"""Revisorpakke — the 14 Oct independent re-review, one test per finding.
Each failed on 5f93dd7d.

MAJOR  a foreign-currency receipt was deducted as Danish købsmoms, and
       udgifter.csv labelled it "25 %"
minor  a close whose own moms leaves part of it momsfri: salg.csv split it,
       box A ("Salg med moms") did not
minor  salg.csv's close references ("K-2026-10-09-2") were in no other file
       and swapped between builds
minor  the M7 fingerprint missed category rows and days
minor  momsangivelse D2: the source rows did not add up to their own Sum
minor  labels: "Køb med købsmoms" over løn; the PDF's file list left out
       fakturaer.csv / koersel.csv; "27 låste dage" over 27 closes on 26 days;
       "Salgsmoms kan ikke opgøres" in the CSV beside moms the PDF includes
minor  a Send tap could land between the schedule's check and its claim
"""
from __future__ import annotations

import io
import json
import uuid
from datetime import date

from fastapi.testclient import TestClient

from app.models.branch import Branch
from app.models.customer import Customer
from app.models.daily_close import DailyClose
from app.models.expense import Expense
from app.models.invoice import Invoice
from app.models.mileage import MileageEntry
from app.models.revisor_package import RevisorPackageSend
from app.models.sale import Sale
from app.models.user import User
from app.services.tax_filing_pdf import build_moms_filing_pdf, compute_filing_data
from tests.test_revisor_package_review2 import (  # noqa: F401 — fixtures
    NOW, OCT, SEP, _as, _cat, _manual_send_on, _month, _owner, _pdf_text, _rows, _zip,
    client, db, factory, job, mailbox, rp, store, utc,
)


def _csv_total(rows, col=3):
    return round(sum(float(r[col].replace(".", "").replace(",", ".")) for r in rows), 2)


# ── MAJOR: foreign VAT is not købsmoms ──────────────────────────────────

def test_a_foreign_currency_receipt_carries_no_danish_kobsmoms(db, store):
    u = _owner(db)
    vare = _cat(db, u, "Varekøb")
    db.add_all([
        # 100 EUR at 7,46: foreign VAT, never købsmoms.
        Expense(user_id=u.id, category_id=vare.id, date=date(2026, 10, 21), amount=746,
                description="Metro Hamburg", payment_method="card", currency="EUR",
                original_amount=100, fx_rate=7.46),
        Expense(user_id=u.id, category_id=vare.id, date=date(2026, 10, 22), amount=1250,
                description="Hørkram", payment_method="card"),
        # Same currency as the account, spelled out: Danish købsmoms.
        Expense(user_id=u.id, category_id=vare.id, date=date(2026, 10, 23), amount=125,
                description="Netto", payment_method="card", currency="dkk"),
    ])
    db.commit()
    fd = compute_filing_data(db, u, *OCT)
    assert fd["moms_af_kob"] == 275.0                       # was 424,20 (149,20 on the EUR receipt)
    assert fd["kob_med_moms"] == 2121.0                     # the cost stays in
    assert fd["foreign_expenses_total"] == 746.0
    rows = fd["kob_pr_kategori"]
    assert round(sum(r["input_vat"] for r in rows), 2) == fd["moms_af_kob"]
    assert round(sum(r["gross"] for r in rows), 2) == fd["kob_med_moms"]
    foreign = [r for r in rows if r.get("foreign")]
    assert foreign == [{"category": "Varekøb", "gross": 746.0, "fradrag_pct": 0,
                        "input_vat": 0.0, "foreign": True}]

    b = rp.build_package(db, u, *OCT, now=utc(2026, 11, 3, 9, 0))
    z = _zip(b)
    eur = [r for r in _rows(z, "udgifter.csv")[1:] if r[8] == "EUR"]
    assert eur and eur[0][6] == "Udenlandsk valuta — ingen dansk købsmoms"   # was "25 %"
    text = _pdf_text(b.summary_pdf)
    assert "Varekøb (udenlandsk valuta)" in text and "0 % (udenl.)" in text
    assert "Udgifter i udenlandsk valuta (746,00 kr.)" in text
    b.close()

    # The bookkeeping exports code it without købsmoms too.
    from app.services.bookkeeping_export import _no_input_vat
    e_eur = db.query(Expense).filter(Expense.currency == "EUR").one()
    e_dkk = db.query(Expense).filter(Expense.currency == "dkk").one()
    assert _no_input_vat(e_eur, {}, "DKK") is True
    assert _no_input_vat(e_dkk, {}, "DKK") is False


# ── minor: a close's momsfri part is "Salg uden moms", as in salg.csv ────

def test_a_close_whose_moms_leaves_part_untaxed_splits_box_a_like_salg_csv(db, store):
    u = _owner(db)
    db.add_all([
        # 900 kr. moms on 5.000 kr.: 4.500 kr. at 25 % and 500 kr. momsfri.
        DailyClose(user_id=u.id, date=date(2026, 10, 10), revenue_total=5000, moms_total=900,
                   status="confirmed", moms_mode="manual"),
        # The standard rate, and the standard rate within a Z-bon's rounding.
        DailyClose(user_id=u.id, date=date(2026, 10, 11), revenue_total=5000, moms_total=1000,
                   status="confirmed"),
        DailyClose(user_id=u.id, date=date(2026, 10, 12), revenue_total=15000, moms_total=2997.5,
                   status="confirmed", moms_mode="manual"),
        # A close day with 1.000 kr. momsfri at the till, and its moms says so.
        DailyClose(user_id=u.id, date=date(2026, 10, 13), revenue_total=5000, moms_total=800,
                   status="confirmed", moms_mode="manual"),
        Sale(user_id=u.id, date=date(2026, 10, 13), amount=1000, status="completed",
             payment_method="cash", is_tax_exempt=True),
        Sale(user_id=u.id, date=date(2026, 10, 14), amount=200, status="completed",
             payment_method="cash", is_tax_exempt=True),
    ])
    db.commit()
    fd = compute_filing_data(db, u, *OCT)
    assert fd["moms_af_salg"] == 5697.5                     # unchanged: the closes' own moms
    assert fd["salg_med_moms"] == 4500 + 5000 + 15000 + 4000    # was 30.000
    assert fd["salg_uden_moms"] == 500 + 1000 + 200             # was 200
    assert fd["close_exempt_sales"] == 1500.0

    b = rp.build_package(db, u, *OCT, now=utc(2026, 11, 3, 9, 0))
    lines = _rows(_zip(b), "salg.csv")[1:]
    assert _csv_total([r for r in lines if r[4] == "0 %"]) == fd["salg_uden_moms"]
    assert _csv_total([r for r in lines if r[4] == "25 %"]) == fd["salg_med_moms"]
    assert not [r for r in lines if r[0] == "2026-10-12" and r[4] == "0 %"]   # rounding ≠ momsfri
    b.close()


def test_the_bookkeeping_export_splits_a_close_by_the_same_rule(db):
    from app.services.bookkeeping_export import _query_sales
    u = _owner(db)
    db.add_all([
        DailyClose(user_id=u.id, date=date(2026, 10, 10), revenue_total=1300, moms_total=200,
                   status="confirmed"),
        DailyClose(user_id=u.id, date=date(2026, 10, 12), revenue_total=15000, moms_total=2997.5,
                   status="confirmed"),
    ])
    db.commit()
    lines = _query_sales(u, db, *OCT)
    assert [(x.date.day, x.amount, x.is_tax_exempt) for x in lines] == [
        (10, 1000.0, False), (10, 300.0, True), (12, 15000.0, False)]   # no 12,50 "momsfri"


# ── minor: momsangivelse D2 adds up ─────────────────────────────────────

def test_momsangivelse_d2_rows_add_up_to_their_sum(db):
    u = _owner(db)
    cust = Customer(user_id=u.id, name="Firma A/S", cvr="87654321", is_company=True)
    db.add(cust); db.commit(); db.refresh(cust)
    db.add_all([
        DailyClose(user_id=u.id, date=date(2026, 10, 10), revenue_total=5000, moms_total=900,
                   status="confirmed", moms_mode="manual"),
        Invoice(user_id=u.id, customer_id=cust.id, fakturanummer=101, issue_date=date(2026, 10, 15),
                due_date=date(2026, 10, 29), status="sent", subtotal_net=12000, moms_total=3000,
                total_gross=15000),
        Invoice(user_id=u.id, customer_id=cust.id, fakturanummer=102, issue_date=date(2026, 10, 16),
                due_date=date(2026, 10, 30), status="sent", subtotal_net=4000, moms_total=0,
                total_gross=4000),
    ])
    db.commit()
    fd = compute_filing_data(db, u, *OCT)
    assert fd["salg_med_moms"] == 4500 + 15000
    text = _pdf_text(build_moms_filing_pdf(db, u, *OCT))
    d2 = text[text.index("D2 · KILDER"):]
    assert "Heraf uden moms i dagsafslutningerne (efter deres egen moms) −500,00" in d2
    assert "Heraf fakturaer uden moms −4.000,00" in d2
    # Kasserapport 5.000 − 500 + fakturaer 19.000 − 4.000 = Sum 19.500.
    assert "Sum (= Salg med moms) 19.500,00" in d2


# ── minor: salg.csv references a revisor can find, in one order ─────────

_IDS = {k: uuid.UUID(int=i) for i, k in enumerate(("brA", "brB", "cA", "cB", "c8"), start=1)}


def _two_branch_day(db, u, *, a_first: bool):
    db.add_all([Branch(id=_IDS["brA"], user_id=u.id, name="Nørrebro"),
                Branch(id=_IDS["brB"], user_id=u.id, name="Vesterbro")])
    a = DailyClose(id=_IDS["cA"], user_id=u.id, branch_id=_IDS["brA"], date=date(2026, 10, 9),
                   revenue_total=4000, moms_total=800, status="confirmed")
    bb = DailyClose(id=_IDS["cB"], user_id=u.id, branch_id=_IDS["brB"], date=date(2026, 10, 9),
                    revenue_total=6000, moms_total=1200, status="confirmed")
    db.add_all([a, bb] if a_first else [bb, a])
    db.add(DailyClose(id=_IDS["c8"], user_id=u.id, branch_id=_IDS["brA"], date=date(2026, 10, 8),
                      revenue_total=3000, moms_total=600, status="confirmed"))
    db.commit()


def test_salg_csv_names_each_close_by_its_kasserapport_number_in_one_order(tmp_path, store):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.database import Base
    out = []
    for a_first in (True, False):
        eng = create_engine(f"sqlite:///{tmp_path}/two-{a_first}.db",
                            connect_args={"check_same_thread": False})
        Base.metadata.create_all(eng)
        s = sessionmaker(bind=eng)()
        u = User(id=uuid.UUID(int=99), email="k@cafe.dk", password_hash="x",
                 business_name="Café", business_type="cafe", currency="DKK", plan="starter",
                 email_verified=True, timezone="Europe/Copenhagen")
        s.add(u); s.commit()
        _two_branch_day(s, u, a_first=a_first)
        b = rp.build_package(s, u, *OCT, now=utc(2026, 11, 3, 9, 0))
        z = _zip(b)
        sales = _rows(z, "salg.csv")[1:]
        closes = _rows(z, "dagsafslutninger.csv")
        vouchers = {r[1] for r in closes[1:] if r[1]}
        assert {r[1] for r in sales} <= vouchers            # was K-2026-10-09(-2): in no other file
        assert len({r[1] for r in sales if r[0] == "2026-10-09"}) == 2
        # "I alt — 3 låste dage" over 3 closes on 2 days
        assert closes[-1][3] == "I alt — 3 låste dagsafslutninger på 2 dage"
        out.append(([r[1:] for r in sales], [r[1] for r in closes[1:-1]]))
        b.close(); s.close(); eng.dispose()
    assert out[0] == out[1]                                 # was: the two branches swapped


# ── minor: the M7 fingerprint covers the rows the PDF prints ────────────

def test_a_recategorised_expense_and_a_moved_day_are_changes_and_resend_as_rettelse(
        client, db, store, mailbox):
    u = _owner(db)
    _month(db, u, store, skip_days=(20,))
    kontor = _cat(db, u, "Kontorartikler")
    groent = db.query(Expense).filter(Expense.user_id == u.id).first()
    _as(u)
    body = {"start": "2026-09-01", "end": "2026-09-30"}
    assert client.post("/api/revisor-package/send", json={**body, "key": "k1"}).status_code == 200
    assert client.get("/api/revisor-package/checklist", params=body).json()["sent_package"]["changed"] is False

    groent.category_id = kontor.id           # same 100 % fradrag: every total stays
    db.commit()
    sp = client.get("/api/revisor-package/checklist", params=body).json()["sent_package"]
    assert sp["changed"] is True                                          # was False
    first = db.query(RevisorPackageSend).one()
    assert set(json.loads(first.figures_json)["kategorier"]) == {"Varekøb"}
    assert {c["key"] for c in sp["changes"]} >= {"category_vat:Varekøb", "category_vat:Kontorartikler",
                                                  "category_gross:Kontorartikler"}
    assert not [c for c in sp["changes"] if c["key"] in rp.FIGURE_LABELS_DA]
    kc = next(c for c in sp["changes"] if c["key"] == "category_vat:Kontorartikler")
    assert (kc["kind"], kc["name"], kc["before"], kc["after"]) == ("category_vat", "Kontorartikler", 0.0, 20.0)

    r = client.post("/api/revisor-package/send", json={**body, "key": "k2", "resend": True})
    assert r.status_code == 200, r.text
    mail = [m for m in mailbox if m["to"] == ["pia@revisorhuset.dk"]][-1]
    assert mail["subject"].startswith("RETTELSE: Revisorpakke september 2026")    # was no RETTELSE
    assert "Købsmoms — Kontorartikler: 0,00 kr. → 20,00 kr." in mail["html"]

    # Revenue moved from one day to another: same total, another day.
    c19 = db.query(DailyClose).filter(DailyClose.user_id == u.id,
                                      DailyClose.date == date(2026, 9, 19)).one()
    c19.date = date(2026, 9, 20)
    db.commit()
    sp = client.get("/api/revisor-package/checklist", params=body).json()["sent_package"]
    assert sp["changed"] is True
    keys = {c["key"] for c in sp["changes"]}
    assert {"day_revenue:2026-09-19", "day_revenue:2026-09-20"} <= keys and "omsaetning" not in keys


def test_a_send_recorded_before_the_detail_compares_its_totals_only(db):
    """A send row from before the category/day figures: no false 'changed'."""
    old = {k: 0 for k in rp.FIGURE_LABELS_DA}
    new = dict(old, kategorier={"Varekøb": [100.0, 20.0]}, dage={"2026-09-01": 5000.0})
    assert rp.figure_changes(old, new) == []


# ── minor: labels that said more than the figure is ─────────────────────

def test_the_summary_names_what_it_counts_and_every_csv_it_holds(db, store):
    u = _owner(db)
    _month(db, u, store)
    lon = _cat(db, u, "Løn")
    db.add(Expense(user_id=u.id, category_id=lon.id, date=date(2026, 9, 25), amount=25000,
                   description="Løn september", payment_method="bank_transfer"))
    cust = Customer(user_id=u.id, name="Firma A/S", cvr="87654321", is_company=True)
    db.add(cust); db.commit(); db.refresh(cust)
    db.add(Invoice(user_id=u.id, customer_id=cust.id, fakturanummer=1, issue_date=date(2026, 9, 18),
                   due_date=date(2026, 10, 2), status="sent", subtotal_net=1000, moms_total=250,
                   total_gross=1250))
    db.add(MileageEntry(user_id=u.id, trip_date=date(2026, 9, 12), from_address="Nørregade 1",
                        to_address="Metro Glostrup", km=22, purpose="Indkøb", rate_per_km=3.79,
                        deduction_amount=83.38))
    db.commit()
    b = rp.build_package(db, u, *SEP, now=NOW)
    names = set(_zip(b).namelist())
    assert {"fakturaer.csv", "koersel.csv"} <= names
    text = _pdf_text(b.summary_pdf)
    assert "Køb med købsmoms" not in text                       # it held 25.000 kr. løn
    assert "Udgifter inkl. moms, ekskl. momsfri" in text
    assert "salg, udgifter, fakturaer, gavekort, kørsel og momsoversigt" in text   # was without both
    b.close()


def test_a_close_the_csv_cannot_state_moms_for_is_explained_in_the_summary(db, store):
    """dagsafslutninger.csv says 'Salgsmoms kan ikke opgøres' for a close
    with no moms figure, while the moms above includes 25/125 of it."""
    u = _owner(db)
    for d in (3, 4):
        db.add(DailyClose(user_id=u.id, date=date(2026, 9, d), revenue_total=2500,
                          moms_total=None, status="confirmed"))
    db.add(DailyClose(user_id=u.id, date=date(2026, 9, 5), revenue_total=5000, moms_total=1000,
                      status="confirmed"))
    db.commit()
    b = rp.build_package(db, u, *SEP, now=NOW)
    assert b.fd["moms_af_salg"] == 2000.0                   # 1.000 + 25/125 × 5.000
    csv_text = _zip(b).read("dagsafslutninger.csv").decode("utf-8-sig")
    assert csv_text.count("Salgsmoms kan ikke opgøres") == 2
    text = _pdf_text(b.summary_pdf)
    assert ("2 dagsafslutninger uden momsbeløb (5.000,00 kr. i omsætning) står i "
            "dagsafslutninger.csv som «Salgsmoms kan ikke opgøres». Salgsmomsen ovenfor regner "
            "25/125 af deres omsætning") in text
    b.close()


# ── minor: a Send tap between the schedule's check and its claim ────────

def test_a_send_tap_during_the_schedules_check_is_not_sent_twice(factory, store, mailbox, monkeypatch):
    db_ = factory()
    u = _owner(db_, schedule="monthly", since=utc(2026, 9, 1))
    _month(db_, u, store, month=10)
    uid = u.id
    db_.close()
    real = rp.send_blocker
    fired = []

    def _blocker(db2, user, profile, start, end):
        if not fired:
            fired.append(1)
            # The owner taps "Send" on Månedsafslutning at this moment.
            r = _manual_send_on(factory, uid, mailbox, monkeypatch, mode="ok",
                                when=utc(2026, 11, 3, 7, 20))
            assert r.status_code == 200, r.text
        return real(db2, user, profile, start, end)

    monkeypatch.setattr(rp, "send_blocker", _blocker)
    summary = job.run_revisor_package_schedule(factory, now=utc(2026, 11, 3, 7, 20))
    assert fired and summary["sent"] == 0                                # was 1
    revisor = [m for m in mailbox if m["to"] == ["pia@revisorhuset.dk"]]
    assert len(revisor) == 1                                             # was 2
    s = factory()
    assert [r.send_trigger for r in s.query(RevisorPackageSend).all()] == ["manual"]
    s.close()


def test_a_confirmed_resend_waits_for_a_send_in_progress(client, db, store, mailbox, monkeypatch):
    import app.routers.revisor_package as rr
    u = _owner(db)
    _month(db, u, store)
    when = utc(2026, 10, 3, 7, 25)
    monkeypatch.setattr(rr, "utc_now", lambda: when)
    db.add(RevisorPackageSend(user_id=u.id, period_kind="month", period_start=SEP[0],
                              period_end=SEP[1], send_trigger="scheduled",
                              recipient="pia@revisorhuset.dk", dedup_key="sched:2026-09-01:2026-09-30",
                              status="claimed", attempts=1, created_at=utc(2026, 10, 3, 7, 20),
                              updated_at=utc(2026, 10, 3, 7, 20)))
    db.commit()
    _as(u)
    r = client.post("/api/revisor-package/send",
                    json={"start": "2026-09-01", "end": "2026-09-30", "key": "tap2", "resend": True})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "in_progress"   # was 200: a 2nd mail
    assert not [m for m in mailbox if m["to"] == ["pia@revisorhuset.dk"]]
