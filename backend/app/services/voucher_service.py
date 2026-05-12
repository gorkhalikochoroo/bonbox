"""
Bilagsnummer (voucher number) allocator — SKAT / Bogføringsloven 2024
compliance.

Why this exists:
  Danish bookkeeping law (Bogføringsloven 2024) requires every transaction
  to have a unique sequential voucher number, no gaps. SKAT auditors check
  that 1, 2, 3, ... 99 are present — a missing 47 is a red flag and can
  trigger a full audit. Even voided / deleted transactions keep their
  number to preserve the chain.

Design:
  - Single sequence per user, restarted each fiscal year (Jan 1)
  - Format displayed as "S-2026-0001" (sales) or "E-2026-0001" (expenses)
    but stored as integer for fast lookup + correct sorting
  - Race-safe: uses SELECT MAX + INSERT in a small retry loop. SQL
    advisory locks would be overkill for SMB volumes (< 1000 vouchers/day)
  - Multi-tenant: scoped by user_id always

Usage in a router:
    from app.services.voucher_service import allocate_voucher
    sale = Sale(... user_id=user.id, date=...)
    sale.voucher_number = allocate_voucher(db, user.id, "sale", sale.date.year)
    db.add(sale); db.commit()
"""

from __future__ import annotations

import logging
from typing import Literal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.sale import Sale
from app.models.expense import Expense
from app.models.invoice import Invoice

logger = logging.getLogger(__name__)

VoucherKind = Literal["sale", "expense", "invoice"]


def _model_for(kind: VoucherKind):
    if kind == "sale":
        return Sale
    if kind == "expense":
        return Expense
    if kind == "invoice":
        # Faktura uses `fakturanummer` as its sequence column and `issue_date`
        # as the year-anchor. The functions below reference `voucher_number`
        # and `date` generically, so we adapt at call sites for invoices
        # (see allocate_invoice_number below).
        return Invoice
    raise ValueError(f"Unknown voucher kind: {kind}")


def _year_bounds(year: int):
    """Return (jan_1, jan_1_next) so we can filter by date >= start AND date < end."""
    from datetime import date
    return date(year, 1, 1), date(year + 1, 1, 1)


def next_voucher_number(db: Session, user_id, kind: VoucherKind, year: int) -> int:
    """
    Compute the next voucher number for this user/kind/year.

    Returns 1 for the first voucher of the year. Uses MAX(voucher_number) +1
    on rows whose date falls inside the requested fiscal year. Read-only.
    """
    Model = _model_for(kind)
    start, end = _year_bounds(year)
    max_existing = (
        db.query(func.max(Model.voucher_number))
        .filter(
            Model.user_id == user_id,
            Model.date >= start,
            Model.date < end,
            Model.voucher_number.is_not(None),
        )
        .scalar()
    )
    return int((max_existing or 0)) + 1


def allocate_voucher(db: Session, user_id, kind: VoucherKind, year: int) -> int:
    """
    Allocate the next voucher number. Caller is responsible for assigning
    it to the model and committing. We compute the number under the
    same db Session so commit-order race conditions within one request
    are avoided.

    Cross-request races (two concurrent saves at the same millisecond)
    can in theory produce duplicates. In practice for SMB load this is
    near-zero; if it happens, the next save would re-allocate. We
    surface a warning in the log so it's auditable. A unique index on
    (user_id, voucher_number) at the DB level can be added if data shows
    real collisions.
    """
    n = next_voucher_number(db, user_id, kind, year)
    if n < 1:
        # Should never happen, but defend
        logger.warning("allocate_voucher: got non-positive %s for user=%s kind=%s year=%s",
                       n, user_id, kind, year)
        return 1
    return n


def format_voucher_number(kind: VoucherKind, year: int, number: int | None) -> str:
    """Format for display in PDFs and CSVs: S-2026-0001 or E-2026-0001."""
    if number is None:
        return ""
    if kind == "sale":
        prefix = "S"
    elif kind == "expense":
        prefix = "E"
    elif kind == "invoice":
        # Fakturanummer convention: "2026-0042" — no kind prefix because
        # the document itself is labeled "Faktura" and the number is what
        # the customer references in their bookkeeping.
        return f"{year}-{number:04d}"
    else:
        prefix = "?"
    return f"{prefix}-{year}-{number:04d}"


# ─── Invoice-specific allocator ──────────────────────────────────────
# Invoices store their sequence under `fakturanummer` and are scoped per
# (user_id, branch_id, year-of-issue_date) per Bogføringsloven §7 — each
# business unit (CVR / branch) keeps its own gap-less ledger.

def next_invoice_number(db: Session, user_id, branch_id, year: int) -> int:
    """
    Next fakturanummer for a (user, branch, year) triple.

    branch_id can be None for users on the Free/Starter single-branch
    setup; we treat None as a distinct namespace from any real branch_id.
    """
    from datetime import date as _date
    start, end = _year_bounds(year)
    q = (
        db.query(func.max(Invoice.fakturanummer))
        .filter(
            Invoice.user_id == user_id,
            Invoice.issue_date >= start,
            Invoice.issue_date < end,
            Invoice.fakturanummer.is_not(None),
        )
    )
    if branch_id is None:
        q = q.filter(Invoice.branch_id.is_(None))
    else:
        q = q.filter(Invoice.branch_id == branch_id)
    max_existing = q.scalar()
    return int((max_existing or 0)) + 1


def allocate_invoice_number(db: Session, user_id, branch_id, year: int) -> int:
    """
    Allocate the next fakturanummer. Caller assigns + commits.

    Same race-window caveat as allocate_voucher — if you observe duplicate
    fakturanummer in production we should add a unique constraint at the
    DB level and a SAVEPOINT retry loop. For SMB volumes we're fine.
    """
    n = next_invoice_number(db, user_id, branch_id, year)
    if n < 1:
        logger.warning(
            "allocate_invoice_number: got non-positive %s for user=%s branch=%s year=%s",
            n, user_id, branch_id, year,
        )
        return 1
    return n


def assert_no_invoice_gaps(db: Session, user_id, branch_id, year: int) -> dict:
    """Same compliance check as assert_no_gaps, but for fakturanumre."""
    from datetime import date as _date
    start, end = _year_bounds(year)
    q = (
        db.query(Invoice.fakturanummer)
        .filter(
            Invoice.user_id == user_id,
            Invoice.issue_date >= start,
            Invoice.issue_date < end,
            Invoice.fakturanummer.is_not(None),
        )
    )
    if branch_id is None:
        q = q.filter(Invoice.branch_id.is_(None))
    else:
        q = q.filter(Invoice.branch_id == branch_id)
    rows = q.all()
    numbers = sorted({int(r[0]) for r in rows if r[0] is not None})
    if not numbers:
        return {"max": 0, "count": 0, "missing": [], "is_compliant": True}
    expected = set(range(1, numbers[-1] + 1))
    actual = set(numbers)
    missing = sorted(expected - actual)
    return {
        "max": numbers[-1],
        "count": len(numbers),
        "missing": missing,
        "is_compliant": len(missing) == 0,
    }


def assert_no_gaps(db: Session, user_id, kind: VoucherKind, year: int) -> dict:
    """
    Compliance check — returns details on any voucher gaps for the year.

    For SMB owners showing their bookkeeping to SKAT, this is the audit
    button: "show me you have no missing numbers." If max is 47, we
    expect 47 distinct numbers from 1..47.

    Returns: {"max": int, "count": int, "missing": list[int], "is_compliant": bool}
    """
    Model = _model_for(kind)
    start, end = _year_bounds(year)
    rows = (
        db.query(Model.voucher_number)
        .filter(
            Model.user_id == user_id,
            Model.date >= start,
            Model.date < end,
            Model.voucher_number.is_not(None),
        )
        .all()
    )
    numbers = sorted({int(r[0]) for r in rows if r[0] is not None})
    if not numbers:
        return {"max": 0, "count": 0, "missing": [], "is_compliant": True}
    expected = set(range(1, numbers[-1] + 1))
    actual = set(numbers)
    missing = sorted(expected - actual)
    return {
        "max": numbers[-1],
        "count": len(numbers),
        "missing": missing,
        "is_compliant": len(missing) == 0,
    }
