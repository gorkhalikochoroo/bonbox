"""Revisorpakke — a period of the books, handed to the revisor in one go.

Most owners type the day's figures by hand, add the receipt photos later in a
batch, and send their revisor a weekly or monthly package. This module builds
that package for a period (week, month or a custom range) and is the one place
that decides what is in it:

  • Oversigt_<periode>.pdf  — a Danish summary: revenue per day, payment
    methods, the MOMS summary (straight from compute_filing_data — the same
    engine as the momsangivelse, never a second calculation), expenses by
    category with their købsmoms (_calc_vat's own split), gift-card lines,
    cash differences, and every open item listed plainly (days without a
    close, closes not locked, expenses without a bilag, …);
  • CSV files (UTF-8 with BOM, semicolon, decimal comma): revenue per day,
    kasserapporter, salg, udgifter, fakturaer, the gift-card ledger and the
    MOMS summary — built from the bookkeeping_export pieces;
  • bilag/ — every receipt file, named YYYY-MM-DD_leverandør_beløb, with
    bilag-oversigt.csv mapping each file to its expense;
  • LÆS-MIG.txt and manifest.txt (SHA-256 of every file).

Delivered as a ZIP download (every tier — accountant-grade artifacts are the
same at any tier) and, on plans with `accountant_month_end_bundle`, as an
e-mail to the saved revisor: the summary PDF attached, the ZIP behind a signed
link that works for 14 days. The e-mail lists open items honestly — a package
is never dressed up as "ready" when it is not.

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
import time
import unicodedata
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.user import User
from app.services.bonbox_pdf_kit import compose_business_address, escape_pdf_text, money_dk
from app.services.expense_status import not_pending
from app.utils.csv_safe import csv_safe
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

PACKAGE_LINK_TTL_DAYS = 14
MAX_PERIOD_DAYS = 93
# A stored ZIP above this is refused for the link (Supabase's per-object
# ceiling is 50 MB); the owner can still download it from BonBox.
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

def _storage_key_from(photo: str) -> str | None:
    """The storage key inside a stored receipt reference: a Supabase signed
    URL (…/object/sign/<bucket>/<key>?token=…), a public/plain object URL, or
    a bare '<uid>/<kind>/<sha>.<ext>' key."""
    p = photo.split("?", 1)[0]
    for marker in ("/object/sign/", "/object/public/", "/object/"):
        if marker in p:
            rest = p.split(marker, 1)[1]
            parts = rest.split("/", 1)
            return unquote(parts[1]) if len(parts) == 2 else None
    if re.match(r"^[0-9a-fA-F-]{32,36}/[a-z_]+/[0-9a-f]{16,64}\.[a-z0-9]+$", p):
        return p
    return None


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
    return "bin"


def load_bilag(user_id, photo: str | None) -> tuple[bytes, str] | None:
    """The bytes of a stored bilag and their file extension, or None when the
    file cannot be read (gone from local disk, storage down). Never raises.

    Only this owner's files: a storage key must sit under '<user_id>/', a
    local file must sit under uploads/receipts/ (no path traversal)."""
    p = (photo or "").strip()
    if not p:
        return None
    data: bytes | None = None
    try:
        if p.startswith("uploads/receipts/") and p.endswith(".enc"):
            from app.services.inbox_service import load_attachment_blob
            data = load_attachment_blob(p)
        else:
            key = _storage_key_from(p) if ("/object/" in p or "://" not in p) else None
            if key and not p.startswith("uploads/"):
                if not key.startswith(f"{user_id}/"):
                    return None
                from app.services.storage import get_storage
                data = get_storage().get(key)
            elif p.startswith("uploads/"):
                root = (Path.cwd() / "uploads" / "receipts").resolve()
                target = (Path.cwd() / p).resolve()
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
    """The period's real closes (every branch), demo days excluded."""
    rows = (
        db.query(DailyClose)
        .filter(DailyClose.user_id == user.id, DailyClose.is_deleted.isnot(True),
                DailyClose.date >= start, DailyClose.date <= end)
        .order_by(DailyClose.date.asc())
        .all()
    )
    return [c for c in rows if not _is_demo_close(c)]


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


def expenses_by_category(fd: dict, expenses: list[Expense], cat_names: dict) -> list[dict]:
    """Category table: the MOMS base rows from _calc_vat (gross, fradrag %,
    købsmoms — they sum to moms_af_kob), plus the expenses marked momsfri,
    which carry no købsmoms. Counts from the rows themselves."""
    counts: dict[str, int] = {}
    exempt: dict[str, float] = {}
    for e in expenses:
        name = cat_names.get(e.category_id, "") or ""
        counts[name] = counts.get(name, 0) + 1
        if e.is_tax_exempt:
            exempt[name] = exempt.get(name, 0.0) + float(e.amount or 0)
    out = []
    seen = set()
    for r in fd.get("kob_pr_kategori") or []:
        name = r.get("category") or ""
        seen.add(name)
        out.append({
            "category": name or "Uden kategori",
            "count": counts.get(name, 0),
            "gross": round(float(r.get("gross") or 0) + exempt.get(name, 0.0), 2),
            "exempt": round(exempt.get(name, 0.0), 2),
            "fradrag_pct": r.get("fradrag_pct"),
            "input_vat": float(r.get("input_vat") or 0),
        })
    for name, amt in exempt.items():
        if name in seen:
            continue
        out.append({
            "category": name or "Uden kategori", "count": counts.get(name, 0),
            "gross": round(amt, 2), "exempt": round(amt, 2),
            "fradrag_pct": 0, "input_vat": 0.0,
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
                    closes: list | None = None, expenses: list | None = None) -> dict:
    """The open items of a period — what a revisor would ask about.

    Every item: {key, count, applicable, link, rows, …}. `applicable: False`
    means the owner does not use that part of BonBox (no daily closes, no bank
    import) — not "all good". `open_count` counts the items with something
    open. Each `link` is the screen where the item is fixed."""
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
        "rows": [{"id": str(e.id), "date": iso(e.date), "description": e.description,
                  "amount": float(e.amount or 0)} for e in no_bilag],
        "link": f"/expenses?bilag=missing&from={iso(start)}&to={iso(end)}",
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
        "rows": [{"id": str(e.id), "date": iso(e.date), "description": e.description,
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
        "rows": [{"id": str(e.id), "date": iso(e.date), "description": e.description,
                  "amount": float(e.amount or 0)} for e in bank_rows],
        "link": "/imports?tab=bank",
    })

    # 7. Gift-card checks — the warnings the MOMS page and the momsangivelse
    # (section D4) show, for THIS period.
    gk = list(fd.get("gavekort_warnings") or [])
    items.append({
        "key": "gavekort_checks", "count": len(gk), "applicable": True,
        "rows": [
            {"date": str(w.get("date") or ""), "status": w.get("status"),
             "amount": w.get("amount") if isinstance(w.get("amount"), (int, float)) else None}
            for w in gk if isinstance(w, dict)
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
    }


def open_item_lines(checklist: dict) -> list[str]:
    """The open items as plain Danish lines — the summary PDF and the e-mail
    both print exactly these."""
    lines = []
    for it in checklist.get("items") or []:
        if not it.get("applicable") or not it.get("count"):
            continue
        n = it["count"]
        dates = [date.fromisoformat(r["date"]) for r in it.get("rows") or [] if r.get("date")]
        k = it["key"]
        if k == "closes_missing":
            lines.append(f"{n} {'dag' if n == 1 else 'dage'} uden dagsafslutning: {_short_dates(dates)}")
        elif k == "closes_unlocked":
            lines.append(f"{n} {'dagsafslutning er' if n == 1 else 'dagsafslutninger er'} ikke låst "
                         f"(ikke medregnet): {_short_dates(dates)}")
        elif k == "bilag_missing":
            lines.append(f"{n} {'udgift mangler' if n == 1 else 'udgifter mangler'} bilag "
                         f"({_kr(it.get('amount'))})")
        elif k == "drafts_pending":
            lines.append(f"{n} {'udgift venter' if n == 1 else 'udgifter venter'} på godkendelse "
                         "og er ikke med i tallene")
        elif k == "cash_differences":
            parts = [f"{d.day}. {_DA_MONTHS_SHORT[d.month - 1]} ({_kr(r['difference'])})"
                     for d, r in zip(dates, it["rows"])][:6]
            lines.append(f"{n} {'kassedifference' if n == 1 else 'kassedifferencer'} over "
                         f"{_kr(it.get('threshold'))}: {', '.join(parts)}"
                         + (" …" if n > 6 else ""))
        elif k == "bank_unmatched":
            lines.append(f"{n} {'bankpost' if n == 1 else 'bankposter'} fra bankimporten er ikke afstemt")
        elif k == "gavekort_checks":
            lines.append(f"{n} {'gavekort-punkt' if n == 1 else 'gavekort-punkter'} at tjekke "
                         "(se momsangivelsen, afsnit D4)")
    return lines


# ─── CSV files ───────────────────────────────────────────────────────────

def _csv(rows: list[list], header: list[str]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    w.writerow(header)
    for r in rows:
        w.writerow(r)
    return ("﻿" + buf.getvalue()).encode("utf-8")


_SOURCE_DA = {"close": "Låst dagsafslutning", "sales": "Salg", "none": "—"}


def csv_revenue_by_day(days: list[dict], closes) -> bytes:
    cash = {}
    for c in closes:
        if _is_confirmed(c) and c.cash_difference is not None:
            cash[c.date] = cash.get(c.date, 0.0) + float(c.cash_difference)
    rows = []
    for r in days:
        src = _SOURCE_DA[r["source"]]
        if r["draft"]:
            src = "Kladde — ikke låst, ikke medregnet"
        rows.append([
            r["date"].isoformat(), _DA_DAYS[r["date"].weekday()],
            _dk_num(r["amount"]), src,
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


def csv_sales(user: User, db: Session, start: date, end: date) -> bytes:
    from app.services.bookkeeping_export import _query_sales
    rows = []
    for s in _query_sales(user, db, start, end):
        vn = getattr(s, "voucher_number", None)
        bilag = getattr(s, "bilag", None) or (f"S-{s.date.year}-{vn:04d}" if vn else "")
        text = getattr(s, "item_name", None) or getattr(s, "notes", None) or "Salg"
        rows.append([
            s.date.isoformat(), bilag, csv_safe(str(text)[:120]), _dk_num(s.amount),
            "0 %" if getattr(s, "is_tax_exempt", False) else "25 %",
            _pay_da(getattr(s, "payment_method", None)),
        ])
    return _csv(rows, ["Dato", "Bilag", "Tekst", "Beløb inkl. moms", "Moms", "Betaling"])


def csv_expenses(expenses: list[Expense], cat_names: dict, files: dict) -> bytes:
    from app.services.dk_fradrag import fradrag_factor
    rows = []
    for e in expenses:
        cat = cat_names.get(e.category_id, "") or ""
        vn = e.voucher_number
        if e.is_tax_exempt:
            moms = "Momsfri"
        else:
            pct = int(round(fradrag_factor(cat) * 100))
            moms = "25 %" if pct == 100 else f"25 % — {pct} % fradrag"
        status = files.get(e.id)
        rows.append([
            e.date.isoformat(), f"E-{e.date.year}-{vn:04d}" if vn else "",
            csv_safe((e.description or "")[:120]), csv_safe(cat), _dk_num(e.amount),
            _pay_da(e.payment_method), moms,
            status or ("MANGLER" if not _has_bilag(e) else "kunne ikke hentes"),
            e.currency or "", _dk_num(e.original_amount) if e.original_amount is not None else "",
            f"{float(e.fx_rate):.6f}" if e.fx_rate is not None else "",
        ])
    return _csv(rows, ["Dato", "Bilagsnr.", "Tekst", "Kategori", "Beløb inkl. moms",
                       "Betaling", "Moms", "Bilagsfil", "Original valuta",
                       "Originalt beløb", "Kurs"])


# ─── Summary PDF ─────────────────────────────────────────────────────────

def build_summary_pdf(*, user: User, profile, start: date, end: date, kind: str,
                      fd: dict, checklist: dict, days: list[dict], payments: list[dict],
                      categories: list[dict], closes, n_bilag: int, n_expenses: int,
                      n_bilag_unreadable: int = 0,
                      generated_at: datetime, doc_number: str) -> bytes:
    """Page 1 is the answer a revisor wants first: the figures and what is
    open. Then the detail: revenue per day, categories, gift cards, cash."""
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
    lines = open_item_lines(checklist)
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
            [Paragraph("REVISORPAKKE", eyebrow), Paragraph(escape_pdf_text(biz), h1),
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

        # ── Status: what is open (or that nothing is) ──
        if lines:
            rows = [[Paragraph(escape_pdf_text(
                f"Åbne punkter ({len(lines)}) — perioden er ikke færdig"), ParagraphStyle(
                    "OT", parent=body, fontName="Helvetica-Bold", textColor=AMBER))]]
            rows += [[Paragraph("• " + escape_pdf_text(x), body)] for x in lines]
            box = Table(rows, colWidths=[W])
            box.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), AMBER_BG),
                                     ("BOX", (0, 0), (-1, -1), 0.6, AMBER),
                                     ("LEFTPADDING", (0, 0), (-1, -1), 8),
                                     ("TOPPADDING", (0, 0), (-1, -1), 2.5),
                                     ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5)]))
        else:
            box = Table([[Paragraph("Ingen åbne punkter: alle dage er lukket og låst, og alle "
                                    "udgifter har bilag.", ParagraphStyle(
                                        "OK", parent=body, textColor=OK))]], colWidths=[W])
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
            [P("Køb med købsmoms"), P(_kr(fd["kob_med_moms"]), cell_r)],
            [P("Købsmoms (efter §42-fradrag)"), P(_kr(fd["moms_af_kob"]), cell_r)],
            [P("Moms til betaling (beregnet)", cell_b), P(_kr(fd["moms_til_skat"]), cell_br)],
        ]
        s.append(grid(moms, [W * 0.7, W * 0.3], total_row=True))
        s.append(Paragraph(escape_pdf_text(
            "Vejledende — tallene er BonBox' beregning ud fra de låste dagsafslutninger, salg, "
            "fakturaer og bogførte udgifter. Indberetningen sker via revisor/TastSelv."), small))

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
                             else "Betalinger over omsætningen"), P(_kr(unsplit), cell_r)])
            pt.append([P("I alt", cell_b), P(_kr(pay_total + (unsplit if abs(unsplit) >= 0.5 else 0)), cell_br)])
            s.append(grid(pt, [W * 0.7, W * 0.3], total_row=True))

        # ── Expenses by category with købsmoms ──
        s.append(Paragraph("UDGIFTER PR. KATEGORI MED KØBSMOMS", sect))
        ct = [[P("Kategori", cell_b), P("Antal", cell_br), P("Beløb inkl. moms", cell_br),
               P("Fradrag", cell_br), P("Købsmoms", cell_br)]]
        for c in categories:
            frad = "momsfri" if c["gross"] == c["exempt"] else f"{c['fradrag_pct']} %"
            ct.append([P(c["category"]), P(str(c["count"]), cell_r), P(_kr(c["gross"]), cell_r),
                       P(frad, cell_r), P(_kr(c["input_vat"]), cell_r)])
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
        n_gk = len(fd.get("gavekort_warnings") or [])
        s.append(Paragraph(escape_pdf_text(
            f"{n_gk} punkt(er) at tjekke — se momsangivelsen, afsnit D4." if n_gk
            else "Ingen gavekort-punkter at tjekke."), small))

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
            src = "Kladde — ikke låst" if r["draft"] else _SOURCE_DA[r["source"]]
            dt.append([P(f"{_DA_DAYS[r['date'].weekday()][:3]}. {dk_date(r['date'])}"),
                       P(src), P(_kr(r["amount"]) if r["source"] != "none" else "—", cell_r)])
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
        s.append(KeepTogether([Paragraph(escape_pdf_text(
            "Pakken indeholder også CSV-filer (omsætning pr. dag, dagsafslutninger, salg, udgifter, "
            "gavekort og momsoversigt) og alle bilag under bilag/ med bilag-oversigt.csv. "
            "manifest.txt har SHA-256 for hver fil."), small)]))
        return s

    gen_str = generated_at.strftime("%d.%m.%Y %H:%M") + " UTC"
    return render_with_doc_hash(
        story, pagesize=A4, margins_mm=22,
        title=f"Revisorpakke {label} — {biz}", subject="Revisorpakke",
        software_id=get_software_identifier(), generated_at_str=gen_str,
        generator_email=getattr(user, "email", "") or "",
        is_danish=True,
        running_header=f"{biz} · Revisorpakke {label} · {doc_number}",
        running_header_page_no=True,
        footer_note="Opbevares i 5 år efter bogføringsloven.",
    )


# ─── The package ─────────────────────────────────────────────────────────

@dataclass
class PackageBuild:
    zip_bytes: bytes
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
    files: list[tuple[str, int, str]] = field(default_factory=list)

    @property
    def zip_sha256(self) -> str:
        return hashlib.sha256(self.zip_bytes).hexdigest()


def doc_number_for(start: date, end: date) -> str:
    from app.services.bonbox_pdf_kit import export_bilagsnummer
    return export_bilagsnummer("RP", start, end)


def _safe_name(value: str) -> str:
    from app.services.revisor_mail import safe_name_part
    return safe_name_part(value).replace(" ", "_")


def build_package(db: Session, user: User, start: date, end: date, *,
                  kind: str | None = None, now: datetime | None = None,
                  include_bilag: bool = True) -> PackageBuild:
    """Everything for the period, as one ZIP plus the summary PDF on its own
    (the e-mail attaches the PDF). Read-only: nothing in the books changes."""
    from app.services.bookkeeping_export import (
        _query_invoices, export_faktura, export_gavekort_ledger, export_moms_summary,
    )
    from app.services.daily_close_range_export import closes_to_csv_bytes
    from app.services.tax_filing_pdf import compute_filing_data
    from app.utils.document_hash import get_software_identifier

    validate_period(start, end)
    kind = kind or period_kind_of(start, end)
    now = now or utc_now()
    profile = profile_of(db, user)
    fd = compute_filing_data(db, user, start, end)
    closes = period_closes(db, user, start, end)
    expenses = expense_rows(db, user, start, end)
    checklist = build_checklist(db, user, start, end, now=now, fd=fd,
                                closes=closes, expenses=expenses)
    cat_names = dict(
        db.query(ExpenseCategory.id, ExpenseCategory.name)
        .filter(ExpenseCategory.user_id == user.id).all()
    )
    days = revenue_by_day(db, user, start, end, closes)
    payments = payment_methods(db, user, start, end, closes)
    categories = expenses_by_category(fd, expenses, cat_names)
    doc_number = doc_number_for(start, end)
    biz = business_name(profile, user)
    label = period_label(start, end, kind)
    label_file = period_file_label(start, end, kind)

    # Bilag files — read now, named for the revisor.
    bilag_files: list[tuple[str, bytes]] = []
    file_of: dict = {}
    index_rows = []
    used: set[str] = set()
    unreadable = 0
    for e in expenses:
        if not _has_bilag(e):
            continue
        loaded = load_bilag(user.id, e.receipt_photo) if include_bilag else None
        cat = cat_names.get(e.category_id, "") or ""
        vn = f"E-{e.date.year}-{e.voucher_number:04d}" if e.voucher_number else ""
        if loaded is None:
            unreadable += 1
            index_rows.append(["", e.date.isoformat(), csv_safe(e.description or ""),
                               _dk_num(e.amount), vn, csv_safe(cat),
                               "Kunne ikke hentes — se bilaget i BonBox"])
            file_of[e.id] = "kunne ikke hentes"
            continue
        data, ext = loaded
        name = bilag_filename(e.date, e.description or cat, e.amount, ext, used)
        bilag_files.append((f"bilag/{name}", data))
        file_of[e.id] = name
        index_rows.append([name, e.date.isoformat(), csv_safe(e.description or ""),
                           _dk_num(e.amount), vn, csv_safe(cat), "OK"])

    summary = build_summary_pdf(
        user=user, profile=profile, start=start, end=end, kind=kind, fd=fd,
        checklist=checklist, days=days, payments=payments, categories=categories,
        # Expenses that HAVE a bilag (the standalone summary does not read
        # the files, and must not say "0 af 12" for that reason).
        closes=closes, n_bilag=sum(1 for e in expenses if _has_bilag(e)),
        n_bilag_unreadable=unreadable, n_expenses=len(expenses),
        generated_at=now, doc_number=doc_number,
    )
    pdf_name = f"Oversigt_{label_file}.pdf"

    try:
        closes_csv = closes_to_csv_bytes(closes, currency=user.currency or "DKK",
                                         **_close_extras(db, user, closes))
    except Exception:  # noqa: BLE001 — the extras are decoration, never a blocker
        logger.warning("revisor package: close extras failed", exc_info=True)
        closes_csv = closes_to_csv_bytes(closes, currency=user.currency or "DKK")

    files: list[tuple[str, bytes]] = [
        (pdf_name, summary),
        ("omsaetning-pr-dag.csv", csv_revenue_by_day(days, closes)),
        ("dagsafslutninger.csv", closes_csv),
        ("salg.csv", csv_sales(user, db, start, end)),
        ("udgifter.csv", csv_expenses(expenses, cat_names, file_of)),
        ("gavekort.csv", export_gavekort_ledger(user, db, start, end)),
        ("moms-oversigt.csv", export_moms_summary(user, db, start, end)),
    ]
    if _query_invoices(user, db, start, end):
        files.append(("fakturaer.csv", export_faktura(user, db, start, end)))
    files.append(("bilag-oversigt.csv", _csv(index_rows, [
        "Fil", "Dato", "Tekst", "Beløb inkl. moms", "Bilagsnr.", "Kategori", "Status"])))
    files += bilag_files

    open_lines = open_item_lines(checklist)
    readme = "\n".join([
        f"Revisorpakke — {biz}",
        f"Periode: {label} ({start.isoformat()} til {end.isoformat()})",
        f"Bilagsnr.: {doc_number}",
        f"Genereret: {now.strftime('%Y-%m-%d %H:%M')} UTC af {getattr(user, 'email', '') or 'BonBox'}",
        "",
        "INDHOLD",
        f"  {pdf_name}  Oversigt: moms, nøgletal, betalingsmåder, udgifter pr. kategori,",
        "      gavekort, kassedifferencer, omsætning pr. dag og åbne punkter.",
        "  omsaetning-pr-dag.csv  Én række pr. dag: låst dagsafslutning eller salg.",
        "  dagsafslutninger.csv   Alle dagsafslutninger; kun låste er talt med i totalen.",
        "  salg.csv               Omsætningsbilag (K-dato = dagsafslutning, S- = salg).",
        "  udgifter.csv           Bogførte udgifter med bilagsnr., moms/§42-fradrag og bilagsfil.",
        "  gavekort.csv           Gavekort solgt, brugt og annulleret + momssummerne.",
        "  moms-oversigt.csv      Periodens momstal — samme beregning som momsangivelsen.",
        "  fakturaer.csv          Udgående fakturaer (kun hvis der er nogen).",
        "  bilag/                 Bilagsfilerne: ÅÅÅÅ-MM-DD_leverandør_beløb.",
        "  bilag-oversigt.csv     Hvilken fil hører til hvilken udgift.",
        "  manifest.txt           SHA-256 for hver fil.",
        "",
        "CSV: UTF-8. Semikolon og decimalkomma (dansk Excel) i omsaetning-pr-dag,",
        "  dagsafslutninger, salg, udgifter og bilag-oversigt. gavekort.csv og",
        "  moms-oversigt.csv har komma og decimalpunktum — samme format som",
        "  bogføringseksporten, så tallene kan importeres direkte.",
        "",
        "ÅBNE PUNKTER" + (f" ({len(open_lines)})" if open_lines else ""),
        *([f"  • {x}" for x in open_lines] or ["  Ingen."]),
        "",
        "Udkast i godkend-køen er ikke med i tallene, før ejeren har godkendt dem.",
    ]) + "\n"
    files.append(("LAES-MIG.txt", readme.encode("utf-8")))

    manifest = [
        "BonBox revisorpakke — manifest",
        "=" * 60,
        f"Virksomhed: {biz}",
        f"CVR:        {getattr(profile, 'org_number', None) or '—'}",
        f"Periode:    {start.isoformat()} -> {end.isoformat()}",
        f"Bilagsnr.:  {doc_number}",
        f"Genereret:  {now.strftime('%Y-%m-%d %H:%M')} UTC",
        f"Software:   {get_software_identifier()}",
        "",
        "FILER (SHA-256)",
        "-" * 60,
    ]
    meta = []
    for name, data in files:
        digest = hashlib.sha256(data).hexdigest()
        meta.append((name, len(data), digest))
        manifest.append(f"{digest}  {len(data):>9}  {name}")
    files.append(("manifest.txt", ("\n".join(manifest) + "\n").encode("utf-8")))

    # A fixed timestamp per build (the generation time) for every entry.
    stamp = (now.year, now.month, now.day, now.hour, now.minute, now.second)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zf:
        for name, data in files:
            info = zipfile.ZipInfo(name, date_time=stamp)
            # Photos and PDFs are compressed already.
            info.compress_type = (zipfile.ZIP_STORED if name.startswith("bilag/")
                                  else zipfile.ZIP_DEFLATED)
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)

    return PackageBuild(
        zip_bytes=out.getvalue(), summary_pdf=summary,
        zip_filename=f"Revisorpakke_{_safe_name(biz)}_{label_file}.zip",
        pdf_filename=pdf_name, doc_number=doc_number, checklist=checklist, fd=fd,
        revenue_total=round(sum(r["amount"] for r in days), 2),
        n_expenses=len(expenses), n_bilag=len(bilag_files), n_bilag_unreadable=unreadable,
        files=meta,
    )


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


def make_link_token(send_id, user_id, expires_at: datetime) -> str:
    exp = int(expires_at.replace(tzinfo=timezone.utc).timestamp()) if expires_at.tzinfo is None \
        else int(expires_at.timestamp())
    raw = json.dumps({"s": str(send_id), "u": str(user_id), "e": exp},
                     separators=(",", ":")).encode("utf-8")
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
    def __init__(self, code: str, detail: str = ""):
        super().__init__(code)
        self.code = code
        self.detail = detail


_SCHEDULE_DA = {
    "weekly": "hver mandag morgen med ugen før",
    "monthly": "den 3. i hver måned med måneden før",
}


def package_email_html(*, biz: str, cvr: str | None, accountant_name: str | None,
                       label: str, build: PackageBuild, url: str, expires: date,
                       schedule: str | None = None, unsubscribe_url: str | None = None,
                       owner_copy_to: str | None = None) -> str:
    """The mail to the revisor (Danish — revisor-facing). Its figures are the
    package's own (compute_filing_data via the build), and the open items are
    the summary PDF's own lines: the mail can never call a period ready that
    the attachment says is not."""
    from app.services.revisor_mail import esc, owner_copy_line, revisor_footer_html
    fd = build.fd
    lines = open_item_lines(build.checklist)
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
    if lines:
        status = (
            "<div style='margin:16px 0;padding:12px 14px;background:#fffbeb;"
            "border:1px solid #f59e0b;border-radius:8px;'>"
            f"<p style='margin:0 0 6px;font-weight:600;color:#92400e;'>Åbne punkter ({len(lines)})"
            " — perioden er ikke færdig</p><ul style='margin:0;padding-left:18px;color:#374151;'>"
            + "".join(f"<li>{esc(x)}</li>" for x in lines)
            + "</ul></div>"
        )
    else:
        status = (
            "<p style='margin:16px 0;color:#065f46;'>Ingen åbne punkter: alle dage er lukket "
            "og låst, og alle udgifter har bilag.</p>"
        )
    unread = (
        f"<p style='color:#92400e;font-size:13px;'>{esc(build.n_bilag_unreadable)} bilag kunne ikke "
        "hentes og er ikke i pakken — de står i bilag-oversigt.csv.</p>"
        if build.n_bilag_unreadable else ""
    )
    sched = (
        f"<p style='color:#6b7280;font-size:13px;'>Pakken sendes automatisk "
        f"{esc(_SCHEDULE_DA[schedule])}, som {esc(biz)} har valgt i BonBox.</p>"
        if schedule in _SCHEDULE_DA else ""
    )
    return (
        "<div style='font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#111827;line-height:1.5;font-size:14px;max-width:560px;'>"
        f"<p>{greeting}</p>"
        f"<p>Her er revisorpakken for <strong>{esc(biz)}</strong> for <strong>{esc(label)}</strong>.</p>"
        f"<table style='border-collapse:collapse;margin:12px 0;font-size:14px;'>{table}</table>"
        f"{status}"
        f"<p style='font-size:13px;color:#374151;'>Vedhæftet: {esc(build.pdf_filename)} "
        f"(oversigt, bilagsnr. {esc(build.doc_number)}).</p>"
        f"<p style='margin:16px 0;'><a href='{esc(url)}' style='display:inline-block;"
        "background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;"
        "border-radius:8px;font-weight:600;'>Hent hele pakken (ZIP)</a></p>"
        f"<p style='font-size:13px;color:#374151;'>ZIP'en har CSV-filerne og "
        f"{esc(build.n_bilag)} bilag ({esc(_mb(len(build.zip_bytes)))}). Linket virker til og med "
        f"{esc(dk_date(expires))}; bed {esc(biz)} sende pakken igen, hvis det er udløbet.</p>"
        f"{unread}{sched}"
        + (owner_copy_line(owner_copy_to, True) if owner_copy_to else
           revisor_footer_html(business_name=biz, cvr=cvr,
                               unsubscribe_url=unsubscribe_url, is_danish=True))
        + "</div>"
    )


def _mb(n: int) -> str:
    return f"{n / (1024 * 1024):.1f} MB".replace(".", ",")


def deliver(db: Session, user: User, profile, row, *, now: datetime | None = None,
            schedule: str | None = None) -> PackageBuild:
    """Build the package for `row`'s period, store the ZIP, mail the revisor
    (the owner's copy separately), and stamp `row` sent. Raises
    PackageDeliveryError when nothing went out — the row says failed then.
    The caller commits."""
    from app.services import revisor_mail as rm
    from app.services.storage import compose_key, get_storage
    from app.services.audit_service import record as audit_record

    now = now or utc_now()
    recipient = rm.saved_revisor_address(profile)
    build = build_package(db, user, row.period_start, row.period_end,
                          kind=row.period_kind, now=now)
    if len(build.zip_bytes) > MAX_LINK_ZIP_BYTES:
        raise PackageDeliveryError("too_large", _mb(len(build.zip_bytes)))
    storage = get_storage()
    key = compose_key(user.id, "revisor_package", build.zip_sha256, "zip")
    try:
        storage.put(key, build.zip_bytes, content_type="application/zip")
    except Exception as e:  # noqa: BLE001
        raise PackageDeliveryError("storage", type(e).__name__) from None

    expires_at = now + timedelta(days=PACKAGE_LINK_TTL_DAYS)
    url = download_url(make_link_token(row.id, user.id, expires_at))
    biz = business_name(profile, user)
    label = period_label(row.period_start, row.period_end, row.period_kind)
    subject = rm.header_safe(f"Revisorpakke {label} — {biz}", 180)
    unsub = rm.revisor_unsubscribe_url(user.id, recipient)
    common = dict(
        biz=biz, cvr=getattr(profile, "org_number", None),
        accountant_name=getattr(profile, "accountant_name", None),
        label=label, build=build, url=url, expires=expires_at.date(), schedule=schedule,
    )
    owner_addr = (getattr(user, "email", None) or "").strip().lower()
    ok, err, owner_copied = rm.send_file_to_revisor(
        recipient=recipient, subject=subject,
        html_revisor=package_email_html(**common, unsubscribe_url=unsub),
        html_owner=package_email_html(**common, owner_copy_to=recipient),
        owner_email=owner_addr if rm.owner_copy_allowed(profile, owner_addr) else None,
        attachment_bytes=build.summary_pdf, attachment_filename=build.pdf_filename,
        attachment_mime="application/pdf", reply_to=owner_addr or None,
        from_display=rm.sender_display(biz), unsubscribe_url=unsub, is_danish=True,
    )
    if not ok:
        try:
            # Nothing references this copy now (a manual re-send of the same
            # bytes would have re-uploaded it under the same key anyway).
            others = db.query(type(row)).filter(
                type(row).storage_key == key, type(row).status == "sent",
                type(row).purged_at.is_(None)).first()
            if others is None:
                storage.delete(key)
        except Exception:  # noqa: BLE001
            pass
        raise PackageDeliveryError("mail", err or "unknown")

    row.status = "sent"
    row.skip_reason = None
    row.error = None
    row.recipient = recipient
    row.recipient_fp = rm.address_fingerprint(rm.mailbox_address(recipient))
    row.storage_key = key
    row.zip_sha256 = build.zip_sha256
    row.zip_size = len(build.zip_bytes)
    row.n_bilag = build.n_bilag
    row.open_items = build.checklist["open_count"]
    row.link_expires_at = expires_at
    row.sent_at = now
    row.updated_at = now
    # The mail has gone: from here on nothing may raise, or a caller could
    # take a delivered package for a failed one and send it again.
    try:
        _audit_sent(db, user, row, build, recipient, owner_copied, expires_at, subject, audit_record)
    except Exception:  # noqa: BLE001
        logger.exception("revisor package: audit of a delivered send failed")
    return build


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
                "zip_sha256": build.zip_sha256, "zip_size": len(build.zip_bytes),
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
    now = utc_now()
    return [{
        "id": str(r.id), "trigger": r.send_trigger, "kind": r.period_kind,
        "period_start": r.period_start.isoformat(), "period_end": r.period_end.isoformat(),
        "label": period_label(r.period_start, r.period_end, r.period_kind),
        "status": r.status, "skip_reason": r.skip_reason, "error": r.error,
        "recipient": r.recipient, "open_items": r.open_items, "n_bilag": r.n_bilag,
        "sent_at": r.sent_at.isoformat() if r.sent_at else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "link_expires_at": r.link_expires_at.isoformat() if r.link_expires_at else None,
        "link_active": bool(r.status == "sent" and r.link_expires_at and r.link_expires_at > now
                            and not r.purged_at),
    } for r in rows]
