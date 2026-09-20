# ESTADO DO PROJETO — PINPOP v2.3.0

## Arquitetura
- GitHub: repositório principal
- Vercel: hosting + Functions
- Vercel Blob privado: estado da loja + imagens
- Express: API
- Frontend: HTML/CSS/JS estático

## Admin
- segredo manual: `ADMIN_PASSWORD`
- primeiro login: senha → cadastro TOTP por QR → código 6 dígitos
- sessão: cookie HttpOnly/Secure/SameSite=Strict

## Funções preservadas
- catálogo e busca
- carrinho
- WhatsApp +595 991 950 031
- cadastro/edição/desativação de produtos
- câmera/upload mobile
- galeria de imagens
- estoque e movimentações
- pedidos, confirmação, entrega e estorno
- categorias
- dashboard
- SEO, sitemap, robots e llms.txt

## Infraestrutura removida
- Netlify Functions
- Netlify Blobs
- `netlify.toml`
- `_redirects` / `_headers` do Netlify
- `serverless-http`

## Observação de migração
O Vercel Blob inicia com o catálogo fallback empacotado se ainda não existir estado persistido. Dados que eventualmente existam apenas no Netlify Blobs não são importados automaticamente.
