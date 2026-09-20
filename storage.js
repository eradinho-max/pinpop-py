const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const isVercelRuntime = process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);
const uploadsDir = path.join(__dirname, 'public', 'images', 'uploads');
let blobModulePromise = null;

async function getBlobModule() {
  if (!(isVercelRuntime || process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_OIDC_TOKEN)) return null;
  if (!blobModulePromise) blobModulePromise = import('@vercel/blob');
  return blobModulePromise;
}

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  const png = [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a];
  if (png.every((v,i)=>buffer[i]===v)) return { mime:'image/png', ext:'.png' };
  if (buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP') return { mime:'image/webp', ext:'.webp' };
  return null;
}

function assertValidImage(buffer, declaredMime) {
  if (!buffer || buffer.length === 0) throw new Error('Archivo de imagen vacío.');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('La imagen excede el límite máximo permitido de 4MB.');
  const detected = detectImageType(buffer);
  if (!detected || !ALLOWED_MIMES.includes(detected.mime)) throw new Error('El contenido no corresponde a una imagen JPG, PNG o WebP válida.');
  if (declaredMime && ALLOWED_MIMES.includes(declaredMime) && declaredMime !== detected.mime) throw new Error('El tipo real de la imagen no coincide con el tipo declarado.');
  return detected;
}

function encodeKey(key) { return Buffer.from(key, 'utf8').toString('base64url'); }
function decodeKey(id) { try { return Buffer.from(String(id), 'base64url').toString('utf8'); } catch (_) { return null; } }

async function saveImage(buffer, declaredMime) {
  const detected = assertValidImage(buffer, declaredMime);
  const filename = `products/pin-${crypto.randomUUID()}${detected.ext}`;
  const blob = await getBlobModule();
  if (blob) {
    await blob.put(filename, buffer, {
      access: 'private',
      addRandomSuffix: false,
      contentType: detected.mime
    });
    return { url: `/api/media/${encodeKey(filename)}`, path: filename, provider: 'vercel-blob', mime: detected.mime };
  }
  if (isVercelRuntime) throw new Error('Vercel Blob no está disponible temporalmente.');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  const localName = path.basename(filename);
  fs.writeFileSync(path.join(uploadsDir, localName), buffer, { flag: 'wx' });
  return { url: `/images/uploads/${localName}`, path: `images/uploads/${localName}`, provider: 'local', mime: detected.mime };
}

function isManagedImageUrl(url) {
  return typeof url === 'string' && (url.startsWith('/api/media/') || url.startsWith('/images/uploads/'));
}

async function deleteImageByUrl(url) {
  if (!isManagedImageUrl(url)) return { deleted:false, reason:'not-managed' };
  if (url.startsWith('/api/media/')) {
    const key = decodeKey(url.split('/api/media/')[1].split(/[?#]/)[0]);
    if (!key || !key.startsWith('products/')) return { deleted:false, reason:'invalid-key' };
    const blob = await getBlobModule();
    if (!blob) return { deleted:false, reason:'store-unavailable' };
    await blob.del(key);
    return { deleted:true, provider:'vercel-blob' };
  }
  if (!isVercelRuntime) {
    const filename = path.basename(url);
    const localPath = path.join(uploadsDir, filename);
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    return { deleted:true, provider:'local' };
  }
  return { deleted:false, reason:'unsupported-runtime' };
}

async function getImageById(id) {
  const key = decodeKey(id);
  if (!key || !key.startsWith('products/')) return null;
  const blob = await getBlobModule();
  if (!blob) return null;
  const result = await blob.get(key, { access:'private' });
  if (!result) return null;
  const arrayBuffer = await new Response(result.stream).arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType: result.blob?.contentType || 'application/octet-stream' };
}

async function ensureBucket() { return true; }

module.exports = { MAX_UPLOAD_BYTES, ALLOWED_MIMES, detectImageType, assertValidImage, saveImage, deleteImageByUrl, isManagedImageUrl, getImageById, ensureBucket };
