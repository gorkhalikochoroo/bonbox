"""
Receipt-forwarding email inbox — v0.1 helpers.

This module owns the small handful of pure-Python primitives the
inbox router + webhook depend on, kept out of the router so they're
unit-testable without spinning up FastAPI:

  • generate_inbox_alias()         — slugify + Crockford suffix + dedup
  • ensure_alias()                  — lazy allocator for legacy users
  • allowed_attachment_mime()       — MIME allowlist
  • persist_attachment_blob()       — Fernet-encrypt + write to disk
  • load_attachment_blob()          — decrypt for OCR
  • count_messages_this_month()     — cap counter

Why a dedicated module:
  • The webhook handler is dense. Pulling helpers out keeps every
    multi-barrier layer easy to read.
  • Tests can exercise the allocator + cap counter without hitting
    HTTP at all.
"""
from __future__ import annotations

import hashlib
import logging
import os
import random
import re
import uuid
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy.orm import Session

from app.models.email_message import EmailMessage
from app.models.user import User
from app.utils.crypto import fernet_decrypt_bytes, fernet_encrypt_bytes
from app.utils.time import utc_now

logger = logging.getLogger(__name__)


# ── Alias generation ────────────────────────────────────────────────

# Crockford-style alphabet — lowercase, drops 0/1/i/l/o so an owner
# reading the alias out loud over the phone to their bookkeeper can
# never confuse a "1" with "I" or an "O" with "0". 32 chars total.
_RAND_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def _slugify_business(name: str | None) -> str:
    """Lowercase, strip to a-z0-9, trim to 6 chars. Falls back to
    'user' when the result would be empty (no Latin chars in the
    business name — common for Nepali / Arabic / Cyrillic names that
    haven't filled in an English alias).
    """
    base = re.sub(r"[^a-z0-9]", "", (name or "user").lower())[:6]
    return base or "user"


def generate_inbox_alias(business_name: str | None, db: Session) -> str:
    """Allocate a fresh, unused alias for this user.

    Format: ``<base>-<rand4>`` where:
      • base    — slugified business_name, 1-6 chars a-z0-9
      • rand4   — 4 chars from `_RAND_ALPHABET` (~1M aliases per base)

    Retries up to 5 times on collision. If all 5 collide (≈ never,
    statistically — would mean 1M+ users sharing the same base) we
    fall back to a UUID-prefixed alias that's effectively impossible
    to collide on. The fallback shape is `u-<8-hex>` so it's still
    short enough to email by hand if needed.
    """
    base = _slugify_business(business_name)
    rng = random.SystemRandom()  # cryptographic entropy — guessing-resistant
    for _ in range(5):
        rand = "".join(rng.choices(_RAND_ALPHABET, k=4))
        candidate = f"{base}-{rand}"
        if not db.query(User).filter(User.inbox_alias == candidate).first():
            return candidate
    return f"u-{uuid.uuid4().hex[:8]}"


def ensure_alias(db: Session, user: User) -> str:
    """Return user.inbox_alias, allocating one lazily on the first hit.

    Lazy allocation matters: every existing user predates Migration 016
    and has inbox_alias=NULL. The first /api/inbox/me GET (or the first
    webhook resolve, although that path won't ever resolve a NULL
    alias) writes a fresh alias + commits in the same transaction.
    """
    if user.inbox_alias:
        return user.inbox_alias
    alias = generate_inbox_alias(user.business_name, db)
    user.inbox_alias = alias
    # Caller commits — we just flush so the alias is visible within the
    # current transaction (the route handler will commit before
    # responding).
    db.flush()
    return alias


# ── MIME allowlist ──────────────────────────────────────────────────

# Receipts come as PDFs (most accountant-friendly format), iPhone JPEGs,
# Android PNGs, HEIC from newer iPhones, and the occasional GIF from a
# WhatsApp share. We deliberately exclude application/* generic + every
# office format — invoices and receipts that arrive as .docx/.xlsx are
# rare and the OCR pipeline doesn't have a path for them anyway.
_ALLOWED_MIME_PREFIXES = ("image/",)
_ALLOWED_MIME_EXACT = {
    "application/pdf",
    # Postmark + some Android clients label HEIC as "image/heic" already
    # (caught by the prefix above) but some legacy clients send the
    # bare suffix-only marker — be explicit for safety.
    "image/heic",
    "image/heif",
}


def allowed_attachment_mime(content_type: str | None) -> bool:
    """True iff the attachment is one we'll OCR. Defensive against a
    None or whitespace-only value (some Postmark inbound rows omit the
    content-type when the sender used an obscure client)."""
    ct = (content_type or "").strip().lower()
    if not ct:
        return False
    if any(ct.startswith(p) for p in _ALLOWED_MIME_PREFIXES):
        return True
    return ct in _ALLOWED_MIME_EXACT


# ── Blob persistence (Fernet-encrypted on local disk) ───────────────

# Repo-root-relative — same convention as `receipt_ocr.UPLOAD_DIR`.
# We could swap to Supabase Storage via the storage abstraction later;
# the column shape (`storage_path TEXT`) allows that without a schema
# change. v0.1 stays on local disk so we have one fewer dependency
# to wire when INBOX_ENABLED first flips on.
_RECEIPT_DIR = Path("uploads/receipts")


def _ensure_storage_dir() -> Path:
    _RECEIPT_DIR.mkdir(parents=True, exist_ok=True)
    return _RECEIPT_DIR


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def persist_attachment_blob(plaintext: bytes, sha_hex: str) -> str:
    """Fernet-encrypt `plaintext` and write to disk under
    `uploads/receipts/<sha>.enc`. Returns the relative storage path
    stamped into ReceiptIntake.storage_path.

    The sha is over the PLAINTEXT, not the ciphertext — each Fernet
    encrypt() uses a fresh nonce so the ciphertext differs every time
    even for identical input. Stamping the sha against plaintext means
    dedup queries (e.g. "same receipt forwarded twice") work
    regardless of encryption-time noise.
    """
    folder = _ensure_storage_dir()
    relative = f"{sha_hex}.enc"
    target = folder / relative
    if target.exists():
        # Same plaintext sha — same blob. Don't re-encrypt and replace
        # the file (atomic write is overkill for the dedup case).
        return f"uploads/receipts/{relative}"
    enc = fernet_encrypt_bytes(plaintext)
    # Best-effort atomic write — write to a temp neighbour then rename.
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_bytes(enc)
    os.replace(tmp, target)
    return f"uploads/receipts/{relative}"


def load_attachment_blob(storage_path: str) -> bytes:
    """Reverse of `persist_attachment_blob`. Returns the original
    plaintext bytes. Raises FileNotFoundError if the blob is gone
    (caller maps to a graceful OCR failure)."""
    if not storage_path:
        raise FileNotFoundError("empty storage_path")
    p = Path(storage_path)
    if not p.is_absolute():
        # storage_path is repo-relative; resolve against cwd.
        p = Path.cwd() / p
    enc = p.read_bytes()
    return fernet_decrypt_bytes(enc)


# ── Cap counter ─────────────────────────────────────────────────────


def count_messages_this_month(db: Session, user_id) -> int:
    """How many EmailMessage rows count against the per-month cap?

    Counts rows for this user in the current calendar month with a
    status in the "real" set (received, queued, processed). We
    deliberately EXCLUDE 'throttled', 'rejected', 'orphan', and
    'quarantined' so a hostile flood of spoofed emails doesn't push
    a legit owner over their cap.
    """
    now = utc_now()
    first_of_month = datetime(now.year, now.month, 1)
    real_statuses = ("received", "queued", "processed")
    return (
        db.query(EmailMessage)
        .filter(EmailMessage.user_id == user_id)
        .filter(EmailMessage.received_at >= first_of_month)
        .filter(EmailMessage.status.in_(real_statuses))
        .count()
    )


# ── Test helper — synthesize a Postmark webhook payload ─────────────


def build_test_postmark_payload(alias: str, *, domain: str) -> dict:
    """Build a minimal Postmark Inbound JSON envelope so the /inbox/test
    endpoint can drive the same handler the real webhook drives. Single
    PDF attachment, base64 of a 1-byte "PDF" sentinel — enough for the
    Fernet round-trip + persist path to exercise. The OCR layer will
    fail-soft into a blank draft via L8.
    """
    import base64
    sentinel = b"%PDF-1.7\n%TEST\n%%EOF\n"
    return {
        "FromFull": {"Email": "owner-test@in.example.test", "Name": "Test"},
        "From": "owner-test@in.example.test",
        "OriginalRecipient": f"{alias}@{domain}",
        "To": f"{alias}@{domain}",
        "Subject": "Receipt from BonBox self-test",
        "MessageID": f"selftest-{uuid.uuid4().hex[:12]}",
        "TextBody": "Self-test from /api/inbox/test.\nNo real receipt attached.",
        "HtmlBody": "",
        "Headers": [
            {"Name": "Received-SPF", "Value": "pass"},
            {"Name": "Authentication-Results", "Value": "dkim=pass; dmarc=pass; spf=pass"},
        ],
        "MailboxHash": "",
        "Attachments": [
            {
                "Name": "self-test-receipt.pdf",
                "Content": base64.b64encode(sentinel).decode("ascii"),
                "ContentType": "application/pdf",
                "ContentLength": len(sentinel),
            }
        ],
    }
