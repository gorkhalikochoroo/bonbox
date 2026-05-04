"""
Bookkeeping export service.

Exports sales + expenses to CSVs that import cleanly into the major Danish
bookkeeping platforms (Dinero, Billy, e-conomic). Also produces a
generic-CSV format that works for any accountant.

Each platform expects slightly different column names + ordering. We keep
all variants here so the formatting logic is colocated and easy to update
when platforms change their schemas.

Design rules:
  - Output is always pre-rendered CSV bytes, never a streaming file. Bookkeeping
    exports are typically a month or quarter — bounded.
  - VAT handling: Danish "Moms" is 25% by default. Items flagged tax-exempt
    are exported with VAT code = 0.
  - Returns are excluded (status="returned") so the books don't double-count.
  - Soft-deleted rows are excluded.
"""

from __future__ import annotations

import csv
import io
from datetime import date
from typing import Iterable

from sqlalchemy.orm import Session

from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.user import User


# ───────── helpers ─────────


def _money(amount) -> str:
    """Format Decimal/float with comma decimal (Danish convention)."""
    if amount is None:
        return "0,00"
    try:
        return f"{float(amount):.2f}".replace(".", ",")
    except (TypeError, ValueError):
        return "0,00"


def _money_dot(amount) -> str:
    """Format with dot decimal (international convention)."""
    if amount is None:
        return "0.00"
    try:
        return f"{float(amount):.2f}"
    except (TypeError, ValueError):
        return "0.00"


def _query_sales(user: User, db: Session, start: date, end: date) -> list[Sale]:
    return (
        db.query(Sale)
        .filter(
            Sale.user_id == user.id,
            Sale.date >= start,
            Sale.date <= end,
            Sale.is_deleted == False,  # noqa: E712
            Sale.status != "returned",
        )
        .order_by(Sale.date.asc())
        .all()
    )


def _query_expenses(user: User, db: Session, start: date, end: date) -> list[Expense]:
    return (
        db.query(Expense)
        .filter(
            Expense.user_id == user.id,
            Expense.date >= start,
            Expense.date <= end,
            Expense.is_deleted == False,  # noqa: E712
            Expense.is_personal == False,  # noqa: E712
        )
        .order_by(Expense.date.asc())
        .all()
    )


def _category_lookup(user: User, db: Session) -> dict:
    rows = db.query(ExpenseCategory).filter(ExpenseCategory.user_id == user.id).all()
    return {str(r.id): r.name for r in rows}


# ───────── DINERO ─────────


def export_dinero(user: User, db: Session, start: date, end: date) -> bytes:
    """
    Dinero CSV — based on their "Bilag (CSV)" import.
    Columns: Dato; Bilag; Beskrivelse; Beløb; Moms; Konto

    For Dinero, sales go to account 1010 (Salg af varer/ydelser) by default
    and expenses go to a generic 2750 (Andre driftsudgifter). Owners will
    re-categorise inside Dinero — we just provide a clean import.
    """
    sales = _query_sales(user, db, start, end)
    expenses = _query_expenses(user, db, start, end)
    cats = _category_lookup(user, db)

    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    w.writerow(["Dato", "Bilag", "Beskrivelse", "Beløb", "Moms", "Konto"])

    voucher = 1
    for s in sales:
        moms = "0%" if getattr(s, "is_tax_exempt", False) else "25%"
        desc = (s.description or "Salg") + (
            f" (ref: {s.reference_id})" if getattr(s, "reference_id", None) else ""
        )
        w.writerow([
            s.date.isoformat() if hasattr(s.date, "isoformat") else str(s.date),
            f"S{voucher:04d}",
            desc[:80],
            _money(s.amount),
            moms,
            "1010",
        ])
        voucher += 1

    voucher = 1
    for e in expenses:
        moms = "0%" if getattr(e, "is_tax_exempt", False) else "25%"
        cat_name = cats.get(str(e.category_id), "Other")
        desc = f"{cat_name}: {e.description}" if e.description else cat_name
        w.writerow([
            e.date.isoformat() if hasattr(e.date, "isoformat") else str(e.date),
            f"E{voucher:04d}",
            desc[:80],
            _money(-float(e.amount)),
            moms,
            "2750",
        ])
        voucher += 1

    return buf.getvalue().encode("utf-8-sig")  # BOM so Excel opens cleanly


# ───────── BILLY ─────────


def export_billy(user: User, db: Session, start: date, end: date) -> bytes:
    """
    Billy CSV — they accept simple "Dato, Tekst, Beløb" entries.
    We produce two virtual files joined by section header lines so the user
    can split easily: one section "Salg", one "Udgifter".

    Billy users typically import sales as "income lines" and expenses as
    expense lines. We split into two, each with their preferred column set.
    """
    sales = _query_sales(user, db, start, end)
    expenses = _query_expenses(user, db, start, end)
    cats = _category_lookup(user, db)

    buf = io.StringIO()
    w = csv.writer(buf, delimiter=",", quoting=csv.QUOTE_MINIMAL, lineterminator="\n")

    # SALES section
    w.writerow(["# === SALES ==="])
    w.writerow(["Date", "Description", "Amount", "Currency", "VAT %", "Payment"])
    for s in sales:
        vat = "0" if getattr(s, "is_tax_exempt", False) else "25"
        desc = s.description or "Sale"
        w.writerow([
            s.date.isoformat() if hasattr(s.date, "isoformat") else str(s.date),
            desc[:120],
            _money_dot(s.amount),
            user.currency or "DKK",
            vat,
            (getattr(s, "payment_method", None) or "").capitalize(),
        ])

    # Empty separator
    w.writerow([])

    # EXPENSES section
    w.writerow(["# === EXPENSES ==="])
    w.writerow(["Date", "Category", "Description", "Amount", "Currency", "VAT %"])
    for e in expenses:
        vat = "0" if getattr(e, "is_tax_exempt", False) else "25"
        cat_name = cats.get(str(e.category_id), "Other")
        w.writerow([
            e.date.isoformat() if hasattr(e.date, "isoformat") else str(e.date),
            cat_name,
            e.description or "",
            _money_dot(e.amount),
            user.currency or "DKK",
            vat,
        ])

    return buf.getvalue().encode("utf-8-sig")


# ───────── E-CONOMIC ─────────


def export_economic(user: User, db: Session, start: date, end: date) -> bytes:
    """
    e-conomic CSV — based on their voucher CSV import.
    Columns:
      Voucher number, Date, Description, Account, Amount, Currency, VAT code

    e-conomic is more rigid about account numbers. We use:
      1010 = sales
      2750 = generic expenses
    Owners will re-map categories in e-conomic afterward — we just provide
    a clean canonical voucher list.
    """
    sales = _query_sales(user, db, start, end)
    expenses = _query_expenses(user, db, start, end)
    cats = _category_lookup(user, db)
    cur = user.currency or "DKK"

    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    w.writerow([
        "Voucher number",
        "Date",
        "Description",
        "Account",
        "Amount",
        "Currency",
        "VAT code",
    ])

    voucher = 1
    for s in sales:
        vat = "U0" if getattr(s, "is_tax_exempt", False) else "U25"
        desc = s.description or "Salg"
        w.writerow([
            f"S{voucher:05d}",
            s.date.isoformat() if hasattr(s.date, "isoformat") else str(s.date),
            desc[:80],
            "1010",
            _money_dot(s.amount),
            cur,
            vat,
        ])
        voucher += 1

    voucher = 1
    for e in expenses:
        vat = "I0" if getattr(e, "is_tax_exempt", False) else "I25"
        cat_name = cats.get(str(e.category_id), "Other")
        desc = f"{cat_name}: {e.description}" if e.description else cat_name
        w.writerow([
            f"E{voucher:05d}",
            e.date.isoformat() if hasattr(e.date, "isoformat") else str(e.date),
            desc[:80],
            "2750",
            f"-{_money_dot(e.amount)}",
            cur,
            vat,
        ])
        voucher += 1

    return buf.getvalue().encode("utf-8-sig")


# ───────── Generic / Universal CSV ─────────


def export_generic(user: User, db: Session, start: date, end: date) -> bytes:
    """
    Universal CSV that any accountant can re-format. Single sheet with
    type column so users don't need to deal with two files.

    Columns: Date, Type, Description, Category, Amount, Currency, VAT %, Payment
    """
    sales = _query_sales(user, db, start, end)
    expenses = _query_expenses(user, db, start, end)
    cats = _category_lookup(user, db)
    cur = user.currency or "DKK"

    buf = io.StringIO()
    w = csv.writer(buf, delimiter=",", quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    w.writerow([
        "Date", "Type", "Description", "Category", "Amount", "Currency", "VAT %", "Payment"
    ])
    for s in sales:
        vat = "0" if getattr(s, "is_tax_exempt", False) else "25"
        w.writerow([
            s.date.isoformat() if hasattr(s.date, "isoformat") else str(s.date),
            "Sale",
            (s.description or "Sale")[:120],
            "",
            _money_dot(s.amount),
            cur,
            vat,
            (getattr(s, "payment_method", None) or "").capitalize(),
        ])
    for e in expenses:
        vat = "0" if getattr(e, "is_tax_exempt", False) else "25"
        cat_name = cats.get(str(e.category_id), "Other")
        w.writerow([
            e.date.isoformat() if hasattr(e.date, "isoformat") else str(e.date),
            "Expense",
            (e.description or cat_name)[:120],
            cat_name,
            _money_dot(e.amount),
            cur,
            vat,
            (getattr(e, "payment_method", None) or "").capitalize(),
        ])

    return buf.getvalue().encode("utf-8-sig")


# ───────── Format registry ─────────


FORMATS = {
    "dinero": {
        "label": "Dinero",
        "ext": "csv",
        "mime": "text/csv",
        "exporter": export_dinero,
        "instructions": (
            "Open Dinero → Bogføring → Importér → CSV. "
            "Map: Dato, Bilag, Beskrivelse, Beløb, Moms, Konto. "
            "BonBox sets sales account 1010 and expenses 2750 by default — "
            "re-categorise inside Dinero as needed."
        ),
    },
    "billy": {
        "label": "Billy",
        "ext": "csv",
        "mime": "text/csv",
        "exporter": export_billy,
        "instructions": (
            "Open Billy → Bogføring → Importér. The file is split into "
            "SALES and EXPENSES sections — import each section separately "
            "if Billy expects clean files. Currency, payment method and "
            "VAT % are pre-filled."
        ),
    },
    "economic": {
        "label": "e-conomic",
        "ext": "csv",
        "mime": "text/csv",
        "exporter": export_economic,
        "instructions": (
            "Open e-conomic → Daglig bogføring → Indlæs kassekladde "
            "(CSV). Account 1010 is pre-set for sales (U25 / U0), 2750 "
            "for expenses (I25 / I0). Re-map account codes on import "
            "if your chart of accounts differs."
        ),
    },
    "generic": {
        "label": "Generic CSV (any accountant)",
        "ext": "csv",
        "mime": "text/csv",
        "exporter": export_generic,
        "instructions": (
            "Universal columns: Date, Type, Description, Category, Amount, "
            "Currency, VAT %, Payment. Any accountant can re-format this."
        ),
    },
}
