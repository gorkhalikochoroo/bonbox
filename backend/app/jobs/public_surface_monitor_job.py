"""
public_surface_monitor_job — the AUTO in auto-diagnosis for public booking pages.

Runs on the BackgroundScheduler every ~15 min. For each live booking slug it runs
public_surface_check (no HTTP, no headless browser — same DB the diner's API
reads) and flags SILENT quality defects: a page dead for 14 days, an app-default
title, or a structurally un-bookable venue. Sibling of frontend_monitor_job;
reuses its operator-alert helpers.

Guards (same family doctrine):
  • Only scans slugs a diner could actually reach — mirrors _resolve_owner's gate
    (reservation_slug set + reservations_enabled + has_feature) — so a
    downgraded-tier page (which 410s) is never scanned and never alarms.
  • FLAP TOLERANCE — 2 consecutive unhealthy ticks (≈30 min) before DEGRADED, 2
    green before recovery. A single transient miss / midnight-rollover never flips.
  • ALERT is intrusive (email + push) ONLY for `urgent` (dead_on_arrival). `warn`
    signals (stale_meta, no_bookable_resources) surface in the admin panel + the
    recent-errors feed but never nag — respects the anti-spam doctrine.
  • Fail-soft: any exception → rollback + warn + return; never crashes the dyno.
"""
from datetime import datetime
from zoneinfo import ZoneInfo

from app.database import SessionLocal
from app.models.surface_finding import SurfaceFinding
from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.models.error_log import ErrorLog
from app.services.billing import has_feature
from app.services.public_surface_check import check_slug
from app.services.email_service import send_email
from app.jobs.frontend_monitor_job import _operator_emails, _push_operators, _esc

_TZ = ZoneInfo("Europe/Copenhagen")
_MAX_SLUGS_PER_TICK = 200
_N_FAIL_TO_DEGRADE = 2
_N_OK_TO_RECOVER = 2
_STATUS_URL = "https://api.bonbox.dk/api/admin/public-surface-health"


def _now_local() -> datetime:
    return datetime.now(_TZ)


def run_public_surface_monitor_tick() -> dict:
    db = SessionLocal()
    try:
        now = _now_local()
        profiles = (
            db.query(BusinessProfile)
            .filter(
                BusinessProfile.reservation_slug.isnot(None),
                BusinessProfile.reservation_slug != "",
                BusinessProfile.reservations_enabled.is_(True),
            )
            .limit(_MAX_SLUGS_PER_TICK)
            .all()
        )
        scanned = 0
        degraded = 0
        for prof in profiles:
            owner = db.query(User).filter(User.id == prof.user_id).first()
            if owner is None or not has_feature(owner, "reservations"):
                continue  # 410 to a diner → never scan, never alarm
            scanned += 1
            try:
                res = check_slug(db, profile=prof, owner=owner, now=now)
            except Exception as e:  # a bad slug never sinks the scan
                print(f"public_surface_check {prof.reservation_slug} error: {e}")
                continue
            _apply(db, prof, res, now)
            if not res["healthy"]:
                degraded += 1
        db.commit()
        return {"scanned": scanned, "degraded": degraded}
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        print(f"public_surface_monitor warning: {e}")
        return {"error": str(e)}
    finally:
        db.close()


def _apply(db, prof, res, now) -> None:
    """Flap-tolerant per-slug state machine + alert-once on OK→DEGRADED."""
    slug = prof.reservation_slug
    sf = db.query(SurfaceFinding).filter(SurfaceFinding.slug == slug).first()
    if not sf:
        sf = SurfaceFinding(slug=slug, user_id=prof.user_id, state="OK",
                            fail_streak=0, consecutive_ok=0)
        db.add(sf)
        db.flush()
    sf.user_id = prof.user_id
    sf.last_scanned_at = now
    sf.last_summary = (res["summary"] or "")[:500]
    sf.codes = res["codes"]
    sf.detail = res["detail"]
    sf.severity = res["severity"]

    if res["healthy"]:
        sf.fail_streak = 0
        sf.consecutive_ok = (sf.consecutive_ok or 0) + 1
        if sf.state == "DEGRADED" and sf.consecutive_ok >= _N_OK_TO_RECOVER:
            sf.state = "OK"
            sf.degraded_since = None
    else:
        sf.consecutive_ok = 0
        sf.fail_streak = (sf.fail_streak or 0) + 1
        if sf.fail_streak >= _N_FAIL_TO_DEGRADE and sf.state != "DEGRADED":
            sf.state = "DEGRADED"
            sf.degraded_since = now
            _write_incident(db, sf, res)
            # Intrusive alert ONLY for a genuinely dead page — never for a
            # demo's missing name (that just shows in the panel).
            if res["severity"] == "urgent":
                _alert_operator(db, prof, sf, res)


def _write_incident(db, sf, res) -> None:
    """One ErrorLog row per incident → shows in /admin/recent-errors for free."""
    try:
        db.add(ErrorLog(
            method="MONITOR",
            path=f"/public/{sf.slug}",
            status_code=0,
            error_type=f"monitor:public_surface_{'dead' if res['severity'] == 'urgent' else 'warn'}",
            message=f"{sf.slug}: {res['summary']}"[:2000],
        ))
    except Exception as e:
        print(f"public_surface incident-log failed: {e}")


def _alert_operator(db, prof, sf, res) -> None:
    when = sf.degraded_since.strftime("%Y-%m-%d %H:%M") if sf.degraded_since else "?"
    lines = [
        f"BonBox: a public booking page has NO free tables for the next 14 days.",
        f"page = bonbox.dk/{sf.slug}",
        f"since = {when} UTC",
        f"detail: {res['summary']}",
        "",
        "Likely a schedule/opening-hours or resource config gap — the owner's",
        "reservation settings. Customers who open the link just bounce.",
        f"Status: {_STATUS_URL}",
    ]
    html = "<br>".join(_esc(x) for x in lines)
    for to in _operator_emails():
        try:
            send_email(to, "🔴 Booking page DEAD — bonbox.dk", html)
        except Exception as e:
            print(f"public_surface alert email failed ({to}): {e}")
    _push_operators(db, "BonBox: a booking page is dead",
                    f"bonbox.dk/{sf.slug} — no free tables for 14 days")
