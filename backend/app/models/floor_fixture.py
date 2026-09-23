"""FloorFixture — the things in a room that are NOT bookable.

A bar counter, an entrance, a window, a dividing wall. They make the floor
plan read as a room instead of circles on a card, and a host recognises their
own room at a glance because the bar is where the bar is.

WHY THIS IS ITS OWN TABLE AND NOT `kind='fixture'` ON BookableResource.

Because the booking engine filters resources with a DENYLIST, not an
allow-list. Every one of these reads "anything that is not a provider is a
table":

    reservations.py:1248           BookableResource.kind != "provider"
    reservation_service.py:295     [r for r in resources if r.kind != "provider"]
    reservation_service.py:351     (slot_remaining_counts)
    reservation_service.py:419     (recheck_and_assign_combo)
    reservation_service.py:434
    reservation_service.py:485     (public_floor)

So a new `kind` value is BOOKABLE BY DEFAULT, in six places at once, and the
failures are not cosmetic: `recheck_and_assign_combo` would seat a real party
of four AT THE WALL; `_venue_seats_total` would inflate the seat count the
room_full 409 is computed from; `enforce_cap(user, "bookable_resources_max")`
would let a drawn window eat one of a Free venue's three TABLE slots; and
`_activate_reservations_on_first_resource` would mint a public booking slug
and switch the guest booking page ON for a venue whose first "resource" was a
decorative wall.

Keeping the fixture in a different table makes all six a non-event — the row
is not in the query's FROM clause at all, so no filter can be forgotten. That
is what "structurally incapable of entering the booking path" has to mean; a
filter someone must remember is not a guarantee.

Two further structural guarantees, deliberately:
  • There is NO capacity/seats column. There is nothing here to inflate a seat
    total with, and nothing a future refactor could mistake for one.
  • `Reservation.resource_id` is an FK to `bookable_resources.id`, so a
    fixture id can never be written into a booking even by a malformed
    request — the database refuses it.

GEOMETRY: percentages, like BookableResource.pos_x/pos_y, so a layout is
resolution-independent across phone, door tablet and desktop. But a fixture
needs w_pct/h_pct rather than the tables' `size_scale`: a bar counter is a
wall-length object (the reference plan's bar is 6.5% x 48% of the room), and
size_scale is clamped 0.5-2.5 and multiplies a SEATS-derived square — it
cannot express a tall thin slab, and widening that clamp would silently change
behaviour for every existing table.

user_id is a REAL ForeignKey to users.id and not merely a GUID column: GDPR
erasure (auth.py delete_account) discovers ownership by inspecting
`col.foreign_keys` for a users table match. A plain GUID column would leave
this table invisible to the sweep AND to the static guard in
tests/test_delete_account_completeness.py — passing tests, orphaned rows.
"""
import uuid
from datetime import datetime

from sqlalchemy import String, Integer, Float, Boolean, DateTime, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now

# The plan symbols an owner can place. Anything else normalises to "wall" —
# clamp-don't-reject, matching how `shape` is handled on BookableResource, so
# a stale client never 422s a whole room save.
FIXTURE_KINDS = ("bar_counter", "entrance", "window", "wall")


class FloorFixture(Base):
    """A non-bookable object drawn on the owner's 2D floor plan."""

    __tablename__ = "floor_fixtures"
    # Declared on the MODEL, not only in the Postgres DDL: new tables are
    # created by Base.metadata.create_all (main.py:3345) on BOTH engines, and
    # create_all emits __table_args__ indexes. An index that exists only in the
    # hand-written PG branch is an index SQLite silently never gets.
    __table_args__ = (
        Index("ix_floor_fixture_user_active", "user_id", "is_deleted"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=False, index=True,
    )

    # One of FIXTURE_KINDS. Note `bar_counter`, NOT `bar`: "bar" is already a
    # BOOKABLE table archetype (a counter with stools that guests sit at and
    # reserve). This is the solid slab you walk up to. Two different objects,
    # and overloading the token would make the distinction unreadable.
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="wall")

    # Owner free text ("Bar", "Køkken", "Indgang Nørrebrogade"). Optional, and
    # NEVER translated — it is the owner's own word for their own room.
    label: Mapped[str | None] = mapped_column(String(60), nullable=True)

    # Centre point, percent of the canvas (0-100 each axis).
    pos_x: Mapped[float] = mapped_column(Float, nullable=False, default=50.0)
    pos_y: Mapped[float] = mapped_column(Float, nullable=False, default=50.0)

    # Footprint, percent of the canvas.
    w_pct: Mapped[float] = mapped_column(Float, nullable=False, default=20.0)
    h_pct: Mapped[float] = mapped_column(Float, nullable=False, default=8.0)

    # Degrees clockwise. NULL reads as 0 everywhere (as on BookableResource).
    rotation_deg: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Paint order within the fixture layer. Fixtures always paint BELOW tables;
    # this only orders them against each other.
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Soft-delete for symmetry with BookableResource and so an accidental
    # delete during service is recoverable. Nothing references a fixture, so
    # this is convenience rather than referential necessity.
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)

    user: Mapped["User"] = relationship()  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return f"<FloorFixture {self.kind} {self.w_pct}x{self.h_pct} @({self.pos_x},{self.pos_y})>"
