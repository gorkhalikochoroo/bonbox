"""R-d round 3 — chat and profile photos: the decode gate, a 25 MP PNG
ceiling and a reduced JPEG decode; and no decode site outside the gate.

Measured under Linux, 1 CPU / 2 GB, no swap (10 Oct): a 214 KB 50 MP RGBA PNG
through sanitize_chat_photo peaked at 766 MB (the canvas, a convert() copy,
a white canvas and split() into four bands, all at full size); two at once
1.6 GB, three at once OOM-killed the instance. Anyone with a staff link can
post three photos a message. What is pinned here:

  * chat and profile photos hold the decode gate; busy is a 503 with a clear
    Danish "try again" (and Retry-After), before any message row is written;
  * a PNG is decoded in full only up to 25 MP — above it is refused before
    anything is decoded; a JPEG keeps the 50 MP ceiling and is decoded at a
    reduced scale, so a 48 MP phone photo still goes through (chat 1600 px,
    avatar 512 px) and decodes at 2016x1512 / 1008x756, not 8064x6048;
  * transparency is still flattened onto white;
  * every app module that opens an image with Pillow goes through the gate.

Run:
  cd backend && python -m pytest tests/test_chat_photo_decode.py -q
"""

from __future__ import annotations

import io
import pathlib
import random
import re
import uuid

import pytest
from fastapi import HTTPException
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.user import User
from app.services import chat_image, image_guard
from app.services.auth import hash_password

_db_ready.set()

APP_DIR = pathlib.Path(__file__).resolve().parents[1] / "app"


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


def _owner(db) -> User:
    u = User(
        id=str(uuid.uuid4()),
        email=f"{uuid.uuid4().hex[:10]}@cafe-example.dk",
        password_hash=hash_password("pw123456"),
        business_name="Venue", business_type="cafe", currency="DKK",
        plan="free", role="owner", email_verified=True,
    )
    db.add(u)
    db.commit()
    return u


def _ip() -> dict:
    return {"CF-Connecting-IP": f"10.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}"}


def _img(fmt: str, size=(64, 48), mode="RGB", color=(240, 240, 240), **kw) -> bytes:
    buf = io.BytesIO()
    if mode == "RGBA" and len(color) == 3:
        color = (*color, 128)
    Image.new(mode, size, color).save(buf, fmt, **kw)
    return buf.getvalue()


@pytest.fixture
def all_decode_slots_taken(monkeypatch):
    monkeypatch.setattr(image_guard, "DECODE_WAIT_S", 0.2)
    taken = 0
    for _ in range(image_guard.DECODE_MAX_CONCURRENT):
        assert image_guard._decode_slots.acquire(timeout=5)
        taken += 1
    try:
        yield
    finally:
        for _ in range(taken):
            image_guard._decode_slots.release()


@pytest.fixture
def no_decoder(monkeypatch):
    from PIL import ImageFile

    def boom(self, *a, **k):  # pragma: no cover - must not run
        raise AssertionError("an image was decoded without a decode slot")

    monkeypatch.setattr(ImageFile.ImageFile, "load", boom)


# ─── 1. The decode gate ─────────────────────────────────────────────

@pytest.mark.parametrize("fn_name", ["sanitize_chat_photo", "sanitize_profile_photo"])
def test_chat_and_profile_photos_refuse_busy_with_a_clear_try_again(all_decode_slots_taken, no_decoder, fn_name):
    with pytest.raises(HTTPException) as ei:
        getattr(chat_image, fn_name)(_img("PNG"))
    assert ei.value.status_code == 503
    assert "Prøv igen" in ei.value.detail
    assert ei.value.headers.get("Retry-After")


def test_the_portal_chat_photo_answers_try_again_and_writes_no_message(SessionLocal, db, all_decode_slots_taken):
    from fastapi.testclient import TestClient

    from app.models.staff import StaffChatMessage, StaffLink, StaffMember
    from app.routers import staff_chat as sc

    sc._limiter.reset()
    owner = _owner(db)
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name="Agnes", role="server")
    db.add(m)
    db.commit()
    token = f"tok-{uuid.uuid4().hex[:8]}"
    db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=m.id, token=token, active=True))
    db.commit()

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    try:
        r = TestClient(app).post(
            f"/api/portal/{token}/chat/photos",
            files=[("photos", ("a.png", _img("PNG"), "image/png"))],
            headers=_ip(),
        )
    finally:
        app.dependency_overrides.pop(get_db, None)
        sc._limiter.reset()
    assert r.status_code == 503, r.text
    assert "Prøv igen" in r.json()["detail"]
    assert r.headers.get("retry-after")
    assert db.query(StaffChatMessage).count() == 0


def test_every_module_that_decodes_an_upload_goes_through_the_gate():
    """A new decode site must not bypass the gate: any app module that
    opens an image with Pillow (Image.open / open_upload_image) must use
    decode_slot. The PDF builders only embed the already-sanitised logo
    (reportlab), never an upload."""
    offenders = []
    for path in APP_DIR.rglob("*.py"):
        if path.name == "image_guard.py":
            continue
        src = path.read_text(encoding="utf-8")
        if re.search(r"\bImage\.open\(|\bopen_upload_image\(", src) and "decode_slot(" not in src:
            offenders.append(str(path.relative_to(APP_DIR)))
    assert offenders == []


# ─── 2. The chat sanitizer: 25 MP for PNG, phone JPEGs reduced ──────

def test_the_chat_png_ceiling_is_25_mp_and_the_jpeg_ceiling_stays_50_mp():
    assert chat_image._MAX_FULL_DECODE_PIXELS == 25_000_000
    assert chat_image._MAX_DECODED_PIXELS == 50_000_000 >= 8160 * 6120  # Samsung 50 MP


@pytest.mark.parametrize("fn_name,msg", [
    ("sanitize_chat_photo", "Billedet har for mange pixels."),
    ("sanitize_profile_photo", "Billedet har for høj opløsning."),
])
def test_a_png_over_25_mp_is_refused_before_it_is_decoded(monkeypatch, fn_name, msg):
    # 5001 x 5001 = 25.01 MP, RGBA: a few KB on the wire, 100 MB decoded.
    raw = _img("PNG", size=(5001, 5001), mode="RGBA", color=(255, 0, 0, 0))
    from PIL import ImageFile

    loads = []
    real_load = ImageFile.ImageFile.load
    monkeypatch.setattr(ImageFile.ImageFile, "load", lambda self: loads.append(1) or real_load(self))
    with pytest.raises(HTTPException) as ei:
        getattr(chat_image, fn_name)(raw)
    assert ei.value.status_code == 413
    assert ei.value.detail == msg
    assert loads == [], "nothing may be decoded before the refusal"


def test_an_rgba_png_under_the_ceiling_is_flattened_onto_white_as_before():
    raw = _img("PNG", size=(1200, 800), mode="RGBA", color=(0, 0, 0, 0))  # fully transparent
    data, ctype, _sha = chat_image.sanitize_chat_photo(raw)
    assert ctype == "image/jpeg"
    out = Image.open(io.BytesIO(data))
    assert out.size == (1200, 800)
    assert min(out.convert("L").getextrema()) >= 250  # white, not black


def test_a_48_mp_phone_jpeg_goes_through_chat_and_profile_decoded_reduced(monkeypatch):
    """iPhone 48 MP = 8064 x 6048. It must still work everywhere it worked,
    and the decoder must run at a reduced scale (draft), not 146 MB of RGB."""
    raw = _img("JPEG", size=(8064, 6048), color=(200, 210, 220), quality=60)
    from PIL import ImageFile

    loaded_sizes = []
    real_load = ImageFile.ImageFile.load

    def spy(self):
        loaded_sizes.append(self.size)
        return real_load(self)

    monkeypatch.setattr(ImageFile.ImageFile, "load", spy)
    data, _, _ = chat_image.sanitize_chat_photo(raw)
    assert Image.open(io.BytesIO(data)).size == (1600, 1200)
    assert loaded_sizes and loaded_sizes[0] == (2016, 1512)

    loaded_sizes.clear()
    data, _, _ = chat_image.sanitize_profile_photo(raw)
    assert Image.open(io.BytesIO(data)).size == (512, 512)
    assert loaded_sizes and loaded_sizes[0] == (1008, 756)


