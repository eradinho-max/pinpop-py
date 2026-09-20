const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = process.env.DATABASE_PATH || path.join(DB_DIR, 'pinpop.sqlite');

let db = null;
let SQL = null;
let pgPool = null;
const isPostgres = Boolean(process.env.DATABASE_URL);
const isNetlifyRuntime = process.env.NETLIFY === 'true';

if (!isPostgres && !isNetlifyRuntime && !fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

function persistDb() {
  if (isPostgres || isNetlifyRuntime || !db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_FILE, buffer);
  } catch (err) {
    console.error('Error al persistir SQLite:', err);
  }
}

// Convert '?' placeholders to '$1, $2, ...' for PostgreSQL queries.
// node-postgres uses unnamed statements here, which is compatible with Supavisor transaction mode.
function toPgSql(sql) {
  let idx = 1;
  return sql.replace(/\?/g, () => `$${idx++}`);
}

async function queryAll(sql, params = [], pgClient = null) {
  if (isPostgres) {
    const executor = pgClient || pgPool;
    const res = await executor.query(toPgSql(sql), params);
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

async function queryOne(sql, params = [], pgClient = null) {
  const rows = await queryAll(sql, params, pgClient);
  return rows.length > 0 ? rows[0] : null;
}

async function runSql(sql, params = [], pgClient = null) {
  if (isPostgres) {
    const executor = pgClient || pgPool;
    return await executor.query(toPgSql(sql), params);
  }
  db.run(sql, params);
  return null;
}

// Guarantee that every PostgreSQL transaction uses one physical pooled connection.
// SQLite keeps the same semantics on its single in-memory connection.
async function withTransaction(work) {
  if (isPostgres) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const tx = {
        queryAll: (sql, params = []) => queryAll(sql, params, client),
        queryOne: (sql, params = []) => queryOne(sql, params, client),
        runSql: (sql, params = []) => runSql(sql, params, client)
      };
      const result = await work(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  db.run('BEGIN TRANSACTION;');
  try {
    const tx = { queryAll, queryOne, runSql };
    const result = await work(tx);
    db.run('COMMIT;');
    persistDb();
    return result;
  } catch (err) {
    try { db.run('ROLLBACK;'); } catch (_) {}
    throw err;
  }
}

function randomId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
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

function normalizeProductImageUrl(value, required = false) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url) {
    if (required) throw new Error('La imagen principal del producto es obligatoria.');
    return '';
  }
  if (url.length > 2048) throw new Error('URL de imagen inválida.');
  if (/^(javascript|file|vbscript):/i.test(url)) throw new Error('URL de imagen no permitida.');
  if (/^https:\/\//i.test(url)) return url;
  const local = url.replace(/^\//, '');
  if (local.startsWith('images/') && !local.includes('..') && /^[A-Za-z0-9_./-]+$/.test(local)) {
    return url.startsWith('/') ? `/${local}` : local;
  }
  throw new Error('La imagen debe provenir del almacenamiento PINPOP o usar una URL HTTPS válida.');
}

function normalizeGalleryImages(values, mainImage = '') {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new Error('La galería de imágenes es inválida.');
  const normalized = [];
  for (const value of values.slice(0, 4)) {
    const url = normalizeProductImageUrl(value, true);
    if (url !== mainImage && !normalized.includes(url)) normalized.push(url);
  }
  return normalized;
}

const DEFAULT_WHATSAPP_NUMBER = '595991950031';
const LEGACY_PLACEHOLDER_WHATSAPP = '595981234567';

function normalizeParaguayWhatsapp(value) {
  let digits = String(value || '').replace(/\D/g, '');
  // International +595 must not include the domestic trunk prefix 0.
  if (digits.startsWith('5950')) digits = '595' + digits.slice(4);
  // Domestic format 09XX... -> +595 9XX...
  if (digits.startsWith('0') && digits.length === 10) digits = '595' + digits.slice(1);
  if (digits.startsWith('9') && digits.length === 9) digits = '595' + digits;
  if (!/^5959\d{8}$/.test(digits)) {
    throw new Error('Número de WhatsApp inválido. Use un celular paraguayo, por ejemplo +595 991 950 031.');
  }
  return digits;
}

async function initDatabase() {
  if (isPostgres) {
    const { Pool } = require('pg');
    const poolMax = Math.max(1, Number(process.env.PG_POOL_MAX || (isNetlifyRuntime ? 1 : 5)));
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
      max: poolMax,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
      allowExitOnIdle: true
    });

    // Fail fast if the DATABASE_URL is invalid.
    await pgPool.query('SELECT 1');
    console.log(`✓ Conexión establecida con PostgreSQL / Supabase (pool max=${poolMax}).`);
    
    // Execute idempotent DDL schema on PostgreSQL if needed.
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const ddl = fs.readFileSync(schemaPath, 'utf8');
      await pgPool.query(ddl);
    }

    // Keep the human-friendly order sequence ahead of any previously imported P#### ids.
    await pgPool.query(`
      SELECT setval(
        'pinpop_order_number_seq',
        GREATEST(
          1000,
          (SELECT last_value FROM pinpop_order_number_seq),
          COALESCE((SELECT MAX(SUBSTRING(id FROM 2)::BIGINT) FROM orders WHERE id ~ '^P[0-9]+$'), 1000)
        ),
        true
      )
    `);
  } else {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    SQL = await initSqlJs({
      locateFile: (file) => file.endsWith('.wasm') ? wasmPath : file
    });

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

  // Seed admin only when an explicit password is configured. Never invent a default credential.
  const adminExists = await queryOne('SELECT * FROM admin_users WHERE username = ?', ['admin']);
  if (!adminExists) {
    const adminPassword = process.env.ADMIN_PASSWORD || '';
    if (adminPassword.length < 12) {
      console.warn('⚠️ Admin no creado: configure ADMIN_PASSWORD con al menos 12 caracteres.');
    } else {
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
      whatsappNumber: DEFAULT_WHATSAPP_NUMBER,
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

  // Migrate the old demo WhatsApp placeholder without overwriting a real custom number.
  const whatsappSetting = await queryOne('SELECT value FROM settings WHERE key = ?', ['whatsappNumber']);
  let currentWhatsapp = null;
  if (whatsappSetting) {
    try { currentWhatsapp = JSON.parse(whatsappSetting.value); }
    catch (_) { currentWhatsapp = whatsappSetting.value; }
  }
  if (!currentWhatsapp || String(currentWhatsapp).replace(/\D/g, '') === LEGACY_PLACEHOLDER_WHATSAPP) {
    if (isPostgres) {
      await runSql(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        ['whatsappNumber', JSON.stringify(DEFAULT_WHATSAPP_NUMBER)]
      );
    } else {
      await runSql('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['whatsappNumber', JSON.stringify(DEFAULT_WHATSAPP_NUMBER)]);
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

async function getPublicProductById(id) {
  const p = await queryOne(`
    SELECT id, sku, name, category, target_type, price, promo_price, stock, image, description, badge, active, featured, gallery_images, updated_at
    FROM products
    WHERE id = ? AND (active = 1 OR active = true)
  `, [id]);
  if (!p) return null;
  let gallery = [];
  try { gallery = JSON.parse(p.gallery_images || '[]'); } catch (_) {}
  return {
    ...p,
    targetType: p.target_type || 'crocs',
    promoPrice: p.promo_price,
    active: Boolean(p.active),
    featured: Boolean(p.featured),
    galleryImages: gallery,
    updatedAt: p.updated_at
  };
}

async function getSeoProducts() {
  const rows = await queryAll(`
    SELECT id, name, updated_at
    FROM products
    WHERE active = 1 OR active = true
    ORDER BY updated_at DESC, id ASC
  `);
  return rows.map(r => ({ id: r.id, name: r.name, updatedAt: r.updated_at }));
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

  const safeName = sanitizeString(customer.name, 100);
  const safePhone = sanitizeString(customer.phone, 30);
  const safeAddress = sanitizeString(customer.address, 200);
  const safePayment = sanitizeString(customer.paymentMethod, 60);
  const safeNotes = sanitizeString(customer.notes, 250);
  const safeDeliveryType = customer.deliveryType === 'pickup' ? 'pickup' : 'delivery';

  const created = await withTransaction(async (tx) => {
    let subtotal = 0;
    const verifiedItems = [];

    for (const item of items) {
      const qty = parseInt(item.quantity, 10);
      if (isNaN(qty) || qty <= 0 || qty > 100) {
        throw new Error('Cantidad inválida para el producto.');
      }

      const prod = await tx.queryOne(
        'SELECT * FROM products WHERE id = ? AND (active = 1 OR active = true)',
        [item.productId]
      );
      if (!prod) throw new Error('El producto seleccionado no existe o está inactivo.');
      if (Number(prod.stock) < qty) {
        throw new Error(`Stock insuficiente para "${prod.name}". Stock disponible: ${prod.stock}, solicitado: ${qty}.`);
      }

      const effectivePrice = prod.promo_price !== null && Number(prod.promo_price) > 0
        ? Number(prod.promo_price)
        : Number(prod.price);
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

    const settingRows = await tx.queryAll('SELECT key, value FROM settings');
    const settings = {};
    for (const row of settingRows) {
      try { settings[row.key] = JSON.parse(row.value); }
      catch (_) { settings[row.key] = row.value; }
    }

    const deliveryFeeDefault = Number(settings.deliveryFee || 15000);
    const freeThreshold = Number(settings.freeDeliveryThreshold || 100000);
    const deliveryFee = safeDeliveryType === 'delivery' && subtotal < freeThreshold
      ? deliveryFeeDefault
      : 0;
    const total = subtotal + deliveryFee;

    let nextNum;
    if (isPostgres) {
      const seqRow = await tx.queryOne("SELECT nextval('pinpop_order_number_seq') AS next_num");
      nextNum = Number(seqRow.next_num);
    } else {
      const orderRows = await tx.queryAll('SELECT id FROM orders');
      let maxNum = 1000;
      for (const row of orderRows) {
        const match = /^P(\d+)$/.exec(String(row.id || ''));
        if (match) maxNum = Math.max(maxNum, Number(match[1]));
      }
      nextNum = maxNum + 1;
    }

    const orderId = `P${nextNum}`;
    const now = new Date().toISOString();

    await tx.runSql(
      `INSERT INTO orders (
        id, customer_name, customer_phone, delivery_type, address, payment_method, notes,
        subtotal, delivery_fee, total, status, stock_deducted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId, safeName, safePhone, safeDeliveryType, safeAddress, safePayment, safeNotes,
        subtotal, deliveryFee, total, 'pending', 0, now
      ]
    );

    for (const it of verifiedItems) {
      await tx.runSql(
        `INSERT INTO order_items (id, order_id, product_id, product_name, sku, price, quantity, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomId('item'), orderId, it.productId, it.name, it.sku, it.price, it.quantity, it.lineTotal]
      );
    }

    return { orderId, now, verifiedItems, subtotal, deliveryFee, total, settings };
  });

  const { orderId, now, verifiedItems, subtotal, deliveryFee, total, settings } = created;
  const formatPrice = (v) => `Gs. ${Number(v).toLocaleString('es-PY')}`;
  let msg = `Hola 👋 Quiero realizar el pedido #${orderId}\n\n`;
  verifiedItems.forEach(it => {
    msg += `${it.quantity}x ${it.name} — ${formatPrice(it.lineTotal)}\n`;
  });
  msg += `\nTotal: ${formatPrice(total)}`;

  if (safeName) msg += `\n\n👤 *Cliente:* ${safeName}`;
  if (safeDeliveryType === 'delivery' && safeAddress) msg += `\n📍 *Entrega:* ${safeAddress}`;
  else if (safeDeliveryType === 'pickup') msg += '\n🏪 *Retiro en local*';
  if (safePayment) msg += `\n💳 *Pago:* ${safePayment}`;
  if (safeNotes) msg += `\n📝 *Nota:* ${safeNotes}`;

  const rawPhone = String(settings.whatsappNumber || DEFAULT_WHATSAPP_NUMBER).replace(/\D/g, '');
  const whatsappUrl = `https://wa.me/${rawPhone}?text=${encodeURIComponent(msg)}`;

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
  if (!name) throw new Error('El nombre del producto es obligatorio.');

  const price = Number(data.price);
  if (isNaN(price) || price < 0) throw new Error('El precio del producto debe ser mayor o igual a 0.');

  const parsedStock = Number(data.stock ?? 0);
  const parsedMinStock = Number(data.minStock ?? 3);
  const parsedCost = Number(data.costPrice ?? 0);
  const parsedPromo = data.promoPrice === null || data.promoPrice === undefined || data.promoPrice === '' ? null : Number(data.promoPrice);
  if (!Number.isInteger(parsedStock) || parsedStock < 0) throw new Error('El stock debe ser un entero mayor o igual a 0.');
  if (!Number.isFinite(parsedMinStock) || parsedMinStock < 0) throw new Error('El stock mínimo debe ser mayor o igual a 0.');
  if (!Number.isFinite(parsedCost) || parsedCost < 0) throw new Error('El costo debe ser mayor o igual a 0.');
  if (parsedPromo !== null && (!Number.isFinite(parsedPromo) || parsedPromo < 0)) throw new Error('El precio promocional es inválido.');
  const stock = parsedStock;
  const minStock = Math.trunc(parsedMinStock);
  const costPrice = parsedCost;
  const promoPrice = parsedPromo;
  const targetType = data.targetType === 'estetoscopio' ? 'estetoscopio' : 'crocs';
  const category = sanitizeString(data.category, 60) || (targetType === 'estetoscopio' ? 'Cardiología' : 'Personajes');
  const badge = sanitizeString(data.badge, 50);
  const description = sanitizeString(data.description, 500);
  const featured = data.featured ? 1 : 0;
  const image = normalizeProductImageUrl(data.image, true);
  const galleryImages = JSON.stringify(normalizeGalleryImages(data.galleryImages || [], image));
  const id = randomId('pin');

  let sku = data.sku ? sanitizeString(data.sku, 30).toUpperCase().replace(/\s+/g, '-') : '';
  if (!sku) {
    let prefix = 'PIN';
    const cleanCat = category.toUpperCase().replace(/[^A-Z]/g, '');
    if (cleanCat.length >= 3) prefix = cleanCat.substring(0, 3);
    else if (targetType === 'estetoscopio') prefix = 'EST';

    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = `${prefix}-${crypto.randomInt(1000, 10000)}`;
      const collision = await queryOne('SELECT id FROM products WHERE sku = ?', [candidate]);
      if (!collision) {
        sku = candidate;
        break;
      }
    }
    if (!sku) throw new Error('No se pudo generar un SKU único. Intente nuevamente.');
  } else {
    const existingSku = await queryOne('SELECT id FROM products WHERE sku = ?', [sku]);
    if (existingSku) throw new Error(`El código SKU "${sku}" ya existe.`);
  }

  const now = new Date().toISOString();
  await withTransaction(async (tx) => {
    await tx.runSql(
      `INSERT INTO products (
        id, sku, name, category, target_type, price, promo_price, cost_price, stock, min_stock,
        image, description, badge, sales_count, active, featured, gallery_images, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, sku, name, category, targetType, price, promoPrice, costPrice, stock, minStock,
        image, description, badge, 0, data.active !== undefined ? (data.active ? 1 : 0) : 1,
        featured, galleryImages, now, now
      ]
    );

    if (stock > 0) {
      await tx.runSql(
        `INSERT INTO stock_movements (
          id, product_id, sku, product_name, type, quantity, prev_stock, new_stock, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomId('mov'), id, sku, name, 'entrada', stock, 0, stock, 'Stock inicial / Alta de producto', now]
      );
    }
  });

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

  const nextName = data.name !== undefined ? sanitizeString(data.name, 150) : current.name;
  if (!nextName) throw new Error('El nombre del producto es obligatorio.');
  const nextPrice = data.price !== undefined ? Number(data.price) : Number(current.price);
  const nextPromo = data.promoPrice !== undefined
    ? (data.promoPrice === null || data.promoPrice === '' ? null : Number(data.promoPrice))
    : current.promo_price;
  const nextCost = data.costPrice !== undefined ? Number(data.costPrice) : Number(current.cost_price || 0);
  const nextMinStock = data.minStock !== undefined ? Number(data.minStock) : Number(current.min_stock || 0);
  if (!Number.isFinite(nextPrice) || nextPrice < 0) throw new Error('El precio debe ser mayor o igual a 0.');
  if (nextPromo !== null && (!Number.isFinite(nextPromo) || nextPromo < 0)) throw new Error('El precio promocional es inválido.');
  if (!Number.isFinite(nextCost) || nextCost < 0) throw new Error('El costo debe ser mayor o igual a 0.');
  if (!Number.isFinite(nextMinStock) || nextMinStock < 0) throw new Error('El stock mínimo debe ser mayor o igual a 0.');
  const nextImage = data.image !== undefined
    ? (data.image === current.image ? current.image : normalizeProductImageUrl(data.image, true))
    : current.image;
  const galleryImages = data.galleryImages !== undefined
    ? JSON.stringify(normalizeGalleryImages(data.galleryImages, nextImage))
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
      nextName,
      data.category !== undefined ? sanitizeString(data.category, 60) : current.category,
      data.targetType !== undefined ? (data.targetType === 'estetoscopio' ? 'estetoscopio' : 'crocs') : (current.target_type || 'crocs'),
      nextPrice,
      nextPromo,
      nextCost,
      Math.trunc(nextMinStock),
      nextImage,
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
  const result = await withTransaction(async (tx) => {
    const lockSql = isPostgres
      ? 'SELECT * FROM products WHERE id = ? FOR UPDATE'
      : 'SELECT * FROM products WHERE id = ?';
    const prod = await tx.queryOne(lockSql, [productId]);
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

    if (!Number.isFinite(quantityChange)) throw new Error('Cantidad de stock inválida.');

    const now = new Date().toISOString();
    const safeReason = sanitizeString(reason, 200) || 'Ajuste de inventario';

    await tx.runSql('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?', [newStock, now, productId]);
    await tx.runSql(
      `INSERT INTO stock_movements (
        id, product_id, sku, product_name, type, quantity, prev_stock, new_stock, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomId('mov'), prod.id, prod.sku, prod.name, movType, quantityChange, prevStock, newStock, safeReason, now]
    );

    return {
      success: true,
      productId: prod.id,
      sku: prod.sku,
      prevStock,
      newStock,
      delta: quantityChange,
      reason: safeReason
    };
  });

  return result;
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

async function getAllCategoriesAdmin() {
  return await queryAll('SELECT id, name, target_type as "targetType", active, created_at as "createdAt" FROM categories ORDER BY active DESC, target_type ASC, name ASC');
}

async function updateCategoryAdmin(id, { name, targetType, active }) {
  const current = await queryOne('SELECT * FROM categories WHERE id = ?', [id]);
  if (!current) throw new Error('Categoría no encontrada.');
  const safeName = name !== undefined ? sanitizeString(name, 50) : current.name;
  if (!safeName) throw new Error('El nombre de la categoría es obligatorio.');
  const type = targetType !== undefined ? (targetType === 'estetoscopio' ? 'estetoscopio' : 'crocs') : current.target_type;
  const duplicate = await queryOne('SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND target_type = ? AND id != ?', [safeName, type, id]);
  if (duplicate) throw new Error(`Ya existe una categoría llamada "${safeName}" en esa línea.`);
  const activeValue = active !== undefined ? (active ? 1 : 0) : current.active;
  await runSql('UPDATE categories SET name = ?, target_type = ?, active = ? WHERE id = ?', [safeName, type, activeValue, id]);
  // Keep existing products consistent when a category is renamed.
  if (safeName !== current.name || type !== current.target_type) {
    await runSql('UPDATE products SET category = ?, target_type = ?, updated_at = ? WHERE category = ? AND target_type = ?', [safeName, type, new Date().toISOString(), current.name, current.target_type]);
  }
  persistDb();
  return await queryOne('SELECT id, name, target_type as "targetType", active FROM categories WHERE id = ?', [id]);
}

async function activateCategoryAdmin(id) {
  const current = await queryOne('SELECT id FROM categories WHERE id = ?', [id]);
  if (!current) throw new Error('Categoría no encontrada.');
  await runSql('UPDATE categories SET active = 1 WHERE id = ?', [id]);
  persistDb();
  return { success: true, id };
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

// Confirm order with one real transaction and row locks on PostgreSQL.
async function confirmOrderStockAdmin(orderId) {
  return await withTransaction(async (tx) => {
    const orderSql = isPostgres
      ? 'SELECT * FROM orders WHERE id = ? FOR UPDATE'
      : 'SELECT * FROM orders WHERE id = ?';
    const order = await tx.queryOne(orderSql, [orderId]);
    if (!order) throw new Error('Pedido no encontrado');

    if (order.stock_deducted === 1 || order.stock_deducted === true) {
      throw new Error('El stock de este pedido ya fue descontado anteriormente.');
    }
    if (order.status === 'cancelled' || order.status === 'delivered') {
      throw new Error('Este pedido no puede ser confirmado en su estado actual.');
    }

    const items = await tx.queryAll('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    if (items.length === 0) throw new Error('El pedido no contiene productos.');

    const lockedProducts = new Map();
    for (const item of items) {
      const prodSql = isPostgres
        ? 'SELECT * FROM products WHERE id = ? FOR UPDATE'
        : 'SELECT * FROM products WHERE id = ?';
      const prod = await tx.queryOne(prodSql, [item.product_id]);
      if (!prod) throw new Error(`El producto "${item.product_name}" ya no existe en el catálogo.`);
      if (Number(prod.stock) < Number(item.quantity)) {
        throw new Error(
          `⚠ Stock insuficiente para confirmar la venta: el pin "${prod.name}" (${prod.sku}) solo tiene ${prod.stock} unidad(es) física(s) y el pedido requiere ${item.quantity}.`
        );
      }
      lockedProducts.set(item.product_id, prod);
    }

    const now = new Date().toISOString();
    const deductions = [];

    for (const item of items) {
      const prod = lockedProducts.get(item.product_id);
      const prevStock = Number(prod.stock) || 0;
      const newStock = prevStock - Number(item.quantity);
      const newSalesCount = (Number(prod.sales_count) || 0) + Number(item.quantity);

      await tx.runSql(
        'UPDATE products SET stock = ?, sales_count = ?, updated_at = ? WHERE id = ?',
        [newStock, newSalesCount, now, prod.id]
      );

      await tx.runSql(
        `INSERT INTO stock_movements (
          id, product_id, sku, product_name, type, quantity, prev_stock, new_stock, reason, order_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomId('mov'), prod.id, prod.sku, prod.name, 'venta', -Number(item.quantity),
          prevStock, newStock, `Venta pedido #${orderId}`, orderId, now
        ]
      );

      deductions.push({ id: prod.id, sku: prod.sku, name: prod.name, prevStock, newStock, quantity: Number(item.quantity) });
    }

    await tx.runSql(
      'UPDATE orders SET status = ?, stock_deducted = 1, confirmed_at = ? WHERE id = ?',
      ['confirmed', now, orderId]
    );

    return {
      success: true,
      orderId,
      status: 'confirmed',
      deductions,
      message: '¡Venta confirmada y stock descontado con éxito!'
    };
  });
}

// Restore stock if order is cancelled, using the same transaction/row-lock guarantees.
async function restoreOrderStockAdmin(orderId) {
  return await withTransaction(async (tx) => {
    const orderSql = isPostgres
      ? 'SELECT * FROM orders WHERE id = ? FOR UPDATE'
      : 'SELECT * FROM orders WHERE id = ?';
    const order = await tx.queryOne(orderSql, [orderId]);
    if (!order) throw new Error('Pedido no encontrado');

    const now = new Date().toISOString();

    if (order.stock_deducted === 0 || order.stock_deducted === false) {
      await tx.runSql(
        'UPDATE orders SET status = ?, cancelled_at = ? WHERE id = ?',
        ['cancelled', now, orderId]
      );
      return { success: true, message: 'Pedido cancelado (ningún stock había sido descontado).' };
    }

    const items = await tx.queryAll('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    for (const item of items) {
      const prodSql = isPostgres
        ? 'SELECT * FROM products WHERE id = ? FOR UPDATE'
        : 'SELECT * FROM products WHERE id = ?';
      const prod = await tx.queryOne(prodSql, [item.product_id]);
      if (!prod) continue;

      const prevStock = Number(prod.stock) || 0;
      const qty = Number(item.quantity) || 0;
      const newStock = prevStock + qty;
      const newSalesCount = Math.max(0, (Number(prod.sales_count) || 0) - qty);

      await tx.runSql(
        'UPDATE products SET stock = ?, sales_count = ?, updated_at = ? WHERE id = ?',
        [newStock, newSalesCount, now, prod.id]
      );

      await tx.runSql(
        `INSERT INTO stock_movements (
          id, product_id, sku, product_name, type, quantity, prev_stock, new_stock, reason, order_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomId('mov'), prod.id, prod.sku, prod.name, 'estorno', qty,
          prevStock, newStock, `Estorno pedido #${orderId}`, orderId, now
        ]
      );
    }

    await tx.runSql(
      'UPDATE orders SET status = ?, stock_deducted = 0, cancelled_at = ? WHERE id = ?',
      ['cancelled', now, orderId]
    );

    return { success: true, message: 'Stock estornado y pedido cancelado con éxito.' };
  });
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
  for (const [key, originalVal] of Object.entries(newSettings)) {
    if (key !== 'adminPassword' && key !== 'jwtSecret') {
      const val = key === 'whatsappNumber' ? normalizeParaguayWhatsapp(originalVal) : originalVal;
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
  getPublicProductById,
  getSeoProducts,
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
  getAllCategoriesAdmin,
  createCategoryAdmin,
  updateCategoryAdmin,
  activateCategoryAdmin,
  deleteCategoryAdmin
};
