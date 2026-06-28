"""Gavekort redemption ↔ MOMS reconciliation (tax_service._calc_vat).

THE INVARIANT under test: a gavekort is a TENDER, never a second sale. The
reconciliation detector must DETECT a redeemed-but-uncaptured meal WITHOUT ever
adding the redemption to revenue/MOMS (that would double-count and over-declare
MOMS to SKAT). So:

  (a) DOUBLE-COUNT SAFE — adding a redemption leaves output_vat + sales_total
      byte-identical; only gavekort_warnings grows.
  (b) DETECT the door-scan-only gap — a redemption on a date with no close and
      no Sale → an 'unmatched_redemption' warning.
  (c) QUIET when covered — a redemption on a date that already has a Sale row
      (the gift_card-tagged meal is plausibly among them) → no warning.
  (d) SPV EXCLUDED — single-purpose vouchers are taxed at ISSUANCE, not
      redemption, so their redemption is never flagged.
  (e) TENDER_SHORT — a confirmed close whose gift_card tender line is materially
      LESS than what was redeemed → flag (the net-of-gavekort case).

Run: cd backend && python3 -m pytest tests/test_gavekort_moms_recon.py -q
"""
from datetime import date, datetime, time, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.daily_close import DailyClose, encode_breakdown
from app.models.gift_card import GiftCard, GiftCardTransaction
from app.models.sale import Sale
from app.models.user import User
from app.services.tax_service import _calc_vat


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def user(db):
    u = User(email="owner@bonbox.test", password_hash="x",
             business_name="Café Hygge", business_type="cafe", currency="DKK")
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


_N = 0


def _card(db, user, voucher_class="mpv"):
    global _N
    _N += 1
    c = GiftCard(
        user_id=user.id,
        code_hash=f"{'a' * 60}{_N:04d}", short_code=f"GK-TST-{_N:04d}-X",
        code_last4=f"{_N:04d}"[-4:],
        face_value_minor=50000, balance_minor=50000,
        voucher_class=voucher_class, status="active",
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _redeem(db, user, card, kr, on_date):
    """Append a redeem ledger row (negative øre) stamped to on_date."""
    db.add(GiftCardTransaction(
        gift_card_id=card.id, user_id=user.id, kind="redeem",
        amount_minor=-int(round(kr * 100)),
        balance_after_minor=0,
        business_day=datetime.combine(on_date, time(12, 0)),
    ))
    db.commit()


def _sale(db, user, kr, on_date, method="card"):
    db.add(Sale(user_id=user.id, date=on_date, amount=Decimal(str(kr)),
                payment_method=method, order_channel="dine_in"))
    db.commit()


def _close(db, user, revenue_kr, on_date, gift_card_tender=None):
    pc = encode_breakdown({"gift_card": gift_card_tender}) if gift_card_tender is not None else None
    db.add(DailyClose(user_id=user.id, date=on_date,
                      revenue_total=Decimal(str(revenue_kr)),
                      status="confirmed", payment_categories=pc))
    db.commit()


def _vat(db, user):
    today = date.today()
    return _calc_vat(db, user.id, today - timedelta(days=30), today + timedelta(days=1),
                     vat_rate=0.25, prices_include_moms=True)


# ── (a) the headline: redemption NEVER moves revenue/MOMS ───────────
def test_redemption_does_not_change_revenue_or_moms(db, user):
    day_a = date.today() - timedelta(days=3)
    day_b = date.today() - timedelta(days=2)
    _sale(db, user, 500.0, day_a)             # an ordinary captured sale

    before = _vat(db, user)

    # A gavekort redeemed on a DIFFERENT day with no sale + no close.
    _redeem(db, user, _card(db, user), 200.0, day_b)
    after = _vat(db, user)

    # Double-count-safe: the money math is byte-identical.
    assert after["output_vat"] == before["output_vat"]
    assert after["sales_total"] == before["sales_total"]
    assert after["taxable_sales"] == before["taxable_sales"]
    # But the gap is now visible to the revisor.
    statuses = [w["status"] for w in after["gavekort_warnings"]]
    assert "unmatched_redemption" in statuses
    assert before["gavekort_warnings"] == []


# ── (c) quiet when the meal is plausibly captured (a Sale exists) ───
def test_redemption_on_a_sale_date_is_not_flagged(db, user):
    day = date.today() - timedelta(days=4)
    _sale(db, user, 300.0, day, method="gift_card")
    _redeem(db, user, _card(db, user), 300.0, day)
    res = _vat(db, user)
    assert res["gavekort_warnings"] == []


# ── (d) SPV redemptions are out of scope (taxed at issuance) ────────
def test_spv_redemption_not_flagged(db, user):
    day = date.today() - timedelta(days=5)
    _redeem(db, user, _card(db, user, voucher_class="spv"), 250.0, day)
    res = _vat(db, user)
    assert res["gavekort_warnings"] == []


# ── (e) tender_short: close revenue is net-of-gavekort ──────────────
def test_close_with_short_gift_card_tender_is_flagged(db, user):
    day = date.today() - timedelta(days=6)
    # A confirmed close exists, but its gift_card tender line (50 kr) is far
    # below what was redeemed (400 kr) → the redeemed meals are likely missing.
    _close(db, user, 1000.0, day, gift_card_tender=50.0)
    _redeem(db, user, _card(db, user), 400.0, day)
    res = _vat(db, user)
    flagged = [w for w in res["gavekort_warnings"] if w["status"] == "tender_short"]
    assert len(flagged) == 1
    assert flagged[0]["redeemed"] == 400.0
    assert flagged[0]["matched_close_tender"] == 50.0
    # And, again, revenue/MOMS are untouched by the detector.
    assert res["sales_total"] == _calc_vat(
        db, user.id, date.today() - timedelta(days=30), date.today() + timedelta(days=1),
        vat_rate=0.25, prices_include_moms=True,
    )["sales_total"]
