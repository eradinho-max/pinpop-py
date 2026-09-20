const crypto = require('crypto');
const fallbackData = require('./fallback-data');

const STATE_KEY = 'pinpop-data/state-v1.json';
let localState = null;
let blobModulePromise = null;
let mutationQueue = Promise.resolve();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function randomId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function sanitizeString(str, maxLen = 255) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<[^>]*>?/gm, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
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
  if ((local.startsWith('images/') || local.startsWith('api/media/')) && !local.includes('..') && /^[A-Za-z0-9_./?=&%-]+$/.test(local)) {
    return url.startsWith('/') ? `/${local}` : `/${local}`;
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
function normalizeParaguayWhatsapp(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('5950')) digits = '595' + digits.slice(4);
  if (digits.startsWith('0') && digits.length === 10) digits = '595' + digits.slice(1);
  if (digits.startsWith('9') && digits.length === 9) digits = '595' + digits;
  if (!/^5959\d{8}$/.test(digits)) {
    throw new Error('Número de WhatsApp inválido. Use un celular paraguayo, por ejemplo +595 991 950 031.');
  }
  return digits;
}

function normalizeFallbackProduct(p) {
  const gallery = Array.isArray(p.galleryImages)
    ? p.galleryImages
    : (() => { try { return JSON.parse(p.gallery_images || '[]'); } catch (_) { return []; } })();
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    category: p.category || 'Otros',
    target_type: p.target_type || p.targetType || 'crocs',
    price: Number(p.price) || 0,
    promo_price: p.promo_price ?? p.promoPrice ?? null,
    cost_price: Number(p.cost_price ?? p.costPrice ?? 0) || 0,
    stock: Number(p.stock) || 0,
    min_stock: Number(p.min_stock ?? p.minStock ?? 3) || 3,
    image: p.image,
    description: p.description || '',
    badge: p.badge || '',
    sales_count: Number(p.sales_count ?? p.salesCount ?? 0) || 0,
    active: p.active === false || p.active === 0 ? 0 : 1,
    featured: p.featured ? 1 : 0,
    gallery_images: gallery,
    created_at: p.created_at || new Date().toISOString(),
    updated_at: p.updated_at || new Date().toISOString()
  };
}

function makeInitialState() {
  return {
    version: 1,
    products: fallbackData.products.map(normalizeFallbackProduct),
    categories: fallbackData.categories.map(c => ({
      id: c.id || randomId('cat'),
      name: c.name,
      target_type: c.target_type || c.targetType || 'crocs',
      active: c.active === false || c.active === 0 ? 0 : 1,
      created_at: c.created_at || new Date().toISOString()
    })),
    settings: {
      ...clone(fallbackData.settings || {}),
      whatsappNumber: DEFAULT_WHATSAPP_NUMBER
    },
    orders: [],
    order_items: [],
    stock_movements: [],
    security: {
      password_fingerprint: '',
      totp_enabled: false,
      totp_secret: '',
      totp_pending_secret: '',
      totp_pending_at: null,
      totp_enabled_at: null
    },
    counters: { order: 1000 }
  };
}

function isVercelRuntime() {
  return process.env.VERCEL === '1' || process.env.VERCEL_ENV || process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_OIDC_TOKEN;
}

async function getBlobModule() {
  if (!isVercelRuntime()) return null;
  if (!blobModulePromise) blobModulePromise = import('@vercel/blob');
  return blobModulePromise;
}

async function readPrivateJson(pathname) {
  const blob = await getBlobModule();
  if (!blob) return null;
  const result = await blob.get(pathname, { access: 'private', useCache: false });
  if (!result) return null;
  const text = await new Response(result.stream).text();
  if (!text) return null;
  return JSON.parse(text);
}

async function writePrivateJson(pathname, value) {
  const blob = await getBlobModule();
  if (!blob) throw new Error('Vercel Blob no está disponible.');
  return blob.put(pathname, JSON.stringify(value), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json'
  });
}

async function readStateWithMeta() {
  const blob = await getBlobModule();
  if (!blob) {
    if (!localState) localState = makeInitialState();
    return { data: clone(localState), provider: 'memory-dev' };
  }

  let data = await readPrivateJson(STATE_KEY);
  if (!data) {
    data = makeInitialState();
    await writePrivateJson(STATE_KEY, data);
  }
  return { data, provider: 'vercel-blob' };
}

async function readState() {
  const entry = await readStateWithMeta();
  return clone(entry.data);
}

async function mutateState(work) {
  const blob = await getBlobModule();
  if (!blob) {
    if (!localState) localState = makeInitialState();
    const draft = clone(localState);
    const result = await work(draft);
    localState = draft;
    return result;
  }

  // Serialize mutations inside each warm function instance. PINPOP is a small-store
  // workload; Vercel Blob remains the single persistent source of truth.
  const task = mutationQueue.then(async () => {
    const current = await readState();
    const draft = clone(current);
    const result = await work(draft);
    draft.version = Math.max(1, Number(draft.version) || 1) + 1;
    await writePrivateJson(STATE_KEY, draft);
    return result;
  });
  mutationQueue = task.catch(() => undefined);
  return task;
}


function ensureSecurityState(state) {
  if (!state.security || typeof state.security !== 'object') state.security = {};
  const sec = state.security;
  if (typeof sec.password_fingerprint !== 'string') sec.password_fingerprint = '';
  if (typeof sec.totp_enabled !== 'boolean') sec.totp_enabled = false;
  if (typeof sec.totp_secret !== 'string') sec.totp_secret = '';
  if (typeof sec.totp_pending_secret !== 'string') sec.totp_pending_secret = '';
  if (!('totp_pending_at' in sec)) sec.totp_pending_at = null;
  if (!('totp_enabled_at' in sec)) sec.totp_enabled_at = null;
  return sec;
}

async function syncAdminSecurity(passwordFingerprint) {
  if (!passwordFingerprint) throw new Error('Fingerprint de contraseña inválido.');
  return mutateState(async state => {
    const sec = ensureSecurityState(state);
    if (sec.password_fingerprint && sec.password_fingerprint !== passwordFingerprint) {
      sec.password_fingerprint = passwordFingerprint;
      sec.totp_enabled = false;
      sec.totp_secret = '';
      sec.totp_pending_secret = '';
      sec.totp_pending_at = null;
      sec.totp_enabled_at = null;
    } else if (!sec.password_fingerprint) {
      sec.password_fingerprint = passwordFingerprint;
    }
    return {
      totpEnabled: Boolean(sec.totp_enabled && sec.totp_secret),
      pending: Boolean(sec.totp_pending_secret),
      pendingAt: sec.totp_pending_at || null,
      enabledAt: sec.totp_enabled_at || null
    };
  });
}

async function beginAdminTotpSetup(passwordFingerprint, secret) {
  if (!passwordFingerprint || !secret) throw new Error('Datos de configuración 2FA inválidos.');
  return mutateState(async state => {
    const sec = ensureSecurityState(state);
    if (sec.password_fingerprint && sec.password_fingerprint !== passwordFingerprint) {
      sec.totp_enabled = false;
      sec.totp_secret = '';
    }
    sec.password_fingerprint = passwordFingerprint;
    if (sec.totp_enabled && sec.totp_secret) throw new Error('El 2FA ya está configurado.');
    sec.totp_pending_secret = secret;
    sec.totp_pending_at = new Date().toISOString();
    return { success: true };
  });
}

async function getAdminTotpPending(passwordFingerprint) {
  const state = await readState();
  const sec = ensureSecurityState(state);
  if (!passwordFingerprint || sec.password_fingerprint !== passwordFingerprint) return '';
  return sec.totp_pending_secret || '';
}

async function getAdminTotpSecret(passwordFingerprint) {
  const state = await readState();
  const sec = ensureSecurityState(state);
  if (!passwordFingerprint || sec.password_fingerprint !== passwordFingerprint || !sec.totp_enabled) return '';
  return sec.totp_secret || '';
}

async function confirmAdminTotpSetup(passwordFingerprint, secret) {
  if (!passwordFingerprint || !secret) throw new Error('Datos de confirmación 2FA inválidos.');
  return mutateState(async state => {
    const sec = ensureSecurityState(state);
    if (sec.password_fingerprint !== passwordFingerprint) throw new Error('La contraseña administrativa cambió. Reinicie la configuración 2FA.');
    if (sec.totp_pending_secret !== secret) throw new Error('La configuración 2FA pendiente ya no es válida.');
    sec.totp_secret = secret;
    sec.totp_enabled = true;
    sec.totp_enabled_at = new Date().toISOString();
    sec.totp_pending_secret = '';
    sec.totp_pending_at = null;
    return { success: true, enabledAt: sec.totp_enabled_at };
  });
}

async function initDatabase() {
  await readStateWithMeta();
  return true;
}

function publicProduct(p) {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    category: p.category,
    target_type: p.target_type,
    targetType: p.target_type || 'crocs',
    price: Number(p.price) || 0,
    promo_price: p.promo_price ?? null,
    promoPrice: p.promo_price ?? null,
    stock: Number(p.stock) || 0,
    image: p.image,
    description: p.description || '',
    badge: p.badge || '',
    active: Boolean(p.active),
    featured: Boolean(p.featured),
    gallery_images: JSON.stringify(p.gallery_images || []),
    galleryImages: Array.isArray(p.gallery_images) ? p.gallery_images : [],
    updated_at: p.updated_at,
    updatedAt: p.updated_at
  };
}

function adminProduct(p) {
  return {
    ...publicProduct(p),
    cost_price: Number(p.cost_price) || 0,
    costPrice: Number(p.cost_price) || 0,
    min_stock: Number(p.min_stock) || 0,
    minStock: Number(p.min_stock) || 0,
    sales_count: Number(p.sales_count) || 0,
    salesCount: Number(p.sales_count) || 0,
    created_at: p.created_at,
    createdAt: p.created_at
  };
}

async function getPublicProducts() {
  const state = await readState();
  return state.products
    .filter(p => Boolean(p.active))
    .sort((a, b) => Number(b.featured || 0) - Number(a.featured || 0) || String(a.id).localeCompare(String(b.id)))
    .map(publicProduct);
}

async function getPublicProductById(id) {
  const state = await readState();
  const p = state.products.find(p => p.id === id && Boolean(p.active));
  return p ? publicProduct(p) : null;
}

async function getSeoProducts() {
  const state = await readState();
  return state.products.filter(p => Boolean(p.active)).map(p => ({ id: p.id, name: p.name, updatedAt: p.updated_at || null }));
}

async function getPublicSettings() {
  const state = await readState();
  return clone(state.settings || {});
}

async function createOrderSecure({ customer, items }) {
  if (!items || !Array.isArray(items) || items.length === 0) throw new Error('El carrito no puede estar vacío.');
  if (!customer || !customer.name || !customer.phone) throw new Error('Nombre y teléfono son obligatorios.');

  const safeName = sanitizeString(customer.name, 100);
  const safePhone = sanitizeString(customer.phone, 30);
  const safeAddress = sanitizeString(customer.address, 200);
  const safePayment = sanitizeString(customer.paymentMethod, 60);
  const safeNotes = sanitizeString(customer.notes, 250);
  const safeDeliveryType = customer.deliveryType === 'pickup' ? 'pickup' : 'delivery';

  const created = await mutateState(async state => {
    let subtotal = 0;
    const verifiedItems = [];
    for (const item of items) {
      const qty = parseInt(item.quantity, 10);
      if (!Number.isInteger(qty) || qty <= 0 || qty > 100) throw new Error('Cantidad inválida para el producto.');
      const prod = state.products.find(p => p.id === item.productId && Boolean(p.active));
      if (!prod) throw new Error('El producto seleccionado no existe o está inactivo.');
      if (Number(prod.stock) < qty) throw new Error(`Stock insuficiente para "${prod.name}". Stock disponible: ${prod.stock}.`);
      const price = prod.promo_price !== null && Number(prod.promo_price) > 0 ? Number(prod.promo_price) : Number(prod.price);
      const lineTotal = price * qty;
      subtotal += lineTotal;
      verifiedItems.push({ productId: prod.id, sku: prod.sku, name: prod.name, image: prod.image, price, quantity: qty, lineTotal });
    }

    const settings = state.settings || {};
    const fee = Number(settings.deliveryFee || 15000);
    const threshold = Number(settings.freeDeliveryThreshold || 100000);
    const deliveryFee = safeDeliveryType === 'delivery' && subtotal < threshold ? fee : 0;
    const total = subtotal + deliveryFee;
    state.counters = state.counters || { order: 1000 };
    state.counters.order = Math.max(1000, Number(state.counters.order) || 1000) + 1;
    const orderId = `P${state.counters.order}`;
    const now = new Date().toISOString();

    state.orders.push({
      id: orderId,
      customer_name: safeName,
      customer_phone: safePhone,
      delivery_type: safeDeliveryType,
      address: safeAddress,
      payment_method: safePayment,
      notes: safeNotes,
      subtotal,
      delivery_fee: deliveryFee,
      total,
      status: 'pending',
      stock_deducted: 0,
      confirmed_at: null,
      delivered_at: null,
      cancelled_at: null,
      created_at: now
    });
    for (const it of verifiedItems) {
      state.order_items.push({ id: randomId('item'), order_id: orderId, product_id: it.productId, product_name: it.name, sku: it.sku, price: it.price, quantity: it.quantity, line_total: it.lineTotal });
    }
    return { orderId, now, verifiedItems, subtotal, deliveryFee, total, settings: clone(settings) };
  });

  const { orderId, now, verifiedItems, subtotal, deliveryFee, total, settings } = created;
  const formatPrice = v => `Gs. ${Number(v).toLocaleString('es-PY')}`;
  let msg = `Hola 👋 Quiero realizar el pedido #${orderId}\n\n`;
  verifiedItems.forEach(it => { msg += `${it.quantity}x ${it.name} — ${formatPrice(it.lineTotal)}\n`; });
  msg += `\nTotal: ${formatPrice(total)}`;
  if (safeName) msg += `\n\n👤 *Cliente:* ${safeName}`;
  if (safeDeliveryType === 'delivery' && safeAddress) msg += `\n📍 *Entrega:* ${safeAddress}`;
  else if (safeDeliveryType === 'pickup') msg += '\n🏪 *Retiro en local*';
  if (safePayment) msg += `\n💳 *Pago:* ${safePayment}`;
  if (safeNotes) msg += `\n📝 *Nota:* ${safeNotes}`;
  const rawPhone = String(settings.whatsappNumber || DEFAULT_WHATSAPP_NUMBER).replace(/\D/g, '');

  return {
    order: {
      id: orderId,
      customer: { name: safeName, phone: safePhone, deliveryType: safeDeliveryType, address: safeAddress, paymentMethod: safePayment, notes: safeNotes },
      items: verifiedItems,
      subtotal,
      deliveryFee,
      total,
      status: 'pending',
      createdAt: now
    },
    whatsappUrl: `https://wa.me/${rawPhone}?text=${encodeURIComponent(msg)}`,
    formattedMessage: msg
  };
}

async function verifyAdminPassword() { return false; }
async function updateAdminPassword() { throw new Error('La contraseña se administra desde las variables de entorno de Vercel.'); }

async function getAllProductsAdmin() {
  const state = await readState();
  return state.products
    .slice()
    .sort((a, b) => Number(b.active) - Number(a.active) || String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .map(adminProduct);
}

async function getProductById(id) {
  const state = await readState();
  const p = state.products.find(p => p.id === id);
  return p ? adminProduct(p) : null;
}

function generateSku(state, category, targetType) {
  const base = sanitizeString(category || (targetType === 'estetoscopio' ? 'EST' : 'PIN'), 20)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 3) || 'PIN';
  let n = 1;
  let sku;
  do { sku = `${base}-${String(n++).padStart(3, '0')}`; } while (state.products.some(p => p.sku === sku));
  return sku;
}

async function createProductAdmin(data) {
  return mutateState(async state => {
    const now = new Date().toISOString();
    const name = sanitizeString(data.name, 150);
    if (!name) throw new Error('El nombre del producto es obligatorio.');
    const targetType = data.targetType === 'estetoscopio' ? 'estetoscopio' : 'crocs';
    const category = sanitizeString(data.category, 60) || 'Otros';
    const price = Number(data.price);
    const stock = Math.max(0, Math.trunc(Number(data.stock) || 0));
    const minStock = Math.max(0, Math.trunc(Number(data.minStock ?? 3) || 0));
    const costPrice = Math.max(0, Number(data.costPrice) || 0);
    const promoPrice = data.promoPrice === '' || data.promoPrice === null || data.promoPrice === undefined ? null : Number(data.promoPrice);
    if (!Number.isFinite(price) || price < 0) throw new Error('El precio debe ser mayor o igual a 0.');
    if (promoPrice !== null && (!Number.isFinite(promoPrice) || promoPrice < 0)) throw new Error('El precio promocional es inválido.');
    const image = normalizeProductImageUrl(data.image, true);
    let sku = data.sku ? sanitizeString(data.sku, 30).toUpperCase().replace(/\s+/g, '-') : generateSku(state, category, targetType);
    if (state.products.some(p => p.sku === sku)) throw new Error(`El código SKU "${sku}" ya existe.`);
    const id = randomId('prod');
    const gallery = normalizeGalleryImages(data.galleryImages || [], image);
    const product = {
      id, sku, name, category, target_type: targetType, price, promo_price: promoPrice,
      cost_price: costPrice, stock, min_stock: minStock, image,
      description: sanitizeString(data.description || '', 500), badge: sanitizeString(data.badge || '', 50),
      sales_count: 0, active: data.active === false ? 0 : 1, featured: data.featured ? 1 : 0,
      gallery_images: gallery, created_at: now, updated_at: now
    };
    state.products.push(product);
    if (stock > 0) state.stock_movements.push({ id: randomId('mov'), product_id: id, sku, product_name: name, type: 'entrada', quantity: stock, prev_stock: 0, new_stock: stock, reason: 'Stock inicial / Alta de producto', order_id: null, created_at: now });
    return adminProduct(product);
  });
}

async function updateProductAdmin(id, data) {
  return mutateState(async state => {
    const p = state.products.find(p => p.id === id);
    if (!p) throw new Error('Producto no encontrado');
    const now = new Date().toISOString();
    if (data.sku !== undefined) {
      const sku = sanitizeString(data.sku, 30).toUpperCase().replace(/\s+/g, '-');
      if (!sku) throw new Error('El SKU es obligatorio.');
      if (state.products.some(x => x.id !== id && x.sku === sku)) throw new Error(`El código SKU "${sku}" ya pertenece a otro producto.`);
      p.sku = sku;
    }
    if (data.name !== undefined) { const name = sanitizeString(data.name, 150); if (!name) throw new Error('El nombre es obligatorio.'); p.name = name; }
    if (data.category !== undefined) p.category = sanitizeString(data.category, 60) || p.category;
    if (data.targetType !== undefined) p.target_type = data.targetType === 'estetoscopio' ? 'estetoscopio' : 'crocs';
    if (data.price !== undefined) { const v = Number(data.price); if (!Number.isFinite(v) || v < 0) throw new Error('Precio inválido.'); p.price = v; }
    if (data.promoPrice !== undefined) { const v = data.promoPrice === '' || data.promoPrice === null ? null : Number(data.promoPrice); if (v !== null && (!Number.isFinite(v) || v < 0)) throw new Error('Precio promocional inválido.'); p.promo_price = v; }
    if (data.costPrice !== undefined) { const v = Number(data.costPrice); if (!Number.isFinite(v) || v < 0) throw new Error('Costo inválido.'); p.cost_price = v; }
    if (data.minStock !== undefined) { const v = Number(data.minStock); if (!Number.isFinite(v) || v < 0) throw new Error('Stock mínimo inválido.'); p.min_stock = Math.trunc(v); }
    if (data.image !== undefined) p.image = data.image === p.image ? p.image : normalizeProductImageUrl(data.image, true);
    if (data.galleryImages !== undefined) p.gallery_images = normalizeGalleryImages(data.galleryImages, p.image);
    if (data.description !== undefined) p.description = sanitizeString(data.description, 500);
    if (data.badge !== undefined) p.badge = sanitizeString(data.badge, 50);
    if (data.active !== undefined) p.active = data.active ? 1 : 0;
    if (data.featured !== undefined) p.featured = data.featured ? 1 : 0;
    p.updated_at = now;
    return adminProduct(p);
  });
}

async function adjustStockAdmin(productId, payload) {
  return mutateState(async state => {
    const p = state.products.find(p => p.id === productId);
    if (!p) throw new Error('Producto no encontrado');
    const prevStock = Number(p.stock) || 0;
    let newStock, delta, movType = 'ajuste';
    const { type, stock: targetStock, quantity, reason = 'Ajuste manual de inventario' } = payload || {};
    if (type === 'entrada') { delta = Math.abs(Number(quantity || 0)); newStock = prevStock + delta; movType = 'entrada'; }
    else if (type === 'salida') { const q = Math.abs(Number(quantity || 0)); delta = -Math.min(prevStock, q); newStock = prevStock + delta; }
    else if (type === 'fijo' || targetStock !== undefined) { newStock = Math.max(0, Math.trunc(Number(targetStock ?? quantity) || 0)); delta = newStock - prevStock; movType = delta >= 0 ? 'entrada' : 'ajuste'; }
    else throw new Error('Debe especificar entrada, salida o stock fijo.');
    if (!Number.isFinite(delta)) throw new Error('Cantidad de stock inválida.');
    p.stock = newStock;
    p.updated_at = new Date().toISOString();
    const safeReason = sanitizeString(reason, 200) || 'Ajuste de inventario';
    state.stock_movements.push({ id: randomId('mov'), product_id: p.id, sku: p.sku, product_name: p.name, type: movType, quantity: delta, prev_stock: prevStock, new_stock: newStock, reason: safeReason, order_id: null, created_at: p.updated_at });
    return { success: true, productId: p.id, sku: p.sku, prevStock, newStock, delta, reason: safeReason };
  });
}

async function getCategories(targetType = null) {
  const state = await readState();
  return state.categories.filter(c => Boolean(c.active) && (!targetType || c.target_type === targetType)).sort((a,b) => a.name.localeCompare(b.name)).map(c => ({ ...c, targetType: c.target_type, active: Boolean(c.active) }));
}

async function getAllCategoriesAdmin() {
  const state = await readState();
  return state.categories.slice().sort((a,b) => Number(b.active)-Number(a.active) || a.target_type.localeCompare(b.target_type) || a.name.localeCompare(b.name)).map(c => ({ ...c, targetType: c.target_type, active: Boolean(c.active), createdAt: c.created_at }));
}

async function createCategoryAdmin({ name, targetType = 'crocs' }) {
  return mutateState(async state => {
    const safeName = sanitizeString(name, 50);
    if (!safeName) throw new Error('El nombre de la categoría es obligatorio.');
    const type = targetType === 'estetoscopio' ? 'estetoscopio' : 'crocs';
    const existing = state.categories.find(c => c.target_type === type && c.name.toLowerCase() === safeName.toLowerCase());
    if (existing) { existing.active = 1; return { ...existing, targetType: type, active: true }; }
    const c = { id: randomId('cat'), name: safeName, target_type: type, active: 1, created_at: new Date().toISOString() };
    state.categories.push(c);
    return { ...c, targetType: type, active: true };
  });
}

async function updateCategoryAdmin(id, { name, targetType, active }) {
  return mutateState(async state => {
    const c = state.categories.find(c => c.id === id);
    if (!c) throw new Error('Categoría no encontrada.');
    const oldName = c.name, oldType = c.target_type;
    const nextName = name !== undefined ? sanitizeString(name, 50) : c.name;
    const nextType = targetType !== undefined ? (targetType === 'estetoscopio' ? 'estetoscopio' : 'crocs') : c.target_type;
    if (!nextName) throw new Error('El nombre de la categoría es obligatorio.');
    if (state.categories.some(x => x.id !== id && x.target_type === nextType && x.name.toLowerCase() === nextName.toLowerCase())) throw new Error(`Ya existe una categoría llamada "${nextName}" en esa línea.`);
    c.name = nextName; c.target_type = nextType; if (active !== undefined) c.active = active ? 1 : 0;
    if (oldName !== nextName || oldType !== nextType) {
      const now = new Date().toISOString();
      state.products.filter(p => p.category === oldName && p.target_type === oldType).forEach(p => { p.category = nextName; p.target_type = nextType; p.updated_at = now; });
    }
    return { ...c, targetType: c.target_type, active: Boolean(c.active) };
  });
}

async function activateCategoryAdmin(id) {
  return mutateState(async state => { const c = state.categories.find(c => c.id === id); if (!c) throw new Error('Categoría no encontrada.'); c.active = 1; return { success: true, id }; });
}
async function deleteCategoryAdmin(id) {
  return mutateState(async state => { const c = state.categories.find(c => c.id === id); if (!c) throw new Error('Categoría no encontrada.'); c.active = 0; return { success: true, id }; });
}
async function softDeleteProductAdmin(id) {
  return mutateState(async state => { const p = state.products.find(p => p.id === id); if (!p) throw new Error('Producto no encontrado'); p.active = 0; p.updated_at = new Date().toISOString(); return { success: true, id, message: 'Producto desactivado (conservando historial comercial).' }; });
}

async function getAllOrdersAdmin() {
  const state = await readState();
  return state.orders.slice().sort((a,b) => String(b.created_at).localeCompare(String(a.created_at))).map(o => ({
    id: o.id,
    customer: { name: o.customer_name, phone: o.customer_phone, deliveryType: o.delivery_type, address: o.address, paymentMethod: o.payment_method, notes: o.notes },
    items: state.order_items.filter(i => i.order_id === o.id).map(i => ({ productId: i.product_id, sku: i.sku, name: i.product_name, price: i.price, quantity: i.quantity, lineTotal: i.line_total, image: state.products.find(p => p.id === i.product_id)?.image || '' })),
    subtotal: o.subtotal, deliveryFee: o.delivery_fee, total: o.total, status: o.status, stockDeducted: Boolean(o.stock_deducted), confirmedAt: o.confirmed_at, deliveredAt: o.delivered_at, cancelledAt: o.cancelled_at, createdAt: o.created_at
  }));
}

async function confirmOrderStockAdmin(orderId) {
  return mutateState(async state => {
    const o = state.orders.find(o => o.id === orderId);
    if (!o) throw new Error('Pedido no encontrado');
    if (o.status === 'cancelled') throw new Error('El pedido está cancelado.');
    if (o.stock_deducted) return { success: true, message: 'El stock ya había sido descontado.' };
    const items = state.order_items.filter(i => i.order_id === orderId);
    for (const item of items) {
      const p = state.products.find(p => p.id === item.product_id);
      if (!p) throw new Error(`Producto no encontrado: ${item.product_name}`);
      if (Number(p.stock) < Number(item.quantity)) throw new Error(`Stock insuficiente para ${p.name}. Disponible: ${p.stock}.`);
    }
    const now = new Date().toISOString();
    for (const item of items) {
      const p = state.products.find(p => p.id === item.product_id);
      const prev = Number(p.stock) || 0, qty = Number(item.quantity) || 0, next = prev - qty;
      p.stock = next; p.sales_count = (Number(p.sales_count)||0) + qty; p.updated_at = now;
      state.stock_movements.push({ id: randomId('mov'), product_id: p.id, sku: p.sku, product_name: p.name, type: 'venta', quantity: -qty, prev_stock: prev, new_stock: next, reason: `Venta pedido #${orderId}`, order_id: orderId, created_at: now });
    }
    o.status = 'confirmed'; o.stock_deducted = 1; o.confirmed_at = now;
    return { success: true, orderId, status: 'confirmed', message: 'Pedido confirmado y stock descontado.' };
  });
}

async function restoreOrderStockAdmin(orderId) {
  return mutateState(async state => {
    const o = state.orders.find(o => o.id === orderId);
    if (!o) throw new Error('Pedido no encontrado');
    const now = new Date().toISOString();
    if (!o.stock_deducted) { o.status = 'cancelled'; o.cancelled_at = now; return { success: true, message: 'Pedido cancelado.' }; }
    const items = state.order_items.filter(i => i.order_id === orderId);
    for (const item of items) {
      const p = state.products.find(p => p.id === item.product_id); if (!p) continue;
      const prev = Number(p.stock)||0, qty = Number(item.quantity)||0, next = prev + qty;
      p.stock = next; p.sales_count = Math.max(0, (Number(p.sales_count)||0)-qty); p.updated_at = now;
      state.stock_movements.push({ id: randomId('mov'), product_id: p.id, sku: p.sku, product_name: p.name, type: 'estorno', quantity: qty, prev_stock: prev, new_stock: next, reason: `Estorno pedido #${orderId}`, order_id: orderId, created_at: now });
    }
    o.status = 'cancelled'; o.stock_deducted = 0; o.cancelled_at = now;
    return { success: true, message: 'Stock estornado y pedido cancelado con éxito.' };
  });
}

async function markOrderDeliveredAdmin(orderId) {
  return mutateState(async state => { const o = state.orders.find(o => o.id === orderId); if (!o) throw new Error('Pedido no encontrado'); if (o.status !== 'confirmed') throw new Error('Solo un pedido confirmado puede marcarse como entregado.'); o.status='delivered'; o.delivered_at=new Date().toISOString(); return { success:true, orderId, status:'delivered', message:'Pedido marcado como entregado.' }; });
}

async function getStockMovementsAdmin(limit = 100) {
  const state = await readState();
  return state.stock_movements.slice().sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
}

async function getStatsAdmin() {
  const state = await readState();
  const products = state.products.filter(p => Boolean(p.active));
  const orders = state.orders;
  const totalProducts = state.products.length;
  const activeProducts = products.length;
  const totalStockUnits = products.reduce((a,p)=>a+(Number(p.stock)||0),0);
  const totalInventoryRetailValue = products.reduce((a,p)=>a+(Number(p.stock)||0)*(Number(p.price)||0),0);
  const totalInventoryCostValue = products.reduce((a,p)=>a+(Number(p.stock)||0)*(Number(p.cost_price)||0),0);
  const outOfStockCount = products.filter(p => Number(p.stock)<=0).length;
  const lowStockCount = products.filter(p => Number(p.stock)>0 && Number(p.stock)<=Number(p.min_stock||3)).length;
  const confirmedOrders = orders.filter(o=>o.status==='confirmed').length;
  const deliveredOrders = orders.filter(o=>o.status==='delivered').length;
  const pendingOrders = orders.filter(o=>o.status==='pending').length;
  const cancelledOrders = orders.filter(o=>o.status==='cancelled').length;
  const confirmedRevenue = orders.filter(o=>o.status==='confirmed'||o.status==='delivered').reduce((a,o)=>a+(Number(o.total)||0),0);
  return {
    totalProducts, activeProducts, totalStockUnits, totalInventoryRetailValue, totalInventoryCostValue,
    potentialProfit: totalInventoryRetailValue-totalInventoryCostValue,
    outOfStockCount, lowStockCount, totalOrders: orders.length, confirmedOrders, deliveredOrders, pendingOrders, cancelledOrders,
    conversionRate: orders.length ? Math.round(((confirmedOrders+deliveredOrders)/orders.length)*100) : 0,
    confirmedRevenue,
    topSellers: state.products.slice().sort((a,b)=>Number(b.sales_count||0)-Number(a.sales_count||0)).slice(0,10).map(p=>({ id:p.id, sku:p.sku, name:p.name, category:p.category, salesCount:Number(p.sales_count)||0, stock:Number(p.stock)||0, image:p.image }))
  };
}

async function updateSettingsAdmin(newSettings) {
  return mutateState(async state => {
    for (const [key, original] of Object.entries(newSettings || {})) {
      if (key === 'adminPassword' || key === 'jwtSecret') continue;
      state.settings[key] = key === 'whatsappNumber' ? normalizeParaguayWhatsapp(original) : original;
    }
    return clone(state.settings);
  });
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
  syncAdminSecurity,
  beginAdminTotpSetup,
  getAdminTotpPending,
  getAdminTotpSecret,
  confirmAdminTotpSetup,
  getCategories,
  getAllCategoriesAdmin,
  createCategoryAdmin,
  updateCategoryAdmin,
  activateCategoryAdmin,
  deleteCategoryAdmin
};
