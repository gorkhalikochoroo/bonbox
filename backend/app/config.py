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
    # Session lifetime — 30 days. Paired with the sliding-refresh
    # middleware in app/main.py (sliding_refresh_middleware): on every
    # authenticated request whose JWT is past its midway point (15d),
    # the middleware mints a fresh token + re-issues the cookie/bearer
    # so an actively-used session never expires. Matches Stripe / Linear
    # / Notion stay-signed-in UX. Was 60 * 24 (24h, no sliding refresh)
    # which kicked owners back to the login screen on second-day open.
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 30  # 30 days
    FRONTEND_URL: str = "http://localhost:5173"
    # Where a mail RECIPIENT's browser reaches this API (opt-out links, the
    # one-click List-Unsubscribe POST). Deliberately its own setting: the SPA
    # host serves its own shell at /api/*, so a link built on FRONTEND_URL is
    # dead. Empty → https://api.bonbox.dk in production, the local API in
    # development (services/revisor_mail.public_api_base).
    PUBLIC_API_URL: str = ""
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
    # Nightly off-project backup (services/backup_service). OFF unless the
    # first three are ALL set; some-but-not-all is reported as misconfigured.
    # BACKUP_SUPABASE_URL / _SERVICE_KEY belong to a SEPARATE Supabase project
    # ("bonbox-backup"), never the main one. BACKUP_ENCRYPTION_KEY is a Fernet
    # key (Fernet.generate_key()); everything is encrypted with it before
    # upload, so keep an offline copy — without it the backup cannot be read.
    # _PREVIOUS is only for reading older backups after a key rotation.
    BACKUP_SUPABASE_URL: str = ""
    BACKUP_SUPABASE_SERVICE_KEY: str = ""
    BACKUP_ENCRYPTION_KEY: str = ""
    BACKUP_ENCRYPTION_KEY_PREVIOUS: str = ""
    BACKUP_BUCKET: str = "bonbox-backup"
    ANTHROPIC_API_KEY: str = ""
    # Mindee Receipt API — primary OCR provider (2026-05). Free tier
    # gives 250 pages/month; Standard plan beyond that is ~$0.04/page.
    # When empty, the receipt OCR chain skips Mindee and falls through
    # to Claude Vision (secondary) → Google Vision + regex (last resort).
    MINDEE_API_KEY: str = ""
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
    # Operator ops alerts (R-i, services/ops_alert.py): one capped,
    # deduplicated, customer-data-free alert path. Sent only when
    # ENVIRONMENT == "production" and OPS_ALERTS_ENABLED. Recipients =
    # ADMIN_EMAIL + SUPER_ADMIN_EMAILS (no address lives in code).
    # Cooldown is per dedupe key (clamped 15–10080 min); the daily cap
    # counts messages per UTC day (clamped 1–50).
    OPS_ALERTS_ENABLED: bool = True
    OPS_ALERT_DAILY_CAP: int = 10
    OPS_ALERT_COOLDOWN_MINUTES: int = 360
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
    # ── AI model tiers ─────────────────────────────────────────────────
    # Three tiers, each with graceful fallback so a model outage or bad ID
    # can never break a flow — it degrades to the next tier down:
    #   1. ACCURACY_MODEL — money-critical number extraction ONLY
    #      (kasserapport till/close totals, receipt expense amounts,
    #      supplier-invoice amounts) where a misread digit = wrong money.
    #      Falls back to DEFAULT_MODEL on any error.
    #   2. PREMIUM_MODEL — the two user-facing AI surfaces (the BonBox AI
    #      chat assistant + the daily brief). Falls back to DEFAULT_MODEL.
    #   3. DEFAULT_MODEL — everything else (triage, anomaly, menu, sale
    #      parser, wine, inventory extract/categorize) AND the fallback
    #      target for the two tiers above.
    #
    # A wrong model ID has 404-broken AI before (task #239) — treat these as
    # load-bearing; never GUESS or substitute a variant/date suffix.
    #   • claude-opus-4-8 — accuracy tier. Probed live vs /v1/models AND
    #     /v1/messages (HTTP 200). STAYS on the money-critical OCR: Opus 4.8
    #     out-reasons Sonnet on hard kasserapport/receipt vision, and that
    #     feeds MOMS — accuracy > a cheaper tier.
    #   • claude-sonnet-5-5 — premium + default + fallback tier (Sonnet 5.5).
    #     Bumped from claude-sonnet-5 on 2026-10-12. The id comes from
    #     Anthropic's current model list (Sonnet 5.5 = claude-sonnet-5-5, bare
    #     id, no date suffix); it was NOT probed live from this machine (no
    #     key here) — confirm one live read after deploy.
    #   • claude-sonnet-5 — LEGACY_SAFE_MODEL: the last Sonnet known to work
    #     on this account. Used ONLY by the runtime net below.
    # RUNTIME NET (services/ai_model_guard.py): if Anthropic ever answers
    # model-not-found for DEFAULT_MODEL / PREMIUM_MODEL, that call is retried
    # ONCE on LEGACY_SAFE_MODEL — so photo/text reading keeps working — and
    # one error_logs row "AI:ModelNotFound" per model per day reaches the
    # 15-min ops triage digest. Sonnet 5.5 also refuses forced tool_choice;
    # the same guard sends those reads as tool_choice "auto" + a system line
    # naming the tool (the legacy retry keeps the forced call Sonnet 5 takes),
    # and sends every Sonnet 5.5 read with thinking off (between_tools) unless
    # the caller set thinking — so thinking never eats a read's max_tokens.
    # SAFETY NET: the BONBOX_*_MODEL env vars hot-swap any tier WITHOUT a
    # redeploy. To roll back for good, set BONBOX_DEFAULT_MODEL /
    # BONBOX_PREMIUM_MODEL = claude-sonnet-5 in Render (no code change).
    ACCURACY_MODEL: str = os.environ.get("BONBOX_ACCURACY_MODEL", "claude-opus-4-8")
    PREMIUM_MODEL: str = os.environ.get("BONBOX_PREMIUM_MODEL", "claude-sonnet-5-5")
    DEFAULT_MODEL: str = os.environ.get("BONBOX_DEFAULT_MODEL", "claude-sonnet-5-5")
    LEGACY_SAFE_MODEL: str = os.environ.get("BONBOX_SAFE_MODEL", "claude-sonnet-5")
    # ── Stripe subscription billing ──
    # Live keys go in Render env vars (sync: false). Test keys can go in .env
    # for local dev. The webhook secret is per-endpoint (Stripe gives a unique
    # signing secret to verify requests really came from Stripe).
    STRIPE_SECRET_KEY: str = ""
    STRIPE_PUBLISHABLE_KEY: str = ""
    # Primary webhook signing secret — for whichever Stripe mode the
    # production endpoint is hooked to (typically live).  Get from
    # Stripe Dashboard → Developers → Webhooks → endpoint → Signing
    # secret (whsec_...).
    STRIPE_WEBHOOK_SECRET: str = ""
    # Optional secondary signing secret — Task #117.  Stripe sends
    # webhook events from BOTH test and live modes; if you have one
    # endpoint registered in both modes (very common during launch),
    # each mode has a DIFFERENT signing secret.  Without supporting
    # both, every test-mode event fails signature verification +
    # eventually Stripe disables the endpoint.  Set this to the
    # test-mode whsec_ value (or vice versa).  Handler tries primary
    # first, then secondary — first one that verifies wins.
    STRIPE_WEBHOOK_SECRET_TEST: str = ""
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
    # Danish MOMS (25%) on OUR OWN SaaS invoice. Off by default because turning
    # Stripe Tax on in code without a DK tax registration in the Stripe dashboard
    # makes checkout ERROR. Once the registration exists (or the Prices are set
    # tax-inclusive), flip this env to "true" — no code change. A MOMS-certainty
    # product should show MOMS on its own invoice, but only when it's real.
    STRIPE_AUTOMATIC_TAX: bool = False
    # Ask for Terms acceptance on Stripe Checkout (consent_collection
    # terms_of_service=required). OFF by default: Stripe rejects the session
    # until a Terms URL (https://www.bonbox.dk/terms) is saved under Settings →
    # Public details in the Stripe dashboard. Set to 1/true after that.
    STRIPE_TOS_CONSENT: bool = False
    # Public, human-readable monthly price table in whole DKK (ex MOMS).
    # This is a DISPLAY mirror of the Stripe Price `unit_amount` on the four
    # STRIPE_PRICE_ID_* products above — it is NOT the charge authority. The
    # actual amount charged always comes from the Stripe Price at checkout
    # (stripe_billing.create_checkout_session retrieves unit_amount live and
    # builds the "first charge" submit message from it, so the message can
    # never disagree with the line item — BUG B fix). Surfaced read-only via
    # GET /api/billing/plans for the frontend / a self-check. Keep these in
    # lockstep with the Stripe dashboard prices (199/129 Starter, 349/249 Pro).
    PLAN_PRICES_DKK: dict = {
        "starter": {"regular": 199, "founding": 129},
        "pro": {"regular": 349, "founding": 249},
    }
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
    # v6 base URL.  v5 was retired and the v6 path layout is incompatible
    # (notably `POST /connect_sessions/create` → `POST /connections/connect`).
    # The same host serves sandbox + real-bank providers; no separate
    # sandbox subdomain.  Render must keep this on v6.
    SALTEDGE_BASE_URL: str = "https://www.saltedge.com/api/v6"

    # ── Yapily (DK + EU PSD2 AISP, startup-tier) — Task #219 ────────────
    # Self-serve signup at https://console.yapily.com.  66 institutions
    # support AIS in DK as of 2026-05-27 (Danske, Nordea DK, Jyske, Sydbank,
    # Spar Nord, Lunar, AL, Revolut, plus dozens of smaller DK banks).
    # Sandbox is free; production-tier ~€199-300/month entry.
    # Auth is HTTP Basic with application_id + application_secret.  Sandbox
    # vs production lives on the same host — the application scope on
    # Yapily's side decides which institution set is exposed.
    YAPILY_APPLICATION_ID: str = ""
    YAPILY_APPLICATION_SECRET: str = ""
    YAPILY_BASE_URL: str = "https://api.yapily.com"

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

    # ── Native APNs push for the BonBox Scheduler app (app/services/apns_sender.py) ──
    # MUST be declared here: BaseSettings has extra="ignore", so an env var
    # that isn't a declared field is silently dropped — an undeclared
    # APNS_AUTH_KEY would leave apns_configured() False forever even with
    # the Render vars set. All optional → unset means every send is a
    # logged no-op (same fail-soft doctrine as VAPID).
    APNS_AUTH_KEY: str = ""     # contents of the .p8 (literal \n accepted)
    APNS_KEY_ID: str = ""       # 10-char key id from developer.apple.com
    APNS_TEAM_ID: str = ""      # Apple Developer Team ID (QZ5VC474N8)
    APNS_TOPIC: str = ""        # bundle id; code defaults to dk.bonbox.scheduler
    APNS_USE_SANDBOX: str = ""  # "1" → sandbox host (Xcode dev builds only)

    # ── Receipt-forwarding email inbox (Postmark Inbound) — v0.1 ───────
    # The webhook is dark-launched: INBOX_ENABLED=false (default) makes
    # /api/inbox/postmark-webhook return 503 with an honesty body so
    # Postmark stops retrying. Flip to "true" once the Server's Inbound
    # endpoint is configured + DNS for `in.bonbox.dk` MX → Postmark is
    # live. Same sandbox-honesty pattern as MobilePay / Aiia.
    INBOX_ENABLED: bool = False

    # ── R-h privacy purges — every irreversible step ships OFF ─────────
    # OFF = the nightly job only counts what is due (dry run) and writes
    # nothing. GET /api/admin/privacy-purges shows the counts; Manoj turns a
    # flag on separately after reading them.
    # R-h LEG-05. OFF = nightly dry-run count only. Manoj turns it on after
    # GET /api/admin/privacy-purges shows the count.
    PRIVACY_PURGE_WAITLIST_ENABLED: bool = False
    # R-h LEG-18: whatsapp_messages > 90 d, magic-link tokens 30 d past
    # expiry, anonymous paid-plan waitlist e-mails > 12 months. Same
    # OFF = dry-run shape.
    PRIVACY_PURGE_ORPHANS_ENABLED: bool = False
    # R-h LEG-06 one-off. Turn on only after the R-j text names this one edit
    # in EVERY place that says the change log is never edited, EN and DA:
    #   1. /privacy "Change log" / "Ændringslog" paragraph,
    #   2. the /privacy retention-table row ("No end date: it cannot be edited
    #      or deleted through BonBox" / "Ingen slutdato: den kan ikke redigeres
    #      eller slettes gennem BonBox"),
    #   3. Terms § 4 ("neither by you nor by us" / "hverken af dig eller af os").
    # tests/test_audit_email_cleanup.py fails if the R-j paragraph lands in
    # /privacy while any of the other places still promises no edit.
    AUDIT_EMAIL_CLEANUP_ENABLED: bool = False
    # Postmark Basic-Auth secret. Configured on the Inbound Stream
    # under "Webhook URL" as `https://USER:PASS@api.bonbox.dk/api/inbox/
    # postmark-webhook`. Constant-time compared in the router so an
    # operator typo doesn't leak via timing. Both blank = 401 on every
    # hit (defense-in-depth — same effect as INBOX_ENABLED=false).
    POSTMARK_INBOUND_USER: str = ""
    POSTMARK_INBOUND_PASS: str = ""
    # The host portion of every alias. Owners forward receipts to
    # `<short>-<random>@<INBOX_DOMAIN>`. Keep this in env so a future
    # custom-domain feature (Pro tier v0.2+) can swap per-user without
    # touching code.
    INBOX_DOMAIN: str = "in.bonbox.dk"

    # ── Priority support routing (P10) ─────────────────────────────────
    # When a Pro user submits a /support/tickets request, we tag the row
    # with is_priority + prefix the subject [PRIORITY]. If these env vars
    # are set we ALSO route to:
    #   • PRIORITY_SUPPORT_EMAIL — a dedicated inbox CC'd on the founder
    #     notification, so the Pro queue is separable from the general
    #     /support firehose. Empty = no CC (fallback to current behavior).
    #   • PRIORITY_SUPPORT_SLACK_WEBHOOK — optional Slack incoming-webhook
    #     URL for the Pro-tickets channel. Empty = no Slack push. Posts
    #     are best-effort; a Slack outage never blocks ticket creation.
    # Both flags are operator-configurable so the marketing claim
    # ("Priority email support — Pro") becomes a real, opt-in routing
    # difference rather than just a subject prefix.
    PRIORITY_SUPPORT_EMAIL: str = ""
    PRIORITY_SUPPORT_SLACK_WEBHOOK: str = ""

    # ── Foresight engine (Sprint 1, #356) ──────────────────────────────
    # Kill-switch for the forward MOMS cash-flow foresight payload on
    # /cashflow/forecast. Default on; set FORESIGHT_ENABLED=false in the
    # Render dashboard to disable it instantly without a deploy. The legacy
    # cash-flow forecast is unaffected — foresight degrades to absent.
    # Not tier-gated: like the FREE MOMS countdown it upgrades (#42), the
    # foresight verdict is part of the core honest value, available to all.
    FORESIGHT_ENABLED: bool = True

    # ── Abuse caps (R-sec) ─────────────────────────────────────────────
    # Client address for rate limits (app/utils/client_ip.py). True: a
    # request without a valid CF-Connecting-IP / True-Client-IP (set by the
    # Cloudflare edge in front of api.bonbox.dk) shares ONE "no-edge" bucket,
    # and a client-sent X-Forwarded-For is never trusted as the address.
    # False is the kill switch: back to the old behaviour (leftmost XFF via
    # uvicorn), a Render env change and a restart, no deploy.
    CLIENT_IP_FAIL_CLOSED: bool = True
    # Ceilings that hold when an attacker rotates addresses. Every one is
    # read at call time; 0 (or less) switches that check off. Measured prod
    # peaks on 11 Oct 2026 are in the comments. Sized for Resend FREE (100
    # mails/day, 3,000/month; 11 Oct usage 4/day, 71/month): the magic-link
    # and guest-mail fleet ceilings together (20 + 40 = 60/day) leave room
    # for verification, reset, staff and alert mail. Raise them (Render env)
    # when Resend is upgraded, e.g. 60/300/30/100 and 2000.
    # Sign-in link mails to addresses WITHOUT a confirmed account (confirmed
    # accounts always get theirs; routers/auth_magic_link.py,
    # services/abuse_caps.py).
    MAGIC_LINK_FLEET_MAX_PER_HOUR: int = 10     # peak 1
    MAGIC_LINK_FLEET_MAX_PER_DAY: int = 20      # peak 2
    MAGIC_LINK_DOMAIN_MAX_PER_HOUR: int = 5     # peak 1
    MAGIC_LINK_DOMAIN_MAX_PER_DAY: int = 10     # peak 1
    # Every POST /auth/magic-link/request answer waits until this many ms
    # after the request arrived (the mail goes out after the answer). While a
    # ceiling holds unknown addresses back, the answer time then does not tell
    # a confirmed account from an unknown one. 0 = off.
    MAGIC_LINK_MIN_RESPONSE_MS: int = 300
    # Guest e-mails delivered across ALL venues in a rolling 24 h
    # (services/reservation_emails.py deliver()). Peak ~3/day. Raised from 40
    # (24 Oct 2026, booking fix round 2): with the magic-link ceiling (20) it
    # still leaves 20 of Resend Free's 100 a day for verification, reset,
    # staff and alert mail. Raise both when Resend is upgraded.
    GUEST_EMAILS_FLEET_PER_DAY: int = 60
    # One venue's share of that ceiling for the mails its ONLINE bookings
    # start (the confirmation, or "request received"): at most this percent
    # of GUEST_EMAILS_FLEET_PER_DAY in a rolling 24 h (60 → 9). A slow drip
    # at one or two venues can then no longer use up every venue's guest
    # mail for the day (recheck, 24 Oct: two venues drained the 40). The
    # page never promises a mail the share holds back, and the operator is
    # alerted (abuse monitor, abuse_guest_mail). 0 = off.
    BOOKING_VENUE_MAIL_SHARE_PCT: int = 15
    # Anonymous online bookings (services/booking_screen.py). Over a ceiling a
    # booking is HELD as a request the owner approves — a real guest is never
    # refused, a bot's flood holds no table. The venue ceilings count only the
    # online bookings that PASSED the screen, so held bots never push real
    # guests into "held" (R1 fix round, 24 Oct 2026). Fix round 2 (same day):
    # the ceilings are for BURSTS and PATTERNS only — measured on simulated
    # busy weeks at 4, 6 and 10 tables, no real guest is held.
    BOOKING_MIN_FILL_MS: int = 2000             # faster form fill → held
    BOOKING_GROUP_REQUESTS_PER_DAY: int = 10    # real group requests a day; over it → held, never refused
    BOOKING_GROUP_FLOOR: int = 6                # a "real group" is at least max(threshold, this)
    BOOKING_CONTACT_ACTIVE_MAX: int = 3         # active future bookings per guest
    BOOKING_VENUE_HOUR_MIN: int = 6             # an hour: max(6, tables/chairs) online bookings
    BOOKING_SITTING_MIN: int = 3                # one sitting: max(3, half the tables) …
    BOOKING_SITTING_WINDOW_MIN: int = 180       # … made in the last 3 hours (a burst)
    BOOKING_DATE_MIN: int = 6                   # one date: max(6, 1.5 × tables or 4 × chairs) …
    BOOKING_DATE_PER_TABLE: float = 1.5         # … made in the last 24 hours
    BOOKING_DATE_PER_CHAIR: int = 4
    # Mail to a HELD booking's typed address that looks like a person's (not
    # a bot's form): the "request received" mail, and the decline or expiry
    # mail when it never got that one — at most this many per venue an hour
    # and a day, all of them together. A bot-like hold (trap, fast fill, a
    # link in the name) gets none; the guest page says so when no mail is
    # coming (fix round 2, 24 Oct 2026).
    BOOKING_HELD_GUEST_MAILS_PER_HOUR: int = 3
    BOOKING_HELD_GUEST_MAILS_PER_DAY: int = 10
    # Pings to the OWNER about online bookings and cancellations
    # (services/owner_booking_alerts.py): this many an hour, then one summary
    # an hour; the day ceiling stops only the single pings, never the summary.
    OWNER_BOOKING_PINGS_PER_HOUR: int = 3
    OWNER_BOOKING_PINGS_PER_DAY: int = 20
    # Quiet hours (venue time, Europe/Copenhagen) for a summary that would
    # only be about HELD bookings: it waits for the morning. A bot-like hold
    # never starts a summary at all — the next summary, or the morning one,
    # counts it (fix round 2). Real bookings and cancellations are unchanged.
    OWNER_SUMMARY_QUIET_FROM_HOUR: int = 22
    OWNER_SUMMARY_QUIET_TO_HOUR: int = 7
    # Wrong staff join / stand pairing codes from all addresses together:
    # JOIN_FAIL_GLOBAL_MAX within JOIN_FAIL_WINDOW_SEC pauses that door for
    # everyone for JOIN_COOLOFF_SEC (main.join_failure_brake).
    JOIN_FAIL_GLOBAL_MAX: int = 300
    JOIN_FAIL_WINDOW_SEC: int = 600
    JOIN_COOLOFF_SEC: int = 60                  # matches the "vent et minut" copy
    # Alert only (jobs/abuse_monitor_job.py): new accounts per hour / 24 h.
    SIGNUP_ALERT_PER_HOUR: int = 20             # peak 3
    SIGNUP_ALERT_PER_DAY: int = 60              # peak 9
    # Alert when this many non-health requests in one 2-minute monitor tick
    # arrive without a valid edge header (expected 0).
    NO_EDGE_ALERT_PER_TICK: int = 20


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
if settings.ENVIRONMENT == "production" and not os.environ.get("SECRET_KEY"):
    # The previous check compared SECRET_KEY to a function docstring and
    # could never be true, so a prod deploy that forgot to set SECRET_KEY
    # ran on a per-process random key with NO warning (tokens invalidate
    # on every restart). Check the env var directly instead.
    import warnings
    warnings.warn("SECRET_KEY not set! Using random key — tokens will invalidate on restart.")
