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
import math

from fastapi import HTTPException, status as http_status

logger = logging.getLogger(__name__)

MAX_CHAT_PHOTO_BYTES = 8_000_000  # 8 MB raw — phone photos fit comfortably
MAX_OUTPUT_DIM = 1600             # plenty for receipts / schedules on a phone
JPEG_QUALITY = 82

# Decompression-bomb ceiling: max decoded pixels allowed BEFORE img.load() runs.
# The byte caps above bound only the *compressed* size — a tiny highly-
# compressible PNG can decode to 100M+ px (hundreds of MB of RGB). BOTH
# sanitizers below MUST use this so they can never drift out of lock-step.
_MAX_DECODED_PIXELS = 50_000_000  # ~7000x7000; a real phone photo is <=~50MP

# PNG has no reduced-size decode: the whole canvas is decoded, as RGBA when
# the file has transparency (4 bytes / px). A 214 KB 50 MP RGBA PNG peaked
# at 766 MB through this pipeline (Linux, 10 Oct) and three at once
# OOM-killed the 2 GB instance — reachable from any staff link. A JPEG is
# decoded at a reduced scale (draft) so it keeps the 50 MP ceiling and every
# phone photo (iPhone 48 MP, Samsung 50 MP) still goes through; a PNG — a
# screenshot, a few MP — is held to 25 MP.
_MAX_FULL_DECODE_PIXELS = 25_000_000

_BUSY_DETAIL = "Der behandles mange billeder lige nu. Prøv igen om et øjeblik."
_BUSY_RETRY_AFTER_S = "10"

# Profile avatar: staff can pick a full-res iPhone/Android photo (up to 8 MB),
# and we re-encode it down to a small square JPEG — light to store + serve, and
# it always fills the circular avatar cleanly (center-crop, no letterboxing).
MAX_PROFILE_PHOTO_BYTES = 8_000_000
PROFILE_OUTPUT_DIM = 512          # a 512² avatar is ~40–90 KB at q85

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


def _decode_rgb(raw_bytes: bytes, inferred: str, *, need_for, too_many_px: str):
    """Decode a magic-checked PNG / JPEG to an RGB image, transparency
    flattened onto white. Caller holds ``image_guard.decode_slot``.

    ``need_for(size)`` — the smallest (width, height) the caller's output
    needs from an image of ``size``: a JPEG is decoded at the smallest scale
    (1/2, 1/4, 1/8) that still covers it, so a 48 MP phone photo decodes at
    ~2016x1512, not 8064x6048. Raises HTTPException exactly as the two
    sanitizers always did.
    """
    from PIL import Image

    # PNG / JPEG decoders only — the magic bytes said one of the two.
    img = Image.open(io.BytesIO(raw_bytes), formats=["PNG", "JPEG"])
    try:
        # Decompression-bomb guard — reject huge pixel dimensions BEFORE
        # img.load() allocates the bitmap. A tiny highly-compressible PNG can
        # decode to 100M+ px (~hundreds of MB each) and OOM the
        # single-worker instance.
        pixels = img.width * img.height
        is_jpeg = (img.format or "").upper() in ("JPEG", "MPO")
        if pixels > _MAX_DECODED_PIXELS or (not is_jpeg and pixels > _MAX_FULL_DECODE_PIXELS):
            raise HTTPException(http_status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, too_many_px)
        need = need_for(img.size)
        if is_jpeg and img.width >= 2 * need[0] and img.height >= 2 * need[1]:
            try:
                img.draft(None, need)  # never below ``need``; see docstring
            except Exception as e:  # noqa: BLE001 — only a memory saving
                logger.info("chat photo reduced decode skipped: %s", e)
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
        # Flatten transparency onto white, then RGB for JPEG output. No
        # convert() to the mode the image already has (that is a full copy)
        # and only the alpha band is split off (split() copies all four).
        if img.mode in ("RGBA", "LA", "P"):
            rgba = img if img.mode == "RGBA" else img.convert("RGBA")
            bg = Image.new("RGB", rgba.size, (255, 255, 255))
            bg.paste(rgba, mask=rgba.getchannel("A"))
            del rgba
            return bg
        if img.mode == "RGB":
            out, img = img, None  # handed to the caller, not closed below
            return out
        return img.convert("RGB")
    finally:
        if img is not None:
            img.close()  # frees the decoded canvas now, not at GC


def _fit(size: tuple[int, int], box: int) -> tuple[int, int]:
    """The size ``thumbnail((box, box))`` produces for ``size``."""
    w, h = size
    if max(w, h) <= box:
        return w, h
    r = box / max(w, h)
    return max(1, round(w * r)), max(1, round(h * r))


def _short_side_at_least(side: int):
    """need_for: the size whose SHORT side is ``side`` (the avatar crop)."""
    def need_for(size: tuple[int, int]) -> tuple[int, int]:
        w, h = size
        k = side / max(1, min(w, h))
        if k >= 1:
            return w, h
        return max(1, math.ceil(w * k)), max(1, math.ceil(h * k))
    return need_for


def _busy() -> HTTPException:
    return HTTPException(
        http_status.HTTP_503_SERVICE_UNAVAILABLE, _BUSY_DETAIL,
        headers={"Retry-After": _BUSY_RETRY_AFTER_S},
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
    from app.services.image_guard import DecodeBusyError, decode_slot

    try:
        # One of the process-wide decode slots (image_guard: at most 2 photo
        # decodes at once); busy → 503 "try again", before any row is written.
        with decode_slot(lang="da"):
            # The pixel ceilings and the reduced JPEG decode live in
            # _decode_rgb, shared with sanitize_profile_photo (they MUST stay
            # in lock-step — the header size cap only bounds the *compressed*
            # bytes, not the decoded surface).
            img = _decode_rgb(
                raw_bytes, inferred,
                need_for=lambda size: _fit(size, MAX_OUTPUT_DIM),
                too_many_px="Billedet har for mange pixels.",
            )
            img.thumbnail((MAX_OUTPUT_DIM, MAX_OUTPUT_DIM), Image.LANCZOS)
            out = io.BytesIO()
            img.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
            img.close()
            sanitized = out.getvalue()
    except DecodeBusyError:
        logger.warning("Chat photo refused: every decode slot busy")
        raise _busy()
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


def sanitize_profile_photo(raw_bytes: bytes) -> tuple[bytes, str, str]:
    """Validate + re-encode a staff profile avatar. Same paranoid pipeline as
    sanitize_chat_photo (size cap → magic bytes → Pillow re-encode strips EXIF/
    GPS/ICC + kills polyglots), but shaped for an avatar: center-cropped to a
    square and downscaled to PROFILE_OUTPUT_DIM. Returns (bytes, content_type,
    sha_hex). Raises HTTPException on any validation failure."""
    if not raw_bytes:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "Tomt billede.")
    if len(raw_bytes) > MAX_PROFILE_PHOTO_BYTES:
        raise HTTPException(
            http_status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"Billedet er for stort (maks {MAX_PROFILE_PHOTO_BYTES // 1_000_000} MB).",
        )

    inferred = _verify_magic_bytes(raw_bytes)

    try:
        from PIL import Image, ImageFile
    except ImportError as e:  # pragma: no cover
        logger.error("Pillow not installed — profile photo upload disabled")
        raise HTTPException(
            http_status.HTTP_503_SERVICE_UNAVAILABLE,
            "Billedbehandling er midlertidigt utilgængelig.",
        ) from e

    ImageFile.LOAD_TRUNCATED_IMAGES = False
    from app.services.image_guard import DecodeBusyError, decode_slot

    try:
        # One of the process-wide decode slots (image_guard: at most 2 photo
        # decodes at once); busy → 503 "try again", before anything is stored.
        with decode_slot(lang="da"):
            # Decompression-bomb guard + reduced JPEG decode: _decode_rgb,
            # shared with sanitize_chat_photo. 50 MP (25 MP for a PNG) is
            # orders of magnitude more than an avatar needs. The square crop
            # needs PROFILE_OUTPUT_DIM on the SHORT side, so a JPEG decodes at
            # the smallest scale that keeps it.
            img = _decode_rgb(
                raw_bytes, inferred,
                need_for=_short_side_at_least(PROFILE_OUTPUT_DIM),
                too_many_px="Billedet har for høj opløsning.",
            )
            # Center-crop to a square so the circular avatar never letterboxes.
            w, h = img.size
            side = min(w, h)
            left = (w - side) // 2
            top = (h - side) // 2
            img = img.crop((left, top, left + side, top + side))
            if side > PROFILE_OUTPUT_DIM:
                img = img.resize((PROFILE_OUTPUT_DIM, PROFILE_OUTPUT_DIM), Image.LANCZOS)
            out = io.BytesIO()
            img.save(out, format="JPEG", quality=85, optimize=True)
            sanitized = out.getvalue()
    except DecodeBusyError:
        logger.warning("Profile photo refused: every decode slot busy")
        raise _busy()
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logger.warning("Profile photo re-encode failed: %s", e)
        raise HTTPException(
            http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Billedet er beskadiget eller kan ikke læses.",
        ) from e

    sha_hex = hashlib.sha256(sanitized).hexdigest()
    return sanitized, "image/jpeg", sha_hex
