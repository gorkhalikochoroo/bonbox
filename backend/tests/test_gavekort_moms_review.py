"""Gavekort vs MOMS — the 12 Oct 2026 strict review of 6fe622b8, one test per item.

Every test here failed on c01af31c and passes after the fix.

  B1  revisor documents: revenue ex MOMS takes out the MOMS INSIDE revenue,
      gavekort lines apart, subtotals never negative, totals tie to
      compute_filing_data (kasserapport, overview, monthly PDF, vat-export).
  a   the close's SPV take-out is capped by what revenue can hold + warns.
  b   a bundled / fee-netted bank line that may be an online order → asked.
  c   a PENDING order's bank payment is not held back (no card) → asked.
  d   "sold in revenue" only on evidence (not sold after the close, not paid
      another way), worded as a question.
  e   Z-bon-only closes and Sale-only days ASK when a card sale can't be checked.
  g   multi-branch: no false "doesn't add up" on a branch that sold nothing;
      the prefill says the facts are account-wide.
  h   void "issued in error" (same open period only) + free/sponsor cards.
  j   the online buyer cannot choose the voucher class — the owner does.
  k   the revisor ZIP carries a gavekort ledger CSV that ties to the angivelse.
  (f lives in the frontend: DailyClosePage.gavekortNote.test.jsx)

  cd backend && DATABASE_URL=sqlite:///<scratch> python3 -m pytest tests/test_gavekort_moms_review.py -q
"""
from __future__ import annotations

import csv
import io
import uuid
import zipfile
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.branch import Branch
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose, encode_breakdown
from app.models.gift_card import GiftCard, GiftCardTransaction
from app.models.gift_card_order import GiftCardOrder
from app.models.sale import Sale
from app.models.user import User
from app.services import gavekort_moms as gkm
from app.services.auth import get_current_user
from app.services.tax_filing_pdf import compute_filing_data
from app.services.tax_service import _calc_vat, _generate_tax_alerts

_db_ready.set()


# ─── fixtures ────────────────────────────────────────────────────────
@pytest.fixture
def maker():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng)


@pytest.fixture
def db(maker):
    s = maker()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(maker):
    def _get():
        s = maker()
        try:
            yield s
        finally:
            s.close()
    app.dependency_overrides[get_db] = _get
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db, plan="pro") -> User:
    u = User(email=f"o-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
             business_name="Restaurant Nord", business_type="restaurant",
             currency="DKK", plan=plan)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user


def _utc(on: date, hour: int, minute: int = 0) -> datetime:
    local = datetime.combine(on, time(hour, minute), tzinfo=ZoneInfo("Europe/Copenhagen"))
    return local.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)


_N = [0]


def _card(db, user, kr, vclass, issued_on: date, *, hour=12, minute=0, pm=None):
    _N[0] += 1
    c = GiftCard(user_id=user.id, code_hash=f"{'c' * 58}{_N[0]:06d}",
                 short_code=f"GK-R{_N[0]:04d}-X", code_last4=f"{_N[0]:04d}"[-4:],
                 face_value_minor=int(kr * 100), balance_minor=int(kr * 100),
                 voucher_class=vclass, status="active",
                 issued_at=_utc(issued_on, hour, minute), payment_method=pm)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _redeem(db, user, card, kr, on: date):
    db.add(GiftCardTransaction(gift_card_id=card.id, user_id=user.id, kind="redeem",
                               amount_minor=-int(kr * 100), balance_after_minor=0,
                               business_day=datetime.combine(on, time.min)))
    db.commit()


def _close(db, user, on, revenue, payments, *, saved_hour=23, branch_id=None,
           payment_total=None):
    saved = _utc(on, saved_hour)
    db.add(DailyClose(user_id=user.id, date=on, revenue_total=Decimal(str(revenue)),
                      status="confirmed", created_at=saved, updated_at=saved,
                      branch_id=branch_id,
                      payment_total=Decimal(str(payment_total if payment_total is not None
                                                else sum((payments or {}).values()))),
                      payment_categories=encode_breakdown(payments) if payments else None))
    db.commit()


def _vat(db, user, start, end_incl):
    return _calc_vat(db, user.id, start, end_incl + timedelta(days=1),
                     vat_rate=0.25, prices_include_moms=True)


def _statuses(v):
    return [w["status"] for w in v["gavekort_warnings"]]


Q4 = (date(2026, 10, 1), date(2026, 12, 31))
Q1 = (date(2027, 1, 1), date(2027, 3, 31))


# ═════════════════════════════════════════════════════════════════════
# BLOCKER 1 — revisor documents
# ═════════════════════════════════════════════════════════════════════
def test_kasserapport_card_only_day_is_not_negative_and_ties_to_the_filing(db, client):
    """A day with only a 1.000 kr SPV card sale printed MOMS 200 and
    subtotal −200. The card is not revenue: the till lines read 0, the
    gavekort line carries the 200, and the lines add up to the filing."""
    u = _owner(db)
    d = date(2026, 11, 3)
    _card(db, u, 1000, "spv", d, pm="card")
    _as(u)
    r = client.get("/api/reports/daily-kasserapport", params={"report_date": d.isoformat()})
    assert r.status_code == 200, r.text
    k = r.json()
    assert k["total"] == 0.0
    assert k["vat_amount"] == 0.0 and k["subtotal"] == 0.0
    assert k["gavekort"]["sold"] == 1000.0 and k["gavekort"]["sold_vat"] == 200.0
    rec = k["moms_reconciliation"]
    assert rec["moms_af_salg"] == compute_filing_data(db, u, d, d)["moms_af_salg"] == 200.0
    assert round(rec["kassesalg"] + rec["fakturaer"] + rec["gavekort_solgt"]
                 + rec["gavekort_brugt"], 2) == rec["moms_af_salg"]


def test_kasserapport_spv_meal_day_strips_the_moms_inside_revenue(db, client):
    """A 5.000 kr close holding a 1.000 kr SPV meal (MOMS paid when the card
    was sold last period): revenue ex MOMS is 4.000 — not 4.200 — and the
    meal's 200 is its own gavekort line."""
    u = _owner(db)
    c = _card(db, u, 1000, "spv", date(2026, 11, 28))
    d = date(2027, 1, 5)
    _redeem(db, u, c, 1000, d)
    _close(db, u, d, 5000, {"card": 4000, "gift_card": 1000})
    _as(u)
    k = client.get("/api/reports/daily-kasserapport", params={"report_date": d.isoformat()}).json()
    assert k["vat_amount"] == 1000.0 and k["subtotal"] == 4000.0
    assert k["gavekort"]["redeemed"] == 1000.0 and k["gavekort"]["redeemed_vat"] == 200.0
    assert k["moms_reconciliation"]["moms_af_salg"] == 800.0
    assert round(sum(v for key, v in k["moms_reconciliation"].items() if key != "moms_af_salg"), 2) == 800.0


def test_filing_data_splits_revenue_moms_from_gavekort_moms(db):
    u = _owner(db)
    _card(db, u, 1000, "spv", date(2026, 11, 3))
    _close(db, u, date(2026, 11, 4), 2500, {"card": 2500})
    f = compute_filing_data(db, u, *Q4)
    assert f["moms_af_omsaetning"] == 500.0
    assert f["gavekort_moms_netto"] == 200.0
    assert f["moms_af_salg"] == f["moms_af_omsaetning"] + f["gavekort_moms_netto"] == 700.0
    assert f["salg_omsaetning_med_moms"] == 2500.0 and f["salg_med_moms"] == 3500.0


def test_overview_month_with_only_a_card_sale_is_not_a_loss(db, client):
    u = _owner(db)
    _card(db, u, 1000, "spv", date(2026, 11, 3))
    _as(u)
    o = client.get("/api/reports/overview", params={"month": 11, "year": 2026}).json()
    assert o["revenue_ex_moms"] == 0.0          # was −200
    assert o["net_profit"] == 0.0               # was −200
    assert o["vat_payable"] == 200.0            # the liability is still owed


def test_monthly_pdf_shows_the_gavekort_line_apart(db, client):
    from tests.test_pdf_markup_escape import _text
    u = _owner(db)
    _card(db, u, 1000, "spv", date(2026, 11, 3))
    _close(db, u, date(2026, 11, 4), 2500, {"card": 2500})
    _as(u)
    r = client.get("/api/reports/monthly/pdf", params={"month": 11, "year": 2026})
    assert r.status_code == 200, r.text
    txt = _text(r.content)
    assert "Gavekort solgt \\(enkeltform" in txt
    assert "Salg \\(oms" in txt
    # Revenue ex MOMS: 2.500 − 500 = 2.000 (not 2.500 − 700 = 1.800).
    assert "2.000 kr." in txt and "1.800 kr." not in txt


# ═════════════════════════════════════════════════════════════════════
# (a) SPV take-out capped by revenue evidence — and said
# ═════════════════════════════════════════════════════════════════════
def test_spv_takeout_is_capped_by_what_revenue_can_hold(db):
    """Revenue 4.000, card payments 4.000 + gavekort 1.000: the gavekort meal
    is NOT inside revenue, so nothing is taken out (MOMS 800, not 600), and
    BonBox asks."""
    u = _owner(db)
    c = _card(db, u, 1000, "spv", date(2026, 11, 28))
    _redeem(db, u, c, 1000, date(2027, 1, 5))
    _close(db, u, date(2027, 1, 5), 4000, {"card": 4000, "gift_card": 1000})
    v = _vat(db, u, *Q1)
    assert v["gavekort_spv_redeemed_in_revenue"] == 0.0
    assert v["output_vat"] == 800.0
    w = [x for x in v["gavekort_warnings"] if x["status"] == "spv_check_double"]
    assert w and w[0]["uncertain"] is True and w[0]["taken_out"] == 0.0


def test_spv_takeout_on_a_close_that_does_not_add_up_is_asked(db):
    """Revenue 5.000 can hold the 1.000 kr SPV meal (card paid 3.500), so it
    is taken out — but the payments (4.500) don't add up, so BonBox says it
    took it out and asks to check, instead of doing it silently."""
    u = _owner(db)
    c = _card(db, u, 1000, "spv", date(2026, 11, 28))
    _redeem(db, u, c, 1000, date(2027, 1, 5))
    _close(db, u, date(2027, 1, 5), 5000, {"card": 3500, "gift_card": 1000})
    v = _vat(db, u, *Q1)
    assert v["gavekort_spv_redeemed_in_revenue"] == 1000.0 and v["output_vat"] == 800.0
    assert "spv_taken_out_uncertain" in _statuses(v)


# ═════════════════════════════════════════════════════════════════════
# (b) + (c) bank lines
# ═════════════════════════════════════════════════════════════════════
def _order(db, u, kr, status="issued", name="Mette", on=datetime(2026, 10, 6, 10, 0)):
    o = GiftCardOrder(user_id=u.id, amount_minor=int(kr * 100), buyer_email="m@x.dk",
                      buyer_name=name, voucher_class="spv", status=status, created_at=on)
    db.add(o)
    db.commit()
    return o


def _bank(desc, amount, d="2026-10-08", ref="h1", **kw):
    return {"bank": "danske_bank", "transactions": [
        {"date": d, "description": desc, "amount": amount, "type": "income",
         "ref_hash": ref, **kw}]}


def test_bundled_fee_netted_payout_is_asked_on_the_moms_page(db, client):
    u = _owner(db)
    _order(db, u, 300, name="Anna")
    _order(db, u, 200, name="Bo")
    _as(u)
    out = client.post("/api/bank-import/confirm", json=_bank("MobilePay Box udbetaling", 495.0)).json()
    assert out["imported"] == 1                     # booked as a sale (not exact)
    v = _vat(db, u, *Q4)
    w = [x for x in v["gavekort_warnings"] if x["status"] == "bank_maybe_gavekort"]
    assert len(w) == 1 and w[0]["amount"] == 495.0 and len(w[0]["orders"]) == 2
    types = [a["type"] for a in _generate_tax_alerts(
        [], {"tax_name": "MOMS"}, "DKK",
        {"vat_payable": 0.0, "output_vat": 0.0, "input_vat": 0.0, "sales_total": 0.0},
        {"current_month": v})]
    assert "gavekort_bank_check" in types


def test_owner_says_not_the_gavekort_and_the_moms_page_stops_asking(db, client):
    u = _owner(db)
    _order(db, u, 500)
    _as(u)
    client.post("/api/bank-import/confirm",
                json=_bank("Gavekort Mette", 500.0, not_gavekort=True))
    assert "bank_maybe_gavekort" not in _statuses(_vat(db, u, *Q4))


def test_pending_order_payment_is_not_held_back_and_is_asked(db, client):
    """A bank payment for an order that is NOT issued yet was held back with
    no card (money with no MOMS). Now: booked, and the MOMS page asks."""
    u = _owner(db)
    _order(db, u, 500, status="pending")
    _as(u)
    out = client.post("/api/bank-import/confirm", json=_bank("Gavekort Mette", 500.0)).json()
    assert out["gavekort_matched"] == 0 and out["imported"] == 1
    w = [x for x in _vat(db, u, *Q4)["gavekort_warnings"] if x["status"] == "bank_maybe_gavekort"]
    assert w and w[0]["order_status"] == "pending"


# ═════════════════════════════════════════════════════════════════════
# (d) "sold in revenue" only on evidence, and it asks
# ═════════════════════════════════════════════════════════════════════
def test_card_sold_after_the_close_is_not_flagged(db):
    u = _owner(db)
    d = date(2026, 11, 10)
    _close(db, u, d, 7500, {"card": 6000, "cash": 1500}, saved_hour=21)
    _card(db, u, 500, "mpv", d, hour=22, minute=30, pm="card")     # after the close
    assert "sold_in_revenue" not in _statuses(_vat(db, u, *Q4))


def test_card_paid_on_a_tender_the_close_does_not_carry_is_not_flagged(db):
    u = _owner(db)
    d = date(2026, 11, 10)
    _card(db, u, 500, "mpv", d, pm="mobilepay")
    _close(db, u, d, 7500, {"card": 6000, "cash": 1500})          # no MobilePay line
    assert "sold_in_revenue" not in _statuses(_vat(db, u, *Q4))


def test_card_that_could_be_in_the_close_is_asked_not_accused(db):
    u = _owner(db)
    d = date(2026, 11, 10)
    _card(db, u, 500, "mpv", d, pm="card")
    _close(db, u, d, 7500, {"card": 6000, "cash": 1500})
    v = _vat(db, u, *Q4)
    assert "sold_in_revenue" in _statuses(v)
    alert = [a for a in _generate_tax_alerts(
        [], {"tax_name": "MOMS"}, "DKK",
        {"vat_payable": 0.0, "output_vat": 0.0, "input_vat": 0.0, "sales_total": 0.0},
        {"current_month": v}) if a["type"] == "gavekort_double_check"][0]
    assert "?" in alert["title"] and "Is it?" in alert["detail"]


# ═════════════════════════════════════════════════════════════════════
# (e) can't check → ask
# ═════════════════════════════════════════════════════════════════════
def test_zbon_only_close_with_a_card_sale_asks(db):
    u = _owner(db)
    d = date(2026, 11, 12)
    _card(db, u, 500, "spv", d, pm="card")
    _close(db, u, d, 7500, None, payment_total=0)                  # Z-bon only
    w = [x for x in _vat(db, u, *Q4)["gavekort_warnings"] if x["status"] == "sold_unchecked"]
    assert w and w[0]["reason"] == "no_payments"


def test_sale_only_day_with_a_card_sale_asks_or_flags(db):
    u = _owner(db)
    a, b, c = date(2026, 11, 13), date(2026, 11, 14), date(2026, 11, 15)
    for d in (a, b, c):
        _card(db, u, 500, "spv", d, pm="card")
    db.add(Sale(user_id=u.id, date=a, amount=Decimal("500"), payment_method="card",
                item_name="Gavekort"))
    db.add(Sale(user_id=u.id, date=b, amount=Decimal("820"), payment_method="card",
                item_name="Middag"))
    db.commit()                                                    # c: no Sales
    v = _vat(db, u, *Q4)
    by_day = {(w["date"], w["status"]) for w in v["gavekort_warnings"]}
    assert (a.isoformat(), "sold_in_revenue") in by_day
    assert (b.isoformat(), "sold_unchecked") in by_day
    assert not any(dd == c.isoformat() for dd, _ in by_day)


# ═════════════════════════════════════════════════════════════════════
# (g) multi-branch
# ═════════════════════════════════════════════════════════════════════
def test_branch_that_sold_nothing_is_not_called_unreconciled(db):
    from app.services.diagnostics_service import _detect_close_unreconciled
    u = _owner(db)
    b1 = Branch(user_id=u.id, name="Nord")
    b2 = Branch(user_id=u.id, name="Syd")
    db.add_all([b1, b2])
    db.commit()
    d = date(2026, 11, 10)
    _card(db, u, 3000, "spv", d, pm="card")
    _close(db, u, d, 10000, {"card": 13000}, branch_id=b1.id)     # sold the card
    _close(db, u, d, 8000, {"card": 8000}, branch_id=b2.id)       # sold nothing
    assert _detect_close_unreconciled(db, u, datetime(2026, 11, 12)) is None


def test_prefill_on_a_multi_branch_account_says_account_wide(db, client):
    u = _owner(db)
    b1 = Branch(user_id=u.id, name="Nord")
    b2 = Branch(user_id=u.id, name="Syd")
    db.add_all([b1, b2])
    db.commit()
    _as(u)
    d = gkm.business_day_stamp(db, u).date()
    r = client.get("/api/daily-close/prefill", params={"date": d.isoformat(), "branch_id": str(b2.id)})
    assert r.status_code == 200, r.text
    assert r.json()["gavekort"]["scope"] == "account"
    one = client.get("/api/daily-close/prefill", params={"date": d.isoformat()}).json()
    assert one["gavekort"]["scope"] == "close"


# ═════════════════════════════════════════════════════════════════════
# (h) issued in error / free card
# ═════════════════════════════════════════════════════════════════════
def test_void_issued_in_error_takes_the_spv_moms_out_in_the_open_period(db, client):
    u = _owner(db)
    _as(u)
    card = client.post("/api/gavekort/issue", json={"amount_minor": 50000, "payment_method": "card"}).json()
    today = gkm.business_day_stamp(db, u).date()
    p_start, p_end = gkm.moms_period_of(u, today)
    assert _vat(db, u, p_start, p_end)["gavekort_spv_output_vat"] == 100.0
    r = client.post(f"/api/gavekort/{card['id']}/void", json={"reason": "issued_in_error"})
    assert r.status_code == 200, r.text
    v = _vat(db, u, p_start, p_end)
    assert v["gavekort_spv_sold"] == 0.0 and v["gavekort_spv_output_vat"] == 0.0
    assert "spv_voided" not in _statuses(v)
    tx = db.query(GiftCardTransaction).filter(GiftCardTransaction.kind == "void").one()
    assert tx.sale_ref == gkm.VOID_ERROR_REF


def test_void_issued_in_error_is_refused_for_a_used_card_or_an_ended_period(db, client):
    u = _owner(db)
    _as(u)
    used = client.post("/api/gavekort/issue", json={"amount_minor": 50000}).json()
    client.post(f"/api/gavekort/{used['id']}/redeem",
                json={"amount_minor": 10000, "idempotency_key": "u1"})
    r1 = client.post(f"/api/gavekort/{used['id']}/void", json={"reason": "issued_in_error"})
    assert r1.status_code == 409 and r1.json()["detail"]["error"] == "void_error_used"
    old = _card(db, u, 400, "spv", date(2026, 5, 15))     # Q2 / H1 — ended
    r2 = client.post(f"/api/gavekort/{old.id}/void", json={"reason": "issued_in_error"})
    assert r2.status_code == 409 and r2.json()["detail"]["error"] == "void_error_period_closed"
    # An ordinary void still works and keeps the MOMS.
    assert client.post(f"/api/gavekort/{old.id}/void").status_code == 200


def test_free_card_has_no_moms_at_issue_and_is_surfaced(db, client):
    u = _owner(db)
    _as(u)
    r = client.post("/api/gavekort/issue", json={"amount_minor": 30000, "payment_method": "free"})
    assert r.status_code == 201, r.text
    today = gkm.business_day_stamp(db, u).date()
    p_start, p_end = gkm.moms_period_of(u, today)
    v = _vat(db, u, p_start, p_end)
    assert v["gavekort_spv_sold"] == 0.0 and v["output_vat"] == 0.0
    assert "free_card" in _statuses(v)
    f = gkm.period_facts(db, u.id, today, today + timedelta(days=1))
    assert f["counter_sold"] == {}                  # never "money in the till"


# ═════════════════════════════════════════════════════════════════════
# (j) the buyer can't pick the class
# ═════════════════════════════════════════════════════════════════════
def test_online_buyer_cannot_choose_the_voucher_class(db, client):
    u = _owner(db)
    db.add(BusinessProfile(user_id=u.id))
    db.commit()
    _as(u)
    s = client.put("/api/gavekort/order-settings", json={"enabled": True, "voucher_class": "spv"})
    assert s.status_code == 200 and s.json()["voucher_class"] == "spv"
    slug = s.json()["slug"]
    app.dependency_overrides.pop(get_current_user, None)
    r = client.post(f"/api/public/gavekort/buy/{slug}", json={
        "amount_minor": 30000, "buyer_email": "k@example.com", "voucher_class": "mpv"})
    assert r.status_code == 201, r.text
    o = db.query(GiftCardOrder).filter(GiftCardOrder.user_id == u.id).one()
    assert o.voucher_class == "spv"


# ═════════════════════════════════════════════════════════════════════
# (k) the revisor ZIP
# ═════════════════════════════════════════════════════════════════════
def test_revisor_bundle_has_a_gavekort_ledger_that_ties_to_the_angivelse(db):
    from app.services.bookkeeping_export import export_bundle
    u = _owner(db)
    c = _card(db, u, 1000, "spv", date(2026, 11, 3), pm="card")
    _card(db, u, 400, "mpv", date(2026, 11, 3), pm="cash")
    _redeem(db, u, c, 1000, date(2026, 11, 20))
    _close(db, u, date(2026, 11, 20), 5000, {"card": 4000, "gift_card": 1000})
    z = zipfile.ZipFile(io.BytesIO(export_bundle(u, db, date(2026, 11, 1), date(2026, 11, 30))))
    name = [n for n in z.namelist() if n.startswith("gavekort-")]
    assert name, z.namelist()
    rows = list(csv.reader(io.StringIO(z.read(name[0]).decode("utf-8-sig"))))
    events = [r[2] for r in rows[1:] if r and r[0]]
    assert events.count("Solgt") == 2 and "Brugt" in events
    sums = {r[2]: r for r in rows if r and not r[0] and len(r) > 8}
    total = sums["Moms af salg i alt (som i momsangivelsen)"]
    f = compute_filing_data(db, u, date(2026, 11, 1), date(2026, 11, 30))
    assert float(total[8]) == f["moms_af_salg"]
    assert round(float(sums["Moms af omsætningen"][8]) + float(sums["Gavekort MOMS netto"][8]), 2) \
        == f["moms_af_salg"]
    assert "gavekort-" in z.read("manifest.txt").decode("utf-8")
