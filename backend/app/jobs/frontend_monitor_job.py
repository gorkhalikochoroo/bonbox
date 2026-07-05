"""
frontend_monitor_job — automatic synthetic monitor for the live frontend.

Runs on the BackgroundScheduler every ~5 min. Probes https://www.bonbox.dk
(check_prod_frontend) and, on a broken/stale Vercel deploy, alerts the operator
ONCE per incident (push + email) + records it — so the stale-chunk outage that
dead-ends users at the ErrorBoundary pages a human instead of waiting for a
support ticket. This is the "auto" in auto-diagnosis: nobody runs a command.

Guards:
  • FLAP TOLERANCE — only DECLARE broken after N_FAIL_TO_BREAK consecutive
    fails (the /reservations outage was a single transient edge skew; one blip
    must not alarm). Counters live in the DB row, not process memory, so a dyno
    restart mid-incident doesn't reset the streak.
  • ALERT ONCE — the alert fires exactly on the HEALTHY→BROKEN transition; while
    BROKEN, further failing ticks just increment the streak (anti-spam).
  • RECOVERED note — fires exactly on BROKEN→HEALTHY, after N_OK_TO_RECOVER
    green ticks (anti-flap on the way back).

Read-only + fail-soft: only GETs public URLs + writes its own status rows;
never redeploys, never touches money/MOMS. Any exception is swallowed with a
warning — it can never crash the web process (BonBox tells, a human acts).
"""
import os
import re

from sqlalchemy import func

from app.database import SessionLocal
from app.config import settings
from app.utils.time import utc_now
from app.models.monitor_state import MonitorState
from app.models.error_log import ErrorLog
from app.models.user import User
from app.models.push_subscription import PushSubscription
from app.services.prod_healthcheck import check_prod_frontend
from app.services.email_service import send_email
from app.services.push_sender import send_to_subscription

_SERVICE = "frontend_prod"
N_FAIL_TO_BREAK = 3   # 3 × 5-min ≈ 10-15 min sustained before we wake a human
N_OK_TO_RECOVER = 2   # 2 green ticks before calling it recovered

_STATUS_URL = "https://api.bonbox.dk/api/admin/prod-health"


def run_frontend_monitor_tick() -> dict:
    """One monitor tick. Never raises."""
    db = SessionLocal()
    try:
        st = _load_or_create(db)
        base = os.environ.get("HEALTHCHECK_BASE", "https://www.bonbox.dk")
        result = check_prod_frontend(base)
        st.last_check_at = utc_now()
        st.last_summary = (result.summary or "")[:2000]

        if result.healthy:
            st.fail_streak = 0
            st.consecutive_ok = (st.consecutive_ok or 0) + 1
            # RECOVERED edge: was BROKEN, now clean for N_OK_TO_RECOVER ticks
            if st.state == "BROKEN" and st.consecutive_ok >= N_OK_TO_RECOVER:
                st.state = "HEALTHY"
                _send_recovered(db, st)
                st.broken_since = None
                st.incident_entry = None
                st.incident_chunk = None
                st.last_alert_at = None       # reset so the NEXT incident can alert
        else:
            st.consecutive_ok = 0
            st.fail_streak = (st.fail_streak or 0) + 1
            # DECLARE broken only after N consecutive fails (flap tolerance)
            if st.fail_streak >= N_FAIL_TO_BREAK and st.state != "BROKEN":
                st.state = "BROKEN"
                st.broken_since = utc_now()
                st.incident_entry = result.entry
                st.incident_chunk = _first_chunk(result.errors)
                _write_incident(db, st, result)
                _send_alert(db, st, result)
                st.last_alert_at = utc_now()
            # else: still-broken (already alerted) or streak < N → NO alert

        db.commit()
        return {"state": st.state, "fail_streak": st.fail_streak, "healthy": result.healthy}
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        print(f"frontend_monitor warning: {e}")
        return {"error": str(e)}
    finally:
        db.close()


# ── state ────────────────────────────────────────────────────────────
def _load_or_create(db) -> MonitorState:
    st = db.query(MonitorState).filter(MonitorState.service == _SERVICE).first()
    if not st:
        st = MonitorState(service=_SERVICE, state="HEALTHY", fail_streak=0, consecutive_ok=0)
        db.add(st)
        db.flush()
    return st


def _first_chunk(errors) -> str | None:
    for e in errors or []:
        m = re.search(r"([A-Za-z0-9_$-]+-[A-Za-z0-9_$-]{8}\.js)", str(e))
        if m:
            return m.group(1)
    return None


def _write_incident(db, st: MonitorState, result) -> None:
    """One ErrorLog row per incident → shows in the existing /admin/recent-errors
    panel (method=MONITOR) for free."""
    try:
        db.add(ErrorLog(
            method="MONITOR",
            path="/health/monitor/frontend",
            status_code=0,
            error_type="monitor:frontend_broken",
            message=(result.summary or "")[:2000],
        ))
    except Exception as e:
        print(f"frontend_monitor incident-log failed: {e}")


# ── alerting (fail-soft) ───────────────────────────────────────────────
def _operator_emails() -> list[str]:
    out, seen = [], set()
    raw = (settings.SUPER_ADMIN_EMAILS or "")
    for e in raw.split(","):
        e = e.strip().lower()
        if e and e not in seen:
            seen.add(e)
            out.append(e)
    admin = (settings.ADMIN_EMAIL or "").strip().lower()
    if admin and admin not in seen:
        seen.add(admin)
        out.append(admin)
    return out


def _esc(s: str) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _send_alert(db, st: MonitorState, result) -> None:
    when = st.broken_since.strftime("%Y-%m-%d %H:%M") if st.broken_since else "?"
    lines = [
        f"BonBox detected a broken/stale FRONTEND deploy at {when} UTC.",
        f"entry = {st.incident_entry or '?'}",
        f"first failure = {st.incident_chunk or '(see summary)'}",
        f"summary: {result.summary}",
        "",
        "This is the stale-Vercel-deploy class — the served index references a",
        "chunk hash it no longer builds, so lazy routes fail to load.",
        "Fix: redeploy the frontend on Vercel (clear build cache) + hard-refresh.",
        f"Status: {_STATUS_URL}",
    ]
    html = "<br>".join(_esc(x) for x in lines)
    for to in _operator_emails():
        try:
            send_email(to, "🔴 PROD FRONTEND BROKEN — bonbox.dk", html)
        except Exception as e:
            print(f"frontend_monitor alert email failed ({to}): {e}")
    _push_operators(db, "BonBox: prod frontend BROKEN",
                    (result.summary or "Stale Vercel deploy detected")[:180])


def _send_recovered(db, st: MonitorState) -> None:
    dur = ""
    if st.broken_since:
        mins = int((utc_now() - st.broken_since).total_seconds() // 60)
        dur = f" (down ~{mins} min)"
    lines = [
        f"BonBox: the prod frontend RECOVERED{dur}.",
        f"summary: {st.last_summary}",
        f"Status: {_STATUS_URL}",
    ]
    html = "<br>".join(_esc(x) for x in lines)
    for to in _operator_emails():
        try:
            send_email(to, "🟢 PROD FRONTEND RECOVERED — bonbox.dk", html)
        except Exception as e:
            print(f"frontend_monitor recovered email failed ({to}): {e}")
    _push_operators(db, "BonBox: prod frontend recovered", f"Back to healthy{dur}.")


def _push_operators(db, title: str, body: str) -> None:
    """Best-effort native push to the operator's devices. No-op if push isn't
    configured; the email is the reliable channel."""
    try:
        emails = _operator_emails()
        if not emails:
            return
        admins = db.query(User).filter(func.lower(User.email).in_(emails)).all()
        ids = [a.id for a in admins]
        if not ids:
            return
        subs = db.query(PushSubscription).filter(PushSubscription.user_id.in_(ids)).all()
        for sub in subs:
            try:
                send_to_subscription(sub, {"title": title, "body": body, "url": "/admin"})
            except Exception:
                pass  # per-device failure never blocks the batch
    except Exception as e:
        print(f"frontend_monitor push failed: {e}")
