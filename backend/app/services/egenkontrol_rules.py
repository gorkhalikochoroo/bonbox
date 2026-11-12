"""
Egenkontrol rules — the ONE slot / status / deviation module (spec §4.6).

PURE: stdlib, Decimal and zoneinfo only. No database, no I/O, and it never
reads the clock — every function that needs "now" takes it. The owner app,
the kitchen screen, the NeedsYou detector and the PDF all ask this module, so
they can never disagree about whether a reading was late, a slot was missed or
a deviation is still open.

All datetimes in and out are NAIVE UTC (the database convention), unless a
name ends in _local. The venue zone and business-day cutoff are passed in by
the caller (egenkontrol_service.zone_and_cutoff), never a process-wide zone.
"""

import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Iterable, Optional
from zoneinfo import ZoneInfo

# ── Constants ────────────────────────────────────────────────────────────

LATE_GRACE = timedelta(minutes=60)
UNDO_WINDOW = timedelta(seconds=120)
VALUE_MIN_C = Decimal("-40.0")
VALUE_MAX_C = Decimal("120.0")
RECHECK_MIN_DEFAULT = 30
RECHECK_MIN_RANGE = (5, 240)
FOLDER_MAX_DAYS = 30          # R1a; R1b → 92
TYPED_NAME_MAX = 40
STAFF_NAME_MAX = 80
CHECK_NAME_MAX = 60
CHECK_NOTE_MAX = 80
OTHER_TEXT_MAX = 80
ACTION_NOTE_MAX = 280
PRODUCT_NOTE_MAX = 80
CLIENT_TIME_DIFF = timedelta(minutes=10)

KINDS = ("temp_max", "temp_min", "receiving")
TEMPLATE_KEYS = ("fridge", "freezer", "hot_holding", "reheating", "receiving")
PRODUCT_TYPES = ("chilled", "fish", "frozen")
LIMIT_SOURCES = ("law", "guide", "fvst_example", "owner")
SCHEDULE_TYPES = ("daily", "weekly", "on_event")
GROUP_ORDER = ("temperatures", "reheating", "receiving")

ACTION_CODES = (
    "thermostat_adjusted", "moved_goods", "supplier_contacted",
    "heat_increased", "reheated_further", "other",
)
# Does choosing this fate close the deviation at once?
FATE_CLOSES = {
    "discarded": True,
    "moved": True,
    "assessed_ok": True,
    "returned": True,
    "other": True,
    "reheated_75": False,       # closes on a later reading >= 75.0
    "awaiting_recheck": False,
}
REHEAT_CLOSE_AT_C = Decimal("75.0")

# The PDF prints Danish whatever language the cook used (codes are stored).
ACTION_LABEL_DA = {
    "thermostat_adjusted": "Justeret termostaten",
    "moved_goods": "Flyttet varerne til en anden køl",
    "supplier_contacted": "Leverandøren er kontaktet",
    "heat_increased": "Skruet op for varmen",
    "reheated_further": "Varmet videre",
    "other": "Andet",
}
FATE_LABEL_DA = {
    "discarded": "Kasseret",
    "moved": "Flyttet til anden køl",
    "assessed_ok": "Vurderet — kan bruges",
    "returned": "Afvist og sendt retur",
    "reheated_75": "Genopvarmet til 75 °C",
    "awaiting_recheck": "Afventer ny måling",
    "other": "Andet",
}
PRODUCT_LABEL_DA = {"chilled": "Kølevare", "fish": "Fisk", "frozen": "Frost"}
WEEKDAY_DA = ("mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag")
MONTH_DA = ("jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec")

REF_BILAG_3A = (
    "BEK nr. 1331 af 20/11/2025, bilag 3 A (bl.a. hakket kød, fjerkræ og "
    "varmebehandlede, letfordærvelige kølevarer)"
)
REF_HOT_HOLDING = "BEK nr. 1331 af 20/11/2025, § 29, stk. 3"
REF_REHEATING = "BEK nr. 1331 af 20/11/2025, § 26, stk. 3"

_FRIDGE_ACTIONS = ("thermostat_adjusted", "moved_goods", "other")
_FRIDGE_FATES = ("moved", "discarded", "assessed_ok", "awaiting_recheck", "other")

# Decision 2 values. The source is stored with every limit and always shown;
# "law" only where the exact Danish rule was verified (plan D1/D3).
START_LIST: dict[str, dict] = {
    "fridge": {
        "kind": "temp_max", "group_key": "temperatures",
        "limit": {"limit_c": Decimal("5.0"), "direction": "max", "source": "law", "ref": REF_BILAG_3A},
        "product_limits": None,
        "schedule_default": {"type": "daily", "due": "08:00"},
        "schedule_options": ("daily", "weekly", "on_event"),
        "action_codes": _FRIDGE_ACTIONS, "fate_codes": _FRIDGE_FATES,
        "recheck_min": 30,
    },
    "freezer": {
        "kind": "temp_max", "group_key": "temperatures",
        "limit": {"limit_c": Decimal("-18.0"), "direction": "max", "source": "fvst_example", "ref": None},
        "product_limits": None,
        "schedule_default": {"type": "daily", "due": "08:00"},
        "schedule_options": ("daily", "weekly", "on_event"),
        "action_codes": _FRIDGE_ACTIONS, "fate_codes": _FRIDGE_FATES,
        "recheck_min": 30,
    },
    "hot_holding": {
        "kind": "temp_min", "group_key": "temperatures",
        "limit": {"limit_c": Decimal("56.0"), "direction": "min", "source": "law", "ref": REF_HOT_HOLDING},
        "product_limits": None,
        "schedule_default": {"type": "daily", "due": "12:00"},
        "schedule_options": ("daily", "weekly", "on_event"),
        "action_codes": ("heat_increased", "other"),
        "fate_codes": ("discarded", "reheated_75", "awaiting_recheck", "other"),
        "recheck_min": 30,
    },
    "reheating": {
        "kind": "temp_min", "group_key": "reheating",
        "limit": {"limit_c": Decimal("75.0"), "direction": "min", "source": "law", "ref": REF_REHEATING},
        "product_limits": None,
        "schedule_default": {"type": "on_event"},
        "schedule_options": ("on_event",),
        "action_codes": ("reheated_further", "other"),
        "fate_codes": ("discarded", "awaiting_recheck", "assessed_ok", "other"),
        "recheck_min": 30,
    },
    "receiving": {
        "kind": "receiving", "group_key": "receiving",
        "limit": None,
        "product_limits": {
            "chilled": {"limit_c": Decimal("5.0"), "source": "law", "ref": REF_BILAG_3A},
            "fish": {"limit_c": Decimal("2.0"), "source": "fvst_example", "ref": None},
            "frozen": {"limit_c": Decimal("-18.0"), "source": "fvst_example", "ref": None},
        },
        "schedule_default": {"type": "on_event"},
        "schedule_options": ("on_event",),
        "action_codes": ("supplier_contacted", "other"),
        "fate_codes": ("returned", "discarded", "assessed_ok", "other"),
        "recheck_min": 30,
    },
}


class RuleError(ValueError):
    """A rule refused the input. Routers map it to 422 {"code": code, **detail}."""

    def __init__(self, code: str, detail: Optional[dict] = None):
        super().__init__(code)
        self.code = code
        self.detail = dict(detail or {})


# ── Small helpers ────────────────────────────────────────────────────────

def _sid(v) -> Optional[str]:
    return None if v is None else str(v)


def _voided(e) -> bool:
    return getattr(e, "voided_at", None) is not None


def is_deviation(e) -> bool:
    """An out-of-limit reading is a deviation, whatever its cached state says.
    The folder and the PDF pick deviations with THIS, so the one mutable
    column (deviation_state) can annotate a deviation but never hide one."""
    return getattr(e, "in_limit", None) is False or bool(getattr(e, "deviation_state", None))


def direction_for_kind(kind: str) -> str:
    return "min" if kind == "temp_min" else "max"


def template(template_key: str) -> dict:
    t = START_LIST.get(template_key)
    if t is None:
        raise RuleError("template_unknown")
    return t


# ── Time / business day ──────────────────────────────────────────────────

_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def parse_hhmm(s: Any) -> time:
    if not isinstance(s, str):
        raise RuleError("bad_time")
    m = _HHMM.match(s.strip())
    if not m:
        raise RuleError("bad_time")
    return time(int(m.group(1)), int(m.group(2)))


def validate_due(hhmm: str, cutoff_hour: int) -> str:
    t = parse_hhmm(hhmm)
    if t < time(int(cutoff_hour), 0):
        raise RuleError("due_before_day_start", {"cutoff_hour": int(cutoff_hour)})
    return t.strftime("%H:%M")


def normalize_schedule(schedule: Optional[dict], template_key: str, cutoff_hour: int) -> dict:
    tpl = template(template_key)
    if schedule is None:
        schedule = dict(tpl["schedule_default"])
    if not isinstance(schedule, dict):
        raise RuleError("schedule_not_allowed")
    typ = schedule.get("type")
    if typ not in tpl["schedule_options"]:
        raise RuleError("schedule_not_allowed")
    if typ == "on_event":
        return {"type": "on_event"}
    due = validate_due(schedule.get("due"), cutoff_hour)
    if typ == "daily":
        return {"type": "daily", "due": due}
    wd = schedule.get("weekday", 0)
    if isinstance(wd, bool) or not isinstance(wd, int) or not 0 <= wd <= 6:
        raise RuleError("schedule_not_allowed")
    return {"type": "weekly", "weekday": wd, "due": due}


def _local_roundtrips(naive_local: datetime, tz: ZoneInfo) -> Optional[datetime]:
    aware = naive_local.replace(tzinfo=tz, fold=0)
    utc = aware.astimezone(timezone.utc)
    if utc.astimezone(tz).replace(tzinfo=None) == naive_local:
        return utc.replace(tzinfo=None)
    return None


def wall_to_utc(d: date, hhmm, tz: ZoneInfo) -> datetime:
    """A wall-clock time in the venue zone → naive UTC.

    A NONEXISTENT time (the spring gap) moves to the first valid local minute
    after the gap; an AMBIGUOUS time (autumn) is the first occurrence (fold=0).
    """
    t = hhmm if isinstance(hhmm, time) else parse_hhmm(hhmm)
    naive = datetime.combine(d, t)
    hit = _local_roundtrips(naive, tz)
    if hit is not None:
        return hit
    probe = naive
    for _ in range(24 * 60):
        probe = probe + timedelta(minutes=1)
        hit = _local_roundtrips(probe, tz)
        if hit is not None:
            return hit
    raise RuleError("bad_time")  # pragma: no cover — no real zone has a 24 h gap


def to_local(dt_utc: datetime, tz: ZoneInfo) -> datetime:
    if dt_utc.tzinfo is None:
        dt_utc = dt_utc.replace(tzinfo=timezone.utc)
    return dt_utc.astimezone(tz)


def business_date_of(dt_utc: datetime, tz: ZoneInfo, cutoff_hour: int) -> date:
    local = to_local(dt_utc, tz)
    if local.hour < int(cutoff_hour):
        return local.date() - timedelta(days=1)
    return local.date()


def business_day_bounds(d: date, tz: ZoneInfo, cutoff_hour: int) -> tuple[datetime, datetime]:
    """[start, end) naive UTC, wall-clock anchored (23 h / 25 h on DST days)."""
    c = time(int(cutoff_hour), 0)
    return wall_to_utc(d, c, tz), wall_to_utc(d + timedelta(days=1), c, tz)


def iso_week_monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def iso_week_bounds(d: date, tz: ZoneInfo, cutoff_hour: int) -> tuple[datetime, datetime]:
    monday = iso_week_monday(d)
    return (
        business_day_bounds(monday, tz, cutoff_hour)[0],
        business_day_bounds(monday + timedelta(days=7), tz, cutoff_hour)[0],
    )


def hhmm_local(dt_utc: Optional[datetime], tz: ZoneInfo) -> Optional[str]:
    if dt_utc is None:
        return None
    return to_local(dt_utc, tz).strftime("%H:%M")


# ── Values / limits / names ──────────────────────────────────────────────

_TENTH = Decimal("0.1")


def validate_value(v: Any) -> Decimal:
    if v is None or isinstance(v, bool):
        raise RuleError("value_out_of_range")
    try:
        d = Decimal(str(v).strip())
    except (InvalidOperation, ValueError):
        raise RuleError("value_out_of_range")
    if not d.is_finite():
        raise RuleError("value_out_of_range")
    if d < VALUE_MIN_C or d > VALUE_MAX_C:
        raise RuleError("value_out_of_range")
    q = d.quantize(_TENTH, rounding=ROUND_HALF_UP)
    if q != d:
        raise RuleError("too_many_decimals")
    return q + Decimal("0.0")  # normalise -0.0 → 0.0


@dataclass
class Limit:
    limit_c: Decimal
    direction: str            # max | min
    source: str               # law | guide | fvst_example | owner
    ref: Optional[str] = None

    def as_dict(self) -> dict:
        return {
            "limit_c": float(self.limit_c),
            "direction": self.direction,
            "source": self.source,
            "ref": self.ref,
        }


def template_ref(template_key: str, source: Optional[str], product_type: Optional[str] = None) -> Optional[str]:
    """The legal reference is printed only for a value that is still the
    template's own law value — an owner's value is never "loven"."""
    if source != "law":
        return None
    tpl = START_LIST.get(template_key) or {}
    if product_type:
        pl = (tpl.get("product_limits") or {}).get(product_type) or {}
        return pl.get("ref")
    return (tpl.get("limit") or {}).get("ref")


def source_for_value(template_key: str, value: Decimal, product_type: Optional[str] = None) -> str:
    """Equal to the template default → the template's source; anything else
    (stricter or looser) → "owner" ("jeres egen grænse", never "loven")."""
    tpl = template(template_key)
    if product_type:
        default = (tpl.get("product_limits") or {}).get(product_type)
    else:
        default = tpl.get("limit")
    if default is not None and Decimal(str(value)) == default["limit_c"]:
        return default["source"]
    return "owner"


@dataclass
class RevisionView:
    id: Any
    check_id: Any
    valid_from: datetime
    active: bool
    schedule: dict
    limit_c: Optional[Decimal] = None
    limit_source: Optional[str] = None
    product_limits: Optional[dict] = None
    recheck_min: int = RECHECK_MIN_DEFAULT
    name: str = ""
    note: Optional[str] = None
    template_key: str = "fridge"
    kind: str = "temp_max"
    action_codes: tuple = ()
    fate_codes: tuple = ()


def limit_for(rev: RevisionView, product_type: Optional[str] = None) -> Limit:
    if rev.kind == "receiving":
        if not product_type:
            raise RuleError("product_type_required")
        if product_type not in PRODUCT_TYPES:
            raise RuleError("product_type_unknown")
        pl = (rev.product_limits or {}).get(product_type)
        if pl is None:
            pl = START_LIST["receiving"]["product_limits"][product_type]
        lim = Decimal(str(pl["limit_c"])).quantize(_TENTH)
        src = pl.get("source") or "owner"
        return Limit(lim, "max", src, template_ref(rev.template_key, src, product_type))
    if rev.limit_c is None:
        raise RuleError("limit_missing")
    src = rev.limit_source or "owner"
    return Limit(
        Decimal(str(rev.limit_c)).quantize(_TENTH),
        direction_for_kind(rev.kind), src, template_ref(rev.template_key, src),
    )


def product_limits_list(rev: RevisionView) -> Optional[list]:
    if rev.kind != "receiving":
        return None
    out = []
    for pt in PRODUCT_TYPES:
        lim = limit_for(rev, pt)
        d = lim.as_dict()
        d["product_type"] = pt
        out.append(d)
    return out


def in_limit(value: Decimal, limit: Limit) -> bool:
    """Boundaries are IN limit: −18.0 is in for max −18, 56.0 in for min 56."""
    v = Decimal(str(value))
    if limit.direction == "min":
        return v >= limit.limit_c
    return v <= limit.limit_c


def first_name_last_initial(full: Any) -> str:
    parts = str(full or "").split()
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0][:STAFF_NAME_MAX]
    return f"{parts[0]} {parts[-1][0]}."[:STAFF_NAME_MAX]


def clean_typed_name(s: Any) -> str:
    v = (s if isinstance(s, str) else "").strip()
    if not v or len(v) > TYPED_NAME_MAX:
        raise RuleError("name_invalid")
    return v


# ── Slots (history-safe) ─────────────────────────────────────────────────

@dataclass
class Slot:
    check_id: str
    revision_id: str
    schedule_type: str           # daily | weekly
    business_date: date          # daily: the day; weekly: the due day
    due_at: datetime
    late_after: datetime
    window_start: datetime
    window_end: datetime


@dataclass
class SlotResult:
    slot: Slot
    filled_by: Optional[Any] = None    # the entry object (or None)
    state: str = "open"                # on_time | late | missed | open


def _sorted_revs(revisions: Iterable[RevisionView]) -> list[RevisionView]:
    return sorted(revisions, key=lambda r: r.valid_from)


def revision_at(revisions: Iterable[RevisionView], instant: datetime) -> Optional[RevisionView]:
    """The revision in force at `instant` (newest valid_from <= instant)."""
    best = None
    for r in _sorted_revs(revisions):
        if r.valid_from <= instant:
            best = r
        else:
            break
    return best


def slots_between(revisions: Iterable[RevisionView], first_day: date, last_day: date,
                  tz: ZoneInfo, cutoff_hour: int) -> list[Slot]:
    """Every scheduled slot of ONE check between two business dates.

    A slot exists iff the revision whose rule produces it is the revision IN
    FORCE at the slot's due instant, and is active. So: a check created after
    today's due time has no slot today; a switched-off or archived revision
    yields none; changing daily→weekly or switching a fridge off never removes
    an older "Ikke registreret" (revisions are append-only); a mid-day due-time
    change keeps the earlier slot that was already in force. At most one daily
    slot per business day and one weekly slot per ISO week (the earliest).
    on_event revisions never yield slots, so they are never missed.
    """
    revs = _sorted_revs(revisions)
    if not revs or first_day > last_day:
        return []

    def in_force(i: int, instant: datetime) -> bool:
        nxt = revs[i + 1].valid_from if i + 1 < len(revs) else None
        return revs[i].valid_from <= instant and (nxt is None or instant < nxt)

    out: list[Slot] = []
    d = first_day
    while d <= last_day:
        cands = []
        for i, r in enumerate(revs):
            s = r.schedule or {}
            if not r.active or s.get("type") != "daily":
                continue
            due = wall_to_utc(d, s["due"], tz)
            if in_force(i, due):
                cands.append((due, r))
        if cands:
            due, r = min(cands, key=lambda c: c[0])
            ws, we = business_day_bounds(d, tz, cutoff_hour)
            out.append(Slot(_sid(r.check_id), _sid(r.id), "daily", d, due,
                            due + LATE_GRACE, ws, we))
        d += timedelta(days=1)

    monday = iso_week_monday(first_day)
    while monday <= last_day:
        cands = []
        for i, r in enumerate(revs):
            s = r.schedule or {}
            if not r.active or s.get("type") != "weekly":
                continue
            due_day = monday + timedelta(days=int(s.get("weekday", 0)))
            if not (first_day <= due_day <= last_day):
                continue
            due = wall_to_utc(due_day, s["due"], tz)
            if in_force(i, due):
                cands.append((due, due_day, r))
        if cands:
            due, due_day, r = min(cands, key=lambda c: c[0])
            ws, we = iso_week_bounds(monday, tz, cutoff_hour)
            out.append(Slot(_sid(r.check_id), _sid(r.id), "weekly", due_day, due,
                            due + LATE_GRACE, ws, we))
        monday += timedelta(days=7)

    out.sort(key=lambda s: (s.due_at, s.check_id))
    return out


def _fill(slots: list[Slot], entries: Iterable[Any]) -> dict[int, Any]:
    """Each non-voided entry fills the EARLIEST unfilled slot of its check
    whose window contains recorded_at. Returns {slot index: entry}."""
    order = sorted(range(len(slots)), key=lambda i: slots[i].due_at)
    filled: dict[int, Any] = {}
    for e in sorted((e for e in entries if not _voided(e)), key=lambda e: e.recorded_at):
        cid = _sid(e.check_id)
        for i in order:
            s = slots[i]
            if i in filled or s.check_id != cid:
                continue
            if s.window_start <= e.recorded_at < s.window_end:
                filled[i] = e
                break
    return filled


def is_late(recorded_at: datetime, slot_due_at: Optional[datetime]) -> bool:
    return slot_due_at is not None and recorded_at > slot_due_at + LATE_GRACE


def assign(slots: list[Slot], entries: Iterable[Any], now: datetime) -> list[SlotResult]:
    """on_time iff recorded_at <= due + 60 min (59:59 and exactly 60:00 are on
    time, 61 min is late); missed = the window ended unfilled; open = the
    window has not ended. Readings that fill nothing are off-slot readings —
    kept, printed, and a deviation if out of limit."""
    slots = list(slots)
    filled = _fill(slots, list(entries))
    out = []
    for i, s in enumerate(slots):
        e = filled.get(i)
        if e is not None:
            state = "late" if is_late(e.recorded_at, s.due_at) else "on_time"
        else:
            state = "missed" if now >= s.window_end else "open"
        out.append(SlotResult(s, e, state))
    return out


def slot_for_new_entry(slots: list[Slot], existing_entries: Iterable[Any],
                       recorded_at: datetime) -> Optional[Slot]:
    """The slot a reading saved at `recorded_at` fills (same rule as assign)."""
    slots = list(slots)
    filled = _fill(slots, list(existing_entries))
    for i in sorted(range(len(slots)), key=lambda i: slots[i].due_at):
        s = slots[i]
        if i in filled:
            continue
        if s.window_start <= recorded_at < s.window_end:
            return s
    return None


# ── Deviations (spec §4.6, guide 10.2) ───────────────────────────────────

@dataclass
class OpenDev:
    id: Any
    fate_code: Optional[str]


@dataclass
class Decision:
    deviation_state: Optional[str]
    followup_of_id: Optional[Any]
    close_predecessor: bool
    store_action: bool
    store_fate: bool


def _text(v) -> str:
    return v.strip() if isinstance(v, str) else ""


def _check_action(action_code, action_other, allowed_actions) -> bool:
    """True if an action is given and valid; False if missing. Raises for an
    unknown code or an 'other' without text."""
    if not action_code:
        return False
    if action_code not in allowed_actions:
        raise RuleError("action_unknown")
    if action_code == "other" and not _text(action_other):
        raise RuleError("other_text_required", {"field": "action"})
    return True


def _check_fate(fate_code, fate_other, allowed_fates) -> bool:
    if not fate_code:
        return False
    if fate_code not in allowed_fates:
        raise RuleError("fate_unknown")
    if fate_code == "other" and not _text(fate_other):
        raise RuleError("other_text_required", {"field": "fate"})
    return True


def deviation_decision(*, in_limit: bool, value: Decimal, open_dev: Optional[OpenDev],
                       action_code: Optional[str], action_other: Optional[str],
                       fate_code: Optional[str], fate_other: Optional[str],
                       allowed_actions, allowed_fates) -> Decision:
    allowed_actions = tuple(allowed_actions or ())
    allowed_fates = tuple(allowed_fates or ())
    followup_of = open_dev.id if open_dev is not None else None

    if not in_limit:
        missing = []
        has_action = _check_action(action_code, action_other, allowed_actions)
        has_fate = _check_fate(fate_code, fate_other, allowed_fates)
        if not has_action:
            missing.append("action")
        if not has_fate:
            missing.append("fate")
        if missing:
            raise RuleError("deviation_fields_required", {"missing": missing})
        state = "closed" if FATE_CLOSES.get(fate_code, True) else "open"
        return Decision(state, followup_of, open_dev is not None, True, True)

    if open_dev is None:
        # In limit, nothing open: action/fate fields are ignored (stored NULL).
        return Decision(None, None, False, False, False)

    # In limit, a deviation is open on this check: this reading follows it up.
    prev_fate = open_dev.fate_code
    if prev_fate == "reheated_75" and Decimal(str(value)) >= REHEAT_CLOSE_AT_C:
        return Decision(None, followup_of, True, False, False)
    if not FATE_CLOSES.get(prev_fate, True):
        closing = tuple(f for f in allowed_fates if FATE_CLOSES.get(f, False))
        if not fate_code or fate_code not in closing:
            if fate_code and fate_code not in allowed_fates:
                raise RuleError("fate_unknown")
            raise RuleError("followup_fate_required")
        _check_fate(fate_code, fate_other, closing)
        return Decision(None, followup_of, True, False, True)
    return Decision(None, followup_of, True, False, False)


def recheck_due_at(open_entry: Any, revision: Optional[RevisionView]) -> datetime:
    minutes = revision.recheck_min if revision is not None else RECHECK_MIN_DEFAULT
    return open_entry.recorded_at + timedelta(minutes=int(minutes or RECHECK_MIN_DEFAULT))


def undo_check(entry: Any, now: datetime, *, same_actor: bool) -> str:
    if _voided(entry):
        return "already_voided"
    if not same_actor:
        return "not_yours"
    if now > entry.recorded_at + UNDO_WINDOW:
        return "window_passed"
    return "ok"


# ── Status (one function, unit-tested per state) ─────────────────────────

@dataclass
class CheckStatus:
    status: str                         # later|due|overdue|done|done_late|deviation_open|deviation_closed|on_event
    slot: Optional[Slot] = None
    slot_state: Optional[str] = None    # later|due|overdue|done|done_late (current period)
    slot_is_current: bool = False       # the slot belongs to this business day / ISO week
    last: Optional[Any] = None          # newest non-voided reading of the business day
    open_deviation: Optional[Any] = None
    open_revision: Optional[RevisionView] = None
    slot_entry: Optional[Any] = None    # the reading that FILLED the current slot (done / done_late)


def _bdate(e, tz, cutoff_hour) -> date:
    bd = getattr(e, "business_date", None)
    if isinstance(bd, date):
        return bd
    return business_date_of(e.recorded_at, tz, cutoff_hour)


def status_today(check: Any, revisions: list[RevisionView], entries: list[Any],
                 now: datetime, tz: ZoneInfo, cutoff_hour: int) -> CheckStatus:
    """Precedence: deviation_open (any day) > the current unfilled slot
    (later / due / overdue) > deviation_closed today (D13: never hidden by a
    later good reading) > done_late > done. No slot this period: on_event (or
    "later" with the next slot for a scheduled check created after its due)."""
    today = business_date_of(now, tz, cutoff_hour)
    live = [e for e in entries if not _voided(e)]
    opens = [e for e in live if getattr(e, "deviation_state", None) == "open"]
    open_dev = max(opens, key=lambda e: e.recorded_at) if opens else None
    open_rev = None
    if open_dev is not None:
        rid = _sid(getattr(open_dev, "revision_id", None))
        open_rev = next((r for r in revisions if _sid(r.id) == rid), None)
    today_live = [e for e in live if _bdate(e, tz, cutoff_hour) == today]
    last = max(today_live, key=lambda e: e.recorded_at) if today_live else None
    closed_today = any(getattr(e, "deviation_state", None) == "closed" for e in today_live)

    monday = iso_week_monday(today)
    week = slots_between(revisions, monday, monday + timedelta(days=6), tz, cutoff_hour)
    current = [s for s in week if s.window_start <= now < s.window_end]
    results = assign(current, live, now)

    slot = None
    slot_state = None
    slot_entry = None
    is_current = False
    unfilled = sorted((r for r in results if r.filled_by is None), key=lambda r: r.slot.due_at)
    if unfilled:
        s = unfilled[0].slot
        slot, is_current = s, True
        if now < s.due_at - LATE_GRACE:
            slot_state = "later"
        elif now <= s.due_at + LATE_GRACE:
            slot_state = "due"
        else:
            slot_state = "overdue"
    elif results:
        r = max(results, key=lambda r: r.slot.due_at)
        slot, is_current = r.slot, True
        slot_state = "done_late" if r.state == "late" else "done"
        slot_entry = r.filled_by

    upcoming = None
    if slot is None:
        cur = revision_at(revisions, now)
        if cur is not None and cur.active and (cur.schedule or {}).get("type") in ("daily", "weekly"):
            nxt = slots_between(revisions, today + timedelta(days=1), today + timedelta(days=8),
                                tz, cutoff_hour)
            upcoming = next((s for s in nxt if s.due_at > now), None)

    if open_dev is not None:
        status = "deviation_open"
    elif slot_state in ("later", "due", "overdue"):
        status = slot_state
    elif closed_today:
        status = "deviation_closed"
    elif slot_state in ("done_late", "done"):
        status = slot_state
    elif upcoming is not None:
        status = "done" if last is not None else "later"
        slot = upcoming
    else:
        status = "on_event"
    return CheckStatus(status, slot, slot_state, is_current, last, open_dev, open_rev, slot_entry)


def summary_today(statuses: Iterable[CheckStatus]) -> dict:
    """Counts for the header. total counts only slotted checks with a slot this
    business day / ISO week. Callers never render "all done" over total 0."""
    total = done = missing = due = open_devs = 0
    for st in statuses:
        if st.slot_is_current and st.slot_state:
            total += 1
            if st.slot_state in ("done", "done_late"):
                done += 1
            elif st.slot_state == "overdue":
                missing += 1
            elif st.slot_state == "due":
                due += 1
        if st.open_deviation is not None:
            open_devs += 1
    return {"total": total, "done": done, "missing": missing, "due": due,
            "open_deviations": open_devs}


def day_states(slot_results: list[SlotResult], entries: Iterable[Any],
               first_day: date, last_day: date, tz: ZoneInfo, cutoff_hour: int) -> dict:
    """{date: deviation|missed|late|ok|none}, worst-of. A deviation is never
    hidden by a good re-check the same day (D13)."""
    out = {}
    live = [e for e in entries if not _voided(e)]
    d = first_day
    while d <= last_day:
        day_entries = [e for e in live if _bdate(e, tz, cutoff_hour) == d]
        day_slots = [r for r in slot_results if r.slot.business_date == d]
        if any(is_deviation(e) for e in day_entries):
            st = "deviation"
        elif any(r.state == "missed" for r in day_slots):
            st = "missed"
        elif any(r.state == "late" for r in day_slots):
            st = "late"
        elif day_entries or any(r.state == "on_time" for r in day_slots):
            st = "ok"
        else:
            st = "none"
        out[d] = st
        d += timedelta(days=1)
    return out


def folder_summary(slot_results: list[SlotResult], entries: Iterable[Any]) -> dict:
    entries = list(entries)
    live = [e for e in entries if not _voided(e)]
    devs = [e for e in live if is_deviation(e)]
    return {
        "readings": len(live),
        "slots_on_time": sum(1 for r in slot_results if r.state == "on_time"),
        "slots_late": sum(1 for r in slot_results if r.state == "late"),
        "slots_missed": sum(1 for r in slot_results if r.state == "missed"),
        "deviations": len(devs),
        "deviations_open": sum(1 for e in devs if e.deviation_state != "closed"),
        # EVERY voided reading counts and prints, whatever its reason.
        "undone": sum(1 for e in entries if _voided(e)),
        "paper": 0,
        "corrections": 0,
    }


# ── Danish text helpers (PDF + folder payload) ───────────────────────────

MINUS = "−"


def format_temp_da(v: Any) -> str:
    if v is None:
        return "–"
    d = Decimal(str(v)).quantize(_TENTH, rounding=ROUND_HALF_UP)
    sign = MINUS if d < 0 else ""
    return f"{sign}{abs(d):.1f}".replace(".", ",") + " °C"


def format_date_da(d: date) -> str:
    return f"{d.day}. {MONTH_DA[d.month - 1]} {d.year}"


def schedule_text_da(schedule: Optional[dict], template_key: str) -> str:
    s = schedule or {}
    typ = s.get("type")
    if typ == "daily":
        return f"Skrives ned hver dag kl. {s.get('due')}"
    if typ == "weekly":
        wd = WEEKDAY_DA[int(s.get("weekday", 0)) % 7]
        return f"Skrives ned 1 gang om ugen, {wd} kl. {s.get('due')}"
    if template_key == "receiving":
        return "Ved hver levering"
    if template_key == "reheating":
        return "Hver gang der genopvarmes"
    return "Når det sker"


def limit_text_da(limit: Optional[Limit]) -> str:
    if limit is None:
        return "–"
    t = format_temp_da(limit.limit_c)
    if limit.direction == "min":
        return f"Mindst {t}"
    if limit.limit_c <= 0:
        return f"{t} eller koldere"
    return f"Højst {t}"


def source_text_da(source: Optional[str], ref: Optional[str]) -> str:
    if source == "law":
        return f"Grænse fra loven: {ref}" if ref else "Grænse fra loven"
    if source == "guide":
        return "Fra Fødevarestyrelsens hygiejnevejledning"
    if source == "fvst_example":
        return "Startværdi fra Fødevarestyrelsens eksempel på egenkontrol"
    return "Grænse sat af virksomheden"


def late_text_da(recorded_local: str, due_local: str) -> str:
    return f"For sent · registreret kl. {recorded_local} (frist kl. {due_local})"


def name_note_da(name_source: Optional[str], via: Optional[str]) -> str:
    if name_source == "typed":
        return "(skrevet ind)"
    if via == "kitchen":
        return "(valgt på køkken-iPad)"
    if via == "shared":
        return "(valgt på delt enhed)"
    return "(valgt i ejerens app)"


# ── JSON helpers for revision columns ────────────────────────────────────

def load_json(raw: Optional[str], default):
    if raw is None or raw == "":
        return default
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return default


def dump_product_limits(pl: Optional[dict]) -> Optional[str]:
    if pl is None:
        return None
    out = {}
    for pt in PRODUCT_TYPES:
        if pt in pl:
            v = pl[pt]
            out[pt] = {"limit_c": float(Decimal(str(v["limit_c"]))), "source": v["source"]}
    return json.dumps(out, sort_keys=True)
