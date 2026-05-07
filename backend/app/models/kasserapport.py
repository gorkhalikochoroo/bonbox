"""Kasserapport extraction tables — extracted POS closing reports + a
ground-truth examples library for prompt few-shotting.

Two tables:

  KasserapportExtraction
    Logs every real extraction attempt (image URL + extracted JSON +
    validator pass/fail + user edits before commit). Used by the
    /admin/training review page so the founder can spot patterns
    ("Oasis always misreads tip when negative") and refine prompts.

  KasserapportExample
    Curated ground-truth examples — image + verified JSON. The format
    detector and extractor use these as few-shot inputs. Grows over
    time as the founder reviews extractions and promotes good ones to
    examples.

Both tables are scoped per-user EXCEPT KasserapportExample which can
also be `is_global=True` (founder-curated, used across all customers).
RLS / app-layer auth keeps user examples private.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, JSON, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class KasserapportExtraction(Base):
    """One row per OCR extraction attempt — for analytics + admin review."""
    __tablename__ = "kasserapport_extractions"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)

    # Optional terminal scoping. When the owner has multiple terminals
    # (Mirabelle has 4) each scan is tagged with which terminal it came
    # from so the aggregator can sum across them per close. NULL = single-
    # terminal venue or pre-multi-terminal data.
    terminal_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("terminals.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # Source
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Pipeline outputs
    document_type: Mapped[str] = mapped_column(String(40), default="unknown")
    pos_system: Mapped[str] = mapped_column(String(40), default="unknown")
    classifier_confidence: Mapped[float | None] = mapped_column(Numeric(4, 3), nullable=True)
    format_confidence: Mapped[float | None] = mapped_column(Numeric(4, 3), nullable=True)
    extraction_confidence: Mapped[float | None] = mapped_column(Numeric(4, 3), nullable=True)

    # The structured JSON the extractor returned (full payload)
    extracted_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    # Validator outputs
    validator_failures: Mapped[list | None] = mapped_column(JSON, nullable=True)
    manual_review_needed: Mapped[bool] = mapped_column(Boolean, default=True)

    # User edits before commit (if any) — comparing extracted_json to
    # final_json reveals where the extractor was wrong, which feeds the
    # weekly training review.
    final_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    user_corrected: Mapped[bool] = mapped_column(Boolean, default=False)

    # Cost / performance tracking
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    timing_ms: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Audit trail. image_sha256 enables idempotency dedup + tying owner
    # corrections back to the exact bytes the model saw. prompt_version
    # lets the training review correlate prompt revisions with failure
    # rates ("did errors spike after the v2 prompt change?").
    image_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    prompt_version: Mapped[str | None] = mapped_column(String(80), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, index=True)
    committed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    __table_args__ = (
        Index("ix_kasse_extractions_user_created", "user_id", "created_at"),
        Index("ix_kasse_extractions_pos_system", "pos_system"),
    )


class KasserapportExample(Base):
    """Curated ground-truth example — image + verified JSON. Used as few-shot
    examples in the extractor prompt for the matching POS system."""
    __tablename__ = "kasserapport_examples"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    # NULL user_id + is_global=True = founder-curated, used across all customers
    user_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id"), nullable=True, index=True)
    is_global: Mapped[bool] = mapped_column(Boolean, default=False, index=True)

    pos_system: Mapped[str] = mapped_column(String(40), default="unknown", index=True)

    # Source — kept for visual review during prompt tuning
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Verified ground-truth JSON (matches the extract_kasserapport tool schema)
    truth_json: Mapped[dict] = mapped_column(JSON)

    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Promoted from a real extraction? If yes, link back so we can audit
    # (and for traceability when the example produces wrong inferences).
    promoted_from_extraction_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("kasserapport_extractions.id"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
    )
