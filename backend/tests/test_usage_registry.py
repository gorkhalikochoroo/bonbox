"""The usage panel must show the number that actually stops the owner.

The failure mode this exists to prevent: a panel that counts "roughly
the same thing" the gate counts, drifts, and then tells an owner "3 of
10 scans" while the gate returns 402. The owner is looking at a number
the product itself disagrees with — and might pay to lift a limit they
had not really reached, or be blocked by one the screen said was fine.

So the registry never counts anything. Each meter points at the function
the gate already calls, and the test below asserts that structurally: if
someone adds a meter with its own private query, it fails.

Run:
  cd backend && python3 -m pytest tests/test_usage_registry.py -q
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.expense import Expense, ExpenseCategory
from app.models.staff import StaffMember
from app.models.user import User
from app.services.auth import get_current_user
from app.services.billing import PLAN_CAPS, get_cap
from app.services.usage_registry import METERS, build_usage

_db_ready.set()


@pytest.fixture
def engine_and_session():
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(eng)
    return eng, sessionmaker(bind=eng)


@pytest.fixture
def db(engine_and_session) -> Iterator:
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

    try:
        app.state.limiter.reset()
    except Exception:
        pass
    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db, plan="free") -> User:
    u = User(
        email=f"o-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
        business_name="Café Hygge", business_type="cafe",
        currency="DKK", plan=plan,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _meter(meters, key):
    return next(m for m in meters if m["key"] == key)


# ── the anti-drift guarantee ─────────────────────────────────────────

def test_every_meter_points_at_a_real_gate_counter():
    """Structural. A meter that runs its own private query would drift
    from the gate the first time either side changed."""
    import inspect
    for meter in METERS:
        src = inspect.getsource(meter.counter)
        assert ("from app.routers" in src or "from app.services" in src), (
            f"{meter.cap_key} does not delegate to the gate's own counter — "
            "the panel would count separately from the gate"
        )
        # ...and it must not be doing its own querying on the side.
        assert ".query(" not in src, (
            f"{meter.cap_key} builds its own query; call the gate's "
            "counter instead so there is exactly one number"
        )


def test_the_panel_and_the_gate_report_the_same_staff_count(db):
    """The one meter with a shared extracted helper, checked end to end
    against the gate's own function."""
    from app.routers.staff import count_active_staff

    u = _owner(db)
    for i in range(4):
        db.add(StaffMember(user_id=u.id, name=f"S{i}", active=True))
    # a leaver frees a seat — both sides must agree it does
    db.add(StaffMember(user_id=u.id, name="Gone", active=False))
    db.commit()

    gate = count_active_staff(db, u.id)
    panel = _meter(build_usage(db, u), "staff_members")["used"]
    assert panel == gate == 4


def test_only_enforced_caps_appear(db):
    """PLAN_CAPS defines three caps nothing enforces
    (billetto_imports_per_month, events_per_month,
    foreign_currency_expenses_per_month). Showing usage against a limit
    that does not exist invents a constraint the owner might pay to
    lift."""
    u = _owner(db)
    shown = {m["key"] for m in build_usage(db, u)}
    for unenforced in (
        "billetto_imports_per_month",
        "events_per_month",
        "foreign_currency_expenses_per_month",
    ):
        assert unenforced in PLAN_CAPS["free"], "test premise: it is still defined"
        assert unenforced not in shown, f"{unenforced} is enforced nowhere"


# ── the numbers themselves ───────────────────────────────────────────

def test_a_fresh_owner_reads_zero_not_blank(db):
    u = _owner(db)
    for m in build_usage(db, u):
        assert m["used"] == 0, f"{m['key']} should read 0, got {m['used']}"


def test_receipt_scans_track_real_expenses(db):
    u = _owner(db)
    c = ExpenseCategory(user_id=u.id, name="Vareforbrug")
    db.add(c); db.commit(); db.refresh(c)
    for i in range(3):
        db.add(Expense(
            user_id=u.id, category_id=c.id, date=date.today(),
            amount=100.0 + i, description=f"Netto {i}", payment_method="cash",
            receipt_photo=f"uploads/receipts/{i}.jpg", receipt_source="scan",
        ))
    db.commit()

    m = _meter(build_usage(db, u), "expense_receipt_scans_per_month")
    assert m["used"] == 3
    assert m["cap"] == PLAN_CAPS["free"]["expense_receipt_scans_per_month"]


def test_the_cap_shown_is_the_owners_actual_tier(db):
    free = _meter(build_usage(db, _owner(db, "free")), "expense_receipt_scans_per_month")
    pro = _meter(build_usage(db, _owner(db, "pro")), "expense_receipt_scans_per_month")
    assert free["cap"] == 10 and pro["cap"] == 1000


# ── honesty about what a number means ────────────────────────────────

def test_unlimited_is_stated_not_drawn_as_a_bar(db):
    """A -1 cap must never reach the client as a denominator, or a
    progress bar renders against a negative and reads as 0% used."""
    u = _owner(db, "pro")
    m = _meter(build_usage(db, u), "moms_pdf_exports_per_month")
    assert get_cap(u, "moms_pdf_exports_per_month") == -1, "test premise"
    assert m["unlimited"] is True
    assert m["cap"] is None


def test_a_zero_cap_is_locked_not_full(db):
    """0 means the feature is not on this plan at all. Rendering it as a
    full bar would tell the owner they have used something up when they
    never had it."""
    u = _owner(db)
    for m in build_usage(db, u):
        if get_cap(u, m["key"]) == 0:
            assert m["locked"] is True


def test_the_estimate_is_flagged_as_one(db):
    """The receipt-scan counter is a documented proxy — it misses scans
    abandoned before saving. The panel must not imply a precision it
    does not have."""
    u = _owner(db)
    meters = {m["key"]: m for m in build_usage(db, u)}
    assert meters["expense_receipt_scans_per_month"]["approximate"] is True
    assert meters["staff_members"]["approximate"] is False, (
        "a live seat count is exact and must not be hedged"
    )


def test_a_broken_counter_reports_unknown_not_zero(db, monkeypatch):
    """A zero the owner cannot distinguish from "we could not read it"
    is the same dishonesty in a smaller font — and it must not 500 the
    profile page either."""
    import app.services.usage_registry as reg

    def _boom(db_, user):
        raise RuntimeError("counter exploded")

    monkeypatch.setattr(
        reg, "METERS",
        tuple(
            reg.UsageMeter(m.cap_key, m.label_key, m.period, _boom, m.approximate)
            if m.cap_key == "staff_members" else m
            for m in reg.METERS
        ),
    )
    u = _owner(db)
    assert _meter(reg.build_usage(db, u), "staff_members")["used"] is None


# ── the endpoint ─────────────────────────────────────────────────────

def test_endpoint_returns_the_callers_own_usage(client, db):
    u = _owner(db)
    db.add(StaffMember(user_id=u.id, name="A", active=True)); db.commit()
    app.dependency_overrides[get_current_user] = lambda: u

    r = client.get("/api/billing/usage")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["plan"] == "free"
    assert _meter(body["meters"], "staff_members")["used"] == 1


def test_usage_never_leaks_across_tenants(client, db):
    mine, theirs = _owner(db), _owner(db)
    for i in range(5):
        db.add(StaffMember(user_id=theirs.id, name=f"T{i}", active=True))
    db.commit()

    app.dependency_overrides[get_current_user] = lambda: mine
    body = client.get("/api/billing/usage").json()
    assert _meter(body["meters"], "staff_members")["used"] == 0


# ── every "today" must mean the same day ─────────────────────────────

def test_all_per_day_counters_use_the_business_day():
    """The panel labels three caps "i dag" side by side. If they used
    different definitions of today, that label is a lie for at least one.

    kasserapport._today_count used date.today() — UTC on Render, which
    rolls at 02:00 Copenhagen in summer — while the other two used the
    DK 06:00 business day. A café closing at 02:00, exactly the owner
    the convention exists for, burned the NEXT day's quota an hour into
    their close ritual.

    Asserted over the AST, not the source text. A first attempt stripped
    the docstring by string replace and then grepped: on Python 3.13
    (this repo's venv) docstrings are dedented at compile time, so
    __doc__ is no longer a substring of getsource and the strip silently
    did nothing — the grep then matched the PROSE in a docstring that
    names date.today() as the thing it avoids, failing a correct
    counter. Reading the calls the function actually makes cannot be
    fooled by a comment either way.
    """
    import ast
    import inspect
    import textwrap
    from app.services.usage_registry import METERS, PERIOD_DAY

    def _calls(fn) -> set[str]:
        tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                f = node.func
                if isinstance(f, ast.Name):
                    names.add(f.id)
                elif isinstance(f, ast.Attribute):
                    names.add(f.attr)
                    if isinstance(f.value, ast.Name):
                        names.add(f"{f.value.id}.{f.attr}")
        return names

    checked = 0
    for meter in METERS:
        if meter.period != PERIOD_DAY:
            continue
        # follow the delegation to the gate's own counter
        src = inspect.getsource(meter.counter)
        mod = src.split("from app.routers.")[1].split(" import")[0]
        fn_name = src.split("import ")[1].split("\n")[0].strip()
        gate_fn = getattr(__import__(f"app.routers.{mod}", fromlist=[fn_name]), fn_name)

        called = _calls(gate_fn)
        assert {"business_day_window", "business_today_local"} & called, (
            f"{meter.cap_key} does not call a business-day helper; the panel "
            'labels it "today" alongside counters that do'
        )
        assert "date.today" not in called, (
            f"{meter.cap_key} calls date.today() — at 02:00 Copenhagen "
            "that is already tomorrow"
        )
        checked += 1

    expected = sum(1 for m in METERS if m.period == PERIOD_DAY)
    assert checked == expected and checked > 0, (
        f"checked {checked} of {expected} per-day meters"
    )
