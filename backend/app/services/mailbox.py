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


def mailbox_sql_match(column, email: str | None):
    """SQL: `column` holds an address that canonical_mailbox folds to the
    SAME mailbox as `email` — "+tags" dropped, and Gmail dots and
    googlemail.com folded — for the per-contact COUNTS in SQL (R2, Manoj's
    decision 5: no stored second copy of the address; it is folded in code
    at booking time).

    Portable on purpose: lower(), trim(), replace() and LIKE with an explicit
    ESCAPE exist in Postgres and SQLite alike, so a per-contact limit stays
    ONE COUNT and the tests (SQLite) cover the same predicate production
    runs (Postgres). Folding in Python over fetched rows is how the 31 Aug
    blackout happened — never that. LIKE wildcards in the address itself
    ("_", "%") are escaped, so "a_b@x.dk" never matches "axb@x.dk".

    None when `email` is not an address (no "@", nothing either side)."""
    from sqlalchemy import and_, func, or_

    canon = canonical_mailbox(email)
    local, sep, domain = canon.rpartition("@")
    if not sep or not local or not domain:
        return None
    col = func.lower(func.trim(column))
    if local.startswith("+"):
        # canonical_mailbox keeps a local part that STARTS with "+" whole;
        # only the exact spelling is the same mailbox then.
        return col == canon

    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

    if domain == "gmail.com":
        # Every dot goes, the domain's too: "a.nna+x@gmail.com" reads
        # "anna+x@gmailcom". The domain test beside it keeps another domain
        # that happens to read the same without dots out.
        dotless = func.replace(col, ".", "")
        same = []
        for d in ("gmailcom", "googlemailcom"):
            same.append(dotless == f"{local}@{d}")
            same.append(dotless.like(f"{esc(local)}+%@{d}", escape="\\"))
        return and_(or_(col.like("%@gmail.com"), col.like("%@googlemail.com")), or_(*same))
    return or_(col == canon, col.like(f"{esc(local)}+%@{esc(domain)}", escape="\\"))
