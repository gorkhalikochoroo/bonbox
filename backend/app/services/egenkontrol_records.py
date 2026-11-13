"""
Egenkontrol R1b — records written AFTER the fact, and the folder's sections.

  • "Fra papir" (save_paper_entry): the OWNER types in a reading that was
    written on paper, at most 14 days after it was measured. recorded_at is
    the server's receive time (when it was typed in), paper_measured_at the
    measured time; the slot, late and the business day follow the MEASURED
    time. Both times are always shown. A paper reading out of limit must
    carry a CLOSING fate and never takes part in the follow-up chain: it
    never opens, closes or reopens another reading.
  • Corrections (correct_entry): a NEW row replaces the reading
    (supersedes_id) and the old one is voided with void_reason
    'correction'. The official time never changes (recorded_at, business day
    and slot are copied), and a deviation is never removed: the folder and
    the PDF list it as ONE event with its correction chain and reason.
  • The folder JSON (folder_json) and the extras both the JSON and the PDF
    read (folder_extras): photos, documents, weekly reviews, repeat hints,
    the findsmiley.dk link.

Everything typed is stored VERBATIM (only empty / blank → NULL; too long →
422, never truncated). Server clock only: egenkontrol_service.now_utc.
"""

import uuid
from datetime import timedelta
from decimal import Decimal
from typing import Optional

from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.food_check import FoodCheck, FoodCheckEntry
from app.services import audit_service
from app.services import egenkontrol_rules as R
from app.services import egenkontrol_service as S

_DEV_STATES = ("open", "closed")


def _err(code: str, **detail):
    return S.rule_http(R.RuleError(code, detail or None))


def _blank_to_none(v) -> Optional[str]:
    if v is None or not isinstance(v, str) or not v.strip():
        return None
    return v


def _owned_check(db: Session, owner, check_id) -> FoodCheck:
    c = db.query(FoodCheck).filter(FoodCheck.id == check_id, FoodCheck.user_id == owner.id).first()
    if c is None:
        raise S.not_found()
    return c


# ── "Fra papir" ──────────────────────────────────────────────────────────

def save_paper_entry(db: Session, owner, body, *, via: str, actor_user_id) -> tuple[dict, bool]:
    """→ (EntryOut, replayed). Owner only (the router checks the role)."""
    now = S.now_utc()
    tz, cutoff, _ = S.zone_and_cutoff(db, owner)
    client_id = S._norm_client_id(body.client_id)
    existing = S.find_replay(db, owner, client_id)
    if existing is not None:
        return S._replay(existing, body.check_id, tz)

    reason = body.paper_reason
    if not isinstance(reason, str) or not reason.strip():
        raise _err("paper_reason_required")
    if len(reason) > R.REASON_TEXT_MAX:
        raise _err("paper_reason_too_long", max_length=R.REASON_TEXT_MAX)
    try:
        measured_at = R.wall_to_utc(body.measured_date, body.measured_time, tz)
    except R.RuleError as e:
        raise S.rule_http(e)
    if measured_at > now:
        raise _err("paper_in_future")
    if now - measured_at > R.PAPER_MAX_AGE:
        raise _err("paper_too_old", max_days=R.PAPER_MAX_AGE.days)

    check = _owned_check(db, owner, body.check_id)
    if not check.active or check.archived_at is not None:
        raise S.conflict("check_inactive")
    revs = S.revs_by_check(db, [check]).get(str(check.id), [])
    rev_now = R.revision_at(revs, now)
    if rev_now is None or not rev_now.active:
        raise S.conflict("check_inactive")
    rev = R.revision_at(revs, measured_at)
    if rev is None or not rev.active:
        raise S.conflict("check_inactive", at="measured")

    is_tick = check.kind == "tick"
    if is_tick:
        S.tick_fields(body)
    staff_id, staff_name, name_source = S.resolve_name(db, owner, body)

    value = limit = ok = None
    dev_state = None
    action_code = fate_code = None
    is_receiving = check.kind == "receiving"
    product_type = body.product_type if is_receiving else None
    if not is_tick:
        try:
            value = R.validate_value(body.value_c)
            limit = R.limit_for(rev, product_type)
            ok = R.in_limit(value, limit)
            if not ok:
                missing = []
                if not R._check_action(body.action_code, body.action_other, rev.action_codes):
                    missing.append("action")
                if not R._check_fate(body.fate_code, body.fate_other, rev.fate_codes):
                    missing.append("fate")
                if missing:
                    raise R.RuleError("deviation_fields_required", {"missing": missing})
                # No "Afventer ny måling" on paper: nobody can follow it up.
                if not R.FATE_CLOSES.get(body.fate_code, False):
                    raise R.RuleError("paper_fate_must_close")
                dev_state = "closed"
                action_code, fate_code = body.action_code, body.fate_code
        except R.RuleError as e:
            raise S.rule_http(e)

    slot = None if is_tick else S.slot_for(db, owner, check, revs, measured_at, tz, cutoff)
    entry = FoodCheckEntry(
        id=uuid.uuid4(),
        user_id=owner.id,
        branch_id=check.branch_id,
        check_id=check.id,
        revision_id=rev.id,
        client_id=client_id,
        business_date=R.business_date_of(measured_at, tz, cutoff),
        slot_due_at=slot.due_at if slot else None,
        recorded_at=now,                      # when it was TYPED IN
        client_typed_at=None,
        value_c=value,
        done=True if is_tick else None,
        product_type=product_type,
        limit_c=limit.limit_c if limit is not None else None,
        limit_direction=limit.direction if limit is not None else None,
        in_limit=ok,
        late=R.is_late(measured_at, slot.due_at) if slot else False,
        product_note=S._text_or_none(body.product_note) if is_receiving else None,
        label_ok=body.label_ok if is_receiving else None,
        action_code=action_code,
        action_other=S._text_or_none(body.action_other) if action_code == "other" else None,
        fate_code=fate_code,
        fate_other=S._text_or_none(body.fate_other) if fate_code == "other" else None,
        action_note=S._text_or_none(body.action_note) if (dev_state or is_tick) else None,
        deviation_state=dev_state,
        followup_of_id=None,
        source="paper",
        paper_measured_at=measured_at,
        reason_text=reason,                   # verbatim
        staff_id=staff_id,
        staff_name=staff_name,
        name_source=name_source,
        via=via,
        kitchen_link_id=None,
        actor_user_id=actor_user_id,
    )
    db.add(entry)
    db.flush()
    audit_service.record(
        db, owner, "egenkontrol.paper_entry", "food_check_entry", entry.id,
        after={
            "check_id": str(check.id),
            "measured_at": S.iso_z(measured_at),
            **({"done": True} if is_tick else {"value_c": float(value)}),
            "in_limit": ok,
        },
        actor_id=actor_user_id,
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        again = S.find_replay(db, owner, client_id)
        if again is None:
            raise
        return S._replay(again, body.check_id, tz)
    db.refresh(entry)
    return S.entry_out(entry, tz), False


# ── Corrections ──────────────────────────────────────────────────────────

def _pair_out(db: Session, owner, new: FoodCheckEntry, old: Optional[FoodCheckEntry], tz) -> dict:
    ids = [new.id] + ([old.id] if old is not None else [])
    photos = S.photos_for(db, owner, ids)
    return {
        "entry": S.entry_out(new, tz, photos),
        "corrected": S.entry_out(old, tz, photos) if old is not None else None,
    }


def correct_entry(db: Session, owner, body, *, actor_user_id) -> tuple[dict, bool]:
    """→ ({"entry": EntryOut(new), "corrected": EntryOut(old)}, replayed).
    ONE commit: the new row + the void of the old one. No other row
    changes (no follow-up is closed or reopened)."""
    now = S.now_utc()
    tz, cutoff, _ = S.zone_and_cutoff(db, owner)
    client_id = S._norm_client_id(body.client_id)

    existing = S.find_replay(db, owner, client_id)
    if existing is not None:
        if existing.supersedes_id is not None and str(existing.supersedes_id) == str(body.entry_id):
            old = (
                db.query(FoodCheckEntry)
                .filter(FoodCheckEntry.id == existing.supersedes_id,
                        FoodCheckEntry.user_id == owner.id)
                .first()
            )
            return _pair_out(db, owner, existing, old, tz), True
        raise S.conflict("client_id_reused")

    old = (
        db.query(FoodCheckEntry)
        .filter(FoodCheckEntry.id == body.entry_id, FoodCheckEntry.user_id == owner.id)
        .first()
    )
    if old is None:
        raise S.not_found()
    if old.voided_at is not None:
        raise S.conflict("already_voided")
    if now - old.recorded_at > R.CORRECTION_MAX_AGE:
        raise _err("correction_too_old", max_days=R.CORRECTION_MAX_AGE.days)

    code = body.reason_code
    if code not in R.CORRECTION_REASONS:
        raise _err("reason_unknown")
    reason_text = _blank_to_none(body.reason_text)
    if code == "other" and reason_text is None:
        raise _err("other_text_required", field="reason")
    if reason_text is not None and len(reason_text) > R.REASON_TEXT_MAX:
        raise _err("reason_too_long", max_length=R.REASON_TEXT_MAX)

    old_check = db.query(FoodCheck).filter(FoodCheck.id == old.check_id).first()
    target_id = body.check_id or old.check_id
    check_changed = str(target_id) != str(old.check_id)
    if check_changed and code != "wrong_check":
        raise _err("check_change_needs_reason")
    target = _owned_check(db, owner, target_id)
    old_kind = old_check.kind if old_check is not None else None
    if (target.kind == "tick") != (old_kind == "tick"):
        raise _err("kind_mismatch")
    if target.archived_at is not None:
        raise S.conflict("check_inactive")
    at = R.effective_at(old)
    revs = S.revs_by_check(db, [target]).get(str(target.id), [])
    rev = R.revision_at(revs, at)
    if rev is None or not rev.active:
        raise S.conflict("check_inactive")

    is_tick = target.kind == "tick"
    is_receiving = target.kind == "receiving"
    value = limit = ok = None
    dev_state = None
    action_code = action_other = fate_code = fate_other = action_note = None
    product_type = None
    try:
        if is_tick:
            if body.value_c is not None:
                raise R.RuleError("value_not_allowed")
            if not check_changed:
                raise R.RuleError("correction_no_change")
            action_note = (S._text_or_none(body.action_note)
                           if body.action_note is not None else old.action_note)
        else:
            value = (R.validate_value(body.value_c) if body.value_c is not None
                     else (Decimal(str(old.value_c)) if old.value_c is not None else None))
            if value is None:
                raise R.RuleError("value_out_of_range")
            if is_receiving:
                product_type = body.product_type or old.product_type
            value_changed = old.value_c is None or Decimal(str(old.value_c)) != value
            product_changed = is_receiving and product_type != old.product_type
            if not (value_changed or check_changed or product_changed):
                raise R.RuleError("correction_no_change")
            limit = R.limit_for(rev, product_type)
            ok = R.in_limit(value, limit)
            if not ok:
                same = not check_changed
                if body.action_code:
                    action_code, action_other = body.action_code, body.action_other
                elif same and old.action_code:
                    action_code, action_other = old.action_code, old.action_other
                if body.fate_code:
                    fate_code, fate_other = body.fate_code, body.fate_other
                elif same and old.fate_code:
                    fate_code, fate_other = old.fate_code, old.fate_other
                missing = []
                if not R._check_action(action_code, action_other, rev.action_codes):
                    missing.append("action")
                if not R._check_fate(fate_code, fate_other, rev.fate_codes):
                    missing.append("fate")
                if missing:
                    raise R.RuleError("deviation_fields_required", {"missing": missing})
                if same and R.is_deviation(old) and old.deviation_state in _DEV_STATES:
                    dev_state = old.deviation_state
                else:
                    dev_state = "closed" if R.FATE_CLOSES.get(fate_code, True) else "open"
                if body.action_note is not None:
                    action_note = S._text_or_none(body.action_note)
                elif same:
                    action_note = old.action_note
    except R.RuleError as e:
        raise S.rule_http(e)

    if check_changed:
        slot = S.slot_for(db, owner, target, revs, at, tz, cutoff) if not is_tick else None
        slot_due_at = slot.due_at if slot else None
        late = R.is_late(at, slot_due_at) if slot_due_at else False
        followup_of_id = None
    else:
        slot_due_at, late, followup_of_id = old.slot_due_at, bool(old.late), old.followup_of_id

    new = FoodCheckEntry(
        id=uuid.uuid4(),
        user_id=owner.id,
        branch_id=target.branch_id,
        check_id=target.id,
        revision_id=rev.id,
        client_id=client_id,
        business_date=old.business_date,
        slot_due_at=slot_due_at,
        recorded_at=old.recorded_at,          # the official time never changes
        client_typed_at=old.client_typed_at,
        value_c=value,
        done=True if is_tick else None,
        product_type=product_type,
        limit_c=limit.limit_c if limit is not None else None,
        limit_direction=limit.direction if limit is not None else None,
        in_limit=ok,
        late=late,
        product_note=old.product_note if is_receiving else None,
        label_ok=old.label_ok if is_receiving else None,
        action_code=action_code,
        action_other=S._text_or_none(action_other) if action_code == "other" else None,
        fate_code=fate_code,
        fate_other=S._text_or_none(fate_other) if fate_code == "other" else None,
        action_note=action_note,
        acted_by_name=old.acted_by_name,
        deviation_state=dev_state,
        followup_of_id=followup_of_id,
        source=old.source or "live",
        paper_measured_at=old.paper_measured_at,
        staff_id=old.staff_id,
        staff_name=old.staff_name,
        name_source=old.name_source,
        via=old.via,
        kitchen_link_id=old.kitchen_link_id,
        actor_user_id=actor_user_id,
        supersedes_id=old.id,
        correction_reason=code,
        # Two meanings, two columns: the paper reason travels with the reading
        # (a corrected "Fra papir" row still prints why it came in late); the
        # correction's own words go in correction_text.
        reason_text=old.reason_text if (old.source == "paper") else None,
        correction_text=reason_text,          # verbatim
        created_at=now,
    )
    old.voided_at = now
    old.void_reason = "correction"
    db.add(new)
    db.flush()
    audit_service.record(
        db, owner, "egenkontrol.entry_corrected", "food_check_entry", new.id,
        before={"check_id": str(old.check_id),
                "value_c": None if old.value_c is None else float(old.value_c)},
        after={"check_id": str(target.id),
               "value_c": None if value is None else float(value),
               "reason_code": code},
        actor_id=actor_user_id,
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        again = S.find_replay(db, owner, client_id)
        if again is None or str(again.supersedes_id) != str(body.entry_id):
            raise S.conflict("client_id_reused")
        prev = db.query(FoodCheckEntry).filter(FoodCheckEntry.id == again.supersedes_id).first()
        return _pair_out(db, owner, again, prev, tz), True
    db.refresh(new)
    db.refresh(old)
    return _pair_out(db, owner, new, old, tz), False


# ── Folder extras (JSON + PDF) ───────────────────────────────────────────

def folder_extras(db: Session, owner, fd, check_ids) -> None:
    """Photos for every row shown, the documents (branch scope), weekly
    reviews overlapping the period, the findsmiley.dk link and the repeat
    hints (window ends at the period's end). Few queries, none per row."""
    from app.services import egenkontrol_files as F
    from app.services import egenkontrol_week as W

    ids = [e.id for e in fd.entries]
    for fl in fd.followups.values():
        ids.extend(f.id for f in fl)
    fd.photos = S.photos_for(db, owner, ids)
    fd.documents = F.load_documents(db, owner, branch_scope=fd.branch_id)
    fd.reviews = W.reviews_between(db, owner, fd.date_from, fd.date_to)
    settings = S.get_settings(db, owner)
    fd.findsmiley_url = settings.findsmiley_url if settings is not None else None
    end_instant = min(R.business_day_bounds(fd.date_to, fd.tz, fd.cutoff)[1], fd.now)
    fd.repeat = repeat_for(db, owner, check_ids, end_instant, fd.tz, fd.cutoff)


def repeat_for(db: Session, owner, check_ids, end_instant, tz, cutoff) -> list:
    """[(check_id, count)] — live deviations in the 30 days that end at
    `end_instant`, read with their own query (a 7-day week still looks back
    30 days)."""
    if not check_ids:
        return []
    end_day = R.business_date_of(end_instant, tz, cutoff)
    rows = (
        db.query(FoodCheckEntry)
        .filter(
            FoodCheckEntry.user_id == owner.id,
            FoodCheckEntry.check_id.in_(list(check_ids)),
            FoodCheckEntry.voided_at.is_(None),
            or_(FoodCheckEntry.in_limit.is_(False), FoodCheckEntry.deviation_state.isnot(None)),
            FoodCheckEntry.business_date >= end_day - timedelta(days=R.REPEAT_WINDOW_DAYS + 1),
            FoodCheckEntry.business_date <= end_day,
        )
        .all()
    )
    return R.repeat_hints(rows, end_instant)


def _check_names(fd) -> dict:
    out = {}
    for cid, revs in fd.revs.items():
        if revs:
            out[cid] = revs[-1].name
    for c in fd.checks:
        out[str(c.id)] = c.name
    return out


def repeat_out(fd) -> list:
    names = _check_names(fd)
    return [
        {"check_id": cid, "check_name": names.get(cid, ""), "count": n,
         "days": R.REPEAT_WINDOW_DAYS}
        for cid, n in fd.repeat
    ]


def chain_photo(chain_rows, photos: dict):
    for e in chain_rows:
        p = photos.get(str(e.id))
        if p is not None:
            return p
    return None


def corrections_of(fd) -> list:
    """[(original, corrected)] for every correction row in the period, in
    the order they were made. Two corrections with the same created_at (a
    frozen clock, or the same instant) keep their CHAIN order — a correction
    of a correction after the one it corrected — never the random id order."""
    by_id = {str(e.id): e for e in fd.entries}

    def depth(e) -> int:
        d, cur = 0, e
        while cur.supersedes_id is not None and d < 100:
            cur = by_id.get(str(cur.supersedes_id))
            if cur is None:
                break
            d += 1
        return d

    out = []
    for n in sorted((e for e in fd.entries if e.supersedes_id is not None),
                    key=lambda e: (e.created_at, depth(e), str(e.id))):
        orig = by_id.get(str(n.supersedes_id))
        if orig is not None:
            out.append((orig, n))
    return out


def event_followups(fd, head, chain) -> list:
    members = chain or [head]
    member_ids = {str(x.id) for x in members}
    seen, out = set(), []
    for m in members:
        for f in fd.followups.get(str(m.id), []):
            fid = str(f.id)
            if f.voided_at is not None or fid in member_ids or fid in seen:
                continue
            seen.add(fid)
            out.append(f)
    out.sort(key=R.effective_at)
    return out


def folder_json(fd, *, include_readings: bool = False) -> dict:
    from app.services import egenkontrol_files as F
    from app.services import egenkontrol_week as W

    tz = fd.tz
    photos = fd.photos

    def eo(e) -> dict:
        return S.entry_out(e, tz, photos)

    def named(e) -> dict:
        d = eo(e)
        d["check_name"] = S.entry_check_name(fd, e)
        return d

    deviations = []
    for head, chain, state in fd.events:
        d = named(head)
        d["chain"] = [named(x) for x in chain] if chain else []
        d["state"] = state
        d["followups"] = [eo(f) for f in event_followups(fd, head, chain)]
        d["photo"] = S.photo_out(chain_photo(chain or [head], photos), tz)
        deviations.append(d)
    late = []
    for r in fd.slot_results:
        if r.state == "late" and r.filled_by is not None:
            d = named(r.filled_by)
            d["slot_due_local"] = R.hhmm_local(r.slot.due_at, tz)
            late.append(d)
    late.sort(key=lambda d: d["recorded_at"])
    names = {str(c.id): c.name for c in fd.checks}
    missed = []
    for r in sorted(fd.slot_results, key=lambda r: r.slot.due_at):
        if r.state == "missed":
            rv = fd.rev_by_id.get(r.slot.revision_id)
            missed.append({
                "check_id": r.slot.check_id,
                "check_name": rv.name if rv else names.get(r.slot.check_id, ""),
                "date": r.slot.business_date.isoformat(),
                "due_local": R.hhmm_local(r.slot.due_at, tz),
                "schedule_type": r.slot.schedule_type,
            })
    # Every voided reading, whatever its reason — except one replaced by a
    # correction (that one is listed under "corrections" with its reason).
    undone = [named(e) for e in fd.entries
              if e.voided_at is not None and e.void_reason != "correction"]
    corrections = []
    for orig, new in corrections_of(fd):
        loc = R.to_local(new.created_at, tz)
        corrections.append({
            "original": named(orig),
            "corrected": named(new),
            "reason_code": new.correction_reason,
            "reason_text": new.correction_text,
            "corrected_local_date": loc.date().isoformat(),
            "corrected_local": loc.strftime("%H:%M"),
            "check_changed": str(orig.check_id) != str(new.check_id),
            "original_check_name": S.entry_check_name(fd, orig),
            "check_name": S.entry_check_name(fd, new),
        })
    live = sorted((e for e in fd.entries if e.voided_at is None), key=R.effective_at)
    paper = [named(e) for e in live if e.source == "paper"]
    checks = [
        {
            "id": str(c.id),
            "name": c.name,
            "template_key": c.template_key,
            "revisions": [S._rev_out(rv) for rv, _ in fd.period_revs.get(str(c.id), [])],
        }
        for c in fd.checks
    ]
    s = fd.summary
    today_local = R.to_local(fd.now, tz).date()
    out = {
        "from": fd.date_from.isoformat(),
        "to": fd.date_to.isoformat(),
        "range": {"from": fd.date_from.isoformat(), "to": fd.date_to.isoformat(),
                  "max_days": fd.max_days},
        "venue_name": fd.venue_name,
        "branch_name": fd.branch_name,
        "generated_at": S.iso_z(fd.now),
        "title_counts": {
            "readings": s["readings"],
            "deviations": s["deviations"],
            "deviations_open": s["deviations_open"],
        },
        "summary": s,
        "days": [{"date": d.isoformat(), "state": st} for d, st in sorted(fd.days.items())],
        "deviations": deviations,
        "late": late,
        "missed": missed,
        "undone": undone,
        "corrections": corrections,
        "paper": paper,
        "checks": checks,
        "findsmiley_url": fd.findsmiley_url,
        "documents": [F.document_out(d, tz, today_local) for d in fd.documents],
        "reviews": [W.review_out(r, tz) for r in fd.reviews],
        "repeat_hints": repeat_out(fd),
    }
    if include_readings:
        # "Alle målinger": every live reading, by effective time, COMPACT
        # (a dense 92-day period is ~2,200 rows).
        out["readings"] = [
            {k: v for k, v in named(e).items() if k in COMPACT_READING_KEYS} for e in live
        ]
    return out


# The "Alle målinger" row: what the list shows and the "Ret" sheet needs
# (the server copies action / fate from the corrected row when not sent).
COMPACT_READING_KEYS = frozenset({
    "id", "check_id", "check_name", "business_date", "recorded_at", "recorded_local",
    "recorded_local_date", "value_c", "done", "product_type", "limit_c", "limit_direction",
    "in_limit", "late", "slot_due_local", "action_code", "fate_code", "action_note",
    "deviation_state", "staff_name", "name_source", "via", "source", "paper_measured_local",
    "paper_measured_local_date", "reason_text", "supersedes_id", "correction_reason",
    "correction_text",
    "photo", "correctable_until",
})


__all__ = [
    "save_paper_entry", "correct_entry", "folder_extras", "folder_json",
    "corrections_of", "event_followups", "chain_photo", "repeat_out", "repeat_for",
]
