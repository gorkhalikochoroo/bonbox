"""Tests for the business operating profile service.

Multi-layer security pinned:
  • Tenant boundary: every read + write filters by user_id
  • Role validation: unknown roles rejected; cross-vertical roles work
  • Open-days mask: digits 1-7 only, no dupes, length-bounded
  • Hours regex: HH:MM-HH:MM or 'closed'; unknown days rejected
  • Peak windows: lenient (drops invalid entries) but bounded
  • Idempotency: upsert twice returns one row, latest values win
  • Bulk atomic: ANY invalid entry rejects the whole batch
  • Role catalog shape: every vertical has roles spanning categories

Each test pinned by the security or correctness invariant it guards.
"""
from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.business_profile import BusinessProfile
from app.models.staff_role_target import StaffRoleTarget
from app.models.user import User
from app.services.business_operating_service import (
    OperatingProfileError,
    ROLE_CATALOG_BY_VERTICAL,
    bulk_upsert_role_targets,
    delete_role_target,
    get_or_create_profile,
    list_role_targets,
    parse_operating_hours,
    parse_peak_windows,
    role_catalog_for,
    upsert_operating_profile,
    upsert_role_target,
)


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
def owner(db):
    u = User(
        email="cafe@bonbox.test",
        password_hash="x",
        business_name="Café Mirabelle",
        business_type="restaurant",
        currency="DKK",
        plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def other_owner(db):
    u = User(
        email="other@bonbox.test",
        password_hash="x",
        business_name="Other",
        business_type="bar",
        currency="DKK",
        plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


# ─── Role catalog shape invariants ────────────────────────────────────


def test_role_catalog_has_seven_verticals():
    """Adding a new vertical is a deliberate decision — pin the count
    so a future edit needs to update this test on purpose."""
    assert set(ROLE_CATALOG_BY_VERTICAL.keys()) == {
        "restaurant", "cafe", "bar", "retail", "salon", "workshop", "grocery",
    }


def test_role_catalog_every_role_has_required_fields():
    """Every entry must have role/category/default_count/label{en,da}.
    A missing field would 500 the role-catalog endpoint or silently
    skip a vertical's roles in the UI."""
    for vertical, roles in ROLE_CATALOG_BY_VERTICAL.items():
        for r in roles:
            assert "role" in r and r["role"], f"{vertical}: missing role id"
            assert r["category"] in (
                "front_of_house", "kitchen", "support", "specialist",
            ), f"{vertical}.{r['role']}: unknown category"
            assert isinstance(r["default_count"], (int, float))
            assert "en" in r["label"] and "da" in r["label"]


def test_role_catalog_no_duplicates_within_vertical():
    for vertical, roles in ROLE_CATALOG_BY_VERTICAL.items():
        ids = [r["role"] for r in roles]
        assert len(ids) == len(set(ids)), f"{vertical}: duplicate role ids"


def test_role_catalog_for_unknown_vertical_falls_back_to_restaurant():
    """Defensive default keeps the onboarding form usable when
    business_type is empty / weird / new vertical not yet in catalog."""
    assert role_catalog_for(None) == ROLE_CATALOG_BY_VERTICAL["restaurant"]
    assert role_catalog_for("") == ROLE_CATALOG_BY_VERTICAL["restaurant"]
    assert role_catalog_for("nonexistent") == ROLE_CATALOG_BY_VERTICAL["restaurant"]


def test_role_catalog_for_normalises_case():
    assert role_catalog_for("RESTAURANT") == ROLE_CATALOG_BY_VERTICAL["restaurant"]


# ─── get_or_create_profile ────────────────────────────────────────────


def test_get_or_create_profile_returns_empty_shell_when_missing(db, owner):
    """Onboarding flow needs a known shape to render against. Never
    return None."""
    p = get_or_create_profile(db, owner=owner)
    assert p is not None
    assert p.user_id == owner.id


def test_get_or_create_profile_idempotent(db, owner):
    p1 = get_or_create_profile(db, owner=owner)
    p2 = get_or_create_profile(db, owner=owner)
    assert p1.id == p2.id


# ─── Open-days validation ─────────────────────────────────────────────


def test_open_days_valid_examples(db, owner):
    p = upsert_operating_profile(
        db, owner_id=owner.id, open_days_mask="12345",
    )
    assert p.open_days_mask == "12345"

    p2 = upsert_operating_profile(
        db, owner_id=owner.id, open_days_mask="1234567",
    )
    assert p2.open_days_mask == "1234567"


def test_open_days_empty_normalised_to_none(db, owner):
    p = upsert_operating_profile(db, owner_id=owner.id, open_days_mask="")
    assert p.open_days_mask is None


def test_open_days_rejects_non_digits(db, owner):
    with pytest.raises(OperatingProfileError):
        upsert_operating_profile(db, owner_id=owner.id, open_days_mask="12a45")


def test_open_days_rejects_zero_and_eight(db, owner):
    with pytest.raises(OperatingProfileError):
        upsert_operating_profile(db, owner_id=owner.id, open_days_mask="0")
    with pytest.raises(OperatingProfileError):
        upsert_operating_profile(db, owner_id=owner.id, open_days_mask="8")


def test_open_days_rejects_duplicates(db, owner):
    with pytest.raises(OperatingProfileError):
        upsert_operating_profile(db, owner_id=owner.id, open_days_mask="11234")


def test_open_days_rejects_too_long(db, owner):
    with pytest.raises(OperatingProfileError):
        upsert_operating_profile(
            db, owner_id=owner.id, open_days_mask="12345678",
        )


# ─── Operating hours validation ───────────────────────────────────────


def test_operating_hours_valid_payload(db, owner):
    p = upsert_operating_profile(
        db, owner_id=owner.id,
        operating_hours={"mon": "10:00-22:00", "tue": "11:00-23:30"},
    )
    parsed = parse_operating_hours(p)
    assert parsed["mon"] == "10:00-22:00"
    assert parsed["tue"] == "11:00-23:30"


def test_operating_hours_closed_value_persists(db, owner):
    p = upsert_operating_profile(
        db, owner_id=owner.id,
        operating_hours={"sun": "closed"},
    )
    assert parse_operating_hours(p)["sun"] == "closed"


def test_operating_hours_rejects_unknown_day(db, owner):
    with pytest.raises(OperatingProfileError):
        upsert_operating_profile(
            db, owner_id=owner.id,
            operating_hours={"funday": "10:00-22:00"},
        )


def test_operating_hours_rejects_malformed_time(db, owner):
    with pytest.raises(OperatingProfileError):
        upsert_operating_profile(
            db, owner_id=owner.id,
            operating_hours={"mon": "10am-10pm"},
        )


def test_operating_hours_rejects_invalid_hour_range(db, owner):
    """25:00 isn't a real time."""
    with pytest.raises(OperatingProfileError):
        upsert_operating_profile(
            db, owner_id=owner.id,
            operating_hours={"mon": "25:00-26:00"},
        )


# ─── Peak windows validation ──────────────────────────────────────────


def test_peak_windows_lenient_drops_invalid_entries(db, owner):
    """Peak hints are advisory — invalid entries are silently dropped
    rather than rejecting the whole call. But ALL entries invalid
    means None."""
    p = upsert_operating_profile(
        db, owner_id=owner.id,
        peak_windows=[
            {"day": "fri", "start": "18:00", "end": "22:00", "label": "rush"},
            {"day": "funday", "start": "18:00", "end": "22:00"},  # bad day
            {"day": "mon", "start": "x", "end": "y"},  # bad time
        ],
    )
    parsed = parse_peak_windows(p)
    assert len(parsed) == 1
    assert parsed[0]["day"] == "fri"


def test_peak_windows_all_invalid_normalised_to_none(db, owner):
    p = upsert_operating_profile(
        db, owner_id=owner.id,
        peak_windows=[{"day": "funday"}],
    )
    assert p.peak_windows_json is None
    assert parse_peak_windows(p) == []


def test_peak_windows_label_capped_at_80(db, owner):
    p = upsert_operating_profile(
        db, owner_id=owner.id,
        peak_windows=[{"day": "fri", "start": "18:00", "end": "22:00", "label": "x" * 200}],
    )
    parsed = parse_peak_windows(p)
    assert len(parsed[0]["label"]) <= 80


# ─── Tenant boundary ──────────────────────────────────────────────────


def test_upsert_operating_profile_creates_per_owner_only(db, owner, other_owner):
    """Owner A's upsert doesn't touch Owner B's row."""
    upsert_operating_profile(db, owner_id=owner.id, open_days_mask="12345")
    upsert_operating_profile(db, owner_id=other_owner.id, open_days_mask="123456")

    rows = db.query(BusinessProfile).all()
    by_user = {r.user_id: r.open_days_mask for r in rows}
    assert by_user[owner.id] == "12345"
    assert by_user[other_owner.id] == "123456"


def test_list_role_targets_tenant_scoped(db, owner, other_owner):
    upsert_role_target(db, owner_id=owner.id, role="server", default_count=2)
    upsert_role_target(db, owner_id=other_owner.id, role="bartender", default_count=3)

    owner_rows = list_role_targets(db, owner_id=owner.id)
    other_rows = list_role_targets(db, owner_id=other_owner.id)
    assert {r.role for r in owner_rows} == {"server"}
    assert {r.role for r in other_rows} == {"bartender"}


# ─── Role target validation ───────────────────────────────────────────


def test_upsert_role_target_rejects_unknown_role(db, owner):
    with pytest.raises(OperatingProfileError):
        upsert_role_target(
            db, owner_id=owner.id,
            role="phantom_role", default_count=1,
        )


def test_upsert_role_target_normalises_case(db, owner):
    """ROLE_CATALOG keys are lowercase; service normalises input."""
    target = upsert_role_target(
        db, owner_id=owner.id, role="SERVER", default_count=2,
    )
    assert target.role == "server"


def test_default_count_rejects_negative(db, owner):
    with pytest.raises(OperatingProfileError):
        upsert_role_target(
            db, owner_id=owner.id, role="server", default_count=-1,
        )


def test_default_count_rejects_over_99(db, owner):
    with pytest.raises(OperatingProfileError):
        upsert_role_target(
            db, owner_id=owner.id, role="server", default_count=100,
        )


def test_default_count_accepts_zero_and_fractional(db, owner):
    """0 = "we have this role, but nobody scheduled normally" (e.g.
    holidays); 0.5 = part-time / split shift."""
    z = upsert_role_target(db, owner_id=owner.id, role="dishwasher", default_count=0)
    assert float(z.default_count) == 0.0
    h = upsert_role_target(db, owner_id=owner.id, role="server", default_count=0.5)
    assert float(h.default_count) == 0.5


# ─── Idempotency ──────────────────────────────────────────────────────


def test_upsert_role_target_idempotent_same_values(db, owner):
    """Re-upsert with identical values returns the same row (id unchanged)."""
    first = upsert_role_target(
        db, owner_id=owner.id, role="server", default_count=2,
    )
    second = upsert_role_target(
        db, owner_id=owner.id, role="server", default_count=2,
    )
    assert first.id == second.id
    assert db.query(StaffRoleTarget).count() == 1


def test_upsert_role_target_updates_count_on_conflict(db, owner):
    """Re-upsert with a different count overwrites in place."""
    first = upsert_role_target(
        db, owner_id=owner.id, role="server", default_count=2,
    )
    second = upsert_role_target(
        db, owner_id=owner.id, role="server", default_count=3,
    )
    assert first.id == second.id
    assert float(second.default_count) == 3.0


# ─── Notes scrubbing ──────────────────────────────────────────────────


def test_notes_control_chars_stripped(db, owner):
    target = upsert_role_target(
        db, owner_id=owner.id, role="server", default_count=2,
        notes="busy Mon\x00\x07Tue\x1b[31m",
    )
    assert target.notes == "busy MonTue[31m"


def test_notes_capped_at_200_chars(db, owner):
    target = upsert_role_target(
        db, owner_id=owner.id, role="server", default_count=2,
        notes="x" * 500,
    )
    assert len(target.notes) == 200


def test_notes_empty_normalised_to_none(db, owner):
    target = upsert_role_target(
        db, owner_id=owner.id, role="server", default_count=2,
        notes="   ",
    )
    assert target.notes is None


# ─── Bulk atomic semantics ────────────────────────────────────────────


def test_bulk_upsert_atomic_rejects_whole_batch_on_invalid_entry(db, owner):
    """One bad entry → whole batch rejected, no partial writes."""
    db.query(StaffRoleTarget).delete()
    db.commit()
    with pytest.raises(OperatingProfileError):
        bulk_upsert_role_targets(
            db, owner_id=owner.id,
            targets=[
                {"role": "server", "default_count": 2},
                {"role": "phantom_role", "default_count": 1},  # bad
                {"role": "head_chef", "default_count": 1},
            ],
        )
    # No rows should have been written.
    assert db.query(StaffRoleTarget).count() == 0


def test_bulk_upsert_writes_all_when_valid(db, owner):
    targets = [
        {"role": "server", "default_count": 2},
        {"role": "head_chef", "default_count": 1},
        {"role": "dishwasher", "default_count": 1},
    ]
    rows = bulk_upsert_role_targets(db, owner_id=owner.id, targets=targets)
    assert len(rows) == 3
    assert {r.role for r in rows} == {"server", "head_chef", "dishwasher"}


def test_bulk_upsert_caps_batch_at_30(db, owner):
    targets = [{"role": "server", "default_count": 1}] * 31
    with pytest.raises(OperatingProfileError):
        bulk_upsert_role_targets(db, owner_id=owner.id, targets=targets)


# ─── Delete ───────────────────────────────────────────────────────────


def test_delete_role_target_returns_true_when_found(db, owner):
    upsert_role_target(db, owner_id=owner.id, role="server", default_count=1)
    assert delete_role_target(db, owner_id=owner.id, role="server") is True
    assert delete_role_target(db, owner_id=owner.id, role="server") is False


def test_delete_role_target_tenant_scoped(db, owner, other_owner):
    """Owner A can't delete Owner B's role target — even with the
    same role identifier."""
    upsert_role_target(db, owner_id=owner.id, role="server", default_count=1)
    upsert_role_target(db, owner_id=other_owner.id, role="server", default_count=1)

    delete_role_target(db, owner_id=owner.id, role="server")

    # Owner B's row survived.
    surviving = list_role_targets(db, owner_id=other_owner.id)
    assert {r.role for r in surviving} == {"server"}


def test_delete_role_target_rejects_unknown_role(db, owner):
    with pytest.raises(OperatingProfileError):
        delete_role_target(db, owner_id=owner.id, role="phantom_role")
