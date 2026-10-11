"""job_events — scheduled-job failures become error_logs rows (R-i, OPS-10).

APScheduler logged a raising or missed job to a logger nobody reads in prod,
and daily_maintenance swallowed its own step failures (GDPR / accounting
retention / error-log purge) into its return dict. This listener writes one
error_logs row per failure, method="JOB", path="job:<id>", status_code=None,
so the 15-minute ops triage (jobs/ops_triage_job.py) groups them by
fingerprint and alerts the operator (one digest line per group per 24 h).

  EVENT_JOB_ERROR          -> error_type = exception class, message, traceback
  EVENT_JOB_MISSED         -> "JobMissed" (past misfire_grace_time)
  EVENT_JOB_MAX_INSTANCES  -> "JobMaxInstances" (a run skipped: previous still running)
  EVENT_JOB_EXECUTED       -> only for a dict return value: one "JobStep:<key>" row
                              per top-level key ending in "_error" with a truthy value

Module-level imports are apscheduler.events + stdlib only; everything else is
imported lazily so a broken import can never cost the scheduler. The database
session is looked up at call time (app.database.SessionLocal). Never raises.
"""
from __future__ import annotations

import logging

from apscheduler.events import (
    EVENT_JOB_ERROR,
    EVENT_JOB_EXECUTED,
    EVENT_JOB_MAX_INSTANCES,
    EVENT_JOB_MISSED,
)

log = logging.getLogger("bonbox.jobs")

JOB_EVENT_MASK = EVENT_JOB_ERROR | EVENT_JOB_MISSED | EVENT_JOB_MAX_INSTANCES | EVENT_JOB_EXECUTED


def _rows_for(event) -> list[dict]:
    code = getattr(event, "code", 0)
    job_id = getattr(event, "job_id", None) or "?"
    base = {"method": "JOB", "path": f"job:{job_id}"[:500], "status_code": None}

    if code == EVENT_JOB_ERROR:
        exc = getattr(event, "exception", None)
        return [{
            **base,
            "error_type": (type(exc).__name__ if exc is not None else "JobError")[:100],
            "message": str(exc)[:1000],
            "traceback": str(getattr(event, "traceback", None) or "")[:16000],
        }]
    if code == EVENT_JOB_MISSED:
        srt = getattr(event, "scheduled_run_time", None)
        when = srt.isoformat() if srt is not None else "?"
        return [{**base, "error_type": "JobMissed", "message": f"scheduled {when}"}]
    if code == EVENT_JOB_MAX_INSTANCES:
        runs = getattr(event, "scheduled_run_times", None) or []
        return [{**base, "error_type": "JobMaxInstances", "message": f"{len(runs)} run(s) skipped"}]
    if code == EVENT_JOB_EXECUTED:
        retval = getattr(event, "retval", None)
        if not isinstance(retval, dict):
            return []
        return [
            {**base, "error_type": f"JobStep:{key}"[:100], "message": str(val)[:1000]}
            for key, val in retval.items()
            if isinstance(key, str) and key.endswith("_error") and val
        ]
    return []


def on_job_event(event) -> None:
    """APScheduler listener. Never raises."""
    try:
        rows = _rows_for(event)
        if not rows:
            return
        from app.utils.off_loop import pool_exhausted

        if pool_exhausted():
            log.warning("job event rows skipped for %s: DB pool exhausted",
                        getattr(event, "job_id", "?"))
            return
        import app.database as _database
        from app.models.error_log import ErrorLog

        db = _database.SessionLocal()
        try:
            for row in rows:
                db.add(ErrorLog(**row))
            db.commit()
        finally:
            db.close()
    except Exception as e:  # noqa: BLE001 — a listener must never break the scheduler
        log.warning("job event row not written: %s", type(e).__name__)
