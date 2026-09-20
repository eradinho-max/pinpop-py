# PINPOP v2.2.1

Catálogo online de pins com carrinho, fechamento por WhatsApp, estoque, pedidos e painel administrativo mobile-first.

## Configuração mínima

No Netlify, a única variável obrigatória para o painel é:

```text
ADMIN_PASSWORD
```

Use uma senha forte com pelo menos 12 caracteres (recomendado 16+).

Não é necessário criar `JWT_SECRET`, `DATABASE_URL`, Supabase ou chave 2FA manual.

## Primeiro acesso ao Admin

1. Faça o deploy.
2. Abra `Administración` no rodapé.
3. Digite a senha definida em `ADMIN_PASSWORD`.
4. O próprio PINPOP gera o QR Code do 2FA.
5. Escaneie com Google Authenticator ou Microsoft Authenticator.
6. Digite o código de 6 dígitos.
7. Pronto. Nos próximos acessos serão solicitados senha + código 2FA.

Se perder o autenticador, altere `ADMIN_PASSWORD` no Netlify e faça novo deploy. O PINPOP detectará a troca e permitirá configurar um novo 2FA.

## Persistência

- `pinpop-data` (Netlify Blobs): produtos, estoque, categorias, pedidos, movimentos e configuração 2FA.
- `pinpop-media` (Netlify Blobs): imagens enviadas pelo Admin.

## Verificações

```bash
npm run check:all
```
