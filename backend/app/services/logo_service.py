"""
Business logo upload service.

Security model (file uploads are the #1 malware vector — be paranoid):

  1. Size limit (1 MB) BEFORE buffering — refuses oversized uploads cheap.
  2. Magic-byte validation — checks the actual file bytes start with
     PNG or JPEG signatures. Never trust the client-provided MIME type
     or filename extension.
  3. SVG REJECTED — SVG is XML that can contain <script> for XSS when
     rendered inline. Logos don't need vector; PNG/JPEG is fine.
  4. Pillow re-encode — opens the bytes, strips EXIF + ICC + private
     metadata, downscales to ≤800x800, re-saves as PNG. Any embedded
     shellcode, polyglot tricks, or format-specific exploits die here.
  5. Tenant-scoped storage path — business-logo/{user_id}/{sha}.png.
     compose_key from storage.py already validates UUID shape.
  6. Filename never used in storage path — derived UUID/sha only. The
     user-provided filename is discarded after MIME inference.

This service ONLY handles bytes → storage. Persistence of the storage
key/URL onto BusinessProfile is the router's job.
"""
from __future__ import annotations

import hashlib
import io
import logging
from typing import Tuple
from uuid import UUID

from fastapi import HTTPException, status as http_status

from app.services.storage import compose_key, get_storage

logger = logging.getLogger(__name__)

# Hard limit. Logos are SMALL — anything larger is either a customer
# uploading a 4K screenshot by accident or a malware payload trying to
# OOM the server. Either way we reject before processing.
MAX_LOGO_BYTES = 1_000_000  # 1 MB

# Output dimensions. PDFs are typically rendered at 72-150 DPI; even
# 800x800 is overkill but gives Retina display headroom. Pillow
# preserves aspect ratio via thumbnail().
MAX_OUTPUT_DIM = 800

# Decode-pixel ceiling — a decompression-bomb defence. The 1 MB size cap
# above bounds the file on disk, not the canvas it decodes to: a tiny
# highly-compressed file can still declare a 169M px image and force a
# ~0.5 GB in-memory RGB allocation. Pillow's own default only trips above
# ~178M px, which is far too generous. A logo never needs more than a few
# M px, so anything larger raises DecompressionBombError and becomes a
# clean 415 instead of an OOM risk.
MAX_DECODE_PIXELS = 16_000_000

# Magic bytes — checked against the raw file head before Pillow ever
# touches it. PNG and JPEG only.
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_JPEG_MAGIC_PREFIX = b"\xff\xd8\xff"


def _verify_magic_bytes(raw: bytes) -> str:
    """Sanity-check that the upload is actually a PNG or JPEG by reading
    its first few bytes. Returns the inferred format ('png' or 'jpeg')
    or raises HTTPException 415.

    This is the FIRST line of defense. We never trust the
    Content-Type header or the filename — clients lie. A file labeled
    'logo.png' but containing PHP shellcode would fail here because
    its magic bytes won't match PNG's signature.
    """
    if len(raw) < 8:
        raise HTTPException(
            http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Logo file too small to be valid",
        )
    if raw.startswith(_PNG_MAGIC):
        return "png"
    if raw.startswith(_JPEG_MAGIC_PREFIX):
        return "jpeg"
    raise HTTPException(
        http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        "Logo must be PNG or JPEG. SVG, GIF, HEIC, and other formats are not supported.",
    )


def _strip_and_optimize(raw: bytes, inferred_fmt: str) -> bytes:
    """Re-encode the image via Pillow. This is the SECURITY HARDENING
    step — by parsing and re-emitting, we discard:
      • EXIF metadata (privacy: GPS, owner name, camera model)
      • ICC color profiles (known exploit vector — Bug Tracker 2018-13785)
      • XMP/IPTC blocks (could contain malicious URLs/payloads)
      • Format-specific tricks (polyglot files, oversized chunk headers)

    Side benefits:
      • Downscale to 800x800 max → smaller PDFs
      • Uniform PNG output → render predictably
    """
    try:
        from PIL import Image, ImageFile
    except ImportError as e:
        logger.error("Pillow not installed — logo upload disabled")
        raise HTTPException(
            http_status.HTTP_503_SERVICE_UNAVAILABLE,
            "Image processing temporarily unavailable",
        ) from e

    # Pillow's default truncated-image policy is to refuse. Keep that —
    # if the bytes are truncated, the upload is malformed and we'd
    # rather reject than store half a file.
    ImageFile.LOAD_TRUNCATED_IMAGES = False

    # Cap the decode canvas (restored below) so a decompression bomb raises
    # rather than allocating half a gigabyte. Save/restore keeps this local —
    # no global Pillow side-effect on other callers (floor plan, kasserapport).
    _prev_max = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = MAX_DECODE_PIXELS
    try:
        with Image.open(io.BytesIO(raw)) as img:
            # Lazy-load: img.load() forces full decoding so any malformed or
            # oversized bytes throw NOW, not later when we serialize.
            img.load()

            # Validate format against magic-byte inference. If the magic
            # bytes said PNG but Pillow decodes JPEG, that's a polyglot
            # file — reject.
            pillow_fmt = (img.format or "").lower()
            if inferred_fmt == "png" and pillow_fmt != "png":
                raise HTTPException(
                    http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                    "Logo format inconsistent (polyglot file rejected)",
                )
            if inferred_fmt == "jpeg" and pillow_fmt not in ("jpeg", "mpo"):
                raise HTTPException(
                    http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                    "Logo format inconsistent (polyglot file rejected)",
                )

            # Convert to RGBA for transparent logos, or RGB for opaque.
            if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                img = img.convert("RGBA")
            else:
                img = img.convert("RGB")

            # Downscale in-place. thumbnail preserves aspect ratio.
            img.thumbnail((MAX_OUTPUT_DIM, MAX_OUTPUT_DIM), Image.LANCZOS)

            # Always emit PNG — uniform format, kills JPEG-specific
            # exploits, preserves transparency. Strip all metadata via
            # the empty pnginfo + save() args.
            out = io.BytesIO()
            img.save(out, format="PNG", optimize=True)
            return out.getvalue()

    except HTTPException:
        raise
    except Exception as e:
        # DecompressionBombError (oversized canvas) lands here too → a clean 415.
        logger.warning("Logo re-encode failed: %s", e)
        raise HTTPException(
            http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Logo file is corrupt, unreadable, or too large to process",
        ) from e
    finally:
        Image.MAX_IMAGE_PIXELS = _prev_max


def upload_logo(user_id: UUID | str, raw_bytes: bytes) -> Tuple[str, int]:
    """Validate, sanitize, and store a logo. Returns (storage_key, bytes).

    Returns the STORAGE KEY (e.g. 'abc-123/business_logo/sha256.png')
    not a URL — caller fetches a signed URL on demand. This means we
    can revoke access by rotating signing keys without DB migration.

    Raises HTTPException on any validation failure.

    Pure function over the storage backend — easy to unit test.
    """
    if not raw_bytes:
        raise HTTPException(
            http_status.HTTP_400_BAD_REQUEST,
            "Empty logo upload",
        )
    if len(raw_bytes) > MAX_LOGO_BYTES:
        raise HTTPException(
            http_status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"Logo too large (max {MAX_LOGO_BYTES // 1000} KB)",
        )

    # Step 1: magic bytes
    inferred_fmt = _verify_magic_bytes(raw_bytes)

    # Step 2: Pillow re-encode (strips metadata + downscales + emits PNG)
    sanitized = _strip_and_optimize(raw_bytes, inferred_fmt)

    # Step 3: tenant-scoped key + storage put
    sha = hashlib.sha256(sanitized).hexdigest()
    key = compose_key(str(user_id), "business_logo", sha, "png")

    storage = get_storage()
    try:
        storage.put(key, sanitized, content_type="image/png")
    except Exception as e:
        logger.exception("Logo storage put failed for user=%s: %s", user_id, e)
        raise HTTPException(
            http_status.HTTP_503_SERVICE_UNAVAILABLE,
            "Could not save logo — try again",
        ) from e

    logger.info(
        "logo.uploaded user=%s key=%s in_bytes=%d out_bytes=%d",
        user_id, key, len(raw_bytes), len(sanitized),
    )
    return key, len(sanitized)


def logo_signed_url(storage_key: str, ttl_seconds: int = 3600) -> str | None:
    """Generate a short-lived signed URL for the frontend to render.

    Default TTL: 1 hour. The frontend should re-fetch via /api/business
    if the URL expires (it'll just re-render the logo when the user
    next visits Profile or sends a faktura).
    """
    if not storage_key:
        return None
    storage = get_storage()
    return storage.signed_url(storage_key, ttl_seconds=ttl_seconds)


def delete_logo(storage_key: str) -> bool:
    """Best-effort delete from storage. Returns True if successful or
    if the key didn't exist (idempotent). Logs but doesn't raise on
    failure — the caller can still clear the DB pointer."""
    if not storage_key:
        return True
    try:
        storage = get_storage()
        if hasattr(storage, "delete"):
            storage.delete(storage_key)
        return True
    except Exception as e:
        logger.warning("logo.delete failed for key=%s: %s", storage_key, e)
        return False


# ─── Accent color whitelist ────────────────────────────────────────────
#
# Why locked to 6 presets instead of free hex:
#   • Neon green tax invoices look unprofessional → harms BonBox brand
#   • Reduces accessibility risk (low-contrast color combinations)
#   • One palette decision means the PDF template only needs to handle
#     known-good colors — no need to compute contrast for arbitrary input
#
# Picked to work in both light and dark contexts. Each maps to its
# semantic role: green=success/growth, blue=trust, slate=professional,
# terracotta=warm/hospitality, charcoal=austere, burgundy=premium.

ACCENT_COLOR_PALETTE: dict[str, str] = {
    "emerald":   "#10B981",
    "blue":      "#2563EB",
    "slate":     "#475569",
    "terracotta":"#C2410C",
    "charcoal":  "#1F2937",
    "burgundy":  "#9F1239",
}


def validate_accent_color(value: str | None) -> str | None:
    """Validator for the BusinessProfile.accent_color field. Returns the
    canonicalized hex value or None. Rejects anything not in the palette."""
    if value is None or value == "":
        return None
    v = value.strip().upper()
    # Accept either palette name ('emerald') or hex value
    if v.lower() in ACCENT_COLOR_PALETTE:
        return ACCENT_COLOR_PALETTE[v.lower()]
    if v in ACCENT_COLOR_PALETTE.values() or v.upper() in {h.upper() for h in ACCENT_COLOR_PALETTE.values()}:
        return v
    raise ValueError(
        f"accent_color must be one of: {', '.join(ACCENT_COLOR_PALETTE.keys())}"
    )


def validate_logo_position(value: str | None) -> str:
    """Logo position is 'left' (default, Copenhagen standard) or 'center'."""
    if value is None or value == "":
        return "left"
    if value not in ("left", "center"):
        raise ValueError("logo_position must be 'left' or 'center'")
    return value
