const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');
const results=[];
const check=(name,ok)=>results.push({name,ok:Boolean(ok)});

const server=read('server.js');
const db=read('database.js');
const storage=read('storage.js');
const app=read('public/app.js');
const html=read('public/index.html');
const vercel=read('vercel.json');
const pkg=JSON.parse(read('package.json'));
const publicText=fs.readdirSync(path.join(root,'public'),{recursive:true})
  .filter(f=>typeof f==='string' && /\.(js|html|css|json|txt)$/i.test(f))
  .map(f=>read(path.join('public',f))).join('\n');

check('No existe .env real en el paquete', !fs.existsSync(path.join(root,'.env')));
check('Frontend no contiene ADMIN_PASSWORD', !/ADMIN_PASSWORD\s*=|process\.env\.ADMIN_PASSWORD/.test(publicText));
check('Frontend no contiene secretos 2FA', !/ADMIN_TOTP_SECRET|totp_secret/.test(publicText));
check('Sin JWT en frontend/backend', !/jsonwebtoken|JWT_SECRET|Bearer\s/i.test(server+'\n'+app+'\n'+JSON.stringify(pkg.dependencies)));
check('Sesión administrativa usa cookie HttpOnly', /HttpOnly; SameSite=Strict/.test(server));
check('Cookie Secure en producción', /isProduction \? '; Secure'/.test(server));
check('Login exige contraseña + TOTP después del alta', /password, totp/.test(server) && /verifyTotp/.test(server));
check('2FA se configura dentro del panel', /api\/auth\/setup\/start/.test(server) && /api\/auth\/setup\/confirm/.test(server) && !/ADMIN_TOTP_SECRET/.test(server));
check('QR 2FA se genera en servidor', /QRCode\.toDataURL/.test(server) && pkg.dependencies.qrcode==='1.5.4');
check('TOTP acepta solo 6 dígitos', /\^\\d\{6\}\$/.test(server));
check('Comparación de contraseña usa timingSafeEqual', /timingSafeTextEqual/.test(server) && /timingSafeEqual/.test(server));
check('Login tiene rate limiting', /app\.post\('\/api\/auth\/login',\s*loginLimiter/.test(server));
check('Pedidos públicos tienen rate limiting', /app\.post\('\/api\/orders',\s*orderLimiter/.test(server));
check('Rutas admin de escritura exigen autenticación', server.split(/\r?\n/).filter(l=>/app\.(post|put|patch|delete)\('\/api\/admin\//.test(l)).every(l=>l.includes('authenticateAdmin')));
check('No hay token admin en sessionStorage', !/pinpop_admin_jwt|sessionStorage/.test(app));
check('Estado persistente usa Vercel Blob privado', /@vercel\/blob/.test(db) && /access:\s*'private'/.test(db) && /useCache:\s*false/.test(db));
check('Imágenes usan Vercel Blob privado', /@vercel\/blob/.test(storage) && /access:\s*'private'/.test(storage));
check('Upload valida magic bytes', /detectImageType/.test(storage) && /assertValidImage/.test(storage));
check('CSP scripts self-only', /scriptSrc:\s*\["'self'"\]/.test(server) && /script-src 'self'/.test(vercel));
check('Sin event handlers inline', !/\son[a-z]+\s*=/i.test(html));
check('WhatsApp oficial correcto', /595991950031/.test(db));
check('Dependencias fijadas en versiones exactas', Object.values(pkg.dependencies||{}).every(v=>!/^[~^*><=]/.test(String(v))));
check('Netlify removido de dependências operacionais', !/@netlify\/blobs|serverless-http/.test(JSON.stringify(pkg.dependencies)));

const failed=results.filter(r=>!r.ok);
for(const r of results) console.log(`${r.ok?'PASS':'FAIL'} - ${r.name}`);
console.log(`\n${results.length-failed.length}/${results.length} verificaciones aprobadas.`);
if(failed.length)process.exit(1);
