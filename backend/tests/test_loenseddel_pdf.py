"""Lønseddel accountant-grade PDF tests.

Pins the 6 required accountant-grade fields per Manoj's locked doctrine
("Accountant-grade artifacts", May 2026). Mirrors the gold-standard
shape from `build_moms_filing_pdf` in `tax_filing_pdf.py`:

  1. Bilagsnummer  — `LON-{employee_short}-{YYYYMMDD}-{YYYYMMDD}`
  2. Doc-hash      — SHA-256 short (16 hex) in footer
  3. Signature line for medarbejder
  4. Bogføringsloven §10 retention notice
  5. Provenance footer (BonBox v… · UTC · owner email)
  6. Source reconciliation (every HoursLogged row that fed total_gross)

Plus the L7 layer:
  7. audit_logs row written on every router call

Run: cd backend && pytest tests/test_loenseddel_pdf.py -v
"""
from __future__ import annotations

import re
from datetime import date, timedelta

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
from app.models.staff import HoursLogged, StaffMember
from app.models.user import User
from app.services.auth import create_access_token, hash_password
from app.services.loenseddel_pdf import (
    build_loenseddel_pdf,
    build_loenseddel_pdf_multi,
    make_bilagsnummer,
)
from app.utils.time import utc_now

_db_ready.set()


# ─── Fixtures ────────────────────────────────────────────────────────


@pytest.fixture
def db_session():
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
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client():
    yield TestClient(app)
    app.dependency_overrides.clear()


def _make_owner(db):
    u = User(
        email="anders@mirabelle.dk",
        password_hash=hash_password("x"),
        business_name="Mirabelle Café",
        business_type="restaurant",
        currency="DKK",
        plan="pro",
        email_verified=True,
        created_at=utc_now() - timedelta(days=30),
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _make_profile(db, owner):
    p = BusinessProfile(
        user_id=owner.id,
        company_name="Mirabelle Café ApS",
        org_number="12345678",
        country="DK",
        address="Nørrebrogade 10",
        zipcode="2200",
        city="København",
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def _make_employee(db, owner, name="Sofie Nielsen"):
    e = StaffMember(
        user_id=owner.id,
        name=name,
        role="barista",
        contract_type="full",
        base_rate=180.0,
        tax_card_type="hovedkort",
        active=True,
    )
    db.add(e)
    db.commit()
    db.refresh(e)
    return e


def _add_hours(
    db, owner, employee, *,
    on_date: date, hours: float = 8.0, rate: float = 180.0,
    start: str = "09:00", end: str = "17:00",
):
    h = HoursLogged(
        user_id=owner.id,
        staff_id=employee.id,
        date=on_date,
        start_time=start,
        end_time=end,
        total_hours=hours,
        rate_applied=rate,
        earned=hours * rate,
        entry_method="quick",
    )
    db.add(h)
    db.commit()
    db.refresh(h)
    return h


def _auth_headers(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id))}"}


def _extract_pdf_text(pdf_bytes: bytes) -> str:
    """Decode ReportLab content streams to a single text blob.

    ReportLab writes content streams with a `/Filter [/ASCII85Decode
    /FlateDecode]` chain by default. We don't have pypdf / PyPDF2 /
    pdfminer available, so we walk the file byte-by-byte, locate every
    `stream\\n ... \\nendstream` pair, peel ASCII85 + zlib, and return
    everything concatenated for substring searches. Danish characters
    (`ø`, `å`, `æ`) survive as PDF escape sequences (e.g. `\\370`) —
    the assertions split known terms around the escapes.
    """
    import base64
    import zlib

    parts = [pdf_bytes.decode("latin-1", errors="ignore")]

    # Walk every "stream..endstream" pair. The naive find-loop is
    # bounded by file size — fine for our < 50 KB test PDFs.
    i = 0
    while True:
        s = pdf_bytes.find(b"stream", i)
        if s == -1:
            break
        # Skip "endstream"
        if s >= 3 and pdf_bytes[s - 3:s] == b"end":
            i = s + 1
            continue
        body_start = s + len(b"stream")
        while body_start < len(pdf_bytes) and pdf_bytes[body_start:body_start + 1] in (b"\r", b"\n"):
            body_start += 1
        e = pdf_bytes.find(b"endstream", body_start)
        if e == -1:
            break
        body = pdf_bytes[body_start:e].rstrip(b"\r\n")

        decoded: bytes | None = None
        # Try ASCII85+Flate first (ReportLab default).
        if b"~>" in body:
            try:
                end_pos = body.find(b"~>") + 2
                a85 = base64.a85decode(body[:end_pos], adobe=True)
                decoded = zlib.decompress(a85)
            except Exception:
                decoded = None
        # Then try plain Flate.
        if decoded is None and body[:2] == b"\x78\x9c":
            try:
                decoded = zlib.decompress(body)
            except Exception:
                decoded = None

        if decoded is not None:
            parts.append(decoded.decode("latin-1", errors="ignore"))
        i = e + 1
    return "\n".join(parts)


# ─── Bilagsnummer format ─────────────────────────────────────────────


def test_bilagsnummer_format_matches_lon_pattern():
    """Format LON-XXXX-YYYYMMDD-YYYYMMDD where XXXX is first 4 chars
    of the employee UUID (uppercased)."""
    employee_id = "ab12cdef-1234-5678-9abc-def012345678"
    period_start = date(2026, 5, 1)
    period_end = date(2026, 5, 31)
    bn = make_bilagsnummer(employee_id, period_start, period_end)
    assert re.fullmatch(r"LON-[A-Z0-9]{4}-\d{8}-\d{8}", bn), bn
    assert bn == "LON-AB12-20260501-20260531"


def test_bilagsnummer_stable_for_same_input():
    """Same (employee, period) MUST produce the same bilagsnummer —
    that's the contract a revisor relies on when asking the owner to
    regenerate a specific lønseddel."""
    emp = "abcd-1234"
    s = date(2026, 5, 1)
    e = date(2026, 5, 31)
    assert make_bilagsnummer(emp, s, e) == make_bilagsnummer(emp, s, e)


# ─── Renderer: 6 required accountant-grade fields ────────────────────


def test_pdf_generates_without_error(db_session):
    """Smoke test — happy path renders bytes."""
    owner = _make_owner(db_session)
    profile = _make_profile(db_session, owner)
    emp = _make_employee(db_session, owner)
    _add_hours(db_session, owner, emp, on_date=date(2026, 5, 5))
    _add_hours(db_session, owner, emp, on_date=date(2026, 5, 6))

    pdf_bytes, summary = build_loenseddel_pdf(
        db_session, owner, emp,
        date(2026, 5, 1), date(2026, 5, 31),
        profile=profile,
    )
    assert pdf_bytes.startswith(b"%PDF-")
    assert summary["bilagsnummer"].startswith("LON-")
    assert summary["doc_hash"]
    assert summary["total_hours"] == 16.0
    assert summary["total_gross"] == 2880.0  # 16 × 180


def test_pdf_contains_bilagsnummer_in_correct_format(db_session):
    """Field #1 — bilagsnummer LON-XXXX-YYYYMMDD-YYYYMMDD must be in PDF."""
    owner = _make_owner(db_session)
    profile = _make_profile(db_session, owner)
    emp = _make_employee(db_session, owner)
    _add_hours(db_session, owner, emp, on_date=date(2026, 5, 5))

    pdf_bytes, summary = build_loenseddel_pdf(
        db_session, owner, emp,
        date(2026, 5, 1), date(2026, 5, 31),
        profile=profile,
    )
    text = _extract_pdf_text(pdf_bytes)
    assert summary["bilagsnummer"] in text
    assert re.search(r"LON-[A-Z0-9]{4}-20260501-20260531", text)


def test_pdf_contains_doc_hash_16_hex_in_footer(db_session):
    """Field #2 — 16-char hex doc-hash rendered in footer."""
    owner = _make_owner(db_session)
    profile = _make_profile(db_session, owner)
    emp = _make_employee(db_session, owner)
    _add_hours(db_session, owner, emp, on_date=date(2026, 5, 5))

    pdf_bytes, summary = build_loenseddel_pdf(
        db_session, owner, emp,
        date(2026, 5, 1), date(2026, 5, 31),
        profile=profile,
    )
    text = _extract_pdf_text(pdf_bytes)
    assert re.fullmatch(r"[0-9a-f]{16}", summary["doc_hash"]), summary["doc_hash"]
    assert "Doc-hash:" in text
    assert summary["doc_hash"] in text


def test_pdf_contains_signature_line(db_session):
    """Field #3 — signature line for medarbejder."""
    owner = _make_owner(db_session)
    profile = _make_profile(db_session, owner)
    emp = _make_employee(db_session, owner)
    _add_hours(db_session, owner, emp, on_date=date(2026, 5, 5))

    pdf_bytes, _ = build_loenseddel_pdf(
        db_session, owner, emp,
        date(2026, 5, 1), date(2026, 5, 31),
        profile=profile,
    )
    text = _extract_pdf_text(pdf_bytes)
    # Danish word "medarbejder" (may be encoded via PDF escape codes)
    assert "Underskrift" in text or "Underskrift," in text
    assert "Dato:" in text
    # Section header "SIGNERING" is the DK label per the MOMS PDF pattern.
    assert "SIGNERING" in text


def test_pdf_contains_bogfoeringsloven_notice(db_session):
    """Field #4 — Bogføringsloven §10 retention notice. ReportLab
    encodes the `ø` as `\\370` and `§` as `\\247` inside the content
    stream, so we assert on the surrounding ASCII fragments + the
    presence of `10` (the §10 marker)."""
    owner = _make_owner(db_session)
    profile = _make_profile(db_session, owner)
    emp = _make_employee(db_session, owner)
    _add_hours(db_session, owner, emp, on_date=date(2026, 5, 5))

    pdf_bytes, _ = build_loenseddel_pdf(
        db_session, owner, emp,
        date(2026, 5, 1), date(2026, 5, 31),
        profile=profile,
    )
    text = _extract_pdf_text(pdf_bytes)
    # `Bogføringsloven` — split around the encoded ø.
    assert "Bogf" in text
    assert "ringsloven" in text
    # `§10.` — the section marker followed by 10.
    assert "10." in text
    # 5-year retention.
    assert "i 5 " in text


def test_pdf_contains_provenance_footer(db_session):
    """Field #5 — provenance footer with BonBox version + UTC + owner email."""
    owner = _make_owner(db_session)
    profile = _make_profile(db_session, owner)
    emp = _make_employee(db_session, owner)
    _add_hours(db_session, owner, emp, on_date=date(2026, 5, 5))

    pdf_bytes, _ = build_loenseddel_pdf(
        db_session, owner, emp,
        date(2026, 5, 1), date(2026, 5, 31),
        profile=profile,
    )
    text = _extract_pdf_text(pdf_bytes)
    assert "Genereret af BonBox v" in text
    assert "UTC" in text
    assert "af " in text
    assert owner.email in text


def test_pdf_includes_one_row_per_hours_logged(db_session):
    """Field #6 — source reconciliation: every HoursLogged row in
    section A so a revisor can trace gross back to the source."""
    owner = _make_owner(db_session)
    profile = _make_profile(db_session, owner)
    emp = _make_employee(db_session, owner)
    _add_hours(db_session, owner, emp, on_date=date(2026, 5, 5))
    _add_hours(db_session, owner, emp, on_date=date(2026, 5, 12))
    _add_hours(db_session, owner, emp, on_date=date(2026, 5, 19))

    pdf_bytes, _ = build_loenseddel_pdf(
        db_session, owner, emp,
        date(2026, 5, 1), date(2026, 5, 31),
        profile=profile,
    )
    text = _extract_pdf_text(pdf_bytes)
    # ARBEJDSTIMER section header is the DK label.
    assert "ARBEJDSTIMER" in text
    # Each date string must be present.
    assert "2026-05-05" in text
    assert "2026-05-12" in text
    assert "2026-05-19" in text


# ─── Determinism (doc_hash stable for same input) ────────────────────


def test_same_input_same_doc_hash(db_session, monkeypatch):
    """Two builds against identical inputs MUST produce the same
    doc-hash. Determinism is the contract the audit footer relies on:
    if a downloaded PDF is later re-hashed, the result MUST match the
    audit-row's stored hash.

    ReportLab embeds an `/ID` trailer derived from `os.urandom` + the
    wall-clock to make every render unique. For determinism we pin
    both: the bilagsnummer + content + footer all derive solely from
    the input arguments, so once we silence those two ReportLab
    nondeterminism sources we get byte-identical output.
    """
    import os as _os
    import time as _time
    from app.services import loenseddel_pdf as svc

    owner = _make_owner(db_session)
    profile = _make_profile(db_session, owner)
    emp = _make_employee(db_session, owner)
    _add_hours(db_session, owner, emp, on_date=date(2026, 5, 5))

    fixed_now = utc_now().replace(microsecond=0)
    monkeypatch.setattr(svc, "utc_now", lambda: fixed_now)
    monkeypatch.setattr(_os, "urandom", lambda n: b"\x00" * n)
    monkeypatch.setattr(_time, "time", lambda: 1748210000.0)

    pdf1, sum1 = build_loenseddel_pdf(
        db_session, owner, emp,
        date(2026, 5, 1), date(2026, 5, 31),
        profile=profile,
    )
    pdf2, sum2 = build_loenseddel_pdf(
        db_session, owner, emp,
        date(2026, 5, 1), date(2026, 5, 31),
        profile=profile,
    )

    assert sum1["doc_hash"] == sum2["doc_hash"]
    assert sum1["bilagsnummer"] == sum2["bilagsnummer"]
    assert pdf1 == pdf2


# ─── L7 audit row on router call ─────────────────────────────────────


def test_router_writes_audit_log_row_on_pdf_generation(db_session, client):
    """L7 — every lønseddel render writes one audit_logs row per
    employee with action `staff.loenseddel_pdf_generated`."""
    owner = _make_owner(db_session)
    _make_profile(db_session, owner)
    emp = _make_employee(db_session, owner)
    _add_hours(db_session, owner, emp, on_date=date(2026, 5, 5))

    r = client.get(
        "/api/staff/payroll/loenseddel",
        params={
            "period_start": "2026-05-01",
            "period_end": "2026-05-31",
        },
        headers=_auth_headers(owner),
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"

    rows = (
        db_session.query(AuditLog)
        .filter(
            AuditLog.user_id == owner.id,
            AuditLog.action == "staff.loenseddel_pdf_generated",
        )
        .all()
    )
    assert len(rows) == 1, f"expected one audit row, got {len(rows)}"
    row = rows[0]
    assert row.entity_type == "staff_member"
    # entity_id should be the employee's id (UUID may be string in SQLite).
    assert str(row.entity_id) == str(emp.id)
    # `after_state` is JSON-serialized — assert the doc_hash + period
    # land in there so a tamper-check later can find them.
    after = row.after_state or ""
    assert "doc_hash" in after
    assert "2026-05-01" in after
    assert "2026-05-31" in after
    assert "bilagsnummer" in after


def test_router_404_when_no_staff_hours_logged(db_session, client):
    """No HoursLogged rows in the period → 404 (don't ship a blank PDF)."""
    owner = _make_owner(db_session)
    _make_profile(db_session, owner)
    _make_employee(db_session, owner)  # staff exists but no hours

    r = client.get(
        "/api/staff/payroll/loenseddel",
        params={
            "period_start": "2026-05-01",
            "period_end": "2026-05-31",
        },
        headers=_auth_headers(owner),
    )
    assert r.status_code == 404
