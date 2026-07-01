"""Anomaly Detector — daily watchdog that flags unusual events.

Runs once per user per day on yesterday's data. Outputs a list of
AnomalyAlert rows that get surfaced on the dashboard until dismissed.

Multi-barrier defense (same 7-layer pattern as Daily Brief / Smart Sale):

  Layer 1 — INPUT VALIDATION
      ↓ Auth-only endpoint; scan_date derived server-side from today.

  Layer 2 — DETERMINISTIC PRECOMPUTE
      ↓ Pull yesterday's events + 30-day baselines from real DB tables
        (Sale, Expense, EventLog, SecurityEvent, Khata*). Compute
        statistical thresholds (mean + N×std) entirely in Python — no
        LLM involvement in numeric reasoning.

  Layer 3 — RULE-BASED CANDIDATE DETECTION (deterministic)
      ↓ Hand-tuned rules apply thresholds to produce candidates. Each
        candidate carries an EXACT title and detail string built from
        precomputed values — no AI in this step. This is the "facts"
        layer; the LLM cannot invent or distort it.

  Layer 4 — OPTIONAL LLM POLISH
      ↓ For Pro/Trial users, Claude rewrites detail strings into more
        natural language. Tool-use enforces JSON schema. Numbers in
        the polished output are validated against the candidate's
        original numbers — any drift = keep the deterministic version.

  Layer 5 — FALLBACK
      ↓ If LLM fails or validation rejects, deterministic strings are
        used as-is. Owner sees the same alerts either way.

  Layer 6 — IDEMPOTENCY + CACHE
      ↓ One scan per (user, scan_date). If a row already exists for
        today's scan_date, the function returns those existing rows
        (no re-scan, no extra LLM cost). Forces idempotency at the DB
        level via the (user_id, scan_date, kind, reference_id) tuple
        check before inserting.

  Layer 7 — TIGHT BUDGET
      ↓ Free tier: deterministic only (no LLM call). Pro+: 1 LLM call
        per day per user, max ~600 input + 400 output tokens =
        ~$0.005/user/day.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Optional

from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from app.config import settings
from app.models import (
    AnomalyAlert,
    Expense,
    KhataCustomer,
    KhataTransaction,
    Sale,
    SecurityEvent,
    User,
)
from app.services.billing import effective_plan
from app.utils.time import utc_now

logger = logging.getLogger(__name__)


# Minimum days of history before any rule fires. New users with thin data
# would generate noise (every sale looks "unusual" without a baseline).
_MIN_HISTORY_DAYS = 14


# ─────────────────────────────────────────────────────────────────
# Layer 2 + 3 — Precompute + Rules
# ─────────────────────────────────────────────────────────────────

@dataclass
class _Candidate:
    kind: str
    severity: str  # low | medium | high
    title: str
    detail: str
    reference_id: str | None = None
    reference_type: str | None = None
    # The exact numbers that appear in title/detail. The LLM polish step
    # is allowed to reuse these but never invent new ones.
    numeric_facts: list[float] = field(default_factory=list)


def _stats(values: list[float]) -> tuple[float, float]:
    """Returns (mean, std). Empty input -> (0.0, 0.0)."""
    if not values:
        return 0.0, 0.0
    n = len(values)
    mean = sum(values) / n
    var = sum((v - mean) ** 2 for v in values) / n
    return mean, var ** 0.5


def detect_candidates(
    user: User,
    db: Session,
    scan_date: date,
) -> list[_Candidate]:
    """Run all rules against yesterday's data and return flagged
    candidates. Yesterday is `scan_date - 1 day`. Pure read; no DB writes."""
    yesterday = scan_date - timedelta(days=1)
    baseline_start = yesterday - timedelta(days=30)
    candidates: list[_Candidate] = []

    # ── Sales: 30-day baseline + yesterday slice ────────────────────────
    sales_30d = (
        db.query(Sale)
        .filter(
            Sale.user_id == user.id,
            Sale.is_deleted.isnot(True),
            Sale.date >= baseline_start,
            Sale.date < yesterday,
        )
        .all()
    )

    distinct_days = {s.date for s in sales_30d}
    if len(distinct_days) >= _MIN_HISTORY_DAYS:
        amounts = [float(s.amount) for s in sales_30d if s.amount and float(s.amount) > 0]
        if amounts:
            mean, std = _stats(amounts)
            yest_sales = (
                db.query(Sale)
                .filter(
                    Sale.user_id == user.id,
                    Sale.is_deleted.isnot(True),
                    Sale.date == yesterday,
                )
                .all()
            )

            # Rule 1 — Sale amount way above normal
            if std > 0:
                hi_4sigma = mean + 4 * std
                hi_6sigma = mean + 6 * std
                for s in yest_sales:
                    amt = float(s.amount or 0)
                    if amt > hi_4sigma:
                        sev = "high" if amt > hi_6sigma else "medium"
                        candidates.append(_Candidate(
                            kind="sale_outlier",
                            severity=sev,
                            title=f"Unusually large sale: {int(round(amt)):,} {user.currency or 'DKK'}",
                            detail=(
                                f"A sale of {int(round(amt)):,} {user.currency or 'DKK'} on "
                                f"{yesterday.isoformat()} is well above your typical sale "
                                f"(~{int(round(mean)):,} {user.currency or 'DKK'} average). "
                                f"Verify it's correct."
                            ),
                            reference_id=str(s.id),
                            reference_type="sale",
                            numeric_facts=[amt, mean],
                        ))

            # Rule 2 — Sale velocity burst (5-minute window)
            if yest_sales:
                # Count sales by 5-min bucket, find max bucket
                from collections import defaultdict
                buckets: dict[tuple[int, int], int] = defaultdict(int)
                for s in yest_sales:
                    if not s.created_at:
                        continue
                    bucket_min = (s.created_at.hour * 60 + s.created_at.minute) // 5
                    buckets[(s.created_at.hour, bucket_min)] += 1
                if buckets:
                    max_per_bucket = max(buckets.values())
                    avg_per_day = len(amounts) / max(1, len(distinct_days))
                    # Velocity threshold: more than half a day's worth of
                    # sales in one 5-min window is suspicious
                    if max_per_bucket > 5 and max_per_bucket > avg_per_day / 2:
                        sev = "high" if max_per_bucket > avg_per_day else "medium"
                        candidates.append(_Candidate(
                            kind="velocity_burst",
                            severity=sev,
                            title=f"Burst of {max_per_bucket} sales in 5 minutes",
                            detail=(
                                f"You logged {max_per_bucket} sales within a 5-minute window "
                                f"on {yesterday.isoformat()}. If that wasn't a real rush, check "
                                f"for duplicates or a stuck submit button."
                            ),
                            reference_type="sales_velocity",
                            numeric_facts=[float(max_per_bucket)],
                        ))

    # ── Expenses outlier ─────────────────────────────────────────────────
    exp_30d = (
        db.query(Expense)
        .filter(
            Expense.user_id == user.id,
            Expense.is_deleted.isnot(True),
            Expense.is_personal.isnot(True),
            Expense.date >= baseline_start,
            Expense.date < yesterday,
        )
        .all()
    )
    if len({e.date for e in exp_30d}) >= _MIN_HISTORY_DAYS:
        amts = [float(e.amount) for e in exp_30d if e.amount and float(e.amount) > 0]
        if amts:
            mean, std = _stats(amts)
            yest_exp = (
                db.query(Expense)
                .filter(
                    Expense.user_id == user.id,
                    Expense.is_deleted.isnot(True),
                    Expense.is_personal.isnot(True),
                    Expense.date == yesterday,
                )
                .all()
            )
            if std > 0:
                hi = mean + 4 * std
                for e in yest_exp:
                    amt = float(e.amount or 0)
                    if amt > hi:
                        candidates.append(_Candidate(
                            kind="expense_outlier",
                            severity="medium",
                            title=f"Unusually large expense: {int(round(amt)):,} {user.currency or 'DKK'}",
                            detail=(
                                f"An expense of {int(round(amt)):,} {user.currency or 'DKK'} "
                                f"on {yesterday.isoformat()} is well above your normal range "
                                f"(~{int(round(mean)):,} avg). Confirm the receipt and category."
                            ),
                            reference_id=str(e.id),
                            reference_type="expense",
                            numeric_facts=[amt, mean],
                        ))

    # ── Failed login attempts ────────────────────────────────────────────
    try:
        day_start = datetime.combine(yesterday, time.min)
        day_end = datetime.combine(yesterday + timedelta(days=1), time.min)
        failed = (
            db.query(sa_func.count(SecurityEvent.id))
            .filter(
                SecurityEvent.user_id == user.id,
                SecurityEvent.event_type.in_(["failed_login", "login_failed", "auth_failed"]),
                SecurityEvent.created_at >= day_start,
                SecurityEvent.created_at < day_end,
            )
            .scalar()
            or 0
        )
        if failed > 5:
            sev = "high" if failed > 20 else "medium"
            candidates.append(_Candidate(
                kind="failed_logins",
                severity=sev,
                title=f"{int(failed)} failed login attempts yesterday",
                detail=(
                    f"There were {int(failed)} failed login attempts on your account on "
                    f"{yesterday.isoformat()}. If that wasn't you, change your password and "
                    f"consider enabling 2-factor authentication."
                ),
                reference_type="login",
                numeric_facts=[float(failed)],
            ))
    except Exception:  # noqa: BLE001
        # SecurityEvent schema may differ — never let it break the scan
        logger.debug("anomaly_detector: SecurityEvent query failed, skipping rule")

    # ── Many soft-deletions (potential mistake / data tampering) ────────
    try:
        deleted = (
            db.query(sa_func.count(Sale.id))
            .filter(
                Sale.user_id == user.id,
                Sale.is_deleted.is_(True),
                Sale.deleted_at >= datetime.combine(yesterday, time.min),
                Sale.deleted_at < datetime.combine(yesterday + timedelta(days=1), time.min),
            )
            .scalar()
            or 0
        )
        if deleted > 5:
            candidates.append(_Candidate(
                kind="many_deletions",
                severity="medium",
                title=f"{int(deleted)} sales deleted yesterday",
                detail=(
                    f"You deleted {int(deleted)} sales on {yesterday.isoformat()}. "
                    f"If that's normal cleanup, dismiss this. If not, check for accidental "
                    f"swipes or a buggy import."
                ),
                reference_type="deleted_sales",
                numeric_facts=[float(deleted)],
            ))
    except Exception:  # noqa: BLE001
        logger.debug("anomaly_detector: deletion-count query failed, skipping rule")

    # ── New khata customer with very large opening transaction ──────────
    try:
        recent_custs = (
            db.query(KhataCustomer)
            .filter(
                KhataCustomer.user_id == user.id,
                KhataCustomer.is_deleted.isnot(True),
                KhataCustomer.created_at >= datetime.combine(yesterday, time.min),
                KhataCustomer.created_at < datetime.combine(yesterday + timedelta(days=1), time.min),
            )
            .all()
        )
        for c in recent_custs:
            opening = (
                db.query(sa_func.coalesce(sa_func.sum(KhataTransaction.purchase_amount), 0))
                .filter(
                    KhataTransaction.customer_id == c.id,
                    KhataTransaction.user_id == user.id,
                )
                .scalar()
                or 0
            )
            if float(opening) > 5000:  # threshold could be configurable later
                candidates.append(_Candidate(
                    kind="khata_large",
                    severity="medium",
                    title=f"New credit customer with {int(float(opening)):,} {user.currency or 'DKK'} opening balance",
                    detail=(
                        f"You added a new khata customer ({c.name or 'unnamed'}) with an "
                        f"opening purchase of {int(float(opening)):,} {user.currency or 'DKK'} "
                        f"on {yesterday.isoformat()}. Confirm credit terms and contact details."
                    ),
                    reference_id=str(c.id),
                    reference_type="khata_customer",
                    numeric_facts=[float(opening)],
                ))
    except Exception:  # noqa: BLE001
        logger.debug("anomaly_detector: khata query failed, skipping rule")

    # ── Wages / labor cost anomalies (S10) ──────────────────────────────
    # Two rules fire here, each producing an independent candidate:
    #
    #   Rule A — Labor share blowout. Trailing-week labor cost (sum of
    #            HoursLogged.earned, with rate × hours fallback) divided
    #            by trailing-week revenue (sum of Sale.amount). If the
    #            share exceeds 45% it's the canonical Danish-café "watch
    #            this" threshold (well above the 25–35% healthy band but
    #            below what counts as data error). Severity tunes up at
    #            60%.
    #
    #   Rule B — Trailing-week labor cost > 30% above the 8-week median.
    #            Catches *spikes* that don't necessarily blow the labor
    #            share (a flat revenue week with a 30% wages surge) so
    #            the owner notices before payroll month-end.
    #
    # Gated on the `ai_anomaly_detection` feature flag so the marketing
    # claim "AI anomaly detection on sales AND wages" (Starter+) is
    # backed by a real entitlement — Free users don't see these wages
    # candidates in their Daily Brief.
    #
    # Pure SQL aggregation + a constant; no LLM in this layer. Wrapped in
    # try/except so a missing column on an old DB never breaks the scan.
    from app.services.billing import has_feature as _has_feature
    if _has_feature(user, "ai_anomaly_detection"):
        try:
            from app.models.staff import HoursLogged
            week_end = yesterday
            week_start = week_end - timedelta(days=6)

            # Trailing-week labor cost — prefer pre-computed `earned`
            # (set by /hours endpoint at log time); fall back to
            # total_hours × rate_applied when `earned` is NULL (legacy
            # rows).
            wk_hours = (
                db.query(HoursLogged)
                .filter(
                    HoursLogged.user_id == user.id,
                    HoursLogged.date >= week_start,
                    HoursLogged.date <= week_end,
                )
                .all()
            )
            labor_this_week = 0.0
            for h in wk_hours:
                earned = float(h.earned or 0) if h.earned is not None else 0.0
                if earned <= 0 and h.rate_applied is not None:
                    earned = float(h.total_hours or 0) * float(h.rate_applied or 0)
                labor_this_week += earned

            # Trailing-week revenue — same window, sales sum.
            revenue_this_week = float(
                db.query(sa_func.coalesce(sa_func.sum(Sale.amount), 0))
                .filter(
                    Sale.user_id == user.id,
                    Sale.is_deleted.isnot(True),
                    Sale.date >= week_start,
                    Sale.date <= week_end,
                )
                .scalar()
                or 0
            )

            # Rule A — Labor cost % of revenue beyond the watchdog
            # threshold. Only fires when there's meaningful revenue
            # (>= 1000 to suppress division-by-near-zero on a quiet
            # week) AND non-zero labor.
            if labor_this_week > 0 and revenue_this_week >= 1000:
                labor_pct = labor_this_week / revenue_this_week * 100
                if labor_pct > 45:
                    sev = "high" if labor_pct > 60 else "medium"
                    candidates.append(_Candidate(
                        kind="labor_share_high",
                        severity=sev,
                        title=f"Labor cost {int(round(labor_pct))}% of revenue last week",
                        detail=(
                            f"In the 7 days ending {week_end.isoformat()}, payroll cost "
                            f"({int(round(labor_this_week)):,} {user.currency or 'DKK'}) was "
                            f"{int(round(labor_pct))}% of revenue "
                            f"({int(round(revenue_this_week)):,} {user.currency or 'DKK'}). "
                            f"Above 45% is the watchdog band for Danish cafés — review the "
                            f"schedule or look for missing sales before payroll month-end."
                        ),
                        reference_type="wages_week",
                        numeric_facts=[labor_this_week, revenue_this_week, labor_pct],
                    ))

            # Rule B — Trailing-week labor cost is >30% above the 8-week
            # median. Computes the baseline from the 8 PREVIOUS weeks
            # (i.e. weeks -8 … -1 relative to this week). Requires 4+
            # weeks of history to avoid noise on brand-new tenants.
            baseline_start = week_start - timedelta(weeks=8)
            baseline_end = week_start - timedelta(days=1)
            baseline_rows = (
                db.query(HoursLogged)
                .filter(
                    HoursLogged.user_id == user.id,
                    HoursLogged.date >= baseline_start,
                    HoursLogged.date <= baseline_end,
                )
                .all()
            )
            # Bucket into 7-day windows ending on the same weekday as
            # week_end so the comparison is apples-to-apples (Mon-Sun
            # vs Mon-Sun, etc.).
            from collections import defaultdict
            buckets: dict[int, float] = defaultdict(float)
            for h in baseline_rows:
                if not h.date:
                    continue
                # Week index: integer division of days-from-baseline_start
                # by 7.
                idx = (h.date - baseline_start).days // 7
                earned = float(h.earned or 0) if h.earned is not None else 0.0
                if earned <= 0 and h.rate_applied is not None:
                    earned = float(h.total_hours or 0) * float(h.rate_applied or 0)
                buckets[idx] += earned

            weekly_totals = [v for v in buckets.values() if v > 0]
            if len(weekly_totals) >= 4 and labor_this_week > 0:
                sorted_totals = sorted(weekly_totals)
                mid = len(sorted_totals) // 2
                if len(sorted_totals) % 2:
                    median = sorted_totals[mid]
                else:
                    median = (sorted_totals[mid - 1] + sorted_totals[mid]) / 2
                if median > 0 and labor_this_week > median * 1.30:
                    pct_over = (labor_this_week / median - 1) * 100
                    sev = "high" if pct_over > 60 else "medium"
                    # Suppress noise if Rule A already fired for the
                    # same window — they'd describe overlapping symptoms.
                    if not any(c.kind == "labor_share_high" for c in candidates):
                        candidates.append(_Candidate(
                            kind="labor_spike",
                            severity=sev,
                            title=f"Payroll spike: {int(round(pct_over))}% above your 8-week normal",
                            detail=(
                                f"Wages for the week ending {week_end.isoformat()} were "
                                f"{int(round(labor_this_week)):,} {user.currency or 'DKK'} — "
                                f"{int(round(pct_over))}% above the 8-week median of "
                                f"{int(round(median)):,} {user.currency or 'DKK'}. Verify the "
                                f"logged hours and rates before approving the next payroll."
                            ),
                            reference_type="wages_week",
                            numeric_facts=[labor_this_week, median, pct_over],
                        ))
        except Exception:  # noqa: BLE001
            logger.debug("anomaly_detector: wages query failed, skipping rule")

    return candidates


# ─────────────────────────────────────────────────────────────────
# Layer 4 — Optional LLM polish
# ─────────────────────────────────────────────────────────────────

_POLISH_TOOL = {
    "name": "polish_alerts",
    "description": (
        "Rewrite each alert's title and detail in calm, owner-friendly language. "
        "Numbers, kinds, and references must match the input exactly — never "
        "invent or change values."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "alerts": {
                "type": "array",
                "minItems": 1,
                "maxItems": 12,
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string"},
                        "severity": {"type": "string", "enum": ["low", "medium", "high"]},
                        "title": {"type": "string", "minLength": 5, "maxLength": 140},
                        "detail": {"type": "string", "minLength": 20, "maxLength": 600},
                    },
                    "required": ["kind", "severity", "title", "detail"],
                },
            },
        },
        "required": ["alerts"],
    },
}


_POLISH_SYSTEM = (
    "You are BonBox's anomaly explainer for a small business owner. You receive "
    "a list of pre-detected alerts (kind, severity, factual title and detail). "
    "Rewrite ONLY the title and detail to be friendlier and more concise — keep "
    "all numbers, kinds, severities, and references EXACTLY as given. Never "
    "invent new facts. No emoji, no markdown, no exclamation points."
)


def _try_polish(candidates: list[_Candidate]) -> dict[int, _Candidate] | None:
    """Returns {index: polished_candidate} where polish was accepted,
    or None on total failure."""
    try:
        import anthropic
    except ImportError:
        return None
    if not settings.ANTHROPIC_API_KEY or not settings.USE_CLAUDE_API:
        return None
    if not candidates:
        return None

    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
    model = getattr(settings, "AI_MODEL_ANOMALY", "claude-sonnet-5")

    payload = {
        "alerts": [
            {"kind": c.kind, "severity": c.severity, "title": c.title, "detail": c.detail}
            for c in candidates[:12]
        ]
    }
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=900,
            system=[{
                "type": "text",
                "text": _POLISH_SYSTEM,
                "cache_control": {"type": "ephemeral"},
            }],
            tools=[_POLISH_TOOL],
            tool_choice={"type": "tool", "name": _POLISH_TOOL["name"]},
            messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("anomaly_detector: polish call failed: %s", e)
        return None

    block = next(
        (b for b in (resp.content or []) if getattr(b, "type", None) == "tool_use"),
        None,
    )
    if not block or block.name != _POLISH_TOOL["name"]:
        return None
    raw = block.input or {}
    polished_arr = raw.get("alerts")
    if not isinstance(polished_arr, list) or len(polished_arr) != len(candidates[:12]):
        return None

    out: dict[int, _Candidate] = {}
    for i, p in enumerate(polished_arr):
        if not isinstance(p, dict):
            continue
        title = p.get("title", "")
        detail = p.get("detail", "")
        if not isinstance(title, str) or not isinstance(detail, str):
            continue
        # No HTML smuggling
        bad = ("<", ">", "javascript:", "data:")
        if any(b in title.lower() or b in detail.lower() for b in bad):
            continue
        # Length checks
        if len(title) < 5 or len(title) > 140 or len(detail) < 20 or len(detail) > 600:
            continue
        # Validate that every numeric_fact still appears in the polished
        # detail OR title (they MUST be there — the alert has no meaning
        # without them). Tolerant of formatting (commas, decimals) by
        # checking the integer form.
        ok = True
        merged = (title + " " + detail).lower().replace(",", "").replace(".", "")
        for nf in candidates[i].numeric_facts:
            if nf == 0:
                continue
            int_str = str(int(round(abs(nf))))
            if int_str not in merged:
                ok = False
                break
        if not ok:
            continue
        out[i] = _Candidate(
            kind=candidates[i].kind,
            severity=candidates[i].severity,
            title=title,
            detail=detail,
            reference_id=candidates[i].reference_id,
            reference_type=candidates[i].reference_type,
            numeric_facts=candidates[i].numeric_facts,
        )

    return out or None


# ─────────────────────────────────────────────────────────────────
# Public entry point — idempotent
# ─────────────────────────────────────────────────────────────────

def run_daily_scan(user: User, db: Session) -> list[AnomalyAlert]:
    """Run today's scan if not already run; return all open (un-dismissed)
    alerts from the past 7 days for display.

    Idempotent: calling twice the same day is a no-op for the scan but
    still returns the open alert list. The (user, scan_date, kind,
    reference_id) tuple acts as a dedupe key — re-running the rules can't
    produce duplicate rows."""
    today = date.today()

    # Has today's scan already run? If yes, skip detection entirely.
    already_scanned = (
        db.query(sa_func.count(AnomalyAlert.id))
        .filter(AnomalyAlert.user_id == user.id, AnomalyAlert.scan_date == today)
        .scalar()
        or 0
    )

    if not already_scanned:
        candidates = detect_candidates(user, db, today)

        # Optional polish — paid tiers only, gated via the unified
        # ai_anomaly_detection feature flag (May 2026 consolidation).
        # Starter has the flag too; Free stays deterministic with no
        # LLM polish to keep token spend predictable.
        from app.services.billing import has_feature
        polished_map: dict[int, _Candidate] = {}
        if has_feature(user, "ai_anomaly_detection") and candidates:
            polished_map = _try_polish(candidates) or {}

        for i, cand in enumerate(candidates):
            chosen = polished_map.get(i, cand)
            # Dedupe: skip if a row with same (kind, reference_id) already
            # exists for THIS user (e.g. yesterday's scan flagged the same
            # ongoing issue and the user hasn't dismissed it yet).
            existing = (
                db.query(AnomalyAlert)
                .filter(
                    AnomalyAlert.user_id == user.id,
                    AnomalyAlert.kind == chosen.kind,
                    AnomalyAlert.reference_id == chosen.reference_id,
                    AnomalyAlert.dismissed_at.is_(None),
                )
                .first()
            )
            if existing:
                continue
            row = AnomalyAlert(
                user_id=user.id,
                scan_date=today,
                kind=chosen.kind,
                severity=chosen.severity,
                title=chosen.title[:140],
                detail=chosen.detail[:600],
                reference_id=chosen.reference_id,
                reference_type=chosen.reference_type,
                polished_by_ai=(i in polished_map),
            )
            db.add(row)
        # Even if no candidates fired, write a marker so we don't re-run
        # the scan for the rest of today. We use a no-op alert that's
        # immediately dismissed at creation — invisible to the UI but
        # detectable by the "already_scanned" count above.
        if not candidates:
            marker = AnomalyAlert(
                user_id=user.id,
                scan_date=today,
                kind="scan_marker",
                severity="low",
                title="(scan completed — no anomalies)",
                detail="Internal marker; not shown to user.",
                dismissed_at=utc_now(),
                dismissed_reason="auto",
            )
            db.add(marker)
        db.commit()

    # Return the open (un-dismissed) alerts from the past 7 scan_dates,
    # newest first. The "scan_marker" rows are filtered out via dismissed_at.
    cutoff = today - timedelta(days=7)
    rows = (
        db.query(AnomalyAlert)
        .filter(
            AnomalyAlert.user_id == user.id,
            AnomalyAlert.dismissed_at.is_(None),
            AnomalyAlert.scan_date >= cutoff,
        )
        .order_by(AnomalyAlert.scan_date.desc(), AnomalyAlert.created_at.desc())
        .limit(20)
        .all()
    )
    return rows


def serialize_alert(a: AnomalyAlert) -> dict:
    return {
        "id": str(a.id),
        "scan_date": a.scan_date.isoformat() if a.scan_date else None,
        "kind": a.kind,
        "severity": a.severity,
        "title": a.title,
        "detail": a.detail,
        "reference_id": a.reference_id,
        "reference_type": a.reference_type,
        "polished_by_ai": bool(a.polished_by_ai),
        "created_at": a.created_at.isoformat() if a.created_at else None,
    }


def dismiss_alert(alert_id: str, user: User, db: Session, reason: str | None = None) -> bool:
    """Mark an alert as dismissed. Returns True on success. Refuses to
    dismiss alerts that don't belong to this user (BOLA defense)."""
    row = (
        db.query(AnomalyAlert)
        .filter(AnomalyAlert.id == alert_id, AnomalyAlert.user_id == user.id)
        .first()
    )
    if not row:
        return False
    if row.dismissed_at is None:
        row.dismissed_at = utc_now()
        # Coerce reason to allowed bucket
        allowed = {"not_anomalous", "fixed", "snoozed", "ignore", "auto"}
        row.dismissed_reason = reason if reason in allowed else "ignore"
        db.commit()
    return True
