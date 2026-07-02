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

    def info_d(db, user, now, skip=frozenset()):
        return ds._finding("c_info", "info", "/a")

    def urgent_d(db, user, now, skip=frozenset()):
        return ds._finding("c_urgent", "urgent", "/b")

    def warn_d(db, user, now, skip=frozenset()):
        return ds._finding("c_warn", "warn", "/c")

    def boom_d(db, user, now, skip=frozenset()):
        raise RuntimeError("detector blew up")

    def none_d(db, user, now, skip=frozenset()):
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


def test_skip_worst_unreconciled_surfaces_next_worst(db):
    """Dismissing the worst unreconciled close must surface the NEXT-worst —
    the skip goes into the worst-scan, it is not a post-filter that would
    silently mask every other broken close."""
    user = _owner(db)
    biz_today = business_today_local(user)
    worst_d = biz_today - timedelta(days=10)
    next_d = biz_today - timedelta(days=5)
    _add_close(db, user, d=worst_d, status="confirmed", revenue=10000, payment=4000)
    _add_close(db, user, d=next_d, status="confirmed", revenue=10000, payment=8000)

    # No skip → the worst (largest gap) wins.
    f = _only(ds.run_diagnostics(db, user), "close_unreconciled")[0]
    assert f["meta"]["date"] == worst_d.isoformat()

    # Skip the worst → the next-worst surfaces instead of nothing.
    skip = {("close_unreconciled", worst_d.isoformat())}
    f = _only(ds.run_diagnostics(db, user, skip=skip), "close_unreconciled")[0]
    assert f["meta"]["date"] == next_d.isoformat()

    # Skip both → the row disappears.
    skip.add(("close_unreconciled", next_d.isoformat()))
    assert _only(ds.run_diagnostics(db, user, skip=skip), "close_unreconciled") == []


def test_skip_stale_draft_recomputes_oldest_and_count(db):
    """Dismissing the oldest stale draft re-anchors the finding on the next
    one, and the count only covers non-dismissed drafts."""
    user = _owner(db)
    biz_today = business_today_local(user)
    oldest_d = biz_today - timedelta(days=20)
    newer_d = biz_today - timedelta(days=10)
    _add_close(db, user, d=oldest_d, status="draft", revenue=10000, payment=10000)
    _add_close(db, user, d=newer_d, status="draft", revenue=5000, payment=5000)

    f = _only(ds.run_diagnostics(db, user), "stale_draft_close")[0]
    assert f["meta"]["date"] == oldest_d.isoformat()
    assert f["meta"]["count"] == 2

    skip = {("stale_draft_close", oldest_d.isoformat())}
    f = _only(ds.run_diagnostics(db, user, skip=skip), "stale_draft_close")[0]
    assert f["meta"]["date"] == newer_d.isoformat()
    assert f["meta"]["count"] == 1

    skip.add(("stale_draft_close", newer_d.isoformat()))
    assert _only(ds.run_diagnostics(db, user, skip=skip), "stale_draft_close") == []


def test_router_parse_skip_is_fail_soft():
    """Malformed tokens, unknown codes and bad dates are ignored — never a 500
    from a corrupted localStorage value."""
    from app.routers.diagnostics import _parse_skip

    raw = (
        "close_unreconciled:2026-05-04,"          # valid
        "stale_draft_close:2026-05-16,"           # valid
        "close_missing:not-a-date,"               # bad date → dropped
        "unconfirmed_reservations:2026-05-01,"    # non-skippable code → dropped
        "garbage,"                                 # no colon → dropped
        ":2026-01-01,"                             # empty code → dropped
        "close_missing:"                           # empty date → dropped
    )
    assert _parse_skip(raw) == {
        ("close_unreconciled", "2026-05-04"),
        ("stale_draft_close", "2026-05-16"),
    }
    assert _parse_skip("") == set()
    # Token cap: only the first 60 tokens are considered.
    flood = ",".join(f"close_missing:2026-01-{(i % 28) + 1:02d}" for i in range(200))
    assert len(_parse_skip(flood)) <= 60
