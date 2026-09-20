# PINPOP — Estado del proyecto

## Macrobloco actual: Admin + imágenes + seguridad + SEO/IA

### Implementado

- Backend como única fuente de verdad.
- Netlify Functions para Express.
- PostgreSQL/Supabase preparado para persistencia serverless.
- WhatsApp comercial normalizado a **+595 991 950 031**.
- Catálogo, carrito y checkout por WhatsApp.
- Pedidos y estados: pendiente → confirmado → entregado / cancelado.
- Stock transaccional con movimientos y estorno.
- Admin de productos: crear, editar, activar/desactivar, precio, descripción, SKU, stock mínimo, promo y destaque.
- Stock editable únicamente por flujo de inventario después de creado el producto.
- Captura directa por cámara en mobile.
- Compresión a WebP/JPEG y upload persistente.
- Foto principal + hasta 4 fotos adicionales por producto.
- Elegir una foto de galería como principal.
- Sustitución/eliminación con limpieza de uploads nuevos no utilizados.
- Categorías: crear, editar, desactivar y reactivar.
- Validación real de imágenes por magic bytes.
- JWT, bcrypt, Helmet/CSP, CORS, rate limits y no-cache de APIs.
- SEO: canonical, sitemap, páginas individuales de producto, Product JSON-LD.
- Descubrimiento IA: OAI-SearchBot permitido, GPTBot bloqueado, `llms.txt` complementario.
- Scripts `check:syntax` y `check:security`.

### Para Netlify

Configurar: `DATABASE_URL`, `JWT_SECRET`, `ADMIN_PASSWORD`, `SITE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`.

### Validação desta build

- Sintaxe Node/JS: validada.
- Scanner estático de segurança: 21/21 controles aprovados.
- Upload falso com MIME JPEG e conteúdo não-imagem: rejeitado em teste unitário local.
- Instalação npm/runtime completo: não concluído neste ambiente por indisponibilidade de rede; não afirmar teste end-to-end local.

### Pendência não bloqueadora

- Tailwind Browser CDN e Lucide ainda são dependências JavaScript externas. A próxima etapa de performance pode localizá-las/compilar CSS quando for possível instalar ou baixar dependências de forma verificável.

## Hotfix posterior ao MB04

O catálogo público foi tornado resiliente a falhas da Function/banco no Netlify. A vitrine possui fallback somente de leitura, mas Admin, estoque e pedidos continuam obrigatoriamente vinculados ao backend persistente. Consulte `HOTFIX_NETLIFY_CATALOGO.md`.
