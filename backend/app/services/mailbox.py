"""The mailbox an address really delivers to — for COUNTING, never for sending.

Every per-address mail limit on the public booking page used to compare the
address as typed (trimmed, lowercased). But "anna+1@gmail.com",
"anna+2@gmail.com" and "a.n.n.a@gmail.com" all land in one inbox, so an
anonymous sender could rotate "+tags" or dots and get a fresh quota each time
— turning the venue's confirmation and reminder mail into a relay aimed at a
stranger, from BonBox's sending domain.

`canonical_mailbox` folds those spellings together:
  • trim + lowercase;
  • drop a "+tag" from the local part (plus-addressing: Gmail, Outlook,
    iCloud, Fastmail, Proton and most self-hosted mail);
  • Gmail ignores dots in the local part, and googlemail.com IS gmail.com.

Mail is still SENT to exactly what the guest typed; only the limits count by
mailbox. Folding too eagerly can only ever mean a limit bites a little early
for someone who books the same venue several times a day under several
spellings — never that mail goes somewhere it should not.
"""
from __future__ import annotations

_GMAIL_DOMAINS = ("gmail.com", "googlemail.com")


def canonical_mailbox(email: str | None) -> str:
    e = (email or "").strip().lower()
    local, sep, domain = e.rpartition("@")
    if not sep or not local or not domain:
        return e
    base = local.split("+", 1)[0] or local
    if domain in _GMAIL_DOMAINS:
        base = base.replace(".", "") or base
        domain = "gmail.com"
    return f"{base}@{domain}"


def count_same_mailbox(addresses, email: str | None) -> int:
    """How many of `addresses` deliver to the same mailbox as `email`."""
    target = canonical_mailbox(email)
    if not target:
        return 0
    return sum(1 for a in addresses if a and canonical_mailbox(a) == target)
