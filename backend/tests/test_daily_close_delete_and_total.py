"""Two things the kasserapport depends on outside the renderer.

1. THE ROOT CAUSE (B1). A stored row could disagree with itself:
   revenue_categories='food:-57' next to revenue_total 0.00. The save path
   derived the total only when the breakdown summed to something POSITIVE
   (`elif breakdown_sum > 0`), so a correction day fell through to 0 while its
   lines were persisted verbatim. Fixing the PDF alone would only have made the
   document honest ABOUT a bad row; the row must not be writable.

2. THE LIFECYCLE GAP (F1). An owner could not delete a draft kasserapport, so a
   mistaken or contradictory kladde sat forever in the exact list an owner hands
   to their revisor. A LOCKED close is regnskabsmateriale under Bogføringsloven
   §10 and must still refuse deletion, with a reason.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.daily_close import DailyClose
from app.models.user import User
from app.services.auth import hash_password, create_access_token
from app.utils.time import utc_now

_db_ready.set()


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

    def _override_get_db():
        try:
            yield s
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client():
    yield TestClient(app)
    app.dependency_overrides.clear()


def _user(db, email="manoj@cafe.dk"):
    u = User(
        email=email,
        password_hash=hash_password("x"),
        business_name="Café Manoj",
        business_type="restaurant",
        currency="DKK",
        created_at=utc_now() - timedelta(days=2),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _headers(u):
    return {"Authorization": f"Bearer {create_access_token(str(u.id))}"}


# ─────────────────── B1 — the row must not contradict itself ─────────────────


def test_negative_breakdown_is_saved_as_the_total(db_session, client):
    """The exact production shape. 'food:-57' must store revenue_total -57,00,
    not 0.00 — the lines and the total are one fact, not two."""
    u = _user(db_session)
    r = client.post("/api/daily-close", headers=_headers(u), json={
        "date": "2026-09-17",
        "status": "draft",
        "revenue_breakdown": {"food": -57},
    })
    assert r.status_code == 200, r.text
    dc = db_session.query(DailyClose).filter(DailyClose.user_id == u.id).first()
    assert dc.revenue_categories == "food:-57"
    assert float(dc.revenue_total) == -57.0


def test_mixed_breakdown_with_a_correction_sums_to_the_net(db_session, client):
    """A real correction day: a positive category and a refund line."""
    u = _user(db_session)
    r = client.post("/api/daily-close", headers=_headers(u), json={
        "date": "2026-09-18",
        "status": "draft",
        "revenue_breakdown": {"food": 1000, "returns": -57},
    })
    assert r.status_code == 200, r.text
    dc = db_session.query(DailyClose).filter(DailyClose.user_id == u.id).first()
    assert float(dc.revenue_total) == 943.0


def test_negative_revenue_carries_negative_moms(db_session, client):
    """`if revenue_total > 0` zeroed the VAT on a negative day, so the stored
    MOMS contradicted the stored revenue. A net-negative day files negative
    salgsmoms."""
    u = _user(db_session)
    r = client.post("/api/daily-close", headers=_headers(u), json={
        "date": "2026-09-19",
        "status": "draft",
        "revenue_breakdown": {"food": -500},
    })
    assert r.status_code == 200, r.text
    dc = db_session.query(DailyClose).filter(DailyClose.user_id == u.id).first()
    assert float(dc.revenue_total) == -500.0
    assert float(dc.moms_total) == -100.0          # 25% of gross = a fifth
    assert float(dc.revenue_ex_moms) == -400.0     # net + moms == gross


def test_positive_breakdown_still_sums_as_before(db_session, client):
    """The fix must not disturb the ordinary day."""
    u = _user(db_session)
    r = client.post("/api/daily-close", headers=_headers(u), json={
        "date": "2026-09-16",
        "status": "draft",
        "revenue_breakdown": {"food": 8000, "drinks": 2000},
    })
    assert r.status_code == 200, r.text
    dc = db_session.query(DailyClose).filter(DailyClose.user_id == u.id).first()
    assert float(dc.revenue_total) == 10000.0
    assert float(dc.moms_total) == 2000.0


def test_ocr_override_still_wins_over_a_partial_breakdown(db_session, client):
    """The documented OCR case (categories partial, bottom line detected) is
    untouched: a single bad parse must not overwrite the real total."""
    u = _user(db_session)
    r = client.post("/api/daily-close", headers=_headers(u), json={
        "date": "2026-09-15",
        "status": "draft",
        "revenue_breakdown": {"drinks": 1.82},
        "revenue_total_override": 17030,
    })
    assert r.status_code == 200, r.text
    dc = db_session.query(DailyClose).filter(DailyClose.user_id == u.id).first()
    assert float(dc.revenue_total) == 17030.0


# ─────────────────── F1 — delete a kladde, never a record ────────────────────


def _make_close(db, user, status="draft"):
    dc = DailyClose(
        user_id=user.id,
        date=date(2026, 9, 17),
        revenue_total=1000.0,
        moms_total=200.0,
        revenue_ex_moms=800.0,
        status=status,
        closed_at=utc_now() if status == "confirmed" else None,
    )
    db.add(dc); db.commit(); db.refresh(dc)
    return dc


def test_delete_works_on_a_draft(db_session, client):
    u = _user(db_session)
    dc = _make_close(db_session, u, status="draft")
    r = client.delete(f"/api/daily-close/{dc.id}", headers=_headers(u))
    assert r.status_code == 204, r.text
    db_session.refresh(dc)
    assert dc.is_deleted is True


def test_delete_is_soft_not_a_row_removal(db_session, client):
    """Soft-delete matches the table's is_deleted column — the row survives for
    the audit trail; it just leaves the owner's history."""
    u = _user(db_session)
    dc = _make_close(db_session, u, status="draft")
    client.delete(f"/api/daily-close/{dc.id}", headers=_headers(u))
    still_there = db_session.query(DailyClose).filter(DailyClose.id == dc.id).first()
    assert still_there is not None
    assert still_there.is_deleted is True
    assert still_there.deleted_at is not None


def test_deleted_draft_leaves_the_history_list(db_session, client):
    """The whole point: it must be gone from the list an owner hands over."""
    u = _user(db_session)
    dc = _make_close(db_session, u, status="draft")
    client.delete(f"/api/daily-close/{dc.id}", headers=_headers(u))
    listed = client.get("/api/daily-close", headers=_headers(u)).json()
    assert all(row["id"] != str(dc.id) for row in listed)


def test_delete_refuses_a_locked_close_with_a_reason(db_session, client):
    """A locked close is the day's kasserapport under Bogføringsloven §10. The
    refusal must say what to do, not just fail."""
    u = _user(db_session)
    dc = _make_close(db_session, u, status="confirmed")
    r = client.delete(f"/api/daily-close/{dc.id}", headers=_headers(u))
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["error"] == "close_locked"
    assert "Unlock" in detail["message"]
    db_session.refresh(dc)
    assert dc.is_deleted is not True


def test_delete_writes_an_audit_row(db_session, client):
    u = _user(db_session)
    dc = _make_close(db_session, u, status="draft")
    client.delete(f"/api/daily-close/{dc.id}", headers=_headers(u))
    rows = (
        db_session.query(AuditLog)
        .filter(AuditLog.action == "close.deleted")
        .all()
    )
    assert len(rows) == 1
    assert str(rows[0].entity_id) == str(dc.id)


def test_delete_refuses_another_users_close(db_session, client):
    """IDOR — generic 404, no existence leak."""
    alice = _user(db_session, email="alice@a.dk")
    bob = _user(db_session, email="bob@b.dk")
    dc = _make_close(db_session, alice, status="draft")
    r = client.delete(f"/api/daily-close/{dc.id}", headers=_headers(bob))
    assert r.status_code == 404
    db_session.refresh(dc)
    assert dc.is_deleted is not True
