"""Ask the inbox owner — a login link on a never-confirmed account.

Manoj's decision (8 Oct): when an e-mail login link (or the legacy Apple
sign-in, or a login link to a changed, not yet confirmed address) lands in an
account whose address was NEVER confirmed, BonBox does not silently replace
the password. The link proves the inbox, so:

  1. the address is confirmed and the browser that opened the link is signed
     in (the router mints the session as for any login link);
  2. the account's password, its other devices and the revisor / host-stand
     access it handed out stay exactly as they are — for now;
  3. the inbox owner is ASKED: "Did you create this BonBox account yourself
     on <date> and choose the password?"
       keep    ("Ja, det var mig")     nothing changes;
       secure  ("Nej / Ved ikke")      services/auth.secure_account: password
               replaced, every session signed out (token_version), revisor
               grants and host-stand links closed.

Only a TICKET can answer (models/account_claim_ticket.py): a 30-minute page
ticket in the verify answer's body for the browser that opened the link, and a
7-day ticket in the one notice mail (two links, Keep / Secure) for old app
builds and anyone who closes the page. The answer endpoints take nothing but
the ticket — never an account id — so whoever set the password cannot answer:
they do not have the inbox.

The question is OPEN while the account holds a ticket that is neither used nor
voided. Expiry does not close it: an unanswered question is asked again on the
next proof of the inbox (a login link, a legacy Apple sign-in, a password
reset). The notice mail goes when the question opens and again on such a
proof once the newest mail is a day old (REMAIL_AFTER) — so a lost, failed or
expired mail never leaves an old app build without a way to answer, and a
day of sign-ins is still one mail. The first answer voids every other ticket
of the account; repeating the same answer with the same ticket changes
nothing (idempotent); a different answer, a voided ticket, an expired ticket
or an unknown one are refused.

While the question is open:
  * the login e-mail cannot be changed (routers/auth.update_profile):
    otherwise whoever set the password could move the account to another
    address and keep it out of the inbox owner's reach;
  * the account is NOT a confirmed sender (revisor_mail.sender_is_verified):
    the address is confirmed, but whoever set the password still holds a
    session, and a confirmed sender may mail fakturaer, team invitations,
    supplier orders and the revisor. Answering opens it again (review, 9 Oct).
"""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.account_claim_ticket import AccountClaimTicket
from app.models.user import User
from app.utils.time import utc_now

PAGE_TTL = timedelta(minutes=30)
MAIL_TTL = timedelta(days=7)
# An open question is mailed again on a new proof of the inbox once the newest
# open mail ticket is this old: a lost / failed / expired mail is replaced,
# and repeated sign-ins within a day are still one mail.
REMAIL_AFTER = timedelta(hours=24)
ANSWERS = ("keep", "secure")

ASKED_ACTION = "auth.claim.asked"
KEPT_ACTION = "auth.claim.kept"
SECURED_ACTION = "auth.claim.secured"

_DA_MONTHS = ["januar", "februar", "marts", "april", "maj", "juni", "juli",
              "august", "september", "oktober", "november", "december"]
_EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
              "August", "September", "October", "November", "December"]


def _hash(raw: str) -> str:
    return hashlib.sha256((raw or "").encode("utf-8")).hexdigest()


# ── The question ─────────────────────────────────────────────────────────


def created_on(user: User) -> date:
    """The day the account was created, in the owner's own timezone (the date
    the question names). created_at is stored as naive UTC."""
    created = getattr(user, "created_at", None) or utc_now()
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo((getattr(user, "timezone", None) or "Europe/Copenhagen"))
    except Exception:  # noqa: BLE001 — an unknown zone name never blocks a sign-in
        from zoneinfo import ZoneInfo
        tz = ZoneInfo("Europe/Copenhagen")
    return created.astimezone(tz).date()


def question_payload(user: User) -> dict:
    """What the page needs to ask: the creation DATE only (no time, nothing
    else about the account) and whether it was made with a password (every
    account here was: the question exists because a password was set before
    the address was confirmed)."""
    return {"created_at": created_on(user).isoformat(), "has_password": True}


def long_date(d: date, lang: str) -> str:
    if lang == "da":
        return f"{d.day}. {_DA_MONTHS[d.month - 1]} {d.year}"
    return f"{d.day} {_EN_MONTHS[d.month - 1]} {d.year}"


def question_open(db: Session, user: User) -> bool:
    return question_open_for(db, user.id)


def question_open_for(db: Session, user_id) -> bool:
    """The account `user_id` has an unanswered "did you create it?" question."""
    return (
        db.query(AccountClaimTicket.id)
        .filter(AccountClaimTicket.user_id == user_id,
                AccountClaimTicket.used_at.is_(None),
                AccountClaimTicket.voided_at.is_(None))
        .first()
        is not None
    )


def _newest_open_mail_at(db: Session, user: User):
    from sqlalchemy import func
    return (
        db.query(func.max(AccountClaimTicket.created_at))
        .filter(AccountClaimTicket.user_id == user.id,
                AccountClaimTicket.kind == "mail",
                AccountClaimTicket.used_at.is_(None),
                AccountClaimTicket.voided_at.is_(None))
        .scalar()
    )


def reset_in_open_question(db: Session, user_id) -> bool:
    """A password reset is part of the account's OPEN question: one of its
    unanswered tickets was made by a reset code. The password on the account
    is then the one the inbox owner chose with that code, so "Nej / Ved ikke"
    ends it too — whichever proof (a later login link, the app's "Send
    spørgsmålet igen") asks the question next (release gate review, 9 Oct)."""
    return (
        db.query(AccountClaimTicket.id)
        .filter(AccountClaimTicket.user_id == user_id,
                AccountClaimTicket.via == "password_reset",
                AccountClaimTicket.used_at.is_(None),
                AccountClaimTicket.voided_at.is_(None))
        .first()
        is not None
    )


def _new_ticket(db: Session, user: User, *, kind: str, via: str, ttl: timedelta,
                sign_in_ref=None) -> str:
    raw = secrets.token_urlsafe(32)
    now = utc_now()
    db.add(AccountClaimTicket(
        user_id=user.id, token_hash=_hash(raw), kind=kind, via=via,
        sign_in_ref=sign_in_ref, created_at=now, expires_at=now + ttl,
    ))
    return raw


@dataclass
class ClaimAsk:
    question: dict
    via: str
    page_ticket: str | None = None
    mail_ticket: str | None = None
    # A password reset is part of the open question (reset_in_open_question):
    # the mail says "Nej / Ved ikke" ends the password chosen with the code.
    after_reset: bool = False


def ask_inbox_owner(db: Session, user: User, *, via: str, sign_in_ref=None,
                    page_ticket: bool = True,
                    ip_address: str | None = None) -> ClaimAsk | None:
    """The inbox owner just proved this address (a login link, Apple's
    verified claim on the legacy route, or a password reset code). If the
    address was never confirmed, or an earlier question is still unanswered,
    confirm the address and open (or re-ask) the question. Nothing else on
    the account changes here.

    Returns None for a confirmed account with no open question — the usual
    sign-in. Otherwise a ClaimAsk: `page_ticket` for the browser that opened
    the link (when asked for), `mail_ticket` when this call OPENED the
    question, or re-asks one whose newest mail is REMAIL_AFTER old (a lost,
    failed or expired mail is replaced; at most one a day). The result is
    also left on the instance (`pending_ask`) for the route. The caller
    commits, THEN mails (the ticket mailed is the ticket stored).
    """
    # Two links opened at the same moment ask ONE question (one mail): the
    # account row is the lock (FOR UPDATE on Postgres; SQLite serialises
    # writers). Only the id is selected, so the loaded instance — and any
    # change the caller has not flushed yet — is left alone.
    user._claim_ask = None   # never a previous request's answer on a reused instance
    db.query(User.id).filter(User.id == user.id).with_for_update().first()
    already_open = question_open(db, user)
    unconfirmed = getattr(user, "email_verified", False) is not True
    if not already_open and not unconfirmed:
        return None
    if unconfirmed:
        user.email_verified = True
        user.verification_code = None
        user.verification_code_expires = None
    ask = ClaimAsk(question=question_payload(user), via=via,
                   after_reset=(via == "password_reset"
                                or (already_open and reset_in_open_question(db, user.id))))
    if not already_open:
        ask.mail_ticket = _new_ticket(db, user, kind="mail", via=via, ttl=MAIL_TTL)
        _audit(db, user, ASKED_ACTION, {"via": via}, ip_address)
    else:
        newest = _newest_open_mail_at(db, user)
        if newest is None or newest <= utc_now() - REMAIL_AFTER:
            ask.mail_ticket = _new_ticket(db, user, kind="mail", via=via, ttl=MAIL_TTL)
            _audit(db, user, ASKED_ACTION, {"via": via, "again": True}, ip_address)
    if page_ticket:
        ask.page_ticket = _new_ticket(db, user, kind="page", via=via, ttl=PAGE_TTL,
                                      sign_in_ref=sign_in_ref)
    db.flush()
    user._claim_ask = ask
    return ask


def pending_ask(user: User) -> ClaimAsk | None:
    """What ask_inbox_owner left on this instance in this request. Read it
    BEFORE a commit/refresh."""
    return getattr(user, "_claim_ask", None)


# ── The notice mail ──────────────────────────────────────────────────────


def question_email_html(lang: str, created: date, keep_url: str, secure_url: str,
                        with_apple: bool = False, via: str | None = None,
                        again: bool = False, after_reset: bool = False) -> tuple[str, str]:
    """(subject, html) of the mail that asks the question, to the inbox that
    was just proven. No value anybody typed goes in it; the two links open a
    page that asks once more before anything happens (a mail scanner opening
    the links changes nothing).

    The mail is built before any answer exists: the browser that opened a
    login link is asked on the page at the same moment, so the text holds
    for an owner who has already answered there too (review, 9 Oct).

    `again`: sent from the app's "Send spørgsmålet igen" (reask_by_mail) —
    nobody just signed in, so the intro says who asked, not "you just …".

    Asked after a password reset, "Nej / Ved ikke" also ends the password
    chosen with the reset code (services/auth.secure_account replaces the
    password, whichever it is) — the explanation says so (release gate,
    9 Oct). `after_reset`: a reset is part of the open question although
    THIS proof was another (a login link the day after the reset): the
    intro says what just happened, the question and "Nej" name the reset."""
    when = long_date(created, lang)
    reset_now = via == "password_reset"
    reset = reset_now or bool(after_reset)
    apple = with_apple or str(via or "").startswith("apple")
    if lang == "da":
        subject = "BonBox: Har du selv oprettet din konto?"
        if again:
            intro = ("Nogen, der er logget ind på din BonBox-konto, har bedt os sende dette "
                     "spørgsmål igen. Din e-mailadresse er bekræftet, men BonBox venter på dit svar.")
        elif reset_now:
            intro = ("Du har netop valgt en ny adgangskode til BonBox med en kode fra din e-mail, "
                     "og din e-mailadresse er nu bekræftet.")
        else:
            how = "med Apple" if apple else "med et login-link fra din e-mail"
            intro = f"Du er netop logget ind på BonBox {how}, og din e-mailadresse er nu bekræftet."
        if reset:
            question = f"Har du selv oprettet denne BonBox-konto den {when} og valgt den første adgangskode?"
        else:
            question = f"Har du selv oprettet denne BonBox-konto den {when} og valgt adgangskoden?"
        keep_label = "Ja, det var mig"
        secure_label = "Nej / Ved ikke – sikr min konto"
        if reset:
            explain = ("Ja: alt forbliver, som det er. Nej / Ved ikke: adgangskoden holder op med at "
                       "virke – også den nye, du valgte med koden fra din e-mail – alle enheder logges "
                       "ud, og revisoradgang og værtsskærme, der er givet, lukkes. Derefter vælger du "
                       "en ny adgangskode.")
        else:
            explain = ("Ja: alt forbliver, som det er. Nej / Ved ikke: den gamle adgangskode holder op "
                       "med at virke, alle enheder logges ud, og revisoradgang og værtsskærme, der er "
                       "givet, lukkes. Derefter vælger du en ny adgangskode.")
        small = ("Linkene virker i 7 dage, og kun ét svar tæller. Har du allerede svaret i BonBox, "
                 "skal du ikke gøre mere – så virker linkene ikke længere. Har du ikke svaret endnu, "
                 "er kontoen, som den er.")
    else:
        subject = "BonBox: Did you create your account yourself?"
        if again:
            intro = ("Someone signed in to your BonBox account asked us to send this question "
                     "again. Your e-mail address is confirmed, but BonBox is waiting for your answer.")
        elif reset_now:
            intro = ("You just chose a new BonBox password with a code from your e-mail, "
                     "and your e-mail address is now confirmed.")
        else:
            how = "with Apple" if apple else "with a login link from your e-mail"
            intro = f"You just signed in to BonBox {how}, and your e-mail address is now confirmed."
        if reset:
            question = f"Did you create this BonBox account yourself on {when} and choose its first password?"
        else:
            question = f"Did you create this BonBox account yourself on {when} and choose the password?"
        keep_label = "Yes, it was me"
        secure_label = "No / Not sure – secure my account"
        if reset:
            explain = ("Yes: everything stays as it is. No / Not sure: the password stops working – "
                       "including the new one you chose with the code from your e-mail – every "
                       "device is signed out, and revisor access and host-stand devices given out "
                       "are closed. Then you choose a new password.")
        else:
            explain = ("Yes: everything stays as it is. No / Not sure: the old password stops working, "
                       "every device is signed out, and revisor access and host-stand devices given "
                       "out are closed. Then you choose a new password.")
        small = ("The links work for 7 days, and only one answer counts. If you already answered in "
                 "BonBox, there is nothing more to do – the links then no longer work. If you have "
                 "not answered yet, the account stays as it is.")
    p = '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 12px">{}</p>'
    btn = ('<a href="{href}" style="display:inline-block;margin:4px 6px;padding:12px 22px;'
           'border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;{style}">{label}</a>')
    html = (
        "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
        "max-width:480px;margin:0 auto;padding:32px 24px;background:#fff\">"
        + p.format(intro)
        + '<p style="font-size:16px;color:#0f172a;line-height:1.5;margin:16px 0;font-weight:600">'
        + question + "</p>"
        + '<div style="text-align:center;margin:20px 0">'
        + btn.format(href=keep_url, label=keep_label,
                     style="background:#f1f5f9;color:#0f172a;border:1px solid #cbd5e1")
        + btn.format(href=secure_url, label=secure_label,
                     style="background:#0f172a;color:#ffffff")
        + "</div>"
        + p.format(explain)
        + '<p style="font-size:12px;color:#64748b;line-height:1.6;margin:16px 0 0">' + small + "</p>"
        + "</div>"
    )
    return subject, html


def send_question_mail(user: User, ask: ClaimAsk | None, *, again: bool = False) -> bool:
    """Best-effort, after the commit: the one notice mail with the two links
    (Keep / Secure), in the account's language. Never raises. `again`: the
    app's "Send spørgsmålet igen" (reask_by_mail)."""
    if not ask or not ask.mail_ticket:
        return False
    try:
        from app.config import settings
        from app.services.email_service import send_email
        from app.services.owner_language import owner_lang
        base = (settings.FRONTEND_URL or "https://bonbox.dk").rstrip("/")
        link = f"{base}/login/claim?token={ask.mail_ticket}"
        lang = owner_lang(user)
        subject, html = question_email_html(
            lang, date.fromisoformat(ask.question["created_at"]),
            f"{link}&answer=keep", f"{link}&answer=secure", via=ask.via, again=again,
            after_reset=ask.after_reset)
        return bool(send_email(user.email, subject, html))
    except Exception:  # noqa: BLE001 — the question stays open; the next proof
        # of the inbox a day on mails it again (ask_inbox_owner, REMAIL_AFTER)
        return False


# ── "Send spørgsmålet igen" from the app ─────────────────────────────────
#
# While the question is open, every third-party send says so (release gate,
# 9 Oct) and offers to e-mail the question again. The app's session only
# ASKS for the mail: the new ticket goes to the account's own (confirmed)
# inbox and nowhere else, so whoever set the password still cannot answer —
# only the inbox owner can. At most one question mail a day (REMAIL_AFTER,
# the same window the sign-in re-ask uses); a mail that fails to send does
# not use up the day (the route withdraws its ticket).

REMAIL_FAILED_EN = "BonBox couldn't send the e-mail just now. Try again in a few minutes."
REMAIL_FAILED_DA = "BonBox kunne ikke sende mailen lige nu. Prøv igen om et par minutter."


def _hours_until(when) -> int:
    import math
    secs = (when - utc_now()).total_seconds()
    return max(1, math.ceil(secs / 3600))


def reask_by_mail(db: Session, user: User, *, ip_address: str | None = None) -> ClaimAsk:
    """A new question mail (a 7-day mail ticket) for an account whose
    question is open and whose newest open question mail is a day old (or
    missing). Refuses: 409 no open question (or an unconfirmed address — the
    question only exists once the inbox was proven), 429 inside the day.
    The caller commits, THEN mails (send_question_mail(..., again=True))."""
    db.query(User.id).filter(User.id == user.id).with_for_update().first()
    if getattr(user, "email_verified", False) is not True or not question_open(db, user):
        raise _refuse(status.HTTP_409_CONFLICT, "claim_no_open_question",
                      "There is no open question on this account.",
                      "Der er ikke noget åbent spørgsmål på kontoen.")
    newest = _newest_open_mail_at(db, user)
    if newest is not None and newest > utc_now() - REMAIL_AFTER:
        hours = _hours_until(newest + REMAIL_AFTER)
        raise _refuse(
            status.HTTP_429_TOO_MANY_REQUESTS, "claim_remail_cooldown",
            ("BonBox e-mails this question at most once a day. You can ask for it again in "
             f"{hours} hour{'s' if hours != 1 else ''} — or sign in with a login link and answer "
             "it there right away."),
            ("BonBox mailer højst spørgsmålet én gang i døgnet. Du kan bede om det igen om "
             f"{hours} time{'r' if hours != 1 else ''} – eller logge ind med et login-link og "
             "svare der med det samme."),
            retry_after_hours=hours,
        )
    # The question as a whole, not its newest ticket: a reset anywhere in
    # the open question means the password on the account was chosen with
    # the reset code, so the mail (and the page — ticket_status) names the
    # FIRST password and says "Nej" ends the new one too. A later login-link
    # page ticket (via=magic_link) must not drop that (release gate review,
    # 9 Oct). Otherwise: how the question was FIRST asked (oldest ticket).
    if reset_in_open_question(db, user.id):
        via = "password_reset"
    else:
        via_row = (
            db.query(AccountClaimTicket.via)
            .filter(AccountClaimTicket.user_id == user.id,
                    AccountClaimTicket.used_at.is_(None),
                    AccountClaimTicket.voided_at.is_(None))
            .order_by(AccountClaimTicket.created_at.asc())
            .first()
        )
        via = (via_row[0] if via_row and via_row[0] else "magic_link")
    ask = ClaimAsk(question=question_payload(user), via=via,
                   after_reset=(via == "password_reset"))
    ask.mail_ticket = _new_ticket(db, user, kind="mail", via=via, ttl=MAIL_TTL)
    _audit(db, user, ASKED_ACTION, {"via": via, "again": True, "in_app": True}, ip_address)
    db.flush()
    return ask


def withdraw_mail_ticket(db: Session, raw: str | None) -> None:
    """The question mail with this ticket never left: drop the ticket, so the
    day's one mail is not used up by a send that failed. The question stays
    open (reask_by_mail only runs on an open question — other tickets hold
    it). The caller commits."""
    if not raw:
        return
    db.query(AccountClaimTicket).filter(
        AccountClaimTicket.token_hash == _hash(raw),
        AccountClaimTicket.kind == "mail",
        AccountClaimTicket.used_at.is_(None),
    ).delete(synchronize_session=False)


# ── The answer ───────────────────────────────────────────────────────────


@dataclass
class Decision:
    answer: str
    kind: str
    user: User
    already_decided: bool = False
    access_closed: bool = False


def _refuse(http_status: int, code: str, message: str, message_da: str, **extra):
    return HTTPException(status_code=http_status, detail={
        "code": code, "message": message, "message_da": message_da, **extra})


def _invalid():
    # 404, not 401: the app's 401 handler would send the page to /login.
    return _refuse(status.HTTP_404_NOT_FOUND, "claim_ticket_invalid",
                   "This link is invalid.", "Dette link er ugyldigt.")


def _expired():
    return _refuse(status.HTTP_410_GONE, "claim_ticket_expired",
                   "This question has expired. Sign in with a new login link and we'll ask again.",
                   "Spørgsmålet er udløbet. Log ind med et nyt login-link, så stiller vi det igen.")


def _already(decision: str | None):
    return _refuse(status.HTTP_409_CONFLICT, "claim_already_decided",
                   "This question has already been answered.",
                   "Spørgsmålet er allerede besvaret.", decision=decision)


def _find(db: Session, raw: str) -> AccountClaimTicket:
    if not raw or len(raw) < 43 or len(raw) > 128:
        raise _invalid()
    row = db.query(AccountClaimTicket).filter(AccountClaimTicket.token_hash == _hash(raw)).first()
    if row is None:
        raise _invalid()
    return row


def _decided_answer(db: Session, user_id) -> str | None:
    row = (
        db.query(AccountClaimTicket)
        .filter(AccountClaimTicket.user_id == user_id, AccountClaimTicket.used_at.isnot(None))
        .order_by(AccountClaimTicket.used_at.desc())
        .first()
    )
    return row.answer if row else None


def _audit(db: Session, user: User, action: str, after: dict, ip_address: str | None) -> None:
    try:
        from app.services import audit_service
        audit_service.record(db, user, action, "user", entity_id=user.id,
                             after=after, ip_address=ip_address)
    except Exception:  # noqa: BLE001 — audit is best-effort, never block the answer
        pass


def ticket_status(db: Session, raw: str) -> dict:
    """Read-only: what the mail's landing page shows before anything is
    answered (state + the date the question names)."""
    row = _find(db, raw)
    user = db.query(User).filter(User.id == row.user_id).first()
    if user is None:
        raise _invalid()
    decision = None
    if row.used_at is not None:
        state, decision = "decided", row.answer
    elif row.voided_at is not None:
        state, decision = "decided", _decided_answer(db, user.id)
    elif row.expires_at < utc_now():
        state = "expired"
    else:
        state = "open"
    question = question_payload(user)
    # Asked after a password reset: the owner has just chosen the current
    # password, so the page asks about the FIRST one (as the mail does).
    # A reset anywhere in the OPEN question counts, not only on this ticket:
    # a login-link page ticket made after a reset must still say "Nej" ends
    # the password chosen with the code (release gate review, 9 Oct).
    question["after_reset"] = row.via == "password_reset" or (
        state == "open" and reset_in_open_question(db, user.id))
    return {"state": state, "decision": decision, "question": question}


def decide(db: Session, raw: str, answer: str, *, ip_address: str | None = None) -> Decision:
    """Apply the inbox owner's answer. The caller commits."""
    if answer not in ANSWERS:
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "claim_answer_invalid",
                      "Answer keep or secure.", "Svar ja eller nej.")
    row = _find(db, raw)
    # One answer per account at a time: the account row is the lock (FOR
    # UPDATE on Postgres; SQLite serialises writers), then the ticket is read
    # again under it — two tickets answered at once cannot both apply.
    user = db.query(User).filter(User.id == row.user_id).with_for_update().first()
    if user is None:
        raise _invalid()
    db.refresh(row)
    if row.used_at is not None:
        if row.answer == answer:
            return Decision(answer=answer, kind=row.kind, user=user, already_decided=True)
        raise _already(row.answer)
    if row.voided_at is not None:
        raise _already(_decided_answer(db, user.id))
    now = utc_now()
    if row.expires_at < now:
        raise _expired()

    row.used_at = now
    row.answer = answer
    (
        db.query(AccountClaimTicket)
        .filter(AccountClaimTicket.user_id == user.id,
                AccountClaimTicket.id != row.id,
                AccountClaimTicket.used_at.is_(None),
                AccountClaimTicket.voided_at.is_(None))
        .update({AccountClaimTicket.voided_at: now}, synchronize_session=False)
    )
    access_closed = False
    if answer == "secure":
        from app.services.auth import secure_account
        n_grants, n_stands = secure_account(db, user)
        access_closed = bool(n_grants or n_stands)
        _audit(db, user, SECURED_ACTION, {
            "via": row.via, "ticket": row.kind, "token_version": user.token_version,
            "revoked_grants": n_grants, "revoked_stand_links": n_stands,
        }, ip_address)
    else:
        _audit(db, user, KEPT_ACTION, {"via": row.via, "ticket": row.kind}, ip_address)
    db.flush()
    return Decision(answer=answer, kind=row.kind, user=user, access_closed=access_closed)
