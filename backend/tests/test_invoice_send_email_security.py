"""POST /api/invoices/{id}/send-email — mail to a third party (security, 8 Oct).

The faktura mail goes out from noreply@bonbox.dk to whatever address the
customer row (or the body) names. It now follows the shared third-party
rules in services/revisor_mail:

  1. the account's own e-mail must be confirmed (403 email_unverified);
  2. a daily ceiling on faktura mails, and on DISTINCT recipient addresses
     (429), counted from audit_logs — a customer already mailed today can
     still get a reminder under the total;
  3. every interpolated value is HTML-escaped and the subject is header-safe;
  4. an explicit per-IP limiter on the route (10/minute) — and the body is
     still parsed as a body (the router lost its future-annotations import,
     which would have turned the body into a query parameter → 422).

Senders and the PDF renderer are stubbed: nothing is ever mailed.
"""
import json
import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.customer import Customer
from app.models.invoice import Invoice
from app.models.user import User
from app.services.auth import get_current_user, hash_password
from app.services.revisor_mail import (
    INVOICE_MAIL_DAILY_CAP, INVOICE_MAIL_RECIPIENT_DAILY_CAP,
)
from app.utils.time import utc_now

_db_ready.set()


@pytest.fixture
def Session_():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture
def db(Session_):
    s = Session_()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture(autouse=True)
def _reset_limiter():
    from app.routers import invoices as inv_router
    lim = getattr(inv_router, "limiter", None)
    if lim is not None:
        lim.reset()
    yield
    if lim is not None:
        lim.reset()


@pytest.fixture
def client(Session_, monkeypatch):
    def _get_test_db():
        s = Session_()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    sent: list[dict] = []

    def _fake_send(to, subject, html, **kw):
        sent.append({"to": to, "subject": subject, "html": html, **kw})
        return True, None

    monkeypatch.setattr("app.routers.invoices.send_email_with_attachment", _fake_send)
    monkeypatch.setattr("app.routers.invoices.render_invoice_pdf", lambda db, inv: b"%PDF-1.4 stub")
    tc = TestClient(app)
    tc.sent = sent  # type: ignore[attr-defined]
    yield tc
    app.dependency_overrides.clear()


def _owner(db, *, verified=True, business_name="Café Nord") -> User:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash=hash_password("pw123456"),
        business_name=business_name,
        business_type="cafe",
        currency="DKK",
        plan="pro",
        role="owner",
        email_verified=verified,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    return u


def _invoice(db, owner, *, customer_name="Hansen ApS", email="kunde@example.dk") -> Invoice:
    c = Customer(user_id=owner.id, name=customer_name, email=email)
    db.add(c)
    db.flush()
    inv = Invoice(
        user_id=owner.id, customer_id=c.id, fakturanummer=7,
        issue_date=date(2026, 10, 1), due_date=date(2026, 10, 15),
        status="sent", total_gross=Decimal("1250.00"), currency="DKK",
        customer_lang="da",
    )
    db.add(inv)
    db.commit()
    db.refresh(inv)
    return inv


def _seed_sends(db, owner, addresses):
    for a in addresses:
        db.add(AuditLog(
            user_id=owner.id, actor_id=owner.id, action="invoice.email_sent",
            entity_type="invoice", entity_id=uuid.uuid4(),
            after_state=json.dumps({"to": a}), created_at=utc_now() - timedelta(hours=1),
        ))
    db.commit()


def test_unverified_owner_cannot_mail_a_customer(client, db):
    owner = _owner(db, verified=False)
    inv = _invoice(db, owner)
    r = client.post(f"/api/invoices/{inv.id}/send-email", json={"cc_self": False})
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "email_unverified"
    assert r.json()["detail"]["message_da"]
    assert client.sent == []


def test_verified_owner_sends_and_every_value_is_escaped(client, db):
    owner = _owner(db, business_name="<b>Bad</b> Café\r\nBcc: victim@example.com")
    inv = _invoice(db, owner, customer_name='<img src=x onerror="alert(1)">')
    r = client.post(
        f"/api/invoices/{inv.id}/send-email",
        json={"cc_self": False, "message": "Tak <script>x</script>"},
    )
    assert r.status_code == 200, r.text
    assert len(client.sent) == 1
    mail = client.sent[0]
    html = mail["html"]
    assert "<img" not in html and "<b>Bad</b>" not in html and "<script>" not in html
    assert "&lt;img" in html and "&lt;b&gt;Bad&lt;/b&gt;" in html
    assert "\r" not in mail["subject"] and "\n" not in mail["subject"]
    # Audited with the recipient — the counter the ceiling reads.
    row = db.query(AuditLog).filter(AuditLog.action == "invoice.email_sent").one()
    assert json.loads(row.after_state)["to"] == "kunde@example.dk"


def test_distinct_recipient_ceiling(client, db):
    owner = _owner(db)
    inv = _invoice(db, owner, email="new-customer@example.dk")
    _seed_sends(db, owner, [f"c{i}@example.dk" for i in range(INVOICE_MAIL_RECIPIENT_DAILY_CAP)])
    r = client.post(f"/api/invoices/{inv.id}/send-email", json={"cc_self": False})
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["code"] == "invoice_mail_recipient_cap"
    assert client.sent == []

    # A customer already mailed today can still get a reminder.
    inv2 = _invoice(db, owner, email="c3@example.dk")
    r2 = client.post(f"/api/invoices/{inv2.id}/send-email", json={"cc_self": False})
    assert r2.status_code == 200, r2.text
    assert client.sent[-1]["to"] == "c3@example.dk"


def test_total_daily_ceiling(client, db):
    owner = _owner(db)
    inv = _invoice(db, owner, email="same@example.dk")
    _seed_sends(db, owner, ["same@example.dk"] * INVOICE_MAIL_DAILY_CAP)
    r = client.post(f"/api/invoices/{inv.id}/send-email", json={"cc_self": False})
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["code"] == "invoice_mail_daily_cap"
    assert client.sent == []


def test_old_sends_do_not_count(client, db):
    owner = _owner(db)
    inv = _invoice(db, owner, email="fresh@example.dk")
    for i in range(INVOICE_MAIL_DAILY_CAP):
        db.add(AuditLog(
            user_id=owner.id, actor_id=owner.id, action="invoice.email_sent",
            entity_type="invoice", after_state=json.dumps({"to": f"o{i}@example.dk"}),
            created_at=utc_now() - timedelta(hours=25),
        ))
    db.commit()
    r = client.post(f"/api/invoices/{inv.id}/send-email", json={"cc_self": False})
    assert r.status_code == 200, r.text


def test_route_has_an_explicit_limiter_and_still_reads_the_body(client, db):
    owner = _owner(db)
    inv = _invoice(db, owner)
    codes = []
    for _ in range(11):
        codes.append(client.post(
            f"/api/invoices/{inv.id}/send-email", json={"cc_self": False, "message": "Hej"},
        ).status_code)
    assert codes[:10] == [200] * 10, codes
    assert codes[10] == 429, codes
    # The body was a body: the note reached the mail.
    assert "Hej" in client.sent[0]["html"]


def test_the_unverified_refusal_names_the_pdf_way_forward(client, db):
    """Review, 8 Oct: an OLD app (open tab / bundled iOS build) shows the
    server's message as it is, after it already locked the faktura as sent —
    and its Profile → Unverified path can be a dead end. So this refusal
    itself says what still works: the PDF, sent from the owner's own mail."""
    owner = _owner(db, verified=False)
    inv = _invoice(db, owner)
    r = client.post(f"/api/invoices/{inv.id}/send-email", json={"cc_self": False})
    assert r.status_code == 403, r.text
    d = r.json()["detail"]
    assert d["code"] == "email_unverified"
    assert "PDF" in d["message"] and "own e-mail" in d["message"]
    assert "PDF" in d["message_da"] and "egen e-mail" in d["message_da"]


def test_the_general_refusal_claims_only_what_is_gated():
    """RELEASE_GATE 5 (claims are true): guest, shift and gavekort mail
    still go out for an unconfirmed account, so the refusal must not say
    BonBox mails no one else — it names what it holds back (mail to the
    revisor is held too since 8 Oct: test_revisor_mail_confirmed_sender)."""
    from app.services import revisor_mail
    for text in (revisor_mail.VERIFY_EMAIL_FIRST_MESSAGE_EN, revisor_mail.VERIFY_EMAIL_FIRST_MESSAGE_DA):
        low = text.lower()
        assert "mail to others" not in low and "mail til andre" not in low
    assert "fakturaer" in revisor_mail.VERIFY_EMAIL_FIRST_MESSAGE_EN
    assert "fakturaer" in revisor_mail.VERIFY_EMAIL_FIRST_MESSAGE_DA
