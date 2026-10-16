"""SQL statement budget for one Home open (speed push, 15 Oct).

Production talks to Supabase in eu-west-1 from Frankfurt: every SQL statement
is a ~21-22 ms round trip, so on Home the statement COUNT is the latency. The
15 Oct investigation measured ~80-90 statements in /dashboard/batch alone and
93-114 in /tax/overview, which Home waited for too.

This pins the budget so a change that quietly adds queries to the first screen
fails here instead of in an owner's hand:
  • /dashboard/batch — the call the money card waits for;
  • the whole set of GETs Home and its cards fire on one open (warm: today's
    brief already exists, as it will once the morning precompute has run).

The data is a realistic small venue: three months of closes, sales and
expenses, a stocked inventory, staff and shifts — enough rows that a per-row
query (N+1) would blow the budget rather than hide in an empty account.

Round 2 of the speed push (cutting /batch towards ~30) lowers these numbers;
it must never raise them.

Kept in step with the frontend: HOME_OPEN mirrors what DashboardPage and its
cards request (src/__tests__/dashboardSpeed.test.jsx pins the frontend half —
no /tax/overview, no second /cashflow/forecast on first load).
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem
from app.models.sale import Sale
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()

BATCH_BUDGET = 95          # measured 16 Oct: 88 here, 91 on the 15-month lab venue
HOME_OPEN_BUDGET = 200     # measured 16 Oct: 187. Before the speed push Home also fired /tax/overview (103 here) and repeated forecast + close checks (32): 322 computed

TODAY = date.today()


@pytest.fixture
def env():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    Session = sessionmaker(bind=eng, autoflush=False, autocommit=False)
    counter = {"n": 0}

    @event.listens_for(eng, "before_cursor_execute")
    def _count(conn, cursor, statement, params, context, executemany):
        counter["n"] += 1

    s = Session()
    u = User(id=uuid.uuid4(), email="budget@bonbox.test", password_hash=hash_password("x"),
             business_name="Budget Bistro", business_type="restaurant", currency="DKK",
             role="owner", timezone="Europe/Copenhagen", email_verified=True)
    s.add(u)
    s.flush()
    cats = [ExpenseCategory(user_id=u.id, name=n, color="#888888")
            for n in ("Råvarer", "Løn", "Husleje", "Drikkevarer")]
    s.add_all(cats)
    s.flush()
    for off in range(1, 91):
        d = TODAY - timedelta(days=off)
        s.add(DailyClose(user_id=u.id, date=d, revenue_total=Decimal("18000"), status="confirmed"))
        for k in range(3):
            s.add(Sale(user_id=u.id, date=d, amount=150 + k, payment_method="card",
                       item_name=f"Ret {k}", quantity_sold=1))
        s.add(Expense(user_id=u.id, category_id=cats[off % 4].id, date=d, amount=900,
                      description="Leverandør", payment_method="card"))
    for i in range(30):
        s.add(InventoryItem(user_id=u.id, name=f"Vare {i}", quantity=i % 7, unit="stk",
                            min_threshold=3, cost_per_unit=10, category="Råvarer"))
    staff = [StaffMember(user_id=u.id, name=f"Medarbejder {i}", role="server", base_rate=170,
                         contract_type="part", active=True) for i in range(6)]
    s.add_all(staff)
    s.flush()
    for off in range(-7, 30):
        for m in staff[:3]:
            s.add(Schedule(user_id=u.id, staff_id=m.id, date=TODAY - timedelta(days=off),
                           start_time="10:00", end_time="16:00", break_minutes=30,
                           role_on_shift="server", status="published"))
    s.commit()
    s.refresh(u)
    s.expunge(u)
    s.close()

    def _db():
        x = Session()
        try:
            yield x
        finally:
            x.close()

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: u
    try:
        yield TestClient(app), counter
    finally:
        app.dependency_overrides.clear()


def _count(client, counter, path, params=None):
    counter["n"] = 0
    r = client.get(path, params=params)
    assert r.status_code == 200, (path, r.status_code, r.text[:300])
    return counter["n"]


HOME_OPEN = [
    ("/api/auth/me", None),
    ("/api/config/features", None),
    ("/api/billing/entitlements", None),
    ("/api/auth/device-pin/status", None),
    ("/api/pillars", None),
    ("/api/activation", None),
    ("/api/branches/list", None),
    ("/api/reservations/changes", None),
    ("/api/modules", None),
    ("/api/email/alerts-preview", None),
    ("/api/inventory/alerts", None),
    ("/api/budgets/summary", {"month": f"{TODAY.year}-{TODAY.month:02d}", "mode": "business"}),
    ("/api/dashboard/batch", {"month": TODAY.month, "year": TODAY.year, "weather": 0}),
    ("/api/business", None),
    ("/api/daily-close", {"from": (TODAY - timedelta(days=1)).isoformat(), "to": TODAY.isoformat()}),
    ("/api/diagnostics/needs-you", None),
    ("/api/smart-drift", None),
    ("/api/demo/status", {"scope": "has_demo"}),
    ("/api/dashboard/anomalies", None),
    ("/api/accountants/grants", None),
    ("/api/email/preferences", None),
    ("/api/branches/summary", None),
    ("/api/cashflow/forecast", None),
    ("/api/dashboard/daily-brief", None),
    ("/api/staff/today", None),
    ("/api/business/staffing-suggestion", None),
    ("/api/output-channels", None),
]


def test_batch_stays_inside_its_statement_budget(env, monkeypatch):
    client, counter = env
    import app.services.daily_brief as brief_mod
    monkeypatch.setattr(brief_mod, "_try_llm_polish", lambda *a, **k: (None, 0, 0, "deterministic"))
    n = _count(client, counter, "/api/dashboard/batch",
               {"month": TODAY.month, "year": TODAY.year, "weather": 0})
    print(f"\n/dashboard/batch statements: {n} (budget {BATCH_BUDGET})")
    assert n <= BATCH_BUDGET


def test_one_warm_home_open_stays_inside_its_statement_budget(env, monkeypatch):
    client, counter = env
    import app.services.daily_brief as brief_mod
    monkeypatch.setattr(brief_mod, "_try_llm_polish", lambda *a, **k: (None, 0, 0, "deterministic"))
    # Warm: the morning precompute (or an earlier open) already wrote today's
    # brief and the anomaly scan has run.
    for path, params in HOME_OPEN:
        client.get(path, params=params)
    per = {path: _count(client, counter, path, params) for path, params in HOME_OPEN}
    total = sum(per.values())
    print("\n" + "\n".join(f"{v:4d}  {k}" for k, v in sorted(per.items(), key=lambda kv: -kv[1])))
    print(f"total {total} (budget {HOME_OPEN_BUDGET})")
    assert total <= HOME_OPEN_BUDGET
    # The full tax calculation is not part of Home any more.
    assert "/api/tax/overview" not in per


def test_the_tax_calculation_is_heavier_than_the_date_it_used_to_supply(env):
    """Why A matters, in this test's own units: /tax/overview costs far more
    statements than the batch's date fields (which cost none)."""
    client, counter = env
    tax = _count(client, counter, "/api/tax/overview")
    print(f"\n/tax/overview statements: {tax}")
    assert tax > 30
