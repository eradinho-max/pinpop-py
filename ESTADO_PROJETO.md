# Estado do Projeto PINPOP — v2.2.1

## Arquitetura atual

- Hospedagem: Netlify
- Backend: Netlify Functions + Express
- Dados: Netlify Blobs (`pinpop-data`)
- Imagens: Netlify Blobs (`pinpop-media`)
- Admin: senha forte + TOTP 2FA autoconfigurável + cookie HttpOnly
- Checkout: WhatsApp +595 991 950 031

## Configuração obrigatória

Somente:

```text
ADMIN_PASSWORD
```

Não usar `DATABASE_URL`, `JWT_SECRET`, `ADMIN_TOTP_SECRET` ou Supabase.

## Fluxo do primeiro acesso

Senha → QR Code gerado pelo PINPOP → Authenticator → código 6 dígitos → sessão segura.

## Recuperação

Trocar `ADMIN_PASSWORD` invalida sessões antigas e força novo cadastro do 2FA.

## Funcionalidades preservadas

Catálogo, busca, filtros, favoritos, carrinho, WhatsApp, cadastro mobile com câmera, galeria, categorias, estoque, pedidos, confirmação/estorno/entrega, histórico, dashboard, SEO, sitemap e descoberta por buscadores/IA.
