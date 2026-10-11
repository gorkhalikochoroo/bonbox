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
