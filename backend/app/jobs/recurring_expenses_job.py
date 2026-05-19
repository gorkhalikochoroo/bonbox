"""
Daily cron — materialize due recurring expenses (Task #47).

Runs at 04:00 UTC (~05:00–06:00 Copenhagen). For each RecurringExpense
where is_active=True AND next_run_date <= today, this job:
  1. Creates an Expense row identical to a hand-typed one (voucher
     allocation, cash sync, audit log all intact).
  2. Advances the rule's next_run_date by one month (clamped to
     day_of_month).
  3. Stamps last_run_date.
  4. Writes a `recurring_expense.materialized` audit_logs entry.

Multi-tenant safety:
  • Each rule is processed in its own SAVEPOINT-style block so a single
    bad row (e.g. category was deleted, expense_categories FK fails)
    can't poison the rest of the sweep.
  • Idempotency check: if an Expense already exists today with the
    same user_id + amount + date + description, we skip — protecting
    against the cron getting re-fired in the same day (e.g. ops
    restart at 04:01, scheduler re-runs missed job at boot).

Returns a summary dict callable from a future health endpoint.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta
from typing import Callable

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.expense import Expense, ExpenseCategory
from app.models.recurring_expense import RecurringExpense
from app.services import audit_service
from app.services.cash_sync import sync_cash_out_for_expense

logger = logging.getLogger(__name__)


def _advance_one_month(current: date, day_of_month: int) -> date:
    """Return the same day-of-month in the next calendar month.

    Hand-rolled to avoid a hard dateutil dep at call-site — dateutil IS
    installed (tax_service uses it) but this function is small enough
    that an inline implementation is clearer than the import. Clamps
    day_of_month into the actual next month (day_of_month is already
    bounded 1..28 at the schema level so we never need to clamp).
    """
    year = current.year
    month = current.month + 1
    if month > 12:
        month = 1
        year += 1
    # day_of_month is already 1..28 (schema validator caps), so no
    # last-day-of-month logic needed. Defensive min/max anyway.
    safe_day = max(1, min(28, int(day_of_month)))
    return date(year, month, safe_day)


def _due_rules(db: Session, today: date) -> list[RecurringExpense]:
    """Tenant-broad query — returns every due rule across all users. The
    multi-tenant transaction boundary is per-rule, not per-tenant: each
    rule is its own try/commit/rollback so one user's bad row can't
    leak into another tenant's books."""
    return (
        db.query(RecurringExpense)
        .filter(
            RecurringExpense.is_active.is_(True),
            RecurringExpense.next_run_date <= today,
        )
        .all()
    )


def _already_materialized_today(
    db: Session, rule: RecurringExpense, target_date: date,
) -> bool:
    """Idempotency check — has an Expense already been posted for this
    rule on this date? We match on user_id + amount + date + description
    because RecurringExpense isn't FK-linked to Expense (a future option
    we considered but rejected — keeping them decoupled lets owners edit
    materialized rows freely without breaking the rule).
    """
    desc = (rule.description or rule.name or "").strip()
    if not desc:
        return False
    q = (
        db.query(Expense.id)
        .filter(
            Expense.user_id == rule.user_id,
            Expense.date == target_date,
            Expense.amount == rule.amount,
            Expense.description == desc,
            Expense.is_deleted.isnot(True),
        )
        .first()
    )
    return q is not None


def _materialize_one(
    db: Session, rule: RecurringExpense, today: date,
) -> tuple[str, Expense | None]:
    """Process a single rule. Returns ('created'|'skipped'|'error',
    expense_or_None). Caller commits / rolls back."""
    target_date = rule.next_run_date or today
    # Don't post in the future — if next_run_date is somehow tomorrow,
    # the outer query wouldn't have selected this rule. Defensive.
    if target_date > today:
        return ("skipped", None)

    if _already_materialized_today(db, rule, target_date):
        logger.info(
            "recurring_expense.skip_duplicate rule=%s user=%s date=%s",
            rule.id, rule.user_id, target_date,
        )
        # Still advance next_run_date so we don't keep trying — but
        # ONLY if we've actually crossed the boundary. We treat this as
        # "today's run already happened (somehow)" and advance.
        rule.last_run_date = target_date
        rule.next_run_date = _advance_one_month(target_date, rule.day_of_month)
        return ("skipped", None)

    # Resolve the description — falls back to name if not set.
    description = (rule.description or rule.name or "Recurring expense").strip()[:255]

    # Resolve the category — fall back to user's first category if the
    # rule's category was deleted. If no category exists at all, we
    # can't post — Expense.category_id is NOT NULL.
    category_id = rule.category_id
    if category_id:
        cat = db.query(ExpenseCategory).filter(
            ExpenseCategory.id == category_id,
            ExpenseCategory.user_id == rule.user_id,
        ).first()
        if not cat:
            category_id = None
    if not category_id:
        fallback_cat = db.query(ExpenseCategory).filter(
            ExpenseCategory.user_id == rule.user_id,
        ).first()
        if not fallback_cat:
            logger.warning(
                "recurring_expense.no_category user=%s rule=%s — skipping",
                rule.user_id, rule.id,
            )
            return ("error", None)
        category_id = fallback_cat.id

    expense = Expense(
        user_id=rule.user_id,
        category_id=category_id,
        branch_id=rule.branch_id,
        date=target_date,
        amount=rule.amount,
        description=description,
        is_recurring=True,
        payment_method=rule.payment_method,
        notes=rule.notes,
        is_personal=rule.is_personal,
    )
    # Bilagsnummer — Bogføringsloven 2024. Year from expense.date so
    # back-dated entries land in the right fiscal year sequence (same
    # logic as create_expense in routers/expenses.py).
    try:
        from app.services.voucher_service import allocate_voucher
        expense.voucher_number = allocate_voucher(
            db, rule.user_id, "expense", expense.date.year,
        )
    except Exception:  # noqa: BLE001
        expense.voucher_number = None
    db.add(expense)
    db.flush()

    # Cash sync for cash expenses — same as the manual create path.
    if expense.payment_method == "cash" and not expense.is_personal:
        try:
            sync_cash_out_for_expense(db, expense)
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "recurring_expense.cash_sync_failed rule=%s user=%s err=%s",
                rule.id, rule.user_id, e,
            )

    # Advance the schedule.
    rule.last_run_date = target_date
    rule.next_run_date = _advance_one_month(target_date, rule.day_of_month)

    # Audit trail — system-actor since this fires from the cron, not
    # a user request. IP is None.
    audit_service.record(
        db,
        user=rule.user_id,
        action="recurring_expense.materialized",
        entity_type="recurring_expense",
        entity_id=rule.id,
        after={
            "expense_id": str(expense.id),
            "amount": float(rule.amount),
            "date": target_date.isoformat(),
            "description": description,
            "voucher_number": expense.voucher_number,
        },
        actor_type="system.recurring_expenses",
    )
    return ("created", expense)


def materialize_due_recurring_expenses(
    db_factory: Callable[[], Session] = SessionLocal,
) -> dict[str, int]:
    """Materialize every due recurring expense across all tenants.

    Tenant safety: one db session, per-rule SAVEPOINT-like try/commit
    so one bad row doesn't poison the rest. We commit after each rule
    so partial progress persists even if the process is killed mid-job.

    Returns: {users_processed, expenses_created, skipped_existing, errors}.
    """
    today = date.today()
    summary = {
        "users_processed": 0,
        "expenses_created": 0,
        "skipped_existing": 0,
        "errors": 0,
    }
    db = db_factory()
    try:
        rules = _due_rules(db, today)
        if not rules:
            logger.info("recurring_expenses: no due rules at %s", today.isoformat())
            return summary

        seen_users: set = set()
        for rule in rules:
            try:
                status, _expense = _materialize_one(db, rule, today)
                if status == "created":
                    summary["expenses_created"] += 1
                elif status == "skipped":
                    summary["skipped_existing"] += 1
                else:
                    summary["errors"] += 1
                # Commit per-rule so failures in subsequent rules don't
                # roll back successful ones.
                db.commit()
                seen_users.add(str(rule.user_id))
            except Exception as e:  # noqa: BLE001
                logger.exception(
                    "recurring_expenses: rule=%s user=%s failed: %s",
                    rule.id, rule.user_id, e,
                )
                db.rollback()
                summary["errors"] += 1
        summary["users_processed"] = len(seen_users)
        logger.info("recurring_expenses summary: %s", summary)
        return summary
    finally:
        db.close()
