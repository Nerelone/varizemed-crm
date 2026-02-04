# CRM-API - Manual de Operacao e Administracao

Este documento descreve como o sistema esta organizado agora, como administrar usuarios, configurar ambiente e fazer deploy.

## Visao Geral

O CRM agora roda em um unico servico (backend + SPA). O Flask serve a API e os arquivos estaticos gerados pelo frontend React.

Componentes principais:
- Backend: Flask com Blueprints (pacote `crm_app`).
- Frontend: React + Vite (codigo em `src/`, build em `web/`).
- Banco: Firestore (colecoes configuraveis via env).
- Integracoes: Twilio WhatsApp.

## Estrutura do Repo

```
crm-api/
  app.py                       # entrypoint (gunicorn app:app)
  crm_app/                      # backend (blueprints + core)
    __init__.py                 # create_app()
    core.py                     # helpers, Firestore, Twilio, auth, utils
    blueprints/
      auth/                     # /login, /logout
      user/                     # /api/user/profile
      admin/                    # /api/admin/*
      spa/                      # /, /assets/*, /favicon.ico, SPA fallback
  src/                          # frontend React
  web/                          # build final do frontend (index + assets)
  templates/login.html          # tela de login server-side
  Dockerfile
  requirements.txt
```

## Backend (Flask + Blueprints)

Blueprints principais:
- `auth`: `/login`, `/logout`.
- `user`: `/api/user/profile` (buscar e salvar display_name/use_prefix).
- `admin`: `/api/admin/*` (conversas, mensagens, envio, reopen, media proxy, etc).
- `spa`: serve `/` e fallback do SPA.

Entry point:
- `app.py` expõe `app = create_app()`.
- Procfile e Docker continuam apontando para `app:app`.

## Frontend (React)

- Codigo em `src/` com features separadas (`auth`, `conversations`, `chat`, `shared`).
- Build com Vite gera `web/index.html` e `web/assets/*`.
- O Flask serve o `web/` diretamente (sem hosting separado).

Comandos:
```powershell
npm run build  # gera web/
npm run dev    # dev server (frontend apenas)
```

## Autenticacao e Usuarios

O login eh por sessao (cookie). Usuarios sao definidos por variavel de ambiente:
- `USER_ADMIN_PASSWORD_HASH`
- `USER_SECRETARIA_PASSWORD_HASH`

Hashes gerados com o script:
```powershell
python scripts/gerar_hash.py senhaAqui
```

No momento, os usuarios sao fixos: `admin` e `secretaria`.

## Perfil do Agente (display name)

Depois do login, o usuario configura:
- `display_name`
- `use_prefix`

Isso e salvo no Firestore em `FS_USERS_COLL` (default: `crm_users`).
Se `use_prefix` estiver ativo, mensagens enviadas sao prefixadas com o nome do agente.

## Firestore (colecoes)

Colecoes usadas:
- `FS_CONV_COLL` (default: `conversations`)
- `FS_MSG_SUBCOLL` (default: `messages`)
- `FS_USERS_COLL` (default: `crm_users`)

Para staging separado, use nomes diferentes (ex: `stg_conversations`).

## Twilio / WhatsApp

Variaveis obrigatorias:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN_REST`
- `TWILIO_AUTH_TOKEN` (assinatura do callback)
- `TWILIO_WHATSAPP_FROM`

Fluxos:
- Envio de mensagem: `/api/admin/conversations/<id>/send`
- Reabertura com template: `/api/admin/conversations/<id>/reopen`
- Callback de status Twilio: `/api/admin/twilio-status`
- Proxy de midia: `/api/admin/media/<conversation_id>/<message_id>`

## Janela de 24h

O backend calcula se a ultima mensagem inbound esta fora da janela.
- Usa `last_inbound_at` se existir no documento.
- Caso nao exista, busca mensagens recentes e preenche `last_inbound_at` (lazy).

## Variaveis de Ambiente Importantes

Obrigatorias:
- `SESSION_SECRET_KEY`
- `USER_ADMIN_PASSWORD_HASH`
- `USER_SECRETARIA_PASSWORD_HASH`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN_REST`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`

Opcionais:
- `CRM_ADMIN_TOKEN` (token alternativo para chamadas admin)
- `FS_CONV_COLL`, `FS_MSG_SUBCOLL`, `FS_USERS_COLL`
- `TWILIO_REOPEN_TEMPLATE_SID*`
- `RATE_LIMIT_SEND_PER_CONVO_PER_SEC`

## Deploy (Cloud Run)

Antes do deploy, gere o build do frontend:
```powershell
npm run build
```

Deploy:
```powershell
gcloud run deploy crm-api-staging `
  --source . `
  --project=val-02-469714 `
  --region=southamerica-east1 `
  --allow-unauthenticated
```

Observacao: o `Dockerfile` copia a pasta `web/`, entao o build precisa existir localmente.

## Operacao no Dia-a-dia

- Login no `/login`.
- Use a aba de conversas, assuma, envie, encerre.
- Para reabrir conversa fora da janela de 24h, use o botao "Reabrir Conversa".
- Menu admin permite reabrir conversas antigas em lote.

## Troubleshooting Rapido

1) Erro de login:
- Verifique as env vars `USER_ADMIN_PASSWORD_HASH` e `USER_SECRETARIA_PASSWORD_HASH`.

2) Erro de sessao expirada:
- Verifique `SESSION_SECRET_KEY` (mudou = invalida todas as sessoes).

3) Midia nao abre:
- Confira `TWILIO_AUTH_TOKEN_REST` e proxy `/api/admin/media/...`.

4) Deploy sem UI atualizada:
- Faltou rodar `npm run build` antes do deploy.

## Logs

Cloud Run:
```powershell
gcloud logging read "resource.labels.service_name=crm-api-staging" --limit=50
```

