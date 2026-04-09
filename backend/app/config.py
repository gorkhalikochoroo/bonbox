import os
import secrets

from pydantic_settings import BaseSettings


def _default_secret() -> str:
    """Generate a random secret if none is provided via env."""
    return secrets.token_urlsafe(64)


_ENV_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql://postgres:postgres@localhost:5432/smallbiz"
    SECRET_KEY: str = _default_secret()
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24  # 24 hours
    FRONTEND_URL: str = "http://localhost:5173"
    GOOGLE_VISION_API_KEY: str = ""
    SUPABASE_URL: str = ""
    SUPABASE_ANON_KEY: str = ""
    ANTHROPIC_API_KEY: str = ""
    COMPANIES_HOUSE_API_KEY: str = ""
    GOOGLE_CLIENT_ID: str = ""  # Google OAuth client ID
    ADMIN_EMAIL: str = ""  # Get notified on new signups
    USE_CLAUDE_API: bool = False  # Enable full Claude AI mode (requires ANTHROPIC_API_KEY)
    ENVIRONMENT: str = "development"  # "production" in deployed env

    class Config:
        env_file = _ENV_FILE


settings = Settings()

# Fix: Claude Code sets ANTHROPIC_API_KEY="" in shell env, which overrides .env.
# Read the real values from .env and override both settings AND os.environ.
try:
    from dotenv import dotenv_values
    _env_vals = dotenv_values(_ENV_FILE) if os.path.exists(_ENV_FILE) else {}
    if _env_vals.get("ANTHROPIC_API_KEY") and not settings.ANTHROPIC_API_KEY:
        settings.ANTHROPIC_API_KEY = _env_vals["ANTHROPIC_API_KEY"]
    if _env_vals.get("USE_CLAUDE_API") and not settings.USE_CLAUDE_API:
        settings.USE_CLAUDE_API = _env_vals["USE_CLAUDE_API"].lower() == "true"
except Exception:
    pass  # No .env file (e.g. Render) — env vars come from dashboard

# Also set os.environ so the anthropic SDK picks it up (it reads env vars internally)
if settings.ANTHROPIC_API_KEY:
    os.environ["ANTHROPIC_API_KEY"] = settings.ANTHROPIC_API_KEY

print(f"[Config] ANTHROPIC_API_KEY={'set' if settings.ANTHROPIC_API_KEY else 'empty'} | USE_CLAUDE={settings.USE_CLAUDE_API}")

# Warn if running with auto-generated secret in production
if settings.ENVIRONMENT == "production" and settings.SECRET_KEY == _default_secret.__doc__:
    import warnings
    warnings.warn("SECRET_KEY not set! Using random key — tokens will invalidate on restart.")
