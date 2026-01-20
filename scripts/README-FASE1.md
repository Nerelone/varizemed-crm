# 🔐 CRM Varizemed - Fase 1: Autenticação com Login/Senha

## 📋 O que mudou?

### ❌ **REMOVIDO:**
- Menu "Configurar" onde qualquer um podia colocar token e agent_id
- Sistema de autenticação por `X-Admin-Token` nos headers
- LocalStorage para guardar credenciais

### ✅ **ADICIONADO:**
- **Tela de login** com usuário e senha
- **Autenticação por sessão** (cookies seguros)
- **Usuários hardcoded** em variáveis de ambiente com senha hasheada
- **Roles (papéis):** `admin` e `secretaria`
- **Agent ID e Agent Name** mapeados automaticamente por usuário

## 🚀 Como funciona?

Cada usuário configurado no sistema possui:
- **Username**: usado para fazer login
- **Password Hash**: senha criptografada com scrypt
- **Role**: `admin` ou `secretaria` (para controle de permissões futuras)
- **Agent ID**: identificador único do agente (ex: `admin01`, `sec01`)
- **Agent Name**: nome exibido no sistema (ex: `Administrador`, `Secretária`)

## 📁 Estrutura de arquivos

```
crm-api/
├── app.py                    ← Backend modificado (autenticação por sessão)
├── requirements.txt          ← Adicionar: Flask>=3.0.0, Werkzeug>=3.0.0
└── .env.yaml                 ← Variáveis de ambiente (usuarios)

crm-ui/
└── public/
    ├── index.html            ← Frontend com tela de login
    └── app.js                ← JavaScript modificado

scripts/
├── gerar_hash.py             ← Script para gerar hash de senha
└── deploy-fase1.ps1          ← Comandos de deploy completos
```

## 🔧 Passo a passo - Deploy

### 1️⃣ Gerar hashes de senha

```powershell
# Instalar werkzeug
pip install werkzeug

# Gerar hash para ADMIN
python gerar_hash.py admin123
# Output: scrypt:32768:8:1$ABC123...

# Gerar hash para SECRETARIA
python gerar_hash.py senha456
# Output: scrypt:32768:8:1$XYZ789...
```

### 2️⃣ Configurar variáveis no Cloud Run

```powershell
# Definir variáveis do projeto
$PROJECT_ID = "val-02-469714"
$REGION = "southamerica-east1"
$SERVICE_CRM_API = "val-agent"

# Configurar ADMIN
gcloud run services update $SERVICE_CRM_API `
  --project=$PROJECT_ID `
  --region=$REGION `
  --update-env-vars="USER_ADMIN_PASSWORD_HASH=scrypt:32768:8:1$ABC123..."

gcloud run services update $SERVICE_CRM_API `
  --project=$PROJECT_ID `
  --region=$REGION `
  --update-env-vars="USER_ADMIN_ROLE=admin,USER_ADMIN_AGENT_ID=admin01,USER_ADMIN_AGENT_NAME=Administrador"

# Configurar SECRETARIA
gcloud run services update $SERVICE_CRM_API `
  --project=$PROJECT_ID `
  --region=$REGION `
  --update-env-vars="USER_SECRETARIA_PASSWORD_HASH=scrypt:32768:8:1$XYZ789..."

gcloud run services update $SERVICE_CRM_API `
  --project=$PROJECT_ID `
  --region=$REGION `
  --update-env-vars="USER_SECRETARIA_ROLE=secretaria,USER_SECRETARIA_AGENT_ID=sec01,USER_SECRETARIA_AGENT_NAME=Secretária"

# Configurar chave secreta para sessões (OBRIGATÓRIO!)
$SECRET_KEY = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([guid]::NewGuid().ToString()))

gcloud run services update $SERVICE_CRM_API `
  --project=$PROJECT_ID `
  --region=$REGION `
  --update-env-vars="FLASK_SECRET_KEY=$SECRET_KEY,SESSION_COOKIE_SECURE=true"
```

### 3️⃣ Deploy do Backend (CRM-API)

```powershell
cd .\crm-api\

# Fazer deploy
gcloud run deploy $SERVICE_CRM_API `
  --source . `
  --project=$PROJECT_ID `
  --region=$REGION `
  --allow-unauthenticated `
  --memory=512Mi `
  --timeout=60s
```

### 4️⃣ Deploy do Frontend (CRM-UI)

```powershell
cd ..\crm-ui\public\

# Deploy no Firebase Hosting
firebase deploy --only hosting
```

### 5️⃣ Testar!

Acesse: https://crm-varizemed.web.app

**Credenciais padrão:**
- **Admin:** `admin` / `admin123`
- **Secretária:** `secretaria` / `senha456`

## 🔐 Como adicionar novos usuários?

### Opção 1: Via gcloud (recomendado)

```powershell
# 1. Gerar hash da senha
python gerar_hash.py senhadamaria

# 2. Adicionar variáveis
gcloud run services update val-agent `
  --project=val-02-469714 `
  --region=southamerica-east1 `
  --update-env-vars="USER_MARIA_PASSWORD_HASH=scrypt:32768:8:1$...,USER_MARIA_ROLE=secretaria,USER_MARIA_AGENT_ID=maria01,USER_MARIA_AGENT_NAME=Maria Silva"
```

### Opção 2: Via arquivo .env.yaml (local)

```yaml
USER_MARIA_PASSWORD_HASH: "scrypt:32768:8:1$..."
USER_MARIA_ROLE: "secretaria"
USER_MARIA_AGENT_ID: "maria01"
USER_MARIA_AGENT_NAME: "Maria Silva"
```

## 🛡️ Segurança

### ✅ Boas práticas implementadas:
- Senhas hasheadas com **scrypt** (algoritmo seguro)
- Sessões com **cookies HttpOnly** (protege contra XSS)
- Sessões com **cookie SameSite=Lax** (protege contra CSRF)
- Sessões expiram em **8 horas** de inatividade
- **HTTPS obrigatório** em produção (`SESSION_COOKIE_SECURE=true`)
- Comparação de senha com **timing-safe** (previne timing attacks)

### ⚠️ Importante:
- **NUNCA** commite hashes de senha no Git
- Use senhas fortes para usuários reais
- Troque a `FLASK_SECRET_KEY` em produção
- Ative `SESSION_COOKIE_SECURE=true` em produção (HTTPS)

## 📊 Estrutura de usuários

```
Variável de ambiente → Formato
────────────────────────────────────────────
USER_<USERNAME>_PASSWORD_HASH → Hash scrypt
USER_<USERNAME>_ROLE          → admin|secretaria
USER_<USERNAME>_AGENT_ID      → ID único
USER_<USERNAME>_AGENT_NAME    → Nome exibido
```

**Exemplo:**
```
USER_ADMIN_PASSWORD_HASH=scrypt:32768:8:1$...
USER_ADMIN_ROLE=admin
USER_ADMIN_AGENT_ID=admin01
USER_ADMIN_AGENT_NAME=Administrador
```

## 🔄 Próximas fases

### Fase 2 - Usuários no Firestore
- Migrar usuários para coleção `users` no Firestore
- CRUD via API (somente admin)
- Mesma lógica de autenticação

### Fase 3 - Painel administrativo
- Interface web para gerenciar usuários
- Reset de senha
- Logs de auditoria

### Fase 4 - Hardening
- 2FA (TOTP)
- Política de senha forte
- Bloqueio por tentativas
- Rotação de sessão

## 🐛 Troubleshooting

### Problema: "No users configured"
**Solução:** Verifique se as variáveis de ambiente estão configuradas corretamente:
```powershell
gcloud run services describe val-agent --format="get(spec.template.spec.containers[0].env)"
```

### Problema: "Invalid credentials"
**Solução:** 
1. Verifique se o hash foi copiado corretamente (não deve ter espaços/quebras)
2. Teste localmente gerando novo hash
3. Verifique se o username está em minúsculas

### Problema: "Session expired"
**Solução:** A sessão expira após 8 horas ou se a FLASK_SECRET_KEY mudar. Faça login novamente.

## 📞 Suporte

Se tiver problemas:
1. Veja os logs: `gcloud logging read "resource.labels.service_name=val-agent" --limit=50`
2. Verifique variáveis: Use o comando de describe acima
3. Teste localmente primeiro com `flask run`

---

**Desenvolvido para Varizemed** 🏥
