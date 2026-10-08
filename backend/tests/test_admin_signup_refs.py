"""
GET /api/admin/signup-refs — door visits counted as conversions, counts only.

The Oct 2026 door rounds hand out a QR per visit (/register?ref=r1-a-03).
These tests pin what would flatter or leak the numbers if it broke quietly:

  • founder/test accounts (the shared EXCLUDED_ACCOUNTS list) count nowhere
  • a demo-seeded close is not a first close; a draft is not a locked close
  • a cron event is not activity, and neither is a human action 10 days ago
  • per ref and per round/argument add up; planned rounds show as measured 0s
  • the payload carries counts only — no id, e-mail or business name
  • only a super-admin gets it, through the EXISTING guard (which answers a
    refusal with a deliberate 404, not 403 — see services/admin_security.py)
  • the thesis export gains a signup_ref dimension by round/argument, never
    the code itself

Run:
  cd backend && python3 -m pytest tests/test_admin_signup_refs.py -x -q
"""
from __future__ import annotations

import json
import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.daily_close import DailyClose
from app.models.event_log import EventLog
from app.models.staff import StaffLink, StaffMember
from app.models.user import User
from app.services.admin_security import require_super_admin
from app.services.auth import create_access_token, hash_password
from app.services.internal_accounts import EXCLUDED_ACCOUNTS
from app.utils.time import utc_now

_db_ready.set()

FOUNDER_ID = "3436a646-b458-4321-96fc-49ac108bd2f3"


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


def _override_db(SessionLocal):
    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()
    app.dependency_overrides[get_db] = _get_test_db


@pytest.fixture
def client(SessionLocal):
    """The arithmetic, with the guard stubbed (the guard has its own tests below)."""
    _override_db(SessionLocal)
    app.dependency_overrides[require_super_admin] = lambda: None
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def guarded_client(SessionLocal):
    """The REAL require_super_admin guard."""
    _override_db(SessionLocal)
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db, *, ref=None, uid=None, verified=False, onboarded=False,
           name="Venue", email=None, role="owner", age_days=0) -> User:
    u = User(
        id=uid or str(uuid.uuid4()),
        email=email or f"{uuid.uuid4().hex[:10]}@cafe-example.dk",
        password_hash=hash_password("pw123456"),
        business_name=name, business_type="cafe", currency="DKK",
        plan="free", role=role, email_verified=verified,
        onboarding_completed_at=utc_now() if onboarded else None,
        signup_ref=ref, created_at=utc_now() - timedelta(days=age_days),
    )
    db.add(u)
    db.commit()
    return u


def _close(db, owner, *, status="confirmed", notes=None, deleted=False, days_ago=1):
    db.add(DailyClose(
        id=uuid.uuid4(), user_id=owner.id, date=date.today() - timedelta(days=days_ago),
        revenue_total=1000, payment_total=1000, status=status, notes=notes,
        is_deleted=deleted,
    ))
    db.commit()


def _link(db, owner, *, opened: bool):
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name="Anna",
                    role="server", active=True, is_deleted=False)
    db.add(m)
    db.commit()
    db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=m.id,
                     token=uuid.uuid4().hex, active=True,
                     last_accessed=utc_now() if opened else None))
    db.commit()


def _event(db, owner, event, *, days_ago=0):
    db.add(EventLog(user_id=owner.id, event=event, page="dashboard",
                    created_at=utc_now() - timedelta(days=days_ago)))
    db.commit()


def _seed(db) -> dict:
    """Six owners with refs + one founder with a ref + one owner without."""
    assert FOUNDER_ID in EXCLUDED_ACCOUNTS
    founder = _owner(db, uid=FOUNDER_ID, ref="r1-a-01", verified=True, onboarded=True,
                     name="BonBox Founder")
    _close(db, founder)
    _link(db, founder, opened=True)
    _event(db, founder, "page_view")

    u1 = _owner(db, ref="r1-a-01", verified=True, onboarded=True, name="Kaffebaren Nord")
    _close(db, u1, status="confirmed")
    _link(db, u1, opened=True)
    _event(db, u1, "page_view")

    u2 = _owner(db, ref="r1-a-01", verified=False, name="Bageriet Syd")
    _close(db, u2, status="draft")

    u3 = _owner(db, ref="r1-a-02", verified=True, name="Pizza Vest")
    _close(db, u3, status="confirmed", notes="sample · demo")   # demo — not a close
    _event(db, u3, "daily_brief.email_sent")                    # cron — not activity
    _event(db, u3, "sale_logged", days_ago=10)                  # human, but too old

    u4 = _owner(db, ref="r2-b-01", verified=True, onboarded=True, name="Café Øst")
    _close(db, u4, status="confirmed", deleted=True)            # did it, deleted it later
    _link(db, u4, opened=False)

    u5 = _owner(db, ref="flyer-01", name="Flyer Venue")

    none = _owner(db, ref=None, verified=True, onboarded=True, name="No Ref Venue")
    _close(db, none)
    _link(db, none, opened=True)
    _event(db, none, "page_view")
    return {"founder": founder, "u1": u1, "u2": u2, "u3": u3, "u4": u4, "u5": u5, "none": none}


def _get(client) -> dict:
    r = client.get("/api/admin/signup-refs")
    assert r.status_code == 200, r.text
    return r.json()


def _row(rows, key, value) -> dict:
    return next(r for r in rows if r[key] == value)


# ── The arithmetic ───────────────────────────────────────────────────


def test_totals_exclude_founder_and_ignore_demo_cron_and_stale_activity(db, client):
    _seed(db)
    body = _get(client)
    assert body["excluded_internal"] == 1
    assert body["total"] == {
        "signups": 5,              # u1..u5 — founder out, no-ref owner out
        "email_verified": 3,       # u1, u3, u4
        "onboarding_finished": 2,  # u1, u4
        "first_close_any": 3,      # u1 (locked), u2 (draft), u4 (deleted) — u3's is demo
        "first_close_locked": 2,   # u1, u4
        "staff_link_created": 2,   # u1, u4
        "staff_link_opened": 1,    # u1
        "active_7d": 1,            # u1 — u3 has only a cron event + a 10-day-old action
    }


def test_per_ref_and_per_round(db, client):
    _seed(db)
    body = _get(client)
    r1a01 = _row(body["by_ref"], "ref", "r1-a-01")
    assert r1a01["prefix"] == "r1-a"
    assert r1a01["signups"] == 2                     # founder excluded
    assert r1a01["first_close_any"] == 2
    assert r1a01["first_close_locked"] == 1          # u2's is a draft
    assert r1a01["staff_link_opened"] == 1
    assert r1a01["active_7d"] == 1

    r1a02 = _row(body["by_ref"], "ref", "r1-a-02")
    assert r1a02["signups"] == 1 and r1a02["first_close_any"] == 0 and r1a02["active_7d"] == 0

    assert _row(body["by_prefix"], "prefix", "r1-a")["signups"] == 3
    r2b = _row(body["by_prefix"], "prefix", "r2-b")
    assert r2b["signups"] == 1 and r2b["first_close_locked"] == 1 and r2b["staff_link_opened"] == 0
    assert _row(body["by_prefix"], "prefix", "other")["signups"] == 1
    assert _row(body["by_ref"], "ref", "flyer-01")["prefix"] == "other"

    # Rows add up to the total, step by step.
    for step in body["steps"]:
        assert sum(r[step] for r in body["by_ref"]) == body["total"][step], step
        assert sum(r[step] for r in body["by_prefix"]) == body["total"][step], step


def test_empty_database_reads_as_measured_zeros(db, client):
    body = _get(client)
    assert body["by_ref"] == []
    assert {r["prefix"] for r in body["by_prefix"]} == {"r1-a", "r2-b"}
    for r in body["by_prefix"]:
        assert all(r[s] == 0 for s in body["steps"])
    assert all(v == 0 for v in body["total"].values())


def test_notes_say_counts_are_a_lower_bound(db, client):
    # A code is only kept in the browser that opened the QR, from the deploy
    # onward — a 0 here is "none counted", never "none happened".
    notes = _get(client)["notes"]
    assert "LOWER BOUND" in notes
    assert "/api/health" in notes


def test_payload_carries_no_personal_data(db, client):
    people = _seed(db)
    raw = json.dumps(_get(client), ensure_ascii=False)
    for u in people.values():
        assert u.email not in raw
        assert u.business_name not in raw
        assert str(u.id) not in raw
        assert str(u.id).replace("-", "") not in raw
    assert "@" not in raw
    # Only these keys exist on a row: the code/prefix and the step counts.
    body = json.loads(raw)
    allowed = set(body["steps"]) | {"ref", "prefix"}
    for row in body["by_ref"] + body["by_prefix"]:
        assert set(row) <= allowed, set(row) - allowed
        assert all(isinstance(row[s], int) for s in body["steps"])


# ── The guard (real, not stubbed) ────────────────────────────────────


def _bearer(u: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(str(u.id), u.token_version or 0)}"}


def test_non_admin_owner_is_refused_with_no_data(db, guarded_client, monkeypatch):
    from app.config import settings as _settings
    monkeypatch.setattr(_settings, "SUPER_ADMIN_EMAILS", "founder@bonbox.dk", raising=False)
    _seed(db)
    owner = _owner(db, ref="r1-a-09", verified=True, age_days=30)
    r = guarded_client.get("/api/admin/signup-refs", headers=_bearer(owner))
    # The existing guard refuses every non-admin with a generic 404 (it never
    # says which layer failed). No count leaves the server.
    assert r.status_code == 404, r.text
    assert "by_ref" not in r.text and "signups" not in r.text


def test_super_admin_role_without_allowlisted_email_is_refused(db, guarded_client, monkeypatch):
    from app.config import settings as _settings
    monkeypatch.setattr(_settings, "SUPER_ADMIN_EMAILS", "founder@bonbox.dk", raising=False)
    impostor = _owner(db, role="super_admin", verified=True, age_days=30,
                      email="someone.else@cafe-example.dk")
    r = guarded_client.get("/api/admin/signup-refs", headers=_bearer(impostor))
    assert r.status_code == 404, r.text


def test_unauthenticated_is_refused(guarded_client):
    r = guarded_client.get("/api/admin/signup-refs")
    assert r.status_code in (401, 403), r.text
    assert "by_ref" not in r.text


def test_real_super_admin_passes_the_real_guard(db, guarded_client, monkeypatch):
    from app.config import settings as _settings
    monkeypatch.setattr(_settings, "SUPER_ADMIN_EMAILS", "founder@bonbox.dk", raising=False)
    _seed(db)
    admin = _owner(db, role="super_admin", verified=True, age_days=30,
                   email="founder@bonbox.dk", name="Admin")
    r = guarded_client.get("/api/admin/signup-refs", headers=_bearer(admin))
    assert r.status_code == 200, r.text
    assert r.json()["total"]["signups"] == 5


def test_route_is_wired_to_the_super_admin_guard():
    for route in app.routes:
        if getattr(route, "path", "") == "/api/admin/signup-refs":
            deps = {d.call for d in route.dependant.dependencies}
            assert require_super_admin in deps
            return
    raise AssertionError("route /api/admin/signup-refs not mounted")


# ── Thesis export: round/argument only, suppressed like every table ───


def test_thesis_export_counts_signup_ref_by_round_never_by_code(db):
    _seed(db)
    from scripts.thesis_export import HUMAN_ACTIONS, collect
    from app.services.human_actions import HUMAN_ACTIONS as SHARED
    assert HUMAN_ACTIONS is SHARED  # one definition of "active"
    dims = collect(db)
    assert dims["signup_ref"] == {"r1-a": 3, "r2-b": 1, "other": 1, "(no ref)": 1}
    raw = json.dumps(dims)
    for code in ("r1-a-01", "r1-a-02", "r2-b-01", "flyer-01"):
        assert code not in raw
