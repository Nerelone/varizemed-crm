# CRM-API - Manual de Operacao e Administracao

Este documento descreve como o sistema esta organizado agora, como administrar usuarios, configurar ambiente e fazer deploy.

## Visao Geral

O CRM agora roda em um unico servico (backend + SPA). O Flask serve a API e os arquivos estaticos gerados pelo frontend React.

Componentes principais:
- Backend: Flask com Blueprints (pacote `crm_app`).
- Frontend: React + Vite (codigo em `src/`, build em `web/`).
- Banco: Firestore (colecoes configuraveis via env).
- Integracoes: Twilio WhatsApp.

## Atualizacoes Recentes (08/02/2026)

- Visibilidade de conversas claimed/active: todas veem, so quem assumiu envia.
- Botao "Assumir atendimento" (takeover) para transferir conversa entre atendentes.
- Nome declarado (CX) e Perfil wapp (Twilio ProfileName) exibidos separadamente na lista e no header.
- Respostas rapidas individuais por usuario com atalhos opcionais (ex: /bomdia).
- Tags por conversa com cores (configuradas em src/shared/constants/tags.ts).
- Composer com textarea e corretor basico (spellcheck).


## Estrutura do Repo

```
crm-api/
  app.py                       # entrypoint (gunicorn app:app)
  crm_app/                      # backend (blueprints + core)
    __init__.py                 # create_app()
    core.py                     # helpers, Firestore, Twilio, auth, utils
    blueprints/
      auth/                     # /login, /logout
      user/                     # /api/user/* (perfil, quick-replies)
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
- `user`: `/api/user/profile` e `/api/user/quick-replies` (perfil e respostas rapidas).
- `admin`: `/api/admin/*` (conversas, mensagens, envio, reopen, media proxy, etc).
- `spa`: serve `/` e fallback do SPA.

Entry point:
- `app.py` expõe `app = create_app()`.
- Procfile e Docker continuam apontando para `app:app`.



## Regras de Atendimento

- Conversas claimed/active podem ser vistas por todas as atendentes.
- Apenas o assignee pode enviar mensagens.
- Para assumir conversa de outra atendente, use "Assumir atendimento".
- Para conversar com o bot, use "Assumir do Bot".
- Para conversar fora da janela de 24h, use "Reabrir Conversa".

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



## Respostas Rapidas (Quick Replies)

- Sao individuais por usuario.
- Podem ser criadas/alteradas/excluidas no modal "Respostas".
- Atalho opcional: se a mensagem digitada for igual ao atalho, o texto completo e enviado.
- Dados salvos em `crm_users.quick_replies`.

## Firestore (colecoes)

Colecoes usadas:
- `FS_CONV_COLL` (default: `conversations`)
- `FS_MSG_SUBCOLL` (default: `messages`)
- `FS_USERS_COLL` (default: `crm_users`)

Para staging separado, use nomes diferentes (ex: `stg_conversations`).

Campos adicionais em `conversations`:
- `wa_profile_name` (ProfileName do WhatsApp)
- `tags` (lista de tags da conversa)
- `assignee_name` (nome exibido do atendente)

Dados em `crm_users`:
- `quick_replies` (lista de respostas rapidas do usuario)


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



## Tags

- Cada conversa pode ter ate 12 tags.
- Cores definidas em `src/shared/constants/tags.ts`.
- Tags aparecem na lista e no header da conversa.

## Janela de 24h

O backend calcula se a ultima mensagem inbound esta fora da janela.
- Usa `last_inbound_at` se existir no documento.
- Caso nao exista, busca mensagens recentes e preenche `last_inbound_at` (lazy).



## Nome Declarado x Perfil Wapp

- Nome declarado vem do Dialogflow CX (session_parameters.user_name).
- Perfil wapp vem do Twilio ProfileName.
- Sao exibidos separadamente para evitar mistura.

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



## Novos Endpoints (08/02/2026)

- POST /api/admin/conversations/<id>/takeover
- POST /api/admin/conversations/<id>/tags
- GET /api/user/quick-replies
- POST /api/user/quick-replies
- PUT /api/user/quick-replies/<id>
- DELETE /api/user/quick-replies/<id>

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
- Para assumir conversa de outra atendente, use "Assumir atendimento".
- Para conversar com o bot, use "Assumir do Bot".
- Para reabrir conversa fora da janela de 24h, use o botao "Reabrir Conversa".
- Use "Respostas" para respostas rapidas individuais.
- Use "Tags" para classificar a conversa.
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


5) Nao consigo enviar mensagem:
- Verifique se voce e o assignee (use "Assumir atendimento").
- Verifique se a conversa esta fora da janela (use "Reabrir Conversa").

## Logs

Cloud Run:
```powershell
gcloud logging read "resource.labels.service_name=crm-api-staging" --limit=50
```

