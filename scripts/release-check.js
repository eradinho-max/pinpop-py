const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([true,name]); console.log('PASS - '+name); }
  catch (e) { checks.push([false,name]); console.error('FAIL - '+name+' :: '+e.message); }
};

const index = read('public/index.html');
const app = read('public/app.js');
const server = read('server.js');
const db = read('database.js');
const netlify = read('netlify.toml');
const headers = read('public/_headers');
const fallback = JSON.parse(read('public/data/catalog-fallback.json'));
const settings = JSON.parse(read('public/data/settings-fallback.json'));
const fallbackModule = require(path.join(root, 'fallback-data.js'));

check('Home pública existe', () => assert(exists('public/index.html')));
check('CSS Tailwind está pré-compilado localmente', () => {
  assert(index.includes('tailwind-built.css'));
  assert(exists('public/tailwind-built.css'));
  assert(fs.statSync(path.join(root,'public/tailwind-built.css')).size > 20000);
  assert(!index.includes('cdn.tailwindcss.com'));
});
check('Ícones do site estão locais', () => {
  assert(index.includes('vendor/icons.js'));
  assert(exists('public/vendor/icons.js'));
  assert(!index.includes('unpkg.com'));
});
check('CSP de produção não autoriza scripts CDN', () => {
  assert(/script-src 'self'/.test(headers));
  assert(!headers.includes('cdn.tailwindcss.com'));
  assert(!headers.includes('unpkg.com'));
  assert(server.includes('scriptSrc: ["\'self\'"]'));
});
check('Catálogo fallback tem produtos válidos', () => {
  assert(Array.isArray(fallback) && fallback.length >= 10);
  const ids = new Set(), skus = new Set();
  for (const p of fallback) {
    assert(p.id && p.sku && p.name && p.image);
    assert(!ids.has(p.id)); ids.add(p.id);
    assert(!skus.has(p.sku)); skus.add(p.sku);
    assert(Number.isFinite(Number(p.price)) && Number(p.price) >= 0);
    assert(Number.isInteger(Number(p.stock)) && Number(p.stock) >= 0);
  }
});
check('Todas as imagens do catálogo fallback existem', () => {
  for (const p of fallback) {
    if (p.image.startsWith('/')) assert(exists('public'+p.image), `${p.id}: ${p.image}`);
    for (const img of (p.galleryImages || [])) if (img.startsWith('/')) assert(exists('public'+img), `${p.id}: ${img}`);
  }
});
check('Catálogo principal usa WebP otimizado', () => {
  const locals = fallback.filter(p => String(p.image).startsWith('/images/'));
  assert(locals.length > 0);
  assert(locals.every(p => p.image.endsWith('.webp')), 'Há imagem principal local fora de WebP');
});
check('Fallback de código e fallback JSON estão alinhados', () => {
  const products = fallbackModule.products;
  assert(Array.isArray(products));
  assert.strictEqual(products.length, fallback.length);
  assert.strictEqual(products[0].id, fallback[0].id);
});
check('WhatsApp oficial PINPOP está em E.164', () => {
  assert.strictEqual(String(settings.whatsappNumber).replace(/\D/g,''), '595991950031');
  assert(server.includes('595991950031'));
  assert.strictEqual(String(fallbackModule.settings.whatsappNumber).replace(/\D/g,''), '595991950031');
});
check('Checkout usa API real antes do WhatsApp', () => {
  assert(app.includes("fetch('/api/orders'"));
  assert(app.includes('wa.me'));
  assert(!app.includes('pinpop-local-jwt-session'));
});
check('Admin não usa localStorage como banco', () => {
  assert(!/localStorage\.setItem\([^)]*(product|order|stock|settings|admin)/i.test(app));
});
check('Cadastro mobile permite câmera traseira', () => {
  assert(index.includes('capture="environment"'));
  assert(index.includes('accept="image/*"'));
});
check('Galeria de produto está implementada', () => {
  assert(app.includes('productFormGalleryImages'));
  assert(app.includes('btn-gallery-main'));
  assert(app.includes('btn-gallery-remove'));
});
check('Upload exige autenticação administrativa', () => {
  assert(/app\.post\(['"]\/api\/admin\/upload/.test(server));
  assert(server.includes('authenticateAdmin'));
});
check('Pedidos públicos exigem banco persistente', () => {
  assert(server.includes("app.post('/api/orders', orderLimiter, requirePersistentDatabase"));
});
check('Confirmação de estoque possui transação', () => {
  assert(db.includes('confirmOrderStockAdmin'));
  assert(/BEGIN/i.test(db) && /COMMIT/i.test(db) && /ROLLBACK/i.test(db));
});
check('Netlify encaminha APIs, SEO e páginas de produto à Function', () => {
  for (const route of ['/api/*','/producto/*','/robots.txt','/sitemap.xml','/llms.txt']) assert(netlify.includes(route), route);
});
check('SEO técnico essencial está presente', () => {
  assert(index.includes('<meta name="description"'));
  assert(index.includes('application/ld+json'));
  assert(server.includes("app.get('/sitemap.xml'"));
  assert(server.includes("app.get('/robots.txt'"));
  assert(server.includes("app.get('/llms.txt'"));
  assert(server.includes("app.get('/producto/:id'"));
});
check('OAI-SearchBot está permitido e GPTBot separado', () => {
  assert(server.includes('OAI-SearchBot'));
  assert(server.includes('GPTBot'));
});
check('Pacote não contém .env real', () => assert(!exists('.env')));
check('Arquivos críticos de deploy existem', () => {
  for (const f of ['netlify.toml','netlify/functions/api.js','schema.sql','.env.example']) assert(exists(f),f);
});

const failed = checks.filter(c=>!c[0]);
console.log(`\n${checks.length-failed.length}/${checks.length} verificaciones de release aprobadas.`);
if (failed.length) process.exit(1);
