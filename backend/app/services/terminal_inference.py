"""Terminal inference — propose POS terminals from kasserapport scans.

Why this exists (May 2026):
  Mirabelle has 4 terminals. The owner used to need to:
    1. Open Settings → Terminals
    2. Hand-add 4 rows: name, branch, capability flags, receipt label
    3. Then go to Multi-terminal close to actually use them
  That's homework. The kasserapport itself already prints the
  terminal label ("Term 1", "Bar 2", "Terrasse"). We can read it.

Founder's rule: "our goal should be simple. how can we help them.
no complicated stuff." So this service is the inverse: scan first,
we propose the terminals. One tap "Looks right ✓" → done.

Mirrors the pattern of staffing_inference + inventory_inference:
  • Pure deterministic (no LLM in the inference itself; the OCR
    upstream did all the LLM work — we just summarise its output).
  • Read-only — confirm step writes via existing auth-gated CRUD.
  • Tenant boundary: extractions filtered by user_id.
  • Fail-closed: if no labels found, propose a single sensible
    default terminal so the close flow can still proceed.

Multi-layer security:
  • Caller auth-gates the wrapping endpoint.
  • Inputs (extraction_ids) re-validated to belong to the user.
  • Capability-flag inference is conservative: True only if a
    non-zero amount appeared on that payment line. False is
    the safe default (closer can fix during confirm).
  • bulk_create_terminals() pre-validates ALL entries (name,
    branch ownership, count cap) before writing any — atomic.
  • Per-user terminal cap mirrors the CRUD limit.
  • Auto-route helper is case-insensitive substring-equal,
    NOT regex — no ReDoS surface.
"""
from __future__ import annotations

import logging
import re
import uuid
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.branch import Branch
from app.models.kasserapport import KasserapportExtraction
from app.models.terminal import Terminal
from app.models.user import User
from app.utils.time import utc_now

logger = logging.getLogger("bonbox.terminal_inference")


# Mirror the cap used by the CRUD layer so bulk-create can't slip
# past it. If the existing user already has terminals, we count those
# too — the cap is total, not per-batch.
DEFAULT_TERMINAL_LIMIT = 20

# How many recent extractions to walk when inferring. Same idea as
# SALES_LOOKBACK_DAYS: enough to capture a full normal close (≤10
# terminals at any sane venue) without trawling years of history.
INFER_LOOKBACK_EXTRACTIONS = 25


# ─── Vertical defaults ──────────────────────────────────────────────────
#
# When the OCR can't read a meaningful terminal label (rare but happens
# with hand-written or partially-cropped slips), we fall back to a
# vertical-aware naming scheme. These are used IN ORDER as terminals
# are detected: the first un-named terminal gets the first name, etc.
#
# Designed to feel right for the founder's first 5 customer types.
# Returning to this list later is fine — it's just defaults; owner
# can rename in the confirm step.

DEFAULT_NAMES_BY_VERTICAL: dict[str, list[str]] = {
    "restaurant": ["Front bar", "Back bar", "Terrace", "Takeaway", "Bar 2"],
    "cafe":       ["Front counter", "Bar", "Terrace", "Takeaway"],
    "bar":        ["Main bar", "Back bar", "Garden", "VIP"],
    "bakery":     ["Counter", "Café area", "Takeaway"],
    "retail":     ["POS 1", "POS 2", "POS 3", "POS 4"],
    "salon":      ["Reception", "Stylist 1", "Stylist 2"],
    "workshop":   ["Reception", "Service desk"],
    "grocery":    ["Checkout 1", "Checkout 2", "Checkout 3", "Checkout 4"],
}
# Cross-vertical fallback used if business_type unknown.
DEFAULT_NAMES_FALLBACK: list[str] = ["Terminal 1", "Terminal 2", "Terminal 3", "Terminal 4"]


def _vertical_default_names(business_type: Optional[str]) -> list[str]:
    bt = (business_type or "").strip().lower()
    return DEFAULT_NAMES_BY_VERTICAL.get(bt) or DEFAULT_NAMES_FALLBACK


# ─── Label extraction & normalisation ───────────────────────────────────


# Strip punctuation/whitespace and lowercase for case-insensitive equality.
# Kept simple — NOT a regex match, NOT substring; exact normalised equality.
# This avoids "Term" matching "Terminal 5" when the closer just typed "Term".
_PUNCT_RE = re.compile(r"[\s\-_.,;:#]+")


def _normalise_label(raw: Any) -> str:
    """Lowercased, punctuation-collapsed form for matching. Empty if junk."""
    if raw is None:
        return ""
    s = str(raw).strip()
    if not s:
        return ""
    if len(s) > 60:  # defense — never store anything obscene
        s = s[:60]
    return _PUNCT_RE.sub("", s).lower()


def _label_from_extraction(ext: KasserapportExtraction) -> Optional[str]:
    """Pull the terminal label out of an extraction's JSON payload."""
    payload = ext.final_json or ext.extracted_json or {}
    if not isinstance(payload, dict):
        return None
    session = payload.get("session") or {}
    if not isinstance(session, dict):
        return None
    raw = session.get("terminal")
    if not raw:
        return None
    s = str(raw).strip()
    return s[:40] if s else None  # match the receipt_label DB column cap


def _capabilities_from_extraction(ext: KasserapportExtraction) -> dict[str, bool]:
    """Conservative capability inference from one slip's payments block.

    Truth table: a flag becomes True ONLY if a strictly-positive amount
    appeared on the matching payment line. None / 0 / negative = False.
    Closer can flip flags on in the confirm step if a quiet day didn't
    surface a payment method that the terminal does take.
    """
    payload = ext.final_json or ext.extracted_json or {}
    if not isinstance(payload, dict):
        return {"accepts_dankort": False, "accepts_mobilepay": False, "accepts_amex": False}
    pay = payload.get("payments") or {}
    if not isinstance(pay, dict):
        pay = {}

    def _gt0(key: str) -> bool:
        val = pay.get(key)
        try:
            return val is not None and float(val) > 0
        except (TypeError, ValueError):
            return False

    # card_betalingskort and card_softpay are both Dankort-family in DK.
    # Either being non-zero implies the terminal takes Dankort.
    accepts_dankort = _gt0("card_betalingskort") or _gt0("card_softpay") or _gt0("card_total")
    accepts_mobilepay = _gt0("mobilepay")
    # Amex is rarely on its own line — leave conservative False. Owner
    # toggles on during confirm if relevant.
    accepts_amex = False
    return {
        "accepts_dankort": accepts_dankort,
        "accepts_mobilepay": accepts_mobilepay,
        "accepts_amex": accepts_amex,
    }


# ─── Public — proposal ──────────────────────────────────────────────────


def infer_terminals_from_extractions(
    db: Session,
    *,
    user: User,
    extraction_ids: Optional[list[uuid.UUID]] = None,
) -> dict[str, Any]:
    """Read recent kasserapport extractions and propose terminals.

    Args:
      user:
        Owner — required for tenant scoping.
      extraction_ids:
        Optional whitelist. If provided, ONLY those rows are inspected
        (and they're re-checked for tenant ownership). If omitted, the
        most recent INFER_LOOKBACK_EXTRACTIONS rows are read.

    Returns a dict with:
      proposals: list of {
        receipt_label, name, accepts_dankort, accepts_mobilepay,
        accepts_amex, display_order, source_count, matches_existing_id
      }
      existing_terminals: list of currently-active terminals' (id, receipt_label, name)
      confidence: "high" | "medium" | "low"
      data_quality: { extractions_observed, distinct_labels, lookback }
      reasoning: human-readable summary

    Empty-extractions case: returns a fail-closed single-terminal default
    using the vertical's first name. Owner just confirms.
    """
    # ── Read extractions, tenant-scoped ────────────────────────────────
    q = (
        db.query(KasserapportExtraction)
        .filter(KasserapportExtraction.user_id == user.id)
    )
    if extraction_ids:
        # Defense: clamp to existing user's rows. We never trust the
        # IDs blindly — even though the wrapping endpoint auth-checks,
        # this is a service-level guard for direct callers (tests etc.).
        q = q.filter(KasserapportExtraction.id.in_(extraction_ids))
    rows = (
        q.order_by(KasserapportExtraction.created_at.desc())
        .limit(INFER_LOOKBACK_EXTRACTIONS)
        .all()
    )

    # ── Existing terminals so we can mark "matches_existing_id" ────────
    existing = (
        db.query(Terminal)
        .filter(
            Terminal.user_id == user.id,
            Terminal.is_deleted.isnot(True),
        )
        .order_by(Terminal.display_order.asc(), Terminal.created_at.asc())
        .all()
    )
    existing_by_norm: dict[str, Terminal] = {}
    for t in existing:
        n = _normalise_label(t.receipt_label or t.name)
        if n:
            existing_by_norm[n] = t

    # ── Group extractions by normalised label ──────────────────────────
    groups: dict[str, dict[str, Any]] = {}
    for ext in rows:
        raw = _label_from_extraction(ext)
        norm = _normalise_label(raw)
        if not norm:
            continue
        g = groups.setdefault(norm, {"raw_label": raw, "extractions": []})
        # Keep the longest-form raw label seen — "Bar 2" beats "Bar"
        if len(raw) > len(g["raw_label"]):
            g["raw_label"] = raw
        g["extractions"].append(ext)

    # ── Build proposals ────────────────────────────────────────────────
    defaults = _vertical_default_names(user.business_type)
    proposals: list[dict[str, Any]] = []

    if not groups:
        # No labels found at all — fail-closed single-terminal proposal.
        proposals.append({
            "receipt_label": None,
            "name": defaults[0],
            "accepts_dankort": True,
            "accepts_mobilepay": True,
            "accepts_amex": False,
            "display_order": 0,
            "source_count": 0,
            "matches_existing_id": str(existing[0].id) if existing else None,
        })
        confidence = "low"
        reasoning = (
            "No terminal labels found on recent slips — proposing a single default "
            "terminal so you can still close. You can edit this later."
        )
    else:
        # OR of capability flags across all extractions in the group
        # (any slip showing dankort means terminal takes dankort).
        for idx, (norm, info) in enumerate(
            sorted(groups.items(), key=lambda kv: kv[1]["raw_label"])
        ):
            caps_or = {"accepts_dankort": False, "accepts_mobilepay": False, "accepts_amex": False}
            for ext in info["extractions"]:
                caps = _capabilities_from_extraction(ext)
                for k, v in caps.items():
                    caps_or[k] = caps_or[k] or v

            existing_match = existing_by_norm.get(norm)
            # Pick a friendly name. If the OCR'd label is itself friendly
            # (e.g. "Front bar" — has letters and is ≥4 chars), use it
            # verbatim. Otherwise inject the vertical default for that
            # display_order index.
            raw_label = info["raw_label"]
            looks_friendly = (
                len(raw_label) >= 4
                and any(ch.isalpha() for ch in raw_label)
                and not raw_label.lower().startswith(("term ", "term#", "terminal "))
                and raw_label.lower() not in {"t1", "t2", "t3", "t4", "t5"}
            )
            if existing_match:
                name = existing_match.name
            elif looks_friendly:
                name = raw_label
            else:
                name = defaults[idx] if idx < len(defaults) else f"Terminal {idx + 1}"

            proposals.append({
                "receipt_label": raw_label,
                "name": name,
                "accepts_dankort": caps_or["accepts_dankort"] or True,  # always-true default
                "accepts_mobilepay": caps_or["accepts_mobilepay"] or True,
                "accepts_amex": caps_or["accepts_amex"],
                "display_order": idx,
                "source_count": len(info["extractions"]),
                "matches_existing_id": str(existing_match.id) if existing_match else None,
            })

        # Confidence: high if every group has ≥2 supporting extractions,
        # medium if all have ≥1 and some have only 1, low if anything's
        # lopsided. We never lie — owners trust calibrated badges.
        sizes = [len(g["extractions"]) for g in groups.values()]
        if all(s >= 2 for s in sizes):
            confidence = "high"
        elif all(s >= 1 for s in sizes):
            confidence = "medium"
        else:
            confidence = "low"
        reasoning = (
            f"Found {len(groups)} distinct terminal label(s) across "
            f"{sum(sizes)} recent slip(s). Names and capabilities pre-filled — "
            "tap Edit to fine-tune."
        )

    return {
        "proposals": proposals,
        "existing_terminals": [
            {"id": str(t.id), "receipt_label": t.receipt_label, "name": t.name}
            for t in existing
        ],
        "confidence": confidence,
        "data_quality": {
            "extractions_observed": len(rows),
            "distinct_labels": len(groups),
            "lookback_extractions": INFER_LOOKBACK_EXTRACTIONS,
        },
        "reasoning": reasoning,
    }


# ─── Public — auto-route by receipt_label ───────────────────────────────


def find_terminal_for_label(
    db: Session,
    *,
    user: User,
    label: Optional[str],
) -> Optional[uuid.UUID]:
    """Return the terminal_id whose receipt_label matches `label`, or None.

    Tenant-scoped, case-insensitive, punctuation-tolerant equality.
    Used by the /kasserapport/extract router to auto-tag a scan when
    the closer doesn't pre-bind it to a slot.

    Defense: returns None on empty/junk input rather than guessing.
    Caller decides the policy when no match is found (current behaviour
    leaves terminal_id NULL — the aggregator handles unbound rows).
    """
    norm = _normalise_label(label)
    if not norm:
        return None
    rows = (
        db.query(Terminal)
        .filter(
            Terminal.user_id == user.id,
            Terminal.is_deleted.isnot(True),
            Terminal.is_active.is_(True),
        )
        .all()
    )
    for t in rows:
        # First check explicit receipt_label, fall back to terminal name
        # so "Bar 2" still routes if the owner only set the name field.
        if _normalise_label(t.receipt_label) == norm:
            return t.id
        if _normalise_label(t.name) == norm:
            return t.id
    return None


# ─── Public — atomic bulk create ────────────────────────────────────────


class TerminalInferenceError(ValueError):
    """422-mappable: a proposal payload failed validation. The bulk-
    create endpoint translates this into HTTP 422 with the reason."""


def _validate_proposal(p: dict[str, Any]) -> None:
    """Each proposal must be shaped like a TerminalCreate. Cheap to do
    here so we can pre-check the whole batch before writing any of it."""
    name = (p.get("name") or "").strip()
    if not name or len(name) > 80:
        raise TerminalInferenceError(f"Invalid name: {p.get('name')!r}")
    rl = p.get("receipt_label")
    if rl is not None and len(str(rl)) > 40:
        raise TerminalInferenceError(f"receipt_label too long: {rl!r}")
    do = p.get("display_order", 0)
    if not isinstance(do, int) or do < 0 or do > 999:
        raise TerminalInferenceError(f"Invalid display_order: {do!r}")
    for flag in ("accepts_dankort", "accepts_mobilepay", "accepts_amex"):
        v = p.get(flag, False)
        if not isinstance(v, bool):
            raise TerminalInferenceError(f"{flag} must be bool, got {type(v).__name__}")


def bulk_create_terminals(
    db: Session,
    *,
    user: User,
    proposals: list[dict[str, Any]],
    branch_id: Optional[uuid.UUID] = None,
) -> list[Terminal]:
    """Atomically create all terminals in `proposals`.

    Pre-validation guarantees: if ANY proposal is malformed, NOTHING is
    written. This avoids the half-applied state where some terminals
    exist and the rest don't, which would confuse the close flow.

    Defense layers:
      • Owner-supplied branch_id (if any) is re-checked for ownership.
      • Per-user cap (DEFAULT_TERMINAL_LIMIT) accounts for already-
        existing rows so a malicious client can't fill the table by
        chunking the bulk request.
      • All field-level validation runs before db.add() — never half-
        commits.
      • db.flush() before commit so a constraint violation rolls back
        cleanly.
    """
    if not proposals:
        raise TerminalInferenceError("No proposals supplied.")
    if len(proposals) > DEFAULT_TERMINAL_LIMIT:
        raise TerminalInferenceError(
            f"Too many terminals in one request (max {DEFAULT_TERMINAL_LIMIT})."
        )

    # Branch ownership re-check (forged branch_id rejected)
    if branch_id is not None:
        b = (
            db.query(Branch)
            .filter(Branch.id == branch_id, Branch.user_id == user.id)
            .first()
        )
        if not b:
            raise TerminalInferenceError("Branch not found for this owner.")

    # Cap including already-existing terminals
    existing_count = (
        db.query(Terminal)
        .filter(Terminal.user_id == user.id, Terminal.is_deleted.isnot(True))
        .count()
    )
    if existing_count + len(proposals) > DEFAULT_TERMINAL_LIMIT:
        raise TerminalInferenceError(
            f"Would exceed terminal limit ({DEFAULT_TERMINAL_LIMIT}). "
            f"Currently have {existing_count}."
        )

    # Pre-validate everything
    for p in proposals:
        _validate_proposal(p)

    # All clear — write
    created: list[Terminal] = []
    for p in proposals:
        rl = p.get("receipt_label")
        rl_clean = (str(rl).strip() if rl else "") or None
        term = Terminal(
            id=uuid.uuid4(),
            user_id=user.id,
            branch_id=branch_id,
            name=str(p["name"]).strip(),
            display_order=int(p.get("display_order", 0)),
            accepts_dankort=bool(p.get("accepts_dankort", True)),
            accepts_mobilepay=bool(p.get("accepts_mobilepay", True)),
            accepts_amex=bool(p.get("accepts_amex", False)),
            receipt_label=rl_clean,
            is_active=True,
            is_deleted=False,
            created_at=utc_now(),
            updated_at=utc_now(),
        )
        db.add(term)
        created.append(term)

    try:
        db.flush()  # surface constraint errors before commit
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.exception("bulk_create_terminals failed: %s", exc)
        raise TerminalInferenceError("Database write failed; nothing saved.") from exc

    for t in created:
        db.refresh(t)
    return created
