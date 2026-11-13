"""
Egenkontrol — the database layer over egenkontrol_rules.

`now_utc()` below is the ONLY clock in the feature: every save, status, folder
and PDF asks it, so the server's receive time is the official time and tests
freeze the feature by monkeypatching this one symbol.

Tenancy: the tenant is always the OWNER (`owner.id`) — an invited member is
delegated to the owner by get_current_user, a kitchen iPad is re-derived from
its link row. Every id in a path or body (check, entry, branch, staff, device)
is looked up WITH the tenant, so another venue's id is a plain 404.
"""

import json
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.branch import Branch
from app.models.business_profile import BusinessProfile
from app.models.food_check import (
    FoodCheck, FoodCheckEntry, FoodCheckPhoto, FoodCheckRevision, FoodCheckSettings,
)
from app.models.staff import Schedule, StaffMember
from app.services import audit_service
from app.services import egenkontrol_rules as R
from app.utils.time import utc_now

# The plan's limit (billing.PLAN_CAPS). It counts ACTIVE TEMPERATURE checks
# only — køl, frost, varmholdelse, genopvarmning, varemodtagelse: every kind
# except "tick" — on every plan (Free 6, Starter / Pro / Trial 100). Ticks
# (Rengøring, Termometertjek) never count and never give a 402; they have the
# flat abuse ceiling R.TICKS_MAX instead (409 too_many_ticks). Founder, 13 Nov
# 2026. The key keeps its R1a name so the 402 payload's "cap" never changes.
CAP_KEY = "egenkontrol_active_checks"
TICK_KIND = "tick"
FEATURE = "egenkontrol"
_DEFAULT_TZ = "Europe/Copenhagen"
_DEFAULT_CUTOFF = 6


def now_utc() -> datetime:
    """THE clock of the feature (naive UTC)."""
    return utc_now()


# ── Errors ───────────────────────────────────────────────────────────────

def not_found() -> HTTPException:
    return HTTPException(status_code=404, detail={"error": "not_found"})


def conflict(code: str, **extra) -> HTTPException:
    return HTTPException(status_code=409, detail={"code": code, **extra})


def rule_http(e: R.RuleError) -> HTTPException:
    return HTTPException(status_code=422, detail={"code": e.code, **e.detail})


# ── Venue zone, cutoff, relevance ────────────────────────────────────────

def zone_and_cutoff(db: Session, owner) -> tuple[ZoneInfo, int, str]:
    """The VENUE's zone (tz_utils.owner_tz_name) + business_profiles.
    day_cutoff_hour (fallback 6) — resolved once per request, exactly like
    dashboard._resolve_user_cutoff; never a process-wide zone.

    Never the raw users.timezone: the browser writes its own zone there at
    every login (useAuth.syncTimezoneIfChanged), so an owner who logs in
    abroad or from a laptop on UTC would move the kitchen's day. The 12 Nov
    rule (tz_utils.owner_tz_name): a DKK owner's business day is
    Europe/Copenhagen whatever is stored — the same day I dag, the daily close
    and the reservation book use. It matters doubly here: business_date and
    late are written once into append-only rows (088) that print in the
    Kontrolmappe. Every Egenkontrol module (records, week, files, PDF, the
    kitchen iPad, the needs-you finding) reads the zone through here."""
    from app.services.tz_utils import owner_tz_name
    name = (owner_tz_name(owner) or _DEFAULT_TZ).strip() or _DEFAULT_TZ
    try:
        tz = ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        tz, name = ZoneInfo("UTC"), "UTC"
    cutoff = _DEFAULT_CUTOFF
    row = (
        db.query(BusinessProfile.day_cutoff_hour)
        .filter(BusinessProfile.user_id == owner.id)
        .first()
    )
    if row is not None and row[0] is not None:
        try:
            cutoff = max(0, min(23, int(row[0])))
        except (TypeError, ValueError):
            cutoff = _DEFAULT_CUTOFF
    return tz, cutoff, name


def relevant(business_type: Optional[str], opted_in: bool = False) -> bool:
    """UI visibility only (food service and bar; R1b: a grocery, veggie_shop
    or kiosk that switched it on); the backend never 403s another archetype."""
    from app.services.archetype import archetype_id_for
    if archetype_id_for(business_type) in ("food_service", "bar"):
        return True
    return bool(opted_in) and (business_type or "") in R.RETAIL_OPT_IN_TYPES


def opt_in_offered(business_type: Optional[str], opted_in: bool) -> bool:
    return (business_type or "") in R.RETAIL_OPT_IN_TYPES and not opted_in


# ── Serialisation ────────────────────────────────────────────────────────

def _sid(v) -> Optional[str]:
    return None if v is None else str(v)


def iso_z(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.isoformat() + "Z"


def _f(v) -> Optional[float]:
    return None if v is None else float(v)


def rev_view(rev: FoodCheckRevision, check: FoodCheck) -> R.RevisionView:
    return R.RevisionView(
        id=rev.id,
        check_id=rev.check_id,
        valid_from=rev.valid_from,
        active=bool(rev.active),
        schedule=R.load_json(rev.schedule, {"type": "on_event"}),
        limit_c=rev.limit_c,
        limit_source=rev.limit_source,
        product_limits=R.load_json(rev.product_limits, None),
        recheck_min=int(rev.recheck_min or R.RECHECK_MIN_DEFAULT),
        name=rev.name,
        note=rev.note,
        template_key=check.template_key,
        kind=check.kind,
        action_codes=tuple(R.load_json(rev.action_codes, [])),
        fate_codes=tuple(R.load_json(rev.fate_codes, [])),
    )


def _limit_of(rv: R.RevisionView) -> Optional[dict]:
    if rv.kind == "receiving" or rv.limit_c is None:
        return None
    return R.limit_for(rv).as_dict()


def check_out(check: FoodCheck, revs: list[R.RevisionView]) -> dict:
    cur = revs[-1] if revs else None
    tpl = R.START_LIST.get(check.template_key) or {}
    return {
        "id": str(check.id),
        "name": check.name,
        "note": check.note,
        "kind": check.kind,
        "template_key": check.template_key,
        "group_key": check.group_key,
        "branch_id": _sid(check.branch_id),
        "sort_order": int(check.sort_order or 0),
        "active": bool(check.active),
        "archived_at": iso_z(check.archived_at),
        "limit": _limit_of(cur) if cur else None,
        "product_limits": R.product_limits_list(cur) if cur else None,
        "schedule": cur.schedule if cur else None,
        "schedule_options": list(tpl.get("schedule_options") or ()),
        "recheck_min": cur.recheck_min if cur else R.RECHECK_MIN_DEFAULT,
        "action_codes": list(cur.action_codes) if cur else [],
        "fate_codes": list(cur.fate_codes) if cur else [],
        "revision_id": _sid(cur.id) if cur else None,
        "valid_from": iso_z(cur.valid_from) if cur else None,
    }


def photo_out(p: Optional[FoodCheckPhoto], tz: ZoneInfo) -> Optional[dict]:
    """PhotoOut — never the storage key; bytes only through the proxy routes."""
    if p is None:
        return None
    loc = R.to_local(p.uploaded_at, tz)
    return {
        "id": str(p.id),
        "entry_id": str(p.entry_id),
        "uploaded_at": iso_z(p.uploaded_at),
        "uploaded_local_date": loc.date().isoformat(),
        "uploaded_local": loc.strftime("%H:%M"),
        "size_bytes": int(p.size_bytes or 0),
        "removed_at": iso_z(p.removed_at),
        "removed_local_date": (R.to_local(p.removed_at, tz).date().isoformat()
                               if p.removed_at is not None else None),
        "via": p.via,
    }


def photos_for(db: Session, owner, entry_ids) -> dict[str, FoodCheckPhoto]:
    """{entry id: photo row} for a whole page of readings — one query per
    500 ids, never one per row."""
    ids = sorted({str(x) for x in entry_ids if x is not None})
    if not ids:
        return {}
    out: dict[str, FoodCheckPhoto] = {}
    for i in range(0, len(ids), 500):
        for p in (
            db.query(FoodCheckPhoto)
            .filter(FoodCheckPhoto.user_id == owner.id,
                    FoodCheckPhoto.entry_id.in_([uuid.UUID(x) for x in ids[i:i + 500]]))
            .all()
        ):
            out[str(p.entry_id)] = p
    return out


def _local_parts(dt: Optional[datetime], tz: ZoneInfo) -> tuple[Optional[str], Optional[str]]:
    if dt is None:
        return None, None
    loc = R.to_local(dt, tz)
    return loc.strftime("%H:%M"), loc.date().isoformat()


def entry_out(e: FoodCheckEntry, tz: ZoneInfo, photos: Optional[dict] = None) -> dict:
    """EntryOut. `photos` is the per-request batch ({entry id: photo row},
    photos_for) — never one query per row; None = no photo known."""
    local = R.to_local(e.recorded_at, tz)
    differs = False
    if e.client_typed_at is not None:
        differs = abs(e.recorded_at - e.client_typed_at) > R.CLIENT_TIME_DIFF
    voided = e.voided_at is not None
    is_correction = e.supersedes_id is not None
    paper_local, paper_date = _local_parts(e.paper_measured_at, tz)
    created_local, created_date = _local_parts(e.created_at, tz)
    return {
        "id": str(e.id),
        "check_id": str(e.check_id),
        "client_id": e.client_id,
        "recorded_at": iso_z(e.recorded_at),
        "recorded_local": local.strftime("%H:%M"),
        "recorded_local_date": local.date().isoformat(),
        "business_date": e.business_date.isoformat() if e.business_date else None,
        "value_c": _f(e.value_c),
        "product_type": e.product_type,
        "product_note": e.product_note,
        "label_ok": e.label_ok,
        "limit_c": _f(e.limit_c),
        "limit_direction": e.limit_direction,
        "in_limit": e.in_limit,
        "late": bool(e.late),
        "slot_due_at": iso_z(e.slot_due_at),
        "slot_due_local": R.hhmm_local(e.slot_due_at, tz),
        "action_code": e.action_code,
        "action_other": e.action_other,
        "fate_code": e.fate_code,
        "fate_other": e.fate_other,
        "action_note": e.action_note,
        "deviation_state": e.deviation_state,
        "followup_of_id": _sid(e.followup_of_id),
        "staff_name": e.staff_name,
        "name_source": e.name_source,
        "via": e.via,
        "client_typed_at": iso_z(e.client_typed_at),
        "client_typed_local": R.hhmm_local(e.client_typed_at, tz),
        "client_time_differs": bool(differs),
        "voided_at": iso_z(e.voided_at),
        "void_reason": e.void_reason,
        # A correction is corrected again, never undone.
        "undo_until": (None if (voided or is_correction)
                       else iso_z(e.recorded_at + R.UNDO_WINDOW)),
        # R1b
        "done": e.done,
        "source": e.source or "live",
        "paper_measured_at": iso_z(e.paper_measured_at),
        "paper_measured_local": paper_local,
        "paper_measured_local_date": paper_date,
        "reason_text": e.reason_text,
        "supersedes_id": _sid(e.supersedes_id),
        "correction_reason": e.correction_reason,
        "correction_text": e.correction_text,
        "created_at": iso_z(e.created_at),
        "created_local": created_local,
        "created_local_date": created_date,
        "photo": photo_out((photos or {}).get(str(e.id)), tz),
        "correctable_until": (None if voided
                              else iso_z(e.recorded_at + R.CORRECTION_MAX_AGE)),
    }


# ── Loading ──────────────────────────────────────────────────────────────

def _scope_filter(q, branch_scope):
    if branch_scope is None:
        return q
    return q.filter(or_(FoodCheck.branch_id.is_(None), FoodCheck.branch_id == branch_scope))


def _group_rank(check: FoodCheck) -> tuple:
    try:
        g = R.GROUP_ORDER.index(check.group_key)
    except ValueError:
        g = len(R.GROUP_ORDER)
    return (g, int(check.sort_order or 0), check.created_at or datetime.min)


def load_checks(db: Session, owner, *, branch_scope=None, live_only=True) -> list[FoodCheck]:
    q = db.query(FoodCheck).filter(FoodCheck.user_id == owner.id)
    if live_only:
        q = q.filter(FoodCheck.active.is_(True), FoodCheck.archived_at.is_(None))
    rows = _scope_filter(q, branch_scope).all()
    return sorted(rows, key=_group_rank)


def revs_by_check(db: Session, checks: list[FoodCheck]) -> dict[str, list[R.RevisionView]]:
    if not checks:
        return {}
    by_id = {str(c.id): c for c in checks}
    rows = (
        db.query(FoodCheckRevision)
        .filter(FoodCheckRevision.check_id.in_([c.id for c in checks]))
        .all()
    )
    out: dict[str, list[R.RevisionView]] = {k: [] for k in by_id}
    for r in rows:
        c = by_id.get(str(r.check_id))
        if c is not None:
            out[str(c.id)].append(rev_view(r, c))
    for k in out:
        out[k].sort(key=lambda v: (v.valid_from, ))
    return out


def _active_checks(db: Session, owner):
    return db.query(FoodCheck).filter(
        FoodCheck.user_id == owner.id,
        FoodCheck.active.is_(True),
        FoodCheck.archived_at.is_(None),
    )


def active_check_count(db: Session, owner) -> int:
    """Every active check, ticks included (diagnostics: "has any check")."""
    return int(_active_checks(db, owner).count())


def counts_toward_cap(kind: Optional[str]) -> bool:
    """A temperature check counts toward the plan's limit; a tick never does.
    Fails closed: any kind that is not "tick" (a future one too) counts."""
    return kind != TICK_KIND


def active_temperature_count(db: Session, owner) -> int:
    """What the plan's limit counts: active checks that are not ticks."""
    return int(_active_checks(db, owner).filter(FoodCheck.kind != TICK_KIND).count())


def active_tick_count(db: Session, owner) -> int:
    return int(_active_checks(db, owner).filter(FoodCheck.kind == TICK_KIND).count())


def _enforce_room(db: Session, owner, kinds: list) -> None:
    """Room for len(kinds) more ACTIVE checks of these kinds. Temperature
    checks → the plan's limit (402 cap_exceeded, the payload every cap uses;
    its count is the active temperature checks). Ticks → R.TICKS_MAX (409
    too_many_ticks, never a 402). Called only when a check is ADDED or
    switched back ON: after a downgrade every existing check keeps recording."""
    from app.services.billing import enforce_cap

    temps = sum(1 for k in kinds if counts_toward_cap(k))
    ticks = len(kinds) - temps
    if temps:
        enforce_cap(owner, CAP_KEY, active_temperature_count(db, owner) + temps - 1)
    if ticks and active_tick_count(db, owner) + ticks > R.TICKS_MAX:
        raise conflict("too_many_ticks", max=R.TICKS_MAX)


def resolve_branch(db: Session, owner, branch_id) -> Optional[Branch]:
    if branch_id is None:
        return None
    b = db.query(Branch).filter(Branch.id == branch_id, Branch.user_id == owner.id).first()
    if b is None:
        raise not_found()
    return b


def get_settings(db: Session, owner) -> Optional[FoodCheckSettings]:
    return db.query(FoodCheckSettings).filter(FoodCheckSettings.user_id == owner.id).first()


# ── Today ────────────────────────────────────────────────────────────────

def _slot_out(slot: Optional[R.Slot], tz: ZoneInfo) -> Optional[dict]:
    if slot is None:
        return None
    out = {
        "due_at": iso_z(slot.due_at),
        "due_local": R.hhmm_local(slot.due_at, tz),
        "late_after": iso_z(slot.late_after),
        "business_date": slot.business_date.isoformat(),
        "schedule_type": slot.schedule_type,
    }
    if slot.schedule_type == "weekly":
        out["weekday"] = slot.business_date.weekday()
    return out


def _open_dev_out(st: R.CheckStatus, tz: ZoneInfo) -> Optional[dict]:
    e = st.open_deviation
    if e is None:
        return None
    due = R.recheck_due_at(e, st.open_revision)
    reheat = e.fate_code == "reheated_75"
    return {
        "entry_id": str(e.id),
        "recorded_at": iso_z(e.recorded_at),
        "recorded_local": R.hhmm_local(e.recorded_at, tz),
        "value_c": _f(e.value_c),
        "fate_code": e.fate_code,
        "recheck_due_at": iso_z(due),
        "recheck_due_local": R.hhmm_local(due, tz),
        "needs_fate": not R.FATE_CLOSES.get(e.fate_code, True),
        "closes_at_or_above": float(R.REHEAT_CLOSE_AT_C) if reheat else None,
    }


def _entries_for_today(db: Session, owner, checks: list[FoodCheck], week_start: datetime):
    if not checks:
        return []
    return (
        db.query(FoodCheckEntry)
        .filter(
            FoodCheckEntry.user_id == owner.id,
            FoodCheckEntry.check_id.in_([c.id for c in checks]),
            or_(FoodCheckEntry.recorded_at >= week_start,
                FoodCheckEntry.deviation_state == "open"),
        )
        .all()
    )


def build_today(db: Session, owner, *, branch_scope=None, now: Optional[datetime] = None) -> dict:
    now = now or now_utc()
    tz, cutoff, tzname = zone_and_cutoff(db, owner)
    today = R.business_date_of(now, tz, cutoff)
    checks = load_checks(db, owner, branch_scope=branch_scope)
    revs = revs_by_check(db, checks)
    week_start = R.iso_week_bounds(today, tz, cutoff)[0]
    entries = _entries_for_today(db, owner, checks, week_start - timedelta(days=1))
    by_check: dict[str, list] = {}
    for e in entries:
        by_check.setdefault(str(e.check_id), []).append(e)
    photos = photos_for(db, owner, [e.id for e in entries])

    statuses = []
    out_checks = []
    for c in checks:
        cr = revs.get(str(c.id), [])
        st = R.status_today(c, cr, by_check.get(str(c.id), []), now, tz, cutoff)
        statuses.append(st)
        d = check_out(c, cr)
        d.update({
            "status": st.status,
            "slot": _slot_out(st.slot, tz),
            "slot_is_today": bool(st.slot_is_current),
            "last": entry_out(st.last, tz, photos) if st.last is not None else None,
            # The reading that filled the slot: "For sent · registreret kl.
            # 09:30 (frist kl. 08:00)" names THAT reading, not a later one.
            "slot_entry": (entry_out(st.slot_entry, tz, photos)
                           if st.slot_entry is not None else None),
            "open_deviation": _open_dev_out(st, tz),
        })
        out_checks.append(d)
    settings = get_settings(db, owner)
    return {
        "business_date": today.isoformat(),
        "server_now": iso_z(now),
        "timezone": tzname,
        "cutoff_hour": cutoff,
        "setup_done": bool(settings and settings.setup_done_at),
        "checks": out_checks,
        "summary": R.summary_today(statuses),
    }


def cap_out(db: Session, owner) -> dict:
    """{"limit": the plan's limit, "active": active TEMPERATURE checks} — the
    same numbers enforce_cap uses, so the UI counter and the 402 never
    disagree. Ticks are not in "active" (they never count)."""
    from app.services.billing import get_cap
    return {"limit": int(get_cap(owner, CAP_KEY)), "active": active_temperature_count(db, owner)}


def build_status(db: Session, owner, *, now: Optional[datetime] = None) -> dict:
    today = build_today(db, owner, now=now)
    has_records = (
        db.query(FoodCheckEntry.id).filter(FoodCheckEntry.user_id == owner.id).first()
        is not None
    )
    s = today["summary"]
    settings = get_settings(db, owner)
    opted = bool(settings is not None and settings.opted_in)
    btype = getattr(owner, "business_type", None)
    return {
        "relevant": relevant(btype, opted),
        "setup_done": today["setup_done"],
        "active_checks": len(today["checks"]),
        "missing_now": s["missing"],
        "due_soon": s["due"],
        "open_deviations": s["open_deviations"],
        "has_records": bool(has_records),
        "business_date": today["business_date"],
        "opted_in": opted,
        "opt_in_offered": opt_in_offered(btype, opted),
        "cap": cap_out(db, owner),
    }


def templates_out(db: Session, owner) -> dict:
    tz, cutoff, tzname = zone_and_cutoff(db, owner)
    items = []
    for key in R.TEMPLATE_KEYS:
        t = R.START_LIST[key]
        lim = None
        if t["limit"] is not None:
            lim = R.Limit(t["limit"]["limit_c"], t["limit"]["direction"],
                          t["limit"]["source"], t["limit"]["ref"]).as_dict()
        pls = None
        if t["product_limits"]:
            pls = []
            for pt in R.PRODUCT_TYPES:
                p = t["product_limits"][pt]
                d = R.Limit(p["limit_c"], "max", p["source"], p["ref"]).as_dict()
                d["product_type"] = pt
                pls.append(d)
        items.append({
            "key": key,
            "kind": t["kind"],
            "group_key": t["group_key"],
            "limit": lim,
            "product_limits": pls,
            "schedule_default": dict(t["schedule_default"]),
            "schedule_options": list(t["schedule_options"]),
            "action_codes": list(t["action_codes"]),
            "fate_codes": list(t["fate_codes"]),
            "recheck_min": t["recheck_min"],
        })
    return {"templates": items, "cutoff_hour": cutoff, "timezone": tzname}


# ── Staff names ("Hvem målte?") ──────────────────────────────────────────

def staff_choices(db: Session, owner, *, now: Optional[datetime] = None) -> dict:
    now = now or now_utc()
    tz, cutoff, _ = zone_and_cutoff(db, owner)
    today = R.business_date_of(now, tz, cutoff)
    staff = (
        db.query(StaffMember)
        .filter(
            StaffMember.user_id == owner.id,
            StaffMember.active.is_(True),
            StaffMember.is_deleted.is_(False),
        )
        .all()
    )
    on_shift = {
        str(r[0]) for r in (
            db.query(Schedule.staff_id)
            .filter(
                Schedule.user_id == owner.id,
                Schedule.date == today,
                Schedule.status == "published",
            )
            .all()
        )
    }
    items = [
        {
            "id": str(s.id),
            "name": R.first_name_last_initial(s.name),
            "on_shift": str(s.id) in on_shift,
        }
        for s in staff
    ]
    items = [i for i in items if i["name"]]
    items.sort(key=lambda i: (not i["on_shift"], i["name"].lower()))
    return {"staff": items}


# ── Saving a reading ─────────────────────────────────────────────────────

def _norm_client_id(raw: str) -> str:
    try:
        return str(uuid.UUID(str(raw).strip()))
    except (ValueError, AttributeError, TypeError):
        raise rule_http(R.RuleError("client_id_invalid"))


def _parse_client_time(v: Any) -> Optional[datetime]:
    if v is None or isinstance(v, bool):
        return None
    dt = None
    if isinstance(v, datetime):
        dt = v
    elif isinstance(v, str):
        s = v.strip()
        if s.endswith(("Z", "z")):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
        except ValueError:
            return None
    else:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    if not (2000 <= dt.year <= 2100):
        return None
    return dt


def _text_or_none(v: Optional[str]) -> Optional[str]:
    """Typed text is stored VERBATIM; only an empty or blank value is NULL."""
    if v is None or not isinstance(v, str) or not v.strip():
        return None
    return v


def _replay(existing: FoodCheckEntry, check_id, tz) -> tuple[dict, bool]:
    if str(existing.check_id) != str(check_id):
        raise conflict("client_id_reused")
    return entry_out(existing, tz), True


def _open_deviation(db: Session, owner, check_id) -> Optional[FoodCheckEntry]:
    return (
        db.query(FoodCheckEntry)
        .filter(
            FoodCheckEntry.user_id == owner.id,
            FoodCheckEntry.check_id == check_id,
            FoodCheckEntry.deviation_state == "open",
            FoodCheckEntry.voided_at.is_(None),
        )
        .order_by(FoodCheckEntry.recorded_at.desc())
        .first()
    )


def find_replay(db: Session, owner, client_id: str) -> Optional[FoodCheckEntry]:
    return (
        db.query(FoodCheckEntry)
        .filter(FoodCheckEntry.user_id == owner.id, FoodCheckEntry.client_id == client_id)
        .first()
    )


def resolve_name(db: Session, owner, body) -> tuple[Any, str, str]:
    """Who measured — exactly one of a picked staff member or a typed name.
    → (staff_id, staff_name snapshot, name_source)."""
    if body.staff_id is not None and body.typed_name:
        raise rule_http(R.RuleError("name_invalid"))
    if body.staff_id is not None:
        staff = (
            db.query(StaffMember)
            .filter(
                StaffMember.id == body.staff_id,
                StaffMember.user_id == owner.id,
                StaffMember.is_deleted.is_(False),
            )
            .first()
        )
        if staff is None:
            raise not_found()
        return staff.id, (R.first_name_last_initial(staff.name)[: R.STAFF_NAME_MAX] or "?"), "picked"
    if body.typed_name is not None and str(body.typed_name).strip():
        try:
            return None, R.clean_typed_name(body.typed_name), "typed"
        except R.RuleError as e:
            raise rule_http(e)
    raise rule_http(R.RuleError("name_required"))


def tick_fields(body) -> None:
    """A tick (cleaning, thermometer): no value, done must be true."""
    if body.value_c is not None:
        raise rule_http(R.RuleError("value_not_allowed"))
    if body.done is not True:
        raise rule_http(R.RuleError("done_required"))


def slot_for(db: Session, owner, check: FoodCheck, revs: list, at: datetime,
             tz: ZoneInfo, cutoff: int) -> Optional[R.Slot]:
    """The unfilled slot of `check` whose window contains `at` (the new
    reading's EFFECTIVE time) — existing readings matched on THEIR effective
    time, so a paper reading measured inside a window counts there."""
    bdate = R.business_date_of(at, tz, cutoff)
    monday = R.iso_week_monday(bdate)
    slots = [
        s for s in R.slots_between(revs, monday, monday + timedelta(days=6), tz, cutoff)
        if s.window_start <= at < s.window_end
    ]
    if not slots:
        return None
    earliest = min(s.window_start for s in slots)
    existing_entries = (
        db.query(FoodCheckEntry)
        .filter(
            FoodCheckEntry.user_id == owner.id,
            FoodCheckEntry.check_id == check.id,
            FoodCheckEntry.voided_at.is_(None),
            or_(FoodCheckEntry.recorded_at >= earliest,
                FoodCheckEntry.paper_measured_at >= earliest),
        )
        .all()
    )
    return R.slot_for_new_entry(slots, existing_entries, at)


def save_entry(db: Session, owner, body, *, via: str, kitchen_link=None,
               actor_user_id=None, branch_scope=None) -> tuple[dict, bool]:
    """Save one reading. Returns (EntryOut, replayed). Everything that matters
    is decided HERE, on the server clock: recorded_at, business day, the
    revision in force, the limit, in_limit, the slot, late and the deviation
    state. Unknown body fields never reach the row."""
    now = now_utc()
    tz, cutoff, _ = zone_and_cutoff(db, owner)
    client_id = _norm_client_id(body.client_id)

    existing = find_replay(db, owner, client_id)
    if existing is not None:
        return _replay(existing, body.check_id, tz)

    # R1b offline queue: a reading typed on an earlier business day is never
    # saved on today's (it would land on the wrong day). Replays above win.
    bdate = R.business_date_of(now, tz, cutoff)
    cbd = getattr(body, "client_business_date", None)
    if cbd is not None and cbd != bdate:
        raise conflict("business_day_changed", server_business_date=bdate.isoformat())

    check = (
        db.query(FoodCheck)
        .filter(FoodCheck.id == body.check_id, FoodCheck.user_id == owner.id)
        .first()
    )
    if check is None:
        raise not_found()
    if branch_scope is not None and check.branch_id is not None and str(check.branch_id) != str(branch_scope):
        raise not_found()
    if not check.active or check.archived_at is not None:
        raise conflict("check_inactive")

    revs = revs_by_check(db, [check]).get(str(check.id), [])
    rev = R.revision_at(revs, now)
    if rev is None or not rev.active:
        raise conflict("check_inactive")

    is_tick = check.kind == "tick"
    if is_tick:
        tick_fields(body)
    staff_id, staff_name, name_source = resolve_name(db, owner, body)

    open_e = None
    if is_tick:
        value, limit, ok = None, None, None
        decision = R.Decision(None, None, False, False, False)
    else:
        try:
            value = R.validate_value(body.value_c)
            product_type = body.product_type if check.kind == "receiving" else None
            limit = R.limit_for(rev, product_type)
            ok = R.in_limit(value, limit)
            open_e = _open_deviation(db, owner, check.id)
            decision = R.deviation_decision(
                in_limit=ok, value=value,
                open_dev=R.OpenDev(open_e.id, open_e.fate_code) if open_e is not None else None,
                action_code=body.action_code, action_other=body.action_other,
                fate_code=body.fate_code, fate_other=body.fate_other,
                allowed_actions=rev.action_codes, allowed_fates=rev.fate_codes,
            )
        except R.RuleError as e:
            raise rule_http(e)

    # The slot this reading fills — server-decided, immutable afterwards.
    # Ticks are on-event: no slot.
    slot = None if is_tick else slot_for(db, owner, check, revs, now, tz, cutoff)

    action_code = body.action_code if decision.store_action else None
    fate_code = body.fate_code if decision.store_fate else None
    is_receiving = check.kind == "receiving"
    product_type = body.product_type if is_receiving else None
    entry = FoodCheckEntry(
        id=uuid.uuid4(),
        user_id=owner.id,
        branch_id=check.branch_id,
        check_id=check.id,
        revision_id=rev.id,
        client_id=client_id,
        business_date=bdate,
        slot_due_at=slot.due_at if slot else None,
        recorded_at=now,
        client_typed_at=_parse_client_time(body.client_typed_at),
        value_c=value,
        done=True if is_tick else None,
        product_type=product_type,
        limit_c=limit.limit_c if limit is not None else None,
        limit_direction=limit.direction if limit is not None else None,
        in_limit=ok,
        late=R.is_late(now, slot.due_at) if slot else False,
        product_note=_text_or_none(body.product_note) if is_receiving else None,
        label_ok=body.label_ok if is_receiving else None,
        action_code=action_code,
        action_other=_text_or_none(body.action_other) if action_code == "other" else None,
        fate_code=fate_code,
        fate_other=_text_or_none(body.fate_other) if fate_code == "other" else None,
        # A tick's optional note lives here too (≤ 280, verbatim).
        action_note=(_text_or_none(body.action_note)
                     if (decision.store_action or decision.store_fate or is_tick) else None),
        deviation_state=decision.deviation_state,
        followup_of_id=decision.followup_of_id,
        source="live",
        staff_id=staff_id,
        staff_name=staff_name,
        name_source=name_source,
        via=via,
        kitchen_link_id=kitchen_link.id if kitchen_link is not None else None,
        actor_user_id=actor_user_id,
    )
    if decision.close_predecessor and open_e is not None:
        # The only UPDATE a save makes: the follow-up closes the open deviation.
        open_e.deviation_state = "closed"
    db.add(entry)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        again = (
            db.query(FoodCheckEntry)
            .filter(FoodCheckEntry.user_id == owner.id, FoodCheckEntry.client_id == client_id)
            .first()
        )
        if again is None:
            raise
        return _replay(again, body.check_id, tz)
    db.refresh(entry)
    return entry_out(entry, tz), False


def undo_entry(db: Session, owner, entry_id, *, kitchen_link=None, actor_user_id=None) -> dict:
    """Undo VOIDS (voided_at, void_reason='undo'); the row stays and prints
    under "Fortrudte indtastninger". Only within 120 s, only by the same
    device (kitchen) or the same person (owner app / shared device)."""
    now = now_utc()
    tz, _, _ = zone_and_cutoff(db, owner)
    e = (
        db.query(FoodCheckEntry)
        .filter(FoodCheckEntry.id == entry_id, FoodCheckEntry.user_id == owner.id)
        .first()
    )
    if e is None:
        raise not_found()
    if e.supersedes_id is not None and e.voided_at is None:
        # A correction is corrected again, never undone (its undo_until is null).
        raise conflict("undo_window_passed")
    if kitchen_link is not None:
        same = e.via == "kitchen" and str(e.kitchen_link_id) == str(kitchen_link.id)
    else:
        same = (
            e.via in ("owner_app", "shared")
            and actor_user_id is not None
            and str(e.actor_user_id) == str(actor_user_id)
        )
    verdict = R.undo_check(e, now, same_actor=same)
    if verdict == "already_voided":
        raise conflict("already_voided")
    if verdict == "not_yours":
        raise HTTPException(status_code=403, detail={"code": "undo_not_yours"})
    if verdict == "window_passed":
        raise conflict("undo_window_passed")
    e.voided_at = now
    e.void_reason = "undo"
    if e.followup_of_id is not None:
        pred = (
            db.query(FoodCheckEntry)
            .filter(FoodCheckEntry.id == e.followup_of_id, FoodCheckEntry.user_id == owner.id)
            .first()
        )
        # R1b: the deviation this reading closed may since have been
        # CORRECTED — then its live row is the end of the correction chain.
        members = [pred.id] if pred is not None else []
        hops = 0
        while (pred is not None and pred.voided_at is not None
               and pred.void_reason == "correction" and hops < 20):
            pred = (
                db.query(FoodCheckEntry)
                .filter(FoodCheckEntry.user_id == owner.id,
                        FoodCheckEntry.supersedes_id == pred.id)
                .first()
            )
            if pred is not None:
                members.append(pred.id)
            hops += 1
        if pred is not None and pred.voided_at is None and pred.deviation_state == "closed":
            others = (
                db.query(FoodCheckEntry.id)
                .filter(
                    FoodCheckEntry.user_id == owner.id,
                    FoodCheckEntry.followup_of_id.in_(members),
                    FoodCheckEntry.voided_at.is_(None),
                    FoodCheckEntry.id != e.id,
                )
                .first()
            )
            if others is None:
                pred.deviation_state = "open"
    db.commit()
    db.refresh(e)
    return entry_out(e, tz)


# ── Configuration (owner) ────────────────────────────────────────────────

def _limit_value(template_key: str, value, product_type=None) -> tuple[Decimal, str]:
    v = R.validate_value(value)
    return v, R.source_for_value(template_key, v, product_type)


def _product_limits(template_key: str, given, base: Optional[dict] = None) -> dict:
    """Receiving: {chilled|fish|frozen: {limit_c, source}} from the start
    values (or the current revision), with any given value replacing it."""
    tpl = R.template(template_key)
    out = {}
    for pt in R.PRODUCT_TYPES:
        cur = (base or {}).get(pt)
        if cur is None:
            d = tpl["product_limits"][pt]
            cur = {"limit_c": d["limit_c"], "source": d["source"]}
        out[pt] = {"limit_c": Decimal(str(cur["limit_c"])), "source": cur["source"]}
    if given is not None:
        vals = given.model_dump() if hasattr(given, "model_dump") else dict(given)
        for pt in R.PRODUCT_TYPES:
            if vals.get(pt) is not None:
                v, src = _limit_value(template_key, vals[pt], pt)
                out[pt] = {"limit_c": v, "source": src}
    return out


def _next_valid_from(revs: list[R.RevisionView], now: datetime) -> datetime:
    """Revisions are strictly ordered in time, even within one clock tick."""
    if revs and revs[-1].valid_from >= now:
        return revs[-1].valid_from + timedelta(microseconds=1)
    return now


def _rev_dict(rev: FoodCheckRevision) -> dict:
    return {
        "revision_id": _sid(rev.id),
        "name": rev.name,
        "note": rev.note,
        "active": bool(rev.active),
        "limit_c": _f(rev.limit_c),
        "limit_source": rev.limit_source,
        "product_limits": R.load_json(rev.product_limits, None),
        "schedule": R.load_json(rev.schedule, None),
        "recheck_min": rev.recheck_min,
    }


def _new_check(db: Session, owner, *, template_key, name, note, limit_c, product_limits,
               schedule, recheck_min, branch_id, sort_order, cutoff, actor_id, now) -> tuple:
    tpl = R.template(template_key)
    if not isinstance(name, str) or not name.strip():
        raise R.RuleError("name_required")
    sched = R.normalize_schedule(schedule, template_key, cutoff)
    lim, src, pls = None, None, None
    if tpl["kind"] == "receiving":
        pls = _product_limits(template_key, product_limits)
    elif tpl["kind"] == "tick":
        # A tick has no limit (R1b): a given limit is refused, never ignored.
        if limit_c is not None:
            raise R.RuleError("limit_not_allowed")
    elif limit_c is None:
        lim, src = tpl["limit"]["limit_c"], tpl["limit"]["source"]
    else:
        lim, src = _limit_value(template_key, limit_c)
    check = FoodCheck(
        id=uuid.uuid4(), user_id=owner.id, branch_id=branch_id,
        kind=tpl["kind"], template_key=template_key, group_key=tpl["group_key"],
        name=name, note=_text_or_none(note), sort_order=sort_order, active=True,
        created_at=now,
    )
    rev = FoodCheckRevision(
        id=uuid.uuid4(), user_id=owner.id, check_id=check.id, valid_from=now,
        name=check.name, note=check.note, active=True,
        limit_c=lim, limit_source=src, product_limits=R.dump_product_limits(pls),
        schedule=json.dumps(sched, sort_keys=True),
        action_codes=json.dumps(list(tpl["action_codes"])),
        fate_codes=json.dumps(list(tpl["fate_codes"])),
        recheck_min=int(recheck_min or tpl["recheck_min"]),
        created_by_user_id=actor_id, created_at=now,
    )
    db.add(check)
    db.flush()
    db.add(rev)
    db.flush()
    return check, rev


def setup(db: Session, owner, payload, *, actor_id) -> list[dict]:
    existing = (
        db.query(FoodCheck.id)
        .filter(FoodCheck.user_id == owner.id, FoodCheck.archived_at.is_(None))
        .first()
    )
    if existing is not None:
        raise conflict("already_set_up")
    branch = resolve_branch(db, owner, payload.branch_id)
    now = now_utc()
    _, cutoff, _ = zone_and_cutoff(db, owner)
    try:
        kinds = [R.template(item.template_key)["kind"] for item in payload.items]
    except R.RuleError as e:
        raise rule_http(e)
    _enforce_room(db, owner, kinds)
    made = []
    try:
        for i, item in enumerate(payload.items):
            made.append(_new_check(
                db, owner, template_key=item.template_key, name=item.name, note=item.note,
                limit_c=item.limit_c, product_limits=item.product_limits,
                schedule=item.schedule, recheck_min=None,
                branch_id=branch.id if branch else None, sort_order=i,
                cutoff=cutoff, actor_id=actor_id, now=now,
            ))
    except R.RuleError as e:
        db.rollback()
        raise rule_http(e)
    settings = get_settings(db, owner)
    if settings is None:
        settings = FoodCheckSettings(user_id=owner.id, created_at=now)
        db.add(settings)
    settings.setup_done_at = now
    settings.updated_at = now
    audit_service.record(
        db, owner, "egenkontrol.setup", "food_check", None,
        after={"count": len(made), "template_keys": [c.template_key for c, _ in made]},
        actor_id=actor_id,
    )
    db.commit()
    checks = [c for c, _ in made]
    revs = revs_by_check(db, checks)
    return [check_out(c, revs.get(str(c.id), [])) for c in checks]


def create_check(db: Session, owner, payload, *, actor_id) -> dict:
    branch = resolve_branch(db, owner, payload.branch_id)
    try:
        kind = R.template(payload.template_key)["kind"]
    except R.RuleError as e:
        raise rule_http(e)
    _enforce_room(db, owner, [kind])
    now = now_utc()
    _, cutoff, _ = zone_and_cutoff(db, owner)
    top = (
        db.query(FoodCheck.sort_order)
        .filter(FoodCheck.user_id == owner.id)
        .order_by(FoodCheck.sort_order.desc())
        .first()
    )
    sort_order = (int(top[0]) + 1) if top and top[0] is not None else 0
    try:
        check, rev = _new_check(
            db, owner, template_key=payload.template_key, name=payload.name, note=payload.note,
            limit_c=payload.limit_c, product_limits=payload.product_limits,
            schedule=payload.schedule, recheck_min=payload.recheck_min,
            branch_id=branch.id if branch else None, sort_order=sort_order,
            cutoff=cutoff, actor_id=actor_id, now=now,
        )
    except R.RuleError as e:
        db.rollback()
        raise rule_http(e)
    audit_service.record(db, owner, "egenkontrol.check_created", "food_check", check.id,
                         after=_rev_dict(rev), actor_id=actor_id)
    db.commit()
    return check_out(check, revs_by_check(db, [check]).get(str(check.id), []))


def _owned_check(db: Session, owner, check_id) -> FoodCheck:
    c = db.query(FoodCheck).filter(FoodCheck.id == check_id, FoodCheck.user_id == owner.id).first()
    if c is None:
        raise not_found()
    return c


def _latest_rev_row(db: Session, check: FoodCheck) -> Optional[FoodCheckRevision]:
    rows = db.query(FoodCheckRevision).filter(FoodCheckRevision.check_id == check.id).all()
    if not rows:
        return None
    return max(rows, key=lambda r: r.valid_from)


def _write_revision(db: Session, owner, check: FoodCheck, base: FoodCheckRevision, *,
                    now: datetime, actor_id, **changes) -> FoodCheckRevision:
    revs = revs_by_check(db, [check]).get(str(check.id), [])
    fields = {
        "name": base.name, "note": base.note, "active": base.active,
        "limit_c": base.limit_c, "limit_source": base.limit_source,
        "product_limits": base.product_limits, "schedule": base.schedule,
        "action_codes": base.action_codes, "fate_codes": base.fate_codes,
        "recheck_min": base.recheck_min,
    }
    fields.update(changes)
    rev = FoodCheckRevision(
        id=uuid.uuid4(), user_id=owner.id, check_id=check.id,
        valid_from=_next_valid_from(revs, now), created_by_user_id=actor_id,
        created_at=now, **fields,
    )
    db.add(rev)
    return rev


def patch_check(db: Session, owner, check_id, payload, *, actor_id) -> dict:
    check = _owned_check(db, owner, check_id)
    if check.archived_at is not None:
        raise conflict("archived")
    base = _latest_rev_row(db, check)
    if base is None:
        raise not_found()
    now = now_utc()
    _, cutoff, _ = zone_and_cutoff(db, owner)
    sent = payload.model_fields_set
    changes: dict = {}
    try:
        if "name" in sent and payload.name is not None:
            if not payload.name.strip():
                raise R.RuleError("name_required")
            if payload.name != base.name:
                changes["name"] = payload.name
        if "note" in sent:
            note = _text_or_none(payload.note)
            if note != base.note:
                changes["note"] = note
        if check.kind == "receiving":
            if "product_limits" in sent and payload.product_limits is not None:
                cur = R.load_json(base.product_limits, None)
                pls = R.dump_product_limits(_product_limits(check.template_key, payload.product_limits, cur))
                if pls != base.product_limits:
                    changes["product_limits"] = pls
        elif "limit_c" in sent and payload.limit_c is not None:
            if check.kind == "tick":
                raise R.RuleError("limit_not_allowed")
            v, src = _limit_value(check.template_key, payload.limit_c)
            old = None if base.limit_c is None else Decimal(str(base.limit_c))
            if old is None or v != old or src != base.limit_source:
                changes["limit_c"] = v
                changes["limit_source"] = src
        if "schedule" in sent and payload.schedule is not None:
            sched = json.dumps(R.normalize_schedule(payload.schedule, check.template_key, cutoff),
                               sort_keys=True)
            if R.load_json(sched, None) != R.load_json(base.schedule, None):
                changes["schedule"] = sched
        if "recheck_min" in sent and payload.recheck_min is not None:
            if int(payload.recheck_min) != int(base.recheck_min):
                changes["recheck_min"] = int(payload.recheck_min)
        if "active" in sent and payload.active is not None:
            if bool(payload.active) != bool(base.active):
                changes["active"] = bool(payload.active)
    except R.RuleError as e:
        raise rule_http(e)

    if changes.get("active") is True:
        _enforce_room(db, owner, [check.kind])
    if changes.get("active") is False:
        _refuse_with_open_deviation(db, owner, check)

    if changes:
        before = _rev_dict(base)
        rev = _write_revision(db, owner, check, base, now=now, actor_id=actor_id, **changes)
        check.name = rev.name
        check.note = rev.note
        check.active = bool(rev.active)
        check.updated_at = now
        db.flush()
        audit_service.record(db, owner, "egenkontrol.check_changed", "food_check", check.id,
                             before=before, after=_rev_dict(rev), actor_id=actor_id)
    if "sort_order" in sent and payload.sort_order is not None:
        check.sort_order = int(payload.sort_order)
        check.updated_at = now
    db.commit()
    return check_out(check, revs_by_check(db, [check]).get(str(check.id), []))


def _refuse_with_open_deviation(db: Session, owner, check: FoodCheck) -> None:
    """A switched-off or archived check takes no readings, so an open
    deviation on it could never be followed up or closed — while the
    Kontrolmappe kept printing it as "Ikke afsluttet" and the alarm went
    quiet. Finish it first: a new reading with what happened to the food."""
    if _open_deviation(db, owner, check.id) is not None:
        raise conflict("open_deviation")


def archive_check(db: Session, owner, check_id, *, actor_id) -> dict:
    check = _owned_check(db, owner, check_id)
    if check.archived_at is not None:
        raise conflict("already_archived")
    _refuse_with_open_deviation(db, owner, check)
    base = _latest_rev_row(db, check)
    now = now_utc()
    if base is not None:
        before = _rev_dict(base)
        rev = _write_revision(db, owner, check, base, now=now, actor_id=actor_id, active=False)
        db.flush()
        after = _rev_dict(rev)
    else:
        before, after = None, None
    check.active = False
    check.archived_at = now
    check.updated_at = now
    audit_service.record(db, owner, "egenkontrol.check_archived", "food_check", check.id,
                         before=before, after=after, actor_id=actor_id)
    db.commit()
    return check_out(check, revs_by_check(db, [check]).get(str(check.id), []))


def checks_list(db: Session, owner) -> dict:
    rows = load_checks(db, owner, live_only=False)
    revs = revs_by_check(db, rows)
    live = [check_out(c, revs.get(str(c.id), [])) for c in rows if c.archived_at is None]
    archived = [check_out(c, revs.get(str(c.id), [])) for c in rows if c.archived_at is not None]
    return {"checks": live, "archived": archived, "cap": cap_out(db, owner)}


# ── Kontrolmappe (folder) ────────────────────────────────────────────────

@dataclass
class FolderData:
    date_from: date
    date_to: date
    tz: ZoneInfo
    cutoff: int
    now: datetime
    venue_name: str
    branch_name: Optional[str]
    checks: list = field(default_factory=list)            # FoodCheck rows shown
    revs: dict = field(default_factory=dict)              # check id → [RevisionView]
    rev_by_id: dict = field(default_factory=dict)         # revision id → RevisionView
    entries: list = field(default_factory=list)           # all entries in the period (incl. voided)
    followups: dict = field(default_factory=dict)         # deviation id → [entries]
    slot_results: list = field(default_factory=list)
    days: dict = field(default_factory=dict)
    summary: dict = field(default_factory=dict)
    period_revs: dict = field(default_factory=dict)       # check id → [(RevisionView, until)]
    # R1b (filled by egenkontrol_records.folder_extras)
    max_days: int = R.FOLDER_MAX_DAYS
    branch_id: Any = None
    events: list = field(default_factory=list)            # [(head, chain, state)]
    photos: dict = field(default_factory=dict)            # entry id → FoodCheckPhoto
    documents: list = field(default_factory=list)         # FoodCheckDocument rows
    reviews: list = field(default_factory=list)           # FoodCheckReview rows
    repeat: list = field(default_factory=list)            # [(check_id, count)]
    findsmiley_url: Optional[str] = None
    today: Optional[date] = None


def validate_range(date_from: date, date_to: date, today: date,
                   max_days: int = R.FOLDER_MAX_DAYS) -> None:
    if date_from > date_to or date_to > today:
        raise R.RuleError("bad_range")
    if (date_to - date_from).days + 1 > max_days:
        raise R.RuleError("range_too_long", {"max_days": max_days})


def default_range(db: Session, owner, *, days: int = R.FOLDER_DEFAULT_DAYS) -> tuple[date, date]:
    tz, cutoff, _ = zone_and_cutoff(db, owner)
    today = R.business_date_of(now_utc(), tz, cutoff)
    return today - timedelta(days=days - 1), today


def entry_check_name(fd: FolderData, e) -> str:
    rv = fd.rev_by_id.get(str(e.revision_id))
    if rv is not None:
        return rv.name
    c = next((c for c in fd.checks if str(c.id) == str(e.check_id)), None)
    return c.name if c is not None else ""


def folder_data(db: Session, owner, date_from: date, date_to: date, branch_id=None, *,
                max_days: int = R.FOLDER_MAX_DAYS, extras: bool = True) -> FolderData:
    now = now_utc()
    tz, cutoff, _ = zone_and_cutoff(db, owner)
    today = R.business_date_of(now, tz, cutoff)
    validate_range(date_from, date_to, today, max_days)
    branch = resolve_branch(db, owner, branch_id)
    fd = FolderData(
        date_from=date_from, date_to=date_to, tz=tz, cutoff=cutoff, now=now,
        venue_name=(getattr(owner, "business_name", None) or "").strip() or (owner.email or ""),
        branch_name=branch.name if branch is not None else None,
        max_days=max_days, branch_id=branch.id if branch is not None else None, today=today,
    )
    all_checks = load_checks(db, owner, branch_scope=branch.id if branch else None, live_only=False)
    revs = revs_by_check(db, all_checks)
    p_start = R.business_day_bounds(date_from, tz, cutoff)[0]
    p_end = R.business_day_bounds(date_to, tz, cutoff)[1]

    ids = [c.id for c in all_checks]
    # A weekly slot's window is its whole ISO week, so a slot whose due day is
    # in the range can be filled by a reading from earlier (or later) that
    # week, outside the range. Load the whole ISO weeks at both ends to FILL
    # the slots; print and count only the readings inside the range.
    load_from = R.iso_week_monday(date_from)
    load_to = R.iso_week_monday(date_to) + timedelta(days=6)
    loaded = []
    if ids:
        loaded = (
            db.query(FoodCheckEntry)
            .filter(
                FoodCheckEntry.user_id == owner.id,
                FoodCheckEntry.check_id.in_(ids),
                FoodCheckEntry.business_date >= load_from,
                FoodCheckEntry.business_date <= load_to,
            )
            .order_by(FoodCheckEntry.recorded_at)
            .all()
        )
    entries = [e for e in loaded if date_from <= e.business_date <= date_to]
    # Follow-ups of every deviation EVENT — a corrected deviation's voided
    # original included (follow-ups point at the row they followed).
    events = R.deviation_events(entries)
    dev_ids = sorted({str(x.id) for head, chain, _ in events for x in (chain or [head])})
    for i in range(0, len(dev_ids), 500):
        for f in (
            db.query(FoodCheckEntry)
            .filter(FoodCheckEntry.user_id == owner.id,
                    FoodCheckEntry.followup_of_id.in_(dev_ids[i:i + 500]))
            .order_by(FoodCheckEntry.recorded_at)
            .all()
        ):
            fd.followups.setdefault(str(f.followup_of_id), []).append(f)
    fd.events = events

    by_check: dict[str, list] = {}
    for e in entries:
        by_check.setdefault(str(e.check_id), []).append(e)
    fill_by_check: dict[str, list] = {}
    for e in loaded:
        fill_by_check.setdefault(str(e.check_id), []).append(e)

    shown = []
    for c in all_checks:
        cr = revs.get(str(c.id), [])
        overlapping = []
        for i, rv in enumerate(cr):
            until = cr[i + 1].valid_from if i + 1 < len(cr) else None
            if rv.valid_from < p_end and (until is None or until > p_start):
                overlapping.append((rv, until))
        has_entries = bool(by_check.get(str(c.id)))
        if not has_entries and not any(rv.active for rv, _ in overlapping):
            continue
        shown.append(c)
        fd.period_revs[str(c.id)] = overlapping
        fd.slot_results.extend(
            R.assign(R.slots_between(cr, date_from, date_to, tz, cutoff),
                     fill_by_check.get(str(c.id), []), now)
        )
    fd.checks = shown
    fd.revs = revs
    fd.rev_by_id = {str(rv.id): rv for cr in revs.values() for rv in cr}
    fd.entries = entries
    fd.days = R.day_states(fd.slot_results, entries, date_from, date_to, tz, cutoff)
    fd.summary = R.folder_summary(fd.slot_results, entries)
    if extras:
        from app.services import egenkontrol_records
        egenkontrol_records.folder_extras(db, owner, fd, [c.id for c in all_checks])
    return fd


def _rev_out(rv: R.RevisionView) -> dict:
    return {
        "valid_from": iso_z(rv.valid_from),
        "name": rv.name,
        "active": rv.active,
        "limit": _limit_of(rv),
        "product_limits": R.product_limits_list(rv),
        "schedule": rv.schedule,
        "schedule_text_da": R.schedule_text_da(rv.schedule, rv.template_key),
    }


def build_folder(db: Session, owner, date_from: date, date_to: date, branch_id=None, *,
                 include_readings: bool = False, max_days: int = R.FOLDER_MAX_DAYS) -> dict:
    """The Kontrolmappe JSON (owner and kitchen share it). The sections live
    in egenkontrol_records.folder_json."""
    from app.services import egenkontrol_records
    try:
        fd = folder_data(db, owner, date_from, date_to, branch_id, max_days=max_days)
    except R.RuleError as e:
        raise rule_http(e)
    return egenkontrol_records.folder_json(fd, include_readings=include_readings)
