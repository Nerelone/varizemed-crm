# Patch: Retry Automático para SSLEOFError

**Data:** 2026-01-08  
**Versão:** 1.0  
**Autor:** Claude (assistido por I.Z.)  
**Serviços afetados:** `webh`, `crm-api`

---

## 1. Problema Identificado

### Erro Observado
```
SSLEOFError: EOF occurred in violation of protocol
```

### Causa Raiz
O erro `SSLEOFError` ocorre quando a conexão SSL/TLS é fechada abruptamente pelo servidor remoto durante o handshake ou transferência de dados. Causas comuns incluem:

| Causa | Descrição |
|-------|-----------|
| **Cold Start** | Instância do Cloud Run "acordando" após período ocioso |
| **Timeout de conexão idle** | Twilio ou GCP fecharam conexão ociosa |
| **Rate limiting transiente** | Muitas requisições simultâneas |
| **Instabilidade de rede** | Problemas momentâneos de conectividade |

### Chamadas HTTP Afetadas

| Serviço | Arquivo | Função | Destino |
|---------|---------|--------|---------|
| webh | `webh.py` | `send_whatsapp_text()` | api.twilio.com |
| webh | `webh.py` | `send_twilio_template()` | api.twilio.com |
| crm-api | `app.py` | `_twilio_send_whatsapp()` | api.twilio.com |
| crm-api | `app.py` | `_twilio_send_template()` | api.twilio.com |
| crm-api | `app.py` | `proxy_media()` | Twilio Media URLs |

---

## 2. Solução Implementada

### Estratégia: Retry com Backoff Exponencial

A biblioteca `requests` do Python não faz retry automático em erros de SSL/conexão por padrão. O patch implementa uma sessão HTTP persistente com retry automático usando `urllib3.util.retry.Retry`.

### Parâmetros de Retry

| Parâmetro | Valor | Descrição |
|-----------|-------|-----------|
| `total` | 3 | Número máximo de tentativas |
| `read` | 3 | Retries para erros de leitura |
| `connect` | 3 | Retries para erros de conexão |
| `backoff_factor` | 0.5 | Fator de backoff exponencial |
| `status_forcelist` | (500, 502, 503, 504) | Códigos HTTP que disparam retry |
| `allowed_methods` | ["GET", "POST"] | Métodos HTTP permitidos para retry |

### Tempos de Espera (Backoff)

Com `backoff_factor=0.5`, os tempos de espera entre tentativas são:

| Tentativa | Tempo de Espera |
|-----------|-----------------|
| 1ª → 2ª | 0.5 segundos |
| 2ª → 3ª | 1.0 segundo |
| 3ª → 4ª | 2.0 segundos |

**Fórmula:** `{backoff_factor} * (2 ** (tentativa - 1))`

---

## 3. Alterações por Arquivo

### 3.1 webh.py

#### Código Adicionado (após imports, linha ~14)

```python
# ================== RETRY CONFIG (SSLEOFError patch) ==================
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

def _get_retry_session(retries=3, backoff_factor=0.5, status_forcelist=(500, 502, 503, 504)):
    """Sessão requests com retry automático para erros de SSL/conexão."""
    session = requests.Session()
    retry = Retry(
        total=retries,
        read=retries,
        connect=retries,
        backoff_factor=backoff_factor,
        status_forcelist=status_forcelist,
        allowed_methods=["GET", "POST"],
        raise_on_status=False
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session

# Sessão global com retry (reutilizada para performance)
http_session = _get_retry_session()
```

#### Funções Modificadas

**`send_whatsapp_text()`**
```python
# ANTES
r = requests.post(url, data=data, auth=(...), timeout=30)

# DEPOIS
r = http_session.post(url, data=data, auth=(...), timeout=30)
```

**`send_twilio_template()`**
```python
# ANTES
resp = requests.post(url, data=data, auth=(...), timeout=20)

# DEPOIS
resp = http_session.post(url, data=data, auth=(...), timeout=20)
```

---

### 3.2 app.py

#### Código Adicionado (após imports, linha ~16)

```python
# ================== RETRY CONFIG (SSLEOFError patch) ==================
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

def _get_retry_session(retries=3, backoff_factor=0.5, status_forcelist=(500, 502, 503, 504)):
    """Sessão requests com retry automático para erros de SSL/conexão."""
    session = requests.Session()
    retry = Retry(
        total=retries,
        read=retries,
        connect=retries,
        backoff_factor=backoff_factor,
        status_forcelist=status_forcelist,
        allowed_methods=["GET", "POST"],
        raise_on_status=False
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session

# Sessão global com retry (reutilizada para performance)
http_session = _get_retry_session()
```

#### Funções Modificadas

**`_twilio_send_whatsapp()`**
```python
# ANTES
resp = requests.post(url, data=data, auth=(...), timeout=20)

# DEPOIS
resp = http_session.post(url, data=data, auth=(...), timeout=20)
```

**`_twilio_send_template()`**
```python
# ANTES
resp = requests.post(url, data=data, auth=(...), timeout=20)

# DEPOIS
resp = http_session.post(url, data=data, auth=(...), timeout=20)
```

**`proxy_media()`**
```python
# ANTES
resp = requests.get(media_url, auth=(...), timeout=30, stream=True)

# DEPOIS
resp = http_session.get(media_url, auth=(...), timeout=30, stream=True)
```

---

## 4. Benefícios da Implementação

| Benefício | Descrição |
|-----------|-----------|
| **Resiliência** | Erros transientes são tratados automaticamente sem intervenção |
| **Performance** | Sessão HTTP persistente reutiliza conexões (connection pooling) |
| **Transparência** | Retry acontece no nível de transporte, sem alterar lógica de negócio |
| **Configurável** | Parâmetros podem ser ajustados via função `_get_retry_session()` |

---

## 5. Comandos de Deploy

### PowerShell (Windows)

```powershell
# Deploy do serviço webh
gcloud run deploy webh `
    --source . `
    --region southamerica-east1 `
    --project val-02-469714

# Deploy do serviço crm-api
gcloud run deploy crm-api `
    --source . `
    --region southamerica-east1 `
    --project val-02-469714
```

### Verificar Logs Após Deploy

```powershell
# Logs do webh (últimas 50 linhas)
gcloud run logs read webh `
    --region southamerica-east1 `
    --project val-02-469714 `
    --tail 50

# Logs do crm-api (últimas 50 linhas)
gcloud run logs read crm-api `
    --region southamerica-east1 `
    --project val-02-469714 `
    --tail 50

# Logs em tempo real (streaming)
gcloud run logs tail webh `
    --region southamerica-east1 `
    --project val-02-469714
```

---

## 6. Monitoramento Pós-Deploy

### Indicadores de Sucesso

- ✅ Ausência de `SSLEOFError` nos logs
- ✅ Mensagens enviadas com sucesso (`📨 Enviado via REST: SID=...`)
- ✅ Templates enviados com sucesso (`✅ Template enviado com sucesso`)

### Indicadores de Problema Persistente

Se após o patch os erros continuarem com frequência:

1. **Aumentar retries:** Alterar `retries=3` para `retries=5`
2. **Aumentar backoff:** Alterar `backoff_factor=0.5` para `backoff_factor=1.0`
3. **Investigar timeout do Cloud Run:** Verificar configuração de timeout da instância
4. **Verificar rate limits do Twilio:** Consultar dashboard do Twilio para limites

---

## 7. Rollback (se necessário)

Para reverter as mudanças, basta substituir `http_session.post()` e `http_session.get()` por `requests.post()` e `requests.get()` respectivamente, e remover o bloco `RETRY CONFIG`.

---

## 8. Referências

- [urllib3 Retry Documentation](https://urllib3.readthedocs.io/en/stable/reference/urllib3.util.html#urllib3.util.Retry)
- [Requests HTTPAdapter](https://requests.readthedocs.io/en/latest/api/#requests.adapters.HTTPAdapter)
- [Twilio API Rate Limits](https://www.twilio.com/docs/usage/api/rate-limits)
- [Google Cloud Run Timeout Configuration](https://cloud.google.com/run/docs/configuring/request-timeout)
