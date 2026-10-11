"""R-h fix round: the Insights pattern engine after H-7 (usage events leave
the browser only after a "yes" to Analytics).

Before R-h only owners who explicitly declined sent no page_view events.
After R-h that is everyone who has not answered the banner — the default.
owner_patterns read those events in two places:

  • detect_dormant_feature said "You haven't opened X in 14 days" for every
    page with old page_views and none in the last 14 days. With no events at
    all in the last 14 days, the log is silent, not proof of absence: the
    detector now says nothing (three outcomes — "can't tell" is not "dormant").
  • _has_enough_data counted only event days, so ~76 days after the deploy
    every non-consenting owner would silently lose the revenue, expense and
    wage% insights. Activity days now also come from the records the owner
    makes (sales, expenses, daily closes — by the day they were entered, so
    a bulk import or a seeded history counts as one day, not ninety).

Run:
  cd backend && python -m pytest -q tests/test_owner_patterns_without_consent.py
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.database import Base
from app.models.event_log import EventLog
from app.models.expense import Expense, ExpenseCategory
from app.models.owner_pattern import OwnerPattern
from app.models.sale import Sale
from app.models.user import User
from app.services import owner_patterns as op
from app.utils.time import utc_now


@pytest.fixture
def s():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    yield db
    db.close()


@pytest.fixture
def owner(s):
    u = User(email=f"o-{uuid.uuid4().hex[:6]}@cafe.dk", password_hash="x", business_name="Café",
             business_type="restaurant", currency="DKK", role="owner")
    s.add(u)
    s.commit()
    s.refresh(u)
    return u


def _views(s, u, pages, days):
    now = utc_now()
    for d in days:
        for page in pages:
            s.add(EventLog(user_id=u.id, event="page_view", page=page, created_at=now - timedelta(days=d)))
    s.commit()


def _sale(s, u, *, created_days_ago, date_days_ago=None):
    now = utc_now()
    s.add(Sale(user_id=u.id, date=(now - timedelta(days=date_days_ago if date_days_ago is not None
                                                    else created_days_ago)).date(),
               amount=1000, payment_method="card", created_at=now - timedelta(days=created_days_ago)))


def test_no_events_in_the_last_14_days_is_not_proof_a_page_is_dormant(s, owner):
    """The finding's repro: page_views 15-34 days ago (recorded under the old
    rule), then none — an owner who uses the app daily but never answered
    the banner. No "You haven't opened …" claim."""
    _views(s, owner, ("dashboard", "daily-close"), range(15, 35))
    assert op.detect_dormant_feature(owner, s) == []
    op.run_for_user(owner, s)
    assert s.query(OwnerPattern).filter(OwnerPattern.pattern_type == "dormant_feature").count() == 0


def test_a_consenting_owner_still_hears_about_a_page_they_stopped_opening(s, owner):
    """Unchanged where the log can tell: recent page_views exist, one page
    is missing from them."""
    _views(s, owner, ("dashboard", "daily-close"), range(15, 35))
    _views(s, owner, ("dashboard",), range(0, 14))
    titles = [p.title for p in op.detect_dormant_feature(owner, s)]
    assert titles == ["You haven't opened daily-close in 14 days"]


def test_days_with_entered_records_count_as_activity_days(s, owner):
    """An owner with 5 event days but sales entered on 20 different days has
    enough data: the data-driven detectors keep running without consent."""
    _views(s, owner, ("dashboard",), range(80, 85))
    assert op._has_enough_data(owner, s) is False
    for d in range(1, 21):
        _sale(s, owner, created_days_ago=d)
    s.commit()
    assert op._has_enough_data(owner, s) is True


def test_expenses_and_events_add_up_on_distinct_days(s, owner):
    _views(s, owner, ("dashboard",), range(30, 37))  # 7 event days
    cat = ExpenseCategory(user_id=owner.id, name="Varer")
    s.add(cat)
    s.flush()
    now = utc_now()
    for d in range(33, 40):  # 7 expense days, 4 of them shared with events (33-36)
        s.add(Expense(user_id=owner.id, category_id=cat.id, date=(now - timedelta(days=d)).date(),
                      amount=100, description="Mælk", created_at=now - timedelta(days=d)))
    s.commit()
    assert op._has_enough_data(owner, s) is False  # 10 distinct days, not 14
    for d in range(40, 44):
        _sale(s, owner, created_days_ago=d)
    s.commit()
    assert op._has_enough_data(owner, s) is True  # 14 distinct days


def test_a_bulk_import_of_ninety_days_is_one_activity_day(s, owner):
    """Entered today with ninety different business dates: one day of
    activity, not ninety — the same rule the event days followed."""
    for d in range(0, 90):
        _sale(s, owner, created_days_ago=0, date_days_ago=d)
    s.commit()
    assert op._has_enough_data(owner, s) is False


def test_records_older_than_90_days_do_not_count(s, owner):
    for d in range(91, 120):
        _sale(s, owner, created_days_ago=d)
    s.commit()
    assert op._has_enough_data(owner, s) is False
