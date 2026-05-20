import os
import secrets

from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_secret() -> str:
    """Generate a random secret if none is provided via env."""
    return secrets.token_urlsafe(64)


_ENV_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


class Settings(BaseSettings):
    # Pydantic v2 / pydantic-settings v2: replaces the deprecated
    # nested `class Config:` style. Same behaviour: load values from
    # the project-root .env file when one exists. Other env-var
    # discovery still happens via the OS environment.
    model_config = SettingsConfigDict(env_file=_ENV_FILE, extra="ignore")

    DATABASE_URL: str = "postgresql://postgres:postgres@localhost:5432/smallbiz"
    SECRET_KEY: str = _default_secret()
    # Optional. When rotating SECRET_KEY, set the OLD key here for a grace
    # period — tokens signed with the previous key will still verify, but
    # newly issued tokens use SECRET_KEY. Once all tokens have expired (24h
    # default), unset SECRET_KEY_PREVIOUS.
    SECRET_KEY_PREVIOUS: str = ""
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24  # 24 hours
    FRONTEND_URL: str = "http://localhost:5173"
    GOOGLE_VISION_API_KEY: str = ""
    SUPABASE_URL: str = ""
    SUPABASE_ANON_KEY: str = ""
    # Service-role key (sb_secret_…) for backend → Supabase Storage writes.
    # Required for persisting receipt images to the `receipts` bucket. If
    # empty, the storage abstraction falls back to local-disk (dev mode).
    # Never expose to frontend — server-side ONLY.
    SUPABASE_SERVICE_KEY: str = ""
    # Bucket names. Must already exist in Supabase project as PRIVATE
    # buckets (RLS off; access mediated entirely by our backend's auth).
    SUPABASE_RECEIPTS_BUCKET: str = "receipts"
    ANTHROPIC_API_KEY: str = ""
    COMPANIES_HOUSE_API_KEY: str = ""
    GOOGLE_CLIENT_ID: str = ""  # Google OAuth client ID
    # Sign in with Apple — list of accepted audience values. iOS app
    # uses the bundle ID (`dk.bonbox.app`); web SIWA uses the Service
    # ID. Comma-separated to support both. The token's `aud` claim must
    # match one of these or verification fails.
    APPLE_ALLOWED_AUDIENCES: str = "dk.bonbox.app"
    # Task #65 — Apple Service ID / bundle ID used by the new unified
    # /auth/oauth/apple endpoint. When empty we fall back to the first
    # entry in APPLE_ALLOWED_AUDIENCES (back-compat with the original
    # /auth/apple plumbing). APPLE_TEAM_ID is the 10-char Team ID from
    # the Apple Developer portal — currently unused at verify-time but
    # tracked here for future client-secret JWT generation (refresh
    # tokens, server-to-server validation).
    APPLE_CLIENT_ID: str = ""
    APPLE_TEAM_ID: str = ""
    GOOGLE_PLACES_API_KEY: str = ""  # Google Places API (nearby competitor discovery)
    ADMIN_EMAIL: str = ""  # Get notified on new signups
    # SUPER_ADMIN_EMAILS — comma-separated allowlist of emails that may access /admin/*.
    # MUST also have users.role='super_admin' set in the database (defense in depth).
    # There is intentionally NO API path to grant this role.
    SUPER_ADMIN_EMAILS: str = ""
    # Brute-force lockout for admin endpoint
    ADMIN_LOCKOUT_THRESHOLD: int = 5
    ADMIN_LOCKOUT_WINDOW_MIN: int = 10
    ADMIN_LOCKOUT_COOLDOWN_MIN: int = 15
    USE_CLAUDE_API: bool = False  # Enable full Claude AI mode (requires ANTHROPIC_API_KEY)
    ENVIRONMENT: str = "development"  # "production" in deployed env
    # ── Stripe subscription billing ──
    # Live keys go in Render env vars (sync: false). Test keys can go in .env
    # for local dev. The webhook secret is per-endpoint (Stripe gives a unique
    # signing secret to verify requests really came from Stripe).
    STRIPE_SECRET_KEY: str = ""
    STRIPE_PUBLISHABLE_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""
    # ── Subscription price IDs ────────────────────────────────────────
    # Tier structure (May 2026): Free → Starter (199/founding 129) →
    # Pro (349/founding 249). Existing customers locked in at older
    # prices keep their rate — Stripe never retroactively reprices an
    # active subscription, that's the founding-rate guarantee.
    STRIPE_PRICE_ID_STARTER: str = ""           # 199 kr/mo regular
    STRIPE_PRICE_ID_STARTER_FOUNDING: str = ""  # 129 kr/mo founding
    STRIPE_PRICE_ID_PRO: str = ""               # 349 kr/mo regular
    STRIPE_PRICE_ID_PRO_FOUNDING: str = ""      # 249 kr/mo founding
    FOUNDING_MEMBER_LIMIT: int = 100            # First N (active+trialing) lock founding rate
    # Legacy — Business tier was dropped May 2026 but env var kept for
    # webhook back-compat (existing Business customers, if any, still
    # have their subscription routed correctly).
    STRIPE_PRICE_ID_BUSINESS: str = ""
    # URL Stripe sends user back to after checkout. We use the frontend URL.
    STRIPE_SUCCESS_URL: str = ""  # default = FRONTEND_URL + /subscription?success=1
    STRIPE_CANCEL_URL: str = ""   # default = FRONTEND_URL + /subscription?canceled=1
    # ── MobilePay Erhverv (Vipps MobilePay Business) — Task #71 ──────
    # v0.1 ships against the mock client by default. Set MOBILEPAY_ENV
    # to 'sandbox' or 'live' to switch on real HTTP calls (sandbox/live
    # currently raise 501 until v0.2 wires the actual REST shapes).
    # Production credentials require a signed partner agreement with
    # MobilePay — the API itself is locked behind sales approval.
    MOBILEPAY_ENV: str = "mock"          # 'mock' | 'sandbox' | 'live'
    MOBILEPAY_BASE_URL: str = ""         # e.g. https://api.sandbox.vippsmobilepay.com
    MOBILEPAY_CLIENT_ID: str = ""        # OAuth client_id from MobilePay portal
    MOBILEPAY_CLIENT_SECRET: str = ""    # OAuth client_secret (server-side ONLY)

    # ── Founder rate cap — Task #85 ─────────────────────────────────────
    # First N paying customers get the locked founder pricing
    # (Starter 129/199 DKK, Pro 249/349 DKK).  Once the count exceeds
    # FOUNDER_MAX_SLOTS, new signups see standard pricing.  The
    # current count is public via /api/public/founder-rate-status so
    # the landing page can show a live "X of 100 founder seats taken"
    # urgency pill.
    FOUNDER_MAX_SLOTS: int = 100

    # ── Aiia (Mastercard Open Banking) redirect URI — Task #83 ──────────
    # The redirect_uri Aiia bounces the owner back to after SCA.  Must
    # exactly match what's registered in the Aiia portal AND must be a
    # URL routable to the API process (e.g. https://api.bonbox.dk).
    # When unset we fall back to FRONTEND_URL + /api/bank-connect/callback
    # which is fine for `localhost:5173` dev but wrong in prod where the
    # API lives at api.bonbox.dk while the SPA is at app.bonbox.dk.
    AIIA_REDIRECT_URI: str = ""

    # ── GoCardless Bank Account Data — Task #104 ────────────────────────
    # Free-tier real PSD2 access (formerly Nordigen). Sign up at
    # https://bankaccountdata.gocardless.com/ to get secret_id + secret_key.
    # Set BANK_PROVIDER=gocardless to route the bank-connect flow through
    # GoCardless instead of the in-process mock.  Covers Danske, Nordea,
    # Jyske, Lunar, Revolut + 2400 other EU banks with real MitID/SCA.
    BANK_PROVIDER: str = ""  # "" → fall back to AIIA_ENV; "gocardless" → real
    GOCARDLESS_SECRET_ID: str = ""
    GOCARDLESS_SECRET_KEY: str = ""
    # Base URL — production is correct for both sandbox + real banks.
    # GoCardless doesn't have a separate sandbox host; sandbox lives on
    # the SANDBOXFINANCE_SFIN0000 institution_id.
    GOCARDLESS_BASE_URL: str = "https://bankaccountdata.gocardless.com/api/v2"

    # ── Salt Edge (alternate AISP, free Customer tier) ─────────────────
    # Self-serve signup at https://www.saltedge.com/dashboard.  Cover EU+UK
    # incl. DK (Danske, Nordea, Jyske, Lunar).  Set BANK_PROVIDER=saltedge
    # to route through here.  Auth is App-id + Secret in HTTP headers
    # (no token endpoint; their RSA-signed mode is optional and we don't
    # use it for the free Customer plan).
    SALTEDGE_APP_ID: str = ""
    SALTEDGE_SECRET: str = ""
    SALTEDGE_BASE_URL: str = "https://www.saltedge.com/api/v5"

    # ── Web Push (VAPID) — Task #72 ─────────────────────────────────────
    # VAPID identifies BonBox to the push providers (FCM / Apple Push /
    # Mozilla autopush). Without these the /api/push endpoints 503 and
    # the morning push cron silently no-ops — the app still boots and
    # the email + in-app brief still ship.
    #
    # Generate ONCE in prod (private key never rotates lightly — every
    # device subscribed with the old key has to re-subscribe on
    # rotation):
    #     from py_vapid import Vapid01
    #     v = Vapid01(); v.generate_keys()
    #     # public key, raw uncompressed-point base64url:
    #     from cryptography.hazmat.primitives import serialization
    #     import base64
    #     pub = v.public_key.public_bytes(
    #         encoding=serialization.Encoding.X962,
    #         format=serialization.PublicFormat.UncompressedPoint,
    #     )
    #     print(base64.urlsafe_b64encode(pub).decode().rstrip('='))
    #     # private key, PEM (single line, escape newlines in env var):
    #     print(v.private_pem().decode())
    VAPID_PUBLIC_KEY: str = ""
    VAPID_PRIVATE_KEY: str = ""
    # Per RFC 8292 the VAPID `sub` claim MUST be a mailto: or https:// URI
    # — push providers reject anything else. Defaults to the public hello@
    # inbox so we never silently mint claims with the wrong shape.
    VAPID_SUBJECT: str = "mailto:hello@bonbox.dk"


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
