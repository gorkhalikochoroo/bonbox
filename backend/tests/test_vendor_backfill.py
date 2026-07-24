"""Seeding vendor memory from history without teaching it our own defaults.

Vendor memory only knows what it watched happen since it shipped, so an
owner with two years of Netto receipts still faced a blank confirm
screen. The backfill replays what they already told us.

The risk is the whole feature's invariant: "a value nobody chose is not
evidence". History is full of values the APP invented, and a naive
backfill would launder them into owner decisions.

Measured in production before writing this:
  • 167 of 240 recent rows carry payment_method "card" — the default in
    four separate places until this cycle removed them. Nothing
    distinguishes a chosen card from an unasked one.
  • 28 of 49 cash rows are is_personal — QuickAdd's personal tab
    hardcoded "cash" with no picker.
  • 190 rows carry a real category, which owners DO pick.

So the backfill is honestly a category seeder that also takes the few
genuinely-chosen payment methods.

Run:
  cd backend && python3 -m pytest tests/test_vendor_backfill.py -q
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.jobs.vendor_backfill import BACKFILL_CAP, backfill_user
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.models.vendor_profile import VendorProfile
from app.services.vendor_memory import (
    recall, record_signal, BAND_SUGGEST, BAND_PREFILL, BAND_NONE,
)


@pytest.fixture
def db() -> Iterator:
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(eng)
    s = sessionmaker(bind=eng)()
    try:
        yield s
    finally:
        s.close()


def _owner(db) -> User:
    u = User(
        email=f"o-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
        business_name="Café Hygge", business_type="cafe",
        currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _cat(db, user, name) -> ExpenseCategory:
    c = ExpenseCategory(user_id=user.id, name=name)
    db.add(c); db.commit(); db.refresh(c)
    return c


def _exp(db, user, cat, *, desc="Netto", method="cash", days_ago=10, **over):
    e = Expense(
        user_id=user.id, category_id=cat.id if cat else None,
        date=date.today() - timedelta(days=days_ago),
        amount=100.0, description=desc, payment_method=method, **over,
    )
    db.add(e); db.commit(); db.refresh(e)
    return e


def _row(db, user, key, field, value):
    return db.query(VendorProfile).filter(
        VendorProfile.user_id == user.id, VendorProfile.vendor_key == key,
        VendorProfile.field == field, VendorProfile.value == value,
    ).first()


# ── it seeds what the owner actually chose ───────────────────────────

def test_history_seeds_a_suggestion(db):
    u = _owner(db); c = _cat(db, u, "Vareforbrug")
    for i in range(4):
        _exp(db, u, c, method="cash", days_ago=i + 1)

    res = backfill_user(db, u); db.commit()
    assert res["profiles_seeded"] == 2          # method + category

    mem = recall(db, u.id, "netto")
    assert mem["payment_method"]["value"] == "cash"
    assert mem["category_name"]["value"] == "Vareforbrug"


def test_history_earns_a_hint_never_a_decision(db):
    """Capped at BAND_SUGGEST. Four historical receipts must NOT let the
    next scan auto-fill — history is weaker evidence than a confirmation
    we actually watched, and the band rule is where that shows."""
    u = _owner(db); c = _cat(db, u, "Vareforbrug")
    for i in range(4):
        _exp(db, u, c, method="cash", days_ago=i + 1)
    backfill_user(db, u); db.commit()

    mem = recall(db, u.id, "netto")
    assert mem["payment_method"]["agree"] == BACKFILL_CAP
    assert mem["payment_method"]["band"] == BAND_SUGGEST, "history must not prefill"

    # ONE live confirmation is what unlocks it.
    record_signal(db, u.id, "netto", "payment_method", "cash", kind="confirm")
    db.commit()
    assert recall(db, u.id, "netto")["payment_method"]["band"] == BAND_PREFILL


def test_historical_rows_get_a_vendor_key(db):
    """They predate the column, and without one a later correction on
    such a row lands nowhere."""
    u = _owner(db); c = _cat(db, u, "Vareforbrug")
    e = _exp(db, u, c, desc="NETTO 1284 LYNGBY")
    assert e.vendor_key is None
    backfill_user(db, u); db.commit()
    db.refresh(e)
    assert e.vendor_key == "netto lyngby"


# ── it refuses to launder the app's own defaults ─────────────────────

def test_card_is_never_learned_from_history(db):
    """THE headline rule. "card" was the default in the Expense model,
    ExpenseCreate, ReceiptCapture and burst_scan — 167 of 240 production
    rows carry it and none of them prove a choice."""
    u = _owner(db); c = _cat(db, u, "Vareforbrug")
    for i in range(6):
        _exp(db, u, c, method="card", days_ago=i + 1)
    backfill_user(db, u); db.commit()

    assert _row(db, u, "netto", "payment_method", "card") is None
    # ...but the category on those same rows IS a real choice.
    assert _row(db, u, "netto", "category_name", "Vareforbrug") is not None


def test_personal_rows_are_skipped(db):
    """QuickAdd's personal tab hardcoded "cash" with no picker, and a
    private purchase is not a business habit either way."""
    u = _owner(db); c = _cat(db, u, "Vareforbrug")
    for i in range(4):
        _exp(db, u, c, method="cash", days_ago=i + 1, is_personal=True)
    res = backfill_user(db, u); db.commit()
    assert res["profiles_seeded"] == 0


@pytest.mark.parametrize("placeholder", ["Andet", "Ukategoriseret"])
def test_server_chosen_categories_are_not_learned(db, placeholder):
    u = _owner(db); c = _cat(db, u, placeholder)
    for i in range(4):
        _exp(db, u, c, method="cash", days_ago=i + 1)
    backfill_user(db, u); db.commit()
    assert _row(db, u, "netto", "category_name", placeholder) is None
    assert _row(db, u, "netto", "payment_method", "cash") is not None


def test_pending_drafts_are_not_decisions(db):
    u = _owner(db); c = _cat(db, u, "Vareforbrug")
    for i in range(3):
        _exp(db, u, c, method="cash", days_ago=i + 1, status="pending")
    assert backfill_user(db, u)["profiles_seeded"] == 0


def test_deleted_rows_are_not_evidence(db):
    u = _owner(db); c = _cat(db, u, "Vareforbrug")
    for i in range(3):
        _exp(db, u, c, method="cash", days_ago=i + 1, is_deleted=True)
    assert backfill_user(db, u)["profiles_seeded"] == 0


def test_rows_outside_the_window_are_ignored(db):
    u = _owner(db); c = _cat(db, u, "Vareforbrug")
    _exp(db, u, c, method="cash", days_ago=400)
    assert backfill_user(db, u)["profiles_seeded"] == 0


def test_junk_vendors_are_not_keyed(db):
    """A description that canonicalises to nothing would pool unrelated
    suppliers into one bucket."""
    u = _owner(db); c = _cat(db, u, "Vareforbrug")
    _exp(db, u, c, desc="42", method="cash")
    assert backfill_user(db, u)["profiles_seeded"] == 0


# ── strictly additive: it can never revive a corrected value ─────────

def test_a_vendor_with_live_memory_is_left_alone(db):
    u = _owner(db); c = _cat(db, u, "Vareforbrug")
    for i in range(5):
        _exp(db, u, c, method="cash", days_ago=i + 1)

    # The owner has already corrected cash -> mobilepay for this vendor.
    for _ in range(3):
        record_signal(db, u.id, "netto", "payment_method", "cash", kind="confirm")
    record_signal(db, u.id, "netto", "payment_method", "mobilepay",
                  kind="correction", previous_value="cash")
    db.commit()
    before = _row(db, u, "netto", "payment_method", "cash")
    before_agree, before_streak = before.agree_count, before.streak

    backfill_user(db, u); db.commit()

    after = _row(db, u, "netto", "payment_method", "cash")
    assert (after.agree_count, after.streak) == (before_agree, before_streak), (
        "the backfill resurrected a value the owner corrected away"
    )
    assert after.disagree_count == 1


def test_running_it_twice_changes_nothing(db):
    u = _owner(db); c = _cat(db, u, "Vareforbrug")
    for i in range(4):
        _exp(db, u, c, method="cash", days_ago=i + 1)

    backfill_user(db, u); db.commit()
    first = {(r.field, r.value, r.agree_count, r.streak)
             for r in db.query(VendorProfile).filter(VendorProfile.user_id == u.id)}

    assert backfill_user(db, u)["profiles_seeded"] == 0
    db.commit()
    second = {(r.field, r.value, r.agree_count, r.streak)
              for r in db.query(VendorProfile).filter(VendorProfile.user_id == u.id)}
    assert first == second


def test_it_never_crosses_tenants(db):
    a, b = _owner(db), _owner(db)
    ca = _cat(db, a, "Vareforbrug")
    for i in range(4):
        _exp(db, a, ca, method="cash", days_ago=i + 1)
    backfill_user(db, b); db.commit()
    assert db.query(VendorProfile).filter(VendorProfile.user_id == b.id).count() == 0
    assert recall(db, b.id, "netto") == {}


def test_a_single_sighting_is_not_a_habit(db):
    """One historical receipt seeds agree=1, which is BAND_NONE — the
    same bar the live path applies."""
    u = _owner(db); c = _cat(db, u, "Vareforbrug")
    _exp(db, u, c, method="cash")
    backfill_user(db, u); db.commit()
    assert recall(db, u.id, "netto")["payment_method"]["band"] == BAND_NONE
