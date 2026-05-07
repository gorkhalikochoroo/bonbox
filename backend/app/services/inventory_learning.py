"""Smart-inventory learning loop — promote owner corrections to per-
owner few-shot examples + retrieve them for the next extraction.

Public surface:
  promote_corrections(db, imp, extracted, final) -> int
      Called from /commit when user_corrected=True. Diffs extracted vs
      final, persists each meaningful correction as an example.
      Returns number of new/updated examples.

  get_examples_for_user(db, user_id, *, kind=None, limit=10)
      Retrieve top-N examples for a user, ordered by hit_count DESC,
      then most-recent. Used to build few-shot prompts.

  prune_stale_examples(db, user_id) -> int
      Drop examples older than RETENTION_DAYS or beyond
      MAX_EXAMPLES_PER_USER. Called opportunistically on /commit.

Defense:
  • Per-user scoped — examples for owner A are never visible to
    owner B at the SQL or prompt level.
  • Bounded: max 50 examples per user; auto-evict oldest.
  • Length-capped: extracted_name + final_name truncated to schema
    max (200 / 60 chars) before storage.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.inventory_import_example import (
    MAX_EXAMPLES_PER_USER, RETENTION_DAYS, InventoryImportExample,
)
from app.utils.time import utc_now

logger = logging.getLogger(__name__)


# ─── Diff helpers ──────────────────────────────────────────────────────

def _norm_name(s: str | None) -> str:
    """Trim + lowercase for similarity matching."""
    return (s or "").strip().lower()


def _is_meaningful_correction(extracted: dict, final: dict) -> tuple[bool, str]:
    """Decide whether this {extracted → final} pair is worth saving.

    Returns (is_meaningful, kind). Kind is 'name_correction' or
    'category_correction'. Trivial cases (whitespace-only, identical,
    empty) return (False, '').

    We keep examples that show the AI something it could ACT on next
    time:
      • A meaningful name change (different beyond casing/whitespace)
      • A meaningful category change
    """
    ext_name = _norm_name(extracted.get("name"))
    fin_name = _norm_name(final.get("name"))
    ext_cat = _norm_name(extracted.get("category"))
    fin_cat = _norm_name(final.get("category"))

    if not fin_name:
        return False, ""

    # Name correction: anything more than whitespace/casing diff counts.
    # We dedupe identical corrections via hit_count later, so being
    # generous here is safe — false positives just bump a counter,
    # they don't pollute the prompt with junk.
    if ext_name and ext_name != fin_name:
        return True, "name_correction"

    # Category correction.
    if ext_cat and fin_cat and ext_cat != fin_cat:
        return True, "category_correction"

    return False, ""


# ─── Promotion ─────────────────────────────────────────────────────────

def promote_corrections(
    db: Session,
    *,
    user_id,
    import_id,
    extracted: list[dict] | None,
    final: list[dict],
    is_global: bool = False,
) -> int:
    """Persist owner corrections from a /commit as few-shot examples.

    Pairing strategy: positional (extracted[i] vs final[i]) when the
    counts match. When they don't (owner removed or added items at
    review time), we fall back to name-based matching — pair each
    final item with the extracted item whose name is closest. This
    keeps the diff sane even when the user reorders or trims.

    `is_global` (default False): when True, examples are stored with
    `is_global=True` and `user_id=None` so they benefit every owner.
    The router sets this when the committing user has role='super_admin'
    — founder-curated training data. Same pattern as
    KasserapportExample.is_global in the kasserapport learning loop.

    Returns the number of NEW or UPDATED example rows.
    """
    if not final:
        return 0
    extracted = extracted or []

    # Build a quick name → extracted lookup for fallback matching.
    by_norm_name: dict[str, dict] = {}
    for ex in extracted:
        if isinstance(ex, dict):
            by_norm_name.setdefault(_norm_name(ex.get("name")), ex)

    promoted = 0
    for i, fin_item in enumerate(final):
        if not isinstance(fin_item, dict):
            continue
        # Try positional first.
        ex_item: dict | None = None
        if i < len(extracted) and isinstance(extracted[i], dict):
            ex_item = extracted[i]
        # Fallback: name-match (rare, but happens when user removes rows).
        if not ex_item:
            ex_item = by_norm_name.get(_norm_name(fin_item.get("name"))) or {}

        is_meaningful, kind = _is_meaningful_correction(ex_item, fin_item)
        if not is_meaningful:
            continue

        ext_name = (ex_item.get("name") or "").strip()[:200]
        fin_name = (fin_item.get("name") or "").strip()[:200]
        ext_cat = (ex_item.get("category") or "").strip()[:60] or None
        fin_cat = (fin_item.get("category") or "").strip()[:60] or None

        # Defense: skip if either side is empty after trimming.
        if not fin_name:
            continue

        # Look for an existing identical example — bump hit_count
        # rather than storing a duplicate row. Dedup is per-(user_id,
        # is_global) so a super_admin's global example doesn't collide
        # with their personal example for the same correction.
        if is_global:
            existing_q = db.query(InventoryImportExample).filter(
                InventoryImportExample.is_global == True,  # noqa: E712
                InventoryImportExample.kind == kind,
                InventoryImportExample.extracted_name == ext_name,
                InventoryImportExample.final_name == fin_name,
            )
        else:
            existing_q = db.query(InventoryImportExample).filter(
                InventoryImportExample.user_id == user_id,
                InventoryImportExample.is_global == False,  # noqa: E712
                InventoryImportExample.kind == kind,
                InventoryImportExample.extracted_name == ext_name,
                InventoryImportExample.final_name == fin_name,
            )
        existing = existing_q.first()
        if existing:
            existing.hit_count = (existing.hit_count or 1) + 1
            existing.updated_at = utc_now()
            promoted += 1
            continue

        ex = InventoryImportExample(
            # Global examples have user_id=NULL so they're not pinned to
            # one owner; per-user examples carry the original user_id.
            user_id=None if is_global else user_id,
            is_global=is_global,
            kind=kind,
            extracted_name=ext_name,
            extracted_category=ext_cat,
            final_name=fin_name,
            final_category=fin_cat,
            promoted_from_import_id=import_id,
        )
        db.add(ex)
        promoted += 1

    if promoted:
        db.commit()
    return promoted


# ─── Retrieval (for few-shot prompt construction) ─────────────────────

def get_examples_for_user(
    db: Session,
    user_id,
    *,
    kind: str | None = None,
    limit: int = 10,
    include_global: bool = True,
) -> list[InventoryImportExample]:
    """Top-N examples for a user, ordered by hit_count DESC, then
    most-recent. Caller renders these into a prompt block.

    Returns BOTH per-user examples AND founder-curated global ones
    (is_global=True), so a super_admin's training data benefits every
    owner. Global examples take precedence in tie-breaks because
    founder-curated patterns are higher-signal than a single owner's
    one-off correction.

    `include_global=False` opts out (used when an admin tool wants to
    isolate per-user corrections for a privacy review).

    `kind` filter lets the caller pick "just name corrections" or
    "just category corrections" depending on which surface they're
    enriching (extractor vs categorizer).
    """
    from sqlalchemy import or_
    if include_global:
        scope = or_(
            InventoryImportExample.user_id == user_id,
            InventoryImportExample.is_global == True,  # noqa: E712
        )
    else:
        scope = (InventoryImportExample.user_id == user_id)
    q = db.query(InventoryImportExample).filter(scope)
    if kind:
        q = q.filter(InventoryImportExample.kind == kind)
    return (
        # Global examples sort first (boolean True > False in DESC), then
        # by hit_count, then most-recent. Founder-curated patterns get
        # priority in the limited prompt budget.
        q.order_by(
            InventoryImportExample.is_global.desc(),
            InventoryImportExample.hit_count.desc(),
            InventoryImportExample.updated_at.desc(),
        )
        .limit(max(1, min(limit, 50)))  # hard-cap retrieval size
        .all()
    )


# ─── Pruning ───────────────────────────────────────────────────────────

def prune_stale_examples(db: Session, user_id) -> int:
    """Trim a user's example library to MAX_EXAMPLES_PER_USER and drop
    rows older than RETENTION_DAYS. Idempotent + safe to call often.

    Global (founder-curated) examples are NEVER pruned by this — they
    represent intentionally-curated training data that benefits all
    owners. Only per-user, non-global rows are subject to the cap +
    retention cutoff.

    Returns the number of rows deleted.
    """
    deleted = 0

    # Stale by age (per-user only — globals are intentional, not aged).
    cutoff = utc_now() - timedelta(days=RETENTION_DAYS)
    stale = (
        db.query(InventoryImportExample)
        .filter(
            InventoryImportExample.user_id == user_id,
            InventoryImportExample.is_global == False,  # noqa: E712
            InventoryImportExample.updated_at < cutoff,
        )
        .all()
    )
    for row in stale:
        db.delete(row)
        deleted += 1

    # Trim per-user examples to cap. Globals don't count toward the
    # per-user MAX so they never trigger eviction of someone's actual
    # corrections.
    total = (
        db.query(func.count(InventoryImportExample.id))
        .filter(
            InventoryImportExample.user_id == user_id,
            InventoryImportExample.is_global == False,  # noqa: E712
        )
        .scalar()
    ) or 0
    if total > MAX_EXAMPLES_PER_USER:
        # Keep the top-N by hit_count + recency; delete the rest.
        keep_ids = [
            r.id for r in
            db.query(InventoryImportExample.id)
            .filter(
                InventoryImportExample.user_id == user_id,
                InventoryImportExample.is_global == False,  # noqa: E712
            )
            .order_by(
                InventoryImportExample.hit_count.desc(),
                InventoryImportExample.updated_at.desc(),
            )
            .limit(MAX_EXAMPLES_PER_USER)
            .all()
        ]
        evicted = (
            db.query(InventoryImportExample)
            .filter(
                InventoryImportExample.user_id == user_id,
                InventoryImportExample.is_global == False,  # noqa: E712
                InventoryImportExample.id.notin_(keep_ids),
            )
            .all()
        )
        for row in evicted:
            db.delete(row)
            deleted += 1

    if deleted:
        db.commit()
    return deleted


# ─── Prompt-block builder (used by extractor) ─────────────────────────

def build_examples_prompt_block(
    examples: list[InventoryImportExample],
) -> str:
    """Render examples into a concise text block for the extractor's
    system prompt. Empty list → empty string (no header)."""
    if not examples:
        return ""
    lines = ["This owner has corrected past extractions as follows:"]
    for ex in examples:
        if ex.kind == "name_correction":
            line = f"- '{ex.extracted_name}' → prefers '{ex.final_name}'"
        elif ex.kind == "category_correction":
            line = (
                f"- '{ex.extracted_name}' belongs in category "
                f"'{ex.final_category or ''}' (not '{ex.extracted_category or ''}')"
            )
        else:
            line = f"- '{ex.extracted_name}' → '{ex.final_name}'"
        if ex.hit_count and ex.hit_count > 1:
            line += f" (seen {ex.hit_count}x)"
        lines.append(line)
    lines.append(
        "Apply these owner-specific patterns when extracting items "
        "with similar names."
    )
    return "\n".join(lines)
