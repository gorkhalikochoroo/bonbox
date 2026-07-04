"""Nightly reservation jobs — reminder emails + GDPR purge.

  • send_reservation_reminders() — day-before reminder for confirmed
    reservations (the v1 no-show defense, reminders-only).
  • purge_expired_reservations() — Art. 9 retention: null out guest PII +
    allergy on rows past purge_after, keeping the row for aggregate stats.

Both isolate per-row errors so one bad row never poisons the batch, and
both are idempotent (reminder_sent_at / purged_at short-circuit re-runs).
"""
import logging
import uuid
from datetime import timedelta

from sqlalchemy import func

from app.database import SessionLocal
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.staff import NotificationLog
from app.models.user import User
from app.utils.time import utc_now

logger = logging.getLogger(__name__)


def _month_start(now):
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def send_reservation_reminders() -> int:
    """Day-before reminder for confirmed reservations in the next ~24-36h
    that haven't been reminded. Prefers SMS when the owner has the
    sms_reminders feature ON, the business enabled it, the guest gave a
    phone, a provider is configured, and the owner is under their monthly
    SMS cap — otherwise falls back to email. Returns the count reminded."""
    db = SessionLocal()
    sent = 0
    sms_used: dict = {}   # owner_id -> SMS count this month (live tally)
    owners: dict = {}
    profiles: dict = {}
    try:
        from app.services import reservation_service as rsvc
        from app.services import sms_service
        from app.services.billing import has_feature, at_cap

        now = utc_now()
        horizon = now + timedelta(hours=36)
        month_start = _month_start(now)
        rows = (
            db.query(Reservation)
            .filter(
                Reservation.is_deleted.is_(False),
                Reservation.status == "confirmed",
                Reservation.reminder_sent_at.is_(None),
                Reservation.starts_at > now,
                Reservation.starts_at <= horizon,
            )
            .all()
        )
        for r in rows:
            try:
                if r.user_id not in owners:
                    owners[r.user_id] = db.query(User).filter(User.id == r.user_id).first()
                    profiles[r.user_id] = (
                        db.query(BusinessProfile)
                        .filter(BusinessProfile.user_id == r.user_id)
                        .first()
                    )
                owner = owners[r.user_id]
                profile = profiles[r.user_id]
                if owner is None:
                    continue
                biz = (
                    getattr(owner, "business_name", None)
                    or getattr(profile, "company_name", None)
                    or "BonBox"
                )
                when = r.starts_at.strftime("%d/%m %H:%M")
                settings = rsvc.load_settings(profile)

                channel = None
                outcome = {"ok": False}

                # ── SMS preferred when fully eligible ──────────────────
                want_sms = (
                    bool(r.guest_phone)
                    and bool(settings.get("sms_reminders"))
                    and has_feature(owner, "sms_reminders")
                    and sms_service.sms_configured()
                )
                if want_sms:
                    if r.user_id not in sms_used:
                        prior = (
                            db.query(func.count(NotificationLog.id))
                            .filter(
                                NotificationLog.user_id == r.user_id,
                                NotificationLog.channel == "sms",
                                NotificationLog.event_type == "reservation_reminder",
                                NotificationLog.created_at >= month_start,
                            )
                            .scalar()
                        ) or 0
                        sms_used[r.user_id] = int(prior)
                    if not at_cap(owner, "sms_reminders_per_month", sms_used[r.user_id]):
                        phone_line = (
                            f" Ring {profile.phone} for ændringer."
                            if getattr(profile, "phone", None) else ""
                        )
                        text = (
                            f"Påmindelse: bord til {r.party_size} hos {biz} {when}."
                            f"{phone_line} Vi ses!"
                        )
                        outcome = sms_service.send_sms(
                            to=r.guest_phone, text=text,
                            sender=settings.get("sms_sender"),
                        )
                        channel = "sms"
                        if outcome.get("ok"):
                            sms_used[r.user_id] += 1

                # ── Email fallback (no SMS, or SMS send failed) ────────
                if (channel is None or not outcome.get("ok")) and r.guest_email:
                    from app.services.email_service import send_email
                    html = (
                        f"<p>Hej {r.guest_name},</p>"
                        f"<p>Bare en venlig påmindelse om din reservation hos "
                        f"<strong>{biz}</strong>:</p>"
                        f"<p>{r.starts_at.strftime('%d/%m/%Y %H:%M')} · {r.party_size} personer</p>"
                        f"<p>Vi glæder os til at se dig! Skriv eller ring til os, "
                        f"hvis du skal ændre eller aflyse.</p>"
                    )
                    send_email(
                        to=r.guest_email,
                        subject=f"Påmindelse — {biz} {when}",
                        html=html,
                        reply_to=getattr(owner, "email", None),
                    )
                    channel = "email"
                    outcome = {"ok": True}

                if channel and outcome.get("ok"):
                    r.reminder_sent_at = utc_now()
                    sent += 1
                    try:
                        db.add(NotificationLog(
                            id=uuid.uuid4(), user_id=r.user_id, staff_id=None,
                            channel=channel, event_type="reservation_reminder",
                            subject=f"Reminder {when}", body=f"{r.party_size} pers",
                            status="sent",
                        ))
                    except Exception:  # noqa: BLE001
                        pass
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
        from app.services import reservation_occupancy_service as occ_service
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
                # Rule-based AI signals are guest-derived (Art. 9-adjacent) too —
                # purge them on the same schedule as the confirmed fields.
                r.allergy_ai_tags = None
                r.allergy_ai_severity = None
                r.allergy_ai_generic = False
                r.allergy_ai_confirmed = False
                r.allergy_ai_matched = None
                r.note_intent = None
                r.guest_consent_marketing = False
                r.purged_at = now
                # A row past purge_after is well after its service date — the
                # slot is long gone. Release any still-active occupancy rows so
                # the exclusion constraint isn't holding a stale future-dated
                # table hostage (defence-in-depth; normally already inactive).
                occ_service.release_occupancy(db, r.id)
                purged += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning("reservation purge failed for %s: %s", r.id, exc)
        db.commit()
    finally:
        db.close()
    if purged:
        logger.info("reservations purged (GDPR): %d", purged)
    return purged
