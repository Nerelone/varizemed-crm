# Varizemed — Webhook `webh` — Mudanças de 16/01/2026

Este documento registra as mudanças aplicadas no serviço **Cloud Run** `webh` (webhook Twilio/WhatsApp → Dialogflow CX → Firestore), após correções relacionadas a **detecção de handoff** e confiabilidade do **processamento assíncrono**.

---

## 1) Contexto do bug

Foi reportado um caso em produção (conversa “Maria Berenice”) em que o agente do **Dialogflow CX** indicou **handoff**, porém o `webh` **não detectou** e o Firestore **não registrou** `handoff_request`.

### Evidência (CX)
O CX estava setando o parâmetro de handoff em:

- `sessionInfo.parameters.handoff_request = true`

### Sintoma observado (webh)
Nos logs do `webh`, ao salvar parâmetros no Firestore, `handoff_request` **não aparecia** entre as chaves salvas, e a conversa não ia automaticamente para `pending_handoff`.

---

## 2) Mudanças implementadas

### 2.1) Captura de parâmetros do CX mais robusta

**Problema:** O `webh` salvava apenas `resp.query_result.parameters`, mas o CX pode retornar parâmetros também em `sessionInfo.parameters` (dependendo do retorno/SDK).

**Solução:** Foi criado um extrator único que agrega parâmetros de múltiplas fontes, tipicamente:

- `query_result.parameters`
- `query_result.session_info.parameters` (quando existir)
- `resp.session_info.parameters` (quando existir)

**Impacto:** Parâmetros como `handoff_request` passam a ser capturados e persistidos corretamente no Firestore.

---

### 2.2) Detecção de handoff por parâmetro com compatibilidade de nomes

**Problema:** Havia divergência de nomenclatura entre sistemas:

- Webhook (padrão anterior): `handoff_requested`
- CX (em uso): `handoff_request`

**Solução:**
- Padronização do env var em Cloud Run:
  - `DF_HANDOFF_PARAM=handoff_request`
- A detecção de handoff aceita, além do configurado, os nomes mais comuns (compatibilidade):
  - `handoff_request`
  - `handoff_requested`

**Impacto:** Evita falso negativo por diferença de nome do parâmetro.

---

### 2.3) Correção do bug “pós-resolved”

**Problema:** Quando a conversa estava `resolved`, o webhook reabria a conversa no Firestore, mas mantinha `status="resolved"` localmente e ainda forçava `handoff_requested=False` nesse cenário.

**Resultado:** A **primeira mensagem após `resolved`** nunca disparava handoff (mesmo se o CX pedisse).

**Solução na função `_process_message_async`:**
- Ao reabrir após `resolved`, atualizar `status = "bot"` na variável local
- Remover o bloqueio que forçava `handoff_requested=False` quando `was_resolved`
- Ao reabrir após `resolved`, limpar parâmetros de handoff no CX (para não vazar estado antigo)

**Impacto:** A primeira mensagem após `resolved` pode disparar `pending_handoff` normalmente.

---

### 2.4) Ajuste operacional no Cloud Run: CPU sempre alocada

**Problema:** O webhook responde ao Twilio imediatamente e processa em **thread** depois. Com CPU “somente durante request”, o trabalho em background pode falhar/variar.

**Solução:** Foi ajustado para:

- `run.googleapis.com/cpu-throttling: 'false'`

No `gcloud run services describe` isso aparece como:

- `CPU Allocation: CPU is always allocated`

**Impacto:** O processamento assíncrono após retornar HTTP 200 ao Twilio fica mais confiável.

**Observação:** Mantido `Min instances: 0` para economia (cold start aceito).

---

### 2.5) Ajuste de concorrência (concurrency)

- `Concurrency` ajustada para **10**.

**Motivo:** Reduzir risco de sobrecarga por muitas threads simultâneas numa mesma instância, dado que o fluxo faz chamadas externas (CX e Twilio REST) e grava no Firestore.

---

## 3) Configuração final relevante (Cloud Run)

Valores observados após as mudanças (referência):

- `Scaling: Auto (Min: 0)`
- `Concurrency: 10`
- `CPU Allocation: CPU is always allocated`
- `DF_HANDOFF_PARAM=handoff_request`
- `DF_HANDOFF_TEXT_HINTS=...` (mantido, como fallback)

---

## 4) Como validar (checklist)

### 4.1) Caso “pós-resolved”
1. Marcar uma conversa como `resolved` (via CRM/Firestore)
2. Enviar mensagem pedindo atendimento humano (ex.: “transferir para atendente”)
3. Confirmar nos logs:
   - “Reabrindo bot após resolved…”
   - “Handoff detectado via parametro handoff_request…” (ou via marker/hint/payload)
   - “status=pending_handoff”

### 4.2) Caso “handoff via sessionInfo.parameters”
1. No CX, acionar o intent que seta `handoff_request=true`
2. Confirmar no log:
   - “💾 Salvando session_parameters …” contendo `handoff_request`
   - “Handoff detectado via parametro handoff_request …”
   - conversa indo para `pending_handoff`

### 4.3) Confirmações de infra (Cloud Run)
```powershell
gcloud run services describe webh --region southamerica-east1
```

Verificar:
- `Scaling: Auto (Min: 0)`
- `Concurrency: 10`
- `CPU Allocation: CPU is always allocated`

Confirmar annotation:
```powershell
gcloud run services describe webh `
  --region southamerica-east1 `
  --format=yaml | Select-String "cpu-throttling"
```

Deve mostrar:
- `run.googleapis.com/cpu-throttling: 'false'`

---

## 5) Observações importantes

- Mantido `Min instances = 0` para economizar (aceitando cold start).
- O modo async por thread depende de `CPU always allocated` para ser confiável.
- A detecção de handoff fica estável porque o webhook passou a capturar parâmetros também via `sessionInfo.parameters`.

