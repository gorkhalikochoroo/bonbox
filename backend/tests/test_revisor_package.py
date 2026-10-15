"""Revisorpakke — contents, the MOMS tie-out, the checklist, sending, the link.

E-mail is mocked at Resend (nothing leaves); storage is an in-memory fake.

Run:
  cd backend && python3 -m pytest tests/test_revisor_package.py -q
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import uuid
import zipfile
from datetime import date, datetime, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from app.models.revisor_package import RevisorPackageSend
from app.models.sale import Sale
from app.models.user import User
from app.routers.revisor_package import _limiter as _rp_limiter
from app.services import revisor_package as rp
from app.services import storage as storage_mod
from app.services.auth import get_current_user
from app.services.bonbox_pdf_kit import money_dk
from app.services.tax_filing_pdf import compute_filing_data

_db_ready.set()
_rp_limiter.enabled = False

SEP = (date(2026, 9, 1), date(2026, 9, 30))
NOW = datetime(2026, 10, 12, 9, 0)          # naive UTC, a Monday


class FakeStorage(storage_mod.StorageBackend):
    is_durable = True

    def __init__(self):
        self.blobs: dict[str, bytes] = {}

    def put(self, key, data, content_type="image/jpeg"):
        self.blobs[key] = data
        return key

    def get(self, key):
        return self.blobs.get(key)

    def delete(self, key):
        return self.blobs.pop(key, None) is not None


@pytest.fixture
def store(monkeypatch):
    fake = FakeStorage()
    monkeypatch.setattr(storage_mod, "_backend", fake)
    yield fake
    storage_mod.reset_storage_for_tests()


@pytest.fixture
def db(monkeypatch) -> Iterator:
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    SessionLocal = sessionmaker(bind=eng)
    s = SessionLocal()
    import app.database as _dbm
    monkeypatch.setattr(_dbm, "SessionLocal", SessionLocal, raising=False)
    monkeypatch.setattr("app.services.billing.SessionLocal", SessionLocal, raising=False)
    s._factory = SessionLocal
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(db):
    def _get():
        yield db
    app.dependency_overrides[get_db] = _get
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def mailbox(monkeypatch):
    sent = []

    def _send(payload):
        sent.append(payload)
        return {"id": f"m{len(sent)}"}

    monkeypatch.setattr("app.services.email_service.resend.Emails.send", _send)
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")
    return sent


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user


def _owner(db, *, plan="starter", verified=True, revisor="pia@revisorhuset.dk",
           open_days=None) -> User:
    u = User(email=f"ejer-{uuid.uuid4().hex[:6]}@cafe.dk", password_hash="x",
             business_name="Café Hygge", business_type="cafe", currency="DKK",
             plan=plan, email_verified=verified)
    db.add(u); db.commit(); db.refresh(u)
    p = BusinessProfile(user_id=u.id, company_name="Café Hygge ApS", org_number="12345678",
                        address="Nørregade 1", zipcode="1165", city="København K",
                        accountant_email=revisor, accountant_name="Pia",
                        open_days_mask=open_days)
    db.add(p); db.commit()
    return u


def _cat(db, u, name):
    c = ExpenseCategory(user_id=u.id, name=name)
    db.add(c); db.commit(); db.refresh(c)
    return c


def _seed_september(db, u, store):
    """A realistic month: closes (one short, one draft, gaps), typed and
    scanned expenses, a draft in the queue, a personal row."""
    raa = _cat(db, u, "Råvarer")
    rest = _cat(db, u, "Restaurantbesøg")
    for day in range(1, 31):
        d = date(2026, 9, day)
        if day in (3, 17):
            continue                                     # no close at all
        if day == 10:
            db.add(DailyClose(user_id=u.id, date=d, revenue_total=4000, status="draft"))
            continue
        db.add(DailyClose(
            user_id=u.id, date=d, revenue_total=5000, moms_total=1000, status="confirmed",
            payment_categories="cash:1000|card:3500|mobilepay:500", payment_total=5000,
            cash_expected=1000, cash_counted=850 if day == 4 else 1000,
            cash_difference=-150 if day == 4 else 0,
        ))
    key = f"{u.id}/expense/{'ab' * 32}.jpg"
    store.put(key, b"\xff\xd8\xff\xe0" + b"jpegbytes")
    db.add_all([
        Expense(user_id=u.id, category_id=raa.id, date=date(2026, 9, 3), amount=129.95,
                description="Netto", payment_method="card",
                receipt_photo=f"https://p.supabase.co/storage/v1/object/sign/receipts/{key}?token=t"),
        Expense(user_id=u.id, category_id=raa.id, date=date(2026, 9, 8), amount=300,
                description="Hørkram", payment_method="card"),         # no bilag
        Expense(user_id=u.id, category_id=rest.id, date=date(2026, 9, 12), amount=500,
                description="Frokost kunde", payment_method="card",
                receipt_photo=f"https://p.supabase.co/storage/v1/object/sign/receipts/{key}?token=t"),
        Expense(user_id=u.id, category_id=raa.id, date=date(2026, 9, 20), amount=80,
                description="Draft", payment_method="card", status="pending",
                receipt_photo="uploads/receipts/x.jpg"),
        Expense(user_id=u.id, category_id=raa.id, date=date(2026, 9, 21), amount=45,
                description="Privat", payment_method="cash", is_personal=True),
        Expense(user_id=u.id, category_id=raa.id, date=date(2026, 9, 22), amount=60,
                description="Pant", payment_method="cash", is_tax_exempt=True),
    ])
    db.add(Sale(user_id=u.id, date=date(2026, 9, 3), amount=700, status="completed",
                payment_method="cash"))
    db.commit()


# ── The package: contents + the MOMS tie-out ─────────────────────────

def test_package_contents_names_and_manifest(db, store):
    u = _owner(db)
    _seed_september(db, u, store)
    b = rp.build_package(db, u, *SEP, now=NOW)
    z = zipfile.ZipFile(io.BytesIO(b.zip_bytes))
    names = set(z.namelist())
    for n in ("Oversigt_2026-09.pdf", "omsaetning-pr-dag.csv", "dagsafslutninger.csv",
              "salg.csv", "udgifter.csv", "gavekort.csv", "moms-oversigt.csv",
              "bilag-oversigt.csv", "LAES-MIG.txt", "manifest.txt",
              "bilag/2026-09-03_Netto_129,95.jpg", "bilag/2026-09-12_Frokost-kunde_500,00.jpg"):
        assert n in names, n
    assert b.zip_filename == "Revisorpakke_Café_Hygge_ApS_2026-09.zip"
    # The draft and the personal row are not in the books → not in the package.
    udg = z.read("udgifter.csv").decode("utf-8-sig")
    assert "Draft" not in udg and "Privat" not in udg
    assert "MANGLER" in udg and "Hørkram" in udg
    # Every file's SHA-256 is in the manifest.
    manifest = z.read("manifest.txt").decode()
    for n in names - {"manifest.txt"}:
        assert hashlib.sha256(z.read(n)).hexdigest() in manifest, n
    idx = list(csv.reader(io.StringIO(z.read("bilag-oversigt.csv").decode("utf-8-sig")), delimiter=";"))
    assert idx[0][:2] == ["Fil", "Dato"] and len(idx) == 3


def test_moms_in_the_package_is_compute_filing_data(db, store):
    from pypdf import PdfReader
    u = _owner(db)
    _seed_september(db, u, store)
    fd = compute_filing_data(db, u, *SEP)
    b = rp.build_package(db, u, *SEP, now=NOW)
    text = "\n".join(p.extract_text() for p in PdfReader(io.BytesIO(b.summary_pdf)).pages)
    for key in ("moms_af_salg", "moms_af_kob", "moms_til_skat", "salg_med_moms"):
        assert money_dk(fd[key]) in text, key
    # The category table's købsmoms column totals the angivelse's figure.
    assert sum(r["input_vat"] for r in fd["kob_pr_kategori"]) == pytest.approx(fd["moms_af_kob"])
    z = zipfile.ZipFile(io.BytesIO(b.zip_bytes))
    moms_csv = z.read("moms-oversigt.csv").decode("utf-8-sig")
    dk = lambda v: f"{v:.2f}".replace(".", ",")  # noqa: E731 — Danish Excel (decimal comma)
    assert dk(fd["moms_af_salg"]) in moms_csv and dk(fd["moms_af_kob"]) in moms_csv
    # Open items are printed, plainly.
    assert "Åbne punkter" in text
    assert "uden dagsafslutning" in text and "ikke låst" in text
    assert "mangler bilag" in text and "kassedifference" in text


# ── The checklist ────────────────────────────────────────────────────

def _item(cl, key):
    return next(i for i in cl["items"] if i["key"] == key)


def test_checklist_items(db, store):
    u = _owner(db)
    _seed_september(db, u, store)
    db.add(Expense(user_id=u.id, category_id=_cat(db, u, "Bank").id, date=date(2026, 9, 9),
                   amount=19, description="Gebyr", reference_id="bank_danske_abc"))
    db.add(Expense(user_id=u.id, category_id=_cat(db, u, "Bank2").id, date=date(2026, 9, 9),
                   amount=25, description="Linket", reference_id="bank_danske_def",
                   notes="x [linked:123]"))
    db.commit()
    cl = rp.build_checklist(db, u, *SEP, now=NOW)
    assert [r["date"] for r in _item(cl, "closes_missing")["rows"]] == ["2026-09-03", "2026-09-17"]
    assert [r["date"] for r in _item(cl, "closes_unlocked")["rows"]] == ["2026-09-10"]
    assert _item(cl, "closes_unlocked")["link"] == "/daily-close?date=2026-09-10"
    miss = _item(cl, "bilag_missing")
    # Hørkram + the bank fee; never the personal, momsfri or draft rows.
    assert {r["description"] for r in miss["rows"]} == {"Hørkram", "Gebyr", "Linket"}
    assert miss["link"] == "/expenses?bilag=missing&from=2026-09-01&to=2026-09-30"
    assert _item(cl, "drafts_pending")["count"] == 1
    cash = _item(cl, "cash_differences")
    assert [r["date"] for r in cash["rows"]] == ["2026-09-04"] and cash["threshold"] == 100
    assert [r["description"] for r in _item(cl, "bank_unmatched")["rows"]] == ["Gebyr"]
    assert cl["open_count"] == 6


def test_checklist_respects_open_days_and_never_counts_today(db):
    u = _owner(db, open_days="12345")                    # closed weekends
    for day in (5, 6, 7):                                # Mon–Wed of week 41
        db.add(DailyClose(user_id=u.id, date=date(2026, 10, day), revenue_total=1, status="confirmed"))
    db.commit()
    now = datetime(2026, 10, 12, 9, 0)                   # Monday 11:00 local
    cl = rp.build_checklist(db, u, date(2026, 10, 5), date(2026, 10, 18), now=now)
    # Thu 8, Fri 9 missing; Sat/Sun closed; Mon 12 is today — not yet due.
    assert [r["date"] for r in _item(cl, "closes_missing")["rows"]] == ["2026-10-08", "2026-10-09"]


def test_no_daily_closes_in_use_is_not_an_open_item(db):
    u = _owner(db)
    cl = rp.build_checklist(db, u, *SEP, now=NOW)
    miss = _item(cl, "closes_missing")
    assert miss["applicable"] is False and miss["count"] == 0
    assert cl["open_count"] == 0


def test_cash_tolerance_is_the_kasserapport_one(db):
    u = _owner(db)
    db.add(DailyClose(user_id=u.id, date=date(2026, 9, 1), revenue_total=1, status="confirmed",
                      cash_difference=-100))
    db.add(DailyClose(user_id=u.id, date=date(2026, 9, 2), revenue_total=1, status="confirmed",
                      cash_difference=100.01))
    db.commit()
    rows = _item(rp.build_checklist(db, u, *SEP, now=NOW), "cash_differences")["rows"]
    assert [r["date"] for r in rows] == ["2026-09-02"]


# ── What the package may say: never more than was checked ───────────

OCT = (date(2026, 10, 1), date(2026, 10, 31))


def _locked_days(db, u, start, end, weekdays=None):
    d = start
    while d <= end:
        if weekdays is None or d.isoweekday() in weekdays:
            db.add(DailyClose(user_id=u.id, date=d, revenue_total=1000, moms_total=200,
                              status="confirmed"))
        d += timedelta(days=1)
    db.commit()


def test_all_clear_for_a_finished_period_with_every_day_locked(db):
    u = _owner(db)
    _locked_days(db, u, *SEP)
    st = rp.checklist_status(rp.build_checklist(db, u, *SEP, now=NOW, unreadable=[]))
    assert st["open"] == [] and st["notes"] == []
    assert st["title"] == ("Ingen åbne punkter: alle dage er lukket og låst, "
                           "og alle bogførte udgifter med moms har bilag.")


def test_unfinished_period_says_so_and_claims_only_the_days_checked(db):
    u = _owner(db)
    _locked_days(db, u, date(2026, 10, 1), date(2026, 10, 11))
    st = rp.checklist_status(rp.build_checklist(db, u, *OCT, now=NOW, unreadable=[]))   # NOW = 12 Oct
    assert st["open"] == []
    assert "alle dage indtil nu er lukket og låst" in st["title"]
    assert "alle dage er lukket og låst" not in st["title"]
    assert st["notes"] == [
        f"Perioden er ikke slut — kontrolleret til og med {rp.dk_date(date(2026, 10, 11))}."]


def test_period_starting_today_claims_no_locked_days(db):
    u = _owner(db)
    _locked_days(db, u, date(2026, 9, 1), date(2026, 10, 11))
    st = rp.checklist_status(rp.build_checklist(db, u, date(2026, 10, 12), date(2026, 10, 18), now=NOW, unreadable=[]))
    assert "lukket og låst" not in st["title"]
    assert st["notes"] == ["Perioden er ikke slut — ingen dage er kontrolleret endnu."]


def test_owner_without_daily_closes_is_never_told_the_days_are_locked(db):
    u = _owner(db)
    st = rp.checklist_status(rp.build_checklist(db, u, *SEP, now=NOW, unreadable=[]))
    assert st["title"] == "Ingen åbne punkter: alle bogførte udgifter med moms har bilag."
    assert st["notes"] == ["Der føres ikke dagsafslutninger i BonBox, så manglende dage "
                           "er ikke kontrolleret."]


def test_opening_days_are_named_when_the_owner_set_them(db):
    u = _owner(db, open_days="12345")
    _locked_days(db, u, *SEP, weekdays={1, 2, 3, 4, 5})
    st = rp.checklist_status(rp.build_checklist(db, u, *SEP, now=NOW, unreadable=[]))
    assert st["title"].startswith("Ingen åbne punkter: alle åbningsdage er lukket og låst")


def test_open_items_keep_the_unfinished_period_note(db, store):
    u = _owner(db)
    _locked_days(db, u, date(2026, 10, 1), date(2026, 10, 5))   # 6–11 Oct missing
    st = rp.checklist_status(rp.build_checklist(db, u, *OCT, now=NOW, unreadable=[]))
    assert st["title"] == "Åbne punkter (1) — perioden er ikke færdig"
    assert st["open"][0].startswith("6 dage uden dagsafslutning")
    assert st["notes"][0].startswith("Perioden er ikke slut — kontrolleret til og med")


def test_pdf_mail_and_readme_print_the_same_status(db, store):
    from pypdf import PdfReader
    from app.services.revisor_mail import esc
    u = _owner(db)
    _locked_days(db, u, date(2026, 10, 1), date(2026, 10, 11))
    b = rp.build_package(db, u, *OCT, now=NOW)
    st = rp.checklist_status(b.checklist)
    with zipfile.ZipFile(io.BytesIO(b.zip_bytes)) as z:
        readme = z.read("LAES-MIG.txt").decode("utf-8")
    assert st["title"] in readme and st["notes"][0] in readme
    html = rp.package_email_html(biz="Café Hygge", cvr="12345678", accountant_name="Pia",
                                 label="oktober 2026", build=b, url="https://x.test/p",
                                 expires=date(2026, 10, 26))
    assert esc(st["title"]) in html and esc(st["notes"][0]) in html
    assert "alle dage er lukket og låst" not in html
    pdf = " ".join(" ".join(p.extract_text().split()) for p in PdfReader(io.BytesIO(b.summary_pdf)).pages)
    assert st["title"] in pdf and st["notes"][0] in pdf


# ── Download (every tier) and send (the plan that sends) ─────────────

def test_free_owner_downloads_but_cannot_send(client, db, store, mailbox):
    u = _owner(db, plan="free")
    _seed_september(db, u, store)
    _as(u)
    r = client.get("/api/revisor-package/download", params={"start": "2026-09-01", "end": "2026-09-30"})
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert zipfile.ZipFile(io.BytesIO(r.content)).testzip() is None
    r = client.post("/api/revisor-package/send", json={"start": "2026-09-01", "end": "2026-09-30", "key": "k1"})
    assert r.status_code == 402
    assert mailbox == []


def test_send_walls(client, db, store, mailbox):
    u = _owner(db, revisor=None)
    _as(u)
    body = {"start": "2026-09-01", "end": "2026-09-30"}
    r = client.post("/api/revisor-package/send", json={**body, "key": "kb"})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "no_accountant_email"
    u2 = _owner(db, verified=False)
    _as(u2)
    r = client.post("/api/revisor-package/send", json={**body, "key": "kb"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "email_unverified"
    assert mailbox == []
    r = client.post("/api/revisor-package/send", json={"start": "2026-01-01", "end": "2026-06-30", "key": "k2"})
    assert r.status_code == 422


def test_send_mails_revisor_pdf_and_link_and_the_link_serves_the_same_zip(client, db, store, mailbox):
    u = _owner(db)
    _seed_september(db, u, store)
    _as(u)
    r = client.post("/api/revisor-package/send",
                    json={"start": "2026-09-01", "end": "2026-09-30", "key": "tap-1"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["ok"] and out["sent_to"] == "pia@revisorhuset.dk" and out["open_items"] == 5
    to_revisor = [m for m in mailbox if m["to"] == ["pia@revisorhuset.dk"]]
    assert len(to_revisor) == 1
    m = to_revisor[0]
    assert m["subject"].startswith("Revisorpakke september 2026")
    assert m["attachments"][0]["filename"] == "Oversigt_2026-09.pdf"
    assert "List-Unsubscribe" in (m.get("headers") or {})
    html = m["html"]
    assert "Åbne punkter (5)" in html and "uden dagsafslutning" in html
    link = html.split("href='", 1)[1].split("'", 1)[0]
    assert "/api/public/revisor-package/" in link
    # The owner's copy is a separate mail without the opt-out.
    assert any(x["to"] == [u.email] and x["subject"].startswith("Kopi:") for x in mailbox)

    row = db.query(RevisorPackageSend).one()
    assert row.status == "sent" and row.send_trigger == "manual"
    # The link works THROUGH the date the mail names: to 23:59:59 local on
    # the 14th day after the send — not to the minute it was sent.
    from zoneinfo import ZoneInfo
    exp, on = rp.link_expiry(db, u, row.sent_at)
    assert row.link_expires_at == exp
    local = exp.replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Europe/Copenhagen"))
    sent_local = row.sent_at.replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Europe/Copenhagen"))
    assert (local.hour, local.minute, local.second) == (23, 59, 59)
    assert on == sent_local.date() + timedelta(days=14) == local.date()
    assert out["link_expires_on"] == on.isoformat()
    assert rp.dk_date(on) in html
    a = db.query(AuditLog).filter(AuditLog.action == "revisor_package.sent").one()
    assert json.loads(a.after_state)["recipient"] == "pia@revisorhuset.dk"

    token = link.rsplit("/", 1)[1]
    app.dependency_overrides.pop(get_current_user, None)
    g = client.get(f"/api/public/revisor-package/{token}")
    assert g.status_code == 200 and hashlib.sha256(g.content).hexdigest() == row.zip_sha256

    # The same tap again answers with what happened — no second mail.
    _as(u)
    n = len(mailbox)
    r2 = client.post("/api/revisor-package/send",
                     json={"start": "2026-09-01", "end": "2026-09-30", "key": "tap-1"})
    assert r2.json()["replayed"] is True and len(mailbox) == n


def test_unclear_mail_outcome_is_not_resent_and_its_link_still_works(client, db, store, mailbox,
                                                                    monkeypatch):
    """The provider may have accepted the mail before the call died: the
    owner is told to ask, the same tap is not mailed again, and a revisor who
    did get the mail can still use its link."""
    u = _owner(db)
    _seed_september(db, u, store)
    _as(u)
    links = []

    def _flaky(payload):
        links.append(payload["html"].split("href='", 1)[1].split("'", 1)[0])
        raise RuntimeError("read timeout")

    monkeypatch.setattr("app.services.email_service.resend.Emails.send", _flaky)
    body = {"start": "2026-09-01", "end": "2026-09-30", "key": "tap-u"}
    r = client.post("/api/revisor-package/send", json={**body, "key": "kb"})
    assert r.status_code == 502 and r.json()["detail"]["code"] == "email_unclear"
    assert "Spørg revisoren" in r.json()["detail"]["message_da"]
    row = db.query(RevisorPackageSend).one()
    assert row.status == "failed" and row.error.startswith("mail_unclear")
    assert row.storage_key in store.blobs
    # The same tap again: refused with the same advice, nothing mailed.
    r = client.post("/api/revisor-package/send", json={**body, "key": "kb"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "email_unclear"
    assert len(links) == 1
    # The link in the mail that may have arrived serves the package.
    app.dependency_overrides.pop(get_current_user, None)
    g = client.get(f"/api/public/revisor-package/{links[0].rsplit('/', 1)[1]}")
    assert g.status_code == 200 and hashlib.sha256(g.content).hexdigest() == row.zip_sha256


def test_a_refused_mail_can_be_sent_again_with_the_same_tap(client, db, store, mailbox, monkeypatch):
    u = _owner(db)
    _seed_september(db, u, store)
    _as(u)
    from resend.exceptions import RateLimitError

    def _refuse(payload):
        raise RateLimitError("Too many requests", "rate_limit_exceeded", 429)

    monkeypatch.setattr("app.services.email_service.resend.Emails.send", _refuse)
    body = {"start": "2026-09-01", "end": "2026-09-30", "key": "tap-r"}
    r = client.post("/api/revisor-package/send", json={**body, "key": "kb"})
    assert r.status_code == 502 and r.json()["detail"]["code"] == "email_send_failed"
    row = db.query(RevisorPackageSend).one()
    assert row.status == "failed" and row.storage_key is None
    assert not [k for k in store.blobs if "/revisor_package/" in k]   # no orphan ZIP
    monkeypatch.setattr("app.services.email_service.resend.Emails.send",
                        lambda payload: mailbox.append(payload) or {"id": "x"})
    r = client.post("/api/revisor-package/send", json={**body, "key": "kb"})
    assert r.status_code == 200 and r.json()["ok"]
    db.refresh(row)
    assert row.status == "sent" and row.attempts == 2


def test_a_stale_manual_claim_reads_as_failed(db):
    u = _owner(db)
    t0 = datetime.utcnow() - timedelta(hours=2)
    db.add(RevisorPackageSend(user_id=u.id, period_kind="month", period_start=SEP[0],
                              period_end=SEP[1], send_trigger="manual", dedup_key="manual:k",
                              status="claimed", attempts=1, created_at=t0, updated_at=t0))
    db.commit()
    (x,) = rp.last_sends(db, u)
    assert (x["status"], x["error"]) == ("failed", "stale_claim")


def test_a_send_over_the_link_cap_is_split_and_reads_each_bilag_once(db, store, monkeypatch):
    """(Was: a send stopped at the cap and mailed nothing. 12 Oct review M8:
    a package over the cap goes as numbered parts, one link each.)"""
    u = _owner(db)
    _seed_september(db, u, store)
    reads = []
    real = rp.load_bilag
    monkeypatch.setattr(rp, "load_bilag", lambda uid, ref, db=None: reads.append(ref) or real(uid, ref, db=db))
    monkeypatch.setattr(rp, "_PART1_RESERVE", 0)
    monkeypatch.setattr(rp, "_PART_RESERVE", 0)
    b = rp.build_package(db, u, *SEP, now=NOW, split_bytes=1100)
    try:
        assert len(b.parts) == 2 and [pt.n_bilag for pt in b.parts] == [1, 1]
        assert len(reads) == 2
        assert b.parts[1].name.endswith("_del-2-af-2.zip")
    finally:
        b.close()

def test_the_download_is_streamed_and_identical_to_the_build(client, db, store):
    u = _owner(db)
    _seed_september(db, u, store)
    _as(u)
    r = client.get("/api/revisor-package/download", params={"start": "2026-09-01", "end": "2026-09-30"})
    assert r.status_code == 200 and int(r.headers["content-length"]) == len(r.content)
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert z.testzip() is None and "manifest.txt" in z.namelist()
    # Every file in the manifest, in reading order: oversigt first, bilag
    # after the CSVs, LAES-MIG last.
    names = [ln.split()[-1] for ln in z.read("manifest.txt").decode().splitlines()
             if len(ln.split()) == 3 and len(ln.split()[0]) == 64]
    assert names[0].startswith("Oversigt_") and names[-1] == "LAES-MIG.txt"
    assert names.index("bilag-oversigt.csv") < min(i for i, n in enumerate(names) if n.startswith("bilag/"))
    assert set(names) == set(z.namelist()) - {"manifest.txt"}


def test_a_forwarded_gif_or_tiff_bilag_is_handed_to_the_revisor(db, store):
    """Push 8 gate (composition of p8-backend-fixes and revisor-reports): a
    forwarded image/gif or image/tiff bilag is stored durably under
    <uid>/inbox_receipt/<sha>.gif|.tiff. The package must read it, name it
    by its own type and not list it as an open item."""
    from app.services.inbox_service import persist_attachment_blob, sha256_hex
    u = _owner(db)
    raa = _cat(db, u, "Råvarer")
    files = {
        "gif": (b"GIF89a\x01\x00\x01\x00\x80\x00\x00" + b"kvittering-gif", "image/gif"),
        "tiff": (b"II*\x00\x08\x00\x00\x00" + b"kvittering-tif", "image/tiff"),
        "tiff-mm": (b"MM\x00*\x00\x00\x00\x08" + b"kvittering-mm", "image/tiff"),
    }
    rows = []
    for i, (label, (data, ctype)) in enumerate(files.items()):
        # The real producer, so the key is the one production writes.
        key = persist_attachment_blob(data, sha256_hex(data), user_id=u.id, content_type=ctype)
        assert key in store.blobs and "/inbox_receipt/" in key
        rows.append(Expense(user_id=u.id, category_id=raa.id, date=date(2026, 9, 5 + i),
                            amount=100 + i, description=f"Leverandør {label}",
                            payment_method="card", receipt_photo=key))
    db.add_all(rows); db.commit()
    unreadable = next(i for i in rp.build_checklist(db, u, *SEP)["items"]
                      if i["key"] == "bilag_unreadable")
    assert unreadable["count"] == 0
    b = rp.build_package(db, u, *SEP, now=NOW)
    try:
        z = zipfile.ZipFile(io.BytesIO(b.zip_bytes))
        bilag = sorted(n for n in z.namelist() if n.startswith("bilag/"))
        assert [n.rsplit(".", 1)[1] for n in bilag] == ["gif", "tiff", "tiff"], bilag
        assert z.read(bilag[0]) == files["gif"][0]
        udg = z.read("udgifter.csv").decode("utf-8-sig")
        assert rp.UNREADABLE_DA not in udg
    finally:
        b.close()


def test_the_sample_company_package_agrees_with_itself(db, store):
    """Still the demo seeder's sample company: every figure is the sample's,
    the package shows them (marked EKSEMPELDATA) — never 0 kr. revenue beside
    the sample's salgsmoms."""
    from pypdf import PdfReader
    u = _owner(db)
    p = db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).one()
    p.cvr_verified_source = "cvrapi.dk · demo"
    for day in (1, 2):
        db.add(DailyClose(user_id=u.id, date=date(2026, 9, day), revenue_total=1250,
                          moms_total=250, status="confirmed", notes="Eksempeldag · demo"))
    db.commit()
    b = rp.build_package(db, u, *SEP, now=NOW)
    fd = compute_filing_data(db, u, *SEP)
    assert b.revenue_total == 2500 and fd["moms_af_salg"] > 0
    text = " ".join(p.extract_text() for p in PdfReader(io.BytesIO(b.summary_pdf)).pages)
    assert "EKSEMPELDATA" in text
    with zipfile.ZipFile(io.BytesIO(b.zip_bytes)) as z:
        assert "EKSEMPELDATA" in z.read("LAES-MIG.txt").decode()
    # Under the owner's OWN identity the same rows get no package at all.
    u2 = _owner(db)
    db.add(DailyClose(user_id=u2.id, date=date(2026, 9, 1), revenue_total=1250,
                      moms_total=250, status="confirmed", notes="Eksempeldag · demo"))
    db.commit()
    assert [c.date for c in rp.period_closes(db, u2, *SEP)] == []


def test_link_expires_and_tampering_is_refused(client, db, store, mailbox, monkeypatch):
    u = _owner(db)
    _seed_september(db, u, store)
    _as(u)
    client.post("/api/revisor-package/send", json={"start": "2026-09-01", "end": "2026-09-30", "key": "k3"})
    link = mailbox[0]["html"].split("href='", 1)[1].split("'", 1)[0]
    token = link.rsplit("/", 1)[1]
    app.dependency_overrides.pop(get_current_user, None)
    assert client.get(f"/api/public/revisor-package/{token[:-2]}xx").status_code == 404
    import time as _t
    real = _t.time
    monkeypatch.setattr("app.services.revisor_package.time.time", lambda: real() + 15 * 86400)
    r = client.get(f"/api/public/revisor-package/{token}")
    assert r.status_code == 410 and "udløbet" in r.text


def test_opted_out_revisor_and_demo_rows_are_refused(client, db, store, mailbox):
    from app.services import revisor_mail as rm
    u = _owner(db)
    p = db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).one()
    rm.record_opt_out(p, rm.address_fingerprint("pia@revisorhuset.dk"))
    db.commit()
    _as(u)
    r = client.post("/api/revisor-package/send", json={"start": "2026-09-01", "end": "2026-09-30", "key": "k4"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "accountant_opted_out"
    u2 = _owner(db)
    db.add(DailyClose(user_id=u2.id, date=date(2026, 9, 2), revenue_total=1, status="confirmed",
                      notes="sample · demo"))
    db.commit()
    _as(u2)
    r = client.post("/api/revisor-package/send", json={"start": "2026-09-01", "end": "2026-09-30", "key": "k5"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "demo_in_period"
    assert mailbox == []


def test_package_counts_toward_the_shared_revisor_daily_cap(db):
    from app.services.revisor_mail import REVISOR_SEND_ACTIONS
    assert rp.SEND_ACTION in REVISOR_SEND_ACTIONS


def test_members_cannot_read_the_package_prefix():
    import app.main as m
    assert "/api/revisor-package" in m._MEMBER_READ_DENY_PREFIXES


def test_standalone_summary_counts_bilag_without_reading_them(db, store):
    from pypdf import PdfReader
    u = _owner(db)
    _seed_september(db, u, store)
    b = rp.build_package(db, u, *SEP, now=NOW, include_bilag=False)
    text = "\n".join(p.extract_text() for p in PdfReader(io.BytesIO(b.summary_pdf)).pages)
    # 2 of the 4 booked business expenses carry a bilag (the draft and the
    # personal row are not booked business expenses).
    assert "2 af 4" in text.replace("\n", " ")
