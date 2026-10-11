"""ops_triage_job — in-process ops triage + operator alerts, every 15 min (R-i).

Closes OPS-04: error_logs rows (uncaught 500s, raised 5xx HTTPExceptions, JOB
errors/misses, WEBHOOK failures) used to wait for someone to open /admin or
POST /api/admin/run-triage by hand — nothing ran it, so nobody was told.

One tick:
  1. production only (dev, CI and tests: skipped, nothing written);
  2. watermark = monitor_state row "ops_triage": the window is
     [last_check_at, now - 30 s), at most 24 h back (the 30 s lag absorbs
     in-flight commits; the first tick looks back 24 h);
  3. run_triage(..., send_emails=False, use_llm=False, keep_sample_message=False)
     — deterministic notes, no LLM call, no error text leaves the server, and
     no copy of the error message is stored on the note;
  4. every note of the last 24 h that has not reached the operator yet
     (email_sent False: this tick's new notes, plus any whose digest was
     FAILED or CAPPED, or whose tick failed after the notes were written)
     -> ONE digest through ops_alert.send_ops_alert (which owns dedupe,
     cooldown, the daily cap and the PII guard). Only a SENT digest marks its
     notes email_sent=True; anything else leaves them for the next tick, so a
     Resend outage or a capped day delays a group instead of losing it. The
     daily cap bounds the retries; after 24 h a note is no longer re-offered
     (TriageNote's own 24 h cooldown then lets a recurring group open a new
     note);
  5. standing check: storage durability (alert at most once per 24 h);
  6. advance the watermark — never past a Billing:* row that run_triage
     left without a note (res.unnoted_billing_since).

A failing tick alerts directly ("job_error:ops_triage") and does NOT advance
the watermark, so the next tick re-scans (the note cooldown prevents duplicate
notes). Never raises. Digest lines carry severity, error type, route template,
count and fingerprint only — never messages, tracebacks, IPs or user data.
"""
from __future__ import annotations

import logging
import sys
from datetime import timedelta

from app.config import settings
from app.services import ops_alert
from app.utils.time import utc_now

log = logging.getLogger("bonbox.ops_triage")

_SERVICE = "ops_triage"
_LAG = timedelta(seconds=30)
_LOOKBACK = timedelta(hours=24)
_MAX_DIGEST_LINES = 10
# A note not yet delivered is re-offered for this long after it was written.
_RETRY_WINDOW = timedelta(hours=24)
# Bound on the notes one digest carries (run_triage writes at most 20 a tick).
_MAX_DIGEST_NOTES = 200


def run_ops_triage_tick() -> dict:
    """One triage tick. Never raises. Summary keys never end in "_error"
    (the job listener would record those as failed steps)."""
    if settings.ENVIRONMENT != "production":
        return {"skipped": "non_production"}

    db = None
    try:
        import app.database as _database

        db = _database.SessionLocal()
        st = _load_or_create(db)
        upper = utc_now() - _LAG
        since = st.last_check_at or (upper - _LOOKBACK)
        since = max(since, upper - _LOOKBACK)

        from app.services.triage_service import run_triage

        res = run_triage(db, since=since, until=upper, send_emails=False, use_llm=False,
                         keep_sample_message=False)
        new_count = len(res.new_notes or [])
        notes = _undelivered_notes(db, upper)
        digest = None
        if notes:
            digest = ops_alert.send_ops_alert(
                "triage:" + ",".join(sorted({n.fingerprint for n in notes})),
                f"{len(notes)} new error group(s) on prod",
                _digest_lines(res, notes),
            )
            if digest is ops_alert.AlertOutcome.SENT:
                # Only a delivered digest closes its groups. FAILED, CAPPED,
                # COOLDOWN, DISABLED and NO_RECIPIENT leave them for the next tick.
                for n in notes:
                    n.email_sent = True
                db.commit()

        storage = _storage_standing_check()

        # Never past a Billing:* row that got no note this tick.
        hold = getattr(res, "unnoted_billing_since", None)
        st.last_check_at = min(upper, hold) if hold is not None else upper
        st.last_summary = (
            f"rows={res.error_count} new={new_count} skipped={res.skipped_count} "
            f"digest={digest.value if digest is not None else '-'}"
        )
        db.commit()
        return {
            "rows": res.error_count,
            "new_notes": new_count,
            "skipped": res.skipped_count,
            "digest_groups": len(notes),
            "digest": digest.value if digest is not None else None,
            "storage": storage,
        }
    except Exception as e:  # noqa: BLE001 — a monitor must never crash the process
        log.warning("ops triage tick failed: %s", type(e).__name__)
        if db is not None:
            try:
                db.rollback()
            except Exception:  # noqa: BLE001
                pass
        ops_alert.send_ops_alert(
            "job_error:ops_triage", "Ops triage tick failed",
            [f"error_type: {type(e).__name__}"],
        )
        return {"ops_triage_failed": True}
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:  # noqa: BLE001
                pass


def _undelivered_notes(db, now) -> list:
    """Notes of the last 24 h that no digest has delivered yet, oldest first.
    Includes notes written by a manual /admin/run-triage whose own e-mail
    did not go out."""
    from app.models.triage_note import TriageNote

    return (
        db.query(TriageNote)
        .filter(
            TriageNote.email_sent.is_(False),
            TriageNote.created_at >= now - _RETRY_WINDOW,
        )
        .order_by(TriageNote.created_at.asc(), TriageNote.fingerprint.asc())
        .limit(_MAX_DIGEST_NOTES)
        .all()
    )


def _load_or_create(db):
    from app.models.monitor_state import MonitorState

    st = db.query(MonitorState).filter(MonitorState.service == _SERVICE).first()
    if st is None:
        st = MonitorState(service=_SERVICE, state="OK", fail_streak=0, consecutive_ok=0)
        db.add(st)
        db.commit()
    return st


def _route_template(path: str | None) -> str:
    """The route template a stored path was served by ("/api/x/{slug}"), so a
    digest names routes, never a venue slug or other path value. Falls back
    to triage's normalized path for non-HTTP rows ("job:<id>") or when the
    live app is not loaded."""
    if not path or not path.startswith("/"):
        return path or "-"
    try:
        main = sys.modules.get("app.main")
        app = getattr(main, "app", None)
        if app is None:
            return path
        from starlette.routing import Match

        scope = {"type": "http", "path": path, "root_path": "", "method": "GET"}
        for route in app.router.routes:
            try:
                match, _ = route.matches(scope)
            except Exception:  # noqa: BLE001
                continue
            if match != Match.NONE:
                return getattr(route, "path", None) or path
    except Exception:  # noqa: BLE001
        pass
    return path


def _digest_lines(res, notes) -> list[str]:
    lines = [f"error rows in window: {res.error_count}"]
    for n in notes[:_MAX_DIGEST_LINES]:
        sev = (n.severity or "low").upper()
        route = _route_template(n.path_template)
        lines.append(
            f"{sev} | {n.error_type} | {route or '-'} | {n.occurrence_count}x | fp {n.fingerprint}"
        )
    if len(notes) > _MAX_DIGEST_LINES:
        lines.append(f"+{len(notes) - _MAX_DIGEST_LINES} more in /admin")
    return lines


def _storage_standing_check() -> str:
    """Production storage must be durable; if not, uploads are refused
    (fail-closed, services/storage.py) and the operator hears once a day."""
    try:
        from app.services.storage import get_storage

        if get_storage().is_durable:
            return "durable"
        out = ops_alert.send_ops_alert(
            "storage:not_durable",
            "File storage is NOT durable in production",
            [
                "uploads are refused (fail-closed)",
                "check Render env names SUPABASE_URL / SUPABASE_SERVICE_KEY",
                "probe: /api/health/storage",
            ],
            cooldown_minutes=1440,
        )
        return f"not_durable:{getattr(out, 'value', out)}"
    except Exception as e:  # noqa: BLE001
        log.warning("ops triage storage check failed: %s", type(e).__name__)
        return "check_failed"
