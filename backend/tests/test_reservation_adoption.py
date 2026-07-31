"""
Reservation adoption metric — the fleet's "does anyone actually use this?".

WHY THESE TESTS ARE SHAPED THIS WAY. The dangerous failure here is not a crash,
it is a number that is quietly WRONG IN THE DIRECTION OF THE EXISTING BELIEF.
The working assumption was "adoption is zero"; a metric that returns zero by
construction would be believed and would end the enquiry. So the first and most
important assertion in this file is that the metric returns NON-ZERO when
reality is non-zero, and most of the rest pin the specific ways a real venue
could silently vanish.

Locks under test:
  • Non-zero reality → non-zero answer. (The whole point.)
  • A phone-booking venue survives — its rows have idempotency_key NULL, and
    the obvious `NOT LIKE 'demo-%'` filter would erase exactly these.
  • A demo-only account is excluded, and its FIVE fake source='public' rows
    never reach the guest-self-booked tier.
  • An account that sampled demo data and THEN took a real booking is kept:
    exclusion is row-level, never account-level.
  • Purged (PII-nulled), cancelled-only and future-only venues all still count.
  • purge_after is robust where idempotency_key is not: with mark_demo=False
    the key-based filter FABRICATES a guest self-booking out of the seeder.
  • The demo-marker self-audit notices when the two markers disagree.
  • Internal accounts are reported separately, never silently subtracted.

Run: cd backend && python3 -m pytest tests/test_reservation_adoption.py -x -q
"""

import uuid
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.user import User
from app.services.auth import hash_password
from app.services.internal_accounts import EXCLUDED_ACCOUNTS
from app.services.reservation_adoption import collect

_START = datetime(2026, 7, 4, 19, 0, 0)


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _user(db, uid=None):
    u = User(
        id=uid or str(uuid.uuid4()),
        email=f"o-{uuid.uuid4().hex[:8]}@bonbox.dk",
        password_hash=hash_password("x"),
        business_name="Bon", business_type="restaurant",
        currency="DKK", role="owner", timezone="Europe/Copenhagen", plan="pro",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _real_row(db, user, *, source="public", status="confirmed",
              starts_at=_START, key="auto", purged=False):
    """Mimics the four REAL create sites: purge_after is always stamped."""
    if key == "auto":
        # The public widget always sends a UUID; the owner paths never set one.
        key = str(uuid.uuid4()) if source == "public" else None
    r = Reservation(
        user_id=user.id, guest_name=None if purged else "Anna",
        guest_phone=None if purged else "+4520000000",
        party_size=2, starts_at=starts_at,
        ends_at=starts_at + timedelta(minutes=90), duration_min=90,
        status=status, source=source, idempotency_key=key,
        purge_after=starts_at + timedelta(days=90),
        purged_at=datetime(2026, 7, 20) if purged else None,
    )
    db.add(r); db.commit()
    return r


def _demo_row(db, user, n, *, source="public", mark_demo=True):
    """Mimics demo_seed.py:655 — purge_after is NEVER set."""
    r = Reservation(
        user_id=user.id, guest_name="Sofie Holm", party_size=2,
        starts_at=_START, ends_at=_START + timedelta(minutes=90),
        duration_min=90, status="confirmed", source=source,
        idempotency_key=(f"demo-{user.id}-{n}" if mark_demo else None),
        purge_after=None,
    )
    db.add(r); db.commit()
    return r


# ── the assertion that matters most ──────────────────────────────────

def test_non_zero_reality_gives_non_zero_answer(db):
    """A metric that cannot disprove 'adoption is zero' is worse than none."""
    _real_row(db, _user(db))
    _real_row(db, _user(db), source="manual")
    out = collect(db)
    assert out["any_reservation"]["raw"] == 2, out


def test_phone_booking_venue_survives(db):
    """Owner-entered rows have idempotency_key NULL. `NOT LIKE 'demo-%'` drops
    NULLs, which would erase exactly the Danish ICP."""
    u = _user(db)
    r = _real_row(db, u, source="manual")
    assert r.idempotency_key is None, "fixture must reproduce the NULL case"
    out = collect(db)
    assert out["any_reservation"]["raw"] == 1
    assert out["owner_entered"]["raw"] == 1
    assert out["guest_self_booked"]["raw"] == 0


# ── demo data must not become adoption ───────────────────────────────

def test_demo_only_account_is_excluded(db):
    u = _user(db)
    for n in range(7):
        _demo_row(db, u, n)
    out = collect(db)
    assert out["any_reservation"]["raw"] == 0
    assert out["guest_self_booked"]["raw"] == 0, "the seeder's fake 'public' rows leaked"


def test_sampled_then_real_account_is_kept(db):
    """seed_for_user writes demo rows onto ORDINARY owner accounts. Dropping
    accounts that contain a demo row is the likeliest path to a false zero."""
    u = _user(db)
    for n in range(7):
        _demo_row(db, u, n)
    _real_row(db, u, source="manual")  # then took a real phone booking
    out = collect(db)
    assert out["any_reservation"]["raw"] == 1
    assert out["owner_entered"]["raw"] == 1
    assert out["guest_self_booked"]["raw"] == 0, "demo 'public' rows leaked into T3"


def test_purge_after_beats_idempotency_key_when_mark_demo_false(db):
    """With mark_demo=False the seeder writes idempotency_key=None. A NULL-safe
    key filter then counts those fake 'public' rows as guest self-bookings —
    inventing adoption. purge_after does not."""
    u = _user(db)
    _demo_row(db, u, 0, source="public", mark_demo=False)
    out = collect(db)
    assert out["any_reservation"]["raw"] == 0
    assert out["guest_self_booked"]["raw"] == 0


# ── real rows that a careless filter would drop ──────────────────────

def test_purged_venue_still_counts(db):
    """The GDPR job nulls guest PII past purge_after. Realness must never be
    judged by whether a guest name survives."""
    _real_row(db, _user(db), purged=True)
    assert collect(db)["any_reservation"]["raw"] == 1


def test_cancelled_only_venue_still_counts(db):
    """A nightly sweep rewrites unanswered `requested` rows to `cancelled`.
    Excluding cancelled deletes the evidence that a stranger booked."""
    _real_row(db, _user(db), status="cancelled")
    assert collect(db)["any_reservation"]["raw"] == 1


def test_future_only_venue_still_counts(db):
    """A trailing date window would drop the newest adopters."""
    _real_row(db, _user(db), starts_at=datetime(2027, 1, 1, 19, 0))
    assert collect(db)["any_reservation"]["raw"] == 1


def test_salon_appointment_counts(db):
    """Appointments share this table with party_size=1 and resource_id NULL.
    Any restaurant-shaped predicate erases the whole salon segment."""
    u = _user(db)
    r = Reservation(
        user_id=u.id, guest_name="Ida", party_size=1, starts_at=_START,
        ends_at=_START + timedelta(minutes=45), duration_min=45,
        status="confirmed", source="public", service_name="Klip",
        resource_id=None, purge_after=_START + timedelta(days=90),
    )
    db.add(r); db.commit()
    assert collect(db)["any_reservation"]["raw"] == 1


# ── tiers, denominator, and honesty of the payload ───────────────────

def test_tiers_are_nested_not_collapsed(db):
    a, b = _user(db), _user(db)
    _real_row(db, a, source="public")
    _real_row(db, b, source="manual")
    out = collect(db)
    assert out["any_reservation"]["raw"] == 2
    assert out["guest_self_booked"]["raw"] == 1
    assert out["owner_entered"]["raw"] == 1


def test_configured_denominator_separates_the_two_zeros(db):
    """T1=0 with T0>0 is 'switched on, nobody booked'. T1=0 with T0=0 is
    'nobody set it up'. Opposite next moves, so both must be reported."""
    u = _user(db)
    db.add(BusinessProfile(user_id=u.id, reservations_enabled=True)); db.commit()
    out = collect(db)
    assert out["configured"] == 1
    assert out["any_reservation"]["raw"] == 0


def test_internal_accounts_reported_separately_never_hidden(db):
    founder_id = next(iter(EXCLUDED_ACCOUNTS))
    _real_row(db, _user(db, uid=founder_id))
    _real_row(db, _user(db))
    out = collect(db)
    assert out["any_reservation"]["raw"] == 2, "raw must still show the founder"
    assert out["any_reservation"]["excl_internal"] == 1


def test_demo_marker_self_audit_flags_disagreement(db):
    u = _user(db)
    _demo_row(db, u, 0, mark_demo=True)
    assert collect(db)["demo_marker_audit"]["agree"] is True
    # A seeder run with mark_demo=False leaves an unstamped row with no key —
    # the markers now disagree and the headline must not be trusted silently.
    _demo_row(db, u, 1, mark_demo=False)
    audit = collect(db)["demo_marker_audit"]
    assert audit["agree"] is False
    assert audit["unstamped_rows"] == 2 and audit["demo_keyed_rows"] == 1


def test_payload_labels_unit_as_accounts_and_carries_caveats(db):
    out = collect(db)
    assert out["unit"] == "accounts", "must never be labelled 'venues'"
    assert out["caveats"], "the number must not travel without its caveats"


# ── the seeder default this all rests on ─────────────────────────────

def test_seed_reservations_defaults_to_marking_demo(db):
    """purge_after is robust to mark_demo=False, but the seeder's own marker is
    not — so pin the default and keep the two markers agreeing."""
    import inspect
    from app.services.demo_seed import _seed_reservations

    assert inspect.signature(_seed_reservations).parameters["mark_demo"].default is True
