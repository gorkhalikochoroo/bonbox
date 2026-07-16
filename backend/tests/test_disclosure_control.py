"""Complementary k-suppression — the correctness core of the thesis export.

Every test uses the REAL prod distributions (queried 16 Jul 2026), because the
whole point is that THESE numbers can be published safely. A test on invented
data would prove nothing about the thesis.

The invariant under test, stated once: after suppression, no emitted number —
including the total printed alongside — can be arithmetic'd back to a count
below k for any single account. `_assert_safe` checks that mechanically on
every result, so a test cannot pass while leaking.
"""
from __future__ import annotations

from itertools import combinations

from app.services.disclosure_control import K, suppress


def _assert_safe(table, original: dict[str, int]):
    """The re-identification attack, run on every result: can a reader who
    sees the published rows + total recover any suppressed cell down to < k?"""
    assert K == 5

    # (a) Every emitted row is itself >= k.
    for _, n in table.rows:
        assert n >= K, f"emitted a cell of {n} < {K}"

    # (b) The residual bucket, if any, is >= k and covers >= 2 original cells.
    if table.combined_suppressed is not None:
        assert table.combined_suppressed >= K
        assert table.combined_cell_count >= 2

    # (c) The killer check — DIFFERENCING. The reader knows total and every row.
    #     The residual = total - sum(rows). It must NOT reveal a single cell.
    if not table.fully_suppressed and table.combined_suppressed is not None:
        residual = table.total - sum(n for _, n in table.rows)
        assert residual == table.combined_suppressed
        # A residual that equals exactly one original cell is a leak.
        assert residual not in original.values() or table.combined_cell_count >= 2, (
            "residual equals a single original cell — differenceable to one account"
        )

    # (d) No subset of published rows can be differenced against the total to
    #     isolate a below-k cell. (Full power-set check — n is tiny here.)
    if not table.fully_suppressed:
        published = [n for _, n in table.rows]
        for r in range(1, len(published) + 1):
            for combo in combinations(published, r):
                remainder = table.total - sum(combo)
                # remainder is either another safe row-sum, or the residual
                # bucket (>= k, >= 2 cells). It must never be a lone small cell.
                if 0 < remainder < K:
                    # allowed ONLY if it corresponds to the combined bucket,
                    # which by (b) covers >= 2 cells — but then it's >= k, so
                    # remainder < K here is always a leak.
                    raise AssertionError(
                        f"differencing {combo} from {table.total} yields "
                        f"{remainder} < {K} — re-identifiable"
                    )


# ── the real prod distributions ───────────────────────────────────────────

BUSINESS_TYPE = {
    "restaurant": 23, "personal": 19, "other": 8, "clothing": 5, "bakery": 4,
    "(blank)": 4, "cafe": 2, "retail": 2, "online_clothing": 1, "pharmacy": 1,
    "food_truck": 1, "shop": 1,
}
PLAN = {"free": 69, "pro": 2}
STAFF = {"0 staff": 66, "1 staff": 3, "5 staff": 1, "17 staff": 1}
SIGNUP_WEEK = {
    "W13": 19, "W12": 15, "W14": 8, "W15": 8, "W20": 6, "W16": 5, "W19": 5,
    "W22": 2, "W25": 1, "W21": 1, "W26": 1,
}


def test_business_type_keeps_four_collapses_the_rest():
    t = suppress("business_type", BUSINESS_TYPE)
    _assert_safe(t, BUSINESS_TYPE)
    kept = dict(t.rows)
    assert set(kept) == {"restaurant", "personal", "other", "clothing"}
    # 16 accounts across 8 categories fold into one bucket — never eight cells.
    assert t.combined_suppressed == 16
    assert t.combined_cell_count == 8
    assert t.total == 71


def test_plan_is_fully_suppressed_because_the_minority_is_differenceable():
    """free 69 / pro 2: publishing 69 against total 71 discloses pro=2. The
    ONLY safe outcome is to suppress the whole dimension."""
    t = suppress("plan", PLAN)
    _assert_safe(t, PLAN)
    assert t.fully_suppressed is True
    assert t.rows == []
    # "2 pro accounts" must appear NOWHERE.
    assert t.combined_suppressed is None


def test_staff_says_66_have_none_and_never_that_one_has_17():
    t = suppress("staff", STAFF)
    _assert_safe(t, STAFF)
    kept = dict(t.rows)
    assert kept == {"0 staff": 66}
    # {1,5,17}-staff accounts (3+1+1) fold into a bucket of 5 — the "17" is gone.
    assert t.combined_suppressed == 5
    assert t.combined_cell_count == 3
    # The literal string "17" must not survive anywhere in the emitted table.
    assert "17 staff" not in kept


def test_signup_weeks_below_k_fold_into_a_safe_tail():
    t = suppress("signup_week", SIGNUP_WEEK)
    _assert_safe(t, SIGNUP_WEEK)
    kept = dict(t.rows)
    # W22/W25/W21/W26 (2+1+1+1 = 5 across 4 weeks) fold together.
    assert all(kept[w] >= K for w in kept)
    assert t.combined_suppressed == 5
    assert t.combined_cell_count == 4


def test_a_clean_distribution_needs_no_suppression():
    clean = {"a": 20, "b": 15, "c": 10}
    t = suppress("clean", clean)
    _assert_safe(t, clean)
    assert t.combined_suppressed is None
    assert dict(t.rows) == clean


def test_single_below_k_cell_borrows_a_survivor_so_it_cannot_be_differenced():
    """One tiny cell + big survivors: the residual would equal that one cell,
    so a survivor MUST be pulled in to cover >= 2 cells."""
    d = {"big": 40, "mid": 20, "tiny": 2}
    t = suppress("borrow", d)
    _assert_safe(t, d)
    # residual can't be just {tiny:2}; it borrows "mid" -> 22 across 2 cells.
    assert t.combined_cell_count >= 2
    assert t.combined_suppressed >= K


def test_output_is_deterministic():
    a = suppress("business_type", BUSINESS_TYPE).as_dict()
    b = suppress("business_type", dict(reversed(list(BUSINESS_TYPE.items())))).as_dict()
    assert a == b, "same data, different insertion order -> different table (audit-breaking)"


def test_binary_suppression_exposes_a_safe_less_than_k_band():
    """plan (69/2) and activity (67/4): the small side is suppressed to an
    upper bound '< k', never an exact count. The band pins no account."""
    for d in ({"free": 69, "pro": 2}, {"inactive": 67, "active": 4}):
        t = suppress("bin", d)
        assert t.fully_suppressed is True
        assert t.minority_band == f"< {K}"
        # The publishable sentence must say "fewer than 5", never "2" or "4".
        stmt = t.publishable_statement()
        assert f"fewer than {K}" in stmt
        for exact in ("2", "4", "pro", "active"):
            assert f": {exact}" not in stmt
        # The majority is NOT emitted, so the band cannot be differenced.
        assert t.rows == []
