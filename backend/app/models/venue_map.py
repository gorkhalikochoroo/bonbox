"""VenueMap — the small map a staffer sees on the next-shift card.

Drawn ONCE per venue pin by our own server (services/venue_map.py) from
OpenFreeMap vector tiles, in BonBox colours, and kept here. Staff phones load
the image from api.bonbox.dk only, so no map company ever sees a staffer,
their phone or their location.

WHY A TABLE AND NOT SUPABASE STORAGE. The image is ~10-25 KB and keyed by a
hash of the pin, so a row is the simplest cache that is erased with the
account for free: user_id is a REAL ForeignKey to users.id, which is how the
GDPR erasure walk (routers/auth.py delete_account) finds every owned row, and
the export walk skips the PNG bytes as a binary column. No storage kind, no
blob to purge separately.

THREE OUTCOMES, never two. A row with `png` is an image. A row with
`failed_at` and no png is "the render failed" — retried after 24 h, and the
staff card shows no map meanwhile (never a broken image). No row means "not
drawn yet".

The key is (user_id, coords_hash, width, height, dpr). `coords_hash` covers
the pin AND the render version, so moving the pin or changing the style simply
asks for a different row; stale rows are dropped when the pin is reset (an
address change, see the listeners below).
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime, ForeignKey, Index, Integer, LargeBinary, String, UniqueConstraint, delete, event,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class VenueMap(Base):
    __tablename__ = "venue_maps"
    __table_args__ = (
        UniqueConstraint("user_id", "coords_hash", "width", "height", "dpr", name="uq_venue_maps_key"),
        Index("ix_venue_maps_user_branch", "user_id", "branch_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # NULL = the venue (business profile) pin; set = a location's own pin.
    branch_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("branches.id", ondelete="CASCADE"), nullable=True,
    )
    coords_hash: Mapped[str] = mapped_column(String(64))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    dpr: Mapped[int] = mapped_column(Integer)
    png: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    failed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


# ── An address change drops the pin ─────────────────────────────────────────
# The pin was found FROM the address (or checked against it by the owner), so a
# new address makes it a guess about the old place. Every write path that can
# touch the address — the profile PUT, the CVR re-verify, the demo seeder, the
# branch PUT — goes through the ORM flush, so the reset lives here, once,
# instead of at each call site where the next one would forget it. Same write:
# the columns are nulled on the target (part of this UPDATE) and the cached
# images are deleted on the flush's own connection. The staff card then shows
# no map until the owner checks the new pin; the address and Rute still work.
#
# The clock-in geofence anchor is not ours to clear (it is the clock-in
# control), but it may still mark the OLD place — and it outranks a lookup. So
# when one exists the reset leaves a marker, venue_geo_source="moved": the
# anchor then counts as a pin the owner must confirm again, not as a confirmed
# one (services/venue_map.current_pin). Without an anchor everything is NULL,
# which also clears a remembered failed lookup ("none") so the new address is
# looked up.

_PROFILE_ADDRESS_FIELDS = ("address", "zipcode", "city")
_PROFILE_GEO_FIELDS = ("venue_lat", "venue_lng", "venue_geo_source", "venue_geo_at", "venue_geo_confirmed_at")
_BRANCH_GEO_FIELDS = ("geo_lat", "geo_lng", "geo_source", "geo_at", "geo_confirmed_at")


def _changed(target, field: str) -> bool:
    from sqlalchemy import inspect as _inspect

    hist = _inspect(target).attrs[field].history
    if not hist.has_changes():
        return False
    old = (hist.deleted or [None])[0]
    new = (hist.added or [None])[0]
    return (old or "").strip() != (new or "").strip()


def _profile_address_changed(mapper, connection, target):  # noqa: ARG001
    if not any(_changed(target, f) for f in _PROFILE_ADDRESS_FIELDS):
        _profile_country_changed(target)
        return
    # A write that sets a new pin in the same flush owns it (none does today).
    if any(_changed_any(target, f) for f in ("venue_lat", "venue_lng")):
        return
    for f in _PROFILE_GEO_FIELDS:
        setattr(target, f, None)
    from app.services import venue_map as _vm

    if _vm._geofence_point(target):
        target.venue_geo_source = _vm.GEO_MOVED
        target.venue_geo_at = utc_now()
    connection.execute(
        delete(VenueMap.__table__).where(
            VenueMap.__table__.c.user_id == str(target.user_id),
            VenueMap.__table__.c.branch_id.is_(None),
        )
    )


def _profile_country_changed(target) -> None:
    """The venue's country picks where the address is looked up (Denmark:
    the register; Portugal: OpenStreetMap in Portugal). A remembered failed
    lookup ("none") from the old country must not wait LOOKUP_RETRY: clear
    only that marker, so the next pin check asks in the new country. A pin
    — looked up, confirmed or pasted — is never touched here."""
    from sqlalchemy import inspect as _inspect

    from app.services import venue_map as _vm

    if getattr(target, "venue_geo_source", None) != _vm.GEO_NONE:
        return
    hist = _inspect(target).attrs["country"].history
    if not hist.has_changes():
        return
    old = (hist.deleted or [None])[0]
    new = (hist.added or [None])[0]
    if _vm.lookup_country(old) == _vm.lookup_country(new):
        return
    target.venue_geo_source = None
    target.venue_geo_at = None


def _branch_address_changed(mapper, connection, target):  # noqa: ARG001
    if not _changed(target, "address"):
        return
    if any(_changed_any(target, f) for f in ("geo_lat", "geo_lng")):
        return
    for f in _BRANCH_GEO_FIELDS:
        setattr(target, f, None)
    connection.execute(
        delete(VenueMap.__table__).where(VenueMap.__table__.c.branch_id == str(target.id))
    )


def _changed_any(target, field: str) -> bool:
    from sqlalchemy import inspect as _inspect

    return _inspect(target).attrs[field].history.has_changes()


def _register_listeners():
    from app.models.branch import Branch
    from app.models.business_profile import BusinessProfile

    if not event.contains(BusinessProfile, "before_update", _profile_address_changed):
        event.listen(BusinessProfile, "before_update", _profile_address_changed)
    if not event.contains(Branch, "before_update", _branch_address_changed):
        event.listen(Branch, "before_update", _branch_address_changed)


_register_listeners()
