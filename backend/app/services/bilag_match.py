"""Photo-later matching — does this receipt belong to an expense already typed?

Most owners type the day's figures by hand and photograph the receipts later,
in a batch. Every receipt path (single scan, "Scan bunke", the e-mail inbox)
used to make a NEW expense for the photo, so the typed row and the scanned row
both stood in the books: the same purchase twice, its købsmoms claimed twice.

This module answers one question — "which booked expenses WITHOUT a bilag
could this receipt be the bilag for?" — and nothing else. It never merges: the
owner is offered "Knyt til eksisterende udgift" and decides. Attaching then
adds only the bilag (and fills fields that are empty), never the amount, and
never anything VAT-related on a period that is already locked.

The match rule (deliberately narrow — a false offer costs a tap, a false
merge would cost a real expense):
  • same owner, booked (not a Godkend-kø draft), not deleted, not personal;
  • no bilag yet (receipt_photo empty);
  • amount within ±0,50 kr. (a typed 129 vs a printed 128,95);
  • date within ±3 days (typed on the day, receipt dated the purchase);
  • same branch when the receipt side knows its branch (an expense with no
    branch is a candidate for any — typed expenses carry none today);
  • ordered: same supplier first (when known), then nearest date, then
    nearest amount.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.expense import Expense
from app.services.expense_status import not_pending

logger = logging.getLogger(__name__)

AMOUNT_TOLERANCE_KR = 0.50
DATE_WINDOW_DAYS = 3
MAX_CANDIDATES = 5

# A receipt-side branch we do not know (the single scan, an inbox mail).
UNKNOWN_BRANCH = object()


@dataclass
class Candidate:
    expense: Expense
    day_diff: int
    amount_diff: float
    same_vendor: bool


def _no_bilag():
    return or_(Expense.receipt_photo.is_(None), Expense.receipt_photo == "")


def find_candidates(
    db: Session,
    user_id,
    *,
    amount,
    on_date: date | None,
    vendor_key: str | None = None,
    branch_id=UNKNOWN_BRANCH,
    exclude_ids=(),
    limit: int = MAX_CANDIDATES,
) -> list[Candidate]:
    """Booked expenses without a bilag that this receipt could belong to.

    `amount` / `on_date` are what the receipt says (read by OCR or typed by the
    owner). No amount or no date → no candidates: a 0 kr. draft matches
    nothing rather than everything."""
    try:
        amt = float(amount) if amount is not None else 0.0
    except (TypeError, ValueError):
        return []
    if amt <= 0 or on_date is None:
        return []
    lo, hi = amt - AMOUNT_TOLERANCE_KR, amt + AMOUNT_TOLERANCE_KR
    q = (
        db.query(Expense)
        .filter(
            Expense.user_id == user_id,
            Expense.is_deleted.isnot(True),
            Expense.is_personal.isnot(True),
            not_pending(),
            _no_bilag(),
            Expense.amount >= round(lo, 2),
            Expense.amount <= round(hi, 2),
            Expense.date >= on_date - timedelta(days=DATE_WINDOW_DAYS),
            Expense.date <= on_date + timedelta(days=DATE_WINDOW_DAYS),
        )
    )
    if branch_id is not UNKNOWN_BRANCH and branch_id is not None:
        q = q.filter(or_(Expense.branch_id == branch_id, Expense.branch_id.is_(None)))
    ex = [e for e in (exclude_ids or ()) if e is not None]
    if ex:
        q = q.filter(~Expense.id.in_(ex))
    rows = q.limit(50).all()
    out = [
        Candidate(
            expense=e,
            day_diff=abs((e.date - on_date).days),
            amount_diff=round(abs(float(e.amount) - amt), 2),
            same_vendor=bool(vendor_key) and (e.vendor_key or None) == vendor_key,
        )
        for e in rows
    ]
    out.sort(key=lambda c: (
        0 if c.same_vendor else 1, c.day_diff, c.amount_diff,
        -(c.expense.created_at.timestamp() if c.expense.created_at else 0),
    ))
    return out[:limit]


# ─── Locked periods ──────────────────────────────────────────────────────
#
# A period is LOCKED for this purpose when its figures have left BonBox: a
# locked kasserapport for the day, a MOMS-angivelse sent to the revisor that
# covers it, or a revisor package sent for it. Attaching a bilag never changes
# an amount anywhere; on a locked period it also fills no VAT field.

_PERIOD_SEND_ACTIONS = ("tax.filing_sent_to_accountant", "revisor_package.sent")


def locked_reason(db: Session, user_id, d: date) -> str | None:
    """Why `d` is a locked period for this owner, or None.

    'close_locked'  — the day's kasserapport is locked (status confirmed)
    'moms_sent'     — a MOMS-angivelse covering the day went to the revisor
    'package_sent'  — a revisor package covering the day went to the revisor
    A lookup that fails counts as locked: when BonBox cannot tell, it does
    not fill VAT fields."""
    if d is None:
        return None
    try:
        from app.models.daily_close import DailyClose
        hit = (
            db.query(DailyClose.id)
            .filter(DailyClose.user_id == user_id, DailyClose.date == d,
                    DailyClose.is_deleted.isnot(True), DailyClose.status == "confirmed")
            .first()
        )
        if hit:
            return "close_locked"
        from app.models.audit_log import AuditLog
        rows = (
            db.query(AuditLog.action, AuditLog.after_state)
            .filter(AuditLog.user_id == user_id, AuditLog.action.in_(_PERIOD_SEND_ACTIONS))
            .order_by(AuditLog.created_at.desc())
            .limit(200)
            .all()
        )
        iso = d.isoformat()
        for action, after in rows:
            try:
                a = json.loads(after or "{}") or {}
            except (TypeError, ValueError):
                continue
            if not isinstance(a, dict):
                continue
            start = a.get("period_start") or a.get("from_date")
            end = a.get("period_end") or a.get("to_date")
            if start and end and str(start) <= iso <= str(end):
                return "moms_sent" if action == "tax.filing_sent_to_accountant" else "package_sent"
    except Exception:  # noqa: BLE001 — fail closed: no VAT fields filled
        logger.warning("bilag_match.locked_reason lookup failed", exc_info=True)
        return "unknown"
    return None


def candidate_json(c: Candidate, category_name: str | None = None) -> dict:
    e = c.expense
    return {
        "id": str(e.id),
        "date": e.date.isoformat() if e.date else None,
        "amount": float(e.amount or 0),
        "description": e.description,
        "category_id": str(e.category_id) if e.category_id else None,
        "category_name": category_name,
        "payment_method": e.payment_method,
        "voucher_number": e.voucher_number,
        "day_diff": c.day_diff,
        "amount_diff": c.amount_diff,
        "same_vendor": c.same_vendor,
    }
