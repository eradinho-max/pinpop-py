# PINPOP — Estado del proyecto

## Release actual: v2.1.0

### Macroblocos concluidos

1. Backend como única fuente de verdad.
2. Netlify Functions + PostgreSQL/Supabase.
3. Admin de productos, imágenes, categorías y stock.
4. Seguridad, SEO y descubrimiento por IA.
5. Producción/performance + validación integral de release.

### Funcionalidades consolidadas

- Catálogo público responsive para pins de Crocs y charms de estetoscopio.
- Carrinho, pedido registrado no backend e abertura do WhatsApp **+595 991 950 031**.
- Estados de pedido: pendiente → confirmado → entregado / cancelado.
- Stock transaccional con movimientos, ajustes y estorno.
- Admin para crear/editar/activar/desactivar productos.
- Captura directa por cámara no celular.
- Foto principal + até 4 imagens adicionais.
- Upload persistente via Supabase Storage.
- Categorias editáveis.
- Soft delete.
- JWT, bcrypt, CSP, CORS, Helmet y rate limits.
- Validación binaria de uploads por magic bytes.
- Sitemap, robots, páginas de producto, Product JSON-LD y llms.txt.
- OAI-SearchBot permitido; GPTBot separado/bloqueado.
- Fallback público somente de leitura se a Function/banco falhar; Admin/pedidos/estoque nunca usam fallback local.

### Performance aplicada

- Tailwind deixou de rodar via CDN/browser runtime: CSS está pré-compilado em `public/tailwind-built.css`.
- Ícones deixaram de depender de CDN externo: renderer local em `public/vendor/icons.js`.
- Imagens locais do catálogo/simulador convertidas para WebP.
- Peso aproximado de `public/images` reduzido de ~25 MB para ~3 MB.
- Migração automática converte URLs locais antigas `.png/.jpg` de produtos já existentes para os novos `.webp`.
- Cache estático configurado no Netlify para CSS, JS, imagens e dados fallback.

### Validação desta build

- `npm run check:syntax`: aprovado.
- `npm run check:security`: **21/21** controles aprovados.
- `npm run check:release`: **21/21** controles aprovados.
- Smoke test HTTP estático: home, CSS compilado, ícones locais e catálogo fallback retornaram HTTP 200.
- Não foi executado browser end-to-end real nem conexão contra um Supabase/Netlify externo neste ambiente. Essa validação deve ser feita no domínio publicado após o deploy.

### Variáveis necessárias no Netlify

`DATABASE_URL`, `JWT_SECRET`, `ADMIN_PASSWORD`, `SITE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`.

### Macroblocos planejados restantes

**0.** O roadmap funcional definido nesta conversa está concluído. A partir daqui, somente correções derivadas do deploy real ou novas funcionalidades solicitadas.

### Ajuste posterior — acceso Admin
- El acceso al Admin ya no aparece en el encabezado; se encuentra discretamente en el pie de página.
- No hay contraseña hardcodeada. El primer usuario admin se crea únicamente si `ADMIN_PASSWORD` tiene al menos 12 caracteres. Cambios posteriores quedan almacenados sólo como hash bcrypt.
