"""Nightly reservation jobs — reminder emails + GDPR purge.

  • send_reservation_reminders() — day-before reminder for confirmed
    reservations (the v1 no-show defense, reminders-only).
  • purge_expired_reservations() — Art. 9 retention: null out guest PII +
    allergy on rows past purge_after, keeping the row for aggregate stats.

Both isolate per-row errors so one bad row never poisons the batch, and
both are idempotent (reminder_sent_at / purged_at short-circuit re-runs).
"""
import logging
from datetime import timedelta

from app.database import SessionLocal
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.user import User
from app.utils.time import utc_now

logger = logging.getLogger(__name__)


def send_reservation_reminders() -> int:
    """Email a reminder for confirmed reservations starting in the next
    ~24-36h that haven't been reminded yet. Returns the count sent."""
    db = SessionLocal()
    sent = 0
    try:
        now = utc_now()
        horizon = now + timedelta(hours=36)
        rows = (
            db.query(Reservation)
            .filter(
                Reservation.is_deleted.is_(False),
                Reservation.status == "confirmed",
                Reservation.reminder_sent_at.is_(None),
                Reservation.guest_email.isnot(None),
                Reservation.starts_at > now,
                Reservation.starts_at <= horizon,
            )
            .all()
        )
        for r in rows:
            try:
                owner = db.query(User).filter(User.id == r.user_id).first()
                profile = (
                    db.query(BusinessProfile)
                    .filter(BusinessProfile.user_id == r.user_id)
                    .first()
                )
                biz = getattr(profile, "company_name", None) or "BonBox"
                when = r.starts_at.strftime("%d/%m/%Y %H:%M")
                from app.services.email_service import send_email
                html = (
                    f"<p>Hej {r.guest_name},</p>"
                    f"<p>Bare en venlig påmindelse om din reservation hos "
                    f"<strong>{biz}</strong>:</p>"
                    f"<p>{when} · {r.party_size} personer</p>"
                    f"<p>Vi glæder os til at se dig! Skriv til os hvis du skal "
                    f"ændre eller aflyse.</p>"
                )
                send_email(
                    to=r.guest_email,
                    subject=f"Påmindelse — {biz} {when}",
                    html=html,
                    reply_to=getattr(owner, "email", None),
                )
                r.reminder_sent_at = utc_now()
                sent += 1
            except Exception as exc:  # noqa: BLE001 — isolate per-row
                logger.warning("reservation reminder failed for %s: %s", r.id, exc)
        db.commit()
    finally:
        db.close()
    if sent:
        logger.info("reservation reminders sent: %d", sent)
    return sent


def purge_expired_reservations() -> int:
    """GDPR Art. 9 retention: on reservations past purge_after, null the
    guest PII + allergy fields (keep the row for aggregate stats). Returns
    the count purged."""
    db = SessionLocal()
    purged = 0
    try:
        now = utc_now()
        rows = (
            db.query(Reservation)
            .filter(
                Reservation.purge_after.isnot(None),
                Reservation.purge_after <= now,
                Reservation.purged_at.is_(None),
            )
            .all()
        )
        for r in rows:
            try:
                r.guest_name = None
                r.guest_email = None
                r.guest_phone = None
                r.guest_notes = None
                r.allergen_tags = None
                r.allergy_note = None
                r.allergy_severity = None
                r.occasion = None
                r.guest_consent_marketing = False
                r.purged_at = now
                purged += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning("reservation purge failed for %s: %s", r.id, exc)
        db.commit()
    finally:
        db.close()
    if purged:
        logger.info("reservations purged (GDPR): %d", purged)
    return purged
