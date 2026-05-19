"""
Web Push (Task #72) — end-to-end tests for the morning brief push pipeline.

Coverage:
  1. /vapid-public-key (200 with key, 503 when VAPID unset)
  2. /subscribe creates a row scoped to caller user (auth-gated)
  3. /subscribe is idempotent (same endpoint → upsert, not duplicate)
  4. /unsubscribe deletes only the caller's row (cross-tenant safe)
  5. /unsubscribe with unknown endpoint returns 200 (no info leak)
  6. /test fans to all the user's subscriptions; writes audit row
  7. push_sender 410 → row removed (mocked pywebpush)
  8. push_sender 500 → fail_count++ but row kept
  9. push_sender three consecutive 500s → row removed
 10. send_brief_push with no brief candidates skips silently
 11. send_brief_push with brief composes payload from headline
 12. push payload NEVER includes amounts / customer names (privacy)
 13. daily_brief_push_job audit row records counts only, never endpoints

Run: cd backend && pytest tests/test_push_notifications.py -v
"""
from __future__ import annotations

import base64
import json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

# Ensure all models are registered with Base BEFORE create_all().
from app import models as _all_models  # noqa: F401
from app.config import settings
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.push_subscription import PushSubscription
from app.models.user import User
from app.services import push_sender as ps
from app.services.auth import get_current_user
from app.utils.time import utc_now

_db_ready.set()


# ─── Generate ephemeral VAPID keys for the whole module ───────────────


def _ephemeral_vapid() -> tuple[str, str]:
    """Mint a one-off VAPID keypair for testing. Public key returned in
    the raw-uncompressed-point base64url form that PushManager expects;
    private key in PEM (what pywebpush wants)."""
    from py_vapid import Vapid01
    from cryptography.hazmat.primitives import serialization

    v = Vapid01()
    v.generate_keys()
    pub_raw = v.public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    pub_b64 = base64.urlsafe_b64encode(pub_raw).decode("ascii").rstrip("=")
    priv_pem = v.private_pem().decode("ascii")
    return pub_b64, priv_pem


@pytest.fixture(scope="module", autouse=True)
def _set_vapid_env():
    """Install ephemeral VAPID keys on settings so the router doesn't 503
    on the auth-gated endpoints. Reset at module teardown so we don't
    leak test keys into other test modules."""
    orig_pub = settings.VAPID_PUBLIC_KEY
    orig_priv = settings.VAPID_PRIVATE_KEY
    pub, priv = _ephemeral_vapid()
    settings.VAPID_PUBLIC_KEY = pub
    settings.VAPID_PRIVATE_KEY = priv
    yield
    settings.VAPID_PUBLIC_KEY = orig_pub
    settings.VAPID_PRIVATE_KEY = orig_priv


# ─── Per-test fixtures ────────────────────────────────────────────────


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    return engine, SessionLocal


@pytest.fixture
def db(engine_and_session):
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
    # Reset the slowapi limiter that the /test endpoint uses so rapid-
    # fire test calls don't trip 429 across test runs.
    try:
        from app.routers.push import limiter as _push_limiter
        _push_limiter.reset()
    except Exception:
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


def _make_user(db, email="owner@bonbox.test") -> User:
    u = User(
        email=email,
        password_hash="x",
        business_name="Mirabelle Café",
        business_type="cafe",
        currency="DKK",
        plan="free",
        email_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _make_sub(
    db,
    user: User,
    endpoint: str | None = None,
    *,
    fail_count: int = 0,
) -> PushSubscription:
    """Insert a fake PushSubscription row directly. The endpoint is a
    random opaque URL — we don't actually fan a push to it in unit tests
    (pywebpush is patched at the module boundary)."""
    sub = PushSubscription(
        user_id=user.id,
        endpoint=endpoint or f"https://fcm.googleapis.com/fcm/send/{uuid.uuid4().hex}",
        p256dh="BJxXr-fake-p256dh-key-base64url-encoded-32-bytes==",
        auth="fake-auth-secret-16b",
        user_agent="Test/1.0",
        fail_count=fail_count,
    )
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return sub


# ─── 1. /vapid-public-key ─────────────────────────────────────────────


def test_vapid_public_key_returns_200(client):
    res = client.get("/api/push/vapid-public-key")
    assert res.status_code == 200, res.text
    body = res.text.strip()
    # Raw-uncompressed-point base64url public keys are 87 chars
    # (65 bytes → 86.6 → 87 with trim).
    assert len(body) > 60
    assert body == settings.VAPID_PUBLIC_KEY


def test_vapid_public_key_503_when_unset(client, monkeypatch):
    monkeypatch.setattr(settings, "VAPID_PUBLIC_KEY", "")
    monkeypatch.setattr(settings, "VAPID_PRIVATE_KEY", "")
    res = client.get("/api/push/vapid-public-key")
    assert res.status_code == 503, res.text


# ─── 2. /subscribe — happy path + tenant scope ────────────────────────


def test_subscribe_creates_row(client, db):
    user = _make_user(db)
    _override_user(user)

    body = {
        "endpoint": f"https://fcm.googleapis.com/fcm/send/{uuid.uuid4().hex}",
        "keys": {
            "p256dh": "BJxXr-fake-p256dh-key-base64url-encoded-32-bytes==",
            "auth": "fake-auth-secret-16b",
        },
        "user_agent": "Chrome/120 (iPhone)",
    }
    res = client.post("/api/push/subscribe", json=body)
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["created"] is True
    # Endpoint suffix echoed back, not the raw endpoint
    assert out["endpoint_suffix"] == body["endpoint"][-8:]

    # Row exists, scoped to the caller
    row = db.query(PushSubscription).filter(
        PushSubscription.user_id == user.id,
    ).first()
    assert row is not None
    assert row.endpoint == body["endpoint"]
    assert row.user_agent == "Chrome/120 (iPhone)"
    assert row.fail_count == 0


def test_subscribe_is_idempotent_upsert(client, db):
    """Posting the same endpoint twice must NOT create a duplicate row —
    the database UNIQUE constraint exists for a reason but we want a
    clean 200 OK without forcing the frontend to handle conflict logic."""
    user = _make_user(db)
    _override_user(user)

    endpoint = f"https://fcm.googleapis.com/fcm/send/{uuid.uuid4().hex}"
    body = {
        "endpoint": endpoint,
        "keys": {"p256dh": "x" * 30, "auth": "y" * 16},
    }
    res1 = client.post("/api/push/subscribe", json=body)
    res2 = client.post("/api/push/subscribe", json=body)
    assert res1.status_code == 200
    assert res2.status_code == 200
    assert res1.json()["id"] == res2.json()["id"]
    assert res2.json()["created"] is False

    rows = db.query(PushSubscription).filter(
        PushSubscription.user_id == user.id,
        PushSubscription.endpoint == endpoint,
    ).all()
    assert len(rows) == 1


def test_subscribe_requires_auth(client, db):
    """No auth override → get_current_user raises 401."""
    res = client.post("/api/push/subscribe", json={
        "endpoint": f"https://fcm.googleapis.com/fcm/send/{uuid.uuid4().hex}",
        "keys": {"p256dh": "x" * 30, "auth": "y" * 16},
    })
    assert res.status_code == 401, res.text


# ─── 3. /unsubscribe — tenant-scope safety ────────────────────────────


def test_unsubscribe_deletes_own_row(client, db):
    user = _make_user(db)
    sub = _make_sub(db, user)
    _override_user(user)

    res = client.post("/api/push/unsubscribe", json={"endpoint": sub.endpoint})
    assert res.status_code == 200, res.text
    assert res.json()["deleted"] is True
    # Row is gone
    assert db.query(PushSubscription).filter(
        PushSubscription.id == sub.id,
    ).first() is None


def test_unsubscribe_does_not_touch_other_users_row(client, db):
    """Cross-tenant safety: caller B trying to unsubscribe an endpoint
    that belongs to caller A must NOT delete A's row, must NOT 404 (info
    leak), must return 200 with deleted=False."""
    alice = _make_user(db, email="alice@bonbox.test")
    bob = _make_user(db, email="bob@bonbox.test")
    alice_sub = _make_sub(db, alice)

    _override_user(bob)
    res = client.post("/api/push/unsubscribe", json={"endpoint": alice_sub.endpoint})
    assert res.status_code == 200, res.text
    assert res.json()["deleted"] is False

    # Alice's row is untouched
    still_there = db.query(PushSubscription).filter(
        PushSubscription.id == alice_sub.id,
    ).first()
    assert still_there is not None


# ─── 4. push_sender — provider response handling ──────────────────────


def _fake_webpush_factory(status_code: int):
    """Build a fake `webpush` callable that raises a WebPushException
    with a response stub carrying `status_code`."""
    from pywebpush import WebPushException

    class _Resp:
        def __init__(self, code):
            self.status_code = code
            self.text = f"Mock {code}"

    def _fake(*args, **kwargs):
        e = WebPushException(f"Mock {status_code}")
        e.response = _Resp(status_code)
        raise e

    return _fake


def _patch_webpush(monkeypatch, status_code: int | None = None, ok: bool = False):
    """Patch pywebpush.webpush import inside push_sender."""
    if ok:
        # Success path — function returns silently
        def _ok(*a, **kw):
            return None
        monkeypatch.setattr("pywebpush.webpush", _ok)
    else:
        monkeypatch.setattr("pywebpush.webpush", _fake_webpush_factory(status_code))


def test_provider_returns_410_marks_row_for_removal(db, monkeypatch):
    user = _make_user(db)
    sub = _make_sub(db, user)
    _patch_webpush(monkeypatch, status_code=410)

    result = ps.send_to_subscription(sub, {"title": "x", "body": "y"})
    assert result["ok"] is False
    assert result["removed"] is True
    # fail_count is NOT bumped on 410 — the row is going away outright
    db.refresh(sub)
    assert sub.fail_count == 0


def test_provider_returns_500_bumps_fail_count_but_keeps_row(db, monkeypatch):
    user = _make_user(db)
    sub = _make_sub(db, user)
    _patch_webpush(monkeypatch, status_code=500)

    result = ps.send_to_subscription(sub, {"title": "x", "body": "y"})
    assert result["ok"] is False
    assert result["removed"] is False
    assert result["fail_count"] == 1
    assert sub.fail_count == 1
    assert sub.last_failed_at is not None


def test_three_consecutive_500s_remove_the_row(db, monkeypatch):
    user = _make_user(db)
    sub = _make_sub(db, user)
    _patch_webpush(monkeypatch, status_code=500)

    r1 = ps.send_to_subscription(sub, {"title": "x", "body": "y"})
    r2 = ps.send_to_subscription(sub, {"title": "x", "body": "y"})
    r3 = ps.send_to_subscription(sub, {"title": "x", "body": "y"})
    assert r1["removed"] is False
    assert r2["removed"] is False
    assert r3["removed"] is True
    assert sub.fail_count == 3


def test_successful_send_resets_fail_count(db, monkeypatch):
    """Defensive: any success after a string of failures clears the
    counter so we don't accidentally remove a working device after a
    transient provider outage."""
    user = _make_user(db)
    sub = _make_sub(db, user, fail_count=2)
    _patch_webpush(monkeypatch, ok=True)

    result = ps.send_to_subscription(sub, {"title": "x", "body": "y"})
    assert result["ok"] is True
    assert result["removed"] is False
    assert sub.fail_count == 0
    assert sub.last_used_at is not None


# ─── 5. send_brief_push — fan-out + privacy posture ───────────────────


def test_send_brief_push_with_no_subs_skips_silently(db, monkeypatch):
    user = _make_user(db)  # NO subscriptions
    # No need to patch brief — we never call generate when subs is empty.
    result = ps.send_brief_push(db, user)
    assert result == {"attempted": 0, "sent": 0, "removed": 0, "skipped": True}


def test_send_brief_push_skips_when_brief_has_no_text(db, monkeypatch):
    """Empty/headline-less brief means there's nothing useful to push.
    Skip silently rather than waking the owner with "BonBox · Daily
    brief\n" with no body."""
    user = _make_user(db)
    _make_sub(db, user)

    monkeypatch.setattr(
        "app.services.push_sender.get_or_create_brief",
        lambda u, d, **kw: {"headline": "", "insights": []},
        raising=False,
    )
    # Inject the patched module by mutating push_sender's namespace
    import app.services.push_sender as ps_mod
    monkeypatch.setattr(
        "app.services.daily_brief.get_or_create_brief",
        lambda u, d, **kw: {"headline": "", "insights": []},
    )
    result = ps.send_brief_push(db, user)
    assert result["attempted"] == 0
    assert result["skipped"] is True


def test_send_brief_push_payload_strips_financial_data(db, monkeypatch):
    """GDPR-critical assertion: the on-device push payload MUST be a
    one-line headline only — no amounts, no customer names. The brief
    pipeline emits full data; the composer must throw away everything
    but title + body + tag + url."""
    user = _make_user(db)
    _make_sub(db, user)

    fake_brief = {
        "headline": "Yesterday beat the week average by 12%.",
        "insights": [
            {"type": "win", "text": "Best Friday in 3 weeks."},
        ],
        # Things that MUST NOT leak into the push payload:
        "totals": {"net_revenue_kr": 18432.00, "vat_due_kr": 4108.00},
        "khata_outstanding_customers": ["Anders Larsen ApS", "Mette Hansen"],
        "best_seller": "Espresso · 248 sold",
    }
    monkeypatch.setattr(
        "app.services.daily_brief.get_or_create_brief",
        lambda u, d, **kw: dict(fake_brief),
    )

    captured: list[dict] = []

    def _capture(*a, **kw):
        # pywebpush.webpush is called positionally in our code? No — keyword.
        # Capture the `data` kwarg.
        captured.append(kw.get("data"))
        return None

    monkeypatch.setattr("pywebpush.webpush", _capture)

    result = ps.send_brief_push(db, user)
    assert result["attempted"] == 1
    assert result["sent"] == 1
    assert captured, "webpush was not called"
    payload_str = captured[0]
    assert isinstance(payload_str, str)
    payload = json.loads(payload_str)
    # Whitelist: only these four keys allowed.
    assert set(payload.keys()) == {"title", "body", "tag", "data"}
    assert payload["title"] == "BonBox · Daily brief"
    assert payload["body"] == "Yesterday beat the week average by 12%."
    assert payload["tag"] == "bonbox-daily-brief"
    assert payload["data"] == {"url": "/?brief=open"}

    # The full payload as a string must NOT contain any of the
    # financial / PII fields.
    raw = payload_str
    for forbidden in [
        "18432",          # net revenue
        "vat_due",        # field name
        "Anders Larsen",  # customer
        "Mette Hansen",
        "Espresso",
        "248 sold",
    ]:
        assert forbidden not in raw, f"PII leaked into push payload: {forbidden!r}"


# ─── 6. /test endpoint — audit row + fan-out ──────────────────────────


def test_test_endpoint_creates_audit_row_with_counts_only(client, db, monkeypatch):
    user = _make_user(db)
    _make_sub(db, user)
    _make_sub(db, user)  # two devices for the same user
    _override_user(user)

    # Pretend pywebpush succeeds — we don't need real network.
    monkeypatch.setattr("pywebpush.webpush", lambda *a, **kw: None)

    res = client.post("/api/push/test")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["attempted"] == 2
    assert body["sent"] == 2
    assert body["removed"] == 0

    audit_rows = (
        db.query(AuditLog)
        .filter(
            AuditLog.user_id == user.id,
            AuditLog.action == "push.test.sent",
        )
        .all()
    )
    assert len(audit_rows) == 1
    after = json.loads(audit_rows[0].after_state or "{}")
    assert after == {"attempted": 2, "sent": 2, "removed": 0}
    # Critical privacy assertion: audit_log must NEVER store the raw
    # endpoint. Defense-in-depth check below.
    serialized = json.dumps(
        {"before": audit_rows[0].before_state, "after": audit_rows[0].after_state},
    )
    assert "fcm.googleapis.com" not in serialized
    assert "/fcm/send/" not in serialized


# ─── 7. daily_brief_push_job — cron iteration safety ──────────────────


def test_cron_isolates_per_user_failures(db, monkeypatch):
    """One bad row must NOT poison the rest of the batch."""
    alice = _make_user(db, email="alice@bonbox.test")
    bob = _make_user(db, email="bob@bonbox.test")
    _make_sub(db, alice)
    _make_sub(db, bob)

    # Alice's brief generation EXPLODES; Bob's is fine.
    call_count = {"alice": 0, "bob": 0}

    def _explode_for_alice(user, d, **kw):
        if user.id == alice.id:
            call_count["alice"] += 1
            raise RuntimeError("simulated brief generation outage")
        call_count["bob"] += 1
        return {"headline": "All quiet, all clean.", "insights": []}

    monkeypatch.setattr(
        "app.services.daily_brief.get_or_create_brief",
        _explode_for_alice,
    )
    # pywebpush succeeds for Bob.
    monkeypatch.setattr("pywebpush.webpush", lambda *a, **kw: None)

    from app.jobs.daily_brief_push_job import send_daily_brief_pushes

    # Pass a factory that returns our SQLite session.
    SessionLocal = sessionmaker(bind=db.bind, autoflush=False, autocommit=False)
    summary = send_daily_brief_pushes(db_factory=SessionLocal)

    assert summary["users_total"] == 2
    # Alice's brief raised → push_sender catches via send_brief_push's
    # own try/except → skipped silently. Bob's push went through.
    assert summary["sent"] >= 1  # Bob made it through
    # No assertion on summary["errors"] — the brief-gen raise lives
    # inside send_brief_push's try/except, which converts to skipped.


def test_cron_writes_audit_with_counts_only(db, monkeypatch):
    """The aggregate cron audit row MUST contain counts only — never an
    endpoint URL or device user-agent."""
    user = _make_user(db)
    _make_sub(db, user)

    monkeypatch.setattr(
        "app.services.daily_brief.get_or_create_brief",
        lambda u, d, **kw: {"headline": "Good morning, café.", "insights": []},
    )
    monkeypatch.setattr("pywebpush.webpush", lambda *a, **kw: None)

    from app.jobs.daily_brief_push_job import send_daily_brief_pushes

    SessionLocal = sessionmaker(bind=db.bind, autoflush=False, autocommit=False)
    summary = send_daily_brief_pushes(db_factory=SessionLocal)
    assert summary["sent"] == 1

    # Audit row exists, counts only.
    rows = (
        db.query(AuditLog)
        .filter(AuditLog.action == "push.brief.sent")
        .all()
    )
    assert len(rows) == 1
    after = json.loads(rows[0].after_state or "{}")
    assert set(after.keys()) <= {"attempted", "sent", "removed"}
    assert after["sent"] == 1
    # No endpoint leak — anywhere in the row.
    serialized = json.dumps(
        {"before": rows[0].before_state, "after": rows[0].after_state}
    )
    assert "fcm.googleapis.com" not in serialized
    assert "/fcm/send/" not in serialized


def test_cron_skips_locked_users(db, monkeypatch):
    """is_locked users must NOT receive pushes. They can't log in anyway,
    no point burning push provider budget."""
    user = _make_user(db, email="locked@bonbox.test")
    user.is_locked = True
    db.commit()
    _make_sub(db, user)

    monkeypatch.setattr(
        "app.services.daily_brief.get_or_create_brief",
        lambda u, d, **kw: {"headline": "Should not be sent", "insights": []},
    )
    monkeypatch.setattr("pywebpush.webpush", lambda *a, **kw: None)

    from app.jobs.daily_brief_push_job import send_daily_brief_pushes

    SessionLocal = sessionmaker(bind=db.bind, autoflush=False, autocommit=False)
    summary = send_daily_brief_pushes(db_factory=SessionLocal)
    assert summary["users_total"] == 0  # locked user filtered at SQL layer
    assert summary["sent"] == 0


# ─── 8. /test endpoint — VAPID-not-configured graceful ────────────────


def test_test_endpoint_503_when_vapid_unset(client, db, monkeypatch):
    user = _make_user(db)
    _make_sub(db, user)
    _override_user(user)
    monkeypatch.setattr(settings, "VAPID_PUBLIC_KEY", "")
    monkeypatch.setattr(settings, "VAPID_PRIVATE_KEY", "")

    res = client.post("/api/push/test")
    assert res.status_code == 503, res.text
