"""E (speed push, 15 Oct) — the server half of "reads go without custom headers".

The web app now sends a GET with no X-BonBox-Platform and no X-CSRF-Token, so
the browser makes it a CORS "simple" request with no OPTIONS preflight. That is
only safe if the server never needed either header on a read, and still
demands the CSRF token on every write. Pinned here, against the real app:

  • a cookie-authenticated GET without either header is answered (200), with
    the CORS headers a credentialed simple request needs;
  • a cookie-authenticated first-party POST without X-CSRF-Token is refused
    (403 "CSRF token missing"); with a mismatched token, refused too; with the
    matching token it passes the CSRF layer;
  • the Stripe checkout POST still reads X-BonBox-Platform: "ios" is blocked
    (Apple IAP rule), "web" is not blocked by that rule.
"""
import uuid

import pytest
from fastapi.testclient import TestClient
from app.database import Base
from app.main import _db_ready, app
from app.models.user import User
from app.services.auth import create_access_token, hash_password

_db_ready.set()
ORIGIN = "https://www.bonbox.dk"


@pytest.fixture
def owner_cookie():
    # The global engine, not an override: the write guards in main.py look the
    # role up through it (app.utils.off_loop), before any dependency runs.
    from app.database import SessionLocal, engine
    Base.metadata.create_all(engine)
    s = SessionLocal()
    u = User(id=uuid.uuid4(), email=f"csrf-{uuid.uuid4().hex[:8]}@bonbox.test",
             password_hash=hash_password("x"), business_name="Csrf Café", business_type="cafe",
             currency="DKK", role="owner", email_verified=True)
    s.add(u)
    s.commit()
    tok = create_access_token(str(u.id), token_version=getattr(u, "token_version", None))
    s.close()
    yield tok


def _client(cookies):
    c = TestClient(app, base_url="https://api.bonbox.dk")
    for k, v in cookies.items():
        c.cookies.set(k, v)
    return c


def test_cookie_get_without_custom_headers_is_answered_with_cors(owner_cookie):
    c = _client({"bonbox_session": owner_cookie})
    r = c.get("/api/auth/me", headers={"Origin": ORIGIN})
    assert r.status_code == 200, r.text
    assert r.headers.get("access-control-allow-origin") == ORIGIN
    assert r.headers.get("access-control-allow-credentials") == "true"


def test_dashboard_batch_get_needs_no_custom_header(owner_cookie):
    c = _client({"bonbox_session": owner_cookie})
    r = c.get("/api/dashboard/batch", params={"weather": 0}, headers={"Origin": ORIGIN})
    assert r.status_code == 200, r.text


def test_write_without_csrf_token_is_refused(owner_cookie):
    c = _client({"bonbox_session": owner_cookie, "bonbox_csrf": "tok-1"})
    r = c.post("/api/expenses", json={"amount": 10}, headers={"Origin": ORIGIN})
    assert r.status_code == 403
    assert r.json()["detail"] == "CSRF token missing"


def test_write_with_mismatched_csrf_token_is_refused(owner_cookie):
    c = _client({"bonbox_session": owner_cookie, "bonbox_csrf": "tok-1"})
    r = c.post("/api/expenses", json={"amount": 10},
               headers={"Origin": ORIGIN, "X-CSRF-Token": "tok-2"})
    assert r.status_code == 403
    assert r.json()["detail"] == "CSRF token mismatched"


def test_write_with_matching_csrf_token_passes_the_csrf_layer(owner_cookie):
    c = _client({"bonbox_session": owner_cookie, "bonbox_csrf": "tok-1"})
    r = c.post("/api/expenses", json={"amount": 10},
               headers={"Origin": ORIGIN, "X-CSRF-Token": "tok-1"})
    # Whatever the handler says about this body, it is not the CSRF layer.
    assert r.status_code != 403 or "CSRF" not in str(r.json().get("detail", ""))


def test_checkout_still_reads_the_platform_header(owner_cookie, monkeypatch):
    import app.routers.billing as billing
    monkeypatch.setattr(billing.stripe_billing, "is_configured", lambda: True)
    c = _client({"bonbox_session": owner_cookie, "bonbox_csrf": "tok-1"})
    ios = c.post("/api/billing/stripe/checkout-session", json={"plan": "starter"},
                 headers={"Origin": ORIGIN, "X-CSRF-Token": "tok-1", "X-BonBox-Platform": "ios"})
    assert ios.status_code == 403
    assert ios.json().get("redirect_to_web") is True
