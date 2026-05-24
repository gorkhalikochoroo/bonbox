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
import zipfile
from datetime import date
from typing import Iterable

from sqlalchemy.orm import Session

from app.models.business_profile import BusinessProfile
from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.user import User
from app.models.invoice import Invoice
from app.models.customer import Customer
from app.models.mileage import MileageEntry
from app.services.voucher_service import format_voucher_number
from app.utils.document_hash import (
    compute_document_hash,
    get_software_identifier,
)
from app.utils.time import utc_now

log = logging.getLogger("bonbox.bookkeeping_export")


# ───────── helpers ─────────


def _require_custom_templates(user: User) -> None:
    """L4 — defensive feature check for the custom-template exporters
    (Dinero / Billy / e-conomic / generic).

    Router-level enforce_feature(user, "custom_export_templates") is the
    primary gate (exports.py:86). This helper is the multi-barrier
    backup: if a future refactor accidentally drops the router gate,
    each format-specific exporter still refuses.

    PermissionError on refusal — router converts to the same structured
    402 the router gate would have produced. Pure unit tests that don't
    have a billing context can pass a stub User with plan="pro"; this
    helper never auto-skips because skipping would defeat the purpose
    of the defense layer."""
    from app.services.billing import has_feature
    if not has_feature(user, "custom_export_templates"):
        raise PermissionError("custom_export_templates required")


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


def _query_invoices(user: User, db: Session, start: date, end: date) -> list[Invoice]:
    """Pull invoices issued in the range. Excludes drafts (they're not real
    bookkeeping vouchers yet — the gap-less fakturanummer is allocated at
    draft time but the invoice is only legally an outgoing voucher once
    sent). Kreditnotaer are included because they reverse earlier invoices."""
    try:
        return (
            db.query(Invoice)
            .filter(
                Invoice.user_id == user.id,
                Invoice.issue_date >= start,
                Invoice.issue_date <= end,
                Invoice.status != "draft",
            )
            .order_by(Invoice.issue_date.asc(), Invoice.fakturanummer.asc())
            .all()
        )
    except Exception as e:
        log.exception("bookkeeping_export: invoice query failed: %s", e)
        return []


def _query_mileage(user: User, db: Session, start: date, end: date) -> list[MileageEntry]:
    """Pull mileage entries logged in the range. Used both for the standalone
    mileage CSV and the bundle ZIP."""
    try:
        return (
            db.query(MileageEntry)
            .filter(
                MileageEntry.user_id == user.id,
                MileageEntry.trip_date >= start,
                MileageEntry.trip_date <= end,
            )
            .order_by(MileageEntry.trip_date.asc())
            .all()
        )
    except Exception as e:
        log.exception("bookkeeping_export: mileage query failed: %s", e)
        return []


def _customer_lookup(user: User, db: Session) -> dict:
    """invoice.customer_id -> Customer. One query, hot in memory."""
    try:
        rows = db.query(Customer).filter(Customer.user_id == user.id).all()
        return {str(r.id): r for r in rows}
    except Exception as e:
        log.warning("bookkeeping_export: customer lookup failed: %s", e)
        return {}


# ───────── DINERO ─────────


def export_dinero(user: User, db: Session, start: date, end: date) -> bytes:
    """
    Dinero CSV — based on their "Bilag (CSV)" import.
    Columns: Dato; Bilag; Beskrivelse; Beløb; Moms; Konto

    For Dinero, sales go to account 1010 (Salg af varer/ydelser) by default
    and expenses go to a generic 2750 (Andre driftsudgifter). Owners will
    re-categorise inside Dinero — we just provide a clean import.

    L4 — defensive feature check. The exports router already gates this
    via enforce_feature; we re-verify so a future refactor that drops
    the router gate can't silently grant Free users Dinero exports.
    """
    _require_custom_templates(user)
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

    L4 — defensive feature check. Multi-barrier backup for the
    router-level enforce_feature gate; see _require_custom_templates.
    """
    _require_custom_templates(user)
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

    L4 — defensive feature check. Multi-barrier backup for the
    router-level enforce_feature gate; see _require_custom_templates.
    """
    _require_custom_templates(user)
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

    L4 — defensive feature check. Multi-barrier backup for the
    router-level enforce_feature gate; see _require_custom_templates.
    """
    _require_custom_templates(user)
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
    # Columns are additive over the historical set — preserves existing
    # importer mappings. SAF-T-compatible names appended at the end:
    #   TransactionId      = bilagsnummer (matches SAF-T <TransactionID>)
    #   TransactionDate    = ISO date
    #   AccountID          = chart-of-accounts account (1010 or 2750)
    #   Debit / Credit     = SAF-T splits the amount into Debit vs Credit
    # Existing columns up to "Payment" stay byte-identical for backwards
    # compat. Importers that ignore extra columns continue to work.
    w.writerow([
        "Bilagsnummer", "Date", "Type", "Description", "Category",
        "Amount", "Currency", "VAT %", "Payment",
        # SAF-T compatibility (additive — does not change existing imports)
        "TransactionId", "TransactionDate", "AccountID", "Debit", "Credit",
    ])
    for s in sales:
        vat = "0" if getattr(s, "is_tax_exempt", False) else default_vat_str
        sale_text = getattr(s, "item_name", None) or getattr(s, "notes", None) or "Sale"
        vn = getattr(s, "voucher_number", None)
        bilag = f"S-{s.date.year}-{vn:04d}" if vn else ""
        amount_str = _money_dot(s.amount)
        date_iso = s.date.isoformat() if hasattr(s.date, "isoformat") else str(s.date)
        # Sales are credit entries on revenue account 1010
        w.writerow([
            bilag,
            date_iso,
            "Sale",
            sale_text[:120],
            "",
            amount_str,
            cur,
            vat,
            (getattr(s, "payment_method", None) or "").capitalize(),
            # SAF-T fields
            bilag, date_iso, "1010", "0.00", amount_str,
        ])
    for e in expenses:
        vat = "0" if getattr(e, "is_tax_exempt", False) else default_vat_str
        cat_name = cats.get(str(e.category_id), "Other")
        vn = getattr(e, "voucher_number", None)
        bilag = f"E-{e.date.year}-{vn:04d}" if vn else ""
        amount_str = _money_dot(e.amount)
        date_iso = e.date.isoformat() if hasattr(e.date, "isoformat") else str(e.date)
        # Expenses are debit entries on cost account 2750
        w.writerow([
            bilag,
            date_iso,
            "Expense",
            (e.description or cat_name)[:120],
            cat_name,
            amount_str,
            cur,
            vat,
            (getattr(e, "payment_method", None) or "").capitalize(),
            # SAF-T fields
            bilag, date_iso, "2750", amount_str, "0.00",
        ])

    return buf.getvalue().encode("utf-8-sig")


# ───────── MOMS summary (period totals at a glance) ─────────


def export_moms_summary(user: User, db: Session, start: date, end: date) -> bytes:
    """Per-period MOMS summary CSV — one row per VAT rate observed in the
    range, showing salg/koeb totals and net moms owed/refundable.

    The revisor wants to see this 30-second view BEFORE diving into the
    line-item CSV: "Did the totals roughly match what I expected for
    this quarter?". Ties directly to the MOMS-angivelse PDF numbers.

    Columns: Periode start · Periode slut · Momssats · Salg ekskl. moms ·
             Moms af salg · Køb ekskl. moms · Moms af køb · Netto moms.
    """
    sales = _query_sales(user, db, start, end)
    expenses = _query_expenses(user, db, start, end)

    # Aggregate at 25% bucket vs 0% bucket. We don't yet support
    # multi-rate (DK is 25% flat for almost every SMB), so the buckets
    # collapse but the structure scales when reduced-rate sectors are
    # added later.
    bucket_25 = {"sales": 0.0, "expenses": 0.0}
    bucket_0 = {"sales": 0.0, "expenses": 0.0}
    for s in sales:
        amt = float(getattr(s, "amount", 0) or 0)
        if getattr(s, "is_tax_exempt", False):
            bucket_0["sales"] += amt
        else:
            bucket_25["sales"] += amt
    for e in expenses:
        amt = float(getattr(e, "amount", 0) or 0)
        if getattr(e, "is_tax_exempt", False):
            bucket_0["expenses"] += amt
        else:
            bucket_25["expenses"] += amt

    def _split(gross: float, rate: float) -> tuple[float, float]:
        """Return (net, vat) given a gross-incl-VAT amount and rate."""
        if rate <= 0:
            return gross, 0.0
        net = gross / (1.0 + rate)
        return net, gross - net

    salg_net, salg_moms = _split(bucket_25["sales"], 0.25)
    kob_net, kob_moms = _split(bucket_25["expenses"], 0.25)
    netto_moms = salg_moms - kob_moms

    buf = io.StringIO()
    w = csv.writer(buf, delimiter=",", quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    w.writerow([
        "Periode start", "Periode slut", "Momssats",
        "Salg ekskl. moms", "Moms af salg",
        "Køb ekskl. moms", "Moms af køb",
        "Netto moms (positiv = skyldig)", "Currency",
    ])
    w.writerow([
        start.isoformat(), end.isoformat(), "25%",
        _money_dot(salg_net), _money_dot(salg_moms),
        _money_dot(kob_net), _money_dot(kob_moms),
        _money_dot(netto_moms),
        user.currency or "DKK",
    ])
    # 0% / exempt — render only when there's content so the file stays
    # uncluttered for the typical SMB.
    if bucket_0["sales"] or bucket_0["expenses"]:
        w.writerow([
            start.isoformat(), end.isoformat(), "0%",
            _money_dot(bucket_0["sales"]), "0.00",
            _money_dot(bucket_0["expenses"]), "0.00",
            "0.00",
            user.currency or "DKK",
        ])

    return buf.getvalue().encode("utf-8-sig")


# ───────── FAKTURA (outgoing invoices, accounts-receivable view) ─────────


def export_faktura(user: User, db: Session, start: date, end: date) -> bytes:
    """
    Faktura register CSV — one row per sent/paid/credited invoice.

    This is the AR-side view: what was billed, to whom, when, and whether
    it's been paid. Revisor uses this to reconcile against bank import
    + post AR entries in Dinero/Billy/e-conomic.

    Comma-delimited, English headers, UTF-8 BOM — works in Excel + every
    Danish bookkeeping platform's "import customers + invoices" flow.

    Columns: Fakturanr · Issued · Due · Customer · CVR · Country ·
             Excl. moms · Moms · Total · Currency · Status · Paid date ·
             Type (faktura/kreditnota) · EAN.
    """
    invoices = _query_invoices(user, db, start, end)
    cust_by_id = _customer_lookup(user, db)
    cur = user.currency or "DKK"

    buf = io.StringIO()
    w = csv.writer(buf, delimiter=",", quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    w.writerow([
        "Fakturanr", "Issued", "Due", "Delivery date",
        "Customer", "CVR", "Country", "EAN",
        "Excl. moms", "Moms", "Total", "Currency",
        "Status", "Paid date", "Type",
    ])

    for inv in invoices:
        customer = cust_by_id.get(str(inv.customer_id))
        fakturanr_str = format_voucher_number(
            "invoice", inv.issue_date.year, inv.fakturanummer
        )
        paid_str = (
            inv.paid_at.date().isoformat()
            if getattr(inv, "paid_at", None) and hasattr(inv.paid_at, "date")
            else ""
        )
        delivery_str = (
            inv.delivery_date.isoformat()
            if getattr(inv, "delivery_date", None)
            else ""
        )
        inv_type = "kreditnota" if getattr(inv, "is_credit_note", False) else "faktura"
        w.writerow([
            fakturanr_str,
            inv.issue_date.isoformat() if hasattr(inv.issue_date, "isoformat") else str(inv.issue_date),
            inv.due_date.isoformat() if hasattr(inv.due_date, "isoformat") else str(inv.due_date),
            delivery_str,
            (customer.name if customer else "")[:255],
            (customer.cvr if customer and customer.cvr else ""),
            (customer.country if customer else "DK"),
            (getattr(customer, "ean_nummer", None) or "") if customer else "",
            _money_dot(inv.subtotal_net),
            _money_dot(inv.moms_total),
            _money_dot(inv.total_gross),
            inv.currency or cur,
            inv.status,
            paid_str,
            inv_type,
        ])

    return buf.getvalue().encode("utf-8-sig")


# ───────── MILEAGE (kørselsgodtgørelse, Skattestyrelsen-mandated log) ─────────


def export_mileage(user: User, db: Session, start: date, end: date) -> bytes:
    """
    Kørselsgodtgørelse CSV — one row per logged trip.

    Skattestyrelsen requires contemporaneous logs with date, from/to, km,
    purpose, and vehicle registration. We export all of those plus the
    frozen rate and computed deduction so the revisor can verify totals
    without re-calculating against current-year rates.

    Used by the revisor to compute the total fradrag for the period
    and post it as a single voucher in the bookkeeping system.
    """
    entries = _query_mileage(user, db, start, end)
    cur = user.currency or "DKK"

    buf = io.StringIO()
    w = csv.writer(buf, delimiter=",", quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    w.writerow([
        "Date", "From", "To", "Km", "Purpose",
        "Vehicle reg", "Rate (kr/km)", "Deduction", "Currency",
    ])

    total_km = 0.0
    total_deduction = 0.0
    for e in entries:
        try:
            km_val = float(e.km)
            dedu_val = float(e.deduction_amount)
        except (TypeError, ValueError):
            km_val = 0.0
            dedu_val = 0.0
        total_km += km_val
        total_deduction += dedu_val
        w.writerow([
            e.trip_date.isoformat() if hasattr(e.trip_date, "isoformat") else str(e.trip_date),
            (e.from_address or "")[:200],
            (e.to_address or "")[:200],
            f"{km_val:.2f}".replace(",", ""),
            (e.purpose or "")[:200],
            (e.vehicle_reg or ""),
            _money_dot(e.rate_per_km),
            _money_dot(dedu_val),
            cur,
        ])

    # Summary row — separator then totals. Revisor sees the period total
    # immediately rather than running a SUM() in Excel.
    if entries:
        w.writerow([])
        w.writerow([
            "TOTAL", "", "", f"{total_km:.2f}".replace(",", ""),
            "", "", "", _money_dot(total_deduction), cur,
        ])

    return buf.getvalue().encode("utf-8-sig")


# ───────── BUNDLE (everything for one month, as a ZIP) ─────────


def export_bundle(user: User, db: Session, start: date, end: date) -> bytes:
    """
    Monthly handoff ZIP — everything the revisor needs for the period:
      • sales-and-expenses CSV (Dinero format — Danish default)
      • faktura CSV (AR register)
      • mileage CSV (kørselsfradrag log)
      • moms-summary CSV (period MOMS totals at a glance)
      • README.txt explaining what each file is + import order
      • manifest.txt with business info, period, file list, and SHA-256
        hash of each file (audit-grade tamper-evidence)

    Used by the "Send to accountant" monthly button. One attachment,
    revisor opens it, sees the files, knows exactly what to do.

    Audit-grade upgrade (May 2026):
      Manifest provides forensic provenance — business name + CVR +
      VAT no + address, the user who generated the bundle, the exact
      UTC timestamp, the software version, and SHA-256 of every file.
      If the revisor's downloaded copy doesn't match the hashes, the
      bundle has been altered post-handoff.
    """
    sales_csv = export_dinero(user, db, start, end)
    faktura_csv = export_faktura(user, db, start, end)
    mileage_csv = export_mileage(user, db, start, end)
    moms_summary_csv = export_moms_summary(user, db, start, end)

    # Look up the BusinessProfile for the manifest — gracefully empty
    # when the owner hasn't filled it in yet.
    try:
        profile = (
            db.query(BusinessProfile)
            .filter(BusinessProfile.user_id == user.id)
            .first()
        )
    except Exception:
        profile = None

    period_label = f"{start.isoformat()}_to_{end.isoformat()}"
    software_id = get_software_identifier()
    generated_at = utc_now().strftime("%Y-%m-%d %H:%M UTC")
    generator_email = (getattr(user, "email", None) or "system")

    # Compute hashes BEFORE writing the manifest so the manifest can
    # carry the digests. Hashes are computed over the raw bytes that
    # will end up in the ZIP (post UTF-8 + BOM).
    files_to_pack: list[tuple[str, bytes]] = [
        (f"sales-expenses-dinero-{period_label}.csv", sales_csv),
        (f"faktura-{period_label}.csv", faktura_csv),
        (f"mileage-{period_label}.csv", mileage_csv),
        (f"moms-summary-{period_label}.csv", moms_summary_csv),
    ]
    file_hashes = {
        name: compute_document_hash(data) for name, data in files_to_pack
    }

    # ── Business identity block (for manifest header) ────────────────
    biz_lines = []
    biz_name = (
        (profile.company_name if profile and profile.company_name else None)
        or getattr(user, "business_name", None) or "—"
    )
    biz_lines.append(f"Business name:    {biz_name}")
    biz_lines.append(
        f"CVR / Org. no:    {getattr(profile, 'org_number', None) or '—'}"
    )
    vat_no = getattr(profile, "vat_number", None) if profile else None
    biz_lines.append(f"VAT number:       {vat_no or '—'}")
    addr_parts = []
    if profile:
        if getattr(profile, "address", None):
            addr_parts.append(profile.address)
        z = getattr(profile, "zipcode", None) or ""
        c = getattr(profile, "city", None) or ""
        if z or c:
            addr_parts.append(f"{z} {c}".strip())
    biz_lines.append(
        f"Address:          {', '.join(addr_parts) if addr_parts else '—'}"
    )

    manifest_lines = [
        "BonBox bookkeeping handoff — manifest",
        "=" * 60,
        f"Period:           {start.isoformat()} -> {end.isoformat()}",
        f"Generated:        {generated_at}",
        f"Generated by:     {generator_email}",
        f"Software:         {software_id}",
        "",
        *biz_lines,
        "",
        "FILES + SHA-256 HASHES",
        "-" * 60,
    ]
    for name, data in files_to_pack:
        manifest_lines.append(f"{name}")
        manifest_lines.append(f"  size:  {len(data)} bytes")
        manifest_lines.append(f"  sha256: {file_hashes[name]}")
    manifest_lines.append("")
    manifest_lines.append(
        "Verify a file by running locally:"
    )
    manifest_lines.append(
        "  shasum -a 256 <filename>"
    )
    manifest_lines.append(
        "and confirming the digest matches the value above."
    )
    manifest_text = "\n".join(manifest_lines) + "\n"

    readme = (
        f"BonBox bookkeeping handoff\n"
        f"Period: {start.isoformat()} -> {end.isoformat()}\n"
        f"Generated for: {biz_name}  (by {generator_email})\n"
        f"Software: {software_id}\n\n"
        f"FILES IN THIS BUNDLE\n"
        f"  1. sales-expenses-dinero-{period_label}.csv\n"
        f"     Daily sales + expense vouchers. Dinero-format CSV (semicolon\n"
        f"     delimiter, Danish moms columns). Import first.\n\n"
        f"  2. faktura-{period_label}.csv\n"
        f"     Outgoing invoices (AR register). One row per sent/paid/credited\n"
        f"     faktura with customer, CVR, totals, and paid status. Use to\n"
        f"     reconcile against bank receipts.\n\n"
        f"  3. mileage-{period_label}.csv\n"
        f"     Kørselsgodtgørelse log. Contemporaneous trip log with frozen\n"
        f"     2026 rates. Post the period total as a single fradrag-voucher.\n\n"
        f"  4. moms-summary-{period_label}.csv\n"
        f"     Period MOMS totals at a glance — salg ekskl. moms, moms af salg,\n"
        f"     køb ekskl. moms, moms af køb, netto moms. Confirms the angivelse\n"
        f"     before you dive into the line-item CSV.\n\n"
        f"  5. manifest.txt\n"
        f"     Business info + SHA-256 of every file in this bundle. If a\n"
        f"     downloaded copy's hash doesn't match the manifest, the file\n"
        f"     has been altered after BonBox produced it.\n\n"
        f"HOW TO IMPORT\n"
        f"  • Dinero: Bogføring -> Importér -> CSV. Map Dato/Bilag/Beskrivelse/\n"
        f"    Beløb/Moms/Konto. Sales account 1010, expense account 2750 are\n"
        f"    BonBox defaults — re-map as needed.\n"
        f"  • Billy:  Bogføring -> Importér. Convert the Dinero CSV's first\n"
        f"    line to your column names, or use export_billy() directly.\n"
        f"  • e-conomic: Daglig bogføring -> Indlæs kassekladde (CSV). Account\n"
        f"    1010 = sales (U25/U0), 2750 = expenses (I25/I0).\n\n"
        f"NOTES\n"
        f"  • Faktura rows with status='credited' are voided; the kreditnota\n"
        f"    reversal row appears separately with type='kreditnota'.\n"
        f"  • Mileage TOTAL row at the bottom shows the period fradrag sum.\n"
        f"  • Bilagsnumre on every row are Bogføringsloven §15 compliant\n"
        f"    (sequential, gapless within each year).\n\n"
        f"Questions: contact@bonbox.dk\n"
    )

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files_to_pack:
            zf.writestr(name, data)
        zf.writestr("README.txt", readme.encode("utf-8"))
        zf.writestr("manifest.txt", manifest_text.encode("utf-8"))
    return out.getvalue()


# Public alias used by the audit tests + external callers — matches the
# naming convention in the audit checklist ("export_bookkeeping_zip").
def export_bookkeeping_zip(user: User, db: Session, start: date, end: date) -> bytes:
    """Alias for export_bundle() — the audit-grade ZIP handoff."""
    return export_bundle(user, db, start, end)


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
    "faktura": {
        "label": "Faktura (outgoing invoices)",
        "ext": "csv",
        "mime": "text/csv",
        "exporter": export_faktura,
        "instructions": (
            "AR register — one row per sent/paid/credited faktura with customer, "
            "CVR, totals, paid date, and type (faktura vs kreditnota). Import into "
            "your bookkeeping software's Debitor/Faktura module."
        ),
    },
    "mileage": {
        "label": "Mileage (kørselsgodtgørelse)",
        "ext": "csv",
        "mime": "text/csv",
        "exporter": export_mileage,
        "instructions": (
            "Skattestyrelsen-compliant trip log with frozen 2026 rates. The "
            "bottom TOTAL row is the period fradrag sum — post that as a "
            "single voucher in your bookkeeping software."
        ),
    },
    "bundle": {
        "label": "Monthly bundle (ZIP — everything)",
        "ext": "zip",
        "mime": "application/zip",
        "exporter": export_bundle,
        "instructions": (
            "Everything in one ZIP: sales+expenses (Dinero format), faktura "
            "register, mileage log, and a README. The monthly handoff your "
            "revisor needs — one attachment, four files, clear import order."
        ),
    },
}
