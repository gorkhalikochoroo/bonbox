"""R-d fix-up — the paid-AI plan caps and the shared vision slots hold
when requests arrive in parallel.

R-d moved the AI / OCR routes into FastAPI's threadpool (OPS-02). Each
capped route counts today's uses, runs the 0.3–60 s paid read, and only
THEN writes the row that counts. On the event loop that check → read →
write ran atomically; in the threadpool, parallel requests all passed the
check before any of them wrote, so a Free account could run 16 paid reads
against a cap of 10 (reproduced). What is pinned here:

  * the Free cap holds EXACTLY under 16 / 8 parallel requests on every
    route whose counting row is written after the read: smart-scan
    classify, kasserapport extract, inventory smart-import /file and the
    receipt pile (burst-scan) — no extra paid read, and no false refusal;
  * one account holds at most VISION_MAX_PER_USER of the 4 vision slots,
    so another venue's Z-report still gets a slot;
  * the burst pile takes a slot per receipt, not for the whole pile;
  * a request waiting for a slot / holding one through the model call
    has handed its pooled DB connection back.

The databases here are files with real connection pools (not one shared
in-memory connection), so the threads behave as they do on Postgres.

Run:
  cd backend && python -m pytest tests/test_ai_caps_concurrency.py -q
"""
from __future__ import annotations

import asyncio
import contextlib
import io
import random
import threading
import time
import types
import uuid

import httpx
import pytest
from fastapi import Depends
from PIL import Image
from sqlalchemy import create_engine, func, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool, QueuePool

from app import models as _all_models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.expense import Expense
from app.models.user import User
from app.routers import expenses as expenses_router
from app.routers import inventory_smart_import as inventory_router
from app.routers import kasserapport as kasserapport_router
from app.routers import smart_scan as smart_scan_router
from app.services import ai_limits
from app.services import receipt_ocr
from app.services.auth import get_current_user, hash_password
from app.services.kasserapport_extractor import KasserapportResult

_db_ready.set()


# ─── Fixtures / helpers ─────────────────────────────────────────────

def _file_sessionmaker(tmp_path, **engine_kw):
    engine = create_engine(
        f"sqlite:///{tmp_path / f'caps-{uuid.uuid4().hex[:8]}.db'}",
        connect_args={"check_same_thread": False, "timeout": 30},
        **engine_kw,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autocommit=False, autoflush=False)


def _new_owner(SL, *, plan: str = "free", ui_language: str | None = "da") -> str:
    s = SL()
    try:
        u = User(
            id=str(uuid.uuid4()),
            email=f"{uuid.uuid4().hex[:10]}@cafe-example.dk",
            password_hash=hash_password("pw123456"),
            business_name="Venue", business_type="cafe", currency="DKK",
            plan=plan, role="owner", email_verified=True, ui_language=ui_language,
        )
        s.add(u)
        s.commit()
        return str(u.id)
    finally:
        s.close()


@contextlib.contextmanager
def _serving(SL, user_id: str):
    """Route requests through SL as this owner — the user is loaded on the
    request's own session, exactly like the real get_current_user."""

    def _db():
        s = SL()
        try:
            yield s
        finally:
            s.close()

    def _user(db: Session = Depends(get_db)):
        return db.query(User).filter(User.id == user_id).first()

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _user
    try:
        yield
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)


def _ip(i: int = 0) -> dict:
    return {"CF-Connecting-IP": f"10.{random.randint(0, 255)}.{i % 250}.{random.randint(1, 254)}"}


def _jpeg(seed: int = 0) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (40, 60), (200, seed % 256, (seed * 7) % 256)).save(buf, "JPEG")
    return buf.getvalue()


def _parallel(n: int, make_request):
    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver", timeout=60) as c:
            return await asyncio.gather(*[make_request(c, i) for i in range(n)])
    return asyncio.run(run())


class _CountingRead:
    """A blocking paid read that counts its calls (thread-safe)."""

    def __init__(self, seconds: float, result):
        self.seconds = seconds
        self.result = result
        self.calls = 0
        self._lock = threading.Lock()

    def __call__(self, *args, **kwargs):
        with self._lock:
            self.calls += 1
        time.sleep(self.seconds)
        return self.result() if callable(self.result) else self.result


# ─── 1. The Free caps hold exactly under parallel requests ───────────

def test_smart_scan_classify_free_cap_holds_under_16_parallel_requests(tmp_path, monkeypatch):
    SL = _file_sessionmaker(tmp_path, poolclass=NullPool)
    uid = _new_owner(SL)
    read = _CountingRead(0.3, lambda: {
        "doc_type": "receipt", "confidence": 0.9, "route_to": "/expenses",
        "route_label": "expense", "extracted_data": {}, "fallback_used": None,
        "file_size_kb": 1, "verify_hints": [],
    })
    monkeypatch.setattr(smart_scan_router, "route_and_extract", read)

    with _serving(SL, uid):
        rs = _parallel(16, lambda c, i: c.post(
            "/api/smart-scan/classify",
            files={"file": ("r.jpg", _jpeg(i), "image/jpeg")}, headers=_ip(i),
        ))

    codes = sorted(r.status_code for r in rs)
    cap = 10  # PLAN_CAPS["free"]["smart_scan_classify_per_day"]
    assert read.calls == cap, f"Free cap is {cap}/day but {read.calls} paid reads ran ({codes})"
    assert codes == [200] * cap + [402] * (16 - cap), codes


def test_kasserapport_extract_free_cap_holds_under_8_parallel_requests(tmp_path, monkeypatch):
    SL = _file_sessionmaker(tmp_path, poolclass=NullPool)
    uid = _new_owner(SL)
    read = _CountingRead(0.3, lambda: KasserapportResult(
        document_type="kasserapport", pos_system="unknown", data={"totals": {}},
        tokens_used={"input": 1, "output": 1},
    ))
    monkeypatch.setattr(kasserapport_router, "extract_kasserapport_full", read)

    with _serving(SL, uid):
        rs = _parallel(8, lambda c, i: c.post(
            "/api/kasserapport/extract",
            files={"file": ("z.jpg", _jpeg(i), "image/jpeg")}, headers=_ip(i),
        ))

    codes = sorted(r.status_code for r in rs)
    cap = 3  # PLAN_CAPS["free"]["kasse_extracts_per_day"]
    assert read.calls == cap, f"{read.calls} paid reads ran ({codes})"
    assert codes == [200] * cap + [429] * (8 - cap), codes


def test_inventory_smart_import_file_free_quota_holds_under_8_parallel_requests(tmp_path, monkeypatch):
    SL = _file_sessionmaker(tmp_path, poolclass=NullPool)
    uid = _new_owner(SL)
    read = _CountingRead(0.3, lambda: {
        "line_items": [{"name": "Mælk", "qty": 1, "unit": "l", "unit_cost": 10.0}],
        "supplier": None, "invoice_totals": None, "confidence": {"overall": 0.9},
    })
    monkeypatch.setattr(inventory_router, "extract_inventory_data", read)
    monkeypatch.setattr(inventory_router, "categorize_items", lambda items, bt: (items, {}))

    with _serving(SL, uid):
        rs = _parallel(8, lambda c, i: c.post(
            "/api/inventory/smart-import/file",
            files={"file": ("f.jpg", _jpeg(i), "image/jpeg")},
            data={"source_kind": "image"}, headers=_ip(i),
        ))

    codes = sorted(r.status_code for r in rs)
    cap = 3  # PLAN_CAPS["free"]["smart_imports_per_day"]
    assert read.calls == cap, f"{read.calls} paid reads ran ({codes})"
    assert codes == [201] * cap + [429] * (8 - cap), codes


def _fake_receipt_io(monkeypatch, *, read_s: float = 0.05):
    stored: list[str] = []
    lock = threading.Lock()

    def save(raw, filename, user_id, kind="expense"):
        with lock:
            stored.append(filename)
        return f"uploads/receipts/{uuid.uuid4().hex}.jpg", "/nonexistent.jpg"

    read = _CountingRead(read_s, lambda: {"vendor": "Netto", "amount": 42.0, "date": None})
    monkeypatch.setattr(receipt_ocr, "save_receipt_photo_ex", save)
    monkeypatch.setattr(receipt_ocr, "parse_expense_receipt", read)
    return stored, read


def test_two_parallel_receipt_piles_never_pass_the_free_monthly_cap(tmp_path, monkeypatch):
    SL = _file_sessionmaker(tmp_path, poolclass=NullPool)
    uid = _new_owner(SL)
    _stored, read = _fake_receipt_io(monkeypatch)

    with _serving(SL, uid):
        rs = _parallel(2, lambda c, i: c.post(
            "/api/expenses/burst-scan",
            files=[("files", (f"r{i}-{k}.jpg", _jpeg(i * 10 + k), "image/jpeg")) for k in range(8)],
            headers=_ip(i),
        ))

    assert [r.status_code for r in rs] == [200, 200], [r.text for r in rs]
    cap = 10  # PLAN_CAPS["free"]["expense_receipt_scans_per_month"]
    s = SL()
    try:
        drafts = s.query(func.count(Expense.id)).filter(Expense.user_id == uid).scalar()
    finally:
        s.close()
    assert drafts == cap, f"two piles together booked {drafts} scans against a cap of {cap}"
    assert read.calls == cap
    assert sum(r.json()["created"] for r in rs) == cap
    assert any(r.json()["cap_reached"] for r in rs)


def test_counted_use_reserves_until_the_counting_row_is_recorded():
    user = types.SimpleNamespace(id="acct-1")
    committed = {"n": 0}
    cap = 2

    def check(in_flight):
        if committed["n"] + in_flight >= cap:
            raise RuntimeError("cap")

    with ai_limits.counted_use(user, "k", check) as a:
        with ai_limits.counted_use(user, "k", check) as b:
            # Two reads in flight, nothing committed yet: a third is refused.
            with pytest.raises(RuntimeError):
                with ai_limits.counted_use(user, "k", check):
                    pass
            with b.recording():
                committed["n"] += 1
            assert b.reserved == 0
        # a failed read (no row) gives its reservation back
    assert ai_limits._cap_entries == {}
    with ai_limits.counted_use(user, "k", check):
        pass  # 1 committed + 0 in flight < 2
    assert ai_limits._cap_entries == {}


# ─── 2. One account cannot hold every vision slot ───────────────────

def test_one_account_holds_at_most_two_of_the_four_vision_slots(monkeypatch):
    monkeypatch.setattr(ai_limits, "VISION_WAIT_S", 0.2)
    a = types.SimpleNamespace(id="venue-a", ui_language="da")
    b = types.SimpleNamespace(id="venue-b", ui_language="en")
    c = types.SimpleNamespace(id="venue-c", ui_language="en")
    # 4 (was 3 while a read's ~390 MB decode was bounded only by these slots): every decode
    # now holds one of image_guard's 2 decode slots, so 4 reads + 2 decodes fit 2 GB (ai_limits).
    assert ai_limits.VISION_MAX_PER_USER == 2 < ai_limits.VISION_MAX_CONCURRENT == 4
    with ai_limits.vision_slot(a), ai_limits.vision_slot(a):
        with pytest.raises(ai_limits.AIBusyError):
            with ai_limits.vision_slot(a):
                pass
        # another venue still gets its reads — two, and no third
        with ai_limits.vision_slot(b), ai_limits.vision_slot(b):
            with pytest.raises(ai_limits.AIBusyError):
                with ai_limits.vision_slot(b):
                    pass
            # all four process-wide slots are taken now: a third venue waits, then 503
            with pytest.raises(ai_limits.AIBusyError):
                with ai_limits.vision_slot(c):
                    pass
    with ai_limits.vision_slot(a):
        pass
    assert ai_limits._user_slots == {}


def test_the_async_slot_also_caps_one_account(monkeypatch):
    monkeypatch.setattr(ai_limits, "VISION_WAIT_S", 0.2)
    a = types.SimpleNamespace(id="venue-a")

    async def run():
        # VISION_MAX_PER_USER is 2: the 3rd read of one account waits, then 503
        async with ai_limits.vision_slot_async(a), ai_limits.vision_slot_async(a):
            with pytest.raises(ai_limits.AIBusyError):
                async with ai_limits.vision_slot_async(a):
                    pass
            async with ai_limits.vision_slot_async(types.SimpleNamespace(id="venue-b")):
                pass

    asyncio.run(run())
    assert ai_limits._user_slots == {}


# ─── 3. The receipt pile takes a slot per receipt ───────────────────

def _counting_slot(monkeypatch, *, busy_on: set[int] | None = None):
    entered = {"n": 0}
    real = ai_limits.vision_slot

    @contextlib.contextmanager
    def slot(user=None, **kw):
        entered["n"] += 1
        if busy_on and entered["n"] in busy_on:
            raise ai_limits.AIBusyError("da")
        with real(user, **kw):
            yield

    monkeypatch.setattr(expenses_router, "vision_slot", slot)
    return entered


def test_the_pile_takes_one_slot_per_receipt_not_one_for_the_whole_pile(tmp_path, monkeypatch):
    SL = _file_sessionmaker(tmp_path, poolclass=NullPool)
    uid = _new_owner(SL, plan="pro")
    _stored, read = _fake_receipt_io(monkeypatch)
    entered = _counting_slot(monkeypatch)
    with _serving(SL, uid):
        (r,) = _parallel(1, lambda c, i: c.post(
            "/api/expenses/burst-scan",
            files=[("files", (f"r{k}.jpg", _jpeg(k), "image/jpeg")) for k in range(3)],
            headers=_ip(i),
        ))
    assert r.status_code == 200, r.text
    assert entered["n"] == 3 and read.calls == 3 and r.json()["created"] == 3


def test_a_busy_slot_mid_pile_still_stores_the_receipt_as_an_unread_draft(tmp_path, monkeypatch):
    SL = _file_sessionmaker(tmp_path, poolclass=NullPool)
    uid = _new_owner(SL, plan="pro")
    stored, read = _fake_receipt_io(monkeypatch)
    _counting_slot(monkeypatch, busy_on={2})
    with _serving(SL, uid):
        (r,) = _parallel(1, lambda c, i: c.post(
            "/api/expenses/burst-scan",
            files=[("files", (f"r{k}.jpg", _jpeg(k), "image/jpeg")) for k in range(3)],
            headers=_ip(i),
        ))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] == 3, "no receipt may be dropped"
    assert len(stored) == 3 and read.calls == 2
    amounts = sorted(d["amount"] for d in body["drafts"])
    assert amounts == [0, 42.0, 42.0], "the unread one lands as 'Mangler beløb'"


def test_a_busy_slot_on_the_first_receipt_is_a_retryable_503_with_nothing_stored(tmp_path, monkeypatch):
    SL = _file_sessionmaker(tmp_path, poolclass=NullPool)
    uid = _new_owner(SL, plan="pro")
    stored, read = _fake_receipt_io(monkeypatch)
    _counting_slot(monkeypatch, busy_on={1})
    with _serving(SL, uid):
        (r,) = _parallel(1, lambda c, i: c.post(
            "/api/expenses/burst-scan",
            files=[("files", (f"r{k}.jpg", _jpeg(k), "image/jpeg")) for k in range(3)],
            headers=_ip(i),
        ))
    assert r.status_code == 503 and r.json()["code"] == "ai_busy"
    assert stored == [] and read.calls == 0


# ─── 4. The pooled DB connection is handed back during the read ─────

def test_a_scan_in_flight_does_not_hold_a_pooled_db_connection(tmp_path, monkeypatch):
    """Pool of ONE connection: while the classify read runs, another
    request's session must still be able to get it. Before the fix the
    route's session kept it (opened by get_current_user + the cap count)
    for the whole read, so this probe timed out."""
    SL = _file_sessionmaker(
        tmp_path, poolclass=QueuePool, pool_size=1, max_overflow=0, pool_timeout=1,
    )
    uid = _new_owner(SL)
    probe = {"ok": None}

    def read(raw, **kw):
        s = SL()
        try:
            probe["ok"] = s.execute(text("SELECT 1")).scalar() == 1
        except Exception as e:  # noqa: BLE001
            probe["ok"] = f"{type(e).__name__}: {e}"
        finally:
            s.close()
        return {
            "doc_type": "receipt", "confidence": 0.9, "route_to": "/expenses",
            "route_label": "expense", "extracted_data": {}, "fallback_used": None,
            "file_size_kb": 1, "verify_hints": [],
        }

    monkeypatch.setattr(smart_scan_router, "route_and_extract", read)
    with _serving(SL, uid):
        (r,) = _parallel(1, lambda c, i: c.post(
            "/api/smart-scan/classify",
            files={"file": ("r.jpg", _jpeg(1), "image/jpeg")}, headers=_ip(i),
        ))
    assert probe["ok"] is True, probe["ok"]
    assert r.status_code == 200, r.text


def test_the_connection_is_never_released_over_pending_or_flushed_writes(tmp_path):
    SL = _file_sessionmaker(tmp_path, poolclass=NullPool)
    uid = _new_owner(SL)
    s = SL()
    try:
        u = s.query(User).filter(User.id == uid).first()
        assert ai_limits.release_db_connection(s) is True
        assert u.business_name == "Venue"  # still loaded, no expiry
        u.business_name = "Changed"
        assert ai_limits.release_db_connection(s) is False  # dirty: keep
        s.flush()
        assert ai_limits.release_db_connection(s) is False  # flushed: keep
        s.rollback()
        assert ai_limits.release_db_connection(s) is True
    finally:
        s.close()
    s = SL()
    try:
        assert s.query(User).filter(User.id == uid).first().business_name == "Venue"
    finally:
        s.close()
