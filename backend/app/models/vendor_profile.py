"""Per-vendor memory — an evidence ledger, not a score.

One row per (user, vendor_key, field, value). We store COUNTS the owner
could audit ("kort — som de sidste 6 gange hos Netto"), never a tuned
confidence number. The previous design's hardcoded 0.9/0.7/0.6 were
presented to the UI as "confidence" while reflecting no measured
accuracy at all; replacing them with a formula we tune until it gives
the answer we wanted would be the same dishonesty in nicer clothes.

Why a row per VALUE rather than a row per field:
  A correction has to leave a mark on the value it corrected. With one
  row per field we would overwrite "card" with "cash" and lose the fact
  that "card" was ever wrong here — which is exactly how the existing
  category_mappings loop forgets corrections. Keeping both rows lets a
  disagreement outlive the value that caused it.

Bounded by construction: 4 fields x small value domains x the tens of
suppliers a café actually buys from. No unigram/bigram spray like
category_mappings (which writes N unigrams + N-1 bigrams per save and
has no unique constraint, no index and no pruning).

GDPR: user_id is NOT NULL with ON DELETE CASCADE — there is no global /
NULL row, so cross-tenant learning is impossible by construction rather
than by policy.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    String, DateTime, Integer, Boolean, Numeric, ForeignKey, Index,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now

# The only fields memory is allowed to hold an opinion about. Amount and
# date are deliberately absent: those are read off the paper or they are
# not known, and a remembered amount would be a fabricated figure in the
# books. Currency is absent until the FX trio is wired end to end.
VENDOR_MEMORY_FIELDS = ("payment_method", "category_name", "is_personal", "is_recurring")


class VendorProfile(Base):
    __tablename__ = "vendor_profiles"
    __table_args__ = (
        UniqueConstraint("user_id", "vendor_key", "field", "value", name="uq_vendor_profile_value"),
        Index("ix_vendor_profile_lookup", "user_id", "vendor_key", "field"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    vendor_key: Mapped[str] = mapped_column(String(80))
    # The owner's own words for this supplier, for the memory line. Not
    # the canonical key — that reads like machine output.
    display_name: Mapped[str | None] = mapped_column(String(160), nullable=True)

    field: Mapped[str] = mapped_column(String(24))
    value: Mapped[str] = mapped_column(String(100))

    agree_count: Mapped[int] = mapped_column(Integer, default=0)
    disagree_count: Mapped[int] = mapped_column(Integer, default=0)
    # Consecutive agreements on THIS value. Any disagreement zeroes it.
    # Trust is re-earned, never averaged back — one correction has to
    # outrank five confirmations or a stale habit never dies.
    streak: Mapped[int] = mapped_column(Integer, default=0)
    # Sightings remaining before this value may auto-fill again after a
    # correction. Decremented on each recall; auto-fill is blocked while
    # > 0 regardless of how good the counts look.
    demote_sightings: Mapped[int] = mapped_column(Integer, default=0)

    # Snapshot of the §42 fradrag factor at confirm time (category rows
    # only). If a later proposal would MOVE this, it can never auto-fill:
    # dk_fradrag defaults unknown category names to FULL, so the
    # dangerous direction is over-claiming købsmoms.
    fradrag_class: Mapped[float | None] = mapped_column(Numeric(3, 2), nullable=True)

    # Owner said "stop filling this in for me here".
    is_locked: Mapped[bool] = mapped_column(Boolean, default=False)

    last_agree_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_disagree_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)
