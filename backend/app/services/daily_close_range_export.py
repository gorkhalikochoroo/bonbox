"""Daily close range export — multi-day PDF + CSV + XLSX for accountant handoff.

Distinct from the per-close PDF (services/kasserapport_pdf.py) which
makes one polished receipt per closing day. This module aggregates a
DATE RANGE into a single document, with totals + averages so the
accountant can review a week / month / quarter at a glance.

Three formats:
  • PDF   — table with one row per close, totals + readiness badge.
            Danish labels for DKK tenants (matches the per-close PDF).
  • CSV   — same data tabular, semicolon-delimited + UTF-8 BOM so
            Danish-locale Excel opens it cleanly.
  • XLSX  — proper Excel workbook: typed columns (numbers as numbers,
            dates as dates), frozen header, auto-widths, Danish number
            format. The accountant can sort / filter / pivot directly.

Inputs are pre-filtered DailyClose ORM rows (date+user already
narrowed by the router); this service only formats.
"""
from __future__ import annotations

import csv
import io
from datetime import date

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.daily_close import DailyClose, decode_breakdown
from app.utils.csv_safe import csv_safe


# ─── Confirmed vs draft — one predicate, one label ────────────────────

def _is_confirmed(c) -> bool:
    return (getattr(c, "status", None) or "confirmed") == "confirmed"


def status_label(c, danish: bool) -> str:
    """The Status cell text. The Excel totals formula keys on CONFIRMED_LABEL,
    so the row writer and the formula read the same constant."""
    if _is_confirmed(c):
        return CONFIRMED_LABEL_DA if danish else CONFIRMED_LABEL_EN
    return DRAFT_LABEL_DA if danish else DRAFT_LABEL_EN


CONFIRMED_LABEL_DA = "Låst"
CONFIRMED_LABEL_EN = "Locked"
DRAFT_LABEL_DA = "Kladde (ikke medregnet)"
DRAFT_LABEL_EN = "Draft (not counted)"


# ─── CSV ──────────────────────────────────────────────────────────────
#
# THE DEFAULT CSV IS FOR A DANISH REVISOR IN DANISH EXCEL. It used to write
# Python's "15021.00": Danish Excel reads "." as a time/grouping separator, so
# MOMS became time values and revenue became text — in the one file the panel
# promised "opens directly in Excel". It also carried English DB field names,
# branch UUIDs and the photo's storage key, none of which a revisor needs.
#
# Now: UTF-8 BOM, ";" delimiter, decimal comma with NO thousands separator
# ("15021,00" — what Danish Excel parses as a number), Danish headers, a fixed
# column order (the header row names every column), drafts listed but marked
# "Kladde (ikke medregnet)" and kept out of the totals row at the bottom.
#
# The old machine shape is still available — only behind an explicit
# `variant="machine"` (`?variant=machine` on the endpoint); the UI never offers
# it. Its storage key / branch id columns are gone there too.

_MACHINE_CSV_COLUMNS = [
    "date", "status",
    "revenue_total", "revenue_ex_moms", "moms_total", "moms_mode",
    "payment_total", "cash_expected", "cash_counted", "cash_difference",
    "tips_total", "tips_staff_count", "tips_per_person",
    "revenue_breakdown",   # encoded "food:12400|drinks:5800"
    "payment_breakdown",   # encoded "cash:4200|card:13500"
    "closed_by", "closed_at",
    "unlock_reason", "unlocked_by", "unlocked_at",
    "notes",
]
# Back-compat name for the machine variant's documented column set.
_CSV_COLUMNS = _MACHINE_CSV_COLUMNS

# Fixed revisor columns, in order. Category columns ("Kategori: Mad" …) follow
# after these, built-in categories first in the app's order, then the owner's
# own, then "Kategori: Ikke fordelt".
# "Bilagsnr." is the day's own kasserapport number (KR-…) and "Dokument-id"
# the id printed on that kasserapport — so every row ties to the voucher the
# revisor holds. "Bogføring" is the kasserapport's own verdict, word for word.
_REVISOR_CSV_COLUMNS_DA = [
    "Dato", "Bilagsnr.", "Dokument-id", "Status", "Bogføring", "Afdeling",
    "Omsætning inkl. moms", "Salgsmoms", "Omsætning ekskl. moms", "Momsopgørelse",
    "Kontant", "Kort", "MobilePay", "Gavekort", "Bankoverførsel", "Andre betalinger",
    "Betalinger i alt",
    "Forventet kontant", "Optalt kontant (uden byttepenge)", "Kassedifference",
    "Drikkepenge", "Antal medarbejdere", "Drikkepenge pr. medarbejder",
    "Kilde", "Lukket af", "Låst (dansk tid)", "Historik", "Bemærkninger",
]
_REVISOR_CSV_COLUMNS_EN = [
    "Date", "Voucher no.", "Document ID", "Status", "Bookkeeping", "Branch",
    "Revenue incl. VAT", "Salgsmoms", "Revenue excl. VAT", "VAT basis",
    "Cash", "Card", "MobilePay", "Gavekort", "Bank transfer", "Other payments",
    "Payments total",
    "Expected cash", "Counted cash (float taken off)", "Cash difference",
    "Tips", "Staff count", "Tips per person",
    "Source", "Closed by", "Locked (local time)", "History", "Notes",
]


def _opt(v):
    """Machine variant: optional float as fixed 2-decimal dot, or ""."""
    if v is None:
        return ""
    return f"{float(v):.2f}"


def _dk_num(v) -> str:
    """Revisor variant: optional amount as Danish Excel reads a NUMBER —
    decimal comma, no thousands separator ("15021,00", "-180,00")."""
    if v is None:
        return ""
    try:
        n = float(v)
    except (TypeError, ValueError):
        return ""
    if abs(n) < 0.005:
        n = 0.0
    return f"{n:.2f}".replace(".", ",")


def _en_num(v) -> str:
    if v is None:
        return ""
    try:
        return f"{float(v):.2f}"
    except (TypeError, ValueError):
        return ""


def to_local(dt, tz=None):
    """closed_at / unlocked_at are stored as naive UTC. Every artifact prints
    them in the venue's time (Europe/Copenhagen unless the caller passes the
    owner's zone) — the app and the e-mail already did; the PDF, Excel and CSV
    printed raw UTC, two hours and sometimes a calendar day apart."""
    if dt is None:
        return None
    try:
        from datetime import timezone as _tz
        from zoneinfo import ZoneInfo
        zone = tz or ZoneInfo("Europe/Copenhagen")
        aware = dt if dt.tzinfo else dt.replace(tzinfo=_tz.utc)
        return aware.astimezone(zone)
    except Exception:  # noqa: BLE001
        return dt


def dk_datetime(dt, tz=None, *, danish: bool = True) -> str:
    """'26.09.2026 kl. 01:28' — the one Danish date+time style."""
    loc = to_local(dt, tz)
    if loc is None:
        return ""
    return loc.strftime("%d.%m.%Y kl. %H:%M") if danish else loc.strftime("%d %b %Y %H:%M")


_BUILTIN_CAT_ORDER = [
    "food", "drinks", "takeaway", "bread_pastry", "groceries", "fresh",
    "products", "retail_products", "services", "treatments", "parts", "labor",
    "diagnostics", "towing", "tobacco_lottery", "online_sales", "shipping",
    "returns", "returns_refunds", "revenue", "other",
]


def _category_amounts(c) -> tuple[dict, float | None]:
    """{folded_key: amount} for one close, plus the part of its revenue no
    category carries — the whole revenue when it has no breakdown at all, so
    the category columns always add back to Omsætning. Keys are folded
    case-insensitively — 'Food' and 'food' are one category."""
    raw = decode_breakdown(getattr(c, "revenue_categories", None)) or {}
    out: dict = {}
    for k, v in raw.items():
        key = (k or "").strip()
        fold = key.lower() if key.lower() in _BUILTIN_CAT_ORDER else key
        out[fold] = round(out.get(fold, 0.0) + float(v or 0), 2)
    unsplit = round(float(getattr(c, "revenue_total", 0) or 0) - sum(out.values()), 2)
    return out, (unsplit if abs(unsplit) >= 0.005 else 0.0)


def category_columns(closes) -> list:
    """The category keys found in a range, in a STABLE order: built-ins in the
    app's order, then owner-typed names alphabetically."""
    seen: set = set()
    for c in closes:
        seen.update(_category_amounts(c)[0].keys())
    builtin = [k for k in _BUILTIN_CAT_ORDER if k in seen]
    custom = sorted((k for k in seen if k not in _BUILTIN_CAT_ORDER), key=str.lower)
    return builtin + custom


def _row_history(c, history: dict | None, tz, danish: bool) -> str:
    """The close's unlock history: from the audit trail when the router passed
    it, else from the row's own unlock fields (a close that is unlocked right
    now still carries them)."""
    cid = str(getattr(c, "id", "") or "")
    if history and history.get(cid):
        return history[cid]
    reason = getattr(c, "unlock_reason", None)
    if not reason:
        return ""
    from app.services.close_history import actor_display
    who = actor_display(getattr(c, "unlocked_by", None), danish=danish)
    when = dk_datetime(getattr(c, "unlocked_at", None), tz, danish=danish)
    if danish:
        return f"Låst op {when}" + (f" af {who}" if who else "") + f" — årsag: {reason}"
    return f"Unlocked {when}" + (f" by {who}" if who else "") + f" — reason: {reason}"


def closes_to_csv_bytes(
    closes: list[DailyClose],
    *,
    currency: str = "DKK",
    variant: str = "revisor",
    tz=None,
    history: dict | None = None,
    branch_names: dict | None = None,
    sources: dict | None = None,
) -> bytes:
    """Serialize closes to CSV (UTF-8 BOM, ";" delimiter).

    `variant="revisor"` (default) — Danish headers and decimal comma for a DKK
    owner, a totals row over LOCKED closes only, no internal ids.
    `variant="machine"` — the raw shape for imports, only on explicit request.
    `history` / `branch_names` / `sources` are optional per-close strings the
    router derives (unlock history from the audit trail, branch names, the
    figures' source) keyed by str(close.id) / str(branch_id).
    """
    buf = io.StringIO()
    buf.write("﻿")
    writer = csv.writer(buf, delimiter=";")

    if variant == "machine":
        writer.writerow(_MACHINE_CSV_COLUMNS)
        for c in closes:
            writer.writerow([
                c.date.isoformat() if c.date else "",
                csv_safe(getattr(c, "status", "") or ""),
                _opt(c.revenue_total),
                _opt(c.revenue_ex_moms),
                _opt(c.moms_total),
                csv_safe(getattr(c, "moms_mode", "") or ""),
                _opt(c.payment_total),
                _opt(c.cash_expected),
                _opt(c.cash_counted),
                _opt(c.cash_difference),
                _opt(c.tips_total),
                c.tips_staff_count if c.tips_staff_count is not None else "",
                _opt(c.tips_per_person),
                csv_safe(c.revenue_categories or ""),
                csv_safe(c.payment_categories or ""),
                csv_safe(c.closed_by or ""),
                c.closed_at.isoformat() if c.closed_at else "",
                csv_safe(getattr(c, "unlock_reason", "") or ""),
                csv_safe(getattr(c, "unlocked_by", "") or ""),
                (c.unlocked_at.isoformat() if getattr(c, "unlocked_at", None) else ""),
                csv_safe(c.notes or ""),
            ])
        return buf.getvalue().encode("utf-8")

    DA = (currency or "").upper() == "DKK"
    num = _dk_num if DA else _en_num
    from app.services.close_category_labels import revenue_category_label

    cats = category_columns(closes)
    cat_prefix = "Kategori: " if DA else "Category: "
    header = list(_REVISOR_CSV_COLUMNS_DA if DA else _REVISOR_CSV_COLUMNS_EN)
    header += [cat_prefix + revenue_category_label(k, danish=DA) for k in cats]
    header += [cat_prefix + ("Ikke fordelt" if DA else "Not allocated")]
    writer.writerow(header)

    sorted_closes = sorted(closes, key=lambda c: c.date or date.min)
    for c in sorted_closes:
        pay = _bucketed_payments(c)
        unknown = moms_is_unknown(c)
        moms = None if unknown else float(c.moms_total or 0)
        net = _net_of(c)
        amounts, unsplit = _category_amounts(c)
        cid = str(getattr(c, "id", "") or "")
        bname = (branch_names or {}).get(str(c.branch_id), "") if c.branch_id else ""
        row = [
            c.date.isoformat() if c.date else "",
            close_voucher_no(c, branch_names),
            close_doc_id(c),
            status_label(c, DA),
            csv_safe(readiness_text(c, currency)),
            csv_safe(bname),
            num(c.revenue_total),
            num(moms),
            num(net),
            # The same label the day's kasserapport and the lock mail print.
            moms_basis_text(c, currency),
            num(pay["cash"] or None), num(pay["card"] or None),
            num(pay["mobilepay"] or None), num(pay["gift_card"] or None),
            num(pay["bank_transfer"] or None), num(pay["other"] or None),
            num(c.payment_total),
            num(c.cash_expected), num(c.cash_counted), num(c.cash_difference),
            num(c.tips_total),
            c.tips_staff_count if c.tips_staff_count is not None else "",
            num(c.tips_per_person),
            csv_safe((sources or {}).get(cid, "")),
            csv_safe(c.closed_by or ""),
            dk_datetime(c.closed_at, tz, danish=DA) if _is_confirmed(c) else "",
            csv_safe(_row_history(c, history, tz, DA)),
            csv_safe(c.notes or ""),
        ]
        row += [num(amounts.get(k)) if k in amounts else "" for k in cats]
        row += [num(unsplit) if unsplit else ""]
        writer.writerow(row)

    if sorted_closes:
        t = period_totals(closes)
        tot_label = totals_label(t["n_confirmed"], DA)
        if t["n_drafts"]:
            tot_label += (
                f" ({t['n_drafts']} {'kladde' if t['n_drafts'] == 1 else 'kladder'} ikke medregnet)"
                if DA else f" ({t['n_drafts']} draft(s) not counted)"
            )
        total_row = [
            "", "", "", tot_label, "", "",
            num(t["revenue"]), num(t["moms"]), num(t["net"]), "",
            num(t["cash"]), num(t["card"]), num(t["mobilepay"]),
            num(t["gift_card"]), num(t["bank_transfer"]), num(t["other"]),
            num(t["payment_total"]),
            num(t["cash_expected"]), num(t["cash_counted"]), num(t["cash_difference"]),
            num(t["tips"]), "", "",
            "", "", "", "", "",
        ]
        total_row += [num(t["categories"].get(k, 0.0)) for k in cats]
        total_row += [num(t["unallocated"]) if t["unallocated"] else ""]
        writer.writerow(total_row)
    return buf.getvalue().encode("utf-8")


# ─── Per-day identity, MOMS label and verdict — shared by all three ───

def close_voucher_no(c, branch_names: dict | None = None) -> str:
    """The day's own kasserapport bilag number (KR-YYYYMMDD[-branch]) — the
    number its kasserapport prints, computed the same way (branch name from
    the same lookup)."""
    from app.services.close_kasserapport_pdf import close_bilagsnummer
    if getattr(c, "date", None) is None:
        return ""
    bname = ((branch_names or {}).get(str(c.branch_id))
             if getattr(c, "branch_id", None) else None)
    return close_bilagsnummer(c, bname)


def close_doc_id(c) -> str:
    """The Dokument-id printed on that day's kasserapport (this version)."""
    from app.services.close_kasserapport_pdf import close_document_id
    try:
        return close_document_id(c)
    except Exception:  # noqa: BLE001
        return ""


def period_document_id(closes, from_date: date, to_date: date) -> str:
    """A stable 16-hex id for a period export: the period plus the Dokument-id
    of every close it lists. The same closes in the same state give the same
    id on every download and in the mail — a hash of the bytes changed with
    the generation time printed in the footer."""
    import hashlib
    ids = sorted(f"{c.date.isoformat() if c.date else ''}:{close_doc_id(c)}" for c in closes)
    raw = "|".join([from_date.isoformat(), to_date.isoformat(), *ids]).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def moms_basis_text(c, currency: str = "DKK") -> str:
    """The Momsopgørelse cell: the day's MOMS label (kasserapport_claims.
    moms_label), or that it cannot be stated."""
    from app.services.kasserapport_claims import moms_label
    DA = (currency or "").upper() == "DKK"
    if moms_is_unknown(c):
        return "Salgsmoms kan ikke opgøres" if DA else "Output VAT cannot be stated"
    return moms_label(c, currency)


def readiness_text(c, currency: str = "DKK") -> str:
    from app.services.kasserapport_claims import readiness_text as _rt
    try:
        return _rt(c, currency)
    except Exception:  # noqa: BLE001
        return ""


def totals_label(n: int, danish: bool) -> str:
    """'I alt — 26 låste dage' (it read 'I alt (låste) (26)')."""
    if danish:
        return f"I alt — {n} {'låst dag' if n == 1 else 'låste dage'}"
    return f"Total — {n} locked {'day' if n == 1 else 'days'}"


def period_readiness(closes, currency: str = "DKK") -> dict:
    """{"n_locked", "ready": [closes], "review": [closes]} — each LOCKED close
    judged by its own kasserapport's rule (close_readiness). The period PDF
    badge and the period mail read this, so neither can disagree with the
    day's own document."""
    from app.services.kasserapport_claims import close_readiness
    ready, review = [], []
    for c in sorted(closes, key=lambda c: c.date or date.min):
        if not _is_confirmed(c):
            continue
        try:
            ok = bool(close_readiness(c, currency)["ready"])
        except Exception:  # noqa: BLE001
            ok = False
        (ready if ok else review).append(c)
    return {"n_locked": len(ready) + len(review), "ready": ready, "review": review}


def all_standard_auto(closes, currency: str = "DKK") -> bool:
    """True when every listed close's MOMS label is the plain standard one —
    BonBox-calculated at the standard rate. Only then may a period column or
    total say "Salgsmoms (25 %)" and the footer cite the statutory basis."""
    from app.services.kasserapport_claims import moms_label, standard_moms_label
    std = standard_moms_label(currency)
    return all(moms_label(c, currency) == std for c in closes if not moms_is_unknown(c))


# ─── Helpers shared by PDF + XLSX ─────────────────────────────────────

# Payment-method buckets we surface as their own columns in PDF + XLSX.
# Anything unrecognized rolls into "other" so the totals still tie out.
_PAY_BUCKETS = ["cash", "card", "mobilepay", "gift_card", "bank_transfer"]

# Card-brand / scheme splits are a BREAKDOWN of the `card` line, not extra
# methods — they ride along in payment_categories for accountant fidelity but
# summing them would double-count the card total. Mirrors the write-side
# invariant `_CARD_BREAKDOWN_KEYS` in routers/daily_close.py (the close UI
# shows brands UNDER the card line, never adding). Excluded from every bucket
# so _payments_sum() ties out to revenue for a normal terminal close.
_CARD_BRAND_KEYS = {"dankort", "visa", "mastercard", "softpay", "betalingskort"}


def _bucketed_payments(c: DailyClose) -> dict:
    """Decode encoded payment_categories into known buckets + 'other'.

    Card-brand scheme keys (dankort/visa/…) are dropped — they are a split of
    the `card` line, so counting them would inflate payments past revenue and
    false-flag reconciliation on the most common DK terminal close."""
    out = {k: 0.0 for k in _PAY_BUCKETS}
    out["other"] = 0.0
    raw = decode_breakdown(c.payment_categories) or {}
    for k, v in raw.items():
        try:
            amt = float(v or 0)
        except (TypeError, ValueError):
            continue
        norm = (k or "").lower().replace(" ", "_").replace("-", "_")
        if norm in _CARD_BRAND_KEYS:
            continue  # brand split of the card line — never add it on top
        # Danish ⟷ English payment-method synonyms. The write side persists
        # English keys (cash/card/mobilepay — see routers/daily_close.py:1565
        # kontant→cash, dankort→card; defensive "kontant" in pb at :893), but
        # manually-edited / legacy / imported closes can still carry Danish
        # spellings. Without this map kontant/kort fell into "other" and
        # vanished from the table's Kontant/Kort columns while still summing
        # into _payments_sum — so the reconciliation badge read "✓ afstemt"
        # above a table that visibly did NOT tie out. Normalize so every
        # spelling lands in the right visible column.
        norm = {
            "kontant": "cash",
            "kort": "card",
            # NB: "betalingskort" is intentionally NOT mapped here — it is a
            # card-brand split (in _CARD_BRAND_KEYS above) and is dropped
            # before reaching this map, never added on top of the card line.
            "mobile_pay": "mobilepay",
            "mobilepay_total": "mobilepay",
            "gavekort": "gift_card",
            "giftcard": "gift_card",
            "gift_cards": "gift_card",
            "bankoverforsel": "bank_transfer",
            "bankoverførsel": "bank_transfer",
            "bank_overforsel": "bank_transfer",
            "overforsel": "bank_transfer",
        }.get(norm, norm)
        if norm in _PAY_BUCKETS:
            out[norm] += amt
        else:
            out["other"] += amt
    return out


def _payments_sum(c: DailyClose) -> float:
    """Total of EVERY decoded payment bucket for a close — including the ones
    the PDF's narrow column set hides (gift_card / bank_transfer / other).

    This is the number that must tie out to ``revenue_total`` for a close to be
    bookkeeping-ready: every krone of revenue is collected by some method, so
    the methods must sum to the revenue. The per-close PDF reconciliation and
    the readiness badge both key on it."""
    return sum(_bucketed_payments(c).values())


# Per-row tie-out tolerance: a single close row whose decoded payments differ
# from its revenue by more than this (in kr) is FLAGGED inline in both the PDF
# and the XLSX — drafts included. 0.5 kr absorbs øre rounding but catches the
# real "Kort 1.850 vs Omsætning 1.070" (780 kr) mismatch the export must never
# present silently. Mirrors the aggregate RECON_TOL used below.
ROW_TIE_OUT_TOL = 0.50


def _row_ties_out(c: DailyClose) -> bool:
    """True when this close's decoded payments tie out to its revenue within
    ROW_TIE_OUT_TOL — OR when there are no reconcilable payment methods at all
    (a revenue-only / scan-and-lock close has nothing to tie out, so it is not
    flagged). False means: payments were recorded AND they do not match revenue
    → the row must carry the inline mismatch flag."""
    if not _has_reconcilable_payments(c):
        return True
    return abs(_payments_sum(c) - float(c.revenue_total or 0)) <= ROW_TIE_OUT_TOL


def _has_reconcilable_payments(c: DailyClose) -> bool:
    """True only when the close actually recorded payment-method amounts that
    sum to something. A revenue-only close (scan-and-lock / Z-report bottom
    line with no method split) or one carrying only card-brand splits has
    NOTHING to tie out — reconciling it would falsely flag the whole day's
    revenue as an 'Afvigelse' and wrongly drop a book-ready close to review."""
    return _payments_sum(c) > 0.005


# The one-line address composer that never double-prints the city now lives in
# bonbox_pdf_kit (every other artifact hand-rolled the same join — and the same
# "…, 2500 Valby, 2500 Valby" defect). Re-exported here so the existing callers
# and tests in this module keep their import path.
from app.services.bonbox_pdf_kit import compose_business_address  # noqa: E402,F401
# ONE predicate for "this close's salgsmoms cannot be stated", shared with the
# per-close kasserapport. Without it the two artifacts disagreed about the same
# stored row: "—" on the close's own document, a confident number in the period
# total a revisor files from.
from app.services.kasserapport_claims import moms_is_unknown  # noqa: E402


def _net_of(c) -> float | None:
    """Revenue ex. MOMS for one close, or None when its MOMS cannot be stated
    (a net built by subtracting an unknown VAT hands the missing figure back)."""
    if moms_is_unknown(c):
        return None
    if getattr(c, "revenue_ex_moms", None) is not None:
        return float(c.revenue_ex_moms)
    return float(getattr(c, "revenue_total", 0) or 0) - float(getattr(c, "moms_total", 0) or 0)


def period_totals(closes) -> dict:
    """THE period totals — one source of truth for the range PDF's KPI band and
    totals row, the Excel Oversigt sheet and totals row, the CSV totals row and
    the e-mail body that delivers them.

    They used to be summed four times in four places. The Excel totals row was
    a plain SUM over every row — the draft included — under the label
    "I alt (bekræftede)", so the attachment disagreed with its own summary
    sheet, the PDF and the e-mail by a whole day's revenue.

    LOCKED closes only. Drafts are counted (n_drafts) so every artifact can say
    "N kladder ikke medregnet", but never summed. MOMS and net are None when
    any locked close's MOMS cannot be stated (the shared predicate)."""
    confirmed = [c for c in closes if _is_confirmed(c)]
    drafts = [c for c in closes if not _is_confirmed(c)]
    moms_unknown = [c for c in confirmed if moms_is_unknown(c)]

    def _sum(vals):
        return round(sum(float(v) for v in vals if v is not None), 2)

    def g(c, attr):
        return getattr(c, attr, None)

    buckets = {k: 0.0 for k in _PAY_BUCKETS}
    buckets["other"] = 0.0
    for c in confirmed:
        for k, v in _bucketed_payments(c).items():
            buckets[k] = round(buckets[k] + v, 2)

    categories: dict = {}
    unallocated = 0.0
    for c in confirmed:
        amounts, unsplit = _category_amounts(c)
        for k, v in amounts.items():
            categories[k] = round(categories.get(k, 0.0) + v, 2)
        unallocated = round(unallocated + unsplit, 2)

    def _opt_sum(attr):
        vals = [getattr(c, attr, None) for c in confirmed]
        return _sum(vals) if any(v is not None for v in vals) else None

    return {
        "confirmed": confirmed,
        "drafts": drafts,
        "n_confirmed": len(confirmed),
        "n_drafts": len(drafts),
        "moms_unknown_count": len(moms_unknown),
        "revenue": _sum(g(c, "revenue_total") for c in confirmed),
        "moms": None if moms_unknown else _sum(g(c, "moms_total") for c in confirmed),
        "net": None if moms_unknown else _sum(_net_of(c) for c in confirmed),
        "tips": _sum(g(c, "tips_total") for c in confirmed),
        "payment_total": _sum(g(c, "payment_total") for c in confirmed),
        **buckets,
        "cash_expected": _opt_sum("cash_expected"),
        "cash_counted": _opt_sum("cash_counted"),
        "cash_difference": _opt_sum("cash_difference"),
        "categories": categories,
        "unallocated": unallocated,
    }


def _fmt_kr(v, currency: str = "DKK") -> str:
    """Render a money value as the PDF's canonical Danish string ("1.850,00
    kr."). Wraps the gold money_dk formatter (same one the PDF/MOMS artifacts
    use) so the XLSX tie-out note text matches the PDF byte-for-byte. Imported
    lazily — keeps this module import-light and mirrors the PDF builder, which
    also imports money_dk inside the function."""
    from app.services.bonbox_pdf_kit import money_dk
    return money_dk(v, currency)


def _voucher_ranges(db: Session, user_id, dt: date) -> tuple[str, str]:
    """Return (sales_label, expense_label) bilagsnummer range for a day.

    Empty strings if no vouchers were recorded for that date. The PDF and
    XLSX print these so the accountant can cross-check each row against the
    underlying voucher numbers — but they fetch them for the whole period at
    once with `_voucher_ranges_by_date`. This one-day form is the reference
    the period form is tested against (same filter, same labels)."""
    if db is None or dt is None:
        return ("", "")
    try:
        from app.models.sale import Sale
        from app.models.expense import Expense
        smin, smax = (
            db.query(func.min(Sale.voucher_number), func.max(Sale.voucher_number))
            .filter(
                Sale.user_id == user_id,
                Sale.date == dt,
                Sale.voucher_number.is_not(None),
                Sale.is_deleted.isnot(True),
            )
            .one_or_none() or (None, None)
        )
        emin, emax = (
            db.query(func.min(Expense.voucher_number), func.max(Expense.voucher_number))
            .filter(
                Expense.user_id == user_id,
                Expense.date == dt,
                Expense.voucher_number.is_not(None),
                Expense.is_deleted.isnot(True),
            )
            .one_or_none() or (None, None)
        )
    except Exception:
        return ("", "")

    return (
        _voucher_label("S", smin, smax, dt.year),
        _voucher_label("E", emin, emax, dt.year),
    )


def _voucher_label(prefix, lo, hi, year) -> str:
    """"S-2026-0002" for one voucher, "S-2026-0002 → S-2026-0004" for a range,
    "" for none — the one formatter both voucher-range paths print with."""
    if lo is None:
        return ""
    if lo == hi:
        return f"{prefix}-{year}-{lo:04d}"
    return f"{prefix}-{year}-{lo:04d} → {prefix}-{year}-{hi:04d}"


def _voucher_ranges_by_date(
    db: Session | None, user_id, dates, *, expenses: bool = True,
) -> dict:
    """{date: (sales_label, expense_label)} for every date in `dates` — the
    same labels `_voucher_ranges` gives one day at a time, from ONE grouped
    query per table instead of two queries per day.

    The period PDF and Excel used to call `_voucher_ranges` once per close,
    and the PDF did it inside the story builder, which the two-pass render
    runs twice: a month cost ~110 round trips and grew with every day in the
    range. The filter is the per-day one with `date == d` widened to
    `date IN (the closes' dates)`, grouped by date, so every day gets exactly
    the min/max it got before. Dates with no vouchers are present with "".

    `expenses=False` skips the expense query for a caller that never prints
    it (the PDF shows only the sales range). Fail-soft like the per-day form:
    on a query error every day reads "" rather than breaking the export."""
    days = {d for d in (dates or ()) if d is not None}
    if db is None or not days:
        return {}
    try:
        from app.models.sale import Sale
        from app.models.expense import Expense

        def _grouped(model) -> dict:
            rows = (
                db.query(
                    model.date,
                    func.min(model.voucher_number),
                    func.max(model.voucher_number),
                )
                .filter(
                    model.user_id == user_id,
                    model.date.in_(sorted(days)),
                    model.voucher_number.is_not(None),
                    model.is_deleted.isnot(True),
                )
                .group_by(model.date)
                .all()
            )
            return {d: (lo, hi) for d, lo, hi in rows}

        sales = _grouped(Sale)
        exps = _grouped(Expense) if expenses else {}
    except Exception:
        return {d: ("", "") for d in days}

    return {
        d: (
            _voucher_label("S", *sales.get(d, (None, None)), d.year),
            _voucher_label("E", *exps.get(d, (None, None)), d.year),
        )
        for d in days
    }


# ─── PDF ──────────────────────────────────────────────────────────────

def build_daily_close_range_pdf(
    closes: list[DailyClose],
    *,
    from_date: date,
    to_date: date,
    business_name: str = "",
    currency: str = "DKK",
    profile=None,
    db: Session | None = None,
    user_id=None,
    bilagsnummer: str = "",
    tz=None,
    branch_names: dict | None = None,
    history: dict | None = None,
    sources: dict | None = None,
) -> bytes:
    """Build a multi-day daily-close PDF report — accountant-grade.

    What this PDF gives the accountant:
      • Business identity header (company_name, CVR, address, period)
      • One row per close: Date, Bilag, Revenue, MOMS (25%), Net,
                            Cash, Card, MobilePay, Cash diff, Status
      • Totals row (excludes Draft closes — only confirmed closes count)
      • Readiness badge: "X af Y closes klar til bogføring"
      • Footer cites Bogføringsloven §10 + Momsbekendtgørelsen §57

    Localized for DKK (Danish labels), else English.
    """
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        Paragraph, Spacer, Table, TableStyle, HRFlowable, KeepTogether,
    )

    from app.services.bonbox_pdf_kit import escape_pdf_text, money_dk, render_with_doc_hash
    from app.services.close_kasserapport_pdf import generated_local
    from app.services.kasserapport_claims import moms_label, standard_moms_label
    from app.utils.document_hash import get_software_identifier

    DA = (currency == "DKK")

    L = {
        "title":       "Kasserapport" if DA else "Daily Close",
        "period":      "Periode" if DA else "Period",
        "closes":      "lukninger" if DA else "closes",
        "close_one":   "lukning" if DA else "close",
        "across_days": "over" if DA else "across",
        "days":        "dage" if DA else "days",
        "day_one":     "dag" if DA else "day",
        # Header summary — count confirmed closes and drafts separately so a
        # single Kladde never reads as "1 lukning" (which implies a booked,
        # confirmed close). "bekræftede" + "kladde(r)" keep the distinction
        # honest for the revisor.
        "confirmed_word":   "låste" if DA else "locked",
        "confirmed_one":    "låst" if DA else "locked",
        "draft_word":       "kladde" if DA else "draft",
        "drafts_word":      "kladder" if DA else "drafts",
        "amounts_in":  "Alle beløb i" if DA else "All amounts in",
        "no_closes":   "Ingen lukninger i denne periode." if DA else "No daily closes in this range.",
        # KPI band labels (kept short for the 4-up grid)
        "kpi_rev":     "Omsætning" if DA else "Revenue",
        "kpi_moms":    "Salgsmoms" if DA else "Output VAT",
        "kpi_net":     "Netto (uden moms)" if DA else "Net (excl. VAT)",
        "kpi_tips":    "Drikkepenge" if DA else "Tips",
        # Table headers
        "h_date":      "Dato" if DA else "Date",
        "h_bilag":     "Bilag" if DA else "Voucher",
        "h_rev":       "Omsætning" if DA else "Revenue",
        # The column header follows the ONE label rule: "Salgsmoms (25 %)"
        # only while every row IS a BonBox-calculated standard-rate figure.
        "h_moms":      standard_moms_label(currency),
        "h_net":       "Netto" if DA else "Net",
        "h_cash":      "Kontant" if DA else "Cash",
        "h_card":      "Kort" if DA else "Card",
        "h_mobilepay": "MobilePay" if DA else "MobilePay",
        "h_gift":      "Gavekort" if DA else "Gavekort",
        "h_other":     "Øvrige" if DA else "Other",
        "h_diff":      "Kassediff." if DA else "Diff",
        "h_status":    "Status" if DA else "Status",
        # Status badges — the same words as the Excel and the CSV
        "locked":      "Låst" if DA else "Locked",
        "draft":       "Kladde" if DA else "Draft",
        # Per-row tie-out footnote — explains the "!" marker that flags any row
        # whose payments do not equal its revenue (drafts included). The "!" is
        # rendered as a bold amber glyph; this text is the explanation after it.
        # The kasserapport must never present a non-tying row silently.
        "row_flag_note": (
            "betalinger stemmer ikke med omsætning"
            if DA else
            "payments do not match revenue"
        ),
        "relocked":    "genlåst" if DA else "relocked",
        "src_title":   ("Kilde, salgsmoms og historik pr. dag" if DA
                        else "Source, VAT and history per day"),
        "src_summary": "Kilde" if DA else "Source",
        "src_days":    "dage" if DA else "days",
        "src_day":     "dag" if DA else "day",
        "src_none":    "ikke registreret" if DA else "not recorded",
        "draft_excl":  "Kladder ikke medregnet" if DA else "Drafts not summed",
        # Readiness — the SAME rule as each close's own kasserapport
        # (kasserapport_claims), read the right way round.
        "ready":       "klar til bogføring" if DA else "ready for booking",
        "review":      "skal gennemgås" if DA else "need review",
        "of":          "af" if DA else "of",
        "ready_rule":  ("klar = salgsmoms opgjort og lig med 25 % (eller 0 %), kontant "
                        "optalt inden for ±100 kr., betalinger stemmer, og linjerne "
                        "modsiger ikke totalen; omsætning uden kategori er en note — "
                        "samme regel som på hver kasserapport"
                        if DA else
                        "ready = VAT stated at the standard rate (or 0 %), cash counted within "
                        "±100 kr., payments agree and no line contradicts the total; "
                        "revenue without a category is a note — the same rule as each "
                        "kasserapport"),
        # Kasseafstemning: optalt − forventet = difference (the app's sign)
        "kasse_title":  "Kasseafstemning" if DA else "Cash reconciliation",
        "kasse_over":   "for meget i kassen" if DA else "over",
        "kasse_short":  "kassen mangler" if DA else "short",
        "dist_title":   "Fordeling i perioden (låste)" if DA else "Split for the period (locked)",
        "dist_rev":     "Omsætning pr. kategori" if DA else "Revenue per category",
        "dist_pay":     "Betalinger pr. metode" if DA else "Payments per method",
        "unallocated":  "Ikke fordelt" if DA else "Not allocated",
        "kasse_exp":    "forventet" if DA else "expected",
        "kasse_cnt":    "optalt" if DA else "counted",
        # Document voucher number (header) — matches the gold MOMS-PDF label
        "bilag_label": "Bilagsnr" if DA else "Voucher",
        # Payments ↔ revenue reconciliation (accountant-grade)
        "recon_ok":    "Betalinger afstemt med omsætning" if DA else "Payments reconciled to revenue",
        "recon_off":   "Betalinger stemmer ikke med omsætning" if DA else "Payments do not reconcile to revenue",
        "recon_pay":   "Betalinger" if DA else "Payments",
        "recon_rev":   "Omsætning" if DA else "Revenue",
        "recon_delta": "Afvigelse" if DA else "Difference",
        "recon_review": ("lukning(er) skal gennemgås før bogføring"
                         if DA else "close(s) need review before booking"),
        # Signature line (two-person control, Bogføringsloven §10)
        "sig_counted":  "Optalt af" if DA else "Counted by",
        "sig_approved": "Godkendt af" if DA else "Approved by",
        "sig_date":     "Dato" if DA else "Date",
        # Footer. TWO variants: the §57 sentence asserts that BonBox CALCULATED
        # the sales VAT per the statute. That is only true when every included
        # close was auto-calculated — a manually keyed or scanned moms_total is
        # the owner's number, not ours, and claiming a statutory basis over it
        # is exactly the kind of overclaim an accountant-grade artifact must not
        # make. `footer_law_mixed` drops the claim and says nothing else; it is
        # deliberately NOT a warning (the document must not look broken).
        "footer_law":  (
            "Genereret af BonBox · Opbevares i 5 år efter bogføringsloven. "
            "Salgsmoms beregnet pr. Momsbekendtgørelsen §57."
        ) if DA else (
            "Generated by BonBox · Keep for 5 years under the Danish Bookkeeping Act. "
            "VAT computed per Momsbekendtgørelsen §57."
        ),
        "footer_law_mixed": (
            "Genereret af BonBox · Opbevares i 5 år efter bogføringsloven. "
            "Salgsmoms som indtastet/aflæst pr. lukning."
        ) if DA else (
            "Generated by BonBox · Keep for 5 years under the Danish Bookkeeping Act. "
            "Sales VAT as entered/scanned per close."
        ),
        # Generic MOMS header — used instead of "Moms 25%" whenever any included
        # row's VAT is not the standard rate, so the column heading can never
        # describe a number it doesn't fit.
        "h_moms_generic": "Salgsmoms" if DA else "Output VAT",
        # Quiet totals note: the payment columns legitimately exclude closes that
        # recorded revenue with no method split (see _row_ties_out). Without this
        # line a reader adds the columns, finds a gap, and has no explanation.
        "totals_excl_note": (
            "Betalingskolonner medregner ikke lukninger uden betalingsfordeling"
            if DA else
            "Payment columns exclude closes with no payment split"
        ),
        # A period total built over closes whose salgsmoms was never computed is
        # not a total — it is an understatement with no warning on it. The KPI
        # renders "—" and this sentence says how many closes are behind it.
        "moms_unknown_note": (
            "Salgsmoms i alt kan ikke opgøres: {n} bekræftet(e) lukning(er) har "
            "ingen momsopgørelse. Se kolonnen Moms nedenfor."
            if DA else
            "Total output VAT cannot be stated: {n} confirmed close(s) have no "
            "VAT figure. See the VAT column below."
        ),
    }

    # Sort ascending so the report reads chronologically.
    closes_sorted = sorted(closes, key=lambda c: c.date or date.min)

    # Bilag (sales voucher range) per day, fetched ONCE here — outside
    # _make_story, which the two-pass render runs twice — with one grouped
    # query, so the query count no longer grows with the days in the range.
    voucher_by_date = _voucher_ranges_by_date(
        db, user_id, [c.date for c in closes_sorted], expenses=False,
    )

    # Danish-style date for header period
    if DA:
        _MM = ["jan", "feb", "mar", "apr", "maj", "jun",
               "jul", "aug", "sep", "okt", "nov", "dec"]
        def _date_short(d):
            return f"{d.day}. {_MM[d.month - 1]} {d.year}" if d else ""
    else:
        def _date_short(d):
            return d.strftime("%d %b %Y") if d else ""

    # ─── Provenance footer inputs (computed ONCE, before rendering) ──────
    # All fail-soft: footer derivation must never break the PDF. One clock:
    # the venue's, like every lock time in the table.
    software_id = get_software_identifier()
    generated_at_str = generated_local(tz, danish=DA)

    # Per-day facts the table and the source block print — derived once, out
    # of the two-pass story builder, with no query of their own.
    row_label = {id(c): moms_label(c, currency) for c in closes_sorted}
    std_label = standard_moms_label(currency)
    vno = {id(c): close_voucher_no(c, branch_names) for c in closes_sorted}
    dids = {id(c): close_doc_id(c) for c in closes_sorted}
    readiness = period_readiness(closes_sorted, currency)
    ready_ids = {id(c) for c in readiness["ready"]}
    # No login e-mail on a document that goes to a third party (the revisor
    # does not need the owner's sign-in address; the business is named above).
    generator_email = ""

    INK = colors.HexColor("#171717")
    MUTED = colors.HexColor("#6b7280")
    DIVIDER = colors.HexColor("#e5e7eb")
    EMERALD = colors.HexColor("#065f46")
    AMBER = colors.HexColor("#92400e")
    EMERALD_BG = colors.HexColor("#d1fae5")
    AMBER_BG = colors.HexColor("#fef3c7")

    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("H1", parent=styles["Heading1"], fontSize=15,
                        textColor=INK, fontName="Helvetica-Bold",
                        leading=18, spaceAfter=2)
    subtitle = ParagraphStyle("Sub", parent=styles["Normal"], fontSize=9,
                              textColor=MUTED, leading=12, spaceAfter=6)
    section = ParagraphStyle("Sect", parent=styles["Normal"], fontSize=8,
                             textColor=MUTED, fontName="Helvetica-Bold",
                             leading=11, spaceBefore=8, spaceAfter=2)
    note = ParagraphStyle("Note", parent=styles["Normal"], fontSize=8,
                          textColor=MUTED, fontName="Helvetica-Oblique",
                          leading=11)
    # Centered cell style for the Status column when it carries the inline "!"
    # tie-out marker (a Paragraph, not a bare string, so the "!" can be amber).
    status_style = ParagraphStyle("Status", parent=styles["Normal"], fontSize=8.5,
                                  textColor=INK, fontName="Helvetica",
                                  leading=10, alignment=1)  # 1 = TA_CENTER

    # Bilag cell. A raw string in a ReportLab table cell does NOT wrap — it
    # overruns into the neighbouring column, which is exactly what a full
    # voucher RANGE did: "S-2026-0002 → S-2026-0004" is far wider than the
    # 25 mm Bilag column, so it printed straight over the Omsætning figure and
    # the two became an unreadable smear on a document a revisor signs. A
    # Paragraph wraps inside the cell instead. Slightly smaller + tighter
    # leading so a wrapped two-line bilag doesn't inflate every row height.
    bilag_style = ParagraphStyle("Bilag", parent=styles["Normal"], fontSize=6.8,
                                 textColor=INK, fontName="Helvetica",
                                 leading=8, alignment=0)  # 0 = TA_LEFT

    def _make_story():
        # Returns a FRESH list of flowables each call — render_with_doc_hash
        # invokes this once per pass (reportlab mutates flowables in-place, so
        # pass 1 and pass 2 each need brand-new objects). All numeric data is
        # plain-value closure capture; only the Paragraph/Table/Spacer/
        # HRFlowable OBJECTS are created fresh here.
        story = []

        # ─── Business identity header ────────────────────────────────────
        # Owner-typed text is escaped at the Paragraph boundary.
        biz_line = f"<font name='Helvetica-Bold' size='12'>{escape_pdf_text(business_name) or '—'}</font>"
        biz_meta = []
        if profile:
            if getattr(profile, "org_number", None):
                biz_meta.append(f"CVR {escape_pdf_text(profile.org_number)}")
            addr_line = compose_business_address(profile)
            if addr_line:
                biz_meta.append(escape_pdf_text(addr_line))
        head_left = biz_line
        if biz_meta:
            head_left += f"<br/><font color='#6b7280' size='9'>{' · '.join(biz_meta)}</font>"

        head_right = (
            f"<font name='Helvetica-Bold' size='11'>{L['title']}</font>"
            f"<br/><font color='#6b7280' size='9'>"
            f"{_date_short(from_date)} → {_date_short(to_date)}"
            f"</font>"
        )
        # Document voucher number — gives the revisor a stable per-document
        # reference (mirrors build_moms_filing_pdf). Only shown when supplied.
        if bilagsnummer:
            head_right += (
                f"<br/><font color='#6b7280' size='8'>"
                f"{L['bilag_label']} {bilagsnummer}</font>"
            )

        head_table = Table(
            [[Paragraph(head_left, subtitle), Paragraph(head_right, subtitle)]],
            colWidths=[160*mm, 110*mm],
        )
        head_table.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ALIGN", (1, 0), (1, 0), "RIGHT"),
        ]))
        story.append(head_table)
        story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER, spaceBefore=2, spaceAfter=8))

        confirmed = [c for c in closes_sorted if (getattr(c, "status", None) or "confirmed") == "confirmed"]
        drafts = [c for c in closes_sorted if (getattr(c, "status", None) or "confirmed") != "confirmed"]
        n_conf = len(confirmed)
        span_days = (to_date - from_date).days + 1 if to_date and from_date and to_date >= from_date else 1

        # Singular/plural agreement on confirmed + drafts SEPARATELY so a lone
        # Kladde never reads as "1 lukning" (which implies a booked close). E.g.
        # "0 bekræftede · 1 kladde over 30 dage" vs "3 bekræftede · 2 kladder
        # over 7 dage". n_draft uses the plural-aware draft words.
        n_draft = len(drafts)
        days_word = L["day_one"] if span_days == 1 else L["days"]
        confirmed_part = f"{n_conf} {L['confirmed_one'] if n_conf == 1 else L['confirmed_word']}"
        draft_word = L["draft_word"] if n_draft == 1 else L["drafts_word"]
        draft_part = f"{n_draft} {draft_word}"
        story.append(Paragraph(
            f"{confirmed_part} · {draft_part} {L['across_days']} {span_days} {days_word}"
            f"  ·  {L['amounts_in']} {currency}",
            subtitle,
        ))

        if not closes_sorted:
            story.append(Spacer(1, 6))
            story.append(Paragraph(L["no_closes"], note))
            story.append(Spacer(1, 12))
            story.append(Paragraph(L["footer_law"], note))
            return story

        # ─── KPI band (only sums CONFIRMED — drafts excluded so totals are
        #   honest for the accountant) ────────────────────────────────────
        # ONE source of truth — the same function the Excel workbook, the CSV
        # and the e-mail body read, so the four can never disagree.
        T = period_totals(closes_sorted)
        total_revenue = T["revenue"]
        total_moms = T["moms"]
        total_net = T["net"]
        total_tips = T["tips"]

        # ── MOMS KPI honesty (the SAME predicate as the per-close kasserapport) ──
        # `_sum` coerces a NULL moms_total to 0, so a range containing closes
        # whose VAT was never computed produced a confident headline figure that
        # silently UNDERSTATED the period's salgsmoms — the one number on this
        # page a revisor carries into a filing. A total built over an unknown is
        # not known. Doctrine: render "—" and say how many closes are missing.
        #
        # This used to test `c.moms_total is None` and nothing else, so a close
        # the per-close kasserapport dashes (auto-mode zero VAT on non-zero
        # revenue; a stored trio that does not reconstruct gross; revenue lines
        # that contradict the total) still contributed a confident number here.
        # The same stored row rendered "—" on its own document and a firm figure
        # in the period export. One predicate now answers for both.
        moms_unknown_closes = [c for c in confirmed if moms_is_unknown(c)]
        moms_total_known = total_moms is not None
        # A period net built by subtracting an unknown VAT from revenue is just
        # as unknown — and would sit beside a dashed MOMS in the same band,
        # inviting the reader to reconstruct the missing figure from it.
        net_total_known = total_net is not None

        def _fmt(v):
            # Canonical money formatter — the ONE every BonBox export must use
            # (mirrors the gold MOMS-PDF + the per-close kasserapport_pdf). DKK
            # → "1.234,56 kr." (period thousands, comma decimal, "kr." unit);
            # None / "" / non-numeric → "—". Previously this builder rolled its
            # own formatter that produced Danish digits but DROPPED the "kr."
            # unit, so the range PDF disagreed with every other artifact and a
            # revisor saw bare "15.000,00". money_dk also snaps negative-zero
            # dust to "0,00 kr." for free.
            return money_dk(v, currency)

        kpi_rows = [[
            Paragraph(f"<font color='#6b7280' size='8'>{L['kpi_rev']}</font><br/><font name='Helvetica-Bold' size='13'>{_fmt(total_revenue)}</font>", subtitle),
            Paragraph(f"<font color='#6b7280' size='8'>{L['kpi_moms']}</font><br/><font name='Helvetica-Bold' size='13'>{_fmt(total_moms) if moms_total_known else '—'}</font>", subtitle),
            Paragraph(f"<font color='#6b7280' size='8'>{L['kpi_net']}</font><br/><font name='Helvetica-Bold' size='13'>{_fmt(total_net) if net_total_known else '—'}</font>", subtitle),
            Paragraph(f"<font color='#6b7280' size='8'>{L['kpi_tips']}</font><br/><font name='Helvetica-Bold' size='13'>{_fmt(total_tips)}</font>", subtitle),
        ]]
        kpi = Table(kpi_rows, colWidths=[68*mm, 68*mm, 68*mm, 66*mm])
        kpi.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f9fafb")),
            ("BOX", (0, 0), (-1, -1), 0.5, DIVIDER),
            ("INNERGRID", (0, 0), (-1, -1), 0.5, DIVIDER),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 7),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ]))
        story.append(kpi)
        if not moms_total_known:
            # The dash above is not enough on its own — it must say WHY, and
            # how many closes are behind it, or the reader assumes a bug.
            story.append(Spacer(1, 4))
            story.append(Paragraph(
                f"<font color='{AMBER.hexval()}'>"
                f"{L['moms_unknown_note'].format(n=len(moms_unknown_closes))}</font>",
                note,
            ))
        story.append(Spacer(1, 8))

        # ─── Per-close table — accountant columns ────────────────────────
        # "Øvrige" carries every payment method outside the named columns
        # (gift_card / bank_transfer / unrecognized) so the row's payment
        # cells ALWAYS visibly sum to omsætning. Without it, money in those
        # buckets was invisible on the page yet counted in the reconciliation
        # — a "✓ afstemt" badge above a table that didn't add up.
        # ── MOMS heading honesty ─────────────────────────────────────────
        # The column was hard-labelled "Moms 25%", but the VALUE is the stored
        # moms_total — which may be manually keyed or OCR'd off a Z-report and
        # is then not 25% of the base. A revisor reading "Moms 25%" over a
        # number that isn't 25% is being told something untrue. So the heading
        # keeps "25%" ONLY while every included row genuinely is the standard
        # rate; otherwise it degrades quietly to plain "Moms".
        # Compared in KRONER, not as a rate. A rate tolerance has to be loose
        # enough for øre rounding on small closes, which then silently swallows
        # a real deviation on a large one: 28 May 2026 in a live export carried
        # 26.791,06 kr where 25% is 27.033,37 kr — 242 kr off, yet only 0,28
        # percentage points, so any sane rate tolerance passed it. Kroner scale
        # correctly at both ends.
        # One label rule (kasserapport_claims.moms_label): the header keeps
        # "(25 %)" only while every row IS a BonBox-calculated standard-rate
        # figure; otherwise it is plain "Salgsmoms" and each row that is not
        # carries its own source/rate under the amount — the same words its
        # kasserapport and the lock mail use.
        all_standard_rate = all_standard_auto(closes_sorted, currency)
        moms_heading = L["h_moms"] if all_standard_rate else L["h_moms_generic"]

        # Confirmed closes that booked revenue with NO payment split at all.
        # _row_ties_out() deliberately does not flag these (a scan-and-lock
        # close has nothing to tie out) — correct, but it leaves the payment
        # columns summing to less than the revenue with nothing on the page to
        # explain the gap. We surface the amount under the totals instead.
        revenue_only_confirmed = [
            c for c in confirmed
            if not _has_reconcilable_payments(c) and float(getattr(c, "revenue_total", 0) or 0) > 0
        ]
        revenue_only_amount = sum(
            float(getattr(c, "revenue_total", 0) or 0) for c in revenue_only_confirmed
        )

        # Every cell is a Paragraph in ONE style per column kind, so no row's
        # date prints larger than another's and a long header wraps inside its
        # column instead of running into the next.
        head_style = ParagraphStyle("Head", parent=styles["Normal"], fontSize=7.5,
                                    textColor=MUTED, fontName="Helvetica-Bold",
                                    leading=9, alignment=2)
        head_left = ParagraphStyle("HeadL", parent=head_style, alignment=0)
        head_center = ParagraphStyle("HeadC", parent=head_style, alignment=1)
        cell_left = ParagraphStyle("CellL", parent=styles["Normal"], fontSize=8,
                                   textColor=INK, fontName="Helvetica", leading=9.5)
        cell_right = ParagraphStyle("CellR", parent=cell_left, alignment=2)
        tot_left = ParagraphStyle("TotL", parent=cell_left, fontName="Helvetica-Bold",
                                  textColor=EMERALD)
        tot_right = ParagraphStyle("TotR", parent=tot_left, alignment=2)

        def _H(txt, st=head_style):
            return Paragraph(txt, st)

        table_data = [[
            _H(L["h_date"], head_left), _H(L["h_bilag"], head_left),
            _H(L["h_rev"]), _H(escape_pdf_text(moms_heading)), _H(L["h_net"]),
            _H(L["h_cash"]), _H(L["h_card"]), _H(L["h_mobilepay"]), _H(L["h_gift"]),
            _H(L["h_other"]), _H(L["h_diff"]), _H(L["h_status"], head_center),
        ]]

        # Track whether ANY row (drafts included) failed its per-row tie-out so
        # we can emit the footnote that explains the inline "!" marker.
        any_row_flagged = False
        hist = history or {}

        def _small(txt):
            return f"<br/><font size='6' color='#6b7280'>{txt}</font>"

        for c in closes_sorted:
            pay = _bucketed_payments(c)
            vsales, _vexp = voucher_by_date.get(c.date, ("", ""))
            revenue = float(c.revenue_total or 0)
            # Same predicate as the KPI band and the per-close kasserapport, so
            # a row cannot state a MOMS the page above it refuses to state.
            row_moms_unknown = moms_is_unknown(c)
            moms = None if row_moms_unknown else float(c.moms_total or 0)
            # `revenue - (moms or 0)` printed a confident net BESIDE that row's
            # own "—" Moms cell — the missing figure handed back to the reader
            # by subtraction.
            net = (
                float(c.revenue_ex_moms or 0)
                if (c.revenue_ex_moms is not None and not row_moms_unknown)
                else (None if row_moms_unknown else revenue - (moms or 0))
            )
            cash_diff = c.cash_difference
            cash_diff_str = ""
            if cash_diff is not None:
                sign = "+" if cash_diff > 0 else ""
                cash_diff_str = f"{sign}{_fmt(cash_diff)}"
            status = (getattr(c, "status", None) or "confirmed")
            # Residual = every bucket outside the named columns (Gavekort has
            # its own now), so the visible payment cells always add up to the
            # day's collected payments.
            gift_amt = pay["gift_card"]
            other_amt = pay["bank_transfer"] + pay["other"]
            # Per-row tie-out flag — DRAFTS INCLUDED. A row whose recorded
            # payments do not equal its revenue carries an amber "!" next to its
            # status badge (typographic marker, no emoji — matches the badge
            # marks elsewhere). The kasserapport never shows a non-tying row,
            # even a Kladde, without saying so.
            status_label = L["locked"] if status == "confirmed" else L["draft"]
            status_txt = status_label
            if not _row_ties_out(c):
                any_row_flagged = True
                status_txt = (f"<font name='Helvetica-Bold' color='{AMBER.hexval()}'>!</font>"
                              f" {status_label}")
            # A day that was unlocked and locked again says so on its row, as
            # the Excel and the CSV do (the details are in the block below).
            if hist.get(str(getattr(c, "id", "") or "")):
                status_txt += _small(L["relocked"])
            status_cell = Paragraph(status_txt, status_style)
            # Two branches on the same day are two rows: name the branch under
            # the date (the CSV and Excel carry an Afdeling column), or the
            # revisor sees a duplicate and drops one.
            _bname = ((branch_names or {}).get(str(c.branch_id), "")
                      if getattr(c, "branch_id", None) else "")
            date_cell = Paragraph(
                escape_pdf_text(_date_short(c.date)) + (_small(escape_pdf_text(_bname)) if _bname else ""),
                cell_left)
            # Bilag: the day's own kasserapport number and its Dokument-id —
            # the voucher a revisor matches the row to — then any S-vouchers.
            bilag_txt = (f"{escape_pdf_text(vno[id(c)])}"
                         + _small(f"id {escape_pdf_text(dids[id(c)])}")
                         + (_small(escape_pdf_text(vsales)) if vsales else ""))
            # The MOMS cell: when this row's label is not the column's, its
            # own source/rate goes under the amount ("fra Z-bon, svarer til
            # 16,7 %").
            moms_txt = _fmt(moms) if moms is not None else "—"
            lbl = row_label[id(c)]
            if moms is not None and lbl != std_label and "(" in lbl:
                moms_txt += _small(escape_pdf_text(
                    lbl[lbl.index("(") + 1:].rstrip(")")).replace(" %", "&nbsp;%"))
            table_data.append([
                date_cell,
                Paragraph(bilag_txt, bilag_style),
                Paragraph(_fmt(revenue), cell_right),
                Paragraph(moms_txt, cell_right),
                Paragraph(_fmt(net) if net is not None else "—", cell_right),
                Paragraph(_fmt(pay["cash"]) if pay["cash"] else "—", cell_right),
                Paragraph(_fmt(pay["card"]) if pay["card"] else "—", cell_right),
                Paragraph(_fmt(pay["mobilepay"]) if pay["mobilepay"] else "—", cell_right),
                Paragraph(_fmt(gift_amt) if gift_amt else "—", cell_right),
                Paragraph(_fmt(other_amt) if other_amt else "—", cell_right),
                Paragraph(cash_diff_str or "—", cell_right),
                status_cell,
            ])

        # Totals (locked only) — from period_totals, like everything else.
        sum_cash = T["cash"]
        sum_card = T["card"]
        sum_mp = T["mobilepay"]
        sum_gift = T["gift_card"]
        sum_other = round(T["bank_transfer"] + T["other"], 2)
        sum_diff = T["cash_difference"] or 0.0

        def _tot(v):
            return Paragraph(v, tot_right)

        table_data.append([
            # "I alt — 26 låste dage", across the Dato and Bilag columns.
            Paragraph(totals_label(n_conf, DA), tot_left), "",
            _tot(_fmt(total_revenue)),
            # The KPI band four inches above this row already renders "—" for
            # exactly this quantity. Printing a confident (and understated)
            # figure here made the document contradict itself about the single
            # number a revisor carries into a MOMS filing.
            _tot(_fmt(total_moms) if moms_total_known else "—"),
            _tot(_fmt(total_net) if net_total_known else "—"),
            _tot(_fmt(sum_cash) if sum_cash else "—"),
            _tot(_fmt(sum_card) if sum_card else "—"),
            _tot(_fmt(sum_mp) if sum_mp else "—"),
            _tot(_fmt(sum_gift) if sum_gift else "—"),
            _tot(_fmt(sum_other) if sum_other else "—"),
            _tot((("+" if sum_diff > 0.004 else "") + _fmt(sum_diff))
                 if any(c.cash_difference is not None for c in confirmed) else "—"),
            "",
        ])

        # 270 mm: a Bilag column wide enough for "KR-20260925-VES3F2A" and its
        # Dokument-id, money columns for "521.983,50 kr." in bold.
        col_widths = [20*mm, 30*mm, 24*mm, 24*mm, 24*mm, 22*mm, 22*mm, 20*mm, 20*mm, 20*mm, 22*mm, 22*mm]
        table = Table(table_data, colWidths=col_widths, repeatRows=1)
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f3f4f6")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
            ("TOPPADDING", (0, 0), (-1, 0), 5),
            ("BOTTOMPADDING", (0, 1), (-1, -2), 4),
            ("TOPPADDING", (0, 1), (-1, -2), 4),
            ("LINEBELOW", (0, 0), (-1, 0), 0.5, DIVIDER),
            ("LINEBELOW", (0, 1), (-1, -2), 0.25, DIVIDER),
            ("LINEABOVE", (0, -1), (-1, -1), 1, EMERALD),
            ("BACKGROUND", (0, -1), (-1, -1), EMERALD_BG),
            ("SPAN", (0, -1), (1, -1)),
        ]))
        story.append(table)

        # The generic header needs its key: an amount with no note under it
        # is BonBox's own standard-rate figure.
        if not all_standard_rate:
            story.append(Spacer(1, 3))
            story.append(Paragraph(
                f"<font color='#6b7280' size='7.5'>"
                + (f"Salgsmoms uden note under beløbet = {escape_pdf_text(std_label)}, beregnet af BonBox."
                   if DA else
                   f"Output VAT with no note under the amount = {escape_pdf_text(std_label)}, calculated by BonBox.")
                + "</font>", note))

        # ─── Per-row tie-out footnote (if any row was flagged) ───────────
        # Explains the amber "!" marker carried by any row — drafts included —
        # whose payments do not equal its revenue. Placed directly under the
        # table so the marker and its meaning sit together.
        if any_row_flagged:
            story.append(Spacer(1, 4))
            story.append(Paragraph(
                f"<font color='{AMBER.hexval()}' size='8.5'>"
                f"<font name='Helvetica-Bold'>!</font>"
                f" {L['row_flag_note']}</font>",
                note,
            ))

        # ─── Payment-column scope note (if any) ──────────────────────────
        # Neutral grey, not amber: these closes are book-ready, nothing is
        # wrong with them. The line exists so a reader who adds the payment
        # columns and finds them short of the revenue total sees immediately
        # why, instead of hunting a phantom discrepancy.
        if revenue_only_confirmed:
            story.append(Spacer(1, 4))
            story.append(Paragraph(
                f"<font color='#6b7280' size='8.5'>{L['totals_excl_note']} "
                f"({len(revenue_only_confirmed)} × {_fmt(revenue_only_amount)}).</font>",
                note,
            ))

        # ─── Draft note (if any) ─────────────────────────────────────────
        if drafts:
            story.append(Spacer(1, 4))
            story.append(Paragraph(
                f"<font color='#92400e' size='8.5'>"
                f"<font name='Helvetica-Bold'>!</font> {len(drafts)} "
                f"{L['draft'].lower()} — {L['draft_excl']}.</font>",
                note,
            ))

        # ─── Fordeling i perioden — categories + payment methods ─────────
        # The table has no room for a column per category; the revisor still
        # needs the split (and gavekort on its own line). Locked closes only,
        # each line ties to Omsætning i alt.
        if confirmed:
            from app.services.close_category_labels import revenue_category_label
            cat_parts = [
                f"{escape_pdf_text(revenue_category_label(k, danish=DA))} {_fmt(v)}"
                for k, v in sorted(
                    T["categories"].items(),
                    key=lambda kv: (_BUILTIN_CAT_ORDER.index(kv[0]) if kv[0] in _BUILTIN_CAT_ORDER else 99, str(kv[0]).lower()),
                )
            ]
            if T["unallocated"]:
                cat_parts.append(f"{L['unallocated']} {_fmt(T['unallocated'])}")
            pay_parts = [
                f"{lbl} {_fmt(T[key])}" for key, lbl in (
                    ("cash", L["h_cash"]), ("card", L["h_card"]), ("mobilepay", L["h_mobilepay"]),
                    ("gift_card", L["h_gift"]),
                    ("bank_transfer", "Bankoverførsel" if DA else "Bank transfer"),
                    ("other", "Andet" if DA else "Other"),
                ) if T[key]
            ]
            story.append(Spacer(1, 6))
            story.append(Paragraph(
                f"<font color='#6b7280' name='Helvetica-Bold' size='8'>{L['dist_title']}</font>", note))
            if cat_parts:
                story.append(Paragraph(
                    f"<font color='#374151' size='8'>{L['dist_rev']}: {' · '.join(cat_parts)}</font>", note))
            if pay_parts:
                story.append(Paragraph(
                    f"<font color='#374151' size='8'>{L['dist_pay']}: {' · '.join(pay_parts)}</font>", note))

        # ─── Kasseafstemning (drawer reconciliation) ─────────────────────
        # The "Kassediff." column shows only the NET difference; a revisor
        # needs the derivation (forventet − optalt = difference) to trust the
        # number. We surface it as one quiet line per close that actually
        # counted its drawer, with the sign on the difference. forventet =
        # register/expected, optalt = counted (read for XLSX but previously
        # never shown on the PDF). Confirmed closes only.
        counted_closes = [
            c for c in confirmed
            if c.cash_counted is not None and c.cash_expected is not None
        ]
        if counted_closes:
            story.append(Spacer(1, 6))
            kasse_lines = []
            # Only the days with a difference get a line; the rest are counted
            # in one sentence (30 lines of "= 0,00 kr." buried the two that
            # mattered).
            balanced = [c for c in counted_closes
                        if abs(float(c.cash_difference) if c.cash_difference is not None
                               else float(c.cash_counted or 0) - float(c.cash_expected or 0)) < 0.005]
            if balanced:
                kasse_lines.append(Paragraph(
                    f"<font color='#6b7280' size='8'>"
                    + (f"{len(balanced)} {'dag' if len(balanced) == 1 else 'dage'}: optalt = forventet (0,00 kr.)"
                       if DA else
                       f"{len(balanced)} {'day' if len(balanced) == 1 else 'days'}: counted = expected (0,00 kr.)")
                    + "</font>", note))
            for c in counted_closes:
                if c in balanced:
                    continue
                exp = float(c.cash_expected or 0)
                cnt = float(c.cash_counted or 0)
                diff = (float(c.cash_difference) if c.cash_difference is not None
                        else round(cnt - exp, 2))
                diff_sign = "+" if diff > 0 else ""
                # Emerald when within ±100 kr, amber when outside — status
                # colour only, no rainbow.
                diff_col = EMERALD if abs(diff) <= 100 else AMBER
                # optalt − forventet = difference: the operands in the order
                # that actually produces the printed result, and the app's own
                # words for which way it went. It read "forventet 4.205 −
                # optalt 4.245 = +40", which is −40.
                words = ""
                if abs(diff) >= 0.005:
                    words = f" ({L['kasse_over'] if diff > 0 else L['kasse_short']})"
                kasse_lines.append(Paragraph(
                    f"<font color='#6b7280' size='8'>"
                    f"{_date_short(c.date)} — {L['kasse_cnt']} {_fmt(cnt)} − "
                    f"{L['kasse_exp']} {_fmt(exp)} = "
                    f"<font color='{diff_col.hexval()}' name='Helvetica-Bold'>"
                    f"{diff_sign}{_fmt(diff)}</font>{words}</font>",
                    note,
                ))
            # The heading never stands alone at the foot of a page: it is kept
            # with its first lines.
            story.append(KeepTogether([
                Paragraph(f"<font color='#6b7280' name='Helvetica-Bold' size='8'>"
                          f"{L['kasse_title']}</font>", note),
                *kasse_lines[:3],
            ]))
            story.extend(kasse_lines[3:])

        # ─── Payments ↔ revenue reconciliation (accountant-grade) ────────
        # A kasserapport must TIE OUT: every krone of revenue is collected by
        # some payment method, so the methods must sum to the revenue. We
        # reconcile on CONFIRMED closes (drafts are excluded from totals) and
        # surface any close that does not balance — silently presenting
        # non-tying numbers to a revisor is exactly what "accountant-grade"
        # exists to prevent. RECON_TOL absorbs øre rounding but catches real
        # gaps (the per-close payment sum includes hidden buckets like
        # gift_card / bank_transfer / other that the narrow table omits).
        RECON_TOL = 0.50  # 50 øre
        # Only closes that actually recorded payment methods can be reconciled —
        # a revenue-only close has nothing to tie out (see _has_reconcilable_).
        recon_closes = [c for c in confirmed if _has_reconcilable_payments(c)]
        unbalanced = [
            c for c in recon_closes
            if abs(_payments_sum(c) - float(c.revenue_total or 0)) > RECON_TOL
        ]
        if recon_closes:
            story.append(Spacer(1, 6))
            if unbalanced:
                # Sum of ABSOLUTE per-close deviations — never 0 while a close
                # is off (a NET figure could cancel out and read "0,00" beside
                # a "needs review" warning, which is self-contradictory).
                abs_dev = sum(
                    abs(_payments_sum(c) - float(c.revenue_total or 0))
                    for c in unbalanced
                )
                story.append(Paragraph(
                    f"<font color='{AMBER.hexval()}' size='8.5'>"
                    f"<font name='Helvetica-Bold'>!</font> {L['recon_off']}: "
                    f"{len(unbalanced)} {L['recon_review']} "
                    f"({L['recon_delta']} {_fmt(abs_dev)}).</font>",
                    note,
                ))
            else:
                net = (
                    sum(_payments_sum(c) for c in recon_closes)
                    - sum(float(c.revenue_total or 0) for c in recon_closes)
                )
                story.append(Paragraph(
                    f"<font color='{EMERALD.hexval()}' size='8.5'>"
                    f"<font name='Helvetica-Bold'>•</font> {L['recon_ok']} "
                    f"({L['recon_delta']} {_fmt(net)}).</font>",
                    note,
                ))

        # ─── Kilde, salgsmoms og historik pr. dag ────────────────────────
        # What the Excel and the CSV carry per row, on the PDF too: one
        # summary of where the figures came from, then each day that needs a
        # word — a MOMS that is not BonBox's standard figure, a corrected
        # scan, tills added together, an unlock and relock.
        src_map = sources or {}
        counts: dict = {}
        notable = []
        for c in closes_sorted:
            cid = str(getattr(c, "id", "") or "")
            src = (src_map.get(cid) or "").strip()
            kind = src.split(" · ")[0] if src else L["src_none"]
            counts[kind] = counts.get(kind, 0) + 1
            parts = []
            if row_label[id(c)] != std_label and not moms_is_unknown(c):
                parts.append(row_label[id(c)])
            if " · " in src:
                parts.append(src)
            if hist.get(cid):
                parts.append(hist[cid])
            if parts:
                _bn = ((branch_names or {}).get(str(c.branch_id), "")
                       if getattr(c, "branch_id", None) else "")
                who = _date_short(c.date) + (f" ({_bn})" if _bn else "")
                notable.append(f"{escape_pdf_text(who)}: " + escape_pdf_text(" · ".join(parts)))
        if sources is not None or notable:
            summary = " · ".join(
                f"{escape_pdf_text(k)} {n} {L['src_day'] if n == 1 else L['src_days']}"
                for k, n in counts.items())
            block = [
                Paragraph(f"<font color='#6b7280' name='Helvetica-Bold' size='8'>"
                          f"{L['src_title']}</font>", note),
            ]
            if sources is not None:
                block.append(Paragraph(
                    f"<font color='#374151' size='8'>{L['src_summary']}: {summary}</font>", note))
            for line in notable:
                block.append(Paragraph(f"<font color='#374151' size='8'>{line}</font>", note))
            story.append(Spacer(1, 6))
            story.append(KeepTogether(block[:3]))
            story.extend(block[3:])

        # ─── Readiness badge ─────────────────────────────────────────────
        # A close counts as "ready for booking" only when ALL three hold:
        # MOMS computed, cash drawer within ±100 (or not counted), AND
        # payments reconcile to revenue. The third condition is the honesty
        # fix — previously a close with a payment/revenue mismatch could still
        # claim "klar til bogføring".
        ready_count = sum(1 for c in confirmed if id(c) in ready_ids)
        review = [c for c in confirmed if id(c) not in ready_ids]
        all_ready = (ready_count == n_conf and n_conf > 0)
        badge_color = EMERALD if all_ready else AMBER
        badge_bg = EMERALD_BG if all_ready else AMBER_BG
        # Neutral typographic status mark (no emoji — design lock): emerald "•"
        # when ready, amber "!" when review is needed.
        icon = "•" if all_ready else "!"
        # The count reads the right way round — it said "23 / 26 skal
        # gennemgås" while 23 were READY — and the days to look at are named.
        head = f"{icon} {ready_count} {L['of']} {n_conf} {L['ready']}"
        if review:
            days = ", ".join(_date_short(c.date) for c in review[:8])
            more = f" +{len(review) - 8}" if len(review) > 8 else ""
            head += f" · {len(review)} {L['review']}: {days}{more}"

        story.append(Spacer(1, 8))
        badge = Table(
            [[Paragraph(
                f"<font name='Helvetica-Bold' color='{badge_color.hexval()}' size='10'>"
                f"{head}</font>"
                f"<br/><font color='#6b7280' size='8'>{L['ready_rule']}</font>",
                subtitle,
            )]],
            colWidths=[270*mm],
        )
        badge.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), badge_bg),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(badge)

        # ─── Signature line (two-person control, Bogføringsloven §10) ─────
        # The revisor expects a signed cash report: who counted the drawer +
        # who approved it for booking, with a date. Kept to a single quiet
        # line so it never crowds the landscape body.
        story.append(Spacer(1, 14))
        story.append(Paragraph(
            f"<font color='#6b7280' size='8'>"
            f"{L['sig_counted']}: ______________________&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
            f"{L['sig_approved']}: ______________________&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
            f"{L['sig_date']}: ____________</font>",
            note,
        ))

        # ─── Footer ──────────────────────────────────────────────────────
        story.append(Spacer(1, 6))
        story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER, spaceBefore=2, spaceAfter=4))
        story.append(Paragraph(
            L["footer_law"] if all_standard_rate else L["footer_law_mixed"], note,
        ))

        return story

    # ─── 2-pass render with the accountant-grade provenance footer ───────
    # Content-aligned margins (NOT symmetric 22mm): the wide landscape tables
    # are 270mm (head_table 160+110, KPI band, badge, per-close table). On
    # landscape A4 (297mm) a 271mm frame fits them with ~1mm spare and centres
    # them — 14mm left / 12mm right gives 297−14−12 = 271mm. Symmetric 22mm
    # would leave only 253mm and overrun the right margin by ~17mm. The footer
    # now anchors to these 14/12 content edges (not a hardcoded 22mm), so
    # Doc-hash / Side X/Y line up with the table edges. bottom_mm=20 keeps the
    # y=10mm footer clear of body content. render_with_doc_hash calls
    # _make_story once per pass (fresh flowables each time).
    period_subject = f"{from_date.isoformat()} → {to_date.isoformat()}"
    # Identity on every page after the first (the first carries the full
    # header): business, period, Bilagsnr — and "Side x af y" is appended by
    # the renderer. The id is the period's stable Dokument-id, the same word
    # the kasserapport uses (it said "Doc-hash" here).
    running = " · ".join(p for p in (
        f"{L['title']}er" if DA else f"{L['title']}s",
        business_name or "",
        f"{_date_short(from_date)} – {_date_short(to_date)}",
        f"{L['bilag_label']} {bilagsnummer}" if bilagsnummer else "",
    ) if p)
    return render_with_doc_hash(
        _make_story,
        pagesize=landscape(A4),
        left_mm=14, right_mm=12, top_mm=16, bottom_mm=20,
        title=f"{L['title']} — {business_name}",
        author="BonBox",
        subject=period_subject,
        software_id=software_id,
        generated_at_str=generated_at_str,
        generator_email=generator_email,
        is_danish=DA,
        doc_hash=period_document_id(closes_sorted, from_date, to_date),
        hash_label="Dokument-id" if DA else "Document ID",
        running_header=running,
        running_header_page_no=True,
    )


# ─── XLSX ─────────────────────────────────────────────────────────────


def _as_text(cell):
    """Store a person-typed value as TEXT. openpyxl writes any string that
    starts with "=" as a live formula, so a "Lukket af" of
    '=HYPERLINK("https://…","Lars")' reached the revisor's Excel as a working
    link (or WEBSERVICE call). The CSV path neutralises these with csv_safe;
    here the cell type is forced instead, so the text is shown exactly as
    typed and never evaluated."""
    if isinstance(cell.value, str) and cell.value.startswith("="):
        cell.data_type = "s"
    return cell


def build_daily_close_range_xlsx(
    closes: list[DailyClose],
    *,
    from_date: date,
    to_date: date,
    business_name: str = "",
    currency: str = "DKK",
    profile=None,
    db: Session | None = None,
    user_id=None,
    tz=None,
    history: dict | None = None,
    sources: dict | None = None,
    branch_names: dict | None = None,
    bilagsnummer: str = "",
) -> bytes:
    """Build the revisor's Excel workbook:

      1. "Oversigt" — business header, period, the LOCKED-only totals (from
         period_totals — the same figures as the PDF and the e-mail), the
         revenue per category and the payments per method.
      2. "Kasserapport" — one row per close, typed cells, frozen header. The
         totals row is a live SUMIFS keyed on the Status column, so drafts stay
         listed (marked "Kladde (ikke medregnet)") but never enter a total, and
         the revisor can still edit a row and watch the totals follow.

    Money cells use the INVARIANT format code '#,##0.00 "kr."'. An xlsx format
    code is always read in en-US grammar and localised by Excel: a Danish
    machine shows "15.021,00 kr.". The previous Danish literal '#.##0,00' was
    read as "decimal point after the first #", which is how the revisor saw
    "15021,000 kr." and '####' totals.
    """
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
    from openpyxl.utils import get_column_letter
    from app.services.close_category_labels import revenue_category_label

    from app.services.bonbox_pdf_kit import export_bilagsnummer
    from app.services.close_kasserapport_pdf import generated_local

    DA = (currency == "DKK")
    money_fmt = '#,##0.00" kr."' if DA else f'#,##0.00" {currency}"'
    totals = period_totals(closes)
    conf_label = CONFIRMED_LABEL_DA if DA else CONFIRMED_LABEL_EN
    cats = category_columns(closes)
    bilagsnummer = bilagsnummer or export_bilagsnummer("KRP", from_date, to_date)

    def _d(d):
        return d.strftime("%d.%m.%Y") if DA else d.isoformat()

    # Localized headers — same vocabulary as the PDF for consistency.
    # Column 20 (T) is Status; the totals formula keys on it.
    # B/C: the day's own kasserapport bilag number (KR-…) and the Dokument-id
    # printed on it — the voucher a revisor matches the row to. The sales /
    # expense voucher ranges keep their own columns at the end.
    H = (
        ["Dato", "Bilagsnr.", "Dokument-id",
         "Omsætning", "Salgsmoms", "Netto (uden moms)",
         "Kontant", "Kort", "MobilePay", "Gavekort", "Bank", "Andet",
         "Betalinger i alt", "Forventet kontant", "Optalt kontant (uden byttepenge)",
         "Kassedifference",
         "Drikkepenge", "Antal medarbejdere", "Pr. medarbejder",
         "Status", "Lukket af", "Låst (dansk tid)", "Kilde", "Historik", "Bemærkninger",
         "Afdeling", "Momsopgørelse", "Bogføring", "Salgsbilag", "Udgiftsbilag"]
        if DA else
        ["Date", "Voucher no.", "Document ID",
         "Revenue", "Salgsmoms", "Net (excl. VAT)",
         "Cash", "Card", "MobilePay", "Gavekort", "Bank transfer", "Other",
         "Payments total", "Expected cash", "Counted cash (float taken off)", "Cash diff",
         "Tips", "Staff count", "Per person",
         "Status", "Closed by", "Locked (local time)", "Source", "History", "Notes",
         "Branch", "VAT basis", "Bookkeeping", "Sales voucher", "Expense voucher"]
    )
    STATUS_COL = 20
    n_fixed = len(H)
    cat_prefix = "Kategori: " if DA else "Category: "
    H = H + [cat_prefix + revenue_category_label(k, danish=DA) for k in cats] + [
        cat_prefix + ("Ikke fordelt" if DA else "Not allocated")]
    cat_col_start = n_fixed + 1

    wb = Workbook()
    bold = Font(bold=True)
    big = Font(size=14, bold=True)
    muted = Font(color="6B7280", italic=True)

    # ─── Sheet 1: Oversigt ────────────────────────────────────────────
    s1 = wb.active
    s1.title = "Oversigt" if DA else "Summary"
    s1.column_dimensions["A"].width = 34
    s1.column_dimensions["B"].width = 22
    s1.column_dimensions["C"].width = 40

    s1["A1"] = business_name or "—"
    _as_text(s1["A1"])
    s1["A1"].font = big
    row = 2
    if profile:
        if getattr(profile, "org_number", None):
            s1.cell(row=row, column=1, value="CVR")
            s1.cell(row=row, column=2, value=str(profile.org_number))
            row += 1
        addr_line = compose_business_address(profile)
        if addr_line:
            s1.cell(row=row, column=1, value="Adresse" if DA else "Address")
            _as_text(s1.cell(row=row, column=2, value=addr_line))
            row += 1

    period_row = max(row + 1, 6)
    s1.cell(row=period_row, column=1, value="Periode" if DA else "Period").font = bold
    s1.cell(row=period_row, column=2, value=f"{_d(from_date)}–{_d(to_date)}")
    s1.cell(row=period_row + 1, column=1, value="Valuta" if DA else "Currency").font = bold
    s1.cell(row=period_row + 1, column=2, value=currency)
    s1.cell(row=period_row + 2, column=1,
            value="Låste lukninger (medregnet)" if DA else "Locked closes (counted)").font = bold
    s1.cell(row=period_row + 2, column=2, value=totals["n_confirmed"])
    s1.cell(row=period_row + 3, column=1,
            value="Kladder (ikke medregnet)" if DA else "Drafts (not counted)").font = bold
    s1.cell(row=period_row + 3, column=2, value=totals["n_drafts"])
    # The workbook's own identity, as on the period PDF: its bilag number, its
    # Dokument-id (the same id the PDF of the same period prints), when it was
    # made (the venue's clock) and the retention duty.
    ident = [
        ("Bilagsnr." if DA else "Voucher no.", bilagsnummer),
        ("Dokument-id" if DA else "Document ID", period_document_id(closes, from_date, to_date)),
        ("Genereret" if DA else "Generated", generated_local(tz, danish=DA)),
    ]
    for i, (k, v) in enumerate(ident):
        s1.cell(row=period_row + 4 + i, column=1, value=k).font = bold
        _as_text(s1.cell(row=period_row + 4 + i, column=2, value=v))
    s1.cell(row=period_row + 4 + len(ident), column=1, value=(
        "Opbevares i 5 år efter bogføringsloven." if DA
        else "Keep for 5 years under the Danish Bookkeeping Act.")).font = muted
    period_row += len(ident) + 1

    kpi_rows = [
        ("Omsætning i alt" if DA else "Total revenue", totals["revenue"]),
        ("Salgsmoms i alt" if DA else "Total output VAT", totals["moms"]),
        ("Netto (uden moms)" if DA else "Net (excl. VAT)", totals["net"]),
        ("Drikkepenge i alt" if DA else "Total tips", totals["tips"]),
    ]
    k_start = period_row + 5
    s1.cell(row=k_start, column=1,
            value="Totaler (kun låste lukninger)" if DA else "Totals (locked closes only)").font = bold
    for i, (label, val) in enumerate(kpi_rows):
        r = k_start + 1 + i
        s1.cell(row=r, column=1, value=label)
        if val is None:
            # A total built over a close whose MOMS cannot be stated is not
            # known; "—", never a fabricated (understated) number.
            c = s1.cell(row=r, column=2, value="—")
        else:
            c = s1.cell(row=r, column=2, value=val)
            c.number_format = money_fmt
        c.alignment = Alignment(horizontal="right")
    r = k_start + 1 + len(kpi_rows)
    if totals["moms"] is None:
        s1.cell(
            row=r, column=1,
            value=(
                "Salgsmoms i alt kan ikke opgøres: {n} låst(e) lukning(er) "
                "har ingen momsopgørelse."
                if DA else
                "Total output VAT cannot be stated: {n} locked close(s) have "
                "no VAT figure."
            ).format(n=totals["moms_unknown_count"]),
        ).font = muted
        r += 1
    if totals["n_drafts"]:
        s1.cell(row=r, column=1, value=(
            f"{totals['n_drafts']} {'kladde' if totals['n_drafts'] == 1 else 'kladder'} i perioden "
            "står på arket Kasserapport, men er ikke medregnet."
            if DA else
            f"{totals['n_drafts']} draft(s) are listed on the detail sheet but not counted."
        )).font = muted
        r += 1

    # Revenue per category — ties to Omsætning i alt (Ikke fordelt carries the rest).
    r += 1
    s1.cell(row=r, column=1,
            value="Omsætning pr. kategori (låste)" if DA else "Revenue per category (locked)").font = bold
    r += 1
    for k in cats:
        if k in totals["categories"]:
            _as_text(s1.cell(row=r, column=1, value=revenue_category_label(k, danish=DA)))
            c = s1.cell(row=r, column=2, value=totals["categories"][k])
            c.number_format = money_fmt
            r += 1
    if totals["unallocated"]:
        s1.cell(row=r, column=1, value="Ikke fordelt på kategori" if DA else "Not allocated")
        c = s1.cell(row=r, column=2, value=totals["unallocated"])
        c.number_format = money_fmt
        r += 1

    # Payments per method — gavekort on its own line.
    r += 1
    s1.cell(row=r, column=1,
            value="Betalinger pr. metode (låste)" if DA else "Payments per method (locked)").font = bold
    r += 1
    for key, da_l, en_l in (
        ("cash", "Kontant", "Cash"), ("card", "Kort", "Card"),
        ("mobilepay", "MobilePay", "MobilePay"), ("gift_card", "Gavekort", "Gavekort"),
        ("bank_transfer", "Bankoverførsel", "Bank transfer"), ("other", "Andet", "Other"),
    ):
        if totals[key]:
            s1.cell(row=r, column=1, value=da_l if DA else en_l)
            c = s1.cell(row=r, column=2, value=totals[key])
            c.number_format = money_fmt
            r += 1

    # ─── Sheet 2: Kasserapport detail ─────────────────────────────────
    s2 = wb.create_sheet("Kasserapport" if DA else "Daily Close")
    header_fill = PatternFill(start_color="F3F4F6", end_color="F3F4F6", fill_type="solid")
    thin = Side(border_style="thin", color="E5E7EB")
    border = Border(top=thin, bottom=thin, left=thin, right=thin)

    for col_idx, label in enumerate(H, start=1):
        cell = s2.cell(row=1, column=col_idx, value=label)
        cell.font = bold
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="left" if col_idx == 1 else "right",
                                   vertical="center", wrap_text=True)
        cell.border = border
    s2.freeze_panes = "B2"

    money_cols = set(range(4, 18)) | {19} | set(range(cat_col_start, len(H) + 1))
    sorted_closes = sorted(closes, key=lambda c: c.date or date.min)
    locked_rows: list[list] = []
    # Both voucher ranges for every day in two grouped queries, not two per row.
    voucher_by_date = _voucher_ranges_by_date(db, user_id, [c.date for c in sorted_closes])
    for r, c in enumerate(sorted_closes, start=2):
        pay = _bucketed_payments(c)
        vsales, vexp = voucher_by_date.get(c.date, ("", ""))
        revenue = float(c.revenue_total or 0) if c.revenue_total is not None else None
        # Same predicate as the PDF row builder — a cell must not state a MOMS
        # (or a net derived from it) that the rest of the workbook dashes.
        moms = None if moms_is_unknown(c) else float(c.moms_total or 0)
        net = _net_of(c)
        # Per-row tie-out note (Bemærkninger) — DRAFTS INCLUDED. When a close's
        # recorded payments don't equal its revenue, APPEND (never overwrite)
        # an explicit "Betalinger (X kr.) ≠ omsætning (Y kr.)" note to whatever
        # the owner already wrote, mirroring the PDF's "!" row flag.
        remarks = c.notes or ""
        if not _row_ties_out(c):
            pay_total = _payments_sum(c)
            rev = float(c.revenue_total or 0)
            mismatch = (
                f"Betalinger ({_fmt_kr(pay_total, currency)}) ≠ omsætning ({_fmt_kr(rev, currency)})"
                if DA else
                f"Payments ({_fmt_kr(pay_total, currency)}) ≠ revenue ({_fmt_kr(rev, currency)})"
            )
            remarks = f"{remarks} · {mismatch}" if remarks else mismatch
        local_closed = to_local(c.closed_at, tz) if (c.closed_at and _is_confirmed(c)) else None
        amounts, unsplit = _category_amounts(c)
        cid = str(getattr(c, "id", "") or "")
        row_values = [
            c.date, close_voucher_no(c, branch_names), close_doc_id(c),
            revenue, moms, net,
            pay["cash"] or None, pay["card"] or None, pay["mobilepay"] or None,
            pay["gift_card"] or None, pay["bank_transfer"] or None, pay["other"] or None,
            float(c.payment_total) if c.payment_total is not None else None,
            float(c.cash_expected) if c.cash_expected is not None else None,
            float(c.cash_counted) if c.cash_counted is not None else None,
            float(c.cash_difference) if c.cash_difference is not None else None,
            float(c.tips_total) if c.tips_total is not None else None,
            c.tips_staff_count,
            float(c.tips_per_person) if c.tips_per_person is not None else None,
            status_label(c, DA),
            c.closed_by or "",
            local_closed.replace(tzinfo=None) if local_closed is not None else None,
            (sources or {}).get(cid, ""),
            _row_history(c, history, tz, DA),
            remarks,
            ((branch_names or {}).get(str(c.branch_id), "") if getattr(c, "branch_id", None) else ""),
            # The same MOMS label and verdict as the day's own kasserapport.
            moms_basis_text(c, currency),
            readiness_text(c, currency),
            vsales, vexp,
        ]
        row_values += [amounts.get(k) for k in cats]
        row_values += [unsplit or None]
        if _is_confirmed(c):
            locked_rows.append(row_values)
        for col_idx, val in enumerate(row_values, start=1):
            cell = s2.cell(row=r, column=col_idx, value=val)
            cell.border = border
            if isinstance(val, str):
                # Lukket af, notes, source, history, branch: typed by people.
                _as_text(cell)
            if col_idx == 1 and val is not None:
                cell.number_format = "dd.mm.yyyy" if DA else "yyyy-mm-dd"
            elif col_idx == 18 and isinstance(val, (int, float)):
                cell.number_format = "0"
                cell.alignment = Alignment(horizontal="right")
            elif col_idx in money_cols and isinstance(val, (int, float)):
                cell.number_format = money_fmt
                cell.alignment = Alignment(horizontal="right")
            elif col_idx == 22 and val is not None:
                cell.number_format = "dd.mm.yyyy hh:mm" if DA else "yyyy-mm-dd hh:mm"

    # Totals row — SUMIFS over the LOCKED rows only, keyed on the Status
    # column, so it equals Oversigt, the PDF and the e-mail. A live formula,
    # so the revisor can audit it and edit a row.
    cached: dict = {}
    if sorted_closes:
        first = 2
        last = len(sorted_closes) + 1
        totals_row = last + 1
        s_letter = get_column_letter(STATUS_COL)
        label = totals_label(totals["n_confirmed"], DA)
        s2.cell(row=totals_row, column=1, value=label).font = bold
        fill = PatternFill(start_color="D1FAE5", end_color="D1FAE5", fill_type="solid")
        sum_cols = list(range(4, 18)) + list(range(cat_col_start, len(H) + 1))
        for col_idx in range(1, len(H) + 1):
            s2.cell(row=totals_row, column=col_idx).fill = fill
        for col_idx in sum_cols:
            letter = get_column_letter(col_idx)
            if col_idx in (5, 6) and totals["moms"] is None:
                # Same "—" as Oversigt: a SUMIFS over the known rows would be
                # an understated period salgsmoms.
                cell = s2.cell(row=totals_row, column=col_idx, value="—")
            else:
                cell = s2.cell(
                    row=totals_row, column=col_idx,
                    value=(f'=SUMIFS({letter}{first}:{letter}{last},'
                           f'${s_letter}${first}:${s_letter}${last},"{conf_label}")'),
                )
                cell.number_format = money_fmt
                # The formula's value, written next to it: a phone preview or
                # Quick Look shows cached values and never recalculates.
                cached[f"{letter}{totals_row}"] = round(sum(
                    float(rv[col_idx - 1]) for rv in locked_rows
                    if isinstance(rv[col_idx - 1], (int, float)) and not isinstance(rv[col_idx - 1], bool)
                ), 2)
            cell.font = bold
            cell.alignment = Alignment(horizontal="right")
        if totals["n_drafts"]:
            s2.cell(row=totals_row + 1, column=1, value=(
                f"Kladder står på listen, men indgår ikke i I alt ({totals['n_drafts']})."
                if DA else f"Drafts are listed but not in the totals ({totals['n_drafts']})."
            )).font = muted

    # Column widths — wide enough for "1.234.567,89 kr." so a month over
    # 1 mio. kr. never shows ####.
    widths = ([12, 22, 19] + [17] * 14 + [11, 15, 22, 16, 18, 22, 28, 32, 18]
              + [30, 44, 18, 18] + [17] * (len(H) - n_fixed))
    for i, w in enumerate(widths, start=1):
        s2.column_dimensions[get_column_letter(i)].width = w
    s2.row_dimensions[1].height = 32

    # Print setup: a 30-column sheet prints landscape, fitted to the page
    # width, with the header row repeated on every page.
    for ws in (s1, s2):
        ws.page_setup.paperSize = ws.PAPERSIZE_A4
    s2.page_setup.orientation = "landscape"
    s2.page_setup.fitToWidth = 1
    s2.page_setup.fitToHeight = 0
    s2.sheet_properties.pageSetUpPr.fitToPage = True
    s2.print_title_rows = "1:1"

    out = io.BytesIO()
    wb.save(out)
    return _with_cached_values(out.getvalue(), wb.sheetnames.index(s2.title) + 1, cached)


def _with_cached_values(xlsx: bytes, sheet_no: int, values: dict) -> bytes:
    """Write each formula cell's value into the saved workbook (openpyxl can
    only write a formula OR a value). Excel still recalculates on open; a
    viewer that shows cached values now shows the totals instead of a blank
    row. Fail-soft: on any surprise the workbook is returned as saved."""
    import re as _re
    import zipfile
    if not values:
        return xlsx
    path = f"xl/worksheets/sheet{sheet_no}.xml"
    try:
        zin = zipfile.ZipFile(io.BytesIO(xlsx))
        xml = zin.read(path).decode("utf-8")
        for ref, v in values.items():
            # Every shape the writer may emit for an empty value: `<v/>` /
            # `<v />` (openpyxl's own writer) and `<v></v>` (openpyxl with
            # lxml installed), or no <v> at all. Matching only the first
            # shape silently dropped every total wherever lxml was present.
            xml = _re.sub(
                rf'(<c r="{ref}"[^>]*>\s*<f>[^<]*</f>)\s*(?:<v\s*/>|<v>\s*</v>)?(\s*</c>)',
                lambda m: f"{m.group(1)}<v>{v:.2f}</v>{m.group(2)}", xml, count=1)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = xml.encode("utf-8") if item.filename == path else zin.read(item.filename)
                zout.writestr(item, data)
        return buf.getvalue()
    except Exception:  # noqa: BLE001
        return xlsx
