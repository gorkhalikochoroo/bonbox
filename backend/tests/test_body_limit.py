"""R-d INFRA-02 — the request-body cap counts the bytes actually received.

The old cap trusted Content-Length, so a chunked body (which has none)
skipped it, and FastAPI parses form bodies before any auth check. Now the
bytes are counted as they arrive, and urlencoded forms are capped at 64 KB.

Run:
  cd backend && python -m pytest tests/test_body_limit.py -q
"""

from __future__ import annotations

import asyncio
import io
import random
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
from app.services.auth import get_current_user, hash_password
from app.utils.body_limit import MAX_BODY_BYTES, MAX_URLENCODED_BYTES, BodySizeLimitMiddleware

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


def _img(fmt: str, **kw) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (32, 48), (240, 240, 240)).save(buf, fmt, **kw)
    return buf.getvalue()


def _post(path: str, **kw):
    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            return await c.post(path, **kw)
    return asyncio.run(run())


# ─── INFRA-02: the body cap counts real bytes ───────────────────────

def _chunks(total: int, size: int = 64 * 1024):
    async def gen():
        sent = 0
        while sent < total:
            n = min(size, total - sent)
            sent += n
            yield b"a" * n
    return gen()


def test_a_chunked_body_over_10mb_is_cut_off_without_content_length():
    r = _post(
        "/api/billing/stripe/webhook",
        content=_chunks(MAX_BODY_BYTES + 256 * 1024),
        headers={"Content-Type": "application/json", **_ip()},
    )
    assert r.status_code == 413
    assert "too large" in r.json()["detail"]


def test_a_declared_content_length_over_10mb_is_refused_at_once():
    r = _post(
        "/api/billing/stripe/webhook",
        content=b"a" * (MAX_BODY_BYTES + 1),
        headers={"Content-Type": "application/json", **_ip()},
    )
    assert r.status_code == 413
    assert r.json() == {
        "detail": "Request body too large (max 10 MB)", "_error": True, "_recoverable": False,
    }


def test_a_chunked_urlencoded_body_over_64kb_is_refused():
    r = _post(
        "/api/billing/stripe/webhook",
        content=_chunks(MAX_URLENCODED_BYTES + 1024, size=8 * 1024),
        headers={"Content-Type": "application/x-www-form-urlencoded", **_ip()},
    )
    assert MAX_URLENCODED_BYTES == 64 * 1024
    assert r.status_code == 413


def test_a_small_urlencoded_body_is_not_capped():
    r = _post(
        "/api/billing/stripe/webhook",
        content=_chunks(32 * 1024, size=8 * 1024),
        headers={"Content-Type": "application/x-www-form-urlencoded", **_ip()},
    )
    assert r.status_code != 413


def test_a_normal_photo_upload_is_not_capped(db, as_user, monkeypatch):
    u = _owner(db)
    as_user(u)
    monkeypatch.setattr(daily_close_router, "parse_z_report", lambda p: {"doc_type": "receipt"})
    monkeypatch.setattr(
        daily_close_router, "save_receipt_photo_ex",
        lambda *a, **k: ("uploads/receipts/f.jpg", "/nonexistent/f.jpg"),
    )
    big_jpeg = _img("JPEG", quality=100) + b"\x00" * (4 * 1024 * 1024)  # ~4 MB, under every cap
    r = _post(
        "/api/daily-close/scan-report",
        files={"file": ("z.jpg", big_jpeg, "image/jpeg")},
        headers=_ip(),
    )
    assert r.status_code == 200, r.text


def test_the_body_cap_wraps_every_layer_inside_cors():
    names = [m.cls for m in app.user_middleware]
    # user_middleware[0] is the outermost layer.
    assert names[0].__name__ == "CORSMiddleware"
    assert names[1] is BodySizeLimitMiddleware
    assert names.count(BodySizeLimitMiddleware) == 1


def test_the_middleware_counts_chunks_when_no_content_length_is_sent():
    """Standalone: a tiny app behind the middleware (limit 1 KB) sees the
    request without Content-Length and is stopped mid-body with a 413."""
    seen = {"headers": None, "bytes": 0}

    async def inner(scope, receive, send):
        seen["headers"] = dict(scope["headers"])
        while True:
            msg = await receive()
            seen["bytes"] += len(msg.get("body", b""))
            if not msg.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    mw = BodySizeLimitMiddleware(inner, max_body_bytes=1024, max_urlencoded_bytes=512)

    async def run(content, ctype="application/octet-stream"):
        transport = httpx.ASGITransport(app=mw)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            return await c.post("/", content=content, headers={"Content-Type": ctype})

    r = asyncio.run(run(_chunks(4096, size=256)))
    assert b"content-length" not in seen["headers"]
    assert r.status_code == 413
    assert seen["bytes"] <= 1024 + 256  # stopped at the chunk that crossed the limit

    seen["bytes"] = 0
    r = asyncio.run(run(_chunks(1000, size=100)))
    assert r.status_code == 200 and seen["bytes"] == 1000

    r = asyncio.run(run(_chunks(600, size=100), ctype="application/x-www-form-urlencoded"))
    assert r.status_code == 413


# ─── R-d fix-up: a real 413 on routes FastAPI parses itself ─────────
#
# Behind the @app.middleware("http") layers anyio wraps the overflow in an
# ExceptionGroup, and FastAPI's body reader then answered a generic 400
# "There was an error parsing the body" on every JSON / form / multipart
# route (only routes that read request.body() themselves saw the 413).

def _chunked_multipart(total: int, boundary: str = "bonboxboundary"):
    head = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="z.jpg"\r\n'
        "Content-Type: image/jpeg\r\n\r\n"
    ).encode() + b"\xff\xd8\xff\xe0"

    async def gen():
        yield head
        sent = len(head)
        while sent < total:
            n = min(64 * 1024, total - sent)
            sent += n
            yield b"a" * n
        yield f"\r\n--{boundary}--\r\n".encode()
    return gen()


def test_a_chunked_photo_upload_over_10mb_gets_413_and_the_route_never_runs(db, as_user, monkeypatch):
    u = _owner(db)
    as_user(u)
    monkeypatch.setattr(daily_close_router, "parse_z_report", lambda p: pytest.fail("route ran"))
    monkeypatch.setattr(
        daily_close_router, "save_receipt_photo_ex", lambda *a, **k: pytest.fail("route ran"),
    )
    r = _post(
        "/api/daily-close/scan-report",
        content=_chunked_multipart(MAX_BODY_BYTES + 512 * 1024),
        headers={"Content-Type": "multipart/form-data; boundary=bonboxboundary", **_ip()},
    )
    assert r.status_code == 413, r.text
    assert r.json()["detail"] == "Request body too large (max 10 MB)"


def test_a_chunked_json_body_over_10mb_gets_413_on_a_parsed_route():
    r = _post(
        "/api/auth/login",
        content=_chunks(MAX_BODY_BYTES + 256 * 1024),
        headers={"Content-Type": "application/json", **_ip()},
    )
    assert r.status_code == 413, r.text


def test_a_chunked_urlencoded_body_over_64kb_gets_413_on_a_parsed_route():
    r = _post(
        "/api/auth/login",
        content=_chunks(MAX_URLENCODED_BYTES + 1024, size=8 * 1024),
        headers={"Content-Type": "application/x-www-form-urlencoded", **_ip()},
    )
    assert r.status_code == 413, r.text



# ─── Push 2: the inbound-mail webhook has the inbox's own 30 MB cap ─
#
# Postmark posts a forwarded receipt mail with its attachments base64-encoded
# (4/3 the size). At the general 10 MB, a mail with ~7 MB of attachments got
# a 413 before the inbox's own 30 MB check and silently never landed. Only
# POST /api/inbox/postmark-webhook gets 30 MB; bytes are still counted
# (chunked included); every other route keeps 10 MB.

from app.routers import inbox as inbox_router  # noqa: E402

_WEBHOOK = "/api/inbox/postmark-webhook"
_MB = 1024 * 1024


@pytest.fixture
def inbox_on(monkeypatch, as_user):
    """INBOX_ENABLED with Postmark creds; the pipeline replaced by a stub
    that records how many body bytes reached the handler."""
    from app.config import settings
    monkeypatch.setenv("INBOX_ENABLED", "true")
    monkeypatch.setenv("POSTMARK_INBOUND_USER", "test")
    monkeypatch.setenv("POSTMARK_INBOUND_PASS", "test")
    monkeypatch.setattr(settings, "INBOX_ENABLED", True, raising=False)
    monkeypatch.setattr(settings, "POSTMARK_INBOUND_USER", "test", raising=False)
    monkeypatch.setattr(settings, "POSTMARK_INBOUND_PASS", "test", raising=False)
    lim = getattr(inbox_router, "limiter", None)
    if lim is not None:
        lim.reset()
    seen: list[int] = []

    def _stub(db, payload, **k):
        seen.append(len(payload.get("TextBody") or ""))
        return {"status": "stub"}

    monkeypatch.setattr(inbox_router, "_process_inbound_email", _stub)
    yield seen
    if lim is not None:
        lim.reset()


def _basic() -> dict:
    import base64
    return {"Authorization": "Basic " + base64.b64encode(b"test:test").decode("ascii")}


def _json_body(total: int) -> bytes:
    """A JSON object of exactly `total` bytes: {"TextBody": "aaaa…"}."""
    head, tail = b'{"TextBody": "', b'"}'
    return head + b"a" * (total - len(head) - len(tail)) + tail


def _json_chunks(total: int, size: int = 256 * 1024):
    body = _json_body(total)

    async def gen():
        for i in range(0, len(body), size):
            yield body[i:i + size]
    return gen()


def test_the_inbound_mail_cap_is_the_inboxs_own_30mb():
    assert inbox_router.MAX_BODY_BYTES == 30 * _MB
    mw = next(m for m in app.user_middleware if m.cls is BodySizeLimitMiddleware)
    assert mw.kwargs["max_body_bytes"] == 10 * _MB
    assert mw.kwargs["route_limits"] == {("POST", _WEBHOOK): inbox_router.MAX_BODY_BYTES}
    # The path in the override is the real webhook route.
    assert any(getattr(r, "path", None) == _WEBHOOK and "POST" in getattr(r, "methods", ())
               for r in app.routes)


@pytest.mark.parametrize("chunked", [False, True])
def test_a_25mb_inbound_mail_reaches_the_webhook(inbox_on, chunked):
    total = 25 * _MB
    content = _json_chunks(total) if chunked else _json_body(total)
    r = _post(_WEBHOOK, content=content,
              headers={"Content-Type": "application/json", **_basic(), **_ip()})
    assert r.status_code == 200, r.text[:300]
    assert r.json() == {"ok": True, "status": "stub"}
    assert inbox_on == [total - len(b'{"TextBody": ""}')], "the whole body reached the handler"


@pytest.mark.parametrize("chunked", [False, True])
def test_a_31mb_inbound_mail_gets_413_and_the_pipeline_never_runs(inbox_on, chunked):
    total = 31 * _MB
    content = _json_chunks(total) if chunked else _json_body(total)
    r = _post(_WEBHOOK, content=content,
              headers={"Content-Type": "application/json", **_basic(), **_ip()})
    assert r.status_code == 413, r.text[:300]
    assert r.json()["detail"] == "Request body too large (max 30 MB)"
    assert inbox_on == []


def test_other_routes_keep_10mb_even_under_the_inbox_prefix(inbox_on, db, as_user):
    as_user(_owner(db))
    body = _json_body(11 * _MB)
    for path in ("/api/billing/stripe/webhook", "/api/inbox/test",
                 _WEBHOOK + "/", _WEBHOOK + "-x"):
        r = _post(path, content=body, headers={"Content-Type": "application/json", **_basic(), **_ip()})
        assert r.status_code == 413, (path, r.status_code)
        assert r.json()["detail"] == "Request body too large (max 10 MB)", path
    # Chunked, too.
    r = _post("/api/inbox/test", content=_json_chunks(11 * _MB),
              headers={"Content-Type": "application/json", **_ip()})
    assert r.status_code == 413
    # Another method on the webhook path keeps the general cap.
    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            return await c.put(_WEBHOOK, content=body,
                               headers={"Content-Type": "application/json", **_ip()})
    assert asyncio.run(run()).status_code == 413
    assert inbox_on == []


def test_an_urlencoded_body_to_the_webhook_is_still_64kb(inbox_on):
    r = _post(_WEBHOOK, content=_chunks(MAX_URLENCODED_BYTES + 1024, size=8 * 1024),
              headers={"Content-Type": "application/x-www-form-urlencoded", **_basic(), **_ip()})
    assert r.status_code == 413
    assert inbox_on == []


def test_the_middleware_route_override_is_exact_and_per_method():
    async def inner(scope, receive, send):
        while True:
            msg = await receive()
            if not msg.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    mw = BodySizeLimitMiddleware(inner, max_body_bytes=1024, max_urlencoded_bytes=512,
                                 route_limits={("post", "/big"): 4096})

    async def run(path, content, method="POST", ctype="application/octet-stream"):
        transport = httpx.ASGITransport(app=mw)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            return await c.request(method, path, content=content, headers={"Content-Type": ctype})

    assert asyncio.run(run("/big", _chunks(3000, size=100))).status_code == 200
    assert asyncio.run(run("/big", _chunks(5000, size=100))).status_code == 413
    assert asyncio.run(run("/big", b"a" * 5000)).status_code == 413
    assert asyncio.run(run("/big", _chunks(3000, size=100), method="PUT")).status_code == 413
    assert asyncio.run(run("/big/", _chunks(3000, size=100))).status_code == 413
    assert asyncio.run(run("/other", _chunks(3000, size=100))).status_code == 413
    assert asyncio.run(run("/big", _chunks(600, size=100),
                           ctype="application/x-www-form-urlencoded")).status_code == 413
