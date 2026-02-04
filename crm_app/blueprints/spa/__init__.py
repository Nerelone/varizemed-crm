from flask import Blueprint

bp = Blueprint("spa", __name__)

from . import routes  # noqa: E402,F401
