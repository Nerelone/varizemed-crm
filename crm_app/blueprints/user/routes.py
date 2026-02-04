from flask import jsonify, request, session

from google.cloud import firestore

from ...core import FS_USERS_COLL, _agent_profile, _logger, fs, login_required, log_event
from . import bp


@bp.get("/api/user/profile")
@login_required
def user_profile():
    """Retorna perfil do usuário logado para a UI"""
    prof = _agent_profile()
    return jsonify({
        "username": prof["id"],
        "display_name": prof["display_name"],
        "use_prefix": prof["use_prefix"],
    })


@bp.post("/api/user/profile")
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
            "updated_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)

        log_event("profile_update", user=username, display_name=display_name, use_prefix=use_prefix)
        return jsonify({"ok": True, "display_name": display_name, "use_prefix": use_prefix})
    except Exception as e:
        _logger().error("Erro ao atualizar perfil: %s", e)
        return jsonify({"error": "Erro ao atualizar perfil"}), 500
