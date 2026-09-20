# PINPOP — Deploy no Netlify

## Importante

Esta versão usa backend Express através de **Netlify Functions**. Portanto, não utilize o deploy simples por arrastar uma pasta/ZIP no Netlify Drop para a operação completa do sistema.

Use uma destas opções:

1. **Import from Git** no Netlify (recomendado), ou
2. **Netlify CLI**.

O arquivo `netlify.toml` já define:

- pasta publicada: `public`;
- Functions: `netlify/functions`;
- redirecionamento de `/api/*` para a Function Express.

## Teste inicial do site

Depois do deploy correto, a página pública deve abrir normalmente e o catálogo inicial pode ser lido do banco SQLite incluído no pacote.

## Para habilitar o Admin

Configure nas Environment Variables do projeto Netlify:

```text
JWT_SECRET=<uma chave longa e aleatória>
ADMIN_PASSWORD=<sua senha administrativa>
```

## Para operação real com persistência

No Netlify, não utilize SQLite para alterações permanentes. Configure também:

```text
DATABASE_URL=<conexão Transaction Pooler do Supabase, porta 6543>
PG_POOL_MAX=1
```

Sem `DATABASE_URL`, esta versão bloqueia intencionalmente operações que alteram produtos, estoque e pedidos no Netlify. Para Netlify/serverless, use a conexão **Transaction Pooler (Supavisor)** copiada em **Supabase → Connect**, não a conexão direta montada manualmente.

## Para upload persistente das fotos

Configure:

```text
SUPABASE_URL=<URL do projeto Supabase>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
SUPABASE_BUCKET=pins-images
```

O bucket `pins-images` deve existir. O frontend já comprime as fotografias antes do upload.

## Configuração de Build no Netlify

O `netlify.toml` já contém a configuração. Ao importar o repositório, não é necessário escolher manualmente outra pasta de publicação.

Se o painel do Netlify pedir os valores:

```text
Build command: echo PINPOP Netlify build
Publish directory: public
Functions directory: netlify/functions
```

## Verificação rápida

Após o deploy:

1. abra a URL principal;
2. confirme que o catálogo aparece;
3. abra `/api/products` e confirme que retorna JSON;
4. somente depois configure e teste o Admin.


## Verificación rápida después del deploy

Abrí estas URLs en el navegador reemplazando `TU-SITIO`:

- `https://TU-SITIO.netlify.app/` → debe mostrar la tienda.
- `https://TU-SITIO.netlify.app/api/health` → debe devolver JSON con `"ok": true`.
- `https://TU-SITIO.netlify.app/api/products` → debe devolver una lista JSON de productos.

Si `/api/health` o `/api/products` devuelve error, revisá **Deploys > Functions > api > Logs** en Netlify.

## Variables obligatorias para la versión actual

En **Netlify → Site configuration → Environment variables** configurar como mínimo:

```text
DATABASE_URL=...              # Supabase Transaction Pooler / PostgreSQL
JWT_SECRET=...                # mínimo 32 caracteres de alta entropía
ADMIN_PASSWORD=...            # mínimo 12 caracteres
SITE_URL=https://tu-dominio  # URL pública sin barra final
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=... # solo backend/Netlify; nunca frontend
SUPABASE_BUCKET=pins-images
```

Opcional:

```text
ALLOWED_ORIGINS=https://otro-dominio-autorizado
PG_POOL_MAX=1
```

El WhatsApp comercial predeterminado es **+595 991 950 031** (`595991950031` para `wa.me`). Puede modificarse luego desde el panel Admin.

Después del deploy comprobar:

- `/api/health`
- `/api/products`
- `/robots.txt`
- `/sitemap.xml`
- `/llms.txt`

Para probar el Admin de imágenes, las variables de Supabase Storage deben estar configuradas. La service-role key nunca debe incluirse en `public/`, JavaScript del navegador ni repositorio público.
