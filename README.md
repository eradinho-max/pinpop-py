# 🐊🩺 PINPOP • Pins para Crocs & Estetoscopio
### Catálogo Visual E-commerce con Identidad de Marca Oficial, Doble Línea de Productos, Simulador Interactivo y Mini-ERP Transaccional

Aplicación web integral, robusta y lista para producción diseñada con la **identidad visual oficial de PINPOP** para la venta de **pins para calzados tipo Crocs** y **charms / clips para tubos de estetoscopio** en Paraguay (Guaraníes Gs.).

---

## 🎨 Identidad Visual Oficial PINPOP (Brand Guide)

Implementada fielmente según el manual de marca oficial:

| Elemento | Especificación | Uso en el Sistema |
| :--- | :--- | :--- |
| **Rosa Principal** | `#FF2D8A` | Botones de compra directa, llamados a la acción, acentos y selector activo. |
| **Preto / Texto** | `#111111` | Tipografía principal, títulos de producto, navbar y botones secundarios. |
| **Rosa Claro** | `#FFE8F1` | Fondos destacados, tarjetas de promoción y estados hover. |
| **Verde Menta** | `#A7E8D4` | Badges de disponibilidad inmediata (`🟢 Disponible`). |
| **Amarelo** | `#FFD84D` | Badges de alerta de stock (`🟡 ¡Últimas unidades!`). |
| **Cinza Fundo** | `#F4F5F7` | Fondo general de la plataforma con textura suave. |
| **Tipografía UI / Body** | `Poppins` (400, 600, 700, 800) | Lectura clara en móviles, fichas de producto, carrito y formularios. |
| **Tipografía Acentos** | `Sora` (600, 700, 800) | Títulos principales, tabs de modo y badges destacados. |
| **Logotipo Oficial** | PNG transparente con destello | Encabezado principal, pie de página y favicons. |

---

## 🩺 Nueva Línea: Pins y Charms para Estetoscopio

Además del catálogo para Crocs, la tienda incorpora una sección especializada para profesionales y estudiantes de la salud (Medicina, Enfermería, Odontología, Veterinaria):

1. **Selector de Modo Superior:**
   - `🐊 Pins para Crocs`: Catálogo para calzados Crocs con categorías por temática (Personajes, Medicina, Flores, Animales, Comida, etc.).
   - `🩺 Pins para Estetoscopio`: Charms, clips esmaltados y dijes que se abrazan a las tubuladuras de estetoscopios (Littmann, MDF, etc.) con categorías especializadas (**Cardiología**, **Odontología**, **Veterinaria**, **Packs Médicos**).
2. **Catálogo con Fotografía de Alta Definición:**
   - Dije Clip Estetoscopio Corazón EKG Rosa (`EST-EKG01`).
   - Charm Estetoscopio Diente Molar Kawaii (`EST-DEN02`).
   - Dije Estetoscopio Patita Pet Veterinaria (`EST-VET03`).
   - Pack Combo Clínico 2 en 1 (Dije Esteto + Pin Crocs a Juego, `EST-DUO04`).
   - Charm Corazón Glitter Lux (`EST-COR05`).
   - Pin Mini Estetoscopio Clínico 3D Rosa (`EST-MIN06`).
3. **Simulador Dual Interactivo:**
   - Permite alternar entre el **Calzado Crocs** (8 orificios) y el **Tubo de Estetoscopio** (4 clips a lo largo de la manguera).
   - Los clientes pueden probar cómo lucen los dijes antes de comprar y transferir su combinación al carrito con un solo clic.

---

## 🔍 Lupa de Aumento Interactivo (Image Zoom Lens)

En la ventana de detalle de cada producto:
- **En Computadora (Desktop):** Al pasar el cursor del mouse sobre la foto del pin o dije, se activa una lupa fluida con aumento **2.5x** que sigue el puntero en tiempo real, permitiendo apreciar el relieve, el esmalte y la textura de la goma o metal.
- **En Celular (Mobile):** Botón flotante `🔍 Toque para Zoom` que expande la vista detallada táctil.

---

## 🚀 Cómo Iniciar el Proyecto Localmente

### Requisitos:
- **Node.js** v18 o superior.
- **npm** v8 o superior.

### Pasos:

1. **Instalar dependencias:**
   ```bash
   npm install
   ```

2. **Configurar variables de entorno:**
   Copiá el archivo `.env.example` a `.env`:
   ```bash
   cp .env.example .env
   ```
   Variables clave:
   - `PORT`: Puerto donde correrá el servidor (por defecto `3000`).
   - `NODE_ENV`: Modo de ejecución (`development` o `production`).
   - `JWT_SECRET`: Clave secreta criptográfica para firmar tokens administrativos. En producción detiene el arranque si falta.
   - `ADMIN_PASSWORD`: Contraseña inicial del panel administrativo (`pinpop2026`).
   - `DATABASE_PATH`: Ruta del archivo SQLite (por defecto `./data/pinpop.sqlite`).

3. **Iniciar el servidor:**
   ```bash
   npm start
   ```

4. **Abrir en el navegador:**
   - **Tienda pública:** [http://localhost:3000](http://localhost:3000)
   - **Panel de Administración:** [http://localhost:3000/#admin](http://localhost:3000/#admin) (Contraseña inicial: `pinpop2026`).

---

## 🛡️ Matriz de Seguridad y Endurecimiento

| Vector de Seguridad | Implementación en PINPOP |
| :--- | :--- |
| **Prevención de XSS Almacenado** | Doble capa: Sanitización backend con `sanitizeString()` (eliminación de etiquetas HTML) + función de escape estricto frontend `escapeHtml()` en todos los campos editables. |
| **Autenticación y Claves JWT** | Tokens HMAC-SHA256 con expiración de 8 horas. No se almacenan contraseñas en cookies no seguras. |
| **Protección contra Fuerza Bruta** | Middleware `express-rate-limit` en `/api/auth/login` (5 intentos en 15 min) y en `/api/orders` (máx. 15 pedidos cada 15 min por IP). |
| **Headers de Seguridad HTTP (Helmet)** | `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, y deshabilitación del header informativo `X-Powered-By`. |
| **Cálculo de Precios Servidor** | El frontend únicamente envía `productId` y `quantity`. El servidor consulta la base de datos para calcular subtotales, delivery y total de forma inmutable. |
| **Control Transaccional de Stock** | Al confirmar una venta en el panel administrativo, se verifica atómicamente que `stock >= cantidad_solicitada` y se genera una entrada en la auditoría `stock_movements`. |
| **Privacidad de Costos** | Los endpoints públicos `/api/products` nunca exponen `costPrice` ni `minStock`. |

---

## 📦 Estructura de Archivos del Proyecto

```
crocs-pins-store/
├── data/
│   └── pinpop.sqlite            # Base de datos relacional SQLite
├── public/
│   ├── images/
│   │   ├── brand/
│   │   │   ├── pinpop-logo.png      # Logotipo transparente oficial
│   │   │   └── pinpop-logo-web.png  # Versión optimizada para header web
│   │   ├── pins/                    # Catálogo de fotos HD de pins y charms
│   │   ├── crocs-clog.png           # Calzado para simulador
│   │   └── stethoscope-tube.png     # Tubuladura clínica para simulador
│   ├── app.js                   # Lógica SPA, WhatsApp, zoom y simulador
│   ├── style.css                # Estilos PINPOP Brand Guide & animaciones
│   └── index.html               # Storefront accesible y responsivo
├── database.js                  # Capa de persistencia (SQLite + PostgreSQL)
├── server.js                    # Servidor Express con middleware de seguridad
├── schema.sql                   # Definición DDL SQL para PostgreSQL / Supabase
├── package.json                 # Dependencias y scripts
├── .env.example                 # Plantilla de configuración
└── README.md                    # Documentación técnica y de usuario
```

---

## 📲 Flujo de Checkout por WhatsApp (Paraguay)

1. El cliente explora la tienda, filtra por calzado Crocs o estetoscopio, y agrega sus pins al carrito.
2. Abre el carrito y hace clic en **"Continuar con WhatsApp 📲"**.
3. Ingresa su Nombre, Celular, Dirección o Retiro en Local y Método de Pago (Transferencia SIPAP, Efectivo contra entrega o QR).
4. El servidor registra el pedido en estado `pending` y genera un enlace `https://wa.me/59598...` con el mensaje formateado en Guaraníes.
5. El cliente envía el mensaje preformateado con un toque y el vendedor recibe el pedido con su código `#P...`.
6. En el panel `/admin`, el vendedor confirma el pago con el botón **"Confirmar venta & Descontar Stock"**, lo que descuenta las unidades y registra la auditoría.
