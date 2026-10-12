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


def _suggested_within_cap(user: User, suggested: list[str]) -> list[str]:
    """The archetype's suggestions that may be merged into ``user``'s module
    CSV without granting more than the plan allows.

    Canonical ids (the real, tier-capped modules — bar_pour / wine_sommelier /
    workshop) are kept only while the account has room under its plan's
    module cap: a bar is suggested two, and a Free account (cap 1) — say one
    that runs the wizard after its trial ended — gets the first only. Ids the
    account already has always pass (no new grant). The legacy signal ids
    (competitor / weather / …) are not modules, count for nothing and always
    pass. Pure; never raises (an unreadable cap keeps only what is held)."""
    from app.services.modules import get_enabled, is_valid_module_id

    held = set(get_enabled(user))
    try:
        from app.services.billing import get_cap
        cap = get_cap(user, "modules")
    except Exception:  # noqa: BLE001 — no cap answer = no new module
        cap = 0
    room = None if cap is None or cap < 0 else max(0, cap - len(held))
    out: list[str] = []
    for m in suggested:
        cid = canonical_module_id(m)
        if not cid or cid in out:
            continue
        if is_valid_module_id(cid) and cid not in held:
            if room is not None:
                if room <= 0:
                    continue
                room -= 1
        out.append(cid)
    return out


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
        # Within the plan's module cap (_suggested_within_cap): the bar's
        # suggestions are real modules now, and a Free account must not be
        # handed two (vertical-fit review, Oct 2026). On a trial — where every
        # new account starts — the cap is unlimited and nothing changes.
        try:
            suggested = _suggested_within_cap(user, defaults["suggested_modules"])
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
        # The new preset would hide these, but they stay. `pillars_kept`: the
        # owner uses them (a real usage row) — the sheet says "because you use
        # it". `pillars_stay`: there is no usage signal to go on (Insights has
        # none), so they stay without a reason claimed.
        "pillars_kept": [],
        "pillars_stay": [],
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
        # No signal for a pillar (insights) = treated as in use: it stays —
        # but the sheet must not claim the owner uses it (pillars_stay).
        hide = sorted(p for p in candidates if used.get(p) is False)
        kept = sorted(p for p in candidates if used.get(p) is True)
        plan["pillars_show"] = show
        plan["pillars_hide"] = hide
        plan["pillars_kept"] = kept
        plan["pillars_stay"] = sorted(candidates - set(hide) - set(kept))
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
    # The owner's team members read their OWN row's business_type (/auth/me
    # answers as the member) — copied at invite and never updated, so a
    # manager kept the café's nav after the owner became a salon. Same
    # transaction as the owner's own change.
    sync_team_business_type(db, user)
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


# ─── Team members carry the owner's type ──────────────────────────────────
#
# An invited member is a User row with owner_id = the owner (routers/team.py
# copies business_type at invite). Every request a member makes is answered
# as the owner (services/auth._resolve_member_view) EXCEPT /auth/me and the
# login responses, which serialise the member's own row — and the app takes
# the business type from there. Nothing updated that copy, so after a type
# change the owner's manager kept the old type's nav and words (vertical-fit
# review, Oct 2026). Kept in step on every owner write of the type, and
# aligned once per boot for the rows that drifted before.
#
# Hardened after a Postgres 16 review (Push 8): only the three member roles
# follow the owner (an accountant / owner row that carries an owner_id is not
# a team seat); never an owner whose type is "personal" (personal mode is
# the owner's own household books, not a vertical a team works in); and the
# write keeps users.updated_at, which means "last profile change", not "last
# boot" (services/last_seen.py writes it the same way).

_MEMBER_ROLES = ("manager", "cashier", "viewer")
_PERSONAL_TYPE = "personal"


def sync_team_business_type(db: Session, owner: User) -> int:
    """Give ``owner``'s team members the owner's business_type. Does NOT
    commit: the caller commits it with the owner's own change, so the two can
    never disagree. Returns the number of member rows changed."""
    from sqlalchemy import or_, update

    bt = getattr(owner, "business_type", None)
    if getattr(owner, "id", None) is None or not bt or bt == _PERSONAL_TYPE:
        return 0
    result = db.execute(
        update(User)
        .where(
            User.owner_id == owner.id,
            User.role.in_(_MEMBER_ROLES),
            or_(User.business_type.is_(None), User.business_type != bt),
        )
        # updated_at=User.updated_at: the column's onupdate would stamp it.
        .values(business_type=bt, updated_at=User.updated_at)
        .execution_options(synchronize_session=False)
    )
    return int(result.rowcount or 0)


def _boot_lock_timeout(db: Session) -> None:
    """A boot fix waits at most 3 s for a row a live request holds (Postgres;
    SQLite has no row locks). SET LOCAL: it ends with the fix's own
    transaction, so it never leaks to the pooled connection's next user."""
    from sqlalchemy import text

    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SET LOCAL lock_timeout = '3s'"))


def _drifted_members(db: Session) -> list[tuple]:
    """(member id, member type, owner id, owner type) for every team seat
    whose type differs from its owner's. Read-only."""
    from sqlalchemy import or_, select
    from sqlalchemy.orm import aliased

    owner = aliased(User)
    return list(db.execute(
        select(User.id, User.business_type, owner.id, owner.business_type)
        .join(owner, User.owner_id == owner.id)
        .where(
            User.role.in_(_MEMBER_ROLES),
            owner.business_type.isnot(None),
            owner.business_type != _PERSONAL_TYPE,
            or_(User.business_type.is_(None), User.business_type != owner.business_type),
        )
    ).all())


def align_member_business_types(db: Session) -> int:
    """Boot backfill: every member row whose business_type differs from its
    owner's takes the owner's. Idempotent (a second pass changes nothing).
    Read-mostly: only drifted member rows are written. Returns the count.

    Each write is conditional on what was read: the member still holds the
    type the boot saw AND the owner still holds the type the boot is about to
    copy. A row an owner changed between the read and the write is left to
    the owner's own request (which syncs the team itself)."""
    from sqlalchemy import exists, update
    from sqlalchemy.orm import aliased

    _boot_lock_timeout(db)
    changed = 0
    for member_id, member_type, owner_id, owner_type in _drifted_members(db):
        current_owner = aliased(User)
        still_member_type = (
            User.business_type.is_(None) if member_type is None
            else User.business_type == member_type
        )
        result = db.execute(
            update(User)
            .where(
                User.id == member_id,
                User.owner_id == owner_id,
                User.role.in_(_MEMBER_ROLES),
                still_member_type,
                exists().where(
                    current_owner.id == owner_id,
                    current_owner.business_type == owner_type,
                ),
            )
            .values(business_type=owner_type, updated_at=User.updated_at)
            .execution_options(synchronize_session=False)
        )
        changed += int(result.rowcount or 0)
    db.commit()
    return changed


# ─── The bar's old module spellings, renamed in place ─────────────────────
#
# Until Oct 2026 a new bar was given enabled_modules "pour,wine" — spellings
# no gate reads — so Bar Pour (/bar) and Vinkort (/wine-list) never appeared.
# archetype.py suggests the canonical ids now; this renames the old spelling
# for the accounts that already carry it. A RENAME, never an addition:
#   • only an id the account already holds is touched ("pour" → "bar_pour",
#     "wine" → "wine_sommelier", in place, order kept);
#   • never past the plan's module cap. The old spellings were no module at
#     all, the canonical ids are real, tier-capped ones: a Free bar after its
#     trial ("pour,wine", cap 1) would come out holding two. Such a row is
#     left exactly as it was — the owner picks on /modules;
#   • a live trial counts with the FREE cap here (onboarding still grants a
#     trial both bar modules). With the trial's own, unlimited cap the answer
#     depended on the deploy date: the same "pour,wine" bar became two
#     modules when the boot ran during its trial and stayed as it was when
#     the boot ran a day after it ended;
#   • conditional on the value read: an owner who saved /modules between the
#     boot's read and its write keeps what they saved;
#   • idempotent: a renamed row holds no old spelling; a row left as it was
#     is looked at again next boot and renamed once the plan allows it.
# Runs at boot (main._init_db via run_vertical_fit_boot_fixes), on Postgres
# and SQLite alike.

def _boot_module_cap(user: User) -> int:
    """The module cap the boot rename applies: the plan's, except that a
    live trial counts as Free (see above)."""
    from app.services.billing import PLAN_CAPS, effective_plan, get_cap

    if effective_plan(user) == "trial":
        return int(PLAN_CAPS["free"].get("modules", 0))
    return get_cap(user, "modules")


def rename_legacy_module_ids(db: Session) -> dict[str, int]:
    """Rename the old module spellings in place for every account that
    carries one, within its module cap. Returns {renamed, kept}; "kept" is
    every row left exactly as it was — over the cap, or changed by a request
    meanwhile — and looked at again next boot."""
    from sqlalchemy import or_, update

    from app.services.modules import parse_enabled

    _boot_lock_timeout(db)
    out = {"renamed": 0, "kept": 0}
    candidates = (
        db.query(User)
        .filter(
            User.enabled_modules.isnot(None),
            or_(*[User.enabled_modules.like(f"%{old}%") for old in _MODULE_ALIASES]),
        )
        .all()
    )
    for user in candidates:
        old_csv = user.enabled_modules
        pieces = [p.strip() for p in (old_csv or "").split(",") if p.strip()]
        if not any(p in _MODULE_ALIASES for p in pieces):
            continue  # "pour" inside another word — nothing to rename
        renamed: list[str] = []
        for p in pieces:
            c = _MODULE_ALIASES.get(p, p)
            if c not in renamed:
                renamed.append(c)
        cap = _boot_module_cap(user)
        if cap is not None and cap >= 0 and len(parse_enabled(",".join(renamed))) > cap:
            out["kept"] += 1
            continue
        result = db.execute(
            update(User)
            .where(User.id == user.id, User.enabled_modules == old_csv)
            .values(enabled_modules=",".join(renamed) or None, updated_at=User.updated_at)
            .execution_options(synchronize_session=False)
        )
        if result.rowcount:
            out["renamed"] += 1
        else:
            out["kept"] += 1
    db.commit()
    return out


def run_vertical_fit_boot_fixes(session_factory, log=print) -> dict[str, Any]:
    """The two boot data fixes, each in its OWN session and try: a failure in
    one (a lock timeout, a bad row) never stops the other, and leaves its own
    rows as they were for the next boot. The log carries the error's type
    name only — an exception's text can hold the SQL and its parameters.
    Returns {"modules": {renamed, kept} | None, "members": int | None}."""
    out: dict[str, Any] = {"modules": None, "members": None}
    try:
        with session_factory() as vf_db:
            out["modules"] = rename_legacy_module_ids(vf_db)
    except Exception as e:  # noqa: BLE001 — fail-soft, retried next boot
        log(f"Vertical-fit module rename skipped: {type(e).__name__}")
    try:
        with session_factory() as vf_db:
            out["members"] = align_member_business_types(vf_db)
    except Exception as e:  # noqa: BLE001 — fail-soft, retried next boot
        log(f"Vertical-fit member alignment skipped: {type(e).__name__}")
    mods = out["modules"] or {}
    if mods.get("renamed") or mods.get("kept") or out["members"]:
        log(
            f"Vertical-fit backfill: {mods.get('renamed', 0)} module CSVs renamed, "
            f"{mods.get('kept', 0)} kept as they were (over the cap, or changed meanwhile), "
            f"{out['members'] or 0} member types aligned"
        )
    return out
