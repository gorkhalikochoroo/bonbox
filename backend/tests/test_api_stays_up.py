"""R-d "Keep the API up" — the single API process keeps answering while
AI / OCR calls are in flight (OPS-02 / P0-3).

Production runs ONE uvicorn worker. Before R-d, scan_z_report,
smart-scan classify, the receipt scans and the Copilot stream were
`async def` and called the synchronous Anthropic / OCR clients directly,
so every venue's requests stopped for the whole vendor round-trip
(reproduced: /api/health 3.7 s late behind a 4 s call).

What is pinned here:
  * /api/health answers in < 200 ms while a fake 2 s blocking vision read
    (Z-report) or model call (Copilot stream) is in flight;
  * the Copilot stream still streams (text reaches the client before the
    next model call finishes);
  * the Copilot tool loop stops after MAX_TOOL_ROUNDS with an honest
    message in the owner's language;
  * at most 4 vision reads run at once; a 5th waits, then gets a 503
    "busy, try again" in the owner's language — before anything is stored;
  * every Anthropic client is built with a bounded timeout and 1 retry.

The timing tests are built so a regression cannot pass by accident: the
fake records when it really started and finished, and the health request
must both be SENT after the fake started and COMPLETE before it finished.
If the call blocked the event loop, health could only run after it.

Run:
  cd backend && python -m pytest tests/test_api_stays_up.py -q
"""
from __future__ import annotations

import asyncio
import inspect
import io
import json
import pathlib
import random
import sys
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
from app.routers import agent as agent_router
from app.routers import daily_close as daily_close_router
from app.services import ai_limits
from app.services.auth import get_current_user, hash_password

_db_ready.set()

HEALTH_BUDGET_S = 0.2
SLOW_CALL_S = 2.0


# ─── Fixtures ────────────────────────────────────────────────────────

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
    """Route requests through the in-memory DB as the given owner."""
    holder: dict = {}

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    app.dependency_overrides[get_current_user] = lambda: holder["user"]

    def _set(user):
        holder["user"] = user

    yield _set
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)


def _owner(db, *, ui_language: str | None = None, currency: str = "DKK") -> User:
    u = User(
        id=str(uuid.uuid4()),
        email=f"{uuid.uuid4().hex[:10]}@cafe-example.dk",
        password_hash=hash_password("pw123456"),
        business_name="Venue", business_type="cafe", currency=currency,
        plan="free", role="owner", email_verified=True,
        ui_language=ui_language,
    )
    db.add(u)
    db.commit()
    return u


def _ip() -> dict:
    """A fresh client IP per request so these tests never share a
    rate-limit bucket with the rest of the suite."""
    return {"CF-Connecting-IP": f"10.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}"}


def _jpeg_bytes(fmt: str = "JPEG", **save_kw) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (40, 60), "white").save(buf, fmt, **save_kw)
    return buf.getvalue()


class _SlowCall:
    """A blocking call that records when it really ran."""

    def __init__(self, seconds: float, result):
        self.seconds = seconds
        self.result = result
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self.calls = 0

    def __call__(self, *args, **kwargs):
        self.calls += 1
        self.started_at = time.perf_counter()
        time.sleep(self.seconds)  # blocking on purpose — like the real SDKs
        self.finished_at = time.perf_counter()
        return self.result() if callable(self.result) else self.result


async def _health_while(slow: _SlowCall, start_slow_request, *, settle_s: float = 0.4):
    """Start the slow request, then hit /api/health while it is in flight.

    Returns (health_response, sent_at, done_at, slow_response)."""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        task = asyncio.create_task(start_slow_request(c))
        planned = time.perf_counter() + settle_s
        # Wait (cooperatively) until the slow call has started, at most 1.5 s.
        while slow.started_at is None and time.perf_counter() < planned + 1.5:
            await asyncio.sleep(0.01)
        delay = planned - time.perf_counter()
        if delay > 0:
            await asyncio.sleep(delay)
        sent_at = time.perf_counter()
        health = await c.get("/api/health", headers=_ip())
        done_at = time.perf_counter()
        slow_resp = await task
    return health, sent_at, done_at, slow_resp


def _assert_health_answered_during(slow: _SlowCall, health, sent_at: float, done_at: float):
    assert health.status_code == 200, health.text
    assert slow.started_at is not None, "the slow call never ran"
    assert slow.started_at < sent_at, "health was sent before the slow call started"
    assert done_at < slow.finished_at, (
        "health only answered AFTER the blocking call finished — the event loop was blocked"
    )
    assert done_at - sent_at < HEALTH_BUDGET_S, f"health took {done_at - sent_at:.3f}s"


# ─── 1. Z-report scan: health stays fast during a blocking vision read ──

def test_health_answers_fast_while_a_z_report_scan_is_being_read(db, as_user, monkeypatch):
    u = _owner(db)
    as_user(u)
    slow = _SlowCall(SLOW_CALL_S, lambda: {"doc_type": "receipt", "revenue": 100.0})
    monkeypatch.setattr(daily_close_router, "parse_z_report", slow)
    monkeypatch.setattr(
        daily_close_router, "save_receipt_photo_ex",
        lambda *a, **k: ("uploads/receipts/fake.jpg", "/nonexistent/fake.jpg"),
    )

    async def scan(c):
        return await c.post(
            "/api/daily-close/scan-report",
            files={"file": ("z.jpg", _jpeg_bytes(), "image/jpeg")},
            headers=_ip(),
        )

    health, sent_at, done_at, scan_resp = asyncio.run(_health_while(slow, scan))
    _assert_health_answered_during(slow, health, sent_at, done_at)
    assert scan_resp.status_code == 200, scan_resp.text
    assert slow.calls == 1


# ─── 2. Copilot stream: health stays fast, and the stream still streams ─

class _Block:
    def __init__(self, type_, **kw):
        self.type = type_
        for k, v in kw.items():
            setattr(self, k, v)


class _Resp:
    def __init__(self, blocks):
        self.content = blocks
        self.usage = types.SimpleNamespace(input_tokens=10, output_tokens=5)
        self.model = "fake-model"


def _install_fake_anthropic(monkeypatch, create):
    """sys.modules['anthropic'] → a fake whose client records its kwargs."""
    built: list[dict] = []

    class _Client:
        def __init__(self, **kwargs):
            built.append(kwargs)
            self.messages = types.SimpleNamespace(create=create)

    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=_Client))
    return built


def _enable_claude(monkeypatch):
    monkeypatch.setattr(agent_router.settings, "ANTHROPIC_API_KEY", "test-key", raising=False)
    monkeypatch.setattr(agent_router.settings, "USE_CLAUDE_API", True, raising=False)


def _sse_events(text: str) -> list[tuple[str, dict]]:
    out = []
    for chunk in text.split("\n\n"):
        lines = chunk.strip().split("\n")
        if len(lines) >= 2 and lines[0].startswith("event: ") and lines[1].startswith("data: "):
            out.append((lines[0][7:], json.loads(lines[1][6:])))
    return out


def _streamed_text(events) -> str:
    return "".join(d.get("delta", "") for e, d in events if e == "text")


def test_health_answers_fast_while_the_copilot_waits_on_the_model(db, as_user, monkeypatch):
    u = _owner(db)
    as_user(u)
    _enable_claude(monkeypatch)
    slow = _SlowCall(SLOW_CALL_S, lambda: _Resp([_Block("text", text="Omsætningen ser fin ud.")]))
    built = _install_fake_anthropic(monkeypatch, slow)

    async def chat(c):
        return await c.post("/api/agent/chat", json={"message": "hvordan går det?", "history": []}, headers=_ip())

    health, sent_at, done_at, chat_resp = asyncio.run(_health_while(slow, chat))
    _assert_health_answered_during(slow, health, sent_at, done_at)
    assert chat_resp.status_code == 200
    events = _sse_events(chat_resp.text)
    assert _streamed_text(events) == "Omsætningen ser fin ud."
    assert events[-1][0] == "done"
    # The client was built bounded: 30 s, one SDK retry.
    assert built and built[0]["timeout"] == ai_limits.AI_TIMEOUT_S == 30.0
    assert built[0]["max_retries"] == ai_limits.AI_MAX_RETRIES == 1


def test_the_copilot_stream_still_streams_text_before_the_next_model_call_ends(db, as_user, monkeypatch):
    """Round 1 answers text + a tool call; round 2 takes 1 s. The round-1
    text must reach the client ~1 s before the stream ends — i.e. the
    response is streamed, not buffered until the end."""
    u = _owner(db)
    as_user(u)
    _enable_claude(monkeypatch)
    monkeypatch.setitem(agent_router.TOOL_MAP, "business_overview", lambda db, uid: {"ok": True})
    calls = {"n": 0}

    def create(**kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return _Resp([
                _Block("text", text="Jeg slår det op."),
                _Block("tool_use", name="business_overview", input={}, id="t1"),
            ])
        time.sleep(1.0)
        return _Resp([_Block("text", text=" Færdig.")])

    _install_fake_anthropic(monkeypatch, create)

    chunks: list[tuple[float, bytes]] = []

    async def recording_app(scope, receive, send):
        async def rec_send(message):
            if message.get("type") == "http.response.body" and message.get("body"):
                chunks.append((time.perf_counter(), message["body"]))
            await send(message)
        await app(scope, receive, rec_send)

    async def run():
        transport = httpx.ASGITransport(app=recording_app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            return await c.post("/api/agent/chat", json={"message": "status?", "history": []}, headers=_ip())

    resp = asyncio.run(run())
    assert resp.status_code == 200
    assert _streamed_text(_sse_events(resp.text)) == "Jeg slår det op. Færdig."
    first_text_at = next(t for t, b in chunks if b"event: text" in b)
    last_at = chunks[-1][0]
    assert last_at - first_text_at > 0.8, "the stream was buffered, not streamed"


# ─── 3. Copilot tool loop cap ───────────────────────────────────────

def _always_wants_a_tool(counter):
    def create(**kwargs):
        counter["n"] += 1
        return _Resp([_Block("tool_use", name="business_overview", input={}, id=f"t{counter['n']}")])
    return create


@pytest.mark.parametrize("ui_language,expected", [
    (None, agent_router._TOOL_CAP_TEXT["da"]),   # DKK account, no app choice yet → Danish
    ("da", agent_router._TOOL_CAP_TEXT["da"]),
    ("en", agent_router._TOOL_CAP_TEXT["en"]),
])
def test_the_copilot_stops_after_4_tool_rounds_with_an_honest_message(db, as_user, monkeypatch, ui_language, expected):
    u = _owner(db, ui_language=ui_language)
    as_user(u)
    _enable_claude(monkeypatch)
    tool_runs = {"n": 0}

    def fake_tool(db, uid):
        tool_runs["n"] += 1
        return {"ok": True}

    monkeypatch.setitem(agent_router.TOOL_MAP, "business_overview", fake_tool)
    model_calls = {"n": 0}
    _install_fake_anthropic(monkeypatch, _always_wants_a_tool(model_calls))

    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            return await c.post("/api/agent/chat", json={"message": "alt", "history": []}, headers=_ip())

    resp = asyncio.run(run())
    assert resp.status_code == 200
    events = _sse_events(resp.text)
    assert agent_router.MAX_TOOL_ROUNDS == 4
    assert tool_runs["n"] == 4, "exactly 4 rounds of tools run"
    assert model_calls["n"] == 5, "the 5th answer asked for a 5th round and was stopped"
    assert sum(1 for e, _ in events if e == "tool_result") == 4
    assert sum(1 for e, _ in events if e == "tool_call") == 4, "the refused 5th round is not announced"
    assert _streamed_text(events) == expected
    assert events[-1][0] == "done"


# ─── 4. At most 4 vision reads at once; a 5th gets a clear 503 ───────

def test_at_most_four_vision_reads_run_at_once():
    active = {"now": 0, "max": 0}
    lock = threading.Lock()

    def read():
        with ai_limits.vision_slot():
            with lock:
                active["now"] += 1
                active["max"] = max(active["max"], active["now"])
            time.sleep(0.3)
            with lock:
                active["now"] -= 1

    threads = [threading.Thread(target=read) for _ in range(7)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert active["max"] == ai_limits.VISION_MAX_CONCURRENT == 4
    assert active["now"] == 0


@pytest.fixture
def all_vision_slots_taken(monkeypatch):
    monkeypatch.setattr(ai_limits, "VISION_WAIT_S", 0.2)
    taken = 0
    for _ in range(ai_limits.VISION_MAX_CONCURRENT):
        assert ai_limits._vision_slots.acquire(timeout=5)
        taken += 1
    try:
        yield
    finally:
        for _ in range(taken):
            ai_limits._vision_slots.release()


@pytest.mark.parametrize("ui_language,expected_lang", [(None, "da"), ("en", "en")])
def test_a_fifth_scan_gets_busy_503_before_anything_is_stored(
    db, as_user, monkeypatch, all_vision_slots_taken, ui_language, expected_lang,
):
    u = _owner(db, ui_language=ui_language)
    as_user(u)
    stored = []
    monkeypatch.setattr(daily_close_router, "save_receipt_photo_ex", lambda *a, **k: stored.append(a) or ("x", "y"))
    monkeypatch.setattr(daily_close_router, "parse_z_report", lambda p: pytest.fail("must not read"))

    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            return await c.post(
                "/api/daily-close/scan-report",
                files={"file": ("z.jpg", _jpeg_bytes(), "image/jpeg")},
                headers=_ip(),
            )

    resp = asyncio.run(run())
    assert resp.status_code == 503
    assert resp.json()["detail"] == ai_limits.busy_message(expected_lang)
    assert resp.json()["code"] == "ai_busy"
    assert resp.headers.get("retry-after") == str(ai_limits.BUSY_RETRY_AFTER_S)
    assert stored == [], "busy must be refused before the photo is stored"


def test_the_busy_message_survives_the_production_5xx_sanitizer(db, as_user, monkeypatch, all_vision_slots_taken):
    """In prod every other 5xx detail becomes 'Something went wrong'. The
    busy 503 has its own handler so the owner reads the real reason."""
    import app.main as main_mod

    monkeypatch.setattr(main_mod, "is_prod", True)
    u = _owner(db)
    as_user(u)

    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            return await c.post(
                "/api/daily-close/scan-report",
                files={"file": ("z.jpg", _jpeg_bytes(), "image/jpeg")},
                headers=_ip(),
            )

    resp = asyncio.run(run())
    assert resp.status_code == 503
    assert resp.json()["detail"] == ai_limits.busy_message("da")


def test_the_async_slot_waits_without_blocking_the_event_loop(monkeypatch, all_vision_slots_taken):
    monkeypatch.setattr(ai_limits, "VISION_WAIT_S", 0.3)
    ticks = {"n": 0}

    async def ticker():
        while True:
            ticks["n"] += 1
            await asyncio.sleep(0.02)

    async def run():
        t = asyncio.create_task(ticker())
        with pytest.raises(ai_limits.AIBusyError):
            async with ai_limits.vision_slot_async():
                pass
        t.cancel()

    asyncio.run(run())
    assert ticks["n"] >= 5, "the event loop kept running while the slot was awaited"


# ─── 5. Every Anthropic client is bounded ───────────────────────────

def test_anthropic_client_defaults_to_30s_and_one_retry(monkeypatch):
    built = _install_fake_anthropic(monkeypatch, lambda **k: None)
    ai_limits.anthropic_client("k")
    ai_limits.anthropic_client("k", timeout=45.0)
    assert built[0] == {"api_key": "k", "timeout": 30.0, "max_retries": 1}
    assert built[1] == {"api_key": "k", "timeout": 45.0, "max_retries": 1}


# app/routers/onboarding.py is owned by another branch and could not be
# changed in R-d; it still builds an unbounded client. Remove it from this
# set once it calls ai_limits.anthropic_client like everything else.
_KNOWN_UNBOUNDED = {"app/routers/onboarding.py"}


def test_no_anthropic_client_is_built_outside_the_bounded_factory():
    """Any `<x>.Anthropic(...)` / `Anthropic(...)` call in app/ outside
    ai_limits.py would be a client with the SDK's 600 s / 2-retry defaults."""
    import ast

    root = pathlib.Path(__file__).resolve().parents[1]
    offenders = []
    for path in sorted((root / "app").rglob("*.py")):
        rel = path.relative_to(root).as_posix()
        if rel == "app/services/ai_limits.py":
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            name = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", None)
            if name in ("Anthropic", "AsyncAnthropic"):
                offenders.append(f"{rel}:{node.lineno}")
    unexpected = [o for o in offenders if o.split(":")[0] not in _KNOWN_UNBOUNDED]
    assert unexpected == []
    # The known exception is still there (so this set is not stale).
    assert {o.split(":")[0] for o in offenders} == _KNOWN_UNBOUNDED


# ─── 6. The AI / OCR routes no longer run on the event loop ─────────

_OFF_LOOP_ROUTES = [
    ("POST", "/api/daily-close/scan-report"),
    ("POST", "/api/smart-scan/classify"),
    ("POST", "/api/kasserapport/extract"),
    ("POST", "/api/expenses/parse-receipt"),
    ("POST", "/api/expenses/upload-receipt"),
    ("POST", "/api/expenses/burst-scan"),
    ("POST", "/api/expenses/{expense_id}/attach-receipt"),
    ("POST", "/api/sales/upload-receipt"),
    ("POST", "/api/competitors/{competitor_id}/scan-menu"),
    ("POST", "/api/inventory/smart-import/file"),
    ("POST", "/api/business/logo"),
    ("POST", "/api/agent/chat"),
]


@pytest.mark.parametrize("method,path", _OFF_LOOP_ROUTES)
def test_ai_and_ocr_routes_are_sync_so_fastapi_runs_them_in_the_threadpool(method, path):
    matches = [
        r for r in app.routes
        if getattr(r, "path", None) == path and method in getattr(r, "methods", set())
    ]
    assert matches, f"route {method} {path} not found"
    for r in matches:
        assert not inspect.iscoroutinefunction(r.endpoint), (
            f"{method} {path} is async again — its blocking AI/OCR calls would freeze the event loop"
        )
