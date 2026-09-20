# PINPOP — SEO, descubrimiento por IA y seguridad

## SEO técnico implementado

- Título y descripción orientados a Paraguay.
- Canonical, Open Graph y Twitter Card.
- `robots.txt` dinámico.
- `sitemap.xml` dinámico con una URL indexable por producto.
- Páginas `/producto/:id` renderizadas en servidor con información pública del producto.
- JSON-LD `Product` + `Offer` con precio en PYG y disponibilidad.
- `llms.txt` como índice textual complementario del catálogo público.
- `OAI-SearchBot` permitido para descubrimiento en búsqueda de ChatGPT.
- `GPTBot` bloqueado; visibilidad en búsqueda y entrenamiento quedan separados.

### Términos naturales prioritarios

Usarlos en títulos, descripciones y contenido cuando correspondan al producto; no repetirlos artificialmente:

- pins para Crocs Paraguay
- pins para Crocs Asunción
- charms para Crocs Paraguay
- accesorios para Crocs Paraguay
- pins para estetoscopio Paraguay
- pins para estetoscopio Asunción
- dijes para estetoscopio
- charms para estetoscopio
- pins personalizados Paraguay

PINPOP debe presentarse como marca independiente. Para productos genéricos, preferir lenguaje como “compatible con calzados tipo Crocs” y no dar a entender afiliación oficial con Crocs, Inc.

## Seguridad implementada

- JWT administrativo obligatorio y secreto mínimo de 32 caracteres en producción.
- Contraseña administrativa mínima de 12 caracteres.
- `bcrypt` para hash de contraseña.
- Rate limit en login, pedidos públicos y uploads.
- Helmet + Content Security Policy.
- CORS same-origin por defecto y whitelist explícita opcional.
- API con `Cache-Control: no-store` y `X-Robots-Tag: noindex`.
- Sin contraseña, JWT secret ni service-role dentro del frontend público.
- Rotas administrativas de escritura protegidas por `authenticateAdmin`.
- Upload en memoria; no se confía en extensión del archivo.
- JPG, PNG y WebP validados por firma binaria (magic bytes) en el backend.
- Storage persistente en Netlify; sin fallback silencioso al filesystem efímero.
- Produto público não expone costo ni stock mínimo administrativo.
- XSS mitigado al escapar contenido dinámico antes de insertarlo en HTML.
- Soft delete para preservar historial.
- Transacciones para operaciones críticas de stock/pedidos.

## Riesgo residual conocido

Los scripts críticos del storefront ya no dependen de CDN externos: Tailwind se entrega precompilado y los íconos se sirven localmente. El riesgo residual principal pasa a ser operacional: configuración correcta de secretos, Supabase, DNS/Netlify y nuevas dependencias que puedan agregarse en versiones futuras.

## Pruebas incluidas

Ejecutar:

```bash
npm run check:all
```

El comando ejecuta sintaxis, hardening estático y validación de release. Estas verificaciones no sustituyen un pentest externo contra el dominio publicado ni pruebas E2E en navegador real.
