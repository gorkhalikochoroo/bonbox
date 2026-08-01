"""
Host-stand pairing code — a device credential with reservations-only reach.

WHAT THESE TESTS ARE FOR. This adds a SECOND way to authenticate into an app
that holds bank balances, tax figures and payroll. The dangerous failure is not
"the code doesn't work" — it is "the code works for more than it should". So
the load-bearing tests here are the NEGATIVE ones: a stand credential must not
reach owner surfaces, must not reach another tenant, and must stop working the
instant it is revoked.

Locks under test:
  • A code pairs a device and the device can run a service (read the book, seat
    a guest, take a walk-in, record an allergy).
  • The credential CANNOT reach owner config — settings, slug, resources,
    layout, behandlinger, insights. Verified structurally: no route accepts it.
  • It is tenant-locked: the owner is re-derived from the row, never the client.
  • Revocation is immediate — the next request fails.
  • Codes are single-use, expire, and every failure mode returns the SAME 404
    so they cannot be enumerated.
  • The owner can see their devices, and a spent code is never shown again.

Run: cd backend && python3 -m pytest tests/test_stand_link.py -x -q
"""

import uuid
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.stand_link import StandLink
from app.models.user import User
from app.services.auth import hash_password

_db_ready.set()
_START = "2026-07-04T19:00:00"
_DAY = "2026-07-04"


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """The 8/minute cap on /stand/join is per-IP and every test request comes
    from the same "testclient" address, so without this the limiter carries
    over and later tests fail with 429 instead of what they assert. Resetting
    keeps each test honest — the cap itself is exercised deliberately in
    test_join_is_rate_limited."""
    from app.routers.stand_link import limiter
    try:
        limiter.reset()
    except Exception:  # noqa: BLE001 — storage backend without reset()
        pass
    yield


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
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(db, plan="pro"):
    u = User(
        email=f"o-{uuid.uuid4().hex[:8]}@bonbox.dk",
        password_hash=hash_password("x"),
        business_name="Bistro Nørrebro", business_type="restaurant",
        currency="DKK", role="owner", timezone="Europe/Copenhagen", plan=plan,
    )
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(user_id=u.id)); db.commit()
    return u


def _as(user):
    from app.routers import stand_link as S
    from app.routers import reservations as R
    app.dependency_overrides[S.get_current_user] = lambda: user
    app.dependency_overrides[R.get_current_user] = lambda: user


def _mint(client, label="Door iPad"):
    r = client.post("/api/stand/links", json={"label": label})
    assert r.status_code == 200, r.text
    return r.json()


def _pair(client, code):
    r = client.post("/api/stand/join", json={"code": code})
    assert r.status_code == 200, r.text
    return r.json()["path"].rsplit("/", 1)[-1]  # the token


def _book(client, user, **body):
    """Create a booking as the OWNER, so the stand has something to work with."""
    _as(user)
    base = {"guest_name": "Agnes", "party_size": 4, "starts_at": _START,
            "auto_assign": False, "allow_overflow": True}
    base.update(body)
    r = client.post("/api/reservations/book", json=base)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


# ── it works ─────────────────────────────────────────────────────────

def test_code_pairs_and_opens_the_book(client, db):
    u = _seed(db); _as(u)
    rid = _book(client, u)
    minted = _mint(client)
    assert len(minted["code"]) == 6
    token = _pair(client, minted["code"])

    r = client.get(f"/api/stand/{token}/book?day={_DAY}")
    assert r.status_code == 200, r.text
    ids = [x["id"] for x in r.json().get("reservations", [])]
    assert rid in ids


def test_stand_can_run_a_service(client, db):
    """Seat a guest and take a walk-in — without an owner session."""
    u = _seed(db); _as(u)
    rid = _book(client, u)
    token = _pair(client, _mint(client)["code"])

    seated = client.patch(
        f"/api/stand/{token}/reservations/{rid}/status", json={"status": "seated"}
    )
    assert seated.status_code == 200, seated.text

    walkin = client.post(f"/api/stand/{token}/book", json={
        "guest_name": "Walk-in", "party_size": 2, "starts_at": _START,
        "status": "seated", "source": "walk_in",
        "auto_assign": False, "allow_overflow": True,
    })
    assert walkin.status_code in (200, 201), walkin.text


def test_stand_can_record_an_allergy(client, db):
    """The stand chimes for severe allergies; it must be able to enter one."""
    u = _seed(db); _as(u)
    rid = _book(client, u)
    token = _pair(client, _mint(client)["code"])
    r = client.patch(f"/api/stand/{token}/reservations/{rid}", json={
        "allergy_note": "Skaldyr — ingen bisque", "allergy_severity": "severe",
    })
    assert r.status_code == 200, r.text


# ── what it must NOT reach ───────────────────────────────────────────

def test_credential_reaches_no_owner_config_route(client, db):
    """Structural: the ONLY routes accepting a stand token are the wrapped
    ones. If someone later wraps settings or slug, this test fails loudly."""
    from app.routers import stand_link as S

    wrapped = {r.path for r in S.router.routes if "{token}" in r.path}
    allowed = {
        "/stand/{token}/book",
        "/stand/{token}/resources",
        "/stand/{token}/waitlist",
        "/stand/{token}/reservations/{reservation_id}",
        "/stand/{token}/reservations/{reservation_id}/status",
    }
    assert wrapped == allowed, (
        "the stand credential's reach changed — this is a security boundary, "
        f"unexpected: {wrapped ^ allowed}"
    )


def test_owner_config_paths_404_under_the_stand_prefix(client, db):
    u = _seed(db); _as(u)
    token = _pair(client, _mint(client)["code"])
    for path in ("settings", "slug", "insights", "behandlinger", "resources/layout"):
        r = client.get(f"/api/stand/{token}/{path}")
        assert r.status_code in (404, 405), f"{path} reachable: {r.status_code}"


def test_token_is_tenant_locked(client, db):
    """Venue A's device must never see venue B's book, even though both use
    the same wrapped handlers."""
    a, b = _seed(db), _seed(db)
    _as(a); rid_a = _book(client, a)
    token_a = _pair(client, _mint(client)["code"])

    _as(b); rid_b = _book(client, b, guest_name="Other Venue")

    r = client.get(f"/api/stand/{token_a}/book?day={_DAY}")
    assert r.status_code == 200
    ids = [x["id"] for x in r.json().get("reservations", [])]
    assert rid_a in ids
    assert rid_b not in ids, "cross-tenant leak"


def test_stand_cannot_touch_another_tenants_booking(client, db):
    a, b = _seed(db), _seed(db)
    _as(a); token_a = _pair(client, _mint(client)["code"])
    _as(b); rid_b = _book(client, b)

    r = client.patch(
        f"/api/stand/{token_a}/reservations/{rid_b}/status", json={"status": "seated"}
    )
    assert r.status_code == 404, r.text


# ── revocation ───────────────────────────────────────────────────────

def test_revoke_kills_the_device_immediately(client, db):
    u = _seed(db); _as(u)
    minted = _mint(client)
    token = _pair(client, minted["code"])
    assert client.get(f"/api/stand/{token}/book?day={_DAY}").status_code == 200

    assert client.delete(f"/api/stand/links/{minted['id']}").status_code == 200
    after = client.get(f"/api/stand/{token}/book?day={_DAY}")
    assert after.status_code == 404, "a revoked device kept working"


def test_owner_cannot_revoke_another_venues_device(client, db):
    a, b = _seed(db), _seed(db)
    _as(a); minted = _mint(client)
    _as(b)
    assert client.delete(f"/api/stand/links/{minted['id']}").status_code == 404


# ── the code itself ──────────────────────────────────────────────────

def test_code_is_single_use(client, db):
    """A photographed code must not pair a second device later."""
    u = _seed(db); _as(u)
    code = _mint(client)["code"]
    assert client.post("/api/stand/join", json={"code": code}).status_code == 200
    again = client.post("/api/stand/join", json={"code": code})
    assert again.status_code == 404


def test_expired_code_does_not_resolve(client, db):
    u = _seed(db); _as(u)
    minted = _mint(client)
    row = db.query(StandLink).filter(StandLink.join_code == minted["code"]).first()
    row.code_expires_at = datetime(2020, 1, 1)
    db.commit()
    assert client.post("/api/stand/join", json={"code": minted["code"]}).status_code == 404


def test_every_failure_mode_returns_the_same_404(client, db):
    """No oracle: unknown, malformed, revoked and expired must be
    indistinguishable, or codes become enumerable."""
    u = _seed(db); _as(u)
    minted = _mint(client)
    db.query(StandLink).filter(StandLink.join_code == minted["code"]).update(
        {"active": False}
    )
    db.commit()

    bodies = ["ZZZZZZ", "abc", "!!!!!!", "", minted["code"], "AAAAAAAAAAAAAAAAAAAA"]
    codes = {client.post("/api/stand/join", json={"code": b}).status_code for b in bodies}
    assert codes <= {404, 422}, codes
    # The realistic attacker inputs (well-formed but wrong) must all be 404.
    assert client.post("/api/stand/join", json={"code": "ZZZZZZ"}).status_code == 404
    assert client.post("/api/stand/join", json={"code": minted["code"]}).status_code == 404


def test_join_is_rate_limited(client, db):
    """Brute force is the only attack on a 6-char code, so the cap IS the
    control. 8/minute per IP against 32^6 makes guessing hopeless long before
    the 20-minute TTL expires the code anyway."""
    u = _seed(db); _as(u)
    codes = [client.post("/api/stand/join", json={"code": "ZZZZZZ"}).status_code
             for _ in range(12)]
    assert 429 in codes, "the redemption endpoint is not rate limited"


def test_code_alphabet_excludes_ambiguous_characters(client, db):
    """These get read aloud across a dining room. O/0 and I/1 cost a pairing."""
    from app.routers.stand_link import _ALPHABET
    for ch in "IO01":
        assert ch not in _ALPHABET
    assert len(_ALPHABET) == 32


# ── what the owner sees ──────────────────────────────────────────────

def test_owner_sees_devices_and_a_spent_code_is_hidden(client, db):
    u = _seed(db); _as(u)
    minted = _mint(client, label="Door iPad")

    listing = client.get("/api/stand/links").json()["devices"]
    assert len(listing) == 1
    assert listing[0]["label"] == "Door iPad"
    assert listing[0]["code"] == minted["code"], "an unredeemed code should be visible"

    _pair(client, minted["code"])
    after = client.get("/api/stand/links").json()["devices"][0]
    assert after["paired"] is True
    assert after["code"] is None, "a spent code must not be shown again"


def test_devices_are_scoped_to_their_owner(client, db):
    a, b = _seed(db), _seed(db)
    _as(a); _mint(client)
    _as(b)
    assert client.get("/api/stand/links").json()["devices"] == []
