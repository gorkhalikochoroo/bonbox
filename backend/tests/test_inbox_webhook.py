"""
Receipt-forwarding email inbox — v0.1 tests.

Covers the multi-barrier matrix on /api/inbox/postmark-webhook +
/api/inbox/me + /api/inbox/test:

  • happy path:  valid alias + valid creds + 1 PDF attachment → drafted
                 expense, audit rows written, response is 200 with
                 structured outcome.
  • wrong auth:  bad Basic Auth secret → 401 (when INBOX_ENABLED is on).
  • unknown alias: 200 with status='orphan', no downstream expense.
  • over-cap:    Free user blasted past 5 messages → status='throttled'
                 and 402-shape upgrade_to hint in the response body.
  • OCR fail-soft: Smart Scan raises → still creates blank-amount
                 Expense draft with [needs review] marker.

All tests force INBOX_ENABLED=true + Postmark creds via monkeypatch so
we can exercise the wired-up path without touching env on the host.

Run:
  INBOX_ENABLED=true POSTMARK_INBOUND_USER=test POSTMARK_INBOUND_PASS=test \
    pytest backend/tests/test_inbox_webhook.py -v
"""
from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.email_message import EmailMessage
from app.models.expense import Expense, ExpenseCategory  # noqa: F401 — load
from app.models.receipt_intake import ReceiptIntake
from app.models.user import User
from app.services.auth import get_current_user
from app.utils.time import utc_now

# Mark the DB as ready so the readiness middleware doesn't 503 our
# tests before they even reach the router.
_db_ready.set()


# ─── Fixtures ────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _inbox_env(monkeypatch):
    """Force INBOX_ENABLED=true + Postmark creds for every test."""
    monkeypatch.setenv("INBOX_ENABLED", "true")
    monkeypatch.setenv("POSTMARK_INBOUND_USER", "test")
    monkeypatch.setenv("POSTMARK_INBOUND_PASS", "test")
    # Mirror onto settings so the verification path that reads
    # `settings.POSTMARK_INBOUND_*` agrees with the env override.
    from app.config import settings
    monkeypatch.setattr(settings, "INBOX_ENABLED", True, raising=False)
    monkeypatch.setattr(settings, "POSTMARK_INBOUND_USER", "test", raising=False)
    monkeypatch.setattr(settings, "POSTMARK_INBOUND_PASS", "test", raising=False)
    monkeypatch.setattr(settings, "INBOX_DOMAIN", "in.bonbox.dk", raising=False)
    yield


@pytest.fixture
def engine_and_session():
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(eng)
    SessionLocal = sessionmaker(bind=eng)
    return eng, SessionLocal


@pytest.fixture
def db(engine_and_session) -> Iterator:
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    # Reset the limiter between tests; the 5/day /test cap would
    # bleed across runs otherwise.
    try:
        from app.routers.inbox import limiter as _lim
        _lim.reset()
    except Exception:  # noqa: BLE001
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


# ─── Helpers ────────────────────────────────────────────────────────


def _user(db, *, plan: str = "starter", business: str = "Nepali Café", alias: str | None = None) -> User:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x",
        business_name=business,
        business_type="cafe",
        currency="DKK",
        plan=plan,
        inbox_enabled=True,
        inbox_alias=alias,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _basic_header(user: str = "test", pwd: str = "test") -> dict:
    raw = f"{user}:{pwd}".encode("utf-8")
    return {"Authorization": "Basic " + base64.b64encode(raw).decode("ascii")}


def _postmark_payload(*, alias: str, domain: str = "in.bonbox.dk", with_pdf: bool = True) -> dict:
    atts = []
    if with_pdf:
        sentinel = b"%PDF-1.7\n%TEST CONTENT\n%%EOF\n"
        atts.append({
            "Name": "receipt.pdf",
            "Content": base64.b64encode(sentinel).decode("ascii"),
            "ContentType": "application/pdf",
            "ContentLength": len(sentinel),
        })
    return {
        "FromFull": {"Email": "supplier@hørkram.example", "Name": "Hørkram"},
        "From": "supplier@hørkram.example",
        "OriginalRecipient": f"{alias}@{domain}",
        "To": f"{alias}@{domain}",
        "Subject": "Faktura 2026-1234",
        "MessageID": f"msg-{uuid.uuid4().hex[:12]}",
        "TextBody": "Tak for handlen — vedhæftet faktura.",
        "Headers": [
            {"Name": "Authentication-Results", "Value": "spf=pass; dkim=pass; dmarc=pass"},
        ],
        "Attachments": atts,
    }


def _patch_smart_scan(monkeypatch, *, doc_type: str = "receipt", extracted: dict | None = None,
                     confidence: float = 0.92, raise_exc: Exception | None = None):
    """Replace smart_scan_service.route_and_extract so tests don't
    spin up the real OCR chain."""
    from app.services import smart_scan_service

    def _stub(image_bytes, **kwargs):  # noqa: ARG001
        if raise_exc:
            raise raise_exc
        return {
            "doc_type": doc_type,
            "confidence": confidence,
            "route_to": "/expenses",
            "route_label": "Expenses",
            "extracted_data": extracted,
            "fallback_used": None,
            "file_size_kb": 1,
            "verify_hints": [],
            "reason": None,
        }

    monkeypatch.setattr(smart_scan_service, "route_and_extract", _stub)


# ─── Tests ──────────────────────────────────────────────────────────


def test_inbox_disabled_globally_returns_503(client, db, monkeypatch):
    """L6 — when INBOX_ENABLED is false, the webhook 503s with the
    honesty body so Postmark backs off."""
    monkeypatch.delenv("INBOX_ENABLED", raising=False)
    monkeypatch.delenv("POSTMARK_INBOUND_USER", raising=False)
    monkeypatch.delenv("POSTMARK_INBOUND_PASS", raising=False)
    from app.config import settings
    monkeypatch.setattr(settings, "INBOX_ENABLED", False, raising=False)
    monkeypatch.setattr(settings, "POSTMARK_INBOUND_USER", "", raising=False)
    monkeypatch.setattr(settings, "POSTMARK_INBOUND_PASS", "", raising=False)

    user = _user(db, alias="testbiz-aaaa")
    payload = _postmark_payload(alias=user.inbox_alias)
    res = client.post(
        "/api/inbox/postmark-webhook",
        json=payload,
        headers=_basic_header(),
    )
    assert res.status_code == 503, res.text
    body = res.json()
    assert body["ok"] is False
    assert body["reason"] == "inbox_not_configured"


def test_webhook_wrong_auth_returns_401(client, db):
    """L1 — Basic Auth must match exactly. Bad creds → 401, no row."""
    user = _user(db, alias="testbiz-bbbb")
    payload = _postmark_payload(alias=user.inbox_alias)
    res = client.post(
        "/api/inbox/postmark-webhook",
        json=payload,
        headers=_basic_header(pwd="wrong"),
    )
    assert res.status_code == 401, res.text
    # No EmailMessage row was written
    assert db.query(EmailMessage).count() == 0


def test_webhook_missing_auth_returns_401(client, db):
    user = _user(db, alias="testbiz-cccc")
    payload = _postmark_payload(alias=user.inbox_alias)
    res = client.post("/api/inbox/postmark-webhook", json=payload)
    assert res.status_code == 401
    assert db.query(EmailMessage).count() == 0


def test_webhook_unknown_alias_writes_orphan(client, db):
    """L5 — alias doesn't resolve → 200 with status='orphan' + a
    row in email_messages with user_id=None for observability."""
    payload = _postmark_payload(alias="nobody-zzzz")
    res = client.post(
        "/api/inbox/postmark-webhook",
        json=payload,
        headers=_basic_header(),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] is True
    assert body["status"] == "orphan"
    # One orphan row, no user_id, no expenses
    row = db.query(EmailMessage).first()
    assert row is not None
    assert row.status == "orphan"
    assert row.user_id is None
    assert db.query(Expense).count() == 0


def test_happy_path_creates_draft_expense_and_audits(client, db, monkeypatch):
    """End-to-end — valid auth, known alias, valid PDF → draft expense
    is created + audit_logs row is written for inbox.received and
    inbox.expense_drafted."""
    _patch_smart_scan(
        monkeypatch,
        doc_type="receipt",
        confidence=0.92,
        extracted={
            "vendor": "Hørkram",
            "amount": 432.50,
            "date": "2026-05-20",
            "currency": "DKK",
        },
    )

    user = _user(db, alias="bonbox-dddd")
    payload = _postmark_payload(alias=user.inbox_alias)
    res = client.post(
        "/api/inbox/postmark-webhook",
        json=payload,
        headers=_basic_header(),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] is True
    assert body["status"] == "processed"
    assert body["drafted"] == 1

    # ── Email row stamped 'processed' + tied to the user ──
    em = db.query(EmailMessage).filter(EmailMessage.user_id == user.id).one()
    assert em.status == "processed"
    assert em.attachment_ct == 1
    assert em.spf_pass is True and em.dkim_pass is True and em.dmarc_pass is True

    # ── ReceiptIntake row carries the sha + storage path + expense_id ──
    intake = db.query(ReceiptIntake).filter(ReceiptIntake.user_id == user.id).one()
    assert intake.ocr_status == "ok"
    assert intake.expense_id is not None
    assert intake.storage_path.startswith("uploads/receipts/")
    assert intake.sha256 and len(intake.sha256) == 64

    # ── Draft Expense exists with the OCR'd amount + vendor ──
    expense = db.query(Expense).filter(Expense.user_id == user.id).one()
    assert "Hørkram" in expense.description or "from inbox" in expense.description
    assert float(expense.amount) == 432.50
    assert expense.receipt_photo == intake.storage_path

    # ── Audit log: one received + one expense_drafted ──
    audits = (
        db.query(AuditLog)
        .filter(AuditLog.user_id == user.id)
        .order_by(AuditLog.created_at.asc())
        .all()
    )
    actions = [a.action for a in audits]
    assert "inbox.received" in actions
    assert "inbox.expense_drafted" in actions

    received = next(a for a in audits if a.action == "inbox.received")
    after = json.loads(received.after_state or "{}")
    assert after["status"] == "processed"
    assert after["attachment_ct"] == 1


def test_ocr_failure_still_creates_blank_draft(client, db, monkeypatch):
    """L8 — when Smart Scan raises, we still create a draft expense
    with amount=0 and a [needs review] marker so no receipt is ever
    lost. The intake row stamps ocr_status='failed'."""
    _patch_smart_scan(monkeypatch, raise_exc=RuntimeError("Claude down"))

    user = _user(db, alias="needsrv-eeee")
    payload = _postmark_payload(alias=user.inbox_alias)
    res = client.post(
        "/api/inbox/postmark-webhook",
        json=payload,
        headers=_basic_header(),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] is True
    assert body["status"] == "processed"
    assert body["drafted"] == 1

    expense = db.query(Expense).filter(Expense.user_id == user.id).one()
    assert float(expense.amount) == 0  # blank — needs review
    assert "needs review" in expense.description.lower()

    intake = db.query(ReceiptIntake).filter(ReceiptIntake.user_id == user.id).one()
    assert intake.ocr_status == "failed"
    assert intake.expense_id == expense.id


def test_free_user_over_cap_returns_throttled(client, db, monkeypatch):
    """L3 + L10 — Free tier cap (5/mo). Sixth email lands as throttled,
    no draft expense, and the response carries an upgrade_to hint."""
    _patch_smart_scan(monkeypatch, doc_type="receipt", confidence=0.92,
                      extracted={"vendor": "X", "amount": 10, "date": "2026-05-20"})

    user = _user(db, plan="free", alias="tinyco-ffff")
    # Pre-seed 5 'processed' rows so the next one is the (cap+1)'th.
    for i in range(5):
        em = EmailMessage(
            id=uuid.uuid4(),
            user_id=user.id,
            alias=user.inbox_alias,
            from_addr="bot@bot.test",
            subject=f"old-{i}",
            message_id=f"old-{i}-{uuid.uuid4().hex[:6]}",
            attachment_ct=0,
            status="processed",
            received_at=utc_now() - timedelta(days=1),
        )
        db.add(em)
    db.commit()

    payload = _postmark_payload(alias=user.inbox_alias)
    res = client.post(
        "/api/inbox/postmark-webhook",
        json=payload,
        headers=_basic_header(),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "throttled"
    assert body["cap"] == 5
    assert body["current"] >= 6
    assert body["upgrade_to"] in ("starter", "pro")
    # No expense draft for the over-cap email
    assert db.query(Expense).filter(Expense.user_id == user.id).count() == 0


def test_user_disabled_quarantines(client, db, monkeypatch):
    """L6 — owner flipped inbox_enabled=False → status='quarantined',
    no OCR, no expense."""
    _patch_smart_scan(monkeypatch, doc_type="receipt", confidence=0.92,
                      extracted={"vendor": "X", "amount": 10, "date": "2026-05-20"})
    user = _user(db, alias="quietco-gggg")
    user.inbox_enabled = False
    db.commit()

    payload = _postmark_payload(alias=user.inbox_alias)
    res = client.post(
        "/api/inbox/postmark-webhook",
        json=payload,
        headers=_basic_header(),
    )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "quarantined"
    assert db.query(Expense).filter(Expense.user_id == user.id).count() == 0


def test_mime_blocked_attachment_is_skipped(client, db, monkeypatch):
    """L2 — disallowed MIME type → intake row written with
    ocr_status='skipped' AND no expense draft."""
    _patch_smart_scan(monkeypatch)

    user = _user(db, alias="mimeblk-hhhh")
    payload = _postmark_payload(alias=user.inbox_alias)
    payload["Attachments"][0]["ContentType"] = "application/x-msdownload"
    res = client.post(
        "/api/inbox/postmark-webhook",
        json=payload,
        headers=_basic_header(),
    )
    assert res.status_code == 200
    body = res.json()
    # Rejected because no attachment made it through the allowlist
    assert body["status"] in ("rejected", "processed")
    assert body["drafted"] == 0
    assert body["skipped"] == 1

    intake = db.query(ReceiptIntake).filter(ReceiptIntake.user_id == user.id).one()
    assert intake.ocr_status == "skipped"
    assert intake.expense_id is None


def test_get_me_lazy_allocates_alias(client, db):
    """GET /api/inbox/me with no alias yet → lazy allocate + persist."""
    user = _user(db, business="Nepali", alias=None)
    _override_user(user)

    res = client.get("/api/inbox/me")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["alias"].endswith("@in.bonbox.dk")
    # Format: <base>-<rand4>@domain
    local = body["alias"].split("@", 1)[0]
    assert "-" in local
    base, _, rand = local.partition("-")
    assert base and rand
    assert len(rand) == 4
    assert body["enabled"] is True
    assert body["messages_this_month"] == 0
    assert body["cap"] in (-1, 5, 200)
    assert body["infra_enabled"] is True  # env was forced on

    # Round-trip: alias persisted. Re-query instead of db.refresh() —
    # the User object was loaded in the test session but the endpoint's
    # Depends(get_db) used a separate session, so the test session's
    # User instance is non-persistent in its own context. Re-querying
    # by id forces a fresh read across the session boundary.
    fresh = db.query(type(user)).filter_by(id=user.id).first()
    assert fresh is not None
    assert fresh.inbox_alias == local


def test_duplicate_message_id_is_idempotent(client, db, monkeypatch):
    """Same (alias, message_id) replayed → no second expense; the
    response flags 'duplicate'."""
    _patch_smart_scan(monkeypatch, doc_type="receipt", confidence=0.92,
                      extracted={"vendor": "X", "amount": 10, "date": "2026-05-20"})

    user = _user(db, alias="dupect-iiii")
    payload = _postmark_payload(alias=user.inbox_alias)

    first = client.post(
        "/api/inbox/postmark-webhook",
        json=payload,
        headers=_basic_header(),
    )
    assert first.status_code == 200
    assert first.json()["status"] == "processed"

    second = client.post(
        "/api/inbox/postmark-webhook",
        json=payload,
        headers=_basic_header(),
    )
    assert second.status_code == 200
    assert second.json().get("duplicate") is True

    # Only one expense created
    assert db.query(Expense).filter(Expense.user_id == user.id).count() == 1
