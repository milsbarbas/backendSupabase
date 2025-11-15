# Backend Supabase

Este é o backend do projeto, usando Supabase como banco de dados.

## Instalação rápida

1. Clone o repositório
2. Entre na pasta do backend e instale dependências:

```powershell
cd backend-supabase
npm install
```

3. Crie o arquivo de ambiente a partir do exemplo e edite-o:

```powershell
Copy-Item .\.env.example .\.env    # Windows PowerShell
notepad .\.env                      # cole suas chaves e salve
```

4. Inicie o servidor (recomendado — utiliza o `.env` automaticamente):

```powershell
.\start-server.ps1
```

Alternativa (se preferir usar nodemon durante desenvolvimento):

```powershell
npm run dev
```

## Variáveis de ambiente

No arquivo `.env` (não comite este arquivo), defina pelo menos:

```
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_KEY=COLE_AQUI_SUA_SERVICE_ROLE_KEY
PORT=3000
```

- IMPORTANTE: use a `SUPABASE_SERVICE_KEY` (service_role) no backend para operações administrativas. Não exponha essa chave no front-end. Se a chave foi vazada, rotacione-a imediatamente no painel do Supabase (Project → Settings → API → Rotate service role key).

## Notas de segurança e manutenção

- Nunca comite o arquivo `.env`. Este repositório já contém um `.gitignore` que ignora `.env`.
- Para chamadas públicas do front-end, use a chave anon/public e regras RLS apropriadas — nunca use a service_role no cliente.
- Recomenda-se implementar hashing de senhas (bcrypt) no backend para armazenar senhas com segurança.

Se precisar, eu posso ajudar a adicionar scripts para migração de senhas, limpeza de duplicatas ou configuração de políticas RLS.