"""
Notification service — detect shift changes and send email notifications to staff.

Handles:
  - Detecting added/removed/modified shifts when a schedule is published
  - Building HTML email templates for shift notifications
  - Sending emails via email_service and logging to notification_log
"""

import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session

from app.models.staff import StaffMember, StaffLink, NotificationLog
from app.models.business_profile import BusinessProfile
from app.models.push_subscription import PushSubscription
from app.models.user import User
from app.services.email_service import send_email
from app.utils.text import portal_path

logger = logging.getLogger("bonbox.notification_service")


def _notify_blocked_by_test_guard(member) -> bool:
    """Dev-safety valve: when BONBOX_NOTIFY_TEST_RECIPIENT is set (non-prod /
    verification only), suppress the REAL external sends (email + push) to
    everyone EXCEPT the named recipient — matched by email OR staff id — so a
    verification publish never blasts the live staff list. The in-app
    NotificationLog row is still written (it touches no external system), so the
    audit trail stays honest while no real message leaves the building.

    Returns False (normal behaviour) when the env var is unset — i.e. prod is
    unaffected.
    """
    target = (os.getenv("BONBOX_NOTIFY_TEST_RECIPIENT") or "").strip().lower()
    if not target:
        return False
    candidates = {
        str(getattr(member, "email", "") or "").lower(),
        str(getattr(member, "id", "") or "").lower(),
    }
    return target not in candidates


def _send_staff_schedule_push(
    db: Session,
    user_id,
    staff_id,
    staff_name: str,
    week_label: str,
    portal_url: str | None,
) -> dict:
    """Best-effort push fan-out for ONE staff member when their schedule
    changes. Returns {"attempted": int, "sent": int, "removed": int}.

    Multi-barrier:
      L1 Tenant: filter on (user_id, staff_id) — never reach across tenants.
      L2 Tier-gated on the OWNER's `schedule_publish_push` feature; if the
         owner downgrades after a staff subscribed, the row stays but we
         skip the send (the staff /portal/{token}/push/unsubscribe path
         is still open for them to clean up).
      L4 Fail-soft: any push provider error is caught + logged + returned
         as `sent=0`; the schedule publish itself is unaffected.
      L7 Audit: each send/fail writes a NotificationLog row with
         channel='push' — same surface the email path uses.
      L8 Fallback: 410 Gone responses delete the row immediately
         (handled inside push_sender.send_to_subscription).
      L10 Honest claims: the returned counts reflect what actually
          happened; never optimistic.
    """
    result = {"attempted": 0, "sent": 0, "removed": 0}

    # Lazy-import to avoid cold-start cost on machines that don't use push.
    try:
        from app.services.push_sender import send_to_subscription
        from app.services.billing import has_feature
    except Exception:  # noqa: BLE001
        return result

    owner = db.query(User).filter(User.id == user_id).first()
    if owner is None:
        return result
    if not has_feature(owner, "schedule_publish_push"):
        # Free-tier — the L4 design says we silently skip without erroring
        # the email path. (Front-line audit row still exists from the
        # email send.)
        return result

    subs = (
        db.query(PushSubscription)
        .filter(
            PushSubscription.user_id == user_id,
            PushSubscription.staff_id == staff_id,
        )
        .all()
    )

    # PII-stripped payload. No amounts, no co-worker names — only the
    # one-liner "your schedule changed". The deep-link uses the staff's
    # OWN portal URL so taps land on a personalized view.
    title = "BonBox · Vagtplan"
    body_text = f"Din vagtplan for {week_label} er opdateret"
    if len(body_text) > 140:
        body_text = body_text[:139] + "…"

    # Tag dedupes — re-fires of the same week replace the previous push
    # in the OS tray instead of stacking. Keyed on (user_id, week_label)
    # rather than (staff_id, week_label) so multiple devices belonging to
    # the same staff each get exactly one notification.
    safe_label = week_label.replace(" ", "-").lower()
    tag = f"bonbox-schedule-{user_id}-{safe_label}"

    payload = {
        "title": title,
        "body": body_text,
        "tag": tag,
        "data": {
            # When the staff taps the notification, land on their portal.
            # Falls back to / when we have no portal URL (Free owner, or
            # link rotation in flight).
            "url": portal_url or "/",
        },
    }

    for sub in subs:
        result["attempted"] += 1
        try:
            outcome = send_to_subscription(sub, payload)
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "notification: push send threw for staff_id=%s: %s",
                staff_id, exc,
            )
            outcome = {"ok": False, "removed": False}

        # NotificationLog row — same surface email uses. error_message
        # captured when push failed so the owner can spot patterns.
        status = "sent" if outcome.get("ok") else "failed"
        try:
            db.add(NotificationLog(
                id=uuid.uuid4(),
                user_id=user_id,
                staff_id=staff_id,
                channel="push",
                event_type="schedule_published",
                subject=title,
                body=body_text,
                status=status,
                error_message=None if outcome.get("ok") else "push_send_failed",
            ))
        except Exception:  # noqa: BLE001
            # Never let log-insert failure escalate.
            pass

        if outcome.get("ok"):
            result["sent"] += 1
        if outcome.get("removed"):
            result["removed"] += 1
            try:
                db.delete(sub)
            except Exception:  # noqa: BLE001
                pass

    # Native devices (BonBox Scheduler app) — web push is dead in the
    # shell's WKWebView, so those phones registered an APNs token instead.
    # Same payload, same tier gate, same honesty on the returned counts.
    try:
        from app.services import apns_sender

        apns = apns_sender.send_to_staff_devices(db, user_id, staff_id, payload)
        result["attempted"] += apns["attempted"]
        result["sent"] += apns["sent"]
        result["removed"] += apns["removed"]
        if apns["attempted"]:
            db.add(NotificationLog(
                id=uuid.uuid4(),
                user_id=user_id,
                staff_id=staff_id,
                channel="push",
                event_type="schedule_published",
                subject=title,
                body=body_text,
                status="sent" if apns["sent"] else "failed",
                error_message=None if apns["sent"] else "apns_send_failed",
            ))
    except Exception:  # noqa: BLE001
        logger.exception(
            "notification: APNs fan-out threw for staff_id=%s", staff_id,
        )

    return result


# ── Change detection ──────────────────────────────────────────────────────


@dataclass
class ShiftChange:
    change_type: str  # 'added', 'removed', 'modified'
    date: str
    old_start: str | None = None
    old_end: str | None = None
    new_start: str | None = None
    new_end: str | None = None
    role: str | None = None


def _shift_key(s: dict) -> str:
    """Unique key for a shift: staff_id + date."""
    return f"{s['staff_id']}|{s['date']}"


def detect_shift_changes(
    old_shifts: list[dict],
    new_shifts: list[dict],
) -> dict[str, list[ShiftChange]]:
    """
    Compare old vs new shifts and return a dict of staff_id -> list of changes.

    Each shift dict should have: staff_id, date, start_time, end_time, role_on_shift.
    """
    changes_by_staff: dict[str, list[ShiftChange]] = {}

    old_map: dict[str, dict] = {}
    for s in old_shifts:
        key = _shift_key(s)
        old_map[key] = s

    new_map: dict[str, dict] = {}
    for s in new_shifts:
        key = _shift_key(s)
        new_map[key] = s

    # Find added and modified shifts
    for key, ns in new_map.items():
        sid = str(ns["staff_id"])
        if key not in old_map:
            # Added
            changes_by_staff.setdefault(sid, []).append(ShiftChange(
                change_type="added",
                date=str(ns["date"]),
                new_start=ns["start_time"],
                new_end=ns["end_time"],
                role=ns.get("role_on_shift"),
            ))
        else:
            os = old_map[key]
            if os["start_time"] != ns["start_time"] or os["end_time"] != ns["end_time"]:
                changes_by_staff.setdefault(sid, []).append(ShiftChange(
                    change_type="modified",
                    date=str(ns["date"]),
                    old_start=os["start_time"],
                    old_end=os["end_time"],
                    new_start=ns["start_time"],
                    new_end=ns["end_time"],
                    role=ns.get("role_on_shift"),
                ))

    # Find removed shifts
    for key, os in old_map.items():
        if key not in new_map:
            sid = str(os["staff_id"])
            changes_by_staff.setdefault(sid, []).append(ShiftChange(
                change_type="removed",
                date=str(os["date"]),
                old_start=os["start_time"],
                old_end=os["end_time"],
                role=os.get("role_on_shift"),
            ))

    return changes_by_staff


# ── Email builder ─────────────────────────────────────────────────────────


def _format_date_nice(date_str: str) -> str:
    """Format 'YYYY-MM-DD' -> 'Mon 14 Apr'."""
    from datetime import date as date_cls
    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    try:
        d = date_cls.fromisoformat(date_str)
        return f"{days[d.weekday()]} {d.day} {months[d.month - 1]}"
    except Exception:
        return date_str


def build_shift_email_html(
    staff_name: str,
    changes: list[ShiftChange],
    portal_url: str | None,
    restaurant_name: str,
    week_label: str,
) -> str:
    """Build a mobile-friendly HTML email for shift change notifications."""

    # Build change rows
    change_rows = ""
    for c in sorted(changes, key=lambda x: x.date):
        date_nice = _format_date_nice(c.date)
        if c.change_type == "added":
            badge = '<span style="display:inline-block;padding:2px 8px;border-radius:6px;background:#16a34a20;color:#16a34a;font-size:11px;font-weight:600">NEW</span>'
            detail = f"{c.new_start} - {c.new_end}"
        elif c.change_type == "removed":
            badge = '<span style="display:inline-block;padding:2px 8px;border-radius:6px;background:#dc262620;color:#dc2626;font-size:11px;font-weight:600">CANCELLED</span>'
            detail = f"<s style=\"color:#94a3b8\">{c.old_start} - {c.old_end}</s>"
        else:
            badge = '<span style="display:inline-block;padding:2px 8px;border-radius:6px;background:#d9770620;color:#d97706;font-size:11px;font-weight:600">CHANGED</span>'
            detail = f"<s style=\"color:#94a3b8\">{c.old_start}-{c.old_end}</s> &rarr; <strong>{c.new_start}-{c.new_end}</strong>"

        change_rows += f"""
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #1e293b;font-size:14px;color:#e2e8f0">{date_nice}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #1e293b;font-size:14px;color:#e2e8f0">{detail}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #1e293b;text-align:right">{badge}</td>
        </tr>"""

    # CTA button
    cta = ""
    if portal_url:
        cta = f"""
        <div style="text-align:center;margin-top:24px">
          <a href="{portal_url}" style="display:inline-block;padding:12px 32px;background:#22c55e;color:white;text-decoration:none;border-radius:10px;font-size:15px;font-weight:600">View Schedule</a>
        </div>"""

    return f"""
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:20px">
    <!-- Header -->
    <div style="text-align:center;padding:24px 0">
      <div style="display:inline-block;width:48px;height:48px;background:#22c55e;border-radius:14px;line-height:48px;text-align:center">
        <span style="color:white;font-size:20px;font-weight:bold">B</span>
      </div>
      <h1 style="margin:12px 0 4px;font-size:20px;color:#f1f5f9">{restaurant_name}</h1>
      <p style="margin:0;font-size:13px;color:#64748b">Schedule update - {week_label}</p>
    </div>

    <!-- Greeting -->
    <div style="margin-bottom:20px">
      <p style="margin:0;font-size:15px;color:#cbd5e1">Hi {staff_name.split(' ')[0]},</p>
      <p style="margin:6px 0 0;font-size:14px;color:#94a3b8">Your schedule has been updated. Here's what changed:</p>
    </div>

    <!-- Changes table -->
    <div style="background:#1e293b;border-radius:12px;overflow:hidden;border:1px solid #334155">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <tr style="background:#0f172a">
          <td style="padding:8px 12px;font-size:11px;color:#64748b;text-transform:uppercase;font-weight:600">Day</td>
          <td style="padding:8px 12px;font-size:11px;color:#64748b;text-transform:uppercase;font-weight:600">Shift</td>
          <td style="padding:8px 12px;font-size:11px;color:#64748b;text-transform:uppercase;font-weight:600;text-align:right">Status</td>
        </tr>
        {change_rows}
      </table>
    </div>

    {cta}

    <!-- Footer -->
    <div style="text-align:center;margin-top:32px;padding-top:16px;border-top:1px solid #1e293b">
      <p style="margin:0;font-size:12px;color:#475569">This is an automated notification from BonBox.</p>
      <p style="margin:4px 0 0;font-size:11px;color:#334155">Questions? Ask your manager directly.</p>
    </div>
  </div>
</body>
</html>"""


# ── Send notifications ────────────────────────────────────────────────────


def send_shift_notifications(
    db: Session,
    user_id,
    changes_by_staff: dict[str, list[ShiftChange]],
    week_label: str,
):
    """
    For each staff with changes, look up their email and send a notification.
    Logs all attempts to notification_log.

    Multi-layer hardening (May 2026):
      L1 — TENANT SCOPE
           StaffMember + StaffLink queries filter by user_id.
      L2 — PER-STAFF FAILURE ISOLATION
           Each iteration is wrapped in its own try/except so a single
           bad email (network error, malformed address, log insert
           failure) can't kill the rest of the batch. Email to staff #2
           still goes out even if staff #1's send raised.
      L3 — PER-STAFF DB COMMIT
           NotificationLog rows commit per-staff. Without this, a single
           constraint violation at the end of the loop would roll back
           every log row in the batch (silent failure of the whole audit
           trail). Per-staff commit costs a tiny extra round-trip but
           preserves observability.
      L4 — DEFENSIVE DEFAULTS
           Missing email → skip (already had this). Missing portal link
           → email still sends without CTA button (build_shift_email_html
           handles `portal_url=None`).
      L5 — NO PUBLISH BLOCKING
           Caller (publish_week) runs us in a BackgroundTask, so even a
           catastrophic failure here cannot fail the publish response.
    """
    if not changes_by_staff:
        return

    # Get restaurant name
    try:
        from app.models.user import User
        owner = db.query(User).filter(User.id == user_id).first()
        profile = db.query(BusinessProfile).filter(
            BusinessProfile.user_id == user_id
        ).first()
        # Prefer the owner's editable trading name over the BusinessProfile
        # fields (which may still hold the CVR legal name). Staff see this.
        restaurant_name = (
            (getattr(owner, "business_name", None) if owner else None)
            or (profile.business_name if profile else None)
            or (getattr(profile, "company_name", None) if profile else None)
            or "BonBox"
        )
    except Exception:  # noqa: BLE001
        # Even profile lookup shouldn't kill the batch — fall back to
        # a generic sender name and continue.
        logger.exception("notification: profile lookup failed (using default)")
        restaurant_name = "BonBox"

    for staff_id_str, changes in changes_by_staff.items():
        # Per-staff isolation — one failure doesn't poison the rest.
        try:
            try:
                staff_uuid = uuid.UUID(staff_id_str)
            except ValueError:
                continue

            # Multi-tenant: enforce that the staff member belongs to
            # user_id. Without this, a malicious caller passing another
            # tenant's staff_id could trigger a schedule-update email
            # to that user's staff (DoS / phishing vector).
            member = db.query(StaffMember).filter(
                StaffMember.id == staff_uuid,
                StaffMember.user_id == user_id,
                StaffMember.is_deleted.isnot(True),
            ).first()
            # Only tenant-scope / deleted bails out. A MISSING EMAIL no longer
            # skips the staff: we still write the in-app alert (so the portal
            # Alerts feed shows "schedule published") and still fire push.
            # Most DK café staff never give an email — they'd previously have
            # seen an empty Alerts feed and gotten no push even when subscribed.
            if not member:
                continue

            # Dev-safety: when BONBOX_NOTIFY_TEST_RECIPIENT is set, suppress the
            # real email/push to everyone but the test recipient (the in_app row
            # is still written). Unset in prod → no-op.
            blocked = _notify_blocked_by_test_guard(member)

            # Look up portal link for CTA button
            link = db.query(StaffLink).filter(
                StaffLink.staff_id == staff_uuid,
                StaffLink.user_id == user_id,
                StaffLink.active.is_(True),
            ).first()
            portal_url = f"https://www.bonbox.dk{portal_path(link.token, restaurant_name)}" if link else None

            subject = f"Schedule updated - {week_label}"

            # ── Email channel — only when the staff has an address ────────
            # When emailed, the NotificationLog row carries channel="email"
            # (and the full HTML body); otherwise we record an "in_app" row.
            # Either way exactly ONE schedule_published row is written per
            # staff, so the portal Alerts feed always has the entry without
            # duplicating it for emailed staff.
            channel = "in_app"
            status = "sent"
            error_message = None
            body = None
            if member.email and not blocked:
                html = build_shift_email_html(
                    staff_name=member.name,
                    changes=changes,
                    portal_url=portal_url,
                    restaurant_name=restaurant_name,
                    week_label=week_label,
                )
                # send_email is internally try/except'd — returns False on
                # any failure. The per-staff outer try/except is belt-and-
                # braces against changes to that contract.
                success = send_email(to=member.email, subject=subject, html=html)
                channel = "email"
                status = "sent" if success else "failed"
                error_message = None if success else "Email delivery failed"
                body = html

            log = NotificationLog(
                id=uuid.uuid4(),
                user_id=user_id,
                staff_id=staff_uuid,
                channel=channel,
                event_type="schedule_published",
                subject=subject,
                body=body,
                status=status,
                error_message=error_message,
            )
            db.add(log)

            # Staff v2 (2026-05-28) — push fan-out alongside email.
            # Fully fail-soft: a push error never blocks the email send
            # or the per-staff commit. Tier-gating + tenant scope live
            # inside _send_staff_schedule_push.
            if not blocked:
                try:
                    _send_staff_schedule_push(
                        db=db,
                        user_id=user_id,
                        staff_id=staff_uuid,
                        staff_name=member.name,
                        week_label=week_label,
                        portal_url=portal_url,
                    )
                except Exception:  # noqa: BLE001
                    logger.exception(
                        "notification: push fan-out threw for staff_id=%s",
                        staff_id_str,
                    )

            # Per-staff commit — preserves audit trail even if a later
            # iteration explodes.
            db.commit()
        except Exception as exc:  # noqa: BLE001
            # Roll back this iteration's pending log if any, log to
            # server stderr so we can spot patterns, and move on.
            try:
                db.rollback()
            except Exception:  # noqa: BLE001
                pass
            logger.exception(
                "notification: per-staff send failed for staff_id=%s: %s",
                staff_id_str, exc,
            )
            continue


def send_single_shift_notification(
    db: Session,
    user_id,
    staff_id,
    change: ShiftChange,
    event_type: str = "shift_changed",
):
    """
    Send a notification for a single shift change (edit or delete).

    Multi-tenant: same fix as send_shift_notifications — enforce that
    the staff_id belongs to user_id before fetching the email and
    triggering the send.
    """
    member = db.query(StaffMember).filter(
        StaffMember.id == staff_id,
        StaffMember.user_id == user_id,
        StaffMember.is_deleted.isnot(True),
    ).first()
    # Tenant scope / deleted bails out. A MISSING EMAIL no longer skips the
    # staff: we still write the in-app alert (so the portal Alerts feed shows
    # the change) and still fire push — parity with the publish path. Most DK
    # café staff have no email on file.
    if not member:
        return

    owner = db.query(User).filter(User.id == user_id).first()
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user_id
    ).first()
    restaurant_name = (
        (getattr(owner, "business_name", None) if owner else None)
        or (profile.business_name if profile else None)
        or (getattr(profile, "company_name", None) if profile else None)
        or "BonBox"
    )

    link = db.query(StaffLink).filter(
        StaffLink.staff_id == staff_id,
        StaffLink.user_id == user_id,
        StaffLink.active.is_(True),
    ).first()
    portal_url = f"https://www.bonbox.dk{portal_path(link.token, restaurant_name)}" if link else None

    week_label = _format_date_nice(change.date)
    subject = f"Shift {'cancelled' if change.change_type == 'removed' else 'updated'} - {week_label}"

    blocked = _notify_blocked_by_test_guard(member)

    # ── Email channel — only when the staff has an address AND the test guard
    #    isn't suppressing them. Otherwise we still record an in_app row so the
    #    portal Alerts feed shows the change. Exactly ONE row either way.
    channel = "in_app"
    status = "sent"
    error_message = None
    body = None
    if member.email and not blocked:
        html = build_shift_email_html(
            staff_name=member.name,
            changes=[change],
            portal_url=portal_url,
            restaurant_name=restaurant_name,
            week_label=week_label,
        )
        success = send_email(to=member.email, subject=subject, html=html)
        channel = "email"
        status = "sent" if success else "failed"
        error_message = None if success else "Email delivery failed"
        body = html
    elif member.email and blocked:
        logger.info(
            "notification(single): test-guard suppressed email to staff_id=%s",
            staff_id,
        )

    log = NotificationLog(
        id=uuid.uuid4(),
        user_id=user_id,
        staff_id=staff_id,
        channel=channel,
        event_type=event_type,
        subject=subject,
        body=body,
        status=status,
        error_message=error_message,
    )
    db.add(log)

    # Push fan-out — matches the publish path so single edits reach staff in
    # the OS tray too. Fail-soft + tier-gated inside the helper; suppressed by
    # the test guard.
    if not blocked:
        try:
            _send_staff_schedule_push(
                db=db,
                user_id=user_id,
                staff_id=staff_id,
                staff_name=member.name,
                week_label=week_label,
                portal_url=portal_url,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "notification(single): push fan-out threw for staff_id=%s",
                staff_id,
            )

    db.commit()


def notify_owner_new_reservation(db: Session, owner, reservation, *, cancelled: bool = False) -> dict:
    """Best-effort push to the OWNER's devices when a guest books via the
    public /r/<slug> link — the "ping when a table is booked" the host
    stand wants. Pushes to owner subscriptions (staff_id IS NULL), writes
    a NotificationLog row, and never blocks the booking.

    PII-light by design: party size + time only on the lock-screen body,
    no guest name (the full detail lives behind auth in the reservation
    book). Returns {"attempted", "sent"}.
    """
    result = {"attempted": 0, "sent": 0}
    try:
        from app.services.push_sender import send_to_subscription
    except Exception:  # noqa: BLE001
        return result

    subs = (
        db.query(PushSubscription)
        .filter(
            PushSubscription.user_id == owner.id,
            PushSubscription.staff_id.is_(None),  # owner devices, not staff
        )
        .all()
    )

    when = reservation.starts_at.strftime("%d/%m %H:%M") if reservation.starts_at else ""
    is_request = reservation.status == "requested"
    if cancelled:
        # Guest cancelled online — tell the owner the table is free again
        # (NOT "Ny reservation", which would be misleading). Same tag, so
        # this push replaces the earlier booking ping on the lock screen.
        title = "BonBox · Reservation aflyst"
        body_text = f"{reservation.party_size} pers · {when} — bord frigivet"
    else:
        title = "BonBox · Ny forespørgsel" if is_request else "BonBox · Ny reservation"
        body_text = f"{reservation.party_size} pers · {when}"
        if is_request:
            body_text += " — afventer svar"
    tag = f"bonbox-reservation-{reservation.id}"
    # Deep link straight to THIS booking: the frontend consumer
    # (?booking=<id>&date=) re-derives the row from a fresh fetch, opens the
    # drawer with the state-matched action at thumb height, and shows an honest
    # "no longer exists" note for dead links. A bare /reservations landed the
    # owner on today's book and made them step days from memory.
    _day = reservation.starts_at.date().isoformat() if reservation.starts_at else ""
    deep_url = f"/reservations?booking={reservation.id}" + (f"&date={_day}" if _day else "")
    payload = {
        "title": title,
        "body": body_text,
        "tag": tag,
        "data": {"url": deep_url},
    }

    for sub in subs:
        result["attempted"] += 1
        try:
            outcome = send_to_subscription(sub, payload)
            if outcome.get("ok"):
                result["sent"] += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("reservation push send threw: %s", exc)
            outcome = {"ok": False}

    # One NotificationLog row per booking (channel='push'), regardless of
    # device count — the audit surface mirrors the schedule-push path.
    try:
        db.add(NotificationLog(
            id=uuid.uuid4(),
            user_id=owner.id,
            staff_id=None,
            channel="push",
            event_type="reservation_cancelled" if cancelled else "reservation_created",
            subject=title,
            body=body_text,
            status="sent" if result["sent"] else "failed",
            error_message=None if result["sent"] else "no_active_subscription",
        ))
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
    return result


def notify_owner_freed_table(
    db: Session, owner, freed_reservation, top_match, *, sms_available: bool = False
) -> dict:
    """Best-effort OWNER push when a cancel/no-show frees a table AND a real
    waiting party fits it — the "re-offer the freed seat" nudge for the host
    stand. Owner devices only (staff_id IS NULL). Deep-links into the
    Venteliste so the owner can offer it in one tap.

    HARD RED-LINES (waitlist money layer):
      • OWNER PUSH ONLY — zero send_sms / guest-channel calls. The guest is
        NEVER messaged here; offering the seat to a waiting guest stays behind
        the manual, cap-enforced notify_waitlist path.
      • DEDUP — dedup_key = "freed:<freed_id>:<match_id>". If a recent row with
        the same key + event already exists (owner cancelled AND the guest
        self-cancelled the same booking, or a double-tap), we DON'T re-buzz.
      • FIRE ONLY ON A REAL FIT — caller passes top_match only when a FIFO fit
        exists; no empty ping.
      • FAIL-SOFT — never raises; a push failure never turns a cancel into an
        error (caller also wraps this in try/except).

    top_match is a waitlist-match dict (id, guest_name, party_size) from the
    reservations router's _waitlist_matches. Returns {"attempted","sent"} (plus
    {"skipped": "duplicate"} when de-duped). PII-light: first name + party size
    only on the lock screen.
    """
    result = {"attempted": 0, "sent": 0}
    match_id = str(top_match.get("id") or "")
    if not match_id:
        return result
    dedup_key = f"freed:{freed_reservation.id}:{match_id}"

    # Dedup FIRST — a duplicate freeing event (owner cancel + guest self-cancel,
    # or a double-tap) must not double-buzz. Look back ~10 min.
    try:
        from datetime import timedelta
        from app.utils.time import utc_now as _utc_now
        cutoff = _utc_now() - timedelta(minutes=10)
        dupe = (
            db.query(NotificationLog.id)
            .filter(
                NotificationLog.dedup_key == dedup_key,
                NotificationLog.event_type == "waitlist_freed_table",
                NotificationLog.created_at >= cutoff,
            )
            .first()
        )
        if dupe is not None:
            return {"attempted": 0, "sent": 0, "skipped": "duplicate"}
    except Exception:  # noqa: BLE001 — a dedup lookup failure must not block the send-once path
        pass

    try:
        from app.services.push_sender import send_to_subscription
    except Exception:  # noqa: BLE001
        return result

    subs = (
        db.query(PushSubscription)
        .filter(
            PushSubscription.user_id == owner.id,
            PushSubscription.staff_id.is_(None),  # owner devices, not staff
        )
        .all()
    )

    navn = (str(top_match.get("guest_name") or "").strip().split(" ") or [""])[0]
    n = top_match.get("party_size")
    title = "BonBox · Bord frigivet"
    if navn:
        body_text = f"{navn} ({n} pers) passer — tryk for at tilbyde"
    else:
        body_text = f"{n} pers på ventelisten passer — tryk for at tilbyde"
    # Distinct tag from the create/cancel ping (bonbox-reservation-<id>) so the
    # freed-table nudge doesn't overwrite / isn't overwritten by it.
    tag = f"bonbox-freed-{freed_reservation.id}"
    payload = {
        "title": title,
        "body": body_text,
        "tag": tag,
        "data": {
            "url": f"/reservations?waitlist={match_id}",
            "kind": "freed_table",
            "match_id": match_id,
            # Truthful capability flag — the landing CTA never promises an SMS
            # the account can't actually send.
            "sms": bool(sms_available),
        },
    }

    for sub in subs:
        result["attempted"] += 1
        try:
            outcome = send_to_subscription(sub, payload)
            if outcome.get("ok"):
                result["sent"] += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("freed-table push send threw: %s", exc)
            outcome = {"ok": False}

    # ONE NotificationLog row (channel='push'), carrying the dedup_key so the
    # next duplicate freeing event de-dups against it.
    try:
        db.add(NotificationLog(
            id=uuid.uuid4(),
            user_id=owner.id,
            staff_id=None,
            channel="push",
            event_type="waitlist_freed_table",
            subject=title,
            body=body_text,
            status="sent" if result["sent"] else "failed",
            error_message=None if result["sent"] else "no_active_subscription",
            dedup_key=dedup_key,
        ))
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
    return result


def notify_owner_shift_claimed(
    db: Session, *, owner, staff_name: str, shift_date, start_time: str, end_time: str,
) -> dict:
    """Best-effort push to the OWNER when a staffer claims an open shift from
    their portal — "Agnes tog en åben vagt". Pushes to owner devices
    (staff_id IS NULL), writes ONE NotificationLog row, never blocks the claim.
    PII-light: first name + slot only. Mirrors notify_owner_new_reservation."""
    result = {"attempted": 0, "sent": 0}
    try:
        from app.services.push_sender import send_to_subscription
    except Exception:  # noqa: BLE001
        return result

    subs = (
        db.query(PushSubscription)
        .filter(
            PushSubscription.user_id == owner.id,
            PushSubscription.staff_id.is_(None),  # owner devices, not staff
        )
        .all()
    )
    try:
        when = shift_date.strftime("%d/%m")
    except Exception:  # noqa: BLE001
        when = str(shift_date)
    title = "BonBox · Åben vagt taget"
    body_text = f"{staff_name} tog {when} {start_time}–{end_time}"
    payload = {
        "title": title,
        "body": body_text,
        "tag": "bonbox-open-shift-claimed",
        "data": {"url": "/staff/schedule"},
    }
    for sub in subs:
        result["attempted"] += 1
        try:
            outcome = send_to_subscription(sub, payload)
            if outcome.get("ok"):
                result["sent"] += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("open-shift claim push threw: %s", exc)

    try:
        db.add(NotificationLog(
            id=uuid.uuid4(),
            user_id=owner.id,
            staff_id=None,
            channel="push",
            event_type="open_shift_claimed",
            subject=title,
            body=body_text,
            status="sent" if result["sent"] else "failed",
            error_message=None if result["sent"] else "no_active_subscription",
        ))
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
    return result


def notify_owner_sick_call(
    db: Session, *, owner, staff_name: str, absence_date, shift=None, staff_id=None,
) -> dict:
    """Best-effort push to the OWNER when a staffer calls in sick.

    This did not exist. create_sick_call wrote a pending StaffAbsence row and a
    log line and nothing else, so the most time-critical message in the whole
    product — "I can't come in today" — reached nobody. The staffer taps the
    button, sees a confirmation, and believes the venue knows. The venue finds
    out when the shift starts and they are one person short.

    That the omission was never noticed is itself telling: create_sick_call's
    own docstring says idempotency "lets the staff tap the button twice without
    spamming the owner", so the notification was always intended.

    Same shape as notify_owner_shift_claimed: owner devices only
    (PushSubscription.staff_id IS NULL), one NotificationLog row stamped with
    the staffer who called in, PII-light on the wire (first name + slot),
    and it must NEVER block the sick call — an absence that failed to save
    because a push failed would be strictly worse than a silent one.
    """
    result = {"attempted": 0, "sent": 0}
    try:
        from app.services.push_sender import send_to_subscription
    except Exception:  # noqa: BLE001
        return result

    subs = (
        db.query(PushSubscription)
        .filter(
            PushSubscription.user_id == owner.id,
            PushSubscription.staff_id.is_(None),   # owner devices, not staff
        )
        .all()
    )
    try:
        when = absence_date.strftime("%d/%m")
    except Exception:  # noqa: BLE001
        when = str(absence_date)

    # Name the SLOT when we know it. "Sofie 03/09" makes the owner open the app
    # to find out what is uncovered; "Sofie 03/09 16:00–23:00" is already the
    # decision — that is the shift with a hole in it.
    slot = ""
    try:
        if shift is not None and getattr(shift, "start_time", None) and getattr(shift, "end_time", None):
            slot = f" {shift.start_time}–{shift.end_time}"
    except Exception:  # noqa: BLE001
        slot = ""

    title = "BonBox · Sygemelding"
    body_text = f"{staff_name} har meldt sig syg {when}{slot}"
    payload = {
        "title": title,
        "body": body_text,
        "tag": f"bonbox-sick-{when}",   # collapses repeat taps on one device
        "data": {"url": "/staff/schedule"},
    }
    for sub in subs:
        result["attempted"] += 1
        try:
            outcome = send_to_subscription(sub, payload)
            if outcome.get("ok"):
                result["sent"] += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("sick-call push threw: %s", exc)

    try:
        db.add(NotificationLog(
            id=uuid.uuid4(),
            user_id=owner.id,
            # The staffer IS known here, unlike the booking-driven owner
            # notifications, so name them: a sick-call audit row whose whole
            # point is "who called in" should not be anonymous. This was
            # staff_id=None into a NOT NULL column, which meant the insert
            # below threw into its own except and the row was never written
            # — the push landed and nothing was recorded. See Migration 070.
            staff_id=staff_id,
            channel="push",
            event_type="sick_call",
            subject=title,
            body=body_text,
            status="sent" if result["sent"] else "failed",
            error_message=None if result["sent"] else "no_active_subscription",
        ))
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
    return result


def notify_owner_swap_executed(db: Session, *, owner_id, swap) -> dict:
    """Best-effort owner notification when a peer-to-peer shift swap
    auto-executes (both staff accepted → schedules already reassigned).

    The swap is NOT gated on this — it already happened. This is pure
    awareness for the owner ("Anna and Lars swapped two shifts"), mirroring
    the push + NotificationLog pattern used for new reservations. Never
    raises; never blocks. Writes ONE NotificationLog row (channel='push')
    under the owner's user_id so it surfaces in their notification history.

    Owner-approval UI is a deliberate follow-up (see shift_swap_service
    respond_to_swap) — for now the owner is informed after the fact, not
    asked to approve.
    """
    result = {"attempted": 0, "sent": 0}

    # Resolve names + a shift date for a human-readable line. Best-effort —
    # missing rows just yield a terser message.
    from_staff = (
        db.query(StaffMember).filter(StaffMember.id == swap.from_staff_id).first()
        if swap.from_staff_id else None
    )
    to_staff = (
        db.query(StaffMember).filter(StaffMember.id == swap.to_staff_id).first()
        if swap.to_staff_id else None
    )
    from_name = (from_staff.name if from_staff else "Staff")
    to_name = (to_staff.name if to_staff else "Staff")

    title = "BonBox · Vagtbytte gennemført"
    body_text = f"{from_name} ↔ {to_name} byttede to vagter"

    owner = db.query(User).filter(User.id == owner_id).first()
    if owner is None:
        return result

    # Push to the owner's OWN devices (staff_id IS NULL), if any.
    try:
        from app.services.push_sender import send_to_subscription

        subs = (
            db.query(PushSubscription)
            .filter(
                PushSubscription.user_id == owner.id,
                PushSubscription.staff_id.is_(None),
            )
            .all()
        )
        payload = {
            "title": title,
            "body": body_text,
            "tag": f"bonbox-swap-{swap.id}",
            "data": {"url": "/staff/schedule"},
        }
        for sub in subs:
            result["attempted"] += 1
            try:
                outcome = send_to_subscription(sub, payload)
                if outcome.get("ok"):
                    result["sent"] += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning("swap push send threw: %s", exc)
    except Exception:  # noqa: BLE001
        # push_sender unavailable (CI / partial checkout) — still log below.
        pass

    # One NotificationLog row regardless of device count — owner audit
    # surface. status='sent' only if a push actually landed; otherwise
    # the row still records that the swap happened (channel push, no sub).
    try:
        db.add(NotificationLog(
            id=uuid.uuid4(),
            user_id=owner.id,
            staff_id=None,
            channel="push",
            event_type="shift_swapped",
            subject=title,
            body=body_text,
            status="sent" if result["sent"] else "failed",
            error_message=None if result["sent"] else "no_active_subscription",
        ))
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
    return result
