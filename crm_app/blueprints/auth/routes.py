from flask import redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash

from ...core import USERS, log_event
from . import bp


@bp.get("/login")
def login():
    nxt = request.args.get("next", "/")
    if session.get("user"):
        return redirect(nxt)
    return render_template("login.html", error=None)


@bp.post("/login")
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


@bp.post("/logout")
def logout():
    u = session.pop("user", None)
    log_event("logout", user=u)
    return redirect(url_for("auth.login"))
