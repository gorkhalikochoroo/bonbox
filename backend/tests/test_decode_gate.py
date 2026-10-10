"""R-d round 3 — one decode gate for every user-supplied photo decode.

Measured under Linux, 1 CPU / 2 GB, no swap (10 Oct): one decode of a 48 MP
phone photo peaks at ~340-390 MB. Before this gate only the vision slots
bounded them (3 at once), and the receipt save after a busy 503, the
attach-receipt upload, chat / profile photos and the logo decoded outside
any limit. What is pinned here:

  * at most ``DECODE_MAX_CONCURRENT`` (2) decodes run at once, process-wide;
    a 3rd waits, then gets ``DecodeBusyError`` — an ``AIBusyError``, so the
    usual 503 "busy, try again" in the owner's language;
  * the decode sites hold the gate: the OCR / vision reads (receipt,
    Z-report, kasserapport, inventory), the receipt save, the logo — with
    every slot taken, each one refuses instead of decoding (and none falls
    back to sending the raw file). Chat + profile photos and the sweep over
    every module: tests/test_chat_photo_decode.py;
  * a refused decode inside a vision read ends the read as busy even when
    the OCR chain swallows the error, and the read's later decodes fail at
    once instead of each waiting again;
  * routes answer 503 BEFORE anything is stored (the attach-receipt upload,
    in the owner's language);
  * the OCR reads decode a JPEG at the smallest scale that still covers the
    ~2000 px they send.

Run:
  cd backend && python -m pytest tests/test_decode_gate.py -q
"""

from __future__ import annotations

import asyncio
import io
import random
import threading
import time
import types
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
from app.services import ai_limits, image_guard, receipt_ocr
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


def _post(path: str, **kw):
    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            return await c.post(path, **kw)
    return asyncio.run(run())


def _img(fmt: str, size=(64, 48), mode="RGB", color=(240, 240, 240), **kw) -> bytes:
    buf = io.BytesIO()
    if mode == "RGBA" and len(color) == 3:
        color = (*color, 128)
    Image.new(mode, size, color).save(buf, fmt, **kw)
    return buf.getvalue()


@pytest.fixture
def local_receipts(tmp_path, monkeypatch):
    monkeypatch.setattr(receipt_ocr, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(receipt_ocr, "_upload_to_supabase", lambda *a, **k: None)
    return tmp_path


@pytest.fixture
def all_decode_slots_taken(monkeypatch):
    """Every decode slot held by 'someone else'; waits are short."""
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
    """Fails the test if any Pillow decode starts."""
    from PIL import ImageFile

    def boom(self, *a, **k):  # pragma: no cover - must not run
        raise AssertionError("an image was decoded without a decode slot")

    monkeypatch.setattr(ImageFile.ImageFile, "load", boom)


# ─── 1. The gate itself ─────────────────────────────────────────────

def test_at_most_two_decodes_run_at_once():
    active = {"now": 0, "max": 0}
    lock = threading.Lock()

    def decode():
        with image_guard.decode_slot():
            with lock:
                active["now"] += 1
                active["max"] = max(active["max"], active["now"])
            time.sleep(0.2)
            with lock:
                active["now"] -= 1

    threads = [threading.Thread(target=decode) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    # 2: one 48 MP decode peaks at ~390 MB (Linux, 10 Oct); 2 at once stay under ~0.8 GB.
    assert active["max"] == image_guard.DECODE_MAX_CONCURRENT == 2
    assert active["now"] == 0


@pytest.mark.parametrize("lang", ["da", "en"])
def test_a_third_decode_waits_then_gets_the_busy_error_in_the_owners_language(all_decode_slots_taken, lang):
    t0 = time.monotonic()
    with pytest.raises(image_guard.DecodeBusyError) as ei:
        with image_guard.decode_slot(lang=lang):
            pytest.fail("must not decode")
    waited = time.monotonic() - t0
    assert 0.15 <= waited < 2.0, waited
    assert isinstance(ei.value, ai_limits.AIBusyError)  # → the 503 handler in main.py
    assert str(ei.value) == ai_limits.busy_message(lang)


def test_the_decode_gate_is_separate_from_the_vision_slots():
    """4 vision reads (vendor calls) and 2 decodes: the decode gate is its own
    semaphore, so a read waiting on the vendor never holds a decode slot."""
    assert ai_limits.VISION_MAX_CONCURRENT == 4
    assert ai_limits.VISION_MAX_PER_USER == 2
    assert image_guard._decode_slots is not ai_limits._vision_slots
    with ai_limits.vision_slot(), ai_limits.vision_slot(), ai_limits.vision_slot(), ai_limits.vision_slot():
        with image_guard.decode_slot(), image_guard.decode_slot():
            pass


# ─── 2. Every decode site holds the gate ────────────────────────────

def test_the_receipt_save_refuses_busy_before_anything_is_written(all_decode_slots_taken, local_receipts, no_decoder):
    with pytest.raises(image_guard.DecodeBusyError):
        receipt_ocr.save_receipt_photo_ex(_img("JPEG"), "r.jpg", str(uuid.uuid4()), kind="expense")
    assert list(local_receipts.iterdir()) == []


def test_the_ocr_read_refuses_busy_and_never_falls_back_to_the_raw_file(all_decode_slots_taken, tmp_path, no_decoder):
    p = tmp_path / "r.jpg"
    p.write_bytes(_img("JPEG"))
    with pytest.raises(image_guard.DecodeBusyError):
        receipt_ocr._image_to_base64_jpeg(str(p))
    from app.services import claude_vision_ocr

    with pytest.raises(image_guard.DecodeBusyError):
        claude_vision_ocr._image_to_base64_jpeg_for_vision(str(p))


def test_the_kasserapport_and_inventory_reads_refuse_busy(all_decode_slots_taken, tmp_path, no_decoder):
    from app.services import inventory_ocr, kasserapport_extractor

    p = tmp_path / "k.png"
    p.write_bytes(_img("PNG"))
    with pytest.raises(image_guard.DecodeBusyError):
        kasserapport_extractor._image_to_base64_jpeg(str(p))
    with pytest.raises(image_guard.DecodeBusyError):
        inventory_ocr._image_bytes_to_base64_jpeg(_img("PNG"))
    # The full kasserapport pipeline does not log it as an unreadable image.
    with pytest.raises(ai_limits.AIBusyError):
        kasserapport_extractor.extract_kasserapport_full(str(p), skip_classifier=True)


def test_the_logo_refuses_busy(all_decode_slots_taken, no_decoder):
    # An AIBusyError, not an HTTPException 503: main.py's busy handler answers
    # it (503 + Retry-After) and the production 5xx sanitizer leaves it alone;
    # the upload route re-raises it in the owner's language
    # (test_chat_photo_decode: test_busy_photo_refusals_survive_...).
    from app.services import logo_service

    with pytest.raises(ai_limits.AIBusyError):
        logo_service._strip_and_optimize(_img("PNG"), "png")


# ─── 3. A refused decode inside a vision read ───────────────────────

def test_a_swallowed_busy_decode_still_ends_the_read_as_busy_and_later_decodes_fail_fast(all_decode_slots_taken):
    owner = types.SimpleNamespace(id="venue-a", ui_language="en")
    attempts = []
    with pytest.raises(ai_limits.AIBusyError) as ei:
        with ai_limits.vision_slot(owner):
            # An OCR chain that falls through to the next provider on ANY error.
            for _provider in range(4):
                t0 = time.monotonic()
                try:
                    with image_guard.decode_slot():
                        pytest.fail("must not decode")
                except Exception:  # noqa: BLE001 — what the OCR chains do
                    attempts.append(time.monotonic() - t0)
    assert str(ei.value) == ai_limits.busy_message("en")
    assert len(attempts) == 4
    assert attempts[0] >= 0.15  # the first one waited its turn ...
    assert max(attempts[1:]) < 0.05  # ... the rest of the read did not wait again
    # The next read starts clean.
    with ai_limits.vision_slot(owner):
        pass


def test_a_read_whose_decodes_were_not_refused_is_untouched():
    with ai_limits.vision_slot(types.SimpleNamespace(id="v", ui_language="da")):
        with image_guard.decode_slot():
            pass
    assert not ai_limits.current_read_refused()


# ─── 4. Routes: 503 before anything is stored ───────────────────────

@pytest.mark.parametrize("ui_language,lang", [(None, "da"), ("en", "en")])
def test_attach_receipt_answers_busy_503_in_the_owners_language_and_stores_nothing(
    db, as_user, local_receipts, all_decode_slots_taken, ui_language, lang,
):
    from app.models.expense import Expense, ExpenseCategory

    u = _owner(db, ui_language=ui_language)
    as_user(u)
    cat = ExpenseCategory(id=uuid.uuid4(), user_id=u.id, name="Varer")
    db.add(cat)
    db.commit()
    import datetime as _dt

    e = Expense(id=uuid.uuid4(), user_id=u.id, category_id=cat.id, amount=100, date=_dt.date.today(), description="x")
    db.add(e)
    db.commit()
    r = _post(
        f"/api/expenses/{e.id}/attach-receipt",
        files={"file": ("k.jpg", _img("JPEG"), "image/jpeg")},
        headers=_ip(),
    )
    assert r.status_code == 503, r.text
    assert r.json()["code"] == "ai_busy"
    assert r.json()["detail"] == ai_limits.busy_message(lang)
    assert r.headers.get("retry-after")
    assert list(local_receipts.iterdir()) == []
    db.refresh(e)
    assert e.receipt_photo is None


# ─── 5. The OCR reads decode a JPEG reduced ─────────────────────────

def test_open_upload_image_decodes_a_jpeg_at_the_smallest_scale_that_covers_max_side():
    big = _img("JPEG", size=(4032, 3024))
    img = image_guard.open_upload_image(big, max_side=1000)
    assert img.size == (1008, 756)  # 1/4 — still >= 1000 on the long side
    img.load()
    # Without max_side (the stored receipt photo) it is decoded in full.
    assert image_guard.open_upload_image(big).size == (4032, 3024)
    # A format without a reduced decode is untouched (decoded in full).
    assert image_guard.open_upload_image(_img("PNG", size=(4032, 3024)), max_side=1000).size == (4032, 3024)


def test_the_ocr_read_still_sends_2000_px(tmp_path):
    p = tmp_path / "r.jpg"
    p.write_bytes(_img("JPEG", size=(8064, 6048), quality=60))
    import base64

    b64 = receipt_ocr._image_to_base64_jpeg(str(p))
    out = Image.open(io.BytesIO(base64.b64decode(b64)))
    assert out.size == (2000, 1500)
