"""
Chat photo sanitization — same paranoid pipeline as logo_service, tuned for
message photos (a bit larger, emitted as JPEG to keep payloads small).

Pipeline (file uploads are the #1 malware vector — be paranoid):
  1. Size cap BEFORE decoding — refuses oversized uploads cheap.
  2. Magic-byte check — never trust Content-Type / filename.
  3. Pillow re-encode — strips EXIF (incl. GPS), ICC, XMP; kills polyglots
     and format-specific exploits; downscales; emits a uniform JPEG.
  4. Tenant-scoped storage key (compose_key validates UUID shape).

Returns (sanitized_bytes, content_type, sha_hex). The router computes the
storage key + persists. Photos are served ONLY via the tenant-re-checked proxy
endpoint — never a signed/public URL.
"""
from __future__ import annotations

import hashlib
import io
import logging

from fastapi import HTTPException, status as http_status

logger = logging.getLogger(__name__)

MAX_CHAT_PHOTO_BYTES = 8_000_000  # 8 MB raw — phone photos fit comfortably
MAX_OUTPUT_DIM = 1600             # plenty for receipts / schedules on a phone
JPEG_QUALITY = 82

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_JPEG_MAGIC_PREFIX = b"\xff\xd8\xff"


def _verify_magic_bytes(raw: bytes) -> str:
    if len(raw) < 8:
        raise HTTPException(
            http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Billedet er for lille til at være gyldigt.",
        )
    if raw.startswith(_PNG_MAGIC):
        return "png"
    if raw.startswith(_JPEG_MAGIC_PREFIX):
        return "jpeg"
    raise HTTPException(
        http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        "Kun PNG- og JPEG-billeder er tilladt.",
    )


def sanitize_chat_photo(raw_bytes: bytes) -> tuple[bytes, str, str]:
    """Validate + re-encode a chat photo. Returns (bytes, content_type, sha_hex).
    Raises HTTPException on any validation failure."""
    if not raw_bytes:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "Tomt billede.")
    if len(raw_bytes) > MAX_CHAT_PHOTO_BYTES:
        raise HTTPException(
            http_status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"Billedet er for stort (maks {MAX_CHAT_PHOTO_BYTES // 1_000_000} MB).",
        )

    inferred = _verify_magic_bytes(raw_bytes)

    try:
        from PIL import Image, ImageFile
    except ImportError as e:  # pragma: no cover
        logger.error("Pillow not installed — chat photo upload disabled")
        raise HTTPException(
            http_status.HTTP_503_SERVICE_UNAVAILABLE,
            "Billedbehandling er midlertidigt utilgængelig.",
        ) from e

    ImageFile.LOAD_TRUNCATED_IMAGES = False
    try:
        with Image.open(io.BytesIO(raw_bytes)) as img:
            img.load()
            pillow_fmt = (img.format or "").lower()
            if inferred == "png" and pillow_fmt != "png":
                raise HTTPException(
                    http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                    "Billedformatet er inkonsistent (polyglot afvist).",
                )
            if inferred == "jpeg" and pillow_fmt not in ("jpeg", "mpo"):
                raise HTTPException(
                    http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                    "Billedformatet er inkonsistent (polyglot afvist).",
                )
            # Flatten transparency onto white, then RGB for JPEG output.
            if img.mode in ("RGBA", "LA", "P"):
                img = img.convert("RGBA")
                bg = Image.new("RGB", img.size, (255, 255, 255))
                bg.paste(img, mask=img.split()[-1] if img.mode == "RGBA" else None)
                img = bg
            else:
                img = img.convert("RGB")
            img.thumbnail((MAX_OUTPUT_DIM, MAX_OUTPUT_DIM), Image.LANCZOS)
            out = io.BytesIO()
            img.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
            sanitized = out.getvalue()
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logger.warning("Chat photo re-encode failed: %s", e)
        raise HTTPException(
            http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Billedet er beskadiget eller kan ikke læses.",
        ) from e

    sha_hex = hashlib.sha256(sanitized).hexdigest()
    return sanitized, "image/jpeg", sha_hex
