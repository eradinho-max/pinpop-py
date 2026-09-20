# Deploy PINPOP no Netlify — v2.2.1

## 1. Suba o projeto via Git

Conecte o repositório ao Netlify. O `netlify.toml` já contém a configuração de `public/` e Functions.

## 2. Crie apenas uma variável obrigatória

Netlify → Project configuration → Environment variables:

```text
ADMIN_PASSWORD = sua senha forte
```

Mínimo: 12 caracteres. Recomendado: 16+ com letras, números e símbolos.

Opcional para canonical/SEO:

```text
SITE_URL = https://seu-dominio.com
```

## 3. Deploy

Use `Clear cache and deploy site`.

## 4. Primeiro acesso ao Admin

No rodapé, clique em `Administración`.

- Digite `ADMIN_PASSWORD`.
- O PINPOP gera o QR Code do 2FA automaticamente.
- Escaneie no Google Authenticator ou Microsoft Authenticator.
- Digite o código de 6 dígitos.

Nenhuma chave 2FA precisa ser criada manualmente.

## 5. Recuperação do 2FA

Se perder o autenticador:

1. Troque `ADMIN_PASSWORD` no Netlify.
2. Faça um novo deploy.
3. No próximo acesso, o PINPOP pedirá a configuração de um novo 2FA.
