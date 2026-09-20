# Deploy PINPOP no Vercel

## Fluxo recomendado: GitHub → Vercel

### 1. GitHub
Substitua os arquivos do repositório PINPOP pelos arquivos deste backup e faça commit/push na branch principal.

### 2. Importar no Vercel
No Vercel:

**Add New → Project → Import Git Repository**

Selecione o repositório PINPOP. O projeto já contém `vercel.json` e a Function `api/index.js`. Não configure build command manualmente.

### 3. Criar a senha administrativa
Em **Project Settings → Environment Variables**, crie:

```text
ADMIN_PASSWORD = sua senha forte
```

Use Production, Preview e Development se quiser testar previews; para uso somente em produção, Production é suficiente.

### 4. Criar o armazenamento
Em **Storage → Create Database/Store → Blob**, crie um **Blob privado** e conecte ao projeto PINPOP.

Prefira a autenticação OIDC oferecida pelo Vercel. Não exponha token de Blob no frontend.

### 5. Deploy
Faça o deploy. Depois teste:

```text
/api/health
/api/products
```

No `/api/health`, o esperado em produção é:

```json
{
  "ok": true,
  "runtime": "vercel",
  "database": "vercel-blob",
  "databaseHealthy": true,
  "adminConfigured": true
}
```

### Primeiro acesso ao Admin
No rodapé, clique em **Administración**:

1. digite `ADMIN_PASSWORD`;
2. o site mostra QR Code + chave manual;
3. escaneie com Google Authenticator ou Microsoft Authenticator;
4. digite o código de 6 dígitos;
5. pronto.

Nos acessos seguintes: senha → código 2FA.

## Deploys futuros
Depois que GitHub e Vercel estiverem conectados, cada push na branch de produção gera um novo deploy automaticamente. Pull requests/branches podem gerar previews.
