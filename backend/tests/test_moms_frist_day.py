"""
The MOMS countdown was silent on the one day it exists for.

THE DEFECT
----------
`tax_service._get_next_deadlines()` dropped any deadline falling on `today`
(`deadline <= today` in the fixed-date branch, `deadline > today` in the monthly
one). So `days_until` was always >= 1 and could never be 0. On 1 September — the
frist for a default DK half-yearly filer — the owner opened /tax and read
"181 days" (March's deadline) instead of "due today", and the ~06:00 brief said
nothing. Every downstream `== 0` branch was unreachable: the daily brief's
due-today candidate, get_tax_overview's status, TaxAutopilotPage.

WHY IT WAS NOT A TWO-CHARACTER FLIP
-----------------------------------
The author's own note listed the coupling, and it was right. Both branches of
_get_next_deadlines had to move together with the two fail-closed guards in
foresight_service — project() and build_envelope(), which each bailed on
`deadline <= as_of`. Fixing only the tax filter would have handed a COVERED
owner INSUFFICIENT_DATA from Foresight on the exact day the bill was due: a
worse regression than the bug, on the same screen.

WHAT REMAINS DELIBERATELY UNREACHABLE
-------------------------------------
`days_until < 0` and every "overdue" state. Not an oversight — BonBox has no
signal that an owner has filed (no filings table, no filed flag, no SKAT
integration; most DK small businesses file through their revisor). An
"overdue — SKAT fines accrue" alert would fire at owners who filed on time,
every morning, undismissable. test_overdue_is_still_unreachable pins that, and
it should FAIL loudly if someone enables it without a filed signal first.

Run:
  cd backend && python3 -m pytest tests/test_moms_frist_day.py -x -q
"""

from datetime import date
from decimal import Decimal

import pytest

from app.services import foresight_service as fs
from app.services import tax_service as ts
from app.services.foresight_service import (
    ENVELOPE_FUNDED,
    ENVELOPE_FUNDING,
    ForesightInputs,
    STATE_INSUFFICIENT_DATA,
)

# DK fristerne used below. 1 Sep settles H1 (half-yearly) and Q2 (quarterly);
# the 25th settles the prior month.
FRIST_HALF = date(2026, 9, 1)
FRIST_MONTHLY = date(2026, 9, 25)


# ── tax_service: the frist day is now inside the window ───────────────────
@pytest.mark.parametrize("freq,frist,period", [
    ("half_yearly", FRIST_HALF, "H1 2026"),
    ("quarterly", FRIST_HALF, "Q2 2026"),
    ("monthly", FRIST_MONTHLY, "August 2026"),
])
def test_days_until_reaches_zero_on_the_frist(freq, frist, period):
    rows = ts._get_next_deadlines("DKK", frequency=freq, count=2, as_of=frist)
    assert rows, f"no {freq} deadlines"
    first = rows[0]
    assert first["deadline"] == frist, (
        "the deadline falling today must be returned, not skipped for the next one"
    )
    assert (first["deadline"] - frist).days == 0
    # The period the countdown names must be the one actually due today.
    assert first["period_label"] == period


@pytest.mark.parametrize("freq,frist", [
    ("half_yearly", FRIST_HALF),
    ("quarterly", FRIST_HALF),
    ("monthly", FRIST_MONTHLY),
])
def test_the_day_after_rolls_forward_and_never_returns_a_past_frist(freq, frist):
    day_after = date.fromordinal(frist.toordinal() + 1)
    rows = ts._get_next_deadlines("DKK", frequency=freq, count=4, as_of=day_after)
    assert rows
    for r in rows:
        assert r["deadline"] > frist, (
            "a passed frist must never come back — the overdue states are "
            "deliberately unreachable until a 'filed' signal exists"
        )


def test_period_does_not_drift_when_the_frist_day_is_included():
    """_derive_period reads only the DEADLINE, never `today`, so including the
    same-day deadline shifts no period. On 1 Sep it returns H1 (the one due)
    instead of H2 — the fix, not drift. A countdown change that silently moved
    which period compute_filing_data settles would be far worse than the bug."""
    on_frist = ts._get_next_deadlines("DKK", frequency="half_yearly", count=1,
                                      as_of=FRIST_HALF)[0]
    day_before = ts._get_next_deadlines("DKK", frequency="half_yearly", count=1,
                                        as_of=date(2026, 8, 31))[0]
    assert on_frist["deadline"] == day_before["deadline"] == FRIST_HALF
    assert on_frist["period_label"] == day_before["period_label"] == "H1 2026"
    assert on_frist["period_start"] == day_before["period_start"]
    assert on_frist["period_end"] == day_before["period_end"]


# ── foresight: the regression the SCOPE note warned about ─────────────────
def _inputs(balance, *, as_of=FRIST_HALF, deadline=FRIST_HALF):
    return ForesightInputs(
        as_of=as_of, deadline=deadline,
        current_balance=Decimal(balance),
        moms_estimate=Decimal("88777"),
        safety_buffer=Decimal("0"),
        frequency="half_yearly",
    )


def test_foresight_answers_on_the_frist_instead_of_insufficient_data():
    """The single most useful moment this engine has — 'the bill lands today,
    does your balance cover it?' — was the one day the answer was withheld."""
    covered = fs.project(_inputs("200000"))
    assert covered.state != STATE_INSUFFICIENT_DATA
    assert covered.covers_moms is True
    assert covered.horizon_days == 0
    assert covered.balance_after_moms == Decimal("111223")   # 200000 - 88777

    short = fs.project(_inputs("10000"))
    assert short.state != STATE_INSUFFICIENT_DATA
    assert short.covers_moms is False
    assert short.balance_after_moms == Decimal("-78777")


def test_foresight_still_fails_closed_on_a_passed_deadline():
    """The fail-closed guard (#352) must survive the fix — only the boundary
    moved from `<=` to `<`."""
    p = fs.project(_inputs("200000", as_of=date(2026, 9, 2), deadline=FRIST_HALF))
    assert p.state == STATE_INSUFFICIENT_DATA
    assert p.covers_moms is None
    assert p.balance_after_moms is None


def test_foresight_fails_closed_on_missing_balance_regardless():
    p = fs.project(ForesightInputs(
        as_of=FRIST_HALF, deadline=FRIST_HALF, current_balance=None,
        moms_estimate=Decimal("88777"), safety_buffer=Decimal("0"),
    ))
    assert p.state == STATE_INSUFFICIENT_DATA


# ── the reserve envelope on the due date ──────────────────────────────────
def _cone(deadline, as_of=FRIST_HALF, balance="300000"):
    inp = ForesightInputs(as_of=as_of, deadline=deadline,
                          current_balance=Decimal(balance),
                          safety_buffer=Decimal("0"))
    rng = fs.build_moms_range(realized_moms=Decimal("100000"),
                              projected_remaining_moms=Decimal("40000"))
    return fs.build_cone(inp, rng)


def test_envelope_keeps_the_numbers_it_knows_on_the_frist():
    """target / reserved / remaining / funded_pct are all still exactly right on
    the due date. Only the SCHEDULE is meaningless — there are no weeks left to
    spread a contribution over. Saying INSUFFICIENT_DATA would claim not to know
    a figure we know perfectly well, on the day it matters most."""
    env = fs.build_envelope(_cone(FRIST_HALF), reserved=Decimal("50000"))
    assert env.status != STATE_INSUFFICIENT_DATA
    assert env.status == ENVELOPE_FUNDING
    assert env.target == Decimal("150000")
    assert env.remaining == Decimal("100000")
    assert env.funded_pct == pytest.approx(0.33, abs=0.01)
    # No schedule is possible — same shape the INSUFFICIENT_DATA branch emits,
    # so no consumer sees a new type.
    assert env.weeks is None
    assert env.weekly_contribution == Decimal("0")


def test_envelope_says_funded_on_the_frist_when_the_money_is_there():
    env = fs.build_envelope(_cone(FRIST_HALF), reserved=Decimal("150000"))
    assert env.status == ENVELOPE_FUNDED
    assert env.remaining == Decimal("0")
    assert env.weeks is None


def test_envelope_still_insufficient_on_a_passed_deadline():
    env = fs.build_envelope(
        _cone(FRIST_HALF, as_of=date(2026, 9, 2)), reserved=Decimal("50000"),
    )
    assert env.status == STATE_INSUFFICIENT_DATA


def test_envelope_unchanged_with_time_left():
    """Non-regression: the ordinary case must be byte-identical."""
    env = fs.build_envelope(_cone(date(2026, 9, 1), as_of=date(2026, 6, 14)))
    assert env.status == ENVELOPE_FUNDING
    assert env.weeks == 12
    assert env.weekly_contribution == Decimal("12500")


# ── the brief, and the line that must stay switched off ───────────────────
def test_the_due_today_brief_candidate_now_fires():
    from app.services.daily_brief import Precompute, generate_candidates

    # 20 neutral fields so no unrelated candidate interferes — same shape as
    # tests/test_daily_brief_moms_member.py.
    neutral = dict(
        business_name="Test", currency="DKK", today="2026-09-01",
        yesterday="2026-08-31", weekday="Tuesday", today_revenue=0.0,
        yesterday_revenue=0.0, pct_change_yesterday=0.0, week_avg_revenue=0.0,
        pct_change_week_avg=0.0, month_revenue=0.0, month_expenses=0.0,
        month_profit_margin_pct=0.0, monthly_goal=0.0,
        monthly_goal_progress_pct=0.0, days_left_in_month=29,
        top_seller_today=None, low_stock_items=[], khata_outstanding=0.0,
        khata_with_balance=0,
    )
    p = Precompute(**neutral, moms_days_left=0, moms_estimated_owed=88777.0,
                   moms_deadline_date=FRIST_HALF.isoformat(),
                   moms_period_label="H1 2026")
    cands = [c for c in generate_candidates(p) if c.cta_url == "/tax"]
    assert len(cands) == 1
    text = cands[0].text
    assert "due today" in text
    assert "H1 2026" in text
    assert cands[0].weight == 0.97      # headline on that one morning, by design


# ── the copy branches that only became reachable with this fix ────────────
# A neutral year-to-date block: _generate_tax_alerts also emits a YTD summary
# alert, and a zero payable keeps it out of the way of these assertions.
_YTD = {"vat_payable": 0.0, "output_vat": 0.0, "input_vat": 0.0,
        "sales_total": 0.0, "expenses_total": 0.0}

def test_the_urgent_alert_does_not_say_zero_days():
    """It is an f-string over the number, so the day the frist arrived it read
    "MOMS due in 0 days!" — directly beneath a hero saying "Frist I DAG!". The
    page contradicted its own tone on the one day the fix exists to serve."""
    from app.services.tax_service import _generate_tax_alerts

    cfg = {"tax_name": "MOMS", "authority": "SKAT"}
    row = {"days_until": 0, "estimated_amount": 88777.0, "status": "urgent",
           "deadline": FRIST_HALF, "period_label": "H1 2026"}
    a = _generate_tax_alerts([row], cfg, "DKK", _YTD)[0]
    assert "0 days" not in a["title"]
    assert "TODAY" in a["title"]
    assert "midnight" in a["action"]
    # The status string must NOT change — the hero's red treatment is gated on
    # it being exactly "overdue" or "urgent", so a new value would drop the most
    # urgent day of the period onto the calm surface.
    assert a["type"] == "urgent"
    assert a["severity"] == "critical"


def test_the_urgent_alert_still_pluralises_correctly():
    from app.services.tax_service import _generate_tax_alerts

    cfg = {"tax_name": "MOMS", "authority": "SKAT"}

    def _title(days):
        row = {"days_until": days, "estimated_amount": 1.0, "status": "urgent",
               "deadline": FRIST_HALF, "period_label": "H1 2026"}
        return _generate_tax_alerts([row], cfg, "DKK", _YTD)[0]["title"]

    assert "in 1 day!" in _title(1)      # was "in 1 days!"
    assert "in 3 days!" in _title(3)


def test_no_weekly_savings_rate_on_the_day_the_bill_is_due():
    """weeks_to_deadline was max(1, …), safe only while a same-day deadline was
    impossible. Once the frist day reached project(), it claimed one week of
    runway that does not exist and solve_weekly_rate divided the WHOLE shortfall
    by that phantom week — "set aside 78.000 kr./week" on the morning the 78.000
    is due."""
    inp = ForesightInputs(
        as_of=FRIST_HALF, deadline=FRIST_HALF,
        current_balance=Decimal("10000"), safety_buffer=Decimal("0"),
    )
    rng = fs.build_moms_range(realized_moms=Decimal("70000"),
                              projected_remaining_moms=Decimal("0"))
    cone = fs.build_cone(inp, rng)

    assert cone.mid.weeks_to_deadline == 0, "no week remains on the frist itself"
    assert cone.weekly_plan is None, "a weekly rate on the due date is a fiction"
    assert cone.weekly_plan_safe is None
    assert cone.headline_plan is None
    # The verdict itself must still be real — the shortfall is the honest number.
    assert cone.headline_state != STATE_INSUFFICIENT_DATA
    assert cone.mid.shortfall is not None and cone.mid.shortfall > 0


def test_weekly_plan_unchanged_when_time_remains():
    """Non-regression: the ordinary case keeps its weekly rate."""
    inp = ForesightInputs(
        as_of=date(2026, 6, 14), deadline=FRIST_HALF,
        current_balance=Decimal("10000"), safety_buffer=Decimal("0"),
    )
    rng = fs.build_moms_range(realized_moms=Decimal("70000"),
                              projected_remaining_moms=Decimal("0"))
    cone = fs.build_cone(inp, rng)
    assert cone.mid.weeks_to_deadline == 12
    assert cone.weekly_plan is not None
    assert cone.weekly_plan.weekly_rate > 0


# ── the effect that matters more than the countdown ───────────────────────
def test_the_filing_period_is_the_one_actually_due_on_the_frist():
    """The strongest argument for this change. get_tax_overview serialises
    period_start/period_end into every row, TaxAutopilotPage passes row 0 into
    FilingPdfCard, and those dates go to /tax/filing-pdf AND to
    send-to-accountant. Before the fix, on 1 Sep a DK half-yearly filer's row 0
    was March's deadline — so the Pro filing artifact was pre-filled with
    H2 2026 (Jul 1–Dec 31), a period only two months elapsed, and the revisor
    was emailed that same wrong period."""
    row = ts._get_next_deadlines("DKK", frequency="half_yearly", count=1,
                                 as_of=FRIST_HALF)[0]
    assert row["period_start"] == date(2026, 1, 1)
    assert row["period_end"] == date(2026, 6, 30)
    assert row["period_label"] == "H1 2026"
    # The period must be CLOSED — never a half-year still in progress.
    assert row["period_end"] < FRIST_HALF


def test_overdue_is_still_unreachable():
    """A GUARD, not a wish.

    BonBox cannot tell whether an owner filed — there is no filings table, no
    filed flag, no SKAT integration, and most DK small businesses file through
    their revisor. Until a "mark as filed" signal exists, an overdue alert would
    accuse owners who filed on time, every morning, undismissably.

    If this test fails, someone made past deadlines reachable. Do not "fix" the
    test — check that a filed signal shipped first.
    """
    for freq in ("half_yearly", "quarterly", "monthly"):
        for offset in (1, 5, 30, 200):
            as_of = date.fromordinal(FRIST_HALF.toordinal() + offset)
            rows = ts._get_next_deadlines("DKK", frequency=freq, count=4,
                                          as_of=as_of)
            for r in rows:
                assert (r["deadline"] - as_of).days >= 0, (
                    f"{freq}: a past deadline became reachable ({r['deadline']} "
                    f"vs {as_of}) — the overdue brief candidate would now fire "
                    "at owners who have already filed"
                )
