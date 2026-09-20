const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const results = [];
function check(name, condition, detail='') {
  results.push({ name, ok: Boolean(condition), detail });
}

check('No existe .env en el paquete', !fs.existsSync(path.join(root, '.env')));

const server = read('server.js');
const db = read('database.js');
const app = read('public/app.js');
const html = read('public/index.html');
const publicFiles = fs.readdirSync(path.join(root, 'public'), { recursive: true })
  .filter(f => typeof f === 'string' && /\.(js|html|css|json|txt)$/i.test(f))
  .map(f => read(path.join('public', f))).join('\n');

check('Service role no está en archivos públicos', !/SUPABASE_SERVICE_ROLE_KEY|service_role/i.test(publicFiles));
check('JWT secret no está hardcodeado en el frontend', !/JWT_SECRET/i.test(publicFiles));
check('Sin eval/new Function en frontend', !/\beval\s*\(|new\s+Function\s*\(/.test(app));
check('CSP no permite unsafe-inline en scripts', /scriptSrc:\s*\[(?![^\]]*unsafe-inline)/s.test(server));
check('Uploads usan memoryStorage', /multer\.memoryStorage\(\)/.test(server));
check('Upload valida firma real (magic bytes)', /detectImageType|assertValidImage/.test(read('storage.js')));
check('Login tiene rate limiting', /app\.post\('\/api\/auth\/login',\s*loginLimiter/.test(server));
check('Pedidos públicos tienen rate limiting', /app\.post\('\/api\/orders',\s*orderLimiter/.test(server));
check('Upload exige admin + rate limit', /app\.post\('\/api\/admin\/upload',\s*authenticateAdmin,\s*requirePersistentDatabase,\s*uploadLimiter/.test(server));
const adminWriteLines = server.split(/\r?\n/).filter(line => /app\.(post|put|patch|delete)\('\/api\/admin\//.test(line));
check('Rutas admin de escritura exigen autenticación', adminWriteLines.length > 0 && adminWriteLines.every(line => line.includes('authenticateAdmin')));
check('Catálogo público no expone costPrice/minStock', !/SELECT[^;]*cost_price[^;]*FROM products WHERE active = 1/is.test(db));
check('Contraseña nueva mínima >=12 no frontend', /newPassword\.length < 12/.test(app));
check('Sin event handlers inline en HTML', !/\son[a-z]+\s*=/i.test(html));
check('WhatsApp configurado en E.164 PY', /DEFAULT_WHATSAPP_NUMBER = '595991950031'/.test(db));

const pkg = JSON.parse(read('package.json'));
check('Dependencias runtime fijadas a versiones exactas', Object.values(pkg.dependencies || {}).every(v => !/^[~^*><=]/.test(String(v))));
check('Sin contraseña admin hardcodeada conocida', !/pinpop2026|password\s*=\s*['"]admin['"]/i.test(server + '\n' + db + '\n' + app));
check('APIs deshabilitan cache compartido', /app\.use\('\/api'[\s\S]*Cache-Control'[\s\S]*no-store/.test(server));

const netlifyHeaders = read('public/_headers');
check('Netlify estático aplica CSP', /Content-Security-Policy:/.test(netlifyHeaders));
check('Netlify bloquea framing', /frame-ancestors 'none'/.test(netlifyHeaders) && /X-Frame-Options: DENY/.test(netlifyHeaders));
check('Netlify fuerza nosniff', /X-Content-Type-Options: nosniff/.test(netlifyHeaders));

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} verificaciones aprobadas.`);
process.exitCode = failed ? 1 : 0;
