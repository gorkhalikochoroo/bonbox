"""Egenkontrol R1a — the pure rules module (app/services/egenkontrol_rules.py).

No database and no clock: every function takes `now`. These pin the plan's
rule tests — late (60-minute grace), business day (06:00 cutoff), daylight
saving 2027, history-safe slots, deviations, status precedence (D13), undo.
"""
from datetime import date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace as NS
from zoneinfo import ZoneInfo

import pytest

from app.services import egenkontrol_rules as R

CPH = ZoneInfo("Europe/Copenhagen")


def rev(id_="r1", check="c1", valid_from=datetime(2026, 1, 1), active=True,
        schedule=None, limit_c=Decimal("5.0"), source="law", kind="temp_max",
        template_key="fridge", recheck_min=30, product_limits=None):
    tpl = R.START_LIST[template_key]
    return R.RevisionView(
        id=id_, check_id=check, valid_from=valid_from, active=active,
        schedule=schedule or {"type": "daily", "due": "08:00"},
        limit_c=limit_c, limit_source=source, product_limits=product_limits,
        recheck_min=recheck_min, name="Køl 1", template_key=template_key, kind=kind,
        action_codes=tpl["action_codes"], fate_codes=tpl["fate_codes"],
    )


def ent(at, check="c1", voided=False, deviation_state=None, id_=None, **kw):
    return NS(id=id_ or f"e-{at.isoformat()}", check_id=check, recorded_at=at,
              voided_at=(at if voided else None), deviation_state=deviation_state,
              void_reason=("undo" if voided else None), revision_id="r1",
              fate_code=kw.pop("fate_code", None), **kw)


def utc_of(d, hhmm):
    return R.wall_to_utc(d, hhmm, CPH)


# ── Late (plan "Late") ──────────────────────────────────────────────────

def test_late_is_more_than_60_minutes_after_due():
    due = datetime(2026, 11, 12, 7, 0)  # 08:00 Copenhagen
    assert R.is_late(due + timedelta(minutes=59), due) is False
    assert R.is_late(due + timedelta(minutes=60), due) is False  # exactly 60:00 is on time
    assert R.is_late(due + timedelta(minutes=61), due) is True
    assert R.is_late(due + timedelta(hours=5), None) is False


def test_assign_marks_on_time_late_missed_and_open():
    d = date(2026, 11, 12)
    slots = R.slots_between([rev()], d, d, CPH, 6)
    assert len(slots) == 1 and slots[0].due_at == utc_of(d, "08:00")
    s = slots[0]
    for minutes, state in ((59, "on_time"), (60, "on_time"), (61, "late")):
        res = R.assign(slots, [ent(s.due_at + timedelta(minutes=minutes))], s.window_end)
        assert res[0].state == state, minutes
    assert R.assign(slots, [], s.window_end)[0].state == "missed"
    assert R.assign(slots, [], s.window_end - timedelta(seconds=1))[0].state == "open"
    # a voided reading fills nothing
    assert R.assign(slots, [ent(s.due_at, voided=True)], s.window_end)[0].state == "missed"


# ── Business day (plan "Business day") ──────────────────────────────────

def test_a_0020_reading_belongs_to_the_previous_business_day_but_keeps_its_date():
    at = utc_of(date(2026, 11, 13), "00:20")
    assert R.business_date_of(at, CPH, 6) == date(2026, 11, 12)
    local = R.to_local(at, CPH)
    assert local.date() == date(2026, 11, 13) and local.strftime("%H:%M") == "00:20"
    assert R.format_date_da(local.date()) == "13. nov 2026"


def test_due_before_the_day_start_is_refused_with_cutoff_6_and_accepted_with_4():
    with pytest.raises(R.RuleError) as e:
        R.validate_due("05:30", 6)
    assert e.value.code == "due_before_day_start" and e.value.detail == {"cutoff_hour": 6}
    assert R.validate_due("05:30", 4) == "05:30"
    with pytest.raises(R.RuleError) as e:
        R.parse_hhmm("25:00")
    assert e.value.code == "bad_time"


# ── Daylight saving 2027 (plan "Daylight saving") ───────────────────────

def test_spring_forward_28_mar_2027():
    d = date(2027, 3, 28)
    assert utc_of(d, "08:00") == datetime(2027, 3, 28, 6, 0)          # CEST
    start, end = R.business_day_bounds(d - timedelta(days=1), CPH, 6)  # 27→28 Mar spans the gap
    assert end - start == timedelta(hours=23)
    # nonexistent 02:30 → first valid minute after the gap, 03:00 local
    t = R.wall_to_utc(d, "02:30", CPH)
    assert R.to_local(t, CPH).strftime("%H:%M") == "03:00"


def test_fall_back_31_oct_2027():
    d = date(2027, 10, 31)
    assert utc_of(d, "08:00") == datetime(2027, 10, 31, 7, 0)          # CET
    start, end = R.business_day_bounds(d - timedelta(days=1), CPH, 6)
    assert end - start == timedelta(hours=25)
    # ambiguous 02:30 → the first occurrence (still CEST, 00:30 UTC)
    assert R.wall_to_utc(d, "02:30", CPH) == datetime(2027, 10, 31, 0, 30)


def test_late_is_measured_in_real_elapsed_time_on_dst_days():
    for d in (date(2027, 3, 28), date(2027, 10, 31)):
        slots = R.slots_between([rev()], d, d, CPH, 6)
        s = slots[0]
        assert R.assign(slots, [ent(s.due_at + timedelta(minutes=60))], s.window_end)[0].state == "on_time"
        assert R.assign(slots, [ent(s.due_at + timedelta(minutes=61))], s.window_end)[0].state == "late"


# ── History (plan "History") ────────────────────────────────────────────

def test_daily_to_weekly_keeps_last_months_missed_slots():
    r1 = rev("r1", valid_from=datetime(2026, 10, 1))
    r2 = rev("r2", valid_from=datetime(2026, 11, 1, 12),
             schedule={"type": "weekly", "weekday": 0, "due": "08:00"})
    slots = R.slots_between([r1, r2], date(2026, 10, 1), date(2026, 10, 31), CPH, 6)
    assert len(slots) == 31 and all(s.schedule_type == "daily" for s in slots)
    res = R.assign(slots, [], datetime(2026, 11, 12))
    assert all(r.state == "missed" for r in res)


def test_switching_a_fridge_off_does_not_remove_past_missed_days():
    r1 = rev("r1", valid_from=datetime(2026, 10, 1))
    off = rev("r2", valid_from=datetime(2026, 11, 10, 12), active=False)
    october = R.slots_between([r1, off], date(2026, 10, 1), date(2026, 10, 31), CPH, 6)
    assert len(october) == 31
    after = R.slots_between([r1, off], date(2026, 11, 11), date(2026, 11, 20), CPH, 6)
    assert after == []


def test_a_check_created_after_todays_due_has_no_slot_today():
    d = date(2026, 11, 12)
    r1 = rev(valid_from=utc_of(d, "10:00"))
    slots = R.slots_between([r1], d, d + timedelta(days=1), CPH, 6)
    assert [s.business_date for s in slots] == [d + timedelta(days=1)]


def test_a_midday_due_change_keeps_the_earlier_slot_already_in_force():
    d = date(2026, 11, 12)
    r1 = rev("r1", valid_from=datetime(2026, 11, 1))
    r2 = rev("r2", valid_from=utc_of(d, "10:00"), schedule={"type": "daily", "due": "14:00"})
    slots = R.slots_between([r1, r2], d, d, CPH, 6)
    assert len(slots) == 1
    assert slots[0].due_at == utc_of(d, "08:00") and slots[0].revision_id == "r1"
    nxt = R.slots_between([r1, r2], d + timedelta(days=1), d + timedelta(days=1), CPH, 6)
    assert nxt[0].due_at == utc_of(d + timedelta(days=1), "14:00")


def test_weekly_slot_is_late_after_due_plus_60_and_missed_at_week_end():
    r = rev(schedule={"type": "weekly", "weekday": 2, "due": "08:00"})  # Wednesday
    monday = date(2026, 11, 9)
    slots = R.slots_between([r], monday, monday + timedelta(days=6), CPH, 6)
    assert len(slots) == 1
    s = slots[0]
    assert s.business_date == date(2026, 11, 11) and s.schedule_type == "weekly"
    # a Monday reading fills it on time (the window is the ISO week)
    assert R.assign(slots, [ent(utc_of(monday, "09:00"))], s.window_end)[0].state == "on_time"
    assert R.assign(slots, [ent(s.due_at + timedelta(minutes=61))], s.window_end)[0].state == "late"
    assert R.assign(slots, [], s.window_end)[0].state == "missed"
    assert R.assign(slots, [], s.window_end - timedelta(minutes=1))[0].state == "open"


def test_on_event_never_has_slots_so_is_never_missed():
    r = rev(schedule={"type": "on_event"}, template_key="receiving", kind="receiving", limit_c=None)
    assert R.slots_between([r], date(2026, 11, 1), date(2026, 11, 30), CPH, 6) == []


def test_earliest_unfilled_filling_and_two_readings_one_slot():
    d = date(2026, 11, 12)
    slots = R.slots_between([rev()], d, d, CPH, 6)
    a = ent(utc_of(d, "07:30"), id_="a")
    b = ent(utc_of(d, "09:30"), id_="b")
    res = R.assign(slots, [b, a], slots[0].window_end)
    assert res[0].filled_by.id == "a" and res[0].state == "on_time"
    # the second reading is an off-slot reading — nothing for it to fill
    assert R.slot_for_new_entry(slots, [a], utc_of(d, "09:30")) is None
    assert R.slot_for_new_entry(slots, [], utc_of(d, "09:30")) is slots[0]


# ── Values / limits / names ─────────────────────────────────────────────

def test_in_limit_boundaries():
    freezer = R.Limit(Decimal("-18.0"), "max", "fvst_example")
    assert R.in_limit(Decimal("-18.0"), freezer) is True
    assert R.in_limit(Decimal("-17.9"), freezer) is False
    hot = R.Limit(Decimal("56.0"), "min", "law")
    assert R.in_limit(Decimal("56.0"), hot) is True
    assert R.in_limit(Decimal("55.9"), hot) is False


def test_validate_value_range_and_decimals():
    assert R.validate_value(3.1) == Decimal("3.1")
    assert R.validate_value("-18") == Decimal("-18.0")
    assert R.validate_value(-40) == Decimal("-40.0") and R.validate_value(120) == Decimal("120.0")
    for bad, code in ((120.1, "value_out_of_range"), (-40.1, "value_out_of_range"),
                      ("abc", "value_out_of_range"), (None, "value_out_of_range"),
                      (True, "value_out_of_range"), (3.15, "too_many_decimals")):
        with pytest.raises(R.RuleError) as e:
            R.validate_value(bad)
        assert e.value.code == code, bad


def test_receiving_limit_follows_the_product_type():
    r = rev(template_key="receiving", kind="receiving", limit_c=None, schedule={"type": "on_event"})
    assert R.limit_for(r, "fish").limit_c == Decimal("2.0")
    assert R.limit_for(r, "frozen").limit_c == Decimal("-18.0")
    assert R.limit_for(r, "chilled").source == "law"
    with pytest.raises(R.RuleError) as e:
        R.limit_for(r, None)
    assert e.value.code == "product_type_required"


def test_limit_source_never_overclaims_the_law():
    assert R.source_for_value("hot_holding", Decimal("56.0")) == "law"
    assert R.source_for_value("hot_holding", Decimal("65.0")) == "owner"   # stricter = own limit
    assert R.source_for_value("freezer", Decimal("-18.0")) == "fvst_example"
    assert R.template_ref("hot_holding", "owner") is None


def test_first_name_last_initial():
    assert R.first_name_last_initial("Ali Khan Hansen") == "Ali H."
    assert R.first_name_last_initial("Ali") == "Ali"
    assert len(R.first_name_last_initial("A" * 200)) <= 80
    assert len(R.first_name_last_initial("A" * 200 + " B")) <= 80


def test_clean_typed_name():
    assert R.clean_typed_name("  Mia  ") == "Mia"
    for bad in ("", "   ", "x" * 41, None):
        with pytest.raises(R.RuleError):
            R.clean_typed_name(bad)


# ── Deviations ──────────────────────────────────────────────────────────

_FR = R.START_LIST["fridge"]
_HH = R.START_LIST["hot_holding"]


def _dec(**kw):
    base = dict(in_limit=False, value=Decimal("7.1"), open_dev=None, action_code=None,
                action_other=None, fate_code=None, fate_other=None,
                allowed_actions=_FR["action_codes"], allowed_fates=_FR["fate_codes"])
    base.update(kw)
    return R.deviation_decision(**base)


def test_out_of_limit_needs_both_action_and_fate():
    with pytest.raises(R.RuleError) as e:
        _dec()
    assert e.value.code == "deviation_fields_required"
    assert e.value.detail == {"missing": ["action", "fate"]}
    with pytest.raises(R.RuleError) as e:
        _dec(action_code="thermostat_adjusted")
    assert e.value.detail == {"missing": ["fate"]}
    with pytest.raises(R.RuleError) as e:
        _dec(action_code="heat_increased", fate_code="moved")
    assert e.value.code == "action_unknown"
    with pytest.raises(R.RuleError) as e:
        _dec(action_code="other", fate_code="moved")
    assert e.value.code == "other_text_required"


def test_closing_fate_closes_awaiting_recheck_stays_open():
    d = _dec(action_code="moved_goods", fate_code="moved")
    assert d.deviation_state == "closed" and d.store_action and d.store_fate
    d = _dec(action_code="thermostat_adjusted", fate_code="awaiting_recheck")
    assert d.deviation_state == "open"


def test_in_limit_with_no_open_deviation_ignores_the_fields():
    d = _dec(in_limit=True, value=Decimal("3.1"), action_code="moved_goods", fate_code="moved")
    assert d == R.Decision(None, None, False, False, False)


def test_in_limit_followup_needs_a_closing_fate():
    open_dev = R.OpenDev("dev1", "awaiting_recheck")
    with pytest.raises(R.RuleError) as e:
        _dec(in_limit=True, value=Decimal("4.0"), open_dev=open_dev)
    assert e.value.code == "followup_fate_required"
    with pytest.raises(R.RuleError):
        _dec(in_limit=True, value=Decimal("4.0"), open_dev=open_dev, fate_code="awaiting_recheck")
    d = _dec(in_limit=True, value=Decimal("4.0"), open_dev=open_dev, fate_code="assessed_ok")
    assert d.followup_of_id == "dev1" and d.close_predecessor and d.deviation_state is None
    assert d.store_fate and not d.store_action


def test_reheated_75_closes_only_on_75_or_more():
    open_dev = R.OpenDev("dev1", "reheated_75")
    kw = dict(allowed_actions=_HH["action_codes"], allowed_fates=_HH["fate_codes"], open_dev=open_dev)
    d = _dec(in_limit=True, value=Decimal("75.0"), **kw)
    assert d.close_predecessor and not d.store_fate
    with pytest.raises(R.RuleError) as e:
        _dec(in_limit=True, value=Decimal("60.0"), **kw)
    assert e.value.code == "followup_fate_required"


def test_out_of_limit_followup_is_a_new_linked_deviation_and_closes_the_old():
    open_dev = R.OpenDev("dev1", "awaiting_recheck")
    d = _dec(open_dev=open_dev, action_code="thermostat_adjusted", fate_code="awaiting_recheck")
    assert d.deviation_state == "open" and d.followup_of_id == "dev1" and d.close_predecessor


def test_recheck_due_at():
    e = ent(datetime(2026, 11, 12, 7, 0))
    assert R.recheck_due_at(e, rev(recheck_min=45)) == datetime(2026, 11, 12, 7, 45)


# ── Status (every state) ────────────────────────────────────────────────

D = date(2026, 11, 12)


def _st(now, entries=(), revisions=None):
    revisions = revisions or [rev(valid_from=datetime(2026, 11, 1))]
    return R.status_today(NS(id="c1"), revisions, list(entries), now, CPH, 6)


def test_status_later_due_overdue():
    assert _st(utc_of(D, "06:30")).status == "later"
    assert _st(utc_of(D, "07:00")).status == "due"
    assert _st(utc_of(D, "09:00")).status == "due"     # exactly due + 60
    st = _st(utc_of(D, "09:01"))
    assert st.status == "overdue" and st.slot_state == "overdue"
    assert R.summary_today([st])["missing"] == 1


def test_status_done_and_done_late():
    st = _st(utc_of(D, "10:00"), [ent(utc_of(D, "08:12"), business_date=D)])
    assert st.status == "done" and st.last is not None
    st = _st(utc_of(D, "10:00"), [ent(utc_of(D, "09:30"), business_date=D)])
    assert st.status == "done_late"


def test_status_deviation_open_wins_over_everything():
    e = ent(utc_of(D - timedelta(days=1), "08:05"), deviation_state="open",
            fate_code="awaiting_recheck", business_date=D - timedelta(days=1))
    st = _st(utc_of(D, "06:30"), [e])
    assert st.status == "deviation_open" and st.open_deviation is e
    assert R.summary_today([st])["open_deviations"] == 1


def test_deviation_closed_is_not_hidden_by_a_later_good_reading():
    bad = ent(utc_of(D, "08:05"), id_="bad", deviation_state="closed", business_date=D)
    good = ent(utc_of(D, "08:40"), id_="good", business_date=D)
    st = _st(utc_of(D, "12:00"), [bad, good])
    assert st.status == "deviation_closed"


def test_status_on_event_and_weekly_before_its_day():
    on_event = [rev(schedule={"type": "on_event"})]
    assert _st(utc_of(D, "12:00"), revisions=on_event).status == "on_event"
    weekly = [rev(valid_from=datetime(2026, 11, 1),
                  schedule={"type": "weekly", "weekday": 4, "due": "08:00"})]
    st = _st(utc_of(D, "12:00"), revisions=weekly)  # Thursday, due Friday
    assert st.status == "later" and st.slot.business_date == date(2026, 11, 13)


def test_summary_never_counts_a_check_without_a_slot():
    created_late = [rev(valid_from=utc_of(D, "10:00"))]
    st = _st(utc_of(D, "11:00"), revisions=created_late)
    assert st.status == "later" and not st.slot_is_current
    assert R.summary_today([st]) == {"total": 0, "done": 0, "missing": 0, "due": 0,
                                     "open_deviations": 0}


def test_day_states_worst_of():
    d1, d2, d3 = D - timedelta(days=2), D - timedelta(days=1), D
    slots = R.slots_between([rev(valid_from=datetime(2026, 11, 1))], d1, d3, CPH, 6)
    e1 = ent(utc_of(d1, "08:05"), id_="1", business_date=d1, deviation_state="closed")
    e1b = ent(utc_of(d1, "08:40"), id_="1b", business_date=d1)
    e3 = ent(utc_of(d3, "09:30"), id_="3", business_date=d3)
    res = R.assign(slots, [e1, e1b, e3], utc_of(d3 + timedelta(days=1), "07:00"))
    states = R.day_states(res, [e1, e1b, e3], d1, d3, CPH, 6)
    assert states == {d1: "deviation", d2: "missed", d3: "late"}
    s = R.folder_summary(res, [e1, e1b, e3])
    assert s["slots_missed"] == 1 and s["slots_late"] == 1 and s["deviations"] == 1


# ── Undo ────────────────────────────────────────────────────────────────

def test_undo_window_is_120_seconds():
    e = ent(datetime(2026, 11, 12, 7, 0))
    assert R.undo_check(e, e.recorded_at + timedelta(seconds=120), same_actor=True) == "ok"
    assert R.undo_check(e, e.recorded_at + timedelta(seconds=121), same_actor=True) == "window_passed"
    assert R.undo_check(e, e.recorded_at, same_actor=False) == "not_yours"
    assert R.undo_check(ent(e.recorded_at, voided=True), e.recorded_at, same_actor=True) == "already_voided"


# ── Danish text ─────────────────────────────────────────────────────────

def test_danish_text_helpers():
    assert R.format_temp_da(Decimal("3.1")) == "3,1 °C"
    assert R.format_temp_da(Decimal("-18")) == "−18,0 °C"
    assert R.limit_text_da(R.Limit(Decimal("5.0"), "max", "law")) == "Højst 5,0 °C"
    assert R.limit_text_da(R.Limit(Decimal("56.0"), "min", "law")) == "Mindst 56,0 °C"
    assert R.limit_text_da(R.Limit(Decimal("-18.0"), "max", "law")) == "−18,0 °C eller koldere"
    assert R.schedule_text_da({"type": "daily", "due": "08:00"}, "fridge") == "Skrives ned hver dag kl. 08:00"
    assert R.schedule_text_da({"type": "weekly", "weekday": 0, "due": "08:00"}, "fridge") == \
        "Skrives ned 1 gang om ugen, mandag kl. 08:00"
    assert R.schedule_text_da({"type": "on_event"}, "receiving") == "Ved hver levering"
    assert R.late_text_da("09:30", "08:00") == "For sent · registreret kl. 09:30 (frist kl. 08:00)"
    assert R.name_note_da("picked", "kitchen") == "(valgt på køkken-iPad)"
    assert R.name_note_da("typed", "kitchen") == "(skrevet ind)"
    assert R.source_text_da("owner", None) == "Grænse sat af virksomheden"


def test_the_start_list_is_decision_2():
    sl = R.START_LIST
    assert sl["hot_holding"]["limit"]["limit_c"] == Decimal("56.0")
    assert sl["hot_holding"]["limit"]["source"] == "law"
    assert sl["reheating"]["limit"]["limit_c"] == Decimal("75.0")
    assert sl["fridge"]["limit"]["limit_c"] == Decimal("5.0")
    assert sl["freezer"]["limit"]["source"] == "fvst_example"
    assert sl["receiving"]["product_limits"]["fish"]["limit_c"] == Decimal("2.0")
    assert sl["reheating"]["schedule_options"] == ("on_event",)
    assert sl["receiving"]["schedule_options"] == ("on_event",)
    assert sl["hot_holding"]["fate_codes"][0] == "discarded"


def test_normalize_schedule():
    assert R.normalize_schedule(None, "fridge", 6) == {"type": "daily", "due": "08:00"}
    assert R.normalize_schedule({"type": "weekly", "due": "09:00"}, "fridge", 6) == \
        {"type": "weekly", "weekday": 0, "due": "09:00"}
    with pytest.raises(R.RuleError) as e:
        R.normalize_schedule({"type": "daily", "due": "08:00"}, "receiving", 6)
    assert e.value.code == "schedule_not_allowed"
