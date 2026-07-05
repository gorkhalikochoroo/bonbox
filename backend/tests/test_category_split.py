"""
_build_category_split — the honest, computed revenue-category suggestion for the
daily close. The load-bearing guarantees (a wrong split poisons the owner's trust
AND, if it didn't tie out, would poison MOMS):

  • TIES OUT — the per-category amounts sum EXACTLY to sales_total (øre-exact).
  • GRACEFUL BLANK — <3 usable historical closes → None (never invents a split).
  • SINGLE-CATEGORY / zero-total → None.
  • BRANCH-SCOPED — location A's mix never pollutes location B.
  • CONFIDENCE — >=8 samples "medium", 3-7 "low".

Run: cd backend && python3 -m pytest tests/test_category_split.py -q
"""
import uuid
from datetime import date, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.daily_close import DailyClose, encode_breakdown
from app.routers.daily_close import _build_category_split

_UID = uuid.uuid4()
_TARGET = date(2026, 7, 6)  # a Monday


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _user():
    return SimpleNamespace(id=_UID)


def _close(db, d, cats, branch_id=None):
    db.add(DailyClose(
        user_id=_UID, date=d, status="confirmed", branch_id=branch_id,
        revenue_categories=encode_breakdown(cats), is_deleted=False,
    ))


def _seed_days(db, n, cats, start_offset=1, branch_id=None):
    """n confirmed closes on consecutive prior days with the same mix."""
    for i in range(n):
        _close(db, _TARGET - timedelta(days=start_offset + i), cats, branch_id=branch_id)
    db.commit()


def test_ties_out_exactly(db):
    # 5 closes at a 60/30/10 food/drinks/takeaway mix.
    _seed_days(db, 5, {"food": 600, "drinks": 300, "takeaway": 100})
    r = _build_category_split(db, _user(), None, "restaurant", _TARGET, 1000.03)
    assert r is not None
    assert round(sum(r["categories"].values()), 2) == 1000.03  # øre-exact tie-out
    # Proportions preserved (~60/30/10) within rounding.
    assert r["categories"]["food"] > r["categories"]["drinks"] > r["categories"]["takeaway"]


def test_graceful_blank_under_min_sample(db):
    _seed_days(db, 2, {"food": 600, "drinks": 400})  # only 2 → below min 3
    assert _build_category_split(db, _user(), None, "restaurant", _TARGET, 1000) is None


def test_single_category_vertical_none(db):
    _seed_days(db, 5, {"revenue": 1000})
    assert _build_category_split(db, _user(), None, "general", _TARGET, 1000) is None


def test_zero_total_none(db):
    _seed_days(db, 5, {"food": 600, "drinks": 400})
    assert _build_category_split(db, _user(), None, "restaurant", _TARGET, 0) is None
    assert _build_category_split(db, _user(), None, "restaurant", _TARGET, -50) is None


def test_confidence_scales_with_sample(db):
    _seed_days(db, 4, {"food": 600, "drinks": 400})  # 4 → low
    assert _build_category_split(db, _user(), None, "restaurant", _TARGET, 1000)["confidence"] == "low"


def test_confidence_medium_at_8(db):
    _seed_days(db, 10, {"food": 600, "drinks": 400})  # >=8 → medium
    r = _build_category_split(db, _user(), None, "restaurant", _TARGET, 1000)
    assert r["confidence"] == "medium"
    assert r["sample_size"] >= 8


def test_branch_scoped(db):
    branch_a, branch_b = uuid.uuid4(), uuid.uuid4()
    # Branch A: drinks-heavy; Branch B: food-heavy. Asking for A must not see B.
    _seed_days(db, 5, {"food": 100, "drinks": 900}, branch_id=branch_a)
    _seed_days(db, 5, {"food": 900, "drinks": 100}, branch_id=branch_b, start_offset=20)
    r = _build_category_split(db, _user(), str(branch_a), "restaurant", _TARGET, 1000)
    assert r["categories"]["drinks"] > r["categories"]["food"]  # A's mix, not B's


def test_same_weekday_preferred(db):
    # 4 Mondays (target is Monday) at drinks-heavy; 10 other-days at food-heavy.
    for i in range(4):
        _close(db, _TARGET - timedelta(days=7 * (i + 1)), {"food": 100, "drinks": 900})
    for i in range(10):
        d = _TARGET - timedelta(days=1 + i)
        if d.weekday() != _TARGET.weekday():
            _close(db, d, {"food": 900, "drinks": 100})
    db.commit()
    r = _build_category_split(db, _user(), None, "restaurant", _TARGET, 1000)
    # Same-weekday (Monday) pool has >=3, so it wins → drinks-heavy.
    assert r["categories"]["drinks"] > r["categories"]["food"]
