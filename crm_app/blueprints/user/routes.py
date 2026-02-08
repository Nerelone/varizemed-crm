import uuid

from flask import jsonify, request, session
from google.cloud import firestore

from ...core import FS_USERS_COLL, _agent_profile, _logger, fs, login_required, log_event
from . import bp


@bp.get("/api/user/profile")
@login_required
def user_profile():
    """Retorna perfil do usuario logado para a UI"""
    prof = _agent_profile()
    return jsonify({
        "username": prof["id"],
        "display_name": prof["display_name"],
        "use_prefix": prof["use_prefix"],
    })


@bp.post("/api/user/profile")
@login_required
def user_profile_update():
    """Atualiza display_name e use_prefix do usuario"""
    data = request.get_json() or {}
    display_name = (data.get("display_name") or "").strip()
    use_prefix = data.get("use_prefix", False)

    if not display_name:
        return jsonify({"error": "display_name obrigatorio"}), 400

    username = session.get("user")
    if not username:
        return jsonify({"error": "unauthorized"}), 401

    try:
        fs.collection(FS_USERS_COLL).document(username).set({
            "display_name": display_name,
            "use_prefix": use_prefix,
            "updated_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)

        log_event("profile_update", user=username, display_name=display_name, use_prefix=use_prefix)
        return jsonify({"ok": True, "display_name": display_name, "use_prefix": use_prefix})
    except Exception as e:
        _logger().error("Erro ao atualizar perfil: %s", e)
        return jsonify({"error": "Erro ao atualizar perfil"}), 500


def _load_quick_replies(username: str):
    if not username:
        return []
    try:
        snap = fs.collection(FS_USERS_COLL).document(username).get()
        if not snap.exists:
            return []
        data = snap.to_dict() or {}
        replies = data.get("quick_replies")
        return replies if isinstance(replies, list) else []
    except Exception as e:
        _logger().warning("Erro ao carregar quick replies: %s", e)
        return []


def _save_quick_replies(username: str, replies: list):
    fs.collection(FS_USERS_COLL).document(username).set({
        "quick_replies": replies,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)


def _normalize_shortcut(raw: str):
    shortcut = (raw or "").strip()
    if not shortcut:
        return ""
    if not shortcut.startswith("/"):
        shortcut = f"/{shortcut}"
    return shortcut


@bp.get("/api/user/quick-replies")
@login_required
def list_quick_replies():
    username = session.get("user")
    if not username:
        return jsonify({"error": "unauthorized"}), 401
    replies = _load_quick_replies(username)
    return jsonify({"items": replies})


@bp.post("/api/user/quick-replies")
@login_required
def create_quick_reply():
    username = session.get("user")
    if not username:
        return jsonify({"error": "unauthorized"}), 401

    data = request.get_json() or {}
    title = (data.get("title") or "").strip()
    text = (data.get("text") or "").strip()
    shortcut = _normalize_shortcut(data.get("shortcut") or "")

    if not title:
        return jsonify({"error": "title obrigatorio"}), 400
    if not text:
        return jsonify({"error": "text obrigatorio"}), 400
    if len(title) > 60:
        return jsonify({"error": "title muito longo (max 60)"}), 400
    if len(text) > 2000:
        return jsonify({"error": "text muito longo (max 2000)"}), 400
    if shortcut and (" " in shortcut or len(shortcut) > 40):
        return jsonify({"error": "shortcut invalido (sem espacos, max 40)"}), 400

    replies = _load_quick_replies(username)
    if shortcut:
        for r in replies:
            if (r.get("shortcut") or "").strip() == shortcut:
                return jsonify({"error": "shortcut ja existe"}), 400

    reply = {
        "id": str(uuid.uuid4()),
        "title": title,
        "text": text,
        "shortcut": shortcut,
    }
    replies.append(reply)
    _save_quick_replies(username, replies)

    log_event("quick_reply_create", user=username, reply_id=reply["id"])
    return jsonify(reply), 201


@bp.put("/api/user/quick-replies/<reply_id>")
@login_required
def update_quick_reply(reply_id):
    username = session.get("user")
    if not username:
        return jsonify({"error": "unauthorized"}), 401

    data = request.get_json() or {}
    title = (data.get("title") or "").strip()
    text = (data.get("text") or "").strip()
    shortcut = _normalize_shortcut(data.get("shortcut") or "")

    if not title:
        return jsonify({"error": "title obrigatorio"}), 400
    if not text:
        return jsonify({"error": "text obrigatorio"}), 400
    if len(title) > 60:
        return jsonify({"error": "title muito longo (max 60)"}), 400
    if len(text) > 2000:
        return jsonify({"error": "text muito longo (max 2000)"}), 400
    if shortcut and (" " in shortcut or len(shortcut) > 40):
        return jsonify({"error": "shortcut invalido (sem espacos, max 40)"}), 400

    replies = _load_quick_replies(username)
    found = False
    for r in replies:
        if r.get("id") == reply_id:
            found = True
            r["title"] = title
            r["text"] = text
            r["shortcut"] = shortcut
        elif shortcut and (r.get("shortcut") or "").strip() == shortcut:
            return jsonify({"error": "shortcut ja existe"}), 400

    if not found:
        return jsonify({"error": "quick reply nao encontrada"}), 404

    _save_quick_replies(username, replies)
    log_event("quick_reply_update", user=username, reply_id=reply_id)
    return jsonify({"ok": True, "id": reply_id})


@bp.delete("/api/user/quick-replies/<reply_id>")
@login_required
def delete_quick_reply(reply_id):
    username = session.get("user")
    if not username:
        return jsonify({"error": "unauthorized"}), 401

    replies = _load_quick_replies(username)
    next_replies = [r for r in replies if r.get("id") != reply_id]
    if len(next_replies) == len(replies):
        return jsonify({"error": "quick reply nao encontrada"}), 404

    _save_quick_replies(username, next_replies)
    log_event("quick_reply_delete", user=username, reply_id=reply_id)
    return jsonify({"ok": True})
