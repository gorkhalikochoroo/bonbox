"""
checkout_ready() — the money-path gate that keeps a partial Stripe config from
dead-ending an owner at a 500. Locks the two things that matter:
  • PER-TIER: a misconfigured Starter must NOT drag down a working Pro (and v.v.).
  • FOUNDING-AWARE: at launch (slot open) readiness follows the *_FOUNDING IDs,
    which is the exact branch create_checkout_session takes.

Run: cd backend && python3 -m pytest tests/test_checkout_ready.py -q
"""
import app.services.stripe_billing as sb


class _U:
    subscription_status = None


def test_no_stripe_is_all_false(monkeypatch):
    monkeypatch.setattr(sb, "_stripe", lambda: None)
    assert sb.checkout_ready(_U(), None) == {"starter": False, "pro": False, "any": False}


def test_founding_per_tier_starter_unset_does_not_block_pro(monkeypatch):
    monkeypatch.setattr(sb, "_stripe", lambda: object())
    monkeypatch.setattr(sb, "_is_founding_member_slot_open", lambda u, db: True)
    monkeypatch.setattr(sb.settings, "STRIPE_PRICE_ID_PRO_FOUNDING", "price_pro_f")
    monkeypatch.setattr(sb.settings, "STRIPE_PRICE_ID_STARTER_FOUNDING", "")  # the gf-tested-Pro case
    assert sb.checkout_ready(_U(), None) == {"starter": False, "pro": True, "any": True}


def test_founding_uses_founding_ids_not_regular(monkeypatch):
    monkeypatch.setattr(sb, "_stripe", lambda: object())
    monkeypatch.setattr(sb, "_is_founding_member_slot_open", lambda u, db: True)
    # Regular IDs set, founding IDs unset → founding user still can't check out.
    monkeypatch.setattr(sb.settings, "STRIPE_PRICE_ID_PRO", "price_pro")
    monkeypatch.setattr(sb.settings, "STRIPE_PRICE_ID_STARTER", "price_starter")
    monkeypatch.setattr(sb.settings, "STRIPE_PRICE_ID_PRO_FOUNDING", "")
    monkeypatch.setattr(sb.settings, "STRIPE_PRICE_ID_STARTER_FOUNDING", "")
    assert sb.checkout_ready(_U(), None) == {"starter": False, "pro": False, "any": False}


def test_non_founding_uses_regular_ids(monkeypatch):
    monkeypatch.setattr(sb, "_stripe", lambda: object())
    monkeypatch.setattr(sb, "_is_founding_member_slot_open", lambda u, db: False)
    monkeypatch.setattr(sb.settings, "STRIPE_PRICE_ID_PRO", "price_pro")
    monkeypatch.setattr(sb.settings, "STRIPE_PRICE_ID_STARTER", "price_starter")
    assert sb.checkout_ready(_U(), None) == {"starter": True, "pro": True, "any": True}
