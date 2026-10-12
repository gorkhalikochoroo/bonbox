"""Gavekort vs MOMS — the 12 Oct 2026 findings (5 P0 + 1 P1), one test each.

The Danish rule (Momsloven §§ 4 a–4 c, since 1 Jul 2019):
  • SPV (enkeltformål): MOMS at SALE. Using the card later is not a new sale.
  • MPV (flerformål): MOMS at REDEMPTION, on the meal.

Each test failed on 4a2f7b25 and passes after the fix:
  P0-1  SPV salgsmoms is counted in the period of SALE (screen + filing).
  P0-2  New cards default to SPV (the owner can still pick MPV); existing
        cards keep their class; SPV sold before the guard keep the old
        treatment so no earlier period moves.
  P0-3  The close sees gavekort SOLD at the counter (not revenue) and a card
        sale typed into revenue is flagged (counted twice).
  P0-4  An online order paid into the bank is not booked as a taxable Sale.
  P0-5  A close with no gavekort tender line on a redemption day is flagged.
  P1    One small Sale no longer silences a large redemption.
  + no double count: an SPV meal inside close revenue is taken back out;
    the real redeem endpoint → prefill path (SQLite binding) works; the
    owner's day cutoff is honoured.

  cd backend && DATABASE_URL=sqlite:///<scratch> python3 -m pytest tests/test_gavekort_moms_spv.py -q
"""
from __future__ import annotations

import uuid
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
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose, encode_breakdown
from app.models.gift_card import GiftCard, GiftCardTransaction
from app.models.gift_card_order import GiftCardOrder
from app.models.sale import Sale
from app.models.user import User
from app.services import gavekort_moms as gkm
from app.services.auth import get_current_user
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


_N = [0]


def _utc(on: date, hour: int) -> datetime:
    local = datetime.combine(on, time(hour, 0), tzinfo=ZoneInfo("Europe/Copenhagen"))
    return local.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)


def _card(db, user, kr, vclass, issued_on: date, *, hour=12, status="active",
          payment_method=None):
    """A card sold on `issued_on` at `hour`:00 Copenhagen (stored naive UTC)."""
    _N[0] += 1
    issued_utc = _utc(issued_on, hour)
    c = GiftCard(user_id=user.id, code_hash=f"{'b' * 58}{_N[0]:06d}",
                 short_code=f"GK-T{_N[0]:04d}-X", code_last4=f"{_N[0]:04d}"[-4:],
                 face_value_minor=int(kr * 100), balance_minor=int(kr * 100),
                 voucher_class=vclass, status=status, issued_at=issued_utc,
                 payment_method=payment_method)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _redeem(db, user, card, kr, on: date):
    db.add(GiftCardTransaction(gift_card_id=card.id, user_id=user.id, kind="redeem",
                               amount_minor=-int(kr * 100), balance_after_minor=0,
                               business_day=datetime.combine(on, time.min)))
    db.commit()


def _close(db, user, on, revenue, payments: dict | None, *, saved_hour=23):
    """A confirmed close for `on`, saved at `saved_hour`:00 that evening (a
    real close is saved after the day's sales — the 'sold after the close'
    evidence reads this)."""
    saved = _utc(on, saved_hour)
    db.add(DailyClose(user_id=user.id, date=on, revenue_total=Decimal(str(revenue)),
                      status="confirmed", created_at=saved, updated_at=saved,
                      payment_categories=encode_breakdown(payments) if payments else None))
    db.commit()


def _vat(db, user, start, end_incl):
    return _calc_vat(db, user.id, start, end_incl + timedelta(days=1),
                     vat_rate=0.25, prices_include_moms=True)


Q4 = (date(2026, 10, 1), date(2026, 12, 31))
Q1 = (date(2027, 1, 1), date(2027, 3, 31))


# ═════════════════════════════════════════════════════════════════════
# P0-1 — SPV MOMS in the period of SALE
# ═════════════════════════════════════════════════════════════════════
def test_spv_sold_counts_moms_in_the_period_of_sale(db):
    """C1/C2/C11: 400 kr SPV sold, never used → 80 kr MOMS in Q4 (was 0)."""
    u = _owner(db)
    _card(db, u, 400, "spv", date(2026, 11, 20))
    v = _vat(db, u, *Q4)
    assert v["gavekort_spv_sold"] == 400.0
    assert v["gavekort_spv_output_vat"] == 80.0
    assert v["output_vat"] == 80.0
    assert v["sales_total"] == 400.0 and v["taxable_sales"] == 400.0
    # The filing data (screen + PDF) reads the same number.
    from app.services.tax_filing_pdf import compute_filing_data
    f = compute_filing_data(db, u, *Q4)
    assert f["moms_af_salg"] == 80.0
    assert f["gavekort_spv_sold"] == 400.0


def test_spv_used_next_period_is_not_taxed_twice(db):
    """C3: sold 28 Nov (Q4), meal on 5 Jan inside a close whose gavekort line
    shows it → Q4 carries the 200 kr MOMS, Q1 takes the meal back out."""
    u = _owner(db)
    c = _card(db, u, 1000, "spv", date(2026, 11, 28))
    _redeem(db, u, c, 1000, date(2027, 1, 5))
    _close(db, u, date(2027, 1, 5), 5000, {"card": 4000, "gift_card": 1000})
    q4 = _vat(db, u, *Q4)
    q1 = _vat(db, u, *Q1)
    assert q4["output_vat"] == 200.0
    assert q1["output_vat"] == 800.0          # 5000 gross = 1000 MOMS, minus the 1000 kr meal
    assert q1["gavekort_spv_redeemed_in_revenue"] == 1000.0
    assert q1["gavekort_spv_redeemed_vat"] == 200.0
    assert q1["gavekort_warnings"] == []


def test_spv_meal_in_a_close_without_gavekort_line_is_flagged_not_guessed(db):
    """Revenue that may hold an SPV meal, but no tender says so: BonBox does
    not take anything out (that would be a guess) — it asks."""
    u = _owner(db)
    c = _card(db, u, 600, "spv", date(2026, 11, 2))
    _redeem(db, u, c, 600, date(2026, 11, 9))
    _close(db, u, date(2026, 11, 9), 4000, {"card": 4000})
    v = _vat(db, u, *Q4)
    assert v["gavekort_spv_redeemed_in_revenue"] == 0.0
    assert v["output_vat"] == 120.0 + 800.0    # card sale + close, untouched
    assert [w["status"] for w in v["gavekort_warnings"]] == ["spv_check_double"]


def test_spv_voided_keeps_moms_and_asks(db, client):
    u = _owner(db)
    c = _card(db, u, 300, "spv", date(2026, 10, 5))
    _as(u)
    r = client.post(f"/api/gavekort/{c.id}/void")
    assert r.status_code == 200, r.text
    today = date.today()
    v = _vat(db, u, date(2026, 10, 1), today + timedelta(days=1))
    assert v["gavekort_spv_output_vat"] == 60.0     # MOMS stays in
    voided = [w for w in v["gavekort_warnings"] if w["status"] == "spv_voided"]
    assert voided and voided[0]["amount"] == 300.0 and voided[0]["moms"] == 60.0


# ═════════════════════════════════════════════════════════════════════
# P0-2 — the default + history
# ═════════════════════════════════════════════════════════════════════
def test_new_cards_default_to_spv_and_owner_can_pick_mpv(db, client):
    u = _owner(db)
    _as(u)
    a = client.post("/api/gavekort/issue", json={"amount_minor": 10000})
    b = client.post("/api/gavekort/issue", json={"amount_minor": 10000, "voucher_class": "mpv"})
    assert a.status_code == 201 and b.status_code == 201
    assert a.json()["voucher_class"] == "spv"
    assert b.json()["voucher_class"] == "mpv"


def test_online_order_defaults_to_spv(db):
    u = _owner(db)
    o = GiftCardOrder(user_id=u.id, amount_minor=20000, buyer_email="k@x.dk")
    db.add(o)
    db.commit()
    assert o.voucher_class == "spv"


def test_spv_sold_before_the_guard_keeps_its_old_treatment(db):
    """A September SPV card: Q3 stays exactly as BonBox showed it (no SPV
    sale), and its meal is checked like before (MOMS via the meal)."""
    u = _owner(db)
    c = _card(db, u, 500, "spv", date(2026, 9, 15))
    q3 = _vat(db, u, date(2026, 7, 1), date(2026, 9, 30))
    assert q3["output_vat"] == 0.0 and q3["gavekort_spv_sold"] == 0.0
    _redeem(db, u, c, 500, date(2026, 10, 20))     # door-scan only
    q4 = _vat(db, u, *Q4)
    assert [w["status"] for w in q4["gavekort_warnings"]] == ["unmatched_redemption"]
    assert q4["output_vat"] == 0.0


def test_existing_mpv_cards_keep_their_class(db):
    u = _owner(db)
    c = _card(db, u, 250, "mpv", date(2026, 11, 3))
    v = _vat(db, u, *Q4)
    db.refresh(c)
    assert c.voucher_class == "mpv"
    assert v["gavekort_spv_sold"] == 0.0 and v["output_vat"] == 0.0


# ═════════════════════════════════════════════════════════════════════
# P0-3 — sold at the counter: not revenue, and flagged when typed in
# ═════════════════════════════════════════════════════════════════════
def test_prefill_shows_gavekort_sold_today_by_tender(db, client):
    """C1: two real counter sales → the close can see them (was: no key)."""
    u = _owner(db)
    _as(u)
    client.post("/api/gavekort/issue", json={"amount_minor": 50000, "payment_method": "card"})
    client.post("/api/gavekort/issue", json={"amount_minor": 40000, "payment_method": "cash"})
    bday = gkm.business_day_stamp(db, u).date()
    r = client.get("/api/daily-close/prefill", params={"date": bday.isoformat()})
    assert r.status_code == 200, r.text
    gk = r.json()["gavekort"]
    assert gk["sold"] == 900.0
    assert gk["sold_by_tender"] == {"card": 500.0, "cash": 400.0}


def test_card_sale_typed_into_close_revenue_is_flagged(db):
    """C5: payments tie to revenue although 500 kr of the takings was a card
    sale → 'sold_in_revenue'. Taken out of revenue → quiet."""
    u = _owner(db)
    _card(db, u, 500, "mpv", date(2026, 11, 10))
    _close(db, u, date(2026, 11, 10), 7500, {"card": 6000, "cash": 1500})
    flagged = [w["status"] for w in _vat(db, u, *Q4)["gavekort_warnings"]]
    assert flagged == ["sold_in_revenue"]

    u2 = _owner(db)
    _card(db, u2, 500, "mpv", date(2026, 11, 10))
    _close(db, u2, date(2026, 11, 10), 7000, {"card": 6000, "cash": 1500})
    assert _vat(db, u2, *Q4)["gavekort_warnings"] == []


# ═════════════════════════════════════════════════════════════════════
# P0-4 — online order paid into the bank
# ═════════════════════════════════════════════════════════════════════
def _bank_txn(desc, amount=500.0, d="2026-10-08", ref="h1", **kw):
    return {"date": d, "description": desc, "amount": amount, "type": "income",
            "ref_hash": ref, **kw}


def test_bank_payment_for_an_online_order_is_not_a_sale(db, client):
    """C6: the transfer was booked as a taxable Sale (MOMS twice)."""
    u = _owner(db)
    db.add(GiftCardOrder(user_id=u.id, amount_minor=50000, buyer_email="m@x.dk",
                         buyer_name="Mette", voucher_class="mpv", status="issued",
                         created_at=datetime(2026, 10, 6, 10, 0)))
    db.commit()
    _as(u)
    body = {"bank": "danske_bank", "transactions": [_bank_txn("Overførsel gavekort Mette")]}
    r = client.post("/api/bank-import/confirm", json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["gavekort_matched"] == 1 and out["imported"] == 0
    assert db.query(Sale).filter(Sale.user_id == u.id).count() == 0
    # Re-importing the same file is a no-op, not a second match or a Sale.
    again = client.post("/api/bank-import/confirm", json=body).json()
    assert again["gavekort_matched"] == 0 and again["skipped"] == 1
    assert db.query(Sale).filter(Sale.user_id == u.id).count() == 0


def test_bank_match_is_strict_and_the_owner_can_override(db, client):
    u = _owner(db)
    db.add(GiftCardOrder(user_id=u.id, amount_minor=50000, buyer_email="m@x.dk",
                         buyer_name="Mette", status="issued",
                         created_at=datetime(2026, 10, 6, 10, 0)))
    db.commit()
    _as(u)
    # Same amount but the text names neither a gavekort nor the buyer → a sale.
    r1 = client.post("/api/bank-import/confirm", json={"bank": "danske_bank", "transactions": [
        _bank_txn("MobilePay 12345", ref="h2")]}).json()
    # The text matches, but the owner says it is NOT the gavekort → a sale.
    r2 = client.post("/api/bank-import/confirm", json={"bank": "danske_bank", "transactions": [
        _bank_txn("Gavekort Mette", ref="h3", not_gavekort=True)]}).json()
    assert r1["imported"] == 1 and r1["gavekort_matched"] == 0
    assert r2["imported"] == 1 and r2["gavekort_matched"] == 0
    assert db.query(Sale).filter(Sale.user_id == u.id).count() == 2


# ═════════════════════════════════════════════════════════════════════
# P0-5 — restaurant close with no gavekort line
# ═════════════════════════════════════════════════════════════════════
def test_mpv_redemption_on_a_close_without_gavekort_line_is_flagged(db):
    """C7: 500 kr redeemed, close 9500 with card+cash only → was silent."""
    u = _owner(db)
    c = _card(db, u, 500, "mpv", date(2026, 10, 2))
    _redeem(db, u, c, 500, date(2026, 11, 14))
    _close(db, u, date(2026, 11, 14), 9500, {"card": 7000, "cash": 2500})
    w = _vat(db, u, *Q4)["gavekort_warnings"]
    assert [x["status"] for x in w] == ["unverified_redemption"]
    assert w[0]["redeemed"] == 500.0


def test_close_with_a_gavekort_line_covering_the_redemption_is_quiet(db):
    u = _owner(db)
    c = _card(db, u, 500, "mpv", date(2026, 10, 2))
    _redeem(db, u, c, 500, date(2026, 11, 14))
    _close(db, u, date(2026, 11, 14), 10000, {"card": 7000, "cash": 2500, "gift_card": 500})
    assert _vat(db, u, *Q4)["gavekort_warnings"] == []


# ═════════════════════════════════════════════════════════════════════
# P1 — one small Sale must not silence a large redemption
# ═════════════════════════════════════════════════════════════════════
def test_small_sale_does_not_silence_a_large_redemption(db):
    """C8: 2000 kr redeemed + one 30 kr card Sale → was no warning."""
    u = _owner(db)
    c = _card(db, u, 2000, "mpv", date(2026, 10, 2))
    _redeem(db, u, c, 2000, date(2026, 11, 21))
    db.add(Sale(user_id=u.id, date=date(2026, 11, 21), amount=Decimal("30"),
                payment_method="card"))
    db.commit()
    w = _vat(db, u, *Q4)["gavekort_warnings"]
    assert [x["status"] for x in w] == ["sale_short"]
    assert w[0]["redeemed"] == 2000.0 and w[0]["matched_sales"] == 30.0


# ═════════════════════════════════════════════════════════════════════
# The real redeem endpoint → prefill (SQLite binding) + the owner's cutoff
# ═════════════════════════════════════════════════════════════════════
def test_real_redeem_lands_on_the_right_day_in_prefill(db, client):
    """C4: on SQLite the raw INSERT put every redemption on the PREVIOUS day."""
    u = _owner(db)
    _as(u)
    card = client.post("/api/gavekort/issue",
                       json={"amount_minor": 50000, "voucher_class": "mpv"}).json()
    r = client.post(f"/api/gavekort/{card['id']}/redeem",
                    json={"amount_minor": 20000, "idempotency_key": "k1"})
    assert r.status_code == 200, r.text
    bday = gkm.business_day_stamp(db, u).date()
    on_day = client.get("/api/daily-close/prefill", params={"date": bday.isoformat()}).json()
    day_before = client.get("/api/daily-close/prefill",
                            params={"date": (bday - timedelta(days=1)).isoformat()}).json()
    assert on_day["gavekort"]["redeemed"] == 200.0
    assert on_day["gavekort"]["redeemed_total"] == 200.0
    assert day_before["gavekort"]["redeemed"] == 0.0


def test_ledger_business_day_honours_the_owner_cutoff(db, client, monkeypatch):
    """C9: a redemption at 03:30 on 12 Oct, owner cutoff 00:00, belongs to
    12 Oct — the redeem endpoint stamped 11 Oct (fixed 06:00), so it showed
    on the wrong close and, at a quarter edge, in the wrong MOMS period."""
    import app.services.tz_utils as tzu

    class _Fake(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 10, 12, 3, 30, tzinfo=ZoneInfo("Europe/Copenhagen")).astimezone(tz)

    monkeypatch.setattr(tzu, "datetime", _Fake)
    u = _owner(db)
    db.add(BusinessProfile(user_id=u.id, day_cutoff_hour=0))
    db.commit()
    _as(u)
    card = client.post("/api/gavekort/issue",
                       json={"amount_minor": 50000, "voucher_class": "mpv"}).json()
    r = client.post(f"/api/gavekort/{card['id']}/redeem",
                    json={"amount_minor": 10000, "idempotency_key": "cut0"})
    assert r.status_code == 200, r.text
    rows = {t.kind: t.business_day for t in db.query(GiftCardTransaction)
            .filter(GiftCardTransaction.user_id == u.id).all()}
    assert rows["redeem"] == datetime(2026, 10, 12)
    assert rows["issue"] == datetime(2026, 10, 12)       # a business date, not UTC
    # Without a profile the Danish default (06:00) still applies.
    u2 = _owner(db)
    assert gkm.business_day_stamp(db, u2) == datetime(2026, 10, 11)


# ═════════════════════════════════════════════════════════════════════
# The MOMS page alerts: under-report vs counted-twice vs voided
# ═════════════════════════════════════════════════════════════════════
def test_alerts_split_missing_from_counted_twice():
    recon = {"current_month": {"gavekort_warnings": [
        {"date": "2026-11-14", "redeemed": 500.0, "status": "unverified_redemption"},
        {"date": "2026-11-10", "sold": 500.0, "status": "sold_in_revenue"},
        {"date": "2026-11-11", "amount": 300.0, "moms": 60.0, "status": "spv_voided"},
    ]}}
    ytd = {"vat_payable": 0.0, "output_vat": 0.0, "input_vat": 0.0, "sales_total": 0.0}
    types = [a["type"] for a in _generate_tax_alerts([], {"tax_name": "MOMS"}, "DKK", ytd, recon)]
    assert "gavekort_reconciliation" in types
    assert "gavekort_double_check" in types
    assert "gavekort_spv_voided" in types


def test_filing_pdf_prints_the_spv_line(db):
    from tests.test_pdf_markup_escape import _text
    from app.services.tax_filing_pdf import build_moms_filing_pdf
    u = _owner(db)
    _card(db, u, 400, "spv", date(2026, 11, 20))
    pdf = build_moms_filing_pdf(db, u, *Q4)
    # PDF strings escape "(" as "\(".
    assert "Gavekort solgt \\(enkeltform" in _text(pdf)


def test_close_with_gavekort_sold_is_not_called_unreconciled(db):
    """The close now ties out as payments = revenue + gavekort sold. The
    "Skal ses nu" detector must agree, or every such day raises an urgent
    'doesn't add up' for a close that does."""
    from app.services.diagnostics_service import _detect_close_unreconciled
    u = _owner(db)
    _card(db, u, 3000, "spv", date(2026, 11, 10))
    db.add(DailyClose(user_id=u.id, date=date(2026, 11, 10), revenue_total=Decimal("10000"),
                      payment_total=Decimal("13000"), status="confirmed",
                      payment_categories=encode_breakdown({"card": 13000})))
    db.commit()
    assert _detect_close_unreconciled(db, u, datetime(2026, 11, 12)) is None

    u2 = _owner(db)       # same close, no gavekort sold → still flagged
    db.add(DailyClose(user_id=u2.id, date=date(2026, 11, 10), revenue_total=Decimal("10000"),
                      payment_total=Decimal("13000"), status="confirmed",
                      payment_categories=encode_breakdown({"card": 13000})))
    db.commit()
    assert _detect_close_unreconciled(db, u2, datetime(2026, 11, 12)) is not None
