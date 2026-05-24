"""
Tests for the cultural-event entity CRUD (migration 013).

Coverage:
  1. POST /api/events — happy path + audit row + tenant scope on subsequent reads.
  2. GET /api/events — lists owner's events, hides soft-deleted by default,
     respects sort + include_deleted.
  3. GET /api/events/{id} — owner can read, cross-tenant returns 404.
  4. PATCH /api/events/{id} — partial fields, blocked across tenant.
  5. DELETE /api/events/{id} — soft-delete sets is_deleted + deleted_at.
  6. GET /api/events/{id}/summary — aggregates sales + ticket counts +
     MOMS + exempt revenue across the right scope.
  7. POST /api/sales with event_id — accepts owner's event, rejects
     cross-tenant event_id with 404 (IDOR defense).
  8. GET /api/sales?event_id=<uuid> — filters to this event only.
  9. GET /api/sales?event_id=null — returns untagged sales.
 10. ticket_breakdown validation: malformed shape → 422.

Run: cd backend && pytest tests/test_events.py -v
"""
from __future__ import annotations

from datetime import date, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.event import Event
from app.models.sale import Sale
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()


# ─── Fixtures ──────────────────────────────────────────────────────────


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


def _override_user(user: User | None):
    if user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = lambda: user


def _make_user(db, email: str = "sudip@bonbox.test") -> User:
    u = User(
        email=email,
        password_hash=hash_password("test_pw"),
        business_name="Nepali Cultural Society",
        business_type="general",
        currency="DKK",
        plan="free",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


# ─── 1. Create ─────────────────────────────────────────────────────────


def test_create_event_201(client, db):
    owner = _make_user(db)
    _override_user(owner)

    res = client.post(
        "/api/events",
        json={
            "name": "Nepali Movie Night",
            "event_date": "2026-04-04",
            "venue": "Kulturhus Kbh",
            "notes": "Spring showcase",
        },
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["name"] == "Nepali Movie Night"
    assert body["event_date"] == "2026-04-04"
    assert body["venue"] == "Kulturhus Kbh"
    assert body["is_deleted"] is False
    assert body["id"]
    assert body["user_id"] == str(owner.id)


def test_create_event_audit_row(client, db):
    """Mutations must leave an audit_log row (L7)."""
    from app.models.audit_log import AuditLog

    owner = _make_user(db)
    _override_user(owner)

    res = client.post(
        "/api/events",
        json={"name": "Pop-up market", "event_date": "2026-06-01"},
    )
    assert res.status_code == 201
    rows = db.query(AuditLog).filter(AuditLog.user_id == owner.id).all()
    assert any(r.action == "event.create" for r in rows), [r.action for r in rows]


# ─── 2. List ───────────────────────────────────────────────────────────


def test_list_events_only_for_caller(client, db):
    """Cross-tenant: User A's events must NOT appear in User B's list."""
    a = _make_user(db, email="a@bonbox.test")
    b = _make_user(db, email="b@bonbox.test")

    _override_user(a)
    client.post("/api/events", json={"name": "A1", "event_date": "2026-05-01"})
    client.post("/api/events", json={"name": "A2", "event_date": "2026-05-15"})

    _override_user(b)
    client.post("/api/events", json={"name": "B1", "event_date": "2026-05-10"})

    _override_user(a)
    res = client.get("/api/events")
    assert res.status_code == 200
    rows = res.json()
    assert sorted(r["name"] for r in rows) == ["A1", "A2"]

    _override_user(b)
    res = client.get("/api/events")
    rows = res.json()
    assert sorted(r["name"] for r in rows) == ["B1"]


def test_list_events_excludes_soft_deleted_by_default(client, db):
    owner = _make_user(db)
    _override_user(owner)

    r1 = client.post("/api/events", json={"name": "Live", "event_date": "2026-05-01"})
    r2 = client.post("/api/events", json={"name": "Deleted", "event_date": "2026-05-02"})
    deleted_id = r2.json()["id"]
    client.delete(f"/api/events/{deleted_id}")

    res = client.get("/api/events")
    assert res.status_code == 200
    names = [e["name"] for e in res.json()]
    assert names == ["Live"]

    res = client.get("/api/events?include_deleted=true")
    names = [e["name"] for e in res.json()]
    assert sorted(names) == ["Deleted", "Live"]


def test_list_events_sort_date_desc_default(client, db):
    owner = _make_user(db)
    _override_user(owner)
    client.post("/api/events", json={"name": "Old", "event_date": "2026-01-01"})
    client.post("/api/events", json={"name": "Mid", "event_date": "2026-06-01"})
    client.post("/api/events", json={"name": "New", "event_date": "2026-12-01"})
    res = client.get("/api/events")
    names = [e["name"] for e in res.json()]
    assert names == ["New", "Mid", "Old"]


# ─── 3. Get one ────────────────────────────────────────────────────────


def test_get_event_cross_tenant_404(client, db):
    a = _make_user(db, email="a@bonbox.test")
    b = _make_user(db, email="b@bonbox.test")
    _override_user(a)
    created = client.post(
        "/api/events", json={"name": "A's event", "event_date": "2026-05-01"}
    ).json()
    _override_user(b)
    res = client.get(f"/api/events/{created['id']}")
    assert res.status_code == 404


# ─── 4. Update ─────────────────────────────────────────────────────────


def test_patch_event_partial(client, db):
    owner = _make_user(db)
    _override_user(owner)
    created = client.post(
        "/api/events",
        json={"name": "Initial", "event_date": "2026-05-01", "venue": "Hall A"},
    ).json()
    res = client.patch(
        f"/api/events/{created['id']}",
        json={"name": "Renamed", "notes": "Updated note"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["name"] == "Renamed"
    assert body["venue"] == "Hall A"  # unchanged
    assert body["notes"] == "Updated note"


def test_patch_event_cross_tenant_404(client, db):
    a = _make_user(db, email="a@bonbox.test")
    b = _make_user(db, email="b@bonbox.test")
    _override_user(a)
    created = client.post(
        "/api/events", json={"name": "A's event", "event_date": "2026-05-01"}
    ).json()
    _override_user(b)
    res = client.patch(f"/api/events/{created['id']}", json={"name": "Hijacked"})
    assert res.status_code == 404


# ─── 5. Soft-delete ────────────────────────────────────────────────────


def test_soft_delete_event(client, db):
    owner = _make_user(db)
    _override_user(owner)
    created = client.post(
        "/api/events", json={"name": "Soon gone", "event_date": "2026-05-01"}
    ).json()
    res = client.delete(f"/api/events/{created['id']}")
    assert res.status_code == 204
    res = client.get(f"/api/events/{created['id']}")
    # include_deleted=True path → soft-deleted still readable for audit
    assert res.status_code == 200
    body = res.json()
    assert body["is_deleted"] is True
    assert body["deleted_at"]


# ─── 6. Summary aggregate ─────────────────────────────────────────────


def test_summary_aggregates_sales_and_tickets(client, db):
    owner = _make_user(db)
    _override_user(owner)
    ev = client.post(
        "/api/events", json={"name": "Show", "event_date": "2026-05-01"}
    ).json()
    eid = ev["id"]

    # 3 sales tagged to this event — one with ticket_breakdown, one exempt, one plain.
    client.post(
        "/api/sales",
        json={
            "date": "2026-05-01",
            "amount": 1000,  # gross-incl-moms
            "payment_method": "card",
            "event_id": eid,
            "ticket_breakdown": {
                "adult": {"price": 250, "count": 3},  # 3 guests
                "student": {"price": 150, "count": 4},  # 4 guests
            },
        },
    )
    client.post(
        "/api/sales",
        json={
            "date": "2026-05-01",
            "amount": 500,
            "payment_method": "cash",
            "event_id": eid,
            "is_tax_exempt": True,
        },
    )
    client.post(
        "/api/sales",
        json={
            "date": "2026-05-01",
            "amount": 200,
            "payment_method": "mobilepay",
            "event_id": eid,
            "guest_count": 5,  # contributes to fallback guest count
        },
    )
    # Untagged sale (different event_id=None) — must NOT appear in summary.
    client.post(
        "/api/sales",
        json={"date": "2026-05-01", "amount": 999, "payment_method": "card"},
    )

    res = client.get(f"/api/events/{eid}/summary")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["sale_count"] == 3
    assert body["total_sales_amount"] == pytest.approx(1000 + 500 + 200)
    assert body["total_exempt_amount"] == pytest.approx(500)
    # MOMS only on non-exempt: 1000 + 200 = 1200 gross → 1200*0.2 = 240
    assert body["total_moms"] == pytest.approx(240, abs=0.5)
    # Guests: 3 + 4 from ticket_breakdown + 5 fallback = 12
    assert body["total_guests"] == 12


# ─── 7. Sale.event_id validation ──────────────────────────────────────


def test_post_sale_rejects_cross_tenant_event(client, db):
    a = _make_user(db, email="a@bonbox.test")
    b = _make_user(db, email="b@bonbox.test")
    _override_user(a)
    ev = client.post(
        "/api/events", json={"name": "A only", "event_date": "2026-05-01"}
    ).json()
    _override_user(b)
    res = client.post(
        "/api/sales",
        json={
            "date": "2026-05-01",
            "amount": 100,
            "payment_method": "cash",
            "event_id": ev["id"],  # try to use User A's event
        },
    )
    assert res.status_code == 404


def test_post_sale_with_own_event(client, db):
    owner = _make_user(db)
    _override_user(owner)
    ev = client.post(
        "/api/events", json={"name": "Mine", "event_date": "2026-05-01"}
    ).json()
    res = client.post(
        "/api/sales",
        json={
            "date": "2026-05-01",
            "amount": 250,
            "payment_method": "card",
            "event_id": ev["id"],
        },
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["event_id"] == ev["id"]


# ─── 8 + 9. /sales filter by event_id ──────────────────────────────────


def test_list_sales_filtered_by_event(client, db):
    owner = _make_user(db)
    _override_user(owner)
    ev = client.post(
        "/api/events", json={"name": "Filter test", "event_date": "2026-05-01"}
    ).json()

    client.post(
        "/api/sales",
        json={"date": "2026-05-01", "amount": 100, "payment_method": "cash", "event_id": ev["id"]},
    )
    client.post(
        "/api/sales",
        json={"date": "2026-05-01", "amount": 200, "payment_method": "card"},  # untagged
    )

    res = client.get(f"/api/sales?event_id={ev['id']}")
    assert res.status_code == 200
    rows = res.json()
    assert len(rows) == 1
    assert float(rows[0]["amount"]) == 100

    # Untagged filter
    res = client.get("/api/sales?event_id=null")
    assert res.status_code == 200
    rows = res.json()
    assert all(r["event_id"] is None for r in rows)
    assert any(float(r["amount"]) == 200 for r in rows)


def test_list_sales_invalid_event_id_400(client, db):
    owner = _make_user(db)
    _override_user(owner)
    res = client.get("/api/sales?event_id=not-a-uuid")
    assert res.status_code == 400


# ─── 10. ticket_breakdown validation ──────────────────────────────────


def test_ticket_breakdown_malformed_422(client, db):
    owner = _make_user(db)
    _override_user(owner)
    res = client.post(
        "/api/sales",
        json={
            "date": "2026-05-01",
            "amount": 100,
            "payment_method": "cash",
            "ticket_breakdown": "not a dict",
        },
    )
    assert res.status_code == 422


def test_ticket_breakdown_negative_count_422(client, db):
    owner = _make_user(db)
    _override_user(owner)
    res = client.post(
        "/api/sales",
        json={
            "date": "2026-05-01",
            "amount": 100,
            "payment_method": "cash",
            "ticket_breakdown": {"adult": {"price": 100, "count": -1}},
        },
    )
    assert res.status_code == 422


def test_ticket_breakdown_empty_dict_treated_as_none(client, db):
    """An explicit empty {} is normalised to None so we don't store noise."""
    owner = _make_user(db)
    _override_user(owner)
    res = client.post(
        "/api/sales",
        json={
            "date": "2026-05-01",
            "amount": 100,
            "payment_method": "cash",
            "ticket_breakdown": {},
        },
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["ticket_breakdown"] is None


# ─── 11. Backwards compatibility — existing sale flows untouched ─────


def test_existing_sale_create_without_event_still_works(client, db):
    """The whole point of the migration: every existing sale flow must
    keep working without the new fields. Pinned so a future tightening
    (e.g. making event_id required) requires a deliberate decision."""
    owner = _make_user(db)
    _override_user(owner)
    res = client.post(
        "/api/sales",
        json={"date": "2026-05-01", "amount": 99.50, "payment_method": "card"},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["event_id"] is None
    assert body["ticket_breakdown"] is None
