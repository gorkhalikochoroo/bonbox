"""Replay guard for expense creation.

WHAT THIS IS FOR — and what it deliberately is NOT.

Measured in production: 5 collision groups in 253 expenses. Every one is
a TYPED row (receipt_photo NULL), and four of five were created 6, 23,
90 and 143 seconds apart. Two live mechanisms produce exactly that:

  1. The axios interceptor replayed POSTs whose response never arrived —
     a dropped socket or our own 60s timeout — at 2s / 6s / 14s / 26s
     cumulative backoff. The 6-second pair is that backoff exactly.
  2. The typed forms had no in-flight lock, so a second tap during a
     slow save posted again.

Both send a BYTE-IDENTICAL payload seconds apart. That is not a
statistical resemblance between two purchases — it is one intent
arriving more than once, and collapsing it is provably correct.

So this is a REPLAY guard, not a duplicate detector. It answers "did
this exact request already land?", never "do these two expenses look
similar?". Receipt-identity matching (was this paper photographed
twice?) is a different problem needing different evidence, and is out of
scope here.

WHY THE FINGERPRINT IS OVER CONTENT, NOT A CLIENT TOKEN
A client-minted idempotency key looks cleaner, but every version of it
reviewed had the same hole: if the key outlives one submit — and on an
always-mounted form that clears and stays open, it does — then the
owner's NEXT, DIFFERENT expense reuses it, the server hands back the
OLD row, and a real expense plus its §42 fradrag is destroyed while the
UI shows success. Hashing the actual content makes that impossible by
construction: a different expense has a different fingerprint and can
never collide with an earlier one.

THE WINDOW IS THE HONESTY BOUNDARY
A café can legitimately buy the same thing twice from the same shop for
the same amount on the same day. Over a day that is plausible; within
~2 minutes, with an identical amount, vendor, category and method, it is
not — it is a replay. The window is deliberately short, and
`allow_duplicate` always lets the owner force a genuine repeat through,
so a false positive can never cost them an expense.
"""

from __future__ import annotations

import hashlib
from datetime import timedelta

from sqlalchemy.orm import Session

from app.models.expense import Expense
from app.utils.time import utc_now

# Long enough to cover the observed replay signature — the axios backoff
# ran to ~26s cumulative, and a slow double-tap on a Render cold start
# can be slower still — and short enough that a genuine repeat purchase
# of an identical amount is not plausibly inside it.
REPLAY_WINDOW_SECONDS = 180


def fingerprint(
    *,
    user_id,
    amount,
    date,
    description: str | None,
    payment_method: str | None,
    category_id=None,
) -> str:
    """Stable hash of everything that makes an expense THIS expense.

    Any field the owner could have changed between two submits must be
    in here: if it isn't, two genuinely different expenses would share a
    fingerprint and the second would be swallowed.
    """
    parts = [
        str(user_id),
        f"{float(amount or 0):.2f}",
        date.isoformat() if hasattr(date, "isoformat") else str(date or ""),
        " ".join((description or "").split()).casefold(),
        (payment_method or "").casefold(),
        str(category_id or ""),
    ]
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


def find_recent_replay(db: Session, user_id, fp: str) -> Expense | None:
    """The row this request is a replay OF, if any.

    Scoped to the user, to a live row, and to the window. Returns the
    EARLIEST match so repeated replays all collapse onto the same
    original rather than chaining.
    """
    cutoff = utc_now() - timedelta(seconds=REPLAY_WINDOW_SECONDS)
    return (
        db.query(Expense)
        .filter(
            Expense.user_id == user_id,
            Expense.dedup_fingerprint == fp,
            Expense.is_deleted.isnot(True),
            Expense.created_at >= cutoff,
        )
        .order_by(Expense.created_at.asc())
        .first()
    )
