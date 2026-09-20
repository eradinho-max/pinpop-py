# PINPOP — Estado do Projeto

Data do backup: 2026-09-20

## Concluído

- Backend é a única fonte de verdade para produtos, estoque, pedidos e admin.
- Deploy preparado para Netlify Functions.
- `/api/health` e `/api/products` disponíveis para diagnóstico.
- Admin bloqueia escrita no Netlify sem `DATABASE_URL` persistente.
- PostgreSQL/Supabase com schema completo para produtos, pedidos, itens, estoque, categorias, configurações e admin.
- PostgreSQL usa transações na mesma conexão (`BEGIN/COMMIT/ROLLBACK`).
- Operações de estoque usam bloqueio de linha no PostgreSQL para evitar concorrência incorreta.
- Criação de pedido é transacional.
- Criação de produto + movimento de estoque inicial é transacional.
- Ajuste de estoque + histórico é transacional.
- Confirmação e estorno de pedidos são transacionais.
- Número amigável do pedido (`P1001`, `P1002`...) usa sequence no PostgreSQL.
- Supabase JS fixado em versão estável no `package.json`.
- Node 22 definido para compatibilidade atual no Netlify/Supabase.

## Produção no Netlify

Variáveis mínimas:

- `DATABASE_URL` — usar Transaction Pooler/Supavisor do Supabase (porta 6543).
- `PG_POOL_MAX=1`
- `JWT_SECRET`
- `ADMIN_PASSWORD`
- `ALLOWED_ORIGINS`

Para imagens persistentes:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_BUCKET=pins-images`

## Próxima etapa prevista

Finalizar o ciclo de imagens persistentes e administração de galeria/categorias sem alterar o fluxo comercial existente.

## Observação de validação

A sintaxe JavaScript foi validada. O ambiente desta sessão não concluiu a instalação NPM, portanto o teste runtime completo com dependências e conexão Supabase real deve ser feito no deploy/ambiente com as variáveis configuradas.
