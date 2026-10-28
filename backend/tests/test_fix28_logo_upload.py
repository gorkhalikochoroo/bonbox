"""28 Oct 2026: no logo upload had ever succeeded in production.

1. Storage answered every upload 400 "Invalid Compact JWS": the server's
   Supabase key is a new-format key (sb_secret_…), which is not a JWT, and the
   client sent it as ``Authorization: Bearer`` as well as ``apikey``. Supabase:
   "Send publishable and secret keys on the apikey header, not on
   Authorization: Bearer."
2. 1 MB refused most phone photos of a logo; WebP logos saved from a website
   were refused too. Now 10 MB, PNG / JPEG / WebP in, a small PNG out.
"""
from __future__ import annotations

import io
import os
import uuid

import pytest
from fastapi import HTTPException
from PIL import Image

from app.services import logo_service
from app.services.backup_storage import SupabaseBucket
from app.services.storage import SupabaseStorageBackend, supabase_key_headers

JWT_LIKE = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln"


# ── 1. Supabase keys in either format ─────────────────────────────────────

def test_a_new_secret_key_goes_on_the_apikey_header_only():
    assert supabase_key_headers("sb_secret_abc123") == {"apikey": "sb_secret_abc123"}


def test_a_legacy_jwt_key_keeps_both_headers():
    assert supabase_key_headers(JWT_LIKE) == {
        "Authorization": f"Bearer {JWT_LIKE}",
        "apikey": JWT_LIKE,
    }


def test_file_storage_and_the_backup_bucket_use_the_same_rule():
    files = SupabaseStorageBackend("https://x.supabase.co", "sb_secret_k", "receipts")
    backup = SupabaseBucket("https://y.supabase.co", "sb_secret_k", "backups")
    assert files._headers == {"apikey": "sb_secret_k"}
    assert backup._headers == {"apikey": "sb_secret_k"}
    legacy = SupabaseStorageBackend("https://x.supabase.co", JWT_LIKE, "receipts")
    assert legacy._headers["Authorization"] == f"Bearer {JWT_LIKE}"


# ── 2. Size and formats ───────────────────────────────────────────────────

class _FakeStorage:
    def __init__(self):
        self.puts = []
        self.data = {}

    def put(self, key, data, content_type="image/jpeg"):
        self.puts.append((key, len(data), content_type))
        self.data[key] = data
        return key


@pytest.fixture
def storage(monkeypatch):
    fake = _FakeStorage()
    monkeypatch.setattr(logo_service, "get_storage", lambda: fake)
    return fake


def _encode(img: Image.Image, fmt: str) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


def test_a_3_mb_photo_of_a_logo_is_accepted_and_stored_as_a_small_png(storage):
    # Noise does not compress: 1000x1000 RGB is about 3 MB as a PNG — over the
    # old 1 MB limit, the size of a phone photo.
    noise = Image.frombytes("RGB", (1000, 1000), os.urandom(3_000_000))
    raw = _encode(noise, "PNG")
    assert len(raw) > 2_000_000
    key, out_bytes = logo_service.upload_logo(uuid.uuid4(), raw)
    assert key.endswith(".png") and "/business_logo/" in key
    assert storage.puts == [(key, out_bytes, "image/png")]
    with Image.open(io.BytesIO(storage.data[key])) as small:
        assert small.format == "PNG"
        assert max(small.size) <= logo_service.MAX_OUTPUT_DIM


def test_over_10_mb_is_refused_with_the_new_limit_in_words(storage):
    raw = b"\x89PNG\r\n\x1a\n" + b"0" * logo_service.MAX_LOGO_BYTES
    with pytest.raises(HTTPException) as exc:
        logo_service.upload_logo(uuid.uuid4(), raw)
    assert exc.value.status_code == 413
    assert "10 MB" in exc.value.detail
    assert storage.puts == []


def test_a_webp_logo_is_accepted_and_stored_as_png(storage):
    raw = _encode(Image.new("RGBA", (400, 200), (10, 20, 30, 128)), "WEBP")
    assert raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"
    key, _ = logo_service.upload_logo(uuid.uuid4(), raw)
    assert key.endswith(".png")
    assert storage.puts[0][2] == "image/png"


def test_webp_gets_the_pixel_ceiling_without_the_2x_slack(storage, monkeypatch):
    # 400x200 = 80,000 px. With the ceiling at 50,000: a PNG may use the 2x
    # slack (100,000) and passes; a WebP may not and is refused before decode.
    monkeypatch.setattr(logo_service, "MAX_DECODE_PIXELS", 50_000)
    img = Image.new("RGB", (400, 200), (200, 100, 50))
    logo_service.upload_logo(uuid.uuid4(), _encode(img, "PNG"))
    with pytest.raises(HTTPException) as exc:
        logo_service.upload_logo(uuid.uuid4(), _encode(img, "WEBP"))
    assert exc.value.status_code == 415
    assert len(storage.puts) == 1


@pytest.mark.parametrize("raw", [
    b"GIF89a" + b"\x00" * 64,
    b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    b"RIFF\x00\x00\x00\x00WAVEfmt " + b"\x00" * 32,
])
def test_gif_svg_and_other_riff_files_are_still_refused(storage, raw):
    with pytest.raises(HTTPException) as exc:
        logo_service.upload_logo(uuid.uuid4(), raw)
    assert exc.value.status_code == 415
    assert storage.puts == []
