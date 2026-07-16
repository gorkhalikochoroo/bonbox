"""Statistical disclosure control for the thesis export.

The one job: given a categorical breakdown of BonBox accounts, emit a table
that CANNOT be used to re-identify any single account — even by an examiner
who knows the total, knows the population is ~71 Danish micro-SMBs, and
personally knows some of the owners (the researcher recruited them
door-to-door). Getting this wrong once, in a published PDF, is the only
irreversible failure in the whole thesis pipeline. So the module is pure,
small, and unit-tested to the boundary.

THE THRESHOLD is BonBox's own `MIN_COHORT_SIZE = 5` (smart_pricing.py) — the
platform already treats a cohort of <5 as too small to expose to an owner, and
holding the RESEARCH output to the PRODUCT's own privacy floor is a defensible
methods point, not an arbitrary pick.

WHY "COMPLEMENTARY", not just "hide small cells": primary suppression alone
leaks. If plan = {free: 69, pro: 2} and you publish "free 69, total 71", the
reader computes pro = 2 by subtraction. So this enforces the full rule:

  1. PRIMARY   — suppress any cell < k.
  2. RESIDUAL  — the suppressed cells collapse into ONE "combined" bucket.
  3. SECONDARY — if that bucket is itself < k, or aggregates < 2 original
                 cells (so it could be differenced back to a single account),
                 pull in the smallest SURVIVING cells until the bucket is
                 >= k AND covers >= 2 original cells.
  4. FAIL-CLOSED — if step 3 cannot produce a safe bucket without collapsing
                 everything (e.g. a binary split with a minority < k, like
                 the plan dimension), the WHOLE dimension is suppressed. A
                 useless-but-safe table beats a useful-but-identifying one.

The emitted total is always safe because a residual bucket that covers >= 2
cells and is >= k can never be differenced down to one account.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from app.services.smart_pricing import MIN_COHORT_SIZE

K = MIN_COHORT_SIZE  # 5 — reused, never redefined, so the two move together.


@dataclass
class SuppressedTable:
    """A disclosure-safe categorical table. Every field here is publishable."""

    dimension: str
    rows: list[tuple[str, int]]           # (bucket_label, count) — each count >= k
    combined_suppressed: int | None       # count in the "Other (combined)" bucket, or None
    combined_cell_count: int              # how many original cells collapsed into it
    total: int                            # safe to publish alongside the rows
    fully_suppressed: bool                # True => rows is empty, only `total` is safe
    # For a binary dimension suppressed because ONE side is < k: the safe upper
    # bound on that side (e.g. "< 5"). Publishing an upper bound is disclosure-
    # safe — it pins no account — and preserves the finding ("fewer than 5
    # accounts are active"). None unless exactly one below-k side exists and the
    # majority is NOT emitted (so the bound cannot be differenced to a point).
    minority_band: str | None = None
    notes: str = ""

    def publishable_statement(self) -> str:
        """The exact sentence that is safe to paste into the thesis."""
        if self.minority_band is not None:
            return (
                f"[{self.dimension}] fewer than {K} of {self.total} accounts fall "
                f"in the smallest category (exact count suppressed for privacy)."
            )
        if self.fully_suppressed:
            return f"[{self.dimension}] suppressed for privacy (n={self.total})."
        parts = [f"{b}: {n}" for b, n in self.rows]
        if self.combined_suppressed is not None:
            # Deliberately does NOT print how many categories collapsed — that
            # number would disclose category-diversity for zero analytic gain
            # (red-team hardening, 2026-07-16). The count lives in the provenance
            # JSON for the audit trail, not in the published sentence.
            parts.append(f"other smaller categories combined: {self.combined_suppressed}")
        return f"[{self.dimension}] " + "; ".join(parts) + f" (n={self.total})."

    def as_dict(self) -> dict:
        return {
            "dimension": self.dimension,
            "rows": [{"bucket": b, "n": n} for b, n in self.rows],
            "combined_suppressed_n": self.combined_suppressed,
            "combined_cell_count": self.combined_cell_count,
            "total": self.total,
            "fully_suppressed": self.fully_suppressed,
            "minority_band": self.minority_band,
            "publishable_statement": self.publishable_statement(),
            "k": K,
            "notes": self.notes,
        }


def suppress(dimension: str, counts: dict[str, int], *, k: int = K) -> SuppressedTable:
    """Apply complementary k-suppression to one categorical breakdown.

    `counts` maps bucket -> number of accounts. Returns a SuppressedTable whose
    every emitted number is safe to print in the thesis.
    """
    total = sum(counts.values())
    # Deterministic order: biggest first, ties broken by label, so the same
    # input always yields the same table (an audit trail must be reproducible).
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))

    survivors = [(b, n) for b, n in ordered if n >= k]
    suppressed = [(b, n) for b, n in ordered if n < k]

    if not suppressed:
        return SuppressedTable(
            dimension=dimension, rows=survivors, combined_suppressed=None,
            combined_cell_count=0, total=total, fully_suppressed=False,
            notes="No suppression needed — every cell >= k.",
        )

    # Build the residual bucket from the below-k cells, then borrow the
    # smallest survivors until it is BOTH >= k AND covers >= 2 original cells.
    # Borrowing smallest-first keeps the maximum information in the survivors.
    residual_cells = list(suppressed)
    survivors_asc = sorted(survivors, key=lambda kv: (kv[1], kv[0]))  # smallest first
    while survivors_asc and (
        sum(n for _, n in residual_cells) < k or len(residual_cells) < 2
    ):
        residual_cells.append(survivors_asc.pop(0))

    residual_n = sum(n for _, n in residual_cells)
    residual_count = len(residual_cells)

    # Could we not build a safe bucket? (Everything got pulled in, or the
    # bucket is still < k / < 2 cells.) Then the dimension is unpublishable.
    safe = residual_n >= k and residual_count >= 2 and len(survivors_asc) >= 1
    if not safe:
        # If exactly ONE original cell was below k, its size is a safe upper
        # bound ("< k") — an aggregate that pins no account. We expose the bound
        # but NOT the majority cell, so it cannot be differenced to a point.
        band = f"< {k}" if len(suppressed) == 1 else None
        return SuppressedTable(
            dimension=dimension, rows=[], combined_suppressed=None,
            combined_cell_count=0, total=total, fully_suppressed=True,
            minority_band=band,
            notes=(
                f"Whole dimension suppressed: a safe residual bucket (>= {k}, "
                f">= 2 cells, leaving >= 1 survivor) could not be formed. This "
                f"is the correct outcome for a binary split whose minority is "
                f"< {k} (e.g. plan = free-heavy with a tiny paid minority) — "
                f"publishing the majority would disclose the minority by "
                f"subtraction."
            ),
        )

    kept = sorted(survivors_asc, key=lambda kv: (-kv[1], kv[0]))
    return SuppressedTable(
        dimension=dimension, rows=kept, combined_suppressed=residual_n,
        combined_cell_count=residual_count, total=total, fully_suppressed=False,
        notes=(
            f"{residual_count} cells (< {k}, plus any borrowed survivors) "
            f"combined into one residual bucket of {residual_n}; no single "
            f"cell is recoverable by differencing."
        ),
    )
