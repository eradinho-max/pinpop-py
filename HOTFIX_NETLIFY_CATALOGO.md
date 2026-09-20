# PINPOP — Hotfix Netlify: catálogo público

## Problema observado

A página estática carregava, mas `/api/products` dependia do boot completo da Netlify Function e do banco. Uma falha de `DATABASE_URL`, Supabase, SQLite/WASM ou inicialização da Function fazia a vitrine aparecer como catálogo indisponível.

## Correção aplicada

- A Netlify Function não bloqueia mais toda requisição esperando o banco iniciar.
- `/api/health` responde mesmo quando o banco está indisponível e informa o estado real.
- `/api/products`, `/api/settings`, `/api/categories`, sitemap, llms.txt e páginas públicas de produto utilizam fallback público somente de leitura quando o banco não responde.
- Existe também fallback estático em `public/data/` caso a própria Function esteja indisponível.
- Admin, alterações de estoque e criação de pedidos continuam fail-closed: nunca escrevem no fallback.
- O frontend bloqueia checkout quando detecta que somente o fallback público está disponível.

## Diagnóstico após deploy

Abra:

- `/api/health`
- `/api/products`

`/api/health` deve responder HTTP 200 mesmo em modo degradado.

Quando `databaseHealthy` for `false`, a loja continua visível, mas o Admin/pedidos exigem corrigir `DATABASE_URL`/Supabase.
