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
    assert f"{fd['moms_af_salg']:.2f}" in moms_csv and f"{fd['moms_af_kob']:.2f}" in moms_csv
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


# ── Download (every tier) and send (the plan that sends) ─────────────

def test_free_owner_downloads_but_cannot_send(client, db, store, mailbox):
    u = _owner(db, plan="free")
    _seed_september(db, u, store)
    _as(u)
    r = client.get("/api/revisor-package/download", params={"start": "2026-09-01", "end": "2026-09-30"})
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert zipfile.ZipFile(io.BytesIO(r.content)).testzip() is None
    r = client.post("/api/revisor-package/send", json={"start": "2026-09-01", "end": "2026-09-30"})
    assert r.status_code == 402
    assert mailbox == []


def test_send_walls(client, db, store, mailbox):
    u = _owner(db, revisor=None)
    _as(u)
    body = {"start": "2026-09-01", "end": "2026-09-30"}
    r = client.post("/api/revisor-package/send", json=body)
    assert r.status_code == 400 and r.json()["detail"]["code"] == "no_accountant_email"
    u2 = _owner(db, verified=False)
    _as(u2)
    r = client.post("/api/revisor-package/send", json=body)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "email_unverified"
    assert mailbox == []
    r = client.post("/api/revisor-package/send", json={"start": "2026-01-01", "end": "2026-06-30"})
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
    assert (row.link_expires_at - row.sent_at) == timedelta(days=14)
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


def test_link_expires_and_tampering_is_refused(client, db, store, mailbox, monkeypatch):
    u = _owner(db)
    _seed_september(db, u, store)
    _as(u)
    client.post("/api/revisor-package/send", json={"start": "2026-09-01", "end": "2026-09-30"})
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
    r = client.post("/api/revisor-package/send", json={"start": "2026-09-01", "end": "2026-09-30"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "accountant_opted_out"
    u2 = _owner(db)
    db.add(DailyClose(user_id=u2.id, date=date(2026, 9, 2), revenue_total=1, status="confirmed",
                      notes="sample · demo"))
    db.commit()
    _as(u2)
    r = client.post("/api/revisor-package/send", json={"start": "2026-09-01", "end": "2026-09-30"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "demo_in_period"
    assert mailbox == []


def test_package_counts_toward_the_shared_revisor_daily_cap(db):
    from app.services.revisor_mail import REVISOR_SEND_ACTIONS
    assert rp.SEND_ACTION in REVISOR_SEND_ACTIONS


def test_members_cannot_read_the_package_prefix():
    import app.main as m
    assert "/api/revisor-package" in m._MEMBER_READ_DENY_PREFIXES
