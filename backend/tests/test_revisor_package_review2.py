"""Revisorpakke — the 12 Oct accountant-grade review (FIX-FIRST), one test per
finding. Each failed on b396283d.

B1  the standalone summary PDF claimed every bilag "kunne ikke hentes"
M1  an unclear / unfinished manual send was mailed again by the schedule
M2  unreadable bilag were no open item ("Ingen åbne punkter" over a missing file)
M3  §9 variances were never shown; gavekort points pointed at a document
    that is not in the package ("se momsangivelsen, afsnit D4")
M4  salg.csv carried faktura payments and exchanged sales (did not tie)
M7  a sent period that changed afterwards gave no signal; no correction
M8  a package over the link cap mailed nothing
minors 2 3 4 8 9 10 14 15 16 17
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import uuid
import zipfile
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import importlib as _il
import pkgutil as _pu
import app.models as _models
for _m in _pu.iter_modules(_models.__path__):
    _il.import_module(f"app.models.{_m.name}")

from app.database import Base, get_db
from app.main import app, _db_ready
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
from app.jobs import revisor_package_job as job

_db_ready.set()
_rp_limiter.enabled = False
CPH = ZoneInfo("Europe/Copenhagen")
SEP = (date(2026, 9, 1), date(2026, 9, 30))
OCT = (date(2026, 10, 1), date(2026, 10, 31))


def utc(y, m, d, hh=0, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=CPH).astimezone(ZoneInfo("UTC")).replace(tzinfo=None)


NOW = utc(2026, 10, 12, 11, 0)


class FakeStorage(storage_mod.StorageBackend):
    is_durable = True

    def __init__(self):
        self.blobs = {}

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
def factory(monkeypatch, tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path}/r2.db", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    SessionLocal = sessionmaker(bind=eng)
    import app.database as _dbm
    monkeypatch.setattr(_dbm, "SessionLocal", SessionLocal, raising=False)
    monkeypatch.setattr("app.services.billing.SessionLocal", SessionLocal, raising=False)
    return SessionLocal


@pytest.fixture
def db(factory):
    s = factory()
    yield s
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
    class _Box(list):
        pass
    sent = _Box()
    sent.mode = "ok"

    def _send(payload):
        if sent.mode == "timeout_after_accept":
            sent.append(payload)
            import requests
            raise requests.exceptions.ReadTimeout("read timed out")
        sent.append(payload)
        return {"id": f"m{len(sent)}"}

    monkeypatch.setattr("app.services.email_service.resend.Emails.send", _send)
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")
    return sent


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user


def _owner(db, *, schedule=None, since=None, open_days=None) -> User:
    u = User(email=f"ejer-{uuid.uuid4().hex[:6]}@cafe.dk", password_hash="x",
             business_name="Café Hygge", business_type="cafe", currency="DKK",
             plan="starter", email_verified=True, timezone="Europe/Copenhagen")
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(user_id=u.id, company_name="Café Hygge ApS", org_number="12345678",
                           address="Nørregade 1", zipcode="1165", city="København K",
                           accountant_email="pia@revisorhuset.dk", accountant_name="Pia",
                           revisor_package_schedule=schedule, revisor_package_schedule_at=since,
                           open_days_mask=open_days))
    db.commit()
    return u


def _cat(db, u, name="Varekøb"):
    c = ExpenseCategory(user_id=u.id, name=name)
    db.add(c); db.commit(); db.refresh(c)
    return c


def _month(db, u, store, *, year=2026, month=9, readable=2, unreadable=0, variance_day=None,
           skip_days=()):
    """Every day closed and locked; `readable` expenses with a stored bilag,
    `unreadable` with a forwarded file that is gone."""
    import calendar
    cat = _cat(db, u)
    for d in range(1, calendar.monthrange(year, month)[1] + 1):
        if d in skip_days:
            continue
        db.add(DailyClose(user_id=u.id, date=date(year, month, d), revenue_total=5000,
                          moms_total=1000, status="confirmed",
                          payment_categories="cash:1000|card:4000", payment_total=5000,
                          cash_expected=1000, cash_counted=1000, cash_difference=0))
    if variance_day:
        db.add(Sale(user_id=u.id, date=date(year, month, variance_day), amount=300,
                    status="completed", payment_method="card"))
    for i in range(readable):
        data = b"\xff\xd8\xff\xe0" + f"bilag{i}-{u.id}".encode()
        key = f"{u.id}/expense/{hashlib.sha256(data).hexdigest()}.jpg"
        store.put(key, data)
        db.add(Expense(user_id=u.id, category_id=cat.id, date=date(year, month, 2 + i),
                       amount=100 + i, description=f"Netto {i}", payment_method="card",
                       receipt_photo=key))
    for i in range(unreadable):
        db.add(Expense(user_id=u.id, category_id=cat.id, date=date(year, month, 10 + i),
                       amount=250 + i, description=f"Videresendt {i}", payment_method="card",
                       receipt_photo="uploads/receipts/" + f"{i + 1:064x}" + ".enc"))
    db.commit()
    return cat


def _pdf_text(data: bytes) -> str:
    from pypdf import PdfReader
    return " ".join(" ".join(p.extract_text().split()) for p in PdfReader(io.BytesIO(data)).pages)


def _zip(b) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(b.zip_bytes))


def _rows(z, name):
    return list(csv.reader(io.StringIO(z.read(name).decode("utf-8-sig")), delimiter=";"))


# ── B1 ───────────────────────────────────────────────────────────────

def test_B1_standalone_summary_does_not_call_unread_bilag_unreadable(client, db, store):
    u = _owner(db)
    _month(db, u, store, readable=3)
    _as(u)
    r = client.get("/api/revisor-package/summary.pdf", params={"start": "2026-09-01", "end": "2026-09-30"})
    assert r.status_code == 200
    text = _pdf_text(r.content)
    assert "3 af 3" in text
    assert "ikke kunne hentes" not in text                    # was "… 3"
    assert "Bilagsfilerne er ikke hentet i denne oversigt" in text


# ── M1 ───────────────────────────────────────────────────────────────

def _manual_send_on(factory, uid, mailbox, monkeypatch, *, mode, when):
    import app.routers.revisor_package as rr
    monkeypatch.setattr(rr, "utc_now", lambda: when)
    monkeypatch.setattr(rp, "utc_now", lambda: when)
    s = factory()

    def _get():
        yield s
    app.dependency_overrides[get_db] = _get
    user = s.query(User).filter(User.id == uid).first()
    app.dependency_overrides[get_current_user] = lambda: user
    mailbox.mode = mode
    r = TestClient(app).post("/api/revisor-package/send",
                             json={"start": "2026-10-01", "end": "2026-10-31", "key": "tap1"})
    app.dependency_overrides.clear()
    mailbox.mode = "ok"
    s.close()
    return r


def test_M1_an_unclear_manual_send_is_never_sent_again_by_the_schedule(factory, store, mailbox,
                                                                      monkeypatch):
    db = factory()
    u = _owner(db, schedule="monthly", since=utc(2026, 9, 1))
    _month(db, u, store, month=10)
    uid = u.id
    db.close()
    r = _manual_send_on(factory, uid, mailbox, monkeypatch, mode="timeout_after_accept",
                        when=utc(2026, 11, 1, 10, 0))
    assert r.status_code == 502 and r.json()["detail"]["code"] == "email_unclear"
    job.run_revisor_package_schedule(factory, now=utc(2026, 11, 3, 7, 20))
    job.run_revisor_package_schedule(factory, now=utc(2026, 11, 4, 7, 20))
    revisor = [m for m in mailbox if m["to"] == ["pia@revisorhuset.dk"]]
    assert len(revisor) == 1                                   # was 2


def test_M1_a_manual_send_in_progress_blocks_the_schedule(factory, store, mailbox):
    db = factory()
    u = _owner(db, schedule="monthly", since=utc(2026, 9, 1))
    _month(db, u, store, month=10)
    db.add(RevisorPackageSend(user_id=u.id, period_kind="month", period_start=OCT[0],
                              period_end=OCT[1], send_trigger="manual", dedup_key="manual:x",
                              status="claimed", attempts=1, created_at=utc(2026, 11, 3, 7, 10),
                              updated_at=utc(2026, 11, 3, 7, 10)))
    db.commit(); db.close()
    job.run_revisor_package_schedule(factory, now=utc(2026, 11, 3, 7, 20))
    assert [m for m in mailbox if m["to"] == ["pia@revisorhuset.dk"]] == []


# ── M2 ───────────────────────────────────────────────────────────────

def test_M2_a_bilag_that_could_not_be_fetched_is_an_open_item_everywhere(db, store):
    from app.services.revisor_mail import esc
    u = _owner(db)
    _month(db, u, store, readable=2, unreadable=1)
    b = rp.build_package(db, u, *SEP, now=NOW)
    st = rp.checklist_status(b.checklist)
    line = next(x for x in st["open"] if "bilag kunne ikke hentes" in x)
    assert st["title"].startswith("Åbne punkter (1)")          # was "Ingen åbne punkter …"
    assert "Videresendt 0" in line
    z = _zip(b)
    readme = z.read("LAES-MIG.txt").decode()
    assert line in readme and st["title"] in readme
    html = rp.package_email_html(biz="Café Hygge ApS", cvr="12345678", accountant_name="Pia",
                                 label="september 2026", build=b, url="https://x.test/p",
                                 expires=date(2026, 10, 26))
    assert esc(line) in html
    assert " ".join(line.split()) in _pdf_text(b.summary_pdf)
    idx = _rows(z, "bilag-oversigt.csv")
    assert any("ÅBENT PUNKT: kunne ikke hentes" in r[-1] for r in idx[1:])
    b.close()


# ── M3 ───────────────────────────────────────────────────────────────

def test_M3_a_kasserapport_variance_is_an_open_item_in_the_angivelses_words(db, store):
    from app.services.tax_filing_pdf import VARIANCE_D3_INTRO_DA
    u = _owner(db)
    _month(db, u, store, variance_day=7)
    b = rp.build_package(db, u, *SEP, now=NOW)
    assert b.fd["variance_warnings"]
    st = rp.checklist_status(b.checklist)
    line = next(x for x in st["open"] if x.startswith(VARIANCE_D3_INTRO_DA))
    assert "Bogføringsloven §9 stk. 2" in line and "7. sep." in line
    assert "kasserapport 5.000,00 kr." in line and "POS-salg 300,00 kr." in line
    pdf = _pdf_text(b.summary_pdf)
    assert "KASSERAPPORT OG POS-SALG" in pdf and " ".join(VARIANCE_D3_INTRO_DA.split()) in pdf
    b.close()


def test_M3_gavekort_points_carry_the_d4_note_and_never_point_at_the_angivelse(db, store):
    from app.models.gift_card import GiftCard, GiftCardTransaction
    from app.services.tax_filing_pdf import GAVEKORT_NOTES_DA
    u = _owner(db)
    _month(db, u, store)
    card = GiftCard(user_id=u.id, code_hash="h" * 64, short_code="GK-TEST-0001-X",
                    code_last4="0001", face_value_minor=25000, balance_minor=0,
                    voucher_class="mpv", status="active", payment_method="cash",
                    issued_at=datetime(2026, 8, 20, 12, 0))
    db.add(card); db.commit(); db.refresh(card)
    db.add(GiftCardTransaction(gift_card_id=card.id, user_id=u.id, kind="issue", amount_minor=25000,
                               balance_after_minor=25000, created_at=datetime(2026, 8, 20, 12, 0)))
    db.add(GiftCardTransaction(gift_card_id=card.id, user_id=u.id, kind="redeem", amount_minor=-25000,
                               balance_after_minor=0, business_day=datetime(2026, 9, 22),
                               idempotency_key="r1", created_at=datetime(2026, 9, 22, 12, 0)))
    db.commit()
    b = rp.build_package(db, u, *SEP, now=NOW)
    st = rp.checklist_status(b.checklist)
    line = next(x for x in st["open"] if "gavekort-punkt" in x)
    assert GAVEKORT_NOTES_DA["unverified_redemption"] in line and "22. sep." in line
    readme = _zip(b).read("LAES-MIG.txt").decode()
    html = rp.package_email_html(biz="X", cvr=None, accountant_name=None, label="september 2026",
                                 build=b, url="https://x.test/p", expires=date(2026, 10, 26))
    for doc in (_pdf_text(b.summary_pdf), readme, html):
        assert "afsnit D4" not in doc or "samme punkter som momsangivelsens afsnit D4" in doc
        assert "se momsangivelsen" not in doc
    b.close()


# ── M4 ───────────────────────────────────────────────────────────────

def test_M4_salg_csv_ties_to_the_package_revenue_to_the_ore(db, store):
    from app.models.customer import Customer
    from app.models.invoice import Invoice
    u = _owner(db)
    _month(db, u, store, skip_days=(5, 19))
    cust = Customer(user_id=u.id, name="Firma A/S", cvr="87654321", is_company=True)
    db.add(cust); db.commit(); db.refresh(cust)
    inv = Invoice(user_id=u.id, customer_id=cust.id, fakturanummer=1, issue_date=date(2026, 9, 18),
                  due_date=date(2026, 10, 2), status="paid", subtotal_net=10000, moms_total=2500,
                  total_gross=12500)
    db.add(inv); db.commit(); db.refresh(inv)
    d = date(2026, 9, 19)
    db.add_all([
        Sale(user_id=u.id, date=d, amount=450, status="completed", payment_method="card", item_name="Brunch"),
        Sale(user_id=u.id, date=d, amount=100, status="completed", payment_method="cash",
             item_name="Pant", is_tax_exempt=True),
        Sale(user_id=u.id, date=d, amount=75, status="returned", payment_method="card", item_name="Retur"),
        Sale(user_id=u.id, date=d, amount=60, status="exchanged", payment_method="card", item_name="Byttet"),
        Sale(user_id=u.id, date=date(2026, 9, 5), amount=12500, status="completed",
             payment_method="mobilepay", item_name="Indbetaling faktura 1", invoice_id=inv.id),
    ])
    db.commit()
    b = rp.build_package(db, u, *SEP, now=NOW)
    z = _zip(b)
    lines = _rows(z, "salg.csv")[1:]
    total = round(sum(float(r[3].replace(",", ".")) for r in lines), 2)
    assert total == b.revenue_total == 28 * 5000 + 450 + 100        # was + 12.500 + 60
    texts = " ".join(r[2] for r in lines)
    assert "Indbetaling faktura" not in texts and "Byttet" not in texts and "Retur" not in texts
    readme = z.read("LAES-MIG.txt").decode()
    assert re.search(r"salg\.csv i alt: 140\.550,00 kr\. = omsætning i alt .*140\.550,00 kr\.",
                     " ".join(readme.split()))
    assert "byttede salg" in readme and "fakturaer.csv" in readme
    b.close()


# ── M7 ───────────────────────────────────────────────────────────────

def test_M7_a_sent_period_that_changes_says_so_and_is_resent_as_a_rettelse(client, db, store, mailbox):
    u = _owner(db)
    cat = _month(db, u, store)
    draft = Expense(user_id=u.id, category_id=cat.id, date=date(2026, 9, 15), amount=1250,
                    description="Inco", payment_method="card", status="pending",
                    receipt_photo=f"{u.id}/expense/{'ee' * 32}.jpg")
    db.add(draft); db.commit()
    _as(u)
    body = {"start": "2026-09-01", "end": "2026-09-30"}
    assert client.post("/api/revisor-package/send", json={**body, "key": "k1"}).status_code == 200
    first = db.query(RevisorPackageSend).one()
    assert first.figures_fp and json.loads(first.figures_json)["moms_af_kob"] == 40.2
    cl = client.get("/api/revisor-package/checklist", params=body).json()
    assert cl["sent_package"]["changed"] is False
    assert client.post(f"/api/expenses/{draft.id}/approve").status_code == 200
    cl = client.get("/api/revisor-package/checklist", params=body).json()
    sp = cl["sent_package"]
    assert sp["changed"] is True and sp["recipient"] == "pia@revisorhuset.dk"
    assert {"key": "moms_af_kob", "before": 40.2, "after": 290.2} in sp["changes"]
    # A second send of the period needs the owner's confirmation …
    r = client.post("/api/revisor-package/send", json={**body, "key": "k2"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_sent"
    assert len([m for m in mailbox if m["to"] == ["pia@revisorhuset.dk"]]) == 1
    # … and then it goes as a RETTELSE.
    r = client.post("/api/revisor-package/send", json={**body, "key": "k2", "resend": True})
    assert r.status_code == 200, r.text
    mail = [m for m in mailbox if m["to"] == ["pia@revisorhuset.dk"]][-1]
    assert mail["subject"].startswith("RETTELSE: Revisorpakke september 2026")
    assert "RETTELSE — erstatter pakken" in mail["html"]
    assert "Købsmoms: 40,20 kr. → 290,20 kr." in mail["html"]
    import base64
    pdf = base64.b64decode(mail["attachments"][0]["content"])
    assert "REVISORPAKKE · RETTELSE" in _pdf_text(pdf)
    second = db.query(RevisorPackageSend).filter(RevisorPackageSend.dedup_key == "manual:k2").one()
    assert second.is_correction is True


def test_M7_the_schedule_never_sends_a_correction(factory, store, mailbox):
    db = factory()
    u = _owner(db, schedule="monthly", since=utc(2026, 9, 1))
    cat = _month(db, u, store, month=10)
    uid, cid = u.id, cat.id
    db.close()
    job.run_revisor_package_schedule(factory, now=utc(2026, 11, 3, 7, 20))
    db = factory()
    db.add(Expense(user_id=uid, category_id=cid, date=date(2026, 10, 20), amount=900,
                   description="Glemt bilag", payment_method="card"))
    db.commit(); db.close()
    for when in (utc(2026, 11, 3, 8, 20), utc(2026, 11, 10, 7, 20), utc(2026, 11, 30, 7, 20)):
        job.run_revisor_package_schedule(factory, now=when)
    assert len([m for m in mailbox if m["to"] == ["pia@revisorhuset.dk"]]) == 1


# ── M8 ───────────────────────────────────────────────────────────────

def test_M8_a_phone_receipt_is_stored_small_and_stays_legible():
    from tests.receipt_photo_fixture import read_back, receipt_photo
    data, layout = receipt_photo(seed=7)
    small, ext, did = rp.reencode_for_package(data, "jpg")
    from PIL import Image
    im = Image.open(io.BytesIO(small))
    assert did and ext == "jpg" and max(im.size) == rp.BILAG_LONG_EDGE
    assert len(small) < len(data) / 10                        # 4–5 MB → ~0,1 MB
    res = read_back(small, layout)
    ok, total = res["alnum"]
    assert ok == total, res["misreads"]                       # every letter and digit
    ok_all, all_ = res["all"]
    assert ok_all / all_ >= 0.99


def test_M8_a_package_over_the_cap_goes_in_parts_with_one_link_each(client, db, store, mailbox,
                                                                   monkeypatch):
    from tests.receipt_photo_fixture import receipt_photo
    u = _owner(db)
    cat = _month(db, u, store, readable=0)
    for i in range(4):
        data, _ = receipt_photo(seed=20 + i)
        key = f"{u.id}/expense/{hashlib.sha256(data).hexdigest()}.jpg"
        store.put(key, data)
        db.add(Expense(user_id=u.id, category_id=cat.id, date=date(2026, 9, 3 + i), amount=200 + i,
                       description=f"Hørkram {i}", payment_method="card", receipt_photo=key))
    db.commit()
    # A cap of ~1,5 bilag: forces three parts from four re-encoded photos.
    monkeypatch.setattr(rp, "MAX_LINK_ZIP_BYTES", 200 * 1024)
    monkeypatch.setattr(rp, "_PART1_RESERVE", 60 * 1024)
    monkeypatch.setattr(rp, "_PART_RESERVE", 1024)
    _as(u)
    r = client.post("/api/revisor-package/send",
                    json={"start": "2026-09-01", "end": "2026-09-30", "key": "big"})
    assert r.status_code == 200, r.text
    mail = [m for m in mailbox if m["to"] == ["pia@revisorhuset.dk"]][0]
    assert mail["attachments"][0]["filename"] == "Oversigt_2026-09.pdf"   # always the PDF
    links = re.findall(r"href='([^']*/api/public/revisor-package/[^']+)'", mail["html"])
    row = db.query(RevisorPackageSend).one()
    parts = json.loads(row.parts_json)
    assert len(parts) >= 2 and len(links) == len(parts)
    assert f"Hent del 1 af {len(parts)} (ZIP)" in mail["html"]
    app.dependency_overrides.pop(get_current_user, None)
    names = []
    for i, link in enumerate(links, start=1):
        g = client.get("/api/public/revisor-package/" + link.rsplit("/", 1)[1])
        assert g.status_code == 200 and len(g.content) <= 200 * 1024
        assert hashlib.sha256(g.content).hexdigest() == parts[i - 1]["sha256"]
        z = zipfile.ZipFile(io.BytesIO(g.content))
        names += [n for n in z.namelist() if n.startswith("bilag/")]
        assert "manifest.txt" in z.namelist()
        if i == 1:
            assert "Oversigt_2026-09.pdf" in z.namelist() and "udgifter.csv" in z.namelist()
    assert len(names) == len(set(names)) == 4                    # every bilag, once


def test_M8_150_receipts_fit_in_one_link(db, store):
    """150 phone receipts (4–5 MB each, ≈ 700 MB) — before: over the cap,
    nothing mailed. Now one ZIP well under the cap."""
    from tests.receipt_photo_fixture import receipt_photo
    u = _owner(db)
    cat = _month(db, u, store, readable=0)
    base, _ = receipt_photo(seed=99)
    for i in range(150):
        data = base + i.to_bytes(2, "big")                    # 150 distinct files
        key = f"{u.id}/expense/{hashlib.sha256(data).hexdigest()}.jpg"
        store.put(key, data)
        db.add(Expense(user_id=u.id, category_id=cat.id, date=date(2026, 9, 1 + i % 30),
                       amount=100 + i, description=f"Leverandør {i}", payment_method="card",
                       receipt_photo=key))
    db.commit()
    originals = 150 * len(base)
    b = rp.build_package(db, u, *SEP, now=NOW, split_bytes=rp.MAX_LINK_ZIP_BYTES)
    try:
        assert originals > 600 * 1024 * 1024
        assert len(b.parts) == 1 and b.zip_size < rp.MAX_LINK_ZIP_BYTES
        assert b.n_bilag == 150 and b.n_reencoded == 150
    finally:
        b.close()


# ── minor 2 · 3 · 4 · 10 · 15 · 16 · 17 ─────────────────────────────

def test_minor2_every_csv_is_danish_excel(db, store):
    from app.models.customer import Customer
    from app.models.invoice import Invoice
    u = _owner(db)
    _month(db, u, store)
    cust = Customer(user_id=u.id, name="Firma A/S", cvr="87654321", is_company=True)
    db.add(cust); db.commit(); db.refresh(cust)
    db.add(Invoice(user_id=u.id, customer_id=cust.id, fakturanummer=1, issue_date=date(2026, 9, 18),
                   due_date=date(2026, 10, 2), status="paid", subtotal_net=10000, moms_total=2500,
                   total_gross=12500))
    db.commit()
    b = rp.build_package(db, u, *SEP, now=NOW)
    z = _zip(b)
    csvs = [n for n in z.namelist() if n.endswith(".csv")]
    assert {"fakturaer.csv", "gavekort.csv", "moms-oversigt.csv"} <= set(csvs)
    for n in csvs:
        raw = z.read(n)
        assert raw.startswith(b"\xef\xbb\xbf"), n
        head = raw.decode("utf-8-sig").splitlines()[0]
        assert ";" in head and "," not in head.replace(", ", ""), (n, head)
        assert not re.search(r"(?<![\d,])\d+\.\d{2}(?!\d)", raw.decode("utf-8-sig")), n
    fak = _rows(z, "fakturaer.csv")
    assert fak[0][:3] == ["Fakturanr.", "Fakturadato", "Forfaldsdato"]
    assert fak[1][10] == "12500,00" and fak[1][12] == "Betalt"
    readme = z.read("LAES-MIG.txt").decode()
    assert "Alle CSV-filer er i dansk Excel-format" in readme
    b.close()


def test_minor3_lon_and_forsikring_are_no_vat_not_zero_fradrag(db, store):
    u = _owner(db)
    _month(db, u, store)
    lon, fors, repr_ = _cat(db, u, "Løn"), _cat(db, u, "Forsikring"), _cat(db, u, "Repræsentation")
    for c, amt in ((lon, 20000), (fors, 1234), (repr_, 399)):
        db.add(Expense(user_id=u.id, category_id=c.id, date=date(2026, 9, 9), amount=amt,
                       description=c.name, payment_method="bank_transfer"))
    db.commit()
    b = rp.build_package(db, u, *SEP, now=NOW)
    rows = {r[3]: r[6] for r in _rows(_zip(b), "udgifter.csv")[1:]}
    assert rows["Løn"] == "Ingen moms (løn/forsikring)"          # was "25 % — 0 % fradrag"
    assert rows["Forsikring"] == "Ingen moms (løn/forsikring)"
    assert rows["Repræsentation"] == "25 % — 0 % fradrag (§42 stk. 1)"
    pdf = _pdf_text(b.summary_pdf)
    assert "Løn 1 20.000,00 kr. ingen moms" in pdf
    b.close()


def test_minor4_a_draft_close_day_counted_from_its_sales_says_so(db, store):
    u = _owner(db)
    _month(db, u, store)
    c = db.query(DailyClose).filter(DailyClose.date == date(2026, 9, 14)).first()
    c.status = "draft"
    db.add(Sale(user_id=u.id, date=date(2026, 9, 14), amount=700, status="completed",
                payment_method="card"))
    db.commit()
    b = rp.build_package(db, u, *SEP, now=NOW)
    row = [r for r in _rows(_zip(b), "omsaetning-pr-dag.csv") if r[0] == "2026-09-14"][0]
    assert row[2] == "700,00"
    assert row[3] == "Salg — dagsafslutningen er en kladde og er ikke medregnet"
    b.close()


def test_minor10_readme_heading_is_the_pdf_and_mail_heading(db, store):
    u = _owner(db)
    _month(db, u, store, skip_days=(3,))
    b = rp.build_package(db, u, *SEP, now=NOW)
    st = rp.checklist_status(b.checklist)
    readme = _zip(b).read("LAES-MIG.txt").decode().splitlines()
    assert st["title"] in readme and "ÅBNE PUNKTER" not in readme
    b.close()


def test_minor15_payments_over_revenue_explain_gift_cards_sold_at_the_till(db, store):
    u = _owner(db)
    _month(db, u, store)
    c = db.query(DailyClose).filter(DailyClose.date == date(2026, 9, 5)).first()
    c.payment_categories = "cash:1500|card:4000"          # 500 more than the day's revenue
    c.payment_total = 5500
    db.commit()
    b = rp.build_package(db, u, *SEP, now=NOW)
    pdf = _pdf_text(b.summary_pdf)
    assert "Betalinger over omsætningen (se note)" in pdf
    assert "typisk gavekort solgt ved kassen" in pdf
    b.close()


def test_minor16_bilag_files_are_named_after_the_supplier(db, store):
    from app.models.vendor_profile import VendorProfile
    u = _owner(db)
    cat = _month(db, u, store, readable=0)
    data = b"\xff\xd8\xff\xe0hoerkram"
    key = f"{u.id}/expense/{hashlib.sha256(data).hexdigest()}.jpg"
    store.put(key, data)
    db.add(Expense(user_id=u.id, category_id=cat.id, date=date(2026, 9, 3), amount=2345.67,
                   description="Faktura 88123 — kolonialvarer", payment_method="card",
                   receipt_photo=key, vendor_key="horkram"))
    db.add(VendorProfile(user_id=u.id, vendor_key="horkram", display_name="Hørkram",
                         field="category_name", value="Varekøb"))
    db.commit()
    b = rp.build_package(db, u, *SEP, now=NOW)
    assert "bilag/2026-09-03_Hoerkram_2345,67.jpg" in _zip(b).namelist()
    b.close()


def test_minor17_days_without_a_close_say_closed_days_count_when_opening_days_are_unset(db, store):
    u = _owner(db)
    _month(db, u, store, skip_days=(7, 14))
    b = rp.build_package(db, u, *SEP, now=NOW)
    line = next(x for x in rp.checklist_status(b.checklist)["open"] if "uden dagsafslutning" in x)
    assert "åbningsdage er ikke angivet i BonBox, så lukkedage tælles med" in line
    b.close()
    u2 = _owner(db, open_days="1234567")
    _month(db, u2, store, skip_days=(7,))
    b2 = rp.build_package(db, u2, *SEP, now=NOW)
    line2 = next(x for x in rp.checklist_status(b2.checklist)["open"] if "uden dagsafslutning" in x)
    assert "åbningsdage er ikke angivet" not in line2
    b2.close()


# ── minor 8 · 9 · 14 ─────────────────────────────────────────────────

def test_minor8_a_send_needs_a_key_and_a_resend_a_confirmation(client, db, store, mailbox):
    u = _owner(db)
    _month(db, u, store)
    _as(u)
    body = {"start": "2026-09-01", "end": "2026-09-30"}
    assert client.post("/api/revisor-package/send", json=body).status_code == 422
    assert client.post("/api/revisor-package/send", json={**body, "key": "a"}).status_code == 200
    r = client.post("/api/revisor-package/send", json={**body, "key": "b"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_sent"
    assert "Bekræft for at sende den igen" in r.json()["detail"]["message_da"]
    assert len([m for m in mailbox if m["to"] == ["pia@revisorhuset.dk"]]) == 1


def test_minor9_the_card_gets_the_real_run_time_and_the_owners_zone(client, db, monkeypatch):
    import app.routers.revisor_package as rr
    u = _owner(db, schedule="monthly", since=utc(2026, 10, 5))   # after September fell due
    monkeypatch.setattr(rr, "utc_now", lambda: utc(2026, 10, 12, 10, 0))
    _as(u)
    nxt = client.get("/api/revisor-package/settings").json()["next"]
    assert nxt["due_at"] == utc(2026, 11, 3, 7, 0).isoformat() + "Z"
    assert nxt["run_at"] == utc(2026, 11, 3, 7, 20).isoformat() + "Z"       # the job's :20
    assert nxt["tz"] == "Europe/Copenhagen"


def test_minor9_history_dates_are_the_owners_local_dates(db):
    u = _owner(db)
    sent = utc(2026, 11, 3, 0, 30)                    # 00:30 local on 3 Nov = 2 Nov 23:30 UTC
    db.add(RevisorPackageSend(user_id=u.id, period_kind="month", period_start=OCT[0],
                              period_end=OCT[1], send_trigger="scheduled", dedup_key="sched:x",
                              status="sent", attempts=1, sent_at=sent, created_at=sent))
    db.commit()
    (x,) = rp.last_sends(db, u)
    assert x["sent_at"].startswith("2026-11-02") and x["sent_on"] == "2026-11-03"


def test_minor14_a_send_that_fails_after_the_upload_leaves_no_zip(client, db, store, mailbox,
                                                                monkeypatch):
    u = _owner(db)
    _month(db, u, store)

    def boom(*a, **k):
        raise RuntimeError("template broke")
    monkeypatch.setattr(rp, "package_email_html", boom)
    _as(u)
    r = client.post("/api/revisor-package/send",
                    json={"start": "2026-09-01", "end": "2026-09-30", "key": "x"})
    assert r.status_code == 502 and mailbox == []
    assert not [k for k in store.blobs if "/revisor_package/" in k]     # was: the ZIP stayed
