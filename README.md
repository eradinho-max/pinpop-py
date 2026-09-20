# PINPOP v2.3.0 — Vercel

Loja/catálogo de pins com carrinho, fechamento por WhatsApp, painel administrativo, estoque, upload de imagens e 2FA.

## Produção

- Hospedagem e Functions: **Vercel**
- Código-fonte: **GitHub**
- Persistência e imagens: **Vercel Blob privado**
- Admin: **ADMIN_PASSWORD + TOTP 2FA**
- Sessão: cookie `HttpOnly`, `Secure`, `SameSite=Strict`
- WhatsApp: **+595 991 950 031**

## Único segredo manual da aplicação

No Vercel configure apenas:

```text
ADMIN_PASSWORD
```

Use no mínimo 12 caracteres; recomendado 16+.

O 2FA é configurado no primeiro acesso ao painel: senha → QR Code → código de 6 dígitos.

## Armazenamento

Crie **um Vercel Blob store privado** e conecte-o ao projeto. Em projetos novos, o Vercel usa OIDC automaticamente, então não é necessário copiar `BLOB_READ_WRITE_TOKEN` manualmente.

Veja `DEPLOY_VERCEL.md`.
