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

import base64
import hashlib
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


def _coerce_to_fernet_key(secret: str) -> str:
    """Take an arbitrary operator-provided secret and return a value
    that ``Fernet`` will accept (32-byte url-safe base64).

    Why this exists: operators routinely set APP_SECRET_KEY to a
    random string (`openssl rand -hex 32`, `python -c 'secrets.token_hex(32)'`,
    a JWT secret, etc.) without realizing Fernet wants a specific
    base64 shape. The old behavior was to raise CryptoConfigError on
    every encrypt() call — surfacing as opaque 500s on every
    bank-connect callback in prod.

    Strategy: if the secret is already a valid Fernet key, use it
    verbatim. Otherwise derive a deterministic Fernet key from it via
    SHA-256 → url-safe base64. The derivation is stable (same input
    → same key) so rows encrypted under the derived key remain
    decryptable across restarts.

    Security note: we're not weakening the protection — operator-
    chosen randomness is preserved as the SHA-256 preimage. We're
    just normalizing the FORMAT.
    """
    candidate = secret.encode() if isinstance(secret, str) else secret
    try:
        # Already valid Fernet?  Honor it as-is.
        Fernet(candidate)
        return secret if isinstance(secret, str) else secret.decode()
    except (ValueError, TypeError):
        pass
    # Derive 32 raw bytes via SHA-256, then url-safe base64 (which is
    # what Fernet wants on the wire).
    raw = hashlib.sha256(candidate).digest()  # 32 bytes
    derived = base64.urlsafe_b64encode(raw).decode("ascii")
    logger.warning(
        "crypto: APP_SECRET_KEY is not a Fernet-formatted key — "
        "deriving one via SHA-256 so encrypt/decrypt work. To migrate "
        "to a native Fernet key, set APP_SECRET_KEY_PREVIOUS to the "
        "current value and APP_SECRET_KEY to a new "
        "Fernet.generate_key()."
    )
    return derived


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

    # Fallback chain for missing APP_SECRET_KEY:
    # 1. SECRET_KEY (JWT signing key — always set in prod, by definition).
    #    Derive a stable Fernet key from it so existing deploys "just
    #    work". TRANSITIONAL ONLY — this couples bank-token encryption to
    #    the JWT signing secret (a single leak boundary). Target state is
    #    a dedicated APP_SECRET_KEY in its own boundary.
    # 2. Ephemeral key — only safe for non-production.
    #
    # #359: the DATABASE_URL fallback was REMOVED. DATABASE_URL is not a
    # secret-grade value (it sits in env, build logs, render.yaml and DB
    # backups), so keying at-rest encryption off it would defeat the
    # DB-dump threat model this module exists to satisfy.
    if not primary:
        from app.config import settings  # local import — avoid cycle

        seed = (getattr(settings, "SECRET_KEY", "") or "").strip()

        if seed:
            primary = seed
            logger.critical(
                "crypto: APP_SECRET_KEY unset; deriving the at-rest key "
                "from SECRET_KEY as a TRANSITIONAL fallback — bank-token "
                "encryption is coupled to the JWT secret. Set a dedicated "
                "APP_SECRET_KEY (Fernet.generate_key()) plus "
                "APP_SECRET_KEY_PREVIOUS=<current SECRET_KEY> to migrate."
            )
        elif _is_production():
            # Genuinely no seed available — refuse to silently use an
            # ephemeral key that would lose existing rows on restart.
            raise CryptoConfigError(
                "APP_SECRET_KEY must be set in production. "
                "Generate one with: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
            )
        else:
            # Dev / test — ephemeral key is fine.
            logger.warning(
                "crypto: APP_SECRET_KEY unset; generating an ephemeral "
                "key for this process (dev only — set the env var before "
                "shipping to prod)."
            )
            primary = Fernet.generate_key().decode()

    # Coerce arbitrary operator-provided secrets into a Fernet-shaped
    # key so encrypt() doesn't 500 in prod on misconfigured deploys.
    # See `_coerce_to_fernet_key` docstring.
    primary_key = _coerce_to_fernet_key(primary)

    keys: list[Fernet] = []
    try:
        keys.append(Fernet(primary_key.encode()))
    except (ValueError, TypeError) as e:
        # Should be unreachable after _coerce_to_fernet_key but keep
        # the explicit fail-loud for completeness.
        raise CryptoConfigError(
            f"APP_SECRET_KEY could not be coerced to a Fernet key. {e}"
        ) from e

    if previous:
        try:
            keys.append(Fernet(_coerce_to_fernet_key(previous).encode()))
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


def fernet_encrypt_bytes(plaintext: bytes) -> bytes:
    """Encrypt raw bytes → Fernet token bytes.

    The text-mode `encrypt()` above forces UTF-8 round-tripping which
    corrupts arbitrary binary payloads (PDFs, JPEGs, HEIC). This helper
    is the canonical at-rest path for the receipt-inbox blobs — same
    MultiFernet key chain, same authentication/timestamp guarantees.
    Empty input returns empty bytes (caller decides if that's an error).
    """
    if not plaintext:
        return b""
    if not isinstance(plaintext, (bytes, bytearray)):
        raise TypeError("fernet_encrypt_bytes requires bytes input")
    return _get_fernet().encrypt(bytes(plaintext))


def fernet_decrypt_bytes(ciphertext: bytes | str) -> bytes:
    """Decrypt a Fernet token → raw bytes. Mirror of
    `fernet_encrypt_bytes`. Raises InvalidToken on tamper / bad-key /
    wrong-version. Empty input returns empty bytes.
    """
    if not ciphertext:
        return b""
    if isinstance(ciphertext, str):
        ciphertext = ciphertext.encode("utf-8")
    try:
        return _get_fernet().decrypt(ciphertext)
    except InvalidToken:
        logger.exception(
            "crypto.fernet_decrypt_bytes: InvalidToken — wrong key or tampered ciphertext"
        )
        raise


def assert_key_configured() -> None:
    """Call from app startup to fail-fast if the key is misconfigured.
    Triggers the lru_cache validation without ever logging the key.
    """
    _get_fernet()


def assert_can_decrypt_existing_tokens(db) -> None:
    """Audit P3 (Task #82) — defense against silent key-rotation loss.

    If an operator rotates `APP_SECRET_KEY` without also setting
    `APP_SECRET_KEY_PREVIOUS`, every previously-stored Fernet token
    (BankConnection.refresh_token_enc, MobilePayConnection.access_/
    refresh_token_enc, …) becomes undecryptable.  The app would boot
    fine and only error on the first /sync — at which point the bank
    consent has effectively been lost.

    This helper probes the newest few rows that carry an encrypted
    secret and tries to decrypt them.  If ANY fail AND we have no
    previous-key set, we raise CryptoConfigError so the process
    refuses to start with an "operator intervention required" message.

    Best-effort: a missing table (fresh DB), zero rows, or a single
    decrypt that succeeds means we pass.  Only "rows exist + decrypt
    fails + no previous key" trips the assertion.
    """
    # Lazy import to avoid circulars at module load.
    try:
        from app.models.bank_connection import BankConnection
    except Exception:  # noqa: BLE001
        return  # Models not loaded yet — nothing to verify.

    has_previous = bool((os.environ.get("APP_SECRET_KEY_PREVIOUS") or "").strip())

    try:
        rows = (
            db.query(BankConnection)
            .filter(BankConnection.refresh_token_enc.isnot(None))
            .order_by(BankConnection.updated_at.desc())
            .limit(3)
            .all()
        )
    except Exception as e:  # noqa: BLE001
        # Table not migrated yet, or DB unreachable.  Don't block boot.
        logger.warning(
            "crypto.assert_can_decrypt_existing_tokens: query failed: %s", e,
        )
        return

    if not rows:
        return  # Nothing to verify.

    failures = 0
    for row in rows:
        try:
            _ = decrypt(row.refresh_token_enc)
        except InvalidToken:
            failures += 1

    if failures and not has_previous:
        raise CryptoConfigError(
            f"APP_SECRET_KEY appears to have rotated: {failures} of "
            f"{len(rows)} recent BankConnection refresh tokens failed "
            "to decrypt and APP_SECRET_KEY_PREVIOUS is not set.  "
            "Set APP_SECRET_KEY_PREVIOUS to the prior key (grace-"
            "period decrypt) and re-deploy, OR drop the affected rows "
            "and have owners re-consent."
        )
    if failures and has_previous:
        # Operator knows about the rotation — keep going but warn so
        # the next deploy still surfaces the issue.
        logger.warning(
            "crypto: %d of %d sampled tokens failed to decrypt with "
            "primary key but APP_SECRET_KEY_PREVIOUS is set — grace "
            "period in effect.  Re-encrypt these rows before "
            "removing the previous key.",
            failures, len(rows),
        )
