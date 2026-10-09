"""CMS-2 — "Sign out other devices" and password change keep the shared-device
("Delt enhed") PIN curtain.

Both endpoints bump token_version and re-mint THIS device's token. They used to
mint a plain token, so a staffer holding the shared iPad could tap Profile →
"Sign out other devices" (no password) and the curtain was gone for good:
reports, tax, cash flow, bank and payroll readable without the PIN. Lifting the
curtain needs the account password (POST /api/auth/device-pin/disable-shared).

Each re-mint now carries `sd` + `dn` forward from the request's own token,
exactly like the sliding-refresh middleware. A normal session stays normal.
"""
import pytest
from jose import jwt
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.testclient import TestClient

from app.config import settings
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.user import User
from app.services.auth import create_access_token, hash_password

_db_ready.set()

_PAYROLL = "/api/staff/payroll/estimate?period_start=2026-10-01&period_end=2026-10-07"


def _decode(tok):
    return jwt.decode(tok, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])


@pytest.fixture
def db(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SL = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SL()

    def _override_get_db():
        yield s

    app.dependency_overrides[get_db] = _override_get_db
    # The curtain middleware opens its own SessionLocal() at call time.
    import app.database as _dbmod
    monkeypatch.setattr(_dbmod, "SessionLocal", SL, raising=False)
    from app.routers import auth as _auth_router
    _auth_router.limiter.reset()
    try:
        yield s
    finally:
        app.dependency_overrides.pop(get_db, None)
        _auth_router.limiter.reset()
        s.close()


@pytest.fixture
def client(db):
    return TestClient(app)


def _owner(db):
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("ownerpw123"),
        business_name="Bon Café", business_type="restaurant", currency="DKK",
        plan="pro", role="owner", email_verified=True,
        device_pin_hash=hash_password("4271"),
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _bearer(tok):
    return {"Authorization": f"Bearer {tok}"}


def test_sign_out_all_keeps_the_curtain(db, client):
    owner = _owner(db)
    sd = create_access_token(str(owner.id), 0, shared_device=True, device_nonce="n1")
    # Curtain is down before.
    r = client.get(_PAYROLL, headers=_bearer(sd))
    assert r.status_code == 403 and r.json()["detail"]["code"] == "device_pin_required"

    r = client.post("/api/auth/sign-out-all", headers=_bearer(sd))
    assert r.status_code == 200, r.text
    fresh = r.json()["token"]
    p = _decode(fresh)
    assert p["sd"] is True and p["dn"] == "n1"
    assert p["tv"] == 1  # the other devices really were signed out

    # Same device, fresh token: still curtained, still shared.
    r = client.get(_PAYROLL, headers=_bearer(fresh))
    assert r.status_code == 403 and r.json()["detail"]["code"] == "device_pin_required"
    r = client.get("/api/auth/device-pin/status", headers=_bearer(fresh))
    assert r.status_code == 200 and r.json()["shared"] is True


def test_sign_out_all_cookie_session_keeps_the_curtain(db, client):
    owner = _owner(db)
    sd = create_access_token(str(owner.id), 0, shared_device=True, device_nonce="n2")
    client.cookies.set("bonbox_session", sd)
    client.cookies.set("bonbox_csrf", "c")
    r = client.post("/api/auth/sign-out-all", headers={"X-CSRF-Token": "c"})
    assert r.status_code == 200, r.text
    p = _decode(r.json()["token"])
    assert p["sd"] is True and p["dn"] == "n2"
    set_cookie = r.headers.get("set-cookie", "")
    assert r.json()["token"] in set_cookie


def test_password_change_keeps_the_curtain(db, client):
    owner = _owner(db)
    sd = create_access_token(str(owner.id), 0, shared_device=True, device_nonce="n3")
    r = client.post(
        "/api/auth/change-password",
        json={"current_password": "ownerpw123", "new_password": "newpass-8642"},
        headers=_bearer(sd),
    )
    assert r.status_code == 200, r.text
    fresh = r.json()["token"]
    p = _decode(fresh)
    assert p["sd"] is True and p["dn"] == "n3"
    r = client.get(_PAYROLL, headers=_bearer(fresh))
    assert r.status_code == 403 and r.json()["detail"]["code"] == "device_pin_required"


def test_a_normal_session_stays_normal(db, client):
    owner = _owner(db)
    plain = create_access_token(str(owner.id), 0)
    r = client.post("/api/auth/sign-out-all", headers=_bearer(plain))
    assert r.status_code == 200
    p = _decode(r.json()["token"])
    assert "sd" not in p and "dn" not in p
    r = client.post(
        "/api/auth/change-password",
        json={"current_password": "ownerpw123", "new_password": "newpass-8642"},
        headers=_bearer(r.json()["token"]),
    )
    assert r.status_code == 200
    p = _decode(r.json()["token"])
    assert "sd" not in p and "dn" not in p


def test_only_the_password_route_lifts_the_curtain(db, client):
    """The designed way out still works after a sign-out-all."""
    owner = _owner(db)
    sd = create_access_token(str(owner.id), 0, shared_device=True, device_nonce="n4")
    fresh = client.post("/api/auth/sign-out-all", headers=_bearer(sd)).json()["token"]
    r = client.post("/api/auth/device-pin/disable-shared",
                    json={"password": "ownerpw123"}, headers=_bearer(fresh))
    assert r.status_code == 200
    assert "sd" not in _decode(r.json()["token"])


def test_the_reminting_routes_are_not_refreshed_over():
    """Both routes bump token_version and set their own cookie. A midway
    sliding refresh would re-mint from the OLD token (old tv) and overwrite
    that cookie, signing this device out on its next request."""
    from app.main import _REFRESH_EXEMPT_PATHS
    assert "/api/auth/sign-out-all" in _REFRESH_EXEMPT_PATHS
    assert "/api/auth/change-password" in _REFRESH_EXEMPT_PATHS
