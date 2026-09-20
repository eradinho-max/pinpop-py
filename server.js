require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const QRCode = require('qrcode');

const db = require('./database');
const imageStorage = require('./storage');
const fallbackData = require('./fallback-data');

const app = express();
const PORT = process.env.PORT || 3000;
const isNetlifyRuntime = process.env.NETLIFY === 'true';

// Trust reverse proxy (Vercel, Railway, Render, Cloudflare, Nginx)
app.set('trust proxy', 1);

// ==========================================
// SIMPLE ADMIN SECURITY: PASSWORD + TOTP + HTTPONLY COOKIE
// ==========================================
const isProduction = process.env.NODE_ENV === 'production' || process.env.NETLIFY === 'true';
const configuredAdminPassword = process.env.ADMIN_PASSWORD || '';
const adminPasswordReady = configuredAdminPassword.length >= 12;
const SESSION_COOKIE = 'pinpop_admin_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

if (isProduction && !adminPasswordReady) {
  console.warn('⚠️ PINPOP: Admin deshabilitado. Configure ADMIN_PASSWORD con al menos 12 caracteres.');
}

function adminPasswordFingerprint() {
  return crypto.createHash('sha256').update(`pinpop-admin-v2|${configuredAdminPassword}`).digest('hex');
}

function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    output += alphabet[parseInt(chunk, 2)];
  }
  return output;
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of String(input || '').replace(/=+$/g, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('TOTP secret inválido.');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function generateTotp(secret, timeMs = Date.now()) {
  const counter = Math.floor(timeMs / 30000);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

function verifyTotp(token, secret) {
  const clean = String(token || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  for (const drift of [-30000, 0, 30000]) {
    if (crypto.timingSafeEqual(Buffer.from(clean), Buffer.from(generateTotp(secret, Date.now() + drift)))) return true;
  }
  return false;
}

function timingSafeTextEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a || '')).digest();
  const bh = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function sessionSigningKey() {
  return crypto.createHash('sha256').update(`${configuredAdminPassword}|pinpop-session-v2`).digest();
}

function createSessionToken() {
  const payload = Buffer.from(JSON.stringify({ sub: 'admin', exp: Date.now() + SESSION_TTL_SECONDS * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSigningKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return false;
    const expected = crypto.createHmac('sha256', sessionSigningKey()).update(payload).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.sub === 'admin' && Number(data.exp) > Date.now();
  } catch (_) { return false; }
}

function readCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const item of cookies) {
    const idx = item.indexOf('=');
    if (idx < 0) continue;
    if (item.slice(0, idx).trim() === name) return decodeURIComponent(item.slice(idx + 1).trim());
  }
  return null;
}

function setAdminSessionCookie(res) {
  const secure = isProduction ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(createSessionToken())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure}`);
}

function clearAdminSessionCookie(res) {
  const secure = isProduction ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
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
      imgSrc: ["'self'", "data:", "blob:"],
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
// ADMIN SESSION MIDDLEWARE
// ==========================================
async function authenticateAdmin(req, res, next) {
  if (!adminPasswordReady) {
    return res.status(503).json({ error: 'Administración no configurada. Defina ADMIN_PASSWORD.' });
  }
  const token = readCookie(req, SESSION_COOKIE);
  if (!verifySessionToken(token)) {
    return res.status(401).json({ error: 'Sesión inválida o expirada.' });
  }
  req.user = { username: 'admin', role: 'admin' };
  return next();
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
    databaseError = err && err.message ? err.message : 'Storage initialization failed';
  }
  let totpConfigured = false;
  if (databaseHealthy && adminPasswordReady) {
    try {
      const status = await db.syncAdminSecurity(adminPasswordFingerprint());
      totpConfigured = Boolean(status.totpEnabled);
    } catch (_) {}
  }
  res.status(200).json({
    ok: true,
    runtime: isNetlifyRuntime ? 'netlify' : 'node',
    database: isNetlifyRuntime ? 'netlify-blobs' : 'memory-dev',
    databaseHealthy,
    publicCatalogSource: databaseHealthy ? 'netlify-blobs' : 'bundled-readonly-fallback',
    adminConfigured: adminPasswordReady && databaseHealthy,
    totpConfigured,
    databaseError: databaseHealthy ? null : databaseError
  });
});

async function publicDataOrFallback(dbGetter, fallbackValue, res, label) {
  try {
    await ensureDatabaseReady();
    const value = await dbGetter();
    res.setHeader('X-PINPOP-Data-Source', 'netlify-blobs');
    return value;
  } catch (err) {
    console.error(`PINPOP ${label} storage fallback:`, err.message);
    res.setHeader('X-PINPOP-Data-Source', 'bundled-readonly-fallback');
    res.setHeader('X-PINPOP-Degraded', '1');
    return typeof fallbackValue === 'function' ? fallbackValue() : fallbackValue;
  }
}

// Public browsing remains available during a database outage.
// Writes, Admin and order creation remain fail-closed.
app.get('/api/products', async (req, res) => {
  const products = await publicDataOrFallback(
    () => db.getPublicProducts(),
    fallbackData.products,
    res,
    'catalog'
  );
  res.setHeader('X-PINPOP-Orders-Ready', res.getHeader('X-PINPOP-Degraded') === '1' ? '0' : '1');
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
app.get('/api/auth/setup-status', loginLimiter, async (req, res) => {
  if (!adminPasswordReady) {
    return res.status(200).json({ passwordConfigured: false, totpConfigured: false, setupRequired: true });
  }
  try {
    await ensureDatabaseReady();
    const status = await db.syncAdminSecurity(adminPasswordFingerprint());
    return res.json({ passwordConfigured: true, totpConfigured: Boolean(status.totpEnabled), setupRequired: !status.totpEnabled });
  } catch (err) {
    console.error('PINPOP 2FA status error:', err.message);
    return res.status(503).json({ error: 'Almacenamiento temporalmente no disponible.' });
  }
});

app.post('/api/auth/setup/start', loginLimiter, async (req, res) => {
  if (!adminPasswordReady) {
    return res.status(503).json({ error: 'Configure ADMIN_PASSWORD en Netlify antes del primer acceso.' });
  }
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'La contraseña es obligatoria.' });
  if (!timingSafeTextEqual(password, configuredAdminPassword)) {
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }
  try {
    await ensureDatabaseReady();
    const fingerprint = adminPasswordFingerprint();
    const status = await db.syncAdminSecurity(fingerprint);
    if (status.totpEnabled) return res.status(409).json({ error: 'El 2FA ya está configurado. Inicie sesión normalmente.' });
    const secret = generateTotpSecret();
    await db.beginAdminTotpSetup(fingerprint, secret);
    const otpauthUri = `otpauth://totp/${encodeURIComponent('PINPOP:admin')}?secret=${secret}&issuer=${encodeURIComponent('PINPOP')}&algorithm=SHA1&digits=6&period=30`;
    const qrDataUrl = await QRCode.toDataURL(otpauthUri, { width: 240, margin: 1, errorCorrectionLevel: 'M' });
    return res.json({ setupRequired: true, qrDataUrl, manualKey: secret, account: 'PINPOP:admin' });
  } catch (err) {
    console.error('PINPOP 2FA setup start error:', err.message);
    return res.status(503).json({ error: 'No se pudo iniciar la configuración 2FA.' });
  }
});

app.post('/api/auth/setup/confirm', loginLimiter, async (req, res) => {
  if (!adminPasswordReady) return res.status(503).json({ error: 'Admin no configurado.' });
  const { password, totp } = req.body || {};
  if (!password || !totp) return res.status(400).json({ error: 'Contraseña y código 2FA son obligatorios.' });
  if (!timingSafeTextEqual(password, configuredAdminPassword)) {
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }
  try {
    await ensureDatabaseReady();
    const fingerprint = adminPasswordFingerprint();
    await db.syncAdminSecurity(fingerprint);
    const pendingSecret = await db.getAdminTotpPending(fingerprint);
    if (!pendingSecret) return res.status(409).json({ error: 'No hay una configuración 2FA pendiente. Comience nuevamente.' });
    if (!verifyTotp(totp, pendingSecret)) return res.status(401).json({ error: 'Código 2FA incorrecto. Verifique la hora del celular e intente nuevamente.' });
    await db.confirmAdminTotpSetup(fingerprint, pendingSecret);
    setAdminSessionCookie(res);
    return res.json({ authenticated: true, configured: true, expiresIn: '8h', user: { username: 'admin', role: 'admin' } });
  } catch (err) {
    console.error('PINPOP 2FA setup confirm error:', err.message);
    return res.status(503).json({ error: 'No se pudo confirmar la configuración 2FA.' });
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  if (!adminPasswordReady) {
    return res.status(503).json({ error: 'Admin no configurado. Defina ADMIN_PASSWORD en Netlify.' });
  }
  const { password, totp } = req.body || {};
  if (!password || !totp) return res.status(400).json({ error: 'Contraseña y código 2FA son obligatorios.' });
  if (!timingSafeTextEqual(password, configuredAdminPassword)) {
    return res.status(401).json({ error: 'Contraseña o código 2FA incorrecto.' });
  }
  try {
    await ensureDatabaseReady();
    const fingerprint = adminPasswordFingerprint();
    const status = await db.syncAdminSecurity(fingerprint);
    if (!status.totpEnabled) {
      return res.status(428).json({ error: 'El 2FA todavía no está configurado.', setupRequired: true });
    }
    const secret = await db.getAdminTotpSecret(fingerprint);
    if (!secret || !verifyTotp(totp, secret)) {
      return res.status(401).json({ error: 'Contraseña o código 2FA incorrecto.' });
    }
    setAdminSessionCookie(res);
    return res.json({ authenticated: true, expiresIn: '8h', user: { username: 'admin', role: 'admin' } });
  } catch (err) {
    console.error('PINPOP login error:', err.message);
    return res.status(503).json({ error: 'Almacenamiento temporalmente no disponible.' });
  }
});

app.get('/api/auth/session', authenticateAdmin, (req, res) => {
  res.json({ authenticated: true, user: req.user });
});

app.post('/api/auth/logout', (req, res) => {
  clearAdminSessionCookie(res);
  res.json({ success: true });
});

// ==========================================
// PERSISTENCE GUARD — Netlify Blobs
// ==========================================
async function requirePersistentDatabase(req, res, next) {
  try {
    await ensureDatabaseReady();
    return next();
  } catch (err) {
    console.error('PINPOP storage error:', err.message);
    return res.status(503).json({ error: 'Almacenamiento persistente no disponible temporalmente.' });
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
app.post('/api/admin/change-password', authenticateAdmin, (req, res) => {
  res.status(409).json({ error: 'La contraseña se administra en Netlify mediante ADMIN_PASSWORD. Cambie la variable y haga un nuevo deploy.' });
});

// Public media stored in Netlify Blobs. Long cache because every upload uses a unique key.
app.get('/api/media/:id', async (req, res) => {
  try {
    const media = await imageStorage.getImageById(req.params.id);
    if (!media) return res.status(404).end();
    res.setHeader('Content-Type', media.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(media.buffer);
  } catch (err) {
    console.error('PINPOP media read error:', err.message);
    return res.status(404).end();
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
