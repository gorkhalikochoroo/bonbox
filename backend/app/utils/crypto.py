"""
Symmetric encryption helper for at-rest secrets — Aiia refresh tokens
(Task #67) and any other tokens we add later.

Why Fernet (rather than raw AES via cryptography.hazmat):
  • Fernet is the "I just want safe symmetric encryption" recipe from
    pyca/cryptography. AES-128-CBC + HMAC-SHA256 with versioned token
    format. Authenticated, timestamped, URL-safe-base64 wire format.
  • Bonbox already pulls cryptography in transitively (python-jose
    [cryptography]) so we don't add a new dep.
  • Key is a 32-byte url-safe base64 value — generate via
    `Fernet.generate_key()` once, set as APP_SECRET_KEY in env.

Threat model:
  • Encrypted-at-rest defense for refresh tokens that grant 90-day
    read-only PSD2 access to a Danish café's bank account. A DB dump
    leak should NOT include usable bank tokens.
  • We assume the application server is trusted (key lives in process
    memory). Worst-case attacker with API access already has a bank-
    sync endpoint — encryption defends against DB-only leak.

Key management:
  • Single key per environment via APP_SECRET_KEY env var.
  • Fail-fast on import if the key is missing AND we're in production
    — never silently fall back to a random key (would prevent decrypt
    of existing rows after restart).
  • Development mode (ENVIRONMENT != "production"): auto-generates a
    stable per-process key so tests + local dev work without setup.
  • Rotation: add APP_SECRET_KEY_PREVIOUS for grace-period decrypt
    after rotating APP_SECRET_KEY. MultiFernet tries each in turn.
"""
from __future__ import annotations

import logging
import os
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

logger = logging.getLogger(__name__)


class CryptoConfigError(RuntimeError):
    """Raised when the encryption key is missing or malformed in a
    context where we must fail loud (production startup)."""


def _is_production() -> bool:
    return os.environ.get("ENVIRONMENT", "development").lower() == "production"


@lru_cache(maxsize=1)
def _get_fernet() -> MultiFernet:
    """Return a process-wide MultiFernet built from APP_SECRET_KEY (+
    optional APP_SECRET_KEY_PREVIOUS for grace-period decrypt).

    Cached via lru_cache so we only validate the key once per process.
    Tests that need to override the key should clear the cache:
    `_get_fernet.cache_clear()`.
    """
    primary = (os.environ.get("APP_SECRET_KEY") or "").strip()
    previous = (os.environ.get("APP_SECRET_KEY_PREVIOUS") or "").strip()

    if not primary:
        if _is_production():
            raise CryptoConfigError(
                "APP_SECRET_KEY must be set in production. "
                "Generate one with: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
            )
        # Dev mode — generate a per-process key. Stable across one
        # uvicorn process, gone on restart. Means dev-mode encrypted
        # rows can't be decrypted after a restart, which is fine for
        # local sandbox data.
        logger.warning(
            "crypto: APP_SECRET_KEY unset; generating an ephemeral key for "
            "this process (development mode only — set the env var before "
            "shipping to prod)."
        )
        primary = Fernet.generate_key().decode()

    keys: list[Fernet] = []
    try:
        keys.append(Fernet(primary.encode() if isinstance(primary, str) else primary))
    except (ValueError, TypeError) as e:
        raise CryptoConfigError(
            f"APP_SECRET_KEY is not a valid Fernet key (must be 32-byte "
            f"url-safe base64). Generate one with "
            f"Fernet.generate_key(). {e}"
        ) from e

    if previous:
        try:
            keys.append(Fernet(previous.encode()))
        except (ValueError, TypeError) as e:
            # Don't fail startup over a bad previous key — log + skip.
            # Primary still works.
            logger.warning(
                "crypto: APP_SECRET_KEY_PREVIOUS is malformed; ignoring. %s", e,
            )

    return MultiFernet(keys)


def encrypt(plaintext: str) -> bytes:
    """Encrypt a string → bytes. Returns the Fernet token (url-safe
    base64 + auth tag + timestamp). Empty/None → empty bytes (caller
    decides if that's an error).
    """
    if plaintext is None:
        return b""
    if not isinstance(plaintext, str):
        plaintext = str(plaintext)
    if plaintext == "":
        return b""
    return _get_fernet().encrypt(plaintext.encode("utf-8"))


def decrypt(ciphertext: bytes | str) -> str:
    """Decrypt bytes → string. Raises InvalidToken on tamper /
    bad-key / wrong-version. Empty input returns empty string —
    matches the encrypt-empty contract above.
    """
    if not ciphertext:
        return ""
    if isinstance(ciphertext, str):
        ciphertext = ciphertext.encode("utf-8")
    try:
        return _get_fernet().decrypt(ciphertext).decode("utf-8")
    except InvalidToken:
        logger.exception("crypto.decrypt: InvalidToken — wrong key or tampered ciphertext")
        raise


def assert_key_configured() -> None:
    """Call from app startup to fail-fast if the key is misconfigured.
    Triggers the lru_cache validation without ever logging the key.
    """
    _get_fernet()
