"""
Daily-brief "you didn't close yesterday" candidate. The morning-brief delivery
of the close nudge (the founder rejected an evening/in-service push). Guarantees:
  • fires only when the shared detector set close_missing_yesterday (one gate),
  • calm (type "watch", never an alarm), one-tap to /daily-close,
  • names the concrete downstream stakes (MOMS + accountant) honestly,
  • absent when there's no missing close.

Run: cd backend && python3 -m pytest tests/test_daily_brief_close_missing.py -q
"""
from app.services.daily_brief import Precompute, generate_candidates

# All 20 required Precompute fields at neutral values so no unrelated candidate
# noise interferes — we only assert on the close-missing one.
_REQUIRED = dict(
    business_name="Test", currency="DKK", today="2026-07-06", yesterday="2026-07-05",
    weekday="Monday", today_revenue=0.0, yesterday_revenue=0.0, pct_change_yesterday=0.0,
    week_avg_revenue=0.0, pct_change_week_avg=0.0, month_revenue=0.0, month_expenses=0.0,
    month_profit_margin_pct=0.0, monthly_goal=0.0, monthly_goal_progress_pct=0.0,
    days_left_in_month=10, top_seller_today=None, low_stock_items=[],
    khata_outstanding=0.0, khata_with_balance=0,
)


def _pc(**over):
    return Precompute(**{**_REQUIRED, **over})


def _close_cands(cands):
    return [c for c in cands if c.cta_label == "Close the day"]


def test_fires_when_flag_set():
    c = _close_cands(generate_candidates(_pc(close_missing_yesterday=True, close_missing_date="2026-07-05")))
    assert len(c) == 1
    c = c[0]
    assert c.type == "watch"                     # amber "attention", never red/risk
    assert abs(c.weight - 0.80) < 1e-9
    assert c.cta_url == "/daily-close"
    # NO date number in the text — "yesterday" is unambiguous in a morning digest,
    # and a raw ISO date could be LLM-reformatted past the approved-numbers guard
    # and reject the whole brief. facts stays empty for the same reason.
    assert "yesterday" in c.text.lower()
    assert c.facts == []
    assert not any(ch.isdigit() for ch in c.text.split("30-second")[0])  # no stray number before the CTA phrase
    assert "MOMS" in c.text and "accountant" in c.text  # names the honest stakes


def test_absent_when_flag_false():
    assert _close_cands(generate_candidates(_pc(close_missing_yesterday=False))) == []


def test_absent_when_date_missing():
    # Defensive: flag true but no date → no candidate (never a blank nudge).
    assert _close_cands(generate_candidates(_pc(close_missing_yesterday=True, close_missing_date=None))) == []
