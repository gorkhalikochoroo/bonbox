"""Every email about a reservation — to the guest and to the owner.

Before this module the booking mail was scattered across three files, Danish
only, and not trustworthy: the confirmation stamped `confirmation_sent_at`
even when the send failed, a guest cancelling online told the owner only by a
push most owners never enabled, and a guest whose booking the venue cancelled,
confirmed or moved was told nothing at all.

One module now owns:

  • the templates — guest and owner, Danish and English, dates written here in
    code ("mandag 28. september kl. 17:30" / "Monday 28 September at 17:30")
    so nothing depends on the server's locale;
  • the language — a guest email is written in Reservation.guest_lang (what
    the guest booked in), else the venue's default (owner_language.
    venue_language); an owner email in owner_language.owner_lang(owner);
  • escaping — every piece of guest- or owner-supplied text goes through _e().
    Subjects are plain text, never HTML, so they are not escaped (a guest would
    see a literal "&amp;"); newlines are collapsed instead;
  • delivery — `deliver()`: send_email, ONE retry after RETRY_DELAY_SECONDS
    when it fails, and a NotificationLog row either way. The row carries no
    PII: body is "reservation:<id>", subject a fixed label, error a short code;
  • the caps —
      – per (venue, mailbox) confirmations a day (the public form must not be
        a relay aimed at a stranger's inbox), also used by the expiry mail;
      – per reservation: GUEST_EMAILS_PER_RESERVATION_PER_DAY guest emails
        per rolling 24 h, so an owner editing back and forth cannot spam;
      – per owner: GUEST_EMAILS_PER_OWNER_PER_DAY guest emails per rolling
        24 h across all bookings (lower while the owner's own e-mail is
        unconfirmed), so many bookings cannot do what one may not;
      – "you cancelled" goes only to a guest we have already mailed about
        that booking — otherwise the public form + the cancel link would be a
        way around the confirmation cap.

Everything here runs OFF the request path (FastAPI BackgroundTasks or the
nightly jobs), because a failed send retries after a sleep. A send never
raises: callers get True/False.

Guest PII never reaches a log line or a NotificationLog row from this module.
"""
import html as _html
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings as app_config
from app.database import SessionLocal
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.staff import NotificationLog
from app.models.user import User
from app.services.allergens import allergen_label
from app.services.mailbox import count_same_mailbox
from app.services.owner_language import owner_lang, venue_language
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

# ── Knobs ──────────────────────────────────────────────────────────────
# One retry, a moment later: a Resend hiccup is usually gone in a second.
RETRY_DELAY_SECONDS = 1.5
# Confirmations one venue may send to one MAILBOX per day. A guest who books,
# cancels and rebooks is normal and must not be throttled into silence; a
# script pointing the venue's confirmation at a stranger is not. Three covers
# both. (Was public_reservations._CONFIRMATIONS_PER_ADDRESS_PER_DAY.)
CONFIRMATIONS_PER_ADDRESS_PER_DAY = 3
# Guest emails about ONE reservation per rolling 24 h — confirmation, moves,
# cancellation, reminder together. A real booking needs two or three.
GUEST_EMAILS_PER_RESERVATION_PER_DAY = 5
# Guest emails from ONE venue (owner) per rolling 24 h, every kind together.
# The per-reservation cap alone did not bound an owner: bookings are free to
# create with any guest address, so an account could move them back and forth
# and mail strangers at the request rate (sweep, 8 Oct). A busy venue's real
# day — a confirmation and a reminder per online booking, plus moves and
# cancellations — stays far below this; a throw-away signup whose own e-mail
# was never confirmed gets the lower ceiling.
GUEST_EMAILS_PER_OWNER_PER_DAY = 300
GUEST_EMAILS_PER_OWNER_PER_DAY_UNCONFIRMED = 100

# ── NotificationLog.event_type (the column is VARCHAR(50)) ────────────
GUEST_CONFIRMATION = "guest_confirmation"
GUEST_CANCELLED_BY_GUEST = "guest_cancelled_by_guest"
GUEST_CANCELLED_BY_VENUE = "guest_cancelled_by_venue"
GUEST_REQUEST_CONFIRMED = "guest_request_confirmed"
GUEST_MOVED = "guest_moved"
GUEST_REMINDER = "guest_reminder"
GUEST_REQUEST_EXPIRED = "guest_request_expired"
OWNER_NEW_BOOKING = "owner_new_booking"
OWNER_GUEST_CANCELLED = "owner_guest_cancelled"

GUEST_EVENTS = frozenset({
    GUEST_CONFIRMATION, GUEST_CANCELLED_BY_GUEST, GUEST_CANCELLED_BY_VENUE,
    GUEST_REQUEST_CONFIRMED, GUEST_MOVED, GUEST_REMINDER, GUEST_REQUEST_EXPIRED,
})

# NotificationLog.subject — a fixed, PII-free label per event.
_LOG_LABELS = {
    GUEST_CONFIRMATION: "Guest email: booking confirmation",
    GUEST_CANCELLED_BY_GUEST: "Guest email: you cancelled",
    GUEST_CANCELLED_BY_VENUE: "Guest email: cancelled by the venue",
    GUEST_REQUEST_CONFIRMED: "Guest email: request confirmed",
    GUEST_MOVED: "Guest email: booking moved",
    GUEST_REMINDER: "Guest email: day-before reminder",
    GUEST_REQUEST_EXPIRED: "Guest email: request not confirmed",
    OWNER_NEW_BOOKING: "Owner email: new online booking",
    OWNER_GUEST_CANCELLED: "Owner email: guest cancelled online",
}

LANGS = ("da", "en")


# ── Language ───────────────────────────────────────────────────────────

def normalize_lang(value) -> str | None:
    """"da"/"en" from a language tag ("da", "EN", "en-GB", "da_DK"); None for
    anything else — including non-strings — so a client sending junk gets the
    venue's default language instead of an error."""
    if not isinstance(value, str):
        return None
    code = value.strip().lower().replace("_", "-").split("-", 1)[0]
    return code if code in LANGS else None


def guest_language(r, profile, owner) -> str:
    """The language the guest booked in, else the venue's default."""
    return normalize_lang(getattr(r, "guest_lang", None)) or venue_language(profile, owner)


# ── Dates, written here (never the server locale) ──────────────────────

_WEEKDAYS = {
    "da": ("mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"),
    "en": ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"),
}
_MONTHS = {
    "da": ("januar", "februar", "marts", "april", "maj", "juni", "juli",
           "august", "september", "oktober", "november", "december"),
    "en": ("January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"),
}


def format_date(dt: datetime, lang: str, *, now: datetime | None = None) -> str:
    """"mandag 28. september" / "Monday 28 September" — with the year only
    when it is not this year."""
    lang = lang if lang in LANGS else "en"
    weekday = _WEEKDAYS[lang][dt.weekday()]
    month = _MONTHS[lang][dt.month - 1]
    year = f" {dt.year}" if dt.year != (now or datetime.now()).year else ""
    if lang == "da":
        return f"{weekday} {dt.day}. {month}{year}"
    return f"{weekday} {dt.day} {month}{year}"


def format_when(dt: datetime | None, lang: str, *, now: datetime | None = None) -> str:
    """"mandag 28. september kl. 17:30" / "Monday 28 September at 17:30"."""
    if dt is None:
        return ""
    day = format_date(dt, lang, now=now)
    hhmm = f"{dt.hour:02d}:{dt.minute:02d}"
    return f"{day} kl. {hhmm}" if lang == "da" else f"{day} at {hhmm}"


def to_naive_local(dt: datetime | None, owner) -> datetime | None:
    """starts_at is stored naive business-local; anything tz-aware (a client
    that sent an offset) is brought into the owner's wall clock first."""
    if dt is None or dt.tzinfo is None:
        return dt
    from app.services.tz_utils import now_local
    return dt.astimezone(now_local(owner).tzinfo).replace(tzinfo=None)


def starts_in_future(r, owner, *, now: datetime | None = None) -> bool:
    """Is the booking still ahead? starts_at is naive LOCAL wall-clock, so it
    is compared with the owner's local "now" (as the reminder job does) — a
    UTC comparison would be off by the offset."""
    start = to_naive_local(getattr(r, "starts_at", None), owner)
    if start is None:
        return False
    if now is None:
        from app.services.tz_utils import now_local
        now = now_local(owner).replace(tzinfo=None)
    return start > now


def same_start(a: datetime | None, b: datetime | None, owner) -> bool:
    return to_naive_local(a, owner) == to_naive_local(b, owner)


# ── Text helpers ───────────────────────────────────────────────────────

def _e(value) -> str:
    """HTML-escape anything a guest or an owner typed."""
    return _html.escape(str(value if value is not None else ""), quote=True)


def _subject(text: str) -> str:
    """A subject is plain text: never escaped, but no line breaks."""
    return " ".join(str(text or "").split())


def _party(n, lang: str) -> str:
    n = int(n or 0)
    if lang == "da":
        return "1 person" if n == 1 else f"{n} personer"
    return "1 person" if n == 1 else f"{n} people"


def _party_short(n, lang: str) -> str:
    n = int(n or 0)
    if lang == "da":
        return f"{n} pers"
    return "1 guest" if n == 1 else f"{n} guests"


_SEVERITY = {
    "da": {"preference": "præference", "intolerance": "intolerance", "severe": "alvorlig"},
    "en": {"preference": "preference", "intolerance": "intolerance", "severe": "severe"},
}

_FONT = ("font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,"
         "sans-serif;font-size:15px;line-height:1.5;color:#111827")
_MUTED = "color:#6b7280;font-size:13px"
# The owner email's existing call-to-action button (black, rounded).
_BUTTON = ("display:inline-block;background:#111827;color:#ffffff;padding:10px 18px;"
           "border-radius:10px;text-decoration:none;font-weight:600")


def _button(url: str | None, label: str) -> str:
    if not url:
        return ""
    return f'<p><a href="{_e(url)}" style="{_BUTTON}">{_e(label)}</a></p>'


def _shell(lang: str, body: str, footer: str = "") -> str:
    return f'<div lang="{lang}" style="{_FONT}">{body}{footer}</div>'


# ── The venue, as the guest sees it ────────────────────────────────────

@dataclass(frozen=True)
class Venue:
    name: str
    phone: str | None = None
    address: str | None = None
    booking_url: str | None = None   # the public booking page ("book again")
    reply_to: str | None = None      # the owner's inbox


def _app_base_url() -> str:
    from app.services.daily_brief_email import _app_base_url as base
    return base()


def public_booking_url(profile, *, lang: str | None = None) -> str | None:
    """The venue's public booking page. `lang` ("da"/"en") rides along as
    ?lang= so the page opens in the language the guest booked in."""
    slug = getattr(profile, "reservation_slug", None) if profile is not None else None
    if not slug:
        return None
    try:
        lang = normalize_lang(lang)
        return f"{_app_base_url()}/r/{slug}" + (f"?lang={lang}" if lang else "")
    except Exception:  # noqa: BLE001 — a link is never a hard dependency
        return None


def venue_context(owner, profile, *, guest_lang: str | None = None) -> Venue:
    name = (getattr(owner, "business_name", None)
            or getattr(profile, "company_name", None) or "BonBox")
    phone = None
    if profile is not None:
        # The reservation "call us" number wins, as on the public page.
        try:
            from app.services import reservation_service as rsvc
            phone = rsvc.load_settings(profile).get("contact_phone")
        except Exception:  # noqa: BLE001
            phone = None
        phone = phone or getattr(profile, "phone", None)
    # public_address first: `address` is the bookkeeping address and may carry
    # a floor and door that were never meant for guests (same rule as the page).
    address = None
    if profile is not None:
        address = (getattr(profile, "public_address", None)
                   or getattr(profile, "address", None))
    return Venue(
        name=str(name).strip() or "BonBox",
        phone=(" ".join(str(phone).split()) or None) if phone else None,
        address=(" ".join(str(address).split()) or None) if address else None,
        booking_url=public_booking_url(profile, lang=guest_lang),
        reply_to=(getattr(owner, "email", None) or None),
    )


def guest_cancel_url(profile, r) -> str | None:
    """Booking-lifetime signed self-cancel deep-link for guest messages.

    TTL = hours-until-start + 48h grace (min 24h) so a confirmation sent days
    ahead never expires before the guest can use it. None if unbuildable — the
    link is a nice-to-have, never a hard dependency of a send. The URL carries
    a server-minted booking-poll token; the visitor SPA seeds it into the
    existing token-cancel flow (no new route). When the guest booked in a
    known language, &lang= makes the receipt open in it on any device."""
    try:
        slug = getattr(profile, "reservation_slug", None) if profile is not None else None
        if not slug:
            return None
        from app.services.qr_signer import sign_booking_token
        ttl = 24
        if r.starts_at:
            delta_h = (r.starts_at - datetime.now()).total_seconds() / 3600.0
            ttl = max(24, int(delta_h) + 48)
        token = sign_booking_token(str(r.id), ttl_hours=ttl)
        lang = normalize_lang(getattr(r, "guest_lang", None))
        return (f"{_app_base_url()}/r/{slug}?booking={r.id}&token={token}"
                + (f"&lang={lang}" if lang else ""))
    except Exception:  # noqa: BLE001 — never block a send
        return None


def owner_booking_url(r, owner) -> str:
    """Deep link to this booking in the owner's book, on the BUSINESS day it
    belongs to (a 00:30 seating is last night's service — the book files it
    there, so a calendar-date link would land on the wrong day)."""
    base = f"{app_config.FRONTEND_URL.rstrip('/')}/reservations?booking={r.id}"
    start = to_naive_local(getattr(r, "starts_at", None), owner)
    if start is None:
        return base
    try:
        from app.services.tz_utils import _user_cutoff_hour
        cutoff = _user_cutoff_hour(owner)
    except Exception:  # noqa: BLE001
        cutoff = 6
    day = (start - timedelta(hours=cutoff)).date()
    return f"{base}&date={day.isoformat()}"


# ── Template pieces ────────────────────────────────────────────────────

def _is_appointment(r) -> bool:
    return bool(getattr(r, "service_name", None))


def _hello(r, lang: str) -> str:
    name = (getattr(r, "guest_name", None) or "").strip()
    word = "Hej" if lang == "da" else "Hi"
    return f"<p>{word} {_e(name)},</p>" if name else f"<p>{word},</p>"


def _details(r, venue: Venue, lang: str, *, when: str) -> str:
    what = _e(r.service_name) if _is_appointment(r) else _party(r.party_size, lang)
    lines = [f"<strong>{_e(venue.name)}</strong>", f"{_e(when)} · {what}"]
    if venue.address:
        lines.append(_e(venue.address))
    return "<p>" + "<br>".join(lines) + "</p>"


def _allergy_line(r, lang: str, label: str, *, severity: bool = False) -> str:
    """"<label> (severity): Peanuts, Milk — <note>". `label` is our own word,
    without the colon."""
    tags = [t for t in (getattr(r, "allergen_tags", None) or []) if isinstance(t, str)]
    note = (getattr(r, "allergy_note", None) or "").strip()
    if not tags and not note:
        return ""
    names = ", ".join(allergen_label(t, lang) for t in tags)
    parts = [p for p in (_e(names), _e(note)) if p]
    sev = ""
    if severity:
        level = _SEVERITY.get(lang, _SEVERITY["en"]).get(getattr(r, "allergy_severity", None) or "")
        if level:
            sev = f" ({_e(level)})"
    return f"<p><strong>{label}{sev}:</strong> {' — '.join(parts)}</p>"


def _cancel_line(url: str | None, lang: str, *, is_request: bool, appointment: bool) -> str:
    if not url:
        return ""
    href = _e(url)
    if lang == "da":
        if is_request:
            return (f'<p>Har du fået andre planer? <a href="{href}">Træk din '
                    f'forespørgsel tilbage her</a>.</p>')
        what = "tiden" if appointment else "bordet"
        return (f'<p>Kan du ikke komme? <a href="{href}">Aflys din reservation her</a>, '
                f'så en anden gæst kan få {what}.</p>')
    if is_request:
        return f'<p>Plans changed? <a href="{href}">Withdraw your request here</a>.</p>'
    what = "the slot" if appointment else "the table"
    return (f'<p>Can\'t make it? <a href="{href}">Cancel your booking here</a> '
            f'so another guest can have {what}.</p>')


def _call_us(venue: Venue, lead: str) -> str:
    """A sentence ending in the venue's phone number, as a tel: link. `lead`
    is our own sentence start (never user text), e.g. "Ring til os på"."""
    if not venue.phone:
        return ""
    tel = "".join(c for c in venue.phone if c.isdigit() or c == "+")
    return f'<p>{lead} <a href="tel:{_e(tel)}">{_e(venue.phone)}</a>.</p>'


def _guest_footer(venue: Venue, lang: str) -> str:
    name = _e(venue.name)
    if lang == "da":
        text = "Sendt via BonBox" + (f" på vegne af {name}." if venue.name != "BonBox" else ".")
        if venue.reply_to:
            text += " Du kan svare direkte på denne e-mail."
    else:
        text = "Sent via BonBox" + (f" on behalf of {name}." if venue.name != "BonBox" else ".")
        if venue.reply_to:
            text += " You can reply to this email directly."
    return f'<p style="{_MUTED};margin-top:24px">{text}</p>'


def _sign_off(venue: Venue, lang: str) -> str:
    word = "Venlig hilsen" if lang == "da" else "Kind regards"
    return f"<p>{word}<br>{_e(venue.name)}</p>"


# ── Guest templates: (subject, html) ───────────────────────────────────

def render_guest_confirmation(r, venue: Venue, lang: str, *, cancel_url: str | None = None,
                              now: datetime | None = None) -> tuple[str, str]:
    """(a) Booked online: confirmed, or — for a group request — received."""
    is_request = r.status == "requested"
    when = format_when(r.starts_at, lang, now=now)
    if lang == "da":
        if is_request:
            subject = f"{venue.name} — forespørgsel modtaget: {when}"
            lead = ("<p>Tak for din forespørgsel — vi har modtaget den og vender "
                    "tilbage hurtigst muligt.</p>")
            note = "<p>Bordet er først reserveret, når du har fået en bekræftelse fra os.</p>"
            outro = ""
        else:
            subject = f"{venue.name} — reservation bekræftet: {when}"
            lead = "<p>Din reservation er bekræftet.</p>"
            note = ""
            outro = "<p>Vi glæder os til at se dig.</p>"
        allergy = _allergy_line(r, lang, "Allergi noteret")
    else:
        if is_request:
            subject = f"{venue.name} — request received: {when}"
            lead = ("<p>Thanks for your request — we've received it and will get back "
                    "to you as soon as we can.</p>")
            note = "<p>Your table isn't held until you've had a confirmation from us.</p>"
            outro = ""
        else:
            subject = f"{venue.name} — booking confirmed: {when}"
            lead = "<p>Your booking is confirmed.</p>"
            note = ""
            outro = "<p>We look forward to seeing you.</p>"
        allergy = _allergy_line(r, lang, "Allergy noted")
    body = (
        _hello(r, lang) + lead + _details(r, venue, lang, when=when) + allergy + note
        + _cancel_line(cancel_url, lang, is_request=is_request, appointment=_is_appointment(r))
        + outro
    )
    return _subject(subject), _shell(lang, body, _guest_footer(venue, lang))


def render_guest_cancelled_by_guest(r, venue: Venue, lang: str, *, was_request: bool = False,
                                    now: datetime | None = None) -> tuple[str, str]:
    """(b) The guest cancelled online — confirm it, offer another day."""
    when = format_when(r.starts_at, lang, now=now)
    appointment = _is_appointment(r)
    if lang == "da":
        if was_request:
            subject = f"{venue.name} — din forespørgsel er trukket tilbage"
            lead = "<p>Din forespørgsel er trukket tilbage. Tak fordi du sagde til.</p>"
        else:
            subject = f"{venue.name} — din reservation er aflyst"
            what = "tiden" if appointment else "bordet"
            lead = (f"<p>Din reservation er aflyst. Tak fordi du sagde til — så kan "
                    f"{what} gå til en anden gæst.</p>")
        again = "<p>Vil du finde en anden dag?</p>" + _button(venue.booking_url, "Book igen")
        outro = "<p>Vi håber at se dig en anden gang.</p>"
    else:
        if was_request:
            subject = f"{venue.name} — your request is withdrawn"
            lead = "<p>Your request has been withdrawn. Thanks for letting us know.</p>"
        else:
            subject = f"{venue.name} — your booking is cancelled"
            what = "the slot" if appointment else "the table"
            lead = (f"<p>Your booking is cancelled. Thanks for letting us know — now "
                    f"{what} can go to another guest.</p>")
        again = "<p>Want to find another day?</p>" + _button(venue.booking_url, "Book again")
        outro = "<p>We hope to see you another time.</p>"
    if not venue.booking_url:
        again = ""
    body = _hello(r, lang) + lead + _details(r, venue, lang, when=when) + again + outro
    return _subject(subject), _shell(lang, body, _guest_footer(venue, lang))


def render_guest_cancelled_by_venue(r, venue: Venue, lang: str, *, was_request: bool = False,
                                    now: datetime | None = None) -> tuple[str, str]:
    """(c) The venue cancelled the booking (or declined the request) in the app.

    Worded neutrally on purpose: the owner app records the same "cancelled"
    whether the venue had to cancel or the guest phoned to cancel, so the mail
    must read right in both cases."""
    when = format_when(r.starts_at, lang, now=now)
    if lang == "da":
        if was_request:
            subject = f"{venue.name} — vi kunne ikke bekræfte din forespørgsel"
            lead = "<p>Vi kunne desværre ikke bekræfte din forespørgsel.</p>"
            call = _call_us(venue, "Ring gerne til os, hvis du vil finde en anden tid:")
        else:
            subject = f"{venue.name} — din reservation er aflyst: {when}"
            lead = "<p>Din reservation er blevet aflyst.</p>"
            call = _call_us(venue, "Er det en overraskelse, eller vil du finde en anden tid? "
                                   "Ring til os på")
        if not call:
            call = "<p>Har du spørgsmål, så svar blot på denne e-mail.</p>" if venue.reply_to else ""
        again = _button(venue.booking_url, "Book en anden dag")
    else:
        if was_request:
            subject = f"{venue.name} — we couldn't confirm your request"
            lead = "<p>We're sorry — we couldn't confirm your request.</p>"
            call = _call_us(venue, "Call us if you'd like to find another time:")
        else:
            subject = f"{venue.name} — your booking has been cancelled: {when}"
            lead = "<p>Your booking has been cancelled.</p>"
            call = _call_us(venue, "If this comes as a surprise, or you'd like another time, "
                                   "call us on")
        if not call:
            call = "<p>If you have any questions, just reply to this email.</p>" if venue.reply_to else ""
        again = _button(venue.booking_url, "Book another day")
    body = (_hello(r, lang) + lead + _details(r, venue, lang, when=when) + call + again
            + _sign_off(venue, lang))
    return _subject(subject), _shell(lang, body, _guest_footer(venue, lang))


def render_guest_request_confirmed(r, venue: Venue, lang: str, *, cancel_url: str | None = None,
                                   now: datetime | None = None) -> tuple[str, str]:
    """(d) The venue accepted a group request (requested → confirmed)."""
    when = format_when(r.starts_at, lang, now=now)
    if lang == "da":
        subject = f"{venue.name} — din forespørgsel er bekræftet: {when}"
        lead = ("<p>Gode nyheder: vi har bekræftet din forespørgsel, og bordet er "
                "reserveret til jer.</p>")
        allergy = _allergy_line(r, lang, "Allergi noteret")
        outro = "<p>Vi glæder os til at se jer.</p>"
    else:
        subject = f"{venue.name} — your request is confirmed: {when}"
        lead = "<p>Good news: we've confirmed your request and your table is held.</p>"
        allergy = _allergy_line(r, lang, "Allergy noted")
        outro = "<p>We look forward to seeing you.</p>"
    body = (
        _hello(r, lang) + lead + _details(r, venue, lang, when=when) + allergy
        + _cancel_line(cancel_url, lang, is_request=False, appointment=_is_appointment(r))
        + outro
    )
    return _subject(subject), _shell(lang, body, _guest_footer(venue, lang))


def render_guest_moved(r, venue: Venue, lang: str, *, old_starts_at: datetime | None,
                       cancel_url: str | None = None,
                       now: datetime | None = None) -> tuple[str, str]:
    """(e) The venue moved the booking to a new date/time."""
    is_request = r.status == "requested"
    when = format_when(r.starts_at, lang, now=now)
    old_when = format_when(old_starts_at, lang, now=now) if old_starts_at else ""
    what = _e(r.service_name) if _is_appointment(r) else _party(r.party_size, lang)
    if lang == "da":
        noun = "forespørgsel" if is_request else "reservation"
        subject = f"{venue.name} — ny tid for din {noun}: {when}"
        lead = ("<p>Vi har ændret tidspunktet for din forespørgsel.</p>" if is_request
                else "<p>Vi har flyttet din reservation til en ny tid.</p>")
        new_label, old_label = "Ny tid:", "Før:"
        pending = ("<p>Forespørgslen er endnu ikke bekræftet — vi vender tilbage.</p>"
                   if is_request else "")
        call = _call_us(venue, "Passer den nye tid ikke? Ring til os på")
        outro = "" if is_request else "<p>Vi glæder os til at se dig.</p>"
    else:
        noun = "request" if is_request else "booking"
        subject = f"{venue.name} — new time for your {noun}: {when}"
        lead = ("<p>We've changed the time of your request.</p>" if is_request
                else "<p>We've moved your booking to a new time.</p>")
        new_label, old_label = "New time:", "Was:"
        pending = ("<p>Your request isn't confirmed yet — we'll get back to you.</p>"
                   if is_request else "")
        call = _call_us(venue, "If the new time doesn't work for you, call us on")
        outro = "" if is_request else "<p>We look forward to seeing you.</p>"
    lines = [f"<strong>{_e(venue.name)}</strong>",
             f"{new_label} <strong>{_e(when)}</strong> · {what}"]
    if old_when:
        lines.append(f'<span style="{_MUTED}">{old_label} <s>{_e(old_when)}</s></span>')
    if venue.address:
        lines.append(_e(venue.address))
    details = "<p>" + "<br>".join(lines) + "</p>"
    body = (
        _hello(r, lang) + lead + details + pending + call
        + _cancel_line(cancel_url, lang, is_request=is_request, appointment=_is_appointment(r))
        + outro
    )
    return _subject(subject), _shell(lang, body, _guest_footer(venue, lang))


def render_guest_reminder(r, venue: Venue, lang: str, *, cancel_url: str | None = None,
                          now: datetime | None = None) -> tuple[str, str]:
    """(f) The day-before reminder (the nightly job decides WHO gets one)."""
    when = format_when(r.starts_at, lang, now=now)
    what = _e(r.service_name) if _is_appointment(r) else _party(r.party_size, lang)
    where = f"<br>{_e(venue.address)}" if venue.address else ""
    appointment = _is_appointment(r)
    if lang == "da":
        subject = f"Påmindelse — {venue.name}, {when}"
        lead = (f"<p>Bare en venlig påmindelse om din reservation hos "
                f"<strong>{_e(venue.name)}</strong>:</p>")
        tail = (_cancel_line(cancel_url, lang, is_request=False, appointment=appointment)
                + "<p>Vi glæder os til at se dig.</p>") if cancel_url else (
                "<p>Vi glæder os til at se dig! Skriv eller ring til os, hvis du skal "
                "ændre eller aflyse.</p>")
    else:
        subject = f"Reminder — {venue.name}, {when}"
        lead = (f"<p>Just a friendly reminder of your booking at "
                f"<strong>{_e(venue.name)}</strong>:</p>")
        tail = (_cancel_line(cancel_url, lang, is_request=False, appointment=appointment)
                + "<p>We look forward to seeing you.</p>") if cancel_url else (
                "<p>We look forward to seeing you! Write or call us if you need to "
                "change or cancel.</p>")
    body = _hello(r, lang) + lead + f"<p>{_e(when)} · {what}{where}</p>" + tail
    return _subject(subject), _shell(lang, body, _guest_footer(venue, lang))


def render_guest_request_expired(r, venue: Venue, lang: str, *,
                                 now: datetime | None = None) -> tuple[str, str]:
    """An unanswered group request was closed before the sitting."""
    when = format_when(r.starts_at, lang, now=now)
    party = _party(r.party_size, lang)
    if lang == "da":
        subject = f"{venue.name} — vi kunne ikke bekræfte din forespørgsel"
        lead = (f"<p>Vi kunne desværre ikke bekræfte din forespørgsel om bord til "
                f"{party} {_e(when)}.</p>")
        call = _call_us(venue, "Ring gerne, hvis du stadig gerne vil komme:")
        again = _button(venue.booking_url, "Book en anden dag")
        outro = "<p>Beklager ventetiden.</p>"
    else:
        subject = f"{venue.name} — we couldn't confirm your request"
        lead = (f"<p>We're sorry — we couldn't confirm your request for a table for "
                f"{party} on {_e(when)}.</p>")
        call = _call_us(venue, "Please call us if you'd still like to come:")
        again = _button(venue.booking_url, "Book another day")
        outro = "<p>Sorry for the wait.</p>"
    body = _hello(r, lang) + lead + call + again + outro
    return _subject(subject), _shell(lang, body, _guest_footer(venue, lang))


# ── Owner templates ────────────────────────────────────────────────────

def _owner_guest_block(r, lang: str, *, when: str) -> str:
    name = (getattr(r, "guest_name", None) or "").strip() or ("Gæst" if lang == "da" else "Guest")
    bits = []
    if r.guest_phone:
        bits.append(("Tlf: " if lang == "da" else "Phone: ") + _e(r.guest_phone))
    if r.guest_email:
        bits.append(("E-mail: " if lang == "da" else "Email: ") + _e(r.guest_email))
    contact = " · ".join(bits) or (
        "Ingen kontaktinfo opgivet" if lang == "da" else "No contact details given")
    return (f"<p><strong>{_e(name)}</strong> · {_party(r.party_size, lang)}<br>"
            f"{_e(when)}<br>{contact}</p>")


def _owner_reply_hint(r, lang: str) -> str:
    if not r.guest_email:
        return ""
    text = ("Svar på denne e-mail for at skrive direkte til gæsten." if lang == "da"
            else "Reply to this email to write to the guest directly.")
    return f'<p style="{_MUTED};margin-top:24px">{text}</p>'


def render_owner_new_booking(r, venue: Venue, lang: str, *, booking_url: str,
                             now: datetime | None = None) -> tuple[str, str]:
    """A guest booked via /r/<slug>: who, when, contact, notes, allergy."""
    is_request = r.status == "requested"
    when = format_when(r.starts_at, lang, now=now)
    if lang == "da":
        head = "Ny forespørgsel" if is_request else "Ny reservation"
        subject = f"{venue.name} — {head.lower()}: {_party_short(r.party_size, lang)} · {when}"
        title = f"<p><strong>{head} via din bookingside</strong></p>"
        service = (f"<p><strong>Behandling:</strong> {_e(r.service_name)}</p>"
                   if _is_appointment(r) else "")
        occasion = f"<p><strong>Anledning:</strong> {_e(r.occasion)}</p>" if r.occasion else ""
        notes = f"<p><strong>Besked:</strong> {_e(r.guest_notes)}</p>" if r.guest_notes else ""
        allergy = _allergy_line(r, lang, "Allergi", severity=True)
        waiting = "<p>Gæsten venter på dit svar.</p>" if is_request else ""
        cta = "Åbn og bekræft" if is_request else "Åbn reservationen"
    else:
        head = "New request" if is_request else "New booking"
        subject = f"{venue.name} — {head.lower()}: {_party_short(r.party_size, lang)} · {when}"
        title = f"<p><strong>{head} via your booking page</strong></p>"
        service = (f"<p><strong>Service:</strong> {_e(r.service_name)}</p>"
                   if _is_appointment(r) else "")
        occasion = f"<p><strong>Occasion:</strong> {_e(r.occasion)}</p>" if r.occasion else ""
        notes = f"<p><strong>Message:</strong> {_e(r.guest_notes)}</p>" if r.guest_notes else ""
        allergy = _allergy_line(r, lang, "Allergy", severity=True)
        waiting = "<p>The guest is waiting for your answer.</p>" if is_request else ""
        cta = "Open and confirm" if is_request else "Open the booking"
    body = (title + _owner_guest_block(r, lang, when=when) + service + occasion + notes
            + allergy + waiting + _button(booking_url, cta))
    return _subject(subject), _shell(lang, body, _owner_reply_hint(r, lang))


def render_owner_guest_cancelled(r, venue: Venue, lang: str, *, booking_url: str,
                                 was_request: bool = False,
                                 now: datetime | None = None) -> tuple[str, str]:
    """A guest cancelled (or withdrew a request) via the self-cancel link."""
    when = format_when(r.starts_at, lang, now=now)
    appointment = _is_appointment(r)
    if lang == "da":
        if was_request:
            subject = (f"{venue.name} — forespørgsel trukket tilbage: "
                       f"{_party_short(r.party_size, lang)} · {when}")
            title = "<p><strong>En gæst har trukket sin forespørgsel tilbage</strong></p>"
            freed = "<p>Der var ikke reserveret noget bord.</p>"
        else:
            subject = f"{venue.name} — aflyst af gæsten: {_party_short(r.party_size, lang)} · {when}"
            title = "<p><strong>En gæst har aflyst via din bookingside</strong></p>"
            freed = ("<p>Tiden er ledig igen.</p>" if appointment
                     else "<p>Bordet er ledigt igen.</p>")
        cta = "Se dagens reservationer"
    else:
        if was_request:
            subject = (f"{venue.name} — request withdrawn: "
                       f"{_party_short(r.party_size, lang)} · {when}")
            title = "<p><strong>A guest withdrew their request</strong></p>"
            freed = "<p>No table was held.</p>"
        else:
            subject = (f"{venue.name} — cancelled by the guest: "
                       f"{_party_short(r.party_size, lang)} · {when}")
            title = "<p><strong>A guest cancelled via your booking page</strong></p>"
            freed = ("<p>The slot is free again.</p>" if appointment
                     else "<p>The table is free again.</p>")
        cta = "See the day's bookings"
    body = title + _owner_guest_block(r, lang, when=when) + freed + _button(booking_url, cta)
    return _subject(subject), _shell(lang, body, _owner_reply_hint(r, lang))


# ── Delivery ───────────────────────────────────────────────────────────

def _ledger_key(reservation_id) -> str:
    # Indexed column (ix_notiflog_dedup): the per-reservation cap and the
    # "mailed before?" check are an index lookup, not a scan of the whole log.
    return f"rsv-mail:{reservation_id}"


def _plausible_address(addr: str) -> bool:
    """One address, no list. The owner's edit form does not validate the
    address the way the public form does."""
    return (0 < len(addr) <= 254 and addr.count("@") == 1
            and not any(c.isspace() or c in ",;<>" for c in addr))


def _email_configured() -> bool:
    try:
        from app.services import email_service as es
        return bool(getattr(es.resend, "api_key", None))
    except Exception:  # noqa: BLE001 — unknown → let the retry happen
        return True


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


def _send_once(to: str, subject: str, html: str, reply_to: str | None) -> tuple[bool, str | None]:
    # Looked up per call (not imported at module load) so a test that patches
    # email_service.send_email reaches every reservation mail.
    from app.services import email_service as es
    try:
        ok = es.send_email(to=to, subject=subject, html=html, reply_to=reply_to)
    except Exception as exc:  # noqa: BLE001 — send_email should not raise; if it does, it failed
        logger.warning("reservation email send raised %s", type(exc).__name__)
        return False, "send_error"
    return (True, None) if ok else (False, "send_failed")


def _send_with_retry(to: str, subject: str, html: str,
                     reply_to: str | None) -> tuple[bool, str | None]:
    ok, err = _send_once(to, subject, html, reply_to)
    if ok:
        return True, None
    if not _email_configured():
        # No API key is not a hiccup — a retry would only hold the task.
        return False, ("not_configured" if err == "send_failed" else err)
    _sleep(RETRY_DELAY_SECONDS)
    return _send_once(to, subject, html, reply_to)


def _log(db: Session | None, *, owner_id, reservation_id, event_type: str,
         status: str, error: str | None = None) -> None:
    """One NotificationLog row per email decision. No PII: no address, no
    name, no allergy — body is "reservation:<id>", subject a fixed label.

    Inside a SAVEPOINT so a failed log write can never roll back the caller's
    own work (e.g. the confirmation_sent_at stamp that stops a re-send)."""
    if db is None:
        return
    try:
        with db.begin_nested():
            db.add(NotificationLog(
                id=uuid.uuid4(), user_id=owner_id, staff_id=None, channel="email",
                event_type=event_type,
                subject=_LOG_LABELS.get(event_type, "Reservation email"),
                body=f"reservation:{reservation_id}",
                status=status, error_message=error,
                dedup_key=_ledger_key(reservation_id),
            ))
            db.flush()
    except Exception as exc:  # noqa: BLE001 — losing an audit row is acceptable
        logger.warning("reservation email log write failed (reservation=%s): %s",
                       reservation_id, type(exc).__name__)


def _guest_mail_query(db: Session, owner_id, reservation_id):
    return (
        db.query(NotificationLog.id)
        .filter(
            NotificationLog.dedup_key == _ledger_key(reservation_id),
            NotificationLog.user_id == owner_id,
            NotificationLog.channel == "email",
            NotificationLog.status == "sent",
            NotificationLog.event_type.in_(GUEST_EVENTS),
        )
    )


def guest_emails_sent_last_24h(db: Session, owner_id, reservation_id) -> int:
    since = utc_now() - timedelta(days=1)
    return int(
        _guest_mail_query(db, owner_id, reservation_id)
        .filter(NotificationLog.created_at >= since)
        .with_entities(func.count(NotificationLog.id))
        .scalar() or 0
    )


def guest_emails_sent_by_owner_last_24h(db: Session, owner_id) -> int:
    """Guest emails this venue's owner had DELIVERED in the last 24 hours,
    across every booking (failed / capped rows and mail to the owner do not
    count)."""
    since = utc_now() - timedelta(days=1)
    return int(
        db.query(func.count(NotificationLog.id))
        .filter(
            NotificationLog.user_id == owner_id,
            NotificationLog.channel == "email",
            NotificationLog.status == "sent",
            NotificationLog.event_type.in_(GUEST_EVENTS),
            NotificationLog.created_at >= since,
        )
        .scalar() or 0
    )


def guest_email_owner_cap(db: Session, owner_id) -> int:
    """This owner's rolling-24h guest-mail ceiling: the lower one until the
    owner's own e-mail address is confirmed."""
    verified = db.query(User.email_verified).filter(User.id == owner_id).scalar()
    return (GUEST_EMAILS_PER_OWNER_PER_DAY if verified is True
            else GUEST_EMAILS_PER_OWNER_PER_DAY_UNCONFIRMED)


def owner_guest_mail_capped(db: Session, owner_id) -> int | None:
    """The ceiling when this owner has reached it, else None. Raises when the
    count itself fails — the caller decides (deliver() refuses to send)."""
    cap = guest_email_owner_cap(db, owner_id)
    return cap if guest_emails_sent_by_owner_last_24h(db, owner_id) >= cap else None


def owner_cap_notice(cap: int) -> dict:
    """What the owner's edit / status answer carries when the guest was not
    e-mailed because the venue reached its daily guest-mail ceiling. The
    change itself is saved."""
    return {
        "code": "guest_email_owner_cap",
        "cap": int(cap),
        "message": (
            f"Saved. The guest was not e-mailed: BonBox has sent {cap} guest e-mails "
            "for your venue in the last 24 hours, the most it sends. Let the guest know yourself."
        ),
        "message_da": (
            f"Gemt. Gæsten fik ingen e-mail: BonBox har sendt {cap} gæstemails for dit sted "
            "det seneste døgn, og flere sender BonBox ikke. Giv selv gæsten besked."
        ),
    }


def deliver(db: Session | None, *, owner_id, reservation_id, event_type: str,
            to: str | None, subject: str, html: str,
            reply_to: str | None = None) -> bool:
    """Send one reservation email: cap check (guest mail), send, one retry,
    log row. True only when the provider accepted it. Never raises."""
    to = (to or "").strip()
    is_guest = event_type in GUEST_EVENTS
    if not to:
        return False
    if is_guest and db is None:
        # Without a session there is no cap and no ledger — refuse rather than
        # send uncounted mail to an address a stranger may have typed.
        return False
    if not _plausible_address(to):
        _log(db, owner_id=owner_id, reservation_id=reservation_id,
             event_type=event_type, status="failed", error="bad_address")
        return False
    if is_guest:
        try:
            capped = (guest_emails_sent_last_24h(db, owner_id, reservation_id)
                      >= GUEST_EMAILS_PER_RESERVATION_PER_DAY)
            reason = "capped"
            if not capped and owner_guest_mail_capped(db, owner_id) is not None:
                # The venue's own daily ceiling, across all its bookings.
                capped, reason = True, "owner_capped"
        except Exception:  # noqa: BLE001 — couldn't check → don't send
            capped, reason = True, "cap_check_error"
        if capped:
            logger.warning("guest email suppressed: %s (reservation=%s, event=%s)",
                           reason, reservation_id, event_type)
            _log(db, owner_id=owner_id, reservation_id=reservation_id,
                 event_type=event_type, status="failed", error=reason)
            return False
    ok, err = _send_with_retry(to, subject, html, reply_to)
    _log(db, owner_id=owner_id, reservation_id=reservation_id, event_type=event_type,
         status="sent" if ok else "failed", error=err)
    if not ok:
        logger.warning("reservation email not delivered (reservation=%s, event=%s, reason=%s)",
                       reservation_id, event_type, err)
    return ok


# ── Caps ───────────────────────────────────────────────────────────────

def confirmation_quota_left(db: Session, owner_id, email: str) -> bool:
    """Has this venue already mailed this address enough for one day?

    Without a bound, the public booking form is an open relay: anyone can make
    BonBox send branded mail to any address, from our sending domain, reply-to
    the venue, at the public rate limit. That is a deliverability risk to every
    other owner on the platform, not just this one.

    Counted from reservations: confirmation_sent_at is stamped on every
    DELIVERED confirmation, so the ledger exists. Counted by MAILBOX, not by
    spelling (services/mailbox.py): "anna+1@…", "anna+2@…" and
    "a.nna@gmail.com" all land in one inbox."""
    since = utc_now() - timedelta(days=1)
    sent_to = (
        db.query(Reservation.guest_email)
        .filter(Reservation.user_id == owner_id,
                Reservation.guest_email.isnot(None),
                Reservation.confirmation_sent_at.isnot(None),
                Reservation.confirmation_sent_at >= since)
        .all()
    )
    n = count_same_mailbox((a for (a,) in sent_to), email)
    return n < CONFIRMATIONS_PER_ADDRESS_PER_DAY


def guest_heard_from_us(db: Session, r) -> bool:
    """Did this guest already get an email from us about THIS booking?"""
    if getattr(r, "confirmation_sent_at", None) is not None:
        return True
    return _guest_mail_query(db, r.user_id, r.id).first() is not None


# ── Guest sends ────────────────────────────────────────────────────────

def send_guest_confirmation(db: Session | None, owner, profile, r) -> bool:
    """(a) Confirmation — or "request received" for a group request.
    Stamps confirmation_sent_at ONLY when the email was delivered."""
    if db is None or not r.guest_email or r.confirmation_sent_at is not None:
        return False
    # Skip quietly: the BOOKING is real and committed, and the guest sees the
    # reference on screen. A relay attempt must not become an error.
    if not confirmation_quota_left(db, r.user_id, r.guest_email):
        logger.warning("confirmation suppressed: per-address daily cap reached (owner=%s)",
                       r.user_id)
        _log(db, owner_id=r.user_id, reservation_id=r.id, event_type=GUEST_CONFIRMATION,
             status="failed", error="address_capped")
        return False
    lang = guest_language(r, profile, owner)
    venue = venue_context(owner, profile, guest_lang=getattr(r, "guest_lang", None))
    subject, html = render_guest_confirmation(r, venue, lang,
                                              cancel_url=guest_cancel_url(profile, r))
    ok = deliver(db, owner_id=r.user_id, reservation_id=r.id, event_type=GUEST_CONFIRMATION,
                 to=r.guest_email, subject=subject, html=html, reply_to=venue.reply_to)
    if ok:
        r.confirmation_sent_at = utc_now()
    return ok


def send_guest_cancelled_by_guest(db: Session | None, owner, profile, r, *,
                                  was_request: bool = False) -> bool:
    """(b) "Your booking is cancelled" after the guest's own online cancel.

    Only to a guest we have already mailed about this booking. The cancel link
    works for any booking, including the ones whose confirmation the
    per-address cap withheld — without this rule, book-then-cancel would mail
    a stranger past that cap. A guest who never got a confirmation cancelled
    from the page itself, which already told them."""
    if db is None or not r.guest_email:
        return False
    if not guest_heard_from_us(db, r):
        _log(db, owner_id=r.user_id, reservation_id=r.id, event_type=GUEST_CANCELLED_BY_GUEST,
             status="failed", error="no_prior_mail")
        return False
    lang = guest_language(r, profile, owner)
    venue = venue_context(owner, profile, guest_lang=getattr(r, "guest_lang", None))
    subject, html = render_guest_cancelled_by_guest(r, venue, lang, was_request=was_request)
    return deliver(db, owner_id=r.user_id, reservation_id=r.id,
                   event_type=GUEST_CANCELLED_BY_GUEST, to=r.guest_email,
                   subject=subject, html=html, reply_to=venue.reply_to)


def send_guest_cancelled_by_venue(db: Session | None, owner, profile, r, *,
                                  was_request: bool = False) -> bool:
    """(c) The owner cancelled (or declined) a booking still ahead."""
    if db is None or not r.guest_email or r.status != "cancelled":
        return False
    if not starts_in_future(r, owner):
        return False
    lang = guest_language(r, profile, owner)
    venue = venue_context(owner, profile, guest_lang=getattr(r, "guest_lang", None))
    subject, html = render_guest_cancelled_by_venue(r, venue, lang, was_request=was_request)
    return deliver(db, owner_id=r.user_id, reservation_id=r.id,
                   event_type=GUEST_CANCELLED_BY_VENUE, to=r.guest_email,
                   subject=subject, html=html, reply_to=venue.reply_to)


def send_guest_request_confirmed(db: Session | None, owner, profile, r) -> bool:
    """(d) The owner accepted a group request that is still ahead."""
    if db is None or not r.guest_email or r.status != "confirmed":
        return False
    if not starts_in_future(r, owner):
        return False
    lang = guest_language(r, profile, owner)
    venue = venue_context(owner, profile, guest_lang=getattr(r, "guest_lang", None))
    subject, html = render_guest_request_confirmed(r, venue, lang,
                                                   cancel_url=guest_cancel_url(profile, r))
    return deliver(db, owner_id=r.user_id, reservation_id=r.id,
                   event_type=GUEST_REQUEST_CONFIRMED, to=r.guest_email,
                   subject=subject, html=html, reply_to=venue.reply_to)


def send_guest_moved(db: Session | None, owner, profile, r, *,
                     old_starts_at: datetime | None) -> bool:
    """(e) The owner moved a live booking to a new date/time. Nothing when the
    time did not actually change (the owner app always sends starts_at)."""
    if db is None or not r.guest_email or r.status not in ("requested", "confirmed"):
        return False
    if old_starts_at is not None and same_start(old_starts_at, r.starts_at, owner):
        return False
    if not starts_in_future(r, owner):
        return False
    lang = guest_language(r, profile, owner)
    venue = venue_context(owner, profile, guest_lang=getattr(r, "guest_lang", None))
    subject, html = render_guest_moved(r, venue, lang,
                                       old_starts_at=to_naive_local(old_starts_at, owner),
                                       cancel_url=guest_cancel_url(profile, r))
    return deliver(db, owner_id=r.user_id, reservation_id=r.id, event_type=GUEST_MOVED,
                   to=r.guest_email, subject=subject, html=html, reply_to=venue.reply_to)


def send_guest_reminder(db: Session | None, owner, profile, r) -> bool:
    """(f) Day-before reminder. The job owns the window, the status and the
    per-mailbox cap; this owns the words and the delivery."""
    if db is None or not r.guest_email:
        return False
    lang = guest_language(r, profile, owner)
    venue = venue_context(owner, profile, guest_lang=getattr(r, "guest_lang", None))
    subject, html = render_guest_reminder(r, venue, lang,
                                          cancel_url=guest_cancel_url(profile, r))
    return deliver(db, owner_id=r.user_id, reservation_id=r.id, event_type=GUEST_REMINDER,
                   to=r.guest_email, subject=subject, html=html, reply_to=venue.reply_to)


def send_guest_request_expired(db: Session | None, owner, profile, r) -> bool:
    """"We couldn't confirm your request" — the request-expiry sweep's mail.

    Bound by the same per-address cap as the confirmation: a group request is
    a plain insert that always succeeds, so a caller could park unlimited rows
    against one typed address, and this sweep would mail every one of them."""
    if db is None or not r.guest_email:
        return False
    if not confirmation_quota_left(db, r.user_id, r.guest_email):
        logger.warning("request-expiry mail suppressed: per-address daily cap reached "
                       "(owner=%s reservation=%s)", r.user_id, r.id)
        _log(db, owner_id=r.user_id, reservation_id=r.id, event_type=GUEST_REQUEST_EXPIRED,
             status="failed", error="address_capped")
        return False
    lang = guest_language(r, profile, owner)
    venue = venue_context(owner, profile, guest_lang=getattr(r, "guest_lang", None))
    subject, html = render_guest_request_expired(r, venue, lang)
    return deliver(db, owner_id=r.user_id, reservation_id=r.id,
                   event_type=GUEST_REQUEST_EXPIRED, to=r.guest_email,
                   subject=subject, html=html, reply_to=venue.reply_to)


# ── Owner sends ────────────────────────────────────────────────────────

def send_owner_new_booking(db: Session | None, owner, profile, r) -> bool:
    """The dependable companion to the owner push (which only lands when the
    owner enabled notifications). Replying goes to the guest."""
    to = (getattr(owner, "email", None) or "").strip()
    if not to:
        return False
    lang = owner_lang(owner)
    subject, html = render_owner_new_booking(r, venue_context(owner, profile), lang,
                                             booking_url=owner_booking_url(r, owner))
    return deliver(db, owner_id=r.user_id, reservation_id=r.id, event_type=OWNER_NEW_BOOKING,
                   to=to, subject=subject, html=html, reply_to=(r.guest_email or None))


def send_owner_guest_cancelled(db: Session | None, owner, profile, r, *,
                               was_request: bool = False) -> bool:
    """A guest cancelled online — who, when, party, contact, and a link to that
    day's book. Email because the push lands only for owners who enabled it."""
    to = (getattr(owner, "email", None) or "").strip()
    if not to:
        return False
    lang = owner_lang(owner)
    subject, html = render_owner_guest_cancelled(r, venue_context(owner, profile), lang,
                                                 booking_url=owner_booking_url(r, owner),
                                                 was_request=was_request)
    return deliver(db, owner_id=r.user_id, reservation_id=r.id,
                   event_type=OWNER_GUEST_CANCELLED, to=to, subject=subject, html=html,
                   reply_to=(r.guest_email or None))


# ── Background entry point for the owner's actions in the app ──────────

VENUE_CHANGES = ("request_confirmed", "cancelled_by_venue", "moved")


def run_venue_change(reservation_id: str, owner_id: str, change: str, *,
                     prev_status: str | None = None,
                     old_starts_at: str | None = None,
                     new_starts_at: str | None = None) -> None:
    """FastAPI BackgroundTasks entry point: tell the guest what the venue just
    did (confirmed their request, cancelled, moved the booking).

    Runs after the response on a FRESH session, re-fetching by id — the
    request's session is gone. Re-checks the state it was queued for, so a
    mail is never sent about a change that was already undone (confirmed and
    flipped back, moved and moved again). Never raises."""
    if change not in VENUE_CHANGES:
        return
    db = SessionLocal()
    try:
        r = (
            db.query(Reservation)
            .filter(Reservation.id == reservation_id,
                    Reservation.user_id == owner_id,
                    Reservation.is_deleted.is_(False))
            .first()
        )
        owner = db.query(User).filter(User.id == owner_id).first()
        if r is None or owner is None:
            return
        profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == owner_id).first()
        if change == "request_confirmed":
            send_guest_request_confirmed(db, owner, profile, r)
        elif change == "cancelled_by_venue":
            send_guest_cancelled_by_venue(db, owner, profile, r,
                                          was_request=(prev_status == "requested"))
        elif change == "moved":
            if new_starts_at and r.starts_at is not None:
                current = to_naive_local(r.starts_at, owner)
                if current.isoformat() != new_starts_at:
                    return   # moved again since — that edit sends its own mail
            old = datetime.fromisoformat(old_starts_at) if old_starts_at else None
            send_guest_moved(db, owner, profile, r, old_starts_at=old)
        db.commit()
    except Exception:  # noqa: BLE001 — never let a mail break anything
        logger.exception("reservation email task failed (change=%s)", change)
        db.rollback()
    finally:
        db.close()
