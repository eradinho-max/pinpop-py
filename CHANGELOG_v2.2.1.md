# PINPOP v2.2.1

- Removida a necessidade de `ADMIN_TOTP_SECRET`.
- Primeiro acesso agora gera QR Code do 2FA automaticamente.
- 2FA é persistido no Netlify Blobs.
- Mudança de `ADMIN_PASSWORD` reseta o vínculo do 2FA e permite recuperação simples.
- Sessão continua em cookie `HttpOnly`, `Secure`, `SameSite=Strict`.
- Mantida uma única variável obrigatória: `ADMIN_PASSWORD`.
- Adicionada dependência `qrcode` para geração local do QR no backend.
