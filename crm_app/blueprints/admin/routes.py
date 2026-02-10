import uuid
from datetime import datetime, timezone, timedelta

from flask import Response, jsonify, request, session
from google.cloud import firestore

from ...core import (
    REOPEN_TEMPLATE_SID_BOT,
    REOPEN_TEMPLATE_SID_DEFAULT,
    REOPEN_TEMPLATE_SID_PENDING_HANDOFF,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN_REST,
    _agent_from_headers,
    _agent_profile,
    _coerce_ts_to_dt,
    _conversation_created_date,
    _decode_cursor,
    _encode_cursor,
    _extract_user_name,
    _format_date_br,
    _iso,
    _is_outside_24h_window,
    _logger,
    _parse_iso,
    _require_auth,
    _twilio_send_template,
    _twilio_send_whatsapp,
    _validate_twilio_signature,
    conv_ref,
    fs,
    http_session,
    login_required,
    log_event,
    messages_ref,
    FS_CONV_COLL,
)
from . import bp


def _normalize_phone_query(value: str) -> str:
    return "".join(ch for ch in (value or "") if ch.isdigit())


def _serialize_conversation(doc, data: dict | None = None):
    dd = data or doc.to_dict() or {}
    up = dd.get("updated_at")
    user_name = _extract_user_name(dd)
    wa_profile_name = dd.get("wa_profile_name")
    tags = dd.get("tags") if isinstance(dd.get("tags"), list) else []
    return {
        "conversation_id": doc.id,
        "status": dd.get("status"),
        "assignee": dd.get("assignee"),
        "assignee_name": dd.get("assignee_name"),
        "user_name": user_name,
        "wa_profile_name": wa_profile_name,
        "tags": tags,
        "last_message_text": dd.get("last_message_text", ""),
        "last_message_by": dd.get("last_message_by"),
        "updated_at": _iso(up) if up else None,
    }


@bp.get("/api/admin/conversations")
@login_required
def list_conversations():
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth:
        return unauth

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
    if cursor_obj:
        dt = _parse_iso(cursor_obj["updated_at"])
        doc_ref = conv_ref(cursor_obj["id"])
        if dt and doc_ref:
            snap = doc_ref.get()
            if snap.exists:
                q = q.start_after(snap)

    docs = list(q.stream())
    items = []
    for d in docs:
        items.append(_serialize_conversation(d))

    out = {"items": items}
    if len(items) == limit and items:
        last_item = items[-1]
        out["next_cursor"] = _encode_cursor({"updated_at": last_item["updated_at"], "id": last_item["conversation_id"]})

    return jsonify(out)


@bp.get("/api/admin/conversations/search")
@login_required
def search_conversations():
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth:
        return unauth

    raw_query = (request.args.get("q") or "").strip()
    if not raw_query:
        return jsonify({"items": []})

    limit = int(request.args.get("limit") or 20)
    limit = max(1, min(limit, 100))

    normalized_query = _normalize_phone_query(raw_query)
    if not normalized_query:
        return jsonify({"items": []})

    seen_ids = set()
    docs_with_data: list[tuple] = []

    def add_doc(snapshot):
        if not snapshot.exists or snapshot.id in seen_ids:
            return
        data = snapshot.to_dict() or {}
        docs_with_data.append((snapshot, data))
        seen_ids.add(snapshot.id)

    exact_candidates = [
        raw_query,
        raw_query.replace("whatsapp:", "").strip(),
        raw_query.replace("whatsapp:", "").replace("+", "").strip(),
        f"+{normalized_query}",
        f"whatsapp:+{normalized_query}",
        normalized_query,
    ]
    for conv_id in exact_candidates:
        if not conv_id or conv_id in seen_ids:
            continue
        add_doc(conv_ref(conv_id).get())
        if len(docs_with_data) >= limit:
            break

    prefix_candidates = [normalized_query, f"+{normalized_query}"]
    for prefix in prefix_candidates:
        if len(docs_with_data) >= limit:
            break
        upper_bound = f"{prefix}\uf8ff"
        remaining = limit - len(docs_with_data)
        prefix_query = (
            fs.collection(FS_CONV_COLL)
            .where("conversation_id", ">=", prefix)
            .where("conversation_id", "<=", upper_bound)
            .order_by("conversation_id")
            .limit(remaining * 3)
        )
        for snap in prefix_query.stream():
            add_doc(snap)
            if len(docs_with_data) >= limit:
                break

    for prefix in prefix_candidates:
        if len(docs_with_data) >= limit:
            break
        upper_bound = f"{prefix}\uf8ff"
        remaining = limit - len(docs_with_data)
        try:
            doc_id_prefix_query = (
                fs.collection(FS_CONV_COLL)
                .where(firestore.FieldPath.document_id(), ">=", prefix)
                .where(firestore.FieldPath.document_id(), "<=", upper_bound)
                .order_by(firestore.FieldPath.document_id())
                .limit(remaining * 3)
            )
            for snap in doc_id_prefix_query.stream():
                add_doc(snap)
                if len(docs_with_data) >= limit:
                    break
        except Exception as exc:
            _logger().warning("search by document id failed for %s: %s", prefix, exc)

    docs_with_data.sort(
        key=lambda item: _coerce_ts_to_dt(item[1].get("updated_at")) or datetime(1970, 1, 1, tzinfo=timezone.utc),
        reverse=True,
    )
    items = [_serialize_conversation(doc, data) for doc, data in docs_with_data[:limit]]
    return jsonify({"items": items})


@bp.get("/api/admin/conversations/<conversation_id>")
@login_required
def get_conversation(conversation_id):
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth:
        return unauth

    snap = conv_ref(conversation_id).get()
    if not snap.exists:
        return jsonify(error={"code": "NOT_FOUND", "message": "Conversa nao encontrada"}), 404

    return jsonify(_serialize_conversation(snap))


@bp.post("/api/admin/conversations/<conversation_id>/user-name")
@login_required
def update_user_name(conversation_id):
    """Atualiza o nome do cliente em session_parameters.user_name"""
    unauth = _require_auth(allow_session=True)
    if unauth:
        return unauth

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

    ref.set({
        "session_parameters": {
            "user_name": user_name,
        },
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    log_event("update_user_name", conversation_id=conversation_id, agent_id=agent_id, user_name=user_name)
    return jsonify(ok=True)


@bp.post("/api/admin/conversations/<conversation_id>/tags")
@login_required
def update_conversation_tags(conversation_id):
    """Atualiza tags da conversa"""
    unauth = _require_auth(allow_session=True)
    if unauth:
        return unauth

    data = request.get_json() or {}
    tags = data.get("tags", [])
    if not isinstance(tags, list):
        return jsonify(error={"code": "BAD_REQUEST", "message": "tags deve ser uma lista"}), 400

    normalized = []
    seen = set()
    for raw in tags:
        tag = str(raw or "").strip()
        if not tag:
            continue
        if len(tag) > 40:
            return jsonify(error={"code": "BAD_REQUEST", "message": "Tag muito longa (max 40 caracteres)"}), 400
        if tag in seen:
            continue
        seen.add(tag)
        normalized.append(tag)

    if len(normalized) > 12:
        return jsonify(error={"code": "BAD_REQUEST", "message": "Máximo de 12 tags por conversa"}), 400

    ref = conv_ref(conversation_id)
    snap = ref.get()
    if not snap.exists:
        return jsonify(error={"code": "NOT_FOUND", "message": "Conversa não encontrada"}), 404

    agent_id, _ = _agent_from_headers()

    ref.set({
        "tags": normalized,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    log_event("update_tags", conversation_id=conversation_id, agent_id=agent_id, tags=normalized)
    return jsonify(ok=True, tags=normalized)


@bp.get("/api/admin/conversations/<conversation_id>/messages")
@login_required
def list_messages(conversation_id):
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth:
        return unauth

    limit = int(request.args.get("limit") or 25)
    cursor_str = (request.args.get("cursor") or "").strip()

    q = messages_ref(conversation_id).order_by("ts", direction=firestore.Query.DESCENDING).limit(limit)

    cursor_obj = _decode_cursor(cursor_str)
    if cursor_obj:
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
            "display_name": dd.get("display_name"),
            "text": dd.get("text"),
            "media_url": dd.get("media_url"),
            "media_type": dd.get("media_type"),
            "media": dd.get("media"),
            "media_urls": dd.get("media_urls"),
            "mime": dd.get("mime"),
            "content_type": dd.get("content_type"),
            "url": dd.get("url"),
            "ts": _iso(ts) if ts else None,
            "client_request_id": dd.get("client_request_id"),
        })

    out = {"items": items}
    if len(items) == limit and items:
        last_item = items[-1]
        out["next_cursor"] = _encode_cursor({"ts": last_item["ts"], "id": last_item["message_id"]})

    return jsonify(out)

@bp.post("/api/admin/conversations/<conversation_id>/claim")
@login_required
def claim_conversation(conversation_id):
    unauth = _require_auth(allow_session=True)
    if unauth:
        return unauth

    agent_id, display_name = _agent_from_headers()
    if not agent_id:
        return jsonify(error={"code": "BAD_REQUEST", "message": "agent_id obrigatório"}), 400

    ref = conv_ref(conversation_id)
    snap = ref.get()
    if not snap.exists:
        return jsonify(error={"code": "NOT_FOUND", "message": "Conversa não encontrada"}), 404

    d = snap.to_dict() or {}
    st = d.get("status", "pending_handoff")
    if st != "pending_handoff":
        return jsonify(error={"code": "INVALID", "message": f"status atual={st} não é pending_handoff"}), 400

    ref.set({
        "status": "claimed",
        "assignee": agent_id,
        "assignee_name": (display_name or agent_id),
        "updated_at": firestore.SERVER_TIMESTAMP,
        "handoff_active": False,
    }, merge=True)

    try:
        ref.update({
            "session_parameters.handoff_requested": firestore.DELETE_FIELD
        })
    except Exception as e:
        _logger().warning("Erro ao limpar handoff_requested no claim: %s", e)

    log_event("claim", conversation_id=conversation_id, agent_id=agent_id, old_status=st, new_status="claimed")
    return jsonify(ok=True, new_status="claimed")


@bp.post("/api/admin/conversations/<conversation_id>/takeover")
@login_required
def takeover_conversation(conversation_id):
    """Assumir conversa já claimed/active (transferência)"""
    unauth = _require_auth(allow_session=True)
    if unauth:
        return unauth

    agent_id, display_name = _agent_from_headers()
    if not agent_id:
        return jsonify(error={"code": "BAD_REQUEST", "message": "agent_id obrigatório"}), 400

    ref = conv_ref(conversation_id)
    snap = ref.get()
    if not snap.exists:
        return jsonify(error={"code": "NOT_FOUND", "message": "Conversa não encontrada"}), 404

    d = snap.to_dict() or {}
    st = d.get("status", "")
    if st not in ("claimed", "active"):
        return jsonify(error={"code": "INVALID", "message": f"status atual={st} não permite takeover"}), 400

    old_assignee = d.get("assignee")
    if old_assignee == agent_id:
        return jsonify(ok=True, new_status=st, already=True)

    ref.set({
        "assignee": agent_id,
        "assignee_name": (display_name or agent_id),
        "updated_at": firestore.SERVER_TIMESTAMP,
        "handoff_active": False,
    }, merge=True)

    log_event(
        "takeover",
        conversation_id=conversation_id,
        agent_id=agent_id,
        old_assignee=old_assignee,
        new_assignee=agent_id,
        status=st,
    )
    return jsonify(ok=True, new_status=st)


@bp.post("/api/admin/conversations/<conversation_id>/handoff")
@login_required
def handoff_from_bot(conversation_id):
    """Assumir conversa do bot (bot -> claimed)"""
    unauth = _require_auth(allow_session=True)
    if unauth:
        return unauth

    agent_id, display_name = _agent_from_headers()
    if not agent_id:
        return jsonify(error={"code": "BAD_REQUEST", "message": "agent_id obrigatório"}), 400

    ref = conv_ref(conversation_id)
    snap = ref.get()
    if not snap.exists:
        return jsonify(error={"code": "NOT_FOUND", "message": "Conversa não encontrada"}), 404

    d = snap.to_dict() or {}
    st = d.get("status", "bot")
    if st != "bot":
        return jsonify(error={"code": "INVALID", "message": f"status atual={st} não é bot"}), 400

    ref.set({
        "status": "claimed",
        "assignee": agent_id,
        "assignee_name": (display_name or agent_id),
        "updated_at": firestore.SERVER_TIMESTAMP,
        "handoff_active": False,
    }, merge=True)

    log_event("handoff_from_bot", conversation_id=conversation_id, agent_id=agent_id, old_status=st, new_status="claimed")
    return jsonify(ok=True, new_status="claimed")


@bp.post("/api/admin/conversations/<conversation_id>/resolve")
@login_required
def resolve_conversation(conversation_id):
    unauth = _require_auth(allow_session=True)
    if unauth:
        return unauth

    agent_id, _ = _agent_from_headers()
    if not agent_id:
        return jsonify(error={"code": "BAD_REQUEST", "message": "agent_id obrigatório"}), 400

    ref = conv_ref(conversation_id)
    snap = ref.get()
    if not snap.exists:
        return jsonify(error={"code": "NOT_FOUND", "message": "Conversa não encontrada"}), 404

    d = snap.to_dict() or {}
    st = d.get("status", "")
    if st not in ("claimed", "active", "bot"):
        return jsonify(error={"code": "INVALID", "message": f"status atual={st} não permite encerramento"}), 400

    ref.set({
        "status": "resolved",
        "assignee": firestore.DELETE_FIELD,
        "assignee_name": firestore.DELETE_FIELD,
        "updated_at": firestore.SERVER_TIMESTAMP,
        "handoff_active": False,
    }, merge=True)

    try:
        ref.update({
            "session_parameters.handoff_requested": firestore.DELETE_FIELD
        })
    except Exception as e:
        _logger().warning("Erro ao limpar handoff_requested: %s", e)

    log_event("resolve", conversation_id=conversation_id, agent_id=agent_id, old_status=st, new_status="resolved")
    return jsonify(ok=True, new_status="resolved")


@bp.get("/api/admin/conversations/<conversation_id>/window-status")
@login_required
def check_24h_window(conversation_id):
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth:
        return unauth

    try:
        ref = conv_ref(conversation_id)
        snap = ref.get()
        conv_data = snap.to_dict() if snap.exists else None
    except Exception:
        ref = None
        conv_data = None

    outside_window = _is_outside_24h_window(conversation_id, conv_data, ref)

    return jsonify({
        "conversation_id": conversation_id,
        "outside_24h_window": outside_window,
        "can_send_free_message": not outside_window,
    }), 200


@bp.get("/api/admin/conversations/<conversation_id>/window-debug")
@login_required
def debug_24h_window(conversation_id):
    """Endpoint de debug para diagnosticar problemas com janela de 24h"""
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth:
        return unauth

    try:
        msgs_query = messages_ref(conversation_id).where("direction", "==", "in").stream()
        msgs_list = list(msgs_query)

        debug_info = {
            "conversation_id": conversation_id,
            "total_inbound_messages_checked": len(msgs_list),
            "messages": [],
        }

        if msgs_list:
            all_msg_infos = []

            for msg in msgs_list:
                data = msg.to_dict()
                ts = data.get("ts")

                msg_info = {
                    "message_id": msg.id,
                    "text": data.get("text", "")[:50],
                    "ts_raw": str(ts),
                    "ts_type": str(type(ts)),
                    "direction": data.get("direction"),
                }

                if ts:
                    if hasattr(ts, "timestamp"):
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

                all_msg_infos.append((msg_info.get("parsed_timestamp", ""), msg_info))

            all_msg_infos.sort(key=lambda x: x[0], reverse=True)
            debug_info["messages"] = [info for _, info in all_msg_infos[:5]]

            if all_msg_infos:
                debug_info["latest_message"] = all_msg_infos[0][1]

            try:
                ref = conv_ref(conversation_id)
                snap = ref.get()
                conv_data = snap.to_dict() if snap.exists else None
            except Exception:
                ref = None
                conv_data = None

            debug_info["outside_24h_window"] = _is_outside_24h_window(conversation_id, conv_data, ref)
        else:
            debug_info["note"] = "Nenhuma mensagem inbound encontrada"
            debug_info["outside_24h_window"] = True

        return jsonify(debug_info), 200
    except Exception as e:
        _logger().error("Erro no debug 24h: %s", e, exc_info=True)
        return jsonify({"error": str(e)}), 500


@bp.get("/api/admin/conversations/<conversation_id>/user-name-debug")
@login_required
def debug_user_name(conversation_id):
    """Endpoint de debug para verificar session_parameters.user_name"""
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth:
        return unauth

    try:
        conv_snap = conv_ref(conversation_id).get()
        if not conv_snap.exists:
            return jsonify({"error": "Conversa não encontrada"}), 404

        conv_data = conv_snap.to_dict()
        session_params = conv_data.get("session_parameters", {})

        debug_info = {
            "conversation_id": conversation_id,
            "session_parameters_exists": isinstance(session_params, dict),
            "session_parameters_type": str(type(session_params)),
            "user_name_exists": False,
            "user_name_type": None,
            "user_name_raw": None,
            "format": None,
        }

        if isinstance(session_params, dict):
            user_name_field = session_params.get("user_name")
            debug_info["user_name_exists"] = user_name_field is not None
            debug_info["user_name_type"] = str(type(user_name_field))
            debug_info["user_name_raw"] = str(user_name_field)[:200] if user_name_field else None

            if isinstance(user_name_field, str):
                debug_info["format"] = "string_direta"
                debug_info["value"] = user_name_field
            elif isinstance(user_name_field, dict):
                debug_info["format"] = "map"
                debug_info["map_keys"] = list(user_name_field.keys())
                nested = user_name_field.get("user_name")
                debug_info["user_name.user_name_exists"] = nested is not None
                debug_info["user_name.user_name_type"] = str(type(nested))
                debug_info["user_name.user_name_value"] = nested if isinstance(nested, str) else str(nested)[:100]
            else:
                debug_info["format"] = "desconhecido"

        debug_info["funcao_result"] = _extract_user_name(conv_data)

        return jsonify(debug_info), 200

    except Exception as e:
        _logger().error("Erro no debug user_name: %s", e, exc_info=True)
        return jsonify({"error": str(e)}), 500

@bp.post("/api/admin/conversations/<conversation_id>/reopen")
@login_required
def reopen_conversation(conversation_id):
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth:
        return unauth

    agent_id, display_name = _agent_from_headers(allow_query=True)
    if not agent_id:
        return jsonify(error={"code": "MISSING_AGENT", "message": "agent_id required"}), 400

    ref = conv_ref(conversation_id)
    snap = ref.get()
    if not snap.exists:
        return jsonify(error={"code": "NOT_FOUND", "message": "Conversation not found"}), 404

    conv = snap.to_dict()
    status = conv.get("status", "bot")

    if not _is_outside_24h_window(conversation_id, conv, ref):
        return jsonify(error={
            "code": "WINDOW_OPEN",
            "message": "Conversa ainda está dentro da janela de 24h",
        }), 400

    if status == "pending_handoff":
        template_sid = REOPEN_TEMPLATE_SID_PENDING_HANDOFF
        template_name = "handoff_request"
    elif status == "bot":
        template_sid = REOPEN_TEMPLATE_SID_BOT
        template_name = "retomada_bot"
    else:
        template_sid = REOPEN_TEMPLATE_SID_DEFAULT
        template_name = "br_varizemed_reabertura_de_atendimento_utility"

    user_name = _extract_user_name(conv).strip()
    if not user_name:
        user_name = "Sr(a)"

    created_date = _conversation_created_date(conv)
    if not created_date:
        _logger().warning("conversation %s missing created_at; using current date for template", conversation_id)
        created_date = _format_date_br(datetime.now(timezone.utc))

    variables = {
        "1": user_name,
        "2": created_date,
    }

    ok, info = _twilio_send_template(conversation_id, template_sid, variables)
    if not ok:
        log_event("reopen_error", conversation_id=conversation_id, agent_id=agent_id,
                  error_code=info.get("code"), error_message=info.get("message"))
        return jsonify(error=info), 502

    message_id = str(uuid.uuid4())
    by = "system:template"
    system_text = f"🔓 Conversa reaberta por {display_name or agent_id}"

    msg_doc = {
        "message_id": message_id,
        "direction": "out",
        "by": by,
        "display_name": (display_name or agent_id),
        "text": system_text,
        "ts": firestore.SERVER_TIMESTAMP,
        "twilio_sid": info.get("sid"),
        "template_sid": template_sid,
        "template_name": template_name,
    }

    messages_ref(conversation_id).document(message_id).set(msg_doc)

    new_status = status
    if status in ("resolved", "pending_handoff"):
        new_status = "claimed"
    elif status == "bot":
        new_status = "bot"
    else:
        new_status = "active"

    update_data = {
        "updated_at": firestore.SERVER_TIMESTAMP,
        "last_message_text": system_text[:200],
        "last_message_by": by,
        "reopened_at": firestore.SERVER_TIMESTAMP,
        "reopened_by": agent_id,
        "last_reopen_template_at": firestore.SERVER_TIMESTAMP,
        "last_reopen_template_sid": template_sid,
        "last_reopen_template_by": agent_id,
        "last_reopen_template_by_name": (display_name or agent_id),
        "handoff_active": False,
    }

    if new_status in ("claimed", "active"):
        update_data["assignee"] = agent_id
        update_data["assignee_name"] = (display_name or agent_id)
    else:
        update_data["assignee"] = firestore.DELETE_FIELD
        update_data["assignee_name"] = firestore.DELETE_FIELD

    if new_status != status:
        update_data["status"] = new_status

    if isinstance(conv, dict) and "claimed_by" in conv:
        update_data["claimed_by"] = firestore.DELETE_FIELD

    ref.set(update_data, merge=True)

    try:
        ref.update({
            "session_parameters.handoff_requested": firestore.DELETE_FIELD
        })
    except Exception as e:
        _logger().warning("Erro ao limpar handoff_requested no reopen: %s", e)

    log_event(
        "reopen",
        conversation_id=conversation_id,
        agent_id=agent_id,
        template_sid=template_sid,
        template_name=template_name,
        twilio_sid=info.get("sid"),
        old_status=status,
        new_status=new_status,
    )

    return jsonify({
        "message_id": message_id,
        "template_sid": template_sid,
        "template_name": template_name,
        "twilio_sid": info.get("sid"),
        "text": system_text,
        "old_status": status,
        "new_status": new_status,
    }), 200


@bp.post("/api/admin/conversations/<conversation_id>/send")
@login_required
def send_message(conversation_id):
    unauth = _require_auth(allow_session=True)
    if unauth:
        return unauth

    data = request.get_json() or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify(error={"code": "BAD_REQUEST", "message": "text obrigatório"}), 400

    client_req_id = (data.get("client_request_id") or "").strip()
    agent_id, display_name = _agent_from_headers()
    if not agent_id:
        return jsonify(error={"code": "BAD_REQUEST", "message": "agent_id obrigatório"}), 400

    prof = _agent_profile()
    use_prefix = prof.get("use_prefix", False)

    ref = conv_ref(conversation_id)
    snap = ref.get()
    if not snap.exists:
        return jsonify(error={"code": "NOT_FOUND", "message": "Conversa não encontrada"}), 404

    d = snap.to_dict() or {}
    st = d.get("status", "")
    assignee = d.get("assignee")

    if st == "claimed":
        if assignee and assignee != agent_id:
            return jsonify(error={"code": "FORBIDDEN", "message": "Conversa claimed por outro agente"}), 403
        new_status = "active"
    elif st == "active":
        if assignee != agent_id:
            return jsonify(error={"code": "FORBIDDEN", "message": "Conversa ativa por outro agente"}), 403
        new_status = "active"
    elif st == "bot":
        return jsonify(error={"code": "INVALID", "message": "Conversa está com bot. Faça handoff primeiro."}), 400
    elif st in ("pending_handoff", "resolved"):
        return jsonify(error={"code": "INVALID", "message": f"status={st} não permite envio"}), 400
    else:
        return jsonify(error={"code": "INVALID", "message": f"status={st} inválido para envio"}), 400

    if use_prefix and display_name:
        prefixed_text = f"{display_name}: {text}"
    else:
        prefixed_text = text

    ok, info = _twilio_send_whatsapp(conversation_id, prefixed_text)
    status_after = new_status

    message_id = str(uuid.uuid4())
    by = f"human:{agent_id}"

    msg_doc_for_firestore = {
        "message_id": message_id,
        "direction": "out",
        "by": by,
        "display_name": display_name,
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

    ref.set({
        "status": status_after,
        "assignee": agent_id,
        "assignee_name": (display_name or agent_id),
        "updated_at": firestore.SERVER_TIMESTAMP,
        "last_message_text": prefixed_text[:200],
        "last_message_by": by,
    }, merge=True)

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
        log_event(
            "send_error",
            conversation_id=conversation_id,
            agent_id=agent_id,
            error_code=info.get("code"),
            error_message=info.get("message"),
        )
        return jsonify(error=info, message=msg_doc_for_response), 502

    log_event(
        "send",
        conversation_id=conversation_id,
        agent_id=agent_id,
        status_after=status_after,
        twilio_sid=info.get("sid"),
        client_request_id=client_req_id,
    )
    return jsonify(message=msg_doc_for_response), 200

@bp.post("/api/admin/twilio-status")
def twilio_status():
    if not _validate_twilio_signature(request):
        return jsonify(error={"code": "FORBIDDEN", "message": "Invalid signature"}), 403

    sid = request.form.get("MessageSid")
    to = request.form.get("To")
    frm = request.form.get("From")
    stat = request.form.get("MessageStatus")
    err = request.form.get("ErrorCode")
    emsg = request.form.get("ErrorMessage") or None

    if not sid or not to:
        return jsonify(ok=True), 200

    conversation_id = to.replace("whatsapp:", "")

    try:
        q = messages_ref(conversation_id).where("twilio_sid", "==", sid).limit(1)
        snaps = list(q.stream())
        if snaps:
            ref = snaps[0].reference
            updates = {"status": stat, "updated_at": firestore.SERVER_TIMESTAMP}
            if err:
                updates["error"] = {"code": err, "message": emsg}
            ref.set(updates, merge=True)
    except Exception as e:
        _logger().warning("status-callback update failed: %s", e)

    log_event("twilio_status", conversation_id=conversation_id, twilio_sid=sid, status=stat, error=err)
    return jsonify(ok=True), 200


@bp.get("/api/admin/media/<path:conversation_id>/<path:message_id>")
@login_required
def proxy_media(conversation_id, message_id):
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth:
        return unauth

    msg_ref = messages_ref(conversation_id).document(message_id)
    snap = msg_ref.get()
    if not snap.exists:
        return jsonify(error={"code": "NOT_FOUND", "message": "Message not found"}), 404

    m = snap.to_dict() or {}
    media_url = m.get("media_url")
    media_type = m.get("media_type", "application/octet-stream")
    if not media_url:
        return jsonify(error={"code": "NO_MEDIA", "message": "Message has no media"}), 404

    try:
        resp = http_session.get(
            media_url,
            auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN_REST),
            timeout=30,
            stream=True,
        )
        if resp.status_code != 200:
            return jsonify(error={"code": "TWILIO_ERROR", "message": "Failed to fetch media"}), 502

        return Response(
            resp.iter_content(chunk_size=8192),
            mimetype=media_type,
            headers={"Cache-Control": "public, max-age=31536000", "Content-Type": media_type},
        )
    except Exception as e:
        _logger().error("Media proxy error: %s", e)
        return jsonify(error={"code": "PROXY_ERROR", "message": str(e)}), 500


@bp.post("/api/admin/reopen-outdated-conversations")
@login_required
def reopen_outdated_conversations():
    unauth = _require_auth(allow_session=True, allow_query=True)
    if unauth:
        return unauth

    agent_id, display_name = _agent_from_headers(allow_query=True)
    actor_name = (display_name or agent_id or "Sistema")

    try:
        candidate_statuses = ["bot", "pending_handoff", "pending", "claimed", "active"]
        now = datetime.now(timezone.utc)
        reopened_count = 0
        skipped_recent = 0
        skipped_window_open = 0
        checked = 0
        errors = []

        for st in candidate_statuses:
            q = fs.collection(FS_CONV_COLL).where("status", "==", st).stream()
            for conv_doc in q:
                checked += 1
                conv_id = conv_doc.id
                conv_data = conv_doc.to_dict() or {}
                current_status = (conv_data.get("status") or st)

                normalized_status = "pending_handoff" if current_status == "pending" else current_status

                last_sent_dt = _coerce_ts_to_dt(conv_data.get("last_reopen_template_at"))
                if last_sent_dt and (now - last_sent_dt) < timedelta(hours=24):
                    skipped_recent += 1
                    continue

                if not _is_outside_24h_window(conv_id, conv_data, conv_doc.reference):
                    skipped_window_open += 1
                    continue

                if normalized_status == "pending_handoff":
                    template_sid = REOPEN_TEMPLATE_SID_PENDING_HANDOFF
                    template_name = "handoff_request"
                elif normalized_status == "bot":
                    template_sid = REOPEN_TEMPLATE_SID_BOT
                    template_name = "retomada_bot"
                else:
                    template_sid = REOPEN_TEMPLATE_SID_DEFAULT
                    template_name = "br_varizemed_reabertura_de_atendimento_utility"

                user_name = _extract_user_name(conv_data).strip() or "Sr(a)"
                created_date = _conversation_created_date(conv_data)
                if not created_date:
                    _logger().warning("conversation %s missing created_at; using current date for template", conv_id)
                    created_date = _format_date_br(now)

                variables = {
                    "1": user_name,
                    "2": created_date,
                }

                ok, info = _twilio_send_template(conv_id, template_sid, variables)
                if not ok:
                    log_event(
                        "reopen_batch_error",
                        conversation_id=conv_id,
                        agent_id=agent_id,
                        error_code=info.get("code"),
                        error_message=info.get("message"),
                        template_sid=template_sid,
                        old_status=current_status,
                    )
                    errors.append({"conversation_id": conv_id, "error": info})
                    continue

                message_id = str(uuid.uuid4())
                by = "system:template"
                system_text = f"🔓 Conversa reaberta automaticamente por {actor_name}"
                msg_doc = {
                    "message_id": message_id,
                    "direction": "out",
                    "by": by,
                    "display_name": actor_name,
                    "text": system_text,
                    "ts": firestore.SERVER_TIMESTAMP,
                    "twilio_sid": info.get("sid"),
                    "template_sid": template_sid,
                    "template_name": template_name,
                }

                messages_ref(conv_id).document(message_id).set(msg_doc)

                update_data = {
                    "updated_at": firestore.SERVER_TIMESTAMP,
                    "last_message_text": system_text[:200],
                    "last_message_by": by,
                    "reopened_at": firestore.SERVER_TIMESTAMP,
                    "reopened_by": agent_id,
                    "last_reopen_template_at": firestore.SERVER_TIMESTAMP,
                    "last_reopen_template_sid": template_sid,
                    "last_reopen_template_by": agent_id,
                    "last_reopen_template_by_name": actor_name,
                    "handoff_active": False,
                }

                if normalized_status != current_status:
                    update_data["status"] = normalized_status

                if normalized_status not in ("claimed", "active"):
                    update_data["assignee"] = firestore.DELETE_FIELD
                    update_data["assignee_name"] = firestore.DELETE_FIELD

                    if normalized_status == "pending_handoff":
                        update_data["status"] = "pending_handoff"
                        update_data["assignee"] = firestore.DELETE_FIELD
                        update_data["assignee_name"] = firestore.DELETE_FIELD
                else:
                    if normalized_status == "claimed" and conv_data.get("assignee"):
                        update_data["assignee_name"] = conv_data.get("assignee")

                if isinstance(conv_data, dict) and "claimed_by" in conv_data:
                    update_data["claimed_by"] = firestore.DELETE_FIELD

                conv_doc.reference.set(update_data, merge=True)
                reopened_count += 1
                log_event(
                    "conversation_reopened_batch",
                    conversation_id=conv_id,
                    old_status=current_status,
                    new_status=update_data.get("status", normalized_status),
                    template_sid=template_sid,
                    twilio_sid=info.get("sid"),
                    actor=agent_id,
                )

        _logger().info(
            "Reopen batch done: reopened=%s skipped_recent=%s skipped_window_open=%s checked=%s errors=%s",
            reopened_count,
            skipped_recent,
            skipped_window_open,
            checked,
            len(errors),
        )

        return jsonify(
            success=True,
            reopened_count=reopened_count,
            skipped_recent=skipped_recent,
            skipped_window_open=skipped_window_open,
            checked=checked,
            errors=errors[:50],
        ), 200

    except Exception as e:
        _logger().error("Error reopening outdated conversations: %s", e, exc_info=True)
        return jsonify(error={"code": "REOPEN_ERROR", "message": str(e)}), 500
