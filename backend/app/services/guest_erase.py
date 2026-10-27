"""A guest asks a venue to forget them — "Glem" (GDPR art. 17), fix round
27 Oct 2026 (review P2-2).

"Glem" used to remove only the contact's entries on the block list, while
its toast said nothing was kept: the guest's bookings kept their name, phone
and allergy notes until purge_after (~90 days), and waitlist rows up to 30.
Now, scoped to ONE venue (user_id), for the phone and/or the address the
owner types:

  • the block list's entries for the contact go (contact_marks.erase_contact);
  • waitlist rows (any source) lose the name, phone, e-mail and note at once
    — the fields the nightly purge nulls — and a waiting one leaves the list
    (public_waitlist.erase);
  • PAST bookings lose exactly the fields the nightly purge nulls
    (null_reservation_guest_fields, shared with jobs/reservation_jobs);
  • UPCOMING bookings are never erased silently: they keep the contact until
    the visit, and are COUNTED so the owner's confirm can say so ("aflys dem
    først, hvis gæsten bad om det"). Once the owner cancels one, it no longer
    counts as upcoming and the next "Glem" erases it.

MATCHING IS EXACT — never a tail and never a LIKE (a tail of 8 digits is
someone else's number abroad; a LIKE pattern can reach further than meant):
  • the phone: its digits, separators and "+" ignored, compared by equality
    with the few spellings ONE number has (`phone_spellings`: a Danish
    number with or without 45 / 0045, any other with or without 00);
  • the address: the same mailbox as R2 folds it (case, a "+tag", Gmail
    dots and googlemail.com — services/mailbox.canonical_mailbox), compared
    with equality, substr() and length() only (both exist in Postgres and
    SQLite, so the tests cover what production runs).
Every count is a SQL COUNT and every write a set of rows found by those
predicates — never a scan of the venue's rows in Python (the 31 Aug lesson).

The audit row carries counts only — never a name, a number or an address.
"""
from __future__ import annotations

import re
from datetime import datetime

from sqlalchemy import and_, func, or_

from app.models.reservation import Reservation
from app.models.reservation_waitlist import ReservationWaitlistEntry as W
from app.services.booking_screen import _PHONE_SEPARATORS
from app.services.mailbox import canonical_mailbox

# A booking still ahead keeps its contact until the visit (it is counted,
# never erased silently).
_UPCOMING = ("requested", "confirmed", "seated")


# ── The fields the nightly purge nulls (jobs/reservation_jobs) ───────────

def null_reservation_guest_fields(r, now: datetime) -> None:
    """GDPR: the guest PII and the allergy fields of one booking — the row
    stays for the venue's counts. The ONE list both the nightly purge
    (purge_expired_reservations) and "Glem" null, so they can never drift."""
    r.guest_name = None
    r.guest_email = None
    r.guest_phone = None
    r.guest_notes = None
    r.allergen_tags = None
    r.allergy_note = None
    r.allergy_severity = None
    r.occasion = None
    # Rule-based AI signals are guest-derived (Art. 9-adjacent) too.
    r.allergy_ai_tags = None
    r.allergy_ai_severity = None
    r.allergy_ai_generic = False
    r.allergy_ai_confirmed = False
    r.allergy_ai_matched = None
    r.note_intent = None
    r.guest_consent_marketing = False
    r.purged_at = now


# ── Exact matching ───────────────────────────────────────────────────────

def phone_spellings(phone: str | None) -> list[str]:
    """The digit strings ONE phone number can be stored as (separators and
    "+" already gone): a Danish number (8 digits, or 45 / 0045 + 8 digits)
    as 12345678, 4512345678 and 004512345678; any other as typed, with or
    without a leading 00. [] under 6 digits."""
    digits = re.sub(r"\D", "", phone or "")
    if len(digits) < 6:
        return []
    core = digits[2:] if digits.startswith("00") else digits
    if len(core) == 10 and core.startswith("45"):
        national = core[2:]
    elif len(core) == 8:
        national = core
    else:
        national = None
    if national is not None:
        return sorted({national, "45" + national, "0045" + national})
    return sorted({core, "00" + core})


def _digits(column):
    col = column
    for ch in _PHONE_SEPARATORS:
        col = func.replace(col, ch, "")
    return col


def phone_sql_exact(column, phone: str | None):
    """SQL: `column` holds the same number (exact, by equality). None when
    the phone has fewer than 6 digits."""
    spellings = phone_spellings(phone)
    if not spellings:
        return None
    return _digits(column).in_(spellings)


def _starts(expr, prefix: str):
    return func.substr(expr, 1, len(prefix)) == prefix


def _ends(expr, suffix: str):
    return and_(func.length(expr) >= len(suffix),
                func.substr(expr, func.length(expr) - len(suffix) + 1) == suffix)


def mailbox_sql_exact(column, email: str | None):
    """SQL: `column` holds an address that delivers to the SAME mailbox as
    `email` (R2's fold: case, a "+tag", Gmail dots, googlemail.com) — with
    equality, substr() and length() only, never LIKE. None when `email` is
    not an address."""
    canon = canonical_mailbox(email)
    local, sep, domain = canon.rpartition("@")
    if not sep or not local or not domain or " " in canon:
        return None
    col = func.lower(func.trim(column))
    if local.startswith("+"):
        # canonical_mailbox keeps a local part that STARTS with "+" whole.
        return col == canon
    if domain == "gmail.com":
        dotless = func.replace(col, ".", "")
        same = []
        for d in ("gmailcom", "googlemailcom"):
            same.append(dotless == f"{local}@{d}")
            same.append(and_(_starts(dotless, f"{local}+"), _ends(dotless, f"@{d}")))
        return and_(or_(_ends(col, "@gmail.com"), _ends(col, "@googlemail.com")), or_(*same))
    return or_(col == canon,
               and_(_starts(col, f"{local}+"), _ends(col, f"@{domain}")))


def contact_match(email_col, phone_col, *, email: str | None, phone: str | None):
    """The same contact: the same number OR the same mailbox. None when
    neither is usable."""
    conds = [c for c in (phone_sql_exact(phone_col, phone), mailbox_sql_exact(email_col, email))
             if c is not None]
    return or_(*conds) if conds else None


# ── What "Glem" reaches ───────────────────────────────────────────────────

def _upcoming(now_local: datetime):
    """A booking still ahead: not deleted, still on (requested, confirmed or
    seated), and its visit not over — a seated party is in the room."""
    return and_(Reservation.is_deleted.is_(False),
                Reservation.status.in_(_UPCOMING),
                or_(Reservation.ends_at > now_local, Reservation.status == "seated"))


def _reservations(db, owner_id, match):
    return db.query(Reservation).filter(Reservation.user_id == owner_id, match)


def counts(db, owner_id, *, email: str | None, phone: str | None,
           now_local: datetime) -> dict:
    """{"reservations", "waitlist", "future_kept"} — what "Glem" would
    erase at this venue (rows still holding guest data) and the upcoming
    bookings it keeps. COUNTs only; raises on a read error (the caller says
    "couldn't check", never "nothing kept")."""
    r_match = contact_match(Reservation.guest_email, Reservation.guest_phone,
                            email=email, phone=phone)
    w_match = contact_match(W.guest_email, W.guest_phone, email=email, phone=phone)
    if r_match is None or w_match is None:
        return {"reservations": 0, "waitlist": 0, "future_kept": 0}
    past = int(
        _reservations(db, owner_id, r_match)
        .filter(Reservation.purged_at.is_(None), ~_upcoming(now_local))
        .with_entities(func.count(Reservation.id)).scalar() or 0
    )
    kept = int(
        _reservations(db, owner_id, r_match)
        .filter(_upcoming(now_local))
        .with_entities(func.count(Reservation.id)).scalar() or 0
    )
    wait = int(
        db.query(func.count(W.id))
        .filter(W.user_id == owner_id, W.purged_at.is_(None), w_match)
        .scalar() or 0
    )
    return {"reservations": past, "waitlist": wait, "future_kept": kept}


def erase(db, owner_id, *, email: str | None, phone: str | None,
          now_local: datetime, now_utc: datetime) -> dict:
    """Erase the contact's past bookings and waitlist rows at this venue (the
    caller commits, with its audit row). → {"reservations", "waitlist",
    "future_kept"} as done."""
    from app.services import public_waitlist as pwl
    from app.services import reservation_occupancy_service as occ_service

    r_match = contact_match(Reservation.guest_email, Reservation.guest_phone,
                            email=email, phone=phone)
    w_match = contact_match(W.guest_email, W.guest_phone, email=email, phone=phone)
    if r_match is None or w_match is None:
        return {"reservations": 0, "waitlist": 0, "future_kept": 0}
    past = (
        _reservations(db, owner_id, r_match)
        .filter(Reservation.purged_at.is_(None), ~_upcoming(now_local))
        .all()
    )
    for r in past:
        null_reservation_guest_fields(r, now_utc)
        # As the nightly purge: a past booking holds no table (normally
        # released already; idempotent).
        occ_service.release_occupancy(db, r.id)
    rows = db.query(W).filter(W.user_id == owner_id, W.purged_at.is_(None), w_match).all()
    for w in rows:
        pwl.erase(w, now_utc)
    kept = int(
        _reservations(db, owner_id, r_match)
        .filter(_upcoming(now_local))
        .with_entities(func.count(Reservation.id)).scalar() or 0
    )
    return {"reservations": len(past), "waitlist": len(rows), "future_kept": kept}
