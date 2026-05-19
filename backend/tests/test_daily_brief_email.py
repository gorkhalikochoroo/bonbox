"""Tests for the Daily Brief morning email (Task #54).

What we pin:
  Layer 1 — `send_brief_to_user` happy path: HTML rendered, Resend
    called with right subject, audit row written, last_brief_emailed_at
    stamped.
  Layer 2 — Idempotency: same-day re-call short-circuits with reason
    'already_sent_today' (force=False) but DOES send on force=True.
  Layer 3 — Preference gate: user.daily_brief_email_enabled=False →
    skipped silently with reason 'user_opted_out'.
  Layer 4 — Entitlement gate: has_feature False → skipped with
    reason 'feature_not_entitled'.
  Layer 5 — Resend failure: send_email returns False → result.ok=False,
    no crash, error reason persisted to audit_logs.
  Layer 6 — Cron iterator: send_daily_brief_emails iterates eligible
    users only (locked users skipped at the SQL layer; opted-out users
    skipped at the service layer).
  Layer 7 — HTTP endpoint /api/dashboard/daily-brief/send-now:
    requires auth (401 anonymous), returns 200 with structured result
    for the authed user, sends to caller's own email only (multi-tenant).

The Brief payload comes from get_or_create_brief — we monkey-patch
that to a fixed dict so these tests stay fast + deterministic. The
actual brief pipeline has its own dedicated tests.
"""
from __future__ import annotations

from datetime import timedelta
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
from app.models.user import User
from app.services import daily_brief_email as dbe
from app.services.auth import get_current_user
from app.utils.time import utc_now

_db_ready.set()


# ─── Fixtures ────────────────────────────────────────────────────────────


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
    """TestClient with empty overrides — individual tests inject the
    user via app.dependency_overrides[get_current_user]."""
    # Reset the AI limiter so rapid-fire test calls don't trip 429.
    try:
        from app.routers.dashboard import _ai_limiter
        _ai_limiter.reset()
    except Exception:
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def _make_user(
    db,
    email="owner@example.com",
    *,
    plan="free",
    brief_enabled=True,
    is_locked=False,
):
    u = User(
        email=email,
        password_hash="x",
        business_name="Mirabelle Café",
        business_type="restaurant",
        currency="DKK",
        plan=plan,
        daily_brief_email_enabled=brief_enabled,
        is_locked=is_locked,
        email_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


_FAKE_BRIEF = {
    "greeting": "Good morning",
    "date_label": "Tuesday · 19 May",
    "headline": "Yesterday beat the week average by 12%.",
    "headline_cta_label": "Open Sales",
    "headline_cta_url": "/sales",
    "insights": [
        {"type": "win", "text": "Best Friday in 3 weeks.", "cta_label": None, "cta_url": None},
        {
            "type": "action",
            "text": "Cheese is running low.",
            "cta_label": "Open Inventory",
            "cta_url": "/inventory",
        },
    ],
    "ai_polished": True,
    "tier": "free",
    "from_cache": False,
    "refreshes_left": 0,
    "model": None,
}


def _patch_brief_pipeline(monkeypatch, payload=None):
    """Replace get_or_create_brief with a deterministic stub so these
    tests don't exercise the brief pipeline (which has its own suite)."""
    payload = payload or _FAKE_BRIEF
    monkeypatch.setattr(dbe, "get_or_create_brief", lambda user, db, **kw: dict(payload))


# ─── Layer 1 — happy path ────────────────────────────────────────────────


def test_send_brief_happy_path(db_session, monkeypatch):
    _patch_brief_pipeline(monkeypatch)
    sent = []

    def _fake_send_email(to, subject, html):
        sent.append({"to": to, "subject": subject, "html": html})
        return True

    monkeypatch.setattr(dbe, "send_email", _fake_send_email)

    user = _make_user(db_session)
    result = dbe.send_brief_to_user(db_session, user)

    assert result["ok"] is True
    assert result["sent_at"] is not None
    assert result["error"] is None
    assert len(sent) == 1
    assert sent[0]["to"] == user.email
    # Subject prefix is stable; date_label varies in CI so we just check
    # the lead text and that the date_label from the brief is included.
    assert sent[0]["subject"].startswith("Today at BonBox · ")
    assert "Tuesday" in sent[0]["subject"]
    # HTML body sanity — no <script>, brand present, headline rendered,
    # in-app CTA path stitched onto the base URL.
    assert "<script" not in sent[0]["html"].lower()
    assert "BonBox" in sent[0]["html"]
    assert "Yesterday beat the week average" in sent[0]["html"]
    assert "/sales" in sent[0]["html"]
    assert "/dashboard" in sent[0]["html"]
    assert "/profile#notifications" in sent[0]["html"]

    # Idempotency stamp set
    db_session.expire_all()
    user_refreshed = db_session.query(User).filter_by(id=user.id).first()
    assert user_refreshed.last_brief_emailed_at is not None

    # Audit row written
    audits = (
        db_session.query(AuditLog)
        .filter_by(action="daily_brief.email_sent", user_id=user.id)
        .all()
    )
    assert len(audits) == 1


# ─── Layer 2 — idempotency (calendar day, UTC) ───────────────────────────


def test_idempotent_same_day_skip(db_session, monkeypatch):
    _patch_brief_pipeline(monkeypatch)
    monkeypatch.setattr(dbe, "send_email", lambda *a, **kw: True)

    user = _make_user(db_session)
    first = dbe.send_brief_to_user(db_session, user)
    assert first["ok"] is True

    db_session.expire_all()
    user_refreshed = db_session.query(User).filter_by(id=user.id).first()

    second = dbe.send_brief_to_user(db_session, user_refreshed)
    assert second["ok"] is False
    assert second["reason"] == "already_sent_today"
    assert second["error"] is None


def test_force_bypasses_idempotency(db_session, monkeypatch):
    """The /send-now endpoint passes force=True so the 'send a test' button
    works even after the cron has already run."""
    _patch_brief_pipeline(monkeypatch)
    sent_count = {"n": 0}

    def _count_send(*a, **kw):
        sent_count["n"] += 1
        return True

    monkeypatch.setattr(dbe, "send_email", _count_send)

    user = _make_user(db_session)
    dbe.send_brief_to_user(db_session, user)  # first
    db_session.expire_all()
    user_refreshed = db_session.query(User).filter_by(id=user.id).first()

    second = dbe.send_brief_to_user(db_session, user_refreshed, force=True)
    assert second["ok"] is True
    assert sent_count["n"] == 2


# ─── Layer 3 — preference toggle off ─────────────────────────────────────


def test_opted_out_user_silently_skipped(db_session, monkeypatch):
    _patch_brief_pipeline(monkeypatch)
    called = {"n": 0}
    monkeypatch.setattr(dbe, "send_email", lambda *a, **kw: called.__setitem__("n", called["n"] + 1) or True)

    user = _make_user(db_session, brief_enabled=False)
    result = dbe.send_brief_to_user(db_session, user)

    assert result["ok"] is False
    assert result["reason"] == "user_opted_out"
    assert called["n"] == 0  # send_email never invoked


# ─── Layer 4 — entitlement gate ──────────────────────────────────────────


def test_entitlement_gate_blocks_when_feature_off(db_session, monkeypatch):
    """If has_feature returns False (future: we flip Free off), the user
    is skipped with reason='feature_not_entitled'. No email sent."""
    _patch_brief_pipeline(monkeypatch)
    monkeypatch.setattr(dbe, "send_email", lambda *a, **kw: True)
    monkeypatch.setattr(dbe, "has_feature", lambda u, f: False)

    user = _make_user(db_session)
    result = dbe.send_brief_to_user(db_session, user)

    assert result["ok"] is False
    assert result["reason"] == "feature_not_entitled"


# ─── Layer 5 — Resend send error ─────────────────────────────────────────


def test_send_failure_returns_ok_false_no_crash(db_session, monkeypatch):
    _patch_brief_pipeline(monkeypatch)
    monkeypatch.setattr(dbe, "send_email", lambda *a, **kw: False)

    user = _make_user(db_session)
    result = dbe.send_brief_to_user(db_session, user)

    assert result["ok"] is False
    assert result["error"] == "send_failed"

    # Stamp NOT set — we don't want a "false success" to block tomorrow's retry
    db_session.expire_all()
    user_refreshed = db_session.query(User).filter_by(id=user.id).first()
    assert user_refreshed.last_brief_emailed_at is None

    # Failure audit row written
    audits = (
        db_session.query(AuditLog)
        .filter_by(action="daily_brief.email_failed", user_id=user.id)
        .all()
    )
    assert len(audits) == 1


def test_unexpected_exception_is_caught(db_session, monkeypatch):
    """A bug inside the brief pipeline must not crash send_brief_to_user —
    the cron iterates every user, one bad row can't poison the batch."""
    def _explode(*a, **kw):
        raise RuntimeError("brief pipeline went boom")

    monkeypatch.setattr(dbe, "get_or_create_brief", _explode)
    monkeypatch.setattr(dbe, "send_email", lambda *a, **kw: True)

    user = _make_user(db_session)
    result = dbe.send_brief_to_user(db_session, user)

    assert result["ok"] is False
    assert "RuntimeError" in (result["error"] or "")


# ─── Layer 6 — cron iterator ─────────────────────────────────────────────


def test_cron_iterates_eligible_users(db_session, monkeypatch):
    """send_daily_brief_emails sends to opted-in users; skips locked
    users at the SQL gate; skips opted-out users at the service gate."""
    _patch_brief_pipeline(monkeypatch)
    sent_to = []
    monkeypatch.setattr(
        dbe, "send_email",
        lambda to, *a, **kw: sent_to.append(to) or True,
    )

    yes = _make_user(db_session, email="yes@example.com", brief_enabled=True)
    no = _make_user(db_session, email="no@example.com", brief_enabled=False)
    locked = _make_user(db_session, email="locked@example.com", brief_enabled=True, is_locked=True)

    from app.jobs.daily_brief_email_job import send_daily_brief_emails

    SessionLocal = sessionmaker(bind=db_session.bind, autoflush=False, autocommit=False)
    summary = send_daily_brief_emails(db_factory=lambda: SessionLocal())

    # Only `yes` should have received. `no` filtered by SQL (enabled=False),
    # `locked` filtered by SQL (is_locked=True). Cron's _eligible_users
    # query enforces both at the DB layer.
    assert "yes@example.com" in sent_to
    assert "no@example.com" not in sent_to
    assert "locked@example.com" not in sent_to
    assert summary["sent"] == 1
    assert summary["attempted"] == 1  # SQL pre-filtered the other two
    # Make sure unused locals don't trigger lint
    _ = (yes, no, locked)


def test_cron_skips_already_sent_today(db_session, monkeypatch):
    """If the cron is re-fired (process restart, retry), users whose
    last_brief_emailed_at falls on today (UTC) are skipped."""
    _patch_brief_pipeline(monkeypatch)
    monkeypatch.setattr(dbe, "send_email", lambda *a, **kw: True)

    user = _make_user(db_session)
    user.last_brief_emailed_at = utc_now()  # already sent today
    db_session.commit()

    from app.jobs.daily_brief_email_job import send_daily_brief_emails

    SessionLocal = sessionmaker(bind=db_session.bind, autoflush=False, autocommit=False)
    summary = send_daily_brief_emails(db_factory=lambda: SessionLocal())

    assert summary["sent"] == 0
    assert summary["skipped"] == 1


def test_cron_one_bad_user_doesnt_poison_batch(db_session, monkeypatch):
    """If get_or_create_brief raises for user A, user B still gets the
    brief. This is the multi-tenant isolation guarantee."""
    user_a = _make_user(db_session, email="a@example.com")
    user_b = _make_user(db_session, email="b@example.com")

    def _selective_brief(user, db, **kw):
        if user.email == "a@example.com":
            raise RuntimeError("A is poisoned")
        return dict(_FAKE_BRIEF)

    monkeypatch.setattr(dbe, "get_or_create_brief", _selective_brief)
    sent_to = []
    monkeypatch.setattr(
        dbe, "send_email",
        lambda to, *a, **kw: sent_to.append(to) or True,
    )

    from app.jobs.daily_brief_email_job import send_daily_brief_emails

    SessionLocal = sessionmaker(bind=db_session.bind, autoflush=False, autocommit=False)
    summary = send_daily_brief_emails(db_factory=lambda: SessionLocal())

    assert "b@example.com" in sent_to
    assert "a@example.com" not in sent_to
    assert summary["sent"] == 1
    assert summary["errors"] == 1
    _ = (user_a, user_b)


# ─── Layer 7 — HTTP endpoint ─────────────────────────────────────────────


def test_send_now_endpoint_requires_auth(client):
    """No auth → 401. Pin this so a future router refactor can't expose
    a tenant-broad send to anonymous callers."""
    res = client.post("/api/dashboard/daily-brief/send-now")
    assert res.status_code == 401


def test_send_now_endpoint_returns_ok_for_authed_caller(
    db_session, client, monkeypatch,
):
    _patch_brief_pipeline(monkeypatch)
    sent_to = []
    monkeypatch.setattr(
        dbe, "send_email",
        lambda to, *a, **kw: sent_to.append(to) or True,
    )

    user = _make_user(db_session, email="caller@example.com")
    app.dependency_overrides[get_current_user] = lambda: user

    res = client.post("/api/dashboard/daily-brief/send-now")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["sent_at"] is not None
    assert sent_to == ["caller@example.com"]


def test_send_now_only_sends_to_caller(db_session, client, monkeypatch):
    """Cross-tenant isolation — the endpoint sends ONLY to the JWT's user,
    never to another tenant. There's no path to specify a different user
    in the request body; this test confirms that even with two users
    in the DB, only the authed one receives."""
    _patch_brief_pipeline(monkeypatch)
    sent_to = []
    monkeypatch.setattr(
        dbe, "send_email",
        lambda to, *a, **kw: sent_to.append(to) or True,
    )

    me = _make_user(db_session, email="me@example.com")
    other = _make_user(db_session, email="other@example.com")
    app.dependency_overrides[get_current_user] = lambda: me

    res = client.post("/api/dashboard/daily-brief/send-now")
    assert res.status_code == 200
    assert sent_to == ["me@example.com"]
    # `other` got nothing, even though it's an opted-in user
    assert "other@example.com" not in sent_to
    _ = other


def test_send_now_force_bypasses_same_day_skip(db_session, client, monkeypatch):
    """The endpoint MUST force=True so re-clicking "send a test" works
    after the cron has fired today. Pins the contract that the cron and
    the test button do not interfere with each other."""
    _patch_brief_pipeline(monkeypatch)
    count = {"n": 0}
    monkeypatch.setattr(
        dbe, "send_email",
        lambda *a, **kw: count.__setitem__("n", count["n"] + 1) or True,
    )

    user = _make_user(db_session)
    user.last_brief_emailed_at = utc_now()  # cron already ran today
    db_session.commit()
    app.dependency_overrides[get_current_user] = lambda: user

    res = client.post("/api/dashboard/daily-brief/send-now")
    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert count["n"] == 1


# ─── HTML render shape ───────────────────────────────────────────────────


def test_build_brief_html_escapes_user_content():
    """Defense in depth: the brief comes from a validated pipeline, but
    if a candidate text ever contained <, > or &, the HTML must escape
    them so a renderer can't be tricked into HTML injection."""
    u = User(
        email="t@example.com", password_hash="x",
        business_name="<b>Bad</b>", business_type="restaurant", currency="DKK",
    )
    payload = {
        "greeting": "Good morning",
        "date_label": "Tuesday · 19 May",
        "headline": "Headline with <script>alert(1)</script> tag",
        "insights": [
            {"type": "win", "text": "Insight with & ampersand", "cta_url": None, "cta_label": None},
        ],
    }
    html = dbe.build_brief_html(payload, u)
    assert "<script>" not in html
    assert "&lt;script&gt;" in html
    assert "&amp;" in html
    # business_name escaped
    assert "<b>Bad</b>" not in html
    assert "&lt;b&gt;Bad&lt;/b&gt;" in html


def test_build_brief_html_rejects_external_cta_urls():
    """Only in-app paths (starting with single /) become buttons; everything
    else (http://evil.com, //protocol-relative, javascript:) is dropped."""
    u = User(
        email="t@example.com", password_hash="x",
        business_name="X", business_type="restaurant", currency="DKK",
    )
    payload = {
        "greeting": "Hi",
        "date_label": "X",
        "headline": "Test",
        "headline_cta_url": "https://evil.example.com/pwn",
        "headline_cta_label": "Click here",
        "insights": [
            {"type": "win", "text": "Watch this", "cta_url": "javascript:alert(1)", "cta_label": "Run"},
            {"type": "action", "text": "Or this", "cta_url": "//evil.example.com", "cta_label": "Go"},
            {"type": "action", "text": "But this is fine", "cta_url": "/inventory", "cta_label": "Open"},
        ],
    }
    html = dbe.build_brief_html(payload, u)
    assert "evil.example.com" not in html
    assert "javascript:" not in html.lower()
    # The legitimate in-app path IS rendered
    assert "/inventory" in html


def test_idempotency_helper_treats_naive_dt_as_utc():
    """Legacy rows may have naive datetimes (no tzinfo). The idempotency
    check must treat them as UTC so we don't accidentally double-send."""
    import datetime as _dt
    now = _dt.datetime(2026, 5, 19, 12, 0, 0, tzinfo=_dt.timezone.utc)
    same_day_naive = _dt.datetime(2026, 5, 19, 6, 30, 0)  # naive
    diff_day_naive = _dt.datetime(2026, 5, 18, 23, 59, 0)  # naive
    assert dbe._same_calendar_day_utc(same_day_naive, now) is True
    assert dbe._same_calendar_day_utc(diff_day_naive, now) is False
    assert dbe._same_calendar_day_utc(None, now) is False
