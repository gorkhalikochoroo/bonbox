"""close_sanity — last-second guard before a daily close commits.

Why this exists (May 2026):
  The 4-layer kasserapport extractor is rigorous, but a confidently-
  wrong amount silently saved costs real money. Real-world failure
  mode at Mirabelle: closer scans 4 slips, validator passes all 4,
  one slip's "Total" was misread as 2.234 instead of 22.340 because
  the dot was a smudge. Owner taps Send → 20K kr quietly missing.

  This service is the calm last guard. Before commit:
    • Compare today's pre-commit total to the recent baseline.
    • If today is dramatically lower OR higher than the band, return
      a flag with a human-readable reason.
    • Frontend renders a soft "double-check" dialog. Owner taps
      "Yes, send" or "Let me check."

  Detection is purely deterministic (no LLM) — a percentage rule
  applied to recent daily totals. Conservative thresholds tuned to
  catch real misreads (>40% drop, >100% spike) without firing on
  honest quiet days.

Multi-layer:
  • Tenant-scoped: lookback queries filter on user_id.
  • Read-only: never writes anything; the close itself is committed
    by the caller.
  • Fail-closed: if anything fails, returns "ok" — we'd rather miss
    a flag than block the close.
  • Floors on tiny baselines: if recent_avg < 100 kr (brand-new
    venue), we don't fire spurious "below average" warnings.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.sale import Sale
from app.models.user import User

logger = logging.getLogger("bonbox.close_sanity")


# How many recent days form the baseline. 14 captures a full
# fortnightly cycle — enough to smooth a quiet Tuesday vs. busy Friday
# without chasing seasonal long-term shifts.
BASELINE_LOOKBACK_DAYS = 14

# Minimum baseline for flags to fire. New accounts and quiet venues
# can have sub-100 kr days where percentage rules become noisy.
MIN_BASELINE_KR = 100.0

# Thresholds. Tuned conservatively: a 40% under-baseline flag fires
# rarely on real data but reliably catches a misread digit. Spikes
# are less common (you can sell more, not less than nothing) so the
# upper threshold is wider.
LOW_PCT = 0.40    # ≥40% below baseline
HIGH_PCT = 1.00   # ≥100% above baseline


def _baseline_avg(
    db: Session,
    *,
    user: User,
    today: date,
    weekday: int,
) -> tuple[float, int]:
    """Average daily total across the last BASELINE_LOOKBACK_DAYS,
    matching weekday only (so a quiet Sunday doesn't get compared to a
    Friday baseline). Returns (avg, n_days_observed).

    Tenant-scoped. Excludes today by upper bound, voids/manager voids.
    """
    cutoff = today - timedelta(days=BASELINE_LOOKBACK_DAYS)
    rows = (
        db.query(Sale.date, func.sum(Sale.amount))
        .filter(
            Sale.user_id == user.id,
            Sale.date >= cutoff,
            Sale.date < today,
            Sale.is_deleted.isnot(True),
            Sale.is_void.isnot(True),
            Sale.is_manager_void.isnot(True),
        )
        .group_by(Sale.date)
        .all()
    )
    # Filter to same weekday so we compare like-for-like.
    matching = [
        float(total or 0)
        for d, total in rows
        if d and d.weekday() == weekday and total is not None
    ]
    if not matching:
        return (0.0, 0)
    return (sum(matching) / len(matching), len(matching))


def check_close_anomaly(
    db: Session,
    *,
    user: User,
    today: date,
    today_total: float,
) -> dict[str, Any]:
    """Compare today's pending close total against recent same-weekday
    baseline. Returns:
      {
        ok: bool,                  # True = no flag, safe to commit
        flagged: bool,             # True = surface a "double-check" dialog
        reason: "low" | "high" | None,
        today_total: float,
        baseline_avg: float,
        baseline_days: int,        # how many days informed the baseline
        delta_pct: float | None,   # signed pct vs. baseline (None if no baseline)
        message: str               # human-readable summary
      }
    """
    try:
        weekday = today.weekday()
        avg, n = _baseline_avg(db, user=user, today=today, weekday=weekday)
    except Exception as exc:  # noqa: BLE001
        logger.warning("close_sanity baseline failed: %s", exc)
        return {
            "ok": True, "flagged": False, "reason": None,
            "today_total": float(today_total),
            "baseline_avg": 0.0, "baseline_days": 0,
            "delta_pct": None,
            "message": "",
        }

    payload = {
        "ok": True, "flagged": False, "reason": None,
        "today_total": float(today_total),
        "baseline_avg": round(avg, 2),
        "baseline_days": n,
        "delta_pct": None,
        "message": "",
    }

    # No useful baseline → don't flag (new account, missing weekday data).
    if avg < MIN_BASELINE_KR or n < 2:
        return payload

    delta_pct = (today_total - avg) / avg if avg > 0 else 0.0
    payload["delta_pct"] = round(delta_pct, 3)

    if delta_pct <= -LOW_PCT:
        payload["ok"] = False
        payload["flagged"] = True
        payload["reason"] = "low"
        pct = int(abs(delta_pct) * 100)
        payload["message"] = (
            f"Today's total ({int(today_total):,} kr) is {pct}% below your "
            f"usual {int(avg):,} kr for this weekday. "
            "Make sure all terminals were scanned and totals look right."
        )
    elif delta_pct >= HIGH_PCT:
        payload["ok"] = False
        payload["flagged"] = True
        payload["reason"] = "high"
        pct = int(delta_pct * 100)
        payload["message"] = (
            f"Today's total ({int(today_total):,} kr) is {pct}% above your "
            f"usual {int(avg):,} kr for this weekday. "
            "If that's right, send away — otherwise check for a misread amount."
        )
    return payload
