"""
Notification service — detect shift changes and send email notifications to staff.

Handles:
  - Detecting added/removed/modified shifts when a schedule is published
  - Building HTML email templates for shift notifications
  - Sending emails via email_service and logging to notification_log
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session

from app.models.staff import StaffMember, StaffLink, NotificationLog
from app.models.business_profile import BusinessProfile
from app.services.email_service import send_email


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
    """
    if not changes_by_staff:
        return

    # Get restaurant name
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user_id
    ).first()
    restaurant_name = profile.business_name if profile else "BonBox"

    for staff_id_str, changes in changes_by_staff.items():
        try:
            staff_uuid = uuid.UUID(staff_id_str)
        except ValueError:
            continue

        # Multi-tenant: enforce that the staff member belongs to user_id.
        # Without the user_id filter, a malicious caller passing another
        # tenant's staff_id could trigger a schedule-update email to that
        # user's staff (DoS / phishing vector). Always scope by user.
        member = db.query(StaffMember).filter(
            StaffMember.id == staff_uuid,
            StaffMember.user_id == user_id,
            StaffMember.is_deleted.isnot(True),
        ).first()
        if not member or not member.email:
            continue

        # Look up portal link for CTA button
        link = db.query(StaffLink).filter(
            StaffLink.staff_id == staff_uuid,
            StaffLink.user_id == user_id,
            StaffLink.active.is_(True),
        ).first()
        portal_url = f"https://bonbox.dk/s/{link.token}" if link else None

        subject = f"Schedule updated - {week_label}"
        html = build_shift_email_html(
            staff_name=member.name,
            changes=changes,
            portal_url=portal_url,
            restaurant_name=restaurant_name,
            week_label=week_label,
        )

        success = send_email(to=member.email, subject=subject, html=html)

        log = NotificationLog(
            id=uuid.uuid4(),
            user_id=user_id,
            staff_id=staff_uuid,
            channel="email",
            event_type="schedule_published",
            subject=subject,
            body=html,
            status="sent" if success else "failed",
            error_message=None if success else "Email delivery failed",
        )
        db.add(log)

    db.commit()


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
    if not member or not member.email:
        return

    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user_id
    ).first()
    restaurant_name = profile.business_name if profile else "BonBox"

    link = db.query(StaffLink).filter(
        StaffLink.staff_id == staff_id,
        StaffLink.user_id == user_id,
        StaffLink.active.is_(True),
    ).first()
    portal_url = f"https://bonbox.dk/s/{link.token}" if link else None

    week_label = _format_date_nice(change.date)
    subject = f"Shift {'cancelled' if change.change_type == 'removed' else 'updated'} - {week_label}"

    html = build_shift_email_html(
        staff_name=member.name,
        changes=[change],
        portal_url=portal_url,
        restaurant_name=restaurant_name,
        week_label=week_label,
    )

    success = send_email(to=member.email, subject=subject, html=html)

    log = NotificationLog(
        id=uuid.uuid4(),
        user_id=user_id,
        staff_id=staff_id,
        channel="email",
        event_type=event_type,
        subject=subject,
        body=html,
        status="sent" if success else "failed",
        error_message=None if success else "Email delivery failed",
    )
    db.add(log)
    db.commit()
