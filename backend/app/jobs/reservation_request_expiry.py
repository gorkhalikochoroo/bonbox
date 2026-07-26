"""A group request must get an answer — even when the owner never gives one.

A party above the venue's threshold books as status="requested": no table
is held, the owner decides. Nothing ever expired those rows. So the
common small-venue failure — the owner simply doesn't get to it — left
the guest in permanent limbo: the page stops polling after ~2 minutes, no
email is ever sent, and the evening they asked for can pass with nobody
telling them yes or no.

That is the highest-revenue booking type failing in the quietest possible
way. A large party that gets no answer either double-books elsewhere (the
venue loses covers it thought it had) or turns up unconfirmed with twelve
people, which is worse.

So: an unanswered request is declined before the sitting, and the guest is
told. Declining is the honest outcome — we know the table was never held,
so "no" is true, and it is what lets the guest make other plans while
there is still time to.

Deliberately NOT a cancellation of anything real: only rows still sitting
at "requested" are touched. The moment an owner confirms or declines, the
sweep leaves it alone forever.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.user import User
from app.utils.time import utc_now

_TZ = ZoneInfo("Europe/Copenhagen")


def _now_local() -> datetime:
    """Naive Copenhagen wall-clock — the same frame reservations are
    stored in. Not a convenience: a UTC comparison here silently shifts
    the deadline by the offset."""
    return datetime.now(_TZ).replace(tzinfo=None)


logger = logging.getLogger(__name__)

# How long before the sitting an unanswered request is closed out. Far
# enough ahead that the guest can still book somewhere else; late enough
# that an owner who checks the app once a day has had a fair chance.
EXPIRE_BEFORE_START_HOURS = 6


def expire_stale_requests(db: Session | None = None) -> dict:
    """Decline requests the owner never answered, and tell the guest.

    Runs nightly. Never raises — a failure here must not take the rest of
    maintenance down with it.
    """
    own_session = db is None
    db = db or SessionLocal()
    expired, notified = 0, 0
    try:
        # starts_at is stored as NAIVE EUROPE/COPENHAGEN wall-clock (the
        # booking engine's frame — see public_reservations._now_local), so
        # the cutoff has to be built in that frame too. Comparing against
        # naive UTC made the sweep fire two hours out in Danish summer:
        # the "six hours before" promise would really have been four.
        cutoff = _now_local() + timedelta(hours=EXPIRE_BEFORE_START_HOURS)
        rows = (
            db.query(Reservation)
            .filter(
                Reservation.status == "requested",
                Reservation.is_deleted.is_(False),
                Reservation.starts_at <= cutoff,
            )
            .all()
        )
        for r in rows:
            r.status = "cancelled"
            r.cancelled_at = utc_now()
            # Distinct from "guest_cancelled" and from an owner decline —
            # a year later this row should still say plainly that nobody
            # answered, not imply the guest changed their mind.
            r.cancel_reason = "request_expired_no_answer"
            expired += 1
        if expired:
            db.commit()

        # Mail AFTER the commit: the decision is durable first, and a mail
        # failure must never leave a row half-expired.
        for r in rows:
            if _tell_the_guest(db, r):
                notified += 1
    except Exception:  # noqa: BLE001
        logger.warning("reservation request expiry sweep failed", exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
    finally:
        if own_session:
            db.close()

    return {"requests_expired": expired, "guests_notified": notified}


def _tell_the_guest(db: Session, r: Reservation) -> bool:
    """Best-effort "we couldn't take it" mail. Silence is the bug we are
    fixing, so a send failure is logged rather than swallowed."""
    if not r.guest_email:
        return False
    try:
        from app.services.email_service import send_email
        import html as _html

        owner = db.query(User).filter(User.id == r.user_id).first()
        profile = (
            db.query(BusinessProfile)
            .filter(BusinessProfile.user_id == r.user_id)
            .first()
        )
        biz = (
            getattr(owner, "business_name", None)
            or getattr(profile, "company_name", None)
            or "Restauranten"
        )
        when = r.starts_at.strftime("%d/%m/%Y") if r.starts_at else ""
        phone = getattr(profile, "phone", None)
        ring = (
            f'<p>Ring gerne på <a href="tel:{_html.escape(phone)}">'
            f"{_html.escape(phone)}</a>, hvis du stadig gerne vil komme.</p>"
            if phone else ""
        )
        send_email(
            to=r.guest_email,
            subject=f"{biz} — vi kunne ikke bekræfte din forespørgsel",
            html=(
                f"<p>Hej {_html.escape(r.guest_name or '')},</p>"
                f"<p>Vi kunne desværre ikke bekræfte din forespørgsel om bord "
                f"til {r.party_size} personer den {when}.</p>"
                f"{ring}"
                f"<p>Beklager ventetiden.</p>"
            ),
            reply_to=getattr(owner, "email", None),
        )
        return True
    except Exception:  # noqa: BLE001
        logger.warning("request-expiry mail failed for reservation=%s", r.id)
        return False
