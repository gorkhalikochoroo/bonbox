"""
abuse_monitor_job — one alert per incident when an abuse ceiling trips (R-sec).

Runs on the BackgroundScheduler every 2 minutes. The caps themselves act in
the request path (magic-link and guest-mail ceilings, the join/stand cool-off)
and only bump in-process counters (app/utils/abuse_signals.py). This job
drains those counters, adds two DB counts of its own (new accounts per
hour/24 h; links and guest mails for the alert text), and keeps one
MonitorState row per kind:

  abuse_magic_link  sign-in link mails held back (fleet / per-domain ceiling)
  abuse_guest_mail  guest e-mails held back (fleet-wide daily ceiling, or one
                    venue's share of it)
  abuse_staff_join  staff join paused for everyone (global cool-off)
  abuse_stand_join  host-stand pairing paused for everyone (global cool-off)
  abuse_signups     unusual number of new accounts (alert only, nothing blocked)
  abuse_no_edge     requests arriving without the edge address header

Per row: a tripped tick on a HEALTHY row → BROKEN, one ErrorLog row
(/admin/recent-errors, method=MONITOR), and the alert e-mail + push — unless
an alert for this kind went out less than 6 hours ago. 15 quiet ticks (30
min) → HEALTHY, plus one "back to normal" e-mail (no push) if this incident
sent an alert. last_alert_at survives recovery, which keeps the 6-hour gap.

Counts and windows only: no e-mail address, domain, IP or user id ever goes
into a summary, log row, e-mail or push.

Reuses the frontend monitor's operator e-mail list and push fan-out, as the
public-surface monitor does. Fail-soft: never raises, one commit per tick.

Persist, then notify: the state changes (BROKEN, last_alert_at, HEALTHY) are
committed first, and only then do the alert and "back to normal" mails and
pushes go out. If the commit fails nothing is sent and the drained counts
are put back, so the next tick tries again with the same facts. A failure
while sending, after the commit, never re-sends: the incident is saved.
"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import case, func

from app.config import settings
from app.database import SessionLocal
from app.jobs.frontend_monitor_job import _esc, _operator_emails, _push_operators
from app.models.error_log import ErrorLog
from app.models.monitor_state import MonitorState
from app.models.user import User
from app.services.email_service import send_email
from app.utils import abuse_signals
from app.utils.time import utc_now

TICK_MINUTES = 2
N_OK_TO_RECOVER = 15                 # 15 quiet ticks = 30 minutes
ALERT_GAP = timedelta(hours=6)       # at most one alert e-mail per kind per 6 h

SERVICES = (
    "abuse_magic_link",
    "abuse_guest_mail",
    "abuse_staff_join",
    "abuse_stand_join",
    "abuse_signups",
    "abuse_no_edge",
)

_LABELS = {
    "abuse_magic_link": "sign-in link ceiling",
    "abuse_guest_mail": "guest e-mail ceiling",
    "abuse_staff_join": "staff join cool-off",
    "abuse_stand_join": "host-stand pairing cool-off",
    "abuse_signups": "signup burst",
    "abuse_no_edge": "missing edge header",
}


def run_abuse_monitor_tick() -> dict:
    """One monitor tick. Never raises. A failed tick returns
    {"abuse_monitor_error": <exception class>}: the key ends in "_error", so
    R-i's job listener (jobs/job_events.py) writes one JOB row per failed tick
    and the ops triage tells the operator (one digest per 24 h). A plain
    "error" key was invisible to it."""
    sig = abuse_signals.drain()
    db = SessionLocal()
    try:
        try:
            now = utc_now()
            checks = _evaluate(db, sig, now)
            out = {}
            alerts: list[tuple[str, dict]] = []          # sent after the commit
            recovered: list[tuple[str, object, int]] = []
            for service in SERVICES:
                tripped, summary, ctx = checks[service]
                st = _load_or_create(db, service)
                st.last_check_at = now
                st.last_summary = summary[:2000]
                if tripped:
                    st.consecutive_ok = 0
                    st.fail_streak = (st.fail_streak or 0) + 1
                    if st.state != "BROKEN":
                        st.state = "BROKEN"
                        st.broken_since = now
                        _write_incident(db, service, summary)
                        if st.last_alert_at is None or now - st.last_alert_at >= ALERT_GAP:
                            st.last_alert_at = now
                            alerts.append((service, ctx))
                else:
                    st.fail_streak = 0
                    st.consecutive_ok = (st.consecutive_ok or 0) + 1
                    if st.state == "BROKEN" and st.consecutive_ok >= N_OK_TO_RECOVER:
                        if _incident_alerted(st):
                            recovered.append((service, st.broken_since, st.consecutive_ok))
                        st.state = "HEALTHY"
                        st.broken_since = None
                out[service] = st.state
            db.commit()
        except Exception as e:  # noqa: BLE001 — a monitor never takes the app down
            try:
                db.rollback()
            except Exception:  # noqa: BLE001
                pass
            # Nothing was sent (that happens only after a commit), so put the
            # drained counts back for the next tick to see.
            for kind, n in sig.items():
                abuse_signals.bump(kind, n)
            print(f"abuse_monitor warning: {type(e).__name__}")
            return {"abuse_monitor_error": type(e).__name__}

        # Saved: now tell the operators. Each send is fail-soft and never
        # undoes the saved state, so an incident is told at most once.
        for service, ctx in alerts:
            _notify(db, _send_alert, db, service, ctx, now)
        for service, broken_since, consecutive_ok in recovered:
            _notify(db, _send_recovered, service, broken_since, consecutive_ok, now)
        return out
    finally:
        db.close()


def _notify(db, fn, *args) -> None:
    """Run one alert send after the commit. Never raises; resets the session
    afterwards (the push fan-out reads operators and devices, and a failed
    read must not leave an aborted transaction for the next send)."""
    try:
        fn(*args)
    except Exception as e:  # noqa: BLE001
        print(f"abuse_monitor alert failed: {type(e).__name__}")
    try:
        db.rollback()
    except Exception:  # noqa: BLE001
        pass


# ── checks ───────────────────────────────────────────────────────────

def _on(limit) -> bool:
    return isinstance(limit, int) and limit > 0


def _signup_counts(db, now) -> tuple[int, int]:
    """(last hour, last 24 hours) new accounts — every creation path."""
    day, hour = db.query(
        func.count(User.id),
        func.sum(case((User.created_at >= now - timedelta(hours=1), 1), else_=0)),
    ).filter(User.created_at >= now - timedelta(days=1)).one()
    return int(hour or 0), int(day or 0)


def _evaluate(db, sig: dict, now) -> dict:
    from app.services.abuse_caps import magic_link_counts
    from app.services.reservation_emails import guest_emails_sent_fleet_last_24h, venue_mail_share

    g = lambda k: int(sig.get(k, 0) or 0)  # noqa: E731
    when = now.strftime("%Y-%m-%d %H:%M")
    s = settings
    checks = {}

    n_fleet, n_domain = g("magic_link_fleet"), g("magic_link_domain")
    links_h, links_d = magic_link_counts(db)
    checks["abuse_magic_link"] = (
        n_fleet + n_domain > 0,
        f"held_fleet={n_fleet} held_domain={n_domain} links_1h={links_h} links_24h={links_d}",
        dict(when=when, n_fleet=n_fleet, n_domain=n_domain, h=links_h, d=links_d,
             H=s.MAGIC_LINK_FLEET_MAX_PER_HOUR, D=s.MAGIC_LINK_FLEET_MAX_PER_DAY),
    )

    n_guest, n_venue = g("guest_mail_fleet"), g("guest_mail_venue")
    sent24 = guest_emails_sent_fleet_last_24h(db)
    share = venue_mail_share()
    checks["abuse_guest_mail"] = (
        n_guest + n_venue > 0,
        f"held={n_guest} held_venue_share={n_venue} sent_24h={sent24} "
        f"cap={s.GUEST_EMAILS_FLEET_PER_DAY} share={share}",
        dict(when=when, n=n_guest, n_venue=n_venue, sent24=sent24,
             cap=s.GUEST_EMAILS_FLEET_PER_DAY, share=share),
    )

    for service, kind in (("abuse_staff_join", "staff_join"), ("abuse_stand_join", "stand_join")):
        n = g(f"{kind}_cooloff")
        checks[service] = (
            n > 0,
            f"cooloffs={n} max={s.JOIN_FAIL_GLOBAL_MAX} window_s={s.JOIN_FAIL_WINDOW_SEC} "
            f"cool_s={s.JOIN_COOLOFF_SEC}",
            dict(when=when, n=n, max=s.JOIN_FAIL_GLOBAL_MAX,
                 window=f"{s.JOIN_FAIL_WINDOW_SEC / 60:g}", cool=s.JOIN_COOLOFF_SEC),
        )

    signups_h, signups_d = _signup_counts(db, now)
    H, D = s.SIGNUP_ALERT_PER_HOUR, s.SIGNUP_ALERT_PER_DAY
    checks["abuse_signups"] = (
        (_on(H) and signups_h >= H) or (_on(D) and signups_d >= D),
        f"signups_1h={signups_h} signups_24h={signups_d} alert_1h={H} alert_24h={D}",
        dict(when=when, h=signups_h, d=signups_d, H=H, D=D),
    )

    n_no_edge, n_edge = g("no_edge"), g("edge")
    limit = s.NO_EDGE_ALERT_PER_TICK
    checks["abuse_no_edge"] = (
        _on(limit) and n_no_edge >= limit,
        f"edge={n_edge} no_edge={n_no_edge}",
        dict(when=when, n=n_no_edge, e=n_edge),
    )
    return checks


# ── state ────────────────────────────────────────────────────────────

def _load_or_create(db, service: str) -> MonitorState:
    st = db.query(MonitorState).filter(MonitorState.service == service).first()
    if not st:
        st = MonitorState(service=service, state="HEALTHY", fail_streak=0, consecutive_ok=0)
        db.add(st)
        db.flush()
    return st


def _incident_alerted(st: MonitorState) -> bool:
    """Did THIS incident send an alert? (An alert stamps last_alert_at with
    the same instant as broken_since; a suppressed one leaves it older.)"""
    return (st.last_alert_at is not None and st.broken_since is not None
            and st.last_alert_at >= st.broken_since)


def _write_incident(db, service: str, summary: str) -> None:
    db.add(ErrorLog(
        method="MONITOR",
        path="/health/monitor/abuse",
        status_code=0,
        error_type=f"monitor:{service}",
        message=summary[:2000],
    ))


# ── copy (operator alerts; English like the other monitors) ─────────────

def alert_copy(service: str, c: dict) -> tuple[str, list[str], str, str]:
    """(subject, body lines, push title, push body) for one kind. Counts,
    windows and UTC times only."""
    if service == "abuse_magic_link":
        return (
            "BonBox: sign-in link ceiling reached, links held back",
            [
                f"BonBox stopped sending sign-in link e-mails to new addresses at {c['when']} UTC "
                "because a sign-in mail ceiling was reached.",
                f"Held back in the last 2 minutes: {c['n_fleet']} over the fleet-wide ceiling, "
                f"{c['n_domain']} over the per-domain ceiling.",
                f"Links created in the last hour: {c['h']} (ceiling {c['H']}); "
                f"last 24 hours: {c['d']} (ceiling {c['D']}).",
                "Owners whose BonBox account e-mail is confirmed still get their link. New sign-ups by "
                "e-mail link get no mail until the count drops. Password, Google and Apple sign-in "
                "are not affected.",
                "If this is real traffic, raise MAGIC_LINK_FLEET_MAX_PER_HOUR / "
                "MAGIC_LINK_FLEET_MAX_PER_DAY in Render.",
                "You get one e-mail per incident.",
            ],
            "BonBox: sign-in links held back",
            "Sign-in mail ceiling reached. Existing owners still get links. Details by e-mail.",
        )
    if service == "abuse_guest_mail":
        n_venue = int(c.get("n_venue") or 0)
        if not int(c.get("n") or 0) and n_venue:
            # Only one venue's share was used up — every other venue still
            # mails its guests.
            return (
                "BonBox: one venue used its share of guest e-mails",
                [
                    f"At {c['when']} UTC a venue had sent its share of guest confirmation e-mails "
                    f"for the last 24 hours ({c['share']} of the fleet's {c['cap']}), so BonBox "
                    "held the next ones back for that venue only.",
                    f"Held back in the last 2 minutes: {n_venue}. Guest e-mails sent by all venues "
                    f"in the last 24 hours: {c['sent24']}.",
                    "Bookings are still saved, and the guest's booking page says no e-mail is "
                    "coming. Other venues are not affected.",
                    "This is a slow booking drip at one venue, or a venue busier than the share. "
                    "Check /admin/recent-errors and the venue's book; if it is real traffic, raise "
                    "BOOKING_VENUE_MAIL_SHARE_PCT or GUEST_EMAILS_FLEET_PER_DAY in Render.",
                ],
                "BonBox: one venue's guest e-mails held back",
                "A venue used its daily share of guest e-mails. Other venues are not affected.",
            )
        return (
            "BonBox: guest e-mail ceiling reached, guest mails held back",
            [
                "BonBox stopped sending guest e-mails (confirmations, changes, reminders) for all "
                f"venues at {c['when']} UTC: {c['sent24']} were sent in the last 24 hours, and the "
                f"ceiling is {c['cap']}.",
                f"Held back in the last 2 minutes: {c['n']}"
                + (f", and {n_venue} more by one venue's share" if n_venue else "") + ".",
                "Bookings are still saved; only the e-mail to the guest is skipped, and owners are "
                "not told in the app.",
                "If this is real traffic, raise GUEST_EMAILS_FLEET_PER_DAY in Render.",
            ],
            "BonBox: guest e-mails held back",
            "Fleet-wide guest mail ceiling reached. Bookings are still saved.",
        )
    if service in ("abuse_staff_join", "abuse_stand_join"):
        staff = service == "abuse_staff_join"
        what = "staff join codes" if staff else "host-stand pairing codes"
        first = (
            f"More than {c['max']} wrong {what} arrived within {c['window']} minutes from all "
            f"addresses together, at {c['when']} UTC. BonBox paused "
            f"{'staff joining' if staff else 'host-stand pairing'} for everyone for at least "
            f"{c['cool']} seconds, and until fewer than {c['max']} wrong codes remain in the last "
            f"{c['window']} minutes ({c['n']} pauses in the last 2 minutes)."
        )
        second = (
            "Staff who try to join during a pause see 'Too many tries — wait a minute and try "
            "again.' Staff who have already joined are not affected."
            if staff else
            "Devices that try to pair during a pause see 'That code didn't work'. Paired stands "
            "are not affected."
        )
        return (
            f"BonBox: {what} paused (global cool-off)",
            [first, second],
            "BonBox: staff join paused" if staff else "BonBox: stand pairing paused",
            f"Burst of wrong {'join' if staff else 'pairing'} codes from many addresses.",
        )
    if service == "abuse_signups":
        return (
            "BonBox: unusual number of new accounts",
            [
                f"{c['h']} new accounts in the last hour (alert at {c['H']}) and {c['d']} in the "
                f"last 24 hours (alert at {c['D']}), at {c['when']} UTC.",
                "Nothing is blocked. Each new account gets 2 e-mails (verification + welcome). "
                "Check /admin for the new accounts.",
            ],
            "BonBox: signup burst",
            f"{c['h']} new accounts in the last hour.",
        )
    # abuse_no_edge
    return (
        "BonBox: requests arriving without the edge address header",
        [
            f"{c['n']} requests in the last 2 minutes had no valid CF-Connecting-IP or "
            f"True-Client-IP (health checks not counted); {c['e']} had one.",
            "Requests without the header all share ONE rate-limit bucket ('no-edge'), so real "
            "users may be getting 429 errors.",
            "If Render's edge changed, set CLIENT_IP_FAIL_CLOSED=false in Render to restore the "
            "old behaviour, and tell Claude.",
        ],
        "BonBox: edge header missing",
        "Users may be sharing one rate limit. See e-mail.",
    )


def recovered_copy(service: str, since: str, start: str) -> tuple[str, list[str]]:
    kind = _LABELS[service]
    return (
        f"BonBox: {kind} back to normal",
        [f"No more {kind} events for 30 minutes (since {since} UTC). Started {start} UTC."],
    )


# ── sending (fail-soft per channel) ────────────────────────────────────

def _mail(subject: str, lines: list[str]) -> None:
    html = "<br>".join(_esc(x) for x in lines)
    for to in _operator_emails():
        try:
            send_email(to, subject, html)
        except Exception as e:  # noqa: BLE001
            print(f"abuse_monitor alert email failed: {type(e).__name__}")


def _send_alert(db, service: str, ctx: dict, now) -> None:
    subject, lines, push_title, push_body = alert_copy(service, ctx)
    _mail(subject, lines)
    _push_operators(db, push_title, push_body[:180])


def _send_recovered(service: str, broken_since, consecutive_ok: int, now) -> None:
    """broken_since and consecutive_ok are the incident's values, taken
    before the row was marked HEALTHY and saved."""
    since = now - timedelta(minutes=TICK_MINUTES * (consecutive_ok or 0))
    start = broken_since.strftime("%Y-%m-%d %H:%M") if broken_since else "?"
    subject, lines = recovered_copy(service, since.strftime("%Y-%m-%d %H:%M"), start)
    _mail(subject, lines)
