"""Magic link: fleet-wide and per-domain sign-in mail ceilings (R-sec).

THE GAP. POST /auth/magic-link/request allows 10/hour per IP and 3 unused
links per address per 10 minutes. A caller with many IP addresses and many
made-up addresses gets BonBox to mail without bound, from our sending domain.

NOW. Over a fleet-wide (all addresses) or per-domain ceiling, an address
WITHOUT an account gets nothing — no token row, no audit row, no log line, no
mail — and the byte-identical 200. Confirmed accounts still get their link
(an unconfirmed one does not: anyone can register any address).
Settings are read at call time; 0 switches a check off.

Run: cd backend && python -m pytest tests/test_magic_link_ceilings.py -q
"""
from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.config import settings
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.magic_link_token import MagicLinkToken
from app.models.security_event import SecurityEvent
from app.models.user import User
from app.services import abuse_caps
from app.services.auth import hash_password
from app.utils import abuse_signals
from app.utils.time import utc_now

_db_ready.set()

_SETTINGS = ("MAGIC_LINK_FLEET_MAX_PER_HOUR", "MAGIC_LINK_FLEET_MAX_PER_DAY",
             "MAGIC_LINK_DOMAIN_MAX_PER_HOUR", "MAGIC_LINK_DOMAIN_MAX_PER_DAY")


# ─── Fixtures (the per-test engine style of test_magic_link.py) ───────

@pytest.fixture
def engine_and_session():
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def outbox(monkeypatch):
    sent: list[dict] = []

    def _capture(to, subject, html, **kwargs):
        sent.append({"to": to, "subject": subject})
        return True

    monkeypatch.setattr("app.services.email_service.send_email", _capture, raising=True)
    monkeypatch.setattr("app.routers.auth_magic_link.send_email", _capture, raising=True)
    return sent


@pytest.fixture
def caps(monkeypatch):
    """Set the four ceilings (all off unless given)."""
    def _set(fleet_hour=0, fleet_day=0, domain_hour=0, domain_day=0):
        for name, v in zip(_SETTINGS, (fleet_hour, fleet_day, domain_hour, domain_day)):
            monkeypatch.setattr(settings, name, v)
    _set()
    return _set


@pytest.fixture
def client(engine_and_session, monkeypatch, outbox, caps):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    import app.main as _app_main
    monkeypatch.setattr(_app_main, "SessionLocal", SessionLocal, raising=False)
    import app.database as _app_db
    monkeypatch.setattr(_app_db, "SessionLocal", SessionLocal, raising=False)
    from app.routers.auth_magic_link import limiter as _ml_limiter
    _ml_limiter.reset()
    abuse_signals.reset()
    yield TestClient(app)
    app.dependency_overrides.clear()
    _ml_limiter.reset()


def _seed(db, email: str, *, ago=timedelta(minutes=5), n: int = 1):
    for _ in range(n):
        created = utc_now() - ago
        db.add(MagicLinkToken(
            email=email,
            token_hash=hashlib.sha256(uuid.uuid4().bytes).hexdigest(),
            created_at=created,
            expires_at=created + timedelta(minutes=15),
        ))
    db.commit()


def _user(db, email):
    u = User(email=email, password_hash=hash_password("owner-password-1"),
             business_name="Bon Bakery", business_type="cafe", currency="DKK",
             role="owner", email_verified=True)
    db.add(u)
    db.commit()
    return u


def _ask(client, email):
    return client.post("/api/auth/magic-link/request", json={"email": email})


def _rows(db):
    db.expire_all()
    return db.query(MagicLinkToken).count()


def _events(db):
    db.expire_all()
    return db.query(SecurityEvent).count()


# ─── Fleet ceiling ────────────────────────────────────────────────────

def test_fleet_hour_ceiling_holds_back_an_unknown_address_silently(client, db, outbox, caps, caplog):
    baseline = _ask(client, "first@example.org")          # ceilings off: a normal request
    assert baseline.status_code == 200 and len(outbox) == 1
    _seed(db, "seed@example.net")                          # 2 links in the last hour
    rows, events = _rows(db), _events(db)
    abuse_signals.reset()

    caps(fleet_hour=2)
    with caplog.at_level(logging.DEBUG):
        caplog.clear()
        r = _ask(client, "new@example.com")
    assert r.status_code == 200
    assert r.content == baseline.content                   # byte-identical answer
    assert _rows(db) == rows                               # no token row
    assert _events(db) == events                           # no SecurityEvent
    assert len(outbox) == 1                                # no mail
    assert not [rec for rec in caplog.records
                if rec.name.startswith(("app.routers.auth_magic_link", "app.services.magic_link"))]
    assert "new@example.com" not in caplog.text
    assert abuse_signals.drain()["magic_link_fleet"] == 1


def test_fleet_day_ceiling(client, db, outbox, caps):
    _seed(db, "seed@example.net", ago=timedelta(hours=3), n=3)
    caps(fleet_hour=60, fleet_day=3)
    r = _ask(client, "new@example.com")
    assert r.status_code == 200 and outbox == [] and _rows(db) == 3
    assert abuse_signals.drain() == {"magic_link_fleet": 1, "no_edge": 1}


def test_rows_two_hours_old_do_not_count_toward_the_hour(client, db, outbox, caps):
    _seed(db, "seed@example.net", ago=timedelta(hours=2), n=2)
    caps(fleet_hour=2)
    _ask(client, "new@example.com")
    assert len(outbox) == 1 and _rows(db) == 3


def test_rows_older_than_a_day_do_not_count(client, db, outbox, caps):
    _seed(db, "seed@example.net", ago=timedelta(hours=25), n=5)
    caps(fleet_day=5)
    _ask(client, "new@example.com")
    assert len(outbox) == 1


# ─── Domain ceiling ───────────────────────────────────────────────────

def test_domain_ceiling_holds_that_domain_only(client, db, outbox, caps):
    _seed(db, "a@example.org")
    caps(domain_hour=1)
    _ask(client, "b@example.org")
    assert outbox == []
    assert abuse_signals.drain().get("magic_link_domain") == 1
    _ask(client, "c@other.org")
    assert [m["to"] for m in outbox] == ["c@other.org"]


def test_domain_day_ceiling(client, db, outbox, caps):
    _seed(db, "a@example.org", ago=timedelta(hours=5), n=2)
    caps(domain_day=2)
    _ask(client, "b@example.org")
    assert outbox == []


def test_an_underscore_or_percent_in_the_domain_is_not_a_wildcard(db, caps):
    _seed(db, "a@exomple.org")
    _seed(db, "a@exaample.org")
    assert abuse_caps.magic_link_counts(db, "ex_mple.org") == (0, 0)
    assert abuse_caps.magic_link_counts(db, "ex%mple.org") == (0, 0)
    assert abuse_caps.magic_link_counts(db, "exomple.org") == (1, 1)
    caps(domain_hour=1)
    assert abuse_caps.magic_link_ceiling(db, "b@ex_mple.org") is None
    assert abuse_caps.magic_link_ceiling(db, "b@exomple.org") == "domain"


def test_the_domain_is_the_part_after_the_last_at(db, caps):
    _seed(db, "x@evil.example")
    caps(domain_hour=1)
    assert abuse_caps.magic_link_ceiling(db, '"a@b"@Evil.Example') == "domain"


# ─── Who still gets a link ────────────────────────────────────────────

def test_an_existing_account_still_gets_its_link_while_tripped(client, db, outbox, caps):
    _user(db, "owner@bonbox.dk")
    _seed(db, "seed@example.net", n=2)
    caps(fleet_hour=2, domain_hour=1)
    r = _ask(client, "owner@bonbox.dk")
    assert r.status_code == 200
    assert [m["to"] for m in outbox] == ["owner@bonbox.dk"]
    assert _rows(db) == 3
    assert "magic_link_fleet" not in abuse_signals.drain()


def test_a_failing_count_sends_nothing_to_an_unknown_address(client, db, outbox, caps, monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("count failed")

    monkeypatch.setattr(abuse_caps, "magic_link_counts", _boom)
    caps(fleet_hour=60)
    r = _ask(client, "new@example.com")
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert outbox == [] and _rows(db) == 0
    sig = abuse_signals.drain()
    assert "magic_link_fleet" not in sig and "magic_link_domain" not in sig


def test_all_ceilings_off_behaves_as_before(client, db, outbox, caps, monkeypatch):
    _seed(db, "seed@example.org", n=50)
    caps()                                                  # all four 0

    def _never(*a, **k):
        raise AssertionError("no count should run with every ceiling off")

    monkeypatch.setattr(abuse_caps, "magic_link_counts", _never)
    r = _ask(client, "new@example.org")
    assert r.status_code == 200 and len(outbox) == 1 and _rows(db) == 51


def test_default_ceilings_leave_normal_traffic_alone(client, db, outbox, monkeypatch):
    for name, v in zip(_SETTINGS, (60, 300, 30, 100)):
        monkeypatch.setattr(settings, name, v)
    for i in range(5):
        _ask(client, f"user{i}@example.org")
    assert len(outbox) == 5


# ─── The audit address ────────────────────────────────────────────────

def test_a_forged_long_xff_without_cf_stores_no_ip(engine_and_session, client, db, outbox):
    # The production order: uvicorn's proxy-headers layer copies the leftmost
    # X-Forwarded-For into request.client before the app sees it.
    prod = TestClient(ProxyHeadersMiddleware(app, trusted_hosts="*"))
    r = prod.post("/api/auth/magic-link/request", json={"email": "new@example.org"},
                  headers={"X-Forwarded-For": "a" * 80})
    assert r.status_code == 200
    db.expire_all()
    row = db.query(MagicLinkToken).one()
    assert row.request_ip is None
    # SQLite does not enforce VARCHAR(45); the Postgres check is
    # tests/test_pg_abuse_caps.py.
    assert row.request_ip is None or len(row.request_ip) <= 45


def test_the_cf_address_is_stored_when_present(client, db, outbox):
    prod = TestClient(ProxyHeadersMiddleware(app, trusted_hosts="*"))
    prod.post("/api/auth/magic-link/request", json={"email": "new@example.org"},
              headers={"X-Forwarded-For": "6.6.6.6", "CF-Connecting-IP": "203.0.113.9"})
    db.expire_all()
    assert db.query(MagicLinkToken).one().request_ip == "203.0.113.9"


# ─── Only a VERIFIED account walks past a ceiling (R-sec fix round) ───────

def test_an_unverified_signup_does_not_unlock_mail_while_tripped(client, db, outbox, caps, monkeypatch):
    # POST /auth/register makes an UNVERIFIED account for any address, 5/min
    # per IP. If that counted as "has an account", an IP-rotating caller could
    # pre-register victims and then mail each one 3 per 10 minutes past the
    # fleet ceiling. Over a ceiling only a confirmed address gets its link.
    monkeypatch.setattr("app.routers.auth.send_email", lambda *a, **k: True, raising=False)
    _seed(db, "seed@example.net", n=2)
    caps(fleet_hour=2, fleet_day=2)
    _ask(client, "victim@gmail.com")
    assert outbox == []                                     # held back, as designed
    r = client.post("/api/auth/register", headers={"CF-Connecting-IP": "203.0.113.50"},
                    json={"email": "victim@gmail.com", "password": "whatever-123",
                          "business_name": "x"})
    assert r.status_code == 201, r.text
    db.expire_all()
    assert db.query(User).filter(User.email == "victim@gmail.com").one().email_verified is False
    rows = _rows(db)
    for _ in range(3):
        assert _ask(client, "victim@gmail.com").status_code == 200
    assert outbox == []                                     # no mail
    assert _rows(db) == rows                                # no token row
    assert abuse_signals.drain().get("magic_link_fleet") == 4


def test_a_verified_account_still_gets_its_link_while_tripped(client, db, outbox, caps):
    _user(db, "owner@bonbox.dk")                            # email_verified=True
    _seed(db, "seed@example.net", n=2)
    caps(fleet_hour=2)
    _ask(client, "owner@bonbox.dk")
    assert [m["to"] for m in outbox] == ["owner@bonbox.dk"]


def test_has_account_counts_only_confirmed_addresses(db):
    _user(db, "Owner@BonBox.dk")
    u = User(email="pending@bonbox.dk", password_hash=hash_password("owner-password-1"),
             business_name="Cafe", business_type="cafe", currency="DKK", role="owner",
             email_verified=False)
    db.add(u)
    db.commit()
    assert abuse_caps.has_account(db, "owner@bonbox.dk") is True
    assert abuse_caps.has_account(db, "pending@bonbox.dk") is False
    assert abuse_caps.has_account(db, "nobody@bonbox.dk") is False


# ─── While tripped, the answer TIME does not tell accounts apart ──────────
#
# Over a ceiling, an unknown address returns at once; a confirmed account goes
# on to a token row, an audit row, a commit and a Resend call. The attacker
# controls when a domain trips (30 made-up addresses an hour), so without a
# fixed answer time the latency would list which addresses have accounts.
# Measured as a real client sees it: the moment the final response body is
# sent (the mail goes out after that, as a background task).

def _time_to_answer(email: str, ip: str) -> tuple[float, int, bytes]:
    import asyncio
    import json
    import time

    from app.main import app as _app

    payload = json.dumps({"email": email}).encode()
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": "POST", "scheme": "http",
        "path": "/api/auth/magic-link/request", "raw_path": b"/api/auth/magic-link/request",
        "query_string": b"", "root_path": "",
        "headers": [(b"host", b"testserver"), (b"content-type", b"application/json"),
                    (b"content-length", str(len(payload)).encode()),
                    (b"cf-connecting-ip", ip.encode())],
        "client": ("testclient", 50000), "server": ("testserver", 80),
    }

    async def go():
        done = asyncio.Event()
        state = {"sent_body": False, "status": None, "body": b"", "t": None}

        async def receive():
            if not state["sent_body"]:
                state["sent_body"] = True
                return {"type": "http.request", "body": payload, "more_body": False}
            await done.wait()
            return {"type": "http.disconnect"}

        async def send(msg):
            if msg["type"] == "http.response.start":
                state["status"] = msg["status"]
            elif msg["type"] == "http.response.body":
                state["body"] += msg.get("body", b"")
                if not msg.get("more_body", False) and state["t"] is None:
                    state["t"] = time.perf_counter()
                    done.set()

        t0 = time.perf_counter()
        await _app(scope, receive, send)        # returns after any background task
        return state["t"] - t0, state["status"], state["body"]

    return asyncio.run(go())


def test_while_tripped_known_and_unknown_answer_in_the_same_time(client, db, outbox, caps, monkeypatch):
    import statistics
    import time

    def _slow_send(to, subject, html, **kwargs):
        time.sleep(0.15)                                    # a realistic Resend round trip
        outbox.append({"to": to, "subject": subject})
        return True

    monkeypatch.setattr("app.routers.auth_magic_link.send_email", _slow_send, raising=True)
    monkeypatch.setattr(settings, "MAGIC_LINK_MIN_RESPONSE_MS", 120)
    caps(domain_hour=1)
    _seed(db, "made-up@victim.dk")                          # the attacker tripped victim.dk
    for i in range(5):
        _user(db, f"known{i}@victim.dk")

    known, unknown, answers = [], [], set()
    for i in range(5):
        dt, status_code, body = _time_to_answer(f"known{i}@victim.dk", f"203.0.113.{10 + i}")
        known.append(dt)
        answers.add((status_code, body))
        dt, status_code, body = _time_to_answer(f"nobody{i}@victim.dk", f"203.0.113.{40 + i}")
        unknown.append(dt)
        answers.add((status_code, body))

    assert len(answers) == 1 and next(iter(answers))[0] == 200   # identical answers
    assert sorted(m["to"] for m in outbox) == [f"known{i}@victim.dk" for i in range(5)]
    k, u = statistics.median(known), statistics.median(unknown)
    assert k >= 0.115 and u >= 0.115, (k, u)                # both held to the floor
    assert abs(k - u) < 0.03, (k, u)                        # the send is not in the answer time


def test_the_floor_holds_every_answer_and_zero_switches_it_off(client, db, outbox, caps, monkeypatch):
    import time

    monkeypatch.setattr(settings, "MAGIC_LINK_MIN_RESPONSE_MS", 150)
    t0 = time.perf_counter()
    assert _ask(client, "a@example.org").status_code == 200        # normal path
    assert time.perf_counter() - t0 >= 0.145
    caps(fleet_hour=1)
    t0 = time.perf_counter()
    assert _ask(client, "b@example.org").status_code == 200        # held back
    assert time.perf_counter() - t0 >= 0.145
    assert [m["to"] for m in outbox] == ["a@example.org"]

    monkeypatch.setattr(settings, "MAGIC_LINK_MIN_RESPONSE_MS", 0)
    caps()
    t0 = time.perf_counter()
    assert _ask(client, "c@example.org").status_code == 200
    assert time.perf_counter() - t0 < 0.145


def test_the_default_floor():
    from app.config import Settings
    assert Settings().MAGIC_LINK_MIN_RESPONSE_MS == 300
