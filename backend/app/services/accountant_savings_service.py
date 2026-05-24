"""
Accountant Hours Saved — honest "we save you revisor hours" tracker.

Manoj's mandate (verbatim):
    "we try to reduce accountant hrs you know save amount for owners so we
    give them great deal"
    "those claims are big thats why we need to be very precise one breaks
    another gets back to work and give accuracy."

What this is
------------
The product positioning leans on "BonBox saves you revisor hours = saves
you money." That claim has to be defensible — every minute we credit must
trace back to an action the owner actually performed in the app, not to a
fictional "would have done". The accountant who looks at this number must
trust it; the owner who sees it must not feel oversold.

Honesty constraint (L10 — the load-bearing layer):
  NO hours are counted unless the underlying action actually happened. The
  service counts:
    • Receipt OCR scans     — only for Expense rows with a receipt_photo
    • Daily-close locks     — only for DailyClose rows with status=confirmed
    • MOMS PDF exports      — only audit_logs rows with the exact action
    • Faktura PDF/numbering — only Invoice rows that left draft status

Anything we can't prove happened, we don't credit. We round DOWN when in
doubt, never up. The breakdown table is shipped to the frontend exactly
as-computed so an accountant can sanity-check it against the underlying
records.

Multi-barrier (the "one breaks another gets back to work" doctrine):
  L1 — Router gates feature_available behind tier (accountant_hours_widget)
  L2 — Router bounds the date range (max 1 year, end >= start)
  L3 — Router rate-limits (30/min) so a runaway client can't hammer this
  L4 — Service NEVER raises: any source-table failure falls back to 0 for
       that source. The rest of the breakdown still renders honestly.
  L5 — Tenant-scoped: every query filters by user_id
  L7 — Tests cover zero state, mixed, boundary, free-tier, and env override
  L10 — The "actually happened" constraint is implemented as data filters,
       NOT marketing-side math. There is no "magic multiplier" — every
       minute credited is gated on a real DB row.

Free-tier behavior (Manoj-confirmed):
  Free ALWAYS returns hours_saved=0, money_saved_dkk=0, breakdown=[]. The
  widget renders the upsell copy ("Sparer revisoren timer fra Starter")
  instead of zero. This is intentional — the value is real on Starter+,
  Free shouldn't see a confusing "0 hours saved" panel.

Configuration (env vars with defensive defaults — Manoj can tune later):
  ACCT_SAVINGS_RECEIPT_MIN   per-receipt minutes      (default 1.5)
  ACCT_SAVINGS_CLOSE_MIN     per-close minutes        (default 12)
  ACCT_SAVINGS_MOMS_MIN      per-export minutes       (default 45)
  ACCT_SAVINGS_FAKTURA_MIN   per-invoice minutes      (default 4)
  DK_ACCOUNTANT_HOURLY_DKK   DK accountant rate       (default 850)

Money is computed in the owner's currency. We carry a small lookup of
plausible hourly rates per currency so a non-DKK owner still gets a
believable number; DKK remains the headline (kr) per Manoj's framing.
"""
from __future__ import annotations

import logging
import os
from datetime import date
from typing import Any

from sqlalchemy import and_, func
from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog
from app.models.daily_close import DailyClose
from app.models.expense import Expense
from app.models.invoice import Invoice
from app.models.user import User
from app.services.billing import effective_plan, has_feature

logger = logging.getLogger(__name__)


# ─── Default per-source minute rates ──────────────────────────────────
#
# These are deliberately conservative. Real-world ranges (from Danish
# accountant interviews + the Bogføringsloven §10 documentation burden):
#   • Manual receipt categorisation:     2–4 min/receipt (we credit 1.5)
#   • Manual daily-close in Dinero/Billy: 10–20 min      (we credit 12)
#   • Manual MOMS angivelse:             45–90 min       (we credit 45)
#   • Manual faktura + numbering:        4–8 min         (we credit 4)
#
# Lower bound on every source so we under-promise. Env override lets
# Manoj recalibrate without a deploy if an accountant complains either
# way.
_DEFAULT_RECEIPT_MIN: float = 1.5
_DEFAULT_CLOSE_MIN: float = 12.0
_DEFAULT_MOMS_MIN: float = 45.0
_DEFAULT_FAKTURA_MIN: float = 4.0
_DEFAULT_DK_HOURLY_DKK: float = 850.0


# ─── Currency-specific accountant hourly rates ───────────────────────
#
# DKK is the headline (Manoj is selling in Denmark). For users in other
# currencies we still want to show a believable kr-equivalent figure on
# Starter+ — otherwise the widget feels broken for a Nepali or EU owner.
# These rates are intentionally rough; better to show "850 kr-equiv" than
# nothing. Owners using another currency are a tiny minority during early
# launch and the precision will be re-tuned per-market later.
_HOURLY_BY_CURRENCY: dict[str, float] = {
    "DKK": _DEFAULT_DK_HOURLY_DKK,   # Denmark — primary market
    "EUR": 115.0,                    # ~rough EU small-biz accountant
    "NPR": 1500.0,                   # Nepalese rupee
    "SEK": 1100.0,                   # SEK accountant
    "NOK": 1100.0,                   # NOK accountant
    "GBP": 75.0,                     # UK
    "USD": 95.0,                     # US
}


def _f(env_key: str, default: float) -> float:
    """Read a positive float from env with a defensive fallback.

    Returns `default` on any parse error or non-positive value. Never
    raises — the service's L4 promise is "never raise on input issues".
    """
    raw = os.environ.get(env_key)
    if not raw:
        return default
    try:
        v = float(raw)
        if v <= 0:
            return default
        return v
    except (TypeError, ValueError):
        return default


def _hourly_rate_for(currency: str | None) -> float:
    """Look up the accountant hourly rate for `currency` (uppercased).
    Falls back to DK 850 DKK if unknown. The DKK rate itself is env-
    tunable via DK_ACCOUNTANT_HOURLY_DKK so Manoj can recalibrate
    without redeploying.
    """
    cur = (currency or "DKK").upper().strip()
    dk_rate = _f("DK_ACCOUNTANT_HOURLY_DKK", _DEFAULT_DK_HOURLY_DKK)
    rates = dict(_HOURLY_BY_CURRENCY)
    rates["DKK"] = dk_rate
    return rates.get(cur, dk_rate)


def _zero_payload(user: User, *, tier: str) -> dict[str, Any]:
    """Return the canonical empty shape. Used by free-tier short-circuit
    AND by the boundary error path (start > end). Same shape as the
    real payload so the frontend never has to nullcheck."""
    currency = (getattr(user, "currency", None) or "DKK").upper()
    return {
        "hours_saved": 0.0,
        "money_saved_dkk": 0.0,
        "currency": currency,
        "breakdown": [],
        "accountant_hourly_rate": _hourly_rate_for(currency),
        "tier": tier,
    }


def _count_receipt_ocr(db: Session, user_id, start: date, end: date) -> int:
    """Count expense rows in [start, end] that carry an OCR-captured
    receipt photo. We use Expense.receipt_photo IS NOT NULL as the proxy:
    the column is only ever set by the OCR/save path (manual creation
    doesn't populate it). Soft-deleted rows are excluded.

    Honesty: an owner who scanned a receipt then deleted it doesn't get
    credited. An owner who attached a photo manually does — that's still
    a Bogføringsloven §10 source-doc that the accountant doesn't have to
    chase, which is the value we're claiming.

    L4 — best effort. On any DB error returns 0.
    """
    try:
        return int(
            db.query(func.count(Expense.id))
            .filter(
                and_(
                    Expense.user_id == user_id,
                    Expense.date >= start,
                    Expense.date <= end,
                    Expense.receipt_photo.isnot(None),
                    Expense.is_deleted.isnot(True),
                )
            )
            .scalar()
            or 0
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("accountant_savings: receipt count failed: %s", e)
        return 0


def _count_daily_closes_locked(
    db: Session, user_id, start: date, end: date
) -> int:
    """Count DailyClose rows in [start, end] that are locked (status =
    'confirmed' — the codebase synonym for 'locked'). Soft-deleted
    rows are excluded. Draft closes do NOT count: a draft can still be
    edited, so the accountant-hour saving hasn't crystallised.
    """
    try:
        return int(
            db.query(func.count(DailyClose.id))
            .filter(
                and_(
                    DailyClose.user_id == user_id,
                    DailyClose.date >= start,
                    DailyClose.date <= end,
                    DailyClose.status == "confirmed",
                    DailyClose.is_deleted.isnot(True),
                )
            )
            .scalar()
            or 0
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("accountant_savings: daily-close count failed: %s", e)
        return 0


def _count_moms_exports(
    db: Session, user_id, start: date, end: date
) -> int:
    """Count distinct MOMS PDF exports in [start, end] via the
    `reports.vat_export_pdf_generated` audit-log action (commit 707f2cb).
    Each row in audit_logs maps 1:1 to an export the owner actually
    downloaded — we don't credit "would have exported".

    The date filter compares to `created_at` (when the export happened),
    not the underlying VAT period — what we're crediting is the act of
    producing the document, not the period it covered.
    """
    try:
        # Convert date → datetime boundary so the comparison with
        # AuditLog.created_at (which is a DateTime column) works without
        # implicit casts that vary by dialect.
        from datetime import datetime, time as _time
        start_dt = datetime.combine(start, _time.min)
        end_dt = datetime.combine(end, _time.max)
        return int(
            db.query(func.count(AuditLog.id))
            .filter(
                and_(
                    AuditLog.user_id == user_id,
                    AuditLog.action == "reports.vat_export_pdf_generated",
                    AuditLog.created_at >= start_dt,
                    AuditLog.created_at <= end_dt,
                )
            )
            .scalar()
            or 0
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("accountant_savings: moms-export count failed: %s", e)
        return 0


def _count_invoices_generated(
    db: Session, user_id, start: date, end: date
) -> int:
    """Count Invoice rows that became real documents in [start, end].

    Drift note: the spec referenced an `Invoice.pdf_generated_at` field
    that does NOT exist on the model. The semantically-closest signal
    for "this faktura PDF was generated and used" is `sent_at IS NOT
    NULL` — the InvoiceService.mark_sent path stamps sent_at the moment
    the invoice transitions out of draft, and at that point the gap-less
    fakturanummer is permanently allocated and the document is locked
    (per Invoice.locked + the Bogføringsloven §7 contract).

    Falling back to `issue_date` instead would over-count: draft invoices
    with an issue_date but no send action haven't actually been used by
    the owner yet. Using sent_at keeps the honest-marketing promise.

    Includes both fakturaer and kreditnotaer — a kreditnota is also a
    Bogføringsloven document the owner would otherwise have generated
    manually.
    """
    try:
        return int(
            db.query(func.count(Invoice.id))
            .filter(
                and_(
                    Invoice.user_id == user_id,
                    Invoice.sent_at.isnot(None),
                    func.date(Invoice.sent_at) >= start,
                    func.date(Invoice.sent_at) <= end,
                )
            )
            .scalar()
            or 0
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("accountant_savings: invoice count failed: %s", e)
        return 0


def compute_hours_saved(
    db: Session,
    user: User,
    period_start: date,
    period_end: date,
) -> dict[str, Any]:
    """Compute accountant-hours saved by `user` in [period_start, period_end].

    Returns the canonical payload shape:
      {
        "hours_saved": float,            # total across all sources
        "money_saved_dkk": float,        # hours * hourly_rate (currency-aware)
        "currency": "DKK" | "EUR" | ...,
        "breakdown": [                   # one entry PER source with items > 0
          {"source": "receipt_ocr",          "items": N, "hours": h, "rate_min_each": r},
          {"source": "daily_close_autopilot", "items": N, "hours": h, "rate_min_each": r},
          {"source": "moms_export",          "items": N, "hours": h, "rate_min_each": r},
          {"source": "faktura_pdf",          "items": N, "hours": h, "rate_min_each": r},
        ],
        "accountant_hourly_rate": float, # currency-specific rate / hour
        "tier": "free" | "starter" | "pro" | "trial",
      }

    Defensive contract:
      • Free tier ALWAYS returns the zero-payload (no leaking hour counts
        on a tier whose marketing copy says "Starter+").
      • End-before-start returns the zero-payload (service-level fallback;
        the router also returns 422 at the API boundary).
      • Any DB-level failure on a source falls back to 0 for that source.
        We don't propagate the exception — the accountant-hour widget is
        a marketing-grade metric, NOT a financial system of record.
    """
    tier = effective_plan(user)

    # L4 — service-level fallback for invalid period. Router returns
    # 422 here too (defense-in-depth) but if anyone calls the service
    # directly with bad input we never raise.
    if period_end < period_start:
        return _zero_payload(user, tier=tier)

    # Free tier short-circuit. Free users get the upsell copy in the
    # widget — they never see "0 hours saved" which would feel broken.
    if not has_feature(user, "accountant_hours_widget"):
        return _zero_payload(user, tier=tier)

    # ── Rate config (env override → defaults). Read once per call so
    # ── a runtime change of an env var is picked up without restart.
    recv_min = _f("ACCT_SAVINGS_RECEIPT_MIN", _DEFAULT_RECEIPT_MIN)
    close_min = _f("ACCT_SAVINGS_CLOSE_MIN", _DEFAULT_CLOSE_MIN)
    moms_min = _f("ACCT_SAVINGS_MOMS_MIN", _DEFAULT_MOMS_MIN)
    fakt_min = _f("ACCT_SAVINGS_FAKTURA_MIN", _DEFAULT_FAKTURA_MIN)

    # ── Source counts (each one fail-safes to 0 on its own).
    n_recv = _count_receipt_ocr(db, user.id, period_start, period_end)
    n_close = _count_daily_closes_locked(db, user.id, period_start, period_end)
    n_moms = _count_moms_exports(db, user.id, period_start, period_end)
    n_fakt = _count_invoices_generated(db, user.id, period_start, period_end)

    # Build the breakdown — only include sources with items > 0 so the
    # frontend doesn't render an "0 receipts, 0 hours" row that adds
    # nothing.  Hours are rounded DOWN to 2 dp via int truncation to
    # honour Manoj's "round down when in doubt" mandate.
    def _hrs(items: int, per_item_min: float) -> float:
        if items <= 0:
            return 0.0
        return _round_down(items * per_item_min / 60.0)

    breakdown: list[dict[str, Any]] = []
    if n_recv > 0:
        breakdown.append({
            "source": "receipt_ocr",
            "items": n_recv,
            "hours": _hrs(n_recv, recv_min),
            "rate_min_each": recv_min,
        })
    if n_close > 0:
        breakdown.append({
            "source": "daily_close_autopilot",
            "items": n_close,
            "hours": _hrs(n_close, close_min),
            "rate_min_each": close_min,
        })
    if n_moms > 0:
        breakdown.append({
            "source": "moms_export",
            "items": n_moms,
            "hours": _hrs(n_moms, moms_min),
            "rate_min_each": moms_min,
        })
    if n_fakt > 0:
        breakdown.append({
            "source": "faktura_pdf",
            "items": n_fakt,
            "hours": _hrs(n_fakt, fakt_min),
            "rate_min_each": fakt_min,
        })

    hours_saved = _round_down(sum(b["hours"] for b in breakdown))

    currency = (getattr(user, "currency", None) or "DKK").upper()
    hourly = _hourly_rate_for(currency)
    money_saved = _round_down(hours_saved * hourly)

    return {
        "hours_saved": hours_saved,
        "money_saved_dkk": money_saved,
        "currency": currency,
        "breakdown": breakdown,
        "accountant_hourly_rate": hourly,
        "tier": tier,
    }


def _round_down(v: float) -> float:
    """Truncate to 2 decimal places (round-DOWN, not round-half-up).

    Manoj's mandate: "Round DOWN when in doubt." We never want to inflate
    the savings claim, even by 0.005 hours. Multiplying-then-floor-dividing
    avoids the float-display issues `round()` introduces near .005.
    """
    try:
        return float(int(v * 100)) / 100.0
    except Exception:  # noqa: BLE001
        return 0.0
