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

