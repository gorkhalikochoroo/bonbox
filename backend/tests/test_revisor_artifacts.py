"""Revisor-facing artifacts — what the revisor actually opens and receives.

These tests READ THE CONTENT of the generated files (openpyxl for the xlsx, the
csv module for the CSV, pypdf for the PDFs) — a size or magic-bytes check is no
proof that a total is right. Every send is stubbed: no test reaches Resend.

Stage 1 — money & safety:
  · Excel totals exclude drafts and equal the Oversigt sheet, the range PDF and
    the e-mail body for the same period (one source of truth: period_totals).
  · The default CSV parses with ";" and a decimal comma in Danish Excel.
  · A staff-typed "<b>" Lukket af is escaped in the revisor mail HTML.
  · send-to-accountant only mails the SAVED revisor address and has a daily cap.
"""
from __future__ import annotations

import csv
import io
import re
import uuid
from datetime import date, datetime, timedelta
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register all models
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose, encode_breakdown
from app.models.user import User
from app.services.auth import create_access_token, hash_password
from app.services.daily_close_range_export import (
    build_daily_close_range_pdf,
    build_daily_close_range_xlsx,
    closes_to_csv_bytes,
    period_totals,
)
from app.utils.time import utc_now

_db_ready.set()


# ─── Content readers ──────────────────────────────────────────────────


def pdf_text(pdf_bytes: bytes) -> str:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(pdf_bytes))
    return "\n".join((p.extract_text() or "") for p in reader.pages)


def _eval_sumifs(ws, formula: str) -> float:
    """Evaluate the one formula shape the workbook writes:
    =SUMIFS(D2:D9,$T$2:$T$9,"Låst") — sum the column where Status matches."""
    m = re.fullmatch(
        r'=SUMIFS\(([A-Z]+)(\d+):([A-Z]+)(\d+),\$([A-Z]+)\$(\d+):\$([A-Z]+)\$(\d+),"([^"]+)"\)',
        formula,
    )
    assert m, f"unexpected totals formula: {formula}"
    col, r1, _, r2, scol, _s1, _, _s2, crit = m.groups()
    total = 0.0
    for r in range(int(r1), int(r2) + 1):
        if ws[f"{scol}{r}"].value == crit:
            v = ws[f"{col}{r}"].value
            if isinstance(v, (int, float)):
                total += v
    return round(total, 2)


# ─── Builders ─────────────────────────────────────────────────────────


def _close(d, rev, moms, *, status="confirmed", pay=None, cats=None, **kw):
    base = dict(
        id=uuid.uuid4(), user_id=uuid.uuid4(), branch_id=None, date=d,
        revenue_categories=encode_breakdown(cats if cats is not None else {"food": rev}),
        revenue_total=rev,
        payment_categories=encode_breakdown(pay if pay is not None else {"cash": rev}),
        payment_total=rev, moms_total=moms,
        revenue_ex_moms=(round(rev - moms, 2) if moms is not None else None),
        moms_mode="auto",
        cash_expected=(pay or {"cash": rev}).get("cash"),
        cash_counted=(pay or {"cash": rev}).get("cash"),
        cash_difference=0.0, tips_total=None, tips_staff_count=None,
        tips_per_person=None, status=status, notes=None, closed_by="Lars",
        closed_at=datetime(2026, 9, 25, 23, 28) if status == "confirmed" else None,
        is_deleted=False,
    )
    base.update(kw)
    return DailyClose(**base)


def _sep_period():
    """Two locked days and a draft day with a big figure — the shape of the
    rating's September export (a 30.053 kr. draft summed into 'bekræftede')."""
    return [
        _close(date(2026, 9, 24), 1000.0, 200.0),
        _close(date(2026, 9, 25), 2500.0, 500.0,
               pay={"cash": 500.0, "card": 1500.0, "gift_card": 500.0}),
        _close(date(2026, 9, 26), 30053.0, 6010.6, status="draft"),
    ]


# ─── 1. Excel totals exclude drafts and equal every other artifact ────


def test_xlsx_totals_row_excludes_drafts_and_equals_oversigt_pdf_and_mail():
    from openpyxl import load_workbook
    from app.routers.daily_close import _accountant_email_body

    closes = _sep_period()
    f, t = date(2026, 9, 1), date(2026, 9, 30)
    wb = load_workbook(io.BytesIO(build_daily_close_range_xlsx(
        closes, from_date=f, to_date=t, business_name="Mirabelle ApS", currency="DKK")))

    ws = wb["Kasserapport"]
    header = [ws.cell(row=1, column=i).value for i in range(1, ws.max_column + 1)]
    assert header[19] == "Status"
    # The draft is LISTED, and marked.
    statuses = [ws.cell(row=r, column=20).value for r in range(2, 5)]
    assert statuses == ["Låst", "Låst", "Kladde (ikke medregnet)"]
    totals_row = 5
    assert ws.cell(row=totals_row, column=1).value.startswith("I alt (låste")
    rev_formula = ws.cell(row=totals_row, column=4).value
    moms_formula = ws.cell(row=totals_row, column=5).value
    assert "SUMIFS" in rev_formula and "SUMIFS" in moms_formula
    excel_rev = _eval_sumifs(ws, rev_formula)
    excel_moms = _eval_sumifs(ws, moms_formula)
    excel_gift = _eval_sumifs(ws, ws.cell(row=totals_row, column=10).value)

    # Oversigt — the same numbers.
    s1 = wb["Oversigt"]
    kv = {s1.cell(row=r, column=1).value: s1.cell(row=r, column=2).value
          for r in range(1, s1.max_row + 1)}
    assert kv["Omsætning i alt"] == excel_rev == 3500.0
    assert kv["Salgsmoms i alt"] == excel_moms == 700.0
    assert kv["Låste lukninger (medregnet)"] == 2
    assert kv["Kladder (ikke medregnet)"] == 1
    assert excel_gift == 500.0 and kv["Gavekort"] == 500.0

    # Range PDF — the same numbers.
    txt = pdf_text(build_daily_close_range_pdf(
        closes, from_date=f, to_date=t, business_name="Mirabelle ApS", currency="DKK"))
    assert "3.500,00 kr." in txt and "700,00 kr." in txt
    assert "30.053,00 kr." in txt   # the draft row is listed…
    assert "33.553" not in txt       # …but never summed with the locked days

    # E-mail body — the same numbers, and the draft is named.
    html = _accountant_email_body(
        business_name="Mirabelle ApS", from_date=f, to_date=t,
        totals=period_totals(closes), currency="DKK", fmt="xlsx",
        message=None, is_danish=True, attachment_name="Kasserapporter x.xlsx")
    assert "3.500,00 kr." in html and "700,00 kr." in html
    assert "1 kladde i perioden er ikke låst" in html
    assert "33.553" not in html


def test_xlsx_money_format_is_invariant_and_columns_are_wide_enough():
    """'#.##0,00' made Excel show '15021,000 kr.' and '####'. The invariant
    code is localised by Excel to '15.021,00 kr.' on a Danish machine."""
    from openpyxl import load_workbook
    raw = build_daily_close_range_xlsx(
        [_close(date(2026, 9, 1), 1234567.89, 246913.58)],
        from_date=date(2026, 9, 1), to_date=date(2026, 9, 30),
        business_name="Cafe", currency="DKK")
    wb = load_workbook(io.BytesIO(raw))
    ws = wb["Kasserapport"]
    assert ws.cell(row=2, column=4).number_format == '#,##0.00" kr."'
    assert ws.cell(row=3, column=4).number_format == '#,##0.00" kr."'
    assert ws.column_dimensions["D"].width >= 16  # "1.234.567,89 kr."
    import zipfile
    styles = zipfile.ZipFile(io.BytesIO(raw)).read("xl/styles.xml").decode()
    assert "#.##0,00" not in styles


# ─── 2. The CSV opens correctly in Danish Excel ───────────────────────


def test_default_csv_parses_with_semicolon_and_decimal_comma():
    raw = closes_to_csv_bytes(_sep_period(), currency="DKK")
    assert raw.startswith("﻿".encode("utf-8"))
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig")), delimiter=";"))
    header = rows[0]
    # Danish headers, no raw DB field names, no internal ids / storage keys.
    assert header[:4] == ["Dato", "Status", "Afdeling", "Omsætning inkl. moms"]
    for raw_name in ("revenue_total", "branch_id", "receipt_photo", "moms_total"):
        assert raw_name not in header
    money_cols = [i for i, h in enumerate(header) if h in (
        "Omsætning inkl. moms", "Salgsmoms", "Omsætning ekskl. moms", "Kontant",
        "Kort", "Gavekort", "Betalinger i alt", "Kassedifference")]
    for row in rows[1:]:
        for i in money_cols:
            cell = row[i]
            assert cell == "" or re.fullmatch(r"-?\d+,\d{2}", cell), (header[i], cell)
            assert not re.fullmatch(r"-?\d+\.\d{2}", cell)
    body = {r[0]: r for r in rows[1:-1]}
    assert body["2026-09-26"][1] == "Kladde (ikke medregnet)"
    # Totals row: locked closes only, parses back to the period total.
    total = rows[-1]
    assert total[1].startswith("I alt — 2 låste") and "1 kladde ikke medregnet" in total[1]
    assert float(total[3].replace(",", ".")) == 3500.0
    assert float(total[4].replace(",", ".")) == 700.0
    # Same figure as every other artifact.
    assert period_totals(_sep_period())["revenue"] == 3500.0


def test_machine_csv_is_only_behind_an_explicit_variant():
    default = closes_to_csv_bytes([_close(date(2026, 9, 1), 15021.0, 3004.2)]).decode("utf-8-sig")
    machine = closes_to_csv_bytes([_close(date(2026, 9, 1), 15021.0, 3004.2)],
                                  variant="machine").decode("utf-8-sig")
    assert "15021,00" in default and "15021.00" not in default
    assert machine.splitlines()[0].startswith("date;status;revenue_total")
    assert "15021.00" in machine


# ─── 4. Escaping user text in the revisor mail ────────────────────────


class _Row:
    def __init__(self, **kw):
        self.id = uuid.uuid4()
        self.date = date(2026, 9, 25)
        self.status = "confirmed"
        self.closed_at = datetime(2026, 9, 25, 23, 28)
        self.revenue_categories = "food:10000"
        self.revenue_total = 10000.0
        self.payment_categories = "cash:10000"
        self.payment_total = 10000.0
        self.moms_total = 2000.0
        self.revenue_ex_moms = 8000.0
        self.moms_mode = "auto"
        self.cash_counted = 10000.0
        self.cash_expected = 10000.0
        self.cash_difference = 0.0
        self.tips_total = None
        for k, v in kw.items():
            setattr(self, k, v)


def test_lock_mail_escapes_a_b_tag_in_lukket_af_and_the_business_name():
    from app.routers.daily_close import _build_close_email_html
    subject, html = _build_close_email_html(
        business_name='Café <img src="https://x.invalid/p.gif">', dc=_Row(),
        currency="DKK", closed_by="<b>Lars</b><a href='https://x.invalid'>bilag</a>",
        has_scan=False, scan_degraded=False, is_danish=True,
    )
    assert "&lt;b&gt;Lars&lt;/b&gt;" in html
    assert "<b>Lars" not in html
    assert "<a href='https://x.invalid'" not in html
    assert "<img" not in html
    assert "\n" not in subject and "\r" not in subject


def test_period_mail_escapes_business_name_and_message():
    from app.routers.daily_close import _accountant_email_body
    html = _accountant_email_body(
        business_name="<b>Evil</b>", from_date=date(2026, 9, 1), to_date=date(2026, 9, 30),
        totals=period_totals(_sep_period()), currency="DKK", fmt="pdf",
        message="<script>x</script>", is_danish=True)
    assert "<b>Evil</b>" not in html and "&lt;b&gt;Evil&lt;/b&gt;" in html
    assert "<script>" not in html


# ─── 5. send-to-accountant mails the saved revisor only ───────────────


@pytest.fixture
def db_session(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

    def _override_get_db():
        try:
            yield s
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    monkeypatch.setattr("app.services.billing.SessionLocal", SessionLocal, raising=False)
    import app.database as _db_mod
    monkeypatch.setattr(_db_mod, "SessionLocal", SessionLocal, raising=False)
    from app.routers import daily_close as _dc
    _dc._limiter.reset()
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)
        _dc._limiter.reset()


@pytest.fixture
def client():
    yield TestClient(app)
    app.dependency_overrides.clear()


def _make_user(db, *, plan="starter", email="anders@mirabelle.dk"):
    u = User(
        email=email, password_hash=hash_password("x"),
        business_name="Mirabelle Café", business_type="restaurant",
        currency="DKK", plan=plan, auto_email_on_close=True,
        email_verified=True, created_at=utc_now() - timedelta(days=2),
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _make_profile(db, user, **kw):
    p = BusinessProfile(
        user_id=user.id, company_name="Mirabelle ApS", org_number="39842851",
        country="DK", email="owner@mirabelle.dk",
        accountant_email=kw.pop("accountant_email", "anna@revisor.dk"),
        accountant_name=kw.pop("accountant_name", "Anna"),
        **kw,
    )
    db.add(p); db.commit(); db.refresh(p)
    return p


def _auth(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id))}"}


def _add_close(db, user, d, rev=1000.0, status="confirmed"):
    c = _close(d, rev, round(rev / 5, 2), status=status)
    c.user_id = user.id
    db.add(c); db.commit(); db.refresh(c)
    return c


def test_send_to_accountant_refuses_any_address_but_the_saved_revisor(db_session, client):
    user = _make_user(db_session)
    _make_profile(db_session, user)
    _add_close(db_session, user, date(2026, 9, 25))
    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(True, None)) as sender:
        r = client.post(
            "/api/daily-close/send-to-accountant?from=2026-09-01&to=2026-09-30",
            json={"fmt": "pdf", "accountant_email": "victim@elsewhere.dk",
                  "message": "hi"},
            headers=_auth(user))
        assert r.status_code == 422, r.text
        assert r.json()["detail"]["code"] == "recipient_not_saved"
        assert sender.call_count == 0

        r = client.post(
            "/api/daily-close/send-to-accountant?from=2026-09-01&to=2026-09-30",
            json={"fmt": "xlsx", "message": "<b>se venligst</b>"}, headers=_auth(user))
        assert r.status_code == 200, r.text
        assert sender.call_count == 1
        args, kwargs = sender.call_args
        assert args[0] == "anna@revisor.dk"
        assert "<b>se venligst</b>" not in args[2]
        assert "&lt;b&gt;se venligst&lt;/b&gt;" in args[2]
        # Says what is attached, under the business's own name.
        assert kwargs["attachment_filename"] == "Kasserapporter Mirabelle ApS 2026-09-01–2026-09-30.xlsx"
        assert "Kasserapporter Mirabelle ApS 2026-09-01–2026-09-30.xlsx" in args[2]


def test_send_to_accountant_has_a_daily_cap_per_account(db_session, client):
    user = _make_user(db_session)
    _make_profile(db_session, user)
    _add_close(db_session, user, date(2026, 9, 25))
    for _ in range(20):
        db_session.add(AuditLog(
            user_id=user.id, action="daily_close.send_to_accountant",
            entity_type="daily_close_range", created_at=utc_now() - timedelta(hours=1)))
    db_session.commit()
    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(True, None)) as sender:
        r = client.post(
            "/api/daily-close/send-to-accountant?from=2026-09-01&to=2026-09-30",
            json={"fmt": "pdf"}, headers=_auth(user))
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "revisor_daily_cap"
    assert sender.call_count == 0
