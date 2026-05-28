"""POS terminal provider detector — deterministic keyword matcher.

Commit 2 of the POS terminal auto-detect feature. The OCR pipeline
(claude_vision_ocr.extract_z_report_data) already reads the entire
Z-report image and emits payment_terminal_header + payment_terminal_footer
fields as part of its normal extraction. This module takes those two
strings and matches them against the terminal_providers catalog (18 rows
seeded from backend/app/data/terminal_providers.json) to identify which
acquirer (Nets, Worldline, BS PAYCO, MobilePay, SumUp, ...) printed the
receipt.

Why deterministic, not LLM:
  Manoj's cost discipline rule — every LLM call must be justified. Opus
  already read the image once for the kasserapport extraction; making a
  SECOND call just to identify the brand on a receipt the model already
  saw would burn money for zero accuracy gain. Pure-Python substring
  matching against the curated catalog is faster, cheaper, auditable,
  and Manoj can adjust the keywords by editing JSON.

Scoring contract:
  • Lowercase both sides.
  • For each catalog row, count how many `signature_keywords` (newline-
    separated tokens) appear as case-insensitive substrings in the
    combined header + footer haystack.
  • Raw score = number of keywords matched (0..N).
  • Confidence = clamp(raw_score / max(1, len(provider.signature_keywords)),
                       0.0, 1.0)
  • Tie-break order: dk_market_tier (dominant > common > niche > fallback),
    then raw match count (more matches wins inside the same tier).

Returns:
  {provider_id (UUID), slug (str), display_name (str), confidence (float)}
  or None when no provider scored above zero (or when both texts are empty
  / catalog is empty).

The "unknown" fallback row in the catalog has zero signature_keywords by
design — its score is always 0, so it cannot win. No special-casing.

L8 graceful degradation: if the catalog table is empty (seeder hasn't run
yet, or DB has hiccupped) we return None — never raise. The caller (the
/scan-report endpoint) further wraps us in try/except for an extra belt-
and-braces layer so detection failure cannot block the close ritual.
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from app.models.terminal_provider import TerminalProvider

logger = logging.getLogger("bonbox.terminal_provider_detector")


# Tier-rank lookup for tie-breaking. Higher = stronger. Anything not in
# this map (typo in seed JSON, future tier we haven't seen) defaults to 0
# so unknown tiers lose ties — fail-safe rather than promote-the-typo.
_TIER_RANK: dict[str, int] = {
    "dominant": 4,
    "common": 3,
    "niche": 2,
    "fallback": 1,
}


def _tokens_from_keywords(raw: str | None) -> list[str]:
    """Parse the catalog's `signature_keywords` TEXT column into the list
    of individual tokens. Storage is newline-separated lowercase per the
    seeder (services/terminal_providers_seeder._normalize_keywords). We
    re-lowercase + strip defensively in case a row was hand-edited."""
    if not raw or not isinstance(raw, str):
        return []
    return [tok.strip().lower() for tok in raw.split("\n") if tok.strip()]


def detect_provider(
    db: Session,
    header_text: str,
    footer_text: str,
) -> dict[str, Any] | None:
    """Match OCR-extracted header/footer text against the terminal_providers
    catalog and return the best match (or None if no signal).

    Args:
      db: active SQLAlchemy session. Caller owns the lifecycle.
      header_text: top-of-receipt text from the OCR (may be empty / None
                   per caller; we coerce defensively).
      footer_text: bottom-of-receipt text from the OCR.

    Returns:
      Dict with keys:
        provider_id (UUID), slug (str), display_name (str), confidence
        (float in [0.0, 1.0])
      OR None when:
        • both inputs are empty / whitespace-only
        • the catalog has zero rows (seeder hasn't run)
        • no provider scored above zero

    Never raises — L8 graceful degradation. Catalog read failures are
    logged at WARNING and we return None.
    """
    # Defensive coercion — caller may pass None when the OCR didn't emit
    # the field. .get("...", "") in the router already does this, but
    # double-guard for direct unit-test callers.
    haystack = (
        f"{header_text or ''}\n{footer_text or ''}"
    ).strip().lower()
    if not haystack:
        return None

    # Single query — 18 rows today, max ~50 in a year. Filter to active
    # so deactivated providers (a vendor that exited the DK market) can't
    # win even if their keywords are still in the row.
    try:
        providers = (
            db.query(TerminalProvider)
            .filter(TerminalProvider.is_active.is_(True))
            .all()
        )
    except Exception as e:  # noqa: BLE001
        # L8 graceful — never block the close on a catalog read hiccup.
        logger.warning(
            "detect_provider: catalog read failed (%s); returning None", e,
        )
        return None

    if not providers:
        return None

    # Score every provider. Empty-keywords rows (the "unknown" fallback)
    # naturally score 0 and lose by construction — no special-casing.
    candidates: list[tuple[float, int, int, TerminalProvider]] = []
    for prov in providers:
        keywords = _tokens_from_keywords(prov.signature_keywords)
        if not keywords:
            continue
        matches = sum(1 for kw in keywords if kw in haystack)
        if matches <= 0:
            continue
        confidence = max(0.0, min(1.0, matches / max(1, len(keywords))))
        tier_rank = _TIER_RANK.get(prov.dk_market_tier or "", 0)
        # Sort key: higher tier rank first, then higher confidence, then
        # higher raw match count. Python sorts ascending so we'll reverse
        # by negating all three keys.
        candidates.append((tier_rank, confidence, matches, prov))

    if not candidates:
        return None

    # Pick the winner — sort by (tier_rank desc, confidence desc,
    # matches desc) and take the head. This is the documented tie-break
    # contract from the spec.
    candidates.sort(
        key=lambda row: (-row[0], -row[1], -row[2]),
    )
    _tier, best_conf, _matches, winner = candidates[0]

    return {
        "provider_id": winner.id,
        "slug": winner.slug,
        "display_name": winner.display_name,
        "confidence": float(best_conf),
    }
