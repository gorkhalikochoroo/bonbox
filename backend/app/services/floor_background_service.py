"""Reservation floor-plan BACKGROUND photo upload service.

A room background is a photo of the owner's REAL premises — the owner drags their
tables onto it to match the actual room. That makes it doubly sensitive:

  • It is PERSONAL DATA with no accounting-retention basis (staff or guests may be
    in frame). It lives under storage kind "floor_background", which is in BOTH
    storage.ALLOWED_KINDS (so compose_key accepts it) AND ERASURE_PURGE_KINDS (so
    it is purged on GDPR Art.17 account erasure). Missing either list is a bug.
  • A raw phone photo carries EXIF **GPS** — the venue's exact coordinates. Stripping
    it is NON-NEGOTIABLE. The Pillow re-encode below discards ALL metadata.

Security model mirrors logo_service.py (file uploads are the #1 malware vector):
  1. Size limit BEFORE buffering.
  2. Magic-byte validation — PNG/JPEG only; SVG (XML/XSS) and HEIC rejected.
  3. Pillow full-decode + re-encode — strips EXIF/GPS/ICC/XMP, kills polyglots,
     downscales, re-emits a clean JPEG.
  4. SHA-content-addressed, tenant-scoped storage key. Filename never used.

Bytes → storage only. Persisting the key onto BusinessProfile is the router's job.
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

# A room photo needs more detail than a logo, but is still bounded well below a
# raw 12MP phone shot — large enough to read the room, small enough to refuse a
# payload/OOM attempt cheaply.
MAX_FLOOR_BG_BYTES = 2_500_000  # 2.5 MB
MAX_OUTPUT_DIM = 1600  # px (vs the logo's 800 — a room needs to stay legible)

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_JPEG_MAGIC_PREFIX = b"\xff\xd8\xff"


def _verify_magic_bytes(raw: bytes) -> str:
    """Confirm the upload is really PNG or JPEG from its first bytes — never trust
    the Content-Type or filename. Returns 'png'|'jpeg' or raises 415. HEIC (the
    iPhone default) is rejected here; the client must convert first."""
    if len(raw) < 8:
        raise HTTPException(
            http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Image file too small to be valid",
        )
    if raw.startswith(_PNG_MAGIC):
        return "png"
    if raw.startswith(_JPEG_MAGIC_PREFIX):
        return "jpeg"
    raise HTTPException(
        http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        "Room photo must be a PNG or JPEG. SVG, GIF, and HEIC are not supported — "
        "on iPhone, share/export the photo as JPEG first.",
    )


def _strip_and_optimize(raw: bytes, inferred_fmt: str) -> bytes:
    """Re-encode via Pillow — the SECURITY + PRIVACY hardening step. Discards EXIF
    (incl. **GPS coordinates of the venue**), ICC profiles, XMP/IPTC; kills polyglot
    tricks; downscales; re-emits a clean JPEG."""
    try:
        from PIL import Image, ImageFile
    except ImportError as e:
        logger.error("Pillow not installed — floor background upload disabled")
        raise HTTPException(
            http_status.HTTP_503_SERVICE_UNAVAILABLE,
            "Image processing temporarily unavailable",
        ) from e

    ImageFile.LOAD_TRUNCATED_IMAGES = False
    try:
        with Image.open(io.BytesIO(raw)) as img:
            img.load()  # force full decode now so malformed bytes throw here
            pillow_fmt = (img.format or "").lower()
            if inferred_fmt == "png" and pillow_fmt != "png":
                raise HTTPException(
                    http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                    "Image format inconsistent (polyglot file rejected)",
                )
            if inferred_fmt == "jpeg" and pillow_fmt not in ("jpeg", "mpo"):
                raise HTTPException(
                    http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                    "Image format inconsistent (polyglot file rejected)",
                )
            # A background is opaque — flatten to RGB (also drops any alpha channel
            # a screenshot might carry). Re-emitting builds a fresh image with NO
            # metadata carried over — EXIF/GPS cannot survive this.
            img = img.convert("RGB")
            img.thumbnail((MAX_OUTPUT_DIM, MAX_OUTPUT_DIM), Image.LANCZOS)
            out = io.BytesIO()
            img.save(out, format="JPEG", quality=82, optimize=True)
            return out.getvalue()
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("Floor background re-encode failed: %s", e)
        raise HTTPException(
            http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Image file is corrupt or unreadable",
        ) from e


def upload_floor_background(user_id: UUID | str, raw_bytes: bytes) -> Tuple[str, int]:
    """Validate, sanitize (strip EXIF/GPS), and store a room background. Returns
    (storage_key, out_bytes). Raises HTTPException on any validation failure."""
    if not raw_bytes:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "Empty image upload")
    if len(raw_bytes) > MAX_FLOOR_BG_BYTES:
        raise HTTPException(
            http_status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"Room photo too large (max {MAX_FLOOR_BG_BYTES // 1_000_000} MB)",
        )
    inferred_fmt = _verify_magic_bytes(raw_bytes)
    sanitized = _strip_and_optimize(raw_bytes, inferred_fmt)
    sha = hashlib.sha256(sanitized).hexdigest()
    key = compose_key(str(user_id), "floor_background", sha, "jpg")
    storage = get_storage()
    try:
        storage.put(key, sanitized, content_type="image/jpeg")
    except Exception as e:
        logger.exception("Floor background storage put failed for user=%s: %s", user_id, e)
        raise HTTPException(
            http_status.HTTP_503_SERVICE_UNAVAILABLE,
            "Could not save the room photo — try again",
        ) from e
    logger.info(
        "floor_background.uploaded user=%s key=%s in_bytes=%d out_bytes=%d",
        user_id, key, len(raw_bytes), len(sanitized),
    )
    return key, len(sanitized)


def floor_background_signed_url(storage_key: str, ttl_seconds: int = 3600) -> str | None:
    """Short-lived signed URL for the frontend to render (default 1h). Serving via
    a signed URL — never the raw key — lets us revoke by rotating signing keys."""
    if not storage_key:
        return None
    return get_storage().signed_url(storage_key, ttl_seconds=ttl_seconds)


def delete_floor_background(storage_key: str) -> bool:
    """Best-effort, idempotent delete from storage. Logs but never raises so the
    caller can still clear the DB pointer."""
    if not storage_key:
        return True
    try:
        storage = get_storage()
        if hasattr(storage, "delete"):
            storage.delete(storage_key)
        return True
    except Exception as e:
        logger.warning("floor_background.delete failed for key=%s: %s", storage_key, e)
        return False
