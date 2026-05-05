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
import logging
from datetime import date
from typing import Iterable

from sqlalchemy.orm import Session

from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.user import User

log = logging.getLogger("bonbox.bookkeeping_export")


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
    """Inner-layer query — wraps in try so the exporter can decide what to do."""
    try:
        return (
            db.query(Sale)
            .filter(
                Sale.user_id == user.id,
                Sale.date >= start,
                Sale.date <= end,
                Sale.is_deleted.isnot(True),
                Sale.status != "returned",
            )
            .order_by(Sale.date.asc())
            .all()
        )
    except Exception as e:
        # If the status column doesn't exist yet on a stale DB, fall back to the
        # is_deleted-only filter rather than 503'ing the export.
        log.warning("bookkeeping_export: sales query with status filter failed (%s); retrying without status", e)
        try:
            return (
                db.query(Sale)
                .filter(
                    Sale.user_id == user.id,
                    Sale.date >= start,
                    Sale.date <= end,
                    Sale.is_deleted.isnot(True),
                )
                .order_by(Sale.date.asc())
                .all()
            )
        except Exception as e2:
            log.exception("bookkeeping_export: sales fallback query also failed: %s", e2)
            return []


def _query_expenses(user: User, db: Session, start: date, end: date) -> list[Expense]:
    """Inner-layer query — graceful fallback for missing is_personal column."""
    try:
        return (
            db.query(Expense)
            .filter(
                Expense.user_id == user.id,
                Expense.date >= start,
                Expense.date <= end,
                Expense.is_deleted.isnot(True),
                Expense.is_personal == False,  # noqa: E712
            )
            .order_by(Expense.date.asc())
            .all()
        )
    except Exception as e:
        log.warning("bookkeeping_export: expense query with is_personal filter failed (%s); retrying without", e)
        try:
            return (
                db.query(Expense)
                .filter(
                    Expense.user_id == user.id,
                    Expense.date >= start,
                    Expense.date <= end,
                    Expense.is_deleted.isnot(True),
                )
                .order_by(Expense.date.asc())
                .all()
            )
        except Exception as e2:
            log.exception("bookkeeping_export: expense fallback query also failed: %s", e2)
            return []


def _category_lookup(user: User, db: Session) -> dict:
    try:
        rows = db.query(ExpenseCategory).filter(ExpenseCategory.user_id == user.id).all()
        return {str(r.id): r.name for r in rows}
    except Exception as e:
        log.warning("bookkeeping_export: category lookup failed: %s", e)
        return {}


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

    fallback = 1
    for s in sales:
        moms = "0%" if getattr(s, "is_tax_exempt", False) else "25%"
        # Use persisted bilagsnummer when available (Bogføringsloven 2024
        # compliant); fall back to export-time counter for legacy rows.
        vn = getattr(s, "voucher_number", None)
        bilag = f"S-{s.date.year}-{vn:04d}" if vn else f"S{fallback:04d}"
        sale_text = getattr(s, "item_name", None) or getattr(s, "notes", None) or "Salg"
        desc = sale_text + (
            f" (ref: {s.reference_id})" if getattr(s, "reference_id", None) else ""
        )
        w.writerow([
            s.date.isoformat() if hasattr(s.date, "isoformat") else str(s.date),
            bilag,
            desc[:80],
            _money(s.amount),
            moms,
            "1010",
        ])
        fallback += 1

    fallback = 1
    for e in expenses:
        moms = "0%" if getattr(e, "is_tax_exempt", False) else "25%"
        cat_name = cats.get(str(e.category_id), "Other")
        desc = f"{cat_name}: {e.description}" if e.description else cat_name
        vn = getattr(e, "voucher_number", None)
        bilag = f"E-{e.date.year}-{vn:04d}" if vn else f"E{fallback:04d}"
        w.writerow([
            e.date.isoformat() if hasattr(e.date, "isoformat") else str(e.date),
            bilag,
            desc[:80],
            _money(-float(e.amount)),
            moms,
            "2750",
        ])
        fallback += 1

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
    w.writerow(["Bilagsnummer", "Date", "Description", "Amount", "Currency", "VAT %", "Payment"])
    for s in sales:
        vat = "0" if getattr(s, "is_tax_exempt", False) else "25"
        desc = getattr(s, "item_name", None) or getattr(s, "notes", None) or "Sale"
        vn = getattr(s, "voucher_number", None)
        bilag = f"S-{s.date.year}-{vn:04d}" if vn else ""
        w.writerow([
            bilag,
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
    w.writerow(["Bilagsnummer", "Date", "Category", "Description", "Amount", "Currency", "VAT %"])
    for e in expenses:
        vat = "0" if getattr(e, "is_tax_exempt", False) else "25"
        cat_name = cats.get(str(e.category_id), "Other")
        vn = getattr(e, "voucher_number", None)
        bilag = f"E-{e.date.year}-{vn:04d}" if vn else ""
        w.writerow([
            bilag,
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

    fallback = 1
    for s in sales:
        vat = "U0" if getattr(s, "is_tax_exempt", False) else "U25"
        desc = getattr(s, "item_name", None) or getattr(s, "notes", None) or "Salg"
        vn = getattr(s, "voucher_number", None)
        bilag = f"S-{s.date.year}-{vn:04d}" if vn else f"S{fallback:05d}"
        w.writerow([
            bilag,
            s.date.isoformat() if hasattr(s.date, "isoformat") else str(s.date),
            desc[:80],
            "1010",
            _money_dot(s.amount),
            cur,
            vat,
        ])
        fallback += 1

    fallback = 1
    for e in expenses:
        vat = "I0" if getattr(e, "is_tax_exempt", False) else "I25"
        cat_name = cats.get(str(e.category_id), "Other")
        desc = f"{cat_name}: {e.description}" if e.description else cat_name
        vn = getattr(e, "voucher_number", None)
        bilag = f"E-{e.date.year}-{vn:04d}" if vn else f"E{fallback:05d}"
        w.writerow([
            bilag,
            e.date.isoformat() if hasattr(e.date, "isoformat") else str(e.date),
            desc[:80],
            "2750",
            f"-{_money_dot(e.amount)}",
            cur,
            vat,
        ])
        fallback += 1

    return buf.getvalue().encode("utf-8-sig")


# ───────── Generic / Universal CSV ─────────


def export_generic(user: User, db: Session, start: date, end: date) -> bytes:
    """
    Universal CSV that any accountant can re-format. Single sheet with
    type column so users don't need to deal with two files.

    Columns: Date, Type, Description, Category, Amount, Currency, VAT %, Payment

    VAT % is derived from the user's currency (DK 25%, GBP 20%, NPR 13%, etc.)
    so non-DK users get the correct number on their export. Dinero/Billy/
    e-conomic exports stay at 25% because those are DK-only platforms.
    """
    sales = _query_sales(user, db, start, end)
    expenses = _query_expenses(user, db, start, end)
    cats = _category_lookup(user, db)
    cur = user.currency or "DKK"

    # Derive default VAT % string from the user's currency. Tax-exempt rows
    # still override with "0".
    try:
        from app.services.tax_service import _get_vat_rate
        default_vat_pct = int(round(_get_vat_rate(cur) * 100))
    except Exception:  # noqa: BLE001
        default_vat_pct = 25  # safe DK fallback if tax service load fails
    default_vat_str = str(default_vat_pct)

    buf = io.StringIO()
    w = csv.writer(buf, delimiter=",", quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    w.writerow([
        "Bilagsnummer", "Date", "Type", "Description", "Category",
        "Amount", "Currency", "VAT %", "Payment",
    ])
    for s in sales:
        vat = "0" if getattr(s, "is_tax_exempt", False) else default_vat_str
        sale_text = getattr(s, "item_name", None) or getattr(s, "notes", None) or "Sale"
        vn = getattr(s, "voucher_number", None)
        bilag = f"S-{s.date.year}-{vn:04d}" if vn else ""
        w.writerow([
            bilag,
            s.date.isoformat() if hasattr(s.date, "isoformat") else str(s.date),
            "Sale",
            sale_text[:120],
            "",
            _money_dot(s.amount),
            cur,
            vat,
            (getattr(s, "payment_method", None) or "").capitalize(),
        ])
    for e in expenses:
        vat = "0" if getattr(e, "is_tax_exempt", False) else default_vat_str
        cat_name = cats.get(str(e.category_id), "Other")
        vn = getattr(e, "voucher_number", None)
        bilag = f"E-{e.date.year}-{vn:04d}" if vn else ""
        w.writerow([
            bilag,
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
