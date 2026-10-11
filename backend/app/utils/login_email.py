"""The account for a login e-mail, whatever its letter case.

Registration used to store the address as typed while login, forgot/reset,
the e-mail link and Google/Apple looked it up exactly. An owner who signed up
as "Ole@cafe.dk" could not sign in as "ole@cafe.dk", and the e-mail link (or a
Google sign-in) for "ole@cafe.dk" quietly made a second, empty account.

Now every lookup lowers both sides, and every NEW address is stored lower-
cased (register, the Apple legacy route, a changed login e-mail; the e-mail
link and the OAuth routes already lowered theirs). Existing rows are never
rewritten: production had 4 mixed-case addresses and no two differing only in
case (read-only count, 11 Oct 2026). The checks that create an account or
change an address use the same lookup, so no case-duplicate pair can be made
from here on.

A unique index on lower(email) is the later step, after a fresh count.
"""
from __future__ import annotations

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.user import User


def normalize_login_email(email: str | None) -> str:
    """Trimmed and lower-cased — the form a new address is stored in."""
    return (email or "").strip().lower()


def user_by_email(db: Session, email: str | None, *, for_update: bool = False) -> User | None:
    """The user whose login e-mail matches ``email`` ignoring letter case.

    Should two rows ever differ only in case, the one stored exactly as typed
    wins, then the oldest — a deterministic answer rather than whichever row
    the database returns first.
    """
    addr = normalize_login_email(email)
    if not addr:
        return None
    typed = (email or "").strip()
    q = (
        db.query(User)
        .filter(func.lower(User.email) == addr)
        .order_by((User.email == typed).desc(), User.created_at.asc(), User.id.asc())
    )
    if for_update:
        q = q.with_for_update()
    return q.first()
