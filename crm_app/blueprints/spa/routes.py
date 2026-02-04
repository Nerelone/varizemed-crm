import os
from pathlib import Path

from flask import current_app, make_response, redirect, send_from_directory, session, url_for

from ...core import login_required
from . import bp


def _serve_index_injetando_bootstrap():
    index_path = os.path.join(current_app.static_folder or "", "index.html")
    with open(index_path, "r", encoding="utf-8") as f:
        html = f.read()
    resp = make_response(html)
    resp.headers["Content-Type"] = "text/html; charset=utf-8"
    return resp


@bp.get("/")
@login_required
def app_index():
    return _serve_index_injetando_bootstrap()


@bp.get("/assets/<path:filename>")
def assets(filename):
    return send_from_directory(str(Path(current_app.static_folder) / "assets"), filename)


@bp.get("/favicon.ico")
def favicon():
    static_dir = Path(current_app.static_folder or "")
    p = static_dir / "favicon.ico"
    if p.exists():
        return send_from_directory(str(static_dir), "favicon.ico")
    return ("", 204)


@bp.get("/<path:path>")
def spa_proxy(path):
    if path.startswith("api/") or path.startswith("healthz") or path == "login":
        return ("Not Found", 404)

    static_dir = Path(current_app.static_folder or "")
    full = static_dir / path
    if path and full.exists() and full.is_file():
        return send_from_directory(str(static_dir), path)

    if not session.get("user"):
        return redirect(url_for("auth.login", next="/" + path))
    return _serve_index_injetando_bootstrap()
