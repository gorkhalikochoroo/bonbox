"""Materialise the smart signup/onboarding defaults for an account's
business-archetype. Lives in its OWN module (not ``archetype.py``) so the
canonical mapping layer stays model-free / trivially importable; this file is
the only archetype consumer that touches the ORM.

WHAT IT SETS (idempotently — see DOCTRINE in archetype.py)
----------------------------------------------------------
Reads ``archetype_defaults(user.business_type)`` and applies, only where the
owner hasn't already chosen otherwise:

  1. ``BusinessProfile.day_cutoff_hour`` — creates the profile row if missing;
     stamps the archetype's cutoff ONLY when the row is newly created OR the
     value is still the column default (6) and looks uncustomised. NEVER
     clobbers a value the owner set in the Profile editor.
  2. ``User.enabled_modules`` — MERGES (set-union) the archetype's
     ``suggested_modules`` into the existing CSV. Never removes a module the
     owner already enabled. NB: these are the Layout.jsx / branchekode_map
     module keys (competitor / weather / expiry / pour / wine / khata / loan /
     workshop), NOT the modules.py paid-module allowlist — so we do a raw CSV
     union here rather than routing through ``modules.serialize_enabled``
     (which would silently drop every one of them).
  3. Starter ``ExpenseCategory`` rows — seeded ONLY when the user has zero
     categories today. DK-localised internal names (kept Danish per the
     terminology lock — these are bookkeeping categories, not UI chrome).

NOT TOUCHED: VAT (currency-derived), billing/tier. By doctrine, archetype sets
defaults + emphasis only; it never gates a paid feature or flips a plan.

SAFETY: the whole body is wrapped try/except → log + swallow. A defaults error
must NEVER 500 a signup or onboarding-complete. Safe to call repeatedly.
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from app.models.business_profile import BusinessProfile
from app.models.expense import ExpenseCategory
from app.models.user import User
from app.services.archetype import archetype_defaults, archetype_id_for

logger = logging.getLogger("bonbox.archetype_defaults")

# The column default for day_cutoff_hour (BusinessProfile). We only auto-stamp
# the archetype cutoff when the stored value is still this — i.e. the owner
# hasn't touched it. Kept in sync with the model's mapped_column(default=6).
_DEFAULT_CUTOFF_HOUR = 6

# Starter expense categories per archetype id. DK-localised on purpose — these
# are internal bookkeeping buckets (Vareforbrug / Løn / Husleje), not UI text,
# so they stay Danish across all UI languages (terminology lock).
_STARTER_CATEGORIES: dict[str, list[str]] = {
    "food_service": ["Vareforbrug", "Løn", "Husleje", "Emballage"],
    "bar": ["Vareforbrug", "Løn", "Husleje"],
    "retail": ["Varekøb", "Husleje", "Løn"],
    "salon": ["Produkter", "Løn", "Husleje"],
    "services": ["Materialer", "Værktøj", "Husleje"],
    "personal": ["Husleje", "Diverse"],
    "generic": ["Husleje", "Løn", "Diverse"],
}


def _merge_enabled_modules(raw: str | None, suggested: list[str]) -> str | None:
    """Union an existing comma-separated module CSV with the archetype's
    suggested modules, preserving existing order then appending any new ones.

    Returns the new CSV string, or None when the result is empty (keeps the
    column NULL-when-empty convention used elsewhere). Never drops an existing
    entry — merge is additive only.
    """
    seen: set[str] = set()
    out: list[str] = []
    # Existing first — preserve the owner's current selection + order.
    for piece in (raw or "").split(","):
        m = piece.strip()
        if m and m not in seen:
            out.append(m)
            seen.add(m)
    # Then the archetype suggestions that aren't already present.
    for m in suggested:
        m = (m or "").strip()
        if m and m not in seen:
            out.append(m)
            seen.add(m)
    return ",".join(out) if out else None


def apply_archetype_defaults(db: Session, user: User) -> dict[str, Any]:
    """Idempotently materialise archetype-derived signup defaults for ``user``.

    Returns a small dict describing what (if anything) changed — handy for the
    detection/onboarding telemetry and for tests. NEVER raises: any failure is
    logged and swallowed so signup / onboarding-complete can't be broken by a
    defaults hiccup. Callers should still wrap their invocation in their own
    try/except for belt-and-braces (the wire-in points do).
    """
    result: dict[str, Any] = {
        "archetype": None,
        "cutoff_set": False,
        "modules_added": [],
        "categories_seeded": [],
    }
    try:
        if user is None or getattr(user, "id", None) is None:
            return result

        defaults = archetype_defaults(getattr(user, "business_type", None))
        archetype_id = defaults["archetype"]
        result["archetype"] = archetype_id

        # ── 1. BusinessProfile.day_cutoff_hour ─────────────────────────────
        # Create the row if missing; stamp the archetype cutoff only when the
        # row is newly created or the value is still the column default (6).
        # Never overwrite an owner-customised value.
        target_cutoff = defaults["day_cutoff_hour"]
        try:
            profile = (
                db.query(BusinessProfile)
                .filter(BusinessProfile.user_id == user.id)
                .first()
            )
            newly_created = False
            if profile is None:
                profile = BusinessProfile(user_id=user.id)
                db.add(profile)
                newly_created = True
            # Only set when newly created OR still at the documented default —
            # this is the "not explicitly customised" guard.
            current = getattr(profile, "day_cutoff_hour", _DEFAULT_CUTOFF_HOUR)
            if (newly_created or current == _DEFAULT_CUTOFF_HOUR) and (
                target_cutoff != current
            ):
                profile.day_cutoff_hour = int(target_cutoff)
                result["cutoff_set"] = True
            # If newly created we still commit the row even when the cutoff
            # equals the default, so the profile exists for later edits.
            db.commit()
        except Exception as e:  # noqa: BLE001
            db.rollback()
            logger.warning(
                "apply_archetype_defaults: cutoff step skipped for user=%s: %s",
                getattr(user, "id", "?"), e,
            )

        # ── 2. User.enabled_modules — additive merge ───────────────────────
        try:
            suggested = defaults["suggested_modules"]
            if suggested:
                before = getattr(user, "enabled_modules", None)
                merged = _merge_enabled_modules(before, suggested)
                if merged != before:
                    # Compute what was actually added for telemetry/tests.
                    before_set = {
                        p.strip() for p in (before or "").split(",") if p.strip()
                    }
                    after_set = {
                        p.strip() for p in (merged or "").split(",") if p.strip()
                    }
                    result["modules_added"] = sorted(after_set - before_set)
                    user.enabled_modules = merged
                    db.commit()
                    db.refresh(user)
        except Exception as e:  # noqa: BLE001
            db.rollback()
            logger.warning(
                "apply_archetype_defaults: module merge skipped for user=%s: %s",
                getattr(user, "id", "?"), e,
            )

        # ── 3. Starter ExpenseCategory rows (only if user has zero) ─────────
        try:
            existing_count = (
                db.query(ExpenseCategory)
                .filter(ExpenseCategory.user_id == user.id)
                .count()
            )
            if existing_count == 0:
                names = _STARTER_CATEGORIES.get(archetype_id)
                if names:
                    for name in names:
                        db.add(ExpenseCategory(user_id=user.id, name=name))
                    db.commit()
                    result["categories_seeded"] = list(names)
        except Exception as e:  # noqa: BLE001
            db.rollback()
            logger.warning(
                "apply_archetype_defaults: category seed skipped for user=%s: %s",
                getattr(user, "id", "?"), e,
            )

        return result
    except Exception as e:  # noqa: BLE001 — defaults must never break signup
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        logger.exception(
            "apply_archetype_defaults failed (swallowed) for user=%s: %s",
            getattr(user, "id", "?"), e,
        )
        return result
