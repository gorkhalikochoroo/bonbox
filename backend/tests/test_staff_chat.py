"""
Owner ↔ staff 1:1 chat ("Beskeder") — staff_chat.py.

Coverage:
  1. Owner sends → staffer reads it via their token
  2. Staffer replies → owner sees it + unread count, then read clears it
  3. Idempotent send (same client_msg_id → one message, not two)
  4. Tenant isolation — owner B can't read owner A's thread (404 on foreign staff_id)
  5. Cross-token isolation — a staffer's token only ever reaches their own thread
  6. Empty body rejected (422)
  7. sender_type is server-set (a body claiming sender_type is ignored)

Run:
  cd backend && python3 -m pytest tests/test_staff_chat.py -x -q
"""

import io
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember, StaffLink
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    return engine, SessionLocal


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    from app.routers import staff_chat as sc

    sc._limiter.reset()
    yield
    sc._limiter.reset()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user):
    if user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = lambda: user


def _owner(db, *, suffix=""):
    u = User(
        email=f"owner{suffix}@bonbox.dk",
        password_hash=hash_password("ownerpw123"),
        business_name=f"Bon Bakery{suffix}",
        business_type="cafe",
        currency="DKK",
        plan="pro",
        role="owner",
        timezone="Europe/Copenhagen",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _staff(db, owner, *, name="Agnes", token="tok_agnes"):
    s = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role="server")
    db.add(s)
    db.commit()
    db.refresh(s)
    link = StaffLink(
        id=uuid.uuid4(), user_id=owner.id, staff_id=s.id, token=token, active=True
    )
    db.add(link)
    db.commit()
    return s, token


# ─── Tests ────────────────────────────────────────────────────────────


def test_owner_sends_staff_reads(client, db):
    owner = _owner(db)
    staff, token = _staff(db, owner)
    _override_user(owner)

    r = client.post(f"/api/staff/chat/threads/{staff.id}", json={"body": "Hej Agnes!"})
    assert r.status_code == 200, r.text
    assert r.json()["sender_type"] == "owner"
    assert r.json()["mine"] is True

    # Staffer reads via their token — no auth header, just the capability token.
    _override_user(None)
    r2 = client.get(f"/api/portal/{token}/chat")
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert [m["body"] for m in body["messages"]] == ["Hej Agnes!"]
    # The owner's message is NOT "mine" from the staffer's perspective.
    assert body["messages"][0]["mine"] is False
    assert body["restaurant_name"] == "Bon Bakery"


def test_staff_replies_owner_unread_then_read(client, db):
    owner = _owner(db)
    staff, token = _staff(db, owner)

    # Staff sends first.
    _override_user(None)
    r = client.post(f"/api/portal/{token}/chat", json={"body": "Kan jeg bytte vagt?"})
    assert r.status_code == 200, r.text
    assert r.json()["sender_type"] == "staff"

    # Owner thread list shows unread = 1.
    _override_user(owner)
    rl = client.get("/api/staff/chat/threads")
    assert rl.status_code == 200, rl.text
    row = next(t for t in rl.json()["threads"] if t["staff_id"] == str(staff.id))
    assert row["unread"] == 1
    assert row["last_body"] == "Kan jeg bytte vagt?"

    # Opening the thread marks read → unread clears.
    client.get(f"/api/staff/chat/threads/{staff.id}")
    rl2 = client.get("/api/staff/chat/threads")
    row2 = next(t for t in rl2.json()["threads"] if t["staff_id"] == str(staff.id))
    assert row2["unread"] == 0


def test_idempotent_send(client, db):
    owner = _owner(db)
    staff, token = _staff(db, owner)
    _override_user(owner)

    p = {"body": "dup", "client_msg_id": "cmid-1"}
    a = client.post(f"/api/staff/chat/threads/{staff.id}", json=p)
    b = client.post(f"/api/staff/chat/threads/{staff.id}", json=p)
    assert a.status_code == b.status_code == 200
    assert a.json()["id"] == b.json()["id"]  # same row, not a twin

    msgs = client.get(f"/api/staff/chat/threads/{staff.id}").json()["messages"]
    assert len([m for m in msgs if m["body"] == "dup"]) == 1


def test_tenant_isolation_foreign_staff_404(client, db):
    owner_a = _owner(db, suffix="A")
    owner_b = _owner(db, suffix="B")
    staff_b, _ = _staff(db, owner_b, name="Bo", token="tok_bo")

    # Owner A tries to open owner B's staffer's thread → 404.
    _override_user(owner_a)
    r = client.get(f"/api/staff/chat/threads/{staff_b.id}")
    assert r.status_code == 404
    r2 = client.post(f"/api/staff/chat/threads/{staff_b.id}", json={"body": "x"})
    assert r2.status_code == 404


def test_empty_body_rejected(client, db):
    owner = _owner(db)
    staff, token = _staff(db, owner)
    _override_user(owner)
    r = client.post(f"/api/staff/chat/threads/{staff.id}", json={"body": "   "})
    assert r.status_code == 422


def test_sender_type_is_server_set(client, db):
    """A malicious body claiming sender_type must be ignored — the schema
    doesn't accept it and the server sets it from the auth path."""
    owner = _owner(db)
    staff, token = _staff(db, owner)
    _override_user(None)
    r = client.post(
        f"/api/portal/{token}/chat",
        json={"body": "spoof", "sender_type": "owner"},
    )
    assert r.status_code == 200
    assert r.json()["sender_type"] == "staff"  # not 'owner'


def test_owner_unread_aggregate(client, db):
    owner = _owner(db)
    staff, token = _staff(db, owner)

    # No threads → 0.
    _override_user(owner)
    assert client.get("/api/staff/chat/unread").json()["unread"] == 0

    # Staff sends two → owner unread = 2.
    _override_user(None)
    client.post(f"/api/portal/{token}/chat", json={"body": "a"})
    client.post(f"/api/portal/{token}/chat", json={"body": "b"})
    _override_user(owner)
    assert client.get("/api/staff/chat/unread").json()["unread"] == 2

    # Owner opens the thread → unread clears.
    client.get(f"/api/staff/chat/threads/{staff.id}")
    assert client.get("/api/staff/chat/unread").json()["unread"] == 0


def _png_bytes(color=(200, 60, 60)):
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (24, 24), color).save(buf, format="PNG")
    return buf.getvalue()


def test_owner_sends_photo_staff_reads_and_proxy_serves(client, db):
    owner = _owner(db)
    staff, token = _staff(db, owner)
    _override_user(owner)

    png = _png_bytes()
    r = client.post(
        f"/api/staff/chat/threads/{staff.id}/photos",
        data={"body": "Se her"},
        files=[("photos", ("a.png", png, "image/png"))],
    )
    assert r.status_code == 200, r.text
    msg = r.json()
    assert msg["photo_count"] == 1
    assert len(msg["photos"]) == 1
    photo_url = msg["photos"][0]["url"]
    assert photo_url.startswith("/staff/chat/photo/")

    # Owner can fetch the bytes (re-encoded to JPEG by the sanitizer).
    served = client.get("/api" + photo_url)
    assert served.status_code == 200
    assert served.headers["content-type"].startswith("image/jpeg")
    assert len(served.content) > 0

    # Staffer sees the photo in their thread + can fetch it via their token URL.
    _override_user(None)
    body = client.get(f"/api/portal/{token}/chat").json()
    assert body["messages"][0]["photo_count"] == 1
    staff_photo_url = body["messages"][0]["photos"][0]["url"]
    assert staff_photo_url.startswith(f"/portal/{token}/chat/photo/")
    assert client.get("/api" + staff_photo_url).status_code == 200


def test_photo_cross_staffer_isolation(client, db):
    owner = _owner(db)
    staff_a, token_a = _staff(db, owner, name="Agnes", token="tok_a")
    staff_b, token_b = _staff(db, owner, name="Bo", token="tok_b")

    # Owner sends a photo to staff A.
    _override_user(owner)
    r = client.post(
        f"/api/staff/chat/threads/{staff_a.id}/photos",
        files=[("photos", ("a.png", _png_bytes(), "image/png"))],
    )
    pid = r.json()["photos"][0]["id"]

    # Staff B (same tenant) must NOT be able to fetch A's photo.
    _override_user(None)
    assert client.get(f"/api/portal/{token_b}/chat/photo/{pid}").status_code == 404
    # Staff A can.
    assert client.get(f"/api/portal/{token_a}/chat/photo/{pid}").status_code == 200


def test_photo_count_cap(client, db):
    owner = _owner(db)
    staff, _ = _staff(db, owner)
    _override_user(owner)
    files = [("photos", (f"{i}.png", _png_bytes(), "image/png")) for i in range(4)]
    r = client.post(f"/api/staff/chat/threads/{staff.id}/photos", files=files)
    assert r.status_code == 422  # >3 rejected


def test_unread_badge_endpoint(client, db):
    owner = _owner(db)
    staff, token = _staff(db, owner)

    # No thread yet → 0.
    _override_user(None)
    assert client.get(f"/api/portal/{token}/chat/unread").json()["unread"] == 0

    # Owner sends → staff badge shows 1.
    _override_user(owner)
    client.post(f"/api/staff/chat/threads/{staff.id}", json={"body": "ping"})
    _override_user(None)
    assert client.get(f"/api/portal/{token}/chat/unread").json()["unread"] == 1

    # Staff opens chat → badge clears.
    client.get(f"/api/portal/{token}/chat")
    assert client.get(f"/api/portal/{token}/chat/unread").json()["unread"] == 0
