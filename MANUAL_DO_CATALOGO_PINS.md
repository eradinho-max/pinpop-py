# 🐊 PINPOP • Pins para tus Crocs
## Documento de Arquitectura, Seguridad y Guía de Operación Comercial (V3 Hardened & Cloud-Ready)

Este documento detalla la arquitectura técnica completa, las mitigaciones de seguridad definitivas implementadas tras la tercera ronda de auditoría técnica y la guía de operación comercial y despliegue para el catálogo y mini-ERP de **PINPOP**.

---

### 🛡️ Matriz de Vulnerabilidades y Correcciones Definitivas (V3)

| Observación / Vulnerabilidade Auditada | Severidad | Estado | Solución Técnica Implementada |
| :--- | :---: | :---: | :--- |
| **1. Contraseña en Logs del Servidor** | Crítica (Bloqueador) | **ELIMINADA** | Se eliminó por completo la impresión de contraseñas en consola. El servidor únicamente registra: `✓ Usuario administrador configurado.`. Ningún secreto se expone en stdout/stderr. |
| **2. Fallback de `ADMIN_PASSWORD` en Producción** | Alta | **RESUELTO** | Si `NODE_ENV === 'production'` y falta `ADMIN_PASSWORD`, el servidor detiene la ejecución de inmediato (`process.exit(1)`). No se permite iniciar en producción con claves conocidas. |
| **3. Archivo `.env` en el Paquete ZIP** | Alta | **RESUELTO** | El archivo `.env` fue excluido del paquete distribuible. Solo se incluye `.env.example` con credenciales rotadas y placeholders seguros. Se implementó `.gitignore` estricto. |
| **4. Archivos Huérfanos y Base con Pedidos Anteriores** | Media | **RESUELTO** | Se eliminaron definitivamente `orders.json`, `products.json`, `settings.json` y `test.sqlite`. La base SQLite se restableció a estado inicial limpio: **15 productos del catálogo, 0 pedidos de clientes y 0 datos residuales**. Se eliminó la función de sembrado de pedidos falsos. |
| **5. Salto Ilegal de Pedido (`pending → delivered`)** | Media-Alta | **RESUELTO** | La API `POST /api/admin/orders/:id/deliver` valida obligatoriamente que el pedido tenga estado `confirmed`. Es imposible marcar como entregado un pedido pendiente sin confirmar la venta y descontar stock. |
| **6. Doble Codificación HTML en XSS (Entidades Feas)** | Media (UX) | **RESUELTO** | Backend `sanitizeString()` limpia etiquetas HTML y caracteres de control sin transformar entidades (`&`, `'`, `"` se guardan en texto plano). WhatsApp recibe texto natural (ej. `D'Angelo & Hijos`). Frontend escapa en `escapeHtml()` únicamente al insertar en `innerHTML`. |
| **7. Soporte para Reverse Proxy (IPs Reales)** | Media | **RESUELTO** | Configurado `app.set('trust proxy', 1)` para que `express-rate-limit` identifique correctamente las IPs reales de los clientes detrás de Vercel, Railway, Render, Cloudflare o Nginx. |
| **8. Política CORS Restringida** | Baja-Media | **RESUELTO** | CORS configurado para same-origin por defecto o filtrado por lista blanca mediante la variable de entorno `ALLOWED_ORIGINS`. |
| **9. Persistência Dual: SQLite + PostgreSQL / Supabase** | Alta (Arquitectura) | **IMPLEMENTADO** | Capa de base de datos dual: funciona con **SQLite** local/VPS (`sql.js`) o con **PostgreSQL / Supabase** (`pg`) al definir `DATABASE_URL`. Soporte nativo para subida de fotos a **Supabase Storage**. |

---

## 🏗️ Arquitectura de Persistencia Dual (Local vs. Nube Serverless)

PINPOP soporta dos modos de ejecución sin alterar el código de la aplicación:

```text
                                  ┌────────────────────────────┐
                                  │   CLIENTE WEB (Móvil/PC)   │
                                  └─────────────┬──────────────┘
                                                │
                                    HTTP / JSON │ (Token Bearer JWT)
                                                ▼
                                  ┌────────────────────────────┐
                                  │      EXPRESS BACKEND       │
                                  │  - Trust Proxy: 1          │
                                  │  - Helmet & CSP            │
                                  │  - Rate Limiter por IP     │
                                  │  - Sanitización clean-text │
                                  └─────────────┬──────────────┘
                                                │
                      ┌─────────────────────────┴─────────────────────────┐
                      │                                                   │
             ¿Existe DATABASE_URL?                                ¿No hay DATABASE_URL?
                      │                                                   │
                      ▼                                                   ▼
       ┌─────────────────────────────┐                     ┌─────────────────────────────┐
       │   MODO NUBE / SERVERLESS    │                     │   MODO LOCAL / VPS DOCKER   │
       │  (Vercel, Railway, Render)  │                     │   (Zero-config, standalone) │
       │                             │                     │                             │
       │  • PostgreSQL / Supabase    │                     │  • SQLite (sql.js)          │
       │    con Pool de conexiones   │                     │  • data/pinpop.sqlite       │
       │  • Supabase Storage Bucket  │                     │  • public/images/uploads/   │
       │    para imágenes en CDN     │                     │                             │
       │  • schema.sql autoejecutable│                     │  • Transacciones atómicas   │
       └─────────────────────────────┘                     └─────────────────────────────┘
```

---

## 🚀 Despliegue en Supabase / PostgreSQL (Paso a Paso)

Para migrar a una base de datos en la nube (PostgreSQL gestionado):

1. **Crear proyecto en Supabase:**
   - Ingresá a [supabase.com](https://supabase.com) y creá un nuevo proyecto.
2. **Ejecutar el esquema SQL:**
   - Abrí el **SQL Editor** en el panel de Supabase.
   - Copiá y pegá el contenido de `schema.sql` y hacé clic en **Run**. Las 6 tablas e índices quedarán creados de inmediato.
3. **Configurar Storage (Opcional):**
   - En Supabase Storage, creá un bucket público llamado `pins-images`.
4. **Configurar variables en `.env` o en el panel de hosting (Railway / Render / Vercel):**
   ```env
   NODE_ENV=production
   PORT=3000
   JWT_SECRET=tu_clave_aleatoria_de_64_caracteres_hex
   ADMIN_PASSWORD=tu_password_segura
   DATABASE_URL=postgresql://postgres.[REF]:[PASSWORD]@[POOLER-HOST]:6543/postgres
   PG_POOL_MAX=1
   SUPABASE_URL=https://[REF].supabase.co
   SUPABASE_SERVICE_ROLE_KEY=tu_service_role_key
   SUPABASE_BUCKET=pins-images
   ALLOWED_ORIGINS=https://tutienda.com
   ```

---

## 📦 Ciclo de Vida del Pedido en PINPOP

El sistema garantiza la integridad del inventario a través de un flujo unidireccional y seguro:

```text
  [ CLIENTE EN TIENDA ]
           │
           │ (1) Selecciona pins y presiona "Completar pedido por WhatsApp"
           ▼
     [ PENDIENTE ]  ──(Bloqueado: no se puede marcar como Entregado directamente)
           │
           │ (2) Vendedor valida transferencia SIPAP / Billetera
           ▼
    [ CONFIRMAR VENTA ] ──► Deducción atómica de stock (BEGIN ... COMMIT)
           │                 + Registro en auditoría 'stock_movements' (tipo 'venta')
           ▼
    [ CONFIRMADO ]
       ├── (3a) Si cliente desiste ──► [ ESTORNAR STOCK ] (Devuelve pins al inventario)
       │
       └── (3b) Si se despacha/retira ──► [ MARCAR COMO ENTREGADO ]
                                                  │
                                                  ▼
                                            [ ENTREGADO ] (Ciclo comercial cerrado)
```

---

## 🇵🇾 Especificaciones de Negocio (Paraguay)

- **Moneda:** Guaraní Paraguayo (PYG), formateado con separadores de miles: `Gs. 10.000`, `Gs. 12.000`, `Gs. 45.000`.
- **Medios de Pago Soportados:**
  - Transferencia bancaria / SIPAP (Bancos de Paraguay)
  - Tigo Money / Billeteras electrónicas
  - Efectivo contra entrega (Asunción y Gran Asunción)
- **Logística:**
  - Envío en el día para Asunción y Gran Asunción (flete configurable, por defecto Gs. 15.000, gratis a partir de Gs. 100.000).
  - Retiro en local físico disponible sin costo adicional.

---

## 🎨 Identidad Visual PINPOP y Nueva Línea "Pins para Estetoscopio"

### 1. Manual de Marca PINPOP Integrado
- **Paleta Cromática Oficial:**
  - `Rosa Principal (#FF2D8A)`: Botones primarios, acciones de compra, llamados visuales clave.
  - `Preto / Texto (#111111)`: Texto de alta legibilidad, botones oscuros y detalles de contraste.
  - `Rosa Claro (#FFE8F1)`: Fondos tenues, chips seleccionados y estados hover.
  - `Verde Menta (#A7E8D4)`: Badges de disponibilidad y confirmaciones de inventario.
  - `Amarelo (#FFD84D)`: Badges de últimas unidades en stock y ofertas.
  - `Cinza Fundo (#F4F5F7)`: Fondo suave que realza el colorido de los productos.
- **Tipografías:**
  - `Poppins`: Fuente primaria para cuerpo, fichas técnicas, checkout y administración.
  - `Sora`: Tipografía de acento para títulos principales, pestañas y badges de marca.
- **Logotipo Oficial:**
  - Integrado en formato PNG transparente de alta resolución en barra de navegación y pie de página.

### 2. Línea Especializada: Pins para Estetoscopio Clínico
- **Pestaña y Filtros Dinámicos:** Selector de modo en el header para alternar entre "Pins para Crocs" y "Pins para Estetoscopio".
- **Categorías Clínicas:** *Cardiología*, *Odontología*, *Veterinaria*, *Packs Médicos* y *Ofertas*.
- **Modelos y Dijes Esmaltados:** Clips metálicos en oro rosa y resina diseñados para calzar a presión sobre el tubo del estetoscopio sin rayarlo ni deslizarse.
- **Simulador Dual:** El cliente puede previsualizar cómo lucen los pines tanto en un calzado Crocs como en el tubo de un estetoscopio antes de agregarlos al carrito.

### 3. Lupa de Aumento Interactivo (Image Zoom Lens)
- Al abrir la ficha de cualquier producto, pasar el cursor sobre la foto activa una lupa con zoom dinámico 2.5x que sigue las coordenadas del puntero.
- En dispositivos táctiles (móviles/tablets), se incluye un botón de toque que activa el aumento instantáneo.

---

## 🔒 Buenas Prácticas de Operación Diaria

1. **Cambio periódico de contraseña:**
   - Desde el panel administrativo (`/#admin` → pestaña *Configuración*), podés actualizar la contraseña de acceso en cualquier momento. La nueva clave se almacena hasheada con algoritmo bcrypt (cost 10).
2. **Revisión de reposición:**
   - La sección *Alertas de Stock* te avisa automáticamente cuando un modelo tiene 3 o menos unidades. Podés reponer en bloques de +10 unidades con 1 solo clic.
3. **Rotación de modelos (TOP 10):**
   - El dashboard muestra el ranking real de ventas para orientar compras a proveedores mayoristas.
