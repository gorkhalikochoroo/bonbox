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

The explicit sends keep their own older budget too
(routers/staff._check_staff_email_budget: 10 sends / 100 recipients a day).
"""
from __future__ import annotations

import logging
from typing import Any

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
SKIP_LIMIT = "daily_limit"          # a ceiling is reached, or unreadable


def recipient_key(address: str) -> str:
    """The mailbox fingerprint the per-recipient ceiling counts on."""
    return address_fingerprint(mailbox_address(address))


class StaffMailGate:
    """One owner's staff-mail decision for a batch: load once, ask per staffer,
    `record` each delivered mail. Local counters advance with every `take`, so
    a batch cannot overshoot a ceiling between its own sends."""

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
        rows = third_party_sends(db, owner, (STAFF_MAIL_ACTION,))
        if rows is None:
            logger.warning("staff mail count unreadable for owner %s — no mail",
                           getattr(owner, "id", None))
            return cls(owner, held, None, {})
        per: dict[str, int] = {}
        for r in rows:
            k = str(r.get("r") or "")
            if k:
                per[k] = per.get(k, 0) + 1
        return cls(owner, held, len(rows), per)

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
            return None, SKIP_LIMIT
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
    send skips them by name. Returns the gate to use for the sends."""
    from fastapi import HTTPException
    from app.services.revisor_mail import require_verified_sender

    sendable = [a for a in (sendable_email(x) for x in addresses) if a]
    if sendable:
        require_verified_sender(owner, message=STAFF_MAIL_HELD_EN,
                                message_da=STAFF_MAIL_HELD_DA)
    gate = StaffMailGate.load(db, owner)
    if gate.owner_sent is None:
        return gate  # unreadable: every recipient is skipped as over the limit
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
