"""Tests for the Smart Scan /classify per-user daily cap (D-smartscan-cap).

Smart Scan /classify runs paid Claude-vision OCR (classify_document_type)
PLUS a paid extractor on every call. Before this fix it was gated only by
auth + a 20/min per-IP slowapi cap — there was NO per-user daily cap, so a
single Free account could drive unlimited paid OCR (unlike the dedicated
OCR paths: z_report_scans_per_day, expense_receipt_scans_per_month).

This pins the multi-barrier cost guard:
  • PLAN_CAPS["smart_scan_classify_per_day"] exists for EVERY tier, Free
    being the smallest taste (10/day) and paid tiers higher.
  • enforce_cap raises the canonical 402 upgrade payload once a Free user
    has hit their daily allowance — counted via audit_logs
    `smart_scan.classified` rows in the user's LOCAL business day (the same
    row _log_classify_audit writes per call, so the counter is real).
  • _today_classify_count only counts this tenant's classify rows inside
    the current business-day window (no cross-tenant / cross-day leak).

No Anthropic SDK calls here — we exercise the cap layer directly with
audit rows, no network.
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.audit_log import AuditLog
from app.models.user import User
from app.services import audit_service
from app.services.billing import PLAN_CAPS, enforce_cap, get_cap
from app.utils.time import utc_now


CAP_KEY = "smart_scan_classify_per_day"


# ─── Fixtures ────────────────────────────────────────────────────────

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


@pytest.fixture
def free_user(db):
    u = User(
        email="free-cap@mirabelle.dk",
        password_hash="x",
        business_name="Mirabelle",
        business_type="restaurant",
        currency="DKK",
        plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def starter_user(db):
    u = User(
        email="starter-cap@example.com",
        password_hash="x",
        business_name="Starter",
        business_type="restaurant",
        currency="DKK",
        plan="starter",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _write_classify_audit_rows(db, user, n: int) -> None:
    """Write n `smart_scan.classified` audit rows for this user — the same
    action the router's _log_classify_audit writes per real classify call."""
    for i in range(n):
        audit_service.record(
            db,
            user=user,
            action="smart_scan.classified",
            entity_type="smart_scan",
            entity_id=None,
            after={"doc_type": "receipt", "route_to": "/expenses", "i": i},
            ip_address=None,
        )
    db.commit()


# ─── Layer 1: the cap exists for every tier ─────────────────────────

def test_cap_exists_in_plan_caps_for_all_tiers():
    """smart_scan_classify_per_day must be present in EVERY plan (the
    test suite's no-leak guarantee — a missing key would silently fall
    through to free's cap via get_cap)."""
    for plan in ("free", "starter", "trial", "pro"):
        assert CAP_KEY in PLAN_CAPS[plan], (
            f"{CAP_KEY} missing from PLAN_CAPS[{plan!r}] — Free would leak"
        )


def test_cap_values_per_tier_sane():
    """Free is the smallest taste; paid tiers are strictly higher; the cap
    is a positive bounded integer on every tier (never -1/unlimited so the
    paid OCR always has a real per-user ceiling)."""
    free = PLAN_CAPS["free"][CAP_KEY]
    starter = PLAN_CAPS["starter"][CAP_KEY]
    trial = PLAN_CAPS["trial"][CAP_KEY]
    pro = PLAN_CAPS["pro"][CAP_KEY]

    assert free == 10, "Free taste should be 10/day"
    assert starter > free, "Starter must beat Free"
    assert pro >= starter, "Pro must be at least Starter"
    assert trial == pro, "Trial mirrors Pro"
    # Bounded — no unlimited (-1) on a paid-per-call OCR surface.
    for v in (free, starter, trial, pro):
        assert isinstance(v, int) and v > 0


# ─── Layer 2: enforce_cap fires the 402 over the cap ─────────────────

def test_free_user_over_cap_gets_402(free_user):
    """A Free user who has already used their full daily allowance gets the
    canonical 402 upgrade payload from enforce_cap."""
    cap = get_cap(free_user, CAP_KEY)
    assert cap == 10

    # used == cap → at_cap → 402
    with pytest.raises(HTTPException) as exc:
        enforce_cap(free_user, CAP_KEY, cap)

    assert exc.value.status_code == 402
    detail = exc.value.detail
    assert isinstance(detail, dict)
    assert detail["error"] == "cap_exceeded"
    assert detail["cap"] == CAP_KEY
    assert detail["limit"] == cap
    assert detail["upgrade_to"] in ("starter", "pro")


def test_free_user_under_cap_passes(free_user):
    """Just below the cap → no raise (the Nth call within the allowance
    must go through)."""
    cap = get_cap(free_user, CAP_KEY)
    # used == cap - 1 → still under → no exception
    enforce_cap(free_user, CAP_KEY, cap - 1)


def test_starter_user_above_free_cap_passes(starter_user):
    """A Starter user at Free's ceiling is nowhere near their own cap, so
    the gate must NOT fire (no tier-leak where Starter inherits Free's
    smaller cap)."""
    free_cap = PLAN_CAPS["free"][CAP_KEY]
    enforce_cap(starter_user, CAP_KEY, free_cap)  # must not raise


# ─── Layer 3: the router's business-day counter is honest ───────────

def test_today_classify_count_counts_classify_rows(db, free_user):
    """_today_classify_count counts this user's smart_scan.classified rows
    inside the current business day — and ONLY those rows."""
    from app.routers.smart_scan import _today_classify_count

    assert _today_classify_count(db, free_user) == 0

    _write_classify_audit_rows(db, free_user, 3)
    assert _today_classify_count(db, free_user) == 3

    # An unrelated audit action for the same user must NOT inflate the count.
    audit_service.record(
        db,
        user=free_user,
        action="smart_scan.manual_override",
        entity_type="smart_scan",
        entity_id=None,
        after={"original_doc_type": "receipt", "chosen_doc_type": "invoice"},
        ip_address=None,
    )
    db.commit()
    assert _today_classify_count(db, free_user) == 3


def test_today_classify_count_is_tenant_scoped(db, free_user, starter_user):
    """One tenant's classify rows must never count toward another's cap."""
    from app.routers.smart_scan import _today_classify_count

    _write_classify_audit_rows(db, free_user, 5)
    _write_classify_audit_rows(db, starter_user, 2)

    assert _today_classify_count(db, free_user) == 5
    assert _today_classify_count(db, starter_user) == 2


def test_today_classify_count_excludes_prior_business_day(db, free_user):
    """Rows older than the current business-day window don't count — the
    cap is per-day, so yesterday's scans must not block today's."""
    from app.routers.smart_scan import _today_classify_count
    from app.services.tz_utils import business_day_window

    start_utc, _end_utc = business_day_window(free_user)

    # Write one in-window row + backdate two rows to before the window start.
    _write_classify_audit_rows(db, free_user, 1)
    old_rows = (
        db.query(AuditLog)
        .filter(
            AuditLog.user_id == free_user.id,
            AuditLog.action == "smart_scan.classified",
        )
        .all()
    )
    assert len(old_rows) == 1  # only the in-window one so far

    # Two clearly-yesterday rows.
    for i in range(2):
        row = AuditLog(
            user_id=free_user.id,
            actor_id=free_user.id,
            actor_type="user",
            action="smart_scan.classified",
            entity_type="smart_scan",
            entity_id=None,
            after_state="{}",
        )
        row.created_at = start_utc - timedelta(hours=2 + i)
        db.add(row)
    db.commit()

    # Only the in-window row counts.
    assert _today_classify_count(db, free_user) == 1
