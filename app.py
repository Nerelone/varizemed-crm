# app.py  CRM API + SPA estático no mesmo serviço (Cloud Run)
import os, uuid, json, base64, logging, hmac, hashlib
import requests

from pathlib import Path
from datetime import datetime, timezone, timedelta
from functools import wraps
from flask import (
    Flask, render_template, jsonify, request, Response, make_response,
    session, send_from_directory, url_for, redirect
)
from google.cloud import firestore
from werkzeug.security import check_password_hash
from werkzeug.middleware.proxy_fix import ProxyFix

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

# ================== App e estáticos (SPA) ==================
APP_ROOT = Path(__file__).resolve().parent
STATIC_DIR = APP_ROOT / "web"  # coloquei o conteúdo do crm-ui/public aqui

app = Flask(
    __name__,
    static_folder=str(STATIC_DIR),
    static_url_path="",  # serve /web na raiz: /index.html, /assets/*, /app.js...
    template_folder = "templates"
)
# Corrige X-Forwarded-* atrás do proxy do Cloud Run / LB
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1, x_prefix=1)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")

# ================== Config ==================
CRM_ADMIN_TOKEN = (os.getenv("CRM_ADMIN_TOKEN", "") or "").strip()
app.config.update(
    SECRET_KEY=os.environ["SESSION_SECRET_KEY"],
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
)
# Em produção (Cloud Run) garanta cookie seguro
if os.environ.get("K_SERVICE"):
    app.config["SESSION_COOKIE_SECURE"] = True

USERS = {
    "admin": os.environ["USER_ADMIN_PASSWORD_HASH"],
    "secretaria": os.environ["USER_SECRETARIA_PASSWORD_HASH"],
}

# Twilio REST (env via Secret)
TWILIO_ACCOUNT_SID = (os.getenv("TWILIO_ACCOUNT_SID", "") or "").strip()
TWILIO_AUTH_TOKEN_REST = (os.getenv("TWILIO_AUTH_TOKEN_REST", "") or "").strip()
TWILIO_FROM = (os.getenv("TWILIO_WHATSAPP_FROM", "") or "").strip()

# Twilio signature (status callback)  usa o mesmo AUTH TOKEN, mas só p/ assinar
TWILIO_AUTH_TOKEN_SIG = (os.getenv("TWILIO_AUTH_TOKEN", "") or "").strip()

# Firestore
FS_CONV_COLL    = os.getenv("FS_CONV_COLL", "conversations").strip()
FS_MSG_SUBCOLL  = os.getenv("FS_MSG_SUBCOLL", "messages").strip()
FS_USERS_COLL   = os.getenv("FS_USERS_COLL", "crm_users").strip()  #  NOVA coleção
fs = firestore.Client()

# Rate limit
RATE_LIMIT_SEND_PER_CONVO_PER_SEC = float(os.getenv("RATE_LIMIT_SEND_PER_CONVO_PER_SEC", "1"))

# ================== Utils ==================

# -------- Auth helper --------
def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("user"):
            # Se for chamada AJAX/JSON, devolve 401; senão redireciona pro login
            if request.accept_mimetypes.accept_json and not request.accept_mimetypes.accept_html:
                return jsonify({"error": "unauthorized"}), 401
            return redirect(url_for("login", next=request.path))
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
    
    # Busca configurações no Firestore
    display_name = ""
    use_prefix = False
    try:
        user_doc = fs.collection(FS_USERS_COLL).document(username).get()
        if user_doc.exists:
            data = user_doc.to_dict()
            display_name = data.get("display_name", "")
            use_prefix = data.get("use_prefix", False)
    except Exception as e:
        app.logger.warning(f"Erro ao buscar display_name: {e}")
    
    # Fallback para nome padrão se não houver display_name
    if not display_name:
        if username == "admin":
            display_name = "Administrador"
        elif username == "secretaria":
            display_name = "Secretaria"
        else:
            display_name = username.capitalize()
    
    return {
        "id": username,
        "name": display_name,  # Nome completo para sistema
        "display_name": display_name,  # Nome de exibição para cliente
        "use_prefix": use_prefix  # Se deve usar prefixo nas mensagens
    }

def _extract_user_name(conv_data: dict) -> str:
    """
    Extrai user_name de um dict de conversa ja carregado (SEM query adicional).
    
    Estruturas suportadas:
    1. session_parameters.user_name (string direta)
    2. session_parameters.user_name.user_name (map com string dentro)
    
    Retorna string vazia se nao encontrar.
    """
    if not conv_data:
        return ""
    
    session_params = conv_data.get("session_parameters", {})
    
    if not isinstance(session_params, dict):
        return ""
    
    user_name_field = session_params.get("user_name")
    
    if user_name_field is None:
        return ""
    
    # Caso 1: user_name e uma string direta
    if isinstance(user_name_field, str) and user_name_field.strip():
        return user_name_field.strip()
    
    # Caso 2: user_name e um map, buscar user_name.user_name
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
    # 1) sessão
    if allow_session and session.get("user"):
        return None

    # 2) token (opcional)
    tok = (request.headers.get("X-Admin-Token") or "").strip()
    if allow_query and not tok:
        tok = (request.args.get("token") or "").strip()

    if tok and CRM_ADMIN_TOKEN and hmac.compare_digest(tok, CRM_ADMIN_TOKEN):
        return None

    # 3) sem sessão e sem token válido
    return jsonify(error={"code": "UNAUTHORIZED", "message": "Login requerido"}), 401


def _agent_from_headers(allow_query: bool = False):
    """
    Busca agentId e display_name.
    Prioridade: 1) Headers (para compatibilidade), 2) Sessão
    """
    agent_id = (request.headers.get("X-Agent-Id") or "").strip()
    display_name = (request.headers.get("X-Agent-Name") or "").strip()

    if allow_query and not agent_id:
        agent_id = (request.args.get("agent_id") or "").strip()
        display_name = (request.args.get("agent_name") or "").strip()

    # Se não veio nos headers, pega da sessão
    if not agent_id:
        prof = _agent_profile()
        agent_id = prof["id"]
        display_name = display_name or prof["display_name"]

    return agent_id, display_name


def log_event(action, **kw):
    try:
        payload = {"component": "crm-api", "action": action}
        payload.update({k: v for k, v in kw.items() if v is not None})
        app.logger.info(json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass

def _twilio_send_whatsapp(to_e164_plus: str, text: str):
    url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json"
    data = {"From": TWILIO_FROM, "To": f"whatsapp:{to_e164_plus}", "Body": text}
    try:
        # PATCH: Usando http_session com retry automático
        resp = http_session.post(url, data=data, auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN_REST), timeout=20)
        if 200 <= resp.status_code < 300:
            j = resp.json()
            return True, {"sid": j.get("sid"), "status": j.get("status")}
        else:
            try:
                j = resp.json()
                code = j.get("code"); msg  = j.get("message")
            except Exception:
                code = None; msg = resp.text[:200]
            return False, {"code": f"TWILIO_{resp.status_code}", "message": msg or "Twilio error"}
    except requests.RequestException as e:
        return False, {"code": "TWILIO_REQ", "message": str(e)}

def _twilio_send_template(to_e164_plus: str, template_sid: str, variables: dict = None):
    """
    Envia template aprovado do WhatsApp via Twilio Content API
    
    ATUALIZADO: Suporte a variáveis nos templates
    """
    url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json"
    
    data = {
        "From": TWILIO_FROM,
        "To": f"whatsapp:{to_e164_plus}",
        "ContentSid": template_sid
    }
    
    if variables:
        data["ContentVariables"] = json.dumps(variables)
        app.logger.info(f" Enviando template {template_sid} com variáveis: {variables}")
    else:
        app.logger.info(f" Enviando template {template_sid} (sem variáveis)")
    
    try:
        # PATCH: Usando http_session com retry automático
        resp = http_session.post(url, data=data, auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN_REST), timeout=20)
        if 200 <= resp.status_code < 300:
            j = resp.json()
            return True, {"sid": j.get("sid"), "status": j.get("status"), "template_sid": template_sid}
        else:
            try:
                j = resp.json()
                code = j.get("code"); msg = j.get("message")
                app.logger.error(f" Twilio template error {resp.status_code}: code={code}, message={msg}, full_response={j}")
            except Exception:
                code = None; msg = resp.text[:200]
                app.logger.error(f" Twilio template error {resp.status_code}: response_text={msg}")
            return False, {"code": f"TWILIO_{resp.status_code}", "message": msg or "Twilio template error"}
    except requests.RequestException as e:
        app.logger.error(f" Twilio request error: {e}")
        return False, {"code": "TWILIO_REQ", "message": str(e)}

def _is_outside_24h_window(conversation_id: str) -> bool:
    """
    Verifica se a última mensagem INBOUND da conversa está fora da janela de 24h
    """
    try:
        app.logger.info(f" Verificando janela 24h para {conversation_id}")
        
        # NOVA ABORDAGEM: Busca todas mensagens inbound sem order_by
        # Isso evita problema de índice composto no Firestore
        msgs_query = (messages_ref(conversation_id)
                     .where("direction", "==", "in")
                     .stream())
        
        msgs_list = list(msgs_query)
        app.logger.info(f" Total de mensagens inbound encontradas: {len(msgs_list)}")
        
        if not msgs_list:
            app.logger.warning(f" ï¸ Nenhuma mensagem inbound encontrada para {conversation_id}")
            app.logger.info(" Assumindo dentro da janela (sem mensagens inbound)")
            return False
        
        # Encontra manualmente a mensagem mais recente
        latest_msg = None
        latest_time = None
        
        for msg in msgs_list:
            data = msg.to_dict()
            ts = data.get("ts")
            
            if ts:
                # Parse timestamp
                if hasattr(ts, 'timestamp'):
                    msg_time = datetime.fromtimestamp(ts.timestamp(), tz=timezone.utc)
                else:
                    msg_time = _parse_iso(ts)
                
                if msg_time:
                    if latest_time is None or msg_time > latest_time:
                        latest_time = msg_time
                        latest_msg = msg.id
        
        if latest_time is None:
            app.logger.warning(f" ï¸ Nenhum timestamp válido encontrado nas mensagens inbound")
            return False
        
        app.logger.info(f" Ultima mensagem inbound encontrada: {latest_msg}")
        app.logger.info(f" Timestamp: {latest_time}")
        
        now = datetime.now(timezone.utc)
        diff = now - latest_time
        hours_diff = diff.total_seconds() / 3600
        
        app.logger.info(f" Agora: {now}")
        app.logger.info(f" Diferença: {hours_diff:.2f} horas ({diff.days} dias)")
        
        is_outside = diff > timedelta(hours=24)
        app.logger.info(f"{' if is_outside else '} Fora da janela 24h: {is_outside}")
        
        return is_outside
        
    except Exception as e:
        app.logger.error(f" Erro ao checar janela 24h: {e}", exc_info=True)
        return False

def _validate_twilio_signature(req):
    sig = req.headers.get("X-Twilio-Signature", "")
    if not (TWILIO_AUTH_TOKEN_SIG and sig):
        return False
    url = request.url  # deve ser idêntica à URL que o Twilio chamou
    params = request.form.to_dict(flat=True)
    s = url + "".join(k + params[k] for k in sorted(params.keys()))
    expected = base64.b64encode(hmac.new(
        TWILIO_AUTH_TOKEN_SIG.encode(),
        s.encode(),
        hashlib.sha1
    ).digest()).decode()
    return hmac.compare_digest(sig, expected)

# ================== Login / Logout ==================
@app.get("/login")
def login():
    nxt = request.args.get("next", "/")
    if session.get("user"):
        return redirect(nxt)
    return render_template("login.html", error=None)

@app.post("/login")
def login_post():
    u = (request.form.get("username") or "").strip()
    p = (request.form.get("password") or "").strip()
    nxt = request.args.get("next", "/")
    if not (u and p):
        return render_template("login.html", error="Usuário e senha obrigatórios"), 400

    h = USERS.get(u)
    if not h or not check_password_hash(h, p):
        return render_template("login.html", error="Credenciais inválidas"), 401

    session["user"] = u
    log_event("login", user=u)
    return redirect(nxt)

@app.post("/logout")
def logout():
    u = session.pop("user", None)
    log_event("logout", user=u)
    return redirect(url_for("login"))

# ================== User Profile (para UI) ==================
@app.get("/api/user/profile")
@login_required
def user_profile():
    """Retorna perfil do usuário logado para a UI"""
    prof = _agent_profile()
    return jsonify({
        "username": prof["id"],
        "display_name": prof["display_name"],
        "use_prefix": prof["use_prefix"]
    })

@app.post("/api/user/profile")
@login_required
def user_profile_update():
    """Atualiza display_name e use_prefix do usuário"""
    data = request.get_json() or {}
    display_name = (data.get("display_name") or "").strip()
    use_prefix = data.get("use_prefix", False)
    
    if not display_name:
        return jsonify({"error": "display_name é obrigatório"}), 400
    
    username = session.get("user")
    if not username:
        return jsonify({"error": "unauthorized"}), 401
    
    try:
        fs.collection(FS_USERS_COLL).document(username).set({
            "display_name": display_name,
            "use_prefix": use_prefix,
            "updated_at": firestore.SERVER_TIMESTAMP
        }, merge=True)
        
        log_event("profile_update", user=username, display_name=display_name, use_prefix=use_prefix)
        return jsonify({"ok": True, "display_name": display_name, "use_prefix": use_prefix})
    except Exception as e:
        app.logger.error(f"Erro ao atualizar perfil: {e}")
        return jsonify({"error": "Erro ao atualizar perfil"}), 500

# ================== API Admin (protegida) ==================
@app.get("/api/admin/conversations")
@login_required
def list_conversations():
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth: return unauth

    status_str = (request.args.get("status") or "").strip()
    status_list = [s.strip() for s in status_str.split(",") if s.strip()] if status_str else []
    mine = (request.args.get("mine") or "").lower() == "true"
    limit = int(request.args.get("limit") or 25)
    cursor_str = (request.args.get("cursor") or "").strip()

    username = session.get("user") or ""

    q = fs.collection(FS_CONV_COLL)
    if status_list:
        if len(status_list) == 1:
            q = q.where("status", "==", status_list[0])
        else:
            q = q.where("status", "in", status_list)

    if mine and username:
        q = q.where("assignee", "==", username)

    q = q.order_by("updated_at", direction=firestore.Query.DESCENDING).limit(limit)

    cursor_obj = _decode_cursor(cursor_str)
    if cursor_obj and "updated_at" in cursor_obj and "id" in cursor_obj:
        dt = _parse_iso(cursor_obj["updated_at"])
        doc_ref = conv_ref(cursor_obj["id"])
        if dt and doc_ref:
            snap = doc_ref.get()
            if snap.exists:
                q = q.start_after(snap)

    docs = list(q.stream())
    items = []
    for d in docs:
        dd = d.to_dict() or {}
        up = dd.get("updated_at")
        # Extrai user_name do dict ja carregado (SEM query adicional)
        user_name = _extract_user_name(dd)
        items.append({
            "conversation_id": d.id,
            "status": dd.get("status"),
            "assignee": dd.get("assignee"),
            "user_name": user_name,
            "last_message_text": dd.get("last_message_text", ""),
            "last_message_by": dd.get("last_message_by"),
            "updated_at": _iso(up) if up else None,
        })

    out = {"items": items}
    if len(items) == limit and items:
        last_item = items[-1]
        out["next_cursor"] = _encode_cursor({"updated_at": last_item["updated_at"], "id": last_item["conversation_id"]})

    return jsonify(out)

@app.get("/api/admin/conversations/<conversation_id>")
@login_required
def get_conversation(conversation_id):
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth: return unauth

    snap = conv_ref(conversation_id).get()
    if not snap.exists:
        return jsonify(error={"code":"NOT_FOUND","message":"Conversa nao encontrada"}), 404

    d = snap.to_dict() or {}
    up = d.get("updated_at")
    user_name = _extract_user_name(d)
    return jsonify({
        "conversation_id": snap.id,
        "status": d.get("status"),
        "assignee": d.get("assignee"),
        "user_name": user_name,
        "last_message_text": d.get("last_message_text", ""),
        "last_message_by": d.get("last_message_by"),
        "updated_at": _iso(up) if up else None
    })

@app.post("/api/admin/conversations/<conversation_id>/user-name")
@login_required
def update_user_name(conversation_id):
    """Atualiza o nome do cliente em session_parameters.user_name"""
    unauth = _require_auth(allow_session=True)
    if unauth: return unauth

    data = request.get_json() or {}
    user_name = (data.get("user_name") or "").strip()
    
    if not user_name:
        return jsonify(error={"code": "BAD_REQUEST", "message": "user_name obrigatorio"}), 400
    
    if len(user_name) > 100:
        return jsonify(error={"code": "BAD_REQUEST", "message": "Nome muito longo (max 100 caracteres)"}), 400

    ref = conv_ref(conversation_id)
    snap = ref.get()
    if not snap.exists:
        return jsonify(error={"code": "NOT_FOUND", "message": "Conversa nao encontrada"}), 404

    agent_id, _ = _agent_from_headers()
    
    # Salva em session_parameters.user_name como string direta
    # Isso sobrescreve tanto o formato string quanto o formato map
    ref.set({
        "session_parameters": {
            "user_name": user_name
        },
        "user_name_updated_by": agent_id,
        "user_name_updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    log_event("update_user_name", conversation_id=conversation_id, 
              agent_id=agent_id, user_name=user_name)
    
    return jsonify({
        "ok": True, 
        "user_name": user_name,
        "updated_by": agent_id
    })

@app.get("/api/admin/conversations/<conversation_id>/messages")
@login_required
def list_messages(conversation_id):
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth: return unauth

    limit = int(request.args.get("limit") or 25)
    cursor_str = (request.args.get("cursor") or "").strip()

    q = messages_ref(conversation_id).order_by("ts", direction=firestore.Query.DESCENDING).limit(limit)

    cursor_obj = _decode_cursor(cursor_str)
    if cursor_obj and "ts" in cursor_obj and "id" in cursor_obj:
        dt = _parse_iso(cursor_obj["ts"])
        doc_ref = messages_ref(conversation_id).document(cursor_obj["id"])
        if dt and doc_ref:
            snap = doc_ref.get()
            if snap.exists:
                q = q.start_after(snap)

    docs = list(q.stream())
    items = []
    for d in docs:
        dd = d.to_dict() or {}
        ts = dd.get("ts")
        items.append({
            "message_id": d.id,
            "direction": dd.get("direction"),
            "by": dd.get("by"),
            "display_name": dd.get("display_name", ""),
            "text": dd.get("text"),
            "media_url": dd.get("media_url"),
            "media_type": dd.get("media_type"),
            "twilio_sid": dd.get("twilio_sid"),
            "ts": _iso(ts) if ts else None,
            "status": dd.get("status"),
        })

    out = {"items": items}
    if len(items) == limit and items:
        last_item = items[-1]
        out["next_cursor"] = _encode_cursor({"ts": last_item["ts"], "id": last_item["message_id"]})

    return jsonify(out)

@app.post("/api/admin/conversations/<conversation_id>/claim")
@login_required
def claim_conversation(conversation_id):
    unauth = _require_auth(allow_session=True)
    if unauth: return unauth

    agent_id, display_name = _agent_from_headers()
    if not agent_id:
        return jsonify(error={"code":"BAD_REQUEST","message":"agent_id obrigatório"}), 400

    ref = conv_ref(conversation_id)
    snap = ref.get()
    if not snap.exists:
        return jsonify(error={"code":"NOT_FOUND","message":"Conversa não encontrada"}), 404

    d = snap.to_dict() or {}
    st = d.get("status", "pending_handoff")
    if st != "pending_handoff":
        return jsonify(error={"code":"INVALID","message":f"status atual={st} não é pending_handoff"}), 400

    ref.set({
        "status": "claimed",
        "assignee": agent_id,
        "updated_at": firestore.SERVER_TIMESTAMP,
        "handoff_active": False,
    }, merge=True)
    
    # Remove handoff_requested pois o handoff foi atendido
    try:
        ref.update({
            "session_parameters.handoff_requested": firestore.DELETE_FIELD
        })
    except Exception as e:
        app.logger.warning(f"Erro ao limpar handoff_requested no claim: {e}")

    log_event("claim", conversation_id=conversation_id, agent_id=agent_id, old_status=st, new_status="claimed")
    return jsonify(ok=True, new_status="claimed")

@app.post("/api/admin/conversations/<conversation_id>/handoff")
@login_required
def handoff_from_bot(conversation_id):
    """Assumir conversa do bot (bot -> claimed)"""
    unauth = _require_auth(allow_session=True)
    if unauth: return unauth

    agent_id, display_name = _agent_from_headers()
    if not agent_id:
        return jsonify(error={"code":"BAD_REQUEST","message":"agent_id obrigatório"}), 400

    ref = conv_ref(conversation_id)
    snap = ref.get()
    if not snap.exists:
        return jsonify(error={"code":"NOT_FOUND","message":"Conversa não encontrada"}), 404

    d = snap.to_dict() or {}
    st = d.get("status", "bot")
    if st != "bot":
        return jsonify(error={"code":"INVALID","message":f"status atual={st} não é bot"}), 400

    ref.set({
        "status": "claimed",
        "assignee": agent_id,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    log_event("handoff_from_bot", conversation_id=conversation_id, agent_id=agent_id, 
              old_status=st, new_status="claimed")
    return jsonify(ok=True, new_status="claimed")

@app.post("/api/admin/conversations/<conversation_id>/resolve")
@login_required
def resolve_conversation(conversation_id):
    unauth = _require_auth(allow_session=True)
    if unauth: return unauth

    agent_id, _ = _agent_from_headers()
    if not agent_id:
        return jsonify(error={"code":"BAD_REQUEST","message":"agent_id obrigatório"}), 400

    ref = conv_ref(conversation_id)
    snap = ref.get()
    if not snap.exists:
        return jsonify(error={"code":"NOT_FOUND","message":"Conversa não encontrada"}), 404

    d = snap.to_dict() or {}
    st = d.get("status", "")
    
    # Permite encerrar conversas em: claimed, active ou bot
    if st not in ("claimed", "active", "bot"):
        return jsonify(error={"code":"INVALID","message":f"status atual={st} não permite encerramento"}), 400

    # Atualiza status e limpa campos de handoff
    ref.set({
        "status": "resolved",
        "updated_at": firestore.SERVER_TIMESTAMP,
        "handoff_active": False,
        "assignee": None,
        "assignee_name": None,
    }, merge=True)
    
    # Remove handoff_requested de session_parameters (campo aninhado)
    try:
        ref.update({
            "session_parameters.handoff_requested": firestore.DELETE_FIELD
        })
    except Exception as e:
        app.logger.warning(f"Erro ao limpar handoff_requested: {e}")

    log_event("resolve", conversation_id=conversation_id, agent_id=agent_id, old_status=st, new_status="resolved")
    return jsonify(ok=True, new_status="resolved")

# ----- Verificar Status 24h Window -----
@app.get("/api/admin/conversations/<conversation_id>/window-status")
@login_required
def check_24h_window(conversation_id):
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth: return unauth

    outside_window = _is_outside_24h_window(conversation_id)
    
    return jsonify({
        "conversation_id": conversation_id,
        "outside_24h_window": outside_window,
        "can_send_free_message": not outside_window
    }), 200

# ----- DEBUG: Informações detalhadas sobre janela 24h -----
@app.get("/api/admin/conversations/<conversation_id>/window-debug")
@login_required
def debug_24h_window(conversation_id):
    """Endpoint de debug para diagnosticar problemas com janela de 24h"""
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth: return unauth

    try:
        # Busca mensagens inbound (SEM order_by para evitar problema de índice)
        msgs_query = (messages_ref(conversation_id)
                     .where("direction", "==", "in")
                     .stream())
        
        msgs_list = list(msgs_query)
        
        debug_info = {
            "conversation_id": conversation_id,
            "total_inbound_messages_checked": len(msgs_list),
            "messages": []
        }
        
        if msgs_list:
            # Processa todas as mensagens para mostrar no debug
            all_msg_infos = []
            
            for msg in msgs_list:
                data = msg.to_dict()
                ts = data.get("ts")
                
                msg_info = {
                    "message_id": msg.id,
                    "text": data.get("text", "")[:50],
                    "ts_raw": str(ts),
                    "ts_type": str(type(ts)),
                    "direction": data.get("direction")
                }
                
                if ts:
                    if hasattr(ts, 'timestamp'):
                        msg_time = datetime.fromtimestamp(ts.timestamp(), tz=timezone.utc)
                    else:
                        msg_time = _parse_iso(ts)
                    
                    if msg_time:
                        now = datetime.now(timezone.utc)
                        diff = now - msg_time
                        hours_diff = diff.total_seconds() / 3600
                        
                        msg_info["parsed_timestamp"] = msg_time.isoformat()
                        msg_info["hours_ago"] = round(hours_diff, 2)
                        msg_info["days_ago"] = diff.days
                        msg_info["is_outside_24h"] = hours_diff > 24
                        
                        all_msg_infos.append((msg_time, msg_info))
            
            # Ordena por timestamp (mais recente primeiro)
            all_msg_infos.sort(key=lambda x: x[0], reverse=True)
            
            # Pega as 5 mais recentes
            debug_info["messages"] = [info for _, info in all_msg_infos[:5]]
            
            # Status da janela baseado na mais recente
            if all_msg_infos:
                debug_info["latest_message"] = all_msg_infos[0][1]
            
            debug_info["outside_24h_window"] = _is_outside_24h_window(conversation_id)
        else:
            debug_info["note"] = "Nenhuma mensagem inbound encontrada"
            debug_info["outside_24h_window"] = False
        
        return jsonify(debug_info), 200
        
    except Exception as e:
        app.logger.error(f"Erro no debug 24h: {e}", exc_info=True)
        return jsonify({
            "error": str(e),
            "conversation_id": conversation_id
        }), 500

# ----- DEBUG: Verificar nome do cliente -----
@app.get("/api/admin/conversations/<conversation_id>/user-name-debug")
@login_required
def debug_user_name(conversation_id):
    """Endpoint de debug para verificar session_parameters.user_name"""
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth: return unauth

    try:
        conv_snap = conv_ref(conversation_id).get()
        if not conv_snap.exists:
            return jsonify({"error": "Conversation not found"}), 404
        
        conv_data = conv_snap.to_dict()
        session_params = conv_data.get("session_parameters", {})
        
        debug_info = {
            "conversation_id": conversation_id,
            "session_parameters_exists": "session_parameters" in conv_data,
            "session_parameters_type": str(type(session_params)),
        }
        
        if isinstance(session_params, dict):
            user_name_field = session_params.get("user_name")
            debug_info["user_name_exists"] = user_name_field is not None
            debug_info["user_name_type"] = str(type(user_name_field))
            debug_info["user_name_raw"] = str(user_name_field)[:200] if user_name_field else None
            
            # Caso 1: string direta
            if isinstance(user_name_field, str):
                debug_info["format"] = "string_direta"
                debug_info["value"] = user_name_field
            
            # Caso 2: map com user_name dentro
            elif isinstance(user_name_field, dict):
                debug_info["format"] = "map"
                debug_info["map_keys"] = list(user_name_field.keys())
                nested = user_name_field.get("user_name")
                debug_info["user_name.user_name_exists"] = nested is not None
                debug_info["user_name.user_name_type"] = str(type(nested))
                debug_info["user_name.user_name_value"] = nested if isinstance(nested, str) else str(nested)[:100]
            else:
                debug_info["format"] = "desconhecido"
        
        # Resultado da funcao _extract_user_name
        debug_info["funcao_result"] = _extract_user_name(conv_data)
        
        return jsonify(debug_info), 200
        
    except Exception as e:
        app.logger.error(f"Erro no debug user_name: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

# ----- Reabrir Conversa com Template -----
@app.post("/api/admin/conversations/<conversation_id>/reopen")
@login_required
def reopen_conversation(conversation_id):
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth: return unauth

    agent_id, display_name = _agent_from_headers(allow_query=True)
    if not agent_id:
        return jsonify(error={"code": "MISSING_AGENT", "message": "agent_id required"}), 400

    # Verifica se realmente está fora da janela
    if not _is_outside_24h_window(conversation_id):
        return jsonify(error={
            "code": "WINDOW_OPEN", 
            "message": "Conversa ainda está dentro da janela de 24h"
        }), 400

    # Busca conversa para verificar status
    ref = conv_ref(conversation_id)
    snap = ref.get()
    if not snap.exists:
        return jsonify(error={"code": "NOT_FOUND", "message": "Conversation not found"}), 404

    conv = snap.to_dict()
    status = conv.get("status", "bot")

    # Escolhe template baseado no status
    if status == "pending_handoff":
        template_sid = "HXb1361a0ac2b97d83561b74be18c08ea7"  # br_varizemed_retomada_atendimento_pendente
        template_name = "handoff_request"
    else:
        template_sid = "HXb1361a0ac2b97d83561b74be18c08ea7"  # br_varizemed_retomada_atendimento_pendente
        template_name = "retomada_atendimento"

    # Buscar user_name dos session_parameters
    user_name = _extract_user_name(conv).strip()
    if not user_name:
        user_name = "Sr(a)"
    
    variables = {"user_name": user_name}

    # Envia template com variáveis
    ok, info = _twilio_send_template(conversation_id, template_sid, variables)
    
    if not ok:
        log_event("reopen_error", conversation_id=conversation_id, agent_id=agent_id,
                  error_code=info.get("code"), error_message=info.get("message"))
        return jsonify(error=info), 502

    # Registra mensagem no Firestore para aparecer na UI
    message_id = str(uuid.uuid4())
    by = f"system:template"
    
    # Mensagem de sistema inclui nome do ATENDENTE (quem reabriu)
    system_text = f" Conversa reaberta por {display_name or agent_id}"
    
    msg_doc = {
        "message_id": message_id,
        "direction": "out",
        "by": by,
        "display_name": "Sistema",
        "text": system_text,
        "ts": firestore.SERVER_TIMESTAMP,
        "twilio_sid": info.get("sid"),
        "template_sid": template_sid,
        "template_name": template_name,
        "is_template": True
    }
    
    messages_ref(conversation_id).document(message_id).set(msg_doc)

    # Define novo status baseado no status anterior
    # Se era 'resolved', assume a conversa como 'claimed'
    # Se era 'pending_handoff', também muda para 'claimed'
    # Outros status mantêm ou mudam para 'active'
    new_status = status
    if status in ("resolved", "pending_handoff"):
        new_status = "claimed"
    elif status == "bot":
        new_status = "bot"  # Mantém no bot por enquanto
    else:
        new_status = "active"

    # Atualiza conversa
    update_data = {
        "updated_at": firestore.SERVER_TIMESTAMP,
        "last_message_text": system_text[:200],
        "last_message_by": by,
        "reopened_at": firestore.SERVER_TIMESTAMP,
        "reopened_by": agent_id,
        "handoff_active": False,  # Limpa flag de handoff
    }
    
    # Se mudou o status, atualiza também
    if new_status != status:
        update_data["status"] = new_status
        update_data["assignee"] = agent_id  # Atribui ao agente que reabriu
    
    ref.set(update_data, merge=True)
    
    # Remove handoff_requested de session_parameters
    try:
        ref.update({
            "session_parameters.handoff_requested": firestore.DELETE_FIELD
        })
    except Exception as e:
        app.logger.warning(f"Erro ao limpar handoff_requested no reopen: {e}")

    log_event("reopen", conversation_id=conversation_id, agent_id=agent_id,
              template_sid=template_sid, template_name=template_name, 
              twilio_sid=info.get("sid"), old_status=status, new_status=new_status)

    return jsonify({
        "message_id": message_id,
        "template_sid": template_sid,
        "template_name": template_name,
        "twilio_sid": info.get("sid"),
        "text": system_text,
        "old_status": status,
        "new_status": new_status
    }), 200

@app.post("/api/admin/conversations/<conversation_id>/send")
@login_required
def send_message(conversation_id):
    unauth = _require_auth(allow_session=True)
    if unauth: return unauth

    data = request.get_json() or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify(error={"code":"BAD_REQUEST","message":"text obrigatório"}), 400

    client_req_id = (data.get("client_request_id") or "").strip()
    agent_id, display_name = _agent_from_headers()
    if not agent_id:
        return jsonify(error={"code":"BAD_REQUEST","message":"agent_id obrigatório"}), 400

    # Busca configuração do usuário para saber se usa prefixo
    prof = _agent_profile()
    use_prefix = prof.get("use_prefix", False)

    ref = conv_ref(conversation_id)
    snap = ref.get()
    if not snap.exists:
        return jsonify(error={"code":"NOT_FOUND","message":"Conversa não encontrada"}), 404

    d = snap.to_dict() or {}
    st = d.get("status", "")
    assignee = d.get("assignee")

    # Lógica de transição e verificação
    if st == "claimed":
        new_status = "active"
    elif st == "active":
        if assignee != agent_id:
            return jsonify(error={"code":"FORBIDDEN","message":"Conversa ativa por outro agente"}), 403
        new_status = "active"
    elif st == "bot":
        return jsonify(error={"code":"INVALID","message":"Conversa está com bot. Faça handoff primeiro."}), 400
    elif st in ("pending_handoff", "resolved"):
        return jsonify(error={"code":"INVALID","message":f"status={st} não permite envio"}), 400
    else:
        return jsonify(error={"code":"INVALID","message":f"transição {st} -> {new_status} inválida"}), 400

    # Aplica prefixo apenas se use_prefix for True
    if use_prefix and display_name:
        prefixed_text = f"{display_name}: {text}"
    else:
        prefixed_text = text
    
    # Envia via Twilio
    ok, info = _twilio_send_whatsapp(conversation_id, prefixed_text)
    status_after = new_status

    message_id = str(uuid.uuid4())
    by = f"human:{agent_id}"

    # Documento p/ Firestore (ts via SERVER_TIMESTAMP)
    msg_doc_for_firestore = {
        "message_id": message_id,
        "direction": "out",
        "by": by,  # Mantém login real para relatórios
        "display_name": display_name,  # Nome de exibição
        "text": prefixed_text,
        "ts": firestore.SERVER_TIMESTAMP,
    }
    if client_req_id:
        msg_doc_for_firestore["client_request_id"] = client_req_id
    if ok and "sid" in info:
        msg_doc_for_firestore["twilio_sid"] = info["sid"]
    if not ok:
        msg_doc_for_firestore["error"] = info

    messages_ref(conversation_id).document(message_id).set(msg_doc_for_firestore)

    # Atualiza conversa
    ref.set({
        "status": status_after,
        "updated_at": firestore.SERVER_TIMESTAMP,
        "last_message_text": prefixed_text[:200],
        "last_message_by": by
    }, merge=True)

    # Payload p/ resposta imediata
    msg_doc_for_response = {
        "message_id": message_id,
        "direction": "out",
        "by": by,
        "display_name": display_name,
        "text": prefixed_text,
        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if client_req_id:
        msg_doc_for_response["client_request_id"] = client_req_id
    if ok and "sid" in info:
        msg_doc_for_response["twilio_sid"] = info["sid"]
    if not ok:
        msg_doc_for_response["error"] = info

    if not ok:
        log_event("send_error", conversation_id=conversation_id, agent_id=agent_id,
                  error_code=info.get("code"), error_message=info.get("message"))
        return jsonify(error=info, message=msg_doc_for_response), 502

    log_event("send", conversation_id=conversation_id, agent_id=agent_id,
              status_after=status_after, twilio_sid=info.get("sid"), client_request_id=client_req_id)
    return jsonify(message=msg_doc_for_response), 200

# ----- Twilio Status Callback -----
@app.post("/api/admin/twilio-status")
def twilio_status():
    if not _validate_twilio_signature(request):
        return jsonify(error={"code":"FORBIDDEN","message":"Invalid signature"}), 403

    sid   = request.form.get("MessageSid")
    to    = request.form.get("To")      # whatsapp:+55...
    frm   = request.form.get("From")
    stat  = request.form.get("MessageStatus")  # queued/sent/delivered/undelivered/failed
    err   = request.form.get("ErrorCode")
    emsg  = request.form.get("ErrorMessage") or None

    if not sid or not to:
        return jsonify(ok=True), 200  # ignora ruído

    conversation_id = to.replace("whatsapp:", "")

    try:
        q = (messages_ref(conversation_id)
             .where("twilio_sid", "==", sid)
             .limit(1))
        snaps = list(q.stream())
        if snaps:
            ref = snaps[0].reference
            updates = {"status": stat, "updated_at": firestore.SERVER_TIMESTAMP}
            if err:
                updates["error"] = {"code": err, "message": emsg}
            ref.set(updates, merge=True)
    except Exception as e:
        app.logger.warning("status-callback update failed: %s", e)

    log_event("twilio_status", conversation_id=conversation_id, twilio_sid=sid, status=stat, error=err)
    return jsonify(ok=True), 200

# ----- Proxy de Mídia (Twilio) -----
@app.get("/api/admin/media/<path:conversation_id>/<path:message_id>")
@login_required
def proxy_media(conversation_id, message_id):
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth: return unauth

    msg_ref = messages_ref(conversation_id).document(message_id)
    snap = msg_ref.get()
    if not snap.exists:
        return jsonify(error={"code":"NOT_FOUND","message":"Message not found"}), 404

    m = snap.to_dict() or {}
    media_url = m.get("media_url")
    media_type = m.get("media_type", "application/octet-stream")
    if not media_url:
        return jsonify(error={"code":"NO_MEDIA","message":"Message has no media"}), 404

    try:
        # PATCH: Usando http_session com retry automático
        resp = http_session.get(
            media_url,
            auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN_REST),
            timeout=30,
            stream=True
        )
        if resp.status_code != 200:
            return jsonify(error={"code":"TWILIO_ERROR","message":"Failed to fetch media"}), 502

        return Response(
            resp.iter_content(chunk_size=8192),
            mimetype=media_type,
            headers={"Cache-Control": "public, max-age=31536000", "Content-Type": media_type}
        )
    except Exception as e:
        app.logger.error("Media proxy error: %s", e)
        return jsonify(error={"code":"PROXY_ERROR","message":str(e)}), 500

# ================== Admin Tools ==================
@app.post("/api/admin/reopen-outdated-conversations")
@login_required
def reopen_outdated_conversations():
    """Reabre todas as conversas não resolvidas que estão fora da janela de 24h."""
    try:
        # Buscar conversas não resolvidas (bot, pending, claimed) fora de 24h
        outdated_convs = []
        for status in ['bot', 'pending', 'claimed']:
            convs_ref = db.collection('conversations').where('status', '==', status).stream()
            for conv_doc in convs_ref:
                conv_data = conv_doc.to_dict()
                conv_id = conv_doc.id
                if _is_outside_24h_window(conv_id):
                    outdated_convs.append((conv_id, conv_data))
        
        # Reabrir cada conversa
        reopened_count = 0
        for conv_id, conv_data in outdated_convs:
            current_status = conv_data.get('status')
            
            # Lógica de reabertura baseada no status atual
            if current_status == 'bot':
                # Continua em bot
                update_data = {
                    'updated_at': firestore.SERVER_TIMESTAMP
                }
            else:
                # claimed ou pending -> volta para claimed (sem claimed_by)
                update_data = {
                    'status': 'claimed',
                    'updated_at': firestore.SERVER_TIMESTAMP
                }
                if 'claimed_by' in conv_data:
                    update_data['claimed_by'] = firestore.DELETE_FIELD
            
            db.collection('conversations').document(conv_id).update(update_data)
            reopened_count += 1
            
            # Log do evento
            log_event('conversation_reopened_admin', conversation_id=conv_id, reason='outdated_window', previous_status=current_status)
        
        app.logger.info(f"Reopened {reopened_count} outdated conversations")
        return jsonify(success=True, reopened_count=reopened_count), 200
        
    except Exception as e:
        app.logger.error(f"Error reopening outdated conversations: {e}")
        return jsonify(error={"code":"REOPEN_ERROR","message":str(e)}), 500

# ================== Cache e SPA fallback ==================
@app.after_request
def add_cache_headers_after(resp):
    try:
        # HTML da SPA não deve ser cacheado (evita problemas de sessão/atualização)
        if (resp.mimetype or "").startswith("text/html"):
            resp.headers.setdefault("Cache-Control", "no-cache")
        else:
            # Evite cache agressivo para APIs
            if not request.path.startswith("/api/"):
                resp.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    except Exception:
        pass
    return resp

# Home da SPA  protegida
def _serve_index_injetando_bootstrap():
    index_path = os.path.join(app.static_folder, "index.html")
    with open(index_path, "r", encoding="utf-8") as f:
        html = f.read()
    resp = make_response(html)
    resp.headers["Content-Type"] = "text/html; charset=utf-8"
    return resp


@app.get("/")
@login_required
def app_index():
    return _serve_index_injetando_bootstrap()

# Assets estáticos  sem auth
@app.get("/assets/<path:filename>")
def assets(filename):
    return send_from_directory(str(STATIC_DIR / "assets"), filename)

# Favicon/manifest/etc  sem auth
@app.get("/favicon.ico")
def favicon():
    p = STATIC_DIR / "favicon.ico"
    if p.exists():
        return send_from_directory(str(STATIC_DIR), "favicon.ico")
    return ("", 204)

# Catch-all de SPA para rotas de front (com proteção de login)
@app.get("/<path:path>")
def spa_proxy(path):
    # Não sequestra rotas de API, healthz, ou a própria tela de login
    if path.startswith("api/") or path.startswith("healthz") or path == "login":
        return ("Not Found", 404)

    # Se existir arquivo físico, sirva sem auth (js/css/img)
    full = STATIC_DIR / path
    if path and full.exists() and full.is_file():
        return send_from_directory(str(STATIC_DIR), path)

    # Qualquer outra rota é da SPA -> exige login e serve index
    if not session.get("user"):
        return redirect(url_for("login", next="/" + path))
    return _serve_index_injetando_bootstrap()

# 404/500  mantém SPA para rotas não-API, mas respeita login
@app.errorhandler(404)
def not_found(e):
    if request.path.startswith("/api/"):
        return jsonify(error="Not Found"), 404

    if request.path.startswith("/healthz"):
        return ("not found", 404)

    # Para deep links da SPA: se logado, entrega index; senão manda pro login
    if session.get("user"):
        try:
            return _serve_index_injetando_bootstrap()
        except Exception:
            return ("not found", 404)
    return redirect(url_for("login", next=request.path))

@app.errorhandler(500)
def server_error(e):
    if request.path.startswith("/api/"):
        return jsonify(error="Internal Server Error"), 500
    return "Internal Server Error", 500

# Local dev
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 8080)))
