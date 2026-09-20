require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const db = require('./database');
const imageStorage = require('./storage');
const fallbackData = require('./fallback-data');

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
const configuredAdminPassword = process.env.ADMIN_PASSWORD || '';
let adminSecurityReady = Boolean(JWT_SECRET && JWT_SECRET.length >= 32 && configuredAdminPassword.length >= 12);

if (!JWT_SECRET && !isProduction) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('⚠️ AVISO [Desarrollo]: JWT_SECRET no configurado. Se generó clave temporal en memoria.');
}

if (isProduction && !adminSecurityReady) {
  console.warn('⚠️ PINPOP: Admin deshabilitado. En producción, JWT_SECRET debe tener ≥32 caracteres y ADMIN_PASSWORD ≥12 caracteres.');
}

// ==========================================
// SECURITY HEADERS (Helmet & CSP)
// ==========================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:", "https://*.supabase.co", "https://*.supabase.in"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      scriptSrcAttr: ["'none'"]
    }
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false
}));

app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
  next();
});

// ==========================================
// CORS CONFIGURATION (same-origin by default + explicit whitelist)
// ==========================================
const configuredOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors((req, callback) => {
  const origin = req.get('Origin');
  if (!origin) return callback(null, { origin: true, credentials: true });

  const forwardedProto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('host');
  const sameOrigin = host ? `${forwardedProto}://${host}` : null;
  const platformOrigins = [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.SITE_URL]
    .filter(Boolean)
    .map(v => String(v).replace(/\/$/, ''));
  const allow = new Set([...configuredOrigins, ...platformOrigins, sameOrigin].filter(Boolean));

  if (allow.has(origin.replace(/\/$/, ''))) {
    return callback(null, { origin: true, credentials: true });
  }
  return callback(new Error('Bloqueado por política de seguridad CORS'));
}));

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// API responses contain live stock/order/admin data and must not be cached by shared proxies.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// ==========================================
// RATE LIMITING
// ==========================================
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  message: { error: 'Demasiados intentos de acceso fallidos. Por favor, intente nuevamente en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false
});

const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Demasiados pedidos enviados recientemente. Por favor aguarde unos minutos.' },
  standardHeaders: true,
  legacyHeaders: false
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Demasiadas cargas de imágenes. Aguarde unos minutos antes de continuar.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Receive images in memory. Content is validated by magic bytes before Storage/local persistence.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: imageStorage.MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (imageStorage.ALLOWED_MIMES.includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Formato no permitido. Solo se aceptan imágenes JPG, PNG o WebP.'));
  }
});

function escapeHtmlServer(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getSiteBaseUrl(req) {
  const configured = process.env.SITE_URL || process.env.URL;
  if (configured) return String(configured).replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto}://${req.get('host')}`.replace(/\/$/, '');
}

function absoluteAssetUrl(baseUrl, assetUrl) {
  if (!assetUrl) return `${baseUrl}/images/brand/pinpop-logo-web.png`;
  if (/^https?:\/\//i.test(assetUrl)) return assetUrl;
  return `${baseUrl}/${String(assetUrl).replace(/^\//, '')}`;
}

function parseGalleryImages(value) {
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string' && v.trim()).slice(0, 4);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string' && v.trim()).slice(0, 4) : [];
    } catch (_) { return []; }
  }
  return [];
}

async function cleanupRemovedManagedImages(oldProduct, newProduct) {
  if (!oldProduct || !newProduct) return;
  const oldGallery = parseGalleryImages(oldProduct.gallery_images || oldProduct.galleryImages);
  const newGallery = parseGalleryImages(newProduct.gallery_images || newProduct.galleryImages);
  const oldUrls = [oldProduct.image, ...oldGallery].filter(Boolean);
  const newUrls = new Set([newProduct.image || oldProduct.image, ...newGallery].filter(Boolean));
  const removed = [...new Set(oldUrls.filter(url => !newUrls.has(url) && imageStorage.isManagedImageUrl(url)))];
  for (const url of removed) {
    try { await imageStorage.deleteImageByUrl(url); }
    catch (err) { console.warn('PINPOP cleanup image warning:', err.message); }
  }
}

// ==========================================
// JWT AUTHENTICATION MIDDLEWARE
// ==========================================
async function authenticateAdmin(req, res, next) {
  if (isNetlifyRuntime && !process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Admin deshabilitado en Netlify hasta configurar DATABASE_URL.' });
  }
  if (!adminSecurityReady) {
    return res.status(503).json({ error: 'Administración no configurada de forma segura en el servidor.' });
  }
  try {
    await ensureDatabaseReady();
  } catch (err) {
    console.error('PINPOP database unavailable for admin:', err.message);
    return res.status(503).json({ error: 'Base de datos no disponible temporalmente.' });
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


// Health check for deployment diagnostics. It must stay available even if the database is down.
app.get('/api/health', async (req, res) => {
  let databaseHealthy = false;
  let databaseError = null;
  try {
    await ensureDatabaseReady();
    databaseHealthy = true;
  } catch (err) {
    databaseError = err && err.message ? err.message : 'Database initialization failed';
  }
  res.status(200).json({
    ok: true,
    runtime: isNetlifyRuntime ? 'netlify' : 'node',
    database: process.env.DATABASE_URL ? 'postgres' : (isNetlifyRuntime ? 'fallback-public' : 'sqlite'),
    databaseHealthy,
    publicCatalogSource: databaseHealthy ? 'database' : 'bundled-readonly-fallback',
    adminConfigured: adminSecurityReady && databaseHealthy && (!isNetlifyRuntime || Boolean(process.env.DATABASE_URL)),
    databaseError: databaseHealthy ? null : databaseError
  });
});

async function publicDataOrFallback(dbGetter, fallbackValue, res, label) {
  try {
    await ensureDatabaseReady();
    const value = await dbGetter();
    res.setHeader('X-PINPOP-Data-Source', 'database');
    return value;
  } catch (err) {
    console.error(`PINPOP ${label} database fallback:`, err.message);
    res.setHeader('X-PINPOP-Data-Source', 'bundled-readonly-fallback');
    res.setHeader('X-PINPOP-Degraded', '1');
    return typeof fallbackValue === 'function' ? fallbackValue() : fallbackValue;
  }
}

// Public browsing remains available during a database outage.
// Writes, Admin and order creation remain fail-closed.
app.get('/api/products', async (req, res) => {
  res.setHeader('X-PINPOP-Orders-Ready', (!isNetlifyRuntime || Boolean(process.env.DATABASE_URL)) ? '1' : '0');
  const products = await publicDataOrFallback(
    () => db.getPublicProducts(),
    fallbackData.products,
    res,
    'catalog'
  );
  res.json(products);
});

app.get('/api/settings', async (req, res) => {
  const settings = await publicDataOrFallback(
    () => db.getPublicSettings(),
    fallbackData.settings,
    res,
    'settings'
  );
  res.json(settings);
});

// SEO / AI discovery endpoints. These expose only public catalog information.
app.get('/robots.txt', async (req, res) => {
  const baseUrl = getSiteBaseUrl(req);
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/admin/',
    'Disallow: /api/auth/',
    '',
    'User-agent: OAI-SearchBot',
    'Allow: /',
    '',
    'User-agent: GPTBot',
    'Disallow: /',
    '',
    `Sitemap: ${baseUrl}/sitemap.xml`
  ].join('\n'));
});

app.get('/sitemap.xml', async (req, res) => {
  try {
    const baseUrl = getSiteBaseUrl(req);
    const products = await publicDataOrFallback(() => db.getSeoProducts(), () => fallbackData.getSeoProducts(), res, 'sitemap');
    const urls = [
      `<url><loc>${baseUrl}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
      ...products.map(p => `<url><loc>${baseUrl}/producto/${encodeURIComponent(p.id)}</loc>${p.updatedAt ? `<lastmod>${new Date(p.updatedAt).toISOString()}</lastmod>` : ''}<changefreq>weekly</changefreq><priority>0.8</priority></url>`)
    ];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
  } catch (err) {
    res.status(500).type('text/plain').send('No se pudo generar el sitemap.');
  }
});

app.get('/llms.txt', async (req, res) => {
  const baseUrl = getSiteBaseUrl(req);
  let products = [];
  try { products = (await publicDataOrFallback(() => db.getSeoProducts(), () => fallbackData.getSeoProducts(), res, 'llms')).slice(0, 50); } catch (_) { products = fallbackData.getSeoProducts().slice(0, 50); }
  const lines = [
    '# PINPOP',
    '',
    '> Catálogo paraguayo de pins y charms compatibles con calzados tipo Crocs y accesorios decorativos para estetoscopios.',
    '',
    '- Idioma: español (Paraguay)',
    '- Moneda: guaraní paraguayo (PYG)',
    '- Cobertura: Asunción y Paraguay',
    '- Compra: catálogo online, carrito y confirmación por WhatsApp',
    '- WhatsApp: +595 991 950 031',
    `- Sitio: ${baseUrl}/`,
    '',
    '## Productos públicos',
    ...products.map(p => `- ${p.name}: ${baseUrl}/producto/${encodeURIComponent(p.id)}`)
  ];
  res.type('text/plain').send(lines.join('\n'));
});

app.get('/producto/:id', async (req, res) => {
  try {
    const product = await publicDataOrFallback(() => db.getPublicProductById(req.params.id), () => fallbackData.getProductById(req.params.id), res, 'product-page');
    if (!product) return res.status(404).type('html').send('<!doctype html><html lang="es"><meta charset="utf-8"><title>Producto no encontrado | PINPOP</title><body><p>Producto no encontrado.</p><a href="/">Volver a PINPOP</a></body></html>');

    const settings = await publicDataOrFallback(() => db.getPublicSettings(), fallbackData.settings, res, 'product-settings');
    const baseUrl = getSiteBaseUrl(req);
    const canonical = `${baseUrl}/producto/${encodeURIComponent(product.id)}`;
    const productImage = absoluteAssetUrl(baseUrl, product.image);
    const gallery = parseGalleryImages(product.galleryImages).map(url => absoluteAssetUrl(baseUrl, url));
    const images = [...new Set([productImage, ...gallery])];
    const effectivePrice = Number(product.promoPrice || product.price || 0);
    const availability = Number(product.stock || 0) > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';
    const description = product.description || `Pin decorativo ${product.targetType === 'estetoscopio' ? 'para estetoscopio' : 'compatible con calzados tipo Crocs'}, disponible en Paraguay.`;
    const jsonLd = {
      '@context': 'https://schema.org/',
      '@type': 'Product',
      name: product.name,
      image: images,
      description,
      sku: product.sku,
      brand: { '@type': 'Brand', name: 'PINPOP' },
      category: product.category,
      offers: {
        '@type': 'Offer',
        url: canonical,
        priceCurrency: 'PYG',
        price: effectivePrice,
        availability,
        itemCondition: 'https://schema.org/NewCondition'
      }
    };
    const safeJsonLd = JSON.stringify(jsonLd).replace(/</g, '\\u003c');
    const whatsapp = String(settings.whatsappNumber || '595991950031').replace(/\D/g, '');
    const openInCatalog = `/?producto=${encodeURIComponent(product.id)}`;
    const html = `<!doctype html>
<html lang="es-PY"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtmlServer(product.name)} | PINPOP Paraguay</title>
<meta name="description" content="${escapeHtmlServer(description).slice(0, 160)}">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
<link rel="canonical" href="${escapeHtmlServer(canonical)}">
<meta property="og:type" content="product"><meta property="og:site_name" content="PINPOP">
<meta property="og:title" content="${escapeHtmlServer(product.name)} | PINPOP">
<meta property="og:description" content="${escapeHtmlServer(description).slice(0, 200)}">
<meta property="og:image" content="${escapeHtmlServer(productImage)}"><meta property="og:url" content="${escapeHtmlServer(canonical)}">
<meta property="product:price:amount" content="${effectivePrice}"><meta property="product:price:currency" content="PYG">
<script type="application/ld+json">${safeJsonLd}</script>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f4f5f7;color:#111;margin:0}.wrap{max-width:760px;margin:0 auto;padding:28px 18px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:24px;padding:20px;box-shadow:0 8px 30px #0000000d}.logo{height:58px}.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:22px}.img{width:100%;aspect-ratio:1;object-fit:contain;background:#f8fafc;border-radius:18px}.price{font-size:26px;font-weight:900}.tag{color:#ff2d8a;font-weight:800}.btn{display:inline-block;background:#ff2d8a;color:#fff;text-decoration:none;padding:13px 18px;border-radius:14px;font-weight:900}.muted{color:#64748b;font-size:14px}@media(max-width:640px){.grid{grid-template-columns:1fr}}</style>
</head><body><main class="wrap"><a href="/"><img class="logo" src="/images/brand/pinpop-logo-web.png" alt="PINPOP"></a><div class="card grid"><div><img class="img" src="${escapeHtmlServer(productImage)}" alt="${escapeHtmlServer(product.name)}"></div><div><div class="tag">${escapeHtmlServer(product.category)}</div><h1>${escapeHtmlServer(product.name)}</h1><div class="price">Gs. ${effectivePrice.toLocaleString('es-PY')}</div><p>${escapeHtmlServer(description)}</p><p class="muted">${Number(product.stock || 0) > 0 ? `Disponible: ${Number(product.stock)} unidades` : 'Agotado'}</p><a class="btn" href="${openInCatalog}">Ver en catálogo y agregar al carrito</a><p class="muted">Pedidos y confirmación por WhatsApp: +595 991 950 031</p></div></div></main></body></html>`;
    res.type('html').send(html);
  } catch (err) {
    console.error('SEO product page error:', err);
    res.status(500).type('text/plain').send('No se pudo cargar el producto.');
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
  if (!adminSecurityReady) {
    return res.status(503).json({ error: 'Administración no configurada de forma segura. JWT_SECRET ≥32 y ADMIN_PASSWORD ≥12.' });
  }

  try {
    await ensureDatabaseReady();
  } catch (err) {
    console.error('PINPOP login database error:', err.message);
    return res.status(503).json({ error: 'Base de datos no disponible temporalmente.' });
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
async function requirePersistentDatabase(req, res, next) {
  if (process.env.NETLIFY === 'true' && !process.env.DATABASE_URL) {
    return res.status(503).json({
      error: 'Base persistente no configurada. En Netlify, defina DATABASE_URL antes de modificar catálogo, stock o pedidos.'
    });
  }
  try {
    await ensureDatabaseReady();
    return next();
  } catch (err) {
    console.error('PINPOP persistent database error:', err.message);
    return res.status(503).json({ error: 'Base de datos persistente no disponible temporalmente.' });
  }
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
    const previous = await db.getProductById(req.params.id);
    const updated = await db.updateProductAdmin(req.params.id, req.body);
    await cleanupRemovedManagedImages(previous, updated);
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
  const targetType = req.query.targetType || null;
  const fallbackCategories = targetType
    ? fallbackData.categories.filter(c => (c.targetType || c.target_type || 'crocs') === targetType)
    : fallbackData.categories;
  const cats = await publicDataOrFallback(
    () => db.getCategories(targetType),
    fallbackCategories,
    res,
    'categories'
  );
  res.json(cats);
});

app.get('/api/admin/categories', authenticateAdmin, async (req, res) => {
  try {
    res.json(await db.getAllCategoriesAdmin());
  } catch (err) {
    res.status(500).json({ error: 'No se pudieron cargar las categorías.' });
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

app.put('/api/admin/categories/:id', authenticateAdmin, requirePersistentDatabase, async (req, res) => {
  try {
    res.json(await db.updateCategoryAdmin(req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/categories/:id/activate', authenticateAdmin, requirePersistentDatabase, async (req, res) => {
  try {
    res.json(await db.activateCategoryAdmin(req.params.id));
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

// Admin: Upload pin photo. The server validates real file signatures before persistence.
app.post('/api/admin/upload', authenticateAdmin, requirePersistentDatabase, uploadLimiter, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'La imagen excede el límite máximo permitido de 4MB.' });
      return res.status(400).json({ error: 'No se pudo procesar la carga de imagen.' });
    }
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file?.buffer) return res.status(400).json({ error: 'No se envió ningún archivo de imagen.' });

    try {
      const saved = await imageStorage.saveImage(req.file.buffer, req.file.mimetype);
      return res.status(201).json(saved);
    } catch (storageErr) {
      console.error('PINPOP image upload error:', storageErr);
      const publicMessage = /formato|imagen|tipo real|vacío|4MB/i.test(storageErr.message || '')
        ? storageErr.message
        : 'No se pudo guardar la imagen en el almacenamiento persistente.';
      return res.status(400).json({ error: publicMessage });
    }
  });
});

app.post('/api/admin/upload/delete', authenticateAdmin, requirePersistentDatabase, uploadLimiter, async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !imageStorage.isManagedImageUrl(url)) {
      return res.status(400).json({ error: 'La imagen indicada no pertenece al almacenamiento administrado por PINPOP.' });
    }
    const result = await imageStorage.deleteImageByUrl(url);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('PINPOP image delete error:', err);
    res.status(500).json({ error: 'No se pudo eliminar la imagen.' });
  }
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
    if (!newPassword || newPassword.length < 12) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 12 caracteres.' });
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
