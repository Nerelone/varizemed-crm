from .auth import bp as auth_bp
from .user import bp as user_bp
from .admin import bp as admin_bp
from .spa import bp as spa_bp

__all__ = ["auth_bp", "user_bp", "admin_bp", "spa_bp"]
