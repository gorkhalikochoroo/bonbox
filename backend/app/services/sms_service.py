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
import unicodedata

import requests

logger = logging.getLogger(__name__)

SMS_PROVIDER = os.getenv("SMS_PROVIDER", "gatewayapi").strip().lower()
GATEWAYAPI_TOKEN = os.getenv("GATEWAYAPI_TOKEN", "")
GATEWAYAPI_BASE = os.getenv("GATEWAYAPI_BASE", "https://gatewayapi.com").rstrip("/")
SMS_DEFAULT_SENDER = os.getenv("SMS_DEFAULT_SENDER", "BonBox")

# Default country code for bare local numbers when the venue's country is
# unknown (legacy). DK mobile numbers are 8 digits; a guest who types
# "12 34 56 78" at a Danish venue means +45 12345678. A venue whose country
# is known uses its own code (see _NATIONAL below).
_DEFAULT_CC = os.getenv("SMS_DEFAULT_CC", "45")


def sms_configured() -> bool:
    """True iff the active provider has the credentials it needs. Callers
    check this and fall back to email when False."""
    if SMS_PROVIDER == "gatewayapi":
        return bool(GATEWAYAPI_TOKEN)
    return False


# National numbering per venue country: (country code, national length,
# the shape a textable national number has). Denmark: any 8 digits
# ("20 55 66 77"). Portugal: 9 digits, and a mobile starts with 9 ("912 345
# 678") — a bare "612 345 678" at a Portuguese venue is a Spanish mobile typed
# without +34, and 351 in front of it is a stranger's (premium) line. Neither
# country has a trunk "0", so a bare national number is exactly that long.
_NATIONAL = {
    "DK": ("45", 8, re.compile(r"\d{8}")),
    "PT": ("351", 9, re.compile(r"9\d{8}")),
}

# ITU-T E.164 country codes in service (World Zones 1 and 7 are one digit).
# A bare number that starts with one of these at an international length is a
# foreign number typed WITH its code but without "+" ("46 70 123 45 67") —
# sent as typed, as Danish venues always have. Anything else (a trunk "0", an
# unassigned prefix) is not a number anyone can read.
_CC_1 = frozenset("1 7".split())
_CC_2 = frozenset((
    "20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 "
    "57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98"
).split())
_CC_3 = frozenset((
    "211 212 213 216 218 220 221 222 223 224 225 226 227 228 229 "
    "230 231 232 233 234 235 236 237 238 239 240 241 242 243 244 245 246 247 "
    "248 249 250 251 252 253 254 255 256 257 258 260 261 262 263 264 265 266 "
    "267 268 269 290 291 297 298 299 350 351 352 353 354 355 356 357 358 359 "
    "370 371 372 373 374 375 376 377 378 379 380 381 382 383 385 386 387 389 "
    "420 421 423 500 501 502 503 504 505 506 507 508 509 590 591 592 593 594 "
    "595 596 597 598 599 670 672 673 674 675 676 677 678 679 680 681 682 683 "
    "685 686 687 688 689 690 691 692 850 852 853 855 856 880 886 "
    "960 961 962 963 964 965 966 967 968 970 971 972 973 974 975 976 977 "
    "992 993 994 995 996 998"
).split())


def _has_country_code(digits: str) -> bool:
    return digits[:1] in _CC_1 or digits[:2] in _CC_2 or digits[:3] in _CC_3


def _national_plan(country: str | None):
    """(country code, national length, national shape) for a venue country.
    An unknown country keeps the legacy default: SMS_DEFAULT_CC with
    Denmark's 8 digits."""
    plan = _NATIONAL.get((country or "").strip().upper())
    if plan is not None:
        return plan
    return (_DEFAULT_CC, 8, _NATIONAL["DK"][2])


def _normalize_msisdn(phone: str | None, country: str | None = None) -> str | None:
    """Best-effort E.164-ish digits (country code + number, no '+') for the
    venue's guests, or None when the number cannot be read safely.

    • The venue's own national number — 8 digits in Denmark, a 9-digit "9…"
      mobile in Portugal — gets the venue's code, with or without a stray
      "+"/"00" in front ("+20 55 66 77" in Denmark, "+912 345 678" in
      Portugal: no foreign number has that shape, so "+" there is a slip).
    • Another known country's national number without its code — 9 bare
      digits at a Danish venue, 8 at a Portuguese one, or that shape behind a
      stray "+" — is None: a guess would text a stranger.
    • A number that starts with 45 or 351 must be that country's full length.
    • "+…" or "00…" otherwise keeps the guest's own country code (8–15
      digits), whatever the venue's country.
    • A bare number that starts with an ITU country code at an international
      length is a foreign number typed without "+" — kept, as before.
    • Anything else is None — never a guess. The callers fall back to "call
      the guest" / email instead.

    `country` is the VENUE's ("DK" | "PT" | None, owner_language.venue_country).
    None keeps the legacy Danish-first default (SMS_DEFAULT_CC, 8 digits)."""
    raw = unicodedata.normalize("NFKC", phone or "").strip()
    if not raw:
        return None
    explicit = raw.lstrip(" (").startswith("+")
    digits = re.sub(r"[^0-9]", "", raw)
    if not digits:
        return None
    if digits.startswith("00"):
        digits = digits[2:]  # 0045… → 45…, 00351… → 351…
        explicit = True
    cc, national_len, national_shape = _national_plan(country)
    if len(digits) == national_len:
        if national_shape.fullmatch(digits):
            return cc + digits
        if not explicit:
            return None  # the venue's length, not its shape ("612 345 678" in PT)
    for other_cc, other_len, other_shape in _NATIONAL.values():
        if other_cc == cc or len(digits) != other_len:
            continue
        # Bare: any number of that length. Behind "+": only that country's
        # own shape ("+912 345 678" at a Danish venue) — a "+298 123456" from
        # the Faroe Islands is a real 9-digit number with its code.
        if not explicit or other_shape.fullmatch(digits):
            return None
    for known_cc, known_len, _shape in _NATIONAL.values():
        if digits.startswith(known_cc):
            return digits if len(digits) == len(known_cc) + known_len else None
    if not 8 <= len(digits) <= 15:
        return None
    if explicit or _has_country_code(digits):
        return digits
    return None


def _clean_sender(sender: str | None) -> str:
    """Alphanumeric sender IDs are capped at 11 chars by GSM. Strip to
    a safe alnum/space subset; fall back to the default."""
    raw = (sender or SMS_DEFAULT_SENDER or "BonBox").strip()
    cleaned = re.sub(r"[^A-Za-z0-9 ]", "", raw)[:11].strip()
    return cleaned or "BonBox"


def send_sms(*, to: str, text: str, sender: str | None = None,
             country: str | None = None) -> dict:
    """Send one SMS. Best-effort — never raises. Returns
    {"ok": bool, "error": str | None}. `country` is the venue's ("DK" |
    "PT" | None) — the country code a number typed without one belongs to;
    a number that cannot be read for it is "bad_number" and nothing is sent."""
    if not sms_configured():
        return {"ok": False, "error": "not_configured"}
    msisdn = _normalize_msisdn(to, country)
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
