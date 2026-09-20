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
DATABASE_URL=<conexão PostgreSQL/Supabase>
```

Sem `DATABASE_URL`, esta versão bloqueia intencionalmente operações que alteram produtos, estoque e pedidos no Netlify.

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
