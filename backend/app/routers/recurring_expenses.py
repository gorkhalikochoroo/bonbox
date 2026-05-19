"""
Recurring expenses — Starter+ feature (Task #47).

Endpoints:
  GET    /api/recurring-expenses                — list active + paused rules
  POST   /api/recurring-expenses                — create new rule (tier-gated)
  PUT    /api/recurring-expenses/{id}           — update (tier-gated)
  DELETE /api/recurring-expenses/{id}           — soft-archive (is_active=False)
  POST   /api/recurring-expenses/{id}/pause     — pause (is_active=False)
  POST   /api/recurring-expenses/{id}/resume    — resume (is_active=True)
  POST   /api/recurring-expenses/{id}/run-now   — manual materialize (tier-gated)

Multi-layer defense (mirrors the rest of the codebase):
  L1 auth          — get_current_user dep
  L2 tier gate     — has_feature(user, "recurring_expenses") on every mutation
  L3 tenant scope  — every query filters by user_id
  L4 input bounds  — Pydantic validators on amount / day_of_month / etc.
  L5 audit trail   — every mutation writes audit_logs via audit_service

Soft-delete: DELETE sets is_active=False rather than removing the row.
This preserves the audit_logs history that references the rule's id +
keeps the rule visible to admins for the 10y Skatteforvaltningsloven
window. A future endpoint can hard-delete archived rules > 5y old.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.expense import ExpenseCategory
from app.models.branch import Branch
from app.models.recurring_expense import RecurringExpense
from app.models.user import User
from app.schemas.recurring_expense import (
    RecurringExpenseCreate,
    RecurringExpenseResponse,
    RecurringExpenseUpdate,
)
from app.services import audit_service
from app.services.auth import get_current_user
from app.services.billing import effective_plan, has_feature

logger = logging.getLogger(__name__)

router = APIRouter()


# ─── Helpers ──────────────────────────────────────────────────────────

_MONTH_NAMES_EN = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def _format_next_run_human(rule: RecurringExpense) -> str:
    """Build a friendly UI string from the rule's state.

    Examples: "Next: 1 June 2026", "Paused", "Next: today".
    English on the server — i18n happens in the frontend by reading
    next_run_date directly when the locale-aware label is needed.
    """
    if not rule.is_active:
        return "Paused"
    nrd = rule.next_run_date
    if nrd is None:
        return "Not scheduled"
    today = date.today()
    if nrd <= today:
        return "Next: today"
    return f"Next: {nrd.day} {_MONTH_NAMES_EN[nrd.month - 1]} {nrd.year}"


def _to_response(rule: RecurringExpense) -> RecurringExpenseResponse:
    """Compose the response model with the computed next_run_human."""
    return RecurringExpenseResponse(
        id=rule.id,
        user_id=rule.user_id,
        branch_id=rule.branch_id,
        category_id=rule.category_id,
        name=rule.name,
        description=rule.description,
        amount=float(rule.amount),
        payment_method=rule.payment_method,
        frequency=rule.frequency,
        day_of_month=rule.day_of_month,
        next_run_date=rule.next_run_date,
        last_run_date=rule.last_run_date,
        is_active=rule.is_active,
        is_personal=rule.is_personal,
        notes=rule.notes,
        created_at=rule.created_at,
        updated_at=rule.updated_at,
        next_run_human=_format_next_run_human(rule),
    )


def _compute_first_next_run(day_of_month: int, today: date | None = None) -> date:
    """The first next_run_date for a brand-new rule. If today's calendar
    day is already past the rule's day_of_month, schedule next month;
    otherwise schedule this month (so e.g. setting up rent on the
    morning of the 1st posts immediately on the 1st via the daily cron,
    not waiting until next month)."""
    today = today or date.today()
    safe_day = max(1, min(28, int(day_of_month)))
    if today.day <= safe_day:
        return date(today.year, today.month, safe_day)
    # Next month
    year = today.year
    month = today.month + 1
    if month > 12:
        month = 1
        year += 1
    return date(year, month, safe_day)


def _enforce_starter_tier(user: User) -> None:
    """Raise 402 plan_required if the user's plan doesn't include the
    `recurring_expenses` feature. Same structured detail shape as the
    `direct_accountant_email` gate in daily_close.py so the frontend can
    render the upgrade nudge from one error contract.
    """
    if not has_feature(user, "recurring_expenses"):
        raise HTTPException(
            status_code=402,
            detail={
                "code": "plan_required",
                "error": "feature_locked",
                "feature": "recurring_expenses",
                "required_plan": "starter",
                "upgrade_to": "starter",
                "current_plan": effective_plan(user),
                "plan": effective_plan(user),
                "message": (
                    "Recurring expenses (auto-post monthly bills) is on Starter. "
                    "Free users can still log expenses one by one."
                ),
            },
        )


def _resolve_branch(db: Session, user: User, branch_id) -> uuid.UUID | None:
    """If branch_id is given, verify it belongs to the user. Otherwise
    pick the user's default branch (if any). Returns the resolved
    branch_id or None for single-branch / unconfigured tenants."""
    if branch_id is not None:
        b = db.query(Branch).filter(
            Branch.id == branch_id,
            Branch.user_id == user.id,
        ).first()
        if not b:
            raise HTTPException(status_code=404, detail="Branch not found")
        return b.id
    # Default — first active branch, if any. Stays None for owners
    # who haven't set up branches yet (single-location case).
    default_branch = (
        db.query(Branch)
        .filter(Branch.user_id == user.id, Branch.is_active.is_(True))
        .order_by(Branch.is_default.desc(), Branch.created_at.asc())
        .first()
    )
    return default_branch.id if default_branch else None


def _verify_category(db: Session, user: User, category_id) -> uuid.UUID | None:
    """If category_id is given, verify it belongs to the user."""
    if category_id is None:
        return None
    cat = db.query(ExpenseCategory).filter(
        ExpenseCategory.id == category_id,
        ExpenseCategory.user_id == user.id,
    ).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    return cat.id


def _get_owned_rule(db: Session, user: User, rule_id) -> RecurringExpense:
    """Fetch a rule scoped to the current user. 404 on miss — never
    leak whether the rule exists for another tenant."""
    rule = db.query(RecurringExpense).filter(
        RecurringExpense.id == rule_id,
        RecurringExpense.user_id == user.id,
    ).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Recurring expense not found")
    return rule


def _client_ip(request: Request | None) -> str | None:
    try:
        return request.client.host if request and request.client else None
    except Exception:  # noqa: BLE001
        return None


# ─── Endpoints ────────────────────────────────────────────────────────


@router.get("", response_model=list[RecurringExpenseResponse])
def list_recurring_expenses(
    include_inactive: bool = True,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List all recurring expense rules for the current user.

    Not tier-gated on READ — Free users can see archived rules they may
    have set up during a trial. Mutations are still blocked server-side.
    Returns active rules sorted by next_run_date (soonest first), then
    paused rules at the end.
    """
    q = db.query(RecurringExpense).filter(RecurringExpense.user_id == user.id)
    if not include_inactive:
        q = q.filter(RecurringExpense.is_active.is_(True))
    rules = q.order_by(
        RecurringExpense.is_active.desc(),
        RecurringExpense.next_run_date.asc(),
        RecurringExpense.created_at.desc(),
    ).all()
    return [_to_response(r) for r in rules]


@router.post(
    "",
    response_model=RecurringExpenseResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_recurring_expense(
    data: RecurringExpenseCreate,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _enforce_starter_tier(user)

    # Tenant-scoped FK validation.
    branch_id = _resolve_branch(db, user, data.branch_id)
    category_id = _verify_category(db, user, data.category_id)

    # First next_run_date — body override wins (lets owners set up a
    # rule with explicit start), else compute from day_of_month.
    next_run = data.next_run_date or _compute_first_next_run(data.day_of_month)

    rule = RecurringExpense(
        user_id=user.id,
        branch_id=branch_id,
        category_id=category_id,
        name=data.name,
        description=data.description,
        amount=data.amount,
        payment_method=data.payment_method,
        frequency=data.frequency,
        day_of_month=data.day_of_month,
        next_run_date=next_run,
        is_personal=data.is_personal,
        notes=data.notes,
        is_active=True,
    )
    db.add(rule)
    try:
        db.flush()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        # Most likely: UNIQUE(user_id, name) collision.
        raise HTTPException(
            status_code=409,
            detail=f"A recurring expense named {data.name!r} already exists",
        ) from e

    audit_service.record(
        db,
        user=user,
        action="recurring_expense.created",
        entity_type="recurring_expense",
        entity_id=rule.id,
        after={
            "name": rule.name,
            "amount": float(rule.amount),
            "day_of_month": rule.day_of_month,
            "next_run_date": rule.next_run_date.isoformat(),
        },
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(rule)
    return _to_response(rule)


@router.put("/{rule_id}", response_model=RecurringExpenseResponse)
def update_recurring_expense(
    rule_id: uuid.UUID,
    data: RecurringExpenseUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _enforce_starter_tier(user)
    rule = _get_owned_rule(db, user, rule_id)

    before = {
        "name": rule.name,
        "amount": float(rule.amount),
        "day_of_month": rule.day_of_month,
        "next_run_date": rule.next_run_date.isoformat() if rule.next_run_date else None,
        "is_active": rule.is_active,
    }

    payload = data.model_dump(exclude_unset=True)
    # FK validation only for fields that actually changed.
    if "branch_id" in payload:
        payload["branch_id"] = _resolve_branch(db, user, payload["branch_id"])
    if "category_id" in payload:
        payload["category_id"] = _verify_category(db, user, payload["category_id"])

    for field, value in payload.items():
        setattr(rule, field, value)

    try:
        db.flush()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Recurring expense update failed (likely duplicate name)",
        ) from e

    audit_service.record(
        db,
        user=user,
        action="recurring_expense.updated",
        entity_type="recurring_expense",
        entity_id=rule.id,
        before=before,
        after={
            "name": rule.name,
            "amount": float(rule.amount),
            "day_of_month": rule.day_of_month,
            "next_run_date": rule.next_run_date.isoformat() if rule.next_run_date else None,
            "is_active": rule.is_active,
        },
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(rule)
    return _to_response(rule)


@router.delete("/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_recurring_expense(
    rule_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Soft-archive — set is_active=False. Materializer skips inactive
    rules; UI hides them by default. Preserves the audit trail of past
    materializations that reference this rule's id.
    """
    _enforce_starter_tier(user)
    rule = _get_owned_rule(db, user, rule_id)
    if rule.is_active:
        before = {"is_active": True}
        rule.is_active = False
        audit_service.record(
            db,
            user=user,
            action="recurring_expense.archived",
            entity_type="recurring_expense",
            entity_id=rule.id,
            before=before,
            after={"is_active": False},
            ip_address=_client_ip(request),
        )
        db.commit()
    # 204 — no body even on no-op (idempotent).


@router.post("/{rule_id}/pause", response_model=RecurringExpenseResponse)
def pause_recurring_expense(
    rule_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _enforce_starter_tier(user)
    rule = _get_owned_rule(db, user, rule_id)
    if rule.is_active:
        before = {"is_active": True}
        rule.is_active = False
        audit_service.record(
            db,
            user=user,
            action="recurring_expense.archived",
            entity_type="recurring_expense",
            entity_id=rule.id,
            before=before,
            after={"is_active": False, "via": "pause"},
            ip_address=_client_ip(request),
        )
        db.commit()
        db.refresh(rule)
    return _to_response(rule)


@router.post("/{rule_id}/resume", response_model=RecurringExpenseResponse)
def resume_recurring_expense(
    rule_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _enforce_starter_tier(user)
    rule = _get_owned_rule(db, user, rule_id)
    if not rule.is_active:
        before = {"is_active": False}
        rule.is_active = True
        # If next_run_date is in the past (rule was paused for > 1
        # month), nudge it forward to the next future occurrence so the
        # owner doesn't get a back-dated cascade of materializations.
        today = date.today()
        if rule.next_run_date and rule.next_run_date < today:
            rule.next_run_date = _compute_first_next_run(rule.day_of_month, today)
        audit_service.record(
            db,
            user=user,
            action="recurring_expense.updated",
            entity_type="recurring_expense",
            entity_id=rule.id,
            before=before,
            after={"is_active": True, "via": "resume",
                   "next_run_date": rule.next_run_date.isoformat()
                   if rule.next_run_date else None},
            ip_address=_client_ip(request),
        )
        db.commit()
        db.refresh(rule)
    return _to_response(rule)


@router.post("/{rule_id}/run-now", response_model=RecurringExpenseResponse)
def run_recurring_expense_now(
    rule_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Manually materialize the next occurrence. Useful for owners who
    want to post early this month (e.g. paid rent on the 25th instead
    of waiting for the 1st). Reuses the cron job's per-rule routine so
    voucher allocation, cash sync, audit trail all stay consistent.
    """
    _enforce_starter_tier(user)
    rule = _get_owned_rule(db, user, rule_id)
    if not rule.is_active:
        raise HTTPException(
            status_code=400,
            detail="Cannot run a paused rule. Resume it first.",
        )

    from app.jobs.recurring_expenses_job import _materialize_one
    today = date.today()
    # Force today's date even if next_run_date was further out — that's
    # the whole point of "run now".
    original_next_run = rule.next_run_date
    rule.next_run_date = today
    try:
        status_, expense = _materialize_one(db, rule, today)
        if status_ == "error":
            # Restore the schedule on failure so the next cron run
            # picks it up correctly.
            rule.next_run_date = original_next_run
            db.rollback()
            raise HTTPException(
                status_code=400,
                detail=(
                    "Could not materialize — owner has no expense categories yet. "
                    "Add a category first."
                ),
            )
        # On success the materializer already wrote the audit row +
        # advanced next_run_date. Commit once.
        db.commit()
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logger.exception(
            "recurring_expense.run_now failed rule=%s user=%s err=%s",
            rule_id, user.id, e,
        )
        db.rollback()
        rule.next_run_date = original_next_run
        db.commit()
        raise HTTPException(
            status_code=500,
            detail="Could not run this recurring expense now. Try again later.",
        ) from e
    db.refresh(rule)
    return _to_response(rule)
