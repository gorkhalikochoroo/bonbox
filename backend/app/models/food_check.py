"""
Egenkontrol R1a — temperature checks (Migration 088).

Four tables, all owned by the venue (user_id → users.id), so account erasure
and the GDPR export reach them through the metadata walk with no extra code:

  food_checks            the venue's current list (a cache of the newest
                         revision; a check with readings is archived, never
                         deleted)
  food_check_revisions   APPEND-ONLY rule history. Every change to the name,
                         note, on/off, limit, schedule, recheck time or code
                         lists writes a NEW row. Old days are always judged by
                         the rule that was in force then, so switching a
                         fridge off today never rewrites last month's
                         "Ikke registreret".
  food_check_entries     APPEND-ONLY readings. The server stamps the official
                         time (recorded_at), the slot, late and in_limit. A
                         reading is voided (undo), never edited or deleted —
                         except by account erasure and the 730-day purge.
  food_check_settings    one row per venue.

IMMUTABILITY, TWO ENGINES. On Postgres, BEFORE UPDATE triggers (main.py,
Migration 088) refuse any change to a saved reading other than
deviation_state (open <-> closed only) / voided_at + void_reason (once, with a
known reason) / staff_id (cleared only), and any change at all to a
revision. DELETE stays allowed (erasure, purge). The mapper listeners at the
bottom of this file are the SQLite-side twin: the same rule, enforced on every
ORM flush, so a code path that tries to edit a reading fails in tests too.

Deliberately FK-free id columns: followup_of_id and supersedes_id (a
self-reference would make the 730-day purge FK-fail at the boundary between a
deleted and a kept reading), created_by_user_id and actor_user_id (actor refs,
like expenses.linked_expense_id).

Cooling (food_cooling_runs, entries.cooling_run_id) arrives in R2 with its own
ALTER. R1a shipped the R1b columns source, paper_measured_at, supersedes_id,
correction_reason, done, findsmiley_* and staff_card unused.

R1b (Migration 089) adds three tables — food_check_reviews (the weekly
review), food_check_documents (the owner's own documents in the Kontrolmappe)
and food_check_photos (one optional photo on a reading) — and three columns:
food_check_entries.reason_text (the paper reason) and .correction_text (a
correction's own words), and food_check_settings.opted_in. The new
tables carry user_id → users.id, so erasure and the GDPR export reach them
through the same metadata walk; their immutability is app-level (listeners at
the bottom), no new Postgres trigger.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import (
    Boolean, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text,
    event, select, text,
)
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.orm.attributes import get_history

from app.database import Base, GUID
from app.utils.time import utc_now


class EntryImmutableError(ValueError):
    """A saved reading or a revision was about to be changed in place."""


class FoodCheck(Base):
    __tablename__ = "food_checks"
    __table_args__ = (
        Index("ix_food_checks_user_branch", "user_id", "branch_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    # NULL = the whole venue (every branch sees it).
    branch_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("branches.id"), nullable=True
    )
    kind: Mapped[str] = mapped_column(String(12))            # temp_max | temp_min | receiving
    template_key: Mapped[str] = mapped_column(String(16))    # fridge | freezer | hot_holding | reheating | receiving
    group_key: Mapped[str] = mapped_column(String(16))       # temperatures | reheating | receiving
    name: Mapped[str] = mapped_column(String(60))             # verbatim
    note: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    archived_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class FoodCheckRevision(Base):
    __tablename__ = "food_check_revisions"
    __table_args__ = (
        Index("ix_food_check_revisions_check_valid", "check_id", "valid_from"),
        Index("ix_food_check_revisions_user", "user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    check_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("food_checks.id"))
    valid_from: Mapped[datetime] = mapped_column(DateTime)   # server clock
    name: Mapped[str] = mapped_column(String(60))
    note: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    # Deactivate / archive = a revision with active=false.
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    limit_c: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 1), nullable=True)
    limit_source: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    # Receiving only: JSON {"chilled": {"limit_c": 5.0, "source": "law"}, ...}
    product_limits: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # JSON {"type":"daily","due":"08:00"} | {"type":"weekly","weekday":0,"due":"08:00"} | {"type":"on_event"}
    schedule: Mapped[str] = mapped_column(Text)
    action_codes: Mapped[str] = mapped_column(Text)           # JSON list
    fate_codes: Mapped[str] = mapped_column(Text)             # JSON list
    recheck_min: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    created_by_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(GUID(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class FoodCheckEntry(Base):
    __tablename__ = "food_check_entries"
    __table_args__ = (
        # An Index (not a UniqueConstraint) so create_all and the
        # IF NOT EXISTS mirror in main.py produce ONE index of ONE name.
        Index("ux_food_check_entries_client", "user_id", "client_id", unique=True),
        Index("ix_food_check_entries_user_day", "user_id", "business_date"),
        Index("ix_food_check_entries_check_time", "check_id", "recorded_at"),
        Index(
            "ix_food_check_entries_open_dev", "user_id", "deviation_state",
            postgresql_where=text("deviation_state = 'open'"),
            sqlite_where=text("deviation_state = 'open'"),
        ),
        Index("ix_food_check_entries_recorded", "recorded_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    branch_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("branches.id"), nullable=True
    )
    check_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("food_checks.id"))
    # The revision in force at recorded_at.
    revision_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("food_check_revisions.id"))
    client_id: Mapped[str] = mapped_column(String(36))        # device-made uuid (idempotency)
    business_date: Mapped[date] = mapped_column(Date)         # venue zone + cutoff
    slot_due_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    recorded_at: Mapped[datetime] = mapped_column(DateTime)   # server clock: THE official time
    client_typed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    value_c: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 1), nullable=True)
    done: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)            # R1b ticks
    product_type: Mapped[Optional[str]] = mapped_column(String(12), nullable=True)
    limit_c: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 1), nullable=True)
    limit_direction: Mapped[Optional[str]] = mapped_column(String(3), nullable=True)
    in_limit: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    late: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    product_note: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    label_ok: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    action_code: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    action_other: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    fate_code: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    fate_other: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    action_note: Mapped[Optional[str]] = mapped_column(String(280), nullable=True)
    acted_by_name: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    # NULL | 'open' | 'closed' — the one mutable cache on a reading.
    deviation_state: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    followup_of_id: Mapped[Optional[uuid.UUID]] = mapped_column(GUID(), nullable=True)   # no FK
    source: Mapped[str] = mapped_column(String(8), default="live", nullable=False)
    paper_measured_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    staff_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("staff_members.id"), nullable=True
    )
    staff_name: Mapped[str] = mapped_column(String(80))       # snapshot, verbatim
    name_source: Mapped[str] = mapped_column(String(10))      # picked | typed
    via: Mapped[str] = mapped_column(String(10))              # kitchen | owner_app | shared
    kitchen_link_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("kitchen_links.id"), nullable=True
    )
    actor_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(GUID(), nullable=True)   # no FK
    voided_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    void_reason: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    supersedes_id: Mapped[Optional[uuid.UUID]] = mapped_column(GUID(), nullable=True)    # no FK, R1b
    correction_reason: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    # R1b (Migration 089): the owner's own words, verbatim, ≤ 120, immutable
    # after insert like every other column. TWO columns, two meanings:
    # reason_text = why a "Fra papir" reading came in late (a correction of a
    # paper row carries it over, so the folder keeps the real paper reason);
    # correction_text = why THIS row corrected another ("Andet: …").
    reason_text: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    correction_text: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class FoodCheckSettings(Base):
    __tablename__ = "food_check_settings"

    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), primary_key=True)
    staff_card: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)              # R2
    findsmiley_url: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)             # R1b
    findsmiley_on_booking: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)   # R1b
    setup_done_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # R1b (Migration 089): a grocery / veggie_shop / kiosk switched egenkontrol
    # on (retail opt-in). Food service and bar never need it.
    opted_in: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class FoodCheckReview(Base):
    """R1b — "Ugens egenkontrol": the owner marked a business week's
    registrations as reviewed. One row per venue per ISO week (unique), never
    edited (listener below). Kept 730 days by reviewed_at, like the readings
    (jobs/privacy_purges), and deleted with the account. actor_name and note
    are the owner's own words, verbatim."""
    __tablename__ = "food_check_reviews"
    __table_args__ = (
        Index("ux_food_check_reviews_week", "user_id", "iso_week", unique=True),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    iso_week: Mapped[str] = mapped_column(String(8))            # "2026-W46"
    week_start: Mapped[date] = mapped_column(Date)              # the Monday
    reviewed_at: Mapped[datetime] = mapped_column(DateTime)     # server clock
    actor_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(GUID(), nullable=True)   # no FK
    actor_name: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    note: Mapped[Optional[str]] = mapped_column(String(280), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class FoodCheckDocument(Base):
    """R1b — a document the OWNER put in the Kontrolmappe (egenkontrolprogram,
    risikoanalyse, rengøringsplan, hygiejnebevis, …): a PDF stored as-is or an
    image re-encoded to JPEG (EXIF/GPS stripped), in private EU storage under
    "<owner>/food_check_document/<sha256>.<ext>" — content-addressed, so a
    delete removes the blob only when no other row uses the key. Served only
    through the tenant-re-checked proxy routes, as an attachment. Not purged
    by time: kept until the owner deletes it or the account. Only
    reviewed_at / reviewed_by_user_id ever change (listener below)."""
    __tablename__ = "food_check_documents"
    __table_args__ = (
        Index("ix_food_check_documents_user", "user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    # NULL = the whole venue (the R1b UI always sends NULL).
    branch_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("branches.id"), nullable=True
    )
    doc_type: Mapped[str] = mapped_column(String(24))
    title: Mapped[str] = mapped_column(String(120))             # verbatim
    storage_key: Mapped[str] = mapped_column(String(200))
    content_type: Mapped[str] = mapped_column(String(40))
    size_bytes: Mapped[int] = mapped_column(Integer)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime)
    uploaded_by_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(GUID(), nullable=True)
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    reviewed_by_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(GUID(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class FoodCheckPhoto(Base):
    """R1b — one optional photo on a reading (a deviation, or a goods
    delivery): re-encoded JPEG, EXIF/GPS stripped, private EU storage under
    "<owner>/food_check_photo/<sha256>.jpg". At most one row per reading
    (unique entry_id), added within 24 h of the reading.

    storage_key is NULLABLE on purpose: when the owner removes a photo (one
    that shows a person, say) the blob is deleted at once and the row stays
    as a TOMBSTONE (removed_at, removed_by_user_id, storage_key NULL), so the
    Kontrolmappe and the PDF can say "Foto fjernet af ejeren <dato>". Kept
    with its reading for 730 days (privacy_purges deletes the photo rows and
    blobs first, then the readings) and deleted with the account."""
    __tablename__ = "food_check_photos"
    __table_args__ = (
        Index("ux_food_check_photos_entry", "entry_id", unique=True),
        Index("ix_food_check_photos_user", "user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    entry_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("food_check_entries.id"))
    storage_key: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    content_type: Mapped[str] = mapped_column(String(40))
    size_bytes: Mapped[int] = mapped_column(Integer)
    via: Mapped[str] = mapped_column(String(10))                # kitchen | owner_app | shared
    kitchen_link_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("kitchen_links.id"), nullable=True
    )
    actor_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(GUID(), nullable=True)   # no FK
    uploaded_at: Mapped[datetime] = mapped_column(DateTime)
    removed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    removed_by_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(GUID(), nullable=True)   # no FK
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


# ── App-level immutability (the SQLite-side twin of the PG triggers) ─────

# The only columns a save or an undo may touch on a stored reading.
ENTRY_MUTABLE_COLUMNS = frozenset({"deviation_state", "voided_at", "void_reason", "staff_id"})
# ...and only within these values: the folder and the PDF read both columns,
# so a deviation never goes to or from NULL and a void names its reason.
DEVIATION_STATES = ("open", "closed")
# 'correction' (R1b): the reading was replaced by a correction row
# (supersedes_id) and stays printed under Rettelser.
VOID_REASONS = ("undo", "correction")


def _changed_columns(mapper, target) -> set[str]:
    out = set()
    for prop in mapper.column_attrs:
        if get_history(target, prop.key).has_changes():
            out.add(prop.key)
    return out


@event.listens_for(FoodCheckEntry, "before_update")
def _guard_entry_update(mapper, connection, target):
    changed = _changed_columns(mapper, target)
    if not changed:
        return
    illegal = changed - ENTRY_MUTABLE_COLUMNS
    if illegal:
        raise EntryImmutableError(
            "food_check_entries: a saved reading cannot be changed, only voided "
            f"(tried: {', '.join(sorted(illegal))})"
        )
    # Compare against the STORED row, exactly as the trigger compares NEW to
    # OLD — the in-memory history may not hold the old value of an expired
    # attribute.
    t = FoodCheckEntry.__table__
    old = connection.execute(
        select(t.c.voided_at, t.c.void_reason, t.c.staff_id, t.c.deviation_state)
        .where(t.c.id == str(target.id))
    ).first()
    if old is None:
        return
    old_voided, old_reason, old_staff, old_dev = old[0], old[1], old[2], old[3]
    if old_voided is not None and (
        target.voided_at != old_voided or target.void_reason != old_reason
    ):
        raise EntryImmutableError("food_check_entries: a voided reading stays voided")
    if target.voided_at is None and target.void_reason != old_reason:
        raise EntryImmutableError("food_check_entries: void_reason only with voided_at")
    if old_voided is None and target.voided_at is not None and target.void_reason not in VOID_REASONS:
        raise EntryImmutableError("food_check_entries: void_reason must be a known reason")
    if target.deviation_state != old_dev and (
        old_dev is None or target.deviation_state not in DEVIATION_STATES
    ):
        raise EntryImmutableError(
            "food_check_entries: a deviation only moves between open and closed"
        )
    new_staff = None if target.staff_id is None else str(target.staff_id)
    old_staff_s = None if old_staff is None else str(old_staff)
    if new_staff != old_staff_s and new_staff is not None:
        raise EntryImmutableError("food_check_entries: staff_id may only be cleared")


@event.listens_for(FoodCheckRevision, "before_update")
def _guard_revision_update(mapper, connection, target):
    if _changed_columns(mapper, target):
        raise EntryImmutableError(
            "food_check_revisions: a revision is never changed; write a new one"
        )


# R1b — the new tables have no Postgres trigger; these listeners are the
# app-level rule on BOTH engines (every write goes through the ORM).

@event.listens_for(FoodCheckReview, "before_update")
def _guard_review_update(mapper, connection, target):
    if _changed_columns(mapper, target):
        raise EntryImmutableError("food_check_reviews: a weekly review is never changed")


DOCUMENT_MUTABLE_COLUMNS = frozenset({"reviewed_at", "reviewed_by_user_id"})


@event.listens_for(FoodCheckDocument, "before_update")
def _guard_document_update(mapper, connection, target):
    illegal = _changed_columns(mapper, target) - DOCUMENT_MUTABLE_COLUMNS
    if illegal:
        raise EntryImmutableError(
            "food_check_documents: only the review date changes "
            f"(tried: {', '.join(sorted(illegal))})"
        )


PHOTO_MUTABLE_COLUMNS = frozenset({"removed_at", "removed_by_user_id", "storage_key"})


@event.listens_for(FoodCheckPhoto, "before_update")
def _guard_photo_update(mapper, connection, target):
    """A photo row only ever moves ONE way: removed (tombstone) — removed_at
    None → a time, once; storage_key → NULL; removed_by set with it."""
    changed = _changed_columns(mapper, target)
    if not changed:
        return
    illegal = changed - PHOTO_MUTABLE_COLUMNS
    if illegal:
        raise EntryImmutableError(
            f"food_check_photos: a photo row cannot be changed (tried: {', '.join(sorted(illegal))})"
        )
    t = FoodCheckPhoto.__table__
    old = connection.execute(
        select(t.c.removed_at, t.c.storage_key, t.c.removed_by_user_id)
        .where(t.c.id == str(target.id))
    ).first()
    if old is None:
        return
    if old[0] is not None:
        raise EntryImmutableError("food_check_photos: a removed photo stays removed")
    if target.removed_at is None:
        raise EntryImmutableError("food_check_photos: only a removal may change a photo row")
    if target.storage_key is not None:
        raise EntryImmutableError("food_check_photos: a removed photo keeps no blob key")
