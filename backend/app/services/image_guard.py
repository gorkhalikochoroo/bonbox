"""Which uploaded image formats BonBox will decode — and the check before it.

Pillow opens ~40 formats by default, including exotic ones with recent
heap-overflow advisories (PSD, FITS, ...). Receipt, expense, Z-report and
supplier-invoice photos only ever need the formats a phone camera, a
screenshot or a desktop scanner produces, so every decode of an uploaded
photo goes through here (INFRA-03):

1. ``sniff_image_format`` reads the magic bytes BEFORE Pillow sees the
   file. Content-Type and filename are client claims; the bytes are not.
2. ``open_upload_image`` calls ``Image.open(..., formats=...)`` with the
   allow-list, so even a file whose header slipped past (1) can only be
   parsed by one of these decoders.

The allow-list is what the product accepts today: the pickers send
``image/*`` (iPhone HEIC/JPEG, Android JPEG/WebP, screenshots PNG,
desktop BMP/TIFF/GIF), /sales/upload-receipt names GIF, /kasserapport
names BMP. JPEG covers MPO — iPhone multi-picture JPEGs open through the
JPEG decoder and report "MPO"; Pillow has no separate "MPO" opener key.
"""

from __future__ import annotations

import io
import logging
from pathlib import Path
from typing import Union

from PIL import Image

logger = logging.getLogger("bonbox.image_guard")

try:  # HEIC/HEIF (iPhone default). Registration is idempotent.
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception as _e:  # noqa: BLE001
    logger.warning("pillow-heif unavailable — HEIC photos cannot be read: %s", _e)

#: Pillow format ids an uploaded photo may be decoded as.
UPLOAD_IMAGE_FORMATS: tuple[str, ...] = ("JPEG", "PNG", "WEBP", "HEIF", "GIF", "BMP", "TIFF")

# ISO-BMFF major brands that mean HEIC/HEIF (not AVIF, which no BonBox
# path has ever decoded).
_HEIF_BRANDS = {b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"hevm", b"hevs", b"mif1", b"msf1"}

_REFUSAL_TEXT = {
    "da": "Filen kunne ikke læses som et billede. Brug et foto i JPEG, PNG, HEIC eller WebP.",
    "en": "This file couldn't be read as an image. Use a photo in JPEG, PNG, HEIC or WebP.",
}


def refusal_message(lang: str | None) -> str:
    return _REFUSAL_TEXT["da" if lang == "da" else "en"]


class UnsupportedImageError(ValueError):
    """The upload is not one of ``UPLOAD_IMAGE_FORMATS`` by its bytes.

    A ValueError so every existing ``except ValueError -> 400`` keeps
    working; ``str()`` is the English refusal. Routes that know the
    owner use ``refusal_message(owner_lang(user))`` instead.
    """

    def __init__(self, reason: str = ""):
        self.reason = reason
        super().__init__(_REFUSAL_TEXT["en"])


def sniff_image_format(raw: bytes) -> str | None:
    """Pillow format id from the magic bytes, or None if not allowed."""
    if not raw or len(raw) < 12:
        return None
    if raw[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "WEBP"
    if raw[4:8] == b"ftyp" and raw[8:12] in _HEIF_BRANDS:
        return "HEIF"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "GIF"
    if raw[:2] == b"BM":
        return "BMP"
    if raw[:4] in (b"II*\x00", b"MM\x00*"):
        return "TIFF"
    return None


def check_upload_image(raw: bytes) -> str:
    """Return the sniffed format or raise ``UnsupportedImageError``."""
    fmt = sniff_image_format(raw)
    if fmt is None:
        head = (raw or b"")[:8]
        logger.info("upload refused before decode: magic=%r", head)
        raise UnsupportedImageError("magic bytes not in allow-list")
    return fmt


def _decode_formats() -> list[str]:
    # Image.open raises KeyError for an id no plugin registered (e.g. HEIF
    # when pillow-heif is missing), so pass only the registered ones.
    Image.init()
    return [f for f in UPLOAD_IMAGE_FORMATS if f in Image.OPEN]


def open_upload_image(src: Union[bytes, str, Path]) -> Image.Image:
    """``Image.open`` restricted to the allow-list.

    ``src`` is raw upload bytes (magic-checked first) or a path to a file
    that holds them. Raises ``UnsupportedImageError`` for anything else.
    """
    if isinstance(src, (bytes, bytearray)):
        check_upload_image(bytes(src))
        fp: object = io.BytesIO(bytes(src))
    else:
        with open(src, "rb") as fh:
            check_upload_image(fh.read(16))
        fp = str(src)
    try:
        return Image.open(fp, formats=_decode_formats())
    except Image.UnidentifiedImageError as e:
        raise UnsupportedImageError(str(e)) from e
