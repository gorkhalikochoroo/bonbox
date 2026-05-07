"""Smart inventory import audit table — one row per import attempt.

Mirrors the KasserapportExtraction shape because the smart-inventory
pipeline mirrors the kasserapport pipeline architecturally:
  user uploads (text / CSV / Excel / image / voice) →
    extractor parses to structured items →
    categorizer assigns categories (deterministic + AI fallback) →
    user reviews/corrects on a UI screen →
    commit creates real InventoryItem rows.

We log every step so the founder + future training review can trace
"why did 32 of these get auto-flagged for manual review?" back to the
exact bytes the extractor saw, the prompt version, the cost, and what
the user changed before they clicked Commit.

Defense relevance:
  • source_sha256 enables idempotency dedup ("you already imported this
    file 3 minutes ago — review the existing draft instead of paying
    for another extraction").
  • prompt_version + extracted_json + final_json gives us the
    correction-corpus needed for per-owner few-shotting later.
  • input_tokens/output_tokens lets us enforce the daily AI-spend cap
    per tier (Free: tiny, Pro: generous) without trusting the client.
  • created_at + committed_at gives us "extracted but never committed"
    rows = a key signal that the extractor is producing junk for a
    given owner / format and we should review.

Bogføringsloven 2024 §10 — audit trails for accounting-related events
must be retained for 5 years; this row is part of that trail when the
imported items become InventoryItem rows used in COGS / margin reports.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean, DateTime, ForeignKey, Index, Integer, JSON, String, Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class InventoryImport(Base):
    """One row per smart-inventory import attempt — for analytics +
    admin review + few-shot learning.

    Status flow:
      created (extracted, awaiting user review)
        → committed (user clicked Save → real InventoryItem rows live)
        → abandoned (user closed without committing — counts toward
          "extractor produced unusable output for this owner")
        → failed (extractor errored — see `error` field)
    """
    __tablename__ = "inventory_imports"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)

    # Source — what the user uploaded.
    # source_kind: "text" | "csv" | "excel" | "image" | "voice"
    # Bounded VARCHAR not enum for forward-compat (e.g. add "pdf" without migration).
    source_kind: Mapped[str] = mapped_column(String(20), default="text")
    source_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # SHA256 of the raw upload bytes — used for dedup + tying corrections
    # back to the exact input the extractor saw.
    source_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # Storage path for the original upload (image kind only). Format:
    # `<user_id>/inventory_import/<sha>.<ext>`. NULL for non-image
    # kinds. Served via /api/inventory/smart-import/{id}/image.
    storage_key: Mapped[str | None] = mapped_column(String(300), nullable=True)

    # Pipeline outputs.
    # extracted_json: list of {name, qty, unit, ...} the extractor returned.
    # categorized_json: same list with `category` added by categorizer.
    # final_json: what was actually committed (after user edits in the
    #   review UI). Comparing extracted_json → final_json reveals where
    #   the extractor was wrong, feeding the per-owner few-shot corpus.
    extracted_json: Mapped[list | None] = mapped_column(JSON, nullable=True)
    categorized_json: Mapped[list | None] = mapped_column(JSON, nullable=True)
    final_json: Mapped[list | None] = mapped_column(JSON, nullable=True)

    item_count: Mapped[int] = mapped_column(Integer, default=0)
    committed_count: Mapped[int] = mapped_column(Integer, default=0)
    user_corrected: Mapped[bool] = mapped_column(Boolean, default=False)
    manual_review_needed: Mapped[bool] = mapped_column(Boolean, default=True)

    # Extractor confidence (0.0-1.0) — flag below threshold for manual review.
    extraction_confidence: Mapped[float | None] = mapped_column(nullable=True)

    # Cost / performance tracking — fed into the per-tier daily AI-spend cap.
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    model_used: Mapped[str | None] = mapped_column(String(60), nullable=True)
    timing_ms: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Audit trail.
    prompt_version: Mapped[str | None] = mapped_column(String(80), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="created")

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, index=True)
    committed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    __table_args__ = (
        Index("ix_inventory_imports_user_created", "user_id", "created_at"),
        Index("ix_inventory_imports_user_status", "user_id", "status"),
    )
