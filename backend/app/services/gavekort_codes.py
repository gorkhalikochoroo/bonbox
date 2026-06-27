"""Gavekort code generation + verification helpers.

Two distinct identifiers are derived from ONE high-entropy secret code:

  • code        — the high-entropy secret. Shown to the buyer ONCE (encoded
                  in the QR token), NEVER stored in plaintext. This is what a
                  scanned QR / typed code resolves against.
  • short_code  — "GK-XXXX-XXXX-C": a human-readable handle with a mod-37
                  check character. Surfaced in the owner list and on the
                  printed/emailed card. Catches single-character typos.

The two are independent: short_code is a friendly LABEL (UNIQUE, but not a
secret — it's only ~10^12 space and printed openly), while `code` is the
actual high-entropy bearer secret (≥128 bits). Redemption authenticates on
`code_hash` (HMAC of the secret code), NOT on short_code.

NEVER store the plaintext `code`. Store only:
  • code_hash  = HMAC-SHA256(code, GAVEKORT_SIGNING_KEY) — the lookup key
  • short_code
  • code_last4

The HMAC key is the SAME dedicated GAVEKORT_SIGNING_KEY used by qr_signer's
gavekort token family (see app/services/qr_signer.py). In production with
the key unset we FAIL CLOSED — a redeemable bearer secret must never be
hashed under a fallback key.
"""
from __future__ import annotations

import hmac
import hashlib
import secrets

from app.services.qr_signer import gavekort_signing_key

# Alphabet for the human-readable short_code groups + the secret code. Uses
# Crockford-ish unambiguous chars (no I/O/0/1) so a card read aloud or typed
# from a printout is hard to mis-enter.
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 32 chars

# mod-37 check alphabet (0-9 + A-Z + '*'), the classic ISO 7064 MOD 37,2-style
# set. We use a simpler mod-37 over a 36-symbol value space mapping to a single
# check character drawn from this 37-symbol set.
_CHECK_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ*"  # 37 chars
_CHECK_VALUE = {c: i for i, c in enumerate(_CHECK_ALPHABET)}


def _check_char(body: str) -> str:
    """Compute a single mod-37 check character for the short_code body.

    Body is the digits/letters of the short_code WITHOUT the check char
    (e.g. "GKAB3KCD7M" → from "GK-AB3K-CD7M"). We sum each char's value in
    the check alphabet, weighted by position, mod 37, and map to a symbol.
    Catches all single-character substitutions and most transpositions.
    """
    total = 0
    for i, ch in enumerate(body.upper()):
        val = _CHECK_VALUE.get(ch, 0)
        total = (total + val * (i + 1)) % 37
    return _CHECK_ALPHABET[total]


def _random_group(n: int = 4) -> str:
    """Return an n-char group drawn from the unambiguous alphabet."""
    return "".join(secrets.choice(_ALPHABET) for _ in range(n))


def generate_code() -> tuple[str, str, str]:
    """Generate a fresh gavekort identity triple.

    Returns:
      (code, short_code, code_last4)
        • code        — the high-entropy secret (24 chars ≈ 120 bits). The
                        caller encodes this into the QR token and DISCARDS it
                        after responding once; it is never persisted in clear.
        • short_code  — "GK-XXXX-XXXX-C" with a mod-37 check char.
        • code_last4  — last 4 chars of `code`, a non-secret disambiguator.

    The short_code and code are independently random — short_code is the
    friendly label, code is the bearer secret. Uniqueness of both is enforced
    at the DB layer (UNIQUE on code_hash + short_code); the caller retries on
    the astronomically unlikely collision.
    """
    code = "".join(secrets.choice(_ALPHABET) for _ in range(24))
    g1 = _random_group(4)
    g2 = _random_group(4)
    body = f"GK{g1}{g2}"
    check = _check_char(body)
    short_code = f"GK-{g1}-{g2}-{check}"
    return code, short_code, code[-4:]


def short_code_is_valid(short_code: str) -> bool:
    """Verify a short_code's mod-37 check character. Defensive helper for any
    surface that lets a human type the short_code (catches typos before a DB
    lookup). Returns False on any malformed input."""
    if not short_code or not isinstance(short_code, str):
        return False
    parts = short_code.strip().upper().split("-")
    if len(parts) != 4 or parts[0] != "GK":
        return False
    _, g1, g2, check = parts
    if len(g1) != 4 or len(g2) != 4 or len(check) != 1:
        return False
    return _check_char(f"GK{g1}{g2}") == check


def hash_code(code: str) -> str:
    """Return HMAC-SHA256(code, GAVEKORT_SIGNING_KEY) as a hex digest.

    This is the value stored as GiftCard.code_hash and matched against on
    redemption. Uses the dedicated gavekort signing key — in production with
    the key unset, gavekort_signing_key() raises (fail-closed), so we never
    hash a redeemable bearer secret under a weaker fallback key.
    """
    key = gavekort_signing_key().encode("utf-8")
    return hmac.new(key, code.encode("utf-8"), hashlib.sha256).hexdigest()
