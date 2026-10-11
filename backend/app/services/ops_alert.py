"""Operator ops alerts — ONE capped, deduplicated, customer-data-free path (R-i).

Every server-side failure becomes an error_logs row (uncaught 500, raised
HTTPException >= 500, scheduled-job error/miss, Stripe webhook failure). The
15-minute ops triage job (jobs/ops_triage_job.py) groups the new rows and sends
ONE digest through ``send_ops_alert``. Only two other callers use this sender
directly: the triage tick's standing checks (storage durability, the tick's
own failure) and the super-admin test endpoint.

This sender owns every anti-spam rule, so no caller can bypass them:

  • GATE      — production + OPS_ALERTS_ENABLED only. Anywhere else nothing
                is sent and nothing is written (DISABLED, one warning).
  • DEDUPE    — per caller dedupe key; fingerprint = sha256(key)[:16], state
                row monitor_state.service = "alert:<fp>" (no new table).
  • COOLDOWN  — per key, OPS_ALERT_COOLDOWN_MINUTES (default 360, clamped
                15–10080) or the caller's override. Inside it: COOLDOWN and
                the row counts the suppressed alert.
  • DAILY CAP — OPS_ALERT_DAILY_CAP messages per UTC day (default 10, clamped
                1–50), held in row "alert:day". The slot is reserved BEFORE
                sending, so a crash mid-send can never exceed the cap.
  • PII GUARD — every caller string goes through ``safe_fact`` (secrets,
                cards, e-mails, IPs, UUIDs, CPR, DK phones stripped; 160
                chars) and is HTML-escaped. Callers may only pass error types,
                route templates, methods, counts, job ids, Stripe event TYPES,
                fingerprints and severities — never ErrorLog.message,
                tracebacks, IPs, user agents, LLM text, names, e-mails, phones,
                allergy notes, secrets, tokens, Stripe event ids or UUIDs.
  • NEVER RAISES — any internal error returns FAILED with a warning.

Outcomes are three-way-plus (AlertOutcome), never a bool: "couldn't send" must
not read as "nothing to send". FAILED keeps the cap slot consumed but sets no
cooldown, so the next call with the same key retries; the daily cap bounds
those retries. (The triage digest re-offers undelivered groups itself, see
jobs/ops_triage_job.py.)

Push is the second channel. It goes out after a SENT e-mail, and — as the
backup when every e-mail failed — once per key per failure streak (row state
EMAIL_FAILED), so a mail outage never turns into a push every tick. Push runs
AFTER the state is committed and the process lock is released, in its own
session: a push endpoint that never answers can hold only its own caller,
never every other alert (push_sender also passes a timeout to webpush).

Existing monitors (frontend_monitor_job, public_surface_monitor_job) keep
their own once-per-incident alerts and do not count towards this cap.
"""
from __future__ import annotations

import hashlib
import html as _html
import logging
import os
import re
import threading
from datetime import timedelta
from enum import Enum

from app.config import settings
from app.utils.time import utc_now

log = logging.getLogger("bonbox.ops_alert")


class AlertOutcome(str, Enum):
    SENT = "sent"
    COOLDOWN = "cooldown"
    CAPPED = "capped"
    DISABLED = "disabled"
    NO_RECIPIENT = "no_recipient"
    FAILED = "failed"


# One uvicorn worker: a process lock serialises check → reserve → send → record.
_LOCK = threading.Lock()
_WARNED: set[str] = set()

_DAY_SERVICE = "alert:day"
# Row state while every e-mail for this key has failed and the backup push
# for this streak has been tried. A SENT e-mail sets "ALERT".
_EMAIL_FAILED = "EMAIL_FAILED"
_SUBJECT_PREFIX = "[BonBox ops] "
_FACT_MAX = 160


def alerts_enabled() -> bool:
    return settings.ENVIRONMENT == "production" and bool(settings.OPS_ALERTS_ENABLED)


def _warn_once(key: str, msg: str) -> None:
    if key in _WARNED:
        return
    _WARNED.add(key)
    log.warning(msg)


def alert_fingerprint(dedupe_key: str) -> str:
    return hashlib.sha256((dedupe_key or "").encode("utf-8", errors="ignore")).hexdigest()[:16]


def alert_service(dedupe_key: str) -> str:
    """monitor_state.service for a dedupe key — 22 chars, column is 50."""
    return "alert:" + alert_fingerprint(dedupe_key)


# ─── PII guard ──────────────────────────────────────────────────────────

_PHONE = re.compile(r"(?:\+45\s?)?\b\d{2}\s?\d{2}\s?\d{2}\s?\d{2}\b")
# Stricter than triage_service.sanitize (which needs 20+ chars after
# "Bearer"): any bearer value, and any key=value / key: value secret.
_BEARER_ANY = re.compile(r"(?i)\bBearer\s+\S+")
_SECRET_KV = re.compile(
    r"(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie)\b\s*[:=]\s*\S+"
)


def safe_fact(value) -> str:
    """One caller-supplied fact, made safe for an operator alert."""
    from app.services.triage_service import sanitize

    s = sanitize("" if value is None else str(value), _FACT_MAX)
    s = _BEARER_ANY.sub("Bearer <redacted>", s)
    s = _SECRET_KV.sub(lambda m: f"{m.group(1)}=<redacted>", s)
    s = _PHONE.sub("<phone>", s)
    s = " ".join(s.split())
    return s[:_FACT_MAX]


def _safe_subject(subject: str) -> str:
    # Plain-text header: no angle brackets or quotes, no emoji, ≤150 chars.
    s = re.sub(r"[<>\"]", "", safe_fact(subject))
    s = "".join(ch for ch in s if ord(ch) < 0x2000)
    return (_SUBJECT_PREFIX + s)[:150]


# ─── config clamps ──────────────────────────────────────────────────────

def _clamp(value, default: int, lo: int, hi: int) -> int:
    try:
        v = int(value)
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


def _cooldown(override: int | None) -> timedelta:
    raw = override if override is not None else settings.OPS_ALERT_COOLDOWN_MINUTES
    return timedelta(minutes=_clamp(raw, 360, 15, 10080))


def daily_cap() -> int:
    return _clamp(settings.OPS_ALERT_DAILY_CAP, 10, 1, 50)


# ─── channels (looked up at call time so tests can stub them) ───────────

def _recipients() -> list[str]:
    from app.jobs.frontend_monitor_job import _operator_emails
    return _operator_emails()


def _send_email(to: str, subject: str, html: str) -> bool:
    import app.services.email_service as _email_service
    return bool(_email_service.send_email(to, subject, html))


def _push(db, title: str, body: str) -> None:
    import app.jobs.frontend_monitor_job as _fmj
    _fmj._push_operators(db, title, body)


# ─── state rows ─────────────────────────────────────────────────────────

def _load_or_create(db, service: str):
    from sqlalchemy.exc import IntegrityError
    from app.models.monitor_state import MonitorState

    row = db.query(MonitorState).filter(MonitorState.service == service).first()
    if row is not None:
        return row
    row = MonitorState(service=service, state="OK", fail_streak=0, consecutive_ok=0)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        row = db.query(MonitorState).filter(MonitorState.service == service).first()
        if row is None:
            raise
    return row


def _header(now) -> list[str]:
    commit = (os.getenv("RENDER_GIT_COMMIT") or os.getenv("GIT_COMMIT") or "dev").strip()[:8] or "dev"
    return [
        f"time: {now:%Y-%m-%d %H:%M} UTC",
        f"environment: {settings.ENVIRONMENT}",
        f"commit: {commit}",
        "",
    ]


def _footer(suppressed: int, used: int, cap: int) -> list[str]:
    out = [
        "",
        f"suppressed since last alert: {suppressed}",
        f"alerts today {used}/{cap}",
    ]
    if used >= cap:
        out.append(
            "daily cap reached: no more alerts until 00:00 UTC; error groups not yet "
            "sent are retried for 24 h after they first appear, see /admin"
        )
    out += [
        f"{(settings.FRONTEND_URL or '').rstrip('/')}/admin",
        "Ops alerts never contain customer data; details in /admin (super-admin)",
    ]
    return out


# ─── the sender ─────────────────────────────────────────────────────────

def send_ops_alert(
    dedupe_key: str,
    subject: str,
    lines: list[str],
    *,
    cooldown_minutes: int | None = None,
) -> AlertOutcome:
    """Send one operator alert, subject to gate, dedupe, cooldown, daily cap
    and the PII guard. Never raises."""
    try:
        if not alerts_enabled():
            _warn_once(
                "disabled",
                "ops alerts disabled (non-production or OPS_ALERTS_ENABLED=false): nothing sent",
            )
            return AlertOutcome.DISABLED

        recipients = _recipients()
        if not recipients:
            _warn_once("no_recipient", "ops alert not sent: set ADMIN_EMAIL or SUPER_ADMIN_EMAILS")
            return AlertOutcome.NO_RECIPIENT

        import app.database as _database

        with _LOCK:
            db = _database.SessionLocal()
            try:
                outcome, push = _send_locked(db, dedupe_key, subject, list(lines or []),
                                             recipients, _cooldown(cooldown_minutes))
            finally:
                db.close()
        # The outcome is committed and the lock released: a push that hangs
        # can no longer stop every other alert.
        if push is not None:
            _push_best_effort(_database, *push)
        return outcome
    except Exception as e:  # noqa: BLE001 — an alert must never break its caller
        log.warning("ops alert failed internally: %s", type(e).__name__)
        return AlertOutcome.FAILED


def _push_best_effort(database_module, title: str, body: str) -> None:
    db = None
    try:
        db = database_module.SessionLocal()
        _push(db, title, body)
    except Exception:  # noqa: BLE001 — push is best effort; e-mail is the channel
        pass
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:  # noqa: BLE001
                pass


def _send_locked(db, dedupe_key, subject, lines, recipients, cooldown):
    """Returns (outcome, push) where push is (title, body) to send after the
    lock is released, or None."""
    now = utc_now()
    row = _load_or_create(db, alert_service(dedupe_key))

    if row.last_alert_at and now - row.last_alert_at < cooldown:
        row.fail_streak = (row.fail_streak or 0) + 1
        row.last_check_at = now
        db.commit()
        return AlertOutcome.COOLDOWN, None

    day = _load_or_create(db, _DAY_SERVICE)
    today = now.strftime("%Y-%m-%d")
    if day.incident_entry != today:
        day.incident_entry = today
        day.fail_streak = 0
    cap = daily_cap()
    if (day.fail_streak or 0) >= cap:
        row.fail_streak = (row.fail_streak or 0) + 1
        row.last_check_at = now
        db.commit()
        _warn_once(f"capped:{today}", f"ops alert daily cap ({cap}) reached for {today}; no more alerts until 00:00 UTC")
        return AlertOutcome.CAPPED, None

    # Reserve the slot BEFORE sending: a crash mid-send cannot exceed the cap.
    day.fail_streak = (day.fail_streak or 0) + 1
    day.last_check_at = now
    db.commit()
    used = day.fail_streak

    subj = _safe_subject(subject)
    body = (
        _header(now)
        + [safe_fact(x) for x in lines]
        + _footer(suppressed=row.fail_streak or 0, used=used, cap=cap)
    )
    html = "<br>".join(_html.escape(x) for x in body)

    ok = False
    for to in recipients:  # every recipient, not any() — that would stop at the first
        try:
            if _send_email(to, subj, html):
                ok = True
        except Exception:  # noqa: BLE001 — one bad address never blocks the rest
            pass

    push = (subj[:60], (safe_fact(lines[0]) if lines else "")[:120])
    if ok:
        row.last_alert_at = now
        row.fail_streak = 0
        row.state = "ALERT"
        row.last_summary = safe_fact(subject)[:200]
        row.last_check_at = now
        # Recorded first, so a push hiccup can never undo the cooldown.
        db.commit()
        return AlertOutcome.SENT, push

    # Every e-mail failed: push is the backup channel, once per failure streak.
    first_failure = row.state != _EMAIL_FAILED
    row.state = _EMAIL_FAILED
    row.last_check_at = now
    db.commit()
    _warn_once("send_false", "ops alert: send_email returned False — check RESEND_API_KEY")
    return AlertOutcome.FAILED, (push if first_failure else None)
