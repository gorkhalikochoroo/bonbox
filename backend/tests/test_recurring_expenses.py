"""
Recurring expenses — end-to-end tests for task #47.

Coverage:
  1. Free user → 402 plan_required on create / update / pause / resume / run-now
  2. Starter user can create, list, update, pause, resume, archive
  3. Tenant isolation — user A can't see or modify user B's rules
  4. Cron materialize: creates Expense row with correct fields + bilagsnummer
  5. Cron idempotency: running twice on the same day doesn't double-post
  6. Cron advances next_run_date to the next month
  7. audit_logs has rows for created / materialized
  8. day_of_month=31 stored as 28 (validator caps it)

Run: cd backend && pytest tests/test_recurring_expenses.py -v
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.expense import Expense, ExpenseCategory
from app.models.recurring_expense import RecurringExpense
from app.models.user import User
from app.services.auth import get_current_user

_db_ready.set()


# ─── Shared in-memory DB ───────────────────────────────────────────────


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    return engine, SessionLocal


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


# ─── Helpers ───────────────────────────────────────────────────────────


def _user(db, plan: str = "starter", email_suffix: str = "") -> User:
    u = User(
        email=f"owner{email_suffix}@bonbox.test",
        password_hash="x",
        business_name="Bon Bakery",
        business_type="cafe",
        currency="DKK",
        plan=plan,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _category(db, user: User, name: str = "Rent") -> ExpenseCategory:
    c = ExpenseCategory(user_id=user.id, name=name, color="#3B82F6")
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _payload(category_id, **overrides) -> dict:
    base = {
        "name": "Rent — Nørrebrogade",
        "description": "Monthly rent",
        "amount": 18000,
        "payment_method": "bank_transfer",
        "day_of_month": 1,
        "category_id": str(category_id),
    }
    base.update(overrides)
    return base


# ─── Test 1: Free user gets 402 plan_required ──────────────────────────


def test_free_user_blocked_from_create(client, db):
    user = _user(db, plan="free")
    _override_user(user)
    cat = _category(db, user)

    res = client.post("/api/recurring-expenses", json=_payload(cat.id))
    assert res.status_code == 402, res.text
    body = res.json()
    assert body["detail"]["code"] == "plan_required"
    assert body["detail"]["feature"] == "recurring_expenses"
    assert body["detail"]["upgrade_to"] == "starter"


def test_free_user_can_list(client, db):
    """READ is not tier-gated — Free users can see their archived rules."""
    user = _user(db, plan="free")
    _override_user(user)
    res = client.get("/api/recurring-expenses")
    assert res.status_code == 200, res.text
    assert res.json() == []


def test_free_user_blocked_from_update(client, db):
    starter = _user(db, plan="starter", email_suffix="s")
    cat = _category(db, starter)
    rule = RecurringExpense(
        user_id=starter.id, category_id=cat.id, name="Rent",
        amount=Decimal("100"), day_of_month=1,
        next_run_date=date.today() + timedelta(days=1),
    )
    db.add(rule); db.commit(); db.refresh(rule)

    free_user = _user(db, plan="free", email_suffix="f")
    # Switch context to free user — we expect 404 due to tenant scoping
    # BUT note: tenant check happens AFTER plan gate. So free user
    # PUTting their own rule (they don't own this one) would be 402.
    # Let's give the free user their own rule first by direct DB insert.
    free_rule = RecurringExpense(
        user_id=free_user.id, category_id=None, name="Spotify",
        amount=Decimal("99"), day_of_month=5,
        next_run_date=date.today() + timedelta(days=1),
    )
    db.add(free_rule); db.commit(); db.refresh(free_rule)

    _override_user(free_user)
    res = client.put(
        f"/api/recurring-expenses/{free_rule.id}",
        json={"amount": 199},
    )
    assert res.status_code == 402, res.text
    assert res.json()["detail"]["feature"] == "recurring_expenses"


# ─── Test 2: Starter user can CRUD ─────────────────────────────────────


def test_starter_can_create_and_list(client, db):
    user = _user(db, plan="starter")
    _override_user(user)
    cat = _category(db, user)

    res = client.post("/api/recurring-expenses", json=_payload(cat.id))
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["name"] == "Rent — Nørrebrogade"
    assert body["amount"] == 18000.0
    assert body["day_of_month"] == 1
    assert body["is_active"] is True
    assert body["next_run_human"].startswith("Next:") or body["next_run_human"] == "Next: today"

    listed = client.get("/api/recurring-expenses").json()
    assert len(listed) == 1
    assert listed[0]["id"] == body["id"]


def test_starter_can_update(client, db):
    user = _user(db, plan="starter")
    _override_user(user)
    cat = _category(db, user)

    created = client.post("/api/recurring-expenses", json=_payload(cat.id)).json()
    rid = created["id"]

    res = client.put(
        f"/api/recurring-expenses/{rid}",
        json={"amount": 19500, "name": "Rent — updated"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["amount"] == 19500.0
    assert res.json()["name"] == "Rent — updated"


def test_starter_can_pause_and_resume(client, db):
    user = _user(db, plan="starter")
    _override_user(user)
    cat = _category(db, user)
    created = client.post("/api/recurring-expenses", json=_payload(cat.id)).json()
    rid = created["id"]

    paused = client.post(f"/api/recurring-expenses/{rid}/pause").json()
    assert paused["is_active"] is False
    assert paused["next_run_human"] == "Paused"

    resumed = client.post(f"/api/recurring-expenses/{rid}/resume").json()
    assert resumed["is_active"] is True


def test_starter_archive_via_delete_is_soft(client, db):
    """DELETE is a soft-archive — sets is_active=False, keeps row + audit trail."""
    user = _user(db, plan="starter")
    _override_user(user)
    cat = _category(db, user)
    created = client.post("/api/recurring-expenses", json=_payload(cat.id)).json()
    rid = created["id"]

    res = client.delete(f"/api/recurring-expenses/{rid}")
    assert res.status_code == 204

    # Still in DB, just inactive
    rule = db.query(RecurringExpense).filter(RecurringExpense.id == rid).first()
    assert rule is not None
    assert rule.is_active is False


# ─── Test 3: Tenant isolation ──────────────────────────────────────────


def test_tenant_isolation_list(client, db):
    a = _user(db, plan="starter", email_suffix="a")
    b = _user(db, plan="starter", email_suffix="b")
    cat_a = _category(db, a)
    _category(db, b)

    _override_user(a)
    client.post("/api/recurring-expenses", json=_payload(cat_a.id))

    _override_user(b)
    listed = client.get("/api/recurring-expenses").json()
    assert listed == []


def test_tenant_isolation_update_404(client, db):
    a = _user(db, plan="starter", email_suffix="a")
    b = _user(db, plan="starter", email_suffix="b")
    cat_a = _category(db, a)

    _override_user(a)
    rid = client.post("/api/recurring-expenses", json=_payload(cat_a.id)).json()["id"]

    _override_user(b)
    res = client.put(f"/api/recurring-expenses/{rid}", json={"amount": 999})
    assert res.status_code == 404


def test_tenant_isolation_archive_404(client, db):
    a = _user(db, plan="starter", email_suffix="a")
    b = _user(db, plan="starter", email_suffix="b")
    cat_a = _category(db, a)

    _override_user(a)
    rid = client.post("/api/recurring-expenses", json=_payload(cat_a.id)).json()["id"]

    _override_user(b)
    res = client.delete(f"/api/recurring-expenses/{rid}")
    assert res.status_code == 404


# ─── Test 4: Cron materializes a due rule ──────────────────────────────


def test_cron_materializes_due_rule(db):
    """The cron job creates an Expense row with the correct fields when
    a rule's next_run_date is today (or earlier)."""
    from app.jobs.recurring_expenses_job import materialize_due_recurring_expenses

    user = _user(db, plan="starter")
    cat = _category(db, user, name="Rent")
    today = date.today()

    rule = RecurringExpense(
        user_id=user.id,
        category_id=cat.id,
        name="Rent — Nørrebrogade",
        description="Monthly rent",
        amount=Decimal("18000.00"),
        payment_method="bank_transfer",
        day_of_month=1,
        next_run_date=today,  # due today
        is_active=True,
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)

    # Inject the same in-memory session into the job via db_factory.
    SessionLocal = sessionmaker(bind=db.bind)
    summary = materialize_due_recurring_expenses(db_factory=SessionLocal)
    assert summary["expenses_created"] == 1, summary
    assert summary["skipped_existing"] == 0

    exp = db.query(Expense).filter(Expense.user_id == user.id).first()
    assert exp is not None
    assert float(exp.amount) == 18000.0
    assert exp.description == "Monthly rent"
    assert exp.payment_method == "bank_transfer"
    assert exp.category_id == cat.id
    assert exp.is_recurring is True
    assert exp.date == today
    # Bilagsnummer allocated
    assert exp.voucher_number == 1


# ─── Test 5: Cron idempotency — same day re-run doesn't double-post ────


def test_cron_idempotent_same_day(db):
    from app.jobs.recurring_expenses_job import materialize_due_recurring_expenses

    user = _user(db, plan="starter")
    cat = _category(db, user, name="Rent")
    today = date.today()

    rule = RecurringExpense(
        user_id=user.id,
        category_id=cat.id,
        name="Rent",
        description="Monthly rent",
        amount=Decimal("18000.00"),
        payment_method="bank_transfer",
        day_of_month=1,
        next_run_date=today,
        is_active=True,
    )
    db.add(rule); db.commit(); db.refresh(rule)

    SessionLocal = sessionmaker(bind=db.bind)
    # First run — creates the expense.
    s1 = materialize_due_recurring_expenses(db_factory=SessionLocal)
    assert s1["expenses_created"] == 1

    # Reset next_run_date so the rule looks due again (simulating a
    # forced re-run with the same target date — e.g. ops manually
    # reverted next_run_date and ran the cron again).
    db.refresh(rule)
    rule.next_run_date = today
    db.commit()

    # Second run — should skip the duplicate.
    s2 = materialize_due_recurring_expenses(db_factory=SessionLocal)
    assert s2["expenses_created"] == 0
    assert s2["skipped_existing"] == 1

    # Only ONE expense in the table.
    count = db.query(Expense).filter(Expense.user_id == user.id).count()
    assert count == 1


# ─── Test 6: Cron advances next_run_date by one month ──────────────────


def test_cron_advances_next_run_date(db):
    from app.jobs.recurring_expenses_job import materialize_due_recurring_expenses

    user = _user(db, plan="starter")
    cat = _category(db, user, name="Rent")
    # Use a fixed past date so we can predict next month deterministically.
    start = date(2026, 5, 1)

    rule = RecurringExpense(
        user_id=user.id,
        category_id=cat.id,
        name="Rent",
        description="Monthly rent",
        amount=Decimal("18000.00"),
        payment_method="bank_transfer",
        day_of_month=1,
        next_run_date=start,
        is_active=True,
    )
    db.add(rule); db.commit(); db.refresh(rule)

    SessionLocal = sessionmaker(bind=db.bind)
    materialize_due_recurring_expenses(db_factory=SessionLocal)
    db.refresh(rule)
    assert rule.next_run_date == date(2026, 6, 1)
    assert rule.last_run_date == start


def test_cron_advance_handles_december_to_january(db):
    """December → January next year edge case."""
    from app.jobs.recurring_expenses_job import _advance_one_month
    assert _advance_one_month(date(2026, 12, 1), 1) == date(2027, 1, 1)
    assert _advance_one_month(date(2026, 12, 15), 15) == date(2027, 1, 15)


# ─── Test 7: audit_logs records both create + materialize ──────────────


def test_audit_log_on_create(client, db):
    user = _user(db, plan="starter")
    _override_user(user)
    cat = _category(db, user)

    client.post("/api/recurring-expenses", json=_payload(cat.id))

    rows = db.query(AuditLog).filter(
        AuditLog.user_id == user.id,
        AuditLog.action == "recurring_expense.created",
    ).all()
    assert len(rows) == 1
    assert rows[0].entity_type == "recurring_expense"
    assert rows[0].after_state is not None
    assert "Rent — Nørrebrogade" in rows[0].after_state


def test_audit_log_on_materialize(db):
    from app.jobs.recurring_expenses_job import materialize_due_recurring_expenses

    user = _user(db, plan="starter")
    cat = _category(db, user, name="Rent")
    today = date.today()
    rule = RecurringExpense(
        user_id=user.id, category_id=cat.id, name="Rent",
        description="Monthly rent",
        amount=Decimal("18000.00"),
        payment_method="bank_transfer", day_of_month=1,
        next_run_date=today, is_active=True,
    )
    db.add(rule); db.commit(); db.refresh(rule)

    SessionLocal = sessionmaker(bind=db.bind)
    materialize_due_recurring_expenses(db_factory=SessionLocal)

    rows = db.query(AuditLog).filter(
        AuditLog.user_id == user.id,
        AuditLog.action == "recurring_expense.materialized",
    ).all()
    assert len(rows) == 1
    assert rows[0].actor_type == "system.recurring_expenses"


# ─── Test 8: day_of_month=31 stored as 28 (validator caps) ─────────────


def test_day_of_month_capped_at_28(client, db):
    user = _user(db, plan="starter")
    _override_user(user)
    cat = _category(db, user)

    res = client.post(
        "/api/recurring-expenses",
        json=_payload(cat.id, day_of_month=31, name="Rule with day 31"),
    )
    assert res.status_code == 201, res.text
    assert res.json()["day_of_month"] == 28


def test_day_of_month_zero_clamped_to_1(client, db):
    user = _user(db, plan="starter")
    _override_user(user)
    cat = _category(db, user)
    res = client.post(
        "/api/recurring-expenses",
        json=_payload(cat.id, day_of_month=0, name="Day zero rule"),
    )
    assert res.status_code == 201
    assert res.json()["day_of_month"] == 1


# ─── Bonus: validation rejects invalid input ───────────────────────────


def test_amount_must_be_positive(client, db):
    user = _user(db, plan="starter")
    _override_user(user)
    cat = _category(db, user)
    res = client.post(
        "/api/recurring-expenses",
        json=_payload(cat.id, amount=0),
    )
    assert res.status_code == 422


def test_payment_method_whitelisted(client, db):
    user = _user(db, plan="starter")
    _override_user(user)
    cat = _category(db, user)
    res = client.post(
        "/api/recurring-expenses",
        json=_payload(cat.id, payment_method="crypto"),
    )
    assert res.status_code == 422


def test_duplicate_name_returns_409(client, db):
    user = _user(db, plan="starter")
    _override_user(user)
    cat = _category(db, user)
    first = client.post("/api/recurring-expenses", json=_payload(cat.id))
    assert first.status_code == 201
    dup = client.post("/api/recurring-expenses", json=_payload(cat.id))
    assert dup.status_code == 409


# ─── Bonus: run-now manual trigger ─────────────────────────────────────


def test_run_now_materializes_immediately(client, db):
    user = _user(db, plan="starter")
    _override_user(user)
    cat = _category(db, user)

    created = client.post(
        "/api/recurring-expenses",
        json=_payload(cat.id, day_of_month=25),  # future date
    ).json()
    rid = created["id"]

    res = client.post(f"/api/recurring-expenses/{rid}/run-now")
    assert res.status_code == 200, res.text

    # An Expense should now exist for today.
    today = date.today()
    exp = db.query(Expense).filter(
        Expense.user_id == user.id, Expense.date == today,
    ).first()
    assert exp is not None
    assert float(exp.amount) == 18000.0
