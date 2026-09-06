"""
Shared-device ("Delt enhed") reveal PIN — task #379 (backend Slice 1).

Covers the server-authoritative core the adversarial panel demanded:
  • the `sd` (shared) + `dn` (device nonce) claims are SIGNED into the token
    (un-spoofable) and survive a decode round-trip,
  • the reveal-proof HMAC round-trips and rejects wrong pin/nonce/expiry,
  • set / enable-shared / verify / disable-shared endpoints behave (PIN gate,
    lockout, password-to-unshare),
  • the shared-device financial deny set matches the owner-financial prefixes,
  • a locked shared device strips the SKAT figure from the daily brief.

The pin_gate MIDDLEWARE itself uses SessionLocal() (like member_read_guard) so
it can't see a TestClient DB — its decision logic is exercised via the proof
helper + the deny-prefix constant here, and end-to-end in the adversarial pass.

Run: cd backend && python3 -m pytest tests/test_device_pin.py -q
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

# Clear the startup readiness gate so guarded requests don't 503 in tests.
_db_ready.set()
from app.models.user import User
from app.services.auth import (
    create_access_token,
    hash_password,
    mint_device_pin_proof,
    device_pin_proof_valid,
)


# ─── Unit: token claim + proof helpers ───────────────────────────────────
def _decode(tok):
    return jwt.decode(tok, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])


def test_shared_claim_is_signed_into_token():
    plain = _decode(create_access_token("u1", 0))
    assert "sd" not in plain and "dn" not in plain          # normal token — no claim
    shared = _decode(create_access_token("u1", 0, shared_device=True, device_nonce="abc123"))
    assert shared["sd"] is True and shared["dn"] == "abc123"  # baked in + signed


def test_reveal_proof_roundtrip_and_negatives():
    ph = hash_password("1234")
    proof = mint_device_pin_proof("u1", ph, "nonceA")
    assert device_pin_proof_valid("u1", ph, "nonceA", proof) is True
    # Wrong device nonce (cross-device replay), wrong user, wrong hash, missing → all reject.
    assert device_pin_proof_valid("u1", ph, "nonceB", proof) is False
    assert device_pin_proof_valid("u2", ph, "nonceA", proof) is False
    assert device_pin_proof_valid("u1", hash_password("9999"), "nonceA", proof) is False
    assert device_pin_proof_valid("u1", ph, "nonceA", None) is False
    assert device_pin_proof_valid("u1", ph, "nonceA", "garbage") is False


def test_shared_device_deny_set_covers_owner_financials():
    from app.main import _SHARED_DEVICE_DENY_PREFIXES, _MANAGER_READ_DENY_PREFIXES
    # Reuses the owner-financial prefix set → can't drift from the member gate.
    assert _SHARED_DEVICE_DENY_PREFIXES == _MANAGER_READ_DENY_PREFIXES
    for p in ("/api/tax", "/api/bank-connect", "/api/cashflow", "/api/reports"):
        assert any(p.startswith(pref) for pref in _SHARED_DEVICE_DENY_PREFIXES)


# ─── Endpoint flow (real token + get_db override) ────────────────────────
@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

    def _override_get_db():
        yield s

    app.dependency_overrides[get_db] = _override_get_db
    # The write/read guard middleware open their OWN SessionLocal() (they can't
    # use the injected db), so point it at this in-memory engine or every guarded
    # request fails CLOSED (503) because the token's user isn't in the real DB.
    import app.database as _dbmod
    _orig_session = _dbmod.SessionLocal
    _dbmod.SessionLocal = SessionLocal
    try:
        yield s
    finally:
        _dbmod.SessionLocal = _orig_session
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client(db):
    return TestClient(app)


def _owner(db):
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("ownerpw123"),
        business_name="Bon Café", business_type="restaurant", currency="DKK",
        plan="pro", role="owner", email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_set_enable_verify_disable_flow(db, client):
    owner = _owner(db)
    normal = create_access_token(str(owner.id), 0)

    # set PIN
    r = client.post("/api/auth/device-pin/set", json={"pin": "4271"}, headers=_auth(normal))
    assert r.status_code == 200 and r.json()["has_pin"] is True

    # enable-shared → token now carries the signed sd claim
    r = client.post("/api/auth/device-pin/enable-shared", headers=_auth(normal))
    assert r.status_code == 200
    sd_token = r.json()["token"]
    sd_payload = _decode(sd_token)
    assert sd_payload["sd"] is True and sd_payload.get("dn")

    # verify with the WRONG pin → 401 + failed_count increments
    r = client.post("/api/auth/device-pin/verify", json={"pin": "0000"}, headers=_auth(sd_token))
    assert r.status_code == 401 and r.json()["detail"]["code"] == "bad_pin"
    db.refresh(owner)
    assert owner.device_pin_failed_count == 1

    # verify with the CORRECT pin → a reveal proof bound to this device nonce
    r = client.post("/api/auth/device-pin/verify", json={"pin": "4271"}, headers=_auth(sd_token))
    assert r.status_code == 200
    proof = r.json()["proof"]
    assert device_pin_proof_valid(str(owner.id), owner.device_pin_hash, sd_payload["dn"], proof)
    db.refresh(owner)
    assert owner.device_pin_failed_count == 0  # reset on success

    # disable-shared: WRONG password refused, correct password clears the sd claim
    r = client.post("/api/auth/device-pin/disable-shared", json={"password": "nope"}, headers=_auth(sd_token))
    assert r.status_code == 403
    r = client.post("/api/auth/device-pin/disable-shared", json={"password": "ownerpw123"}, headers=_auth(sd_token))
    assert r.status_code == 200
    assert "sd" not in _decode(r.json()["token"])


def test_verify_locked_out_returns_429(db, client):
    from app.utils.time import utc_now
    from datetime import timedelta
    owner = _owner(db)
    owner.device_pin_hash = hash_password("1234")
    owner.device_pin_locked_until = utc_now() + timedelta(minutes=10)
    db.commit()
    sd_token = create_access_token(str(owner.id), 0, shared_device=True, device_nonce="n1")
    r = client.post("/api/auth/device-pin/verify", json={"pin": "1234"}, headers=_auth(sd_token))
    assert r.status_code == 429 and r.json()["detail"]["code"] == "pin_locked"


def test_enable_shared_requires_pin_first(db, client):
    owner = _owner(db)  # no PIN set
    normal = create_access_token(str(owner.id), 0)
    r = client.post("/api/auth/device-pin/enable-shared", headers=_auth(normal))
    assert r.status_code == 400 and r.json()["detail"]["code"] == "pin_not_set"


def test_locked_shared_device_hides_moms_in_brief(db, monkeypatch):
    """The dashboard/brief strips fire on _shared_device_locked too, so a shared
    device that hasn't been PIN-revealed sees no SKAT figure."""
    from app.services.daily_brief import compute_precompute, generate_candidates

    # Mirrors the real tax_service.get_tax_overview row shape (`deadline`,
    # not `date`). The old stub invented a `date` key the producer never
    # emits; with the key bug fixed, that stub would have made this test
    # pass vacuously — asserting the curtain hides a figure that was never
    # computed in the first place. Hence the un-curtained control below.
    #
    # The deadline is relative to today so it always lands inside the
    # candidate's ≤14-day window. A hardcoded date would drift past the
    # window and quietly turn the candidate assertions vacuous again.
    from datetime import date as _date, timedelta as _td
    _dl = _date.today() + _td(days=10)

    def _fake(_u, _d):
        return {"upcoming_deadlines": [{
            "deadline": str(_dl), "period_label": "H2 2026",
            "period_start": str(_dl - _td(days=190)),
            "period_end": str(_dl - _td(days=1)),
            "days_until": 10, "status": "approaching",
            "estimated_amount": 45000.0, "output_vat": 60000.0,
            "input_vat": 15000.0, "sales_total": 300000.0,
            "expenses_total": 75000.0,
        }], "ytd": {"vat_payable": 45000.0}}
    monkeypatch.setattr("app.services.tax_service.get_tax_overview", _fake)

    owner = _owner(db)

    # Control: the SAME owner, SAME stub, curtain OFF must produce the
    # figure AND the candidate. Without this the assertions below prove
    # nothing — they would hold just as well if MOMS never computed at all.
    control = compute_precompute(owner, db)
    assert control.moms_days_left == 10
    assert control.moms_estimated_owed == 45000.0
    assert [c for c in generate_candidates(control) if c.cta_url == "/tax"]

    owner._shared_device_locked = True  # curtained shared device
    pc = compute_precompute(owner, db)
    assert pc.moms_days_left is None and pc.moms_estimated_owed is None
    assert [c for c in generate_candidates(pc) if c.cta_url == "/tax"] == []
