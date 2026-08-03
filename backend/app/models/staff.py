"""Staff Module models — staff members, schedules, hours, tips."""

import uuid
from datetime import date, datetime
from typing import Optional

from sqlalchemy import (
    String, Boolean, Date, DateTime, LargeBinary, Numeric, ForeignKey, Text, Integer,
    UniqueConstraint, CheckConstraint, Index,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


class StaffMember(Base):
    __tablename__ = "staff_members"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(String(255))
    phone: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    # Staff self-edit (portal/chat). `display_name` overrides `name` ONLY in chat
    # + portal chrome — NEVER in lønseddel/revisor artifacts: the owner-set legal
    # `name` stays authoritative for payroll. `profile_photo_key` is a storage
    # compose_key (NOT a URL); served only via the tenant-re-checked proxy
    # endpoint, never a public/signed URL. `profile_photo_at` = cache-bust stamp.
    display_name: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    profile_photo_key: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    profile_photo_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Staff self-edit (portal) — home address, so the owner has a current
    # contact address on file without chasing the staffer. PII: rides on this
    # tenant-scoped row (purged by the metadata-driven GDPR erasure sweep).
    # DK-structured: `address` = gade + husnummer (+ etage/dør), `postal_code`
    # = postnr, `city` = by. All nullable/optional — never required.
    # NOT a payroll field (see decision_staff_scope_not_payroll): the staff
    # module tracks schedule/hours, not CPR/konto. `address_updated_at` stamps
    # the last change so the owner can see "Opdateret {dato}" at a glance.
    address: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    postal_code: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    city: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    address_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Bank account (DK registreringsnummer + kontonummer), staff-entered in the
    # portal so the owner has it for the payroll export.
    #
    # This is the ONE payroll-adjacent field in the module, added by explicit
    # owner decision on 2026-08-01, narrowing the "no banking" line above. CPR,
    # pay maths, feriepenge and eIndkomst all remain out of scope — we still do
    # not compute anyone's pay.
    #
    # ENCRYPTED AT REST via app/utils/crypto (MultiFernet, rotation-aware).
    # Stored as ciphertext bytes, never as digits. The staff member only ever
    # sees the last 4 and only after the PIN; the owner sees the full number
    # because paying someone requires it, and every such read is audited.
    #
    # RETENTION: deliberately NOT wiped on deactivate. Staff are only ever
    # deactivated (`active = False`), never soft-deleted, and a deactivated
    # staffer is often seasonal or still owed a final salary — dropping the
    # account there would break the last payslip. It is removed by the staffer
    # (DELETE /portal/{token}/bank) or by the owner (DELETE
    # /api/staff/members/{id}/bank).
    #
    # ⚠️ ACCOUNT-LEVEL ERASURE DOES NOT REACH THIS ROW TODAY. Verified against
    # prod 2026-08-01: audit_logs.user_id / audit_logs.actor_id /
    # security_events.user_id are FKs to users.id with delete_rule NO ACTION,
    # and those tables are deliberately RETAINED under Bogføringsloven §10
    # (auth.py _ERASURE_RETAINED_TABLES). So db.delete(current_user) FK-violates
    # and the whole Art.17 transaction rolls back — 70 of 71 prod users have
    # audit rows. That is a PRE-EXISTING bug, not one this field introduced, but
    # it means the two explicit deletes above are the only real erasure lever
    # until those FKs become ON DELETE SET NULL.
    bank_reg_nr_enc: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    bank_account_enc: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    bank_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    role: Mapped[str] = mapped_column(String(50), default="server")
    contract_type: Mapped[str] = mapped_column(String(20), default="full")
    base_rate: Mapped[Optional[float]] = mapped_column(Numeric(10, 2), nullable=True)
    evening_rate: Mapped[Optional[float]] = mapped_column(Numeric(10, 2), nullable=True)
    weekend_rate: Mapped[Optional[float]] = mapped_column(Numeric(10, 2), nullable=True)
    holiday_rate: Mapped[Optional[float]] = mapped_column(Numeric(10, 2), nullable=True)
    max_hours_month: Mapped[Optional[float]] = mapped_column(Numeric(6, 1), nullable=True)
    max_hours_week: Mapped[Optional[float]] = mapped_column(Numeric(5, 1), nullable=True)
    # Vagtplan Shield toggle — False silences HOUR-LIMIT warnings (contract
    # cap / 48h / 90t-md) for this staffer. The 11-timers rest warning is NOT
    # covered: hviletid is safety law, not a preference. Default ON.
    hour_limit_warn: Mapped[bool] = mapped_column(Boolean, default=True)
    # Pre-shift push reminder. NULL = off; an int is the lead time in minutes.
    # Opt-in only — a reminder nobody asked for is a notification they did not
    # consent to, and the staffer chooses the lead time because 30 minutes
    # means something different to a cyclist and a commuter.
    shift_reminder_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Danish A-skat trækkort — affects A-skat rate + personfradrag eligibility.
    # Values: "hovedkort" (default, 36% w/ personfradrag), "bikort" (42% no
    # personfradrag), "frikort" (0% until annual limit). NULL = treated as
    # hovedkort. tax_card_rate is an optional override (0.0–0.6) for owners
    # who copy the exact rate from the employee's eSkattekort.
    tax_card_type: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    tax_card_rate: Mapped[Optional[float]] = mapped_column(Numeric(5, 4), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
    )

    schedules: Mapped[list["Schedule"]] = relationship(back_populates="staff_member")
    hours_logged: Mapped[list["HoursLogged"]] = relationship(back_populates="staff_member")
    tip_distributions: Mapped[list["TipDistribution"]] = relationship(back_populates="staff_member")


class StaffDocument(Base):
    """An employment document the owner shares with ONE staff member.

    Contract, addendum, certificate — the things a staffer periodically needs a
    copy of and currently has to ask for. The owner uploads; the staffer reads
    it in their portal behind the PIN.

    The blob lives in storage under the `staff_document` kind; this row is the
    metadata (who it belongs to, what to call it, when it landed). Two reasons
    the row exists rather than deriving everything from the key:
      • there can be many per staffer and they need human labels;
      • deleting the row is how the owner un-shares a document, and the blob is
        removed alongside it.

    RETENTION: `staff_document` is in storage.ERASURE_PURGE_KINDS, so Art.17
    account erasure removes the blobs; this table carries a users.id FK so the
    metadata-driven row sweep takes the rows. Employment documents are NOT
    accounting records — Bogføringsloven §10 does not apply.
    """

    __tablename__ = "staff_documents"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)
    staff_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("staff_members.id"), index=True)
    # Human label the staffer sees ("Ansættelseskontrakt 2026").
    label: Mapped[str] = mapped_column(String(120))
    # Storage key from compose_key(user_id, "staff_document", sha, ext).
    storage_key: Mapped[str] = mapped_column(String(200))
    content_type: Mapped[str] = mapped_column(String(80))
    size_bytes: Mapped[int] = mapped_column(Integer)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)


class PayPeriodConfig(Base):
    __tablename__ = "pay_period_configs"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_pay_period_config_user"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), unique=True)
    period_type: Mapped[str] = mapped_column(String(20), nullable=False)
    custom_start_day: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
    )


class Schedule(Base):
    __tablename__ = "schedules"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    staff_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("staff_members.id"))
    date: Mapped[date] = mapped_column(Date)
    start_time: Mapped[str] = mapped_column(String(5))
    end_time: Mapped[str] = mapped_column(String(5))
    break_minutes: Mapped[int] = mapped_column(Integer, default=0)
    role_on_shift: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="draft")
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Optional location (multi-location S3). NULL = unassigned/main — the
    # single-location owner's schedule never carries or shows a branch.
    branch_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("branches.id"), nullable=True,
    )
    # Bidirectional notification loop (May 2026): when staff opens the
    # schedule via their portal link and taps "I've got it", we stamp
    # confirmed_at. The owner's dashboard shows "N of M confirmed for
    # this week" as a calm awareness signal — no chase emails, no
    # nagging, just a glance. NULL means not-yet-confirmed (or this
    # shift was published before the feature existed).
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)

    staff_member: Mapped["StaffMember"] = relationship(back_populates="schedules")


class StaffAvailability(Base):
    """A staff member's standing "kan ikke arbejde" (or preferred) window.

    UNLIKE StaffAbsence (an EVENT — syg today, ferie next week), availability is
    a STANDING PREFERENCE the owner sees WHILE building the roster: recurring (a
    weekday, e.g. "aldrig mandage") or a one-off date. It never changes the
    schedule by itself — it's a soft signal the owner sees and the autopilot
    respects (Planday calls this "unavailability").

    Exactly one of (weekday, specific_date) is set — enforced at the schema
    layer. NULL start_time/end_time means the WHOLE day. `kind` discriminates
    "unavailable" (the default, "kan ikke") from "preferred" (a soft "helst").

    Tenant boundary: user_id is the OWNER (employer); staff_id is the member.
    The portal write path re-derives BOTH from the magic-link token — a value
    from the request body is never trusted (a peer can't set availability for
    someone else).
    """
    __tablename__ = "staff_availability"
    __table_args__ = (
        Index("ix_staff_availability_user", "user_id"),
        Index("ix_staff_availability_staff", "staff_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    staff_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("staff_members.id"))
    kind: Mapped[str] = mapped_column(String(20), default="unavailable")
    weekday: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # 0=Mon..6=Sun (recurring)
    specific_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)  # one-off
    start_time: Mapped[Optional[str]] = mapped_column(String(5), nullable=True)  # "HH:MM", NULL=all day
    end_time: Mapped[Optional[str]] = mapped_column(String(5), nullable=True)
    note: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
    )


class HoursLogged(Base):
    __tablename__ = "hours_logged"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    staff_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("staff_members.id"))
    date: Mapped[date] = mapped_column(Date)
    start_time: Mapped[Optional[str]] = mapped_column(String(5), nullable=True)
    end_time: Mapped[Optional[str]] = mapped_column(String(5), nullable=True)
    break_minutes: Mapped[int] = mapped_column(Integer, default=0)
    total_hours: Mapped[float] = mapped_column(Numeric(5, 1))
    rate_applied: Mapped[Optional[float]] = mapped_column(Numeric(10, 2), nullable=True)
    earned: Mapped[Optional[float]] = mapped_column(Numeric(10, 2), nullable=True)
    entry_method: Mapped[str] = mapped_column(String(20), default="quick")
    is_overtime: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)

    staff_member: Mapped["StaffMember"] = relationship(back_populates="hours_logged")


class Tip(Base):
    __tablename__ = "tips"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    date: Mapped[date] = mapped_column(Date)
    total_amount: Mapped[float] = mapped_column(Numeric(10, 2))
    split_method: Mapped[str] = mapped_column(String(20), default="by_hours")
    confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)

    distributions: Mapped[list["TipDistribution"]] = relationship(
        back_populates="tip", cascade="all, delete-orphan"
    )


class TipDistribution(Base):
    __tablename__ = "tip_distributions"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    tip_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("tips.id", ondelete="CASCADE")
    )
    staff_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("staff_members.id"))
    share_pct: Mapped[Optional[float]] = mapped_column(Numeric(5, 2), nullable=True)
    amount: Mapped[float] = mapped_column(Numeric(10, 2))

    tip: Mapped["Tip"] = relationship(back_populates="distributions")
    staff_member: Mapped["StaffMember"] = relationship(back_populates="tip_distributions")


class StaffLink(Base):
    """Magic link for staff self-service portal — no login needed."""
    __tablename__ = "staff_links"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    staff_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("staff_members.id"))
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    # Short, human-typable join code (e.g. "K7P2QM") for the "enter a code to
    # connect" flow — an alternative to tapping the magic link. Unambiguous
    # alphabet (no 0/O/1/I). Resolves to the same token; brute-force is bounded
    # by the public endpoint's hard per-IP rate limit.
    join_code: Mapped[Optional[str]] = mapped_column(String(12), nullable=True, unique=True, index=True)
    # A join code is an ONBOARDING token, not a standing credential.
    #
    # Without these two fields it was neither: idempotent, permanent and
    # infinitely reusable, so a code on a staff-room whiteboard, photographed,
    # or sitting in a two-year-old message still opened the portal today — and
    # the portal now carries bank last-4 and employment documents.
    #
    # Mirrors the pattern already used by StandLink (code_expires_at /
    # code_used_at); this is a consistency fix, not a new invention. Each link
    # belongs to ONE staff member, so burning a code on use costs nothing:
    # "copy links for the whole team" still hands every person their own.
    code_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    code_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    pin_hash: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    # PIN brute-force lockout (multi-layer link protection): a per-LINK
    # counter — per-IP rate limits alone don't stop a distributed guesser
    # on a 4-digit space. 8 fails -> locked 15 min (see staff_portal).
    pin_failed_count: Mapped[int] = mapped_column(Integer, default=0)
    pin_locked_until: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    last_accessed: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class NotificationLog(Base):
    """Log of all notifications sent to staff (email, push, whatsapp)."""
    __tablename__ = "notification_log"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    staff_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("staff_members.id"))
    channel: Mapped[str] = mapped_column(String(20))  # 'email', 'push', 'whatsapp'
    event_type: Mapped[str] = mapped_column(String(50))  # 'schedule_published', 'shift_changed', etc.
    subject: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    body: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="sent")  # sent, failed
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Idempotency key for de-duplicating event-driven pushes (e.g. the
    # freed-table owner ping: dedup_key = "freed:<freed_id>:<match_id>").
    # NULL for the many rows that don't need de-dup. Indexed for the lookup.
    dedup_key: Mapped[Optional[str]] = mapped_column(String(120), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)


class OpenShift(Base):
    """An UNASSIGNED roster slot — "Åbn vagt". The owner posts a hole in the
    week (a cover need); any eligible staffer claims it one-tap from their
    portal, which atomically materializes a real published Schedule row for the
    claimer and notifies the owner.

    Kept as its own table (NOT a Schedule row with a nullable staff_id) so the
    whole cost / payroll / overlap-guard surface — all of which assumes a shift
    HAS a staffer — stays untouched. An OpenShift carries no staff_id until it's
    filled; on claim it spawns a Schedule row and flips to 'filled'.

    status: 'open' (claimable) → 'filled' (claimed, Schedule row spawned)
                              → 'cancelled' (owner withdrew it before anyone took it)
    """
    __tablename__ = "open_shifts"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    date: Mapped[date] = mapped_column(Date)
    start_time: Mapped[str] = mapped_column(String(5))
    end_time: Mapped[str] = mapped_column(String(5))
    break_minutes: Mapped[int] = mapped_column(Integer, default=0)
    role_on_shift: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="open")
    # Where the hole is (multi-location S5). Claim inherits this onto the
    # materialized Schedule row. NULL = unassigned/main.
    branch_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("branches.id"), nullable=True,
    )
    # Filled-in only once a staffer claims it. claimed_schedule_id ties the
    # OpenShift to the Schedule row it spawned (so cancelling a filled slot can
    # find + remove that shift, if we ever allow it).
    claimed_by_staff_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("staff_members.id"), nullable=True
    )
    claimed_schedule_id: Mapped[Optional[uuid.UUID]] = mapped_column(GUID(), nullable=True)
    claimed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)


# ─── Owner ↔ staff 1:1 chat ("Beskeder") ──────────────────────────────────
# One private thread per staffer. The OWNER (user_id) sees every thread; each
# STAFFER sees only their own — the staff endpoints take NO id params, so the
# capability token IS the only scope (nothing to tamper). `user_id` is
# denormalized onto every row so every query filters by tenant, belt-and-braces
# (same pattern as NotificationLog).


class StaffChatThread(Base):
    """One 1:1 conversation between the owner (user_id) and a staffer (staff_id).

    Lazily materialized on first message OR first GET. UNIQUE(user_id, staff_id)
    makes a duplicate/cross-tenant thread structurally impossible — on the race,
    the loser catches IntegrityError and re-SELECTs the winner.
    """

    __tablename__ = "staff_chat_threads"
    __table_args__ = (
        UniqueConstraint("user_id", "staff_id", name="uq_staff_chat_thread"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    staff_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("staff_members.id"))
    last_message_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    owner_last_read_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    staff_last_read_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
    )


class StaffChatMessage(Base):
    """A single message. `sender_type` ('owner'|'staff') is SERVER-authoritative
    — set from the auth path, NEVER trusted from the request body. `user_id` is
    the denormalized tenant key every query filters on."""

    __tablename__ = "staff_chat_messages"
    # photo_count is also app-capped at MAX_PHOTOS; this CHECK is the DB-layer
    # backstop. Named so the idempotent migration's IF-NOT-EXISTS guard matches.
    __table_args__ = (
        CheckConstraint(
            "photo_count BETWEEN 0 AND 3",
            name="staff_chat_messages_photo_count_check",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    thread_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("staff_chat_threads.id", ondelete="CASCADE")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    sender_type: Mapped[str] = mapped_column(String(8))  # 'owner' | 'staff'
    body: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    photo_count: Mapped[int] = mapped_column(Integer, default=0)  # 0..3
    client_msg_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)


class StaffChatPhoto(Base):
    """One photo attached to a message (≤3 per message). `storage_key` is a
    compose_key (NOT a URL); served only via the tenant-re-checked proxy. Its own
    `user_id` lets the serve path authorize without a join."""

    __tablename__ = "staff_chat_photos"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    message_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("staff_chat_messages.id", ondelete="CASCADE")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    storage_key: Mapped[str] = mapped_column(String(200))
    content_type: Mapped[str] = mapped_column(String(40))
    size_bytes: Mapped[int] = mapped_column(Integer)
    ord: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
