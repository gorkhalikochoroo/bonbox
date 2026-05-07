"""Per-owner few-shot example library for smart inventory imports.

Mirror of KasserapportExample, scoped to inventory imports. Captures
the {extracted_name → owner_corrected_name, owner_corrected_category}
deltas owners make on the smart-import review screen, then feeds
them back into the next extraction's prompt as few-shot examples.

Why this matters:
  • Owners name things in idiosyncratic ways. Lars at Mirabelle types
    'Toob 33' for what the AI extracted as 'Tuborg Pilsner 33cl';
    after the third correction, the AI should learn HIS shorthand.
  • Supplier slips have repeating layouts (Hørkram delivers fish on
    the same form every Tuesday). Once the AI sees one example of
    Hørkram's slip parsed correctly, the next week's extraction is
    near-perfect.
  • Custom categories — owner renames 'Beer' to 'Øl' in their
    taxonomy → examples carry that preference forward.

Storage strategy:
  • Per-user only (no global examples — each owner's vocabulary is
    their own). No is_global flag like KasserapportExample because
    we don't curate inventory examples centrally.
  • Auto-promotion: on /commit when user_corrected=True we capture
    the diff. Soft cap (MAX_EXAMPLES_PER_USER = 50) prevents the
    table from ballooning; oldest-first eviction.
  • Examples are pruned when the source InventoryImport is older
    than RETENTION_DAYS (180) since fresher feedback is more
    representative of current supplier patterns.

Privacy:
  • Examples never leave the per-user scope. The few-shot prompt
    sent to Anthropic includes ONLY this owner's examples, never
    cross-user.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime, ForeignKey, Index, Integer, JSON, String, Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID


# Soft caps — enforced in the promotion service, not the schema.
MAX_EXAMPLES_PER_USER = 50
RETENTION_DAYS = 180


class InventoryImportExample(Base):
    """One row per learned correction. Joined into the extractor's
    few-shot prompt for the same owner.

    Two example shapes:
      kind='name_correction':
        extracted_name='Tuborg' → final_name='Tuborg Pilsner 33cl'
        Helps the extractor produce the owner's preferred SKU naming.

      kind='category_correction':
        extracted_name='Mango', final_category='Garnish' (overriding
        whatever the categorizer auto-picked).
        Helps the categorizer disambiguate items that fall between
        rule-buckets in this owner's vertical.
    """
    __tablename__ = "inventory_import_examples"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)

    # 'name_correction' | 'category_correction'
    kind: Mapped[str] = mapped_column(String(30), default="name_correction")

    # The original AI-extracted shape (name + optional category) for matching.
    extracted_name: Mapped[str] = mapped_column(String(200))
    extracted_category: Mapped[str | None] = mapped_column(String(60), nullable=True)

    # The owner's corrected version — what we WANT the AI to produce
    # next time it sees a similar input.
    final_name: Mapped[str] = mapped_column(String(200))
    final_category: Mapped[str | None] = mapped_column(String(60), nullable=True)

    # Provenance — link back to the import row this example came from
    # (for traceability + bulk-removal if an owner says "stop
    # learning from that day's import").
    promoted_from_import_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("inventory_imports.id", ondelete="SET NULL"),
        nullable=True,
    )

    # How many times this exact correction has been observed. We bump
    # on duplicate corrections rather than create dup rows — gives
    # us a confidence signal in the prompt ("learned 5x" > "learned 1x").
    hit_count: Mapped[int] = mapped_column(Integer, default=1)

    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    __table_args__ = (
        Index("ix_inv_imp_examples_user_kind", "user_id", "kind"),
        Index("ix_inv_imp_examples_user_extracted", "user_id", "extracted_name"),
    )
