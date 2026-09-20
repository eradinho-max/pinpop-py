require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const isNetlifyRuntime = process.env.NETLIFY === 'true';

// Trust reverse proxy (Vercel, Railway, Render, Cloudflare, Nginx)
app.set('trust proxy', 1);

// ==========================================
// ENVIRONMENT & CREDENTIALS INTEGRITY
// ==========================================
let JWT_SECRET = process.env.JWT_SECRET || null;
const isProduction = process.env.NODE_ENV === 'production' || process.env.NETLIFY === 'true';
const adminSecurityReady = Boolean(JWT_SECRET && process.env.ADMIN_PASSWORD);

if (!JWT_SECRET && !isProduction) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('⚠️ AVISO [Desarrollo]: JWT_SECRET no configurado. Se generó clave temporal en memoria.');
}

if (isProduction && !adminSecurityReady) {
  console.warn('⚠️ PINPOP: Admin deshabilitado hasta configurar JWT_SECRET y ADMIN_PASSWORD en el entorno.');
}

// ==========================================
// SECURITY HEADERS (Helmet & CSP)
// ==========================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://*"],
      connectSrc: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// ==========================================
// CORS CONFIGURATION (Same-origin default / Whitelist)
// ==========================================
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : null;

app.use(cors({
  origin: (origin, callback) => {
    // Permit requests without origin (same-origin, curl, mobile apps)
    if (!origin) return callback(null, true);
    if (!allowedOrigins || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Bloqueado por política de seguridad CORS'));
  },
  credentials: true
}));

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, 'public/images/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ==========================================
// RATE LIMITING
// ==========================================
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 failed attempts per IP
  skipSuccessfulRequests: true, // Only count failed attempts towards the brute-force limit
  message: { error: 'Demasiados intentos de acceso fallidos. Por favor, intente nuevamente en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false
});

const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // max 15 orders per IP per 15 minutes
  message: { error: 'Demasiados pedidos enviados recientemente. Por favor aguarde unos minutos.' },
  standardHeaders: true,
  legacyHeaders: false
});

// ==========================================
// STRICT MULTER CONFIGURATION (MIME + 4MB Limit)
// ==========================================
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'pin-' + crypto.randomUUID() + ext);
  }
});

const uploadStorage = isNetlifyRuntime ? multer.memoryStorage() : diskStorage;

const fileFilter = (req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExts = ['.jpg', '.jpeg', '.png', '.webp'];

  if (allowedMimes.includes(file.mimetype) && allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Formato no permitido. Solo se aceptan imágenes JPG, PNG o WebP.'));
  }
};

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter
});

// ==========================================
// JWT AUTHENTICATION MIDDLEWARE
// ==========================================
function authenticateAdmin(req, res, next) {
  if (isNetlifyRuntime && !process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Admin deshabilitado en Netlify hasta configurar DATABASE_URL.' });
  }
  if (!JWT_SECRET || !process.env.ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Administración no configurada en el servidor. Configure JWT_SECRET y ADMIN_PASSWORD.' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acceso no autorizado: Token Bearer requerido.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded && decoded.role === 'admin') {
      req.user = decoded;
      return next();
    }
    return res.status(403).json({ error: 'Permisos insuficientes para esta operación.' });
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado. Inicie sesión nuevamente.' });
  }
}

// ==========================================
// PUBLIC API ENDPOINTS
// ==========================================

// Get public catalog
app.get('/api/products', async (req, res) => {
  try {
    const products = await db.getPublicProducts();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar productos: ' + err.message });
  }
});

// Get store settings
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await db.getPublicSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar configuración: ' + err.message });
  }
});

// Create Order (Rate-limited, authoritatively priced, and validated server-side)
app.post('/api/orders', orderLimiter, requirePersistentDatabase, async (req, res) => {
  try {
    const { customer, items } = req.body;
    const result = await db.createOrderSecure({ customer, items });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// AUTHENTICATION ENDPOINTS
// ==========================================

// Admin Login (Rate-limited: 5 failed attempts / 15 min)
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  if (isNetlifyRuntime && !process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Admin deshabilitado en Netlify hasta configurar DATABASE_URL.' });
  }
  if (!JWT_SECRET || !process.env.ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Administración no configurada. Defina JWT_SECRET y ADMIN_PASSWORD en Netlify.' });
  }

  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Contraseña requerida.' });
  }

  const isValid = await db.verifyAdminPassword(password);
  if (!isValid) {
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }

  const token = jwt.sign(
    { role: 'admin', user: 'admin' },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({
    token,
    expiresIn: '8h',
    user: { username: 'admin', role: 'admin' }
  });
});

// Verify current token
app.get('/api/auth/verify', authenticateAdmin, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// ==========================================
// PERSISTENCE GUARD
// ==========================================
function requirePersistentDatabase(req, res, next) {
  if (process.env.NETLIFY === 'true' && !process.env.DATABASE_URL) {
    return res.status(503).json({
      error: 'Base persistente no configurada. En Netlify, defina DATABASE_URL antes de modificar catálogo, stock o pedidos.'
    });
  }
  return next();
}

// ==========================================
// PROTECTED ADMIN ENDPOINTS
// ==========================================

// Admin: Get all products (includes costPrice, stock, minStock, active status)
app.get('/api/admin/products', authenticateAdmin, async (req, res) => {
  try {
    const products = await db.getAllProductsAdmin();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Create product
app.post('/api/admin/products', authenticateAdmin, requirePersistentDatabase, async (req, res) => {
  try {
    const newProd = await db.createProductAdmin(req.body);
    res.status(201).json(newProd);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin: Update product
app.put('/api/admin/products/:id', authenticateAdmin, requirePersistentDatabase, async (req, res) => {
  try {
    const updated = await db.updateProductAdmin(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin: Soft delete product (sets active = 0 to preserve order history)
app.delete('/api/admin/products/:id', authenticateAdmin, requirePersistentDatabase, async (req, res) => {
  try {
    const result = await db.softDeleteProductAdmin(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin: Reactivate product
app.post('/api/admin/products/:id/activate', authenticateAdmin, requirePersistentDatabase, async (req, res) => {
  try {
    const updated = await db.updateProductAdmin(req.params.id, { active: 1 });
    res.json({ success: true, product: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin: Adjust stock directly (+/- delta, target stock)
app.post('/api/admin/products/:id/stock', authenticateAdmin, requirePersistentDatabase, async (req, res) => {
  try {
    const result = await db.adjustStockAdmin(req.params.id, req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/admin/products/:id/stock', authenticateAdmin, requirePersistentDatabase, async (req, res) => {
  try {
    const result = await db.adjustStockAdmin(req.params.id, req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// CATEGORIES API (Dynamic Management)
// ==========================================
app.get('/api/categories', async (req, res) => {
  try {
    const targetType = req.query.targetType || null;
    const cats = await db.getCategories(targetType);
    res.json(cats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/categories', authenticateAdmin, requirePersistentDatabase, async (req, res) => {
  try {
    const newCat = await db.createCategoryAdmin(req.body);
    res.status(201).json(newCat);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/categories/:id', authenticateAdmin, requirePersistentDatabase, async (req, res) => {
  try {
    const result = await db.deleteCategoryAdmin(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin: Upload pin photo (persistent Storage on Netlify; local disk only in traditional local/VPS mode)
app.post('/api/admin/upload', authenticateAdmin, requirePersistentDatabase, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'La imagen excede el límite máximo permitido de 4MB.' });
      }
      return res.status(400).json({ error: 'Error de carga: ' + err.message });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No se envió ningún archivo de imagen.' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const filename = req.file.filename || ('pin-' + crypto.randomUUID() + ext);
    const hasSupabaseStorage = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

    if (hasSupabaseStorage) {
      try {
        const { createClient } = require('@supabase/supabase-js');
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false }
        });
        const bucket = process.env.SUPABASE_BUCKET || 'pins-images';
        const fileContent = req.file.buffer || fs.readFileSync(req.file.path);
        const { error: uploadError } = await supabase.storage
          .from(bucket)
          .upload(filename, fileContent, {
            contentType: req.file.mimetype,
            upsert: false
          });

        if (uploadError) throw uploadError;

        const { data: publicUrlData } = supabase.storage.from(bucket).getPublicUrl(filename);
        if (req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.json({ url: publicUrlData.publicUrl, filename });
      } catch (cloudErr) {
        if (req.file.path && fs.existsSync(req.file.path) && isNetlifyRuntime) {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
        }
        if (isNetlifyRuntime) {
          return res.status(500).json({ error: 'No se pudo guardar la imagen en Storage: ' + cloudErr.message });
        }
        console.warn('Fallo upload a Supabase Storage; se usará almacenamiento local:', cloudErr.message);
      }
    }

    if (isNetlifyRuntime) {
      return res.status(503).json({
        error: 'Storage persistente no configurado. Defina SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en Netlify.'
      });
    }

    // Traditional local/VPS mode: multer already wrote the file to public/images/uploads.
    const publicUrl = '/images/uploads/' + filename;
    return res.json({ url: publicUrl, filename });
  });
});

// Admin: Get all orders
app.get('/api/admin/orders', authenticateAdmin, async (req, res) => {
  try {
    const orders = await db.getAllOrdersAdmin();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Confirm order stock (Transactional deduction + audit trail)
app.post('/api/admin/orders/:id/confirm-stock', authenticateAdmin, requirePersistentDatabase, async (req, res) => {
  try {
    const result = await db.confirmOrderStockAdmin(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin: Restore stock / cancel order (Transactional estorno)
app.post('/api/admin/orders/:id/restore-stock', authenticateAdmin, requirePersistentDatabase, async (req, res) => {
  try {
    const result = await db.restoreOrderStockAdmin(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin: Mark order as Delivered (Strictly requires prior 'confirmed' status)
app.post('/api/admin/orders/:id/deliver', authenticateAdmin, requirePersistentDatabase, async (req, res) => {
  try {
    const result = await db.markOrderDeliveredAdmin(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin: Get stock audit trail
app.get('/api/admin/stock-movements', authenticateAdmin, async (req, res) => {
  try {
    const movements = await db.getStockMovementsAdmin();
    res.json(movements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Get dashboard stats
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
  try {
    const stats = await db.getStatsAdmin();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Update store settings
app.put('/api/admin/settings', authenticateAdmin, requirePersistentDatabase, async (req, res) => {
  try {
    const updated = await db.updateSettingsAdmin(req.body);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin: Change password
app.post('/api/admin/change-password', authenticateAdmin, requirePersistentDatabase, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    }
    await db.updateAdminPassword(newPassword);
    res.json({ success: true, message: 'Contraseña actualizada con éxito.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// API routes must never fall through to HTML.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Ruta API no encontrada.' });
});

// Fallback to index.html for direct/local SPA navigation
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

let databaseInitPromise = null;
function ensureDatabaseReady() {
  if (!databaseInitPromise) {
    databaseInitPromise = db.initDatabase().catch(err => {
      databaseInitPromise = null;
      throw err;
    });
  }
  return databaseInitPromise;
}

// Initialize database and start a traditional Node server only when executed directly.
async function startServer() {
  await ensureDatabaseReady();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`🚀 PINPOP Servidor iniciado en http://0.0.0.0:${PORT}`);
    console.log(`   Modo: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   ✓ Usuario administrador configurado.`);
    console.log(`====================================================`);
  });
}

if (require.main === module) {
  startServer().catch(err => {
    console.error('Error fatal al iniciar servidor:', err);
    process.exit(1);
  });
}

module.exports = { app, ensureDatabaseReady };
