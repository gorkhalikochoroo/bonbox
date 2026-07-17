"""Security tests for the reservation room-background photo pipeline.

The room photo is a picture of the owner's real premises — so the two things that
MUST hold are: (1) EXIF/GPS is stripped (a photo can't leak the venue's coordinates),
and (2) the storage kind is registered in BOTH the allow-list and the GDPR purge-list.
"""
import io

import pytest
from fastapi import HTTPException
from PIL import Image

from app.services import storage
from app.services.floor_background_service import (
    _strip_and_optimize,
    _verify_magic_bytes,
)


def test_floor_background_kind_in_both_lists():
    """The gotcha: a new kind must be in ALLOWED_KINDS (else compose_key 500s) AND
    ERASURE_PURGE_KINDS (else the premises photo orphans on account erasure)."""
    assert "floor_background" in storage.ALLOWED_KINDS
    assert "floor_background" in storage.ERASURE_PURGE_KINDS
    key = storage.compose_key(
        "00000000-0000-0000-0000-000000000000", "floor_background", "a" * 64, "jpg",
    )
    assert "/floor_background/" in key


def test_strip_removes_exif_including_gps():
    """A phone photo's EXIF (which carries GPS) must not survive the re-encode."""
    img = Image.new("RGB", (240, 160), (180, 40, 40))
    exif = img.getexif()
    exif[0x010e] = "shot at the venue"  # ImageDescription — stand-in EXIF payload
    exif[0x0110] = "Pixel 8"            # Model
    buf = io.BytesIO()
    img.save(buf, format="JPEG", exif=exif)
    raw = buf.getvalue()

    assert _verify_magic_bytes(raw) == "jpeg"
    assert dict(Image.open(io.BytesIO(raw)).getexif())  # input HAS metadata

    out = _strip_and_optimize(raw, "jpeg")
    # output is a valid JPEG with NO EXIF at all → no GPS, no model, no description
    result = Image.open(io.BytesIO(out))
    assert result.format == "JPEG"
    assert not dict(result.getexif())


def test_downscales_oversized_room_photo():
    img = Image.new("RGB", (4000, 3000), (30, 120, 60))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    out = _strip_and_optimize(buf.getvalue(), "jpeg")
    w, h = Image.open(io.BytesIO(out)).size
    assert max(w, h) <= 1600  # MAX_OUTPUT_DIM


def test_rejects_svg_gif_heic():
    # SVG = XML (XSS vector) — no image magic bytes
    with pytest.raises(HTTPException) as e1:
        _verify_magic_bytes(b'<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')
    assert e1.value.status_code == 415
    # GIF
    with pytest.raises(HTTPException):
        _verify_magic_bytes(b"GIF89a\x01\x00")
    # HEIC (iPhone default) — ftyp box, not PNG/JPEG
    with pytest.raises(HTTPException):
        _verify_magic_bytes(b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00")


def test_rejects_polyglot_png_magic_but_jpeg_body():
    """Magic bytes say PNG but Pillow decodes JPEG → polyglot, rejected."""
    img = Image.new("RGB", (32, 32), (10, 10, 10))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    with pytest.raises(HTTPException) as e:
        _strip_and_optimize(buf.getvalue(), "png")  # claim PNG, bytes are JPEG
    assert e.value.status_code == 415
