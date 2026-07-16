"""Pure tests for services/labor_split.build_labor_split — the department cost
split behind /staff/hours. Honesty rails are the point: never a misleading
single-bucket split, never a fabricated department, estimate framing intact."""

from app.services.labor_split import build_labor_split

FERIE = 0.125


def _split(staff_roles, hours, gross, vertical="restaurant"):
    return build_labor_split(
        staff_roles=staff_roles,
        per_staff_hours=hours,
        per_staff_gross=gross,
        vertical=vertical,
        ferie_uplift=FERIE,
    )


def test_buckets_by_department_with_loaded_estimate():
    # 2 servers (FOH) + 1 chef (kitchen).
    out = _split(
        {"s1": "server", "s2": "server", "c1": "head_chef"},
        {"s1": 30.0, "s2": 20.0, "c1": 40.0},
        {"s1": 6000.0, "s2": 4000.0, "c1": 8000.0},
    )
    assert out is not None
    cats = {c["category"]: c for c in out["categories"]}
    assert set(cats) == {"front_of_house", "kitchen"}
    assert cats["front_of_house"]["gross"] == 10000.0
    assert cats["kitchen"]["gross"] == 8000.0
    # loaded = gross × 1.125 (same feriepenge estimate as the cost tile)
    assert cats["front_of_house"]["loaded"] == 11250.0
    assert cats["kitchen"]["loaded"] == 9000.0
    assert out["total_loaded"] == round(18000.0 * 1.125, 2)
    assert out["basis"] == "primary_role"
    # busiest-cost department first
    assert out["categories"][0]["category"] == "front_of_house"


def test_single_department_returns_none():
    """Every staffer on the default role → one bucket → nothing to split →
    render nothing (never a misleading '100% front of house')."""
    out = _split(
        {"a": "server", "b": "server", "c": "server"},
        {"a": 10.0, "b": 10.0, "c": 10.0},
        {"a": 2000.0, "b": 2000.0, "c": 2000.0},
    )
    assert out is None


def test_no_cost_returns_none():
    """No wage rates configured → gross 0 → the money card has nothing honest to
    show (the parent tile already says 'set wage rates')."""
    out = _split(
        {"s1": "server", "c1": "head_chef"},
        {"s1": 30.0, "c1": 40.0},
        {"s1": 0.0, "c1": 0.0},
    )
    assert out is None


def test_unknown_role_bucketed_unassigned_and_pinned_last():
    out = _split(
        {"s1": "server", "x1": "made_up_role"},
        {"s1": 20.0, "x1": 20.0},
        {"s1": 5000.0, "x1": 3000.0},  # unassigned has LESS cost here anyway
    )
    assert out is not None
    cats = [c["category"] for c in out["categories"]]
    assert "unassigned" in cats
    assert cats[-1] == "unassigned"  # always last, even independent of cost order


def test_unassigned_pinned_last_even_when_costliest():
    """Ordering: 'unassigned' is pinned last even if it carries the most cost —
    it must never read as the headline department."""
    out = _split(
        {"s1": "server", "x1": "mystery"},
        {"s1": 5.0, "x1": 50.0},
        {"s1": 1000.0, "x1": 9000.0},  # unassigned is the BIGGEST
    )
    assert out["categories"][-1]["category"] == "unassigned"
    assert out["categories"][0]["category"] == "front_of_house"


def test_pct_of_cost_sums_to_one_and_no_revenue_pct():
    out = _split(
        {"s1": "server", "c1": "head_chef", "d1": "dishwasher"},
        {"s1": 30.0, "c1": 40.0, "d1": 10.0},
        {"s1": 6000.0, "c1": 8000.0, "d1": 1500.0},
    )
    total_pct = sum(c["pct_of_cost"] for c in out["categories"])
    assert abs(total_pct - 1.0) < 0.001
    # HONESTY: share-of-COST only — never a per-department labour% vs revenue.
    for c in out["categories"]:
        assert set(c.keys()) == {"category", "hours", "gross", "loaded", "pct_of_cost"}


def test_none_role_is_unassigned():
    out = _split(
        {"s1": "server", "n1": None},
        {"s1": 20.0, "n1": 15.0},
        {"s1": 4000.0, "n1": 2500.0},
    )
    cats = {c["category"] for c in out["categories"]}
    assert cats == {"front_of_house", "unassigned"}


def test_negative_department_excluded_and_shares_stay_consistent():
    """A correction/reversal entry can net a department negative (earned has no ≥0
    guard). It must be excluded from BOTH total and render, so shares never sum
    past 100% and no real department vanishes behind an under-counted denominator."""
    out = _split(
        {"s1": "server", "d1": "dishwasher", "c1": "head_chef"},
        {"s1": 30.0, "d1": 20.0, "c1": 30.0},
        {"s1": 5000.0, "d1": 3000.0, "c1": -2000.0},  # kitchen nets NEGATIVE
    )
    assert out is not None
    cats = {c["category"]: c for c in out["categories"]}
    assert "kitchen" not in cats  # negative department excluded from render
    total_pct = sum(c["pct_of_cost"] for c in out["categories"])
    assert abs(total_pct - 1.0) < 0.001          # shares consistent, never >100%
    assert all(c["pct_of_cost"] <= 1.0 for c in out["categories"])
    # total_loaded reconciles with the shown rows (8000 × 1.125)
    assert out["total_loaded"] == 9000.0
    assert round(sum(c["loaded"] for c in out["categories"]), 2) == 9000.0


def test_immaterial_department_hides_card():
    """40,000 kr barista + 130 kr dishwasher must NOT render 'front of house 100% ·
    support 0%' — the sliver is immaterial, so only one department is material and
    the card stays hidden."""
    out = _split(
        {"b1": "barista", "d1": "dishwasher"},
        {"b1": 200.0, "d1": 1.0},
        {"b1": 40000.0, "d1": 130.0},  # dishwasher ≈ 0.3% → immaterial
        vertical="cafe",
    )
    assert out is None


def test_immaterial_department_dropped_but_card_shows_material_ones():
    """A genuinely tiny third department is dropped from the render (never a '0%'
    row), while the two material departments still show."""
    out = _split(
        {"s1": "server", "c1": "line_cook", "d1": "dishwasher"},
        {"s1": 40.0, "c1": 30.0, "d1": 1.0},
        {"s1": 6000.0, "c1": 3900.0, "d1": 50.0},  # support 50/9950 ≈ 0.5% → dropped
    )
    assert out is not None
    cats = {c["category"] for c in out["categories"]}
    assert cats == {"front_of_house", "kitchen"}   # support dropped
    # every shown department is ≥1% (can never round to "0%")
    assert all(round(c["pct_of_cost"] * 100) >= 1 for c in out["categories"])


def test_salon_vertical_passed_through():
    """Salon: stylists (specialist) + reception (FOH). Vertical echoed so the
    frontend can pick the salon-natural label ('Stylists', not 'Specialists')."""
    out = _split(
        {"a": "stylist", "b": "stylist", "r": "receptionist"},
        {"a": 30.0, "b": 30.0, "r": 20.0},
        {"a": 9000.0, "b": 9000.0, "r": 3000.0},
        vertical="salon",
    )
    assert out is not None
    assert out["vertical"] == "salon"
    cats = {c["category"] for c in out["categories"]}
    assert cats == {"specialist", "front_of_house"}
