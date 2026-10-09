"""
Daily Close (Kasserapport) — structured end-of-day closing for restaurants.

Endpoints:
  POST   /api/daily-close              — submit daily close
  GET    /api/daily-close               — list closes (date range)
  GET    /api/daily-close/insights      — aggregated insights
  GET    /api/daily-close/prefill       — prefill from sales/expenses/cash
  POST   /api/daily-close/scan-report   — scan Z-report image via OCR
  GET    /api/daily-close/{id}          — single close
  GET    /api/daily-close/{id}/pdf      — kasserapport PDF
  DELETE /api/daily-close/{id}          — soft delete
"""

import logging
import uuid
from datetime import date, datetime, timedelta
from collections import defaultdict
from io import BytesIO
from typing import Any

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, EmailStr, Field
from fastapi.responses import Response, StreamingResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.daily_close import DailyClose, encode_breakdown, decode_breakdown
from app.models.branch import Branch
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.cashbook import CashTransaction
from app.models.business_profile import BusinessProfile
from app.models.terminal import Terminal
from app.models.kasserapport import KasserapportExtraction
from app.schemas.daily_close import (
    CLOSED_BY_MAX, NOTES_MAX, DailyCloseCreate, DailyCloseResponse, DailyCloseUnlock,
)
from app.services.auth import get_current_user
from app.services.billing import effective_plan, get_cap, has_feature, record_feature_skip
from app.services.expense_status import not_pending
from app.services.receipt_ocr import save_receipt_photo_ex, parse_z_report
from app.services.daily_close_range_export import (
    build_daily_close_range_pdf,
    closes_to_csv_bytes,
    build_daily_close_range_xlsx,
)
from app.services.bonbox_pdf_kit import (
    escape_pdf_text,
    export_bilagsnummer,
    write_export_audit_row,
)
from app.services import audit_service
from app.services.tz_utils import business_today_local
from app.utils.time import utc_now
from app.utils.document_hash import compute_document_hash, short_hash

router = APIRouter()

# Per-IP rate limiter — protects state-changing daily-close endpoints.
# Same shape as inventory/pour, modules, smart-import: a per-router
# Limiter so each router controls its own thresholds. Mirrors the
# 6-layer pattern (auth, bounds, rate limit, tenant scope, plan/quota,
# audit) used everywhere else.
_limiter = Limiter(key_func=client_ip)

# Per-tier daily Z-report scan caps live in PLAN_CAPS
# ("z_report_scans_per_day") — see services/billing.py for the source
# of truth. Local dict removed (May 2026 consolidation) so cap changes
# happen in one place.


def _invalidate_daily_brief_cache(db: Session, user: User) -> None:
    """Drop today's cached DailyBrief so the next /daily-brief call regenerates.

    Without this, the AI brief insight "Latest close (2026-05-04) is 76% below
    POS sales…" stays stale all day even after the owner confirms a new close
    at 05:37 — the brief row was generated before the close landed and the
    cache key (user_id, brief_date=today) keeps serving the old payload.

    The cache key in services/daily_brief.py:1357 uses ``date.today()`` (UTC),
    so we MUST match that here. Using ``business_today_local`` would create a
    timezone mismatch where the brief was stored under one date and we try
    to delete a different date — see CLAUDE.md TZ-cutoff doctrine.

    L8 — graceful degradation: never raise into the close-confirm flow. If
    DailyBrief invalidation fails for any reason (corrupt row, db hiccup),
    we log a warning and let the caller keep going. The brief will refresh
    on its own at the next 8 a.m. cron tick at worst.
    """
    try:
        from app.models.daily_brief import DailyBrief
        today_utc = date.today()
        db.query(DailyBrief).filter(
            DailyBrief.user_id == user.id,
            DailyBrief.brief_date == today_utc,
        ).delete(synchronize_session=False)
        # No explicit commit — the caller's transaction (close confirm)
        # encloses this; the brief drop rides along with the close write.
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "daily_close.confirm: failed to invalidate DailyBrief for user=%s: %s",
            user.id, e,
        )


def _today_scan_count(db: Session, user: User) -> int:
    """How many Z-report scans this user already triggered today.
    Counted via DailyClose rows with receipt_photo set on today's
    business date — the scan-report endpoint doesn't have its own
    audit table, but a successful scan that produces a close lands here.

    Uses `business_today_local(user)` (not `date.today()`) so a 02:00
    CEST scan still belongs to the shift's business date — same TZ
    drift class as the Report Coherence audit (#148) CRITs already
    landed. Without this, an owner closing past midnight could trip
    the next-day quota an hour after starting their close ritual.
    """
    today = business_today_local(user)
    return (
        db.query(func.count(DailyClose.id))
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.date == today,
            DailyClose.receipt_photo.isnot(None),
        )
        .scalar()
    ) or 0


# ─── Helpers ───

def _source_meta_of(dc: DailyClose) -> dict | None:
    """The stored source description as a dict (see _clean_source_meta), or None."""
    import json as _json
    raw = getattr(dc, "source_meta", None)
    if not raw:
        return None
    try:
        meta = _json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return None
    return meta if isinstance(meta, dict) else None


def _to_response(dc: DailyClose) -> dict:
    """Convert DailyClose ORM to response dict with decoded breakdowns."""
    return {
        "id": dc.id,
        "date": dc.date,
        "branch_id": dc.branch_id,
        "revenue_breakdown": decode_breakdown(dc.revenue_categories),
        "revenue_total": float(dc.revenue_total or 0),
        "payment_breakdown": decode_breakdown(dc.payment_categories),
        "payment_total": float(dc.payment_total or 0),
        "moms_total": float(dc.moms_total) if dc.moms_total is not None else None,
        "revenue_ex_moms": float(dc.revenue_ex_moms) if dc.revenue_ex_moms is not None else None,
        "moms_mode": dc.moms_mode,
        "cash_expected": float(dc.cash_expected) if dc.cash_expected is not None else None,
        "cash_counted": float(dc.cash_counted) if dc.cash_counted is not None else None,
        "cash_difference": float(dc.cash_difference) if dc.cash_difference is not None else None,
        "tips_total": float(dc.tips_total) if dc.tips_total is not None else None,
        "tips_staff_count": dc.tips_staff_count,
        "tips_per_person": float(dc.tips_per_person) if dc.tips_per_person is not None else None,
        "status": getattr(dc, "status", None) or "confirmed",
        "notes": dc.notes,
        "closed_by": dc.closed_by,
        "closed_at": dc.closed_at,
        "unlock_reason": getattr(dc, "unlock_reason", None),
        "unlocked_by": getattr(dc, "unlocked_by", None),
        "unlocked_at": getattr(dc, "unlocked_at", None),
        "is_deleted": dc.is_deleted,
        "created_at": dc.created_at,
        # The version of the row: the page sends it back as base_updated_at
        # with its next draft save, so a draft changed elsewhere since is
        # never overwritten in silence (create_daily_close, round 21).
        "updated_at": getattr(dc, "updated_at", None),
        "receipt_photo": getattr(dc, "receipt_photo", None),
        # Where the figures came from (Z-bon or typed, the tills added
        # together, which of them were typed). A reopened draft that was itself
        # a sum keeps its tills on the revisor's record when another bon is
        # added to it, instead of filing the whole draft as one typed till.
        "source_meta": _source_meta_of(dc),
        "cash_float": float(dc.cash_float) if getattr(dc, "cash_float", None) is not None else None,
        # The lasting lock-mail status — History reads it after a reload.
        "email_status": getattr(dc, "email_status", None),
        "email_error": getattr(dc, "email_error", None),
        "email_attempt_at": getattr(dc, "email_attempt_at", None),
        "email_sent_at": getattr(dc, "email_sent_at", None),
        "email_sent_to": [x for x in (getattr(dc, "email_sent_to", None) or "").split(",") if x],
    }


def _business_display_name(profile, user) -> str:
    """The name every revisor-facing artifact prints: the legal company name
    from the profile, else the signup name. ONE rule — the period exports used
    one field and the lock mail another, so the same café was named two ways."""
    return (
        (getattr(profile, "company_name", None) if profile else None)
        or getattr(user, "business_name", None)
        or "BonBox"
    )


def _owner_contact_email(profile, user) -> str:
    """The ONE owner address for everything a revisor mail implies about the
    owner: the owner's own copy (lock mail, "Send igen", the period cc) AND
    the Reply-To on the revisor's copy — the account's LOGIN address.

    Never the free-text business e-mail on Profile: nobody verifies it (a CVR
    re-verify can even overwrite it with the register's address), and the
    owner's copy is uncapped and carries no opt-out — so with Profile.email
    set to a stranger, a forced "Send igen" mailed them over and over, and an
    opted-out revisor put there got mail again. (`profile` is kept in the
    signature so every caller asks this one function.)"""
    return (getattr(user, "email", None) or "").strip().lower()


def _owner_copy_allowed(profile, address: str) -> bool:
    """False when `address` asked BonBox to stop (it is in the revisor
    opt-out set) — an owner copy must not reach an opted-out address either —
    and False for an address the demo seeder wrote (revisor or business
    e-mail on a demo-seeded profile). One rule: revisor_mail.owner_copy_allowed."""
    from app.services.revisor_mail import owner_copy_allowed
    return owner_copy_allowed(profile, address)


def _branch_names(db: Session, user: User, closes) -> dict:
    """{str(branch_id): name} for the branches these closes belong to."""
    branch_names: dict = {}
    try:
        ids = {c.branch_id for c in closes if c.branch_id}
        if ids:
            for b in db.query(Branch).filter(Branch.user_id == user.id, Branch.id.in_(ids)).all():
                branch_names[str(b.id)] = b.name
    except Exception:  # noqa: BLE001
        branch_names = {}
    return branch_names


def _range_extras(db: Session, user: User, closes) -> dict:
    """Per-close strings the period exports print beside the figures: the
    venue's time zone, the unlock/relock history from the audit trail, the
    source of the figures, and branch names (never ids)."""
    from app.services.close_history import close_history_lines, source_lines
    from app.services.tz_utils import _user_zone
    danish = (user.currency or "DKK") == "DKK"
    tz = _user_zone(user)
    branch_names = _branch_names(db, user, closes)
    return {
        "tz": tz,
        "history": close_history_lines(db, user, closes, danish=danish, tz=tz),
        "sources": source_lines(closes, danish=danish, currency=user.currency or "DKK"),
        "branch_names": branch_names,
    }


def _range_bilagsnummer(f: date, t: date) -> str:
    """The period export's own voucher number — KRP (kasserapport, periode).
    It shared 'KR-' with the single kasserapport, so a one-day period export
    and that day's kasserapport carried the same number for two documents."""
    return export_bilagsnummer("KRP", f, t)


def _period_filename(business_name: str, f: date, t: date, ext: str) -> str:
    """'Kasserapporter Mirabelle ApS 2026-09-01–2026-09-30.xlsx' (safe chars)."""
    from app.services.revisor_mail import safe_name_part
    span = f.isoformat() if f == t else f"{f.isoformat()}–{t.isoformat()}"
    return f"Kasserapporter {safe_name_part(business_name)} {span}.{ext}"


# ─── Lane A — close-ritual auto-email helpers (Manoj-confirmed) ───
#
# When the FoH staff taps "Confirm & Lock" on the daily close, we
# auto-fire one email to owner + accountant with the kasserapport PDF
# + scanned Z-report photo (Starter+ feature). The lock-time email
# replaces the old "remember to tap Send to accountant after locking"
# step — one tap, both audiences notified, no forgetting.
#
# Multi-barrier:
#   L3 (router) — `_fire_close_auto_email` is only called for
#                 status="confirmed" and after `has_feature` + the
#                 user's `auto_email_on_close` preference pass.
#   L4 (service) — `send_close_notification` re-checks `has_feature`
#                  inside email_service so a future refactor that
#                  drops the L3 gate still can't leak the feature.
#   L6 (fail-closed) — missing recipients → falls back to user.email,
#                      partial send is acceptable, never raises.
#   L7 (audit) — every attempt writes an audit_logs row + a
#                SecurityEvent on failure for operator monitoring.
#   L8 (degrade) — scan-image fetch failure → email sends with PDF
#                  only and a "scan unavailable" note; Resend hiccup →
#                  status="send_failed", persisted; the owner resends
#                  (there is no background retry, and nothing says there is).
#   L9 (UI) — return shape tells the frontend exactly what happened:
#             email_status, recipients, has_scan, bank_drop block.


def _serialize_close_for_email(dc: DailyClose) -> dict:
    """Compact dict the email template uses — only the four numbers
    that matter for an accountant glance: total revenue, MOMS, cash
    difference, and tips. Mirrors the kasserapport one-page summary."""
    return {
        "date": dc.date.isoformat() if dc.date else None,
        "revenue_total": float(dc.revenue_total or 0),
        "moms_total": float(dc.moms_total or 0),
        "cash_difference": float(dc.cash_difference) if dc.cash_difference is not None else None,
        "tips_total": float(dc.tips_total) if dc.tips_total is not None else None,
    }


def _local_hhmm(dt) -> str:
    """closed_at is stored as naive UTC; the email says a Copenhagen clock
    time ("låst kl. 23:40"), not the UTC one two hours earlier."""
    if not dt:
        return "—"
    try:
        from datetime import timezone as _tz
        from zoneinfo import ZoneInfo
        aware = dt if dt.tzinfo else dt.replace(tzinfo=_tz.utc)
        return aware.astimezone(ZoneInfo("Europe/Copenhagen")).strftime("%H:%M")
    except Exception:  # noqa: BLE001
        return dt.strftime("%H:%M")


_DA_WEEKDAY_SHORT = ["man.", "tir.", "ons.", "tor.", "fre.", "lør.", "søn."]
_DA_WEEKDAY = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"]


def _close_subject(dc: DailyClose, business_name: str, *, is_danish: bool,
                   correction: bool = False, branch: str | None = None) -> str:
    """'Kasserapport fre. 25.09.2026 — Mirabelle ApS' (or 'Rettet kasserapport …').

    No 'Aftenens'/'Dagens': a day back-filled three days later is not tonight's,
    and the subject used to say one thing while the body said another. Two
    branches locking the same day get two different subjects ('… — Mirabelle
    ApS · Vesterbro'): identical ones read as a duplicate to drop."""
    from app.services.revisor_mail import header_safe
    d = dc.date
    biz = header_safe(business_name, 120)
    if branch:
        biz = f"{biz} · {header_safe(branch, 60)}"
    # A demo seeder's sample day says so first, in the inbox list too — as
    # its attachment's "EKSEMPEL …" file name does. A forwarded copy must not
    # read as a real kasserapport under the business's name.
    demo = _is_demo_close(dc)
    if is_danish:
        lead = "Rettet kasserapport" if correction else "Kasserapport"
        return (("EKSEMPEL: " if demo else "")
                + f"{lead} {_DA_WEEKDAY_SHORT[d.weekday()]} {d.strftime('%d.%m.%Y')} — {biz}")
    lead = "Corrected kasserapport" if correction else "Kasserapport"
    return ("SAMPLE: " if demo else "") + f"{lead} {d.strftime('%a %d %b %Y')} — {biz}"


def _signed_money(v, currency: str) -> str:
    from app.services.bonbox_pdf_kit import money_dk
    if v is None:
        return "—"
    return ("+" if float(v) > 0.004 else "") + money_dk(v, currency)


def _cash_diff_words(diff, currency: str, is_danish: bool) -> str:
    """The app's own words: 'Kassen mangler 180,00 kr.' / 'Der er 25,00 kr. for
    meget i kassen' — so a signed number is never read the wrong way round.
    The kasserapport prints the same words (kasserapport_claims)."""
    from app.services.kasserapport_claims import cash_diff_words
    return cash_diff_words(diff, currency)


def _changes_table(changes, is_danish: bool) -> str:
    """What changed in a corrected kasserapport, one line per figure (Linje |
    Før | Nu, figures right-aligned) — it was one run-on sentence of up to
    eight "a → b;" pairs, in the one mail where the revisor must compare
    figures precisely."""
    from app.services.revisor_mail import esc
    head = ("Linje", "Før", "Nu") if is_danish else ("Line", "Before", "Now")
    th = "padding:2px 10px 2px 0;font-weight:600;text-align:{a};"
    td = "padding:2px 10px 2px 0;text-align:{a};font-variant-numeric:tabular-nums;"
    rows = "".join(
        f"<tr><td style='{td.format(a='left')}'>{esc(lbl)}</td>"
        f"<td style='{td.format(a='right')}'>{esc(old)}</td>"
        f"<td style='{td.format(a='right')}'>{esc(new)}</td></tr>"
        for lbl, old, new in changes[:12]
    )
    more = ""
    if len(changes) > 12:
        more = (f"<tr><td colspan='3' style='padding:2px 0;'>"
                + (f"… og {len(changes) - 12} linjer mere (se kasserapporten)" if is_danish
                   else f"… and {len(changes) - 12} more lines (see the kasserapport)")
                + "</td></tr>")
    # "Ændret:" in its own block — the text part ran it into the header
    # ("Ændret:Linje | Før | Nu").
    return (
        "<div>" + ("Ændret:" if is_danish else "Changed:") + "</div>"
        + "<table style='border-collapse:collapse;margin:4px 0 2px 0;font-size:13px;color:#78350f;'>"
        f"<tr><td style='{th.format(a='left')}'>{head[0]}</td>"
        f"<td style='{th.format(a='right')}'>{head[1]}</td>"
        f"<td style='{th.format(a='right')}'>{head[2]}</td></tr>"
        f"{rows}{more}</table>"
    )


def _build_close_email_html(
    *,
    business_name: str,
    dc: DailyClose,
    currency: str,
    closed_by: str | None,
    has_scan: bool,
    scan_degraded: bool,
    is_danish: bool,
    attachment_name: str | None = None,
    audience: str = "owner",
    accountant_name: str | None = None,
    cvr: str | None = None,
    unsubscribe_url: str | None = None,
    correction: dict | None = None,
    revisor_line: str | None = None,
    tz=None,
    branch: str | None = None,
    bilagsnummer: str | None = None,
    doc_id: str | None = None,
) -> tuple[str, str]:
    """Build (subject, html) for the lock mail — one copy per audience.

    audience="revisor": greets the revisor by name, says what is attached, and
    ends with who set the mail up, why, and a one-click opt-out.
    audience="owner": the owner's own copy, which also says whether the revisor
    got it (and if not, why).

    `correction` (a re-lock after an unlock, when an earlier version already
    went out) turns the subject into "Rettet kasserapport …" and adds what
    changed, the unlock reason and which mail it replaces — the revisor would
    otherwise book the day twice.

    Jurisdiction-locked DK terms (Salgsmoms, kasserapport) stay Danish in BOTH
    languages. The VAT rate is currency-derived. EVERY value a person typed is
    escaped; the subject is CR/LF-safe.
    """
    from app.services.bonbox_pdf_kit import money_dk
    from app.services.kasserapport_claims import close_readiness, moms_is_unknown, moms_label
    from app.services.revisor_mail import esc, revisor_footer_html
    from app.services.daily_close_range_export import dk_datetime

    rev = float(dc.revenue_total or 0)
    # Same predicate as the attached kasserapport — money_dk renders None "—".
    moms = None if moms_is_unknown(dc) else float(dc.moms_total or 0)
    cash_diff = float(dc.cash_difference) if dc.cash_difference is not None else None
    biz_plain = business_name
    biz = esc(business_name)
    closer = esc((closed_by or "").strip()) or ("personalet" if is_danish else "staff")
    # The attached kasserapport's own label and verdict — never "25 %" over a
    # figure that is not 25 %, never KLAR here and GENNEMGÅS on the PDF.
    kpi_moms_label = esc(moms_label(dc, currency))
    try:
        verdict = close_readiness(dc, currency)
    except Exception:  # noqa: BLE001
        verdict = {"locked": False, "ready": None, "heading": None, "failing": []}

    def _fmt(v):
        return money_dk(v, currency)

    subject = _close_subject(dc, biz_plain, is_danish=is_danish, correction=bool(correction),
                             branch=branch)
    biz_branch = f"{biz} ({esc(branch)})" if branch else biz
    locked_when = esc(dk_datetime(dc.closed_at, tz, danish=is_danish)) or "—"
    d = dc.date
    day_long = (f"{_DA_WEEKDAY[d.weekday()]} {d.day}. "
                f"{['januar','februar','marts','april','maj','juni','juli','august','september','oktober','november','december'][d.month - 1]} {d.year}"
                if is_danish else d.strftime("%A %d %B %Y"))
    att = esc(attachment_name or "")
    is_revisor = audience == "revisor"

    if is_danish:
        if is_revisor and (accountant_name or "").strip():
            greeting = f"Hej {esc(accountant_name.strip())},"
        else:
            greeting = "Hej,"
        intro = (
            f"Kasserapporten for <strong>{biz_branch}</strong> for {esc(day_long)} er låst "
            f"af {closer} den {locked_when}."
        )
        kpi_rev, kpi_moms, kpi_cash = "Omsætning", kpi_moms_label, "Kassedifference"
        ident = ", ".join(x for x in (
            f"bilagsnr. {esc(bilagsnummer)}" if bilagsnummer else "",
            f"dokument-id {esc(doc_id)}" if doc_id else "",
        ) if x)
        attached = (
            f"Vedhæftet: {att} (PDF{', ' + ident if ident else ''})"
            + (" og Z-bon-foto." if has_scan else ".")
        ) if att else ""
        status_label = "Status"
        ready_txt = "Klar til bogføring"
        review_txt = "Gennemgås"
        # The revisor cannot fetch the photo, so their copy says who can send
        # it; the owner's copy keeps saying what happened.
        scan_note = (("Z-bon-fotoet er ikke vedhæftet — ejeren kan sende det fra BonBox."
                      if is_revisor else
                      "Z-bon-fotoet kunne ikke hentes lige nu — kun PDF'en er vedhæftet.")
                     if scan_degraded else "")
        owner_footer = "Sendt automatisk fra BonBox, da dagen blev låst."
    else:
        if is_revisor and (accountant_name or "").strip():
            greeting = f"Hello {esc(accountant_name.strip())},"
        else:
            greeting = "Hello,"
        intro = (
            f"The kasserapport for <strong>{biz_branch}</strong> for {esc(day_long)} was locked "
            f"by {closer} on {locked_when}."
        )
        kpi_rev, kpi_moms, kpi_cash = "Revenue", kpi_moms_label, "Cash difference"
        ident = ", ".join(x for x in (
            f"voucher no. {esc(bilagsnummer)}" if bilagsnummer else "",
            f"document ID {esc(doc_id)}" if doc_id else "",
        ) if x)
        attached = (
            f"Attached: {att} (PDF{', ' + ident if ident else ''})"
            + (" and the Z-report photo." if has_scan else ".")
        ) if att else ""
        status_label = "Status"
        ready_txt = "Ready for bookkeeping"
        review_txt = "Needs review"
        scan_note = (("The Z-report photo isn't attached — the owner can send it from BonBox."
                      if is_revisor else
                      "The Z-report photo couldn't be fetched right now — only the PDF is attached.")
                     if scan_degraded else "")
        owner_footer = "Sent automatically from BonBox when the day was locked."

    correction_html = ""
    if correction:
        prev = esc(dk_datetime(correction.get("prev_sent_at"), tz, danish=is_danish))
        reason = esc(correction.get("unlock_reason") or "")
        who = esc(correction.get("unlocked_by") or "")
        changes = correction.get("changes") or []
        # Equality is only asserted when every line was compared. A version
        # locked before the lines were recorded in the audit trail can only be
        # compared on its headline figures — and then that is all it says.
        lines_known = bool(correction.get("lines_known"))
        if is_danish:
            lines = [f"<strong>Rettet version.</strong> Denne kasserapport erstatter den, der blev sendt {prev}."]
            if reason:
                lines.append(f"Låst op{(' af ' + who) if who else ''} — årsag: {reason}.")
            if changes:
                lines.append(_changes_table(changes, is_danish))
            elif lines_known:
                lines.append("Tallene er de samme som i den tidligere version.")
            else:
                lines.append("Omsætning, salgsmoms og kassedifference er uændrede — "
                             "se den vedhæftede kasserapport for fordelingen.")
        else:
            lines = [f"<strong>Corrected version.</strong> This kasserapport replaces the one sent {prev}."]
            if reason:
                lines.append(f"Unlocked{(' by ' + who) if who else ''} — reason: {reason}.")
            if changes:
                lines.append(_changes_table(changes, is_danish))
            elif lines_known:
                lines.append("The figures are the same as in the earlier version.")
            else:
                lines.append("Revenue, salgsmoms and the cash difference are unchanged — "
                             "see the attached kasserapport for the split.")
        correction_html = (
            "<div style='margin:12px 0;padding:10px 12px;border-left:3px solid #b45309;"
            "background:#fffbeb;color:#78350f;font-size:13px;'>" + "<br>".join(lines) + "</div>"
        )

    cash_line = ""
    if cash_diff is not None:
        # Two columns only — the words go on their own line under the figure
        # (the first two rows used to end in an empty third cell).
        cash_line = (
            f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{kpi_cash}</td>"
            f"<td style='padding:4px 0;text-align:right;'>{_signed_money(cash_diff, currency)}</td></tr>"
            f"<tr><td colspan='2' style='padding:0 0 4px 0;color:#6b7280;font-size:13px;'>"
            f"{esc(_cash_diff_words(cash_diff, currency, is_danish))}</td></tr>"
        )
    # A sample day says so right under the intro, in the kasserapport's own
    # banner words — not only in the last row of the table.
    demo_html = ""
    if _is_demo_close(dc):
        demo_txt_banner = (
            "EKSEMPELDATA (DEMO) — ikke et bilag. Tallene er lavet af BonBox' demo "
            "og må ikke bogføres." if is_danish else
            "SAMPLE DATA (DEMO) — not a voucher. The figures were made by BonBox's "
            "demo and must not be booked.")
        demo_html = (
            "<div style='margin:12px 0;padding:10px 12px;border-left:3px solid #b45309;"
            "background:#fffbeb;color:#78350f;font-size:13px;font-weight:600;'>"
            f"{demo_txt_banner}</div>"
        )
    status_html = ""
    if verdict.get("locked") and _is_demo_close(dc):
        # The attached kasserapport says "Eksempel — ikke til bogføring" in
        # the band's place; the mail never says Klar over sample figures.
        demo_txt = ("Eksempel — ikke til bogføring" if is_danish
                    else "Sample — not for bookkeeping")
        status_html = (
            f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{status_label}</td>"
            f"<td style='padding:4px 0;text-align:right;color:#92400e;font-weight:600;'>{demo_txt}</td></tr>"
        )
    elif verdict.get("locked"):
        if verdict.get("ready"):
            status_html = (
                f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{status_label}</td>"
                f"<td style='padding:4px 0;text-align:right;color:#065f46;font-weight:600;'>{ready_txt}</td></tr>"
            )
        else:
            reasons = "".join(
                f"<li>{esc(r)}</li>" for r in (verdict.get("failing") or []))
            status_html = (
                f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{status_label}</td>"
                f"<td style='padding:4px 0;text-align:right;color:#92400e;font-weight:600;'>{review_txt}</td></tr>"
                + (f"<tr><td colspan='2' style='padding:0 0 4px 0;color:#92400e;font-size:13px;'>"
                   f"<ul style='margin:2px 0 0 18px;padding:0;'>{reasons}</ul></td></tr>" if reasons else "")
            )

    if is_revisor:
        footer = revisor_footer_html(business_name=biz_plain, cvr=cvr,
                                     unsubscribe_url=unsubscribe_url, is_danish=is_danish)
    else:
        footer = (
            "<p style='color:#6b7280;font-size:13px;'>"
            + (f"{esc(revisor_line)}<br>" if revisor_line else "")
            + owner_footer + "</p>"
        )

    html = (
        "<div style='font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#111827;line-height:1.5;font-size:14px;max-width:560px;'>"
        f"<p>{greeting}</p>"
        f"<p>{intro}</p>"
        f"{demo_html}"
        f"{correction_html}"
        # An explicit size: a client in quirks mode does not pass the body's
        # 14px into a table, and the figures came out larger than the text.
        "<table style='border-collapse:collapse;margin:16px 0;font-size:14px;line-height:1.5;'>"
        f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{kpi_rev}</td>"
        f"<td style='padding:4px 0;font-weight:600;text-align:right;'>{_fmt(rev)}</td></tr>"
        f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{kpi_moms}</td>"
        f"<td style='padding:4px 0;text-align:right;'>{_fmt(moms)}</td></tr>"
        f"{cash_line}"
        f"{status_html}"
        "</table>"
        + (f"<p style='color:#374151;font-size:13px;'>{attached}</p>" if attached else "")
        + (f"<p style='color:#b45309;font-size:13px;'>{scan_note}</p>" if scan_note else "")
        + f"{footer}"
        "</div>"
    )
    return subject, html


def _is_safe_scan_url(url: str) -> bool:
    """SSRF guard for the Z-report photo fetch.

    The receipt_photo value is always either a local uploads/ path
    (handled separately) or a Supabase storage URL. We therefore allow
    ONLY https URLs whose host matches the configured Supabase project
    host (falling back to the managed *.supabase.co domain when
    SUPABASE_URL is unset, e.g. local dev). This blocks an owner from
    coercing the server into fetching internal/metadata endpoints
    (169.254.169.254, localhost, 10.x, …) and exfiltrating the response
    body as a revisor email attachment.
    """
    try:
        from urllib.parse import urlparse
        from app.config import settings
        p = urlparse(url)
        if p.scheme != "https" or not p.hostname:
            return False
        host = p.hostname.lower()
        configured = urlparse((settings.SUPABASE_URL or "").strip()).hostname
        if configured:
            return host == configured.lower()
        return host == "supabase.co" or host.endswith(".supabase.co")
    except Exception:  # noqa: BLE001
        return False


def _fetch_scan_bytes_best_effort(receipt_url: str | None) -> tuple[bytes | None, str | None]:
    """Best-effort fetch of the Z-report photo for email attachment.
    Returns (bytes, filename) or (None, None) on any failure — never
    raises into the close-confirm path. L8 — graceful degradation.

    Supports two storage shapes:
      • Supabase URL (https, allow-listed host): GET it  — SSRF-guarded
      • Local path (uploads/...): read from disk
    """
    if not receipt_url:
        return None, None
    try:
        if receipt_url.startswith("http"):
            # SSRF guard — only fetch from the allow-listed Supabase host.
            if not _is_safe_scan_url(receipt_url):
                logger.warning(
                    "scan_image fetch refused (host not allow-listed): %s",
                    receipt_url[:80],
                )
                return None, None
            from urllib.request import Request, urlopen
            req = Request(receipt_url, headers={"User-Agent": "BonBox/1.0"})
            with urlopen(req, timeout=8) as resp:  # noqa: S310 — host allow-listed above
                data = resp.read()
            return data, "z_report.jpg"
        # Local path branch — read from disk, CONFINED to an allowed root.
        # In prod, storage is Supabase so receipt_photo is always an https URL
        # and this branch isn't reached; the local path is dev/test only. We
        # still confine it so a crafted absolute receipt_photo can't turn the
        # close→revisor email attach into a local-file read (e.g. /etc/passwd,
        # app source, a .env) — auth+tier-gated self-exfil (Jun-2026 leak sweep).
        # Allowed roots: the uploads/ dir always; the system temp dir only
        # outside production (pytest's tmp_path lives there, keeping
        # test_close_auto_email green without weakening prod).
        from pathlib import Path
        import tempfile
        from app.config import settings as _settings
        p = Path(receipt_url)
        allowed_roots = [Path("uploads").resolve()]
        if (_settings.ENVIRONMENT or "").lower() != "production":
            allowed_roots.append(Path(tempfile.gettempdir()).resolve())
        try:
            resolved = p.resolve()
            within = any(
                resolved == root or root in resolved.parents
                for root in allowed_roots
            )
        except Exception:  # noqa: BLE001
            within = False
        if within and p.is_file():
            return p.read_bytes(), p.name
        logger.warning(
            "scan_image local read refused (outside allowed roots): %s",
            str(receipt_url)[:80],
        )
        return None, None
    except Exception as e:  # noqa: BLE001
        logger.warning("scan_image fetch failed: %s", e)
    return None, None


def _compute_bank_drop_hint(dc: DailyClose) -> dict | None:
    """Build the bank-drop reminder block for the locked-state card.
    Universal (all tiers — low cost).

    The hint is informational — it tells the staff how much cash is
    currently in the drawer per their count, and suggests a "leave a
    float of 1.000 DKK, bag the rest" rule. Owners can fine-tune via
    the Profile page later (out of scope for Lane A).
    """
    counted = float(dc.cash_counted) if dc.cash_counted is not None else None
    if counted is None or counted <= 0:
        return None
    # cash_counted is the day's TAKINGS — the form counts the whole drawer and
    # takes the float off before saving, which is also what cash_difference
    # compares with cash sales. So all of it goes in the bag and the float
    # (which the server never sees) stays in the drawer. This used to subtract
    # a fixed 1.000 kr. "float" from the takings a second time, telling the
    # owner to keep 1.000 kr. of the day's money back.
    return {
        "counted_dkk": round(counted, 2),
        "leave_in_drawer_dkk": None,
        "to_drop_dkk": round(counted, 2),
    }


def _close_attachment(db: Session, user: User, dc: DailyClose, profile) -> tuple[bytes, str, str]:
    """(pdf_bytes, filename, doc_id) of the kasserapport that goes to the
    revisor for ONE close. The same document the owner downloads from History
    (services/close_kasserapport_pdf.py) — one builder, one readiness verdict,
    one document id."""
    from app.services.close_kasserapport_pdf import build_close_kasserapport_pdf
    out = build_close_kasserapport_pdf(db, user, dc, profile=profile)
    return out["pdf"], out["filename"], out["doc_id"]


def _persist_email_status(db: Session, dc: DailyClose, result: dict) -> None:
    """Write the lock-mail outcome onto the close so History can show it after
    a reload. Never raises into the lock path."""
    try:
        dc.email_status = result.get("email_status")
        dc.email_error = (result.get("email_error") or None)
        dc.email_attempt_at = utc_now()
        if result.get("sent_to"):
            dc.email_sent_at = dc.email_attempt_at
            dc.email_sent_to = ",".join(result["sent_to"])
        db.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning("close_auto_email: persisting status failed close_id=%s: %s", dc.id, e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


def _ritual_from_row(dc: DailyClose) -> dict:
    """The close_ritual block rebuilt from the persisted status — what a
    replayed resend (same idempotency key) answers with."""
    return {
        "email_status": dc.email_status,
        "email_error": dc.email_error,
        "sent_to": [x for x in (dc.email_sent_to or "").split(",") if x],
        "sent_at": dc.email_sent_at,
    }


def _fire_close_auto_email(
    db: Session,
    request: Request,
    user: User,
    dc: DailyClose,
    *,
    explicit: bool = False,
) -> dict:
    """Send the lock mail — one copy to the owner, one to the revisor — and
    return an honest status block the frontend renders.

        {
            "feature_available": bool,       # tier has close_auto_email
            "preference_on": bool,           # owner's lock-mail switch
            "email_status": "...",           # sent | partial | send_failed |
                                             # failed_skipped | skipped_*
            "email_error": str | None,       # the real cause, never "environment"
                                             # for everything
            "sent_to": [...],
            "accountant_email": str | None,
            "accountant_included": bool,     # did the revisor get THIS mail?
            "accountant_skip_reason": None | "not_saved" | "auto_send_off" |
                                      "opted_out" | "same_as_owner" | "daily_cap" |
                                      "demo_recipient" | "demo_close" |
                                      "demo_identity" | "unchanged" |
                                      "email_unverified" |
                                      "claim_question_open",
            "correction": bool,              # marked "Rettet kasserapport"
            "has_scan", "scan_degraded", "pdf_hash", "push_status",
            "bank_drop", "upgrade_hint",
        }

    There is NO background retry. A failed send says so ("send_failed") and the
    owner resends from the card or History (POST /{id}/resend-email). The
    result is persisted on the close (email_status / email_sent_at / …).

    `explicit=True` is the owner's own "Send igen" — it ignores the automatic
    switches (the owner just asked) but still honours the tier, the saved
    address and the revisor's opt-out. NEVER raises into the lock flow.

    Correction marking is decided HERE, per recipient, from the audit trail
    (_correction_for): a recipient who already received an earlier version of
    this close gets "Rettet kasserapport … erstatter …" — on the re-lock's own
    mail AND on any later resend, and never a recipient who got nothing before.
    """
    result: dict[str, Any] = {
        "feature_available": False,
        "preference_on": bool(getattr(user, "auto_email_on_close", True)),
        "email_status": "skipped_feature_locked",
        "email_error": None,
        "sent_to": [],
        "accountant_email": None,
        "accountant_included": False,
        "accountant_skip_reason": None,
        "correction": False,
        "has_scan": False,
        "scan_degraded": False,
        "pdf_hash": None,
        "push_status": "skipped_feature_locked",
        "bank_drop": _compute_bank_drop_hint(dc),
        "upgrade_hint": None,
    }

    feature_on = has_feature(user, "close_auto_email")
    result["feature_available"] = feature_on

    if not feature_on:
        from app.services.billing import feature_locked_detail
        result["upgrade_hint"] = feature_locked_detail(user, "close_auto_email")
        try:
            record_feature_skip(
                user, "close_auto_email",
                {"close_id": str(dc.id), "stage": "lock_handler"},
            )
        except Exception:  # noqa: BLE001
            pass
        _persist_email_status(db, dc, result)
        return result

    pref_on = bool(getattr(user, "auto_email_on_close", True))
    result["preference_on"] = pref_on
    if not pref_on and not explicit:
        result["email_status"] = "skipped_preference_off"
        _persist_email_status(db, dc, result)
        result["push_status"] = _fire_close_push(db, user, dc)
        return result

    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()
    business_name = _business_display_name(profile, user)
    currency = user.currency or "DKK"
    is_danish = (currency == "DKK")
    from app.services.tz_utils import _user_zone
    tz = _user_zone(user)

    # ── Recipients ──
    # One owner address for the owner's copy AND the revisor's Reply-To: the
    # login. An address that opted out gets no owner copy either.
    owner_email = _owner_contact_email(profile, user)
    if owner_email and not _owner_copy_allowed(profile, owner_email):
        owner_email = ""
    from app.services.revisor_mail import (
        REVISOR_DAILY_CAP, address_fingerprint, is_demo_identity, is_demo_revisor,
        revisor_daily_cap_reached, revisor_opted_out, revisor_unsubscribe_headers,
        revisor_unsubscribe_url, saved_revisor_address, sender_display,
        held_sender_reason,
    )
    from app.services.email_service import html_to_text
    acct = saved_revisor_address(profile)
    result["accountant_email"] = acct or None
    if not acct:
        skip = "not_saved"
    elif is_demo_revisor(profile, acct):
        # The demo seeder's sample revisor on a demo-seeded profile: NOT SAVED
        # for every send — a real close locked after trying the demo must
        # never reach an address the owner never typed.
        skip = "demo_recipient"
    elif _is_demo_close(dc):
        skip = "demo_close"
    elif is_demo_identity(profile, user):
        # A REAL day and a real revisor — but the business is still the demo
        # seeder's sample company: the mail, its From, its footer and the
        # kasserapport would name "Mirabelle ApS (CVR 39842851)". A revisor
        # cannot book a voucher under another legal entity (and may well
        # unsubscribe a sender they do not know). The owner's copy says why.
        skip = "demo_identity"
    elif revisor_opted_out(profile, acct):
        skip = "opted_out"
    elif acct == owner_email:
        skip = "same_as_owner"
    elif not explicit and not getattr(profile, "accountant_auto_send_effective", True):
        skip = "auto_send_off"
    elif (held := held_sender_reason(user)):
        # Mail to the revisor needs the owner's own e-mail confirmed (Manoj,
        # 8 Oct). The lock and the owner's own copy still happen; that copy
        # and the card say "Ikke sendt til revisoren — bekræft din e-mail
        # først". Explicit too: "Send igen" refuses earlier (403) — this is
        # the backstop, never a revisor mail from an unconfirmed account.
        # A CONFIRMED address whose "did you create this account?" question
        # is still open is held too, under its own reason
        # "claim_question_open" — the true one (release gate, 9 Oct).
        skip = held
    elif not explicit and revisor_daily_cap_reached(db, user):
        # The lock mail counts towards the per-account ceiling on mail to a
        # third party, like every other revisor send. At the cap the revisor
        # copy is skipped — the lock itself never fails — and the owner is
        # told why. (An explicit resend is capped by its own route: 429.)
        skip = "daily_cap"
    else:
        skip = None
    include_acct = skip is None

    # Unlock + re-lock with NOTHING changed: the revisor already holds this
    # exact kasserapport, so a "Rettet kasserapport … Tallene er de samme" is
    # a second mail with nothing to book. Skipped (recorded on the audit row as
    # accountant_skip_reason "unchanged"), the owner is told "uændret", and
    # "Send igen" (explicit) still sends it. Only when EVERY line was compared
    # (lines_known) AND everything else the kasserapport prints — Drikkepenge,
    # byttepenge, Lukket af, notes, source, photo — matches the held version
    # (same_document). An older version without that record, or any printed
    # difference, still gets the marked correction.
    trail = None
    acct_correction = None
    if include_acct:
        trail = _close_audit_trail(db, user, dc)
        acct_correction = _correction_for(trail, dc, acct, currency)
        if (not explicit and acct_correction and acct_correction.get("lines_known")
                and not acct_correction.get("changes")
                and acct_correction.get("same_document")):
            skip = "unchanged"
            result["unchanged_since"] = acct_correction.get("prev_sent_at")
            include_acct = False
            acct_correction = None
    result["accountant_skip_reason"] = skip

    if not owner_email and not include_acct:
        result["email_status"] = "skipped_no_recipient"
        result["email_error"] = "no_recipient"
        audit_service.record(
            db, user=user, action="close.auto_emailed",
            entity_type="daily_close", entity_id=dc.id,
            before={"recipients": [], "has_scan": False, "pdf_hash": None},
            after={"email_status": "skipped_no_recipient", "message_id": None},
            ip_address=getattr(request.client, "host", None) if request.client else None,
        )
        _persist_email_status(db, dc, result)
        result["push_status"] = _fire_close_push(db, user, dc)
        return result

    # ── The attachment: the SAME kasserapport the owner reads in History ──
    try:
        pdf_bytes, pdf_filename, doc_id = _close_attachment(db, user, dc, profile)
    except Exception as e:  # noqa: BLE001
        logger.exception("close_auto_email: PDF build failed close_id=%s: %s", dc.id, e)
        result["email_status"] = "failed_skipped"
        result["email_error"] = "pdf_build_failed"
        _persist_email_status(db, dc, result)
        return result
    pdf_hash = compute_document_hash(pdf_bytes)
    result["pdf_hash"] = pdf_hash
    result["doc_id"] = doc_id

    scan_bytes, scan_filename = (None, None)
    scan_supposed_to_attach = has_feature(user, "close_scan_attached")
    receipt_url = getattr(dc, "receipt_photo", None)
    if scan_supposed_to_attach and receipt_url:
        scan_bytes, scan_filename = _fetch_scan_bytes_best_effort(receipt_url)
    scan_degraded = bool(scan_supposed_to_attach and receipt_url and not scan_bytes)
    result["scan_degraded"] = scan_degraded

    from app.services.close_kasserapport_pdf import _branch_name, close_bilagsnummer
    branch = _branch_name(db, user, dc)
    if trail is None:
        trail = _close_audit_trail(db, user, dc)
    owner_correction = _correction_for(trail, dc, owner_email, currency) if owner_email else None
    result["correction"] = bool(acct_correction or owner_correction)

    common = dict(
        business_name=business_name, dc=dc, currency=currency,
        closed_by=dc.closed_by, has_scan=bool(scan_bytes),
        scan_degraded=scan_degraded, is_danish=is_danish,
        attachment_name=pdf_filename, tz=tz, branch=branch,
        # A sample close is no voucher: its kasserapport has no bilag number,
        # and the mail does not name one either.
        bilagsnummer=("" if _is_demo_close(dc) else close_bilagsnummer(dc, branch)),
        doc_id=doc_id,
    )

    from app.services.email_service import send_close_notification
    sends: list[tuple[str, dict]] = []

    # The revisor's copy first: it carries the opt-out and List-Unsubscribe,
    # which must apply to the revisor only — the owner's own copy has neither.
    if include_acct:
        unsub_url = revisor_unsubscribe_url(user.id, acct)
        subject, html = _build_close_email_html(
            **common, audience="revisor", correction=acct_correction,
            accountant_name=getattr(profile, "accountant_name", None),
            cvr=getattr(profile, "org_number", None), unsubscribe_url=unsub_url,
        )
        if not explicit:
            # Counted towards the daily cap (REVISOR_SEND_ACTIONS). An explicit
            # resend is counted by its own daily_close.resend_email row.
            audit_service.record(
                db, user=user, action="daily_close.revisor_lock_mail",
                entity_type="daily_close", entity_id=dc.id,
                after={"recipient_fingerprint": address_fingerprint(acct),
                       "correction": bool(acct_correction)},
                ip_address=getattr(request.client, "host", None) if request.client else None,
            )
        sends.append(("revisor", send_close_notification(
            user, close_id=dc.id, pdf_bytes=pdf_bytes, scan_image_bytes=scan_bytes,
            pdf_filename=pdf_filename, scan_filename=scan_filename,
            recipients=[acct], subject=subject, html=html,
            reply_to=owner_email or user.email,
            headers=revisor_unsubscribe_headers(unsub_url),
            from_display=sender_display(business_name),
            text=html_to_text(html),
        )))

    if owner_email:
        acct_sent = bool(sends and sends[0][1].get("status") == "sent")
        from app.services.daily_close_range_export import dk_datetime
        from app.services.revisor_mail import (
            DEMO_IDENTITY_MESSAGE_DA, DEMO_IDENTITY_MESSAGE_EN,
            DEMO_RECIPIENT_MESSAGE_DA, DEMO_RECIPIENT_MESSAGE_EN,
        )
        unchanged_when = dk_datetime(result.get("unchanged_since"), tz, danish=is_danish)
        if is_danish:
            revisor_line = {
                # "Afleveret til mailserveren": the mail service took it; a
                # delivery into the revisor's inbox is not confirmed to BonBox.
                None: (f"Den samme mail er afleveret til mailserveren til revisoren ({acct})." if acct_sent
                       else f"Mailen til revisoren ({acct}) blev IKKE sendt — send igen fra Historik."),
                "not_saved": "Revisoren fik ikke mailen: der er ingen revisor-mail gemt under Profil.",
                "auto_send_off": "Revisoren fik ikke mailen: automatisk afsendelse til revisor er slået fra under Profil.",
                "opted_out": f"Revisoren ({acct}) har afmeldt mails fra BonBox og fik ikke denne.",
                "same_as_owner": None,
                "demo_close": "Revisoren fik ikke mailen: dagen er eksempeldata (demo).",
                "demo_recipient": DEMO_RECIPIENT_MESSAGE_DA,
                "demo_identity": f"Revisoren ({acct}) fik ikke mailen. {DEMO_IDENTITY_MESSAGE_DA}",
                "unchanged": (f"Revisoren ({acct}) fik ikke en ny mail — tallene er uændrede "
                              f"siden versionen, der blev sendt {unchanged_when or 'tidligere'}. "
                              "Skal revisoren have den igen, så tryk Send igen i Historik."),
                "daily_cap": (f"Revisoren ({acct}) fik ikke mailen: BonBox sender højst "
                              f"{REVISOR_DAILY_CAP} mails om dagen til revisoren, og loftet er nået. "
                              "Send den fra Historik i morgen, eller fra din egen mail."),
                "email_unverified": (f"Ikke sendt til revisoren ({acct}) — bekræft din e-mail først "
                                     "(Profil → Ikke bekræftet). Bagefter kan du sende den "
                                     "fra Historik, eller sende denne mail videre selv."),
                # The address IS confirmed: held because "did you create this
                # account yourself?" waits for an answer (revisor_mail.
                # claim_question_pending) — say that, not "confirm your e-mail".
                "claim_question_open": (f"Ikke sendt til revisoren ({acct}) — din e-mail er bekræftet, "
                                        "men BonBox venter på dit svar på spørgsmålet, vi har mailet "
                                        "dig: Har du selv oprettet denne konto? Svar via linket i den "
                                        "mail. Bagefter kan du sende den fra Historik, eller sende "
                                        "denne mail videre selv."),
            }[skip]
        else:
            revisor_line = {
                None: (f"The same mail was handed to the mail server for your accountant ({acct})." if acct_sent
                       else f"The mail to your accountant ({acct}) was NOT sent — resend it from History."),
                "not_saved": "Your accountant didn't get it: no accountant e-mail is saved on Profile.",
                "auto_send_off": "Your accountant didn't get it: automatic sending to them is off on Profile.",
                "opted_out": f"Your accountant ({acct}) unsubscribed from BonBox mail and didn't get this.",
                "same_as_owner": None,
                "demo_close": "Your accountant didn't get it: this day is sample (demo) data.",
                "demo_recipient": DEMO_RECIPIENT_MESSAGE_EN,
                "demo_identity": f"Your accountant ({acct}) didn't get it. {DEMO_IDENTITY_MESSAGE_EN}",
                "unchanged": (f"Your accountant ({acct}) didn't get a new mail — the figures are "
                              f"unchanged since the version sent {unchanged_when or 'earlier'}. "
                              "To send it again, tap Send again in History."),
                "daily_cap": (f"Your accountant ({acct}) didn't get it: BonBox sends them at most "
                              f"{REVISOR_DAILY_CAP} mails a day and that limit is reached. "
                              "Send it from History tomorrow, or from your own mail."),
                "email_unverified": (f"Not sent to your revisor ({acct}) — confirm your e-mail first "
                                     "(Profile → Unverified). Then send it from History, "
                                     "or forward this mail yourself."),
                "claim_question_open": (f"Not sent to your revisor ({acct}) — your e-mail is confirmed, "
                                        "but BonBox is waiting for your answer to the question we "
                                        "e-mailed you: did you create this account yourself? Answer "
                                        "from the link in that e-mail. Then send it from History, "
                                        "or forward this mail yourself."),
            }[skip]
        subject, html = _build_close_email_html(
            **common, audience="owner", revisor_line=revisor_line,
            correction=owner_correction,
        )
        sends.append(("owner", send_close_notification(
            user, close_id=dc.id, pdf_bytes=pdf_bytes, scan_image_bytes=scan_bytes,
            pdf_filename=pdf_filename, scan_filename=scan_filename,
            recipients=[owner_email], subject=subject, html=html, reply_to=owner_email,
            text=html_to_text(html),
        )))

    # ── Aggregate, honestly ──
    statuses = [r["status"] for _who, r in sends]
    sent_to: list[str] = []
    for _who, r in sends:
        if r["status"] == "sent":
            sent_to.extend(r["sent_to"])
    errors = [r.get("error") for _who, r in sends if r["status"] != "sent" and r.get("error")]
    if not sends:
        # Nothing was attempted (the revisor's copy skipped as unchanged and
        # no owner address) — never "send_failed" for a send that never ran.
        status = "skipped_no_recipient"
    elif statuses and all(st == "sent" for st in statuses):
        status = "sent"
    elif sent_to:
        status = "partial"
    elif any(st == "failed_skipped" for st in statuses):
        status = "failed_skipped"
    else:
        status = "send_failed"
    result["email_status"] = status
    result["email_error"] = errors[0] if errors else None
    if skip == "unchanged" and not result["email_error"]:
        # Persisted with the status, so History still says "uændret" after a
        # reload (the skip reason itself is only on the audit row).
        result["email_error"] = "revisor_unchanged"
    if skip in ("email_unverified", "claim_question_open"):
        # Likewise: History says "Ikke sendt til revisoren — bekræft din
        # e-mail først" (or "… venter på dit svar") after a reload, not "Sent
        # to you — not to your revisor". When the owner's own copy failed too,
        # BOTH facts are kept — "revisor_<reason>;<the copy's error>" — so
        # History says why the revisor got nothing AND why the copy failed,
        # never "mail sending isn't set up" with a Send button that would be
        # refused (release gate, 9 Oct). email_error is VARCHAR(64).
        marker = f"revisor_{skip}"
        owner_err = result["email_error"]
        result["email_error"] = (f"{marker};{owner_err}" if owner_err else marker)[:64]
    result["sent_to"] = sent_to
    result["accountant_included"] = bool(include_acct and acct in sent_to)
    result["has_scan"] = any(r.get("has_scan") for _who, r in sends)

    audit_service.record(
        db, user=user,
        action="close.auto_emailed",
        entity_type="daily_close",
        entity_id=dc.id,
        before={
            "recipients": ([acct] if include_acct else []) + ([owner_email] if owner_email else []),
            "has_scan": bool(scan_bytes),
            "pdf_hash": pdf_hash,
            "doc_id": doc_id,
        },
        after={
            "email_status": status,
            "email_error": result["email_error"],
            "sent_to": sent_to,
            "scan_degraded": scan_degraded,
            "correction": bool(acct_correction),
            "explicit": explicit,
            "accountant_skip_reason": skip,
            "unchanged_since": (result["unchanged_since"].isoformat()
                                if result.get("unchanged_since") else None),
        },
        ip_address=getattr(request.client, "host", None) if request.client else None,
    )
    # The audit row and the status must survive the request: get_db does not
    # commit, so without this the "close.auto_emailed" row was only kept when
    # the Pro push path happened to commit.
    _persist_email_status(db, dc, result)

    if status != "sent":
        try:
            from app.services.billing import _record_gate_refusal
            _record_gate_refusal(
                user, "gate_skipped.close_auto_email_failed",
                {
                    "close_id": str(dc.id),
                    "email_status": status,
                    "error": result["email_error"],
                    "recipients_count": len(sends),
                    "scan_degraded": scan_degraded,
                },
            )
        except Exception:  # noqa: BLE001
            pass

    result["push_status"] = _fire_close_push(db, user, dc) if not explicit else "skipped_explicit"
    return result


def _fire_close_push(db: Session, user: User, dc: DailyClose) -> str:
    """Send a privacy-safe push to the owner that staff just locked
    the close. Pro-only feature; degrades gracefully when there's no
    push subscription, no VAPID config, or pywebpush isn't installed.

    Returns the status string the response payload includes:
        "sent" | "skipped_feature_locked" | "skipped_no_subscription"
        | "queued_retry" | "failed_skipped"
    """
    if not has_feature(user, "close_push_notification"):
        return "skipped_feature_locked"
    try:
        from app.models.push_subscription import PushSubscription
        from app.services.push_sender import send_to_subscription
        subs = db.query(PushSubscription).filter(
            PushSubscription.user_id == user.id,
        ).all()
        if not subs:
            return "skipped_no_subscription"
        # Privacy-safe payload — no amounts, no customer names, only
        # a generic "close locked" notification. Owner taps to open
        # the Daily Close history page.
        from app.services.owner_language import owner_lang
        is_danish = owner_lang(user) == "da"
        title = "BonBox · Dagsafslutning låst" if is_danish else "BonBox · Close locked"
        # `kasserapport` stays Danish in English too (DK terminology lock).
        body = (
            f"{dc.closed_by or 'Personalet'} har låst dagens kasserapport."
            if is_danish else
            f"{dc.closed_by or 'Staff'} locked today's kasserapport."
        )
        payload = {
            "title": title, "body": body[:140],
            "tag": "bonbox-close-locked",
            "data": {"url": "/daily-close"},
        }
        any_ok = False
        for sub in subs:
            res = send_to_subscription(sub, payload)
            if res.get("ok"):
                any_ok = True
        try:
            db.commit()
        except Exception:  # noqa: BLE001
            pass
        return "sent" if any_ok else "queued_retry"
    except Exception as e:  # noqa: BLE001
        logger.warning("close_push: failed user=%s err=%s", user.id, e)
        return "failed_skipped"


def _momsfri_sales_for_date(db: Session, *, user: User, target_date) -> float | None:
    """The day's MOMS-free (tax-exempt) sales as the server sees them, or None
    when they cannot be read.

    The same figure the close page shows and sends as exempt_sales_total: the
    property report's total_revenue − taxable_sales for the business day (same
    rows, same void/return rules, same cutoff resolution). Used to check the
    page's claim before it may keep an auto MOMS — never to compute one.
    """
    try:
        from app.routers.property_report import property_financial_report
        had_cutoff = hasattr(user, "day_cutoff_hour")
        prev_cutoff = getattr(user, "day_cutoff_hour", None)
        try:
            report = property_financial_report(
                report_date=target_date, day_cutoff_hour=6, db=db, user=user,
            )
        finally:
            # The report stashes the resolved cutoff on the user object; the
            # save that called it must not see a different one afterwards.
            if had_cutoff:
                user.day_cutoff_hour = prev_cutoff
            else:
                try:
                    del user.day_cutoff_hour
                except AttributeError:
                    pass
        if not isinstance(report, dict) or report.get("_error"):
            return None
        totals = report.get("totals") or {}
        exempt = float(totals.get("total_revenue") or 0) - float(totals.get("taxable_sales") or 0)
        return max(0.0, round(exempt, 2))
    except Exception as e:  # noqa: BLE001 — a failed lookup only means "not shown"
        logger.warning("daily_close: MOMS-free lookup failed user=%s date=%s: %s", user.id, target_date, e)
        return None


def _register_cash_for_date(db: Session, *, user: User, target_date, branch_id) -> float | None:
    """Cash the POS register says was taken on `target_date`.

    Sums completed, non-deleted `Sale` rows whose payment method maps to
    cash (`cash` / `kontant`) for the day — the SAME grouping the
    /daily-close/prefill endpoint uses (kontant → cash). This is the REAL
    expected-cash baseline for the drawer variance: counted drawer vs what
    the till recorded, which surfaces a genuine shortage/theft instead of
    the self-referential "typed cash vs counted cash".

    Returns None when the date has NO completed sales at all — i.e. there is
    no synced register to compare against (pure manual / cash-only closers).
    In that case the caller falls back to the payment-breakdown cash the
    owner typed, preserving the prior behaviour for those users. Returns 0.0
    when there ARE sales but none were cash (legit "no cash today"), so the
    variance still anchors on the register.

    Fail-soft: any DB error returns None → graceful fall back to typed cash.
    """
    try:
        q = db.query(Sale).filter(
            Sale.user_id == user.id,
            Sale.date == target_date,
            Sale.is_deleted.isnot(True),
            Sale.status == "completed",
        )
        if branch_id:
            q = q.filter(Sale.branch_id == branch_id)
        # No synced register for the day → let the caller fall back.
        if q.count() == 0:
            return None
        cash_methods = ("cash", "kontant")
        cash_total = (
            q.filter(func.lower(Sale.payment_method).in_(cash_methods))
            .with_entities(func.coalesce(func.sum(Sale.amount), 0))
            .scalar()
        )
        return round(float(cash_total or 0), 2)
    except Exception:  # noqa: BLE001
        return None


# ─── POST — submit daily close ───

def _dead_draft_figures(dead) -> dict:
    """What a soft-deleted draft held, for the audit row of the close that
    takes its place (close.restored `before`): its figures, cash, photo and
    source — the reused row's columns are the new close's.

    Never the draft's free-text note, only THAT it had one (had_notes). The
    note can name staff or illness; audit_logs is append-only, left out of
    the GDPR export (/auth/export-data) and kept by account erasure for the
    legal hold — the note would become text the owner can neither see in an
    export nor erase. While the draft row held it, both worked. No other
    daily_close audit row holds free text either (a lock row keeps only a
    digest of what prints, _content_signature)."""
    def _f(v):
        try:
            return None if v is None else round(float(v), 2)
        except (TypeError, ValueError):
            return None
    created = getattr(dead, "created_at", None)
    return {
        "revenue_total": _f(dead.revenue_total),
        "moms_total": _f(dead.moms_total),
        "revenue_breakdown": decode_breakdown(dead.revenue_categories) or {},
        "payment_breakdown": decode_breakdown(dead.payment_categories) or {},
        "cash_counted": _f(dead.cash_counted),
        "cash_expected": _f(dead.cash_expected),
        "cash_float": _f(getattr(dead, "cash_float", None)),
        "tips_total": _f(dead.tips_total),
        "had_notes": bool((dead.notes or "").strip()),
        "closed_by": dead.closed_by,
        "receipt_photo": dead.receipt_photo,
        "source_meta": dead.source_meta,
        "created_at": created.isoformat() if created else None,
    }


DRAFT_CHANGED = "draft_changed"


def _naive_utc(ts):
    """A datetime as the naive UTC the columns hold (an aware one converted)."""
    from datetime import timezone as _tz
    if ts is None:
        return None
    if ts.tzinfo is not None:
        ts = ts.astimezone(_tz.utc).replace(tzinfo=None)
    return ts


def _last_save_id(db, user, close_id) -> str | None:
    """The page's own id for the save that wrote this close last (its
    `save_id`, kept on the daily_close create / update / lock audit row), or
    None. Read only when a page says its save follows one of its own still on
    its way (base_save_id)."""
    import json as _json
    try:
        from app.models.audit_log import AuditLog
        row = (
            db.query(AuditLog)
            .filter(
                AuditLog.user_id == user.id,
                AuditLog.entity_type == "daily_close",
                AuditLog.entity_id == close_id,
                AuditLog.action.in_(("daily_close.create", "daily_close.update", "daily_close.lock")),
            )
            .order_by(AuditLog.created_at.desc())
            .first()
        )
        after = _json.loads(row.after_state or "{}") if row is not None else {}
    except Exception:  # noqa: BLE001
        return None
    sid = after.get("save_id") if isinstance(after, dict) else None
    return sid if isinstance(sid, str) and sid else None


def _last_save_ids(db, user, close_ids) -> dict | None:
    """{str(close_id): save_id | None} for these closes, in ONE query (round
    22): the page's own id for the save that wrote each last, as
    _last_save_id reads it one row at a time. A page whose save got no answer
    (stored, the answer lost) reads its day with this before it takes a
    draft back — the row is its own exactly when the save that wrote it last
    is one the page sent. Bounded by the rows asked for (a day: one per
    branch); History's list never asks for it.

    None when the audit trail could not be read (round 22 review): "couldn't
    check" is not "written by a save with no id" — the caller then names no
    last_save_id at all, and the page treats the row as unknown, never as
    saved somewhere else."""
    import json as _json
    ids = [cid for cid in close_ids if cid is not None]
    out = {str(cid): None for cid in ids}
    if not ids:
        return out
    try:
        from app.models.audit_log import AuditLog
        rows = (
            db.query(AuditLog.entity_id, AuditLog.after_state)
            .filter(
                AuditLog.user_id == user.id,
                AuditLog.entity_type == "daily_close",
                AuditLog.entity_id.in_(ids),
                AuditLog.action.in_(("daily_close.create", "daily_close.update", "daily_close.lock")),
            )
            .order_by(AuditLog.created_at.desc())
            .all()
        )
    except Exception:  # noqa: BLE001
        return None
    seen = set()
    for entity_id, after_state in rows:
        k = str(entity_id)
        if k in seen:
            continue
        seen.add(k)
        try:
            after = _json.loads(after_state or "{}")
        except Exception:  # noqa: BLE001
            after = {}
        sid = after.get("save_id") if isinstance(after, dict) else None
        out[k] = sid if isinstance(sid, str) and sid else None
    return out


def _draft_changed_since(existing, base, base_save_id=None, *, db=None, user=None) -> dict | None:
    """The 412 detail when the stored DRAFT is newer than the version the
    page holds (`base`, its base_updated_at), else None.

    Only a live draft is checked — a locked row keeps its own 409 — and only
    when the page sent a base: an older app build sends none and saves as it
    always did. A base equal to (or newer than) the stored version is the
    page's own latest. The detail carries the stored draft, so the page can
    show it and offer it.

    `base_save_id`: the page's own save still on its way when this one went
    (the page was going away — no time to wait for its answer). When the
    stored version is the one THAT save wrote, it is the page's own and this
    save follows it; anyone else's version in between is still refused."""
    if existing is None or base is None:
        return None
    if (getattr(existing, "status", None) or "confirmed") != "draft":
        return None
    stored = _naive_utc(getattr(existing, "updated_at", None))
    if stored is None or stored <= _naive_utc(base):
        return None
    if base_save_id and db is not None and user is not None and _last_save_id(db, user, existing.id) == base_save_id:
        return None
    from fastapi.encoders import jsonable_encoder
    return {
        "code": DRAFT_CHANGED,
        "message": ("Kladden for denne dag er gemt et andet sted, efter du åbnede den. "
                    "Intet er overskrevet — hent den nyeste kladde, eller behold dine tal."),
        "updated_at": stored.isoformat(),
        "current": jsonable_encoder(_to_response(existing)),
    }


def _claim_draft_version(db, existing, data, user) -> None:
    """Hold the stored draft at the version just checked until this save
    commits (round 21 review). The check above reads the row without a lock
    and the ORM's UPDATE has no version condition: two saves built on the
    same version both passed it on Postgres (READ COMMITTED), the second
    waited on the first's row lock and then wrote over it — both answered
    200, and the version in between was lost with nobody told (the page's
    own older save landing after its newer one, or another phone's).

    A compare-and-set: UPDATE … SET updated_at = <stored> WHERE id = … AND
    updated_at = <stored>. It changes nothing, takes the row lock (held to
    this save's commit), and touches no row when another save committed a
    newer version first — that version is then read and checked like the
    first one (refused 412 draft_changed, or, when it is the page's own save
    still on its way that this one follows — base_save_id — claimed in its
    turn). A row locked or deleted meanwhile is left to the save's own rules
    (the locked-row 409)."""
    for _ in range(3):
        stamp = existing.updated_at
        hit = (
            db.query(DailyClose)
            .filter(DailyClose.id == existing.id, DailyClose.updated_at == stamp)
            .update({DailyClose.updated_at: stamp}, synchronize_session=False)
        )
        if hit:
            return
        db.refresh(existing)
        if (getattr(existing, "status", None) or "confirmed") != "draft" or existing.is_deleted:
            return
        if existing.updated_at == stamp:
            # No newer version — the stamp did not compare equal as stored
            # (a legacy value): never a refusal for that; the row lock alone.
            db.query(DailyClose).filter(DailyClose.id == existing.id).with_for_update().first()
            return
        changed = _draft_changed_since(existing, data.base_updated_at, data.base_save_id, db=db, user=user)
        if changed is not None:
            raise HTTPException(status_code=412, detail=changed)
    from fastapi.encoders import jsonable_encoder
    raise HTTPException(status_code=412, detail={
        "code": DRAFT_CHANGED,
        "message": ("Kladden for denne dag er gemt et andet sted, efter du åbnede den. "
                    "Intet er overskrevet — hent den nyeste kladde, eller behold dine tal."),
        "updated_at": _naive_utc(existing.updated_at).isoformat() if existing.updated_at else None,
        "current": jsonable_encoder(_to_response(existing)),
    })


def _clean_source_meta(meta) -> str | None:
    """Keep only the known, bounded keys of the client's source description
    (see DailyClose.source_meta) and store it as JSON text."""
    import json as _json
    if not isinstance(meta, dict):
        return None
    kind = meta.get("kind")
    if kind not in ("zbon", "typed"):
        return None
    out: dict = {"kind": kind}
    scans = meta.get("scans")
    if isinstance(scans, int) and 0 < scans <= 20:
        out["scans"] = scans
    tt = [round(float(x), 2) for x in (meta.get("terminal_totals") or [])
          if isinstance(x, (int, float)) and not isinstance(x, bool)][:10]
    if tt:
        out["terminal_totals"] = tt
    # Each till's own figure before the owner corrected the day's total (the
    # bon's read total, or the typed till's): the kasserapport names those
    # and the correction separately, never the correction as one till's.
    # Kept only beside a till list of the same length.
    rt = [round(float(x), 2) for x in (meta.get("read_totals") or [])
          if isinstance(x, (int, float)) and not isinstance(x, bool)][:10]
    if kind == "zbon" and len(tt) >= 2 and len(rt) == len(tt):
        out["read_totals"] = rt
    corr = [str(x)[:40] for x in (meta.get("corrected") or []) if isinstance(x, str)][:20]
    if corr:
        out["corrected"] = corr
    # A Z-bon added to figures the owner typed (a close typed by hand, a
    # reopened draft): which tills were typed, not scanned (indexes into
    # terminal_totals), and which lines are the owner's own. Without them the
    # kasserapport printed a typed till as the second scanned one.
    if kind == "zbon":
        typed_tills = sorted({x for x in (meta.get("typed_tills") or [])
                              if isinstance(x, int) and not isinstance(x, bool) and 0 <= x < len(tt)})
        if typed_tills:
            out["typed_tills"] = typed_tills
        typed = [str(x)[:40] for x in (meta.get("typed") or []) if isinstance(x, str)][:20]
        if typed:
            out["typed"] = typed
    return _json.dumps(out)


def _clean_cash_float(v) -> float | None:
    """The float (byttepenge) is informational — printed on the kasserapport,
    never part of a figure. A stray "-500" or a mistyped huge value is dropped
    here rather than 422-ing the lock (an offline-queued lock would be
    dead-lettered over a number nothing is computed from)."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f < 0 or f > 1_000_000:  # NaN or out of range
        return None
    return round(f, 2)


def _clip_text(v, limit: int) -> str | None:
    """Informational text (Lukket af, notes) is cut to its column limit, never
    refused — same rule as _clean_cash_float. A 422 here failed the lock and
    sent an offline-queued close back as "refused, check the numbers"."""
    if v is None:
        return None
    return str(v)[:limit]


def _lock_lines(data) -> dict:
    """The lines a lock audit row records, so a later correction mail can say
    which payment method or category moved (not only the headline figures)."""
    def _clean(d):
        out = {}
        for k, v in (d or {}).items():
            try:
                out[str(k)[:40]] = round(float(v), 2)
            except (TypeError, ValueError):
                continue
        return out
    return {
        "revenue_breakdown": _clean(getattr(data, "revenue_breakdown", None)),
        "payment_breakdown": _clean(getattr(data, "payment_breakdown", None)),
        "cash_counted": getattr(data, "cash_counted", None),
    }


def _content_signature(dc) -> str:
    """A digest of everything the kasserapport prints for this close EXCEPT
    the lock time: the figures and lines, MOMS mode, the cash section (expected,
    counted, float, difference), Drikkepenge (total + how many shared them),
    Lukket af, notes, the figures' source and the Z-bon photo.

    A re-lock is "unchanged" for the revisor only when this matches the version
    they hold — _figure_changes compares the money a correction table lists,
    and missed a tips-only, float-only or notes-only correction, so the revisor
    kept an outdated kasserapport while the owner read "tallene er uændrede".
    Lines are folded the way _figure_changes folds them ('Food' = 'food', a
    zero line = no line), so a wizard round-trip does not read as a change.
    No query: the row is already loaded."""
    import hashlib
    import json as _json

    def _n(v):
        try:
            return None if v is None else round(float(v), 2)
        except (TypeError, ValueError):
            return None

    def _lines(raw):
        out: dict = {}
        for k, v in decode_breakdown(raw).items():
            key = str(k).strip().lower()
            out[key] = round(out.get(key, 0.0) + (_n(v) or 0.0), 2)
        return {k: v for k, v in sorted(out.items()) if abs(v) > 0.004}

    def _t(v):
        return (str(v).strip() or None) if v is not None else None

    canon = {
        "rev": _lines(getattr(dc, "revenue_categories", None)),
        "pay": _lines(getattr(dc, "payment_categories", None)),
        "revenue_total": _n(getattr(dc, "revenue_total", None)),
        "payment_total": _n(getattr(dc, "payment_total", None)),
        "moms_total": _n(getattr(dc, "moms_total", None)),
        "revenue_ex_moms": _n(getattr(dc, "revenue_ex_moms", None)),
        "moms_mode": getattr(dc, "moms_mode", None),
        "cash_expected": _n(getattr(dc, "cash_expected", None)),
        "cash_counted": _n(getattr(dc, "cash_counted", None)),
        "cash_difference": _n(getattr(dc, "cash_difference", None)),
        "cash_float": _n(getattr(dc, "cash_float", None)),
        # No tips and 0 tips print the same (no Drikkepenge section).
        "tips_total": _n(getattr(dc, "tips_total", None)) or 0.0,
        "tips_staff_count": int(getattr(dc, "tips_staff_count", None) or 0),
        "closed_by": _t(getattr(dc, "closed_by", None)),
        "notes": _t(getattr(dc, "notes", None)),
        "source": getattr(dc, "source_meta", None),
        "photo": getattr(dc, "receipt_photo", None),
        "branch_id": str(getattr(dc, "branch_id", None) or "") or None,
    }
    raw = _json.dumps(canon, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def _lock_doc_fields(dc) -> dict:
    """What a lock audit row records about the rest of the kasserapport, from
    the row as stored: the Drikkepenge and cash-section figures a correction
    mail lists (_figure_changes), and the signature of everything printed
    (_content_signature) that decides "unchanged"."""
    def _n(v):
        try:
            return None if v is None else round(float(v), 2)
        except (TypeError, ValueError):
            return None
    return {
        "tips_total": _n(getattr(dc, "tips_total", None)),
        "tips_staff_count": getattr(dc, "tips_staff_count", None),
        "cash_float": _n(getattr(dc, "cash_float", None)),
        "cash_expected": _n(getattr(dc, "cash_expected", None)),
        "doc_sig": _content_signature(dc),
    }


def _source_after_unlock_edit(existing, data, revenue_total, moms_total) -> str | None:
    """The source description for a reopened (unlocked) close that the owner
    edits by hand, or None to leave it as it is.

    Only when the client sent no new source (a rescan replaces it) and the
    figures actually changed. Keeps the kind, adds edited_after_unlock, and
    drops a till list that no longer adds up to the revenue."""
    import json as _json
    if not getattr(existing, "unlock_reason", None) or data.source_meta is not None:
        return None
    raw = getattr(existing, "source_meta", None)
    if not raw:
        return None
    try:
        meta = _json.loads(raw)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(meta, dict) or meta.get("kind") not in ("zbon", "typed"):
        return None

    def _n(v):
        try:
            return None if v is None else round(float(v), 2)
        except (TypeError, ValueError):
            return None

    def _bd(d):
        return {str(k): _n(v) for k, v in (d or {}).items() if _n(v)}

    changed = (
        _n(existing.revenue_total) != _n(revenue_total)
        or _n(existing.moms_total) != _n(moms_total)
        or _n(existing.cash_counted) != _n(data.cash_counted)
        or _bd(decode_breakdown(existing.payment_categories)) != _bd(data.payment_breakdown)
        or _bd(decode_breakdown(existing.revenue_categories)) != _bd(data.revenue_breakdown)
    )
    if not changed:
        return None
    meta["edited_after_unlock"] = True
    tt = [x for x in (meta.get("terminal_totals") or []) if isinstance(x, (int, float))]
    if tt and abs(sum(tt) - float(revenue_total or 0)) > 0.5:
        meta.pop("terminal_totals", None)
        meta.pop("read_totals", None)
    return _json.dumps(meta)


def _keep_unlock_mark(existing, client_meta, cleaned: str) -> str:
    """The source a client sends for a reopened (unlocked) close keeps the
    "rettet af ejeren efter oplåsning" mark.

    The mark is the server's own (_source_after_unlock_edit sets it on a hand
    edit; _clean_source_meta drops it from a client's meta), so any source
    the page sent afterwards — the reopened draft's own source told again
    after Start forfra — erased it, and the re-locked kasserapport presented
    figures typed after the unlock as never touched. Kept when the stored
    source has it; set when the page says the figures differ from the close
    as it was opened (it only ever adds the disclosure, and only on a close
    that is unlocked). A close that is not unlocked is stored as sent."""
    import json as _json
    if not getattr(existing, "unlock_reason", None):
        return cleaned
    had = False
    try:
        old = _json.loads(getattr(existing, "source_meta", None) or "null")
        had = isinstance(old, dict) and bool(old.get("edited_after_unlock"))
    except Exception:  # noqa: BLE001
        had = False
    says = isinstance(client_meta, dict) and client_meta.get("edited_after_unlock") is True
    if not (had or says):
        return cleaned
    meta = _json.loads(cleaned)
    meta["edited_after_unlock"] = True
    return _json.dumps(meta)


def _capture_extraction_correction(db, user, *, status, final_values):
    """Close the OCR learning loop: stamp what the owner ACTUALLY saved
    (final_json) onto the most recent uncommitted scan extraction for this
    user, plus user_corrected (did they change the model's totals?). The
    extracted_json ↔ final_json diff is the training signal for which POS
    layouts / fields the model misreads — fuel for the admin review +
    prompt/format tuning.

    Matches the latest open (committed_at IS NULL) /scan-report row within
    24h — a backend-only match so no extraction_id has to be threaded
    through the frontend (keeps this shippable via Render alone). Precise
    per-scan linking (multi-terminal days) is a later refinement. Never
    raises — a logging failure must never block a close.
    """
    try:
        from datetime import timedelta
        cutoff = utc_now() - timedelta(hours=24)
        row = (
            db.query(KasserapportExtraction)
            .filter(
                KasserapportExtraction.user_id == user.id,
                KasserapportExtraction.committed_at.is_(None),
                KasserapportExtraction.created_at >= cutoff,
            )
            .order_by(KasserapportExtraction.created_at.desc())
            .first()
        )
        if row is None:
            return  # close wasn't created from a scan (pure manual entry)

        row.final_json = final_values

        # user_corrected = did the saved totals differ from what OCR read?
        ext = row.extracted_json or {}

        def _close(a, b, tol=0.5):
            if a is None or b is None:
                return (a is None) == (b is None)
            try:
                return abs(float(a) - float(b)) <= tol
            except (TypeError, ValueError):
                return a == b

        row.user_corrected = not (
            _close(ext.get("revenue_total"), final_values.get("revenue_total"))
            and _close(ext.get("moms_total"), final_values.get("moms_total"))
        )
        # Only "close the book" on this extraction when the day is locked;
        # draft saves leave it open so a later edit can re-stamp final_json.
        if status == "confirmed":
            row.committed_at = utc_now()
        db.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning("daily_close: extraction correction-capture failed: %s", e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


@router.post("")
@_limiter.limit("30/minute")
def create_daily_close(
    request: Request,
    data: DailyCloseCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Cut informational text to length before any use (update path, create
    # path, audit payloads) — a long name or note never fails a lock.
    data.closed_by = _clip_text(data.closed_by, CLOSED_BY_MAX)
    data.notes = _clip_text(data.notes, NOTES_MAX)

    # Check for existing close on same date+branch (upsert)
    existing = (
        db.query(DailyClose)
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.date == data.date,
            DailyClose.branch_id == data.branch_id,
            DailyClose.is_deleted.isnot(True),
        )
        .first()
    )

    # A draft that changed since the page opened it is never replaced in
    # silence (round 21). Every save sends every field, so a page holding an
    # older copy — a save from its previous visit landed after it listed the
    # day, or another phone saved since — filed that copy over the newer
    # draft: a note typed on it erased a Kort 2.000 already stored. The page
    # says which version it holds (base_updated_at, the updated_at it last
    # read or was answered with); an older one is refused with its own code,
    # never the locked-row 409 (to every client a 409 here means "locked —
    # already in the books") and never the 423. The page then asks the owner:
    # the newer draft, or theirs (sent again on the newer base). No base (an
    # older app build) saves as it always did.
    _changed = _draft_changed_since(existing, data.base_updated_at, data.base_save_id, db=db, user=user)
    if _changed is not None:
        raise HTTPException(status_code=412, detail=_changed)
    # …and checked atomically: the version just checked is held until this
    # save commits (a concurrent save of the same version is refused).
    if (existing is not None and data.base_updated_at is not None
            and (getattr(existing, "status", None) or "confirmed") == "draft"):
        _claim_draft_version(db, existing, data, user)

    # Revenue total: when the OCR detected a bottom-line total
    # (revenue_total_override) AND the user didn't fully reconcile the
    # category breakdown, prefer the larger value. Three cases:
    #   • All categories filled, sum = override        → save sum (= override)
    #   • Categories partial (e.g. only Drinks=1.82),
    #     override = 17030                             → save 17030 (override
    #                                                    wins; breakdown is
    #                                                    incomplete or wrong)
    #   • Categories filled past override (user added
    #     extra revenue manually)                      → save sum (user
    #                                                    customizing)
    # The previous logic preferred any non-zero breakdown sum, which
    # broke the "skip — total saves correctly either way" promise of
    # the partial-detection banner: a single wrong OCR parse like 1.82
    # would silently overwrite the real 17,030 total.
    #
    # ROOT CAUSE, fixed 2026-09-20 — a row could disagree with itself.
    # `elif breakdown_sum > 0` meant a breakdown whose lines summed to ZERO or
    # a NEGATIVE amount fell through to `revenue_total = 0` while the lines
    # themselves were still persisted verbatim in revenue_categories. That is
    # exactly the production row behind the bad kasserapport:
    #     revenue_categories = 'food:-57'   revenue_total = 0.00
    # A legitimate correction day (a refund booked against a category) is
    # stored as a document that contradicts itself, and the PDF then printed a
    # -57,00 line above a 0,00 total. The total is DERIVED, so it must be
    # derived whenever there is a breakdown to derive it from — the sign of the
    # sum is data, not a reason to discard it.
    _breakdown = data.revenue_breakdown or {}
    breakdown_sum = sum(
        float(v) for v in _breakdown.values() if isinstance(v, (int, float))
    )
    override = data.revenue_total_override
    if override is not None and override > 0 and getattr(data, "revenue_total_owner_set", False):
        revenue_total = round(float(override), 2)
    elif override is not None and override > 0:
        revenue_total = float(max(breakdown_sum, override))
    elif _breakdown:
        # A breakdown was supplied → the total IS its sum, including 0 and
        # including a net-negative correction day.
        revenue_total = round(breakdown_sum, 2)
    else:
        revenue_total = 0

    # Detective control — when the breakdown sum diverges wildly from
    # the OCR'd override (>5x apart), emit a structured warning so an
    # admin can spot OCR quality issues + edge-case bugs in production
    # logs WITHOUT blocking the save (the save itself uses max() which
    # is the safe value for the user). Pairs with the schema + service
    # layers as a per-row monitor.
    if (
        breakdown_sum > 0
        and override is not None
        and override > 0
        and abs(breakdown_sum - override) / max(breakdown_sum, override) > 0.8
    ):
        logger.warning(
            "daily_close: revenue mismatch (using max=%s) "
            "user=%s breakdown_sum=%s override=%s breakdown=%s",
            revenue_total, user.id, breakdown_sum, override,
            data.revenue_breakdown,
        )

    # payment_total sums ONLY the headline payment methods. Card brand /
    # channel splits (dankort/visa/mastercard/softpay/betalingskort) may ride
    # along in payment_breakdown for accountant fidelity / the kasserapport
    # PDF, but they are a BREAKDOWN of the card line — summing them would
    # double-count. Exclude them here: a server-side guarantee that mirrors
    # the close-UI invariant (brands display under the card line, never add).
    _CARD_BREAKDOWN_KEYS = {"dankort", "visa", "mastercard", "softpay", "betalingskort"}
    payment_total = sum(
        v for k, v in (data.payment_breakdown or {}).items()
        if k not in _CARD_BREAKDOWN_KEYS and isinstance(v, (int, float))
    )

    # Cash expected — the baseline the counted drawer is measured against.
    # Prefer the SYNCED POS register cash for the date (what the till says
    # was taken) over the owner's typed cash line: typed-vs-counted is
    # self-referential and can never reveal a real shortage/theft, whereas
    # register-vs-drawer can. _register_cash_for_date returns None when the
    # date has no completed sales (pure manual / cash-only closers) — in
    # that case we fall back to the typed payment-breakdown cash, preserving
    # the prior behaviour for those users. This keeps the persisted
    # cash_difference (and the revisor kasserapport PDF / L7 audit row) in
    # lockstep with the "Expected (from register)" figure the close screen
    # now shows. Explicit None checks so 0 ("no cash today") isn't treated
    # as missing — the previous `or` chain coerced 0 → None.
    pb = data.payment_breakdown or {}
    register_cash = _register_cash_for_date(
        db, user=user, target_date=data.date, branch_id=data.branch_id,
    )
    if register_cash is not None:
        cash_expected = register_cash
    elif "cash" in pb:
        cash_expected = pb["cash"]
    elif "kontant" in pb:
        cash_expected = pb["kontant"]
    else:
        cash_expected = None
    cash_difference = None
    if cash_expected is not None and data.cash_counted is not None:
        cash_difference = round(float(data.cash_counted) - float(cash_expected), 2)

    tips_per_person = None
    if data.tips_total and data.tips_staff_count and data.tips_staff_count > 0:
        # Half-up to the øre, the same rule the page shows: Python's round()
        # is half-even (342,50 / 4 → 85,62) while the review said 85,63.
        from decimal import Decimal, ROUND_HALF_UP
        tips_per_person = float(
            (Decimal(str(data.tips_total)) / Decimal(int(data.tips_staff_count)))
            .quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        )

    # MOMS / VAT — use provided value or auto-calculate using the user's
    # currency rate AND their prices-include-Moms preference.
    # Previously hardcoded 25% which gave wrong MOMS for any non-DK user
    # (NPR 13%, GBP 20%, EUR 21%, etc.) and ignored B2B net-amount mode.
    moms_mode = data.moms_mode or "auto"
    # "Fra kvittering" with nothing typed sends no figure: the MOMS below is
    # BonBox's own, so it is stored as auto. Kept "manual", the kasserapport
    # printed a computed 3.426 as "Salgsmoms (indtastet)" / "(fra Z-bon)".
    if moms_mode == "manual" and data.moms_total is None:
        moms_mode = "auto"
    try:
        from app.services.tax_service import _get_vat_rate
        vat_rate = _get_vat_rate(user.currency or "DKK")
    except Exception:  # noqa: BLE001
        vat_rate = 0.25  # safe DK fallback if tax service load fails
    # Per-close override beats user-level default (e.g. "this Z-report
    # is gross because the user picked 'with MOMS' before scanning").
    if data.prices_include_moms_override is not None:
        prices_incl_moms = bool(data.prices_include_moms_override)
    else:
        prices_incl_moms = bool(getattr(user, "prices_include_moms", True))

    def _moms_of(amount: float) -> float:
        return round(amount * vat_rate / (1 + vat_rate), 2) if prices_incl_moms else round(amount * vat_rate, 2)

    sent_moms = data.moms_total
    # A partly read Z-bon: the scanned total (17.030) won the revenue over
    # the category sum (10.000), but the page's AUTO MOMS was worked out from
    # the sum — 2.000 saved where 3.406 is owed. An auto figure that equals
    # the sum's MOMS while the saved revenue is not the sum is stale: it is
    # recomputed from what is saved. A scanned or manual MOMS is kept.
    #
    # Unless it is ALSO the MOMS of the saved revenue less the day's MOMS-free
    # sales — the page's own figure: 17.030 − 2.500 MOMS-free = 14.530, which
    # happened to be the category sum too, and 2.906 was swapped for 3.406.
    #
    # The MOMS-free total is the page's claim, so it is never taken on trust:
    # it is held to 0..revenue and must match the server's own MOMS-free
    # sales for the date (the same figure the page reads, from the property
    # report) within 1 kr. Anything else — an unbounded number, a figure the
    # day's sales do not show, a lookup that fails — shields nothing, and the
    # stale auto MOMS is recomputed from the saved total as before.
    stale_auto = (
        sent_moms is not None and moms_mode == "auto" and vat_rate > 0
        and breakdown_sum > 0 and abs(revenue_total - breakdown_sum) > 0.5
        and abs(float(sent_moms) - _moms_of(breakdown_sum)) < 0.02
    )
    exempt_fits = False
    if stale_auto:
        try:
            exempt = float(data.exempt_sales_total or 0)
        except (TypeError, ValueError):
            exempt = 0.0
        if exempt != exempt:  # NaN
            exempt = 0.0
        exempt = min(max(exempt, 0.0), max(0.0, float(revenue_total)))
        if exempt > 0 and abs(float(sent_moms) - _moms_of(max(0.0, revenue_total - exempt))) < 0.02:
            server_exempt = _momsfri_sales_for_date(db, user=user, target_date=data.date)
            exempt_fits = server_exempt is not None and abs(server_exempt - exempt) <= 1.0
    if stale_auto and not exempt_fits:
        sent_moms = None
    # A day whose MOMS-free sales cover the whole close (gift cards only,
    # say): the page's auto MOMS is 0 — the MOMS of nothing left to tax — and
    # the review shows 0,00. Sent as null it was worked out from the full
    # revenue (750 → 150,00 stored under a review of 0,00); sent as 0 it is
    # the same claim as any MOMS-free figure: kept only when the server's own
    # MOMS-free sales for the date (the property report, within 1 kr.) cover
    # the revenue too. An auto 0 with nothing MOMS-free behind it is worked
    # out from the revenue as before.
    if (
        sent_moms is not None and moms_mode == "auto" and vat_rate > 0
        and revenue_total > 0 and abs(float(sent_moms)) < 0.005
        and abs(_moms_of(revenue_total)) >= 0.005
    ):
        try:
            claim0 = float(data.exempt_sales_total or 0)
        except (TypeError, ValueError):
            claim0 = 0.0
        if claim0 != claim0 or claim0 < 0:  # NaN, or nothing MOMS-free
            claim0 = 0.0

        def _covers(exempt: float) -> bool:
            return exempt > 0 and abs(_moms_of(max(0.0, revenue_total - exempt))) < 0.005

        kept = False
        if _covers(claim0):
            server_exempt0 = _momsfri_sales_for_date(db, user=user, target_date=data.date)
            kept = server_exempt0 is not None and abs(server_exempt0 - claim0) <= 1.0 and _covers(server_exempt0)
        if not kept:
            sent_moms = None
    if sent_moms is not None:
        moms_total = round(sent_moms, 2)
    else:
        # `!= 0`, not `> 0`. A net-negative correction day carries NEGATIVE
        # salgsmoms — that is what gets filed. The old `> 0` guard silently
        # wrote moms_total = 0 next to a non-zero revenue, which is what made
        # the kasserapport's MOMS block contradict its own revenue lines.
        if revenue_total != 0 and vat_rate > 0:
            if prices_incl_moms:
                # Gross-input mode (B2C): extract VAT from total
                moms_total = round(revenue_total * vat_rate / (1 + vat_rate), 2)
            else:
                # Net-input mode (B2B): VAT is rate × net
                moms_total = round(revenue_total * vat_rate, 2)
        else:
            moms_total = 0
    # Always derived, never conditionally zeroed — net = gross − moms holds for
    # a negative day exactly as it does for a positive one.
    revenue_ex_moms = round(revenue_total - moms_total, 2)

    status = data.status if data.status in ("draft", "confirmed") else "confirmed"

    # ─── Detective control — anomaly double-check before the lock ───
    # close_sanity compares today's total against the recent same-weekday
    # baseline; a confidently-wrong OCR misread (the classic 2.234 read
    # instead of 22.340) trips the flag. We return a soft
    # {requires_confirmation} WITHOUT mutating anything, so the frontend
    # surfaces a "double-check" dialog; the owner then either fixes the
    # numbers or re-submits with acknowledge_anomaly=True to lock anyway.
    # Only gates the LOCK (status=="confirmed"), never a draft auto-save,
    # and is fully fail-closed — the guard never raises and an error here
    # must never block a legitimate close.
    if status == "confirmed" and not data.acknowledge_anomaly:
        try:
            from app.services.close_sanity import check_close_anomaly
            _anomaly = check_close_anomaly(
                db, user=user, today=data.date, today_total=float(revenue_total),
            )
        except Exception:  # noqa: BLE001
            _anomaly = {"flagged": False}
        if _anomaly.get("flagged"):
            return {
                "requires_confirmation": True,
                "anomaly": {
                    "reason": _anomaly.get("reason"),
                    "today_total": _anomaly.get("today_total"),
                    "baseline_avg": _anomaly.get("baseline_avg"),
                    "baseline_days": _anomaly.get("baseline_days"),
                    "delta_pct": _anomaly.get("delta_pct"),
                },
            }

    if existing:
        # Block edits to confirmed (locked) entries — must unlock first.
        #
        # THE EXEMPTION THAT UNDID THE LOCK. This read
        # `existing_status == "confirmed" and status != "draft"`, so a POST
        # carrying status="draft" walked straight past the guard and into the
        # unconditional update below — including `existing.status = status`.
        #
        # That is not hypothetical. DailyClosePage auto-saves a draft two
        # seconds after any step or amount change and swallows the result
        # (`catch {}`, best-effort). An owner who reopens Daily Close later the
        # same business day to look at what they filed therefore DEMOTES the
        # locked kasserapport to KLADDE and overwrites its revenue, payments
        # and MOMS with whatever the wizard currently holds — silently, with no
        # unlock reason, no unlocked_by, and no unlocked_at, while the screen
        # still says locked. A signed Bogføringsloven record, rewritten by a
        # timer.
        #
        # There is exactly one legitimate way out of "confirmed", and it is not
        # this one: POST /{close_id}/unlock, which demands a written reason
        # (422 without it) and writes its own §10 audit row. Removing the
        # exemption does not touch that path.
        existing_status = getattr(existing, "status", None) or "confirmed"
        if existing_status == "confirmed":
            raise HTTPException(
                status_code=409,
                detail="This daily close is locked. Unlock it first to make changes."
            )
        # A RE-LOCK after an unlock is marked "Rettet kasserapport" by
        # _fire_close_auto_email, per recipient, from the audit trail — not
        # from this row, whose send status the re-lock resets below.
        #
        # The figures' source after an unlock: the client sends no new source
        # when the owner edits a reopened close by hand, and the old one ("Z-bon
        # · 2 terminaler lagt sammen: 5.000 + 7.500") then sat beside a
        # corrected total it no longer adds up to.
        _src_after_unlock = _source_after_unlock_edit(existing, data, revenue_total, moms_total)
        # Read before the update: a seeded day the owner typed real figures
        # into stops being sample data (_notes_to_store).
        _notes = _notes_to_store(existing, data, revenue_total)
        # The photo the row held before this save: one it clears or replaces
        # (another phone's bon, saved over by the owner's "Behold mine tal")
        # stays traceable in the audit row.
        _photo_before = getattr(existing, "receipt_photo", None)
        # Update existing
        existing.revenue_categories = encode_breakdown(data.revenue_breakdown)
        existing.revenue_total = revenue_total
        existing.payment_categories = encode_breakdown(data.payment_breakdown)
        existing.payment_total = payment_total
        existing.moms_total = moms_total
        existing.revenue_ex_moms = revenue_ex_moms
        existing.moms_mode = moms_mode
        existing.cash_expected = cash_expected
        existing.cash_counted = data.cash_counted
        existing.cash_difference = cash_difference
        existing.tips_total = data.tips_total
        existing.tips_staff_count = data.tips_staff_count
        existing.tips_per_person = tips_per_person
        existing.status = status
        existing.notes = _notes
        existing.closed_by = data.closed_by
        # Only overwrite the photo if the caller provided one — owners
        # editing a draft without re-uploading the photo shouldn't lose
        # the existing reference.
        if data.receipt_photo:
            existing.receipt_photo = data.receipt_photo
        elif data.receipt_photo == "":
            # The page says the close has no photo any more: the bon it was
            # of was thrown away (Start forfra), so it is no longer the
            # close's source document — the lock mail attached it as "og
            # Z-bon-foto" to a close typed by hand. null still keeps it.
            existing.receipt_photo = None
        # Same rule for the float and the figures' source: an older client
        # that does not send them must not wipe what is stored.
        _float = _clean_cash_float(data.cash_float)
        if _float is not None:
            existing.cash_float = _float
        _meta = _clean_source_meta(data.source_meta)
        if _meta is not None:
            existing.source_meta = _keep_unlock_mark(existing, data.source_meta, _meta)
        elif _src_after_unlock is not None:
            existing.source_meta = _src_after_unlock
        if status == "confirmed":
            existing.closed_at = utc_now()
            # The send status describes THIS version. A re-lock starts it over —
            # otherwise History would keep saying "Sendt til revisor" for the
            # old version while the corrected one may not have gone out. (The
            # earlier sends stay in the audit trail, which is what marks the
            # next mail as a correction.)
            existing.email_status = None
            existing.email_error = None
            existing.email_sent_at = None
            existing.email_sent_to = None
            # Clear unlock audit when re-confirming
            existing.unlock_reason = None
            existing.unlocked_by = None
            existing.unlocked_at = None
        # Bogføringsloven §10 — append-only audit row for the financial mutation.
        # Action depends on whether this is a confirm/lock or a draft save.
        _audit_action = "daily_close.lock" if status == "confirmed" else "daily_close.update"
        audit_service.record(
            db, user=user,
            action=_audit_action,
            entity_type="daily_close",
            entity_id=existing.id,
            before={
                "status": existing_status, "revenue_total": float(existing.revenue_total or 0),
                **({"receipt_photo": _photo_before}
                   if _photo_before and _photo_before != existing.receipt_photo else {}),
            },
            after={
                "status": status, "revenue_total": revenue_total,
                "payment_total": payment_total, "moms_total": moms_total,
                "cash_difference": cash_difference, "closed_by": data.closed_by,
                # The lines too: a later correction mail compares every line,
                # not only the headline figures (_figure_changes) — and the
                # rest of what the kasserapport prints (_lock_doc_fields).
                **_lock_lines(data),
                **(_lock_doc_fields(existing) if status == "confirmed" else {}),
                # The page's id for this save: the save it sends next, while
                # this one is still on its way, follows it (base_save_id).
                **({"save_id": data.save_id} if data.save_id else {}),
            },
            ip_address=getattr(request.client, "host", None) if request.client else None,
        )
        db.commit()
        db.refresh(existing)
        _capture_extraction_correction(
            db, user, status=status,
            final_values={
                "revenue_total": revenue_total, "moms_total": moms_total,
                "payment_breakdown": data.payment_breakdown,
                "revenue_breakdown": data.revenue_breakdown,
                "cash_counted": data.cash_counted,
            },
        )
        response = _to_response(existing)
        # L3 — Lane A close-ritual auto-email. Only on transition INTO
        # confirmed (i.e. the lock event), not on subsequent draft saves
        # of an unlocked-then-edited close. The helper handles all the
        # tier + preference gating + scan attachment + retry — never
        # raises into this path.
        if status == "confirmed":
            _invalidate_daily_brief_cache(db, user)
            response["close_ritual"] = _fire_close_auto_email(db, request, user, existing)
            response.update({k: v for k, v in _to_response(existing).items()
                             if k.startswith("email_")})
        return response

    dc = DailyClose(
        id=uuid.uuid4(),
        user_id=user.id,
        branch_id=data.branch_id,
        date=data.date,
        revenue_categories=encode_breakdown(data.revenue_breakdown),
        revenue_total=revenue_total,
        payment_categories=encode_breakdown(data.payment_breakdown),
        payment_total=payment_total,
        moms_total=moms_total,
        revenue_ex_moms=revenue_ex_moms,
        moms_mode=moms_mode,
        cash_expected=cash_expected,
        cash_counted=data.cash_counted,
        cash_difference=cash_difference,
        tips_total=data.tips_total,
        tips_staff_count=data.tips_staff_count,
        tips_per_person=tips_per_person,
        status=status,
        notes=_notes_to_store(None, data, revenue_total),
        closed_by=data.closed_by,
        closed_at=utc_now() if status == "confirmed" else None,
        # "" (no photo any more) is no photo on a new row either.
        receipt_photo=data.receipt_photo or None,
        cash_float=_clean_cash_float(data.cash_float),
        source_meta=_clean_source_meta(data.source_meta),
    )
    # A deleted draft for the same day (and branch) is still in the table —
    # a delete is soft — and the (user, branch, date) unique key covers it:
    # the INSERT below failed with an IntegrityError (500) for a venue that
    # files under a branch, and the day could never be saved or locked again.
    # The page deletes drafts on its own now (Start forfra on a day of photos
    # only, a date move). The deleted DRAFT is taken back as this new close:
    # every column is the new close's, and the audit trail keeps what the
    # deleted draft held (its figures, photo and source — `before` of
    # close.restored), so nothing of it is lost from the record. Its
    # free-text note is not copied there, only that it had one (GDPR:
    # _dead_draft_figures).
    #
    # Only a draft, and only where the key collides. A soft-deleted LOCKED
    # kasserapport (deletes before the 2026-06-10 lock check let one through)
    # is a bookkeeping record (bogføringsloven) and is never overwritten. A
    # NULL branch never collides (NULLs are distinct in the unique key), so
    # a day filed again without a branch is a new row, as it always was.
    dead = None
    if data.branch_id is not None:
        dead_any = (
            db.query(DailyClose)
            .filter(
                DailyClose.user_id == user.id,
                DailyClose.date == data.date,
                DailyClose.branch_id == data.branch_id,
                DailyClose.is_deleted.is_(True),
            )
            .first()
        )
        if dead_any is not None and (dead_any.status or "draft") != "draft":
            # Taken back it would be overwritten; inserted beside it the
            # unique key refuses (500). Said plainly instead — and NOT as a
            # 409: to every client (the page, the offline queue, an app build
            # already in the field) a 409 from this route means "a live close
            # is locked for this day, the money is in the books", and a queued
            # copy was offered for removal on it. Nothing of this day is in the
            # books: 423 (Locked) with its own code, kept as a failed save.
            raise HTTPException(
                status_code=423,
                detail={
                    "code": "deleted_locked_close",
                    "message": ("Der ligger en slettet, låst kasserapport for denne dag og afdeling. "
                                "Den bevares (bogføringsloven) og kan ikke overskrives — kontakt support."),
                },
            )
        dead = dead_any
    restored_from = None
    if dead is not None:
        restored_from = {"deleted_at": dead.deleted_at.isoformat() if dead.deleted_at else None,
                         "status": dead.status,
                         **_dead_draft_figures(dead)}
        now = utc_now()
        for attr in DailyClose.__mapper__.column_attrs:
            if attr.key in ("id", "user_id", "branch_id", "date"):
                continue
            setattr(dead, attr.key, getattr(dc, attr.key, None))
        dead.is_deleted = False
        dead.deleted_at = None
        dead.created_at = now
        dead.updated_at = now
        dc = dead
    else:
        db.add(dc)
    db.flush()  # populate dc.id before the audit row references it
    if restored_from is not None:
        audit_service.record(
            db, user=user,
            action="close.restored",
            entity_type="daily_close",
            entity_id=dc.id,
            before={"is_deleted": True, **restored_from},
            after={"is_deleted": False, "date": data.date.isoformat() if data.date else None,
                   "status": status},
            ip_address=getattr(request.client, "host", None) if request.client else None,
        )
    # Bogføringsloven §10 — append-only audit row for the new close.
    audit_service.record(
        db, user=user,
        action="daily_close.lock" if status == "confirmed" else "daily_close.create",
        entity_type="daily_close",
        entity_id=dc.id,
        before=None,
        after={
            "status": status, "date": data.date.isoformat() if data.date else None,
            "revenue_total": revenue_total, "payment_total": payment_total,
            "moms_total": moms_total, "cash_difference": cash_difference,
            "closed_by": data.closed_by, "branch_id": data.branch_id,
            **(_lock_lines(data) if status == "confirmed" else {}),
            **(_lock_doc_fields(dc) if status == "confirmed" else {}),
            **({"save_id": data.save_id} if data.save_id else {}),
        },
        ip_address=getattr(request.client, "host", None) if request.client else None,
    )
    db.commit()
    db.refresh(dc)
    _capture_extraction_correction(
        db, user, status=status,
        final_values={
            "revenue_total": revenue_total, "moms_total": moms_total,
            "payment_breakdown": data.payment_breakdown,
            "revenue_breakdown": data.revenue_breakdown,
            "cash_counted": data.cash_counted,
        },
    )
    response = _to_response(dc)
    # L3 — Lane A close-ritual auto-email. Only on the lock transition.
    # Drafts (status="draft") do NOT trigger — the email is the "the
    # day is officially closed, here's the kasserapport" notification.
    if status == "confirmed":
        _invalidate_daily_brief_cache(db, user)
        response["close_ritual"] = _fire_close_auto_email(db, request, user, dc)
        response.update({k: v for k, v in _to_response(dc).items() if k.startswith("email_")})
    return response


# ─── "Did this address already get a version of this close?" ───
#
# Derived from the APPEND-ONLY audit trail, never from email_sent_at (which a
# re-lock resets and which the owner's copy alone also sets). A lock mail, a
# resend and an old pre-082 lock mail all leave a close.auto_emailed row whose
# `sent_to` lists who actually received it. A delivery to an address BEFORE the
# latest daily_close.lock row is a delivery of an EARLIER version — so the next
# mail to that address, whether the re-lock's own or a later "Send igen", is
# marked "Rettet kasserapport … erstatter den, der blev sendt …".

_DELIVERY_ACTIONS = ("close.auto_emailed", "daily_close.resend_email")
_HISTORY_ACTIONS = _DELIVERY_ACTIONS + ("daily_close.lock", "daily_close.unlock")


def _close_audit_trail(db: Session, user: User, dc: DailyClose) -> list[tuple]:
    """[(created_at, action, after_dict)] for this close, oldest first."""
    import json as _json
    try:
        from app.models.audit_log import AuditLog
        rows = (
            db.query(AuditLog)
            .filter(
                AuditLog.user_id == user.id,
                AuditLog.entity_type == "daily_close",
                AuditLog.entity_id == dc.id,
                AuditLog.action.in_(_HISTORY_ACTIONS),
            )
            .order_by(AuditLog.created_at.asc())
            .all()
        )
    except Exception:  # noqa: BLE001
        return []
    out = []
    for r in rows:
        try:
            after = _json.loads(r.after_state or "{}") or {}
        except Exception:  # noqa: BLE001
            after = {}
        out.append((r.created_at, r.action, after if isinstance(after, dict) else {}))
    return out


def _latest_delivery(trail: list[tuple], address: str | None = None,
                     *, delivered_only: bool = True) -> tuple | None:
    """The latest send of the CURRENT locked version (after the latest lock)
    — to `address` when given. `delivered_only`: only a send that reached
    someone (sent_to non-empty). Closes locked before the status column
    existed (email_status NULL) still have this append-only record: every
    lock mail since May wrote a close.auto_emailed row with sent_to."""
    locks = [t for t in trail if t[1] == "daily_close.lock"]
    cutoff = locks[-1][0] if locks else None
    addr = (address or "").strip().lower()
    for t in reversed(trail):
        if t[1] not in _DELIVERY_ACTIONS:
            continue
        if cutoff is not None and t[0] < cutoff:
            break
        to = [str(x).strip().lower() for x in (t[2].get("sent_to") or [])]
        if delivered_only and not to:
            continue
        if addr and addr not in to:
            continue
        return t
    return None


def _fill_email_status_from_trail(db: Session, user: User, closes, rows: list[dict]) -> None:
    """History's "Afsendelse til revisor" for closes locked before the status
    was kept (email_status NULL): read from the audit trail, in ONE query for
    the whole list, so a day the revisor got says so instead of "ikke
    registreret" — and offers no one-tap duplicate. Read-time only; nothing
    is written. Rows the trail knows nothing about stay NULL."""
    import json as _json
    want = {c.id for c in closes
            if (getattr(c, "status", None) or "confirmed") == "confirmed"
            and not getattr(c, "email_status", None)}
    if not want:
        return
    try:
        from app.models.audit_log import AuditLog
        found = (
            db.query(AuditLog)
            .filter(
                AuditLog.user_id == user.id,
                AuditLog.entity_type == "daily_close",
                AuditLog.entity_id.in_(list(want)),
                AuditLog.action.in_(_HISTORY_ACTIONS),
            )
            .order_by(AuditLog.created_at.asc())
            .all()
        )
    except Exception:  # noqa: BLE001
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return
    trails: dict = {}
    for r in found:
        try:
            after = _json.loads(r.after_state or "{}") or {}
        except Exception:  # noqa: BLE001
            after = {}
        trails.setdefault(r.entity_id, []).append(
            (r.created_at, r.action, after if isinstance(after, dict) else {}))
    for row in rows:
        trail = trails.get(row.get("id"))
        if not trail:
            continue
        t = _latest_delivery(trail, delivered_only=False)
        status = t[2].get("email_status") if t else None
        if not status:
            continue
        to = [str(x).strip().lower() for x in (t[2].get("sent_to") or []) if x]
        row["email_status"] = status
        row["email_error"] = t[2].get("email_error") or None
        row["email_sent_to"] = to
        row["email_sent_at"] = t[0] if to else None
        row["email_status_source"] = "audit_trail"


def _is_demo_close(dc) -> bool:
    """A sample close from the demo seeder (notes end in " · demo"). It is
    never mailed to a revisor: it carries the business's real name and CVR
    over figures nobody took — and it is in no period artifact either (one
    predicate: daily_close_range_export.is_demo_close)."""
    from app.services.daily_close_range_export import is_demo_close
    return is_demo_close(dc)


def _strip_demo_marker(notes):
    """The notes without the demo seeder's " · demo" marker; the seeder's own
    text ("sample") goes with it."""
    from app.services.daily_close_range_export import strip_demo_marker
    return strip_demo_marker(notes)


def _notes_to_store(existing, data, revenue_total) -> str | None:
    """The notes a save writes. Whether a close is sample data is decided by
    the " · demo" marker alone — and that keeps the day out of every period
    artifact and every send. The wizard loads a seeded day's notes into the
    form ("Fortsæt kladden", or Lås op → Rediger) and saves them back, so an
    owner who typed that day's REAL Z-bon figures and locked it had them left
    out of the revisor's month without a word.

    The marker is kept only on a seeded row saved with its figures unchanged
    (a demo user clicking through). Real figures on a seeded day, or a marker
    arriving on a row that is no longer sample data (the wizard still holds
    it after an auto-save stripped it), are the owner's own: stripped. The
    API never writes a new marker — only the seeder does."""
    notes = getattr(data, "notes", None)
    if not _is_demo_close(data):
        return notes
    if existing is not None and _is_demo_close(existing) and _same_figures(existing, data, revenue_total):
        return notes
    return _strip_demo_marker(notes)


def _same_figures(existing, data, revenue_total) -> bool:
    """Does this save carry the figures `existing` already holds? Revenue,
    every revenue and payment line (folded like _figure_changes), counted
    cash and Drikkepenge."""
    def _r(v):
        try:
            return None if v is None else round(float(v), 2)
        except (TypeError, ValueError):
            return None

    def _lines(d):
        out: dict = {}
        for k, v in (d or {}).items():
            key = str(k).strip().lower()
            out[key] = round(out.get(key, 0.0) + (_r(v) or 0.0), 2)
        return {k: v for k, v in out.items() if abs(v) > 0.004}

    return (
        _r(existing.revenue_total) == _r(revenue_total)
        and _lines(decode_breakdown(existing.revenue_categories)) == _lines(data.revenue_breakdown)
        and _lines(decode_breakdown(existing.payment_categories)) == _lines(data.payment_breakdown)
        and _r(existing.cash_counted) == _r(data.cash_counted)
        and (_r(existing.tips_total) or 0.0) == (_r(data.tips_total) or 0.0)
    )


def _correction_for(trail: list[tuple], dc: DailyClose, address: str | None,
                    currency: str) -> dict | None:
    """The correction block for the next mail to `address`, or None when that
    address never received an earlier version of this close."""
    addr = (address or "").strip().lower()
    if not addr:
        return None
    locks = [t for t in trail if t[1] == "daily_close.lock"]
    if not locks:
        return None
    cutoff = locks[-1][0]
    delivered = [
        t for t in trail
        if t[1] in _DELIVERY_ACTIONS and t[0] < cutoff
        and addr in [str(x).strip().lower() for x in (t[2].get("sent_to") or [])]
    ]
    if not delivered:
        return None
    prev_at = delivered[-1][0]
    # The version that address holds = the last lock before its last delivery.
    held = [t for t in locks if t[0] <= prev_at]
    before = held[-1][2] if held else {}
    since = held[-1][0] if held else None
    unlocks = [t for t in trail if t[1] == "daily_close.unlock" and t[0] < cutoff
               and (since is None or t[0] > since)]
    reasons, who = [], None
    from app.services.close_history import actor_display
    for t in unlocks:
        r = str(t[2].get("unlock_reason") or "").strip()
        if r and r not in reasons:
            reasons.append(r)
        who = actor_display(t[2].get("unlocked_by"), danish=(currency or "DKK") == "DKK") or who
    changes, lines_known = _figure_changes(before, dc, currency)
    # The held version's signature of everything printed: "the same document"
    # only when it was recorded and matches. A lock row from before it was
    # recorded is never assumed equal.
    held_sig = before.get("doc_sig")
    return {
        "prev_sent_at": prev_at,
        "unlock_reason": "; ".join(reasons[-3:]),
        "unlocked_by": who,
        "changes": changes,
        "lines_known": lines_known,
        "same_document": bool(held_sig) and held_sig == _content_signature(dc),
    }


def _figure_changes(before: dict, dc: DailyClose, currency: str) -> tuple[list[tuple[str, str, str]], bool]:
    """([(label, old, new)], lines_known) between the version an address was
    sent and the current one: the headline figures, the counted cash, and —
    when the earlier lock recorded them — every payment-method and category
    line. A payments-only correction (6.000 kr. card → MobilePay) is what the
    revisor reconciles against settlements; it must never read "unchanged"."""
    from app.services.bonbox_pdf_kit import money_dk
    from app.services.close_category_labels import (
        is_card_brand_key, payment_method_label, revenue_category_label,
    )
    da = (currency or "DKK") == "DKK"
    out: list[tuple[str, str, str]] = []

    def _r(v):
        try:
            return None if v is None else round(float(v), 2)
        except (TypeError, ValueError):
            return None

    for key, label_da, label_en in (
        ("revenue_total", "Omsætning", "Revenue"),
        ("moms_total", "Salgsmoms", "Salgsmoms"),
        ("cash_counted", "Optalt kontant", "Counted cash"),
        ("cash_difference", "Kassedifference", "Cash difference"),
        # Recorded since the lock row carries them (_lock_doc_fields); an
        # older row without them is not compared on them.
        ("cash_expected", "Forventet kontant", "Expected cash"),
        ("cash_float", "Byttepenge", "Float"),
    ):
        if key not in before:
            continue
        o, n = _r(before.get(key)), _r(getattr(dc, key, None))
        if o != n:
            # The cash difference keeps its sign ("+25,00 kr."), as the KPI
            # row above it and the History card print it.
            _m = ((lambda v: _signed_money(v, currency)) if key == "cash_difference"
                  else (lambda v: money_dk(v, currency)))
            out.append((label_da if da else label_en, _m(o), _m(n)))

    # Drikkepenge: no tips and 0 tips print the same (no section), so they
    # compare equal; how many shared them only matters when there are tips.
    if "tips_total" in before:
        o_t = _r(before.get("tips_total")) or 0.0
        n_t = _r(getattr(dc, "tips_total", None)) or 0.0
        if abs(o_t - n_t) > 0.004:
            out.append(("Drikkepenge" if da else "Tips",
                        money_dk(o_t, currency), money_dk(n_t, currency)))
        o_c = int(before.get("tips_staff_count") or 0)
        n_c = int(getattr(dc, "tips_staff_count", None) or 0)
        if (o_t or n_t) and o_c != n_c:
            out.append(("Drikkepenge delt mellem" if da else "Tips shared by",
                        str(o_c) if o_c else "—", str(n_c) if n_c else "—"))

    lines_known = "payment_breakdown" in before and "revenue_breakdown" in before
    if lines_known:
        def _folded(d):
            # 'Food' and 'food' are ONE category (the wizard folds keys when
            # it reopens a close; the range export already folds them) — the
            # mail listed "Mad 10.000 → 0" and "Mad 0 → 10.000" for no change.
            out_d: dict = {}
            for k, v in (d or {}).items():
                key = str(k).strip()
                fold = key.lower()
                if fold in out_d:
                    out_d[fold] = (out_d[fold][0], round(out_d[fold][1] + (_r(v) or 0.0), 2))
                else:
                    out_d[fold] = (key, _r(v) or 0.0)
            return out_d

        for field, blob_key, label_fn, skip_brand in (
            ("payment_categories", "payment_breakdown", payment_method_label, True),
            ("revenue_categories", "revenue_breakdown", revenue_category_label, False),
        ):
            old = _folded(before.get(blob_key))
            new = _folded(decode_breakdown(getattr(dc, field, None)))
            for fk in sorted(set(old) | set(new)):
                key = (new.get(fk) or old.get(fk))[0]
                if skip_brand and is_card_brand_key(key):
                    continue  # a split of the card line, not money of its own
                o = old.get(fk, (key, 0.0))[1]
                n = new.get(fk, (key, 0.0))[1]
                if abs(o - n) > 0.004:
                    out.append((label_fn(key, danish=da), money_dk(o, currency), money_dk(n, currency)))
    return out, lines_known


# ─── POST — resend the lock mail for a LOCKED close ───
#
# The "Retry" button used to re-POST the close, which the lock guard refuses
# with 409 — and the page swallowed it. And "vi prøver igen" promised a retry
# job that does not exist. This is the real resend:
#   • owner session only (member/accountant writes are refused upstream) and
#     tenant-scoped; 5/min per IP + the 20/day revisor ceiling per account;
#   • only for a LOCKED close; the revisor must be saved and not opted out;
#   • idempotent: the client sends one key per click, and a replay of that
#     key answers with what happened the first time;
#   • one send in flight per close: the send is claimed with ONE conditional
#     UPDATE (email_status → 'sending') before anything is mailed. A second
#     request — another key from the card and the History row, or a second
#     tab — finds 'sending' and gets 409 in_progress instead of a second mail.
#     A claim older than _SENDING_STALE (a crashed worker) can be taken over;
#   • a close the revisor already got needs force=true (the page asks first).


_SENDING_STALE = timedelta(minutes=3)


class ResendEmailBody(BaseModel):
    key: str = Field(..., min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    force: bool = False


@router.post("/{close_id}/resend-email")
@_limiter.limit("5/minute")
def resend_close_email(
    request: Request,
    close_id: str,
    body: ResendEmailBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from sqlalchemy import or_
    from app.services.billing import effective_plan
    from app.services.revisor_mail import (
        enforce_revisor_daily_cap, is_demo_identity, is_demo_revisor,
        require_verified_revisor_sender, resolve_revisor_recipient,
        saved_revisor_address,
    )
    dc = db.query(DailyClose).filter(
        DailyClose.id == close_id,
        DailyClose.user_id == user.id,
        DailyClose.is_deleted.isnot(True),
    ).first()
    if not dc:
        raise HTTPException(status_code=404, detail="Daily close not found")
    if (getattr(dc, "status", None) or "confirmed") != "confirmed":
        raise HTTPException(status_code=409, detail={
            "code": "not_locked",
            "message": "Only a locked kasserapport can be sent.",
        })
    if _is_demo_close(dc):
        # Sample data under the business's real name and CVR: never mailed.
        raise HTTPException(status_code=409, detail={
            "code": "demo_close",
            "message": "This is a sample close (demo data). It is never sent to a revisor.",
        })
    # Same click again (double tap, network retry): answer with what happened
    # the first time — never a second mail.
    if dc.email_send_key and dc.email_send_key == body.key:
        return {"replayed": True, "close_ritual": _ritual_from_row(dc), **_to_response(dc)}
    if not has_feature(user, "close_auto_email"):
        raise HTTPException(status_code=402, detail={
            "code": "plan_required",
            "feature": "direct_accountant_email",
            "required_plan": "starter",
            "current_plan": effective_plan(user),
            "message": "Sending from BonBox is on Starter. Download the PDF and send it from your own mail.",
        })
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    # With a revisor saved, the send goes to them (409 when they opted out).
    # With none — an owner-only setup whose lock mail failed — "Send igen"
    # re-sends the owner's own copy; it used to answer 400 and leave the owner
    # with "Ikke sendt" and no way forward. The demo seeder's sample revisor
    # on a demo-seeded profile is NOT SAVED: the owner's copy only, which says
    # why (skip "demo_recipient"). So is a real revisor while the business is
    # still the demo's sample company (skip "demo_identity").
    if (saved_revisor_address(profile) and not is_demo_revisor(profile)
            and not is_demo_identity(profile, user)):
        acct = resolve_revisor_recipient(profile, user=user)
        # Mail to the revisor needs the owner's own e-mail confirmed: 403
        # email_unverified before anything is claimed or mailed — no revisor
        # mail and no second owner copy (the lock already sent that one). The
        # PDF stays downloadable from History.
        require_verified_revisor_sender(user)
        target = acct
    else:
        acct = None
        # The owner's own copy goes to the LOGIN address only (never the
        # unverified Profile e-mail), and never to an address that opted out.
        target = _owner_contact_email(profile, user)
        if not target:
            raise HTTPException(status_code=400, detail={
                "code": "no_recipient",
                "message": "No e-mail address to send to. Add one on Profile.",
            })
        if not _owner_copy_allowed(profile, target):
            raise HTTPException(status_code=409, detail={
                "code": "accountant_opted_out",
                "message": "This address has unsubscribed from BonBox mail.",
            })
    now = utc_now()
    in_flight = (dc.email_status == "sending" and dc.email_attempt_at is not None
                 and dc.email_attempt_at > now - _SENDING_STALE)
    if in_flight:
        raise HTTPException(status_code=409, detail={
            "code": "in_progress",
            "message": "This kasserapport is being sent right now.",
        })
    sent_to_now = [x for x in (dc.email_sent_to or "").split(",") if x]
    if dc.email_status in ("sent", "partial") and target in sent_to_now and not body.force:
        raise HTTPException(status_code=409, detail={
            "code": "already_sent",
            "message": ("Your revisor already got this kasserapport." if acct
                        else "You already got this kasserapport."),
            "sent_at": dc.email_sent_at.isoformat() if dc.email_sent_at else None,
            "sent_to": sent_to_now,
        })
    if not dc.email_status and not body.force:
        # Locked before the status was kept: the append-only audit trail
        # still knows whether THIS version reached `target` — then the page
        # asks "Send it again?" instead of mailing an unmarked duplicate.
        prior = _latest_delivery(_close_audit_trail(db, user, dc), target)
        if prior:
            raise HTTPException(status_code=409, detail={
                "code": "already_sent",
                "message": ("Your revisor already got this kasserapport." if acct
                            else "You already got this kasserapport."),
                "sent_at": prior[0].isoformat() if prior[0] else None,
                "sent_to": [target],
            })
    # The daily ceiling applies to every resend, the owner-only one too: each
    # is audited as daily_close.resend_email (a REVISOR_SEND_ACTIONS row) and
    # a forced owner-only resend loop was otherwise unlimited.
    enforce_revisor_daily_cap(db, user)

    # The claim: key AND in-flight state in one conditional UPDATE, so of two
    # concurrent requests exactly one gets a row back.
    prev_status = dc.email_status
    claimed = (
        db.query(DailyClose)
        .filter(
            DailyClose.id == dc.id,
            or_(DailyClose.email_send_key.is_(None), DailyClose.email_send_key != body.key),
            or_(
                DailyClose.email_status.is_(None),
                DailyClose.email_status != "sending",
                DailyClose.email_attempt_at.is_(None),
                DailyClose.email_attempt_at <= now - _SENDING_STALE,
            ),
        )
        .update({
            DailyClose.email_send_key: body.key,
            DailyClose.email_status: "sending",
            DailyClose.email_attempt_at: now,
        }, synchronize_session=False)
    )
    db.commit()
    db.refresh(dc)
    if not claimed:
        if dc.email_send_key == body.key and dc.email_status != "sending":
            return {"replayed": True, "close_ritual": _ritual_from_row(dc), **_to_response(dc)}
        raise HTTPException(status_code=409, detail={
            "code": "in_progress",
            "message": "This kasserapport is being sent right now.",
        })

    try:
        ritual = _fire_close_auto_email(db, request, user, dc, explicit=True)
    finally:
        # Never leave a close stuck on 'sending' (the helper persists the real
        # outcome; this only catches a path that did not).
        try:
            db.refresh(dc)
            if dc.email_status == "sending":
                dc.email_status = prev_status if prev_status != "sending" else None
                db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
    audit_service.record(
        db, user=user,
        action="daily_close.resend_email",
        entity_type="daily_close",
        entity_id=dc.id,
        before=None,
        after={
            "email_status": ritual.get("email_status"),
            "sent_to": ritual.get("sent_to"),
            "forced": bool(body.force),
        },
        ip_address=getattr(request.client, "host", None) if request.client else None,
    )
    try:
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
    db.refresh(dc)
    return {"replayed": False, "close_ritual": ritual, **_to_response(dc)}


# ─── POST — dismiss bank-drop reminder (Lane A — universal) ──
#
# Stores the close_id in user.bank_drop_dismissed_ids so the locked-
# state card no longer shows the "🏦 Bank drop" reminder for this
# close. Universal across all tiers (Free/Starter/Pro/Trial) — the
# reminder itself is free.

@router.post("/{close_id}/bank-drop-dismiss")
@_limiter.limit("30/minute")
def dismiss_bank_drop_reminder(
    request: Request,
    close_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Mark the bank-drop reminder for a specific close as done. Idempotent.

    The reminder card on the locked-state UI ("🏦 Put X DKK in safe")
    shows until the staff taps "Sat i sikkerhedsboks" — that triggers
    this endpoint. Stored on user.bank_drop_dismissed_ids as a comma-
    separated list, FIFO-trimmed at 30 entries (~1 month of closes).
    """
    dc = db.query(DailyClose).filter(
        DailyClose.id == close_id,
        DailyClose.user_id == user.id,
        DailyClose.is_deleted.isnot(True),
    ).first()
    if not dc:
        raise HTTPException(status_code=404, detail="Daily close not found")

    raw = (getattr(user, "bank_drop_dismissed_ids", None) or "").strip()
    existing = [x for x in raw.split(",") if x]
    sid = str(close_id)
    if sid not in existing:
        existing.append(sid)
        # FIFO rolloff — keep only the most-recent 30.
        existing = existing[-30:]
        user.bank_drop_dismissed_ids = ",".join(existing)
        db.commit()
    return {"ok": True, "dismissed_count": len(existing)}


# ─── POST — unlock a confirmed daily close ───

@router.post("/{close_id}/unlock")
@_limiter.limit("5/minute")
def unlock_daily_close(
    request: Request,
    close_id: str,
    data: DailyCloseUnlock,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Unlock a confirmed daily close so it can be edited. Owner only. Requires a reason."""
    dc = db.query(DailyClose).filter(
        DailyClose.id == close_id,
        DailyClose.user_id == user.id,
        DailyClose.is_deleted.isnot(True),
    ).first()
    if not dc:
        raise HTTPException(status_code=404, detail="Daily close not found")
    current_status = getattr(dc, "status", None) or "confirmed"
    if current_status != "confirmed":
        raise HTTPException(status_code=400, detail="Only confirmed closes can be unlocked")
    if not data.reason or not data.reason.strip():
        raise HTTPException(status_code=422, detail="A reason is required to unlock")

    dc.status = "draft"
    dc.unlock_reason = data.reason.strip()
    # The ROLE, not the login e-mail: this field is printed on the kasserapport,
    # the Excel/CSV history and the correction mail — documents a revisor
    # receives. The address stays in the audit row (unlocked_by_email).
    dc.unlocked_by = (getattr(user, "role", None) or "owner")[:40]
    dc.unlocked_at = utc_now()
    # Bogføringsloven §10 — unlock is a sensitive mutation; capture reason
    # in the immutable audit trail alongside the per-row fields.
    audit_service.record(
        db, user=user,
        action="daily_close.unlock",
        entity_type="daily_close",
        entity_id=dc.id,
        before={"status": current_status, "date": dc.date.isoformat() if dc.date else None},
        after={
            "status": "draft", "unlock_reason": data.reason.strip(),
            "unlocked_by": dc.unlocked_by, "unlocked_by_email": user.email,
            "unlocked_at": dc.unlocked_at.isoformat(),
        },
        ip_address=getattr(request.client, "host", None) if request.client else None,
    )
    db.commit()
    db.refresh(dc)
    return _to_response(dc)


# ─── GET — list daily closes ───

@router.get("")
def list_daily_closes(
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    branch_id: str = Query(None),
    # Round 22: each row's last_save_id (the page's id for the save that
    # wrote it last). Asked for by the page when it reads ONE day fresh
    # before taking back a draft whose save got no answer.
    with_save_id: bool = Query(False),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = db.query(DailyClose).filter(
        DailyClose.user_id == user.id,
        DailyClose.is_deleted.isnot(True),
    )
    if from_date:
        q = q.filter(DailyClose.date >= from_date)
    if to_date:
        q = q.filter(DailyClose.date <= to_date)
    if branch_id:
        q = q.filter(DailyClose.branch_id == branch_id)

    closes = q.order_by(DailyClose.date.desc()).limit(90).all()
    rows = [_to_response(dc) for dc in closes]
    _fill_email_status_from_trail(db, user, closes, rows)
    if with_save_id:
        sids = _last_save_ids(db, user, [dc.id for dc in closes])
        # Not read (the audit query failed): no last_save_id at all — the
        # page's "couldn't check", never None ("no id wrote it").
        if sids is not None:
            for dc, row in zip(closes, rows):
                row["last_save_id"] = sids.get(str(dc.id))
    return rows


# ─── GET — insights ───

@router.get("/insights")
def daily_close_insights(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    d90 = date.today() - timedelta(days=90)
    closes = (
        db.query(DailyClose)
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.is_deleted.isnot(True),
            DailyClose.date >= d90,
            # Insights are about the owner's books: drafts (an unfinished or
            # test close) showed up in the cash-short streak.
            DailyClose.status == "confirmed",
        )
        .order_by(DailyClose.date.desc())
        .all()
    )

    if not closes:
        return {"has_data": False, "insights": [], "summary": {}}

    # Aggregate data
    total_revenue = 0
    total_food = 0
    total_drinks = 0
    total_takeaway = 0
    total_tips = 0
    total_cash_diff = 0
    cash_diff_negative_days = 0
    cash_diff_count = 0
    tips_by_weekday = defaultdict(list)
    takeaway_by_month = defaultdict(float)
    revenue_by_month = defaultdict(float)

    for dc in closes:
        rev = decode_breakdown(dc.revenue_categories)
        rev_total = float(dc.revenue_total or 0)
        total_revenue += rev_total

        food = sum(v for k, v in rev.items() if k.lower() in ("food", "mad"))
        drinks = sum(v for k, v in rev.items() if k.lower() in ("drinks", "drikkevarer", "beverages"))
        takeaway = sum(v for k, v in rev.items() if k.lower() in ("takeaway", "udbringning", "delivery"))
        total_food += food
        total_drinks += drinks
        total_takeaway += takeaway

        if dc.tips_total:
            total_tips += float(dc.tips_total)
            weekday = dc.date.strftime("%A")
            tips_by_weekday[weekday].append(float(dc.tips_total))

        if dc.cash_difference is not None:
            diff = float(dc.cash_difference)
            total_cash_diff += diff
            cash_diff_count += 1
            if diff < 0:
                cash_diff_negative_days += 1

        month_key = dc.date.strftime("%Y-%m")
        takeaway_by_month[month_key] += takeaway
        revenue_by_month[month_key] += rev_total

    insights = []
    count = len(closes)

    # The owner reads these on a Danish screen: words AND numbers in their
    # language ("1.062", not "1,062" — a Dane reads the comma as a decimal).
    from app.services.owner_language import owner_lang
    _da = owner_lang(user) == "da"
    _DA_DAYS = {"Monday": "mandag", "Tuesday": "tirsdag", "Wednesday": "onsdag", "Thursday": "torsdag",
                "Friday": "fredag", "Saturday": "lørdag", "Sunday": "søndag"}

    def _n(v, signed=False):
        txt = f"{v:+,.0f}" if signed else f"{v:,.0f}"
        return txt.replace(",", ".") if _da else txt

    def _day(d):
        return _DA_DAYS.get(d, d) if _da else d

    # 1. Drink-to-food ratio
    if total_food > 0:
        ratio = round((total_drinks / (total_food + total_drinks)) * 100, 1)
        insights.append({
            "type": "drink_ratio",
            "icon": "🍸",
            "title": (f"Drikkevarer af omsætningen: {str(ratio).replace('.', ',')} %" if _da
                      else f"Drink-to-food ratio: {ratio}%"),
            "detail": (
                "Danske restauranter ligger typisk på 35–45 %. "
                + ("Måske sælger I for lidt drikkevarer — foreslå vin til maden." if ratio < 35
                   else "Fin balance!" if ratio <= 45
                   else "Stærkt drikkevaresalg — hold også øje med maden.")
            ) if _da else (
                "Danish restaurant average is 35-45%. "
                + ("You might be under-selling beverages — consider upselling wine with dinner." if ratio < 35
                   else "Great balance!" if ratio <= 45
                   else "Strong drink sales! Make sure food margins are healthy too.")
            ),
            "value": ratio,
            "benchmark": "35-45%",
        })

    # 2. Tip trends by weekday
    if tips_by_weekday:
        tip_avgs = {day: round(sum(vals) / len(vals)) for day, vals in tips_by_weekday.items()}
        best_day = max(tip_avgs, key=tip_avgs.get)
        worst_day = min(tip_avgs, key=tip_avgs.get)
        if tip_avgs[best_day] > 0 and tip_avgs[worst_day] > 0:
            multiplier = round(tip_avgs[best_day] / tip_avgs[worst_day], 1)
            insights.append({
                "type": "tip_trends",
                "icon": "💰",
                "title": (f"Drikkepenge: {_day(best_day)} i snit {_n(tip_avgs[best_day])} kr. mod {_day(worst_day)} {_n(tip_avgs[worst_day])} kr." if _da
                          else f"{best_day} tips avg {_n(tip_avgs[best_day])} vs {worst_day} avg {_n(tip_avgs[worst_day])}"),
                "detail": (f"Holdet får {str(multiplier).replace('.', ',')} gange så mange drikkepenge om {_day(best_day)}en som om {_day(worst_day)}en." if _da
                           else f"Your {best_day} staff earns {multiplier}x more in tips than {worst_day} staff."),
                "weekday_averages": tip_avgs,
            })

    # 3. Cash difference tracking
    if cash_diff_count >= 5:
        insights.append({
            "type": "cash_drift",
            "icon": "🔍" if total_cash_diff < -200 else "✅",
            "title": (f"Kassedifference: {_n(total_cash_diff, signed=True)} kr. over {cash_diff_count} dage" if _da
                      else f"Cash difference: {_n(total_cash_diff, signed=True)} over {cash_diff_count} days"),
            "detail": (
                (f"Minus {cash_diff_negative_days} af {cash_diff_count} dage. Undersøg det — tællefejl eller svind."
                 if _da else
                 f"Negative {cash_diff_negative_days} out of {cash_diff_count} days. Investigate — could be counting errors or shrinkage.")
                if cash_diff_negative_days > cash_diff_count * 0.5
                else ("Kassen stemmer overvejende." if _da else "Cash drawer tracking looks healthy.")
            ),
            "total_drift": round(total_cash_diff, 2),
            "negative_days": cash_diff_negative_days,
            "total_days": cash_diff_count,
        })

    # 5. Cash variance streak detection — consecutive nights short
    streak_alert = None
    closes_by_date = sorted(
        [(dc.date, float(dc.cash_difference)) for dc in closes if dc.cash_difference is not None],
        key=lambda x: x[0],
    )

    if len(closes_by_date) >= 2:
        streaks = []
        cur_streak = []

        for d, diff in closes_by_date:
            if diff < 0:
                if not cur_streak:
                    cur_streak = [(d, diff)]
                else:
                    gap = (d - cur_streak[-1][0]).days
                    if gap <= 3:          # allow gaps for days the business is closed
                        cur_streak.append((d, diff))
                    else:
                        if len(cur_streak) >= 2:
                            streaks.append(list(cur_streak))
                        cur_streak = [(d, diff)]
            else:
                if len(cur_streak) >= 2:
                    streaks.append(list(cur_streak))
                cur_streak = []

        if len(cur_streak) >= 2:
            streaks.append(list(cur_streak))

        if streaks:
            latest = streaks[-1]
            s_len = len(latest)
            s_total = round(sum(diff for _, diff in latest), 2)
            _DA_MON = ("jan.", "feb.", "mar.", "apr.", "maj", "jun.", "jul.", "aug.", "sep.", "okt.", "nov.", "dec.")
            _dfmt = (lambda d: f"{d.day}. {_DA_MON[d.month - 1]}") if _da else (lambda d: d.strftime("%-d %b"))
            s_start = _dfmt(latest[0][0])
            s_end = _dfmt(latest[-1][0])
            most_recent = closes_by_date[-1][0]
            is_active = (most_recent - latest[-1][0]).days <= 2

            if s_len >= 5:
                severity, icon = "critical", "\U0001f6a8"
                title = (f"Kassen manglede {s_len} aftener i træk" if _da
                         else f"Cash short {s_len} nights in a row")
                detail = (
                    f"Samlet mangel: {_n(s_total)} kr. over {s_len} dage i træk ({s_start}\u2013{s_end}) \u2014 "
                    "mønstret tyder på et fast problem \u2014 gennemgå kasseafstemning og kontanthåndtering."
                ) if _da else (
                    f"Total shortage: {_n(s_total)} over {s_len} consecutive days "
                    f"({s_start}\u2013{s_end}). This pattern suggests systematic issues \u2014 "
                    "review camera footage, POS reconciliation, and cash handling procedures."
                )
            elif s_len >= 3:
                severity, icon = "warning", "\u26a0\ufe0f"
                title = (f"Kassen manglede {s_len} aftener i træk" if _da
                         else f"Cash short {s_len} nights in a row")
                detail = (
                    f"Samlet mangel: {_n(s_total)} kr. fra {s_start} til {s_end} \u2014 "
                    "tre eller flere mangler i træk er et mønster, der er værd at undersøge."
                ) if _da else (
                    f"Total shortage: {_n(s_total)} from {s_start} to {s_end}. "
                    "Three or more consecutive shortages is a pattern worth investigating."
                )
            else:
                severity, icon = "info", "\U0001f4a1"
                title = ("Kassen manglede 2 aftener i træk" if _da else "Cash short 2 nights in a row")
                detail = (
                    f"Samlet mangel: {_n(s_total)} kr. den {s_start} og {s_end} \u2014 "
                    "kan være tilfældigt, men hold øje med det."
                ) if _da else (
                    f"Total shortage: {_n(s_total)} on {s_start} and {s_end}. "
                    "Might be coincidence, but keep an eye on it."
                )

            streak_alert = {
                "type": "cash_streak",
                "icon": icon,
                "title": title,
                "detail": detail,
                "severity": severity,
                "streak_length": s_len,
                "streak_total": s_total,
                "streak_start": latest[0][0].isoformat(),
                "streak_end": latest[-1][0].isoformat(),
                "is_active": is_active,
                "total_streaks": len(streaks),
            }
            insights.insert(0, streak_alert)

    # 4. Takeaway growth
    sorted_months = sorted(revenue_by_month.keys())
    if len(sorted_months) >= 2:
        curr = sorted_months[-1]
        prev = sorted_months[-2]
        curr_takeaway = takeaway_by_month.get(curr, 0)
        prev_takeaway = takeaway_by_month.get(prev, 0)
        curr_rev = revenue_by_month.get(curr, 0)
        prev_rev = revenue_by_month.get(prev, 0)
        if prev_takeaway > 0 and curr_rev > 0:
            # Compare the SHARE of sales, not month totals: a month with 5
            # closes against one with 26 read "grew 479 %" while the share
            # fell from 8,3 % to 7,4 %.
            share_curr = round((curr_takeaway / curr_rev) * 100, 1) if curr_rev else 0
            share_prev = round((prev_takeaway / prev_rev) * 100, 1) if prev_rev else 0
            growth = round(share_curr - share_prev, 1)
            if abs(growth) >= 1:
                _s = lambda v: str(v).replace(".", ",") if _da else str(v)
                insights.append({
                    "type": "takeaway_growth",
                    "icon": "📦",
                    "title": (
                        (f"Takeaway er {'steget' if growth > 0 else 'faldet'} til {_s(share_curr)} % af salget" if _da
                         else f"Takeaway {'rose' if growth > 0 else 'fell'} to {share_curr}% of sales")
                    ),
                    "detail": (
                        f"Mod {_s(share_prev)} % sidste måned." if _da
                        else f"Against {share_prev}% last month."
                    ),
                    "growth_pct": growth,
                    "current_share": share_curr,
                })

    summary = {
        "total_closes": count,
        "total_revenue": round(total_revenue, 2),
        "avg_daily_revenue": round(total_revenue / count, 2) if count else 0,
        "total_tips": round(total_tips, 2),
        "avg_daily_tips": round(total_tips / count, 2) if count else 0,
        "total_cash_difference": round(total_cash_diff, 2),
        "cash_streak": streak_alert,
    }

    return {"has_data": True, "insights": insights, "summary": summary}


# ─── GET — multi-branch daily summary ───

@router.get("/branch-summary")
def branch_summary(
    target_date: date = Query(None, alias="date"),
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Cross-branch comparison: per-branch revenue, cash, tips for a date or range."""
    if target_date:
        from_date = to_date = target_date
    if not from_date:
        from_date = date.today() - timedelta(days=7)
    if not to_date:
        to_date = date.today()

    closes = (
        db.query(DailyClose)
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.date >= from_date,
            DailyClose.date <= to_date,
            DailyClose.is_deleted.isnot(True),
        )
        .order_by(DailyClose.date.desc())
        .all()
    )

    # Fetch branch names
    branches = db.query(Branch).filter(Branch.user_id == user.id, Branch.is_active.isnot(False)).all()
    branch_names = {str(b.id): b.name for b in branches}
    branch_names[None] = "No Branch"

    # Aggregate per branch
    per_branch = defaultdict(lambda: {
        "revenue_total": 0, "payment_total": 0, "cash_diff_total": 0,
        "tips_total": 0, "days_count": 0, "cash_diff_count": 0,
    })

    for dc in closes:
        bid = str(dc.branch_id) if dc.branch_id else None
        b = per_branch[bid]
        b["revenue_total"] += float(dc.revenue_total or 0)
        b["payment_total"] += float(dc.payment_total or 0)
        b["tips_total"] += float(dc.tips_total or 0)
        b["days_count"] += 1
        if dc.cash_difference is not None:
            b["cash_diff_total"] += float(dc.cash_difference)
            b["cash_diff_count"] += 1

    # Build response list
    results = []
    for bid, agg in per_branch.items():
        results.append({
            "branch_id": bid,
            "branch_name": branch_names.get(bid, bid or "Unknown"),
            "revenue_total": round(agg["revenue_total"], 2),
            "avg_daily_revenue": round(agg["revenue_total"] / agg["days_count"], 2) if agg["days_count"] else 0,
            "payment_total": round(agg["payment_total"], 2),
            "cash_diff_total": round(agg["cash_diff_total"], 2),
            "tips_total": round(agg["tips_total"], 2),
            "days_count": agg["days_count"],
        })

    # Sort by revenue descending (top performers first)
    results.sort(key=lambda x: x["revenue_total"], reverse=True)

    grand = {
        "revenue_total": round(sum(r["revenue_total"] for r in results), 2),
        "cash_diff_total": round(sum(r["cash_diff_total"] for r in results), 2),
        "tips_total": round(sum(r["tips_total"] for r in results), 2),
        "total_days": sum(r["days_count"] for r in results),
        "branch_count": len(results),
    }

    return {
        "from_date": from_date.isoformat(),
        "to_date": to_date.isoformat(),
        "branches": results,
        "grand_total": grand,
    }


# ─── GET — prefill from real sales/expenses/cash data ───

# Revenue-category key sets per business type — MUST mirror the frontend
# REVENUE_CATS_BY_TYPE (DailyClosePage.jsx). Used to constrain the computed
# category split to the vertical's real categories (a legacy close that used an
# old key is dropped + renormalised, never surfaced). Single-category verticals
# ("general") get no split — there's nothing to distribute.
_REVENUE_CAT_KEYS_BY_TYPE = {
    "restaurant": ["food", "drinks", "takeaway"],
    "workshop": ["parts", "labor", "diagnostics", "towing"],
    "retail": ["products", "returns", "services"],
    "salon": ["treatments", "retail_products"],
    "bakery": ["bread_pastry", "drinks", "other"],
    "grocery": ["products", "tobacco_lottery", "fresh", "other"],
    "ecommerce": ["online_sales", "returns", "shipping"],
    "general": ["revenue"],
}

# How many prior confirmed closes to sample for the historical mix, and the
# minimum needed before we suggest anything (below it → graceful blank, never a
# false-confidence guess).
_SPLIT_HISTORY_LIMIT = 20
_SPLIT_MIN_SAMPLE = 3
_SPLIT_MEDIUM_SAMPLE = 8


def _build_category_split(db, user, branch_id, branch_type, target_date, sales_total):
    """Compute an HONEST, editable per-category revenue suggestion for the close.

    v1 signal = the owner's own HISTORICAL MIX: the average category proportions
    across their recent CONFIRMED closes, applied to today's sales_total. It is a
    weighted rolling average, NOT a learned model and NOT a measurement — the
    frontend labels it "beregnet" (computed), never "aflæst". The scanned-Z-report
    ("aflæst") path is handled separately by the scan flow, which already carries
    a real revenue_breakdown off the register tape.

    Doctrine guarantees:
      • DEGRADE GRACEFULLY — <3 usable historical closes → returns None; the
        frontend then leaves categories blank (never invents a split).
      • TIES OUT — the per-category amounts sum EXACTLY to sales_total (the øre
        residual rides the largest category), so downstream MOMS is untouched:
        the split only redistributes an already-correct total.
      • SELF-IMPROVES HONESTLY — reads back each close's persisted (already
        owner-corrected) revenue_categories, so a correction improves tomorrow's
        suggestion with zero ML. Same-weekday closes are preferred (a Saturday's
        mix differs from a Tuesday's).
      • TENANT + BRANCH SCOPED — never mixes another owner's or another
        location's mix.

    Returns {"source","confidence","sample_size","categories":{key: amount}} or
    None. Never raises — a bad split must never break the prefill.
    """
    try:
        if not sales_total or sales_total <= 0:
            return None
        keys = _REVENUE_CAT_KEYS_BY_TYPE.get(branch_type or "", _REVENUE_CAT_KEYS_BY_TYPE["restaurant"])
        if len(keys) <= 1:
            return None  # single-category vertical — nothing to split
        key_set = set(keys)

        q = db.query(DailyClose).filter(
            DailyClose.user_id == user.id,
            DailyClose.status == "confirmed",
            DailyClose.is_deleted.isnot(True),
            DailyClose.date < target_date,
        )
        if branch_id:
            q = q.filter(DailyClose.branch_id == branch_id)
        rows = q.order_by(DailyClose.date.desc()).limit(120).all()

        # Prefer same-weekday closes (mix genuinely differs Sat vs Tue); fall
        # back to all-days when there aren't enough same-weekday samples.
        same_dow = [r for r in rows if r.date and r.date.weekday() == target_date.weekday()]
        pool = same_dow if len(same_dow) >= _SPLIT_MIN_SAMPLE else rows
        pool = pool[:_SPLIT_HISTORY_LIMIT]

        # Average-of-ratios: each close contributes its own category PROPORTIONS
        # (normalised by that close's own category-sum, not its stored
        # revenue_total which legacy rows may disagree with), so one huge day
        # never dominates the mix.
        prop_sums = {k: 0.0 for k in keys}
        used = 0
        for r in pool:
            cats = decode_breakdown(r.revenue_categories)
            known = {k: float(v) for k, v in cats.items() if k in key_set and float(v) > 0}
            tot = sum(known.values())
            if tot <= 0:
                continue
            for k, v in known.items():
                prop_sums[k] += v / tot
            used += 1

        if used < _SPLIT_MIN_SAMPLE:
            return None  # not enough signal → graceful blank

        # Mean proportion per key, renormalised over the keys that actually
        # appeared so they sum to 1.0.
        mean_props = {k: (prop_sums[k] / used) for k in keys}
        total_prop = sum(mean_props.values())
        if total_prop <= 0:
            return None
        mean_props = {k: p / total_prop for k, p in mean_props.items()}

        # Apply to today's total, round to øre, then force EXACT tie-out by
        # pushing the residual onto the largest-share category.
        amounts = {k: round(sales_total * p, 2) for k, p in mean_props.items()}
        residual = round(sales_total - sum(amounts.values()), 2)
        if residual != 0:
            biggest = max(amounts, key=lambda k: amounts[k])
            amounts[biggest] = round(amounts[biggest] + residual, 2)

        # Drop zero categories from the suggestion (owner can still type them).
        amounts = {k: v for k, v in amounts.items() if v > 0}
        if not amounts:
            return None

        confidence = "medium" if used >= _SPLIT_MEDIUM_SAMPLE else "low"
        return {
            "source": "history",
            "confidence": confidence,
            "sample_size": used,
            "categories": amounts,
        }
    except Exception as e:  # noqa: BLE001 — a bad split must never break prefill
        print(f"category_split build failed: {e}")
        return None


@router.get("/prefill")
def prefill_daily_close(
    target_date: date = Query(default=None, alias="date"),
    branch_id: str = Query(None),
    branch_type: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Pull today's actual sales/expenses/cash to pre-fill the daily close form."""
    if not target_date:
        target_date = date.today()

    # ── Sales total + by payment method ──
    sales_q = db.query(Sale).filter(
        Sale.user_id == user.id,
        Sale.date == target_date,
        Sale.is_deleted.isnot(True),
        Sale.status == "completed",
    )
    if branch_id:
        sales_q = sales_q.filter(Sale.branch_id == branch_id)

    sales_total = float(
        sales_q.with_entities(func.coalesce(func.sum(Sale.amount), 0)).scalar()
    )
    sales_count = sales_q.count()

    payment_rows = (
        sales_q.with_entities(Sale.payment_method, func.sum(Sale.amount).label("total"))
        .group_by(Sale.payment_method)
        .all()
    )
    by_payment = {}
    for method, total in payment_rows:
        key = (method or "other").lower()
        if key == "kontant":
            key = "cash"
        elif key == "dankort":
            key = "card"
        by_payment[key] = by_payment.get(key, 0) + round(float(total), 2)

    # ── Sales by item_name (for revenue breakdown hints) ──
    item_rows = (
        sales_q.filter(Sale.item_name.isnot(None))
        .with_entities(Sale.item_name, func.sum(Sale.amount).label("total"))
        .group_by(Sale.item_name)
        .all()
    )
    by_item = {name: round(float(total), 2) for name, total in item_rows}

    # ── Expenses by category ──
    expense_q = (
        db.query(ExpenseCategory.name, func.sum(Expense.amount).label("total"))
        .join(Expense, Expense.category_id == ExpenseCategory.id)
        .filter(
            Expense.user_id == user.id,
            Expense.date == target_date,
            Expense.is_deleted.isnot(True),
            Expense.is_personal.isnot(True),
            not_pending(),
        )
    )
    if branch_id:
        expense_q = expense_q.filter(Expense.branch_id == branch_id)

    expense_rows = expense_q.group_by(ExpenseCategory.name).all()
    by_expense_cat = {name: round(float(total), 2) for name, total in expense_rows}
    expenses_total = sum(by_expense_cat.values())

    expenses_count = db.query(func.count(Expense.id)).filter(
        Expense.user_id == user.id,
        Expense.date == target_date,
        Expense.is_deleted.isnot(True),
        Expense.is_personal.isnot(True),
    ).scalar() or 0

    # ── Cash transactions ──
    cash_q = db.query(CashTransaction).filter(
        CashTransaction.user_id == user.id,
        CashTransaction.date == target_date,
        CashTransaction.is_deleted.isnot(True),
    )
    if branch_id:
        cash_q = cash_q.filter(CashTransaction.branch_id == branch_id)

    cash_in = float(
        cash_q.filter(CashTransaction.type == "cash_in")
        .with_entities(func.coalesce(func.sum(CashTransaction.amount), 0)).scalar()
    )
    cash_out = float(
        cash_q.filter(CashTransaction.type == "cash_out")
        .with_entities(func.coalesce(func.sum(CashTransaction.amount), 0)).scalar()
    )

    has_data = sales_count > 0 or expenses_count > 0

    # Night shift cutoff from business profile. DK-first default: an unset
    # cutoff → 06:00 (Europe/Copenhagen restaurant convention). An explicit
    # value (including 0) is respected; only a missing/None cutoff falls back
    # to 6 — the previous `or 0` forced midnight for new DK signups, which
    # pre-selected the wrong business day for a late-night closer.
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    _cut = getattr(profile, "day_cutoff_hour", None)
    cutoff = 6 if _cut is None else int(_cut)

    # ── Gavekort redeemed this business day (MPV only) ──
    # A gavekort is a TENDER, not a second sale — the meal it paid for MUST be
    # in revenue_total or the MOMS is under-declared (DK MPV VAT falls at
    # redemption). We surface the day's MPV redemptions so the owner can confirm
    # the meals are included. BonBox NEVER auto-adds them to revenue — the owner
    # attests (registreret → bogført is the owner's call). SPV excluded (taxed
    # at issuance). User-level (gift_card_transactions has no branch_id).
    from app.models.gift_card import GiftCard, GiftCardTransaction  # local — isolate
    _gk_start = datetime.combine(target_date, datetime.min.time())
    _gk_end = _gk_start + timedelta(days=1)
    _gk_redeemed_minor = (
        db.query(func.coalesce(func.sum(GiftCardTransaction.amount_minor), 0))
        .join(GiftCard, GiftCard.id == GiftCardTransaction.gift_card_id)
        .filter(
            GiftCardTransaction.user_id == user.id,
            GiftCardTransaction.kind == "redeem",
            GiftCardTransaction.business_day >= _gk_start,
            GiftCardTransaction.business_day < _gk_end,
            GiftCard.voucher_class == "mpv",
        )
        .scalar()
    ) or 0
    gavekort_redeemed = round(-float(_gk_redeemed_minor) / 100.0, 2)

    return {
        "date": target_date.isoformat(),
        "has_data": has_data,
        "day_cutoff_hour": cutoff,
        "sales": {
            "total": sales_total,
            "count": sales_count,
            "by_payment_method": by_payment,
            "by_item": by_item,
        },
        # Day's MPV gavekort redemptions (kr) + the gift_card tender already on
        # the day's sales — the frontend compares them so the owner confirms the
        # redeemed meals are in revenue. Surfaced, never auto-posted.
        "gavekort": {
            "redeemed": gavekort_redeemed,
            "tender": round(float(by_payment.get("gift_card", 0)), 2),
        },
        "expenses": {
            "total": expenses_total,
            "count": expenses_count,
            "by_category": by_expense_cat,
        },
        "cash": {
            "total_in": cash_in,
            "total_out": cash_out,
            "net": round(cash_in - cash_out, 2),
        },
        "suggested_prefill": {
            "revenue_total": sales_total,
            "payment_breakdown": by_payment,
            "cash_expected": by_payment.get("cash", 0),
        },
        # Computed per-category revenue suggestion ("beregnet fordeling") so the
        # nightly restaurant close stops being hand-typed. None when there's not
        # enough history — the frontend then leaves categories blank. Honest:
        # this is the owner's own historical mix applied to today's total, never
        # a measurement. See _build_category_split.
        "category_split": _build_category_split(
            db, user, branch_id, branch_type, target_date, sales_total
        ),
    }


# ─── POST — scan Z-report image ───

@router.post("/scan-report")
# Tightened 2026-05-28 with the Opus 4.7 OCR upgrade — now ~5x cost
# per call, so the per-IP burst limit drops AND a daily ceiling is
# added. 6/min handles legitimate multi-terminal owners (one Z-report
# per terminal at end of day); the 80/day per-IP ceiling defends
# against slow-and-steady abuse from a single IP across multiple
# accounts. The per-user PLAN_CAPS cap below enforces the tier limit
# (Free=3/day, Starter=20/day, Pro=100/day) independently.
@_limiter.limit("6/minute;80/day")
async def scan_z_report(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Upload a Z-report / kasserapport photo and extract structured data via OCR.

    Multi-layer defense:
      L1 — auth (get_current_user dep).
      L2 — input bounds: content-type prefix check + 12MB size cap.
      L3 — rate limit (@_limiter.limit("12/minute") per IP). Tight
           because each call may run a Sonnet vision pass = real $.
      L4 — tenant scope: image bytes go to <user_id>/kasserapport/<sha>.jpg
           via the storage abstraction.
      L5 — daily quota: PLAN_CAPS["z_report_scans_per_day"] — Free=5/day,
           Starter=15/day, Pro=50/day. Refuses 429 when exceeded so a
           script can't drain Anthropic spend even within a single
           rate-limit window.
      L6 — audit trail: the resulting DailyClose row carries the
           image_url + receipt_photo path for §10 retention.
    """
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    file_bytes = await file.read()
    # Size cap matches kasserapport extractor (12 MB) — same threshold
    # everywhere the user might upload an image.
    if len(file_bytes) > 12 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 12 MB)")

    # L5 — per-tier daily quota (PLAN_CAPS["z_report_scans_per_day"]).
    plan = effective_plan(user) or "free"
    cap = get_cap(user, "z_report_scans_per_day")
    used = _today_scan_count(db, user)
    if used >= cap:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Daily Z-report scan limit reached ({used}/{cap}). "
                "Upgrade or try again tomorrow."
            ),
        )

    # Save the image (Supabase or local fallback). kind="kasserapport"
    # routes the storage path to <user_id>/kasserapport/<sha>.jpg so Z-
    # report photos sit in their own namespace separate from per-receipt
    # photos on individual sales / expenses.
    # Returns (durable URL/path for the row, local path for OCR). Both are
    # needed: the durable one may be a Supabase URL that OCR can't read.
    image_url, local_path = save_receipt_photo_ex(
        file_bytes,
        file.filename or "z_report.jpg",
        str(user.id),
        kind="kasserapport",
    )

    # This used to pick the newest uploads/receipts/{user}_* file by mtime.
    # On the kasserapport path that is the worst possible race: the Z-report
    # IS the day's revenue, so reading a different photo silently books
    # another day's — or another receipt's — figures as this close.

    # Parse the Z-report
    parsed = parse_z_report(local_path)
    parsed["image_url"] = image_url

    # When the specialized Z-report extractor ran, package the rich
    # fields into a `prefill` block the frontend uses to auto-populate
    # all three daily-close steps. The legacy keys (revenue / payments
    # / tips / moms_total / revenue_total) remain at the top level so
    # existing callers + the simple "Apply OCR" path still work.
    if parsed.get("doc_type") == "z_report":
        rb = parsed.get("revenue_breakdown") or {}
        pb = parsed.get("payment_breakdown") or {}
        per_clerk = parsed.get("per_clerk") or []
        cash_denoms = parsed.get("cash_denominations") or {}

        # Per-clerk earnings summary — frontend drops this into the
        # Notes field so the owner can spot-check vs. their schedule
        # (which is the most common kasserapport error class: clerk
        # logged into the wrong terminal).
        clerk_notes = None
        if per_clerk:
            clerk_lines = [
                f"{c.get('name') or c.get('id') or '?'}: "
                f"{c.get('total'):.2f} kr" if isinstance(c.get('total'), (int, float))
                else f"{c.get('name') or c.get('id') or '?'}: (uklart)"
                for c in per_clerk
            ]
            clerk_notes = "Pr. ekspedient: " + ", ".join(clerk_lines)

        parsed["prefill"] = {
            # Step 1 — Revenue breakdown
            "revenue_breakdown": {
                "food": rb.get("food"),
                "drinks": rb.get("drinks"),
                "other": rb.get("other"),
                "tips": rb.get("tips"),
                "surcharge": rb.get("surcharge"),
            },
            # Step 2 — Payment methods
            "payment_breakdown": {
                "cash": pb.get("cash"),
                "card": parsed.get("payments", {}).get("card"),
                "mobilepay": pb.get("mobilepay"),
                "softpay": pb.get("softpay"),
                "visa": pb.get("visa"),
                "mastercard": pb.get("mastercard"),
                "dankort": pb.get("dankort"),
            },
            # Step 3 — Cash drawer count + denomination breakdown
            "cash_drawer": {
                "counted_total": parsed.get("cash_counted_total"),
                "denominations": cash_denoms,
                "kasse_dif": parsed.get("kasse_dif"),
            },
            # Cross-check + Notes prefill
            "transactions": parsed.get("transactions") or {},
            "per_clerk": per_clerk,
            "per_clerk_notes": clerk_notes,
            "business_date": parsed.get("business_date"),
        }

    # ─── POS terminal auto-detect — Commit 2 + Commit 3 (2026-05-28) ────
    #
    # Layered defense:
    #   L4 fail-soft: the entire detection block is wrapped in try/except.
    #     Detection / persistence / silent-link / conflict-detection
    #     failure NEVER blocks the close ritual — the owner gets the
    #     prefill response either way.
    #   L6 fail-closed: conflict detection (Commit 3) never overwrites
    #     a provider_locked_by_owner=True terminal. Surfaces the mismatch
    #     in the response, audit-logs the event, lets the owner decide.
    #   L7 audit: terminal_provider_detected (always when detected),
    #     terminal_provider_auto_linked (silent link path),
    #     terminal_provider_conflict (Commit 3) — written via
    #     audit_service.record.
    #   L8 graceful: detect_provider returns None on catalog hiccup / no
    #     match; we just skip the chip + skip the silent link.
    #
    # The detection block also persists the scan-level extraction row.
    # This is the first time /scan-report writes a KasserapportExtraction
    # row directly (the /api/kasserapport endpoint also writes one, but
    # /scan-report previously never did). We log the detection result
    # whether or not detection succeeded, so the admin training review
    # has a row to compare against owner corrections in Commit 3.
    parsed["detected_provider"] = None
    parsed["conflict"] = None
    try:
        from app.services.terminal_provider_detector import detect_provider

        header_text = parsed.get("payment_terminal_header") or ""
        footer_text = parsed.get("payment_terminal_footer") or ""
        detection = detect_provider(
            db=db,
            header_text=header_text,
            footer_text=footer_text,
        )

        # Persist the FULL scan-level extraction row regardless of detection
        # outcome — this is the learning loop's raw material: extracted_json
        # (what the model read) is later compared to final_json (what the
        # owner saved on close) to reveal which POS layouts / fields get
        # misread. Reconciliation results (validator_failures / manual_review
        # / consistency) ride along from kasserapport_reconciliation via
        # parse_z_report. Wrapped so a persist failure never blocks the scan.
        try:
            import hashlib as _hashlib
            from app.services.claude_vision_ocr import Z_REPORT_PROMPT_VERSION
            _conf = parsed.get("confidence_per_field") or {}
            _overall = _conf.get("overall") if isinstance(_conf, dict) else None
            extraction_row = KasserapportExtraction(
                id=uuid.uuid4(),
                user_id=user.id,
                image_url=image_url,
                document_type=parsed.get("doc_type") or "unknown",
                pos_system=(detection["slug"] if detection else "unknown"),
                extraction_confidence=_overall,
                extracted_json={
                    "revenue_total": parsed.get("revenue_total"),
                    "moms_total": parsed.get("moms_total"),
                    "moms_rate": parsed.get("moms_rate"),
                    "revenue_breakdown": parsed.get("revenue_breakdown"),
                    "payment_breakdown": parsed.get("payment_breakdown"),
                    "cash_counted_total": parsed.get("cash_counted_total"),
                    "cash_denominations": parsed.get("cash_denominations"),
                    "per_clerk": parsed.get("per_clerk"),
                    "tips": parsed.get("tips"),
                    "surcharge": parsed.get("surcharge"),
                    "doc_type": parsed.get("doc_type"),
                    "business_date": parsed.get("business_date"),
                    "totals_inconsistent": parsed.get("totals_inconsistent", False),
                    "consistency_score": parsed.get("consistency_score"),
                    "confidence": _conf,
                    "notes": parsed.get("claude_notes"),
                    "provider": parsed.get("_provider"),
                    "payment_terminal_header": header_text or None,
                    "payment_terminal_footer": footer_text or None,
                },
                validator_failures=parsed.get("validator_failures") or [],
                manual_review_needed=bool(parsed.get("manual_review_needed", False)),
                image_sha256=_hashlib.sha256(file_bytes).hexdigest(),
                prompt_version=Z_REPORT_PROMPT_VERSION,
                detected_provider_slug=detection["slug"] if detection else None,
                detected_provider_confidence=(
                    detection["confidence"] if detection else None
                ),
            )
            db.add(extraction_row)
            # Commit NOW, independent of detection. Previously the only commit
            # lived inside the `if detection:` branch below, so a scan with no
            # detected provider — the common case — silently rolled back and
            # the table stayed empty. Surface the row id so the close-save can
            # stamp final_json back onto this exact extraction.
            db.commit()
            db.refresh(extraction_row)
            parsed["extraction_id"] = str(extraction_row.id)
        except Exception as e:  # noqa: BLE001
            # Persistence failure must NOT block the scan — the owner still
            # gets their prefill + detection chip; we just lose the audit-
            # history row for this scan.
            logger.warning(
                "scan-report: extraction-row persist failed: %s", e,
            )
            db.rollback()
            extraction_row = None
            parsed["extraction_id"] = None

        unlinked_count = 0
        if detection:
            # L7 audit — we detected something. Log it even at low
            # confidence; the admin review needs the full picture, not
            # just the high-confidence wins.
            audit_service.record(
                db=db,
                user=user,
                action="terminal_provider_detected",
                entity_type="kasserapport_extraction",
                entity_id=extraction_row.id if extraction_row else None,
                after={
                    "slug": detection["slug"],
                    "confidence": round(float(detection["confidence"]), 2),
                },
                ip_address=client_ip(request) if request else None,
            )

            # ─── Commit 3 conflict detection ────────────────────────────
            # If the owner has any terminal locked to a DIFFERENT provider
            # than what we just detected, raise a conflict flag. The
            # frontend renders an amber warning above the prefill so the
            # owner can decide: was a backup terminal used today, or did
            # someone hand us the wrong receipt? Crucial: we DO NOT
            # overwrite a locked provider — L6 fail-closed doctrine.
            #
            # Scope: only locked-by-owner terminals count for conflict.
            # An auto-linked-but-unconfirmed terminal (provider_id set
            # but provider_locked_by_owner=False) is fair game for the
            # detector to flip — the owner never asserted ownership.
            #
            # Picks the first conflicting terminal; if the owner has
            # multiple locked terminals all pointing somewhere different,
            # one warning is enough — the Connections page lets them
            # audit the rest.
            try:
                # Multi-terminal short-circuit (audit R2 hotfix):
                # If ANY of the user's linked terminals already matches
                # the detected provider, the scan is consistent with
                # their setup — don't flag the *other* terminals as
                # conflicts. Multi-terminal cafés (Pro tier) commonly
                # run Nets + Worldline side by side; a Nets scan is
                # not a conflict against the Worldline terminal.
                any_matches_detected = (
                    db.query(Terminal.id)
                    .filter(
                        Terminal.user_id == user.id,
                        Terminal.is_deleted.isnot(True),
                        Terminal.provider_id == detection["provider_id"],
                    )
                    .first()
                    is not None
                )
                locked_others = (
                    []
                    if any_matches_detected
                    else (
                        db.query(Terminal)
                        .filter(
                            Terminal.user_id == user.id,
                            Terminal.is_deleted.isnot(True),
                            Terminal.provider_locked_by_owner.is_(True),
                            Terminal.provider_id.isnot(None),
                            Terminal.provider_id != detection["provider_id"],
                        )
                        .all()
                    )
                )
                if locked_others:
                    current = locked_others[0]
                    cur_prov = current.provider  # joined relationship
                    parsed["conflict"] = {
                        "detected": {
                            "slug": detection["slug"],
                            "display_name": detection["display_name"],
                            "confidence": round(
                                float(detection["confidence"]), 2,
                            ),
                        },
                        "current": {
                            "slug": getattr(cur_prov, "slug", None),
                            "display_name": getattr(
                                cur_prov, "display_name", None,
                            ),
                            "terminal_id": str(current.id),
                            "terminal_name": current.name,
                        },
                    }
                    # L7 audit — the conflict event is on the terminal
                    # the owner had locked, not on the detection row, so
                    # a future "show me every dispute on this terminal"
                    # query lands the right history.
                    audit_service.record(
                        db=db,
                        user=user,
                        action="terminal_provider_conflict",
                        entity_type="terminal",
                        entity_id=current.id,
                        after={
                            "detected_slug": detection["slug"],
                            "detected_confidence": round(
                                float(detection["confidence"]), 2,
                            ),
                            "current_slug": getattr(cur_prov, "slug", None),
                            "locked_by_owner": True,
                        },
                        ip_address=(
                            client_ip(request) if request else None
                        ),
                    )
            except Exception as e:  # noqa: BLE001
                # L8 graceful — conflict check failure must not block
                # the close. Owner just won't see the warning tag this
                # scan; the silent-link block below still won't fire
                # against a locked terminal because Commit 2 already
                # gates that on provider_id IS NULL.
                logger.warning(
                    "scan-report: conflict check failed (non-fatal): %s", e,
                )

            # Silent link — only when confidence is high enough AND the
            # ambiguity is gone (exactly one unlinked terminal). Two
            # unlinked terminals = we can't pick automatically; Commit 3
            # adds the owner confirm UX for that case.
            if float(detection["confidence"]) >= 0.85:
                unlinked = (
                    db.query(Terminal)
                    .filter(
                        Terminal.user_id == user.id,
                        Terminal.is_deleted.isnot(True),
                        Terminal.provider_id.is_(None),
                    )
                    .all()
                )
                unlinked_count = len(unlinked)
                if unlinked_count == 1:
                    target = unlinked[0]
                    from decimal import Decimal as _Decimal
                    target.provider_id = detection["provider_id"]
                    target.provider_confidence = _Decimal(
                        f"{float(detection['confidence']):.2f}"
                    )
                    audit_service.record(
                        db=db,
                        user=user,
                        action="terminal_provider_auto_linked",
                        entity_type="terminal",
                        entity_id=target.id,
                        after={
                            "provider_slug": detection["slug"],
                            "confidence": round(
                                float(detection["confidence"]), 2,
                            ),
                        },
                        ip_address=(
                            client_ip(request) if request else None
                        ),
                    )

            # Commit the audit + extraction + (possibly) the linked
            # Terminal mutation in one atomic write. Wrap commit too so
            # a DB hiccup at the very end can't crash the close ritual.
            try:
                db.commit()
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "scan-report: detection commit failed: %s", e,
                )
                db.rollback()

            # Chip data — only surfaced when confidence is high enough
            # to be actionable. < 0.60 returns null detection so the
            # frontend skips the chip entirely. Commit 3 adds the
            # provider_id to the payload so the Confirm button can
            # POST link-provider without a separate catalog round-trip.
            if float(detection["confidence"]) >= 0.60:
                parsed["detected_provider"] = {
                    "provider_id": str(detection["provider_id"]),
                    "slug": detection["slug"],
                    "display_name": detection["display_name"],
                    "confidence": round(float(detection["confidence"]), 2),
                    "auto_linked": (
                        float(detection["confidence"]) >= 0.85
                        and unlinked_count == 1
                    ),
                }
    except Exception as e:  # noqa: BLE001
        # L4 fail-soft: any failure in the detection pathway gets logged
        # but never blocks the close. The owner still sees their OCR'd
        # prefill — they just don't get the chip this scan.
        logger.warning(
            "scan-report: provider auto-detect failed (non-fatal): %s", e,
        )
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass

    return parsed


# ─── GET — date-range PDF / CSV export (accountant handoff) ───
#
# These two endpoints aggregate a date range into a single document so
# the owner can hand off a week / month / quarter to the accountant in
# one click. Distinct from /{close_id}/pdf (single close, polished
# receipt) — this is the "weekly review" / "month-end" format with
# totals + averages.
#
# Path order: declared BEFORE /{close_id} so FastAPI matches the
# literal "export.pdf" / "export.csv" path before falling through to
# the parametric close_id.

# Hard ceiling — defense-in-depth above any per-tier cap.
# 366 covers leap years + a comfortable yearly review; anything
# longer should be done in chunks. Per-tier caps below this further
# narrow the window for free / starter tiers.
_MAX_RANGE_DAYS = 366

# Plan labels used in the upgrade prompts surfaced to the user when
# they hit the per-tier cap. Kept here rather than in billing.py
# because the wording is feature-specific (kasserapport context).
# Three purchasable tiers + the trial state — Business was dropped
# May 2026.
_PLAN_LABELS = {
    "free": "Free",
    "starter": "Starter",
    "trial": "Trial (Pro)",
    "pro": "Pro",
}


def _resolve_range(
    from_date: date | None,
    to_date: date | None,
    *,
    user: User | None = None,
) -> tuple[date, date]:
    """Validate + default the (from, to) inputs and enforce plan cap.

    Defaults: today minus 30 days → today.
    Raises 422 if from > to.
    Raises 422 if span exceeds the hard ceiling (_MAX_RANGE_DAYS).
    Raises 402 if span exceeds the user's per-tier cap (Free=7d,
    Starter=31d, Pro=366d) — frontend uses 402 as the trigger to
    show the upgrade CTA distinctly from generic validation errors.
    """
    if not to_date:
        to_date = date.today()
    if not from_date:
        from_date = to_date - timedelta(days=30)
    if from_date > to_date:
        raise HTTPException(
            status_code=422,
            detail="Invalid date range: 'from' must be on or before 'to'.",
        )
    span = (to_date - from_date).days + 1
    if span > _MAX_RANGE_DAYS:
        raise HTTPException(
            status_code=422,
            detail=f"Date range too large ({span} days). Max is {_MAX_RANGE_DAYS} days.",
        )

    # Per-tier cap. -1 = unlimited (we still respect _MAX_RANGE_DAYS).
    if user is not None:
        plan = effective_plan(user)
        cap = get_cap(user, "daily_close_export_days")
        if cap > 0 and span > cap:
            tier_label = _PLAN_LABELS.get(plan, plan.title())
            # The plan limits are unchanged (a pricing decision). What changed
            # is that the refusal says how to get the period anyway — in
            # pieces the plan allows — and names the NEXT tier, not always Pro
            # (a Free owner was pushed to Pro when Starter covers a month).
            next_tier = "Starter" if cap < 31 else "Pro"
            raise HTTPException(
                status_code=402,  # Payment Required — distinct from 422
                detail={
                    "code": "plan_cap_exceeded",
                    "message": (
                        f"{tier_label} plan exports up to {cap} days at a time — "
                        f"export the period in parts, or upgrade to {next_tier}."
                    ),
                    "cap_days": cap,
                    "requested_days": span,
                    "plan": plan,
                    "next_plan": next_tier.lower(),
                },
            )

    return from_date, to_date


def _fetch_range_closes_split(
    db: Session, *, user_id, from_date: date, to_date: date,
    branch_id: str | None,
) -> tuple[list[DailyClose], list[DailyClose]]:
    """(closes, demo_closes) in the requested range, tenant-scoped.

    ONE rule for every period artifact: a demo seeder's sample close (notes end
    in " · demo") is EXCLUDED — from period_totals, the period mail, the send
    to the revisor and the downloadable PDF / Excel / CSV alike. They carry
    the business's real name and CVR over figures nobody took; September on a
    tried-the-demo account was 25 sample days + 1 real one. Filtered here in
    Python (the same predicate as the single-close path) — no extra query."""
    q = db.query(DailyClose).filter(
        DailyClose.user_id == user_id,
        DailyClose.is_deleted.isnot(True),
        DailyClose.date >= from_date,
        DailyClose.date <= to_date,
    )
    if branch_id:
        q = q.filter(DailyClose.branch_id == branch_id)
    rows = q.order_by(DailyClose.date.asc()).all()
    real = [c for c in rows if not _is_demo_close(c)]
    demo = [c for c in rows if _is_demo_close(c)]
    return real, demo


def _fetch_range_closes(
    db: Session, *, user_id, from_date: date, to_date: date,
    branch_id: str | None,
) -> list[DailyClose]:
    """Tenant-scoped fetch of the REAL closes in the requested range — demo
    closes are never part of a period artifact (_fetch_range_closes_split)."""
    return _fetch_range_closes_split(
        db, user_id=user_id, from_date=from_date, to_date=to_date, branch_id=branch_id,
    )[0]


@router.get("/export.pdf")
@_limiter.limit("5/minute")
def export_range_pdf(
    request: Request,
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    branch_id: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Multi-day daily-close PDF for accountant handoff.

    Layered defense (same shape as scan-report):
      L1 auth → L2 input bounds (max 366d) → L3 rate limit (5/min)
      L4 tenant scope (user_id filter) → L5 plan cap (Free=7d /
      Starter=31d / Pro=366d) — returns 402 with upgrade context
      when exceeded. L7 a §10 audit row is written on egress (the
      revisor-bound artifact trail; fail-soft).
    """
    f, t = _resolve_range(from_date, to_date, user=user)
    closes = _fetch_range_closes(
        db, user_id=user.id, from_date=f, to_date=t, branch_id=branch_id,
    )

    # Business name for the title page — falls back through profile, user,
    # then a generic label so the PDF always has something readable.
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()
    business_name = _business_display_name(profile, user)
    currency = user.currency or "DKK"

    # Stable per-document voucher number (KR = Kasserapport) — shown in the
    # PDF header + carried into the L7 audit row so the artifact is traceable.
    bilagsnummer = _range_bilagsnummer(f, t)
    # The per-day source and unlock/relock history the Excel and the CSV
    # carry — the PDF prints them too.
    extras = _range_extras(db, user, closes)
    pdf_bytes = build_daily_close_range_pdf(
        closes, from_date=f, to_date=t,
        business_name=business_name, currency=currency,
        profile=profile, db=db, user_id=user.id, bilagsnummer=bilagsnummer,
        tz=extras["tz"], branch_names=extras["branch_names"],
        history=extras["history"], sources=extras["sources"],
    )
    write_export_audit_row(
        db, user, doc_type="daily_close_range_pdf",
        bilagsnummer=bilagsnummer,
        period={"from": f.isoformat(), "to": t.isoformat(), "closes": len(closes)},
        ip_address=(client_ip(request) if request else None),
    )
    from app.services.revisor_mail import content_disposition
    filename = _period_filename(business_name, f, t, "pdf")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": content_disposition(filename),
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/export.csv")
@_limiter.limit("10/minute")
def export_range_csv(
    request: Request,
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    branch_id: str = Query(None),
    # "revisor" (default, what the UI offers): Danish headers, decimal comma,
    # totals row over locked closes. "machine": the raw import shape — only on
    # explicit request, never the default.
    variant: str = Query("revisor", pattern="^(revisor|machine)$"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Multi-day daily-close CSV for Danish Excel: UTF-8 BOM, ";" delimiter,
    decimal comma, Danish headers, drafts listed but not summed.

    Same plan-cap logic as the PDF endpoint — 402 with upgrade
    context when over-tier."""
    f, t = _resolve_range(from_date, to_date, user=user)
    closes = _fetch_range_closes(
        db, user_id=user.id, from_date=f, to_date=t, branch_id=branch_id,
    )
    _extras = _range_extras(db, user, closes) if variant == "revisor" else {}
    csv_bytes = closes_to_csv_bytes(
        closes, currency=user.currency or "DKK", variant=variant, **_extras,
    )
    write_export_audit_row(
        db, user, doc_type="daily_close_range_csv",
        bilagsnummer=_range_bilagsnummer(f, t),
        period={"from": f.isoformat(), "to": t.isoformat(), "closes": len(closes)},
        ip_address=(client_ip(request) if request else None),
    )
    from app.services.revisor_mail import content_disposition
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    filename = _period_filename(_business_display_name(profile, user), f, t, "csv")
    return Response(
        content=csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": content_disposition(filename),
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/export.xlsx")
@_limiter.limit("10/minute")
def export_range_xlsx(
    request: Request,
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    branch_id: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Multi-day daily-close Excel workbook for accountant handoff.

    Two-sheet workbook:
      • Summary  — business header, period, KPI totals (confirmed only)
      • Daily    — one row per close with typed columns (numbers as
                   numbers, dates as dates), frozen header, totals row
                   built from SUM() formulas so the accountant can edit
                   rows and totals stay correct.

    Accountants strongly prefer XLSX over PDF because they can sort,
    filter, and pivot. We keep PDF + CSV available for the
    "lightweight share" and "raw import" flows respectively.

    Same plan-cap logic as PDF/CSV (Free=7d / Starter=31d / Pro=366d).
    """
    f, t = _resolve_range(from_date, to_date, user=user)
    closes = _fetch_range_closes(
        db, user_id=user.id, from_date=f, to_date=t, branch_id=branch_id,
    )

    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()
    # Same derivation as the PDF endpoint and the mails, so the workbook
    # header matches every other artifact for the same account.
    business_name = _business_display_name(profile, user)
    currency = user.currency or "DKK"

    extras = _range_extras(db, user, closes)
    xlsx_bytes = build_daily_close_range_xlsx(
        closes, from_date=f, to_date=t,
        business_name=business_name, currency=currency,
        profile=profile, db=db, user_id=user.id,
        tz=extras["tz"], history=extras["history"], sources=extras["sources"],
        branch_names=extras["branch_names"], bilagsnummer=_range_bilagsnummer(f, t),
    )
    write_export_audit_row(
        db, user, doc_type="daily_close_range_xlsx",
        bilagsnummer=_range_bilagsnummer(f, t),
        period={"from": f.isoformat(), "to": t.isoformat(), "closes": len(closes)},
        ip_address=(client_ip(request) if request else None),
    )
    from app.services.revisor_mail import content_disposition
    filename = _period_filename(business_name, f, t, "xlsx")
    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": content_disposition(filename),
            "Cache-Control": "private, no-store",
        },
    )


# ─────────────────────── Send-to-accountant ───────────────────────
#
# One-tap email of the daily-close range to the accountant. We
# generate the chosen format server-side, attach it to a Resend email
# addressed to BusinessProfile.accountant_email, set reply_to to the
# user's own email so the accountant can hit Reply and reach the
# owner directly (not noreply@bonbox.dk), and return success/failure.
#
# Falls back to a friendly 400 if the user hasn't set an accountant
# email — the frontend then offers the existing mailto/share path.


class SendToAccountantRequest(BaseModel):
    fmt: str = Field(default="xlsx", pattern="^(pdf|csv|xlsx)$")
    # Accepted ONLY when it is the revisor address saved on Profile (an old
    # client may echo it). Any other address is refused: BonBox must not be a
    # way to mail an arbitrary third party. See services/revisor_mail.py.
    accountant_email: EmailStr | None = None
    # Free-text note to the revisor — HTML-escaped before it is rendered.
    message: str | None = Field(default=None, max_length=2000)
    # cc the user's own email so they have a copy for their records
    cc_self: bool = True
    # One key per tap on "Send". A retried POST with the same key (double
    # tap, a network retry) answers with the first send's outcome — never a
    # second mail to the revisor. Optional: an old client without it still
    # sends, as before.
    key: str | None = Field(default=None, min_length=8, max_length=64,
                            pattern=r"^[A-Za-z0-9_-]+$")


# How long a period-send key is remembered — long enough for any retry.
_PERIOD_SEND_REPLAY = timedelta(minutes=10)


def _period_send_replay(db: Session, user: User, key: str | None, *,
                        f: date, t: date, fmt: str,
                        branch_id: str | None = None) -> dict | None:
    """The response of an earlier period send with the same key (audit row,
    last 10 minutes, this account only), or None. The key answers only for
    the send it was minted for: the same period, format and branch. The same
    key on another one is 409 send_key_reused — never "sent" for a period
    that was not mailed."""
    if not key:
        return None
    import json as _json
    from app.models.audit_log import AuditLog
    rows = (
        db.query(AuditLog)
        .filter(
            AuditLog.user_id == user.id,
            AuditLog.action == "daily_close.send_to_accountant",
            AuditLog.created_at >= utc_now() - _PERIOD_SEND_REPLAY,
        )
        .order_by(AuditLog.created_at.desc())
        .limit(50)
        .all()
    )
    for r in rows:
        try:
            a = _json.loads(r.after_state or "{}") or {}
        except Exception:  # noqa: BLE001
            continue
        if isinstance(a, dict) and a.get("send_key") == key:
            same = (a.get("from_date") == f.isoformat() and a.get("to_date") == t.isoformat()
                    and a.get("format") == fmt
                    # Rows written before the branch was recorded carry none.
                    and ("branch_id" not in a or (a.get("branch_id") or None) == (branch_id or None)))
            if not same:
                raise HTTPException(status_code=409, detail={
                    "code": "send_key_reused",
                    "message": ("That send key belongs to another period or format. "
                                "Nothing was sent — try again."),
                    "message_da": ("Den nøgle hører til en anden periode eller et andet "
                                   "format. Intet er sendt — prøv igen."),
                })
            return {
                "ok": True, "replayed": True,
                "sent_to": a.get("recipient"), "cc_self": bool(a.get("cc_self")),
                "cc_to": a.get("cc_to"), "filename": a.get("filename"),
                "format": a.get("format"), "n_closes": a.get("n_closes"),
                "n_drafts": a.get("n_drafts"), "n_demo": a.get("n_demo"),
                "subject": a.get("subject"),
            }
    return None


_DA_MONTHS_FULL = ["januar", "februar", "marts", "april", "maj", "juni", "juli",
                   "august", "september", "oktober", "november", "december"]


def _dk_period(f: date, t: date, danish: bool = True) -> str:
    """'1.–30. september 2026' / '25. september 2026' / '29. sep.–5. okt. 2026'."""
    if not danish:
        if f == t:
            return f.strftime("%d %B %Y")
        return f"{f.strftime('%d %b %Y')} – {t.strftime('%d %b %Y')}"
    if f == t:
        return f"{f.day}. {_DA_MONTHS_FULL[f.month - 1]} {f.year}"
    if f.year == t.year and f.month == t.month:
        return f"{f.day}.–{t.day}. {_DA_MONTHS_FULL[t.month - 1]} {t.year}"
    if f.year == t.year:
        return (f"{f.day}. {_DA_MONTHS_FULL[f.month - 1]}–"
                f"{t.day}. {_DA_MONTHS_FULL[t.month - 1]} {t.year}")
    return (f"{f.day}. {_DA_MONTHS_FULL[f.month - 1]} {f.year}–"
            f"{t.day}. {_DA_MONTHS_FULL[t.month - 1]} {t.year}")


def _accountant_email_body(*, business_name: str, from_date: date, to_date: date,
                          totals: dict, currency: str, fmt: str,
                          message: str | None, is_danish: bool,
                          attachment_name: str = "", accountant_name: str | None = None,
                          cvr: str | None = None, unsubscribe_url: str | None = None,
                          owner_copy_to: str | None = None, bilagsnummer: str = "") -> str:
    """HTML body for the period mail to the revisor.

    Its figures are `period_totals` — the SAME function the attached PDF, Excel
    and CSV read — so the body can never again contradict its own attachment
    (it said 521.983,50 kr. over an Excel whose totals row said 552.036,50 kr.,
    because that row summed the draft). Drafts are named, not silently dropped.
    Every value a person typed is escaped.
    """
    from app.services.bonbox_pdf_kit import money_dk
    from app.services.revisor_mail import esc, owner_copy_line, revisor_footer_html

    def _fmt(v):
        return money_dk(v, currency)

    from app.services.daily_close_range_export import all_standard_auto, period_readiness
    from app.services.kasserapport_claims import standard_moms_label
    biz = esc(business_name)
    period = esc(_dk_period(from_date, to_date, is_danish))
    n_conf, n_drafts = totals["n_confirmed"], totals["n_drafts"]
    total_moms = totals["moms"]
    att = esc(attachment_name)
    confirmed = totals.get("confirmed") or []
    # The attachment's own rules: "(25 %)" only when every locked day is a
    # BonBox standard-rate figure, and each day's verdict from its kasserapport.
    moms_lbl = (standard_moms_label(currency) if all_standard_auto(confirmed, currency)
                else ("Salgsmoms" if is_danish else "Output VAT"))
    ready = period_readiness(confirmed, currency)
    _MM = ["jan.", "feb.", "mar.", "apr.", "maj", "jun.", "jul.", "aug.", "sep.", "okt.", "nov.", "dec."]

    def _short(d):
        return f"{d.day}. {_MM[d.month - 1]}" if is_danish else d.strftime("%d %b")

    # The owner's own copy is not addressed to the revisor by name.
    named = bool((accountant_name or "").strip()) and not owner_copy_to
    if is_danish:
        greeting = f"Hej {esc(accountant_name.strip())}," if named else "Hej,"
        closes_word = "låst lukning" if n_conf == 1 else "låste lukninger"
        intro = (
            f"Vedhæftet er kasserapporterne for <strong>{biz}</strong> for "
            f"<strong>{period}</strong> ({n_conf} {closes_word})."
        )
        draft_note = (
            f"{n_drafts} {'kladde' if n_drafts == 1 else 'kladder'} i perioden er ikke "
            "låst og er ikke medregnet i tallene."
        ) if n_drafts else ""
        kpi_label_rev = "Omsætning"
        kpi_label_moms = esc(moms_lbl)
        ready_line = (
            f"{len(ready['ready'])} af {ready['n_locked']} klar til bogføring"
            + (f" · {len(ready['review'])} skal gennemgås: "
               + ", ".join(_short(c.date) for c in ready["review"][:8])
               + (" …" if len(ready["review"]) > 8 else "")
               if ready["review"] else "")
        ) if ready["n_locked"] else ""
        format_note = {
            "pdf":  "PDF — oversigt over perioden med én linje pr. dag.",
            "xlsx": "Excel — én række pr. dag; totalerne tæller kun låste lukninger.",
            "csv":  "CSV — semikolon og decimalkomma, åbner direkte i dansk Excel.",
        }[fmt]
        # The period voucher number the attachment carries (KRP-…), as the
        # lock mail names the day's KR-… number.
        attached = (f"Vedhæftet fil: {att}"
                    + (f" (bilagsnr. {esc(bilagsnummer)})" if bilagsnummer else "")) if att else ""
    else:
        greeting = f"Hello {esc(accountant_name.strip())}," if named else "Hello,"
        intro = (
            f"Attached are the daily closes for <strong>{biz}</strong> for "
            f"<strong>{period}</strong> ({n_conf} locked)."
        )
        draft_note = (
            f"{n_drafts} draft(s) in the period are not locked and are not counted."
        ) if n_drafts else ""
        kpi_label_rev = "Revenue"
        kpi_label_moms = esc(moms_lbl)
        ready_line = (
            f"{len(ready['ready'])} of {ready['n_locked']} ready for bookkeeping"
            + (f" · {len(ready['review'])} need review: "
               + ", ".join(_short(c.date) for c in ready["review"][:8])
               + (" …" if len(ready["review"]) > 8 else "")
               if ready["review"] else "")
        ) if ready["n_locked"] else ""
        format_note = {
            "pdf":  "PDF — period overview, one line per day.",
            "xlsx": "Excel — one row per day; totals count locked closes only.",
            "csv":  "CSV — semicolon separated, one row per day.",
        }[fmt]
        attached = (f"Attached file: {att}"
                    + (f" (voucher no. {esc(bilagsnummer)})" if bilagsnummer else "")) if att else ""

    moms_note = ""
    if total_moms is None:
        # The body must not state a period salgsmoms the attachment itself
        # refuses to state.
        moms_note = (
            "<p style='color:#b45309;font-size:13px;'>"
            + ("Salgsmoms i alt kan ikke opgøres for perioden — se kolonnen "
               "Salgsmoms i den vedhæftede fil." if is_danish else
               "Total output VAT cannot be stated for this period — see the "
               "VAT column in the attached file.")
            + "</p>"
        )

    user_note_html = ""
    if (message or "").strip():
        safe = esc(message.strip()).replace("\n", "<br>")
        user_note_html = (
            "<div style='margin:16px 0;padding:12px;background:#f9fafb;"
            "border-left:3px solid #10b981;color:#374151;font-size:14px;"
            "line-height:1.5;'>"
            f"{safe}"
            "</div>"
        )

    return (
        "<div style='font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#111827;line-height:1.5;font-size:14px;max-width:560px;'>"
        f"<p>{greeting}</p>"
        f"<p>{intro}</p>"
        + (f"<p style='color:#92400e;font-size:13px;'>{draft_note}</p>" if draft_note else "")
        + f"{user_note_html}"
        "<table style='border-collapse:collapse;margin:16px 0;font-size:14px;line-height:1.5;'>"
        f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{kpi_label_rev}</td>"
        f"<td style='padding:4px 0;font-weight:600;text-align:right;'>{_fmt(totals['revenue'])}</td></tr>"
        f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{kpi_label_moms}</td>"
        f"<td style='padding:4px 0;font-weight:600;text-align:right;'>{_fmt(total_moms)}</td></tr>"
        "</table>"
        + (f"<p style='color:{'#065f46' if not ready['review'] else '#92400e'};font-size:13px;'>"
           f"{esc(ready_line)}</p>" if ready_line else "")
        + f"{moms_note}"
        + (f"<p style='color:#374151;font-size:13px;margin-top:16px;'>{attached}<br>"
           f"<span style='color:#6b7280;'>{format_note}</span></p>" if attached else
           f"<p style='color:#6b7280;font-size:13px;margin-top:16px;'>{format_note}</p>")
        + (owner_copy_line(owner_copy_to, is_danish) if owner_copy_to else
           revisor_footer_html(business_name=business_name, cvr=cvr,
                               unsubscribe_url=unsubscribe_url, is_danish=is_danish))
        + "</div>"
    )


@router.post("/send-to-accountant")
@_limiter.limit("5/minute")
def send_to_accountant(
    request: Request,
    body: SendToAccountantRequest,
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    branch_id: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Email the daily-close range to the accountant. Starter+ feature.

    Free users hit a structured 402; the frontend then downloads the file and
    opens the owner's own mail app — the honest Free path.

    Layered defense:
      L1 auth (owner session; member/accountant writes are refused upstream)
      → L2 input bounds → L3 rate limit (5/min per IP + 20/day per account)
      → L4 tenant scope → L5 plan-feature gate → L6 recipient = the SAVED
      revisor address only, opt-out honoured → L7 audit row.
    """
    from app.services.billing import has_feature, effective_plan
    from app.services.revisor_mail import (
        enforce_revisor_daily_cap, header_safe, require_verified_revisor_sender,
        resolve_revisor_recipient,
    )
    if not has_feature(user, "direct_accountant_email"):
        raise HTTPException(
            status_code=402,
            detail={
                "code": "plan_required",
                "feature": "direct_accountant_email",
                "required_plan": "starter",
                "current_plan": effective_plan(user),
                "message": (
                    "Direct email to your accountant is on Starter. "
                    "You can still download the file and attach it manually."
                ),
            },
        )

    f, t = _resolve_range(from_date, to_date, user=user)

    # The same tap again: answer with what happened — never a second mail.
    # Only for the SAME send (period, format, branch): a key reused for
    # another one is refused (409 send_key_reused), never answered "sent".
    replay = _period_send_replay(db, user, body.key, f=f, t=t, fmt=body.fmt,
                                 branch_id=branch_id)
    if replay is not None:
        return replay

    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()

    # The saved revisor address, and nothing else.
    recipient = resolve_revisor_recipient(profile, body.accountant_email, user=user)
    enforce_revisor_daily_cap(db, user)
    # Demo closes are never sent: the attachment, the body and the counts are
    # the real days only (n_demo says how many sample days were left out).
    closes, demo_closes = _fetch_range_closes_split(
        db, user_id=user.id, from_date=f, to_date=t, branch_id=branch_id,
    )
    n_demo = len(demo_closes)

    business_name = _business_display_name(profile, user)
    currency = user.currency or "DKK"
    fmt = body.fmt
    is_danish = (currency == "DKK")

    # ONE source of truth for the body's figures — the same as the attachment.
    from app.services.daily_close_range_export import period_totals
    totals = period_totals(closes)
    if totals["n_confirmed"] == 0:
        # An empty, drafts-only or demo-only period is never mailed to a third
        # party: it sent the revisor "0 låste lukninger · Omsætning 0,00 kr.".
        raise HTTPException(status_code=422, detail={
            "code": "nothing_locked",
            "n_drafts": totals["n_drafts"],
            "n_demo": n_demo,
            "message": ("Der er ingen låste lukninger i perioden — lås dagene først."
                        if is_danish else
                        "There are no locked closes in this period — lock the days first."),
        })
    # Mail to the revisor needs the owner's own e-mail confirmed: 403
    # email_unverified before anything is built or mailed (no revisor mail,
    # no "Kopi:"). After the walls confirming would not fix; the page offers
    # the download + own mail.
    require_verified_revisor_sender(user)

    bilagsnummer = _range_bilagsnummer(f, t)
    extras = _range_extras(db, user, closes)

    if fmt == "pdf":
        attachment = build_daily_close_range_pdf(
            closes, from_date=f, to_date=t,
            business_name=business_name, currency=currency,
            profile=profile, db=db, user_id=user.id, bilagsnummer=bilagsnummer,
            tz=extras["tz"], branch_names=extras["branch_names"],
            history=extras["history"], sources=extras["sources"],
        )
        mime = "application/pdf"
    elif fmt == "csv":
        attachment = closes_to_csv_bytes(closes, currency=currency, **extras)
        mime = "text/csv; charset=utf-8"
    else:  # xlsx
        attachment = build_daily_close_range_xlsx(
            closes, from_date=f, to_date=t,
            business_name=business_name, currency=currency,
            profile=profile, db=db, user_id=user.id,
            tz=extras["tz"], history=extras["history"], sources=extras["sources"],
            branch_names=extras["branch_names"], bilagsnummer=bilagsnummer,
        )
        mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

    filename = _period_filename(business_name, f, t, fmt)

    from app.services.revisor_mail import revisor_unsubscribe_url
    unsub_url = revisor_unsubscribe_url(user.id, recipient)
    subject_prefix = "Kasserapporter" if is_danish else "Daily closes"
    subject = header_safe(
        f"{subject_prefix} {_dk_period(f, t, is_danish)} — {business_name}", 180,
    )
    body_args = dict(
        business_name=business_name, from_date=f, to_date=t,
        totals=totals, currency=currency, fmt=fmt,
        message=body.message, is_danish=is_danish,
        attachment_name=filename,
        accountant_name=getattr(profile, "accountant_name", None),
        cvr=getattr(profile, "org_number", None),
        # Named only for the files that print it (the CSV carries none).
        bilagsnummer=(bilagsnummer if fmt in ("pdf", "xlsx") else ""),
    )
    html = _accountant_email_body(**body_args, unsubscribe_url=unsub_url)
    html_owner = _accountant_email_body(**body_args, owner_copy_to=recipient)

    from app.services.revisor_mail import send_file_to_revisor, sender_display

    # One owner address for the copy AND the revisor's Reply-To: the login,
    # and no copy to an address that opted out.
    owner_addr = _owner_contact_email(profile, user)
    ok, err, owner_copied = send_file_to_revisor(
        recipient=recipient, subject=subject,
        html_revisor=html, html_owner=html_owner,
        owner_email=(owner_addr if (body.cc_self and _owner_copy_allowed(profile, owner_addr))
                     else None),
        attachment_bytes=attachment, attachment_filename=filename,
        attachment_mime=mime, reply_to=owner_addr or user.email,
        from_display=sender_display(business_name),
        unsubscribe_url=unsub_url, is_danish=is_danish,
    )
    cc = [owner_addr] if owner_copied else None

    if not ok:
        # 502 when Resend was ASKED and failed — the outcome is not "nothing
        # happened", so the frontend must not silently replay or fall back.
        # 503 only when nothing was attempted (mail not configured).
        raise HTTPException(
            status_code=503 if err == "email_not_configured" else 502,
            detail={
                "code": "email_send_failed",
                "reason": err or "unknown",
                "message": "Couldn't send email right now. The file is still available to download or share.",
            },
        )

    # Bogføringsloven — record that the period bundle was delivered to a
    # third party: WHO got WHAT (recipient, range, totals).
    audit_service.record(
        db, user=user,
        action="daily_close.send_to_accountant",
        entity_type="daily_close_range",
        entity_id=None,  # range-level action, not single-row
        before=None,
        after={
            "recipient": recipient, "cc_self": bool(cc), "cc_to": owner_addr if cc else None,
            "format": fmt,
            "filename": filename, "n_closes": totals["n_confirmed"],
            "n_drafts": totals["n_drafts"], "n_demo": n_demo,
            "from_date": f.isoformat(), "to_date": t.isoformat(),
            "branch_id": branch_id or None,
            "total_revenue": totals["revenue"], "total_moms": totals["moms"],
            # The tap's key and what it answered, so a retry replays it.
            "send_key": body.key, "subject": subject,
        },
        ip_address=getattr(request.client, "host", None) if request.client else None,
    )
    try:
        db.commit()
    except Exception as e:  # noqa: BLE001
        # The mail already went: a failed audit commit must not turn a
        # delivered send into a 500 the owner would "retry" into a duplicate.
        logger.warning("send_to_accountant: audit commit failed after send: %s", e)
        db.rollback()

    return {
        "ok": True,
        "sent_to": recipient,
        "cc_self": bool(cc),
        "cc_to": owner_addr if cc else None,
        "filename": filename,
        "format": fmt,
        "n_closes": totals["n_confirmed"],
        "n_drafts": totals["n_drafts"],
        "n_demo": n_demo,
        "subject": subject,
    }


# ─── GET — the period sends to the revisor (a lasting record) ───
#
# A period send left only an 8-second toast: later the owner could not see in
# BonBox whether September went, when, in which format or to whom. The audit
# row already holds all of it; this reads the latest ones back (tenant-scoped).

@router.get("/accountant-sends")
def list_accountant_sends(
    limit: int = Query(3, ge=1, le=20),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    import json as _json
    from app.models.audit_log import AuditLog
    rows = (
        db.query(AuditLog)
        .filter(
            AuditLog.user_id == user.id,
            AuditLog.action == "daily_close.send_to_accountant",
        )
        .order_by(AuditLog.created_at.desc())
        .limit(limit)
        .all()
    )
    out = []
    for r in rows:
        try:
            a = _json.loads(r.after_state or "{}") or {}
        except Exception:  # noqa: BLE001
            a = {}
        if not isinstance(a, dict) or not a.get("from_date"):
            continue
        out.append({
            "sent_at": r.created_at,
            "recipient": a.get("recipient"),
            "format": a.get("format"),
            "from": a.get("from_date"),
            "to": a.get("to_date"),
            "n_closes": a.get("n_closes"),
            "n_drafts": a.get("n_drafts"),
            "filename": a.get("filename"),
            "cc_to": a.get("cc_to"),
        })
    return out


@router.get("/range-counts")
def range_counts(
    from_date: date = Query(..., alias="from"),
    to_date: date = Query(..., alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """What the period exports and the send to the revisor count for a range
    — read from the database, the same rows _fetch_range_closes selects. The
    page used History's cache, which holds only the newest 90 closes, so
    "Forrige kvartal" (and any custom range reaching past them) undercounted
    in the confirm ("76 låste" where the mail counted 184) and could claim a
    range had no locked closes at all."""
    if to_date < from_date:
        from_date, to_date = to_date, from_date
    rows = (
        db.query(DailyClose.id, DailyClose.date, DailyClose.status, DailyClose.notes)
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.is_deleted.isnot(True),
            DailyClose.date >= from_date,
            DailyClose.date <= to_date,
        )
        .order_by(DailyClose.date.asc())
        .limit(5000)
        .all()
    )
    # Demo closes are in no period artifact and never sent (the same rule as
    # _fetch_range_closes_split): counted apart, so the confirm can say
    # "N eksempeldage sendes ikke" and a demo-only range reads as empty.
    demo = [r for r in rows if _is_demo_close(r)]
    real = [r for r in rows if not _is_demo_close(r)]
    locked = [r for r in real if (r.status or "confirmed") == "confirmed"]
    return {
        "from": from_date.isoformat(),
        "to": to_date.isoformat(),
        "n_locked": len(locked),
        "n_drafts": len(real) - len(locked),
        "n_demo": len(demo),
        "locked": [{"id": str(r.id), "date": r.date.isoformat()} for r in locked],
    }


# ─── GET — single close ───

@router.get("/{close_id}")
def get_daily_close(
    close_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    dc = db.query(DailyClose).filter(
        DailyClose.id == close_id,
        DailyClose.user_id == user.id,
    ).first()
    if not dc:
        raise HTTPException(status_code=404, detail="Daily close not found")
    out = _to_response(dc)
    # Round 22: the page's id for the save that wrote it last — a page whose
    # save got no answer knows the row is its own exactly when this is one
    # of the save ids it sent. Left out when it could not be read (round 22
    # review: unknown, never "not the page's").
    sids = _last_save_ids(db, user, [dc.id])
    if sids is not None:
        out["last_save_id"] = sids.get(str(dc.id))
    return out


# ─── GET — PDF Kasserapport ───

@router.get("/{close_id}/pdf")
def daily_close_pdf(
    close_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Kasserapport PDF for one close — the same document the lock mail and
    the explicit resend attach (services/close_kasserapport_pdf.py)."""
    dc = db.query(DailyClose).filter(
        DailyClose.id == close_id,
        DailyClose.user_id == user.id,
        # A deleted close has no kasserapport to hand anyone.
        DailyClose.is_deleted.isnot(True),
    ).first()
    if not dc:
        raise HTTPException(status_code=404, detail="Daily close not found")
    from app.services.close_kasserapport_pdf import build_close_kasserapport_pdf
    from app.services.revisor_mail import content_disposition
    out = build_close_kasserapport_pdf(db, user, dc)
    return StreamingResponse(
        iter([out["pdf"]]),
        media_type="application/pdf",
        headers={
            "Content-Disposition": content_disposition(out["filename"]),
            "X-Document-Id": out["doc_id"],
            # A business document: never kept by a shared cache or proxy (the
            # period exports already said so; this one did not).
            "Cache-Control": "private, no-store",
        },
    )


# ─── DELETE — soft delete ───

@router.delete("/{close_id}", status_code=204)
def delete_daily_close(
    close_id: str,
    request: Request,
    # Round 21 review — the version of the draft the page holds (and its own
    # save still on its way, when an answer was lost): the same draft_changed
    # rule as a save. Absent (History, an older app build): as before.
    base_updated_at: datetime | None = Query(None),
    base_save_id: str | None = Query(None, max_length=64),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    dc = db.query(DailyClose).filter(
        DailyClose.id == close_id,
        DailyClose.user_id == user.id,
    ).first()
    if not dc:
        raise HTTPException(status_code=404, detail="Daily close not found")
    # A locked (status=="confirmed") close is the legal kasserapport for
    # that day under Bogføringsloven §10 — it must NOT be deletable without
    # an explicit unlock first. Refuse and tell the owner to unlock.
    # (Audit 2026-06-10 — previously any close could be soft-deleted with
    # no lock check and no audit row.)
    if (dc.status or "").lower() == "confirmed":
        raise HTTPException(
            status_code=409,
            detail={
                "error": "close_locked",
                "message": "This close is locked. Unlock it first, then delete.",
            },
        )
    # A draft the page created and now takes back (Start forfra on a day of
    # photos only, a date move) that was saved somewhere else since — another
    # phone typed Kort 2.000 into it — is never deleted in silence: refused
    # (412 draft_changed, with the stored draft), and the page shows it.
    if not dc.is_deleted:
        _changed = _draft_changed_since(dc, base_updated_at, base_save_id, db=db, user=user)
        if _changed is not None:
            raise HTTPException(status_code=412, detail=_changed)
        # …and the version just checked is held until this delete commits
        # (round 22 review), as a save's is (_claim_draft_version): the check
        # reads the row without a lock and the delete's UPDATE has no version
        # condition — another phone's save committing in between (it got 200)
        # was deleted with this page's figures. A newer version committed
        # first is read and checked like the first one (412 draft_changed, or
        # the page's own save it follows — base_save_id); a row locked
        # meanwhile keeps its 409.
        if base_updated_at is not None and (dc.status or "").lower() == "draft":
            from types import SimpleNamespace as _NS
            _claim_draft_version(db, dc, _NS(base_updated_at=base_updated_at, base_save_id=base_save_id), user)
            if (dc.status or "").lower() == "confirmed":
                raise HTTPException(
                    status_code=409,
                    detail={
                        "error": "close_locked",
                        "message": "This close is locked. Unlock it first, then delete.",
                    },
                )
    dc.is_deleted = True
    dc.deleted_at = utc_now()
    # L7 — every delete leaves an audit trail (who, when, which date).
    audit_service.record(
        db, user=user,
        action="close.deleted",
        entity_type="daily_close",
        entity_id=dc.id,
        before={"date": dc.date.isoformat() if dc.date else None, "status": dc.status},
        after={"is_deleted": True},
        ip_address=getattr(request.client, "host", None) if request.client else None,
    )
    db.commit()
