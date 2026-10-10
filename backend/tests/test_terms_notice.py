"""
The in-app notice of the new Terms for EXISTING accounts (R-e follow-up).

Manoj, 10 Oct 2026, decision (a): existing accounts are told about the new
Handelsbetingelser by an in-app notice ONLY (no e-mail); the Terms apply to
them from TERMS_EXISTING_FROM (the deploy day + 15 days, so the notice is at
least the 14 full days the live 13 May Terms §14 promise). New sign-ups that
accept them at sign-up are bound at once.

The two dates are RELEASE-TIME constants (services/terms.py and
frontend/src/legal/terms.js, set on the day R-e ships). Every time below is
derived from them, so moving the dates needs no change here.

These tests pin:
  • who is told: every account OWNER with no acceptance of the current
    version (NULL or older), whenever the account was created, who has not
    closed the notice, before TERMS_EXISTING_FROM — and nobody else (staff,
    an account that accepted at sign-up or at checkout, after the date,
    after closing it)
  • the notice stops on its own at 00:00 Copenhagen on TERMS_EXISTING_FROM
  • closing it is remembered per ACCOUNT on the server, and it is notice,
    never acceptance: terms_version / terms_accepted_at are not written
  • /auth/me carries the flag; staff get 403 from the close endpoint
  • the two dates: real ISO days, the same in backend and frontend, and at
    least 14 full days from the END of the deploy day (>= 15 calendar days)
  • the migration + SQLite mirror carry the column; the export includes it

No mail leaves the test; time is pinned (never the wall clock).
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.user import User
from app.services.auth import create_access_token, hash_password
from app.services.terms import (
    TERMS_EXISTING_FROM, TERMS_NOTICE_GAP_DAYS, TERMS_NOTICE_MIN_DAYS, TERMS_VERSION,
    _notice_gap_days, apply_checkout_terms_acceptance, dismiss_terms_notice,
    dk_midnight_utc, terms_notice_due,
)

_db_ready.set()

# Naive UTC, like the DB columns — all derived from the two release-time dates.
RELEASE_DAY = dk_midnight_utc(TERMS_VERSION)                   # 00:00 Copenhagen, deploy day
EFFECTIVE = dk_midnight_utc(TERMS_EXISTING_FROM)               # 00:00 Copenhagen, Terms apply
LAST_MINUTE = EFFECTIVE - timedelta(minutes=1)                 # 23:59 Copenhagen, the day before
DURING_NOTICE = RELEASE_DAY + timedelta(days=2, hours=9)       # between the two dates
BEFORE_RELEASE = RELEASE_DAY - timedelta(days=40)              # an existing account


def _owner(**kw):
    base = dict(role="owner", owner_id=None, terms_version=None,
                terms_accepted_at=None, terms_notice_dismissed_version=None,
                created_at=BEFORE_RELEASE)
    base.update(kw)
    return SimpleNamespace(**base)


# ─────────────────────────── the rule ───────────────────────────

def test_dates_are_copenhagen_midnight():
    # Summer time (UTC+2) up to and including 25 Oct 2026 — DST ends at 03:00
    # that day, so 00:00 on the 25th is still summer time — winter time
    # (UTC+1) after.
    assert dk_midnight_utc("2026-10-10") == datetime(2026, 10, 9, 22, 0)
    assert dk_midnight_utc("2026-10-14") == datetime(2026, 10, 13, 22, 0)
    assert dk_midnight_utc("2026-10-25") == datetime(2026, 10, 24, 22, 0)
    assert dk_midnight_utc("2026-10-29") == datetime(2026, 10, 28, 23, 0)
    assert dk_midnight_utc("2026-12-01") == datetime(2026, 11, 30, 23, 0)


def test_the_two_dates_and_the_15_days():
    # Real ISO days (a typo fails here, not in production).
    v = date.fromisoformat(TERMS_VERSION)
    e = date.fromisoformat(TERMS_EXISTING_FROM)
    assert v.isoformat() == TERMS_VERSION and e.isoformat() == TERMS_EXISTING_FROM
    # The live Terms §14 promise 14 days; the deploy day is only part of one.
    assert TERMS_NOTICE_MIN_DAYS == 14
    assert TERMS_NOTICE_GAP_DAYS == 15
    assert _notice_gap_days() >= TERMS_NOTICE_GAP_DAYS
    assert e >= v + timedelta(days=15)
    # In real hours: even a deploy at 23:59 on the deploy day leaves at least
    # 14 x 24 h before 00:00 Copenhagen on TERMS_EXISTING_FROM (a spring
    # clock change inside the window costs an hour and would fail this).
    end_of_deploy_day = dk_midnight_utc((v + timedelta(days=1)).isoformat())
    assert EFFECTIVE - end_of_deploy_day >= timedelta(days=TERMS_NOTICE_MIN_DAYS)


def test_frontend_carries_the_same_two_dates():
    """ONE place per side: frontend/src/legal/terms.js exports both dates and
    they must equal the server's (the Terms page and the notice print them;
    the server decides who is told and stamps the version)."""
    src = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "legal" / "terms.js").read_text()
    v = re.findall(r'export const TERMS_VERSION\s*=\s*"([^"]+)"', src)
    e = re.findall(r'export const TERMS_EXISTING_FROM\s*=\s*"([^"]+)"', src)
    assert v == [TERMS_VERSION], v
    assert e == [TERMS_EXISTING_FROM], e


def test_frontend_carries_the_same_existing_accounts_date():
    src = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "legal" / "terms.js").read_text()
    m = re.search(r'export const TERMS_EXISTING_FROM\s*=\s*"([^"]+)"', src)
    assert m, "frontend/src/legal/terms.js must export TERMS_EXISTING_FROM"
    assert m.group(1) == TERMS_EXISTING_FROM


def test_an_existing_owner_without_acceptance_is_told():
    assert terms_notice_due(_owner(), DURING_NOTICE) is True
    assert terms_notice_due(_owner(), LAST_MINUTE) is True
    # An unknown creation time counts as an existing account.
    assert terms_notice_due(_owner(created_at=None), DURING_NOTICE) is True
    # An acceptance of an OLDER version is not an acceptance of this one.
    assert terms_notice_due(_owner(terms_version="2026-05-13"), DURING_NOTICE) is True
    # Closing an older notice does not close this one.
    assert terms_notice_due(_owner(terms_notice_dismissed_version="2026-05-13"), DURING_NOTICE) is True


def test_the_notice_stops_on_its_own_when_the_terms_apply():
    assert terms_notice_due(_owner(), EFFECTIVE) is False
    assert terms_notice_due(_owner(), datetime(2026, 11, 30)) is False


@pytest.mark.parametrize("kw", [
    {"role": "manager", "owner_id": uuid.uuid4()},
    {"role": "cashier", "owner_id": uuid.uuid4()},
    {"role": "accountant"},
    {"role": "owner", "owner_id": uuid.uuid4()},
])
def test_staff_and_other_roles_are_never_told(kw):
    assert terms_notice_due(_owner(**kw), DURING_NOTICE) is False


def test_a_new_account_that_accepted_is_not_told():
    # Created on or after the deploy day and stamped at sign-up (web /register
    # and /login send accept_terms).
    for created in (RELEASE_DAY, RELEASE_DAY + timedelta(days=1, hours=8), DURING_NOTICE):
        assert terms_notice_due(_owner(created_at=created, terms_version=TERMS_VERSION), DURING_NOTICE) is False


def test_the_rule_tells_a_new_account_without_acceptance():
    # Review, 10 Oct: the creation time no longer decides. Signed up on the
    # deploy day before the release went live (old sign-up page, no
    # acceptance), or through the owner iOS app 2.1 (Apple sign-in sends no
    # accept_terms) — no acceptance on record, so the owner is told.
    for created in (RELEASE_DAY, RELEASE_DAY + timedelta(hours=11), DURING_NOTICE, LAST_MINUTE):
        assert terms_notice_due(_owner(created_at=created), LAST_MINUTE) is True
    # One minute before the deploy day: an existing account, told as before.
    assert terms_notice_due(_owner(created_at=RELEASE_DAY - timedelta(minutes=1)), DURING_NOTICE) is True


def test_an_account_that_accepted_the_current_terms_is_not_told():
    assert terms_notice_due(_owner(terms_version=TERMS_VERSION), DURING_NOTICE) is False
    # Accepting at checkout (an existing account buying during the notice)
    # ends the notice too.
    u = _owner()
    assert apply_checkout_terms_acceptance(u, True) is True
    assert terms_notice_due(u, DURING_NOTICE) is False


def test_closing_is_notice_never_acceptance():
    u = _owner()
    assert dismiss_terms_notice(u) is True
    assert u.terms_notice_dismissed_version == TERMS_VERSION
    assert u.terms_version is None and u.terms_accepted_at is None
    assert terms_notice_due(u, DURING_NOTICE) is False
    assert dismiss_terms_notice(u) is False  # idempotent


def test_odd_rows_read_false_and_never_raise():
    assert terms_notice_due(_owner(terms_version=20261010), DURING_NOTICE) is False
    assert terms_notice_due(_owner(), "not a time") is False
    # created_at is no longer read: an odd value neither raises nor hides it.
    assert terms_notice_due(_owner(created_at="not a date"), DURING_NOTICE) is True


# ─────────────────────────── the API ───────────────────────────

@pytest.fixture
def db_session(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()
    # The role guards in app/main.py read `users` through the global
    # SessionLocal — point them at this engine (fresh-DB safe).
    import app.database as _db_mod
    monkeypatch.setattr(_db_mod, "SessionLocal", SessionLocal, raising=False)

    def _override_get_db():
        yield s

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client():
    try:
        from app.routers.auth import limiter
        limiter.reset()
    except Exception:  # noqa: BLE001
        pass
    c = TestClient(app)
    yield c
    app.dependency_overrides.clear()


@pytest.fixture
def during_notice(monkeypatch):
    monkeypatch.setattr("app.services.terms.utc_now", lambda: DURING_NOTICE)


def _make(db, *, role="owner", owner=None, created_at=BEFORE_RELEASE, **kw):
    u = User(
        email=f"vilkaar-{uuid.uuid4().hex[:10]}@cafe.dk",
        password_hash=hash_password("Validpass1"),
        business_name="Café Vilkår",
        business_type="cafe",
        currency="DKK",
        role=role,
        owner_id=owner.id if owner is not None else None,
        email_verified=True,
        created_at=created_at,
        **kw,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _auth(u):
    return {"Authorization": f"Bearer {create_access_token(str(u.id))}"}


def test_me_says_due_then_closing_remembers_it_per_account(db_session, client, during_notice):
    u = _make(db_session)
    me = client.get("/api/auth/me", headers=_auth(u))
    assert me.status_code == 200, me.text
    assert me.json()["terms_notice_due"] is True

    r = client.post("/api/auth/terms-notice/dismiss", headers=_auth(u))
    assert r.status_code == 200, r.text
    assert r.json()["terms_notice_due"] is False

    db_session.expire_all()
    row = db_session.query(User).filter(User.id == u.id).first()
    assert row.terms_notice_dismissed_version == TERMS_VERSION
    # Notice, not acceptance.
    assert row.terms_version is None
    assert row.terms_accepted_at is None

    # Another device asks /me — the server answers for the account.
    client.cookies.clear()
    assert client.get("/api/auth/me", headers=_auth(u)).json()["terms_notice_due"] is False
    # Idempotent.
    assert client.post("/api/auth/terms-notice/dismiss", headers=_auth(u)).status_code == 200


def test_staff_are_not_told_and_cannot_write(db_session, client, during_notice):
    owner = _make(db_session)
    staff = _make(db_session, role="manager", owner=owner)
    assert client.get("/api/auth/me", headers=_auth(staff)).json()["terms_notice_due"] is False
    r = client.post("/api/auth/terms-notice/dismiss", headers=_auth(staff))
    assert r.status_code == 403
    db_session.expire_all()
    assert db_session.query(User).filter(User.id == staff.id).first().terms_notice_dismissed_version is None


def test_a_new_account_that_accepted_at_sign_up_is_not_told(db_session, client, during_notice):
    body = {"email": f"ny-{uuid.uuid4().hex[:8]}@cafe.dk", "password": "Validpass1",
            "business_name": "Ny Café", "business_type": "cafe", "currency": "DKK",
            "accept_terms": True}
    r = client.post("/api/auth/register", json=body)
    assert r.status_code == 201, r.text
    client.cookies.clear()
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"})
    assert me.json()["terms_notice_due"] is False


def test_a_new_account_without_acceptance_is_told(db_session, client, during_notice):
    """A sign-up that sent no accept_terms (an app build from before the
    acceptance line, e.g. owner iOS 2.1) accepted nothing: /me tells the
    owner, and nothing is stamped."""
    body = {"email": f"ny-{uuid.uuid4().hex[:8]}@cafe.dk", "password": "Validpass1",
            "business_name": "Ny Café", "business_type": "cafe", "currency": "DKK"}
    r = client.post("/api/auth/register", json=body)
    assert r.status_code == 201, r.text
    db_session.expire_all()
    row = db_session.query(User).filter(User.email == body["email"]).first()
    assert row.terms_version is None and row.terms_accepted_at is None
    # Created after the release went live (the wall clock is not the
    # release's clock): still told, because it accepted nothing.
    row.created_at = RELEASE_DAY + timedelta(hours=11)
    db_session.commit()
    client.cookies.clear()
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"})
    assert me.json()["terms_notice_due"] is True


def test_after_the_date_nobody_is_told(db_session, client, monkeypatch):
    monkeypatch.setattr("app.services.terms.utc_now", lambda: EFFECTIVE)
    u = _make(db_session)
    assert client.get("/api/auth/me", headers=_auth(u)).json()["terms_notice_due"] is False


def test_export_includes_the_closed_notice(db_session, client, during_notice):
    u = _make(db_session)
    client.post("/api/auth/terms-notice/dismiss", headers=_auth(u))
    client.cookies.clear()
    e = client.get("/api/auth/export-data", headers=_auth(u))
    assert e.status_code == 200, e.text
    assert "terms_notice_dismissed_version" in e.text
    assert TERMS_VERSION in e.text


def test_migration_and_sqlite_mirror_carry_the_column():
    src = (Path(__file__).resolve().parents[1] / "app" / "main.py").read_text()
    assert "ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_notice_dismissed_version VARCHAR(16)" in src
    assert '_add("users", "terms_notice_dismissed_version", "VARCHAR(16)")' in src
    col = User.__table__.c.terms_notice_dismissed_version
    assert col.nullable is True
    assert len(TERMS_VERSION) <= col.type.length
