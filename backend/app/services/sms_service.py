"""SMS sending — provider-abstracted, DK-first (GatewayAPI).

Used by the reservation reminder cron (the v1 no-show defense). Built to
degrade gracefully: with no provider token configured, `sms_configured()`
is False and callers fall back to email — so this is safe to ship before
the GatewayAPI account is provisioned, and lights up the moment the token
lands in Render.

Provider choice via SMS_PROVIDER env (default 'gatewayapi'). GatewayAPI is
the Danish gateway — alphanumeric sender IDs (e.g. "BonBox"), strong DK
deliverability, simple REST. Twilio can slot in behind the same
`send_sms()` facade later without touching callers.

Env:
  SMS_PROVIDER         'gatewayapi' (default)
  GATEWAYAPI_TOKEN     API token (HTTP Basic username, empty password)
  GATEWAYAPI_BASE      override base URL (default https://gatewayapi.com)
  SMS_DEFAULT_SENDER   fallback alphanumeric sender (default 'BonBox')
"""
import logging
import os
import re

import requests

logger = logging.getLogger(__name__)

SMS_PROVIDER = os.getenv("SMS_PROVIDER", "gatewayapi").strip().lower()
GATEWAYAPI_TOKEN = os.getenv("GATEWAYAPI_TOKEN", "")
GATEWAYAPI_BASE = os.getenv("GATEWAYAPI_BASE", "https://gatewayapi.com").rstrip("/")
SMS_DEFAULT_SENDER = os.getenv("SMS_DEFAULT_SENDER", "BonBox")

# Default country code for bare local numbers. DK mobile numbers are 8
# digits; a guest who types "12 34 56 78" means +45 12345678.
_DEFAULT_CC = os.getenv("SMS_DEFAULT_CC", "45")


def sms_configured() -> bool:
    """True iff the active provider has the credentials it needs. Callers
    check this and fall back to email when False."""
    if SMS_PROVIDER == "gatewayapi":
        return bool(GATEWAYAPI_TOKEN)
    return False


def _normalize_msisdn(phone: str | None) -> str | None:
    """Best-effort E.164-ish digits (country code + number, no '+').
    Bare 8-digit DK numbers get the +45 prefix. Returns None if it can't
    make something plausible."""
    digits = re.sub(r"\D", "", phone or "")
    if not digits:
        return None
    if digits.startswith("00"):
        digits = digits[2:]  # 0045... → 45...
    if len(digits) == 8:  # bare DK local
        digits = _DEFAULT_CC + digits
    # Plausible international length.
    if not (8 <= len(digits) <= 15):
        return None
    return digits


def _clean_sender(sender: str | None) -> str:
    """Alphanumeric sender IDs are capped at 11 chars by GSM. Strip to
    a safe alnum/space subset; fall back to the default."""
    raw = (sender or SMS_DEFAULT_SENDER or "BonBox").strip()
    cleaned = re.sub(r"[^A-Za-z0-9 ]", "", raw)[:11].strip()
    return cleaned or "BonBox"


def send_sms(*, to: str, text: str, sender: str | None = None) -> dict:
    """Send one SMS. Best-effort — never raises. Returns
    {"ok": bool, "error": str | None}."""
    if not sms_configured():
        return {"ok": False, "error": "not_configured"}
    msisdn = _normalize_msisdn(to)
    if not msisdn:
        return {"ok": False, "error": "bad_number"}
    sender = _clean_sender(sender)
    try:
        if SMS_PROVIDER == "gatewayapi":
            return _send_gatewayapi(msisdn, text, sender)
        return {"ok": False, "error": "unknown_provider"}
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning("sms send threw: %s", exc)
        return {"ok": False, "error": "exception"}


def _send_gatewayapi(msisdn: str, text: str, sender: str) -> dict:
    """POST /rest/mtsms — token as HTTP Basic username, empty password."""
    resp = requests.post(
        f"{GATEWAYAPI_BASE}/rest/mtsms",
        auth=(GATEWAYAPI_TOKEN, ""),
        json={
            "sender": sender,
            "message": text,
            "recipients": [{"msisdn": int(msisdn)}],
        },
        timeout=15,
    )
    if resp.status_code in (200, 201):
        return {"ok": True, "error": None}
    logger.warning("gatewayapi non-2xx: %s %s", resp.status_code, resp.text[:200])
    return {"ok": False, "error": f"http_{resp.status_code}"}
