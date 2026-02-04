import logging
import os
from datetime import timedelta
from pathlib import Path

from flask import Flask, jsonify, make_response, redirect, request, session, url_for
from werkzeug.middleware.proxy_fix import ProxyFix

from .core import get_app_root
from .blueprints import admin_bp, auth_bp, spa_bp, user_bp


def create_app():
    app_root = get_app_root()
    static_dir = app_root / "web"
    template_dir = app_root / "templates"

    app = Flask(
        __name__,
        static_folder=str(static_dir),
        static_url_path="",
        template_folder=str(template_dir),
    )

    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1, x_prefix=1)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")

    app.config.update(
        SECRET_KEY=os.environ["SESSION_SECRET_KEY"],
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
    )

    if os.environ.get("K_SERVICE"):
        app.config["SESSION_COOKIE_SECURE"] = True

    app.register_blueprint(auth_bp)
    app.register_blueprint(user_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(spa_bp)

    @app.after_request
    def add_cache_headers_after(resp):
        try:
            if (resp.mimetype or "").startswith("text/html"):
                resp.headers.setdefault("Cache-Control", "no-cache")
            else:
                if not request.path.startswith("/api/"):
                    resp.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
        except Exception:
            pass
        return resp

    def _serve_index_injetando_bootstrap():
        index_path = Path(app.static_folder or "") / "index.html"
        with open(index_path, "r", encoding="utf-8") as f:
            html = f.read()
        resp = make_response(html)
        resp.headers["Content-Type"] = "text/html; charset=utf-8"
        return resp

    @app.errorhandler(404)
    def not_found(e):
        if request.path.startswith("/api/"):
            return jsonify(error="Not Found"), 404

        if request.path.startswith("/healthz"):
            return ("not found", 404)

        if session.get("user"):
            try:
                return _serve_index_injetando_bootstrap()
            except Exception:
                return ("not found", 404)
        return redirect(url_for("auth.login", next=request.path))

    @app.errorhandler(500)
    def server_error(e):
        if request.path.startswith("/api/"):
            return jsonify(error="Internal Server Error"), 500
        return "Internal Server Error", 500

    return app
