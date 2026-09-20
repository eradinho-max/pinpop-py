const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const BUCKET = process.env.SUPABASE_BUCKET || 'pins-images';
const isNetlifyRuntime = process.env.NETLIFY === 'true';
const uploadsDir = path.join(__dirname, 'public', 'images', 'uploads');
let supabaseClient = null;
let bucketReadyPromise = null;

function getSupabaseClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!supabaseClient) {
    const { createClient } = require('@supabase/supabase-js');
    supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return supabaseClient;
}

async function ensureBucket() {
  const supabase = getSupabaseClient();
  if (!supabase) return false;
  if (!bucketReadyPromise) {
    bucketReadyPromise = (async () => {
      const { data, error } = await supabase.storage.getBucket(BUCKET);
      if (!error && data) return true;

      const { error: createError } = await supabase.storage.createBucket(BUCKET, {
        public: true,
        allowedMimeTypes: ALLOWED_MIMES,
        fileSizeLimit: MAX_UPLOAD_BYTES
      });
      if (createError && !String(createError.message || '').toLowerCase().includes('already')) {
        throw createError;
      }
      return true;
    })().catch(err => {
      bucketReadyPromise = null;
      throw err;
    });
  }
  return bucketReadyPromise;
}

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // JPEG FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }

  // PNG 89 50 4E 47 0D 0A 1A 0A
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngSignature.every((v, i) => buffer[i] === v)) {
    return { mime: 'image/png', ext: '.png' };
  }

  // WEBP: RIFF....WEBP
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: '.webp' };
  }

  return null;
}

function assertValidImage(buffer, declaredMime) {
  if (!buffer || buffer.length === 0) throw new Error('Archivo de imagen vacío.');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('La imagen excede el límite máximo permitido de 4MB.');

  const detected = detectImageType(buffer);
  if (!detected) throw new Error('El contenido del archivo no corresponde a una imagen JPG, PNG o WebP válida.');
  if (!ALLOWED_MIMES.includes(detected.mime)) throw new Error('Formato de imagen no permitido.');
  if (declaredMime && ALLOWED_MIMES.includes(declaredMime) && declaredMime !== detected.mime) {
    throw new Error('El tipo real de la imagen no coincide con el tipo declarado.');
  }
  return detected;
}

async function saveImage(buffer, declaredMime) {
  const detected = assertValidImage(buffer, declaredMime);
  const filename = `pin-${crypto.randomUUID()}${detected.ext}`;
  const objectPath = `products/${filename}`;
  const supabase = getSupabaseClient();

  if (supabase) {
    await ensureBucket();
    const { error } = await supabase.storage.from(BUCKET).upload(objectPath, buffer, {
      contentType: detected.mime,
      cacheControl: '31536000',
      upsert: false
    });
    if (error) throw error;
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(objectPath);
    return { url: data.publicUrl, path: objectPath, provider: 'supabase', mime: detected.mime };
  }

  if (isNetlifyRuntime) {
    throw new Error('Storage persistente no configurado.');
  }

  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  const localPath = path.join(uploadsDir, filename);
  fs.writeFileSync(localPath, buffer, { flag: 'wx' });
  return { url: `/images/uploads/${filename}`, path: `images/uploads/${filename}`, provider: 'local', mime: detected.mime };
}

function extractSupabaseObjectPath(url) {
  if (typeof url !== 'string' || !url) return null;
  const marker = `/storage/v1/object/public/${encodeURIComponent(BUCKET)}/`;
  const plainMarker = `/storage/v1/object/public/${BUCKET}/`;
  let idx = url.indexOf(marker);
  let usedMarker = marker;
  if (idx < 0) {
    idx = url.indexOf(plainMarker);
    usedMarker = plainMarker;
  }
  if (idx < 0) return null;
  return decodeURIComponent(url.slice(idx + usedMarker.length).split('?')[0]);
}

function isManagedImageUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  return Boolean(extractSupabaseObjectPath(url) || url.startsWith('/images/uploads/'));
}

async function deleteImageByUrl(url) {
  if (!isManagedImageUrl(url)) return { deleted: false, reason: 'not-managed' };

  const objectPath = extractSupabaseObjectPath(url);
  if (objectPath) {
    const supabase = getSupabaseClient();
    if (!supabase) return { deleted: false, reason: 'storage-not-configured' };
    const { error } = await supabase.storage.from(BUCKET).remove([objectPath]);
    if (error) throw error;
    return { deleted: true, provider: 'supabase' };
  }

  if (url.startsWith('/images/uploads/') && !isNetlifyRuntime) {
    const filename = path.basename(url);
    const localPath = path.join(uploadsDir, filename);
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    return { deleted: true, provider: 'local' };
  }

  return { deleted: false, reason: 'unsupported-runtime' };
}

module.exports = {
  MAX_UPLOAD_BYTES,
  ALLOWED_MIMES,
  detectImageType,
  assertValidImage,
  saveImage,
  deleteImageByUrl,
  isManagedImageUrl,
  ensureBucket
};
