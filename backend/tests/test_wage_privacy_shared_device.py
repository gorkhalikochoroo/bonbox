"""The "Delt enhed" curtain has to cover the pay rate too.

THE GAP. The wage-privacy redaction shipped 18 Sep 2026 is keyed on ROLE
(`_is_member_view`). A shared-device tablet is logged in as the OWNER — that is
the whole premise of the feature — so on a curtained counter device the
redaction never fired. The revenue hero was curtained, the MOMS figure was
curtained, and a colleague who picked the tablet up read `rate_applied` and
`earned` for every name on the register (/api/staff/hours) and `base_rate` for
every name on the roster (/api/staff/members). Those are exactly the figures
the curtain exists to hide: not a stranger on the internet, the person standing
next to you.

THE FIX — the SAME field-level redaction, keyed on the flag auth.py already
derives from the signed `sd` claim plus the reveal proof
(`_shared_device_locked`). Not a new signal: a second opinion about whether the
curtain is up is a second thing to drift.

WHY REDACT AND NOT DENY. These endpoints are how a host knows who is on
tonight and how to reach them. Adding them to _SHARED_DEVICE_DENY_PREFIXES
would 403 the roster on a counter tablet — the device the feature was built
FOR. Deny where the whole response is money (that set carries /payroll, /tips,
/hours/overview, /schedules/week-cost); redact where the money is mixed into
the work (/hours, /hours/summary, /members).

AND THE CURTAIN IS NOT GET-SHAPED. Three later rounds of this same mistake are
pinned below: portal magic-link tokens (impersonation plus the pay) read
straight through _require_owner_actor, the payroll PDF and its email-to-anyone
sibling walked past the middleware because they are POSTs, and the roster
editor's read-modify-write turned a nulled rate into an ERASED one.

THE POSITIVE CONTROLS ARE THE POINT. A redaction test is satisfied by a 403 and
by a broken endpoint alike, so every assertion here is paired with an owner who
must still SEE the number — uncurtained, and revealed-by-PIN. Without them this
file would pass just as happily against a tablet that shows nothing at all.

Run:
  cd backend && python3 -m pytest tests/test_wage_privacy_shared_device.py -q
"""
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.testclient import TestClient

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import HoursLogged, StaffMember
from app.models.user import User
from app.services.auth import (
    DEVICE_PIN_HEADER,
    create_access_token,
    hash_password,
    mint_device_pin_proof,
)

_db_ready.set()

_DEVICE_NONCE = "tablet-front-counter"
_PIN = "4271"

REGISTER = "/api/staff/hours?from=2026-09-01&to=2026-09-30"
ROSTER = "/api/staff/members"


@pytest.fixture
def db():
    """The guards open their OWN SessionLocal() (they cannot use the injected
    db), so repoint it at the in-memory engine — otherwise every guarded
    request fails CLOSED (503), which would pass a naive "no rate in the body"
    assertion while proving nothing."""
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

    def _override_get_db():
        yield s

    app.dependency_overrides[get_db] = _override_get_db
    import app.database as _dbmod
    _orig = _dbmod.SessionLocal
    _dbmod.SessionLocal = SessionLocal
    try:
        yield s
    finally:
        _dbmod.SessionLocal = _orig
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client(db):
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_rate_limiters():
    from app.routers import staff as staff_router

    lim = getattr(staff_router, "_limiter", None) or getattr(staff_router, "limiter", None)
    if lim is not None:
        lim.reset()
    yield
    if lim is not None:
        lim.reset()


def _owner(db) -> User:
    """An owner with a reveal PIN set — the precondition for shared mode."""
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("ownerpw123"),
        business_name="Bon Bistro", business_type="cafe", currency="DKK",
        plan="pro", role="owner", email_verified=True, timezone="Europe/Copenhagen",
        device_pin_hash=hash_password(_PIN),
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _roster_member(db, owner: User) -> StaffMember:
    m = StaffMember(
        id=uuid.uuid4(), user_id=owner.id, name="Agnes", role="server",
        active=True, is_deleted=False, base_rate=185.0, evening_rate=205.0,
        tax_card_type="hovedkort", tax_card_rate=38.0, phone="+45 20 00 00 00",
    )
    db.add(m)
    db.commit()
    return m


def _worked(db, owner: User, member: StaffMember) -> HoursLogged:
    """8 hours at 185 kr = 1480 kr. A clean division on purpose: earned ÷ hours
    is the rate, which is why `earned` has to go when `rate_applied` does."""
    import datetime as _dt

    h = HoursLogged(
        id=uuid.uuid4(), user_id=owner.id, staff_id=member.id,
        date=_dt.date(2026, 9, 15), start_time="09:00", end_time="17:00",
        break_minutes=0, total_hours=8.0, rate_applied=185.0, earned=1480.0,
        entry_method="quick",
    )
    db.add(h)
    db.commit()
    return h


def _plain(owner: User) -> dict:
    """A normal session — no shared-device claim at all."""
    return {"Authorization": f"Bearer {create_access_token(str(owner.id), 0)}"}


def _curtained(owner: User) -> dict:
    """A shared-device token with NO reveal proof: the curtain is up."""
    tok = create_access_token(
        str(owner.id), 0, shared_device=True, device_nonce=_DEVICE_NONCE,
    )
    return {"Authorization": f"Bearer {tok}"}


def _revealed(owner: User) -> dict:
    """The same device after the owner typed their PIN — the proof the client
    echoes, minted the way routers/device_pin.py mints it."""
    headers = _curtained(owner)
    headers[DEVICE_PIN_HEADER] = mint_device_pin_proof(
        str(owner.id), owner.device_pin_hash, _DEVICE_NONCE,
    )
    return headers


# ═══ The working-time register ════════════════════════════════════════


def test_curtained_tablet_reads_the_register_without_the_rate(client, db):
    owner = _owner(db)
    member = _roster_member(db, owner)
    _worked(db, owner, member)

    res = client.get(REGISTER, headers=_curtained(owner))
    assert res.status_code == 200, res.text
    rows = res.json()
    assert len(rows) == 1, rows
    assert rows[0]["rate_applied"] is None, rows[0]
    assert rows[0]["earned"] is None, rows[0]
    # The operational half survives — this is why it is redacted, not denied.
    assert float(rows[0]["total_hours"]) == 8.0
    assert rows[0]["start_time"] == "09:00"


def test_revealed_owner_sees_the_rate_on_the_register(client, db):
    """POSITIVE CONTROL. The PIN is what lifts the curtain; if this goes red
    the owner typed their PIN and got nothing back, which reads as broken."""
    owner = _owner(db)
    member = _roster_member(db, owner)
    _worked(db, owner, member)

    res = client.get(REGISTER, headers=_revealed(owner))
    assert res.status_code == 200, res.text
    assert float(res.json()[0]["rate_applied"]) == 185.0
    assert float(res.json()[0]["earned"]) == 1480.0


def test_uncurtained_owner_sees_the_rate_on_the_register(client, db):
    """POSITIVE CONTROL. An ordinary session on the owner's own phone is not a
    shared device and must be untouched by any of this."""
    owner = _owner(db)
    member = _roster_member(db, owner)
    _worked(db, owner, member)

    res = client.get(REGISTER, headers=_plain(owner))
    assert res.status_code == 200, res.text
    assert float(res.json()[0]["rate_applied"]) == 185.0


# ═══ The roster ═══════════════════════════════════════════════════════


def test_curtained_tablet_reads_the_roster_without_the_pay(client, db):
    owner = _owner(db)
    _roster_member(db, owner)

    res = client.get(ROSTER, headers=_curtained(owner))
    assert res.status_code == 200, res.text
    row = res.json()[0]
    for money_key in ("base_rate", "evening_rate", "weekend_rate", "holiday_rate",
                      "tax_card_type", "tax_card_rate"):
        assert row[money_key] is None, f"{money_key} survived the curtain: {row}"
    # A host has to know who is on and how to reach them — the curtain is a
    # financial curtain, not a lockout. (The truly owner-only rows — kontonummer,
    # portal credentials, employment documents — 403 on this same flag.)
    assert row["name"] == "Agnes"
    assert row["phone"] == "+45 20 00 00 00"


def test_revealed_owner_sees_the_base_rate_on_the_roster(client, db):
    """POSITIVE CONTROL for the roster."""
    owner = _owner(db)
    _roster_member(db, owner)

    res = client.get(ROSTER, headers=_revealed(owner))
    assert res.status_code == 200, res.text
    assert float(res.json()[0]["base_rate"]) == 185.0
    assert res.json()[0]["tax_card_type"] == "hovedkort"


def test_uncurtained_owner_sees_the_base_rate_on_the_roster(client, db):
    owner = _owner(db)
    _roster_member(db, owner)

    res = client.get(ROSTER, headers=_plain(owner))
    assert res.status_code == 200, res.text
    assert float(res.json()[0]["base_rate"]) == 185.0


# ═══ The two mechanisms have to coexist ═══════════════════════════════


@pytest.mark.parametrize("url", [
    "/api/staff/payroll/estimate?period_start=2026-09-01&period_end=2026-09-30",
    "/api/staff/tips?from=2026-09-01&to=2026-09-30",
])
def test_the_all_money_endpoints_are_still_hard_blocked_by_the_pin_gate(client, db, url):
    """Redacting the register must not have softened the prefix set. These
    responses ARE money end to end, so the curtain answers 403 and asks for the
    PIN rather than serving a hollowed-out payload."""
    owner = _owner(db)
    member = _roster_member(db, owner)
    _worked(db, owner, member)

    res = client.get(url, headers=_curtained(owner))
    assert res.status_code == 403, f"{url} served a curtained tablet: {res.text[:200]}"
    assert res.json()["detail"]["code"] == "device_pin_required"


@pytest.mark.parametrize("url", [
    "/api/staff/payroll/estimate?period_start=2026-09-01&period_end=2026-09-30",
    "/api/staff/hours/summary?from=2026-09-01&to=2026-09-30",
])
def test_the_pin_reopens_the_hard_blocked_ones_too(client, db, url):
    """POSITIVE CONTROL for the gate itself: the PIN has to be a door, not a
    wall. A curtain nobody can lift is an outage with a nicer error code."""
    owner = _owner(db)
    member = _roster_member(db, owner)
    _worked(db, owner, member)

    res = client.get(url, headers=_revealed(owner))
    assert res.status_code == 200, f"the PIN did not reopen {url}: {res.text[:200]}"


# ═══ The exception feed — redacted, NOT denied ════════════════════════
#
# /hours/summary was briefly added to _SHARED_DEVICE_DENY_PREFIXES, which made
# the curtained Detaljer tab render "Ingen timer registreret denne periode"
# directly above a RecentHoursLog still listing this month's real entries — and
# with no PIN pad on that route to explain it or lift it. main.py's own comment
# calls an empty state that states a falsehood worse than the leak it closes.
# Same doctrine as the register: hide the money, keep the operations.


def test_curtained_tablet_reads_the_period_summary_without_the_money(client, db):
    owner = _owner(db)
    member = _roster_member(db, owner)
    _worked(db, owner, member)

    res = client.get(
        "/api/staff/hours/summary?from=2026-09-01&to=2026-09-30",
        headers=_curtained(owner),
    )
    assert res.status_code == 200, res.text
    rows = res.json()
    assert len(rows) == 1, rows
    row = rows[0]
    # Every money key, the legacy aliases included — nulling only the new names
    # would leave the redaction one JSON key wide.
    for key in ("earned", "tips", "total", "hourly_rate",
                "total_earned", "tips_received"):
        assert row[key] is None, f"{key} survived the curtain: {row}"
    # The half a host is holding the tablet FOR.
    assert row["staff_name"] == "Agnes"
    assert float(row["actual_hours"]) == 8.0


def test_uncurtained_owner_sees_the_period_summary_money(client, db):
    """POSITIVE CONTROL — without this, a summary endpoint that returned
    nothing at all would satisfy the test above."""
    owner = _owner(db)
    member = _roster_member(db, owner)
    _worked(db, owner, member)

    res = client.get(
        "/api/staff/hours/summary?from=2026-09-01&to=2026-09-30",
        headers=_plain(owner),
    )
    assert res.status_code == 200, res.text
    assert float(res.json()[0]["earned"]) == 1480.0


# ═══ Portal credentials — the curtain has to reach these ══════════════
#
# A staff magic-link token is impersonation PLUS the pay: whoever holds it
# opens /s/<token> and reads that colleague's own hours and earnings, which is
# the figure the register redaction above spends its whole existence hiding.
# The links are unprotected by default (link.pin_hash is optional), and the
# PIN routes are WRITES, so a PIN-protected link could simply be reset from the
# same tablet. _require_owner_actor carries the flag now, so all eleven of its
# call sites inherit it and the next credential route cannot forget.


@pytest.mark.parametrize("method,url", [
    ("get", "/api/staff/schedules/share-links"),
    ("get", "/api/staff/members/{mid}/link"),
    ("post", "/api/staff/members/{mid}/link"),
    ("post", "/api/staff/members/{mid}/link/pin"),
    ("delete", "/api/staff/members/{mid}/link/pin"),
    ("get", "/api/staff/members/{mid}/bank"),
])
def test_curtained_tablet_cannot_touch_portal_credentials(client, db, method, url):
    owner = _owner(db)
    member = _roster_member(db, owner)

    res = getattr(client, method)(
        url.format(mid=member.id), headers=_curtained(owner),
    )
    assert res.status_code == 403, f"{method.upper()} {url} served: {res.text[:200]}"
    # device_pin_required, not owner_only: this owner CAN lift the curtain, and
    # the client interceptor raises the reveal pad on that code.
    assert res.json()["detail"] == "device_pin_required"


def test_the_pin_reopens_the_share_links(client, db):
    """POSITIVE CONTROL. The owner sharing rotas from the counter tablet is the
    normal case — the curtain must be a door."""
    owner = _owner(db)
    _roster_member(db, owner)

    res = client.get("/api/staff/schedules/share-links", headers=_revealed(owner))
    assert res.status_code == 200, res.text


# ═══ Read-shaped POSTs ════════════════════════════════════════════════


def test_the_payroll_pdf_post_is_curtained(client, db):
    """shared_device_pin_gate used to return early for every non-GET, on the
    reading that a curtain hides numbers and a write changes them. This POST
    renders the whole venue's payroll — per-shift rate and earned, per-staff
    gross, AM-bidrag, A-skat, GRAND TOTAL — and its GET sibling
    (/payroll/loenseddel) has been blocked all along."""
    owner = _owner(db)
    member = _roster_member(db, owner)
    _worked(db, owner, member)

    res = client.post(
        "/api/staff/payroll/pdf",
        json={"period_start": "2026-09-01", "period_end": "2026-09-30"},
        headers=_curtained(owner),
    )
    assert res.status_code == 403, f"payroll PDF served to a curtained tablet ({len(res.content)} bytes)"
    assert res.json()["detail"]["code"] == "device_pin_required"


def test_the_payroll_email_post_is_curtained(client, db):
    """Worse than the download: the recipient is caller-supplied, so this is an
    exfiltration route, and the only gate it carried was a BILLING one."""
    owner = _owner(db)
    _roster_member(db, owner)

    res = client.post(
        "/api/staff/payroll/send-to-accountant",
        json={
            "period_start": "2026-09-01", "period_end": "2026-09-30",
            "accountant_email": "somewhere-else@example.com",
        },
        headers=_curtained(owner),
    )
    assert res.status_code == 403, res.text
    assert res.json()["detail"]["code"] == "device_pin_required"


# ═══ Writes must not become a read, or a wipe ═════════════════════════


def test_a_curtained_put_cannot_erase_the_rates_it_was_not_shown(client, db):
    """THE REDACTION TURNING INTO DATA LOSS. The roster editor seeds its draft
    from GET /members, so a nulled base_rate becomes "" in the form, and Gem
    sends parseFloat("") -> NaN -> JSON null. An owner on a curtained tablet
    fixing a PHONE NUMBER would erase the employee's wage rates and trækkort.
    A curtained session provably did not SEE these values, so it cannot be
    intending to change them."""
    owner = _owner(db)
    member = _roster_member(db, owner)

    res = client.put(
        f"/api/staff/members/{member.id}",
        json={
            "phone": "+45 30 00 00 00",
            "base_rate": None, "evening_rate": None,
            "tax_card_type": None, "tax_card_rate": None,
        },
        headers=_curtained(owner),
    )
    assert res.status_code == 200, res.text

    db.expire_all()
    fresh = db.query(StaffMember).filter(StaffMember.id == member.id).first()
    assert float(fresh.base_rate) == 185.0, "the curtain erased the wage rate"
    assert float(fresh.evening_rate) == 205.0
    assert fresh.tax_card_type == "hovedkort"
    # The non-wage half of the same form still saves — 403-ing the whole PUT
    # would break ordinary roster upkeep to protect a field nobody typed.
    assert fresh.phone == "+45 30 00 00 00"


def test_the_put_echo_does_not_hand_the_rate_back(client, db):
    """PUT {phone} -> 200 {base_rate: 185.0} reads the colleague's rate straight
    back out through a write, which makes the GET redaction a formality."""
    owner = _owner(db)
    member = _roster_member(db, owner)

    res = client.put(
        f"/api/staff/members/{member.id}",
        json={"phone": "+45 30 00 00 00"},
        headers=_curtained(owner),
    )
    assert res.status_code == 200, res.text
    assert res.json()["base_rate"] is None, res.json()


def test_an_uncurtained_owner_can_still_change_a_rate(client, db):
    """POSITIVE CONTROL for the key-drop above: it must narrow the curtained
    session only. Setting a rate is the whole point of the roster editor."""
    owner = _owner(db)
    member = _roster_member(db, owner)

    res = client.put(
        f"/api/staff/members/{member.id}",
        json={"base_rate": 210.0},
        headers=_plain(owner),
    )
    assert res.status_code == 200, res.text
    assert float(res.json()["base_rate"]) == 210.0

    db.expire_all()
    fresh = db.query(StaffMember).filter(StaffMember.id == member.id).first()
    assert float(fresh.base_rate) == 210.0


def test_logging_an_hour_from_the_curtained_tablet_returns_no_rate(client, db):
    """The Stempelur is deliberately still usable on a curtained counter
    tablet, and the rate is computed server-side from the roster — so the 200
    body is the same read through a different verb."""
    owner = _owner(db)
    member = _roster_member(db, owner)

    res = client.post(
        "/api/staff/hours",
        json={
            "staff_id": str(member.id), "date": "2026-09-16",
            "start_time": "09:00", "end_time": "17:00", "break_minutes": 0,
            "total_hours": 8.0,
        },
        headers=_curtained(owner),
    )
    assert res.status_code == 200, res.text
    assert res.json()["rate_applied"] is None, res.json()
    assert res.json()["earned"] is None, res.json()
    # Still LOGGED — the redaction is about the echo, not about refusing work.
    assert float(res.json()["total_hours"]) == 8.0


def test_an_uncurtained_owner_still_sees_the_rate_they_just_logged(client, db):
    owner = _owner(db)
    member = _roster_member(db, owner)

    res = client.post(
        "/api/staff/hours",
        json={
            "staff_id": str(member.id), "date": "2026-09-16",
            "start_time": "09:00", "end_time": "17:00", "break_minutes": 0,
            "total_hours": 8.0,
        },
        headers=_plain(owner),
    )
    assert res.status_code == 200, res.text
    assert float(res.json()["rate_applied"]) == 185.0
    assert float(res.json()["earned"]) == 1480.0
