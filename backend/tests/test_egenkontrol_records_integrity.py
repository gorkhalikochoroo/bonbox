"""Egenkontrol R1a — what the inspection record must never lose or misstate.

Pins the review fixes of 12 Nov:
  • a follow-up's final food fate and its note reach the PDF (and the folder);
  • a check with an open deviation cannot be switched off or archived;
  • the two mutable columns cannot hide a reading or a deviation: a deviation
    moves only open <-> closed, a void needs a known reason, and the PDF
    lists deviations by in_limit and prints every voided row;
  • a manager's PDF is attributed to the manager (audit row and footer);
  • a weekly slot is filled by a reading earlier in its ISO week even when
    the period starts mid-week (no false "Ikke registreret");
  • "For sent · registreret kl. …" names the reading that filled the slot.
"""
import io
import uuid
from datetime import datetime

import pytest
from pypdf import PdfReader
from sqlalchemy import text

from app.models.audit_log import AuditLog
from app.models.food_check import EntryImmutableError, FoodCheckEntry
from tests._ek_support import T0, env  # noqa: F401 — fixture


def _pdf_text(env, user, **params) -> str:
    r = env.client.get("/api/egenkontrol/folder.pdf", params=params, headers=env.h(user))
    assert r.status_code == 200, r.text
    reader = PdfReader(io.BytesIO(r.content))
    return " ".join("\n".join(p.extract_text() or "" for p in reader.pages).split())


def _section(text: str, start: str, end: str) -> str:
    i = text.index(start)
    j = text.index(end, i)
    return text[i:j]


# ── 1. the follow-up's fate and note are printed ────────────────────────

def test_the_final_food_fate_of_a_recheck_is_in_the_pdf_and_the_folder(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    first = env.save(o, fridge, 7.1, action_code="thermostat_adjusted",
                     fate_code="awaiting_recheck")
    assert first.status_code == 201, first.text
    env.clock.tick(minutes=30)                       # 08:00 local
    fu = env.save(o, fridge, 4.0, fate_code="discarded", action_note="FOLLOWUP-NOTE",
                  typed_name="Bo")
    assert fu.status_code == 201, fu.text

    folder = env.client.get("/api/egenkontrol/folder", headers=env.h(o)).json()
    dev = folder["deviations"][0]
    assert dev["fate_code"] == "awaiting_recheck" and dev["deviation_state"] == "closed"
    assert dev["followups"][0]["fate_code"] == "discarded"
    assert dev["followups"][0]["action_note"] == "FOLLOWUP-NOTE"

    text = _pdf_text(env, o)
    devs = _section(text, "Afvigelser", "Registreringer pr. kontrolpunkt")
    assert "Afventer ny måling" in devs
    assert "→ Kasseret (kl. 08:00)" in devs           # what finally happened to the food
    assert "4,0 °C kl. 08:00 · Bo (skrevet ind)" in devs
    assert "FOLLOWUP-NOTE" in devs
    assert "Afsluttet" in devs


def test_a_followup_note_with_markup_prints_as_text(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    env.save(o, fridge, 7.1, action_code="thermostat_adjusted", fate_code="awaiting_recheck")
    env.clock.tick(minutes=30)
    env.save(o, fridge, 4.0, fate_code="other", fate_other="<b>Givet</b> til personalet",
             action_note='<img src="http://169.254.169.254/x"/>')
    devs = _section(_pdf_text(env, o), "Afvigelser", "Registreringer pr. kontrolpunkt")
    assert "<b>Givet</b> til personalet" in devs
    # printed as text (a long cell may wrap, so compare without spaces)
    assert '<imgsrc="http://169.254.169.254/x"/>' in devs.replace(" ", "")


# ── 2. an open deviation blocks switch-off and archive ──────────────────

def test_an_open_deviation_blocks_switch_off_and_archive_until_it_is_closed(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    env.save(o, fridge, 7.1, action_code="thermostat_adjusted", fate_code="awaiting_recheck")

    r = env.client.post(f"/api/egenkontrol/checks/{fridge}/archive", headers=env.h(o))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "open_deviation"
    r = env.client.patch(f"/api/egenkontrol/checks/{fridge}", json={"active": False},
                         headers=env.h(o))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "open_deviation"
    # nothing changed: the check still takes the follow-up
    row = next(c for c in env.today_json(o)["checks"] if c["id"] == fridge)
    assert row["status"] == "deviation_open"
    status = env.client.get("/api/egenkontrol/status", headers=env.h(o)).json()
    assert status["open_deviations"] == 1

    env.clock.tick(minutes=30)
    assert env.save(o, fridge, 4.0, fate_code="discarded").status_code == 201
    r = env.client.patch(f"/api/egenkontrol/checks/{fridge}", json={"active": False},
                         headers=env.h(o))
    assert r.status_code == 200 and r.json()["active"] is False
    r = env.client.post(f"/api/egenkontrol/checks/{fridge}/archive", headers=env.h(o))
    assert r.status_code == 200, r.text


def test_an_out_of_limit_reading_with_a_closing_fate_lets_a_broken_fridge_go(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    env.save(o, fridge, 9.0, action_code="thermostat_adjusted", fate_code="awaiting_recheck")
    env.clock.tick(minutes=30)
    # Still warm: the food is moved and the fridge removed.
    r = env.save(o, fridge, 11.0, action_code="moved_goods", fate_code="moved")
    assert r.status_code == 201 and r.json()["deviation_state"] == "closed"
    r = env.client.post(f"/api/egenkontrol/checks/{fridge}/archive", headers=env.h(o))
    assert r.status_code == 200, r.text


# ── 3. the mutable columns cannot hide a record ─────────────────────────

def test_a_deviation_only_moves_between_open_and_closed(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    dev_id = env.save(o, fridge, 9.9, action_code="thermostat_adjusted",
                      fate_code="awaiting_recheck").json()["id"]
    s = env.SL()

    def row(i):
        return s.query(FoodCheckEntry).filter(FoodCheckEntry.id == uuid.UUID(i)).one()

    r = row(dev_id)
    r.deviation_state = None                        # would drop it from the print
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    r = row(dev_id)
    r.deviation_state = "gone"
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    r = row(dev_id)
    r.deviation_state = "closed"                    # open -> closed: allowed
    s.commit()
    r = row(dev_id)
    r.deviation_state = "open"                      # closed -> open (undo of a follow-up)
    s.commit()
    assert row(dev_id).deviation_state == "open"
    s.close()


def test_an_in_limit_reading_never_becomes_a_deviation_in_place(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    eid = env.save(o, fridge, 3.1).json()["id"]
    s = env.SL()
    r = s.query(FoodCheckEntry).filter(FoodCheckEntry.id == uuid.UUID(eid)).one()
    r.deviation_state = "open"
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    s.close()


def test_a_void_needs_a_known_reason(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    eid = env.save(o, fridge, 3.1).json()["id"]
    s = env.SL()

    def row():
        return s.query(FoodCheckEntry).filter(FoodCheckEntry.id == uuid.UUID(eid)).one()

    r = row()
    r.voided_at, r.void_reason = T0, "x"
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    r = row()
    r.voided_at = T0                                # no reason at all
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    r = row()
    r.voided_at, r.void_reason = T0, "undo"
    s.commit()
    s.close()


def test_the_pdf_lists_deviations_by_in_limit_and_prints_every_voided_row(env):
    """Even a raw UPDATE that slips past the guards (SQLite has no trigger)
    cannot clean the print: an out-of-limit reading stays under Afvigelser,
    and a voided reading of any reason stays under Fortrudte."""
    o = env.owner()
    checks = env.setup(o)
    fridge, freezer = checks["fridge"]["id"], checks["freezer"]["id"]
    dev = env.save(o, fridge, 9.9, action_code="thermostat_adjusted", fate_code="moved").json()
    frz = env.save(o, freezer, -20.0).json()
    with env.engine.begin() as c:
        c.execute(text("UPDATE food_check_entries SET deviation_state = NULL WHERE id = :i"),
                  {"i": dev["id"]})
        c.execute(text("UPDATE food_check_entries SET voided_at = :t, void_reason = 'x' "
                       "WHERE id = :i"), {"i": frz["id"], "t": T0})
    t = _pdf_text(env, o)
    devs = _section(t, "Afvigelser", "Registreringer pr. kontrolpunkt")
    assert "Ingen afvigelser i perioden" not in devs
    assert "9,9 °C" in devs
    undone = _section(t, "Fortrudte indtastninger", "Kontrolpunkter og grænser")
    assert "−20,0 °C" in undone and "Årsag: x" in undone
    folder = env.client.get("/api/egenkontrol/folder", headers=env.h(o)).json()
    assert [d["id"] for d in folder["deviations"]] == [dev["id"]]
    assert [u["id"] for u in folder["undone"]] == [frz["id"]]
    assert folder["summary"]["deviations"] == 1
    assert folder["summary"]["deviations_open"] == 1    # no recorded closure → not closed
    assert folder["summary"]["undone"] == 1


# ── 4. a manager's PDF is the manager's ─────────────────────────────────

def test_a_manager_pdf_is_attributed_to_the_manager(env):
    o = env.owner(email="owner-attr@bonbox.dk")
    env.setup(o)
    m = env.member(o, "manager")
    t = _pdf_text(env, m)
    assert m.email in t and o.email not in t
    env.db.expire_all()
    rows = env.db.query(AuditLog).filter(AuditLog.entity_type == "egenkontrol_registreringer").all()
    assert len(rows) == 1
    assert str(rows[0].user_id) == str(o.id)          # the tenant
    assert str(rows[0].actor_id) == str(m.id)         # the person who pressed it


def test_an_owner_pdf_stays_the_owners(env):
    o = env.owner(email="owner-self@bonbox.dk")
    env.setup(o)
    assert "owner-self@bonbox.dk" in _pdf_text(env, o)
    env.db.expire_all()
    row = env.db.query(AuditLog).filter(AuditLog.entity_type == "egenkontrol_registreringer").one()
    assert str(row.actor_id) == str(o.id)


# ── 5. a weekly slot sees the readings of its whole ISO week ────────────

def test_a_weekly_slot_filled_before_the_period_starts_is_not_missed(env):
    # Monday 9 Nov: Frost 1 is due every Friday 08:00.
    env.clock.set(datetime(2026, 11, 9, 6, 30))
    o = env.owner()
    frost = env.setup(o, items=[{"template_key": "freezer", "name": "Frost 1",
                                 "schedule": {"type": "weekly", "weekday": 4, "due": "08:00"}}])
    fid = frost["freezer"]["id"]
    # Tuesday 10 Nov 09:00 local: recorded — that week shows "on time".
    env.clock.set(datetime(2026, 11, 10, 8, 0))
    assert env.save(o, fid, -18.0).status_code == 201
    # Monday 16 Nov: the period starts Wednesday 11 Nov (mid-week).
    env.clock.set(datetime(2026, 11, 16, 9, 0))
    params = {"from": "2026-11-11", "to": "2026-11-14"}
    folder = env.client.get("/api/egenkontrol/folder", params=params, headers=env.h(o)).json()
    assert folder["missed"] == []
    assert folder["summary"]["slots_on_time"] == 1 and folder["summary"]["slots_missed"] == 0
    assert folder["summary"]["readings"] == 0          # the reading itself is outside the period
    per_check = _section(_pdf_text(env, o, **params), "Registreringer pr. kontrolpunkt",
                         "Fortrudte indtastninger")
    assert "Ikke registreret" not in per_check
    assert "10. nov 2026 kl. 08:00 −18,0 °C kl. 09:00" in per_check   # the reading that filled it
    assert "Til tiden" in per_check


def test_a_weekly_slot_with_no_reading_that_week_is_still_missed(env):
    env.clock.set(datetime(2026, 11, 9, 6, 30))
    o = env.owner()
    frost = env.setup(o, items=[{"template_key": "freezer", "name": "Frost 1",
                                 "schedule": {"type": "weekly", "weekday": 4, "due": "08:00"}}])
    fid = frost["freezer"]["id"]
    # A reading in the NEXT week (Monday 16 Nov) never fills the 13 Nov slot.
    env.clock.set(datetime(2026, 11, 16, 8, 0))
    assert env.save(o, fid, -18.0).status_code == 201
    env.clock.set(datetime(2026, 11, 16, 9, 0))
    params = {"from": "2026-11-11", "to": "2026-11-14"}
    folder = env.client.get("/api/egenkontrol/folder", params=params, headers=env.h(o)).json()
    assert [m["date"] for m in folder["missed"]] == ["2026-11-13"]
    per_check = _section(_pdf_text(env, o, **params), "Registreringer pr. kontrolpunkt",
                         "Fortrudte indtastninger")
    assert "13. nov 2026 kl. 08:00 – – – Ikke registreret" in per_check


# ── 9. "For sent · registreret kl. …" names the slot's own reading ─────

def test_done_late_names_the_reading_that_filled_the_slot(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    env.clock.set(datetime(2026, 11, 12, 8, 30))       # 09:30 local, frist 08:00
    assert env.save(o, fridge, 3.0).status_code == 201
    env.clock.set(datetime(2026, 11, 12, 13, 0))       # 14:00 local, a second reading
    assert env.save(o, fridge, 3.2).status_code == 201
    row = next(c for c in env.today_json(o)["checks"] if c["id"] == fridge)
    assert row["status"] == "done_late"
    assert row["slot_entry"]["recorded_local"] == "09:30"
    assert row["slot_entry"]["slot_due_local"] == "08:00"
    assert row["last"]["recorded_local"] == "14:00"


def test_the_pg_trigger_narrows_the_four_mutable_columns_like_the_listener():
    """The Postgres half runs only with BONBOX_PG_TEST_URL (test_egenkontrol_pg);
    this pins the SQL the boot installs, so the two engines keep one rule."""
    import app.main as main
    from app.models.food_check import DEVIATION_STATES, VOID_REASONS
    fn = main._EK_ENTRY_GUARD_FN
    assert "NEW.deviation_state NOT IN ('open', 'closed')" in fn
    assert "OLD.deviation_state IS NULL OR NEW.deviation_state IS NULL" in fn
    assert "NEW.void_reason NOT IN ('undo', 'correction')" in fn     # Migration 089
    assert DEVIATION_STATES == ("open", "closed") and VOID_REASONS == ("undo", "correction")
