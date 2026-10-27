"""Server-side "last seen" (users.last_seen_at) and the admin list's clock (11 Oct).

Live defect: the super-admin user list said "Last seen 2h ago" for accounts
Manoj had signed in to a minute earlier. Two causes, both pinned here:

  1. admin.py sent naive-UTC datetimes (.isoformat(), no "Z"); the browser
     read them as LOCAL time — 2 h behind in CEST. Every admin datetime now
     goes out as UTC with "Z" (field names unchanged).
  2. last_active came only from event_logs, which the browser writes only
     with analytics consent (R-h). The server now stamps users.last_seen_at
     itself — at sign-in and from get_current_user, at most once per 5
     minutes per account — and last_active is the newer of the two.

Also pinned: the stamp never fails a request; a revisor/team member stamps
their OWN row, never the owner's; a staff-portal link never stamps the owner;
the column ships in the Postgres list AND the SQLite mirror (gotcha: a
missing mirror line fails no create_all-built test); the GDPR export carries
it. The real-Postgres twice-run lives in tests/test_pg_last_seen_migration.py.

Run:
  cd backend && python3 -m pytest tests/test_last_seen.py -q
"""
from __future__ import annotations

import csv
import io
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, text, update
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.requests import Request

from app import models as _all_models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.event_log import EventLog
from app.models.user import User
from app.services import last_seen as ls
from app.services.admin_security import require_super_admin
from app.services.auth import create_access_token, get_current_user, hash_password
from app.utils.time import utc_now

_db_ready.set()


# ── fixtures ──────────────────────────────────────────────────────────


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def SessionLocal(engine):
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


@pytest.fixture
def db(SessionLocal):
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(SessionLocal, monkeypatch):
    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    # The role guards in app/main.py (member_read_guard on /auth/export-data,
    # accountant_write_guard) read the caller's raw role through the GLOBAL
    # app.database.SessionLocal, off the event loop — not through get_db —
    # and fail CLOSED (503 role_check_unavailable) when that read raises.
    # Without this the guard read the process's own database (CI: a fresh
    # ci.db with no users table) and the export answered 503: the guard was
    # right, the test never gave it the database the user lives in.
    import app.database as _db_mod
    monkeypatch.setattr(_db_mod, "SessionLocal", SessionLocal, raising=False)
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def user_updates(engine):
    """Every UPDATE that touches users.last_seen_at, as SQL text."""
    seen: list[str] = []

    def _rec(conn, cursor, statement, params, context, executemany):
        s = " ".join(statement.split()).lower()
        if s.startswith("update users") and "last_seen_at" in s:
            seen.append(s)

    event.listen(engine, "before_cursor_execute", _rec)
    yield seen
    event.remove(engine, "before_cursor_execute", _rec)


def _user(db, *, email=None, role="owner", owner_id=None, last_seen_at=None,
          password="pw-123456") -> User:
    u = User(
        id=uuid.uuid4(),
        email=email or f"{uuid.uuid4().hex[:10]}@cafe-example.dk",
        password_hash=hash_password(password),
        business_name="Café Test", business_type="cafe", currency="DKK",
        role=role, owner_id=owner_id, email_verified=True,
        last_seen_at=last_seen_at,
    )
    db.add(u)
    db.commit()
    return u


def _bearer(u: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(str(u.id), u.token_version)}"}


def _stored(SessionLocal, uid):
    s = SessionLocal()
    try:
        return s.query(User.last_seen_at).filter(User.id == uid).scalar()
    finally:
        s.close()


# ── 1. the stamp itself: at most once per 5 minutes ─────────────────────


def test_a_never_seen_account_is_stamped_once_then_left_alone(db, user_updates):
    u = _user(db)
    assert u.last_seen_at is None

    assert ls.touch_last_seen(db, u) is True
    assert len(user_updates) == 1
    first = u.last_seen_at
    assert first is not None and abs((utc_now() - first).total_seconds()) < 5

    # Straight after: the loaded row says "fresh" — no query at all.
    for _ in range(5):
        assert ls.touch_last_seen(db, u) is False
    assert len(user_updates) == 1


def test_the_interval_is_five_minutes(db, user_updates, monkeypatch):
    u = _user(db)
    t0 = utc_now()
    monkeypatch.setattr(ls, "utc_now", lambda: t0)
    assert ls.touch_last_seen(db, u) is True

    monkeypatch.setattr(ls, "utc_now", lambda: t0 + timedelta(minutes=4, seconds=59))
    assert ls.touch_last_seen(db, u) is False
    assert len(user_updates) == 1

    later = t0 + timedelta(minutes=5, seconds=1)
    monkeypatch.setattr(ls, "utc_now", lambda: later)
    assert ls.touch_last_seen(db, u) is True
    assert len(user_updates) == 2
    db.expire_all()
    assert db.get(User, u.id).last_seen_at == later


def test_a_stale_loaded_row_whose_stored_stamp_is_fresh_writes_nothing(SessionLocal, user_updates):
    """Two concurrent requests from one account: both loaded a stale row, the
    first stamped. The second's UPDATE is conditional and matches no row."""
    s1, s2 = SessionLocal(), SessionLocal()
    try:
        u_id = _user(s1, last_seen_at=utc_now() - timedelta(hours=1)).id
        a = s1.get(User, u_id)
        b = s2.get(User, u_id)  # both see the stamp from an hour ago
        assert ls.touch_last_seen(s1, a) is True
        assert ls.touch_last_seen(s2, b) is False
        assert len(user_updates) == 2  # the second ran, matched 0 rows
    finally:
        s1.close()
        s2.close()
    assert abs((utc_now() - _stored(SessionLocal, u_id)).total_seconds()) < 5


def test_sign_in_forces_the_stamp(db, user_updates):
    u = _user(db, last_seen_at=utc_now() - timedelta(seconds=30))
    assert ls.touch_last_seen(db, u, force=True) is True
    assert len(user_updates) == 1


@pytest.mark.parametrize("force", [False, True], ids=["request", "sign-in"])
def test_a_stamp_leaves_users_updated_at_alone(db, SessionLocal, user_updates, force):
    """users.updated_at has onupdate=utc_now, which SQLAlchemy also applies to
    a Core update(). Without the explicit pin every stamp would rewrite it, and
    "last profile change" would silently become "last request within 5 min"
    (fix round, 11 Oct)."""
    u = _user(db, last_seen_at=utc_now() - timedelta(hours=1))
    old = utc_now().replace(microsecond=0) - timedelta(days=30)
    # An explicit value in SET overrides onupdate, so this pins it as written.
    db.execute(update(User).where(User.id == u.id).values(updated_at=old))
    db.commit()
    s = SessionLocal()
    try:
        assert s.query(User.updated_at).filter(User.id == u.id).scalar() == old
    finally:
        s.close()

    assert ls.touch_last_seen(db, u, force=force) is True
    assert len(user_updates) == 1

    s = SessionLocal()
    try:
        row = s.query(User.updated_at, User.last_seen_at).filter(User.id == u.id).one()
    finally:
        s.close()
    assert row.updated_at == old
    assert abs((utc_now() - row.last_seen_at).total_seconds()) < 5


def test_a_future_stamp_is_rewritten_not_trusted(db):
    u = _user(db, last_seen_at=utc_now() + timedelta(days=1))
    assert ls.touch_last_seen(db, u) is True
    assert u.last_seen_at <= utc_now()


def test_a_failing_write_never_raises_and_rolls_back():
    calls = {"rollback": 0}

    class _BrokenSession:
        def execute(self, *a, **k):
            raise RuntimeError("db down")

        def commit(self):  # pragma: no cover - never reached
            raise AssertionError("must not commit")

        def rollback(self):
            calls["rollback"] += 1

    u = User(id=uuid.uuid4(), email="x@example.dk", password_hash="x")
    assert ls.touch_last_seen(_BrokenSession(), u) is False
    assert calls["rollback"] == 1


# ── 2. where it is stamped ──────────────────────────────────────────────


def test_authenticated_requests_stamp_once_per_five_minutes(client, db, SessionLocal, user_updates):
    u = _user(db)
    for _ in range(4):
        r = client.get("/api/auth/me", headers=_bearer(u))
        assert r.status_code == 200, r.text
    assert len(user_updates) == 1
    stamp = _stored(SessionLocal, u.id)
    assert stamp is not None and abs((utc_now() - stamp).total_seconds()) < 5


def test_an_old_stamp_is_refreshed_by_the_next_request(client, db, SessionLocal):
    u = _user(db, last_seen_at=utc_now() - timedelta(hours=2))
    assert client.get("/api/auth/me", headers=_bearer(u)).status_code == 200
    assert (utc_now() - _stored(SessionLocal, u.id)).total_seconds() < 5


def test_password_login_stamps_the_account(client, db, SessionLocal):
    u = _user(db, email="sangita@cafe-example.dk", password="hunter2-long")
    assert _stored(SessionLocal, u.id) is None
    r = client.post("/api/auth/login",
                    json={"email": "sangita@cafe-example.dk", "password": "hunter2-long"})
    assert r.status_code == 200, r.text
    assert (utc_now() - _stored(SessionLocal, u.id)).total_seconds() < 5


def test_a_failed_login_does_not_stamp(client, db, SessionLocal):
    u = _user(db, email="wrong@cafe-example.dk", password="right-password")
    r = client.post("/api/auth/login",
                    json={"email": "wrong@cafe-example.dk", "password": "not-it"})
    assert r.status_code == 401
    assert _stored(SessionLocal, u.id) is None


def test_a_locked_account_is_not_stamped(client, db, SessionLocal):
    u = _user(db)
    u.is_locked = True
    db.commit()
    assert client.get("/api/auth/me", headers=_bearer(u)).status_code == 401
    assert _stored(SessionLocal, u.id) is None


def _request(path: str) -> Request:
    return Request({"type": "http", "method": "GET", "path": path,
                    "headers": [], "query_string": b""})


def test_a_team_member_stamps_their_own_row_never_the_owners(db, SessionLocal):
    owner = _user(db)
    member = _user(db, role="manager", owner_id=owner.id)
    token = create_access_token(str(member.id), member.token_version)

    resolved = get_current_user(_request("/api/sales"), token=token, db=db)
    assert str(resolved.id) == str(owner.id)  # delegated to the owner's data…
    assert _stored(SessionLocal, member.id) is not None  # …but the member was seen
    assert _stored(SessionLocal, owner.id) is None


def test_a_staff_portal_link_never_stamps_the_owner(client, db, SessionLocal):
    from app.models.staff import StaffLink, StaffMember

    owner = _user(db)
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name="Agnes", role="server")
    db.add(m)
    db.commit()
    token = f"tok-{uuid.uuid4().hex[:12]}"
    db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=m.id, token=token, active=True))
    db.commit()

    r = client.get(f"/api/portal/{token}")
    assert r.status_code == 200, r.text
    assert _stored(SessionLocal, owner.id) is None


# ── 3. the admin list ────────────────────────────────────────────────────


@pytest.fixture
def admin_client(client):
    app.dependency_overrides[require_super_admin] = lambda: None
    yield client


def _event(db, u, at):
    db.add(EventLog(id=uuid.uuid4(), user_id=u.id, event="page_view", page="/dashboard",
                    created_at=at))
    db.commit()


def test_admin_last_active_is_the_newer_of_last_seen_and_events_in_utc_z(admin_client, db):
    now = utc_now().replace(microsecond=0)
    seen_recently = _user(db, email="a@cafe-example.dk", last_seen_at=now - timedelta(minutes=1))
    _event(db, seen_recently, now - timedelta(hours=3))          # consent era, older
    events_only = _user(db, email="b@cafe-example.dk")
    _event(db, events_only, now - timedelta(days=2))             # history before the column
    event_newer = _user(db, email="c@cafe-example.dk", last_seen_at=now - timedelta(days=5))
    _event(db, event_newer, now - timedelta(hours=1))
    never = _user(db, email="d@cafe-example.dk")

    r = admin_client.get("/api/admin/users")
    assert r.status_code == 200, r.text
    rows = {row["email"]: row for row in r.json()}

    assert rows["a@cafe-example.dk"]["last_active"] == (now - timedelta(minutes=1)).isoformat() + "Z"
    assert rows["b@cafe-example.dk"]["last_active"] == (now - timedelta(days=2)).isoformat() + "Z"
    assert rows["c@cafe-example.dk"]["last_active"] == (now - timedelta(hours=1)).isoformat() + "Z"
    assert rows["d@cafe-example.dk"]["last_active"] is None
    for row in rows.values():
        assert row["created_at"].endswith("Z"), row["created_at"]
        assert "last_seen_at" not in row  # field names unchanged: last_active only
    assert never  # noqa: B015 — the account with neither stamp is listed


def test_every_admin_datetime_is_utc_with_z(admin_client, db):
    _user(db)
    ov = admin_client.get("/api/admin/overview")
    assert ov.status_code == 200, ov.text
    assert ov.json()["as_of"].endswith("Z")

    from app.routers.admin import _utc_iso
    from datetime import date, datetime, timezone

    assert _utc_iso(None) is None
    assert _utc_iso(datetime(2026, 10, 11, 8, 14, 3, 123456)) == "2026-10-11T08:14:03.123456Z"
    aware = datetime(2026, 10, 11, 10, 14, tzinfo=timezone(timedelta(hours=2)))
    assert _utc_iso(aware) == "2026-10-11T08:14:00Z"
    assert _utc_iso(date(2026, 10, 11)) == "2026-10-11"  # a date has no offset to state

    import re

    src = (Path(__file__).resolve().parents[1] / "app" / "routers" / "admin.py").read_text()
    start = src.index("def _utc_iso(")
    end = src.index("\ndef ", start + 1)
    helper, rest = src[start:end], src[:start] + src[end:]
    assert helper.count("value.isoformat()") == 2
    bare = re.findall(r"[\w)\]]\.isoformat\(\)", rest)
    assert bare == [], (
        "a bare .isoformat() in admin.py sends naive UTC that the browser reads as local time"
    )


# ── 4. schema: Postgres list + SQLite mirror, idempotent ─────────────────


def test_model_column_is_nullable_without_default():
    col = User.__table__.c.last_seen_at
    assert col.nullable is True
    assert col.default is None and col.server_default is None


def test_postgres_list_carries_an_additive_idempotent_alter():
    from app import main

    stmts = [s for s in main._migrations
             if isinstance(s, str) and s.startswith("ALTER TABLE users") and "last_seen_at" in s]
    assert stmts == ["ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP"]
    sql = stmts[0]
    # A deploy where it already ran takes no lock at all …
    applied = {"rels": set(), "cols": {("users", "last_seen_at")}, "cons": set()}
    assert main._migration_already_applied(sql, applied) is True
    # … and one where it has not runs it (under the 5 s lock_timeout).
    assert main._migration_already_applied(sql, {"rels": set(), "cols": set(), "cons": set()}) is False


def test_the_sqlite_mirror_adds_the_column_and_a_second_boot_is_a_no_op(tmp_path, monkeypatch):
    from app import main

    eng = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    Base.metadata.create_all(eng)
    s = sessionmaker(bind=eng)()
    _user(s, email="old@cafe-example.dk")  # an account from before the column
    s.close()
    with eng.begin() as conn:
        conn.execute(text("ALTER TABLE users DROP COLUMN last_seen_at"))
        cols = {r[1] for r in conn.execute(text("PRAGMA table_info('users')"))}
        assert "last_seen_at" not in cols
    monkeypatch.setattr(main, "engine", eng)

    main._run_migrations()
    main._run_migrations()  # a second boot must neither fail nor change anything

    with eng.connect() as conn:
        info = {r[1]: r for r in conn.execute(text("PRAGMA table_info('users')"))}
        assert "last_seen_at" in info
        assert info["last_seen_at"][2].upper() == "TIMESTAMP"
        assert info["last_seen_at"][3] == 0       # notnull flag off
        assert info["last_seen_at"][4] is None    # no default
        assert conn.execute(text(
            "SELECT last_seen_at FROM users WHERE email = 'old@cafe-example.dk'"
        )).scalar() is None                       # existing rows: not seen yet
    eng.dispose()


# ── 5. the account holder's own copy (Art. 15/20) ────────────────────────


def test_the_gdpr_export_carries_last_seen(client, db):
    # /export-data is limited to 3/minute per address by the auth router's own
    # limiter, which conftest does not reset (it resets the app-wide ones).
    # Run right after tests/test_gdpr_export_complete.py in one process — as a
    # 2-shard split can order them — the bucket is already full and this got
    # 429 (reproduced on f3809de8 too). Start from an empty bucket, as
    # tests/test_terms_notice.py does.
    from app.routers.auth import limiter as _auth_limiter
    _auth_limiter.reset()
    u = _user(db)
    r = client.get("/api/auth/export-data", headers=_bearer(u))
    assert r.status_code == 200, r.text
    # The guard really ran on the user's own row: a cashier seat is refused
    # this path (the same request, a different role in the same database).
    cashier = _user(db, role="cashier", owner_id=u.id)
    _auth_limiter.reset()
    refused = client.get("/api/auth/export-data", headers=_bearer(cashier))
    assert refused.status_code == 403, refused.text
    rows = list(csv.reader(io.StringIO(r.text)))
    header = next(row for row in rows if row and row[0] == "id" and "email" in row)
    assert "last_seen_at" in header
    values = rows[rows.index(header) + 1]
    assert values[header.index("last_seen_at")]  # this very request stamped it
