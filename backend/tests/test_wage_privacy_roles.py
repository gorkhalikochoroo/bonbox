"""
Wage privacy — who can read what a colleague earns.

MANOJ, 2026-09-18: "hide the pay rate, just give labour cost — if someone else
goes to the schedule they can see everything."

THE GAP. /api/staff/schedules/week-cost returns gross wage per SHIFT, per STAFF
and per DAY. Its docstring says the protection is that raw rates never cross the
wire — but the grid prints that cost on the same card as the hours that produced
it, so kr ÷ hours IS the colleague's hourly rate, to one decimal, for every name
on the roster. /staff/schedule is not an ownerOnly destination and the endpoint
was on neither deny-list, so a manager or a cashier read it with nothing but
their own token. Three siblings were open the same way: /hours/summary
(per-staff total_earned + tips), /hours/overview (venue labour cost AND the
venue's revenue) and /tips (per-staff payout).

THE SHAPE OF THE FIX — TWO MECHANISMS, because the money is not always alone
on the endpoint.

  DENIED by prefix, where the whole response is money:
  /schedules/week-cost, /hours/overview, /tips. Full route prefixes in
  _MEMBER_READ_DENY_PREFIXES, which managers alias. Full routes precisely so
  the deny cannot swallow the surfaces a manager needs to run a shift — a bare
  "/api/staff/hours" would take the whole time register with it.

  REDACTED per field, where the money is MIXED IN with operations:
  /hours (the working-time register: rate_applied and earned sit on rows a
  manager must keep seeing) and /hours/summary (per-person earned + tips sit on
  the same row as the clock-in exception feed). Denying these read as an empty
  state that stated a falsehood — "No hours logged" printed directly above a
  list of this month's real entries.

ROUND 2 (Manoj, 18 Sep 2026) — "close the payroll-estimate carve-out, owner
only." A manager kept ONE payroll read, /payroll/estimate, on the reasoning
that it was an aggregate. It is not: its per_staff rows carry gross + AM-bidrag
+ A-skat + ATP + feriepenge per named colleague, so gross ÷ hours is the rate
itself — the strongest surface in this file, permitted while the weakest was
denied. The allow-list mechanism is deleted, not emptied; manager set ⊆ member
set is now manager set == member set.

The positive controls below are therefore not decoration: they are the half of
this change that can regress silently, because an over-broad prefix fails as a
403 on a Tuesday lunch rush, not as a red test. And a redaction test is not
satisfied by a 403 — it has to assert 200 AND a null where the money was, or
it would pass just as happily against a locked-out manager.

Run:
  cd backend && python3 -m pytest tests/test_wage_privacy_roles.py -q
"""
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.testclient import TestClient

from app.database import Base, get_db
from app.main import (
    _MANAGER_READ_DENY_PREFIXES,
    _MEMBER_READ_DENY_PREFIXES,
    _is_manager_denied_path,
    _is_sensitive_member_read_path,
    app,
    _db_ready,
)
from app.models.staff import HoursLogged, StaffMember
from app.models.user import User
from app.services.auth import create_access_token, hash_password

_db_ready.set()


# Every wage/earnings surface a non-owner seat must not reach, with a realistic
# query string — the guard matches on prefix, so the concrete URL is what has to
# be caught, not the bare prefix string.
WAGE_URLS = [
    "/api/staff/schedules/week-cost?week_start=2026-09-14",
    "/api/staff/hours/overview?from=2026-09-01&to=2026-09-30",
    "/api/staff/tips?from=2026-09-01&to=2026-09-30",
    # Added 2026-09-18 when the manager carve-out closed. A manager used to
    # read this one; it returns per-person gross + AM-bidrag + A-skat + ATP +
    # feriepenge, so it was the STRONGEST surface in this list, permitted while
    # the weakest (an aggregate week cost) was denied.
    "/api/staff/payroll/estimate?period_start=2026-09-01&period_end=2026-09-30",
]

# Surfaces a manager MUST keep — running a shift needs the roster, the rota, the
# hours register, the clock-in exception feed and the absence/swap queue. They
# reach these with 200; the money on them is nulled per field (see the
# redaction tests), which a prefix deny could not have done.
SHIFT_RUNNING_URLS = [
    "/api/staff/members",
    "/api/staff/schedules?week_start=2026-09-14",
    "/api/staff/schedules/week-load?week_start=2026-09-14",
    "/api/staff/hours?from=2026-09-01&to=2026-09-30",
    "/api/staff/hours/summary?from=2026-09-01&to=2026-09-30",
    "/api/staff/absences",
    "/api/staff/swap-requests",
]


# ═══ Unit: the classifier, with no HTTP in the way ════════════════════


@pytest.mark.parametrize("url", WAGE_URLS)
def test_wage_urls_are_denied_to_every_non_owner_seat(url):
    assert _is_sensitive_member_read_path(url) is True   # cashier / viewer
    assert _is_manager_denied_path(url) is True          # manager


@pytest.mark.parametrize("url", SHIFT_RUNNING_URLS)
def test_shift_running_urls_stay_open(url):
    """The over-block guard. A prefix that creeps up a path segment would take
    the roster or the time register with it and break a manager mid-service."""
    assert _is_sensitive_member_read_path(url) is False
    assert _is_manager_denied_path(url) is False


def test_the_wage_prefixes_are_full_routes_not_parent_segments():
    for p in ("/api/staff/schedules/week-cost",
              "/api/staff/hours/overview", "/api/staff/tips"):
        assert p in _MEMBER_READ_DENY_PREFIXES
    # Neither parent may be in the list — that is what would break the manager.
    assert "/api/staff/schedules" not in _MEMBER_READ_DENY_PREFIXES
    assert "/api/staff/hours" not in _MEMBER_READ_DENY_PREFIXES
    # Nor the two endpoints that are redacted per field. Re-adding either here
    # would look like tightening and would actually reintroduce the lying empty
    # state on /staff/hours (see the module docstring).
    assert "/api/staff/hours/summary" not in _MEMBER_READ_DENY_PREFIXES


def test_the_shared_device_gate_does_not_deny_the_period_summary():
    """/hours/summary is NOT prefix-denied to a curtained tablet, and that is a
    decision, not an oversight.

    It was, briefly. Denying it reproduced on the curtained owner the exact
    falsehood the member list refuses to ship: the Detaljer tab rendering
    "Ingen timer registreret denne periode" directly over a RecentHoursLog
    still listing this month's real entries — and with no PIN pad on that route
    to explain it or lift it. The money is redacted per FIELD instead (see
    test_wage_privacy_shared_device), which is what the member seat has always
    got. Same doctrine, both populations.

    The inherited prefixes still have to hold: the curtain must never be WEAKER
    than the manager gate."""
    from app.main import _SHARED_DEVICE_DENY_PREFIXES

    assert "/api/staff/hours/summary" not in _SHARED_DEVICE_DENY_PREFIXES
    for p in _MANAGER_READ_DENY_PREFIXES:
        assert p in _SHARED_DEVICE_DENY_PREFIXES


def test_there_is_no_manager_allow_list_left():
    """FOUNDER DECISION, 2026-09-18: "close the payroll-estimate carve-out —
    owner only." The allow-list mechanism is deleted, not emptied to ().

    Asserted by ABSENCE on purpose. An empty tuple would still be a one-line
    invitation to re-open the hole with no new reasoning, and it scans as
    "nothing is restricted" sitting above a deny list. If the name comes back,
    whoever brought it back has to face this test and write down why."""
    import app.main as _m

    assert not hasattr(_m, "_MANAGER_READ_ALLOW_PREFIXES"), (
        "the manager allow-list is back — re-read the comment in main.py before "
        "deciding that is what you want"
    )


def test_manager_is_denied_exactly_what_a_cashier_is():
    """The invariant the file argues for, now an equality rather than ⊆. A
    prefix added for cashiers is a prefix managers lose too."""
    assert set(_MANAGER_READ_DENY_PREFIXES) == set(_MEMBER_READ_DENY_PREFIXES)
    for url in WAGE_URLS + ["/api/staff/payroll/csv", "/api/staff/payroll/loenseddel"]:
        assert _is_manager_denied_path(url) is _is_sensitive_member_read_path(url)


# ═══ End-to-end through the real middleware ═══════════════════════════
#
# member_read_guard opens its OWN SessionLocal() (it cannot use the injected
# db), so the fixture repoints app.database.SessionLocal at the in-memory
# engine — same approach as tests/test_device_pin.py. Without it every guarded
# request fails CLOSED (503) because the token's user isn't in the real DB,
# and a 503 would pass a naive "not 200" assertion while proving nothing.


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
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("ownerpw123"),
        business_name="Bon Bistro", business_type="cafe", currency="DKK",
        plan="pro", role="owner", email_verified=True, timezone="Europe/Copenhagen",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _seat(db, owner: User, *, role: str) -> User:
    """An invited team member. get_current_user delegates them to the owner, so
    the tenant filter alone would let them read everything the owner can — the
    middleware is the only thing standing between them and the wage figures."""
    u = User(
        email=f"{role}@bonbox.dk", password_hash=hash_password("seatpw123"),
        business_name=owner.business_name, business_type=owner.business_type,
        currency="DKK", plan="pro", role=role, owner_id=owner.id, email_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _auth(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(str(user.id), 0)}"}


def _roster(db, owner: User) -> StaffMember:
    m = StaffMember(
        id=uuid.uuid4(), user_id=owner.id, name="Agnes", role="server",
        active=True, is_deleted=False, base_rate=185.0,
    )
    db.add(m)
    db.commit()
    return m


def _worked(db, owner: User, member: StaffMember) -> HoursLogged:
    """One shift on the register: 8 hours at 185 kr = 1480 kr. Deliberately a
    clean division — 1480 ÷ 8 is the rate, which is the whole point."""
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


@pytest.mark.parametrize("role", ["manager", "cashier"])
@pytest.mark.parametrize("url", WAGE_URLS)
def test_seat_is_forbidden_from_wage_endpoints(client, db, role, url):
    owner = _owner(db)
    _roster(db, owner)
    seat = _seat(db, owner, role=role)

    res = client.get(url, headers=_auth(seat))
    assert res.status_code == 403, f"{role} reached {url}: {res.status_code} {res.text[:200]}"
    assert res.json()["detail"]["code"] == "read_forbidden"


@pytest.mark.parametrize("url", WAGE_URLS)
def test_owner_still_gets_the_numbers(client, db, url):
    """The other half of every deny: the person who pays the wages must still
    see them. A deny-list that also silences the owner is not privacy, it is an
    outage."""
    owner = _owner(db)
    _roster(db, owner)

    res = client.get(url, headers=_auth(owner))
    assert res.status_code == 200, f"owner blocked from {url}: {res.status_code} {res.text[:200]}"


def test_manager_can_still_run_a_shift(client, db):
    """POSITIVE CONTROL. A manager keeps the roster and the rota — if this ever
    goes red, the deny list has crept up a path segment and a manager is locked
    out of the schedule mid-service, which is the failure nobody would notice in
    review."""
    owner = _owner(db)
    _roster(db, owner)
    manager = _seat(db, owner, role="manager")

    for url in ("/api/staff/members", "/api/staff/schedules?week_start=2026-09-14"):
        res = client.get(url, headers=_auth(manager))
        assert res.status_code == 200, f"manager blocked from {url}: {res.status_code} {res.text[:200]}"


def test_cashier_can_still_read_the_roster(client, db):
    owner = _owner(db)
    _roster(db, owner)
    cashier = _seat(db, owner, role="cashier")

    res = client.get("/api/staff/members", headers=_auth(cashier))
    assert res.status_code == 200, res.text


# ═══ Field-level redaction: the endpoints a manager KEEPS ═════════════
#
# These are the ones a prefix could not have fixed. Each test asserts 200 AND a
# null, because a 403 would satisfy "no money in the response" while breaking
# the operational half of the endpoint — the exact failure the deny list made
# on /hours/summary and nobody would have noticed until a manager opened
# "Timer & løn" mid-service.


@pytest.mark.parametrize("role", ["manager", "cashier", "viewer"])
def test_hours_register_reaches_a_seat_without_the_rate(client, db, role):
    """THE LEAK THE DENY LIST LEFT OPEN. /hours states `rate_applied` outright —
    not derived from kr ÷ hours the way the schedule card was, but the pay rate
    itself, on every row, one per colleague. StaffHoursPage prints `earned`
    directly under `total_hours` on the same card, which is the very layout the
    schedule grid was stripped of."""
    owner = _owner(db)
    member = _roster(db, owner)
    _worked(db, owner, member)
    seat = _seat(db, owner, role=role)

    res = client.get(
        "/api/staff/hours?from=2026-09-01&to=2026-09-30", headers=_auth(seat)
    )
    assert res.status_code == 200, f"{role} blocked from the register: {res.text[:200]}"
    rows = res.json()
    assert len(rows) == 1, rows
    assert rows[0]["rate_applied"] is None, rows[0]
    assert rows[0]["earned"] is None, rows[0]
    # The operational half survives — this is why it is redacted, not denied.
    assert float(rows[0]["total_hours"]) == 8.0
    assert rows[0]["start_time"] == "09:00"


def test_owner_still_sees_the_rate_on_the_register(client, db):
    owner = _owner(db)
    member = _roster(db, owner)
    _worked(db, owner, member)

    res = client.get(
        "/api/staff/hours?from=2026-09-01&to=2026-09-30", headers=_auth(owner)
    )
    assert res.status_code == 200, res.text
    assert float(res.json()[0]["rate_applied"]) == 185.0


@pytest.mark.parametrize("role", ["manager", "cashier", "viewer"])
def test_period_summary_reaches_a_seat_without_the_money(client, db, role):
    """Every money key, under BOTH its names. total_earned/tips_received are the
    same figures as earned/tips under older key names, so nulling only the new
    pair would have left the redaction one JSON key wide."""
    owner = _owner(db)
    member = _roster(db, owner)
    _worked(db, owner, member)
    seat = _seat(db, owner, role=role)

    res = client.get(
        "/api/staff/hours/summary?from=2026-09-01&to=2026-09-30", headers=_auth(seat)
    )
    assert res.status_code == 200, f"{role} blocked from the summary: {res.text[:200]}"
    rows = res.json()
    assert len(rows) == 1, rows
    row = rows[0]
    for money_key in ("hourly_rate", "earned", "tips", "total",
                      "total_earned", "tips_received"):
        assert row[money_key] is None, f"{money_key} leaked to {role}: {row}"
    # The clock-in exception feed is what this endpoint is FOR on a manager's
    # screen, and it has to survive.
    assert float(row["actual_hours"]) == 8.0
    assert "worst_state" in row and "exceptions" in row


def test_owner_still_sees_the_money_on_the_period_summary(client, db):
    owner = _owner(db)
    member = _roster(db, owner)
    _worked(db, owner, member)

    res = client.get(
        "/api/staff/hours/summary?from=2026-09-01&to=2026-09-30", headers=_auth(owner)
    )
    assert res.status_code == 200, res.text
    row = res.json()[0]
    assert float(row["hourly_rate"]) == 185.0
    assert float(row["earned"]) == 1480.0
    assert float(row["total_earned"]) == 1480.0


@pytest.mark.parametrize("role", ["manager", "cashier", "viewer"])
def test_no_seat_reaches_the_payroll_estimate(client, db, role):
    """THE CARVE-OUT, CLOSED (Manoj, 2026-09-18).

    A manager used to get this one with 200. The reason on record was the
    aggregate they plan rotas against — but the same payload carries per-person
    gross + AM-bidrag + A-skat + ATP + feriepenge, and gross ÷ hours is a named
    colleague's exact hourly rate. That left the deny list denying the weakest
    wage surface (an aggregate week cost) while permitting the strongest one
    tab away, on the same screen.

    Every seat now gets the same 403 a cashier always did."""
    owner = _owner(db)
    member = _roster(db, owner)
    _worked(db, owner, member)
    seat = _seat(db, owner, role=role)

    res = client.get(
        "/api/staff/payroll/estimate?period_start=2026-09-01&period_end=2026-09-30",
        headers=_auth(seat),
    )
    assert res.status_code == 403, f"{role} reached the payroll estimate: {res.text[:200]}"
    assert res.json()["detail"]["code"] == "read_forbidden"


def test_the_owner_still_gets_their_own_payroll_breakdown(client, db):
    """The other half of the deny. Closing a carve-out must not cost the person
    who actually runs the lønkørsel the numbers they run it from."""
    owner = _owner(db)
    member = _roster(db, owner)
    _worked(db, owner, member)

    res = client.get(
        "/api/staff/payroll/estimate?period_start=2026-09-01&period_end=2026-09-30",
        headers=_auth(owner),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["per_staff"], "owner lost their own payroll breakdown"
    assert float(body["totals"]["gross"]) == 1480.0, body["totals"]


def test_the_per_staff_strip_survives_as_the_inner_barrier(client, db):
    """The router still strips per_staff on a member view, even though the
    middleware now 403s before it runs. Two barriers, not one — if the prefix
    list is ever re-scoped, the payslips must not be what leaks. Called
    directly, without the middleware, so the barrier is tested in isolation
    rather than shadowed by the gate in front of it."""
    from app.routers.staff import estimate_payroll
    from datetime import date as _d

    owner = _owner(db)
    member = _roster(db, owner)
    _worked(db, owner, member)

    owner._is_member_view = True  # what _resolve_member_view stamps on a seat
    try:
        result = estimate_payroll(_d(2026, 9, 1), _d(2026, 9, 30), db=db, user=owner)
    finally:
        owner._is_member_view = False
    assert result["per_staff"] == [], result
