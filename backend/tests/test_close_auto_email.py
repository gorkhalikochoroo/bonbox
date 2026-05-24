"""Lane A — close-ritual auto-email tests (Manoj-confirmed, May 2026).

When the FoH person locks the daily close, BonBox auto-fires one email
to owner + accountant with the kasserapport PDF + scanned Z-report
photo attached. Tier-gated:
   Free    — manual "Send to accountant" only (no auto on lock)
   Starter — auto-fires PDF + scan on lock
   Pro     — adds push notification to owner on lock

These tests pin the 10-layer multi-barrier defense per the doctrine in
commits 157463f + db92ddd + 1e8cedd. Layer mapping:
  L3 router — feature gate + preference gate fired at lock time
  L4 service — send_close_notification re-checks feature internally
  L6 fail-closed — missing recipients fall back to owner's own email
  L7 audit — every attempt writes an audit_logs row, failures fire
             a SecurityEvent for operator monitoring
  L8 degrade — Resend failure → "queued_retry"; scan fetch failure
               → PDF-only send with "scan unavailable" note
  L9 UI — response payload includes `close_ritual.email_status` so
          frontend renders honest state (not faked "sent")

Tests are import-isolated (sqlite :memory:) so they're cheap to
run on every CI loop.

Run: cd backend && pytest tests/test_close_auto_email.py -v
"""
from __future__ import annotations

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
from app.models.daily_close import DailyClose
from app.models.security_event import SecurityEvent
from app.models.user import User
from app.services.auth import create_access_token, hash_password
from app.services.billing import PLAN_FEATURES, has_feature
from app.utils.time import utc_now

_db_ready.set()


# ─── Fixtures ─────────────────────────────────────────────────────────


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

    # billing._record_gate_refusal opens its OWN short-lived SessionLocal
    # via app.database.SessionLocal — point that at the in-memory engine
    # so SecurityEvent rows from the gate-refusal observability path
    # land where the assertions can see them (same pattern as
    # test_supplier_detection_gate.py).
    monkeypatch.setattr(
        "app.services.billing.SessionLocal", SessionLocal, raising=False,
    )
    import app.database as _db_mod
    monkeypatch.setattr(_db_mod, "SessionLocal", SessionLocal, raising=False)

    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client():
    yield TestClient(app)
    app.dependency_overrides.clear()


def _make_user(
    db,
    email="anders@mirabelle.dk",
    *,
    plan="starter",
    currency="DKK",
    auto_email=True,
):
    u = User(
        email=email,
        password_hash=hash_password("x"),
        business_name="Mirabelle Café",
        business_type="restaurant",
        currency=currency,
        plan=plan,
        auto_email_on_close=auto_email,
        email_verified=True,
        created_at=utc_now() - timedelta(days=2),
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _make_profile(
    db,
    user,
    *,
    accountant_email="revisor@bonbox.dk",
    owner_email="owner@mirabelle.dk",
):
    p = BusinessProfile(
        user_id=user.id,
        company_name="Mirabelle Café ApS",
        org_number="12345678",
        country="DK",
        email=owner_email,
        accountant_email=accountant_email,
    )
    db.add(p); db.commit(); db.refresh(p)
    return p


def _auth_headers(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id))}"}


def _lock_payload(d: date | None = None):
    """Standard valid payload that triggers the lock branch (status=confirmed)."""
    return {
        "date": (d or date(2026, 5, 23)).isoformat(),
        "branch_id": None,
        "status": "confirmed",
        "revenue_breakdown": {"food": 8000, "drinks": 4500},
        "payment_breakdown": {"cash": 3200, "card": 9300},
        "moms_total": 2500,
        "moms_mode": "auto",
        "tips_total": 450,
        "tips_staff_count": 3,
        "cash_counted": 3200,
        "closed_by": "Anders",
        "notes": "Friday night, busy.",
        "receipt_photo": None,
    }


# ─── Layer 1: PLAN_FEATURES shape (marketing/backend parity) ───────────


def test_plan_features_has_close_auto_email_entries():
    """Drift-trap: every plan MUST have all three new Lane A keys.
    Missing key on a plan would silently fall through to Free=False."""
    expected = {"close_auto_email", "close_scan_attached", "close_push_notification"}
    for plan in ("free", "starter", "pro", "trial"):
        keys = set(PLAN_FEATURES[plan].keys())
        assert expected.issubset(keys), (
            f"Plan {plan!r} missing one of {expected}: got {keys & expected}"
        )


def test_close_auto_email_tier_matrix():
    """Manoj's confirmed matrix:
        Free=False, Starter=True, Pro=True, Trial=True.
    Any drift forces a deliberate update to this test."""
    assert PLAN_FEATURES["free"]["close_auto_email"] is False
    assert PLAN_FEATURES["starter"]["close_auto_email"] is True
    assert PLAN_FEATURES["pro"]["close_auto_email"] is True
    assert PLAN_FEATURES["trial"]["close_auto_email"] is True


def test_close_scan_attached_tier_matrix():
    """Scan-photo attachment moves in lockstep with close_auto_email."""
    assert PLAN_FEATURES["free"]["close_scan_attached"] is False
    assert PLAN_FEATURES["starter"]["close_scan_attached"] is True
    assert PLAN_FEATURES["pro"]["close_scan_attached"] is True


def test_close_push_notification_is_pro_only():
    """Push to owner = the Pro killer.
       Starter does NOT get push; only the email."""
    assert PLAN_FEATURES["free"]["close_push_notification"] is False
    assert PLAN_FEATURES["starter"]["close_push_notification"] is False
    assert PLAN_FEATURES["pro"]["close_push_notification"] is True
    assert PLAN_FEATURES["trial"]["close_push_notification"] is True


# ─── Layer 3: Router gate — Free user lock does NOT trigger email ──────


def test_free_user_lock_does_not_trigger_auto_email(db_session, client, monkeypatch):
    """L3 — a Free user locking a close must NOT have an email sent.
    The response carries `close_ritual.email_status == "skipped_feature_locked"`
    and the upgrade_hint is populated so the frontend can render the
    Starter upsell honestly."""
    sent = []
    monkeypatch.setattr(
        "app.services.email_service.resend.Emails.send",
        lambda *a, **kw: sent.append(a or kw) or None,
    )
    user = _make_user(db_session, plan="free")
    _make_profile(db_session, user)

    r = client.post("/api/daily-close", json=_lock_payload(), headers=_auth_headers(user))
    assert r.status_code == 200, r.text
    ritual = r.json().get("close_ritual")
    assert ritual is not None, "Lock response must carry close_ritual block"
    assert ritual["feature_available"] is False
    assert ritual["email_status"] == "skipped_feature_locked"
    assert ritual["sent_to"] == []
    # L10 — Free user gets a structured upgrade hint
    assert ritual["upgrade_hint"] is not None
    assert ritual["upgrade_hint"]["feature"] == "close_auto_email"
    assert ritual["upgrade_hint"]["upgrade_to"] == "starter"
    # Email was never attempted
    assert sent == []


# ─── Layer 3: Starter user → email fires (PDF only, no scan available) ─


def test_starter_user_lock_triggers_auto_email_with_pdf_only_when_no_scan(
    db_session, client, monkeypatch,
):
    """L3 — Starter user with no Z-report photo → email still fires,
    PDF attached, scan flagged as not present (not a failure)."""
    sent = []

    def _fake_send(payload):
        sent.append(payload)
        return None

    monkeypatch.setattr(
        "app.services.email_service.resend.Emails.send", _fake_send,
    )
    # Resend key must be truthy for send to proceed
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")

    user = _make_user(db_session, plan="starter")
    _make_profile(db_session, user)

    payload = _lock_payload()
    payload["receipt_photo"] = None
    r = client.post("/api/daily-close", json=payload, headers=_auth_headers(user))
    assert r.status_code == 200, r.text
    ritual = r.json()["close_ritual"]
    assert ritual["email_status"] == "sent"
    assert ritual["feature_available"] is True
    assert ritual["has_scan"] is False
    assert ritual["scan_degraded"] is False  # no scan was supposed to be there
    # Owner + accountant — both in `to`
    assert len(ritual["sent_to"]) == 2
    assert "revisor@bonbox.dk" in ritual["sent_to"]
    assert "owner@mirabelle.dk" in ritual["sent_to"]
    # Exactly one email sent, with the PDF as the sole attachment
    assert len(sent) == 1
    sent_payload = sent[0]
    assert len(sent_payload["attachments"]) == 1
    assert sent_payload["attachments"][0]["filename"].startswith("kasserapport_")
    assert sent_payload["attachments"][0]["filename"].endswith(".pdf")


# ─── Layer 3: Starter user with scan attached ──────────────────────────


def test_starter_user_lock_triggers_auto_email_with_pdf_and_scan(
    db_session, client, monkeypatch, tmp_path,
):
    """L3 — Starter user with a local Z-report photo on disk → email
    fires with both PDF + scan attached. has_scan=True in response."""
    sent = []
    monkeypatch.setattr(
        "app.services.email_service.resend.Emails.send",
        lambda p: sent.append(p) or None,
    )
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")

    user = _make_user(db_session, plan="starter")
    _make_profile(db_session, user)

    # Write a fake Z-report jpeg to disk that _fetch_scan_bytes_best_effort
    # can read.
    scan_file = tmp_path / "z_report.jpg"
    scan_file.write_bytes(b"\xff\xd8\xff\xe0" + b"fake jpeg bytes" * 100)

    payload = _lock_payload()
    payload["receipt_photo"] = str(scan_file)
    r = client.post("/api/daily-close", json=payload, headers=_auth_headers(user))
    assert r.status_code == 200, r.text
    ritual = r.json()["close_ritual"]
    assert ritual["email_status"] == "sent"
    assert ritual["has_scan"] is True
    assert ritual["scan_degraded"] is False
    # Two attachments: PDF + scan
    assert len(sent) == 1
    assert len(sent[0]["attachments"]) == 2
    filenames = [a["filename"] for a in sent[0]["attachments"]]
    assert any(f.endswith(".pdf") for f in filenames)
    assert any(f.endswith(".jpg") for f in filenames)


# ─── Layer 8: scan-image fetch failure → graceful degrade ──────────────


def test_starter_user_scan_unavailable_sends_pdf_only_with_degraded_flag(
    db_session, client, monkeypatch,
):
    """L8 — Z-report URL points to nowhere (storage down, file deleted)
    → email STILL fires with PDF only, scan_degraded=True so the
    frontend can show "📷 Z-report photo couldn't be fetched right now"."""
    sent = []
    monkeypatch.setattr(
        "app.services.email_service.resend.Emails.send",
        lambda p: sent.append(p) or None,
    )
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")

    user = _make_user(db_session, plan="starter")
    _make_profile(db_session, user)

    payload = _lock_payload()
    # Path that doesn't exist on disk → scan fetch returns (None, None)
    payload["receipt_photo"] = "/tmp/this/path/does/not/exist.jpg"
    r = client.post("/api/daily-close", json=payload, headers=_auth_headers(user))
    assert r.status_code == 200, r.text
    ritual = r.json()["close_ritual"]
    assert ritual["email_status"] == "sent"
    assert ritual["has_scan"] is False
    assert ritual["scan_degraded"] is True
    assert len(sent) == 1
    assert len(sent[0]["attachments"]) == 1  # PDF only


# ─── Layer 5/6: recipient resolution + owner fallback ──────────────────


def test_recipients_resolved_from_business_profile_with_owner_email_fallback(
    db_session, client, monkeypatch,
):
    """L6 — When BusinessProfile.email is unset, owner_email falls
    back to user.email. Accountant is independent. Tenant-scoped via
    user.id (no cross-tenant leak surface)."""
    sent = []
    monkeypatch.setattr(
        "app.services.email_service.resend.Emails.send",
        lambda p: sent.append(p) or None,
    )
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")

    user = _make_user(db_session, plan="starter", email="anders@mirabelle.dk")
    # Profile has NO email field set; accountant only
    p = BusinessProfile(
        user_id=user.id,
        company_name="Mirabelle Café ApS",
        country="DK",
        email=None,
        accountant_email="revisor@bonbox.dk",
    )
    db_session.add(p); db_session.commit()

    r = client.post("/api/daily-close", json=_lock_payload(), headers=_auth_headers(user))
    assert r.status_code == 200, r.text
    ritual = r.json()["close_ritual"]
    assert ritual["email_status"] == "sent"
    # Owner fallback kicked in
    assert "anders@mirabelle.dk" in ritual["sent_to"]
    assert "revisor@bonbox.dk" in ritual["sent_to"]


def test_no_accountant_email_partial_send_owner_only(db_session, client, monkeypatch):
    """L6 — partial send is OK. If accountant_email is missing, only
    owner gets the email. Don't fail; don't refuse."""
    sent = []
    monkeypatch.setattr(
        "app.services.email_service.resend.Emails.send",
        lambda p: sent.append(p) or None,
    )
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")

    user = _make_user(db_session, plan="starter", email="anders@mirabelle.dk")
    p = BusinessProfile(
        user_id=user.id, company_name="Mirabelle Café ApS", country="DK",
        email="owner@mirabelle.dk", accountant_email=None,
    )
    db_session.add(p); db_session.commit()

    r = client.post("/api/daily-close", json=_lock_payload(), headers=_auth_headers(user))
    ritual = r.json()["close_ritual"]
    assert ritual["email_status"] == "sent"
    assert ritual["sent_to"] == ["owner@mirabelle.dk"]


# ─── Layer 3: User preference toggle off ───────────────────────────────


def test_user_preference_auto_email_off_skips_send(db_session, client, monkeypatch):
    """L3 — Starter user with auto_email_on_close=False → email is
    NOT sent and email_status='skipped_preference_off' surfaces so
    the frontend can offer a 'Turn it back on?' affordance."""
    sent = []
    monkeypatch.setattr(
        "app.services.email_service.resend.Emails.send",
        lambda p: sent.append(p) or None,
    )
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")

    user = _make_user(db_session, plan="starter", auto_email=False)
    _make_profile(db_session, user)

    r = client.post("/api/daily-close", json=_lock_payload(), headers=_auth_headers(user))
    assert r.status_code == 200
    ritual = r.json()["close_ritual"]
    assert ritual["feature_available"] is True
    assert ritual["preference_on"] is False
    assert ritual["email_status"] == "skipped_preference_off"
    assert sent == []


# ─── Layer 9: Lock succeeds even when Resend fails ─────────────────────


def test_email_failure_does_not_block_lock(db_session, client, monkeypatch):
    """L9 — Resend raises an exception mid-send → close-confirm STILL
    succeeds (200), the response carries email_status='queued_retry'
    so the frontend renders an honest 'Email queued for retry' badge
    with a manual retry button."""
    def _boom(payload):
        raise RuntimeError("resend api 503")

    monkeypatch.setattr("app.services.email_service.resend.Emails.send", _boom)
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")

    user = _make_user(db_session, plan="starter")
    _make_profile(db_session, user)

    r = client.post("/api/daily-close", json=_lock_payload(), headers=_auth_headers(user))
    # CRITICAL — lock must succeed
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "confirmed"
    ritual = body["close_ritual"]
    assert ritual["email_status"] == "queued_retry"

    # L7 — SecurityEvent written so operator can spot Resend outage
    evts = (
        db_session.query(SecurityEvent)
        .filter(SecurityEvent.event_type == "gate_skipped.close_auto_email_failed")
        .all()
    )
    assert len(evts) >= 1


def test_email_not_configured_returns_failed_skipped(db_session, client, monkeypatch):
    """L9 — When RESEND_API_KEY isn't set (dev env), close still
    locks; email_status='failed_skipped' so frontend can show a
    'send disabled in this environment' hint rather than faking 'sent'."""
    monkeypatch.setattr("app.services.email_service.resend.api_key", "")
    user = _make_user(db_session, plan="starter")
    _make_profile(db_session, user)
    r = client.post("/api/daily-close", json=_lock_payload(), headers=_auth_headers(user))
    assert r.status_code == 200
    ritual = r.json()["close_ritual"]
    assert ritual["email_status"] == "failed_skipped"


# ─── Layer 7: Audit log on every attempt ───────────────────────────────


def test_audit_log_written_on_each_attempt(db_session, client, monkeypatch):
    """L7 — Every auto-email attempt (success OR failure) writes an
    audit_logs row with event_type='close.auto_emailed'. Auditors can
    reconstruct delivery history."""
    monkeypatch.setattr(
        "app.services.email_service.resend.Emails.send", lambda p: None,
    )
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")

    user = _make_user(db_session, plan="starter")
    _make_profile(db_session, user)

    r = client.post("/api/daily-close", json=_lock_payload(), headers=_auth_headers(user))
    assert r.status_code == 200
    audits = (
        db_session.query(AuditLog)
        .filter(AuditLog.action == "close.auto_emailed", AuditLog.user_id == user.id)
        .all()
    )
    assert len(audits) == 1
    # Audit row carries the recipients, scan flag, and pdf_hash for
    # tamper-evidence cross-check (Bogføringsloven §10).
    row = audits[0]
    assert row.entity_type == "daily_close"
    assert row.before_state is not None
    assert row.after_state is not None
    assert "pdf_hash" in row.before_state


# ─── Layer 9: Bank-drop reminder card data ─────────────────────────────


def test_bank_drop_hint_in_response_when_cash_counted(db_session, client, monkeypatch):
    """Universal (free + paid) — the bank-drop reminder block lands in
    the response so the locked-state card can render '🏦 Put X DKK in
    safe, keep 1.000 in drawer'."""
    monkeypatch.setattr(
        "app.services.email_service.resend.Emails.send", lambda p: None,
    )
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")

    user = _make_user(db_session, plan="free")  # universal works on Free
    payload = _lock_payload()
    payload["cash_counted"] = 4500
    payload["payment_breakdown"]["cash"] = 4500
    r = client.post("/api/daily-close", json=payload, headers=_auth_headers(user))
    assert r.status_code == 200
    ritual = r.json()["close_ritual"]
    bank = ritual["bank_drop"]
    assert bank is not None
    assert bank["counted_dkk"] == 4500.00
    assert bank["leave_in_drawer_dkk"] == 1000.00
    assert bank["to_drop_dkk"] == 3500.00


def test_bank_drop_hint_none_when_no_cash(db_session, client):
    """No cash counted → no reminder card (nothing to drop)."""
    user = _make_user(db_session, plan="free")
    payload = _lock_payload()
    payload["cash_counted"] = 0
    payload["payment_breakdown"] = {"card": 12500}
    r = client.post("/api/daily-close", json=payload, headers=_auth_headers(user))
    ritual = r.json()["close_ritual"]
    assert ritual["bank_drop"] is None


# ─── Layer 9: bank-drop dismiss endpoint ───────────────────────────────


def test_bank_drop_dismiss_persists_close_id(db_session, client):
    """User taps 'Sat i sikkerhedsboks' → close_id lands in
    user.bank_drop_dismissed_ids so the reminder stops showing. Idempotent."""
    user = _make_user(db_session, plan="free")
    payload = _lock_payload()
    r = client.post("/api/daily-close", json=payload, headers=_auth_headers(user))
    close_id = r.json()["id"]

    r = client.post(
        f"/api/daily-close/{close_id}/bank-drop-dismiss",
        headers=_auth_headers(user),
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True

    db_session.expire_all()
    u = db_session.query(User).filter_by(id=user.id).first()
    assert close_id in (u.bank_drop_dismissed_ids or "")

    # Idempotent — second call doesn't duplicate
    r = client.post(
        f"/api/daily-close/{close_id}/bank-drop-dismiss",
        headers=_auth_headers(user),
    )
    assert r.status_code == 200
    db_session.expire_all()
    u = db_session.query(User).filter_by(id=user.id).first()
    assert (u.bank_drop_dismissed_ids or "").count(close_id) == 1


# ─── Layer 3: Draft saves do NOT trigger the auto-email ────────────────


def test_draft_save_does_not_trigger_email(db_session, client, monkeypatch):
    """L3 — Only the LOCK transition (status=confirmed) fires the
    email. Auto-save of a draft does not. Otherwise every keystroke
    during step navigation would email the accountant."""
    sent = []
    monkeypatch.setattr(
        "app.services.email_service.resend.Emails.send",
        lambda p: sent.append(p) or None,
    )
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")

    user = _make_user(db_session, plan="starter")
    _make_profile(db_session, user)

    payload = _lock_payload()
    payload["status"] = "draft"  # not a lock
    r = client.post("/api/daily-close", json=payload, headers=_auth_headers(user))
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "draft"
    # No close_ritual block on a draft (only set on lock)
    assert "close_ritual" not in body
    assert sent == []


# ─── Layer 4: Service-layer entitlement gate ───────────────────────────


def test_service_layer_gate_refuses_free_user_directly():
    """L4 — Even if some future refactor bypasses the router gate and
    calls send_close_notification directly with a Free user, the
    service refuses. Defense in depth."""
    from app.services.email_service import send_close_notification

    free_user = User(
        email="x@x.com", password_hash="x",
        business_name="X", business_type="restaurant",
        currency="DKK", plan="free",
    )
    res = send_close_notification(
        free_user,
        close_id="abc",
        pdf_bytes=b"%PDF-fake",
        scan_image_bytes=None,
        pdf_filename="x.pdf",
        scan_filename=None,
        recipients=["x@y.com"],
        subject="x", html="<p>x</p>",
    )
    assert res["status"] == "skipped_feature_locked"
    assert res["sent_to"] == []


def test_service_layer_skips_when_no_recipients():
    """L6 — empty or all-invalid recipients → skip without crashing."""
    from app.services.email_service import send_close_notification

    starter_user = User(
        email="x@x.com", password_hash="x",
        business_name="X", business_type="restaurant",
        currency="DKK", plan="starter",
    )
    res = send_close_notification(
        starter_user,
        close_id="abc",
        pdf_bytes=b"%PDF-fake",
        scan_image_bytes=None,
        pdf_filename="x.pdf",
        scan_filename=None,
        recipients=["", "not-an-email", None],  # type: ignore[list-item]
        subject="x", html="<p>x</p>",
    )
    assert res["status"] == "skipped_no_recipient"


# ─── Layer 3: Pro user push notification (degrades gracefully) ─────────


def test_pro_user_lock_attempts_push_notification(db_session, client, monkeypatch):
    """L3 — Pro user with no push subscription → push_status=
    'skipped_no_subscription'; close still locks; email still sends."""
    monkeypatch.setattr(
        "app.services.email_service.resend.Emails.send", lambda p: None,
    )
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")

    user = _make_user(db_session, plan="pro")
    _make_profile(db_session, user)
    r = client.post("/api/daily-close", json=_lock_payload(), headers=_auth_headers(user))
    assert r.status_code == 200
    ritual = r.json()["close_ritual"]
    assert ritual["email_status"] == "sent"
    # Pro tier — push attempted, no subscriptions exist → skipped
    assert ritual["push_status"] == "skipped_no_subscription"


def test_starter_user_push_locked_to_pro_only(db_session, client, monkeypatch):
    """L3 — Starter doesn't get push (Pro-only feature). push_status
    must say 'skipped_feature_locked' so the frontend can render the
    Pro upsell next to it."""
    monkeypatch.setattr(
        "app.services.email_service.resend.Emails.send", lambda p: None,
    )
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")

    user = _make_user(db_session, plan="starter")
    _make_profile(db_session, user)
    r = client.post("/api/daily-close", json=_lock_payload(), headers=_auth_headers(user))
    ritual = r.json()["close_ritual"]
    assert ritual["push_status"] == "skipped_feature_locked"


# ─── Layer 10: Honest "upgrade hint" for Free users ────────────────────


def test_free_user_upgrade_hint_points_to_starter(db_session, client):
    """L10 — Free locked-state card needs the 'Want this auto-sent?
    Upgrade to Starter' hint with structured data (not just a string)."""
    user = _make_user(db_session, plan="free")
    _make_profile(db_session, user)
    r = client.post("/api/daily-close", json=_lock_payload(), headers=_auth_headers(user))
    ritual = r.json()["close_ritual"]
    hint = ritual["upgrade_hint"]
    assert hint["feature"] == "close_auto_email"
    assert hint["upgrade_to"] == "starter"
    assert hint["plan"] == "free"
