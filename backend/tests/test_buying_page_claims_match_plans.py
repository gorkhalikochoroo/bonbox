"""Push 3 (F): the plan facts the buying-page sentences rest on.

frontend/src/__tests__/push3BuyingPage.test.js pins the sentences:
  faqA1/faqA2 "Free locks some features (e.g. invoices and revisor login)",
  faqQ2 "Free has the AI Copilot, just with a cap", faqA4 "Pro covers up to
  3 locations", faqA11 "Starter and Pro feature" (schedule autopilot).
"""
from app.services.billing import PLAN_CAPS, PLAN_FEATURES


def test_free_has_fewer_features_incl_invoices_and_revisor_login():
    assert PLAN_CAPS["free"]["invoices_per_month"] == 0
    assert PLAN_FEATURES["free"]["accountant_login"] is False
    off = [k for k, v in PLAN_FEATURES["free"].items() if v is False]
    assert len(off) > 0


def test_free_has_the_copilot_with_a_cap():
    assert 0 < PLAN_CAPS["free"]["ai_chat_messages_per_day"] < PLAN_CAPS["pro"]["ai_chat_messages_per_day"]


def test_pro_covers_up_to_3_locations():
    assert PLAN_CAPS["pro"]["branches"] == 3


def test_schedule_autopilot_is_starter_and_pro():
    assert PLAN_FEATURES["free"]["schedule_autopilot"] is False
    assert PLAN_FEATURES["starter"]["schedule_autopilot"] is True
    assert PLAN_FEATURES["pro"]["schedule_autopilot"] is True


# ── Round 2 (Manoj, 11 Oct): the facts behind B5, faqA10 and faqA12 ──

def test_autopilot_suggests_breaks_and_warns_but_never_blocks_the_owner():
    """faqA11 / featProScheduleAutopilot: "BonBox foreslår pauser og advarer om
    11 timers hvile og 48-timersgrænsen — men det er dig, der bestemmer." No
    claim that it complies with labour law: the break is a suggestion, and a
    warning never stops Apply."""
    import inspect
    from app.services import schedule_autopilot as ap
    assert ap.DK_MIN_DAILY_REST_HOURS == 11.0
    assert ap.DK_MAX_HOURS_PER_WEEK == 48.0
    assert ap.suggested_break_minutes(7) > 0 and ap.suggested_break_minutes(3) == 0
    assert "SUGGESTION only" in inspect.getsource(ap.suggested_break_minutes)
    assert "Violations DON'T block apply" in ap.__doc__
    assert '"code": "over_weekly_cap"' in inspect.getsource(ap)
    # The schedule itself warns on the 11-hour rest and the 48-hour week.
    from pathlib import Path
    staff = (Path(ap.__file__).resolve().parents[1] / "routers" / "staff.py").read_text()
    assert "_daily_rest_shortfalls" in staff and '"over_dk48"' in staff


def test_revisor_login_is_starter_and_pro_and_the_faq_names_what_is_logged():
    """faqA10: invite/remove, the revisor's own sign-up, and switching to the
    business are logged — not "everything they do"."""
    from pathlib import Path
    assert PLAN_FEATURES["free"]["accountant_login"] is False
    assert PLAN_FEATURES["starter"]["accountant_login"] is True
    assert PLAN_FEATURES["pro"]["accountant_login"] is True
    src = (Path(__file__).resolve().parents[1] / "app" / "routers" / "accountants.py").read_text()
    import re
    actions = sorted(set(re.findall(r'action="(accountant\.[a-z_]+)"', src)))
    assert actions == ["accountant.invited", "accountant.revoked", "accountant.signup", "accountant.switch_client"]


def test_a_high_confidence_bank_match_is_marked_paid_with_an_undo():
    """faqA12: "Et sikkert match markerer BonBox selv som betalt, og du kan
    fortryde det i 7 dage" — not "you confirm with one tap"."""
    import inspect
    from app.services import payment_match_service as pm
    src = inspect.getsource(pm)
    assert "invoice.auto_match_reversible = True" in src
    assert "7-day undo" in src
