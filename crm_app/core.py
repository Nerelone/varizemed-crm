import os
import uuid
import json
import base64
import logging
import hmac
import hashlib
from datetime import datetime, timezone, timedelta
from functools import wraps
from pathlib import Path

import requests
from flask import current_app, has_app_context, jsonify, redirect, request, session, url_for
from google.cloud import firestore
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None


# ================== RETRY CONFIG (SSLEOFError patch) ==================

def _get_retry_session(retries=3, backoff_factor=0.5, status_forcelist=(500, 502, 503, 504)):
    """Sessão requests com retry automático para erros de SSL/conexão."""
    session_obj = requests.Session()
    retry = Retry(
        total=retries,
        read=retries,
        connect=retries,
        backoff_factor=backoff_factor,
        status_forcelist=status_forcelist,
        allowed_methods=["GET", "POST"],
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session_obj.mount("https://", adapter)
    session_obj.mount("http://", adapter)
    return session_obj


# Sessão global com retry (reutilizada para performance)
http_session = _get_retry_session()

# ================== Config ==================
CRM_ADMIN_TOKEN = (os.getenv("CRM_ADMIN_TOKEN", "") or "").strip()

USERS = {
    "admin": os.environ["USER_ADMIN_PASSWORD_HASH"],
    "secretaria": os.environ["USER_SECRETARIA_PASSWORD_HASH"],
}

# Twilio REST (env via Secret)
TWILIO_ACCOUNT_SID = (os.getenv("TWILIO_ACCOUNT_SID", "") or "").strip()
TWILIO_AUTH_TOKEN_REST = (os.getenv("TWILIO_AUTH_TOKEN_REST", "") or "").strip()
TWILIO_FROM = (os.getenv("TWILIO_WHATSAPP_FROM", "") or "").strip()

# Templates (WhatsApp Content API)
REOPEN_TEMPLATE_SID_DEFAULT = (
    os.getenv("TWILIO_REOPEN_TEMPLATE_SID", "HX2815473e51a5957705f6be319efe39dc") or ""
).strip()
REOPEN_TEMPLATE_SID_PENDING_HANDOFF = (
    os.getenv("TWILIO_REOPEN_TEMPLATE_SID_PENDING_HANDOFF", REOPEN_TEMPLATE_SID_DEFAULT) or ""
).strip()
REOPEN_TEMPLATE_SID_BOT = (
    os.getenv("TWILIO_REOPEN_TEMPLATE_SID_BOT", REOPEN_TEMPLATE_SID_DEFAULT) or ""
).strip()

# Twilio signature (status callback)
TWILIO_AUTH_TOKEN_SIG = (os.getenv("TWILIO_AUTH_TOKEN", "") or "").strip()

# Firestore
FS_CONV_COLL = os.getenv("FS_CONV_COLL", "conversations").strip()
FS_MSG_SUBCOLL = os.getenv("FS_MSG_SUBCOLL", "messages").strip()
FS_USERS_COLL = os.getenv("FS_USERS_COLL", "crm_users").strip()
fs = firestore.Client()

# Rate limit
RATE_LIMIT_SEND_PER_CONVO_PER_SEC = float(os.getenv("RATE_LIMIT_SEND_PER_CONVO_PER_SEC", "1"))


def _logger():
    if has_app_context():
        return current_app.logger
    return logging.getLogger("crm-api")


# ================== Utils ==================

def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("user"):
            # Se for chamada AJAX/JSON, devolve 401; senão redireciona pro login
            if request.accept_mimetypes.accept_json and not request.accept_mimetypes.accept_html:
                return jsonify({"error": "unauthorized"}), 401
            return redirect(url_for("auth.login", next=request.path))
        return fn(*args, **kwargs)

    return wrapper


def _agent_profile():
    """
    Retorna perfil do agente baseado no usuário logado.
    Busca display_name e use_prefix do Firestore se existir.
    """
    username = session.get("user") or ""
    if not username:
        return {"id": "", "name": "", "display_name": "", "use_prefix": False}

    display_name = ""
    use_prefix = False
    try:
        user_doc = fs.collection(FS_USERS_COLL).document(username).get()
        if user_doc.exists:
            data = user_doc.to_dict()
            display_name = data.get("display_name", "")
            use_prefix = data.get("use_prefix", False)
    except Exception as e:
        _logger().warning("Erro ao buscar display_name: %s", e)

    if not display_name:
        if username == "admin":
            display_name = "Administrador"
        elif username == "secretaria":
            display_name = "Secretaria"
        else:
            display_name = username.capitalize()

    return {
        "id": username,
        "name": display_name,
        "display_name": display_name,
        "use_prefix": use_prefix,
    }


def _extract_user_name(conv_data: dict) -> str:
    """
    Extrai user_name de um dict de conversa já carregado (SEM query adicional).

    Estruturas suportadas:
    1. session_parameters.user_name (string direta)
    2. session_parameters.user_name.user_name (map com string dentro)
    """
    if not conv_data:
        return ""

    session_params = conv_data.get("session_parameters", {})
    if not isinstance(session_params, dict):
        return ""

    user_name_field = session_params.get("user_name")
    if user_name_field is None:
        return ""

    if isinstance(user_name_field, str) and user_name_field.strip():
        return user_name_field.strip()

    if isinstance(user_name_field, dict):
        nested_name = user_name_field.get("user_name")
        if nested_name and isinstance(nested_name, str) and nested_name.strip():
            return nested_name.strip()

    return ""


def _iso(ts):
    try:
        return ts.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return None


def _parse_iso(s: str):
    s = (s or "").strip()
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def _coerce_ts_to_dt(ts):
    """Converte Timestamp/ISO/datetime para datetime UTC (timezone-aware)."""
    if ts is None:
        return None
    try:
        if isinstance(ts, datetime):
            if ts.tzinfo is None:
                return ts.replace(tzinfo=timezone.utc)
            return ts.astimezone(timezone.utc)
    except Exception:
        pass
    if isinstance(ts, str):
        return _parse_iso(ts)
    try:
        if hasattr(ts, "timestamp"):
            return datetime.fromtimestamp(ts.timestamp(), tz=timezone.utc)
    except Exception:
        return None
    return None


def _get_br_tz():
    if ZoneInfo:
        try:
            return ZoneInfo("America/Sao_Paulo")
        except Exception:
            pass
    return timezone(timedelta(hours=-3))


def _format_date_br(dt):
    if not dt:
        return None
    try:
        return dt.astimezone(_get_br_tz()).strftime("%d/%m/%Y")
    except Exception:
        return None


def _conversation_created_date(conv_data: dict) -> str | None:
    if not conv_data or not isinstance(conv_data, dict):
        return None
    created_dt = _coerce_ts_to_dt(conv_data.get("created_at"))
    if not created_dt:
        return None
    return _format_date_br(created_dt)


def _encode_cursor(payload: dict) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(s: str) -> dict | None:
    if not s:
        return None
    try:
        pad = "=" * ((4 - len(s) % 4) % 4)
        raw = base64.urlsafe_b64decode(s + pad)
        return json.loads(raw.decode())
    except Exception:
        return None


def conv_ref(conversation_id: str):
    return fs.collection(FS_CONV_COLL).document(conversation_id)


def messages_ref(conversation_id: str):
    return conv_ref(conversation_id).collection(FS_MSG_SUBCOLL)


def _require_auth(allow_session: bool = True, allow_query: bool = True):
    """
    Autoriza se houver sessão (login).
    Opcionalmente, aceita token via header X-Admin-Token ou ?token=.
    """
    if allow_session and session.get("user"):
        return None

    tok = (request.headers.get("X-Admin-Token") or "").strip()
    if allow_query and not tok:
        tok = (request.args.get("token") or "").strip()

    if tok and CRM_ADMIN_TOKEN and hmac.compare_digest(tok, CRM_ADMIN_TOKEN):
        return None

    return jsonify(error={"code": "UNAUTHORIZED", "message": "Login requerido"}), 401


def _agent_from_headers(allow_query: bool = False):
    """
    Busca agentId e display_name.
    Prioridade: 1) Headers, 2) Sessão
    """
    agent_id = (request.headers.get("X-Agent-Id") or "").strip()
    display_name = (request.headers.get("X-Agent-Name") or "").strip()

    if allow_query and not agent_id:
        agent_id = (request.args.get("agent_id") or "").strip()
        display_name = (request.args.get("agent_name") or "").strip()

    if not agent_id:
        prof = _agent_profile()
        agent_id = prof["id"]
        display_name = display_name or prof["display_name"]

    return agent_id, display_name


def log_event(action, **kw):
    try:
        payload = {"component": "crm-api", "action": action}
        payload.update({k: v for k, v in kw.items() if v is not None})
        _logger().info(json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass


def _twilio_send_whatsapp(to_e164_plus: str, text: str):
    url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json"
    data = {"From": TWILIO_FROM, "To": f"whatsapp:{to_e164_plus}", "Body": text}
    try:
        resp = http_session.post(url, data=data, auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN_REST), timeout=20)
        if 200 <= resp.status_code < 300:
            j = resp.json()
            return True, {"sid": j.get("sid"), "status": j.get("status")}
        try:
            j = resp.json()
            code = j.get("code")
            msg = j.get("message")
        except Exception:
            code = None
            msg = resp.text[:200]
        return False, {"code": f"TWILIO_{resp.status_code}", "message": msg or "Twilio error"}
    except requests.RequestException as e:
        return False, {"code": "TWILIO_REQ", "message": str(e)}


def _twilio_send_template(to_e164_plus: str, template_sid: str, variables: dict | None = None):
    """
    Envia template aprovado do WhatsApp via Twilio Content API
    """
    url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json"

    data = {
        "From": TWILIO_FROM,
        "To": f"whatsapp:{to_e164_plus}",
        "ContentSid": template_sid,
    }

    if variables:
        data["ContentVariables"] = json.dumps(variables)
        _logger().info(" Enviando template %s com variáveis: %s", template_sid, variables)
    else:
        _logger().info(" Enviando template %s SEM variáveis - data: %s", template_sid, data)

    try:
        resp = http_session.post(url, data=data, auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN_REST), timeout=20)
        if 200 <= resp.status_code < 300:
            j = resp.json()
            return True, {"sid": j.get("sid"), "status": j.get("status"), "template_sid": template_sid}
        try:
            j = resp.json()
            code = j.get("code")
            msg = j.get("message")
            _logger().error(
                " Twilio template error %s: code=%s, message=%s, full_response=%s",
                resp.status_code,
                code,
                msg,
                j,
            )
        except Exception:
            code = None
            msg = resp.text[:200]
            _logger().error(" Twilio template error %s: response_text=%s", resp.status_code, msg)
        return False, {"code": f"TWILIO_{resp.status_code}", "message": msg or "Twilio template error"}
    except requests.RequestException as e:
        _logger().error(" Twilio request error: %s", e)
        return False, {"code": "TWILIO_REQ", "message": str(e)}


def _is_outside_24h_window(
    conversation_id: str,
    conv_data: dict | None = None,
    conv_doc_ref=None,
    cache_last_inbound_at: bool = True,
) -> bool:
    """Verifica se a última mensagem INBOUND está fora da janela de 24h."""
    try:
        last_inbound_at = None
        if conv_data and isinstance(conv_data, dict):
            last_inbound_at = conv_data.get("last_inbound_at")

        last_dt = _coerce_ts_to_dt(last_inbound_at)

        if last_dt is None:
            q = (
                messages_ref(conversation_id)
                .order_by("ts", direction=firestore.Query.DESCENDING)
                .limit(25)
            )
            for snap in q.stream():
                d = snap.to_dict() or {}
                if (d.get("direction") or "").lower() == "in":
                    last_dt = _coerce_ts_to_dt(d.get("ts"))
                    if last_dt and cache_last_inbound_at:
                        try:
                            (conv_doc_ref or conv_ref(conversation_id)).set(
                                {"last_inbound_at": d.get("ts")},
                                merge=True,
                            )
                        except Exception:
                            pass
                    break

        if last_dt is None:
            _logger().info("[24h] %s: sem inbound -> fora da janela", conversation_id)
            return True

        now = datetime.now(timezone.utc)
        diff = now - last_dt
        is_outside = diff > timedelta(hours=24)
        _logger().info(
            "[24h] %s: last_inbound=%s diff_h=%.2f outside=%s",
            conversation_id,
            last_dt.isoformat(),
            diff.total_seconds() / 3600,
            is_outside,
        )
        return is_outside

    except Exception as e:
        _logger().error("Erro ao checar janela 24h: %s", e, exc_info=True)
        return False


def _validate_twilio_signature(req):
    sig = req.headers.get("X-Twilio-Signature", "")
    if not (TWILIO_AUTH_TOKEN_SIG and sig):
        return False
    url = request.url
    params = request.form.to_dict(flat=True)
    s = url + "".join(k + params[k] for k in sorted(params.keys()))
    expected = base64.b64encode(
        hmac.new(TWILIO_AUTH_TOKEN_SIG.encode(), s.encode(), hashlib.sha1).digest()
    ).decode()
    return hmac.compare_digest(sig, expected)


def get_app_root() -> Path:
    return Path(__file__).resolve().parent.parent
