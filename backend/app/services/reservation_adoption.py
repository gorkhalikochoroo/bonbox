"""
Reservation adoption — the fleet's honest answer to "does anyone actually use
the booking product?"

WHY THIS EXISTS. Reservations entered NO fleet metric at all: admin.py's
`activated_users` is `distinct(Sale.user_id)`, sales only. Multi-week build
decisions were being weighed against a number nobody had run, next to a working
assumption that adoption is zero. A metric built to confirm that assumption
would be worse than no metric, because it would be believed.

So the design constraint here is asymmetric: this must be CAPABLE OF
DISPROVING the assumption. Every filter below was chosen in the keep-real
direction, and the ones deliberately NOT applied are documented, because each
of them would have manufactured a zero.

──────────────────────────────────────────────────────────────────────────────
THE DISCRIMINATOR: purge_after IS NOT NULL, *not* idempotency_key.

There are exactly five places a Reservation row is constructed:
    public_reservations.py:726  public provider  → purge_after set (:740)
    public_reservations.py:881  public table     → purge_after set (:897)
    reservations.py:1197        owner provider   → purge_after set (:1212)
    reservations.py:1279        owner table      → purge_after set (:1297)
    demo_seed.py:655            the seeder       → purge_after NEVER set
Real rows always carry it; demo rows never do. So the test is written
`.isnot(None)` — the KEEP-REAL direction, where a NULL can only ever remove a
demo row and can never remove a real one.

The obvious alternative, `idempotency_key NOT LIKE 'demo-%'`, is a trap twice
over:
  1. NULL semantics. `NULL NOT LIKE 'demo-%'` is NULL, not true, so the row is
     dropped. The owner/manual create paths never assign a key, so that filter
     silently erases every phone-booking venue — which is the Danish ICP. The
     resulting near-zero would read as proof of no adoption.
  2. It is not robust to `_seed_reservations(mark_demo=False)`, which writes
     idempotency_key=None. A NULL-safe version of that filter then counts the
     seeder's five fake source='public' rows as GUEST SELF-BOOKINGS —
     fabricating adoption that does not exist.
purge_after survives both.

──────────────────────────────────────────────────────────────────────────────
DELIBERATE NON-FILTERS. Each of these would have produced a zero:

  • NO date window on the headline. A window drops venues holding only FUTURE
    bookings — exactly the newest adopters.
  • NO status filter. A nightly sweep rewrites unanswered `requested` rows to
    `cancelled` (reservation_request_expiry.py). Excluding cancelled deletes
    the evidence that a stranger booked and the owner never replied.
  • NO PII predicate. The GDPR purge nulls guest_name/email/phone past
    purge_after — and because demo rows have purge_after NULL they are
    structurally unpurgeable, so among old rows the ones that still LOOK real
    are disproportionately the fake ones.
  • NO party_size / business_type / resource-kind predicate. Salon and clinic
    appointments live on this same table with party_size=1 and often
    resource_id NULL; any restaurant-shaped filter erases that whole segment.
  • NO is_deleted predicate. No code path ever sets it True on a Reservation.
    It can only subtract.
  • ROW-level demo exclusion, NEVER account-level. `seed_for_user` writes demo
    rows onto ORDINARY owner accounts that tapped "try sample data", so
    dropping accounts that contain a demo row is the likeliest path from "some
    adoption" to "zero".
  • EXCLUDED_ACCOUNTS reported as a SECOND number, never silently subtracted.
"""

from sqlalchemy import case, distinct, func, or_
from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.services.internal_accounts import EXCLUDED_ACCOUNTS

# Owners structurally cannot write "public": ManualReservation pins source to
# ^(manual|walk_in)$ (reservations.py:215). So once demo rows are removed, the
# guest-facing widget is the only remaining writer of "public" — which is what
# makes the self-booked tier credible.
OWNER_SOURCES = ("manual", "walk_in")
PUBLIC_SOURCE = "public"

# Audit actions that mean "a reservation was created". Used only to see venues
# whose rows are gone (account deleted — GDPR Art.17 hard-DELETEs reservations
# while audit_logs is retained). demo_seed makes no audit calls, so this table
# is demo-free by construction.
CREATE_ACTIONS = ("reservation.created_public", "reservation.created_manual")


def _real(q):
    """Restrict to non-demo reservation rows. See the module docstring."""
    return q.filter(Reservation.purge_after.isnot(None))


def collect(db: Session) -> dict:
    """One pass over reservations, returned as tiers that are never collapsed.

    Cheap by construction: a handful of grouped aggregates, no per-user loop.
    Safe to call from /api/admin/overview, which is a fixed-query endpoint.
    """
    excluded_ids = set(EXCLUDED_ACCOUNTS)

    # ── T1/T2/T3 in a single grouped pass ────────────────────────────────
    # Per account: total real rows, and how many were guest-self-booked vs
    # owner-entered. Grouping once keeps this O(1) in query count.
    rows = (
        _real(
            db.query(
                Reservation.user_id.label("uid"),
                func.count(Reservation.id).label("n"),
                func.sum(
                    case((Reservation.source == PUBLIC_SOURCE, 1), else_=0)
                ).label("n_public"),
                func.sum(
                    case((Reservation.source.in_(OWNER_SOURCES), 1), else_=0)
                ).label("n_owner"),
            )
        )
        .group_by(Reservation.user_id)
        .all()
    )

    def _ids(pred):
        return {str(r.uid) for r in rows if pred(r)}

    any_ids = _ids(lambda r: (r.n or 0) > 0)
    public_ids = _ids(lambda r: (r.n_public or 0) > 0)
    owner_ids = _ids(lambda r: (r.n_owner or 0) > 0)

    # ── T0 configured — the honest denominator ───────────────────────────
    # "The book was switched on." T1=0 with T0>0 means supply without demand;
    # T1=0 with T0=0 means nobody ever set it up. Opposite next moves, so the
    # headline must never be reported without this.
    configured = (
        db.query(func.count(distinct(BusinessProfile.user_id)))
        .filter(
            or_(
                BusinessProfile.reservations_enabled.is_(True),
                BusinessProfile.reservation_slug.isnot(None),
            )
        )
        .scalar()
        or 0
    )

    # ── T4 churned — used it, then deleted the account ───────────────────
    audit_ids = {
        str(uid)
        for (uid,) in db.query(distinct(AuditLog.user_id)).filter(
            AuditLog.action.in_(CREATE_ACTIONS)
        )
        if uid is not None
    }
    churned_ids = audit_ids - any_ids

    # When reservation audit instrumentation began. Until this is known, a low
    # churned count is a floor of unknown depth, not a finding — so it ships
    # next to the number rather than being left for someone to assume.
    audit_since = (
        db.query(func.min(AuditLog.created_at))
        .filter(AuditLog.action.like("reservation.%"))
        .scalar()
    )

    # ── self-audit: do the two independent demo markers agree? ───────────
    # purge_after IS NULL (our discriminator) vs idempotency_key LIKE 'demo-%'
    # (the seeder's own marker). A disagreement means either a new create path
    # forgot to stamp purge_after (silent UNDERCOUNT) or something seeded with
    # mark_demo=False (silent OVERCOUNT). Either way the headline must not be
    # trusted until a human looks — so the subtraction is auditable rather
    # than invisible.
    unstamped = (
        db.query(func.count(Reservation.id))
        .filter(Reservation.purge_after.is_(None))
        .scalar()
        or 0
    )
    demo_keyed = (
        db.query(func.count(Reservation.id))
        .filter(Reservation.idempotency_key.like("demo-%"))
        .scalar()
        or 0
    )

    def _shape(ids):
        return {"raw": len(ids), "excl_internal": len(ids - excluded_ids)}

    return {
        # Unit is ACCOUNTS, not venues: Reservation carries no branch_id, so a
        # multi-location owner is one id however many rooms are booking.
        "unit": "accounts",
        "configured": configured,
        "any_reservation": _shape(any_ids),
        "guest_self_booked": _shape(public_ids),
        "owner_entered": _shape(owner_ids),
        "churned": _shape(churned_ids),
        "audit_since": audit_since.isoformat() if audit_since else None,
        "demo_marker_audit": {
            "unstamped_rows": unstamped,
            "demo_keyed_rows": demo_keyed,
            "agree": unstamped == demo_keyed,
        },
        "internal_accounts_known": len(excluded_ids),
        # Kept in the payload so nobody has to re-derive what the number means.
        "caveats": [
            "Counts ACCOUNTS, not venues — Reservation has no branch_id.",
            "Lifetime, not active: a venue that booked once in March counts.",
            "Says nothing about geography; a non-zero result may be entirely non-DK.",
            "guest_self_booked cannot tell a stranger from the owner testing "
            "their own booking link — read the rows before acting on a small number.",
            "Waitlist-only venues are invisible here; those rows live in "
            "reservation_waitlist and write no reservation until converted.",
            "Not derived from event_log: reservation telemetry postdates "
            "2026-07-16, so any event-derived zero before then is an artifact.",
        ],
    }
