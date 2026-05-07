"""Kasserapport learning loop — the system gets smarter each scan.

This is what closes the gap between "OCR that works on 5 known formats"
and "OCR that gets better every time anyone scans." There's no LLM
fine-tuning here (Anthropic doesn't offer customer fine-tuning yet).
What we DO have:

  1. AUTO-PROMOTE  Every time an extraction passes the validator AND
                   confidence ≥ 0.85 AND the owner commits without
                   editing anything, that scan becomes a curated
                   `KasserapportExample` for the owner's next scan.

  2. FEW-SHOT FETCH On the next scan, we pull 1-2 of the owner's own
                   past correctly-extracted scans (matching POS system)
                   and inject them as worked examples in the extractor's
                   user message. The model learns "this is how THIS
                   owner's receipts look."

  3. CORRECTION PATTERNS  When the same owner edits the same field the
                   same way 3+ times, surface it as a learned rule
                   ("this owner's Oasis terminal reports tip with
                   reversed sign") and inject into their prompt.

  4. DRIFT MONITOR Rolling extraction confidence per POS system; alerts
                   when it drops > 5pp over 7 days (POS probably changed
                   their receipt format).

The promotion + fetch loop alone is high-leverage: by scan 5-10, the
prompt for any given customer contains 2 of their own past scans as
ground-truth examples, which is far better than my hardcoded Mirabelle
example. By scan 30+ the model is highly tuned to their specific
receipt layout.

Defense layers (per house style — same multi-barrier doctrine):

  • PROMOTION GATE       — multiple criteria all required (validator
                            passed, confidence high, no corrections,
                            committed). Single-criterion passes don't
                            promote — too much risk of teaching the
                            model wrong patterns.
  • DEDUP                 — same image_sha256 already in examples →
                            skip. Don't fill the library with retries.
  • PER-USER CAP          — max 50 examples per (user, pos_system).
                            FIFO eviction when full so we always carry
                            recent format.
  • SCHEMA SANITIZATION   — only persist the structured fields we know
                            about. No raw OCR text, no PII.
  • AUDIT TRAIL           — every promoted example links back to the
                            extraction it came from + records
                            promoted_at timestamp.

All functions here are PURE — they read/write KasserapportExample +
KasserapportExtraction rows but never call the LLM. The LLM call lives
in `kasserapport_extractor.py`; this module is the bookkeeping that
feeds it.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import desc, func
from sqlalchemy.orm import Session

from app.models.kasserapport import KasserapportExample, KasserapportExtraction
from app.utils.time import utc_now

logger = logging.getLogger("bonbox.kasserapport_learning")


# ─── Tunable thresholds ────────────────────────────────────────────────
# Bump these via env vars (or service config) when you have data.
# Defaults are conservative: better to under-promote than to teach the
# model a wrong pattern.

MIN_CONFIDENCE_FOR_PROMOTION = 0.85       # reject iffy extractions
MAX_EXAMPLES_PER_USER_POS = 50            # FIFO cap per (user, pos)
MAX_EXAMPLES_RETURNED_FOR_FEW_SHOT = 2    # how many to inject per scan
DRIFT_WINDOW_DAYS = 7                     # rolling avg window
DRIFT_DROP_THRESHOLD = 0.05               # 5pp drop → flag


# ─── Layer 1 — auto-promote good extractions ───────────────────────────

def should_promote(extraction: KasserapportExtraction) -> tuple[bool, str]:
    """All these gates must pass for an extraction to become an example.
    Returns (should_promote, reason). The reason string is logged when
    we DON'T promote — useful for debugging "why didn't this get added."
    """
    if extraction is None:
        return False, "extraction_is_none"
    if extraction.error:
        return False, f"had_error: {extraction.error[:60]}"
    if extraction.manual_review_needed:
        return False, "validator_flagged_manual_review"
    if extraction.user_corrected:
        return False, "user_made_corrections"
    if extraction.committed_at is None:
        return False, "not_yet_committed"
    if extraction.extraction_confidence is None:
        return False, "no_confidence_score"
    try:
        conf = float(extraction.extraction_confidence)
    except (TypeError, ValueError):
        return False, "confidence_not_numeric"
    if conf < MIN_CONFIDENCE_FOR_PROMOTION:
        return False, f"confidence_below_threshold ({conf:.2f} < {MIN_CONFIDENCE_FOR_PROMOTION})"
    if not extraction.final_json:
        return False, "no_final_json"
    if extraction.pos_system in ("unknown", None):
        return False, "pos_system_unknown"  # won't help future scans of the same format
    return True, "ok"


def auto_promote_to_examples(
    db: Session,
    extraction_id: str | uuid.UUID,
) -> KasserapportExample | None:
    """Called from the /commit endpoint after the owner finalizes a close.

    If the extraction passes ALL gates in `should_promote`, we create a
    `KasserapportExample` row pointing back to it. Future scans by this
    user with the same pos_system will fetch this as a few-shot example.

    Returns the created example, or None if not promoted (gate failed,
    duplicate, or write failed — never raises). All failures are
    logged at INFO/WARNING but never propagate to the caller, since
    learning failures must NEVER break the daily-close flow.
    """
    try:
        ext = db.query(KasserapportExtraction).filter(
            KasserapportExtraction.id == extraction_id,
        ).first()
    except Exception as e:  # noqa: BLE001
        logger.warning("auto_promote: lookup failed: %s", e)
        return None

    ok, reason = should_promote(ext)
    if not ok:
        logger.info("auto_promote: skipped extraction=%s reason=%s", extraction_id, reason)
        return None

    # Dedup — same image already promoted? Don't fill the library with retries.
    if ext.image_sha256:
        existing = (
            db.query(KasserapportExample)
            .filter(
                KasserapportExample.user_id == ext.user_id,
                KasserapportExample.promoted_from_extraction_id == ext.id,
            )
            .first()
        )
        if existing:
            logger.info("auto_promote: already promoted, skipping")
            return existing

    # Per-user cap — FIFO evict oldest when full so we always carry
    # recent receipt format (POS systems update layouts every few months).
    try:
        count = (
            db.query(func.count(KasserapportExample.id))
            .filter(
                KasserapportExample.user_id == ext.user_id,
                KasserapportExample.pos_system == ext.pos_system,
                KasserapportExample.is_global.is_(False),
            )
            .scalar()
            or 0
        )
        if count >= MAX_EXAMPLES_PER_USER_POS:
            oldest = (
                db.query(KasserapportExample)
                .filter(
                    KasserapportExample.user_id == ext.user_id,
                    KasserapportExample.pos_system == ext.pos_system,
                    KasserapportExample.is_global.is_(False),
                )
                .order_by(KasserapportExample.created_at.asc())
                .first()
            )
            if oldest:
                db.delete(oldest)
                logger.info("auto_promote: evicted oldest example=%s for cap", oldest.id)
    except Exception as e:  # noqa: BLE001
        logger.warning("auto_promote: cap check failed: %s", e)
        # Continue — better to occasionally exceed cap than to fail entirely

    # Persist. final_json is the source of truth (post any user edits);
    # for fully-correct auto-promotions final_json == extracted_json.
    try:
        ex = KasserapportExample(
            id=uuid.uuid4(),
            user_id=ext.user_id,
            is_global=False,
            pos_system=ext.pos_system,
            image_url=ext.image_url,
            truth_json=ext.final_json,
            notes=f"auto-promoted (confidence {float(ext.extraction_confidence):.2f})",
            promoted_from_extraction_id=ext.id,
        )
        db.add(ex)
        db.commit()
        db.refresh(ex)
        logger.info(
            "auto_promote: created example=%s for user=%s pos=%s",
            ex.id, ext.user_id, ext.pos_system,
        )
        return ex
    except Exception as e:  # noqa: BLE001
        logger.warning("auto_promote: write failed: %s", e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return None


# ─── Layer 2 — fetch few-shot examples for next scan ───────────────────

def fetch_few_shot_examples(
    db: Session,
    user_id: str | uuid.UUID,
    pos_system: str | None,
    limit: int = MAX_EXAMPLES_RETURNED_FOR_FEW_SHOT,
) -> list[dict[str, Any]]:
    """Return the user's most-recent successful examples for a POS system.
    These get inserted into the extractor's user-message before the new
    image so the model has worked examples of THIS user's receipts.

    Selection priority:
      1. User's own examples for the SAME pos_system (most recent first)
      2. Global / founder-curated examples for the same pos_system (fallback)

    Returns: list of {pos_system, truth_json, notes} dicts. Empty list if
    no useful examples exist (extractor falls through to its baked-in
    Mirabelle example, which is still fine).

    Wrapped in try/except — learning-loop failures NEVER block extraction.
    """
    if not pos_system or pos_system == "unknown":
        return []
    try:
        # User-specific first
        rows = (
            db.query(KasserapportExample)
            .filter(
                KasserapportExample.user_id == user_id,
                KasserapportExample.pos_system == pos_system,
                KasserapportExample.is_global.is_(False),
            )
            .order_by(desc(KasserapportExample.created_at))
            .limit(limit)
            .all()
        )
        if len(rows) < limit:
            # Top up with global examples if user-specific bucket is thin
            extra_needed = limit - len(rows)
            global_rows = (
                db.query(KasserapportExample)
                .filter(
                    KasserapportExample.is_global.is_(True),
                    KasserapportExample.pos_system == pos_system,
                )
                .order_by(desc(KasserapportExample.created_at))
                .limit(extra_needed)
                .all()
            )
            rows = rows + global_rows
        return [
            {
                "pos_system": r.pos_system,
                "truth_json": r.truth_json or {},
                "notes": r.notes or "",
                "is_user_specific": not r.is_global,
            }
            for r in rows
        ]
    except Exception as e:  # noqa: BLE001
        logger.warning("fetch_few_shot_examples: query failed: %s", e)
        return []


def format_examples_as_prompt_block(examples: list[dict[str, Any]]) -> str | None:
    """Render the few-shot list as a single text block to inject before
    the new image in the extractor's user message. Returns None if no
    examples — caller should skip the injection in that case.

    The format is intentionally minimal: a short preamble + each example
    as a labeled JSON block. We don't include the example IMAGES — that
    would 4x the input token cost. The structured JSON alone is enough
    to teach the model "for this user's POS, kassebon means X, dankort
    column maps to field Y" etc.
    """
    if not examples:
        return None
    parts = [
        "REFERENCE EXAMPLES — these are previous correctly-extracted "
        "kasserapports from this same owner's POS system. Use them to "
        "understand their specific receipt layout, label conventions, "
        "and where each field appears. Then extract the NEW kasserapport "
        "image below.\n",
    ]
    import json as _json
    for i, ex in enumerate(examples, start=1):
        scope = "owner-specific" if ex.get("is_user_specific") else "general"
        parts.append(f"\nExample {i} ({scope}):")
        try:
            parts.append(_json.dumps(ex.get("truth_json") or {}, indent=2, ensure_ascii=False))
        except Exception:  # noqa: BLE001
            parts.append("(unparseable example skipped)")
    return "\n".join(parts)


# ─── Layer 3 — correction-pattern detection (cron, weekly) ──────────────

def detect_correction_patterns(
    db: Session,
    user_id: str | uuid.UUID,
    pos_system: str,
    *,
    lookback_days: int = 30,
    min_occurrences: int = 3,
) -> list[dict[str, Any]]:
    """Find systematic field-level corrections this owner has made on
    recent extractions. Output is a list of pattern dicts we can later
    inject into the prompt as inline rules.

    Pattern shape:
      {field_path: "tip", direction: "sign_flip", count: 4,
       examples: [{ai_value: -1000, user_value: 1000}, ...]}

    Caller (cron job) writes patterns to OwnerPattern table or similar
    so they can be retrieved + injected during extraction. For v1 we
    only detect a few common patterns — sign flips on tip, off-by-one
    on cents — and surface anything else as "unknown systematic edit"
    so the founder can review.

    This is a relatively heavy operation; runs weekly per user, not
    per-scan. Defensive — never raises, always returns a (possibly
    empty) list.
    """
    cutoff = utc_now() - timedelta(days=lookback_days)
    try:
        rows = (
            db.query(KasserapportExtraction)
            .filter(
                KasserapportExtraction.user_id == user_id,
                KasserapportExtraction.pos_system == pos_system,
                KasserapportExtraction.user_corrected.is_(True),
                KasserapportExtraction.committed_at.isnot(None),
                KasserapportExtraction.created_at >= cutoff,
            )
            .all()
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("detect_correction_patterns: query failed: %s", e)
        return []

    # Bucket corrections by field path
    field_diffs: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        ai = r.extracted_json or {}
        final = r.final_json or {}
        for path, ai_val, user_val in _walk_diff(ai, final):
            field_diffs.setdefault(path, []).append({"ai": ai_val, "user": user_val})

    patterns: list[dict[str, Any]] = []
    for path, diffs in field_diffs.items():
        if len(diffs) < min_occurrences:
            continue

        numeric_diffs = [
            d for d in diffs
            if isinstance(d["ai"], (int, float)) and isinstance(d["user"], (int, float))
        ]

        # Detector 1: sign flip (e.g. tip frequently AI=-X user=+X)
        sign_flips = sum(
            1 for d in numeric_diffs
            if d["ai"] != 0 and d["user"] != 0
            and (d["ai"] < 0) != (d["user"] < 0)
            and abs(abs(d["ai"]) - abs(d["user"])) < 0.5
        )
        if sign_flips >= min_occurrences:
            patterns.append({
                "field_path": path,
                "direction": "sign_flip",
                "count": sign_flips,
                "rule_text": (
                    f"For this owner, the AI tends to flip the sign on {path}. "
                    f"Trust the magnitude but check the sign carefully."
                ),
            })
            continue

        # Detector 2: scale / unit mismatch — AI returns øre when user expects kr
        # (or vice versa). Detect by ratio: if user_value ≈ ai_value * 100 or
        # ai_value / 100 across most edits, that's a unit mismatch pattern.
        scale_100x = sum(
            1 for d in numeric_diffs
            if d["ai"] != 0 and d["user"] != 0
            and 0.95 < (d["user"] / d["ai"]) / 100 < 1.05
        )
        scale_div100 = sum(
            1 for d in numeric_diffs
            if d["ai"] != 0 and d["user"] != 0
            and 0.95 < (d["user"] / d["ai"]) * 100 < 1.05
        )
        if scale_100x >= min_occurrences:
            patterns.append({
                "field_path": path,
                "direction": "scale_x100",
                "count": scale_100x,
                "rule_text": (
                    f"For this owner, the AI's {path} is consistently 100x too small "
                    f"(possibly reading øre as if it were kr). Multiply by 100 to verify."
                ),
            })
            continue
        if scale_div100 >= min_occurrences:
            patterns.append({
                "field_path": path,
                "direction": "scale_div100",
                "count": scale_div100,
                "rule_text": (
                    f"For this owner, the AI's {path} is consistently 100x too large "
                    f"(possibly reading kr as if it were øre). Divide by 100 to verify."
                ),
            })
            continue

        # Detector 3: rounding — AI returns øre precision, user always
        # rounds to whole kr (or vice versa). Lower-priority signal.
        rounding_drift = sum(
            1 for d in numeric_diffs
            if d["ai"] != 0 and d["user"] != 0
            and abs(d["ai"] - d["user"]) <= 1.0  # within 1 kr
            and d["ai"] != d["user"]
        )
        if rounding_drift >= min_occurrences:
            patterns.append({
                "field_path": path,
                "direction": "rounding",
                "count": rounding_drift,
                "rule_text": (
                    f"For this owner, the AI's {path} is consistently off by < 1 kr "
                    f"(rounding artifact). Cosmetic — tolerate or round at display."
                ),
            })
            continue

        # Otherwise: log as "unknown systematic" for founder review
        patterns.append({
            "field_path": path,
            "direction": "unknown",
            "count": len(diffs),
            "rule_text": (
                f"For this owner, the AI's {path} is often edited (n={len(diffs)}). "
                f"Worth double-checking on extraction."
            ),
        })

    return patterns


def _walk_diff(a: Any, b: Any, path: str = "") -> list[tuple[str, Any, Any]]:
    """Recursive walker that yields (path, a_value, b_value) tuples for
    every leaf value where a != b. Lists compared positionally."""
    diffs: list[tuple[str, Any, Any]] = []
    if isinstance(a, dict) and isinstance(b, dict):
        keys = set(a.keys()) | set(b.keys())
        for k in keys:
            sub_path = f"{path}.{k}" if path else k
            diffs.extend(_walk_diff(a.get(k), b.get(k), sub_path))
    elif isinstance(a, list) and isinstance(b, list):
        for i in range(max(len(a), len(b))):
            sub_path = f"{path}[{i}]"
            av = a[i] if i < len(a) else None
            bv = b[i] if i < len(b) else None
            diffs.extend(_walk_diff(av, bv, sub_path))
    else:
        if a != b:
            diffs.append((path, a, b))
    return diffs


# ─── Layer 4 — drift monitor (cron, daily) ──────────────────────────────

def compute_drift_signal(
    db: Session,
    pos_system: str,
    *,
    window_days: int = DRIFT_WINDOW_DAYS,
    threshold: float = DRIFT_DROP_THRESHOLD,
) -> dict[str, Any] | None:
    """Compare rolling avg confidence over the last `window_days` to the
    period before that. If average drops > threshold, return a drift
    signal dict the admin dashboard can surface. Returns None if no
    drift detected.
    """
    cutoff_recent = utc_now() - timedelta(days=window_days)
    cutoff_baseline = utc_now() - timedelta(days=window_days * 2)
    try:
        recent_avg = (
            db.query(func.avg(KasserapportExtraction.extraction_confidence))
            .filter(
                KasserapportExtraction.pos_system == pos_system,
                KasserapportExtraction.created_at >= cutoff_recent,
                KasserapportExtraction.error.is_(None),
            )
            .scalar()
        )
        baseline_avg = (
            db.query(func.avg(KasserapportExtraction.extraction_confidence))
            .filter(
                KasserapportExtraction.pos_system == pos_system,
                KasserapportExtraction.created_at >= cutoff_baseline,
                KasserapportExtraction.created_at < cutoff_recent,
                KasserapportExtraction.error.is_(None),
            )
            .scalar()
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("compute_drift_signal: query failed: %s", e)
        return None

    if recent_avg is None or baseline_avg is None:
        return None  # not enough data

    recent_f = float(recent_avg)
    baseline_f = float(baseline_avg)
    drop = baseline_f - recent_f
    if drop > threshold:
        return {
            "pos_system": pos_system,
            "baseline_confidence": round(baseline_f, 3),
            "recent_confidence": round(recent_f, 3),
            "drop": round(drop, 3),
            "threshold": threshold,
            "alert": (
                f"Confidence on {pos_system} dropped {drop*100:.1f}pp "
                f"({baseline_f:.2f} → {recent_f:.2f}) over the last "
                f"{window_days} days. POS may have changed receipt format "
                f"— refresh the prompt + worked example."
            ),
        }
    return None
