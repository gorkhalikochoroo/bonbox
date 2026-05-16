"""Tests for the 4-layer anti-bot signup defenses (added 2026-05-16
after the nejesap768@hilostar.com fuzzing incident).

Defense layers exercised here:
  1. Honeypot field (`website`) — bots fill it, humans never see it
  2. Disposable email denylist — covered in test_account_lockdown.py
  3. MX-record DNS check — domain must have working mail servers
  4. Random-pattern heuristic — flags but does NOT reject (post-success
     SecurityEvent so admin can correlate later)

The first three RETURN 422 with a generic message (no enumeration —
attacker can't tell which check fired). The fourth lets the signup
through but writes `signup_flagged_random_pattern` to SecurityEvent.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.security_event import SecurityEvent

_db_ready.set()


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
    try:
        from app.routers.auth import limiter
        limiter.reset()
    except Exception:
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


_BASE = {
    "password": "Validpass1",
    "business_name": "Café Test",
    "business_type": "restaurant",
    "currency": "DKK",
}


# ─────────────────────── Honeypot ───────────────────────


def test_honeypot_non_empty_rejects_signup(db_session, client):
    """Bot fills the hidden `website` field → rejected with generic 422."""
    r = client.post("/api/auth/register", json={
        **_BASE,
        "email": "totally-real-user@gmail.com",
        "website": "https://bot-saw-this-input.example",
    })
    assert r.status_code == 422
    # Generic message — no leak about WHICH check failed
    assert "please try again" in r.json()["detail"].lower() or "could not be completed" in r.json()["detail"].lower()


def test_honeypot_empty_string_allows_signup(db_session, client):
    """Default empty honeypot value must NOT block real users."""
    r = client.post("/api/auth/register", json={
        **_BASE,
        "email": "real-user@gmail.com",
        "website": "",
    })
    assert r.status_code == 201


def test_honeypot_omitted_allows_signup(db_session, client):
    """Older clients that don't send `website` at all must still work."""
    r = client.post("/api/auth/register", json={
        **_BASE,
        "email": "older-client@gmail.com",
    })
    assert r.status_code == 201


def test_honeypot_writes_security_event(db_session, client):
    """Every honeypot trip is auditable so we can measure bot pressure."""
    client.post("/api/auth/register", json={
        **_BASE,
        "email": "trapped@gmail.com",
        "website": "filled-by-bot",
    })
    events = db_session.query(SecurityEvent).filter(
        SecurityEvent.event_type == "signup_blocked_honeypot"
    ).all()
    assert len(events) == 1
    assert events[0].user_id is None  # no user row created
    assert "trapped@gmail.com" in (events[0].detail or "")


# ─────────────────────── MX record check ───────────────────────


def test_whitelisted_provider_skips_dns(db_session, client):
    """gmail.com / outlook.com etc. don't trigger a DNS lookup — proven
    by mocking dns.resolver.resolve and asserting it's NOT called."""
    with patch("dns.resolver.Resolver") as mock_resolver_cls:
        r = client.post("/api/auth/register", json={
            **_BASE,
            "email": "user@gmail.com",
        })
        assert r.status_code == 201
        # Resolver instance should never have been constructed
        mock_resolver_cls.assert_not_called()


def test_no_mx_record_blocks_signup(db_session, client):
    """Custom domain with no MX records → 422 'doesn't appear to exist'.

    Domain must be syntactically valid (EmailStr passes) but have no MX
    records — we mock dns.resolver to simulate NXDOMAIN."""
    from app.routers.auth import _domain_has_mx
    _domain_has_mx.cache_clear()  # don't pick up prior test's cached result

    import dns.resolver as _dns
    with patch("dns.resolver.Resolver") as mock_resolver_cls:
        mock_instance = mock_resolver_cls.return_value
        mock_instance.resolve.side_effect = _dns.NXDOMAIN()

        r = client.post("/api/auth/register", json={
            **_BASE,
            "email": "fake@nonexistent-shop-zzz9.com",
        })
        assert r.status_code == 422
        detail = r.json()["detail"]
        assert isinstance(detail, str), f"expected string detail, got {type(detail).__name__}: {detail!r}"
        assert "doesn't appear to exist" in detail.lower() or "spelling" in detail.lower()


def test_mx_lookup_timeout_fails_open(db_session, client):
    """If DNS is slow/broken, we let signup proceed — disposable list
    + honeypot still catch the bulk of abuse, and we don't want to
    lock out real users during a network blip."""
    from app.routers.auth import _domain_has_mx
    _domain_has_mx.cache_clear()

    with patch("dns.resolver.Resolver") as mock_resolver_cls:
        mock_instance = mock_resolver_cls.return_value
        mock_instance.resolve.side_effect = TimeoutError("dns slow")

        r = client.post("/api/auth/register", json={
            **_BASE,
            "email": "user@my-restaurant.dk",
        })
        # fail open — signup succeeds
        assert r.status_code == 201


def test_mx_check_writes_security_event_on_block(db_session, client):
    """Audit the no-MX rejections too — helps spot patterns."""
    from app.routers.auth import _domain_has_mx
    _domain_has_mx.cache_clear()

    import dns.resolver as _dns
    with patch("dns.resolver.Resolver") as mock_resolver_cls:
        mock_resolver_cls.return_value.resolve.side_effect = _dns.NXDOMAIN()
        client.post("/api/auth/register", json={
            **_BASE,
            "email": "fake@nonexistent-domain-zzz.example",
        })
    events = db_session.query(SecurityEvent).filter(
        SecurityEvent.event_type == "signup_blocked_no_mx"
    ).all()
    assert len(events) >= 1


# ─────────────────────── Random-pattern flag ───────────────────────


def test_random_pattern_email_flags_but_succeeds(db_session, client):
    """nejesap768@gmail.com — the exact shape the 2026-05-16 attacker
    used. Allow the signup (false positives possible for legit users)
    but write a SecurityEvent so admin can review later."""
    r = client.post("/api/auth/register", json={
        **_BASE,
        "email": "nejesap768@gmail.com",  # gmail = whitelisted, MX skip
    })
    assert r.status_code == 201

    events = db_session.query(SecurityEvent).filter(
        SecurityEvent.event_type == "signup_flagged_random_pattern"
    ).all()
    assert len(events) == 1
    assert "nejesap768" in (events[0].detail or "")


def test_normal_email_not_flagged(db_session, client):
    """Real-looking emails don't trip the heuristic — no false positive
    SecurityEvent on signup."""
    r = client.post("/api/auth/register", json={
        **_BASE,
        "email": "manoj.acharya@gmail.com",
    })
    assert r.status_code == 201

    events = db_session.query(SecurityEvent).filter(
        SecurityEvent.event_type == "signup_flagged_random_pattern"
    ).all()
    assert len(events) == 0


def test_first_last_dot_pattern_not_flagged(db_session, client):
    """Dotted firstname.lastname emails are common — must not flag."""
    r = client.post("/api/auth/register", json={
        **_BASE,
        "email": "anne.larsen@gmail.com",
    })
    assert r.status_code == 201
    events = db_session.query(SecurityEvent).filter(
        SecurityEvent.event_type == "signup_flagged_random_pattern"
    ).all()
    assert len(events) == 0


def test_initials_with_digits_not_flagged(db_session, client):
    """Short initials + birthyear (jh1985@gmail.com) is common — don't
    flag. The pattern requires 4+ letter cluster (jh1985 only has 2)."""
    r = client.post("/api/auth/register", json={
        **_BASE,
        "email": "jh1985@gmail.com",
    })
    assert r.status_code == 201
    events = db_session.query(SecurityEvent).filter(
        SecurityEvent.event_type == "signup_flagged_random_pattern"
    ).all()
    assert len(events) == 0
