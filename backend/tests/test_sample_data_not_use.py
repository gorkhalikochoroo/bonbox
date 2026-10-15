"""Sample data is not use (Push 8, Oct 2026).

The business-type sheet said "Bliver, fordi du bruger det: Reservationer" for
an owner whose only bookings were the "Prøv med eksempeldata" sample. The
decision pinned here:

  • GET /api/activation keeps counting sample rows in its per-pillar booleans
    — the nav of someone exploring the sample does not change (Lager and
    Reservationer stay in it, on deploy and after);
  • a SEPARATE signal, `sample_only` (pillars.sample_only_pillars), says which
    pillars rest on sample rows alone — None when that cannot be checked;
  • plan_type_change claims "because you use it" (pillars_kept) only for a
    pillar with a real row; a sample-only one stays without a reason claimed
    (pillars_stay) — never hidden, so the sample stays where it was.

The sample is made by the real producer (demo_seed.seed_for_user), so the
markers tested are the ones the seeder writes.

Run: cd backend && pytest tests/test_sample_data_not_use.py -q
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.business_profile import BusinessProfile
from app.models.inventory import InventoryItem
from app.models.reservation import Reservation
from app.models.user import User
from app.services.archetype import cutoff_hour_for
from app.services.archetype_defaults import apply_type_change, plan_type_change
from app.services.auth import get_current_user, hash_password
from app.services.demo_seed import clear_for_user, seed_choice_for_user, seed_for_user
from app.services.pillars import (
    ACTIVATION_PILLARS,
    activated_pillars,
    get_hidden,
    sample_only_pillars,
)

_db_ready.set()


@pytest.fixture
def session_factory():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


@pytest.fixture
def db(session_factory):
    s = session_factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(session_factory):
    def _get_test_db():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db, email, business_type="cafe", cutoff=6):
    u = User(
        email=email,
        password_hash=hash_password("hunter2pass"),
        business_name="Café Prøve",
        business_type=business_type,
        currency="DKK",
        role="owner",
        email_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    db.add(BusinessProfile(user_id=u.id, day_cutoff_hour=cutoff))
    db.commit()
    return u


def _with_sample(db, email):
    """An owner exploring the sample, as the onboarding wizard seeds it."""
    u = _owner(db, email)
    res = seed_for_user(db, u, keep_profile=True)
    assert res["ok"] is True, res
    assert res["reservations"]["bookings"] > 0 and res["inventory"] > 0
    db.refresh(u)
    return u


# ─── The signal ──────────────────────────────────────────────────────────

def test_sample_rows_keep_the_nav_but_are_flagged_sample_only(db):
    u = _with_sample(db, "sample@bonbox.test")
    # The nav's answer is unchanged: sample bookings and stock activate.
    used = activated_pillars(db, u)
    assert used["reservations"] is True
    assert used["inventory"] is True
    # The separate signal: those two rest on the sample alone.
    assert sample_only_pillars(db, u) == {
        "inventory": True, "reservations": True, "events": False, "staff": False,
    }


def test_one_real_booking_or_item_is_real_use(db):
    u = _with_sample(db, "mixed@bonbox.test")
    start = datetime(2026, 10, 12, 19, 0)
    db.add(Reservation(user_id=u.id, guest_name="Hansen", party_size=2,
                       starts_at=start, ends_at=start + timedelta(minutes=90)))
    db.add(InventoryItem(user_id=u.id, name="Mælk", quantity=4, min_threshold=0))
    db.commit()
    s = sample_only_pillars(db, u)
    assert s["reservations"] is False
    assert s["inventory"] is False


def test_the_owners_own_booking_page_is_real_use(db):
    u = _with_sample(db, "page@bonbox.test")
    prof = db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).first()
    prof.reservations_enabled = True
    db.commit()
    assert sample_only_pillars(db, u)["reservations"] is False


def test_no_rows_at_all_is_not_sample_only(db):
    u = _owner(db, "empty@bonbox.test")
    assert sample_only_pillars(db, u) == {
        "inventory": False, "reservations": False, "events": False, "staff": False,
    }


def test_cleared_sample_leaves_nothing_behind(db):
    u = _with_sample(db, "cleared@bonbox.test")
    assert clear_for_user(db, u)["ok"] is True
    assert activated_pillars(db, u)["reservations"] is False
    assert sample_only_pillars(db, u)["reservations"] is False


def test_a_failed_check_is_unknown_never_a_claim(db):
    u = _owner(db, "boom@bonbox.test")

    class _BoomSession:
        def query(self, *a, **k):
            raise RuntimeError("db down")

    s = sample_only_pillars(_BoomSession(), u)
    assert s["inventory"] is None
    assert s["reservations"] is None


# ─── The type-change sheet ───────────────────────────────────────────────

def test_sample_bookings_stay_without_because_you_use_it(db):
    # café → tøjbutik: the clothing preset hides Reservationer.
    u = _with_sample(db, "sheet@bonbox.test")
    plan = plan_type_change(db, u, "clothing")
    assert "reservations" not in plan["pillars_kept"]
    assert "reservations" not in plan["pillars_hide"]
    assert "reservations" in plan["pillars_stay"]


def test_anvend_with_sample_data_does_not_hide_the_sample(db):
    u = _with_sample(db, "apply@bonbox.test")
    apply_type_change(db, u, "clothing", apply_defaults=True)
    db.refresh(u)
    assert "reservations" not in get_hidden(u)


def test_a_real_booking_still_says_why(db):
    u = _with_sample(db, "why@bonbox.test")
    start = datetime(2026, 10, 12, 19, 0)
    db.add(Reservation(user_id=u.id, guest_name="Hansen", party_size=2,
                       starts_at=start, ends_at=start + timedelta(minutes=90)))
    db.commit()
    plan = plan_type_change(db, u, "clothing")
    assert plan["pillars_kept"] == ["reservations"]
    assert "reservations" not in plan["pillars_stay"]


def test_unknown_sample_check_claims_nothing(db, monkeypatch):
    u = _with_sample(db, "unknown@bonbox.test")
    import app.services.pillars as pillars
    monkeypatch.setattr(pillars, "sample_only_pillars",
                        lambda db, user: {p: None for p in ACTIVATION_PILLARS})
    plan = plan_type_change(db, u, "clothing")
    assert plan["pillars_kept"] == []
    assert "reservations" in plan["pillars_stay"]


# ─── The sample's day cutoff (Push 8 review) ────────────────────────────
#
# The dashboard's "Prøv med eksempeldata" on a profile with no details of the
# owner's own is the DEFAULT seed: it writes the sample company — and its
# night-shift cutoff, 04:00 — onto the profile. The sheet then said "Dit
# dagsskifte kl. 04:00 bliver — du har selv valgt det", and "Anvend" kept the
# sample's 04:00 for a shop (sales between 00 and 04 on the day before).

def _fresh_with_default_seed(db, email, cutoff=None, business_type="restaurant"):
    """A fresh owner seeded the way the dashboard seeds them when the profile
    holds nothing of their own (own_profile False → the default seed)."""
    u = _owner(db, email, business_type=business_type,
               cutoff=cutoff_hour_for(business_type) if cutoff is None else cutoff)
    assert seed_choice_for_user(db, u)["own_profile"] is False
    res = seed_for_user(db, u)
    assert res["ok"] is True and res["profile_kept"] is False, res
    db.refresh(u)
    return u


def _cutoff(db, u):
    p = db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).first()
    return None if p is None else p.day_cutoff_hour


def test_the_samples_cutoff_is_not_the_owners_choice(db):
    u = _fresh_with_default_seed(db, "cut-sample@bonbox.test")
    assert _cutoff(db, u) == 4                       # the sample's night shift
    assert cutoff_hour_for("restaurant") != 4        # else there is nothing to tell
    plan = plan_type_change(db, u, "clothing")
    assert plan["cutoff_kept"] is None               # no "du har selv valgt det"
    assert plan["cutoff"] == {"from": 4, "to": cutoff_hour_for("clothing")}
    assert plan["has_changes"] is True


def test_anvend_moves_the_samples_cutoff_and_ryd_demodata_keeps_it(db):
    u = _fresh_with_default_seed(db, "cut-apply@bonbox.test")
    apply_type_change(db, u, "clothing", apply_defaults=True)
    assert _cutoff(db, u) == cutoff_hour_for("clothing")
    assert clear_for_user(db, u)["ok"] is True
    # The clear puts back only a cutoff that still holds the sample's 04:00.
    assert _cutoff(db, u) in (None, cutoff_hour_for("clothing"))


def test_an_owners_own_cutoff_under_the_sample_is_neither_claimed_nor_moved(db):
    # The owner set 02:00 before trying the sample: the sample's 04:00 is in
    # force, theirs comes back with "Ryd demodata". The sheet claims neither.
    u = _fresh_with_default_seed(db, "cut-own-under@bonbox.test", cutoff=2)
    assert _cutoff(db, u) == 4
    plan = plan_type_change(db, u, "clothing")
    assert plan["cutoff"] is None
    assert plan["cutoff_kept"] is None
    apply_type_change(db, u, "clothing", apply_defaults=True)
    assert _cutoff(db, u) == 4
    assert clear_for_user(db, u)["ok"] is True
    assert _cutoff(db, u) == 2


def test_an_owners_own_four_oclock_is_still_kept_and_said(db):
    # Positive control: no sample — 04:00 is the owner's, and the sheet says so.
    u = _owner(db, "cut-own@bonbox.test", business_type="restaurant", cutoff=4)
    plan = plan_type_change(db, u, "clothing")
    assert plan["cutoff"] is None
    assert plan["cutoff_kept"] == 4


def test_the_samples_cutoff_over_the_same_default_is_no_change(db):
    # A bakery's own default is 04:00 too: seeded or not, nothing to move.
    u = _fresh_with_default_seed(db, "cut-bakery@bonbox.test")
    plan = plan_type_change(db, u, "bakery")
    assert cutoff_hour_for("bakery") == 4
    assert plan["cutoff"] is None and plan["cutoff_kept"] is None


# ─── GET /api/activation ─────────────────────────────────────────────────

def test_activation_payload_keeps_the_nav_and_adds_sample_only(client, session_factory, monkeypatch):
    monkeypatch.setenv("ACTIVATION_DISCLOSURE_ENABLED", "true")
    s = session_factory()
    u = _with_sample(s, "payload@bonbox.test")
    app.dependency_overrides[get_current_user] = lambda: u
    r = client.get("/api/activation")
    s.close()
    assert r.status_code == 200, r.text
    body = r.json()
    # The nav booleans: sample rows still count.
    assert body["reservations"] is True
    assert body["inventory"] is True
    # The separate signal.
    assert body["sample_only"] == {
        "inventory": True, "reservations": True, "events": False, "staff": False,
    }


def test_kill_switch_claims_no_sample(client, session_factory, monkeypatch):
    monkeypatch.setenv("ACTIVATION_DISCLOSURE_ENABLED", "off")
    s = session_factory()
    u = _with_sample(s, "killswitch@bonbox.test")
    app.dependency_overrides[get_current_user] = lambda: u
    r = client.get("/api/activation")
    s.close()
    assert r.status_code == 200, r.text
    body = r.json()
    assert all(body[p] is True for p in ACTIVATION_PILLARS)
    # Push 8 review: nothing was checked, so nothing is claimed either way —
    # None ("could not tell"), not False. Beside the pillars forced True, a
    # False read as real use (the doctrine: use is claimed only on an
    # explicit False next to an activated pillar). This expectation was
    # False; it changes because False made that claim without a query.
    assert body["sample_only"] == {p: None for p in ACTIVATION_PILLARS}
