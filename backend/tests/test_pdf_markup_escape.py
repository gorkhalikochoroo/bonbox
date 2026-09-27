"""Typed text is text in a kasserapport and a lønseddel — never markup.

A ReportLab Paragraph parses a small HTML dialect. The kasserapport and the
lønseddel dropped names, notes, addresses and owner-typed category labels
straight into it, so:
  • "Mad & drikke" or "Levering <5 km" mangled the line or failed the build;
  • `<img src="…">` in a note or a staffer's name made the server read a
    file off its own disk (another tenant's receipt photo is a file) or fetch
    a URL, and embed the result in a document the owner then sends on.
(Security review, Sep 2026.)

Each test builds the real PDF with hostile text and checks that the text
comes out literally and that nothing was embedded or fetched.

  cd backend && pytest tests/test_pdf_markup_escape.py -v
"""
import base64
import re
import struct
import zlib
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.daily_close import DailyClose
from app.models.staff import HoursLogged, StaffMember
from app.models.user import User
from app.services.auth import create_access_token, hash_password
from app.utils.time import utc_now

_db_ready.set()


def _png(path):
    """A real 1×1 PNG — what ReportLab would happily embed."""
    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
    raw = b"\x00\xff\x00\x00"
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    path.write_bytes(png)
    return str(path)


def _text(pdf: bytes) -> str:
    """Every content stream, decoded (ASCII85 + Flate, ReportLab's default)."""
    out, i = [], 0
    while (s := pdf.find(b"stream", i)) != -1:
        if pdf[s - 3:s] == b"end":
            i = s + 1
            continue
        b = s + 6
        while pdf[b:b + 1] in (b"\r", b"\n"):
            b += 1
        e = pdf.find(b"endstream", b)
        body = pdf[b:e].rstrip(b"\r\n")
        try:
            if b"~>" in body:
                body = base64.a85decode(body[:body.find(b"~>") + 2], adobe=True)
            out.append(zlib.decompress(body).decode("latin-1", "ignore"))
        except Exception:  # noqa: BLE001 — images, fonts
            pass
        i = e + 1
    # ReportLab splits one run of text into several Tj strings at every
    # entity it decoded ("(Mad & Bar <) Tj (Nord) Tj (>) Tj") — join them.
    return re.sub(r"\)\s*Tj\s*\(", "", "\n".join(out))


@pytest.fixture
def fetches(monkeypatch):
    """Record any URL ReportLab tries to read."""
    import reportlab.lib.utils as rlu
    seen = []

    def _no_fetch(name, *a, **k):
        seen.append(name)
        raise OSError("blocked in test")
    monkeypatch.setattr(rlu, "rlUrlRead", _no_fetch)
    return seen


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()

    def _override_get_db():
        yield s

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


def _owner(db, name="Café Manoj"):
    u = User(email="manoj@cafe.dk", password_hash=hash_password("x"), business_name=name,
             business_type="restaurant", currency="DKK",
             created_at=utc_now() - timedelta(days=2), email_verified=True)
    db.add(u); db.commit(); db.refresh(u)
    return u


def test_a_kasserapport_prints_typed_text_literally(db_session, tmp_path, fetches):
    secret = _png(tmp_path / "other-tenant-receipt.png")
    user = _owner(db_session, name="Mad & Bar <Nord>")
    dc = DailyClose(
        user_id=user.id, date=date(2026, 5, 15),
        revenue_total=1500.0, moms_total=300.0, revenue_ex_moms=1200.0, moms_mode="auto",
        revenue_categories="Levering <5 km:1000|Mad & drikke:500",
        payment_total=1500.0, payment_categories="cash:500|Kort & <b>MobilePay:1000",
        status="confirmed", closed_at=datetime(2026, 5, 15, 23, 30),
        closed_by="Sita & Ram",
        notes=f'Line one\nZ-rapport <img src="{secret}" width="40" height="40"/> '
              '<img src="http://169.254.169.254/latest/meta-data/" width="9" height="9"/>',
    )
    db_session.add(dc); db_session.commit(); db_session.refresh(dc)

    r = TestClient(app).get(f"/api/daily-close/{dc.id}/pdf",
                            headers={"Authorization": f"Bearer {create_access_token(str(user.id))}"})

    assert r.status_code == 200, r.text[:300]
    assert b"/Subtype /Image" not in r.content, "a file from the server's disk was embedded"
    assert fetches == [], f"the server fetched {fetches}"
    text = _text(r.content)
    for literal in ("Mad & Bar <Nord>", "Levering <5 km", "Mad & drikke", "Sita & Ram",
                    "Kort & <b>MobilePay", "<img src="):
        assert literal in text, f"{literal!r} did not print as typed"


def test_a_lonseddel_prints_a_staffers_name_literally(db_session, tmp_path, fetches):
    from app.services.loenseddel_pdf import build_loenseddel_pdf
    secret = _png(tmp_path / "id-card.png")
    owner = _owner(db_session)
    emp = StaffMember(user_id=owner.id, name=f'Sofie <img src="{secret}"/> & Co',
                      role="Bar & <i>køkken", contract_type="full", base_rate=180.0,
                      tax_card_type="hovedkort", active=True)
    db_session.add(emp); db_session.commit(); db_session.refresh(emp)
    db_session.add(HoursLogged(user_id=owner.id, staff_id=emp.id, date=date(2026, 5, 5),
                               start_time="10:00", end_time="18:00", total_hours=8.0,
                               rate_applied=180.0, earned=1440.0, entry_method="quick"))
    db_session.commit()

    pdf, _summary = build_loenseddel_pdf(db_session, owner, emp, date(2026, 5, 1), date(2026, 5, 31))

    assert pdf.startswith(b"%PDF-")
    assert b"/Subtype /Image" not in pdf
    assert fetches == []
    text = _text(pdf)
    assert "Sofie <img src=" in text and "& Co" in text
    assert "Bar & <i>k" in text


# ─── The other six builders (same review, same rule) ─────────────────────────
# Each hostile literal is placed where it cannot straddle a line wrap: on its
# own line, or ahead of the long tmp path (whose length differs per machine).

_METADATA_IMG = '<img src="http://169.254.169.254/latest/meta-data/" width="9" height="9"/>'


def _auth(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id))}"}


def _assert_literal(text, literals):
    for literal in literals:
        assert literal in text, f"{literal!r} did not print as typed"


def test_a_moms_filing_prints_the_business_block_literally(db_session, tmp_path, fetches):
    from app.models.business_profile import BusinessProfile
    from app.services.tax_filing_pdf import build_moms_filing_pdf
    secret = _png(tmp_path / "other-tenant-receipt.png")
    user = _owner(db_session)
    profile = BusinessProfile(
        user_id=user.id, country="DK",
        company_name=f'Mad & Bar <Nord> <img src="{secret}" width="40" height="40"/>',
        address=f"Gade 1 & <b>2 {_METADATA_IMG}", zipcode="1456", city="Kbh",
        org_number="12345678 & <i>", vat_number="DK<87654321>",
    )
    db_session.add(profile); db_session.commit(); db_session.refresh(profile)

    pdf = build_moms_filing_pdf(db_session, user, date(2026, 5, 1), date(2026, 5, 31),
                                profile=profile)

    assert pdf.startswith(b"%PDF-")
    assert b"/Subtype /Image" not in pdf, "a file from the server's disk was embedded"
    assert fetches == [], f"the server fetched {fetches}"
    _assert_literal(_text(pdf), ("Mad & Bar <Nord> <img src=", "Gade 1 & <b>2",
                                 "CVR 12345678 & <i>", "VAT DK<87654321>"))


def test_a_ledelsesrapport_prints_the_business_header_literally(db_session, tmp_path, fetches):
    from app.models.business_profile import BusinessProfile
    secret = _png(tmp_path / "other-tenant-receipt.png")
    # No company_name → the header falls back to the signup business_name.
    user = _owner(db_session, name=f'Mad & Bar <Nord> <img src="{secret}" width="40" height="40"/> '
                                   f'{_METADATA_IMG}')
    db_session.add(BusinessProfile(
        user_id=user.id, country="DK", company_name="", org_number="12345678 & <i>",
        address="Gade 1 & <b>2", zipcode="1456", city="Kbh", phone="+45 12 & <b>34",
    ))
    db_session.commit()

    r = TestClient(app).get("/api/reports/monthly/pdf?month=5&year=2026", headers=_auth(user))

    assert r.status_code == 200, r.text[:300]
    assert b"/Subtype /Image" not in r.content, "a file from the server's disk was embedded"
    assert fetches == [], f"the server fetched {fetches}"
    _assert_literal(_text(r.content), (
        "Mad & Bar <Nord> <img src=",
        "CVR: 12345678 & <i> | Gade 1 & <b>2, 1456 Kbh | Tel: +45 12 & <b>34",
    ))


def test_a_multi_terminal_kasserapport_prints_typed_text_literally(tmp_path, fetches):
    from app.services.kasserapport_pdf import render_close_pdf
    secret = _png(tmp_path / "other-tenant-receipt.png")

    pdf = render_close_pdf(
        aggregated={
            "closed_by": "Sita & Ram", "cash_total": 1000, "payments_total": 1000,
            "cash_difference": -150, "cash_diff_flagged": True,
            "flagged_reason": f'Kassen mangler & <b>150 <img src="{secret}" width="40" height="40"/>',
            "terminals": [{"terminal_name": f"Bar <1> & {_METADATA_IMG}", "total": 1000}],
        },
        business_name="Mad & Bar <Nord>",
        # All three arrive in the request body — client text, not ours.
        date_label="15.5.2026 (Fredag <u>)",
        bilagsnummer="K-2026 & <b>42",
        business_profile={"org_number": "12345678 & <i>", "address": "Gade 1 & <b>2"},
    )

    assert pdf.startswith(b"%PDF-")
    assert b"/Subtype /Image" not in pdf, "a file from the server's disk was embedded"
    assert fetches == [], f"the server fetched {fetches}"
    text = _text(pdf)
    assert "generation failed" not in text, "this is the fallback page, not the kasserapport"
    _assert_literal(text, ("Mad & Bar <Nord>", "CVR 12345678 & <i>", "Gade 1 & <b>2",
                           "Fredag <u>", "Sita & Ram", "K-2026 & <b>42", "Bar <1> &",
                           "Kassen mangler & <b>150 <img src="))


def test_a_daily_property_report_prints_labels_and_names_literally(tmp_path, fetches):
    from app.services.property_report_pdf import build_property_report_pdf
    secret = _png(tmp_path / "other-tenant-receipt.png")
    report = {
        "report_date": "2026-05-07", "currency": "DKK",
        "totals": {"total_revenue": 1000.0, "tax_collected": 200.0, "all_sales_net": 800.0,
                   "gross_sales": 1000.0, "moms_mode": "incl", "moms_rate_pct": 25},
        # Channel labels are owner-typed (OrderChannelConfig); tender labels
        # fall back to the raw stored payment_method.
        "order_channels": [{"channel": "wolt", "label": "Wolt & <b>Takeaway",
                            "amount": 1000.0, "checks": 3}],
        "tender_media": [{"tender": "kort", "amount": 1000.0, "count": 3,
                          "label": f'Kort <img src="{secret}" width="40" height="40"/>'}],
    }

    pdf = build_property_report_pdf(
        report,
        profile={"company_name": "Mad & Bar <Nord>", "address": f"Gade 1 & <b>2 {_METADATA_IMG}",
                 "zipcode": "1456", "city": "Kbh", "org_number": "12345678 & <i>"},
        closer_name="Sita & <i>Ram",
    )

    assert pdf.startswith(b"%PDF-")
    assert b"/Subtype /Image" not in pdf, "a file from the server's disk was embedded"
    assert fetches == [], f"the server fetched {fetches}"
    _assert_literal(_text(pdf), ("Mad & Bar <Nord>", "Gade 1 & <b>2", "CVR 12345678 & <i>",
                                 "Closed by: Sita & <i>Ram", "Wolt & <b>Takeaway",
                                 "Kort <img src="))


def test_a_procedure_description_prints_the_owners_answers_literally(db_session, tmp_path, fetches):
    from app.models.business_profile import BusinessProfile
    secret = _png(tmp_path / "other-tenant-receipt.png")
    user = _owner(db_session, name="Mad & Bar <Nord>")
    db_session.add(BusinessProfile(user_id=user.id, org_number="12345678 & <i>"))
    db_session.commit()
    client = TestClient(app)

    saved = client.put("/api/reports/procedure", headers=_auth(user), json={"answers": {
        "ansvarlige": f'Sita & Ram\n<img src="{secret}" width="40" height="40"/> ejer',
        "opbevaring": f"Levering <5 km & <b>arkiv {_METADATA_IMG}",
    }})
    assert saved.status_code == 200, saved.text[:300]
    r = client.get("/api/reports/procedure/pdf", headers=_auth(user))

    assert r.status_code == 200, r.text[:300]
    assert b"/Subtype /Image" not in r.content, "a file from the server's disk was embedded"
    assert fetches == [], f"the server fetched {fetches}"
    text = _text(r.content)
    _assert_literal(text, ("Mad & Bar <Nord>", "CVR 12345678 & <i>", "Sita & Ram",
                           "<img src=", "Levering <5 km & <b>arkiv"))
    assert "Sita & Ram <img" not in text, "the owner's line break was lost"


def test_a_printed_rota_prints_names_and_roles_literally(db_session, tmp_path, fetches):
    from app.models.business_profile import BusinessProfile
    from app.models.staff import Schedule
    from app.services.staff_schedule_pdf import render_schedule_pdf
    secret = _png(tmp_path / "other-tenant-receipt.png")
    owner = _owner(db_session)
    db_session.add(BusinessProfile(user_id=owner.id, company_name="Mad & Bar <Nord>"))
    sofie = StaffMember(user_id=owner.id, name="Sofie & <b>Co", active=True)
    jonas = StaffMember(user_id=owner.id, name=f"Jonas {_METADATA_IMG}", active=True)
    db_session.add_all([sofie, jonas]); db_session.commit()
    monday = date(2026, 5, 4)
    for staff, day, role in ((sofie, 0, f'<img src="{secret}" width="40" height="40"/>'),
                             (sofie, 1, "Bar & <i>kok"), (jonas, 2, "Opvask")):
        db_session.add(Schedule(user_id=owner.id, staff_id=staff.id, date=monday + timedelta(days=day),
                                start_time="10:00", end_time="18:00", status="published",
                                role_on_shift=role))
    db_session.commit()

    pdf = render_schedule_pdf(db_session, user_id=owner.id, week_start=monday, lang="en")

    assert pdf.startswith(b"%PDF-")
    assert b"/Subtype /Image" not in pdf, "a file from the server's disk was embedded"
    assert fetches == [], f"the server fetched {fetches}"
    _assert_literal(_text(pdf), ("Mad & Bar <Nord>", "Sofie & <b>Co", "<img src=",
                                 "Bar & <i>kok"))
