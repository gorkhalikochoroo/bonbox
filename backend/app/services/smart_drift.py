"""Smart Drift — weekly re-inference + diff detection.

Once a week the daily cron (jobs/retention_and_patterns.py) calls
`run_drift_scan_for_user(db, user)` for each user. We re-run the
relevant Smart inference services against fresh data and compare the
new proposal to what's currently saved on the owner's profile. If
something materially differs, we insert a SmartDriftFinding so the
dashboard can show a calm, dismissable banner:

   "Your Friday hours look different lately — open until 23:00 now.
    Update?"

Why bother:
   The very point of the Smart cards was "we watch your data" — but
   the cards only run when the owner navigates to them. Without drift
   scanning the inferences go stale silently. The drift scan turns
   "smart" into "alive."

V1 scope (May 2026):
   • staffing only — most actionable; biggest impact on staffing cost.
   • inventory + terminals: deferred to v2. Same primitive (re-infer,
     diff, persist finding) — easy to add later.

Idempotency:
   • If an OPEN (non-dismissed, non-applied) finding of the same kind
     already exists, we update its payload rather than insert a new
     one. So running the scan 7 times in a week never spams 7 banners.
   • If the owner DISMISSED last week's finding, we don't re-insert a
     new one for the same drift in the same week — there's a cooldown
     (DRIFT_COOLDOWN_DAYS).

Multi-layer security:
   • Service is tenant-scoped: every call takes a User and only reads
     that user's data.
   • Detection logic is pure deterministic — no LLM. The diff rules
     are explicit: open-day flip, open-hour shift > 1h, peak window
     appearance/disappearance, role count change > 0.5.
   • Findings carry only summary text and structured diffs — no raw
     sales rows, no PII.
"""
from __future__ import annotations

import logging
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy.orm import Session

from app.models.business_profile import BusinessProfile
from app.models.smart_drift_finding import SmartDriftFinding
from app.models.staff_role_target import StaffRoleTarget
from app.models.user import User
from app.services.business_operating_service import (
    parse_operating_hours,
    parse_peak_windows,
)
from app.services.staffing_inference import infer_staffing_profile
from app.utils.time import utc_now

logger = logging.getLogger("bonbox.smart_drift")


# How many days to wait before re-surfacing a dismissed finding of the
# same kind. 14d is long enough that a typical seasonal blip resolves
# on its own; short enough that real ongoing drift gets re-surfaced.
DRIFT_COOLDOWN_DAYS = 14

# How many minutes / count for the "material" thresholds. Tuned conservatively
# so a 5-minute median jitter doesn't fire a banner.
HOUR_DRIFT_MIN_MINUTES = 60        # at least 1 full hour shift on any day
ROLE_COUNT_DRIFT_MIN = 0.5         # ≥0.5 person


# ─── Diff helpers ──────────────────────────────────────────────────────


def _hours_string_to_minutes(spec: str | None) -> tuple[int, int] | None:
    """Parse "08:00-17:00" → (480, 1020). Returns None on closed/invalid."""
    if not spec or spec == "closed":
        return None
    try:
        a, b = spec.split("-")
        ah, am = a.split(":"); bh, bm = b.split(":")
        return (int(ah) * 60 + int(am), int(bh) * 60 + int(bm))
    except Exception:  # noqa: BLE001
        return None


def _hours_drifted(old_spec: str | None, new_spec: str | None) -> bool:
    """True iff the open OR close time shifted ≥ HOUR_DRIFT_MIN_MINUTES."""
    a = _hours_string_to_minutes(old_spec)
    b = _hours_string_to_minutes(new_spec)
    if a is None and b is None:
        return False
    if a is None or b is None:
        return True  # closed→open or open→closed: definitely drifted
    return abs(a[0] - b[0]) >= HOUR_DRIFT_MIN_MINUTES or abs(a[1] - b[1]) >= HOUR_DRIFT_MIN_MINUTES


def _diff_staffing_proposal(saved: dict, proposal: dict) -> dict | None:
    """Return the diff payload if anything materially changed, else None.

    Material rules:
      • open_days_mask differs at all (one day flipped open/closed)
      • Any per-day open/close time shifted ≥ 1 hour
      • Any peak window appeared or disappeared
      • Any role's default_count changed by ≥ 0.5
    """
    changed: list[str] = []
    summary_lines: list[str] = []

    # Open days
    old_mask = saved.get("open_days_mask") or ""
    new_mask = proposal.get("open_days_mask") or ""
    if set(old_mask) != set(new_mask):
        changed.append("open_days_mask")
        added = sorted(set(new_mask) - set(old_mask))
        removed = sorted(set(old_mask) - set(new_mask))
        if added:
            summary_lines.append(f"Open days added: {', '.join(added)}")
        if removed:
            summary_lines.append(f"Open days removed: {', '.join(removed)}")

    # Hours per day
    old_hours = saved.get("operating_hours") or {}
    new_hours = proposal.get("operating_hours") or {}
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        if _hours_drifted(old_hours.get(day), new_hours.get(day)):
            changed.append(f"hours_{day}")
            o = old_hours.get(day) or "closed"
            n = new_hours.get(day) or "closed"
            summary_lines.append(f"{day.capitalize()} hours: {o} → {n}")

    # Peak windows — set of (day, start, end) tuples. Membership change = drift.
    def _norm_peaks(arr):
        return {(p.get("day"), p.get("start"), p.get("end")) for p in (arr or [])}
    old_peaks = _norm_peaks(saved.get("peak_windows"))
    new_peaks = _norm_peaks(proposal.get("peak_windows"))
    if old_peaks != new_peaks:
        added_peaks = new_peaks - old_peaks
        removed_peaks = old_peaks - new_peaks
        if added_peaks:
            changed.append("peak_windows_added")
            summary_lines.append(f"New peak window: {len(added_peaks)} added")
        if removed_peaks:
            changed.append("peak_windows_removed")
            summary_lines.append(f"Peak window dropped: {len(removed_peaks)} removed")

    # Role counts
    old_targets = {r["role"]: float(r["default_count"]) for r in saved.get("role_targets") or []}
    new_targets = {r["role"]: float(r["default_count"]) for r in proposal.get("role_targets") or []}
    role_lines: list[str] = []
    for role, new_n in new_targets.items():
        old_n = old_targets.get(role)
        if old_n is None or abs(new_n - old_n) >= ROLE_COUNT_DRIFT_MIN:
            changed.append(f"role_{role}")
            role_lines.append(f"{role}: {old_n if old_n is not None else '–'} → {new_n}")
    if role_lines:
        summary_lines.append("Roles: " + "; ".join(role_lines[:3]))

    if not changed:
        return None

    return {
        "kind": "staffing",
        "changed": changed,
        "summary": " · ".join(summary_lines[:4]),  # cap clutter
        "old": {
            "open_days_mask": old_mask,
            "operating_hours": old_hours,
            "peak_windows": list(old_peaks),
            "role_targets": old_targets,
        },
        "new": {
            "open_days_mask": new_mask,
            "operating_hours": new_hours,
            "peak_windows": list(new_peaks),
            "role_targets": new_targets,
        },
    }


# ─── Saved-state loader ────────────────────────────────────────────────


def _load_saved_staffing(db: Session, user: User) -> dict[str, Any]:
    """Read what's currently saved for this owner, in the same shape the
    inference service returns. So the diff is apples-to-apples."""
    bp = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    role_rows = (
        db.query(StaffRoleTarget)
        .filter(StaffRoleTarget.user_id == user.id)
        .all()
    )
    return {
        "open_days_mask": (bp.open_days_mask if bp else None) or "",
        "operating_hours": parse_operating_hours(bp) if bp else {},
        "peak_windows": parse_peak_windows(bp) if bp else [],
        "role_targets": [
            {"role": r.role, "default_count": float(r.default_count or 0)}
            for r in role_rows
        ],
    }


# ─── Public — single-user scan ─────────────────────────────────────────


def run_drift_scan_for_user(db: Session, *, user: User) -> list[SmartDriftFinding]:
    """Re-run Smart inferences for a user, persist any material drift.

    Returns the list of NEW or UPDATED finding rows (excluding ones that
    fell into the dismissal cooldown). Idempotent — safe to call as
    often as the cron schedule allows.
    """
    written: list[SmartDriftFinding] = []

    # ── Staffing drift ────────────────────────────────────────────────
    try:
        proposal = infer_staffing_profile(db, user=user)
    except Exception as exc:  # noqa: BLE001
        logger.warning("staffing inference failed for user %s: %s", user.id, exc)
        proposal = None

    if proposal:
        # Conservative: only consider drift findings if confidence is at
        # least medium. A "low confidence" inference comparing to saved
        # data would generate noise, not signal.
        if proposal.get("confidence") in {"medium", "high"}:
            saved = _load_saved_staffing(db, user)
            diff = _diff_staffing_proposal(saved, proposal)
            if diff:
                # Cooldown: did the owner dismiss a staffing finding in the
                # last DRIFT_COOLDOWN_DAYS? If yes, don't re-pin.
                cutoff = utc_now() - timedelta(days=DRIFT_COOLDOWN_DAYS)
                recent_dismissed = (
                    db.query(SmartDriftFinding)
                    .filter(
                        SmartDriftFinding.user_id == user.id,
                        SmartDriftFinding.kind == "staffing",
                        SmartDriftFinding.dismissed_at.isnot(None),
                        SmartDriftFinding.dismissed_at >= cutoff,
                    )
                    .first()
                )
                if not recent_dismissed:
                    # Idempotent upsert — update the existing OPEN finding
                    # if any, else insert.
                    open_row = (
                        db.query(SmartDriftFinding)
                        .filter(
                            SmartDriftFinding.user_id == user.id,
                            SmartDriftFinding.kind == "staffing",
                            SmartDriftFinding.dismissed_at.is_(None),
                            SmartDriftFinding.applied_at.is_(None),
                        )
                        .first()
                    )
                    title = "Your hours look different lately"
                    summary = diff["summary"]
                    if open_row:
                        open_row.title = title
                        open_row.summary = summary
                        open_row.payload_json = diff
                        open_row.detected_at = utc_now()
                        written.append(open_row)
                    else:
                        row = SmartDriftFinding(
                            id=uuid.uuid4(),
                            user_id=user.id,
                            kind="staffing",
                            title=title,
                            summary=summary,
                            payload_json=diff,
                            detected_at=utc_now(),
                        )
                        db.add(row)
                        written.append(row)

    if written:
        try:
            db.commit()
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            logger.exception("drift commit failed: %s", exc)
            return []

    return written


# ─── Public — apply / dismiss ──────────────────────────────────────────


class DriftFindingError(ValueError):
    """422-mappable when the finding can't be resolved (already
    dismissed/applied, wrong owner, etc.)."""


def dismiss_finding(db: Session, *, user: User, finding_id: uuid.UUID) -> SmartDriftFinding:
    row = (
        db.query(SmartDriftFinding)
        .filter(
            SmartDriftFinding.id == finding_id,
            SmartDriftFinding.user_id == user.id,
        )
        .first()
    )
    if not row:
        raise DriftFindingError("Finding not found.")
    if row.dismissed_at or row.applied_at:
        raise DriftFindingError("Finding already resolved.")
    row.dismissed_at = utc_now()
    db.commit()
    db.refresh(row)
    return row


def apply_finding(db: Session, *, user: User, finding_id: uuid.UUID) -> SmartDriftFinding:
    """Mark a staffing finding as applied. The actual write to the
    operating profile is performed by the dashboard via the existing
    PUT /business/operating-profile + PUT /business/staff-role-targets
    endpoints — this function just closes the finding so it doesn't
    re-surface. Keeps the apply path auditable (via existing endpoints'
    audit trails) and avoids duplicating validation logic.
    """
    row = (
        db.query(SmartDriftFinding)
        .filter(
            SmartDriftFinding.id == finding_id,
            SmartDriftFinding.user_id == user.id,
        )
        .first()
    )
    if not row:
        raise DriftFindingError("Finding not found.")
    if row.dismissed_at or row.applied_at:
        raise DriftFindingError("Finding already resolved.")
    row.applied_at = utc_now()
    db.commit()
    db.refresh(row)
    return row


def list_open_findings(db: Session, *, user: User) -> list[SmartDriftFinding]:
    """Open = not dismissed AND not applied. Tenant-scoped."""
    return (
        db.query(SmartDriftFinding)
        .filter(
            SmartDriftFinding.user_id == user.id,
            SmartDriftFinding.dismissed_at.is_(None),
            SmartDriftFinding.applied_at.is_(None),
        )
        .order_by(SmartDriftFinding.detected_at.desc())
        .all()
    )
