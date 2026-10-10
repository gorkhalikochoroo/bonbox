"""Who BonBox e-mails on an owner's behalf about the schedule, and how often.

SEC-1 + SEC-10 (R-f). Every staff e-mail goes from BonBox's own domain
(DKIM/DMARC-aligned, the reputation password resets and booking mails depend
on) to an address the OWNER typed:

  automatic   notification_service.send_shift_notifications (publish) and
              send_single_shift_notification (edit, delete, sick-call cover)
  explicit    routers/staff.py share_with_staff ("Del med personalet") and
              email_schedule_to_staff ("Send ugens vagtplan", PDF attached)

The 8 Oct security release gated fakturaer, team invitations, supplier orders
and revisor mail on a confirmed owner and a daily ceiling; the schedule mails
were never brought in. The same rules, one place:

  1. A confirmed sender — revisor_mail.held_sender_reason(owner) is None (own
     address confirmed AND no open "did you create this account?" question).
     Automatic mails: held → the in-app alert and the push still go, the mail
     does not, and publish tells the owner why. Explicit sends: 403
     email_unverified before anything is sent (require_verified_sender).
  2. One ordinary mailbox — utils.email_address.sendable_email.
  3. Ceilings over a rolling 24 hours, counted from audit_logs (the repo's
     usage counter, as billing.py / revisor_mail do — no new table): one
     `staff_mail.sent` row per delivered mail, the address kept only as a
     fingerprint of its mailbox ("anna+x@" counts as "anna@").
       STAFF_MAIL_OWNER_DAILY_CAP      mails per owner
       STAFF_MAIL_RECIPIENT_DAILY_CAP  mails per mailbox
     A venue publishing its week and editing a few shifts never gets near
     them; a misused account stops there. When the count cannot be read, no
     mail goes (fail closed) — the in-app alert and the push are unaffected.
  4. One mail at a time per owner (StaffMailGate.turn): the count is re-read
     under an owner lock, the mail is sent and its counter row committed
     before the owner's next staff mail is decided. Without it, requests and
     background sends running at the same moment all read the same old count
     (review, 10 Oct: twelve concurrent shift edits, one mail left under the
     ceiling, twelve mails). The lock is a per-owner lock in this process
     plus, on Postgres, an advisory lock for the rest of the transaction
     (another worker, or the old and new instance during a deploy). A waiting
     mail holds no database connection. A turn that cannot start within
     STAFF_MAIL_TURN_WAIT_S sends nothing (fail closed); the in-app alert and
     the push still go.

The explicit sends keep their own older budget too
(routers/staff._check_staff_email_budget: 10 sends / 100 recipients a day).
"""
from __future__ import annotations

import logging
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterator

from app.services.revisor_mail import (
    address_fingerprint,
    held_sender_reason,
    mailbox_address,
    third_party_sends,
)
from app.utils.email_address import sendable_email

logger = logging.getLogger("bonbox.staff_mail_guard")

STAFF_MAIL_ACTION = "staff_mail.sent"
STAFF_MAIL_OWNER_DAILY_CAP = 100
STAFF_MAIL_RECIPIENT_DAILY_CAP = 10

# Why one staffer was not mailed (the in-app alert and push are separate).
SKIP_NO_ADDRESS = "no_address"      # blank, or not one ordinary mailbox
SKIP_HELD = "held"                  # the owner is not a confirmed sender
SKIP_LIMIT = "daily_limit"          # a ceiling is reached
SKIP_UNKNOWN = "count_unavailable"  # the count could not be read (or the
                                    # turn could not start): no mail, and
                                    # no claim that a limit was reached

# How long one staff mail waits for the owner's previous one (a send and its
# counter row) before it gives up and sends nothing.
STAFF_MAIL_TURN_WAIT_S = 30.0
_TURN_POLL_S = 0.05

_turn_locks: dict[str, threading.RLock] = {}
_turn_locks_guard = threading.Lock()


def _turn_key(owner_id) -> str:
    import uuid as _uuid
    try:
        return f"staff_mail:{_uuid.UUID(str(owner_id))}"
    except (ValueError, TypeError, AttributeError):
        return f"staff_mail:{owner_id}"


def _owner_turn_lock(owner_id) -> threading.RLock:
    """This process's lock for one owner's staff mail (one per owner that
    mailed staff since start — a few hundred at most)."""
    key = _turn_key(owner_id)
    with _turn_locks_guard:
        lock = _turn_locks.get(key)
        if lock is None:
            lock = _turn_locks[key] = threading.RLock()
        return lock


def _take_db_turn(db, owner_id, deadline: float) -> bool:
    """On Postgres, hold the owner's staff-mail advisory lock for the rest of
    this transaction, so another worker or instance waits too. Released by the
    transaction's commit or rollback — nothing can leak it. Polled, never
    blocking past `deadline`. True when held (or on a database that needs
    none: SQLite here is one process, serialised by the process lock)."""
    try:
        dialect = db.get_bind().dialect.name
    except Exception:  # noqa: BLE001 — no bind: the process lock alone
        return True
    if dialect != "postgresql":
        return True
    from sqlalchemy import text
    try:
        with db.begin_nested():
            while True:
                got = db.execute(
                    text("SELECT pg_try_advisory_xact_lock(hashtextextended(:k, 0))"),
                    {"k": _turn_key(owner_id)},
                ).scalar()
                if got:
                    return True
                if time.monotonic() >= deadline:
                    return False
                time.sleep(_TURN_POLL_S)
    except Exception:  # noqa: BLE001 — fail closed: no mail this turn
        logger.warning("staff mail turn: advisory lock failed for owner %s", owner_id)
        return False


def _tally(rows: list[dict]) -> tuple[int, dict[str, int]]:
    per: dict[str, int] = {}
    for r in rows:
        k = str(r.get("r") or "")
        if k:
            per[k] = per.get(k, 0) + 1
    return len(rows), per


def recipient_key(address: str) -> str:
    """The mailbox fingerprint the per-recipient ceiling counts on."""
    return address_fingerprint(mailbox_address(address))


class StaffMailGate:
    """One owner's staff-mail decision for a batch: load once, ask per staffer,
    `record` each delivered mail. Local counters advance with every `take`, so
    a batch cannot overshoot a ceiling between its own sends.

    Every SEND goes through `turn` (one mail at a time per owner, the count
    re-read under the lock); `refusal` alone is for counting ahead (publish's
    "N will be e-mailed", the explicit sends' all-or-nothing check)."""

    def __init__(self, owner: Any, held: str | None, owner_sent: int | None,
                 per_recipient: dict[str, int]):
        self.owner = owner
        self.held = held
        self._owner_sent = owner_sent
        self._per_recipient = per_recipient

    @classmethod
    def load(cls, db, owner) -> "StaffMailGate":
        if owner is None:
            return cls(None, "email_unverified", None, {})
        held = held_sender_reason(owner)
        gate = cls(owner, held, None, {})
        gate._reload_counts(db)
        return gate

    def _reload_counts(self, db) -> None:
        rows = third_party_sends(db, self.owner, (STAFF_MAIL_ACTION,))
        if rows is None:
            logger.warning("staff mail count unreadable for owner %s — no mail",
                           getattr(self.owner, "id", None))
            self._owner_sent, self._per_recipient = None, {}
            return
        self._owner_sent, self._per_recipient = _tally(rows)

    @contextmanager
    def turn(self, db, raw_address) -> Iterator[tuple[str | None, str | None]]:
        """One staff mail, serialised per owner. Yields (address, None) when it
        may be sent now, else (None, SKIP_* reason). The caller sends and
        `record`s inside the block; the counter row is committed when the
        block ends, before the next turn for this owner starts.

        The session is committed when the turn starts too, so a mail waiting
        for its turn holds no pooled database connection (the caller's
        pending work — share_with_staff's minted link — is committed with it;
        every caller commits it anyway).

        No address, or a held sender: nothing to decide, no lock taken."""
        addr = sendable_email(raw_address)
        if not addr or self.held:
            yield self.refusal(raw_address)
            return
        owner_id = getattr(self.owner, "id", None)
        db.commit()
        deadline = time.monotonic() + STAFF_MAIL_TURN_WAIT_S
        lock = _owner_turn_lock(owner_id)
        # This process's lock first (waiting on it holds no connection), then
        # Postgres's for other workers. Every turn that holds both commits
        # before it lets go of the process lock, so the database lock is never
        # left behind for a thread of this process to wait on.
        got = lock.acquire(timeout=STAFF_MAIL_TURN_WAIT_S)
        got_db = got and _take_db_turn(db, owner_id, deadline)
        try:
            if got_db:
                self._reload_counts(db)
            else:
                logger.warning("staff mail turn did not start in time for owner %s — no mail",
                               owner_id)
                self._owner_sent, self._per_recipient = None, {}
            yield self.refusal(raw_address)
            if got_db:
                db.commit()  # the counter row is visible before the next turn
        finally:
            if got:
                lock.release()

    @property
    def owner_sent(self) -> int | None:
        return self._owner_sent

    def refusal(self, raw_address) -> tuple[str | None, str | None]:
        """(address to send to, None) when this staffer may be mailed now,
        else (None, SKIP_* reason). Does not count anything — call `take`."""
        addr = sendable_email(raw_address)
        if not addr:
            return None, SKIP_NO_ADDRESS
        if self.held:
            return None, SKIP_HELD
        if self._owner_sent is None:
            return None, SKIP_UNKNOWN
        if self._owner_sent >= STAFF_MAIL_OWNER_DAILY_CAP:
            return None, SKIP_LIMIT
        if self._per_recipient.get(recipient_key(addr), 0) >= STAFF_MAIL_RECIPIENT_DAILY_CAP:
            return None, SKIP_LIMIT
        return addr, None

    def take(self, address: str) -> None:
        """Count one mail against the local view of the ceilings."""
        if self._owner_sent is not None:
            self._owner_sent += 1
        k = recipient_key(address)
        self._per_recipient[k] = self._per_recipient.get(k, 0) + 1

    def record(self, db, address: str, *, kind: str, staff_id=None,
               explicit: bool = False) -> None:
        """Write the `staff_mail.sent` counter row for one delivered mail (the
        caller commits) and advance the local counters. `explicit` = the owner
        pressed a send button (actor "user"); automatic mails are
        "system.staff_mail", so activity counts can tell them apart."""
        from app.services import audit_service
        audit_service.record(
            db, self.owner, STAFF_MAIL_ACTION, "staff_member", staff_id,
            after={"r": recipient_key(address), "kind": kind},
            actor_type="user" if explicit else "system.staff_mail",
        )
        self.take(address)

    def copy(self) -> "StaffMailGate":
        return StaffMailGate(self.owner, self.held, self._owner_sent, dict(self._per_recipient))

    def recipient_count(self, address: str) -> int:
        return self._per_recipient.get(recipient_key(address), 0)


# ── The two explicit senders ("Del med personalet", "Send ugens vagtplan") ──
#
# Shown by app builds that print the server's own message; the current app
# says it in its own words (i18n staffMailHeld*) with "Bekræft nu".
STAFF_MAIL_HELD_EN = (
    "Not sent: BonBox e-mails your staff only once your own e-mail is confirmed "
    "(Profile → Unverified). Until then, you can copy their links or download the "
    "PDF and share it yourself."
)
STAFF_MAIL_HELD_DA = (
    "Ikke sendt: BonBox mailer først dit personale, når din egen e-mail er bekræftet "
    "(Profil → Ikke bekræftet). Indtil da kan du kopiere deres links eller hente "
    "PDF'en og dele den selv."
)


def staff_mail_daily_cap_detail(lang: str) -> dict:
    da = (lang or "").lower() == "da"
    return {
        "code": "staff_mail_daily_cap",
        "message": (
            f"BonBox sender højst {STAFF_MAIL_OWNER_DAILY_CAP} mails om dagen til dit "
            "personale. Prøv igen i morgen — eller del vagtplanen som PDF."
            if da else
            f"BonBox sends at most {STAFF_MAIL_OWNER_DAILY_CAP} e-mails a day to your "
            "staff. Try again tomorrow — or share the schedule as a PDF."
        ),
        "cap": STAFF_MAIL_OWNER_DAILY_CAP,
    }


def preflight_explicit_send(db, owner, addresses, lang: str) -> StaffMailGate:
    """Before an explicit staff send mails anyone:

      • 403 email_unverified when at least one address could be mailed and the
        owner is not a confirmed sender (nothing is sent, nothing is minted);
      • 429 staff_mail_daily_cap when the mails this send would deliver do not
        fit under the owner's daily ceiling (all or nothing — a half-sent week
        is worse than a clear "try tomorrow").

    Recipients already at their own daily ceiling are not refused here: the
    send skips them by name. Returns the gate to use for the sends; each send
    still goes through `turn`, so a send running at the same moment cannot
    push the owner past a ceiling (it is then skipped by name)."""
    from fastapi import HTTPException
    from app.services.revisor_mail import require_verified_sender

    sendable = [a for a in (sendable_email(x) for x in addresses) if a]
    if sendable:
        # `message` in the owner's language: an older app (the bundled iOS
        # build, a tab open across the deploy) shows `message` as it is.
        require_verified_sender(owner, message=STAFF_MAIL_HELD_EN,
                                message_da=STAFF_MAIL_HELD_DA, lang=lang)
    gate = StaffMailGate.load(db, owner)
    if gate.owner_sent is None:
        return gate  # unreadable: each send re-reads it in its turn, or fails closed
    sim = gate.copy()
    wanted = 0
    for addr in sendable:
        if sim.recipient_count(addr) >= STAFF_MAIL_RECIPIENT_DAILY_CAP:
            continue
        sim.take(addr)
        wanted += 1
    if wanted and gate.owner_sent + wanted > STAFF_MAIL_OWNER_DAILY_CAP:
        raise HTTPException(status_code=429, detail=staff_mail_daily_cap_detail(lang))
    return gate
