"""Revisorpakke — a period of the books, handed to the revisor in one go.

Most owners type the day's figures by hand, add the receipt photos later in a
batch, and send their revisor a weekly or monthly package. This module builds
that package for a period (week, month or a custom range) and is the one place
that decides what is in it:

  • Oversigt_<periode>.pdf  — a Danish summary: the open items first (days
    without a close, closes not locked, expenses without a bilag, bilag that
    could not be fetched, drafts, cash differences, §9 variances between the
    kasserapport and the till sales, unreconciled bank lines, gavekort checks
    in the momsangivelse's own words), the MOMS summary (straight from
    compute_filing_data — the same engine as the momsangivelse, never a
    second calculation), key figures, payment methods, expenses by category
    with their købsmoms (_calc_vat's own split), gift-card lines, cash
    differences and revenue per day;
  • CSV files, all Danish Excel (UTF-8 with BOM, semicolon, decimal comma,
    Danish headers): revenue per day, kasserapporter, salg (tied to the
    revenue to the øre), udgifter, fakturaer, the gift-card ledger, the MOMS
    summary and kørsel — the last four converted from bookkeeping_export;
  • bilag/ — every receipt file, named YYYY-MM-DD_leverandør_beløb (photos
    stored at 1600 px), with bilag-oversigt.csv mapping each file to its
    expense;
  • LAES-MIG.txt and manifest.txt (SHA-256 of every file).

Delivered as a ZIP download (every tier — accountant-grade artifacts are the
same at any tier) and, on plans with `accountant_month_end_bundle`, as an
e-mail to the saved revisor: the summary PDF attached, the ZIP behind a signed
link that works through the 14th day — numbered parts with a link each when a
package is over the link cap. The e-mail lists open items honestly — a
package is never dressed up as "ready" when it is not — and a package re-sent
after its figures changed says RETTELSE and what changed.

Demo data never leaves: a period holding sample rows under the owner's own
identity is refused, as for every other revisor artifact.
"""
from __future__ import annotations

import base64
import calendar
import csv
import hashlib
import hmac
import io
import json
import logging
import re
import tempfile
import time
import unicodedata
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.user import User
from app.services.bonbox_pdf_kit import compose_business_address, escape_pdf_text, money_dk
from app.services.expense_status import not_pending
from app.services.vendor_identity import canonical_vendor_key
from app.utils.csv_safe import csv_safe
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

PACKAGE_LINK_TTL_DAYS = 14
MAX_PERIOD_DAYS = 93
# One stored ZIP (one link) stays under this — Supabase's per-object ceiling
# is 50 MB. A sent package over it is split into numbered parts, one link
# each (MAX_PARTS); the owner's own download is always one ZIP.
MAX_LINK_ZIP_BYTES = 45 * 1024 * 1024

SEND_ACTION = "revisor_package.sent"
SKIP_ACTION = "revisor_package.skipped"
FAIL_ACTION = "revisor_package.failed"
DOWNLOAD_ACTION = "revisor_package.downloaded"
SCHEDULE_ACTION = "revisor_package.schedule_changed"

SCHEDULES = ("weekly", "monthly")

_DA_MONTHS = ["januar", "februar", "marts", "april", "maj", "juni", "juli",
              "august", "september", "oktober", "november", "december"]
_DA_MONTHS_SHORT = ["jan.", "feb.", "mar.", "apr.", "maj", "jun.", "jul.", "aug.",
                    "sep.", "okt.", "nov.", "dec."]
_DA_DAYS = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"]


# ─── Periods ─────────────────────────────────────────────────────────────

def month_bounds(year: int, month: int) -> tuple[date, date]:
    return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])


def week_bounds(d: date) -> tuple[date, date]:
    monday = d - timedelta(days=d.weekday())
    return monday, monday + timedelta(days=6)


def previous_month(today: date) -> tuple[date, date]:
    last = today.replace(day=1) - timedelta(days=1)
    return month_bounds(last.year, last.month)


def previous_week(today: date) -> tuple[date, date]:
    monday, _ = week_bounds(today)
    return monday - timedelta(days=7), monday - timedelta(days=1)


def period_kind_of(start: date, end: date) -> str:
    if start.day == 1 and end == month_bounds(start.year, start.month)[1]:
        return "month"
    if start.weekday() == 0 and end == start + timedelta(days=6):
        return "week"
    return "custom"


def validate_period(start: date, end: date) -> None:
    if start is None or end is None or start > end:
        raise ValueError("period_invalid")
    if (end - start).days + 1 > MAX_PERIOD_DAYS:
        raise ValueError("period_too_long")


def dk_date(d: date) -> str:
    return f"{d.day}. {_DA_MONTHS[d.month - 1]} {d.year}"


def dk_range(f: date, t: date) -> str:
    """'1.–31. oktober 2026' / '29. september–5. oktober 2026'."""
    if f == t:
        return dk_date(f)
    if f.year == t.year and f.month == t.month:
        return f"{f.day}.–{t.day}. {_DA_MONTHS[t.month - 1]} {t.year}"
    if f.year == t.year:
        return f"{f.day}. {_DA_MONTHS[f.month - 1]}–{t.day}. {_DA_MONTHS[t.month - 1]} {t.year}"
    return f"{dk_date(f)}–{dk_date(t)}"


def period_label(start: date, end: date, kind: str | None = None) -> str:
    """The period as a revisor reads it: 'oktober 2026', 'uge 41 (5.–11.
    oktober 2026)', or the range."""
    kind = kind or period_kind_of(start, end)
    if kind == "month":
        return f"{_DA_MONTHS[start.month - 1]} {start.year}"
    if kind == "week":
        return f"uge {start.isocalendar()[1]} ({dk_range(start, end)})"
    return dk_range(start, end)


def period_file_label(start: date, end: date, kind: str | None = None) -> str:
    """Sortable, file-name-safe: '2026-10', '2026-uge-41', '2026-10-01_til_2026-10-15'."""
    kind = kind or period_kind_of(start, end)
    if kind == "month":
        return f"{start.year}-{start.month:02d}"
    if kind == "week":
        y, w, _ = start.isocalendar()
        return f"{y}-uge-{w:02d}"
    return f"{start.isoformat()}_til_{end.isoformat()}"


def _short_dates(dates: list[date], limit: int = 8) -> str:
    """'3., 7. og 12. okt.' — a compact list for one line of the summary."""
    ds = sorted(dates)
    shown = ds[:limit]
    parts = [f"{d.day}. {_DA_MONTHS_SHORT[d.month - 1]}" for d in shown]
    text = ", ".join(parts[:-1]) + (" og " if len(parts) > 1 else "") + parts[-1] if parts else ""
    if len(ds) > limit:
        text += f" (+{len(ds) - limit} flere)"
    return text


def _kr(v) -> str:
    return money_dk(v, "DKK")


def _dk_num(v) -> str:
    """CSV money: '1234,50' (no thousands separator — Excel reads it)."""
    try:
        return f"{float(v):.2f}".replace(".", ",")
    except (TypeError, ValueError):
        return ""


# ─── The owner, the profile, the business day ───────────────────────────

def profile_of(db: Session, user: User) -> BusinessProfile | None:
    return db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()


def business_name(profile, user) -> str:
    """The legal company name, else the signup name — the one rule every
    revisor-facing artifact uses (routers/daily_close._business_display_name)."""
    return ((getattr(profile, "company_name", None) if profile else None)
            or getattr(user, "business_name", None) or "BonBox")


def business_today(db: Session, user: User, now: datetime | None = None) -> date:
    """The owner's current business date (cutoff-aware, default 06:00 local):
    at 02:00 the night being traded still belongs to yesterday."""
    from app.services.gavekort_moms import _tz_user, business_date_of
    return business_date_of(_tz_user(db, user), now or utc_now())


# ─── Bilag files ─────────────────────────────────────────────────────────

def _sniff_ext(data: bytes) -> str:
    if data[:4] == b"%PDF":
        return "pdf"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[4:8] == b"ftyp":
        return "heic"
    # A forwarded inbox bilag may be a GIF or a TIFF (inbox_service._EXT_BY_MIME).
    if data[:4] == b"GIF8":
        return "gif"
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    return "bin"


def load_bilag(user_id, photo: str | None, *, db: Session | None = None) -> tuple[bytes, str] | None:
    """The bytes of a stored bilag and their file extension, or None when the
    file cannot be read (gone from local disk, storage down, not this
    owner's). Never raises.

    Only the exact shapes services/receipt_ref accepts, and only this owner's
    storage keys, local files and inbox blobs (an inbox blob only when the
    mail intake recorded it for this owner — that needs `db`; without it an
    inbox blob is refused). Nothing is ever fetched from a URL's host: a
    signed URL is reduced to its storage key and read through our backend."""
    from app.services.receipt_ref import inbox_blob_owned, parse_receipt_ref
    parsed = parse_receipt_ref(photo, user_id)
    if not parsed:
        return None
    kind, value = parsed
    if kind == "inbox" and not inbox_blob_owned(db, user_id, value):
        return None
    data: bytes | None = None
    try:
        if kind == "inbox":
            from app.services.inbox_service import load_attachment_blob
            data = load_attachment_blob(value)
        elif kind == "storage":
            from app.services.storage import get_storage
            data = get_storage().get(value)
        else:
            root = (Path.cwd() / "uploads" / "receipts").resolve()
            target = (Path.cwd() / value).resolve()
            target.relative_to(root)  # ValueError outside uploads/receipts
            if target.is_file():
                data = target.read_bytes()
    except Exception as e:  # noqa: BLE001 — a missing file is reported, not raised
        logger.info("revisor package: bilag not readable (%s)", type(e).__name__)
        return None
    if not data:
        return None
    return data, _sniff_ext(data)


_ASCII = str.maketrans({"æ": "ae", "ø": "oe", "å": "aa", "Æ": "Ae", "Ø": "Oe", "Å": "Aa"})


def _slug(text: str | None, max_len: int = 40) -> str:
    """ASCII only: a ZIP is opened by every tool a revisor has, and some
    still mangle UTF-8 names ('H??rkram'). The supplier stays readable:
    Hørkram → Hoerkram."""
    s = str(text or "").translate(_ASCII)
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii").strip()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s[:max_len].strip("-") or "udgift"


def bilag_filename(d: date, vendor: str | None, amount, ext: str, used: set[str]) -> str:
    """'2026-10-03_Netto_129,95.jpg' — date, supplier, amount; a second file
    with the same three gets '_2'."""
    base = f"{d.isoformat()}_{_slug(vendor)}_{_dk_num(amount)}"
    name = f"{base}.{ext}"
    n = 2
    while name.lower() in used:
        name = f"{base}_{n}.{ext}"
        n += 1
    used.add(name.lower())
    return name


# ─── The period's data ───────────────────────────────────────────────────

def _is_confirmed(c) -> bool:
    return (getattr(c, "status", None) or "confirmed") == "confirmed"


def _is_demo_close(c) -> bool:
    return str(getattr(c, "notes", None) or "").endswith(" · demo")


def period_closes(db: Session, user: User, start: date, end: date) -> list[DailyClose]:
    """The period's closes (every branch). Sample (demo) days are left out —
    unless the business IS still the sample company: then every figure is the
    sample's, compute_filing_data counts them, and leaving them out printed
    0 kr. revenue beside the sample's salgsmoms. (Under the owner's own
    identity a period with sample rows gets no package at all — the router's
    demo fence.)"""
    rows = (
        db.query(DailyClose)
        .filter(DailyClose.user_id == user.id, DailyClose.is_deleted.isnot(True),
                DailyClose.date >= start, DailyClose.date <= end)
        .all()
    )
    # One order on every database and time zone: two branches closing the
    # same day came out in either order (SQLite vs Postgres), and the CSVs
    # of two builds of the same books differed (14 Oct review).
    rows.sort(key=lambda c: (c.date, str(c.branch_id or ""), str(c.id)))
    if is_sample_company(db, user):
        return rows
    return [c for c in rows if not _is_demo_close(c)]


def is_sample_company(db: Session, user: User) -> bool:
    from app.services.revisor_mail import is_demo_identity
    try:
        return bool(is_demo_identity(profile_of(db, user), user))
    except Exception:  # noqa: BLE001 — a package is never refused on this
        return False


def revenue_by_day(db: Session, user: User, start: date, end: date, closes) -> list[dict]:
    """One row per date: the locked kasserapporter of the day (every branch,
    summed) win; otherwise the day's completed sales that are not a faktura's
    payment (the faktura is its own stream) — the same precedence as the MOMS
    engine. A day with only a draft close says so: its figures are not
    counted."""
    locked: dict[date, float] = {}
    drafts: dict[date, int] = {}
    for c in closes:
        if _is_confirmed(c):
            locked[c.date] = locked.get(c.date, 0.0) + float(c.revenue_total or 0)
        else:
            drafts[c.date] = drafts.get(c.date, 0) + 1
    sales = dict(
        db.query(Sale.date, func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date >= start, Sale.date <= end,
                Sale.is_deleted.isnot(True), Sale.status == "completed",
                Sale.invoice_id.is_(None))
        .group_by(Sale.date)
        .all()
    )
    out = []
    d = start
    while d <= end:
        if d in locked:
            amount, source = round(locked[d], 2), "close"
        elif float(sales.get(d) or 0):
            amount, source = round(float(sales[d]), 2), "sales"
        else:
            amount, source = 0.0, "none"
        out.append({
            "date": d, "amount": amount, "source": source,
            "draft": d in drafts and d not in locked,
        })
        d += timedelta(days=1)
    return out


_PAY_LABELS = {
    "cash": "Kontant", "card": "Kort", "mobilepay": "MobilePay",
    "gift_card": "Gavekort", "bank_transfer": "Bankoverførsel", "other": "Øvrige",
}


def payment_methods(db: Session, user: User, start: date, end: date, closes) -> list[dict]:
    """Payment methods over the counted revenue: the locked kasserapporter'
    own split, plus the sales of days without one. Revenue that carries no
    split is shown as its own line — never spread over the methods."""
    from app.services.daily_close_range_export import period_totals
    confirmed = [c for c in closes if _is_confirmed(c)]
    totals = period_totals(confirmed)
    buckets = {k: float(totals.get(k) or 0) for k in _PAY_LABELS}
    close_dates = {c.date for c in confirmed}
    sale_rows = (
        db.query(Sale.payment_method, Sale.date, Sale.amount)
        .filter(Sale.user_id == user.id, Sale.date >= start, Sale.date <= end,
                Sale.is_deleted.isnot(True), Sale.status == "completed",
                Sale.invoice_id.is_(None))
        .all()
    )
    for method, d, amount in sale_rows:
        if d in close_dates:
            continue
        m = (method or "").lower()
        key = {"kontant": "cash", "kort": "card", "dankort": "card", "mixed": "other"}.get(m, m)
        if key not in buckets:
            key = "other"
        buckets[key] += float(amount or 0)
    return [
        {"method": k, "label": _PAY_LABELS[k], "amount": round(v, 2)}
        for k, v in buckets.items() if abs(v) >= 0.005
    ]


def expense_rows(db: Session, user: User, start: date, end: date) -> list[Expense]:
    """The booked business expenses of the period (drafts never: they are
    in no money total until approved)."""
    return (
        db.query(Expense)
        .filter(Expense.user_id == user.id, Expense.is_deleted.isnot(True),
                Expense.is_personal.isnot(True), not_pending(),
                Expense.date >= start, Expense.date <= end)
        .order_by(Expense.date.asc(), Expense.created_at.asc())
        .all()
    )


def _has_bilag(e: Expense) -> bool:
    return bool((e.receipt_photo or "").strip())


def is_foreign(e: Expense, account_ccy: str | None) -> bool:
    """A receipt in another currency than the account's: its VAT is foreign
    VAT, never Danish købsmoms (tax_service._calc_vat, the same rule)."""
    ccy = (getattr(e, "currency", None) or "").strip().upper()
    return bool(ccy) and ccy != (account_ccy or "DKK").strip().upper()


# Bankimport stores its built-in categories by their English names
# (BankImportPage sends the default names as-is and translates only the
# option text), so the owner's 'El, vand og varme' is saved as "Utilities".
# A revisor file is Danish only (Push 8 gate round 3): it prints the words
# the owner chose — the same Danish BankImportPage shows. Display only: the
# MOMS engine, the fradrag rule and a sent package's fingerprint keep the
# stored name. Any other name is the owner's own and prints as typed.
_BUILTIN_CATEGORY_DA = {
    "Other": "Andet", "Sales": "Salg", "Ingredients": "Råvarer", "Rent": "Husleje",
    "Wages": "Løn", "Utilities": "El, vand og varme", "Supplies": "Forbrugsvarer",
    "Transport": "Transport", "Insurance": "Forsikring", "Subscriptions": "Abonnementer",
    "Equipment": "Udstyr", "Marketing": "Markedsføring",
}
_FOREIGN_ROW_SUFFIX = " (udenlandsk valuta)"


def category_da(name: str | None) -> str:
    n = (name or "").strip()
    if n.endswith(_FOREIGN_ROW_SUFFIX):
        return category_da(n[: -len(_FOREIGN_ROW_SUFFIX)]) + _FOREIGN_ROW_SUFFIX
    return _BUILTIN_CATEGORY_DA.get(n, n)


# BonBox's own markers in an expense's text: the inbox appends "[from
# inbox]" to a forwarded bilag (and "[needs review]" to an unsure read, which
# approving removes). English system tags, never the owner's words: a
# revisor file leaves them out (Push 8 gate round 3).
_SYSTEM_TAG_RE = re.compile(r"\s*\[(?:from inbox|needs review)\]", re.IGNORECASE)


def revisor_text(text: str | None) -> str:
    return _SYSTEM_TAG_RE.sub("", text or "").strip()


def expenses_by_category(fd: dict, expenses: list[Expense], cat_names: dict,
                         account_ccy: str | None = "DKK") -> list[dict]:
    """Category table: the MOMS base rows from _calc_vat (gross, fradrag %,
    købsmoms — they sum to moms_af_kob), plus the expenses marked momsfri,
    which carry no købsmoms. A category's foreign-currency expenses are their
    own row at 0 % (the engine's "foreign" rows). Counts from the rows
    themselves."""
    from app.services.dk_fradrag import fradrag_reason
    counts: dict[tuple, int] = {}
    exempt: dict[str, float] = {}
    for e in expenses:
        name = cat_names.get(e.category_id, "") or ""
        key = (name, bool(not e.is_tax_exempt and is_foreign(e, account_ccy)))
        counts[key] = counts.get(key, 0) + 1
        if e.is_tax_exempt:
            exempt[name] = exempt.get(name, 0.0) + float(e.amount or 0)
    out = []
    seen = set()
    for r in fd.get("kob_pr_kategori") or []:
        name = r.get("category") or ""
        if r.get("foreign"):
            out.append({
                "category": (name or "Uden kategori") + " (udenlandsk valuta)",
                "count": counts.get((name, True), 0),
                "gross": round(float(r.get("gross") or 0), 2),
                "exempt": 0.0, "fradrag_pct": 0, "reason": "foreign", "input_vat": 0.0,
            })
            continue
        seen.add(name)
        out.append({
            "category": name or "Uden kategori",
            "count": counts.get((name, False), 0),
            "gross": round(float(r.get("gross") or 0) + exempt.get(name, 0.0), 2),
            "exempt": round(exempt.get(name, 0.0), 2),
            "fradrag_pct": r.get("fradrag_pct"),
            "reason": fradrag_reason(name),
            "input_vat": float(r.get("input_vat") or 0),
        })
    for name, amt in exempt.items():
        if name in seen:
            continue
        out.append({
            "category": name or "Uden kategori", "count": counts.get((name, False), 0),
            "gross": round(amt, 2), "exempt": round(amt, 2),
            "fradrag_pct": 0, "reason": fradrag_reason(name), "input_vat": 0.0,
        })
    out.sort(key=lambda r: (-r["gross"], r["category"]))
    return out


# ─── The month-end checklist ─────────────────────────────────────────────

def _open_days(profile) -> set[int] | None:
    mask = (getattr(profile, "open_days_mask", None) or "").strip() if profile else ""
    days = {int(ch) for ch in mask if ch in "1234567"}
    return days or None


def build_checklist(db: Session, user: User, start: date, end: date, *,
                    now: datetime | None = None, fd: dict | None = None,
                    closes: list | None = None, expenses: list | None = None,
                    unreadable: list | None = None) -> dict:
    """The open items of a period — what a revisor would ask about.

    Every item: {key, count, applicable, link, rows, …}. `applicable: False`
    means the owner does not use that part of BonBox (no daily closes, no bank
    import) — not "all good". `open_count` counts the items with something
    open. Each `link` is the screen where the item is fixed.

    `unreadable`: the expenses whose bilag the package build tried to read and
    could not (the definitive list). Without it (Månedsafslutning, the
    standalone summary PDF) only what is certain without downloading is
    counted — a reference that is not this owner's, a local or forwarded
    file that is gone — and `bilag_fetched` says the files were not read."""
    from app.services.kasserapport_claims import CASH_TOL
    if fd is None:
        from app.services.tax_filing_pdf import compute_filing_data
        fd = compute_filing_data(db, user, start, end)
    closes = closes if closes is not None else period_closes(db, user, start, end)
    expenses = expenses if expenses is not None else expense_rows(db, user, start, end)
    profile = profile_of(db, user)
    today = business_today(db, user, now)
    checked_until = min(end, today - timedelta(days=1))
    iso = lambda d: d.isoformat()  # noqa: E731
    items: list[dict] = []

    # 1. Days without a close. Only for an owner who closes the day in BonBox:
    # a close in the period, or at least three in the 60 days before it.
    close_dates = {c.date for c in closes}
    uses_closes = bool(closes) or (
        db.query(func.count(DailyClose.id))
        .filter(DailyClose.user_id == user.id, DailyClose.is_deleted.isnot(True),
                DailyClose.date >= start - timedelta(days=60), DailyClose.date < start)
        .scalar() or 0
    ) >= 3
    open_days = _open_days(profile)
    missing: list[date] = []
    if uses_closes:
        d = start
        while d <= checked_until:
            if d not in close_dates and (open_days is None or d.isoweekday() in open_days):
                missing.append(d)
            d += timedelta(days=1)
    items.append({
        "key": "closes_missing", "count": len(missing), "applicable": uses_closes,
        "open_days_configured": open_days is not None,
        "checked_until": iso(checked_until) if checked_until >= start else None,
        "rows": [{"date": iso(d)} for d in missing],
        "link": f"/daily-close?date={iso(missing[0])}" if missing else "/daily-close",
    })

    # 2. Closes not locked (drafts: their figures are counted nowhere).
    unlocked = [c for c in closes if not _is_confirmed(c)]
    items.append({
        "key": "closes_unlocked", "count": len(unlocked), "applicable": uses_closes,
        "rows": [{"date": iso(c.date), "id": str(c.id)} for c in unlocked],
        "link": f"/daily-close?date={iso(unlocked[0].date)}" if unlocked else "/daily-close",
    })

    # 3. Booked expenses without a bilag (the MOMS fradrag a revisor cannot
    # defend). Same rule as the Udgifter page: personal and momsfri rows
    # carry no fradrag and are not counted.
    no_bilag = [e for e in expenses if not _has_bilag(e) and not e.is_tax_exempt]
    items.append({
        "key": "bilag_missing", "count": len(no_bilag), "applicable": True,
        "amount": round(sum(float(e.amount or 0) for e in no_bilag), 2),
        "rows": [{"id": str(e.id), "date": iso(e.date), "description": revisor_text(e.description),
                  "amount": float(e.amount or 0)} for e in no_bilag],
        "link": f"/expenses?bilag=missing&from={iso(start)}&to={iso(end)}",
    })

    # 3b. Bilag referenced but not fetchable — a forwarded receipt whose file
    # is gone, a reference that is not this owner's, storage that failed.
    # The revisor does not get that file, so it is an open item: the package
    # never says "alle … har bilag" over a file it could not hand over.
    fetched = unreadable is not None
    bad = list(unreadable) if fetched else unreadable_without_download(db, user, expenses)
    items.append({
        "key": "bilag_unreadable", "count": len(bad), "applicable": True,
        "rows": [{"id": str(e.id), "date": iso(e.date), "description": revisor_text(e.description),
                  "amount": float(e.amount or 0)} for e in bad],
        "link": f"/expenses?from={iso(start)}&to={iso(end)}",
    })

    # 4. Drafts in the Godkend-kø dated in the period — not in the MOMS yet.
    drafts = (
        db.query(Expense)
        .filter(Expense.user_id == user.id, Expense.is_deleted.isnot(True),
                Expense.status == "pending", Expense.date >= start, Expense.date <= end)
        .order_by(Expense.date.asc())
        .all()
    )
    items.append({
        "key": "drafts_pending", "count": len(drafts), "applicable": True,
        "amount": round(sum(float(e.amount or 0) for e in drafts), 2),
        "rows": [{"id": str(e.id), "date": iso(e.date), "description": revisor_text(e.description),
                  "amount": float(e.amount or 0)} for e in drafts],
        "link": "/expenses",
    })

    # 5. Cash differences over the tolerance the kasserapport itself uses
    # (kasserapport_claims.CASH_TOL). Difference = counted − expected.
    cash_rows = [
        c for c in closes
        if _is_confirmed(c) and c.cash_difference is not None
        and abs(float(c.cash_difference)) > CASH_TOL
    ]
    items.append({
        "key": "cash_differences", "count": len(cash_rows), "applicable": uses_closes,
        "threshold": CASH_TOL,
        "rows": [{"date": iso(c.date), "difference": float(c.cash_difference)} for c in cash_rows],
        "link": f"/daily-close?date={iso(cash_rows[0].date)}" if cash_rows else "/daily-close",
    })

    # 6. Bank lines from the bank import that are not reconciled (outgoing
    # lines without a link to an expense — the reconcile view's own mark).
    bank_q = (
        db.query(Expense)
        .filter(Expense.user_id == user.id, Expense.is_deleted.isnot(True), not_pending(),
                Expense.reference_id.like("bank\\_%", escape="\\"),
                Expense.date >= start, Expense.date <= end)
    )
    bank_rows = [e for e in bank_q.all() if "[linked:" not in (e.notes or "")]
    uses_bank = bool(bank_rows) or bool(
        db.query(Expense.id).filter(
            Expense.user_id == user.id,
            Expense.reference_id.like("bank\\_%", escape="\\"),
            Expense.date >= start - timedelta(days=60), Expense.date <= end,
        ).first()
        or db.query(Sale.id).filter(
            Sale.user_id == user.id,
            Sale.reference_id.like("bank\\_%", escape="\\"),
            Sale.date >= start - timedelta(days=60), Sale.date <= end,
        ).first()
    )
    items.append({
        "key": "bank_unmatched", "count": len(bank_rows), "applicable": uses_bank,
        "rows": [{"id": str(e.id), "date": iso(e.date), "description": revisor_text(e.description),
                  "amount": float(e.amount or 0)} for e in bank_rows],
        "link": "/imports?tab=bank",
    })

    # 7. Kasserapport vs. the day's POS sales (Bogføringsloven §9 stk. 2) —
    # compute_filing_data's variance_warnings, the momsangivelse's section D3.
    vw = [w for w in (fd.get("variance_warnings") or []) if isinstance(w, dict)]
    items.append({
        "key": "sales_variance", "count": len(vw), "applicable": True,
        "rows": [{"date": str(w.get("date") or ""), "close_revenue": w.get("close_revenue"),
                  "sale_sum": w.get("sale_sum"), "delta": w.get("delta"),
                  "delta_pct": w.get("delta_pct"), "direction": w.get("direction")} for w in vw],
        "link": f"/daily-close?date={vw[0].get('date')}" if vw else "/daily-close",
    })

    # 8. Gift-card checks — the warnings the MOMS page and the momsangivelse
    # (section D4) show, for THIS period, with the angivelse's own note.
    from app.services.tax_filing_pdf import GAVEKORT_NOTES_DA, gavekort_warning_amount
    gk = [w for w in (fd.get("gavekort_warnings") or []) if isinstance(w, dict)]

    def _num(v):
        return float(v) if isinstance(v, (int, float)) else None

    items.append({
        "key": "gavekort_checks", "count": len(gk), "applicable": True,
        "rows": [
            {"date": str(w.get("date") or ""), "status": w.get("status"),
             "amount": _num(gavekort_warning_amount(w)),
             "note_da": GAVEKORT_NOTES_DA.get(w.get("status", ""), w.get("status", ""))}
            for w in gk
        ],
        "link": "/tax",
    })

    open_items = [i for i in items if i["applicable"] and i["count"] > 0]
    return {
        "period": {"start": iso(start), "end": iso(end), "kind": period_kind_of(start, end),
                   "label": period_label(start, end)},
        "items": items,
        "open_count": len(open_items),
        "checked_until": iso(checked_until) if checked_until >= start else None,
        # True when the bilag files were actually read (the package build);
        # False: only references were checked (no download).
        "bilag_fetched": fetched,
    }


def unreadable_without_download(db: Session, user: User, expenses) -> list:
    """Expenses whose bilag certainly cannot be handed over, found without
    downloading anything: a reference that is not one of this owner's, a
    local file or a forwarded (inbox) file that is gone or not recorded for
    this owner. A storage key is not fetched here — the package build reads
    it and reports what failed."""
    from app.services.receipt_ref import parse_receipt_ref
    out = []
    base = Path.cwd()
    parsed_all = [(e, parse_receipt_ref(e.receipt_photo, user.id)) for e in expenses if _has_bilag(e)]
    inbox_paths = {p[1] for _, p in parsed_all if p and p[0] == "inbox"}
    owned: set = set()
    if inbox_paths:   # one query for the period, not one per receipt
        from app.models.receipt_intake import ReceiptIntake
        try:
            owned = {r[0] for r in db.query(ReceiptIntake.storage_path).filter(
                ReceiptIntake.user_id == user.id,
                ReceiptIntake.storage_path.in_(list(inbox_paths))).all()}
        except Exception:  # noqa: BLE001 — cannot tell → not theirs
            owned = set()
    for e, parsed in parsed_all:
        if not parsed:
            out.append(e)
            continue
        kind, value = parsed
        if kind == "storage":
            continue
        if kind == "inbox" and value not in owned:
            out.append(e)
            continue
        try:
            if not (base / value).resolve().is_file():
                out.append(e)
        except OSError:
            out.append(e)
    return out


def _short_day(d: date) -> str:
    return f"{d.day}. {_DA_MONTHS_SHORT[d.month - 1]}"


def _signed_kr(v) -> str:
    v = float(v or 0)
    return ("+" if v > 0 else "") + _kr(v)


def open_item_lines(checklist: dict) -> list[str]:
    """The open items as plain Danish lines — the summary PDF, the e-mail and
    LAES-MIG.txt all print exactly these."""
    from app.services.tax_filing_pdf import VARIANCE_D3_INTRO_DA
    lines = []
    for it in checklist.get("items") or []:
        if not it.get("applicable") or not it.get("count"):
            continue
        n = it["count"]
        rows = it.get("rows") or []
        dates = [date.fromisoformat(r["date"]) for r in rows if r.get("date")]
        k = it["key"]
        if k == "closes_missing":
            # Without opening days set, every calendar day is counted —
            # days the business was closed included. Say so (minor 17).
            qual = ("" if it.get("open_days_configured")
                    else " (åbningsdage er ikke angivet i BonBox, så lukkedage tælles med)")
            lines.append(f"{n} {'dag' if n == 1 else 'dage'} uden dagsafslutning{qual}: "
                         f"{_short_dates(dates)}")
        elif k == "closes_unlocked":
            lines.append(f"{n} {'dagsafslutning er' if n == 1 else 'dagsafslutninger er'} ikke låst "
                         f"(ikke medregnet): {_short_dates(dates)}")
        elif k == "bilag_missing":
            lines.append(f"{n} {'udgift mangler' if n == 1 else 'udgifter mangler'} bilag "
                         f"({_kr(it.get('amount'))})")
        elif k == "bilag_unreadable":
            parts = [f"{_short_day(date.fromisoformat(r['date']))} {r.get('description') or ''} "
                     f"({_kr(r.get('amount'))})".replace("  ", " ") for r in rows[:6]]
            lines.append(f"{n} bilag kunne ikke hentes og er ikke med: {', '.join(parts)}"
                         + (" …" if n > 6 else ""))
        elif k == "drafts_pending":
            lines.append(f"{n} {'udgift venter' if n == 1 else 'udgifter venter'} på godkendelse "
                         "og er ikke med i tallene")
        elif k == "cash_differences":
            parts = [f"{_short_day(d)} ({_kr(r['difference'])})"
                     for d, r in zip(dates, rows)][:6]
            lines.append(f"{n} {'kassedifference' if n == 1 else 'kassedifferencer'} over "
                         f"{_kr(it.get('threshold'))}: {', '.join(parts)}"
                         + (" …" if n > 6 else ""))
        elif k == "sales_variance":
            # The momsangivelse's D3 sentence, then its columns per date.
            parts = [f"{_short_day(date.fromisoformat(r['date']))}: kasserapport "
                     f"{_kr(r.get('close_revenue'))}, POS-salg {_kr(r.get('sale_sum'))}, forskel "
                     f"{_signed_kr(r.get('delta'))} ("
                     + f"{float(r.get('delta_pct') or 0):.1f}".replace(".", ",") + " %)"
                     for r in rows[:6]]
            lines.append(f"{VARIANCE_D3_INTRO_DA} (Bogføringsloven §9 stk. 2) — "
                         + "; ".join(parts) + (" …" if n > 6 else ""))
        elif k == "bank_unmatched":
            lines.append(f"{n} {'bankpost' if n == 1 else 'bankposter'} fra bankimporten er ikke afstemt")
        elif k == "gavekort_checks":
            # The momsangivelse's D4 note per check — the angivelse itself is
            # not in the package, so the line carries the reason.
            parts = [f"{_short_day(date.fromisoformat(r['date']))} {_kr(r.get('amount'))} — "
                     f"{r.get('note_da') or r.get('status') or ''}" for r in rows[:6] if r.get("date")]
            lines.append(f"{n} {'gavekort-punkt' if n == 1 else 'gavekort-punkter'} at tjekke: "
                         + "; ".join(parts) + (" …" if n > 6 else ""))
    return lines


def checklist_status(checklist: dict) -> dict:
    """What the package may say about the period — the summary PDF, the
    e-mail and LAES-MIG.txt print exactly this, so the three cannot disagree.

    {"open": [lines], "title": str, "notes": [str]}

    It never says more than was checked: "alle dage er lukket og låst" only
    when BonBox checks this owner's closes (closes_missing applicable), and
    only for the days checked; a period that is not over says so, with the
    last day checked; the bilag claim names the rule it was checked by
    (booked expenses with moms — the Udgifter page's own rule)."""
    period = checklist.get("period") or {}
    end = date.fromisoformat(period["end"]) if period.get("end") else None
    cu = checklist.get("checked_until")
    checked = date.fromisoformat(cu) if cu else None
    over = bool(end and checked and checked >= end)
    closes_item = next((i for i in checklist.get("items") or []
                        if i.get("key") == "closes_missing"), {}) or {}
    closes_on = bool(closes_item.get("applicable"))
    days_word = "alle åbningsdage" if closes_item.get("open_days_configured") else "alle dage"

    notes: list[str] = []
    if not over:
        notes.append(f"Perioden er ikke slut — kontrolleret til og med {dk_date(checked)}."
                     if checked else "Perioden er ikke slut — ingen dage er kontrolleret endnu.")
    if not closes_on:
        notes.append("Der føres ikke dagsafslutninger i BonBox, så manglende dage er ikke kontrolleret.")
    if checklist.get("bilag_fetched") is False:
        notes.append("Bilagsfilerne er ikke hentet i denne oversigt — det sker, når pakken (ZIP) "
                     "laves, og den viser, om de alle kan hentes.")

    lines = open_item_lines(checklist)
    if lines:
        return {"open": lines, "notes": notes,
                "title": f"Åbne punkter ({len(lines)}) — perioden er ikke færdig"}
    parts = []
    if closes_on and checked:
        parts.append(f"{days_word} er lukket og låst" if over
                     else f"{days_word} indtil nu er lukket og låst")
    parts.append("alle bogførte udgifter med moms har bilag")
    return {"open": [], "notes": notes,
            "title": "Ingen åbne punkter: " + ", og ".join(parts) + "."}


# ─── CSV files ───────────────────────────────────────────────────────────
#
# EVERY CSV in the package is Danish Excel: UTF-8 with BOM, semicolon,
# decimal comma, Danish headers — the files BonBox writes itself and the
# ones it takes from the bookkeeping export (gavekort, moms-oversigt,
# fakturaer, kørsel), which are converted (_danish_excel). LAES-MIG says so.

def _csv(rows: list[list], header: list[str]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    w.writerow(header)
    for r in rows:
        w.writerow(r)
    return ("\ufeff" + buf.getvalue()).encode("utf-8")


_DOT_NUMBER = re.compile(r"^-?\d+\.\d+$")


def _danish_excel(raw: bytes, header: list[str], values: dict | None = None,
                  texts: tuple = ()) -> bytes:
    """A comma / decimal-point CSV from the bookkeeping export, re-written
    the Danish-Excel way: same rows and figures (the exporter stays the one
    source), semicolons, decimal comma, Danish header and words. `texts`:
    (old, new) phrases to re-point inside the package (the bookkeeping
    export points at the momsangivelse, which the package does not hold)."""
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"))))
    out = []
    for r in rows[1:]:
        cells = []
        for c in r:
            if _DOT_NUMBER.match(c):
                c = c.replace(".", ",")
            elif values and c in values:
                c = values[c]
            for old, new in texts:
                c = c.replace(old, new)
            cells.append(c)
        out.append(cells)
    if rows and len(rows[0]) != len(header):
        raise ValueError("danish_excel header length")
    return _csv(out, header)


_FAKTURA_HEADER = ["Fakturanr.", "Fakturadato", "Forfaldsdato", "Leveringsdato", "Kunde", "CVR",
                   "Land", "EAN", "Beløb ekskl. moms", "Moms", "Beløb inkl. moms", "Valuta",
                   "Status", "Betalt dato", "Type"]
_FAKTURA_VALUES = {"draft": "Kladde", "sent": "Sendt", "paid": "Betalt", "overdue": "Forfalden",
                   "credited": "Krediteret", "cancelled": "Annulleret"}
_GAVEKORT_HEADER = ["Dato", "Gavekort", "Hændelse", "Type", "Betalt med", "Online-bestilling",
                    "Beløb", "MOMS-behandling", "MOMS ved salget", "Valuta"]
_MOMS_HEADER = ["Periode start", "Periode slut", "Momssats", "Salg inkl. moms", "Moms af salg",
                "Køb inkl. moms", "Moms af køb", "Netto moms (positiv = skyldig)", "Valuta"]
_KOERSEL_HEADER = ["Dato", "Fra", "Til", "Km", "Formål", "Reg.nr.", "Sats (kr./km)",
                   "Fradrag", "Valuta"]


_SOURCE_DA = {"close": "Låst dagsafslutning", "sales": "Salg", "none": "—"}


def day_source_da(r: dict) -> str:
    """The 'Kilde' of one day. A day whose close is a draft is counted from
    its sales when it has any — and says so (it used to say "ikke
    medregnet" beside sales that WERE counted)."""
    if r["draft"]:
        if r["source"] == "sales":
            return "Salg — dagsafslutningen er en kladde og er ikke medregnet"
        return "Kladde — ikke låst, ikke medregnet"
    return _SOURCE_DA[r["source"]]


def csv_revenue_by_day(days: list[dict], closes) -> bytes:
    cash = {}
    for c in closes:
        if _is_confirmed(c) and c.cash_difference is not None:
            cash[c.date] = cash.get(c.date, 0.0) + float(c.cash_difference)
    rows = []
    for r in days:
        rows.append([
            r["date"].isoformat(), _DA_DAYS[r["date"].weekday()],
            _dk_num(r["amount"]), day_source_da(r),
            _dk_num(cash[r["date"]]) if r["date"] in cash else "",
        ])
    rows.append(["I alt", "", _dk_num(sum(r["amount"] for r in days)), "", ""])
    return _csv(rows, ["Dato", "Ugedag", "Omsætning inkl. moms", "Kilde", "Kassedifference"])


def _pay_da(method: str | None) -> str:
    """The app's Danish word for a stored payment key ('card' → 'Kort')."""
    if not method:
        return ""
    from app.services.close_category_labels import payment_method_label
    return csv_safe(payment_method_label(method, danish=True))


def sales_lines(db: Session, user: User, start: date, end: date, days: list[dict],
                closes, branch_names: dict | None = None) -> list[list]:
    """The revenue lines behind omsaetning-pr-dag, day by day, with exactly
    its rule (and the MOMS engine's): a day with locked closes → one line per
    close (split into the 25 % and the momsfri part the close's own moms
    gives — tax_service.close_vat_split, the split box A uses); any other
    day → its completed till sales that are not a faktura's payment. So
    salg.csv sums to the package's revenue to the øre.

    A close's "Bilag" is its own kasserapport number — the Bilagsnr. of its
    row in dagsafslutninger.csv (14 Oct review: "K-2026-10-09-2" was in no
    other file, and which branch got the "-2" changed between builds).

    Not here, as in the revenue and the moms: a faktura's payment (the
    faktura is in fakturaer.csv), returned and exchanged sales (only
    'completed' sales count), deleted rows, and the sales of a day whose
    close is locked (the close is that day's figure)."""
    from app.services.daily_close_range_export import close_voucher_no
    from app.services.tax_service import _get_vat_rate, close_vat_split
    vat_rate = _get_vat_rate(user.currency or "DKK")
    by_day: dict[date, list] = {}
    for c in closes:
        if _is_confirmed(c):
            by_day.setdefault(c.date, []).append(c)
    sale_days = [r["date"] for r in days if r["source"] == "sales"]
    sales_by_day: dict[date, list] = {}
    if sale_days:
        for s_ in (
            db.query(Sale)
            .filter(Sale.user_id == user.id, Sale.date.in_(sale_days),
                    Sale.is_deleted.isnot(True), Sale.status == "completed",
                    Sale.invoice_id.is_(None))
            .order_by(Sale.date.asc(), Sale.created_at.asc())
            .all()
        ):
            sales_by_day.setdefault(s_.date, []).append(s_)
    out: list[list] = []
    for r in days:
        d = r["date"]
        if r["source"] == "close":
            used_refs: set[str] = set()
            for i, c in enumerate(by_day.get(d, []), start=1):
                gross = float(c.revenue_total or 0)
                taxed, exempt = close_vat_split(gross, c.moms_total, vat_rate)
                ref = close_voucher_no(c, branch_names) or f"KR-{d.isoformat()}"
                if ref in used_refs:   # two closes of one day, neither in a branch
                    ref = f"{ref}-{i}"
                used_refs.add(ref)
                text = f"Kasserapport {d.isoformat()}"
                bname = (branch_names or {}).get(str(c.branch_id)) if c.branch_id else None
                if bname:
                    text += f" · {bname}"
                if abs(taxed) > 0.004 or not exempt:
                    out.append([d.isoformat(), ref, csv_safe(text), _dk_num(taxed), "25 %", ""])
                if abs(exempt) > 0.004:
                    out.append([d.isoformat(), ref, csv_safe(text + " (momsfri)"),
                                _dk_num(exempt), "0 %", ""])
        elif r["source"] == "sales":
            for s_ in sales_by_day.get(d, []):
                vn = getattr(s_, "voucher_number", None)
                text = s_.item_name or s_.notes or "Salg"
                out.append([
                    d.isoformat(), f"S-{d.year}-{vn:04d}" if vn else "",
                    csv_safe(str(text)[:120]), _dk_num(s_.amount),
                    "0 %" if s_.is_tax_exempt else "25 %", _pay_da(s_.payment_method),
                ])
    return out


def csv_sales(lines: list[list]) -> bytes:
    return _csv(lines, ["Dato", "Bilag", "Tekst", "Beløb inkl. moms", "Moms", "Betaling"])


FOREIGN_MOMS_DA = "Udenlandsk valuta — ingen dansk købsmoms"


def _moms_label(e: Expense, cat: str, account_ccy: str | None = "DKK") -> str:
    """udgifter.csv 'Moms': what the revisor needs to know about the
    købsmoms of the row. Løn, pension, forsikring carry no moms at all — they
    are never "25 % — 0 % fradrag" (minor 3). A receipt in a foreign currency
    carries foreign VAT, not købsmoms — never "25 %" (14 Oct review)."""
    from app.services.dk_fradrag import fradrag_reason
    if e.is_tax_exempt:
        return "Momsfri"
    if is_foreign(e, account_ccy):
        return FOREIGN_MOMS_DA
    reason = fradrag_reason(cat)
    if reason == "no_vat":
        return "Ingen moms (løn/forsikring)"
    if reason == "no_purchase":
        return "Ikke et køb (svind) — ingen fradrag"
    if reason == "s42_zero":
        return "25 % — 0 % fradrag (§42 stk. 1)"
    if reason == "s42_quarter":
        return "25 % — 25 % fradrag (§42 stk. 2)"
    return "25 %"


UNREADABLE_DA = "ÅBENT PUNKT: kunne ikke hentes — se bilaget i BonBox"


def csv_expenses(expenses: list[Expense], cat_names: dict, files: dict,
                 account_ccy: str | None = "DKK") -> bytes:
    rows = []
    for e in expenses:
        cat = cat_names.get(e.category_id, "") or ""
        vn = e.voucher_number
        status = files.get(e.id)
        rows.append([
            e.date.isoformat(), f"E-{e.date.year}-{vn:04d}" if vn else "",
            csv_safe(revisor_text(e.description)[:120]), csv_safe(category_da(cat)), _dk_num(e.amount),
            _pay_da(e.payment_method), _moms_label(e, cat, account_ccy),
            status or ("MANGLER" if not _has_bilag(e) else UNREADABLE_DA),
            e.currency or "", _dk_num(e.original_amount) if e.original_amount is not None else "",
            f"{float(e.fx_rate):.6f}".replace(".", ",") if e.fx_rate is not None else "",
        ])
    return _csv(rows, ["Dato", "Bilagsnr.", "Tekst", "Kategori", "Beløb inkl. moms",
                       "Betaling", "Moms", "Bilagsfil", "Original valuta",
                       "Originalt beløb", "Kurs"])


# ─── Summary PDF ─────────────────────────────────────────────────────────

# fd["kob_med_moms"]: every booked expense not marked momsfri.
KOB_LABEL_DA = "Udgifter inkl. moms, ekskl. momsfri (fradrag pr. kategori nedenfor)"


def build_summary_pdf(*, user: User, profile, start: date, end: date, kind: str,
                      fd: dict, checklist: dict, days: list[dict], payments: list[dict],
                      categories: list[dict], closes, n_bilag: int, n_expenses: int,
                      n_bilag_unreadable: int | None = 0,
                      generated_at: datetime, doc_number: str, sample: bool = False,
                      correction: dict | None = None, n_parts: int = 1,
                      gavekort_counter_sold: float = 0.0, has_invoices: bool = False,
                      has_trips: bool = False) -> bytes:
    """Page 1 is the answer a revisor wants first: the figures and what is
    open. Then the detail: revenue per day, categories, gift cards, cash.

    `n_bilag_unreadable` None = the standalone summary, which reads no bilag
    files: it prints no "kunne ikke hentes" figure (it would be a guess).
    `correction` (a corrected package): {"replaces": date, "changes": [...]}
    — labelled RETTELSE on the page and in the running header."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import KeepTogether, Paragraph, Spacer, Table, TableStyle

    from app.services.bonbox_pdf_kit import PALETTE, render_with_doc_hash
    from app.services.kasserapport_claims import CASH_TOL, cash_diff_words
    from app.utils.document_hash import get_software_identifier

    INK = colors.HexColor(PALETTE["INK"])
    MUTED = colors.HexColor(PALETTE["MUTED"])
    DIVIDER = colors.HexColor(PALETTE["DIVIDER"])
    AMBER = colors.HexColor("#b45309")
    AMBER_BG = colors.HexColor("#fffbeb")
    OK_BG = colors.HexColor("#f0fdf4")
    OK = colors.HexColor(PALETTE["OK"])

    styles = getSampleStyleSheet()
    eyebrow = ParagraphStyle("Eb", parent=styles["Normal"], fontName="Helvetica-Bold",
                             fontSize=8, textColor=MUTED, leading=10)
    h1 = ParagraphStyle("H1", parent=styles["Normal"], fontName="Helvetica-Bold",
                        fontSize=16, leading=20, textColor=INK)
    small = ParagraphStyle("Sm", parent=styles["Normal"], fontSize=8.5, leading=11.5,
                           textColor=MUTED)
    small_r = ParagraphStyle("SmR", parent=small, alignment=TA_RIGHT)
    body = ParagraphStyle("B", parent=styles["Normal"], fontSize=9.5, leading=13, textColor=INK)
    sect = ParagraphStyle("S", parent=styles["Normal"], fontName="Helvetica-Bold",
                          fontSize=8.5, leading=11, textColor=MUTED, spaceBefore=10, spaceAfter=4)
    cell = ParagraphStyle("C", parent=body, fontSize=9, leading=12)
    cell_r = ParagraphStyle("CR", parent=cell, alignment=TA_RIGHT)
    cell_b = ParagraphStyle("CB", parent=cell, fontName="Helvetica-Bold")
    cell_br = ParagraphStyle("CBR", parent=cell_b, alignment=TA_RIGHT)

    biz = business_name(profile, user)
    cvr = getattr(profile, "org_number", None) if profile else None
    addr = compose_business_address(profile) if profile else ""
    label = period_label(start, end, kind)
    status = checklist_status(checklist)
    lines = status["open"]
    P = lambda t, s=cell: Paragraph(escape_pdf_text(t), s)  # noqa: E731

    def grid(data, widths, *, total_row=False, header=True):
        t = Table(data, colWidths=widths)
        style = [
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 2),
            ("LINEBELOW", (0, 0), (-1, -1), 0.4, DIVIDER),
        ]
        if header:
            style.append(("LINEBELOW", (0, 0), (-1, 0), 0.8, INK))
        if total_row:
            style.append(("LINEABOVE", (0, -1), (-1, -1), 0.8, INK))
        t.setStyle(TableStyle(style))
        return t

    # The frame's own 6 pt padding on each side: a 166 mm table in a 166 mm
    # frame overflows and is centred 6 pt left of every paragraph.
    W = 166 * mm - 12

    def story():
        s = []
        head = Table([[
            [Paragraph("REVISORPAKKE · EKSEMPELDATA" if sample else
                       ("REVISORPAKKE · RETTELSE" if correction else "REVISORPAKKE"), eyebrow),
             Paragraph(escape_pdf_text(biz), h1),
             Paragraph(escape_pdf_text(" · ".join(x for x in (
                 f"CVR {cvr}" if cvr else "", addr) if x)), small)],
            [Paragraph(escape_pdf_text(label[:1].upper() + label[1:]), ParagraphStyle(
                "PL", parent=body, fontName="Helvetica-Bold", alignment=TA_RIGHT)),
             Paragraph(escape_pdf_text(dk_range(start, end)), small_r),
             Paragraph(escape_pdf_text(f"Bilagsnr. {doc_number}"), small_r)],
        ]], colWidths=[W * 0.62, W * 0.38])
        head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"),
                                  ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                  ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                                  ("LINEBELOW", (0, 0), (-1, -1), 1, INK),
                                  ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
        s.append(head)
        s.append(Spacer(1, 4 * mm))

        # ── A corrected package says so first, and what changed ──
        if correction:
            crows = [[Paragraph(escape_pdf_text(correction_title(correction)), ParagraphStyle(
                "CT", parent=body, fontName="Helvetica-Bold", textColor=AMBER))]]
            crows += [[Paragraph("• " + escape_pdf_text(x), body)]
                      for x in correction_lines(correction)]
            cbox = Table(crows, colWidths=[W])
            cbox.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), AMBER_BG),
                                      ("BOX", (0, 0), (-1, -1), 0.6, AMBER),
                                      ("LEFTPADDING", (0, 0), (-1, -1), 8),
                                      ("TOPPADDING", (0, 0), (-1, -1), 2.5),
                                      ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5)]))
            s.append(cbox)
            s.append(Spacer(1, 3 * mm))

        # ── Status: what is open (or that nothing is) — checklist_status,
        # the same sentences the e-mail and LAES-MIG.txt print ──
        note_rows = [[Paragraph(escape_pdf_text(x), small)] for x in status["notes"]]
        if lines:
            rows = [[Paragraph(escape_pdf_text(status["title"]), ParagraphStyle(
                    "OT", parent=body, fontName="Helvetica-Bold", textColor=AMBER))]]
            rows += [[Paragraph("• " + escape_pdf_text(x), body)] for x in lines]
            box = Table(rows + note_rows, colWidths=[W])
            box.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), AMBER_BG),
                                     ("BOX", (0, 0), (-1, -1), 0.6, AMBER),
                                     ("LEFTPADDING", (0, 0), (-1, -1), 8),
                                     ("TOPPADDING", (0, 0), (-1, -1), 2.5),
                                     ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5)]))
        else:
            box = Table([[Paragraph(escape_pdf_text(status["title"]), ParagraphStyle(
                                        "OK", parent=body, textColor=OK))]] + note_rows,
                        colWidths=[W])
            box.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), OK_BG),
                                     ("BOX", (0, 0), (-1, -1), 0.6, OK),
                                     ("LEFTPADDING", (0, 0), (-1, -1), 8)]))
        s.append(box)

        # ── MOMS summary — compute_filing_data, the angivelse's own figures ──
        s.append(Paragraph("MOMS FOR PERIODEN (SAMME BEREGNING SOM MOMSANGIVELSEN)", sect))
        moms = [
            [P("", cell_b), P("Beløb", cell_br)],
            [P("Salg med moms"), P(_kr(fd["salg_med_moms"]), cell_r)],
            [P("Salg uden moms (momsfrit)"), P(_kr(fd["salg_uden_moms"]), cell_r)],
            [P("Salgsmoms"), P(_kr(fd["moms_af_salg"]), cell_r)],
            # Every booked expense not marked momsfri — løn, svind and
            # repræsentation included, at their 0 % (the category table
            # below). It read "Køb med købsmoms" (14 Oct review).
            [P(KOB_LABEL_DA), P(_kr(fd["kob_med_moms"]), cell_r)],
            [P("Købsmoms (efter §42-fradrag)"), P(_kr(fd["moms_af_kob"]), cell_r)],
            [P("Moms til betaling (beregnet)", cell_b), P(_kr(fd["moms_til_skat"]), cell_br)],
        ]
        s.append(grid(moms, [W * 0.7, W * 0.3], total_row=True))
        s.append(Paragraph(escape_pdf_text(
            "Vejledende — tallene er BonBox' beregning ud fra de låste dagsafslutninger, salg, "
            "fakturaer og bogførte udgifter. Indberetningen sker via revisor/TastSelv."), small))
        # dagsafslutninger.csv states the kasserapport's own verdict per day;
        # where that is "Salgsmoms kan ikke opgøres", say what the figures
        # above did with the day instead (14 Oct review: the CSV said "cannot
        # be stated" for 15 closes the moms above includes).
        from app.services.kasserapport_claims import moms_is_unknown
        locked = [c for c in closes if _is_confirmed(c)]
        no_moms = [c for c in locked if c.moms_total is None]
        if no_moms:
            pct = int(round(float(fd.get("vat_rate") or 0.25) * 100))
            n = len(no_moms)
            s.append(Paragraph(escape_pdf_text(
                f"{n} {'dagsafslutning' if n == 1 else 'dagsafslutninger'} uden momsbeløb "
                f"({_kr(sum(float(c.revenue_total or 0) for c in no_moms))} i omsætning) står i "
                "dagsafslutninger.csv som «Salgsmoms kan ikke opgøres». Salgsmomsen ovenfor regner "
                f"{pct}/{100 + pct} af deres omsætning — tjek beløbet mod Z-bonen."), small))
        unsure = [c for c in locked if c.moms_total is not None and moms_is_unknown(c)]
        if unsure:
            n = len(unsure)
            s.append(Paragraph(escape_pdf_text(
                f"{n} {'dagsafslutning' if n == 1 else 'dagsafslutninger'} har et momsbeløb, "
                "kasserapporten ikke kan bekræfte («Salgsmoms kan ikke opgøres» i "
                "dagsafslutninger.csv). Salgsmomsen ovenfor bruger det gemte beløb."), small))
        foreign_total = float(fd.get("foreign_expenses_total") or 0)
        if foreign_total:
            s.append(Paragraph(escape_pdf_text(
                f"Udgifter i udenlandsk valuta ({_kr(foreign_total)}) er med i udgifterne, men "
                "uden dansk købsmoms: udenlandsk moms trækkes ikke fra på momsangivelsen."), small))

        # ── Key figures ──
        s.append(Paragraph("NØGLETAL", sect))
        rev_total = sum(r["amount"] for r in days)
        kt = [
            [P("Omsætning inkl. moms (dagsafslutninger og salg)"), P(_kr(rev_total), cell_r)],
            [P("Fakturaer inkl. moms"), P(_kr(fd.get("invoice_revenue") or 0), cell_r)],
            [P(f"Bogførte udgifter ({n_expenses})"),
             P(_kr(sum(c["gross"] for c in categories)), cell_r)],
            [P("Udgifter med bilag"), P(f"{n_bilag} af {n_expenses}", cell_r)],
        ]
        # Only where the files were read (the package). The standalone
        # summary reads none and must not guess (12 Oct review B1).
        if n_bilag_unreadable:
            kt.append([P("— heraf bilag, der ikke kunne hentes (se bilag-oversigt.csv)"),
                       P(str(n_bilag_unreadable), cell_r)])
        s.append(grid(kt, [W * 0.7, W * 0.3], header=False))

        # ── Payment methods ──
        if payments:
            s.append(Paragraph("BETALINGSMÅDER (LÅSTE DAGSAFSLUTNINGER OG SALG)", sect))
            pay_total = round(sum(p["amount"] for p in payments), 2)
            pt = [[P("Betalingsmåde", cell_b), P("Beløb", cell_br)]]
            pt += [[P(p["label"]), P(_kr(p["amount"]), cell_r)] for p in payments]
            unsplit = round(rev_total - pay_total, 2)
            if abs(unsplit) >= 0.5:
                pt.append([P("Omsætning uden fordeling på betalingsmåde" if unsplit > 0
                             else "Betalinger over omsætningen (se note)"), P(_kr(unsplit), cell_r)])
            pt.append([P("I alt", cell_b), P(_kr(pay_total + (unsplit if abs(unsplit) >= 0.5 else 0)), cell_br)])
            s.append(grid(pt, [W * 0.7, W * 0.3], total_row=True))
            if unsplit <= -0.5:
                # Payments over revenue: the till took money that is not
                # revenue — typically gavekort sold at the counter (a card
                # sale is not a sale of goods; its MOMS, if any, is in the
                # gavekort lines). Say what BonBox can see (minor 15).
                gk_txt = (f" Gavekort solgt ved kassen i perioden: {_kr(gavekort_counter_sold)}"
                          if gavekort_counter_sold else "")
                s.append(Paragraph(escape_pdf_text(
                    "Note: Betalingerne er højere end omsætningen, når kassen har modtaget penge, "
                    "der ikke er omsætning — typisk gavekort solgt ved kassen (et gavekort er "
                    "ikke et salg af varer; momsen af enkeltformålskort står under Gavekort)."
                    + gk_txt), small))

        # ── Expenses by category with købsmoms ──
        s.append(Paragraph("UDGIFTER PR. KATEGORI MED KØBSMOMS", sect))
        ct = [[P("Kategori", cell_b), P("Antal", cell_br), P("Beløb inkl. moms", cell_br),
               P("Fradrag", cell_br), P("Købsmoms", cell_br)]]
        for c in categories:
            ct.append([P(category_da(c["category"])), P(str(c["count"]), cell_r), P(_kr(c["gross"]), cell_r),
                       P(fradrag_label(c), cell_r), P(_kr(c["input_vat"]), cell_r)])
        ct.append([P("I alt", cell_b), P(str(sum(c["count"] for c in categories)), cell_br),
                   P(_kr(sum(c["gross"] for c in categories)), cell_br), P("", cell_r),
                   P(_kr(fd["moms_af_kob"]), cell_br)])
        s.append(grid(ct, [W * 0.38, W * 0.1, W * 0.2, W * 0.12, W * 0.2], total_row=True))

        # ── Gift cards ──
        s.append(Paragraph("GAVEKORT", sect))
        gt = [
            [P("", cell_b), P("Beløb", cell_br), P("Moms", cell_br)],
            [P(f"Solgt, enkeltformål ({int(fd.get('gavekort_spv_sold_count') or 0)} stk.)"),
             P(_kr(fd.get("gavekort_spv_sold") or 0), cell_r),
             P(_kr(fd.get("gavekort_spv_output_vat") or 0), cell_r)],
            [P("Brugt — moms betalt ved salget, taget ud af omsætningen"),
             P(_kr(-float(fd.get("gavekort_spv_redeemed_in_revenue") or 0)), cell_r),
             P(_kr(-float(fd.get("gavekort_spv_redeemed_vat") or 0)), cell_r)],
            [P("Gavekort-moms netto", cell_b), P("", cell_r),
             P(_kr(fd.get("gavekort_moms_netto") or 0), cell_br)],
        ]
        s.append(grid(gt, [W * 0.56, W * 0.22, W * 0.22], total_row=True))
        # The momsangivelse is not in the package: its D4 checks are printed
        # here, in its own words (12 Oct review M3).
        gk_item = next((i for i in checklist["items"] if i["key"] == "gavekort_checks"), None)
        if gk_item and gk_item["count"]:
            from app.services.tax_filing_pdf import GAVEKORT_D4_INTRO_DA
            s.append(Paragraph(escape_pdf_text(
                "Gavekort at tjekke (samme punkter som momsangivelsens afsnit D4). "
                + GAVEKORT_D4_INTRO_DA), small))
            gkt = [[P("Dato", cell_b), P("Gavekort", cell_br), P("Bemærkning", cell_b)]]
            for r in gk_item["rows"]:
                gkt.append([P(dk_date(date.fromisoformat(r["date"])) if r.get("date") else ""),
                            P(_kr(r.get("amount") or 0), cell_r), P(r.get("note_da") or "")])
            s.append(grid(gkt, [W * 0.24, W * 0.2, W * 0.56]))
        else:
            s.append(Paragraph("Ingen gavekort-punkter at tjekke.", small))

        # ── Kasserapport vs. POS sales (§9 stk. 2) — the angivelse's D3 ──
        var_item = next((i for i in checklist["items"] if i["key"] == "sales_variance"), None)
        if var_item and var_item["count"]:
            from app.services.tax_filing_pdf import VARIANCE_D3_INTRO_DA
            s.append(Paragraph("KASSERAPPORT OG POS-SALG (BOGFØRINGSLOVEN §9 STK. 2)", sect))
            s.append(Paragraph(escape_pdf_text(VARIANCE_D3_INTRO_DA), small))
            vt = [[P("Dato", cell_b), P("Kasserapport", cell_br), P("POS-salg", cell_br),
                   P("Forskel", cell_br)]]
            for r in var_item["rows"]:
                pct = f"{float(r.get('delta_pct') or 0):.1f}".replace(".", ",")
                vt.append([P(dk_date(date.fromisoformat(r["date"]))),
                           P(_kr(r.get("close_revenue")), cell_r), P(_kr(r.get("sale_sum")), cell_r),
                           P(f"{_signed_kr(r.get('delta'))} ({pct} %)", cell_r)])
            s.append(grid(vt, [W * 0.25, W * 0.25, W * 0.25, W * 0.25]))

        # ── Cash differences ──
        confirmed = [c for c in closes if _is_confirmed(c)]
        with_diff = [c for c in confirmed if c.cash_difference is not None]
        s.append(Paragraph(f"KASSEDIFFERENCER (OVER {_kr(CASH_TOL).upper()})", sect))
        big = [c for c in with_diff if abs(float(c.cash_difference)) > CASH_TOL]
        if big:
            kd = [[P("Dato", cell_b), P("Forventet", cell_br), P("Optalt", cell_br),
                   P("Difference", cell_br)]]
            for c in big:
                kd.append([P(dk_date(c.date)), P(_kr(c.cash_expected), cell_r),
                           P(_kr(c.cash_counted), cell_r),
                           P(cash_diff_words(c.cash_difference), cell_r)])
            s.append(grid(kd, [W * 0.3, W * 0.2, W * 0.2, W * 0.3]))
        else:
            s.append(Paragraph("Ingen kassedifferencer over grænsen.", small))
        if with_diff:
            s.append(Paragraph(escape_pdf_text(
                "Samlet kassedifference for låste dage: "
                + cash_diff_words(round(sum(float(c.cash_difference) for c in with_diff), 2))
            ), small))

        # ── Revenue per day ──
        s.append(Paragraph("OMSÆTNING PR. DAG", sect))
        dt = [[P("Dato", cell_b), P("Kilde", cell_b), P("Omsætning inkl. moms", cell_br)]]
        for r in days:
            dt.append([P(f"{_DA_DAYS[r['date'].weekday()][:3]}. {dk_date(r['date'])}"),
                       P(day_source_da(r)),
                       P(_kr(r["amount"]) if r["source"] != "none" else "—", cell_r)])
        dt.append([P("I alt", cell_b), P("", cell), P(_kr(rev_total), cell_br)])
        s.append(grid(dt, [W * 0.4, W * 0.32, W * 0.28], total_row=True))

        # ── Expenses without bilag ──
        miss = next((i for i in checklist["items"] if i["key"] == "bilag_missing"), None)
        if miss and miss["count"]:
            s.append(Paragraph("UDGIFTER UDEN BILAG", sect))
            mt = [[P("Dato", cell_b), P("Tekst", cell_b), P("Beløb", cell_br)]]
            for r in miss["rows"][:60]:
                mt.append([P(dk_date(date.fromisoformat(r["date"]))), P(r["description"] or ""),
                           P(_kr(r["amount"]), cell_r)])
            if len(miss["rows"]) > 60:
                mt.append([P(f"+{len(miss['rows']) - 60} flere — se udgifter.csv"), P(""), P("")])
            s.append(grid(mt, [W * 0.25, W * 0.5, W * 0.25]))

        s.append(Spacer(1, 4 * mm))
        parts_txt = (f" Pakken er delt i {n_parts} ZIP-filer (del 1 har denne oversigt, alle "
                     "CSV-filer og de første bilag)." if n_parts > 1 else "")
        # Every CSV that IS in the package — fakturaer and kørsel were left
        # out of this list even when the ZIP held them (14 Oct review).
        csv_names = ["omsætning pr. dag", "dagsafslutninger", "salg", "udgifter"]
        csv_names += (["fakturaer"] if has_invoices else []) + ["gavekort"]
        csv_names += (["kørsel"] if has_trips else []) + ["momsoversigt"]
        s.append(KeepTogether([Paragraph(escape_pdf_text(
            "Pakken indeholder også CSV-filer (" + ", ".join(csv_names[:-1]) + " og "
            + csv_names[-1] + " — alle i dansk Excel-format: semikolon og decimalkomma) og "
            "alle bilag under bilag/ med bilag-oversigt.csv. manifest.txt har SHA-256 for hver fil."
            + parts_txt), small)]))
        return s

    gen_str = generated_at.strftime("%d.%m.%Y %H:%M") + " UTC"
    return render_with_doc_hash(
        story, pagesize=A4, margins_mm=22,
        title=f"Revisorpakke {label} — {biz}", subject="Revisorpakke",
        software_id=get_software_identifier(), generated_at_str=gen_str,
        generator_email=getattr(user, "email", "") or "",
        is_danish=True,
        running_header=(f"{biz} · Revisorpakke {label}"
                        + (" · RETTELSE" if correction else "") + f" · {doc_number}"),
        running_header_page_no=True,
        footer_note="Opbevares i 5 år efter bogføringsloven.",
    )


# ─── The package ─────────────────────────────────────────────────────────

# Every ZIP is written to a spooled temp file: in memory up to this size, on
# disk beyond it. One bilag is in memory at a time — a 93-day period with
# hundreds of photos never holds all of them (or the ZIP twice) in RAM.
_SPOOL_BYTES = 8 * 1024 * 1024
# A sent package over the link cap is split into numbered parts (one link
# each). Part 1 keeps room for the summary PDF and every CSV.
_PART1_RESERVE = 3 * 1024 * 1024
_PART_RESERVE = 64 * 1024
MAX_PARTS = 20


@dataclass
class ZipPart:
    file: Any                     # SpooledTemporaryFile holding this ZIP
    size: int
    sha256: str
    n_bilag: int
    name: str


@dataclass
class PackageBuild:
    parts: list[ZipPart]
    summary_pdf: bytes
    zip_filename: str
    pdf_filename: str
    doc_number: str
    checklist: dict
    fd: dict
    revenue_total: float
    n_expenses: int
    n_bilag: int
    n_bilag_unreadable: int
    figures: dict = field(default_factory=dict)
    figures_fp: str = ""
    correction: dict | None = None
    sales_csv_total: float = 0.0
    n_reencoded: int = 0
    files: list[tuple[str, int, str]] = field(default_factory=list)

    # Part 1 — the whole package when it was not split (every download).
    @property
    def zip_file(self):
        return self.parts[0].file

    @property
    def zip_size(self) -> int:
        return self.parts[0].size

    @property
    def zip_sha256(self) -> str:
        return self.parts[0].sha256

    @property
    def total_size(self) -> int:
        return sum(pt.size for pt in self.parts)

    @property
    def zip_bytes(self) -> bytes:
        """Part 1 in memory — only where it has to be: the storage upload of
        a send (each part is under MAX_LINK_ZIP_BYTES)."""
        return self.part_bytes(0)

    def part_bytes(self, i: int) -> bytes:
        f = self.parts[i].file
        f.seek(0)
        return f.read()

    def iter_zip(self, chunk: int = 1024 * 1024):
        """Part 1 in chunks — the download streams it."""
        self.zip_file.seek(0)
        while True:
            block = self.zip_file.read(chunk)
            if not block:
                return
            yield block

    def close(self) -> None:
        for pt in self.parts:
            try:
                pt.file.close()
            except Exception:  # noqa: BLE001
                pass


def doc_number_for(start: date, end: date) -> str:
    from app.services.bonbox_pdf_kit import export_bilagsnummer
    return export_bilagsnummer("RP", start, end)


def _safe_name(value: str) -> str:
    from app.services.revisor_mail import safe_name_part
    return safe_name_part(value).replace(" ", "_")


# ─── Bilag for the package: legible, and small enough to send ────────────
#
# A phone photo of a receipt is 3–5 MB; 150 of them make a month no link can
# carry. In the package a photo is stored at 1600 px on the long edge as a
# JPEG at quality 75 — a receipt's smallest print stays readable (proven in
# tests/test_revisor_package_review2.py, test_M8_*) at a tenth of the size.
# The original stays in BonBox; PDFs and small images are untouched.
BILAG_LONG_EDGE = 1600
BILAG_JPEG_QUALITY = 75
_REENCODE_FROM_BYTES = 400 * 1024


def reencode_for_package(data: bytes, ext: str) -> tuple[bytes, str, bool]:
    """(bytes, ext, re-encoded?) for one bilag. Never raises; when in doubt
    the original goes in.

    Through the app's decode gate (image_guard): one of the process-wide
    decode slots is held from the decode to the encoded output, the bytes
    are magic-checked against the image allow-list, and a JPEG is decoded
    at the smallest scale that still covers 1600 px (a 12 MP photo decodes
    at a quarter of its pixels)."""
    if ext not in ("jpg", "png", "webp", "heic"):
        return data, ext, False
    try:
        from PIL import Image, ImageOps
        from app.services.image_guard import decode_slot, open_upload_image
        out = io.BytesIO()
        with decode_slot():
            im = open_upload_image(data, max_side=BILAG_LONG_EDGE)
            try:
                if (len(data) < _REENCODE_FROM_BYTES and max(im.size) <= BILAG_LONG_EDGE
                        and ext in ("jpg", "png")):
                    return data, ext, False
                im = ImageOps.exif_transpose(im)
                if max(im.size) > BILAG_LONG_EDGE:
                    im.thumbnail((BILAG_LONG_EDGE, BILAG_LONG_EDGE), Image.LANCZOS)
                if im.mode not in ("RGB", "L"):
                    bg = Image.new("RGB", im.size, (255, 255, 255))
                    rgba = im.convert("RGBA")
                    bg.paste(rgba, mask=rgba.split()[-1])
                    im = bg
                im.save(out, "JPEG", quality=BILAG_JPEG_QUALITY, optimize=True, progressive=True)
            finally:
                try:
                    im.close()
                except Exception:  # noqa: BLE001
                    pass
        small = out.getvalue()
        if len(small) >= len(data) and ext in ("jpg", "png"):
            return data, ext, False
        return small, "jpg", True
    except Exception:  # noqa: BLE001 — a file the gate refuses / Pillow cannot read goes in as it is
        return data, ext, False


def supplier_names(db: Session, user: User, expenses) -> dict:
    """{vendor_key: the owner's own name for the supplier} — what a bilag
    file is named after (minor 16), when BonBox knows the supplier."""
    keys = {e.vendor_key for e in expenses if getattr(e, "vendor_key", None)}
    if not keys:
        return {}
    try:
        from app.models.vendor_profile import VendorProfile
        # Ordered, so the same package names its files the same way every
        # time (a vendor has one row per learned field/value).
        rows = (db.query(VendorProfile.vendor_key, VendorProfile.display_name)
                .filter(VendorProfile.user_id == user.id, VendorProfile.vendor_key.in_(list(keys)),
                        VendorProfile.display_name.isnot(None))
                .order_by(VendorProfile.created_at.asc(), VendorProfile.id.asc())
                .all())
    except Exception:  # noqa: BLE001
        return {}
    out: dict = {}
    for k, name in rows:
        if name and str(name).strip() and k not in out:
            out[k] = str(name).strip()
    return out


def bilag_label(e: Expense, cat: str, suppliers: dict) -> str:
    """Supplier when BonBox knows it, else the expense's text, else the
    category: 2026-10-03_Hoerkram_2345,67.jpg.

    The row's own text wins when it names that same supplier (it folds to
    the row's vendor_key): the learned name is the first one the owner ever
    typed, so "Husleje andel sep" named the October rent bilag after
    September (Push 8 gate). BonBox's own tags ("[from inbox]") and an
    English built-in category never name a file (gate round 3)."""
    if getattr(e, "vendor_key", None):
        own = revisor_text(e.description)
        if own and canonical_vendor_key(own) == e.vendor_key:
            return own
        name = revisor_text(suppliers.get(e.vendor_key))
        if name:
            return name
    return revisor_text(e.description) or category_da(cat)


# ─── What was sent: the figures, and whether they changed afterwards ─────

FIGURE_LABELS_DA = {
    "salg_med_moms": "Salg med moms",
    "salg_uden_moms": "Salg uden moms",
    "moms_af_salg": "Salgsmoms",
    "kob_med_moms": "Udgifter ekskl. momsfri",
    "moms_af_kob": "Købsmoms",
    "moms_til_skat": "Moms til betaling",
    "omsaetning": "Omsætning inkl. moms",
    "udgifter": "Bogførte udgifter",
    "antal_udgifter": "Antal bogførte udgifter",
    "udgifter_med_bilag": "Udgifter med bilag",
}
_COUNT_FIGURES = {"antal_udgifter", "udgifter_med_bilag"}


def category_rows(db: Session, user: User, fd: dict, expenses) -> list[dict]:
    """The summary PDF's category table (expenses_by_category), for a caller
    that has no category names at hand."""
    cat_names = dict(
        db.query(ExpenseCategory.id, ExpenseCategory.name)
        .filter(ExpenseCategory.user_id == user.id).all()
    )
    return expenses_by_category(fd, expenses, cat_names, user.currency or "DKK")


def package_figures(fd: dict, days: list[dict], expenses,
                    categories: list[dict] | None = None) -> dict:
    """The figures a package states — fingerprinted on the send row, so a
    change after the send shows (M7). Besides the totals, every row the PDF
    prints a money figure in: each category's amount and købsmoms, each
    day's revenue. Moving an expense to a category with the same fradrag, or
    revenue to another day, left every total the same and the change went
    unseen (14 Oct review)."""
    out = {
        "salg_med_moms": round(float(fd.get("salg_med_moms") or 0), 2),
        "salg_uden_moms": round(float(fd.get("salg_uden_moms") or 0), 2),
        "moms_af_salg": round(float(fd.get("moms_af_salg") or 0), 2),
        "kob_med_moms": round(float(fd.get("kob_med_moms") or 0), 2),
        "moms_af_kob": round(float(fd.get("moms_af_kob") or 0), 2),
        "moms_til_skat": round(float(fd.get("moms_til_skat") or 0), 2),
        "omsaetning": round(sum(float(r["amount"]) for r in days), 2),
        "udgifter": round(sum(float(e.amount or 0) for e in expenses), 2),
        "antal_udgifter": len(expenses),
        "udgifter_med_bilag": sum(1 for e in expenses if _has_bilag(e)),
    }
    if categories is not None:
        out["kategorier"] = {
            c["category"]: [round(float(c["gross"] or 0), 2), round(float(c["input_vat"] or 0), 2)]
            for c in categories
        }
    out["dage"] = {r["date"].isoformat(): round(float(r["amount"]), 2)
                   for r in days if round(float(r["amount"]), 2)}
    return out


def figures_fingerprint(figures: dict) -> str:
    return hashlib.sha256(json.dumps(figures, sort_keys=True, separators=(",", ":"))
                          .encode("utf-8")).hexdigest()


def _detail_changes(before: dict, after: dict) -> list[dict]:
    """Per-category and per-day changes — only against a sent package that
    recorded them (an older one compares its totals alone)."""
    out = []
    if isinstance(before.get("kategorier"), dict) and isinstance(after.get("kategorier"), dict):
        b_c, a_c = before["kategorier"], after["kategorier"]
        for name in sorted(set(b_c) | set(a_c)):
            b = b_c.get(name) or [0.0, 0.0]
            a = a_c.get(name) or [0.0, 0.0]
            for i, (kind, label) in enumerate((("category_gross", "Udgifter"),
                                                ("category_vat", "Købsmoms"))):
                if round(float(b[i]), 2) != round(float(a[i]), 2):
                    # The key keeps the stored name; what is read (the
                    # page, the RETTELSE lines) is Danish (gate round 3).
                    out.append({"key": f"{kind}:{name}", "kind": kind, "name": category_da(name),
                                "label_da": f"{label} — {category_da(name)}",
                                "before": round(float(b[i]), 2), "after": round(float(a[i]), 2)})
    if isinstance(before.get("dage"), dict) and isinstance(after.get("dage"), dict):
        b_d, a_d = before["dage"], after["dage"]
        for iso in sorted(set(b_d) | set(a_d)):
            b, a = round(float(b_d.get(iso) or 0), 2), round(float(a_d.get(iso) or 0), 2)
            if b != a:
                out.append({"key": f"day_revenue:{iso}", "kind": "day_revenue", "name": iso,
                            "label_da": f"Omsætning {dk_date(date.fromisoformat(iso))}",
                            "before": b, "after": a})
    return out


def figure_changes(before: dict | None, after: dict) -> list[dict]:
    """What differs between a sent package's figures and today's: the
    totals first, then the category rows and the days. Empty = the package
    states the same figures (the RETTELSE test)."""
    before = before or {}
    out = []
    for k, label in FIGURE_LABELS_DA.items():
        b, a = before.get(k), after.get(k)
        if b is None or a is None:
            continue
        if (round(float(b), 2) if k not in _COUNT_FIGURES else int(b)) != \
                (round(float(a), 2) if k not in _COUNT_FIGURES else int(a)):
            out.append({"key": k, "label_da": label, "before": b, "after": a})
    return out + _detail_changes(before, after)


def sent_figures(row) -> dict:
    """The figures recorded on a send row ({} when unreadable)."""
    try:
        v = json.loads(getattr(row, "figures_json", None) or "{}")
        return v if isinstance(v, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _fig_text(key: str, v) -> str:
    return str(int(v)) if key in _COUNT_FIGURES else _kr(v)


def correction_title(c: dict) -> str:
    when = c.get("replaces")
    when_txt = dk_date(date.fromisoformat(when)) if isinstance(when, str) else (
        dk_date(when) if isinstance(when, date) else "")
    to = f" til {c['recipient']}" if c.get("recipient") else ""
    return f"RETTELSE — erstatter pakken for perioden, sendt {when_txt}{to}".strip()


def correction_lines(c: dict) -> list[str]:
    ch = c.get("changes") or []
    if not ch:
        return ["Tallene er de samme som i den sendte pakke."]
    return [f"{x['label_da']}: {_fig_text(x['key'], x['before'])} → {_fig_text(x['key'], x['after'])}"
            for x in ch]


def fradrag_label(c: dict) -> str:
    """The category table's 'Fradrag' cell (minor 3)."""
    if c["gross"] and c["gross"] == c["exempt"]:
        return "momsfri"
    return {"no_vat": "ingen moms", "no_purchase": "ikke et køb",
            "s42_zero": "0 % (§42)", "s42_quarter": "25 % (§42)",
            "foreign": "0 % (udenl.)"}.get(
        c.get("reason"), f"{c['fradrag_pct']} %")


def build_package(db: Session, user: User, start: date, end: date, *,
                  kind: str | None = None, now: datetime | None = None,
                  include_bilag: bool = True,
                  split_bytes: int | None = None,
                  prior_send=None) -> PackageBuild:
    """Everything for the period, as ZIP(s) plus the summary PDF on its own
    (the e-mail attaches the PDF). Read-only: nothing in the books changes.

    `split_bytes` (a send: the link cap): the bilag are spread over numbered
    parts, each under the cap; part 1 holds the PDF, every CSV and the
    LAES-MIG. Without it (the owner's download) it is one ZIP.
    `prior_send` (a re-send of a period already sent): when the figures
    changed since, the package is a RETTELSE and says what changed."""
    from app.services.tax_filing_pdf import compute_filing_data

    validate_period(start, end)
    kind = kind or period_kind_of(start, end)
    now = now or utc_now()
    profile = profile_of(db, user)
    fd = compute_filing_data(db, user, start, end)
    closes = period_closes(db, user, start, end)
    expenses = expense_rows(db, user, start, end)
    cat_names = dict(
        db.query(ExpenseCategory.id, ExpenseCategory.name)
        .filter(ExpenseCategory.user_id == user.id).all()
    )
    ctx = dict(
        kind=kind, now=now, include_bilag=include_bilag, split_bytes=split_bytes,
        prior_send=prior_send, profile=profile, fd=fd, closes=closes, expenses=expenses,
        cat_names=cat_names,
    )
    parts: list[dict] = []
    try:
        return _build_into(db, user, start, end, parts=parts, **ctx)
    except BaseException:
        for pt in parts:
            try:
                pt["zf"].close()
            except Exception:  # noqa: BLE001
                pass
            pt["out"].close()
        raise


def _build_into(db, user, start, end, *, parts, kind, now, include_bilag, split_bytes,
                prior_send, profile, fd, closes, expenses, cat_names) -> PackageBuild:
    from app.services.bookkeeping_export import (
        _query_invoices, _query_mileage, export_faktura, export_gavekort_ledger,
        export_mileage, export_moms_summary,
    )
    from app.services.daily_close_range_export import closes_to_csv_bytes
    from app.utils.document_hash import get_software_identifier

    stamp = (now.year, now.month, now.day, now.hour, now.minute, now.second)

    def new_part() -> dict:
        out = tempfile.SpooledTemporaryFile(max_size=_SPOOL_BYTES)
        pt = {"out": out, "zf": zipfile.ZipFile(out, "w"), "meta": [], "n_bilag": 0}
        parts.append(pt)
        return pt

    def put(pt: dict, name: str, data: bytes) -> tuple[str, int, str]:
        info = zipfile.ZipInfo(name, date_time=stamp)
        # Photos and PDFs are compressed already.
        info.compress_type = (zipfile.ZIP_STORED if name.startswith("bilag/")
                              else zipfile.ZIP_DEFLATED)
        info.external_attr = 0o644 << 16
        pt["zf"].writestr(info, data)
        m = (name, len(data), hashlib.sha256(data).hexdigest())
        pt["meta"].append(m)
        return m

    def budget(i: int) -> int | None:
        if not split_bytes:
            return None
        return split_bytes - (_PART1_RESERVE if i == 0 else _PART_RESERVE)

    # Bilag — one at a time, straight into a part, named for the revisor.
    current = new_part()
    suppliers = supplier_names(db, user, expenses)
    file_of: dict = {}
    index_rows: list[list] = []
    bilag_meta: list[tuple] = []          # (part number, name, size, sha)
    used: set[str] = set()
    unreadable: list = []
    n_reencoded = 0
    for e in expenses:
        if not _has_bilag(e):
            continue
        cat = cat_names.get(e.category_id, "") or ""
        vn = f"E-{e.date.year}-{e.voucher_number:04d}" if e.voucher_number else ""
        row_base = [e.date.isoformat(), csv_safe(revisor_text(e.description)), _dk_num(e.amount), vn,
                    csv_safe(category_da(cat))]
        loaded = load_bilag(user.id, e.receipt_photo, db=db) if include_bilag else None
        if loaded is None:
            if include_bilag:
                unreadable.append(e)
                index_rows.append(["", *row_base, UNREADABLE_DA, ""])
                file_of[e.id] = UNREADABLE_DA
            continue
        data, ext = loaded
        data, ext, did = reencode_for_package(data, ext)
        n_reencoded += 1 if did else 0
        b = budget(len(parts) - 1)
        if b is not None and current["out"].tell() + len(data) + 1024 > b:
            if current["n_bilag"] == 0 and len(parts) > 1 or len(data) + 1024 > (budget(1) or 0):
                # Larger than any part can carry: not in the package — an
                # open item, and the file stays in BonBox.
                too_big = "ÅBENT PUNKT: for stor til pakken — se bilaget i BonBox"
                unreadable.append(e)
                index_rows.append(["", *row_base, too_big, ""])
                file_of[e.id] = too_big
                del data, loaded
                continue
            if len(parts) >= MAX_PARTS:
                raise PackageDeliveryError("too_large", f"over {MAX_PARTS} dele")
            current = new_part()
        name = bilag_filename(e.date, bilag_label(e, cat, suppliers), e.amount, ext, used)
        m = put(current, f"bilag/{name}", data)
        current["n_bilag"] += 1
        bilag_meta.append((len(parts), *m))
        del data, loaded
        file_of[e.id] = name
        index_rows.append([name, *row_base, "OK", str(len(parts))])

    n_parts = len(parts)
    checklist = build_checklist(db, user, start, end, now=now, fd=fd, closes=closes,
                                expenses=expenses,
                                unreadable=unreadable if include_bilag else None)
    days = revenue_by_day(db, user, start, end, closes)
    payments = payment_methods(db, user, start, end, closes)
    categories = expenses_by_category(fd, expenses, cat_names, user.currency or "DKK")
    figures = package_figures(fd, days, expenses, categories)
    fp = figures_fingerprint(figures)
    correction = None
    changes = (figure_changes(sent_figures(prior_send), figures)
               if prior_send is not None and getattr(prior_send, "figures_fp", None) else [])
    if changes:
        sent = prior_send.sent_at or prior_send.updated_at or prior_send.created_at
        correction = {
            "replaces": link_local_date(user, sent) if sent else None,
            "recipient": prior_send.recipient,
            "changes": changes,
        }
    doc_number = doc_number_for(start, end)
    biz = business_name(profile, user)
    label = period_label(start, end, kind)
    label_file = period_file_label(start, end, kind)
    sample = is_sample_company(db, user)
    has_invoices = bool(_query_invoices(user, db, start, end))
    trips = _query_mileage(user, db, start, end)
    try:
        from app.services.gavekort_moms import period_facts
        counter_sold = round(sum(float(v or 0) for v in
                                 period_facts(db, user.id, start, end + timedelta(days=1))
                                 .get("counter_sold", {}).values()), 2)
    except Exception:  # noqa: BLE001 — an explanation, never a blocker
        counter_sold = 0.0

    summary = build_summary_pdf(
        user=user, profile=profile, start=start, end=end, kind=kind, fd=fd,
        checklist=checklist, days=days, payments=payments, categories=categories,
        # Expenses that HAVE a bilag (the standalone summary does not read
        # the files, and must not say "0 af 12" for that reason).
        closes=closes, n_bilag=sum(1 for e in expenses if _has_bilag(e)),
        n_bilag_unreadable=len(unreadable) if include_bilag else None,
        n_expenses=len(expenses), generated_at=now, doc_number=doc_number, sample=sample,
        correction=correction, n_parts=n_parts, gavekort_counter_sold=counter_sold,
        has_invoices=has_invoices, has_trips=bool(trips),
    )
    pdf_name = f"Oversigt_{label_file}.pdf"

    try:
        extras = _close_extras(db, user, closes)
        closes_csv = closes_to_csv_bytes(closes, currency=user.currency or "DKK", **extras)
    except Exception:  # noqa: BLE001 — the extras are decoration, never a blocker
        logger.warning("revisor package: close extras failed", exc_info=True)
        extras = {"branch_names": {}}
        closes_csv = closes_to_csv_bytes(closes, currency=user.currency or "DKK")

    lines = sales_lines(db, user, start, end, days, closes, extras.get("branch_names"))
    sales_total = round(sum(float(x[3].replace(",", ".")) for x in lines), 2)
    revenue_total = round(sum(r["amount"] for r in days), 2)
    if abs(sales_total - revenue_total) >= 0.005:
        logger.warning("revisor package: salg.csv %.2f != revenue %.2f (user=%s)",
                       sales_total, revenue_total, user.id)

    files: list[tuple[str, bytes]] = [
        (pdf_name, summary),
        ("omsaetning-pr-dag.csv", csv_revenue_by_day(days, closes)),
        ("dagsafslutninger.csv", closes_csv),
        ("salg.csv", csv_sales(lines)),
        ("udgifter.csv", csv_expenses(expenses, cat_names, file_of, user.currency or "DKK")),
        ("gavekort.csv", _danish_excel(export_gavekort_ledger(user, db, start, end),
                                       _GAVEKORT_HEADER, texts=(
                                           ("(se MOMS-angivelsens PDF, afsnit D4)",
                                            "(se oversigten (PDF), afsnittet Gavekort)"),))),
        ("moms-oversigt.csv", _danish_excel(export_moms_summary(user, db, start, end),
                                            _MOMS_HEADER)),
    ]
    if has_invoices:
        files.append(("fakturaer.csv", _danish_excel(export_faktura(user, db, start, end),
                                                     _FAKTURA_HEADER, _FAKTURA_VALUES)))
    if trips:
        files.append(("koersel.csv", _danish_excel(export_mileage(user, db, start, end),
                                                   _KOERSEL_HEADER, {"TOTAL": "I alt"})))
    index_header = ["Fil", "Dato", "Tekst", "Beløb inkl. moms", "Bilagsnr.", "Kategori", "Status"]
    if n_parts > 1:
        index_header.append("ZIP-del")
        idx_rows = index_rows
    else:
        idx_rows = [r[:-1] for r in index_rows]
    files.append(("bilag-oversigt.csv", _csv(idx_rows, index_header)))

    status = checklist_status(checklist)
    readme = _readme(
        biz=biz, sample=sample, label=label, start=start, end=end, doc_number=doc_number,
        now=now, user=user, pdf_name=pdf_name, status=status, correction=correction,
        sales_total=sales_total, revenue_total=revenue_total, has_invoices=has_invoices,
        trips=trips, n_reencoded=n_reencoded, n_parts=n_parts,
    )
    files.append(("LAES-MIG.txt", readme.encode("utf-8")))

    head = [
        "BonBox revisorpakke — manifest",
        "=" * 60,
        f"Virksomhed: {biz}",
        f"CVR:        {getattr(profile, 'org_number', None) or '—'}",
        f"Periode:    {start.isoformat()} -> {end.isoformat()}",
        f"Bilagsnr.:  {doc_number}",
        f"Genereret:  {now.strftime('%Y-%m-%d %H:%M')} UTC",
        f"Software:   {get_software_identifier()}",
    ]
    # Part 1: the small files go in after its bilag (they name them); the
    # manifest lists everything in reading order: oversigt, CSVs, bilag,
    # LAES-MIG.
    p1 = parts[0]
    small = [put(p1, name, data) for name, data in files]
    p1_bilag = [m[1:] for m in bilag_meta if m[0] == 1]
    meta = small[:-1] + p1_bilag + [small[-1]]
    manifest = head + ([f"Del:        1 af {n_parts}"] if n_parts > 1 else []) + [
        "", "FILER (SHA-256)", "-" * 60]
    manifest += [f"{d}  {size:>9}  {name}" for name, size, d in meta]
    put(p1, "manifest.txt", ("\n".join(manifest) + "\n").encode("utf-8"))
    all_meta = list(meta)
    for i, pt in enumerate(parts[1:], start=2):
        note = (f"Revisorpakke — {biz} — {label}\nDel {i} af {n_parts}: bilag.\n"
                f"Oversigten (PDF), CSV-filerne og bilag-oversigt.csv er i del 1.\n")
        mine = [m[1:] for m in bilag_meta if m[0] == i]
        r_meta = put(pt, "LAES-MIG.txt", note.encode("utf-8"))
        man = head + [f"Del:        {i} af {n_parts}", "", "FILER (SHA-256)", "-" * 60]
        man += [f"{d}  {size:>9}  {name}" for name, size, d in mine + [r_meta]]
        put(pt, "manifest.txt", ("\n".join(man) + "\n").encode("utf-8"))
        all_meta += mine
    zparts: list[ZipPart] = []
    base_name = f"Revisorpakke_{_safe_name(biz)}_{label_file}"
    for i, pt in enumerate(parts, start=1):
        pt["zf"].close()
        size = pt["out"].tell()
        h = hashlib.sha256()
        pt["out"].seek(0)
        for block in iter(lambda: pt["out"].read(1024 * 1024), b""):
            h.update(block)
        name = f"{base_name}.zip" if n_parts == 1 else f"{base_name}_del-{i}-af-{n_parts}.zip"
        zparts.append(ZipPart(file=pt["out"], size=size, sha256=h.hexdigest(),
                              n_bilag=pt["n_bilag"], name=name))
    return PackageBuild(
        parts=zparts, summary_pdf=summary, zip_filename=zparts[0].name,
        pdf_filename=pdf_name, doc_number=doc_number, checklist=checklist, fd=fd,
        revenue_total=revenue_total, n_expenses=len(expenses), n_bilag=len(bilag_meta),
        n_bilag_unreadable=len(unreadable), figures=figures, figures_fp=fp,
        correction=correction, sales_csv_total=sales_total, n_reencoded=n_reencoded,
        files=all_meta,
    )


def _readme(*, biz, sample, label, start, end, doc_number, now, user, pdf_name, status,
            correction, sales_total, revenue_total, has_invoices, trips, n_reencoded,
            n_parts) -> str:
    """LAES-MIG.txt. Its status heading is the PDF's and the mail's own
    (checklist_status) — word for word (minor 10)."""
    out = [
        f"Revisorpakke — {biz}" + (" — EKSEMPELDATA (ikke en rigtig virksomheds tal)"
                                   if sample else ""),
    ]
    if correction:
        out.append(correction_title(correction))
    out += [
        f"Periode: {label} ({start.isoformat()} til {end.isoformat()})",
        f"Bilagsnr.: {doc_number}",
        f"Genereret: {now.strftime('%Y-%m-%d %H:%M')} UTC af {getattr(user, 'email', '') or 'BonBox'}",
    ]
    if n_parts > 1:
        out.append(f"Del 1 af {n_parts} — bilagene fortsætter i del 2-{n_parts}.")
    out += ["", status["title"]]
    out += [f"  • {x}" for x in status["open"]]
    out += [f"  {x}" for x in status["notes"]]
    if correction:
        out += ["", "RETTELSE — ÆNDRET SIDEN DEN SENDTE PAKKE"]
        out += [f"  • {x}" for x in correction_lines(correction)]
    out += [
        "",
        "INDHOLD",
        f"  {pdf_name}  Oversigt: moms, nøgletal, betalingsmåder, udgifter pr. kategori,",
        "      gavekort, kassedifferencer, omsætning pr. dag og åbne punkter.",
        "  omsaetning-pr-dag.csv  Én række pr. dag: låst dagsafslutning eller salg.",
        "  dagsafslutninger.csv   Alle dagsafslutninger; kun låste er talt med i totalen.",
        "  salg.csv               Omsætningen linje for linje (KR- = dagsafslutningens",
        "                         bilagsnr. som i dagsafslutninger.csv, S- = salg) — se AFSTEMNING.",
        "  udgifter.csv           Bogførte udgifter med bilagsnr., moms/§42-fradrag og bilagsfil.",
        "  gavekort.csv           Gavekort solgt, brugt og annulleret + momssummerne.",
        "  moms-oversigt.csv      Periodens momstal — samme beregning som momsangivelsen.",
    ]
    if has_invoices:
        out.append("  fakturaer.csv          Udgående fakturaer i perioden.")
    if trips:
        out.append("  koersel.csv            Kørsel (kørselsgodtgørelse) i perioden.")
    out += [
        "  bilag/                 Bilagsfilerne: ÅÅÅÅ-MM-DD_leverandør_beløb.",
        "  bilag-oversigt.csv     Hvilken fil hører til hvilken udgift.",
        "  manifest.txt           SHA-256 for hver fil.",
        "",
        "CSV: Alle CSV-filer er i dansk Excel-format: UTF-8 med BOM, semikolon som",
        "  skilletegn, decimalkomma og danske kolonnenavne.",
        "",
        "AFSTEMNING",
        f"  salg.csv i alt: {_kr(sales_total)} = omsætning i alt (oversigten og",
        f"  omsaetning-pr-dag.csv): {_kr(revenue_total)}"
        + ("" if abs(sales_total - revenue_total) < 0.005 else "  AFVIGER — kontakt BonBox."),
        "  salg.csv følger omsætningen dag for dag: dagens låste dagsafslutninger, ellers",
        "  dagens gennemførte salg. Ikke med — som i omsætningen og momsen: betaling af",
        "  en faktura (fakturaen står i fakturaer.csv), returnerede og byttede salg,",
        "  slettede salg og salg på en dag med låst dagsafslutning (dagsafslutningen er",
        "  dagens tal).",
        "",
        "KØRSEL",
    ]
    if trips:
        km = round(sum(float(t.km or 0) for t in trips), 2)
        ded = round(sum(float(t.deduction_amount or 0) for t in trips), 2)
        out.append(f"  koersel.csv: {len(trips)} {'tur' if len(trips) == 1 else 'ture'}, "
                   f"{_dk_num(km)} km, fradrag {_kr(ded)}")
    else:
        out.append("  Ingen kørsel registreret i BonBox i perioden.")
    if n_reencoded:
        out += ["", "BILAG",
                f"  {n_reencoded} foto(s) er gemt i {BILAG_LONG_EDGE} px (JPEG, kvalitet "
                f"{BILAG_JPEG_QUALITY}), så pakken kan sendes;",
                "  originalerne ligger i BonBox."]
    out += ["", "Udkast i godkend-køen er ikke med i tallene, før ejeren har godkendt dem."]
    return "\n".join(out) + "\n"


def _close_extras(db: Session, user: User, closes) -> dict:
    """Branch names, the figures' source and the unlock history the
    kasserapport CSV prints beside each day (as the period export does)."""
    from app.models.branch import Branch
    from app.services.close_history import close_history_lines, source_lines
    from app.services.tz_utils import _user_zone
    tz = _user_zone(user)
    names = {}
    ids = {c.branch_id for c in closes if c.branch_id}
    if ids:
        names = {str(b.id): b.name for b in db.query(Branch).filter(
            Branch.user_id == user.id, Branch.id.in_(ids)).all()}
    return {
        "tz": tz,
        "history": close_history_lines(db, user, closes, danish=True, tz=tz),
        "sources": source_lines(closes, danish=True, currency=user.currency or "DKK"),
        "branch_names": names,
    }


# ─── The signed download link ────────────────────────────────────────────
#
# HMAC over the payload with the app's signing key, DOMAIN-SEPARATED from the
# unsubscribe links (a different message prefix), so a download token is never
# an unsubscribe token or the other way round. The token names the send row;
# the row names the stored ZIP — the link always returns what was sent.

_LINK_DOMAIN = b"bonbox.revisor-package.v1."


def _link_sig(body: str) -> str:
    from app.utils.email_unsubscribe_token import _secret
    sig = hmac.new(_secret(), _LINK_DOMAIN + body.encode("ascii"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")


def make_link_token(send_id, user_id, expires_at: datetime, part: int | None = None) -> str:
    """`part` (2, 3 …) for the later parts of a split package; part 1 has
    none, so the link of an unsplit package is what it always was."""
    exp = int(expires_at.replace(tzinfo=timezone.utc).timestamp()) if expires_at.tzinfo is None \
        else int(expires_at.timestamp())
    payload = {"s": str(send_id), "u": str(user_id), "e": exp}
    if part and int(part) > 1:
        payload["p"] = int(part)
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    body = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    return f"{body}.{_link_sig(body)}"


def parse_link_token(token: str, *, allow_expired: bool = False) -> dict | None:
    """The payload of a valid token, or None. Never raises."""
    if not token or not isinstance(token, str) or token.count(".") != 1 or len(token) > 600:
        return None
    body, sig = token.split(".", 1)
    try:
        expected = _link_sig(body)
        if not hmac.compare_digest(sig, expected):
            return None
        pad = "=" * (-len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(body + pad).decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(payload, dict) or not payload.get("s") or not payload.get("u"):
        return None
    try:
        exp = int(payload.get("e") or 0)
    except (TypeError, ValueError):
        return None
    payload["expired"] = exp < int(time.time())
    if payload["expired"] and not allow_expired:
        return None
    return payload


def download_url(token: str) -> str:
    from app.services.revisor_mail import public_api_base
    return f"{public_api_base()}/api/public/revisor-package/{token}"


# ─── Sending to the revisor ──────────────────────────────────────────────
#
# Every send — the owner's tap or the schedule — goes through the same walls
# as the other mail BonBox sends a revisor (services/revisor_mail.py): the
# SAVED revisor address only, never the demo seeder's, never under the sample
# company's name, never to a revisor who opted out, no sample rows in the
# period, a confirmed owner e-mail, and the shared daily revisor-mail cap.

def send_blocker(db: Session, user: User, profile, start: date, end: date) -> str | None:
    """Why BonBox may not e-mail this package to the revisor right now, or
    None. The non-raising form, for the schedule; the router raises the same
    walls with their existing messages."""
    from app.services import revisor_mail as rm
    from app.services.billing import has_feature
    if not has_feature(user, "accountant_month_end_bundle"):
        return "plan"
    saved = rm.saved_revisor_address(profile)
    if not saved:
        return "no_revisor"
    if rm.is_demo_revisor(profile, saved):
        return "demo_recipient"
    if rm.is_demo_identity(profile, user):
        return "demo_identity"
    if rm.revisor_opted_out(profile, saved):
        return "opted_out"
    if rm.demo_rows_in_period(db, user.id, start, end):
        return "demo_in_period"
    held = rm.held_sender_reason(user)
    if held:
        return held  # "email_unverified" | "claim_question_open"
    if rm.revisor_daily_cap_reached(db, user):
        return "daily_cap"
    return None


class PackageDeliveryError(Exception):
    """Nothing is known to have gone out. `code`:
      too_large             — more than MAX_PARTS link parts (before the mail)
      storage               — the upload failed (before the mail; safe to retry)
      mail                  — the mail service REFUSED it (nothing sent)
      mail_unclear          — the mail call failed in a way that does not say
                              whether the revisor got it (a timeout after the
                              provider accepted it, a 5xx…). Never retried
                              automatically; `keep` carries what the row needs
                              so the link in a mail that did arrive still works."""

    def __init__(self, code: str, detail: str = "", keep: dict | None = None):
        super().__init__(code)
        self.code = code
        self.detail = detail
        self.keep = keep or {}


# What the mail service says when it refused a message outright — the
# request was answered and nothing was queued. Anything else (a timeout, a
# dropped connection, a 5xx) leaves it open whether the mail went out.
_MAIL_REFUSED = {"email_not_configured", "invalid_recipient", "empty_attachment",
                 "attachment_too_large"}
_MAIL_REFUSED_API = {"ValidationError", "MissingRequiredFieldsError", "MissingApiKeyError",
                     "InvalidApiKeyError", "RateLimitError"}


def mail_refused(err: str | None) -> bool:
    """True when the failed send certainly did NOT reach anyone."""
    e = (err or "").strip()
    if e in _MAIL_REFUSED:
        return True
    if e.startswith("send_error:"):
        return e.split(":", 1)[1].strip() in _MAIL_REFUSED_API
    return False


def mark_failed(row, exc: Exception, now: datetime) -> str:
    """Stamp a send row failed after deliver raised (the caller rolled back
    first and commits after). Returns the error code. A 'mail_unclear' row
    keeps its stored ZIP and link (the mail may have arrived) and is never
    retried by the schedule."""
    code = exc.code if isinstance(exc, PackageDeliveryError) else type(exc).__name__
    detail = getattr(exc, "detail", "") or ""
    row.status, row.error, row.updated_at = "failed", f"{code}:{detail}"[:120], now
    for k, v in (getattr(exc, "keep", None) or {}).items():
        setattr(row, k, v)
    return code


_SCHEDULE_DA = {
    "weekly": "hver mandag morgen med ugen før",
    "monthly": "den 3. i hver måned med måneden før",
}


def package_email_html(*, biz: str, cvr: str | None, accountant_name: str | None,
                       label: str, build: PackageBuild, url: str | None = None,
                       expires: date, schedule: str | None = None,
                       unsubscribe_url: str | None = None,
                       owner_copy_to: str | None = None,
                       urls: list[str] | None = None) -> str:
    """The mail to the revisor (Danish — revisor-facing). Its figures are the
    package's own (compute_filing_data via the build), and the open items are
    the summary PDF's own lines: the mail can never call a period ready that
    the attachment says is not. A split package has one link per part; a
    corrected package says RETTELSE first, and what changed."""
    from app.services.revisor_mail import esc, owner_copy_line, revisor_footer_html
    fd = build.fd
    links = list(urls or ([url] if url else []))
    status = checklist_status(build.checklist)
    lines = status["open"]
    named = bool((accountant_name or "").strip()) and not owner_copy_to
    greeting = f"Hej {esc(accountant_name.strip())}," if named else "Hej,"
    rows = [
        ("Omsætning inkl. moms (dagsafslutninger og salg)", build.revenue_total),
    ]
    if float(fd.get("invoice_revenue") or 0):
        rows.append(("Fakturaer inkl. moms", fd.get("invoice_revenue")))
    rows += [
        ("Salgsmoms", fd["moms_af_salg"]),
        ("Købsmoms", fd["moms_af_kob"]),
        ("Moms til betaling (beregnet)", fd["moms_til_skat"]),
    ]
    table = "".join(
        f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{esc(k)}</td>"
        f"<td style='padding:4px 0;font-weight:600;text-align:right;'>{esc(_kr(v))}</td></tr>"
        for k, v in rows
    )
    notes = "".join(
        f"<p style='margin:6px 0 0;font-size:13px;color:#4b5563;'>{esc(x)}</p>"
        for x in status["notes"]
    )
    if lines:
        status_html = (
            "<div style='margin:16px 0;padding:12px 14px;background:#fffbeb;"
            "border:1px solid #f59e0b;border-radius:8px;'>"
            f"<p style='margin:0 0 6px;font-weight:600;color:#92400e;'>{esc(status['title'])}</p>"
            "<ul style='margin:0;padding-left:18px;color:#374151;'>"
            + "".join(f"<li>{esc(x)}</li>" for x in lines)
            + f"</ul>{notes}</div>"
        )
    else:
        status_html = (
            f"<div style='margin:16px 0;'><p style='margin:0;color:#065f46;'>{esc(status['title'])}</p>"
            f"{notes}</div>"
        )
    correction_html = ""
    if build.correction:
        correction_html = (
            "<div style='margin:16px 0;padding:12px 14px;background:#fffbeb;"
            "border:1px solid #f59e0b;border-radius:8px;'>"
            f"<p style='margin:0 0 6px;font-weight:700;color:#92400e;'>"
            f"{esc(correction_title(build.correction))}</p>"
            "<p style='margin:0 0 4px;color:#374151;'>Ændret siden den sendte pakke:</p>"
            "<ul style='margin:0;padding-left:18px;color:#374151;'>"
            + "".join(f"<li>{esc(x)}</li>" for x in correction_lines(build.correction))
            + "</ul></div>"
        )
    btn = ("display:inline-block;background:#111827;color:#ffffff;text-decoration:none;"
           "padding:10px 16px;border-radius:8px;font-weight:600;margin:0 8px 8px 0;")
    n = len(build.parts)
    if n > 1:
        buttons = "".join(
            f"<a href='{esc(u)}' style='{btn}'>Hent del {i} af {n} (ZIP)</a>"
            for i, u in enumerate(links, start=1))
        size_txt = (f"Pakken er delt i {n} ZIP-filer (i alt {esc(_mb(build.total_size))}): del 1 "
                    f"har oversigten, CSV-filerne og de første bilag; i alt {esc(build.n_bilag)} "
                    "bilag.")
    else:
        buttons = "".join(f"<a href='{esc(u)}' style='{btn}'>Hent hele pakken (ZIP)</a>"
                          for u in links[:1])
        size_txt = (f"ZIP'en har CSV-filerne og {esc(build.n_bilag)} bilag "
                    f"({esc(_mb(build.zip_size))}).")
    sched = (
        f"<p style='color:#6b7280;font-size:13px;'>Pakken sendes automatisk "
        f"{esc(_SCHEDULE_DA[schedule])}, som {esc(biz)} har valgt i BonBox.</p>"
        if schedule in _SCHEDULE_DA else ""
    )
    intro = ("Her er den rettede revisorpakke" if build.correction else "Her er revisorpakken")
    return (
        "<div style='font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#111827;line-height:1.5;font-size:14px;max-width:560px;'>"
        f"<p>{greeting}</p>"
        f"<p>{intro} for <strong>{esc(biz)}</strong> for <strong>{esc(label)}</strong>.</p>"
        f"{correction_html}"
        f"<table style='border-collapse:collapse;margin:12px 0;font-size:14px;'>{table}</table>"
        f"{status_html}"
        f"<p style='font-size:13px;color:#374151;'>Vedhæftet: {esc(build.pdf_filename)} "
        f"(oversigt, bilagsnr. {esc(build.doc_number)}).</p>"
        f"<p style='margin:16px 0 8px;'>{buttons}</p>"
        f"<p style='font-size:13px;color:#374151;'>{size_txt} "
        f"{'Linkene virker' if n > 1 else 'Linket virker'} til og med "
        f"{esc(dk_date(expires))}; bed {esc(biz)} sende pakken igen, hvis "
        f"{'de er udløbet' if n > 1 else 'det er udløbet'}.</p>"
        f"{sched}"
        + (owner_copy_line(owner_copy_to, True) if owner_copy_to else
           revisor_footer_html(business_name=biz, cvr=cvr,
                               unsubscribe_url=unsubscribe_url, is_danish=True))
        + "</div>"
    )


def _mb(n: int) -> str:
    return f"{n / (1024 * 1024):.1f} MB".replace(".", ",")


def deliver(db: Session, user: User, profile, row, *, now: datetime | None = None,
            schedule: str | None = None, prior_send=None) -> PackageBuild:
    """Build the package for `row`'s period, store its ZIP part(s), mail the
    revisor (the owner's copy separately), and stamp `row` sent. Raises
    PackageDeliveryError when nothing is KNOWN to have gone out (code
    "mail_unclear": it may have — see PackageDeliveryError); the caller
    marks the row failed (mark_failed) and commits. The returned build's ZIP
    files are closed (their bytes are in storage, row.parts_json).

    A package over the link cap is split into numbered parts, one link
    each, and the summary PDF is always attached (M8). `prior_send`: the
    package of the finished period that already went out — when the figures
    changed since, this one is a RETTELSE (M7). The schedule never passes
    one: it never sends a period twice."""
    from app.services import revisor_mail as rm

    now = now or utc_now()
    recipient = rm.saved_revisor_address(profile)
    build = build_package(db, user, row.period_start, row.period_end,
                          kind=row.period_kind, now=now, split_bytes=MAX_LINK_ZIP_BYTES,
                          prior_send=prior_send)
    try:
        return _deliver_build(db, user, profile, row, build, recipient=recipient, now=now,
                              schedule=schedule)
    finally:
        build.close()


def link_expiry(db: Session, user: User, now: datetime) -> tuple[datetime, date]:
    """(expires_at as naive UTC, the owner's local date it is valid through).

    The mail says "virker til og med <dato>", so the link lives to the END of
    that local day — PACKAGE_LINK_TTL_DAYS days after the day it was sent —
    not to the minute it was sent, mid-day."""
    from app.services.tz_utils import _user_zone
    tz = _user_zone(user)
    aware = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    last_day = aware.astimezone(tz).date() + timedelta(days=PACKAGE_LINK_TTL_DAYS)
    end_local = datetime.combine(last_day, datetime.max.time().replace(microsecond=0), tzinfo=tz)
    return end_local.astimezone(timezone.utc).replace(tzinfo=None), last_day


def _release_stored(db: Session, row, keys: list[str]) -> None:
    """Remove stored ZIPs no send row points at any more — a send that failed
    after the upload must not leave a copy of the books behind (minor 14).
    Never raises."""
    from app.services.storage import get_storage
    R = type(row)
    try:
        storage = get_storage()
    except Exception:  # noqa: BLE001
        return
    for key in keys:
        try:
            used = db.query(R.id).filter(
                R.id != row.id, R.purged_at.is_(None),
                or_(R.storage_key == key, R.parts_json.like(f"%{key}%"))).first()
            if used is None:
                storage.delete(key)
        except Exception:  # noqa: BLE001
            logger.warning("revisor package: could not remove an unused ZIP")


def _deliver_build(db: Session, user: User, profile, row, build: PackageBuild, *,
                   recipient: str, now: datetime, schedule: str | None) -> PackageBuild:
    from app.services import revisor_mail as rm
    from app.services.storage import compose_key, get_storage
    from app.services.audit_service import record as audit_record

    if any(pt.size > MAX_LINK_ZIP_BYTES for pt in build.parts):
        raise PackageDeliveryError("too_large", _mb(max(pt.size for pt in build.parts)))
    storage = get_storage()
    stored: list[str] = []
    parts_info: list[dict] = []
    try:
        for i, pt in enumerate(build.parts):
            key = compose_key(user.id, "revisor_package", pt.sha256, "zip")
            storage.put(key, build.part_bytes(i), content_type="application/zip")
            stored.append(key)
            parts_info.append({"part": i + 1, "key": key, "sha256": pt.sha256,
                               "size": pt.size, "n_bilag": pt.n_bilag, "name": pt.name})
    except Exception as e:  # noqa: BLE001
        _release_stored(db, row, stored)
        raise PackageDeliveryError("storage", type(e).__name__) from None

    fp = rm.address_fingerprint(rm.mailbox_address(recipient))
    try:
        expires_at, expires_on = link_expiry(db, user, now)
        urls = [download_url(make_link_token(row.id, user.id, expires_at, part=pi["part"]))
                for pi in parts_info]
        biz = business_name(profile, user)
        label = period_label(row.period_start, row.period_end, row.period_kind)
        subject = rm.header_safe(("RETTELSE: " if build.correction else "")
                                 + f"Revisorpakke {label} — {biz}", 180)
        unsub = rm.revisor_unsubscribe_url(user.id, recipient)
        common = dict(
            biz=biz, cvr=getattr(profile, "org_number", None),
            accountant_name=getattr(profile, "accountant_name", None),
            label=label, build=build, urls=urls, expires=expires_on, schedule=schedule,
        )
        html_revisor = package_email_html(**common, unsubscribe_url=unsub)
        html_owner = package_email_html(**common, owner_copy_to=recipient)
        owner_addr = (getattr(user, "email", None) or "").strip().lower()
    except Exception:
        # Nothing was mailed: the stored copies have no link out — remove them.
        _release_stored(db, row, stored)
        raise
    ok, err, owner_copied = rm.send_file_to_revisor(
        recipient=recipient, subject=subject,
        html_revisor=html_revisor, html_owner=html_owner,
        owner_email=owner_addr if rm.owner_copy_allowed(profile, owner_addr) else None,
        attachment_bytes=build.summary_pdf, attachment_filename=build.pdf_filename,
        attachment_mime="application/pdf", reply_to=owner_addr or None,
        from_display=rm.sender_display(biz), unsubscribe_url=unsub, is_danish=True,
    )
    stamp = {
        "recipient": recipient, "recipient_fp": fp,
        "storage_key": parts_info[0]["key"], "zip_sha256": parts_info[0]["sha256"],
        "zip_size": build.total_size, "parts_json": json.dumps(parts_info),
        "n_bilag": build.n_bilag, "open_items": build.checklist["open_count"],
        "link_expires_at": expires_at, "figures_json": json.dumps(build.figures),
        "figures_fp": build.figures_fp, "is_correction": bool(build.correction),
    }
    if not ok:
        if not mail_refused(err):
            # It may have arrived: keep the ZIP(s) behind their links, never
            # resend on our own, and let ops and the owner know.
            raise PackageDeliveryError("mail_unclear", err or "unknown", keep=stamp)
        _release_stored(db, row, stored)
        raise PackageDeliveryError("mail", err or "unknown")

    for k, v in stamp.items():
        setattr(row, k, v)
    row.status = "sent"
    row.skip_reason = None
    row.error = None
    row.sent_at = now
    row.updated_at = now
    # The mail has gone: from here on nothing may raise, or a caller could
    # take a delivered package for a failed one and send it again.
    try:
        _audit_sent(db, user, row, build, recipient, owner_copied, expires_at, subject, audit_record)
    except Exception:  # noqa: BLE001
        logger.exception("revisor package: audit of a delivered send failed")
    return build


def stored_keys(row) -> list[str]:
    """Every stored ZIP of a send row (all parts)."""
    keys = []
    try:
        for pi in json.loads(getattr(row, "parts_json", None) or "[]"):
            if pi.get("key"):
                keys.append(pi["key"])
    except Exception:  # noqa: BLE001
        pass
    if row.storage_key and row.storage_key not in keys:
        keys.insert(0, row.storage_key)
    return keys


def part_of(row, part: int) -> dict | None:
    """{key, sha256, size, name} of part `part` (1-based) of a send row."""
    try:
        parts = json.loads(getattr(row, "parts_json", None) or "[]")
    except Exception:  # noqa: BLE001
        parts = []
    if not parts:
        if part == 1 and row.storage_key:
            return {"part": 1, "key": row.storage_key, "sha256": row.zip_sha256,
                    "size": row.zip_size}
        return None
    for pi in parts:
        if int(pi.get("part") or 0) == part:
            return pi
    return None


def _audit_sent(db, user, row, build, recipient, owner_copied, expires_at, subject, audit_record):
    """The §10 trail of a delivered package: who got what, for which period
    (also the row the shared revisor daily cap counts). In a SAVEPOINT, so a
    failed write cannot poison the caller's transaction."""
    with db.begin_nested():
        audit_record(
            db, user, SEND_ACTION, "revisor_package", entity_id=row.id,
            after={
                "send_id": str(row.id), "trigger": row.send_trigger,
                "period_start": row.period_start.isoformat(),
                "period_end": row.period_end.isoformat(),
                "recipient": recipient, "owner_copy": bool(owner_copied),
                "zip_sha256": build.zip_sha256, "zip_size": build.total_size,
                "zip_parts": len(build.parts), "correction": bool(build.correction),
                "figures_fp": build.figures_fp,
                "doc_number": build.doc_number, "n_bilag": build.n_bilag,
                "open_items": build.checklist["open_count"],
                "link_expires_at": expires_at.isoformat(), "subject": subject,
            },
            actor_type="system.revisor_package" if row.send_trigger == "scheduled" else "user",
        )


def last_sends(db: Session, user: User, limit: int = 5) -> list[dict]:
    from app.models.revisor_package import RevisorPackageSend as R
    rows = (
        db.query(R).filter(R.user_id == user.id)
        .order_by(R.created_at.desc()).limit(limit).all()
    )
    from app.jobs.revisor_package_job import STALE_CLAIM
    now = utc_now()

    def _status(r) -> tuple[str, str | None]:
        # A claim nobody finished (the process died mid-send) is not "being
        # sent" forever: it failed, and nobody knows if the mail went.
        if r.status == "claimed" and now - (r.updated_at or r.created_at or now) > STALE_CLAIM:
            return "failed", "stale_claim"
        return r.status, r.error

    return [{
        "id": str(r.id), "trigger": r.send_trigger, "kind": r.period_kind,
        "period_start": r.period_start.isoformat(), "period_end": r.period_end.isoformat(),
        "label": period_label(r.period_start, r.period_end, r.period_kind),
        "status": _status(r)[0], "skip_reason": r.skip_reason, "error": _status(r)[1],
        "recipient": r.recipient, "open_items": r.open_items, "n_bilag": r.n_bilag,
        "sent_at": r.sent_at.isoformat() if r.sent_at else None,
        # The owner's local date — what "Sendt …" prints (minor 9).
        "sent_on": link_local_date(user, r.sent_at),
        "is_correction": bool(getattr(r, "is_correction", False)),
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "link_expires_at": r.link_expires_at.isoformat() if r.link_expires_at else None,
        "link_expires_on": link_local_date(user, r.link_expires_at),
        "link_active": bool(r.status == "sent" and r.link_expires_at and r.link_expires_at > now
                            and not r.purged_at),
    } for r in rows]


def link_local_date(user: User, expires_at: datetime | None) -> str | None:
    """The owner's local date a link is valid through (what the mail says)."""
    if not expires_at:
        return None
    from app.services.tz_utils import _user_zone
    aware = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=timezone.utc)
    return aware.astimezone(_user_zone(user)).date().isoformat()
