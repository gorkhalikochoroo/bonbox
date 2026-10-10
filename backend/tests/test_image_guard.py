"""R-d INFRA-03 — uploaded photos are decoded only as allow-listed formats.

The magic bytes are checked before any Pillow decoder runs, and the decode
itself is restricted to the allow-list. Before R-d a PSD renamed
receipt.jpg was opened with every Pillow plugin enabled (Pillow 11.1.0 had
heap-overflow advisories in the PSD decoder, among others). Every format
the product accepts today must still work.

Run:
  cd backend && python -m pytest tests/test_image_guard.py -q
"""

from __future__ import annotations

import asyncio
import io
import random
import struct
import uuid

import httpx
import pytest
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.user import User
from app.routers import daily_close as daily_close_router
from app.routers import expenses as expenses_router
from app.services import image_guard, receipt_ocr
from app.services.auth import get_current_user, hash_password

_db_ready.set()


# ─── Fixtures / helpers ─────────────────────────────────────────────

@pytest.fixture
def SessionLocal():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture
def db(SessionLocal):
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def as_user(SessionLocal):
    holder: dict = {}

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    app.dependency_overrides[get_current_user] = lambda: holder["user"]
    yield lambda u: holder.__setitem__("user", u)
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)


def _owner(db, *, ui_language: str | None = None) -> User:
    u = User(
        id=str(uuid.uuid4()),
        email=f"{uuid.uuid4().hex[:10]}@cafe-example.dk",
        password_hash=hash_password("pw123456"),
        business_name="Venue", business_type="cafe", currency="DKK",
        plan="free", role="owner", email_verified=True, ui_language=ui_language,
    )
    db.add(u)
    db.commit()
    return u


def _ip() -> dict:
    return {"CF-Connecting-IP": f"10.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}"}


def _psd() -> bytes:
    """A real 2x2 RGB Photoshop file. Pillow (11.1 and 12.3) decodes it."""
    h = b"8BPS" + struct.pack(">H", 1) + b"\x00" * 6 + struct.pack(">HIIHH", 3, 2, 2, 8, 3)
    h += struct.pack(">I", 0) + struct.pack(">I", 0) + struct.pack(">I", 0)
    h += struct.pack(">H", 0)
    return h + bytes([200] * 4) + bytes([10] * 4) + bytes([10] * 4)


def _img(fmt: str, **kw) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (32, 48), (240, 240, 240)).save(buf, fmt, **kw)
    return buf.getvalue()


def _mpo() -> bytes:
    buf = io.BytesIO()
    a, b = Image.new("RGB", (32, 48), "white"), Image.new("RGB", (32, 48), "gray")
    a.save(buf, "MPO", save_all=True, append_images=[b])
    return buf.getvalue()


def _post(path: str, **kw):
    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            return await c.post(path, **kw)
    return asyncio.run(run())


@pytest.fixture
def local_receipts(tmp_path, monkeypatch):
    """save_receipt_photo_ex writes to a temp dir and never to Supabase."""
    monkeypatch.setattr(receipt_ocr, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(receipt_ocr, "_upload_to_supabase", lambda *a, **k: None)
    return tmp_path


# ─── INFRA-03: magic bytes + allow-listed decode ────────────────────

def test_the_minimal_psd_really_is_a_decodable_photoshop_file():
    # Guards the guard test: without the allow-list Pillow WOULD decode it.
    im = Image.open(io.BytesIO(_psd()))
    assert im.format == "PSD"


@pytest.mark.parametrize("fmt,raw", [
    ("JPEG", _img("JPEG")),
    ("PNG", _img("PNG")),
    ("WEBP", _img("WEBP")),
    ("HEIF", _img("HEIF")),
    ("GIF", _img("GIF")),
    ("BMP", _img("BMP")),
    ("TIFF", _img("TIFF")),
    ("JPEG", _mpo()),   # iPhone multi-picture JPEG: opened by the JPEG decoder
])
def test_every_format_the_product_accepts_today_still_saves(local_receipts, fmt, raw):
    assert image_guard.sniff_image_format(raw) == fmt
    stored, local = receipt_ocr.save_receipt_photo_ex(raw, "r.jpg", "u1", kind="expense")
    assert stored == local
    with Image.open(local) as im:
        assert im.format == "JPEG"  # re-encoded, as before


@pytest.mark.parametrize("raw", [
    _psd(),
    b"%PDF-1.7\n" + b"x" * 64,
    b"PK\x03\x04" + b"\x00" * 64,           # zip
    b"SIMPLE  =                    T" + b" " * 64,  # FITS
    b"\x00\x00\x00\x18ftypavif" + b"\x00" * 64,      # AVIF (never decodable here)
    b"",
])
def test_non_allow_listed_bytes_are_refused_before_any_decoder(local_receipts, monkeypatch, raw):
    opened = []
    real_open = Image.open
    monkeypatch.setattr(Image, "open", lambda *a, **k: opened.append(a) or real_open(*a, **k))
    with pytest.raises(image_guard.UnsupportedImageError) as ei:
        receipt_ocr.save_receipt_photo_ex(raw, "receipt.jpg", "u1", kind="expense")
    assert isinstance(ei.value, ValueError)  # every existing `except ValueError` still catches it
    assert opened == [], "Pillow was asked to open a refused file"
    assert list(local_receipts.iterdir()) == []


def test_open_upload_image_refuses_a_psd_even_from_a_path(tmp_path):
    p = tmp_path / "x.jpg"
    p.write_bytes(_psd())
    with pytest.raises(image_guard.UnsupportedImageError):
        image_guard.open_upload_image(p)


def test_the_decode_allow_list_has_no_mpo_key_and_excludes_psd():
    # Pillow has no "MPO" opener key (passing it raises KeyError); JPEG
    # covers MPO. PSD/FITS are exactly what the allow-list keeps out.
    assert "MPO" not in image_guard.UPLOAD_IMAGE_FORMATS
    for bad in ("PSD", "FITS", "PCX", "EPS", "ICO", "SGI", "TGA"):
        assert bad not in image_guard.UPLOAD_IMAGE_FORMATS


@pytest.mark.parametrize("ui_language,lang", [(None, "da"), ("en", "en")])
def test_a_psd_renamed_jpg_is_refused_on_the_z_report_scan(db, as_user, monkeypatch, ui_language, lang):
    u = _owner(db, ui_language=ui_language)
    as_user(u)
    monkeypatch.setattr(daily_close_router, "parse_z_report", lambda p: pytest.fail("must not read"))
    r = _post(
        "/api/daily-close/scan-report",
        files={"file": ("z-rapport.jpg", _psd(), "image/jpeg")},
        headers=_ip(),
    )
    assert r.status_code == 400
    assert r.json()["detail"] == image_guard.refusal_message(lang)


def test_a_psd_renamed_jpg_is_refused_on_the_expense_receipt_scan(db, as_user, monkeypatch):
    u = _owner(db)
    as_user(u)
    monkeypatch.setattr(expenses_router, "parse_expense_receipt", lambda p: pytest.fail("must not read"))
    r = _post(
        "/api/expenses/parse-receipt",
        files={"file": ("kvittering.jpg", _psd(), "image/jpeg")},
        headers=_ip(),
    )
    assert r.status_code == 400
    assert r.json()["detail"] == image_guard.refusal_message("da")


def test_a_psd_renamed_jpg_is_refused_on_the_expense_upload(db, as_user, local_receipts):
    u = _owner(db)
    as_user(u)
    r = _post(
        "/api/expenses/upload-receipt",
        files={"file": ("kvittering.jpg", _psd(), "image/jpeg")},
        headers=_ip(),
    )
    assert r.status_code == 400
    assert r.json()["detail"] == image_guard.refusal_message("da")
    assert list(local_receipts.iterdir()) == []


def test_a_real_jpeg_still_goes_through_the_z_report_scan(db, as_user, local_receipts, monkeypatch):
    u = _owner(db)
    as_user(u)
    seen = []
    monkeypatch.setattr(daily_close_router, "parse_z_report", lambda p: seen.append(p) or {"doc_type": "receipt"})
    r = _post(
        "/api/daily-close/scan-report",
        files={"file": ("z.jpg", _img("JPEG"), "image/jpeg")},
        headers=_ip(),
    )
    assert r.status_code == 200, r.text
    assert len(seen) == 1
