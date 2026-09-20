> **Histórico:** este changelog foi supersedido por `CHANGELOG_MB05.md` e `ESTADO_PROJETO.md`.

# PINPOP — Macrobloco 04

## Escopo consolidado

Este macrobloco reúne as alterações que devem ir juntas em um único deploy no Netlify.

### Catálogo e administração

- WhatsApp comercial: **+595 991 950 031** (`595991950031` no `wa.me`).
- Cadastro mobile com câmera e galeria do aparelho.
- Compressão de imagem no cliente para WebP/JPEG.
- Foto principal + até 4 imagens adicionais.
- Escolha de imagem principal, remoção e substituição.
- Limpeza de uploads novos não utilizados.
- Categorias: criar, editar, desativar e reativar.
- Estoque bloqueado na edição direta; ajustes posteriores passam pelo histórico de inventário.

### Storage

- Upload em memória no backend.
- Validação de assinatura binária (magic bytes), não apenas MIME/extensão.
- Nomes aleatórios com UUID.
- Supabase Storage persistente no Netlify.
- Sem fallback silencioso para filesystem efêmero no Netlify.

### Segurança

- JWT administrativo obrigatório em produção.
- Senha administrativa mínima de 12 caracteres.
- Rate limit em login, pedidos e uploads.
- Helmet, CSP, CORS controlado, anti-framing, `nosniff`, HSTS no Netlify.
- API com `no-store` e `noindex`.
- Rotas administrativas de escrita autenticadas.
- Service role do Supabase somente no servidor.
- Scanner local: **21/21 controles aprovados**.
- Teste de upload falso confirma rejeição por conteúdo inválido.

### SEO e descoberta por IA

- `canonical`, Open Graph, Twitter Card e dados estruturados.
- `sitemap.xml` dinâmico.
- Página SSR individual para cada produto em `/producto/:id`.
- JSON-LD `Product` + `Offer`, preço em PYG e disponibilidade.
- `robots.txt`: OAI-SearchBot permitido; GPTBot bloqueado.
- `llms.txt` como índice textual complementar.
- Conteúdo orientado a buscas naturais no Paraguai sem keyword stuffing.

## Validação

Executar:

```bash
npm run check:syntax
npm run check:security
```

Observação: a revisão de segurança deste macrobloco é uma verificação de código/configuração e testes de ataque locais. Não substitui um pentest externo contra o domínio publicado.

## Risco residual conhecido

Tailwind Browser CDN e Lucide continuam externos. O Tailwind Browser/Play CDN é adequado para desenvolvimento, mas a versão final de performance deve compilar CSS e servir assets localmente. A migração não foi simulada sem instalação/download verificável das dependências neste ambiente.

## Hotfix Netlify — catálogo público resiliente

- Removido boot obrigatório do banco antes de toda requisição da Netlify Function.
- Adicionado fallback público somente de leitura no servidor.
- Adicionado fallback estático em `public/data/` para indisponibilidade total da Function.
- `/api/health` agora informa estado degradado sem cair em HTTP 500.
- Admin, pedidos e estoque permanecem dependentes de banco persistente e não usam fallback.
