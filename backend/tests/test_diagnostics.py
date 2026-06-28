"""Diagnostics "Needs du nu" — read-only detector queue.

Verifies the runner contract (severity sort + fail-soft per detector) and that
the real detectors don't crash on an empty account (they all return None).

Run:
  cd backend && python3 -m pytest tests/test_diagnostics.py -x -q
"""
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.user import User
from app.models.daily_close import DailyClose
from app.services import diagnostics_service as ds
from app.services.auth import hash_password
from app.services.tz_utils import business_today_local


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


def _owner(db):
    u = User(
        email="owner@bonbox.dk",
        password_hash=hash_password("pw12345678"),
        business_name="Bon",
        business_type="cafe",
        currency="DKK",
        plan="starter",
        role="owner",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def test_runner_sorts_by_severity_and_is_fail_soft(db, monkeypatch):
    user = _owner(db)

    def info_d(db, user, now):
        return ds._finding("c_info", "info", "/a")

    def urgent_d(db, user, now):
        return ds._finding("c_urgent", "urgent", "/b")

    def warn_d(db, user, now):
        return ds._finding("c_warn", "warn", "/c")

    def boom_d(db, user, now):
        raise RuntimeError("detector blew up")

    def none_d(db, user, now):
        return None

    monkeypatch.setattr(ds, "_DETECTORS", [info_d, boom_d, urgent_d, none_d, warn_d])

    findings = ds.run_diagnostics(db, user)
    # The raiser is dropped (fail-soft); the None is skipped; the rest are
    # sorted urgent → warn → info.
    assert [f["code"] for f in findings] == ["c_urgent", "c_warn", "c_info"]


def test_empty_account_yields_no_findings_and_does_not_crash(db):
    user = _owner(db)
    findings = ds.run_diagnostics(db, user)
    assert findings == []


def test_finding_shape_is_structured_not_human_strings():
    f = ds._finding("x", "warn", "/path", {"count": 2})
    # Server returns codes + meta; the frontend localizes (DK terms stay client).
    assert set(f.keys()) == {"code", "severity", "deep_link", "meta"}
    assert f["meta"] == {"count": 2}
    assert "title" not in f and "message" not in f


def _add_close(db, user, *, d, status, revenue, payment):
    c = DailyClose(
        user_id=user.id,
        date=d,
        status=status,
        revenue_total=revenue,
        payment_total=payment,
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _only(findings, code):
    return [f for f in findings if f["code"] == code]


def test_stale_draft_close_detected_with_ties_out_false(db):
    """(a) A draft dated 30 days ago whose payments ≠ revenue → flagged
    stale_draft_close, severity warn, ties_out False."""
    user = _owner(db)
    biz_today = business_today_local(user)
    _add_close(
        db, user,
        d=biz_today - timedelta(days=30),
        status="draft",
        revenue=10000,
        payment=7000,  # 3.000 kr off → does NOT tie out
    )

    findings = ds.run_diagnostics(db, user)
    hits = _only(findings, "stale_draft_close")
    assert len(hits) == 1
    f = hits[0]
    assert f["severity"] == "warn"
    assert f["meta"]["ties_out"] is False
    assert f["meta"]["count"] == 1
    assert f["meta"]["date"] == (biz_today - timedelta(days=30)).isoformat()
    # Deep-link uses the daily-close date grammar.
    assert f["deep_link"] == f"/daily-close?date={f['meta']['date']}"


def test_close_unreconciled_detected_urgent(db):
    """(b) A CONFIRMED close with payment far from revenue → flagged
    close_unreconciled, severity urgent."""
    user = _owner(db)
    biz_today = business_today_local(user)
    _add_close(
        db, user,
        d=biz_today - timedelta(days=3),
        status="confirmed",
        revenue=10000,
        payment=4000,  # 6.000 kr / 60% off → clear mismatch
    )

    findings = ds.run_diagnostics(db, user)
    hits = _only(findings, "close_unreconciled")
    assert len(hits) == 1
    f = hits[0]
    assert f["severity"] == "urgent"
    assert f["meta"]["diff"] == -6000.0
    assert f["meta"]["date"] == (biz_today - timedelta(days=3)).isoformat()
    assert f["deep_link"] == f"/daily-close?date={f['meta']['date']}"
    # urgent sorts to the very front of the queue.
    assert findings[0]["code"] == "close_unreconciled"


def test_old_confirmed_close_unreconciled_still_surfaces(db):
    """Regression: a CONFIRMED close that doesn't tie out must NOT age out
    of the queue. A 60-day-old locked mismatch (the real 04-May case:
    payment 573 ≠ revenue 1.118) is the worst kind — it may already be at
    the revisor — yet the old 31-day window silently dropped it. The
    detector is now unbounded in time and still surfaces the single worst."""
    user = _owner(db)
    biz_today = business_today_local(user)
    _add_close(
        db, user,
        d=biz_today - timedelta(days=60),  # well past the old 31-day cap
        status="confirmed",
        revenue=1118,
        payment=573,  # ~49% off → clear mismatch
    )

    findings = ds.run_diagnostics(db, user)
    hits = _only(findings, "close_unreconciled")
    assert len(hits) == 1
    assert hits[0]["severity"] == "urgent"
    assert hits[0]["meta"]["date"] == (biz_today - timedelta(days=60)).isoformat()


def test_confirmed_close_that_ties_out_is_not_flagged(db):
    """(c) A CONFIRMED close that ties out (within tolerance) → NO false
    positive. A tiny tips/rounding gap must never alarm."""
    user = _owner(db)
    biz_today = business_today_local(user)
    _add_close(
        db, user,
        d=biz_today - timedelta(days=3),
        status="confirmed",
        revenue=10000,
        payment=10050,  # 50 kr / 0.5% → under both thresholds, tied out
    )

    findings = ds.run_diagnostics(db, user)
    assert _only(findings, "close_unreconciled") == []


def test_draft_dated_today_is_not_flagged_as_stale(db):
    """(d) A draft for TODAY → NOT stale (the day may still be open)."""
    user = _owner(db)
    biz_today = business_today_local(user)
    _add_close(
        db, user,
        d=biz_today,
        status="draft",
        revenue=10000,
        payment=7000,
    )

    findings = ds.run_diagnostics(db, user)
    assert _only(findings, "stale_draft_close") == []
