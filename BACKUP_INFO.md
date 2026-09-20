# PINPOP — Backup geral v2.2.1

Este ZIP é o backup completo do projeto após simplificação final do Admin.

## Para continuar em outro chat

Informar que a arquitetura oficial é:

- Netlify Functions
- Netlify Blobs para dados e imagens
- `ADMIN_PASSWORD` como única variável administrativa obrigatória
- 2FA TOTP criado automaticamente no primeiro acesso via QR Code
- cookie HttpOnly para sessão

Não reintroduzir Supabase, PostgreSQL, `DATABASE_URL`, `JWT_SECRET` ou `ADMIN_TOTP_SECRET` sem necessidade explícita.
