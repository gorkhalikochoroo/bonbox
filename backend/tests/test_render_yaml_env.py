"""render.yaml lists the production keys by name, and never generates or
holds a secret (INFRA-07, R-i).

`SECRET_KEY: generateValue: true` meant a Blueprint rebuild would mint a new
JWT key and sign everyone out; most production keys were not listed at all,
so a rebuilt service would silently miss them. Parsed line by line (no YAML
dependency): every `- key:` entry and the attributes under it.
"""
from __future__ import annotations

import os
import re

_RENDER_YAML = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "render.yaml")

SECRETS = ["APP_SECRET_KEY", "APP_SECRET_KEY_PREVIOUS", "SECRET_KEY_PREVIOUS",
           "GAVEKORT_SIGNING_KEY", "TICKET_SIGNING_KEY", "BOOKING_TOKEN_KEY",
           "BONBOX_CRON_SECRET", "SECRET_KEY", "DATABASE_URL", "ORIGIN_SHARED_SECRET",
           "ANTHROPIC_API_KEY"]
STORAGE = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "SUPABASE_RECEIPTS_BUCKET", "SUPABASE_ANON_KEY"]
MAIL_OPS = ["RESEND_API_KEY", "RESEND_FROM_EMAIL", "SUPPORT_NOTIFY_EMAIL", "SUPPORT_REPLY_TO",
            "SENTRY_DSN", "OPS_ALERTS_ENABLED", "OPS_ALERT_DAILY_CAP", "OPS_ALERT_COOLDOWN_MINUTES"]
STRIPE = ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET",
          "STRIPE_WEBHOOK_SECRET_TEST", "STRIPE_PRICE_ID_PRO", "STRIPE_PRICE_ID_STARTER",
          "STRIPE_PRICE_ID_STARTER_FOUNDING", "STRIPE_PRICE_ID_PRO_FOUNDING",
          "STRIPE_TOS_CONSENT", "STRIPE_AUTOMATIC_TAX"]
PUSH = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "APNS_AUTH_KEY",
        "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_TOPIC", "APNS_USE_SANDBOX"]
APPLE = ["APPLE_CLIENT_ID", "APPLE_TEAM_ID"]
URLS = ["PUBLIC_API_URL", "PUBLIC_APP_URL", "FRONTEND_URL"]
SMS = ["SMS_PROVIDER", "GATEWAYAPI_TOKEN", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN",
       "TWILIO_WHATSAPP_NUMBER"]
OCR = ["MINDEE_API_KEY", "GOOGLE_VISION_API_KEY", "OCRSPACE_API_KEY"]
INBOX = ["POSTMARK_INBOUND_USER", "POSTMARK_INBOUND_PASS", "INBOX_ENABLED"]
FLAGS = ["PORTAL_PIN_ENFORCE", "DEBUG_BILLING_ENABLED", "ENABLE_BANK_CONNECT", "BANK_PROVIDER"]
BANK = ["GOCARDLESS_SECRET_ID", "GOCARDLESS_SECRET_KEY", "AIIA_CLIENT_ID", "AIIA_CLIENT_SECRET",
        "AIIA_ENV", "SALTEDGE_APP_ID", "SALTEDGE_SECRET", "YAPILY_APPLICATION_ID",
        "YAPILY_APPLICATION_SECRET", "MOBILEPAY_CLIENT_ID", "MOBILEPAY_CLIENT_SECRET",
        "MOBILEPAY_ENV", "WHATSAPP_ENABLED"]
OWNER = ["ADMIN_EMAIL", "SUPER_ADMIN_EMAILS"]

REQUIRED = SECRETS + STORAGE + MAIL_OPS + STRIPE + PUSH + APPLE + URLS + SMS + OCR + INBOX + FLAGS + BANK + OWNER
SECRET_GROUPS = SECRETS + STORAGE + MAIL_OPS + STRIPE + PUSH + SMS + OCR + INBOX + BANK + OWNER

# Not secrets, must survive a rebuild — the only keys allowed a value.
VALUE_ALLOWED = {"ENVIRONMENT": "production", "USE_CLAUDE_API": "true"}
# Never listed: injected by Render, local-only, or code-default tunables.
NEVER_LISTED = ["RENDER_GIT_COMMIT", "GIT_COMMIT", "LOCAL_UPLOADS_ROOT", "HEALTHCHECK_BASE"]


def _env_entries() -> dict[str, dict[str, str]]:
    entries: dict[str, dict[str, str]] = {}
    current = None
    for raw in open(_RENDER_YAML, encoding="utf-8"):
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        m = re.match(r"^\s*-\s+key:\s*(\S+)\s*$", line)
        if m:
            current = m.group(1)
            assert current not in entries, f"duplicate key {current}"
            entries[current] = {}
            continue
        m = re.match(r"^\s+(sync|value|generateValue|fromService|fromDatabase|fromGroup):\s*(.*)$", line)
        if m and current:
            entries[current][m.group(1)] = m.group(2).strip().strip('"')
            continue
        if re.match(r"^\s{0,4}\S", line):          # left the envVars list
            current = None
    return entries


def test_secret_key_is_never_generated():
    e = _env_entries()
    assert e["SECRET_KEY"] == {"sync": "false"}
    assert all("generateValue" not in attrs for attrs in e.values())


def test_every_required_name_is_listed():
    e = _env_entries()
    missing = [k for k in REQUIRED if k not in e]
    assert missing == []


def test_no_secret_carries_a_value():
    e = _env_entries()
    for k in SECRET_GROUPS:
        assert "value" not in e[k], k
        assert e[k].get("sync") == "false", k


def test_only_non_secrets_carry_a_value():
    e = _env_entries()
    with_value = {k: a["value"] for k, a in e.items() if "value" in a}
    assert with_value == VALUE_ALLOWED


def test_injected_and_local_names_are_not_listed():
    e = _env_entries()
    for k in NEVER_LISTED:
        assert k not in e, k
