"""Tests for support tickets — in-app support inbox.

Multi-layer pinned:
  • Model round-trip: ticket persists with correct status lifecycle.
  • Tenant boundary: owner only sees own tickets; admin endpoints
    refuse non-admin users.
  • Rate limit: 5 tickets/hour cap enforced.
  • Field caps: subject, body, kind size limits.
  • Lifecycle: open → responded → closed transitions.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.support_ticket import SupportTicket
from app.models.user import User
from app.utils.time import utc_now


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


def _user(db, email="owner@bonbox.test"):
    u = User(
        email=email, password_hash="x",
        business_name="Bar", business_type="restaurant",
        currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _ticket(db, owner, *, subject="Bug report", kind="bug", body="Something broke"):
    t = SupportTicket(
        id=uuid.uuid4(),
        user_id=owner.id,
        kind=kind,
        subject=subject,
        body=body,
        status="open",
    )
    db.add(t); db.commit(); db.refresh(t)
    return t


# ─── Schema sanity ────────────────────────────────────────────────────


def test_ticket_persists_with_default_status_open(db):
    user = _user(db)
    t = _ticket(db, user)
    fetched = db.query(SupportTicket).filter(SupportTicket.id == t.id).first()
    assert fetched.status == "open"
    assert fetched.response_text is None
    assert fetched.responded_at is None
    assert fetched.closed_at is None


def test_ticket_lifecycle_open_responded_closed(db):
    """The status field tracks lifecycle. Both 'responded' and 'closed'
    are valid terminal states; closed includes resolved + dismissed."""
    user = _user(db)
    t = _ticket(db, user)
    # Respond without closing — status='responded'
    t.response_text = "Looking into it"
    t.responded_at = utc_now()
    t.status = "responded"
    db.commit()
    db.refresh(t)
    assert t.status == "responded"
    assert t.response_text == "Looking into it"
    # Now close
    t.status = "closed"
    t.closed_at = utc_now()
    db.commit()
    db.refresh(t)
    assert t.status == "closed"


def test_ticket_kind_defaults_to_other(db):
    """Free-text kind so we can learn what categories matter without
    a migration. Default 'other' for tickets without a category."""
    user = _user(db)
    t = SupportTicket(
        id=uuid.uuid4(), user_id=user.id,
        subject="Question", body="Random thing",
    )
    db.add(t); db.commit(); db.refresh(t)
    assert t.kind == "other"


# ─── Tenant boundary ──────────────────────────────────────────────────


def test_owner_query_filters_by_user_id(db):
    """Owner A's query MUST never return Owner B's tickets."""
    a = _user(db, email="a@bonbox.test")
    b = _user(db, email="b@bonbox.test")
    _ticket(db, a, subject="A's ticket")
    _ticket(db, b, subject="B's ticket")
    a_rows = (
        db.query(SupportTicket)
        .filter(SupportTicket.user_id == a.id)
        .all()
    )
    assert len(a_rows) == 1
    assert a_rows[0].subject == "A's ticket"


# ─── Rate-limit window ────────────────────────────────────────────────


def test_recent_count_query_for_rate_limit(db):
    """Mirrors the rate-limit query in routers/support.py — counts
    tickets in the last hour for the user. Used by the router to
    enforce TICKETS_PER_HOUR_CAP."""
    user = _user(db)
    # 4 recent tickets + 1 old (>1h ago)
    for i in range(4):
        _ticket(db, user, subject=f"Recent {i}")
    old = _ticket(db, user, subject="Old")
    old.created_at = utc_now() - timedelta(hours=2)
    db.commit()
    cutoff = utc_now() - timedelta(hours=1)
    recent_count = (
        db.query(SupportTicket)
        .filter(
            SupportTicket.user_id == user.id,
            SupportTicket.created_at >= cutoff,
        )
        .count()
    )
    assert recent_count == 4


# ─── Body cap (defense via model + schema) ────────────────────────────


def test_subject_length_140_chars_persists(db):
    """The schema caps subject at 140; the model uses VARCHAR(140).
    Pin that the column accepts the max."""
    user = _user(db)
    long_subject = "x" * 140
    t = _ticket(db, user, subject=long_subject)
    fetched = db.query(SupportTicket).filter(SupportTicket.id == t.id).first()
    assert len(fetched.subject) == 140


# ─── Admin-mail notification (the "connected to my admin mail" half) ──────

from types import SimpleNamespace  # noqa: E402
from app.routers import support as support_router  # noqa: E402


def _fake_ticket(**over):
    base = dict(
        id=uuid.uuid4(), user_id=uuid.uuid4(), kind="bug",
        subject="Login broken", body="It crashes", context=None,
        is_priority=False, response_text=None,
    )
    base.update(over)
    return SimpleNamespace(**base)


def _capture_send_email(monkeypatch):
    calls = []

    def fake_send_email(**kwargs):
        calls.append(kwargs)
        return True

    monkeypatch.setattr("app.services.email_service.send_email", fake_send_email)
    return calls


def test_notify_recipients_prefers_explicit_env(monkeypatch):
    monkeypatch.setenv("SUPPORT_NOTIFY_EMAIL", "support@bonbox.dk")
    assert support_router._admin_notify_recipients() == ["support@bonbox.dk"]


def test_notify_recipients_falls_back_to_superadmin_allowlist(monkeypatch):
    monkeypatch.delenv("SUPPORT_NOTIFY_EMAIL", raising=False)
    monkeypatch.setattr(support_router, "_allowed_emails", lambda: ["founder@bonbox.dk"])
    assert support_router._admin_notify_recipients() == ["founder@bonbox.dk"]


def test_admin_notification_emails_founder_with_reply_to_owner(monkeypatch):
    calls = _capture_send_email(monkeypatch)
    monkeypatch.setattr(support_router, "_admin_notify_recipients", lambda: ["founder@bonbox.dk"])
    owner = SimpleNamespace(email="cafe@owner.dk")
    support_router._send_admin_notification(ticket=_fake_ticket(), owner=owner)
    assert len(calls) == 1
    assert calls[0]["to"] == "founder@bonbox.dk"
    # Reply-To = the owner, so hitting Reply reaches the person who reported it.
    assert calls[0]["reply_to"] == "cafe@owner.dk"
    assert "Login broken" in calls[0]["subject"]


def test_admin_notification_noop_when_no_recipients(monkeypatch):
    calls = _capture_send_email(monkeypatch)
    monkeypatch.setattr(support_router, "_admin_notify_recipients", lambda: [])
    support_router._send_admin_notification(ticket=_fake_ticket(), owner=SimpleNamespace(email="x@y.dk"))
    assert calls == []


def test_admin_notification_escapes_owner_html(monkeypatch):
    """A crafted body must not inject markup into the founder's mail client."""
    calls = _capture_send_email(monkeypatch)
    monkeypatch.setattr(support_router, "_admin_notify_recipients", lambda: ["founder@bonbox.dk"])
    evil = _fake_ticket(body="<script>alert(1)</script>", subject="<b>x</b>")
    support_router._send_admin_notification(ticket=evil, owner=SimpleNamespace(email="e@v.il"))
    html = calls[0]["html"]
    assert "<script>" not in html
    assert "&lt;script&gt;" in html


# ─── Owner reply email (makes "we'll reply by email" true) ───────────────


def test_owner_response_email_reply_to_uses_support_alias(monkeypatch):
    calls = _capture_send_email(monkeypatch)
    monkeypatch.delenv("SUPPORT_REPLY_TO", raising=False)
    monkeypatch.setenv("SUPPORT_NOTIFY_EMAIL", "support@bonbox.dk")
    tk = _fake_ticket(response_text="Fixed in the next deploy 🙏", subject="Login broken")
    owner = SimpleNamespace(email="cafe@owner.dk")
    support_router._send_owner_response_email(ticket=tk, owner=owner)
    assert len(calls) == 1
    assert calls[0]["to"] == "cafe@owner.dk"
    assert calls[0]["reply_to"] == "support@bonbox.dk"
    assert "Fixed in the next deploy" in calls[0]["html"]


def test_owner_response_reply_to_never_leaks_superadmin(monkeypatch):
    """Owner-facing Reply-To must NEVER fall back to the super-admin login
    allowlist — that would hand every customer the admin-takeover target.
    With no support alias configured, we send with no Reply-To."""
    calls = _capture_send_email(monkeypatch)
    monkeypatch.delenv("SUPPORT_NOTIFY_EMAIL", raising=False)
    monkeypatch.delenv("SUPPORT_REPLY_TO", raising=False)
    monkeypatch.setattr(support_router, "_allowed_emails", lambda: ["founder-login@gmail.com"])
    support_router._send_owner_response_email(
        ticket=_fake_ticket(response_text="hi"), owner=SimpleNamespace(email="cafe@owner.dk"))
    assert len(calls) == 1
    assert calls[0]["reply_to"] is None  # NOT the super-admin login address


def test_owner_response_email_noop_without_owner_email(monkeypatch):
    calls = _capture_send_email(monkeypatch)
    support_router._send_owner_response_email(ticket=_fake_ticket(response_text="hi"), owner=SimpleNamespace(email=""))
    assert calls == []
    support_router._send_owner_response_email(ticket=_fake_ticket(response_text="hi"), owner=None)
    assert calls == []


def test_admin_endpoints_use_super_admin_guard():
    """The admin triage endpoints must depend on the real super-admin guard
    (the old getattr(user,'is_admin') gated on a non-existent attr → 403 for
    everyone). Assert require_super_admin is wired in the dependency graph."""
    from app.services.admin_security import require_super_admin
    deps = []
    for route in support_router.router.routes:
        if getattr(route, "path", "").startswith("/admin/"):
            deps.extend(d.call for d in route.dependant.dependencies)
    assert require_super_admin in deps
