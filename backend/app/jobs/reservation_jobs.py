"""Nightly reservation jobs — reminder emails + GDPR purge.

  • send_reservation_reminders() — day-before reminder for confirmed
    reservations (the v1 no-show defense, reminders-only). The email itself
    (bilingual, escaped, retried, logged) is services/reservation_emails.py;
    the SMS text is still written here, in Danish.
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
from app.services.mailbox import canonical_mailbox, count_same_mailbox
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

# Reminder emails one venue may send to one MAILBOX per day. A guest with a
# lunch and a dinner booking still gets both; a script that books the same
# stranger twenty times under "+tag" spellings gets three, not twenty — the
# same bound the booking confirmation already has, counted the same way
# (services/mailbox.py).
_REMINDERS_PER_MAILBOX_PER_DAY = 3


def reminder_sms_text(r, owner, *, biz: str, when: str, phone: str | None) -> str:
    """The day-before SMS, in Danish. A salon, a shop or a repair trade books
    a customer for a time (reservation_emails.speaks_appointments), and a
    booking with a service is a treatment: theirs reads "din aftale", never
    "bord til 1" (Push 8 review: a bike workshop's customer was reminded of
    "bord til 1 hos Cykelværkstedet Amager"). A restaurant's is unchanged."""
    from app.services.reservation_emails import speaks_appointments

    phone_line = f" Ring {phone} for ændringer." if phone else ""
    appointment = bool(getattr(r, "service_name", None)) or speaks_appointments(
        getattr(owner, "business_type", None)
    )
    if appointment:
        return f"Påmindelse: din aftale hos {biz} {when}.{phone_line} Vi ses!"
    return f"Påmindelse: bord til {r.party_size} hos {biz} {when}.{phone_line} Vi ses!"


def _sms_identity(owner, profile, settings) -> tuple[str, str | None]:
    """(name, phone) for the reminder SMS, as the booking page and the guest
    mails show them (venue_identity): the trading name, then the company
    name, never our product name or the demo seeder's sample company; the
    reservations "call us" number, then the Profile phone, never the seeded
    sample phone (a stranger's number). Each read has its own guard, so a
    reminder is never lost to it: no name reads "BonBox" (the known nameless
    gap, as in the mails), no phone drops the "Ring ..." line."""
    from app.services import venue_identity
    try:
        name = venue_identity.public_venue_name(owner, profile)
    except Exception:  # noqa: BLE001
        name = None
    try:
        phone = venue_identity.public_venue_contact(owner, profile, settings).get("phone")
    except Exception:  # noqa: BLE001
        phone = None
    return name or "BonBox", phone


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
    mailed: dict = {}     # (owner_id, mailbox) -> reminder emails in the last 24h
    owners: dict = {}
    profiles: dict = {}
    try:
        from app.services import reservation_service as rsvc
        from app.services import sms_service
        from app.services.billing import has_feature, at_cap
        from app.services.tz_utils import now_local

        now = utc_now()
        month_start = _month_start(now)
        # Reservation.starts_at is stored NAIVE in business-LOCAL wall-clock, so
        # we cannot compare it against an aware-UTC "now". The batch spans owners
        # in different timezones, so there's no single correct naive bound at the
        # DB layer — instead we widen the pre-filter by ±14h (covers every real
        # IANA offset) around the naive-UTC clock, then apply the EXACT per-owner
        # naive-local window inside the loop (now_local(owner) stripped to naive).
        naive_utc_now = now.replace(tzinfo=None)
        pre_lo = naive_utc_now - timedelta(hours=14)
        pre_hi = naive_utc_now + timedelta(hours=36 + 14)
        rows = (
            db.query(Reservation)
            .filter(
                Reservation.is_deleted.is_(False),
                Reservation.status == "confirmed",
                Reservation.reminder_sent_at.is_(None),
                Reservation.starts_at > pre_lo,
                Reservation.starts_at <= pre_hi,
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

                # Exact window in the OWNER's local wall-clock (naive vs naive):
                # the day-before reminder fires for a booking in the next ~36h.
                # starts_at is naive-local, so "now"/horizon must be naive-local
                # too — off-by-the-UTC-offset here would remind at the wrong time
                # (or skip a booking that's genuinely inside the 36h window).
                local_now = now_local(owner).replace(tzinfo=None)
                local_horizon = local_now + timedelta(hours=36)
                if not (local_now < r.starts_at <= local_horizon):
                    continue
                when = r.starts_at.strftime("%d/%m %H:%M")
                settings = rsvc.load_settings(profile)
                biz, venue_phone = _sms_identity(owner, profile, settings)

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
                        text = reminder_sms_text(
                            r, owner, biz=biz, when=when, phone=venue_phone,
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
                    key = (r.user_id, canonical_mailbox(r.guest_email))
                    if key not in mailed:
                        prior = (
                            db.query(Reservation.guest_email)
                            .filter(
                                Reservation.user_id == r.user_id,
                                Reservation.guest_email.isnot(None),
                                Reservation.reminder_sent_at.isnot(None),
                                Reservation.reminder_sent_at >= now - timedelta(days=1),
                            )
                            .all()
                        )
                        mailed[key] = count_same_mailbox((a for (a,) in prior), r.guest_email)
                    if mailed[key] >= _REMINDERS_PER_MAILBOX_PER_DAY:
                        # Left unsent (reminder_sent_at stays empty) — the
                        # booking is untouched; only the mail is withheld.
                        logger.warning(
                            "reminder suppressed: per-mailbox daily cap reached (owner=%s)",
                            r.user_id,
                        )
                        continue
                    # The words live in services/reservation_emails.py: in the
                    # guest's language, every typed value escaped (guest_name
                    # comes from an ANONYMOUS booker — raw, it let a stranger
                    # author HTML in mail from our own domain), one retry, and
                    # a NotificationLog row. It reports whether the mail really
                    # went out: a failed send no longer stamps reminder_sent_at,
                    # so tomorrow morning's run (still inside the window for a
                    # same-day booking) gets a second chance.
                    from app.services import reservation_emails
                    delivered = reservation_emails.send_guest_reminder(db, owner, profile, r)
                    channel = "email"
                    outcome = {"ok": bool(delivered)}
                    if delivered:
                        mailed[key] += 1

                if channel and outcome.get("ok"):
                    r.reminder_sent_at = utc_now()
                    sent += 1
                # The email path wrote its own NotificationLog row (event
                # "guest_reminder"). The row below is the SMS ledger that the
                # monthly SMS cap above counts — SMS only.
                if channel == "sms" and outcome.get("ok"):
                    # notification_log.staff_id is NOT NULL in prod (verified
                    # 2026-08-31) — the table was built from the model, which
                    # declares it non-nullable because it was originally "log of
                    # notifications sent to STAFF". A guest reservation reminder
                    # has no staff member, so this insert cannot succeed today.
                    #
                    # The old code wrapped db.add() in try/except and looked
                    # safe. It was not: db.add() only stages the object, so the
                    # IntegrityError fired at the batch db.commit() below —
                    # outside both handlers. That rolls back every
                    # reminder_sent_at in the batch AFTER the emails have already
                    # been sent, so the same guests would be reminded again the
                    # next night, and every night until their booking passes.
                    #
                    # SAVEPOINT so a failed log write can never cost us the
                    # reminder_sent_at that stops the re-send. Losing an audit
                    # row is acceptable; mailing a guest nightly is not.
                    try:
                        with db.begin_nested():
                            db.add(NotificationLog(
                                id=uuid.uuid4(), user_id=r.user_id, staff_id=None,
                                channel=channel, event_type="reservation_reminder",
                                subject=f"Reminder {when}", body=f"{r.party_size} pers",
                                status="sent",
                            ))
                            db.flush()   # force the INSERT inside the savepoint
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "reservation reminder logged send but could not write "
                            "notification_log for %s: %s", r.id, exc,
                        )
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
        from app.services.guest_erase import null_reservation_guest_fields
        for r in rows:
            try:
                # The guest PII, the allergy fields and the rule-based AI
                # signals (guest-derived, Art. 9-adjacent) — the ONE list
                # "Glem" nulls too (services/guest_erase.py, fix round 27 Oct).
                null_reservation_guest_fields(r, now)
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
