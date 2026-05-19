"""
Tests for Smart Pricing Intelligence (Task #64).

Privacy is non-negotiable. Most tests here pin invariants that must hold
under ANY future refactor:

  • k-anonymity gate: count < MIN_COHORT_SIZE → no aggregate values ever
    leak. Even count is not reported beyond "not enough".
  • Cross-tenant safety: the requesting user's own row is filtered OUT
    of the cohort before aggregation, never compared to themselves.
  • Multi-row tenant: a single tenant with 3 cappuccino entries counts
    as ONE cohort member, not three (otherwise a noisy tenant could
    satisfy MIN_COHORT_SIZE on their own).
  • Audit: every lookup writes a SecurityEvent — no silent scraping.

Aggregate-correctness tests (median, percentile, deviation) are pinned
on a known small cohort so future maths changes get caught.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.business_profile import BusinessProfile
from app.models.inventory import InventoryItem
from app.models.security_event import SecurityEvent
from app.models.user import User
from app.services import smart_pricing as sp_module
from app.services.menu_item_categories import (
    CANONICAL_NAMES,
    list_canonical_names,
    normalize_item_name,
)
from app.services.smart_pricing import (
    MIN_COHORT_SIZE,
    _cache_clear,
    _percentile,
    _percentile_of_value,
    get_all_market_comparisons,
    get_market_comparison,
)
from app.services.billing import PLAN_FEATURES, has_feature
from app.utils.time import utc_now


# ─── Fixtures ──────────────────────────────────────────────────────────


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


@pytest.fixture(autouse=True)
def _clear_cache_between_tests():
    """Always start each test with a fresh cache so test ordering can't
    accidentally pollute results."""
    _cache_clear()
    yield
    _cache_clear()


def _mk_user(db, *, email: str, postal: str | None = "2200",
             cuisine: str | None = "cafe") -> User:
    u = User(
        email=email,
        password_hash="x",
        business_name=f"biz-{email}",
        business_type="cafe",
        currency="DKK",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    # Audit P2 (Task #76): smart_pricing requires the postal to come
    # from a DAWA-verified + CVR-verified profile, otherwise the
    # cohort uses None as effective postal.  Every test that needs a
    # comparison must therefore set both — emulate a verified owner.
    profile = BusinessProfile(
        user_id=u.id,
        company_name=f"biz-{email}",
        country="DK",
        zipcode=postal,
        cuisine=cuisine,
        dawa_address_id=f"dawa-{email}",
        cvr_verified_at=datetime.utcnow(),
        cvr_verified_source="cvrapi.dk",
    )
    db.add(profile)
    db.commit()
    return u


def _mk_item(db, *, user, name: str, sell_price: float | None) -> InventoryItem:
    item = InventoryItem(
        user_id=user.id,
        name=name,
        quantity=Decimal("10"),
        unit="pieces",
        cost_per_unit=Decimal("10"),
        sell_price=Decimal(str(sell_price)) if sell_price is not None else None,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def _seed_cohort(db, *, n: int, base_price: float = 45.0,
                 step: float = 1.0, postal: str = "2200",
                 cuisine: str = "cafe", name: str = "Cappuccino"
                 ) -> list[User]:
    """Create N users in the same postal+cuisine bucket, each with the
    same item priced at base_price + i*step. Returns the list of users
    so a test can pick the "requester" off the front and have the
    remaining (n-1) make up the cohort."""
    users = []
    for i in range(n):
        u = _mk_user(db, email=f"cohort-{i}@x.dk", postal=postal, cuisine=cuisine)
        _mk_item(db, user=u, name=name, sell_price=base_price + i * step)
        users.append(u)
    return users


# ─── Normalisation sanity ──────────────────────────────────────────────


def test_canonical_set_has_thirty_items_roughly():
    """The brief asked for ~30 canonical buckets across drinks/food/snacks.
    If this number swings dramatically we want a deliberate code change."""
    n = len(CANONICAL_NAMES)
    assert 20 <= n <= 60, (
        f"Expected ~30 canonical buckets, got {n}. If you added a new "
        "vertical's items, update this assertion. If you accidentally "
        "dropped buckets, restore them."
    )


def test_caffe_latte_normalises_to_latte():
    """The brief calls out this case explicitly — pin it."""
    assert normalize_item_name("Caffe Latte") == "latte"
    assert normalize_item_name("Caffé Latte") == "latte"
    assert normalize_item_name("CAFFE LATTE") == "latte"
    # Also pin: typos and qualifier-stripping
    assert normalize_item_name("Cappucino") == "cappuccino"
    assert normalize_item_name("Stor cappuccino") == "cappuccino"
    assert normalize_item_name("Sort Kaffe") == "americano"
    assert normalize_item_name("wienerbrød") == "pastry"


def test_unknown_item_returns_none():
    """Unknown items return None — never silently mapped to a wrong bucket."""
    assert normalize_item_name("Hovercraft full of eels") is None
    assert normalize_item_name("") is None
    assert normalize_item_name(None) is None
    assert normalize_item_name("    ") is None


def test_canonical_names_listing_stable():
    """list_canonical_names() must be deterministic — frontend can pin it."""
    a = list_canonical_names()
    b = list_canonical_names()
    assert a == b
    assert a == sorted(a)
    assert "cappuccino" in a
    assert "latte" in a
    assert "espresso" in a


# ─── Percentile helpers ────────────────────────────────────────────────


def test_percentile_basic():
    values = [10, 20, 30, 40, 50]
    assert _percentile(values, 0) == 10.0
    assert _percentile(values, 50) == 30.0
    assert _percentile(values, 100) == 50.0
    # 25th percentile = halfway between 10 and 20 in linear interpolation
    # over 5 values: pos = 0.25 * 4 = 1.0 → index 1 → 20
    assert _percentile(values, 25) == 20.0
    assert _percentile(values, 75) == 40.0


def test_percentile_of_value():
    # 5 values: where does each sit?
    values = sorted([10, 20, 30, 40, 50])
    # value <= all: 100% are at-or-above me, so I'm at the 20th percentile
    assert _percentile_of_value(values, 10) == 20
    # value at median: 60th percentile (3 of 5 are <= 30)
    assert _percentile_of_value(values, 30) == 60
    # value above max: 100th percentile
    assert _percentile_of_value(values, 100) == 100
    # value below min: 0th percentile
    assert _percentile_of_value(values, 1) == 0


def test_percentile_empty_safe():
    """Edge: empty input doesn't blow up."""
    assert _percentile([], 50) == 0.0
    assert _percentile_of_value([], 42) == 0


# ─── Privacy gate (NON-NEGOTIABLE) ─────────────────────────────────────


def test_privacy_gate_below_threshold_no_leak(db):
    """The headline invariant: cohorts with fewer than MIN_COHORT_SIZE
    distinct tenants must return available=False with NO aggregate
    fields ever present. This test pins that contract — any future
    change to the payload schema must update this assertion or be a
    privacy regression."""
    # Requester + only 2 others = cohort size 2 (excluding requester)
    users = _seed_cohort(db, n=3, name="Cappuccino")
    requester = users[0]

    result = get_market_comparison(db, requester, item_name="Cappuccino")

    assert result["available"] is False
    assert result["reason"] == "not_enough_data"
    assert result.get("min_samples") == MIN_COHORT_SIZE

    # Hard assertion — NONE of these aggregate fields may be present
    # in an unavailable payload, even as None.
    forbidden = {"min", "max", "median", "p25", "p75", "count",
                 "your_price", "deviation_pct", "percentile"}
    leaked = forbidden.intersection(result.keys())
    assert not leaked, (
        f"Privacy violation: aggregate fields leaked when n < threshold: {leaked}"
    )


def test_privacy_gate_with_exactly_threshold_minus_one(db):
    """Boundary: requester + (MIN_COHORT_SIZE - 1) others should still
    fail the gate. Adding one more puts us at the threshold."""
    # MIN_COHORT_SIZE = 5 by default. Seed 5 total → cohort excluding
    # requester = 4 → below threshold.
    users = _seed_cohort(db, n=MIN_COHORT_SIZE, name="Cappuccino")
    requester = users[0]
    result = get_market_comparison(db, requester, item_name="Cappuccino")
    assert result["available"] is False
    assert result["reason"] == "not_enough_data"


def test_sufficient_cohort_unlocks(db):
    """One above threshold (requester + MIN_COHORT_SIZE others = cohort N)
    should succeed."""
    # Total of MIN_COHORT_SIZE + 1 = 6 → cohort excluding requester = 5
    users = _seed_cohort(db, n=MIN_COHORT_SIZE + 1, name="Cappuccino")
    requester = users[0]
    result = get_market_comparison(db, requester, item_name="Cappuccino")
    assert result["available"] is True
    assert result["count"] == MIN_COHORT_SIZE
    assert result["canonical_name"] == "cappuccino"


def test_sufficient_cohort_yields_correct_median(db):
    """Pin the actual math: 5 cohort prices [46,47,48,49,50] → median = 48."""
    # 6 users total, requester has the 45 price. Cohort: 46,47,48,49,50.
    users = _seed_cohort(db, n=MIN_COHORT_SIZE + 1, base_price=45, step=1.0,
                         name="Cappuccino")
    requester = users[0]  # has 45
    result = get_market_comparison(db, requester, item_name="Cappuccino")

    assert result["available"] is True
    assert result["count"] == 5
    # Cohort (excluding requester) = [46, 47, 48, 49, 50]
    assert result["min"] == 46.0
    assert result["max"] == 50.0
    assert result["median"] == 48.0
    # User price 45, median 48 → -6.25%
    assert result["your_price"] == 45.0
    assert result["deviation_pct"] == pytest.approx(-6.25, rel=0.01)
    # Percentile: 45 is below every member of [46..50] → 0
    assert result["percentile"] == 0


def test_user_above_median_yields_positive_deviation(db):
    """Symmetric sanity: priced higher → positive deviation, high percentile."""
    users = _seed_cohort(db, n=MIN_COHORT_SIZE + 1, base_price=40, step=1.0,
                         name="Cappuccino")
    # Requester originally has 40; replace with 50 so they're at top.
    requester = users[0]
    requester_item = (
        db.query(InventoryItem).filter(InventoryItem.user_id == requester.id).first()
    )
    requester_item.sell_price = Decimal("50")
    db.commit()
    result = get_market_comparison(db, requester, item_name="Cappuccino")
    assert result["available"] is True
    # Cohort = [41, 42, 43, 44, 45], median = 43, user at 50 → +16.3%
    assert result["median"] == 43.0
    assert result["deviation_pct"] == pytest.approx((50 - 43) / 43 * 100, rel=0.01)
    assert result["percentile"] == 100


# ─── Cross-tenant safety ───────────────────────────────────────────────


def test_requesting_users_own_price_never_in_cohort_min(db):
    """If the requester is the unique minimum, their price must NOT
    appear in the returned min — they're excluded from the cohort."""
    # Cohort prices: 30, 50, 51, 52, 53, 54. Requester has the 30.
    users = []
    for i, price in enumerate([30, 50, 51, 52, 53, 54]):
        u = _mk_user(db, email=f"u{i}@x.dk", postal="2200", cuisine="cafe")
        _mk_item(db, user=u, name="Cappuccino", sell_price=price)
        users.append(u)
    requester = users[0]  # 30
    result = get_market_comparison(db, requester, item_name="Cappuccino")
    assert result["available"] is True
    # Min must be the cohort min (50), not the requester's outlier 30.
    assert result["min"] == 50.0
    assert result["your_price"] == 30.0


def test_multi_row_tenant_counts_once(db):
    """Layer 5 of the privacy model: a single tenant with 3 cappuccino
    rows in their inventory contributes ONE row to the cohort count,
    not three."""
    # 4 tenants with 1 item each + 1 tenant with 3 cappuccino items
    # = 7 rows raw, 5 distinct tenants. With the requester excluded,
    # cohort should be 4 distinct (below threshold).
    requester = _mk_user(db, email="me@x.dk", postal="2200", cuisine="cafe")
    _mk_item(db, user=requester, name="Cappuccino", sell_price=45)

    # Tenant with multiple cappuccino rows
    noisy = _mk_user(db, email="noisy@x.dk", postal="2200", cuisine="cafe")
    _mk_item(db, user=noisy, name="Cappuccino", sell_price=50)
    _mk_item(db, user=noisy, name="Cappuccino Stor", sell_price=55)  # also normalises
    _mk_item(db, user=noisy, name="cappucino", sell_price=60)        # also normalises

    # 3 more single-row tenants
    for i in range(3):
        u = _mk_user(db, email=f"other{i}@x.dk", postal="2200", cuisine="cafe")
        _mk_item(db, user=u, name="Cappuccino", sell_price=48 + i)

    result = get_market_comparison(db, requester, item_name="Cappuccino")
    # Cohort = noisy (1 dedupe), other0, other1, other2 = 4 distinct
    # → below threshold of 5 → gate fires.
    assert result["available"] is False, (
        "Multi-row tenant should have been deduped: each tenant should "
        "contribute at most 1 row to the cohort."
    )


def test_different_cuisine_bucket_isolated(db):
    """Bar cohort never bleeds into cafe cohort — different cuisine
    string means different aggregation bucket."""
    # 6 cafes priced for cappuccino
    cafes = []
    for i in range(6):
        u = _mk_user(db, email=f"cafe{i}@x.dk", postal="2200", cuisine="cafe")
        _mk_item(db, user=u, name="Cappuccino", sell_price=40 + i)
        cafes.append(u)
    # 4 bars also priced for cappuccino in the same postal
    for i in range(4):
        u = _mk_user(db, email=f"bar{i}@x.dk", postal="2200", cuisine="bar")
        _mk_item(db, user=u, name="Cappuccino", sell_price=99 + i)

    # The CAFE requester should see ONLY the 5 other cafes — not the bars.
    requester = cafes[0]
    result = get_market_comparison(db, requester, item_name="Cappuccino")
    assert result["available"] is True
    assert result["count"] == 5
    # Cohort = cafes 1..5 with prices 41..45; max must be 45, not 99+.
    assert result["max"] == 45.0


def test_different_postal_bucket_isolated(db):
    """Same cuisine but a different postal = different bucket."""
    # 6 cafes in 2200
    here = []
    for i in range(6):
        u = _mk_user(db, email=f"here{i}@x.dk", postal="2200", cuisine="cafe")
        _mk_item(db, user=u, name="Cappuccino", sell_price=40 + i)
        here.append(u)
    # 4 cafes in 8000 (Aarhus) at very different prices
    for i in range(4):
        u = _mk_user(db, email=f"aarhus{i}@x.dk", postal="8000", cuisine="cafe")
        _mk_item(db, user=u, name="Cappuccino", sell_price=99 + i)

    requester = here[0]
    result = get_market_comparison(db, requester, item_name="Cappuccino")
    assert result["available"] is True
    assert result["count"] == 5
    assert result["max"] == 45.0  # never 99+


# ─── Missing postal/cuisine ────────────────────────────────────────────


def test_user_without_postal_returns_needs_setup(db):
    """No postal in BusinessProfile → user can't see comparisons."""
    requester = _mk_user(db, email="me@x.dk", postal=None, cuisine="cafe")
    _mk_item(db, user=requester, name="Cappuccino", sell_price=45)
    # Seed a fat cohort with postals so it's not a data gap
    for i in range(MIN_COHORT_SIZE + 1):
        u = _mk_user(db, email=f"o{i}@x.dk", postal="2200", cuisine="cafe")
        _mk_item(db, user=u, name="Cappuccino", sell_price=48 + i)

    result = get_market_comparison(db, requester, item_name="Cappuccino")
    assert result["available"] is False
    assert result["reason"] == "needs_setup"


def test_user_without_cuisine_returns_needs_setup(db):
    """No cuisine in BusinessProfile → no comparisons (can't bucket)."""
    requester = _mk_user(db, email="me@x.dk", postal="2200", cuisine=None)
    _mk_item(db, user=requester, name="Cappuccino", sell_price=45)
    result = get_market_comparison(db, requester, item_name="Cappuccino")
    assert result["available"] is False
    assert result["reason"] == "needs_setup"


def test_unknown_item_returns_unknown_item(db):
    """Item that doesn't map to a canonical → distinct reason."""
    users = _seed_cohort(db, n=MIN_COHORT_SIZE + 1, name="Cappuccino")
    requester = users[0]
    result = get_market_comparison(db, requester, item_name="Astronaut Helmet")
    assert result["available"] is False
    assert result["reason"] == "unknown_item"


# ─── Audit / SecurityEvent ─────────────────────────────────────────────


def test_each_query_writes_security_event(db):
    """Every per-item lookup writes a SecurityEvent — defence against
    quiet scraping. Pin it: no audit row = potential cover-up of
    bulk recon."""
    users = _seed_cohort(db, n=MIN_COHORT_SIZE + 1, name="Cappuccino")
    requester = users[0]
    before = db.query(SecurityEvent).count()
    get_market_comparison(db, requester, item_name="Cappuccino")
    after = db.query(SecurityEvent).count()
    assert after == before + 1
    evt = (
        db.query(SecurityEvent)
        .order_by(SecurityEvent.created_at.desc())
        .first()
    )
    assert evt.event_type == "smart_pricing.lookup"
    assert evt.user_id == requester.id
    assert "canonical=cappuccino" in evt.detail


def test_failed_lookup_also_audited(db):
    """Audit fires even when the gate rejects — recon attacks pinging
    sparse postals must also leave a trail."""
    requester = _mk_user(db, email="me@x.dk", postal="2200", cuisine="cafe")
    _mk_item(db, user=requester, name="Cappuccino", sell_price=45)
    before = db.query(SecurityEvent).count()
    result = get_market_comparison(db, requester, item_name="Cappuccino")
    after = db.query(SecurityEvent).count()
    assert result["available"] is False  # only requester in the bucket
    assert after == before + 1


def test_unknown_item_lookup_also_audited(db):
    """Even unknown item names get audited — otherwise an attacker can
    learn which canonical strings exist by diffing audit/no-audit."""
    requester = _mk_user(db, email="me@x.dk", postal="2200", cuisine="cafe")
    before = db.query(SecurityEvent).count()
    get_market_comparison(db, requester, item_name="No such item")
    after = db.query(SecurityEvent).count()
    assert after == before + 1


def test_batch_audits_once_not_per_item(db):
    """Loading the PricingPage triggers /all which scans many canonicals;
    we want ONE audit row per page-load, not 20."""
    requester = _mk_user(db, email="me@x.dk", postal="2200", cuisine="cafe")
    _mk_item(db, user=requester, name="Cappuccino", sell_price=45)
    _mk_item(db, user=requester, name="Latte", sell_price=49)
    _mk_item(db, user=requester, name="Espresso", sell_price=30)

    before = db.query(SecurityEvent).count()
    get_all_market_comparisons(db, requester)
    after = db.query(SecurityEvent).count()
    # Exactly 1 audit row for the batch, regardless of canonical count.
    assert after - before == 1
    evt = (
        db.query(SecurityEvent)
        .order_by(SecurityEvent.created_at.desc())
        .first()
    )
    assert evt.event_type == "smart_pricing.lookup"
    assert "canonical=<batch>" in evt.detail


# ─── Cache TTL ─────────────────────────────────────────────────────────


def test_cache_hit_avoids_duplicate_query(db, monkeypatch):
    """Within TTL, a second call hits the in-process cache rather than
    re-querying. We assert by counting the SQL aggregator call."""
    users = _seed_cohort(db, n=MIN_COHORT_SIZE + 1, name="Cappuccino")
    requester = users[0]

    call_log = {"count": 0}
    real_fetch = sp_module._fetch_cohort_rows

    def counting_fetch(*args, **kwargs):
        call_log["count"] += 1
        return real_fetch(*args, **kwargs)

    monkeypatch.setattr(sp_module, "_fetch_cohort_rows", counting_fetch)

    r1 = get_market_comparison(db, requester, item_name="Cappuccino")
    first_count = call_log["count"]
    r2 = get_market_comparison(db, requester, item_name="Cappuccino")
    second_count = call_log["count"]

    assert r1["median"] == r2["median"]
    # First call did the aggregate + the user-attach percentile fetch
    # (2 calls). Cached second call still does the user-attach percentile
    # fetch (1 call), but skips the aggregate. So second_count = first_count + 1.
    # The important invariant is: second call did FEWER aggregator calls
    # than the first.
    assert (second_count - first_count) < first_count


def test_cache_ttl_expiry_re_fetches(db, monkeypatch):
    """Beyond TTL, the cache is invalidated and we re-query."""
    users = _seed_cohort(db, n=MIN_COHORT_SIZE + 1, name="Cappuccino")
    requester = users[0]

    # Tell smart_pricing the cache is ancient.
    monkeypatch.setattr(sp_module, "CACHE_TTL_SECONDS", 0)
    sp_module._cache_clear()
    r1 = get_market_comparison(db, requester, item_name="Cappuccino")

    # The TTL=0 path means the very next call rejects the cache.
    call_log = {"count": 0}
    real_fetch = sp_module._fetch_cohort_rows

    def counting_fetch(*args, **kwargs):
        call_log["count"] += 1
        return real_fetch(*args, **kwargs)

    monkeypatch.setattr(sp_module, "_fetch_cohort_rows", counting_fetch)

    r2 = get_market_comparison(db, requester, item_name="Cappuccino")
    # Re-fetch happened (>=1 aggregate calls on second run).
    assert call_log["count"] >= 1
    assert r1["median"] == r2["median"]


# ─── Edge cases ────────────────────────────────────────────────────────


def test_zero_priced_items_excluded(db):
    """Items with sell_price = 0 (or NULL) must not contribute to the
    cohort — they're not 'priced'."""
    requester = _mk_user(db, email="me@x.dk", postal="2200", cuisine="cafe")
    _mk_item(db, user=requester, name="Cappuccino", sell_price=45)
    # 5 cohort members with mix of priced + unpriced rows
    for i in range(5):
        u = _mk_user(db, email=f"o{i}@x.dk", postal="2200", cuisine="cafe")
        _mk_item(db, user=u, name="Cappuccino", sell_price=48 + i)
    # 3 more cohort members with sell_price = 0 (should NOT count)
    for i in range(3):
        u = _mk_user(db, email=f"zp{i}@x.dk", postal="2200", cuisine="cafe")
        _mk_item(db, user=u, name="Cappuccino", sell_price=0)

    result = get_market_comparison(db, requester, item_name="Cappuccino")
    assert result["available"] is True
    # Cohort = 5 priced others; never 8.
    assert result["count"] == 5


def test_user_without_priced_item_still_sees_cohort(db):
    """The requester hasn't priced cappuccino, but they can still see the
    market median (the comparison just has your_price=None)."""
    users = _seed_cohort(db, n=MIN_COHORT_SIZE + 1, name="Cappuccino")
    requester = users[0]
    # Strip the requester's price so they have no comparison anchor
    requester_item = (
        db.query(InventoryItem).filter(InventoryItem.user_id == requester.id).first()
    )
    db.delete(requester_item)
    db.commit()

    result = get_market_comparison(db, requester, item_name="Cappuccino")
    # Cohort excluding requester = 5 = threshold. Available.
    assert result["available"] is True
    assert result["your_price"] is None
    assert result["deviation_pct"] is None
    assert result["percentile"] is None


def test_batch_endpoint_filters_to_priced_items(db):
    """/all only returns comparisons for items the user has priced."""
    requester = _mk_user(db, email="me@x.dk", postal="2200", cuisine="cafe")
    _mk_item(db, user=requester, name="Cappuccino", sell_price=45)
    _mk_item(db, user=requester, name="Latte", sell_price=49)
    # Unpriced item — must NOT appear in comparisons
    _mk_item(db, user=requester, name="Espresso", sell_price=0)

    # Make Latte have an available cohort but Cappuccino doesn't (cohort
    # = 2 others, below threshold). Both items should appear, one
    # available and one not.
    for i in range(MIN_COHORT_SIZE + 1):
        u = _mk_user(db, email=f"l{i}@x.dk", postal="2200", cuisine="cafe")
        _mk_item(db, user=u, name="Latte", sell_price=48 + i)
    # Only 2 cappuccino cohort members → gate
    for i in range(2):
        u = _mk_user(db, email=f"c{i}@x.dk", postal="2200", cuisine="cafe")
        _mk_item(db, user=u, name="Cappuccino", sell_price=48 + i)

    out = get_all_market_comparisons(db, requester)
    canonicals = {c["canonical_name"] for c in out["comparisons"]}
    # Espresso (sell_price=0) is excluded; only cappuccino and latte appear.
    assert canonicals == {"cappuccino", "latte"}
    by_canon = {c["canonical_name"]: c for c in out["comparisons"]}
    assert by_canon["latte"]["available"] is True
    assert by_canon["cappuccino"]["available"] is False
    assert out["available_count"] == 1
    assert out["unavailable_count"] == 1


def test_batch_endpoint_needs_setup_when_no_profile(db):
    """No profile at all → /all returns needs_setup."""
    u = User(
        email="no-profile@x.dk", password_hash="x",
        business_name="x", business_type="cafe", currency="DKK",
    )
    db.add(u); db.commit(); db.refresh(u)
    _mk_item(db, user=u, name="Cappuccino", sell_price=45)
    out = get_all_market_comparisons(db, u)
    assert out["needs_setup"] is True
    assert out["comparisons"] == []


# ─── Billing feature flag ──────────────────────────────────────────────


def test_smart_pricing_enabled_on_all_tiers():
    """Retention hook, not a paywall — every tier (Free, Starter, Pro,
    Trial) must have smart_pricing = True."""
    for plan in ("free", "starter", "pro", "trial"):
        assert PLAN_FEATURES[plan].get("smart_pricing") is True, (
            f"Plan {plan!r} should have smart_pricing=True; got "
            f"{PLAN_FEATURES[plan].get('smart_pricing')!r}"
        )


def test_has_feature_smart_pricing_for_free_user():
    """Smoke test that has_feature() agrees with PLAN_FEATURES."""
    u = User(
        email="x@x.dk", password_hash="x",
        business_name="x", business_type="cafe", currency="DKK",
    )
    u.plan = "free"
    u.trial_ends_at = None
    assert has_feature(u, "smart_pricing") is True


# ─── Schema-level invariant ────────────────────────────────────────────


def test_unavailable_payload_never_includes_aggregates(db):
    """Belt-and-braces: pin that the _unavailable helper never lets
    aggregate keys slip through, even via the `extra` kwargs."""
    from app.services.smart_pricing import _unavailable
    out = _unavailable("not_enough_data")
    for forbidden in ("min", "max", "median", "p25", "p75", "count",
                      "your_price", "deviation_pct", "percentile"):
        assert forbidden not in out


def test_currency_present_in_available_payload(db):
    """UI needs to know what currency the cohort prices are in."""
    users = _seed_cohort(db, n=MIN_COHORT_SIZE + 1, name="Cappuccino")
    requester = users[0]
    result = get_market_comparison(db, requester, item_name="Cappuccino")
    assert result["available"] is True
    assert result.get("currency") == "DKK"


# ─── Audit P2 (Task #76) — postal_code spoofing defense ─────────────


def test_unverified_profile_yields_no_comparison(db):
    """A user whose BusinessProfile has zipcode set but has NOT done
    DAWA + CVR verification must NOT pull a cohort.  Even if the
    cohort exists for that postal, smart_pricing returns
    needs_setup so the attacker can't leech aggregates.

    Mitigates the postal-spoofing attack: PUT /business lets owners
    type any zipcode; without verification, that input is untrusted.
    """
    # Build the cohort first (verified neighbours so cohort is real)
    users = _seed_cohort(db, n=MIN_COHORT_SIZE + 1, name="Cappuccino")
    # All cohort users are verified by _seed_cohort.  Now add an
    # attacker whose profile has the same postal/cuisine but NO
    # DAWA + CVR verification.
    attacker = _mk_user(db, email="attacker@x.test", postal="9999", cuisine="cafe")
    # Strip verification from attacker's profile (the helper sets it,
    # so we deliberately undo for this test):
    from app.models.business_profile import BusinessProfile
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == attacker.id)
        .first()
    )
    profile.dawa_address_id = None
    profile.cvr_verified_at = None
    profile.cvr_verified_source = None
    profile.zipcode = users[0].business_profile.zipcode if hasattr(users[0], "business_profile") else "2200"
    db.commit()

    result = get_market_comparison(db, attacker, item_name="Cappuccino")
    # Attacker gets no usable cohort data
    assert result["available"] is False
    # And the reason is the gate, not "not enough data" (which would
    # leak the fact that the cohort exists).
    assert result["reason"] == "needs_setup"
