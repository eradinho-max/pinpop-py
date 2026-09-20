const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = process.env.DATABASE_PATH || path.join(DB_DIR, 'pinpop.sqlite');

let db = null;
let SQL = null;
let pgPool = null;
const isPostgres = Boolean(process.env.DATABASE_URL);

if (!isPostgres && !fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

function persistDb() {
  if (isPostgres || !db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_FILE, buffer);
  } catch (err) {
    console.error('Error al persistir SQLite:', err);
  }
}

// Convert '?' placeholders to '$1, $2, ...' for PostgreSQL queries
function toPgSql(sql) {
  let idx = 1;
  return sql.replace(/\?/g, () => `$${idx++}`);
}

async function queryAll(sql, params = []) {
  if (isPostgres) {
    const res = await pgPool.query(toPgSql(sql), params);
    return res.rows;
  }
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

async function runSql(sql, params = []) {
  if (isPostgres) {
    return await pgPool.query(toPgSql(sql), params);
  }
  db.run(sql, params);
}

// Sanitize user-provided text strings (removes HTML tags and dangerous control characters WITHOUT double-encoding entities)
function sanitizeString(str, maxLen = 255) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<[^>]*>?/gm, '') // Strip HTML tags
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove ASCII control characters
    .trim()
    .substring(0, maxLen);
}

async function initDatabase() {
  if (isPostgres) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    });
    console.log('✓ Conexión establecida con base de datos PostgreSQL / Supabase.');
    
    // Execute DDL schema on PostgreSQL if needed
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const ddl = fs.readFileSync(schemaPath, 'utf8');
      await pgPool.query(ddl);
    }
  } else {
    SQL = await initSqlJs();

    if (fs.existsSync(DB_FILE)) {
      try {
        const fileBuffer = fs.readFileSync(DB_FILE);
        db = new SQL.Database(fileBuffer);
        console.log('✓ Base de datos SQLite cargada desde:', DB_FILE);
      } catch (e) {
        console.warn('Error leyendo archivo SQLite, creando nueva base:', e.message);
        db = new SQL.Database();
      }
    } else {
      db = new SQL.Database();
      console.log('✓ Nueva base de datos SQLite inicializada.');
    }

    // SQLite Schema
    db.run(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        sku TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        target_type TEXT NOT NULL DEFAULT 'crocs', -- 'crocs' o 'estetoscopio'
        price INTEGER NOT NULL,
        promo_price INTEGER,
        cost_price INTEGER NOT NULL DEFAULT 0,
        stock INTEGER NOT NULL DEFAULT 0,
        min_stock INTEGER NOT NULL DEFAULT 3,
        image TEXT NOT NULL,
        description TEXT,
        badge TEXT,
        sales_count INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        delivery_type TEXT NOT NULL,
        address TEXT,
        payment_method TEXT,
        notes TEXT,
        subtotal INTEGER NOT NULL,
        delivery_fee INTEGER NOT NULL,
        total INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', -- pending, confirmed, delivered, cancelled
        stock_deducted INTEGER NOT NULL DEFAULT 0,
        confirmed_at TEXT,
        delivered_at TEXT,
        cancelled_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        sku TEXT,
        price INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        line_total INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stock_movements (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        sku TEXT,
        product_name TEXT NOT NULL,
        type TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        prev_stock INTEGER NOT NULL,
        new_stock INTEGER NOT NULL,
        reason TEXT NOT NULL,
        order_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    // Ensure target_type, featured and gallery_images columns exist
    try {
      db.run("ALTER TABLE products ADD COLUMN target_type TEXT NOT NULL DEFAULT 'crocs';");
    } catch (e) {}
    try {
      db.run("ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;");
    } catch (e) {}
    try {
      db.run("ALTER TABLE products ADD COLUMN gallery_images TEXT DEFAULT '[]';");
    } catch (e) {}

    // Categories table for dynamic management without code changes
    try {
      db.run(`
        CREATE TABLE IF NOT EXISTS categories (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          target_type TEXT NOT NULL DEFAULT 'crocs',
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
      `);
    } catch (e) {}
  }

  // Seed default admin if empty. In production/serverless, never invent a default password.
  const adminExists = await queryOne('SELECT * FROM admin_users WHERE username = ?', ['admin']);
  if (!adminExists) {
    const productionLike = process.env.NODE_ENV === 'production' || process.env.NETLIFY === 'true';
    if (productionLike && !process.env.ADMIN_PASSWORD) {
      console.warn('⚠️ Admin no creado: ADMIN_PASSWORD no está configurado en producción.');
    } else {
      const adminPassword = process.env.ADMIN_PASSWORD || 'pinpop2026';
      const hash = bcrypt.hashSync(adminPassword, 10);
      await runSql(
        'INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
        ['usr-01', 'admin', hash, new Date().toISOString()]
      );
    }
  }

  // Seed default categories if empty
  const checkCats = await queryOne('SELECT COUNT(*) as count FROM categories');
  if (!checkCats || Number(checkCats.count) === 0) {
    const defaultCats = [
      { name: 'Personajes', target_type: 'crocs' },
      { name: 'Medicina', target_type: 'crocs' },
      { name: 'Animales', target_type: 'crocs' },
      { name: 'Flores', target_type: 'crocs' },
      { name: 'Letras', target_type: 'crocs' },
      { name: 'Deportes', target_type: 'crocs' },
      { name: 'Comida', target_type: 'crocs' },
      { name: 'Viajes', target_type: 'crocs' },
      { name: 'Packs', target_type: 'crocs' },
      { name: 'Ofertas', target_type: 'crocs' },
      { name: 'Especiales', target_type: 'crocs' },
      { name: 'Otros', target_type: 'crocs' },
      { name: 'Cardiología', target_type: 'estetoscopio' },
      { name: 'Odontología', target_type: 'estetoscopio' },
      { name: 'Veterinaria', target_type: 'estetoscopio' },
      { name: 'Packs Médicos', target_type: 'estetoscopio' },
      { name: 'Ofertas', target_type: 'estetoscopio' }
    ];
    const now = new Date().toISOString();
    for (let i = 0; i < defaultCats.length; i++) {
      const c = defaultCats[i];
      await runSql(
        'INSERT INTO categories (id, name, target_type, active, created_at) VALUES (?, ?, ?, 1, ?)',
        [`cat-${i + 1}`, c.name, c.target_type, now]
      );
    }
  }

  // Seed default settings if empty
  const checkSettings = await queryOne('SELECT COUNT(*) as count FROM settings');
  if (!checkSettings || Number(checkSettings.count) === 0) {
    const defaultSettings = {
      storeName: 'PINPOP',
      tagline: 'Pins para tus Crocs • Dale onda a tus calzados ✨',
      whatsappNumber: '595981234567',
      deliveryFee: 15000,
      freeDeliveryThreshold: 100000,
      promoBanner: '¡Dale personalidad a tus Crocs! ✨ Elegí tus pins favoritos. Envíos en el día a todo el país 🛵'
    };
    for (const [key, val] of Object.entries(defaultSettings)) {
      if (isPostgres) {
        await runSql(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
          [key, JSON.stringify(val)]
        );
      } else {
        await runSql('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(val)]);
      }
    }
  }

  // Seed initial products catalog
  await seedInitialProducts();

  persistDb();
  console.log('✓ Tablas relacionales inicializadas con éxito.');
}

async function seedInitialProducts() {
  const initial = [
    {
      id: 'pin-01',
      sku: 'MED-014',
      name: 'Pin Estetoscopio Rosa con Corazón',
      category: 'Medicina',
      price: 12000,
      promo_price: 10000,
      cost_price: 4000,
      stock: 18,
      min_stock: 5,
      image: '/images/pins/estetoscopio-pin.png',
      description: 'Estetoscopio médico en relieve 3D color rosa con dije de corazón rojo. Ideal para enfermeros, médicos y estudiantes de medicina.',
      badge: 'Top Medicina 🩺',
      sales_count: 31
    },
    {
      id: 'pin-02',
      sku: 'SIM-001',
      name: 'Pin Corazón Rojo Clásico',
      category: 'Ofertas',
      price: 10000,
      promo_price: 8000,
      cost_price: 3500,
      stock: 11,
      min_stock: 5,
      image: '/images/pins/corazon-rojo-pin.png',
      description: 'Corazón rojo inflado en alto relieve de goma PVC suave. El detalle romántico y tierno perfecto para combinar.',
      badge: 'En Oferta ❤️',
      sales_count: 38
    },
    {
      id: 'pin-03',
      sku: 'PER-008',
      name: 'Pin Gatita Bow (Estilo Hello Kitty)',
      category: 'Personajes',
      price: 12000,
      promo_price: null,
      cost_price: 4200,
      stock: 14,
      min_stock: 4,
      image: '/images/pins/gatita-bow-pin.png',
      description: 'Carita tierna de gatita blanca con su icónico lazo rosa. De los pins más pedidos por grandes y chicos.',
      badge: 'Más Vendido ✨',
      sales_count: 41
    },
    {
      id: 'pin-04',
      sku: 'ANI-003',
      name: 'Pin Capibara con Florcita',
      category: 'Animales',
      price: 12000,
      promo_price: null,
      cost_price: 4000,
      stock: 8,
      min_stock: 3,
      image: '/images/pins/capivara-pin.png',
      description: 'El animal más querido de internet con florcita rosa en la cabeza. Relieve 3D de alta definición.',
      badge: 'Favorito 🦦',
      sales_count: 47
    },
    {
      id: 'pin-05',
      sku: 'COM-002',
      name: 'Pin Aguacate Cool con Lentes',
      category: 'Comida',
      price: 10000,
      promo_price: null,
      cost_price: 3500,
      stock: 15,
      min_stock: 4,
      image: '/images/pins/avocado-pin.png',
      description: 'Palta / aguacate maduro y simpático usando lentes de sol oscuros. Estilo y frescura en tu calzado.',
      badge: 'Tendencia 🥑',
      sales_count: 24
    },
    {
      id: 'pin-06',
      sku: 'FLO-005',
      name: 'Pin Florcita Daisy Sonriente',
      category: 'Flores',
      price: 10000,
      promo_price: null,
      cost_price: 3200,
      stock: 20,
      min_stock: 5,
      image: '/images/pins/flower-pin.png',
      description: 'Margarita blanca y amarilla con carita alegre estilo Murakami. Llena de vida y buena vibra.',
      badge: 'Clásico 🌼',
      sales_count: 29
    },
    {
      id: 'pin-07',
      sku: 'DEP-001',
      name: 'Pin Balón de Fútbol Estrella',
      category: 'Deportes',
      price: 12000,
      promo_price: null,
      cost_price: 4000,
      stock: 7,
      min_stock: 3,
      image: '/images/pins/futbol-pin.png',
      description: 'Pelota de fútbol clásica con estrellas doradas. Indispensable para los fanáticos del deporte rey.',
      badge: 'Fútbol ⚽',
      sales_count: 22
    },
    {
      id: 'pin-08',
      sku: 'GAM-003',
      name: 'Pin Control Gamer Joystick Arcade',
      category: 'Personajes',
      price: 12000,
      promo_price: null,
      cost_price: 4000,
      stock: 6,
      min_stock: 3,
      image: '/images/pins/gamer-pin.png',
      description: 'Mando retro de videojuegos con cruceta y botones de colores. El preferido de los streamers y gamers.',
      badge: 'Gamer 🎮',
      sales_count: 26
    },
    {
      id: 'pin-09',
      sku: 'COM-007',
      name: 'Pin Rebanada de Pizza Pepperoni',
      category: 'Comida',
      price: 10000,
      promo_price: null,
      cost_price: 3500,
      stock: 9,
      min_stock: 3,
      image: '/images/pins/pizza-pin.png',
      description: 'Porción de pizza con queso derretido y rodajas de pepperoni. Un clásico para personalizar con humor.',
      badge: 'Delicioso 🍕',
      sales_count: 18
    },
    {
      id: 'pin-10',
      sku: 'COM-010',
      name: 'Pin Vaso Boba Tea Kawaii',
      category: 'Comida',
      price: 10000,
      promo_price: null,
      cost_price: 3500,
      stock: 8,
      min_stock: 3,
      image: '/images/pins/boba-pin.png',
      description: 'Vaso de té de perlas con pajita y carita tierna. Súper popular entre los amantes del bubble tea.',
      badge: 'Kawaii 🧋',
      sales_count: 16
    },
    {
      id: 'pin-11',
      sku: 'MET-004',
      name: 'Pin Corazón Glitter Dorado Lux',
      category: 'Ofertas',
      price: 15000,
      promo_price: 12000,
      cost_price: 5000,
      stock: 2,
      min_stock: 3,
      image: '/images/pins/heart-glitter-pin.png',
      description: 'Acabado brillante con microglitter holográfico dorado y resina espejada. Toque de elegancia y brillo.',
      badge: '¡Últimas 2! ⚡',
      sales_count: 27
    },
    {
      id: 'pin-12',
      sku: 'ANI-006',
      name: 'Pin Baby Dino T-Rex Verde',
      category: 'Animales',
      price: 12000,
      promo_price: null,
      cost_price: 4000,
      stock: 0,
      min_stock: 3,
      image: '/images/pins/dino-pin.png',
      description: 'Dinosaurio verde simpático en goma suave. Reposición de stock en camino.',
      badge: 'Agotado',
      sales_count: 35
    },
    {
      id: 'pin-13',
      sku: 'PCK-MED01',
      name: 'Pack Medicina 5 Pins (Promo Especial)',
      category: 'Packs',
      price: 45000,
      promo_price: 45000,
      cost_price: 18000,
      stock: 5,
      min_stock: 2,
      image: '/images/pins/estetoscopio-pin.png',
      description: 'Kit completo para personal de salud: Estetoscopio, Corazón, Curita, Cápsula y Dije Médico. Llevá 5 por solo Gs. 45.000.',
      badge: 'Pack 5x 🩺',
      sales_count: 19
    },
    {
      id: 'pin-14',
      sku: 'PCK-LET02',
      name: 'Pack Letras & Good Vibes (Armá tu Nombre)',
      category: 'Letras',
      price: 40000,
      promo_price: null,
      cost_price: 15000,
      stock: 6,
      min_stock: 2,
      image: '/images/pins/crocs-jibbitz-charms-pins-1.jpg',
      description: 'Combiná iniciales, letras en relieve y dijes positivos para personalizar tu Crocs con tu nombre.',
      badge: 'Armá tu Nombre 🔤',
      sales_count: 14
    },
    {
      id: 'pin-15',
      sku: 'PCK-DIS03',
      name: 'Pack Disney Clásicos 5 Charms',
      category: 'Packs',
      target_type: 'crocs',
      price: 50000,
      promo_price: null,
      cost_price: 20000,
      stock: 4,
      min_stock: 2,
      image: '/images/pins/crocs-jibbitz-charm-stitch-mickey-avenge-2.jpg',
      description: 'Pack con 5 pins de personajes favoritos estilo animación clásica.',
      badge: 'Pack 5 Charms 🎁',
      sales_count: 23
    },
    // --- PINS / CHARMS PARA ESTETOSCOPIO ---
    {
      id: 'pin-steth-01',
      sku: 'EST-EKG01',
      name: 'Dije Clip Estetoscopio Corazón EKG Rosa',
      category: 'Cardiología',
      target_type: 'estetoscopio',
      price: 18000,
      promo_price: 15000,
      cost_price: 6000,
      stock: 15,
      min_stock: 4,
      image: '/images/pins/steth-charm-ekg.png',
      description: 'Dije clip metálico en oro rosa con esmalte de corazón y pulso EKG. Se abraza con seguridad al tubo de cualquier estetoscopio estándar (Littmann, MDF, etc.) sin rayarlo.',
      badge: 'Top Esteto 🩺',
      sales_count: 36
    },
    {
      id: 'pin-steth-02',
      sku: 'EST-DEN02',
      name: 'Charm Estetoscopio Diente Molar Kawaii (Odonto)',
      category: 'Odontología',
      target_type: 'estetoscopio',
      price: 18000,
      promo_price: null,
      cost_price: 6000,
      stock: 12,
      min_stock: 3,
      image: '/images/pins/steth-charm-tooth.png',
      description: 'Diente molar sonriente con cofia rosa en resina esmaltada de alta definición. El accesorio clínico ideal para odontólogos, cirujanos dentales y estudiantes.',
      badge: 'Odontología 🦷',
      sales_count: 28
    },
    {
      id: 'pin-steth-03',
      sku: 'EST-VET03',
      name: 'Dije Estetoscopio Patita Pet (Veterinaria)',
      category: 'Veterinaria',
      target_type: 'estetoscopio',
      price: 18000,
      promo_price: null,
      cost_price: 6000,
      stock: 14,
      min_stock: 4,
      image: '/images/pins/steth-charm-paw.png',
      description: 'Huella de mascota en oro rosa y verde menta pastel. Broche posterior que no resbala en la goma del tubo. El preferido de veterinarios.',
      badge: 'Veterinaria 🐾',
      sales_count: 33
    },
    {
      id: 'pin-steth-04',
      sku: 'EST-DUO04',
      name: 'Pack Combo Clínico: Dije Estetoscopio + Pin Crocs a Juego',
      category: 'Packs Médicos',
      target_type: 'estetoscopio',
      price: 28000,
      promo_price: 25000,
      cost_price: 9500,
      stock: 8,
      min_stock: 3,
      image: '/images/pins/steth-charm-duo.png',
      description: '¡El combo definitivo! Incluye 1 clip para tubo de estetoscopio + 1 pin para tus calzados Crocs con diseño clínico a juego. Llevá ambos y combiná tu guardia médica.',
      badge: 'Combo 2 en 1 🎁',
      sales_count: 42
    },
    {
      id: 'pin-steth-05',
      sku: 'EST-COR05',
      name: 'Charm Estetoscopio Corazón Glitter Lux',
      category: 'Cardiología',
      target_type: 'estetoscopio',
      price: 18000,
      promo_price: null,
      cost_price: 6000,
      stock: 10,
      min_stock: 3,
      image: '/images/pins/heart-glitter-pin.png',
      description: 'Corazón brillante con microglitter holográfico dorado y montura especial para tubuladura de estetoscopio.',
      badge: 'Glitter Lux ✨',
      sales_count: 25
    },
    {
      id: 'pin-steth-06',
      sku: 'EST-MIN06',
      name: 'Pin Mini Estetoscopio Clínico 3D Rosa',
      category: 'Cardiología',
      target_type: 'estetoscopio',
      price: 18000,
      promo_price: 15000,
      cost_price: 6000,
      stock: 16,
      min_stock: 4,
      image: '/images/pins/estetoscopio-pin.png',
      description: 'Dije en relieve 3D de alta definición que se abraza al estetoscopio para personalizar tu herramienta de trabajo diaria.',
      badge: 'Top Ventas 🩺',
      sales_count: 49
    }
  ];

  const now = new Date().toISOString();
  for (const p of initial) {
    const existing = await queryOne('SELECT id FROM products WHERE id = ?', [p.id]);
    if (!existing) {
      await runSql(
        `INSERT INTO products (
          id, sku, name, category, target_type, price, promo_price, cost_price, stock, min_stock, image, description, badge, sales_count, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.id, p.sku, p.name, p.category, p.target_type || 'crocs', p.price, p.promo_price, p.cost_price, p.stock, p.min_stock, p.image, p.description, p.badge, p.sales_count, 1, now, now
        ]
      );

      await runSql(
        `INSERT INTO stock_movements (id, product_id, sku, product_name, type, quantity, prev_stock, new_stock, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['mov-' + Math.random().toString(36).substring(2, 9), p.id, p.sku, p.name, 'entrada', p.stock, 0, p.stock, 'Carga inicial de inventario', now]
      );
    }
  }
}

// ==========================================
// PUBLIC METHODS (Safe, Sanitized)
// ==========================================

async function getPublicProducts() {
  // CRITICAL: NEVER expose cost_price or min_stock!
  const rows = await queryAll(`
    SELECT id, sku, name, category, target_type, price, promo_price, stock, image, description, badge, active, featured, gallery_images
    FROM products
    WHERE active = 1 OR active = true
    ORDER BY featured DESC, id ASC
  `);
  return rows.map(p => {
    let gallery = [];
    try {
      gallery = JSON.parse(p.gallery_images || '[]');
    } catch (e) {
      gallery = [];
    }
    return {
      ...p,
      targetType: p.target_type || 'crocs',
      promoPrice: p.promo_price,
      active: Boolean(p.active),
      featured: Boolean(p.featured),
      galleryImages: gallery
    };
  });
}

async function getPublicSettings() {
  const rows = await queryAll('SELECT key, value FROM settings');
  const out = {};
  rows.forEach(r => {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch (e) {
      out[r.key] = r.value;
    }
  });
  delete out.adminPassword;
  delete out.jwtSecret;
  return out;
}

// ==========================================
// SECURE ORDER CREATION (Server-Side Pricing + Clean Text Sanitization)
// ==========================================

async function createOrderSecure({ customer, items }) {
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new Error('El carrito no puede estar vacío.');
  }

  if (!customer || !customer.name || !customer.phone) {
    throw new Error('Nombre y teléfono son obligatorios.');
  }

  // Clean strings without entity double-encoding
  const safeName = sanitizeString(customer.name, 100);
  const safePhone = sanitizeString(customer.phone, 30);
  const safeAddress = sanitizeString(customer.address, 200);
  const safePayment = sanitizeString(customer.paymentMethod, 60);
  const safeNotes = sanitizeString(customer.notes, 250);
  const safeDeliveryType = customer.deliveryType === 'pickup' ? 'pickup' : 'delivery';

  // 1. Fetch each authoritative product from the DB and validate stock
  let subtotal = 0;
  const verifiedItems = [];

  for (const item of items) {
    const qty = parseInt(item.quantity, 10);
    if (isNaN(qty) || qty <= 0 || qty > 100) {
      throw new Error(`Cantidad inválida para el producto.`);
    }

    const prod = await queryOne('SELECT * FROM products WHERE id = ? AND (active = 1 OR active = true)', [item.productId]);
    if (!prod) {
      throw new Error(`El producto seleccionado no existe o está inactivo.`);
    }

    if (prod.stock < qty) {
      throw new Error(`Stock insuficiente para "${prod.name}". Stock disponible: ${prod.stock}, solicitado: ${qty}.`);
    }

    const effectivePrice = prod.promo_price !== null && prod.promo_price > 0 ? prod.promo_price : prod.price;
    const lineTotal = effectivePrice * qty;
    subtotal += lineTotal;

    verifiedItems.push({
      productId: prod.id,
      sku: prod.sku,
      name: prod.name,
      image: prod.image,
      price: effectivePrice,
      quantity: qty,
      lineTotal
    });
  }

  // 2. Authoritative Delivery Calculation
  const settings = await getPublicSettings();
  const deliveryFeeDefault = settings.deliveryFee || 15000;
  const freeThreshold = settings.freeDeliveryThreshold || 100000;
  
  let deliveryFee = 0;
  if (safeDeliveryType === 'delivery') {
    deliveryFee = subtotal >= freeThreshold ? 0 : deliveryFeeDefault;
  }

  const total = subtotal + deliveryFee;

  // 3. Generate Order ID
  const countRow = await queryOne('SELECT COUNT(*) as count FROM orders');
  const nextNum = 1001 + (countRow ? Number(countRow.count) : 0);
  const orderId = 'P' + nextNum;
  const now = new Date().toISOString();

  // 4. Insert order
  await runSql(
    `INSERT INTO orders (
      id, customer_name, customer_phone, delivery_type, address, payment_method, notes, subtotal, delivery_fee, total, status, stock_deducted, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId,
      safeName,
      safePhone,
      safeDeliveryType,
      safeAddress,
      safePayment,
      safeNotes,
      subtotal,
      deliveryFee,
      total,
      'pending',
      0,
      now
    ]
  );

  for (const it of verifiedItems) {
    const itemId = 'item-' + Math.random().toString(36).substring(2, 9);
    await runSql(
      `INSERT INTO order_items (id, order_id, product_id, product_name, sku, price, quantity, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [itemId, orderId, it.productId, it.name, it.sku, it.price, it.quantity, it.lineTotal]
    );
  }

  persistDb();

  // 5. Generate pristine WhatsApp message (pure plain text, no HTML entities)
  const formatPrice = (v) => `Gs. ${Number(v).toLocaleString('es-PY')}`;
  let msg = `Hola 👋 Quiero realizar el pedido #${orderId}\n\n`;
  verifiedItems.forEach(it => {
    msg += `${it.quantity}x ${it.name} — ${formatPrice(it.lineTotal)}\n`;
  });
  msg += `\nTotal: ${formatPrice(total)}`;

  if (safeName) {
    msg += `\n\n👤 *Cliente:* ${safeName}`;
  }
  if (safeDeliveryType === 'delivery' && safeAddress) {
    msg += `\n📍 *Entrega:* ${safeAddress}`;
  } else if (safeDeliveryType === 'pickup') {
    msg += `\n🏪 *Retiro en local*`;
  }
  if (safePayment) {
    msg += `\n💳 *Pago:* ${safePayment}`;
  }
  if (safeNotes) {
    msg += `\n📝 *Nota:* ${safeNotes}`;
  }

  const rawPhone = (settings.whatsappNumber || '595981234567').replace(/\D/g, '');
  const encodedText = encodeURIComponent(msg);
  const whatsappUrl = `https://wa.me/${rawPhone}?text=${encodedText}`;

  return {
    order: {
      id: orderId,
      customer: {
        name: safeName,
        phone: safePhone,
        deliveryType: safeDeliveryType,
        address: safeAddress,
        paymentMethod: safePayment,
        notes: safeNotes
      },
      items: verifiedItems,
      subtotal,
      deliveryFee,
      total,
      status: 'pending',
      createdAt: now
    },
    whatsappUrl,
    formattedMessage: msg
  };
}

// ==========================================
// PROTECTED ADMIN METHODS
// ==========================================

async function verifyAdminPassword(password) {
  const user = await queryOne('SELECT * FROM admin_users WHERE username = ?', ['admin']);
  if (!user) return false;
  return bcrypt.compareSync(password, user.password_hash);
}

async function updateAdminPassword(newPassword) {
  const hash = bcrypt.hashSync(newPassword, 10);
  await runSql('UPDATE admin_users SET password_hash = ? WHERE username = ?', [hash, 'admin']);
  persistDb();
  return true;
}

async function getAllProductsAdmin() {
  const rows = await queryAll(`
    SELECT id, sku, name, category, target_type as "targetType", price, promo_price as "promoPrice", cost_price as "costPrice", stock, min_stock as "minStock", image, description, badge, sales_count as "salesCount", active, featured, gallery_images as "galleryImages", created_at, updated_at
    FROM products
    ORDER BY active DESC, created_at DESC, id ASC
  `);
  return rows.map(p => {
    let gallery = [];
    try {
      gallery = JSON.parse(p.galleryImages || '[]');
    } catch (e) {
      gallery = [];
    }
    return {
      ...p,
      targetType: p.targetType || 'crocs',
      active: Boolean(p.active),
      featured: Boolean(p.featured),
      galleryImages: gallery
    };
  });
}

async function getProductById(id) {
  return await queryOne('SELECT * FROM products WHERE id = ?', [id]);
}

async function createProductAdmin(data) {
  const name = sanitizeString(data.name, 150);
  if (!name) {
    throw new Error('El nombre del producto es obligatorio.');
  }

  const price = Number(data.price);
  if (isNaN(price) || price < 0) {
    throw new Error('El precio del producto debe ser mayor o igual a 0.');
  }

  const stock = Math.max(0, parseInt(data.stock, 10) || 0);
  const minStock = Math.max(0, parseInt(data.minStock, 10) || 3);
  const costPrice = Math.max(0, Number(data.costPrice) || 0);
  const promoPrice = data.promoPrice ? Math.max(0, Number(data.promoPrice)) : null;
  const targetType = data.targetType === 'estetoscopio' ? 'estetoscopio' : 'crocs';
  const category = sanitizeString(data.category, 60) || (targetType === 'estetoscopio' ? 'Cardiología' : 'Personajes');
  const badge = sanitizeString(data.badge, 50);
  const description = sanitizeString(data.description, 500);
  const featured = data.featured ? 1 : 0;
  const image = data.image && typeof data.image === 'string' ? data.image.trim() : '/images/pins/estetoscopio-pin.png';
  const galleryImages = Array.isArray(data.galleryImages) ? JSON.stringify(data.galleryImages) : '[]';

  const id = 'pin-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);

  // Auto-generate unique SKU if omitted
  let sku = data.sku ? sanitizeString(data.sku, 30).toUpperCase().replace(/\s+/g, '-') : '';
  if (!sku) {
    let prefix = 'PIN';
    const cleanCat = category.toUpperCase().replace(/[^A-Z]/g, '');
    if (cleanCat.length >= 3) {
      prefix = cleanCat.substring(0, 3);
    } else if (targetType === 'estetoscopio') {
      prefix = 'EST';
    }
    const countRow = await queryOne('SELECT COUNT(*) as count FROM products');
    const seq = (Number(countRow?.count || 0) + 1).toString().padStart(3, '0');
    sku = `${prefix}-${seq}`;
    // Verify collision
    const collision = await queryOne('SELECT id FROM products WHERE sku = ?', [sku]);
    if (collision) {
      sku = `${prefix}-${Math.floor(100 + Math.random() * 900)}`;
    }
  } else {
    // Validate duplicate manual SKU
    const existingSku = await queryOne('SELECT id FROM products WHERE sku = ?', [sku]);
    if (existingSku) {
      throw new Error(`El código SKU "${sku}" ya existe.`);
    }
  }

  const now = new Date().toISOString();

  await runSql(
    `INSERT INTO products (
      id, sku, name, category, target_type, price, promo_price, cost_price, stock, min_stock, image, description, badge, sales_count, active, featured, gallery_images, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      sku,
      name,
      category,
      targetType,
      price,
      promoPrice,
      costPrice,
      stock,
      minStock,
      image,
      description,
      badge,
      0,
      data.active !== undefined ? (data.active ? 1 : 0) : 1,
      featured,
      galleryImages,
      now,
      now
    ]
  );

  // Initial stock movement audit record
  if (stock > 0) {
    await runSql(
      `INSERT INTO stock_movements (id, product_id, sku, product_name, type, quantity, prev_stock, new_stock, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['mov-' + Math.random().toString(36).substring(2, 9), id, sku, name, 'entrada', stock, 0, stock, 'Stock inicial / Alta de producto', now]
    );
  }

  persistDb();
  return await queryOne('SELECT * FROM products WHERE id = ?', [id]);
}

async function updateProductAdmin(id, data) {
  const current = await queryOne('SELECT * FROM products WHERE id = ?', [id]);
  if (!current) throw new Error('Producto no encontrado');

  const now = new Date().toISOString();
  let sku = data.sku ? sanitizeString(data.sku, 30).toUpperCase().replace(/\s+/g, '-') : current.sku;

  if (sku !== current.sku) {
    const existing = await queryOne('SELECT id FROM products WHERE sku = ? AND id != ?', [sku, id]);
    if (existing) throw new Error(`El código SKU "${sku}" ya pertenece a otro producto.`);
  }

  const galleryImages = data.galleryImages !== undefined 
    ? (Array.isArray(data.galleryImages) ? JSON.stringify(data.galleryImages) : data.galleryImages)
    : current.gallery_images;

  await runSql(
    `UPDATE products SET
      sku = ?,
      name = ?,
      category = ?,
      target_type = ?,
      price = ?,
      promo_price = ?,
      cost_price = ?,
      min_stock = ?,
      image = ?,
      description = ?,
      badge = ?,
      active = ?,
      featured = ?,
      gallery_images = ?,
      updated_at = ?
    WHERE id = ?`,
    [
      sku,
      data.name !== undefined ? sanitizeString(data.name, 150) : current.name,
      data.category !== undefined ? sanitizeString(data.category, 60) : current.category,
      data.targetType !== undefined ? (data.targetType === 'estetoscopio' ? 'estetoscopio' : 'crocs') : (current.target_type || 'crocs'),
      data.price !== undefined ? Number(data.price) : current.price,
      data.promoPrice !== undefined ? (data.promoPrice ? Number(data.promoPrice) : null) : current.promo_price,
      data.costPrice !== undefined ? Number(data.costPrice) : current.cost_price,
      data.minStock !== undefined ? Number(data.minStock) : current.min_stock,
      data.image !== undefined ? data.image : current.image,
      data.description !== undefined ? sanitizeString(data.description, 500) : current.description,
      data.badge !== undefined ? sanitizeString(data.badge, 50) : current.badge,
      data.active !== undefined ? (data.active ? 1 : 0) : current.active,
      data.featured !== undefined ? (data.featured ? 1 : 0) : (current.featured || 0),
      galleryImages,
      now,
      id
    ]
  );

  persistDb();
  return await queryOne('SELECT * FROM products WHERE id = ?', [id]);
}

async function adjustStockAdmin(productId, payload) {
  const prod = await queryOne('SELECT * FROM products WHERE id = ?', [productId]);
  if (!prod) throw new Error('Producto no encontrado');

  const prevStock = Number(prod.stock) || 0;
  let newStock;
  let quantityChange;
  let movType = 'ajuste';

  const { type, delta, stock: targetStock, quantity, reason = 'Ajuste manual de inventario' } = payload;

  if (type === 'entrada') {
    quantityChange = Math.abs(Number(quantity || delta || 0));
    newStock = prevStock + quantityChange;
    movType = 'entrada';
  } else if (type === 'salida') {
    quantityChange = -Math.abs(Number(quantity || delta || 0));
    newStock = Math.max(0, prevStock + quantityChange);
    movType = 'ajuste';
  } else if (type === 'fijo' || targetStock !== undefined) {
    const desired = targetStock !== undefined ? targetStock : quantity;
    newStock = Math.max(0, Number(desired) || 0);
    quantityChange = newStock - prevStock;
    movType = quantityChange >= 0 ? 'entrada' : 'ajuste';
  } else if (delta !== undefined) {
    quantityChange = Number(delta);
    newStock = Math.max(0, prevStock + quantityChange);
    movType = quantityChange > 0 ? 'entrada' : 'ajuste';
  } else {
    throw new Error('Debe especificar tipo de ajuste (entrada, salida, fijo) o cantidad.');
  }

  const now = new Date().toISOString();
  await runSql('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?', [newStock, now, productId]);

  const safeReason = sanitizeString(reason, 200) || 'Ajuste de inventario';
  await runSql(
    `INSERT INTO stock_movements (id, product_id, sku, product_name, type, quantity, prev_stock, new_stock, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'mov-' + Math.random().toString(36).substring(2, 9),
      prod.id,
      prod.sku,
      prod.name,
      movType,
      quantityChange,
      prevStock,
      newStock,
      safeReason,
      now
    ]
  );

  persistDb();
  return {
    success: true,
    productId: prod.id,
    sku: prod.sku,
    prevStock,
    newStock,
    delta: quantityChange,
    reason: safeReason
  };
}

// ==========================================
// DYNAMIC CATEGORIES MANAGEMENT
// ==========================================

async function getCategories(targetType = null) {
  let sql = 'SELECT id, name, target_type as "targetType", active FROM categories WHERE active = 1';
  const params = [];
  if (targetType) {
    sql += ' AND target_type = ?';
    params.push(targetType);
  }
  sql += ' ORDER BY name ASC';
  return await queryAll(sql, params);
}

async function createCategoryAdmin({ name, targetType = 'crocs' }) {
  const safeName = sanitizeString(name, 50);
  if (!safeName) throw new Error('El nombre de la categoría es obligatorio.');

  const type = targetType === 'estetoscopio' ? 'estetoscopio' : 'crocs';
  const existing = await queryOne('SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND target_type = ?', [safeName, type]);
  if (existing) {
    // If it was inactive, reactivate it
    await runSql('UPDATE categories SET active = 1 WHERE id = ?', [existing.id]);
    persistDb();
    return await queryOne('SELECT id, name, target_type as "targetType", active FROM categories WHERE id = ?', [existing.id]);
  }

  const id = 'cat-' + Date.now().toString(36);
  const now = new Date().toISOString();
  await runSql(
    'INSERT INTO categories (id, name, target_type, active, created_at) VALUES (?, ?, ?, 1, ?)',
    [id, safeName, type, now]
  );
  persistDb();
  return await queryOne('SELECT id, name, target_type as "targetType", active FROM categories WHERE id = ?', [id]);
}

async function deleteCategoryAdmin(id) {
  await runSql('UPDATE categories SET active = 0 WHERE id = ?', [id]);
  persistDb();
  return { success: true, id };
}

async function softDeleteProductAdmin(id) {
  const prod = await queryOne('SELECT * FROM products WHERE id = ?', [id]);
  if (!prod) throw new Error('Producto no encontrado');

  const now = new Date().toISOString();
  await runSql('UPDATE products SET active = 0, updated_at = ? WHERE id = ?', [now, id]);
  persistDb();
  return { success: true, id, message: 'Producto desactivado (conservando historial comercial).' };
}

async function getAllOrdersAdmin() {
  const orders = await queryAll('SELECT * FROM orders ORDER BY created_at DESC');
  const out = [];
  for (const ord of orders) {
    const items = await queryAll('SELECT * FROM order_items WHERE order_id = ?', [ord.id]);
    const itemsDetailed = [];
    for (const it of items) {
      const prod = await queryOne('SELECT image FROM products WHERE id = ?', [it.product_id]);
      itemsDetailed.push({
        productId: it.product_id,
        sku: it.sku,
        name: it.product_name,
        price: it.price,
        quantity: it.quantity,
        lineTotal: it.line_total,
        image: prod ? prod.image : '/images/pins/estetoscopio-pin.png'
      });
    }

    out.push({
      id: ord.id,
      createdAt: ord.created_at,
      customer: {
        name: ord.customer_name,
        phone: ord.customer_phone,
        deliveryType: ord.delivery_type,
        address: ord.address,
        paymentMethod: ord.payment_method,
        notes: ord.notes
      },
      items: itemsDetailed,
      subtotal: ord.subtotal,
      deliveryFee: ord.delivery_fee,
      total: ord.total,
      status: ord.status,
      stockDeducted: Boolean(ord.stock_deducted),
      confirmedAt: ord.confirmed_at,
      deliveredAt: ord.delivered_at,
      cancelledAt: ord.cancelled_at
    });
  }
  return out;
}

// REAL SQL TRANSACTION: Confirm order with strict pre-validation & atomic execution
async function confirmOrderStockAdmin(orderId) {
  const order = await queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) throw new Error('Pedido no encontrado');

  if (order.stock_deducted === 1 || order.stock_deducted === true) {
    throw new Error('El stock de este pedido ya fue descontado anteriormente.');
  }

  const items = await queryAll('SELECT * FROM order_items WHERE order_id = ?', [orderId]);

  // Pre-validation: ensure every item has sufficient physical stock
  for (const item of items) {
    const prod = await queryOne('SELECT * FROM products WHERE id = ?', [item.product_id]);
    if (!prod) {
      throw new Error(`El producto "${item.product_name}" ya no existe en el catálogo.`);
    }
    if (prod.stock < item.quantity) {
      throw new Error(
        `⚠ Stock insuficiente para confirmar la venta: el pin "${prod.name}" (${prod.sku}) solo tiene ${prod.stock} unidad(es) física(s) y el pedido requiere ${item.quantity}.`
      );
    }
  }

  // ATOMIC SQL TRANSACTION
  await runSql('BEGIN TRANSACTION;');
  try {
    const now = new Date().toISOString();
    const deductions = [];

    for (const item of items) {
      const prod = await queryOne('SELECT * FROM products WHERE id = ?', [item.product_id]);
      const prevStock = prod.stock;
      const newStock = prevStock - item.quantity;
      const newSalesCount = (prod.sales_count || 0) + item.quantity;

      await runSql(
        'UPDATE products SET stock = ?, sales_count = ?, updated_at = ? WHERE id = ?',
        [newStock, newSalesCount, now, prod.id]
      );

      await runSql(
        `INSERT INTO stock_movements (id, product_id, sku, product_name, type, quantity, prev_stock, new_stock, reason, order_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'mov-' + Math.random().toString(36).substring(2, 9),
          prod.id,
          prod.sku,
          prod.name,
          'venta',
          -item.quantity,
          prevStock,
          newStock,
          `Venta pedido #${orderId}`,
          orderId,
          now
        ]
      );

      deductions.push({ id: prod.id, sku: prod.sku, name: prod.name, prevStock, newStock, quantity: item.quantity });
    }

    await runSql(
      'UPDATE orders SET status = ?, stock_deducted = 1, confirmed_at = ? WHERE id = ?',
      ['confirmed', now, orderId]
    );

    await runSql('COMMIT;');
    persistDb();

    return {
      success: true,
      orderId,
      status: 'confirmed',
      deductions,
      message: '¡Venta confirmada y stock descontado con éxito!'
    };
  } catch (err) {
    await runSql('ROLLBACK;');
    throw err;
  }
}

// REAL SQL TRANSACTION: Restore stock if order is cancelled
async function restoreOrderStockAdmin(orderId) {
  const order = await queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) throw new Error('Pedido no encontrado');

  const now = new Date().toISOString();

  if (order.stock_deducted === 0 || order.stock_deducted === false) {
    await runSql('UPDATE orders SET status = ?, cancelled_at = ? WHERE id = ?', ['cancelled', now, orderId]);
    persistDb();
    return { success: true, message: 'Pedido cancelado (ningún stock había sido descontado).' };
  }

  await runSql('BEGIN TRANSACTION;');
  try {
    const items = await queryAll('SELECT * FROM order_items WHERE order_id = ?', [orderId]);

    for (const item of items) {
      const prod = await queryOne('SELECT * FROM products WHERE id = ?', [item.product_id]);
      if (prod) {
        const prevStock = prod.stock;
        const newStock = prevStock + item.quantity;
        const newSalesCount = Math.max(0, (prod.sales_count || 0) - item.quantity);

        await runSql(
          'UPDATE products SET stock = ?, sales_count = ?, updated_at = ? WHERE id = ?',
          [newStock, newSalesCount, now, prod.id]
        );

        await runSql(
          `INSERT INTO stock_movements (id, product_id, sku, product_name, type, quantity, prev_stock, new_stock, reason, order_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'mov-' + Math.random().toString(36).substring(2, 9),
            prod.id,
            prod.sku,
            prod.name,
            'estorno',
            item.quantity,
            prevStock,
            newStock,
            `Estorno pedido #${orderId}`,
            orderId,
            now
          ]
        );
      }
    }

    await runSql(
      'UPDATE orders SET status = ?, stock_deducted = 0, cancelled_at = ? WHERE id = ?',
      ['cancelled', now, orderId]
    );

    await runSql('COMMIT;');
    persistDb();

    return { success: true, message: 'Stock estornado y pedido cancelado con éxito.' };
  } catch (err) {
    await runSql('ROLLBACK;');
    throw err;
  }
}

// Strict order lifecycle: ONLY confirmed orders (with deducted stock) can be marked as delivered!
async function markOrderDeliveredAdmin(orderId) {
  const order = await queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) throw new Error('Pedido no encontrado');

  if (order.status !== 'confirmed') {
    throw new Error('Solo un pedido previamente confirmado (con stock descontado) puede marcarse como entregado.');
  }

  const now = new Date().toISOString();
  await runSql('UPDATE orders SET status = ?, delivered_at = ? WHERE id = ?', ['delivered', now, orderId]);
  persistDb();

  return { success: true, orderId, status: 'delivered', message: 'Pedido marcado como entregado con éxito.' };
}

async function getStockMovementsAdmin(limit = 100) {
  return await queryAll(
    `SELECT * FROM stock_movements ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );
}

async function getStatsAdmin() {
  const products = await queryAll('SELECT * FROM products WHERE active = 1 OR active = true');
  const allProductsCount = await queryOne('SELECT COUNT(*) as count FROM products');
  const orders = await queryAll('SELECT * FROM orders');

  const totalProducts = allProductsCount ? Number(allProductsCount.count) : 0;
  const activeProducts = products.length;
  const totalStockUnits = products.reduce((acc, p) => acc + (Number(p.stock) || 0), 0);
  const totalInventoryRetailValue = products.reduce((acc, p) => acc + ((Number(p.stock) || 0) * (Number(p.price) || 0)), 0);
  const totalInventoryCostValue = products.reduce((acc, p) => acc + ((Number(p.stock) || 0) * (Number(p.cost_price) || 0)), 0);
  const potentialProfit = totalInventoryRetailValue - totalInventoryCostValue;

  const outOfStockCount = products.filter(p => (Number(p.stock) || 0) <= 0).length;
  const lowStockCount = products.filter(p => (Number(p.stock) || 0) > 0 && (Number(p.stock) || 0) <= (Number(p.min_stock) || 3)).length;

  const totalOrders = orders.length;
  const confirmedOrders = orders.filter(o => o.status === 'confirmed').length;
  const deliveredOrders = orders.filter(o => o.status === 'delivered').length;
  const pendingOrders = orders.filter(o => o.status === 'pending').length;
  const cancelledOrders = orders.filter(o => o.status === 'cancelled').length;
  
  // Real Conversion Rate %: (confirmed + delivered) / totalOrders
  const conversionRate = totalOrders > 0
    ? Math.round(((confirmedOrders + deliveredOrders) / totalOrders) * 100)
    : 0;

  const confirmedRevenue = orders
    .filter(o => o.status === 'confirmed' || o.status === 'delivered')
    .reduce((acc, o) => acc + (Number(o.total) || 0), 0);

  const topSellers = await queryAll(
    `SELECT id, sku, name, category, sales_count as "salesCount", stock, image
     FROM products
     ORDER BY sales_count DESC
     LIMIT 10`
  );

  return {
    totalProducts,
    activeProducts,
    totalStockUnits,
    totalInventoryRetailValue,
    totalInventoryCostValue,
    potentialProfit,
    outOfStockCount,
    lowStockCount,
    totalOrders,
    confirmedOrders,
    deliveredOrders,
    pendingOrders,
    cancelledOrders,
    conversionRate,
    confirmedRevenue,
    topSellers
  };
}

async function updateSettingsAdmin(newSettings) {
  for (const [key, val] of Object.entries(newSettings)) {
    if (key !== 'adminPassword' && key !== 'jwtSecret') {
      if (isPostgres) {
        await runSql(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
          [key, JSON.stringify(val)]
        );
      } else {
        await runSql('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(val)]);
      }
    }
  }
  persistDb();
  return await getPublicSettings();
}

module.exports = {
  initDatabase,
  getPublicProducts,
  getPublicSettings,
  createOrderSecure,
  verifyAdminPassword,
  updateAdminPassword,
  getAllProductsAdmin,
  getProductById,
  createProductAdmin,
  updateProductAdmin,
  adjustStockAdmin,
  softDeleteProductAdmin,
  getAllOrdersAdmin,
  confirmOrderStockAdmin,
  restoreOrderStockAdmin,
  markOrderDeliveredAdmin,
  getStockMovementsAdmin,
  getStatsAdmin,
  updateSettingsAdmin,
  getCategories,
  createCategoryAdmin,
  deleteCategoryAdmin
};
