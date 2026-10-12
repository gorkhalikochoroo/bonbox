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
     owner already enabled. The list mixes canonical modules.py ids (bar_pour /
     wine_sommelier / workshop — the ones a nav gate reads) with legacy signal
     ids (competitor / weather / expiry / khata / loan) that nothing reads, so
     we do a raw CSV union here rather than routing through
     ``modules.serialize_enabled`` (which would drop the signal ids). Old
     spellings ("pour" / "wine") are mapped by ``_MODULE_ALIASES``.
  3. Starter ``ExpenseCategory`` rows — seeded ONLY when the user has zero
     categories today. DK-localised internal names (kept Danish per the
     terminology lock — these are bookkeeping categories, not UI chrome).

NOT TOUCHED: VAT (currency-derived), billing/tier. By doctrine, archetype sets
defaults + emphasis only; it never gates a paid feature or flips a plan.

A TYPE NOBODY CHOSE (push 6): the e-mail sign-up no longer asks the business
type — the wizard does — and the server stamps its schema default
"restaurant" meanwhile. ``starter_set=False`` (register, when the request
carried no business_type) does step 1 only: the profile row and its cutoff.
Steps 2 and 3 wait for /auth/onboarding/complete, by when the owner has picked
the type, so a salon or a shop does not keep the food modules and the food
expense categories (Emballage, Vareforbrug) of a type it never chose — merge
and seed are additive-only and would never take them back.

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

# The marker demo_seed puts on every sample row it writes ("Løn · demo").
_DEMO_SUFFIX = " · demo"

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


# Old module spellings an archetype used to suggest → the canonical
# services/modules.py id that actually switches a nav row on. A bar was given
# "pour" / "wine", which no gate reads, so Bar Pour and Vinkort never showed
# for a bar (vertical-fit audit, Oct 2026). Mapped on merge; main.py backfills
# the accounts that already carry the old spelling.
_MODULE_ALIASES: dict[str, str] = {
    "pour": "bar_pour",
    "wine": "wine_sommelier",
}


def canonical_module_id(module_id: str | None) -> str:
    """The module id that gates a surface, for a suggested (possibly old) id."""
    m = (module_id or "").strip()
    return _MODULE_ALIASES.get(m, m)


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
        m = canonical_module_id(m)
        if m and m not in seen:
            out.append(m)
            seen.add(m)
    return ",".join(out) if out else None


def apply_archetype_defaults(db: Session, user: User, *, starter_set: bool = True) -> dict[str, Any]:
    """Idempotently materialise archetype-derived signup defaults for ``user``.

    ``starter_set=False`` sets only the profile row + cutoff (step 1) and
    leaves the modules and the starter categories for a later call — used at
    register when the owner was not asked the type (see the module doc).

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

        if not starter_set:
            return result

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
        # Sample categories (the wizard's "Udforsk med eksempeldata" seeds
        # them BEFORE /onboarding/complete, named "<name> · demo") are not the
        # owner's own: counting them left a salon with no starter set at all
        # once "Ryd demodata" removed the samples.
        try:
            existing_count = (
                db.query(ExpenseCategory)
                .filter(
                    ExpenseCategory.user_id == user.id,
                    ~ExpenseCategory.name.like(f"%{_DEMO_SUFFIX}"),
                )
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


# ─── Changing the business type later (Profile → Virksomhedstype) ─────────
#
# Until Oct 2026 the Profile type field changed ONE column: the wording in the
# app followed, but the day cutoff, the modules, the starter categories and
# the pillar preset all stayed those of the old type — while the preview card
# promised "Dagsskifte kl. 00:00" it never saved (vertical-fit audit).
#
# plan_type_change() says, read-only, exactly what switching to a new type
# would change; the owner sees that list and chooses "Anvend" (apply) or
# "Behold mine indstillinger" (type only). apply_type_change() writes it.
#
# NEVER DESTRUCTIVE (doctrine: don't delete working stuff):
#   • the cutoff moves only when it is still the OLD type's default — a value
#     the owner set themselves stays;
#   • modules and expense categories are only ADDED, never removed;
#   • a pillar is hidden only when the new type's preset hides it, the old one
#     did not, AND the owner has never used it (activated_pillars, fail-open:
#     no signal = in use = stays). A pillar the OLD preset hid and the new one
#     does not is shown again.
#   • no row of the owner's data is touched.

def _starter_names(archetype_id: str) -> list[str]:
    return list(_STARTER_CATEGORIES.get(archetype_id) or [])


def plan_type_change(db: Session, user: User, new_type: str | None) -> dict[str, Any]:
    """What switching ``user`` to ``new_type`` would change. Pure read."""
    from app.services.archetype import cutoff_hour_for
    from app.services.modules import get_enabled, is_valid_module_id
    from app.services.pillars import (
        activated_pillars, get_hidden, preset_hidden_pillars,
    )

    old_type = getattr(user, "business_type", None)
    new_defaults = archetype_defaults(new_type)
    plan: dict[str, Any] = {
        "from_type": old_type,
        "to_type": new_type,
        "from_archetype": archetype_id_for(old_type),
        "to_archetype": new_defaults["archetype"],
        "cutoff": None,
        "cutoff_kept": None,
        "modules_add": [],
        "categories_add": [],
        "pillars_show": [],
        "pillars_hide": [],
        "pillars_kept": [],
    }

    # 1. Day cutoff — moves only while it is still the old type's default.
    try:
        profile = (
            db.query(BusinessProfile)
            .filter(BusinessProfile.user_id == user.id)
            .first()
        )
        current = getattr(profile, "day_cutoff_hour", None) if profile else None
        target = int(new_defaults["day_cutoff_hour"])
        if current is None or int(current) == int(cutoff_hour_for(old_type)):
            if current is None or int(current) != target:
                plan["cutoff"] = {"from": current, "to": target}
        elif int(current) != target:
            plan["cutoff_kept"] = int(current)
    except Exception as e:  # noqa: BLE001 — a plan read never 500s
        logger.warning("plan_type_change: cutoff read skipped for user=%s: %s",
                       getattr(user, "id", "?"), e)

    # 2. Modules — canonical ids only, never past the plan's module cap.
    try:
        enabled = list(get_enabled(user))
        wanted = []
        for m in new_defaults["suggested_modules"]:
            cid = canonical_module_id(m)
            if is_valid_module_id(cid) and cid not in enabled and cid not in wanted:
                wanted.append(cid)
        if wanted:
            from app.services.billing import get_cap
            cap = get_cap(user, "modules")
            if cap is not None and cap >= 0:
                wanted = wanted[: max(0, cap - len(enabled))]
        plan["modules_add"] = wanted
    except Exception as e:  # noqa: BLE001
        logger.warning("plan_type_change: modules skipped for user=%s: %s",
                       getattr(user, "id", "?"), e)

    # 3. Starter expense categories the owner does not have yet.
    try:
        have = {
            (c.name or "").strip().casefold()
            for c in db.query(ExpenseCategory)
            .filter(ExpenseCategory.user_id == user.id)
            .all()
        }
        plan["categories_add"] = [
            n for n in _starter_names(new_defaults["archetype"])
            if n.casefold() not in have
        ]
    except Exception as e:  # noqa: BLE001
        logger.warning("plan_type_change: categories skipped for user=%s: %s",
                       getattr(user, "id", "?"), e)

    # 4. Pillars — show what only the old preset hid; hide only the unused.
    try:
        hidden = get_hidden(user)
        old_preset = preset_hidden_pillars(old_type)
        new_preset = preset_hidden_pillars(new_type)
        show = sorted(p for p in hidden if p in old_preset and p not in new_preset)
        candidates = new_preset - old_preset - hidden
        used = activated_pillars(db, user) if candidates else {}
        # No signal for a pillar (insights) = treated as in use: it stays.
        hide = sorted(p for p in candidates if used.get(p) is False)
        plan["pillars_show"] = show
        plan["pillars_hide"] = hide
        plan["pillars_kept"] = sorted(candidates - set(hide))
    except Exception as e:  # noqa: BLE001
        logger.warning("plan_type_change: pillars skipped for user=%s: %s",
                       getattr(user, "id", "?"), e)

    plan["has_changes"] = bool(
        plan["cutoff"] or plan["modules_add"] or plan["categories_add"]
        or plan["pillars_show"] or plan["pillars_hide"]
    )
    return plan


def apply_type_change(db: Session, user: User, new_type: str,
                      *, apply_defaults: bool) -> dict[str, Any] | None:
    """Set ``user.business_type`` and, when the owner chose "Anvend", apply the
    plan computed against the OLD type. Returns the applied plan (None when the
    owner kept their settings). Additive only — see the block comment above."""
    from app.services.pillars import get_hidden, set_hidden

    plan = plan_type_change(db, user, new_type) if apply_defaults else None
    user.business_type = new_type
    db.commit()
    if not plan:
        return None

    if plan["cutoff"]:
        profile = (
            db.query(BusinessProfile)
            .filter(BusinessProfile.user_id == user.id)
            .first()
        )
        if profile is None:
            profile = BusinessProfile(user_id=user.id)
            db.add(profile)
        profile.day_cutoff_hour = int(plan["cutoff"]["to"])
        db.commit()

    if plan["modules_add"]:
        # Raw CSV union (not set_enabled): every id already stored stays,
        # the legacy signal ids included.
        user.enabled_modules = _merge_enabled_modules(
            getattr(user, "enabled_modules", None), plan["modules_add"])
        db.commit()

    if plan["categories_add"]:
        for name in plan["categories_add"]:
            db.add(ExpenseCategory(user_id=user.id, name=name))
        db.commit()

    if plan["pillars_show"] or plan["pillars_hide"]:
        hidden = (get_hidden(user) - set(plan["pillars_show"])) | set(plan["pillars_hide"])
        set_hidden(db, user, hidden)

    return plan
