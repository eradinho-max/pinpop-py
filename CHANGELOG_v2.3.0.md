# PINPOP v2.3.0 — Migração para Vercel

- Migrado de Netlify para Vercel.
- Express exposto como Vercel Function em `api/index.js`.
- Persistência migrada para Vercel Blob privado.
- Uploads de imagens migrados para Vercel Blob privado.
- Removidos Netlify Blobs e `serverless-http`.
- Criado `vercel.json` com rewrites, headers de segurança e cache.
- Mantido Admin com senha + TOTP 2FA automático.
- Mantido cookie HttpOnly/Secure/SameSite=Strict.
- Mantidas todas as funções comerciais e SEO.
