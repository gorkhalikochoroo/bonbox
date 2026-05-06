"""Kasserapport learning loop — periodic background jobs.

Two scheduled jobs:

  • daily_drift_sweep      — runs once per night, computes rolling
                             confidence per POS system, logs alerts
                             for any with significant degradation.
  • weekly_pattern_sweep   — runs Sunday night, walks every active
                             user's recent corrections to detect
                             systematic field-level patterns and
                             persist them for use in future scans.

Both jobs:
  • are idempotent (safe to retry on failure)
  • own their own DB session via SessionLocal (don't share with web)
  • catch all exceptions per-user so one bad row doesn't tank the run
  • log results to console + (future) a JobRun table for audit

Registered in app/main.py alongside the existing nightly maintenance.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.kasserapport import KasserapportExtraction
from app.models.user import User
from app.services.kasserapport_learning import (
    compute_drift_signal,
    detect_correction_patterns,
)

logger = logging.getLogger("bonbox.kasserapport_jobs")


# Known POS systems to sweep. As the format detector picks up new
# systems we'll see them in the extraction data; this set is the
# subset we EXPECT to have enough volume to monitor.
KNOWN_POS_SYSTEMS = (
    "oasis",
    "onlinepos",
    "lightspeed_k",
    "ordrestyring",
    "loyverse",
    "shopify_pos",
)


def daily_drift_sweep() -> dict:
    """Run drift detection for every known POS system. Logs alerts +
    returns summary dict so the cron framework can record the result.

    Idempotent — running twice in a row is harmless; the same drift
    signals get computed and logged.
    """
    db: Session = SessionLocal()
    summary = {
        "ran_at": datetime.utcnow().isoformat(),
        "systems_checked": 0,
        "drifts_detected": 0,
        "alerts": [],
    }
    try:
        for pos in KNOWN_POS_SYSTEMS:
            summary["systems_checked"] += 1
            try:
                signal = compute_drift_signal(db, pos)
            except Exception as e:  # noqa: BLE001
                logger.warning("daily_drift_sweep: %s failed: %s", pos, e)
                continue
            if signal:
                summary["drifts_detected"] += 1
                summary["alerts"].append(signal)
                logger.warning(
                    "DRIFT %s: %s (baseline=%.3f, recent=%.3f, drop=%.3f)",
                    pos, signal["alert"], signal["baseline_confidence"],
                    signal["recent_confidence"], signal["drop"],
                )
    except Exception as e:  # noqa: BLE001
        logger.exception("daily_drift_sweep: catastrophic failure: %s", e)
    finally:
        db.close()
    logger.info(
        "daily_drift_sweep: checked %d systems, %d drifts",
        summary["systems_checked"], summary["drifts_detected"],
    )
    return summary


def weekly_pattern_sweep(*, lookback_days: int = 30) -> dict:
    """For every user who scanned at least one kasserapport in the last
    `lookback_days`, run correction-pattern detection per POS system.
    Returns summary dict.

    The detected patterns aren't persisted yet (separate model coming);
    for v1 they're logged so the founder can review during weekly admin
    triage. Promotion to a OwnerPattern row comes when the admin signs
    off — humans-in-the-loop until we trust the auto-detection.
    """
    db: Session = SessionLocal()
    summary = {
        "ran_at": datetime.utcnow().isoformat(),
        "users_swept": 0,
        "patterns_found": 0,
        "patterns": [],
    }
    cutoff = datetime.utcnow() - timedelta(days=lookback_days)
    try:
        # Find users who scanned at least once in the lookback window
        active_user_ids = (
            db.query(KasserapportExtraction.user_id)
            .filter(KasserapportExtraction.created_at >= cutoff)
            .distinct()
            .all()
        )
        active_user_ids = [r[0] for r in active_user_ids if r[0]]

        for uid in active_user_ids:
            summary["users_swept"] += 1
            # Find which POS systems this user has scanned
            user_pos_systems = (
                db.query(KasserapportExtraction.pos_system)
                .filter(
                    KasserapportExtraction.user_id == uid,
                    KasserapportExtraction.created_at >= cutoff,
                    KasserapportExtraction.pos_system.notin_(("unknown", None)),
                )
                .distinct()
                .all()
            )
            for (pos,) in user_pos_systems:
                if not pos:
                    continue
                try:
                    patterns = detect_correction_patterns(
                        db, uid, pos, lookback_days=lookback_days
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning(
                        "weekly_pattern_sweep: user=%s pos=%s failed: %s",
                        uid, pos, e,
                    )
                    continue
                if patterns:
                    summary["patterns_found"] += len(patterns)
                    for p in patterns:
                        summary["patterns"].append({
                            "user_id": str(uid),
                            "pos_system": pos,
                            **p,
                        })
                        logger.info(
                            "PATTERN user=%s pos=%s field=%s direction=%s count=%d",
                            uid, pos, p.get("field_path"),
                            p.get("direction"), p.get("count"),
                        )
    except Exception as e:  # noqa: BLE001
        logger.exception("weekly_pattern_sweep: catastrophic failure: %s", e)
    finally:
        db.close()
    logger.info(
        "weekly_pattern_sweep: %d users, %d patterns",
        summary["users_swept"], summary["patterns_found"],
    )
    return summary
