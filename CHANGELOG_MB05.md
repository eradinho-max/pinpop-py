# PINPOP — CHANGELOG MB05

## Macrobloco B — Producción + Performance

- Tailwind runtime/CDN removido del storefront.
- CSS Tailwind precompilado y servido localmente.
- Lucide CDN removido; íconos críticos servidos localmente.
- CSP endurecida para `script-src 'self'`.
- Imágenes locales convertidas a WebP; `public/images` reducido de ~25 MB a ~3 MB.
- URLs seed/fallback migradas a WebP.
- Migración automática para URLs antiguas `.png/.jpg` guardadas en bancos ya existentes.
- Cache estático Netlify agregado para assets.

## Macrobloco C — Validación integral de release

- Nuevo `scripts/release-check.js`.
- `npm run check:release` y `npm run check:all`.
- 21/21 controles de seguridad aprobados.
- 21/21 controles de release aprobados.
- Smoke HTTP estático aprobado: `/`, CSS, íconos y fallback JSON retornaron 200.

## Alcance de la validación

No se ejecutó un navegador real ni un deploy de prueba contra un Supabase externo dentro de este entorno. El siguiente paso operativo es desplegar esta build única y validar `/api/health`, `/api/products`, login admin, upload y pedido real no dominio publicado.

## Patch de interfaz administrativa — 2026-09-20
- El acceso visual al panel Admin fue retirado del encabezado público.
- El botón `Administración` permanece accesible en el extremo del pie de página con bajo contraste visual.
- No se modificó la autenticación: el panel continúa protegido por JWT, bcrypt y rate limiting.
- No existe contraseña administrativa predeterminada en el código o paquete de distribución.
