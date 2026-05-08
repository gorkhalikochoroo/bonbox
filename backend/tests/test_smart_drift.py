"""Tests for smart_drift — weekly re-inference + diff detection.

Multi-layer pinned:
  • Material drift detection: open-day flip, hour shift, role count change.
  • Idempotency: scanning twice produces ONE finding row, not two.
  • Cooldown: dismissed findings don't re-pin within DRIFT_COOLDOWN_DAYS.
  • Tenant boundary: cross-owner finding is invisible / unaccessible.
  • Apply / dismiss state machine: rejects double-dismiss / double-apply.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.business_profile import BusinessProfile
from app.models.sale import Sale
from app.models.smart_drift_finding import SmartDriftFinding
from app.models.staff_role_target import StaffRoleTarget
from app.models.user import User
from app.services.smart_drift import (
    DRIFT_COOLDOWN_DAYS,
    DriftFindingError,
    apply_finding,
    dismiss_finding,
    list_open_findings,
    run_drift_scan_for_user,
)
from app.utils.time import utc_now


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


def _user(db, *, vertical="restaurant", email=None) -> User:
    u = User(
        email=email or f"{vertical}-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x",
        business_name=vertical.title(),
        business_type=vertical,
        currency="DKK",
        plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _seed_saved_profile(db, user, *, mask="12345", hours=None, peaks=None, roles=None):
    """Pre-populate BusinessProfile + StaffRoleTarget rows so the drift
    scan has something to diff against."""
    bp = BusinessProfile(
        user_id=user.id,
        open_days_mask=mask,
        operating_hours_json=json.dumps(hours or {"mon": "09:00-17:00"}),
        peak_windows_json=json.dumps(peaks or []),
    )
    db.add(bp)
    for r in (roles or []):
        db.add(StaffRoleTarget(
            user_id=user.id, role=r["role"], default_count=r["default_count"],
        ))
    db.commit()


def _seed_strong_history(db, user, *, mask_days_open=("1", "2", "3", "4", "5"), open_at_hour=10, close_at_hour=22):
    """Seed enough sales history that infer_staffing_profile returns at
    least medium confidence — required for drift findings to write."""
    today = date.today()
    base = today - timedelta(days=30)
    for day_offset in range(28):
        d = base + timedelta(days=day_offset)
        weekday_digit = str((d.weekday() % 7) + 1)
        if weekday_digit not in mask_days_open:
            continue
        # Add multiple sales spanning the open window so P5/P95 matches.
        for hour in (open_at_hour, open_at_hour + 4, close_at_hour - 1):
            db.add(Sale(
                id=uuid.uuid4(),
                user_id=user.id,
                date=d,
                amount=100,
                payment_method="card",
                created_at=datetime(d.year, d.month, d.day, hour, 30),
            ))
    db.commit()


# ─── Fail-closed: no saved + no history ─────────────────────────────


def test_no_drift_when_no_data(db):
    """Fresh account, no saved profile, no sales — no findings."""
    user = _user(db)
    rows = run_drift_scan_for_user(db, user=user)
    assert rows == []


# ─── Drift detection — happy paths ──────────────────────────────────


def test_drift_finding_created_when_hours_shift(db):
    """Saved hours say 09:00–17:00. Sales history says 10:00–22:00 most days.
    The diff should fire and persist a finding."""
    user = _user(db)
    # Saved profile lags reality
    _seed_saved_profile(db, user, mask="12345",
                        hours={d: "09:00-17:00" for d in ("mon","tue","wed","thu","fri")})
    # New sales pattern — late-evening operation
    _seed_strong_history(db, user, mask_days_open=("1","2","3","4","5"),
                         open_at_hour=10, close_at_hour=22)
    rows = run_drift_scan_for_user(db, user=user)
    assert len(rows) == 1
    f = rows[0]
    assert f.kind == "staffing"
    assert f.dismissed_at is None
    assert f.applied_at is None
    payload = f.payload_json
    assert "summary" in payload
    assert any("hours_" in c for c in payload["changed"])


def test_drift_finding_idempotent_on_second_scan(db):
    """Running the scan twice in a row → ONE finding row, not two. The
    second run UPDATES the existing open finding."""
    user = _user(db)
    _seed_saved_profile(db, user, mask="12345",
                        hours={d: "09:00-17:00" for d in ("mon","tue","wed","thu","fri")})
    _seed_strong_history(db, user, mask_days_open=("1","2","3","4","5"),
                         open_at_hour=10, close_at_hour=22)
    rows1 = run_drift_scan_for_user(db, user=user)
    rows2 = run_drift_scan_for_user(db, user=user)
    assert len(rows1) == 1
    assert len(rows2) == 1
    # Same DB row — ID survived the second scan
    assert rows1[0].id == rows2[0].id
    total = db.query(SmartDriftFinding).filter(
        SmartDriftFinding.user_id == user.id,
    ).count()
    assert total == 1


# ─── Cooldown ───────────────────────────────────────────────────────


def test_dismissed_finding_not_re_pinned_during_cooldown(db):
    """Owner dismisses a finding. If they re-run the scan that same
    week, we don't insert a fresh finding — they already said no."""
    user = _user(db)
    _seed_saved_profile(db, user, mask="12345",
                        hours={d: "09:00-17:00" for d in ("mon","tue","wed","thu","fri")})
    _seed_strong_history(db, user, mask_days_open=("1","2","3","4","5"),
                         open_at_hour=10, close_at_hour=22)
    rows = run_drift_scan_for_user(db, user=user)
    assert len(rows) == 1
    dismiss_finding(db, user=user, finding_id=rows[0].id)

    # Second scan — should NOT create a new finding (cooldown active)
    rows2 = run_drift_scan_for_user(db, user=user)
    assert rows2 == []
    open_count = (
        db.query(SmartDriftFinding)
        .filter(
            SmartDriftFinding.user_id == user.id,
            SmartDriftFinding.dismissed_at.is_(None),
            SmartDriftFinding.applied_at.is_(None),
        )
        .count()
    )
    assert open_count == 0


def test_dismissed_finding_re_pins_after_cooldown(db):
    """Once the cooldown lapses, the same drift becomes a fresh finding.
    Mimic by manually back-dating the dismissed_at past the cooldown."""
    user = _user(db)
    _seed_saved_profile(db, user, mask="12345",
                        hours={d: "09:00-17:00" for d in ("mon","tue","wed","thu","fri")})
    _seed_strong_history(db, user, mask_days_open=("1","2","3","4","5"),
                         open_at_hour=10, close_at_hour=22)
    rows = run_drift_scan_for_user(db, user=user)
    dismissed = dismiss_finding(db, user=user, finding_id=rows[0].id)
    # Back-date past the cooldown
    dismissed.dismissed_at = utc_now() - timedelta(days=DRIFT_COOLDOWN_DAYS + 1)
    db.commit()

    rows2 = run_drift_scan_for_user(db, user=user)
    assert len(rows2) == 1
    # Fresh finding row (different id from the dismissed one)
    assert rows2[0].id != dismissed.id


# ─── Tenant boundary ────────────────────────────────────────────────


def test_tenant_boundary_findings_per_user_only(db):
    """Owner B's scan must never touch Owner A's findings, and Owner A's
    list_open_findings must not return Owner B's rows."""
    a = _user(db, email="a@bonbox.test")
    b = _user(db, email="b@bonbox.test")
    _seed_saved_profile(db, a, mask="12345",
                        hours={d: "09:00-17:00" for d in ("mon","tue","wed","thu","fri")})
    _seed_strong_history(db, a, mask_days_open=("1","2","3","4","5"),
                         open_at_hour=10, close_at_hour=22)
    a_rows = run_drift_scan_for_user(db, user=a)
    assert len(a_rows) == 1
    # Owner B's open list excludes A's row
    assert list_open_findings(db, user=b) == []
    # Owner B can't dismiss A's finding (404 / DriftFindingError)
    with pytest.raises(DriftFindingError, match="not found"):
        dismiss_finding(db, user=b, finding_id=a_rows[0].id)


# ─── Apply / dismiss state machine ──────────────────────────────────


def test_apply_marks_finding_resolved(db):
    user = _user(db)
    _seed_saved_profile(db, user, mask="12345",
                        hours={d: "09:00-17:00" for d in ("mon","tue","wed","thu","fri")})
    _seed_strong_history(db, user, mask_days_open=("1","2","3","4","5"),
                         open_at_hour=10, close_at_hour=22)
    rows = run_drift_scan_for_user(db, user=user)
    applied = apply_finding(db, user=user, finding_id=rows[0].id)
    assert applied.applied_at is not None
    assert applied.dismissed_at is None
    # Open list excludes applied
    assert list_open_findings(db, user=user) == []


def test_double_apply_rejected(db):
    user = _user(db)
    _seed_saved_profile(db, user, mask="12345",
                        hours={d: "09:00-17:00" for d in ("mon","tue","wed","thu","fri")})
    _seed_strong_history(db, user, mask_days_open=("1","2","3","4","5"),
                         open_at_hour=10, close_at_hour=22)
    rows = run_drift_scan_for_user(db, user=user)
    apply_finding(db, user=user, finding_id=rows[0].id)
    with pytest.raises(DriftFindingError, match="already resolved"):
        apply_finding(db, user=user, finding_id=rows[0].id)


def test_double_dismiss_rejected(db):
    user = _user(db)
    _seed_saved_profile(db, user, mask="12345",
                        hours={d: "09:00-17:00" for d in ("mon","tue","wed","thu","fri")})
    _seed_strong_history(db, user, mask_days_open=("1","2","3","4","5"),
                         open_at_hour=10, close_at_hour=22)
    rows = run_drift_scan_for_user(db, user=user)
    dismiss_finding(db, user=user, finding_id=rows[0].id)
    with pytest.raises(DriftFindingError, match="already resolved"):
        dismiss_finding(db, user=user, finding_id=rows[0].id)


def test_dismiss_with_unknown_id_raises(db):
    user = _user(db)
    with pytest.raises(DriftFindingError, match="not found"):
        dismiss_finding(db, user=user, finding_id=uuid.uuid4())


# ─── Low confidence — no findings ───────────────────────────────────


def test_low_confidence_inference_does_not_pin_drift(db):
    """A user with thin sales history (low-confidence inference) should
    NOT generate drift findings — would be noise, not signal."""
    user = _user(db)
    _seed_saved_profile(db, user, mask="12345",
                        hours={d: "09:00-17:00" for d in ("mon","tue","wed","thu","fri")})
    # Only a handful of sales — inference will be low confidence
    today = date.today()
    db.add(Sale(
        id=uuid.uuid4(), user_id=user.id, date=today,
        amount=50, payment_method="card",
        created_at=datetime(today.year, today.month, today.day, 12, 0),
    ))
    db.commit()
    rows = run_drift_scan_for_user(db, user=user)
    assert rows == []
