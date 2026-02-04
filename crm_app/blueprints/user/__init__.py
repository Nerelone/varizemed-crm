from flask import Blueprint

bp = Blueprint("user", __name__)

from . import routes  # noqa: E402,F401
