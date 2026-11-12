"""Egenkontrol R1b — "Ugens egenkontrol" (GET /week, POST /week/{iso}/reviewed).

The week card uses the folder's own code path, so its counts equal the
Kontrolmappe's for the same 7 days. A week is reviewed once; the 730-day
purge removes old reviews.
"""
import io
from datetime import datetime, timedelta

from pypdf import PdfReader

from app.models.food_check import FoodCheckReview
from tests._ek_support import env  # noqa: F401 — fixture

AFTER_WEEK_46 = datetime(2026, 11, 17, 9, 0)      # Tue 17 Nov 10:00 Copenhagen


def _dev(env, o, fridge, value=9.0):
    r = env.save(o, fridge, value, action_code="thermostat_adjusted", fate_code="moved")
    assert r.status_code == 201, r.text
    return r.json()


def test_the_default_week_follows_the_business_day(env):
    o = env.owner()
    env.setup(o)
    env.clock.set(datetime(2026, 11, 16, 4, 0))      # Mon 05:00 local = still Sunday's day
    w = env.client.get("/api/egenkontrol/week", headers=env.h(o))
    assert w.status_code == 200, w.text
    w = w.json()
    assert w["iso_week"] == "2026-W45" and w["start"] == "2026-11-02" and w["end"] == "2026-11-08"
    assert w["week_number"] == 45 and w["over"] is True
    assert w["has_activity"] is False                 # before the checks existed
    env.clock.set(datetime(2026, 11, 16, 6, 0))      # Mon 07:00: week 46 is "last week"
    assert env.client.get("/api/egenkontrol/week", headers=env.h(o)).json()["iso_week"] == "2026-W46"


def test_the_week_summary_is_the_folder_summary(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    env.clock.tick(minutes=40)
    _dev(env, o, fridge)
    env.clock.tick(days=1, hours=3)                    # 13 Nov, late reading
    env.save(o, fridge, 3.0)
    env.clock.set(AFTER_WEEK_46)
    w = env.client.get("/api/egenkontrol/week", params={"start": "2026-11-09"},
                       headers=env.h(o)).json()
    f = env.folder(o, **{"from": "2026-11-09", "to": "2026-11-15"})
    assert w["summary"] == f["summary"]
    assert w["has_activity"] is True and w["over"] is True and w["can_review"] is True
    assert w["summary"]["deviations"] == 1 and w["summary"]["slots_missed"] >= 1
    r = env.client.get("/api/egenkontrol/week", params={"start": "2026-11-10"}, headers=env.h(o))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_week"
    r = env.client.get("/api/egenkontrol/week", params={"start": "2026-11-23"}, headers=env.h(o))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_week"


def test_open_deviations_are_listed_whatever_the_day(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    env.save(o, fridge, 7.1, action_code="thermostat_adjusted", fate_code="awaiting_recheck")
    env.clock.set(AFTER_WEEK_46)
    w = env.client.get("/api/egenkontrol/week", headers=env.h(o)).json()
    assert [(d["check_name"], d["value_c"]) for d in w["open_deviations"]] == [("Køl 1", 7.1)]


def _three_days(env, o, fridge, n):
    out = []
    env.clock.tick(minutes=40)
    for i in range(n):
        out.append(_dev(env, o, fridge, 9.0 + i))
        env.clock.tick(days=1)
    return out


def test_repeat_hint_at_three_in_30_days(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    _three_days(env, o, fridge, 3)
    env.clock.set(AFTER_WEEK_46)
    w = env.client.get("/api/egenkontrol/week", params={"start": "2026-11-09"},
                       headers=env.h(o)).json()
    assert w["repeat_hints"] == [{"check_id": fridge, "check_name": "Køl 1", "count": 3, "days": 30}]
    f = env.folder(o, **{"from": "2026-11-09", "to": "2026-11-15"})
    assert f["repeat_hints"][0]["count"] == 3


def test_no_hint_at_two_and_a_corrected_typo_does_not_count(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    devs = _three_days(env, o, fridge, 3)
    r = env.correct(o, devs[-1]["id"], "typo", value_c=3.0)
    assert r.status_code == 201, r.text
    env.clock.set(AFTER_WEEK_46)
    w = env.client.get("/api/egenkontrol/week", params={"start": "2026-11-09"},
                       headers=env.h(o)).json()
    assert w["repeat_hints"] == []


def test_marking_a_week_reviewed(env):
    o = env.owner()
    env.setup(o)
    env.clock.set(AFTER_WEEK_46)
    r = env.client.post("/api/egenkontrol/week/2026-W46/reviewed",
                        json={"name": "  Mia <b>&</b> co  ", "note": "Køl 1 & 2 <i>ok</i>"},
                        headers=env.h(o))
    assert r.status_code == 201, r.text
    first = r.json()
    assert first["iso_week"] == "2026-W46" and first["week_start"] == "2026-11-09"
    assert first["week_end"] == "2026-11-15" and first["actor_name"] == "  Mia <b>&</b> co  "
    assert first["reviewed_local"] == "10:00" and first["reviewed_local_date"] == "2026-11-17"
    env.clock.tick(hours=2)
    again = env.client.post("/api/egenkontrol/week/2026-W46/reviewed",
                            json={"name": "Bo", "note": "other"}, headers=env.h(o))
    assert again.status_code == 200 and again.json()["replayed"] is True
    assert again.json()["actor_name"] == first["actor_name"]
    assert again.json()["reviewed_at"] == first["reviewed_at"]
    env.db.expire_all()
    assert env.db.query(FoodCheckReview).filter(FoodCheckReview.user_id == o.id).count() == 1
    w = env.client.get("/api/egenkontrol/week", params={"start": "2026-11-09"},
                       headers=env.h(o)).json()
    assert w["review"]["note"] == "Køl 1 & 2 <i>ok</i>" and w["can_review"] is False
    # an empty body is fine too (W45)
    assert env.client.post("/api/egenkontrol/week/2026-W45/reviewed",
                           headers=env.h(o)).status_code == 201


def test_review_refusals(env):
    o = env.owner()
    env.setup(o)
    env.clock.set(AFTER_WEEK_46)
    r = env.client.post("/api/egenkontrol/week/2026-W47/reviewed", json={}, headers=env.h(o))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "week_not_over"
    for bad in ("2026-46", "2026-W60", "W46", "2026-W4x"):
        r = env.client.post(f"/api/egenkontrol/week/{bad}/reviewed", json={}, headers=env.h(o))
        assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_week", bad
    r = env.client.post("/api/egenkontrol/week/2026-W46/reviewed", json={"name": "x" * 81},
                        headers=env.h(o))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "name_too_long"
    r = env.client.post("/api/egenkontrol/week/2026-W46/reviewed", json={"note": "x" * 281},
                        headers=env.h(o))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "note_too_long"
    m = env.member(o, "manager")
    assert env.client.post("/api/egenkontrol/week/2026-W46/reviewed", json={},
                           headers=env.h(m)).status_code == 403
    w = env.client.get("/api/egenkontrol/week", headers=env.h(m))
    assert w.status_code == 200 and w.json()["can_review"] is False
    for role in ("cashier", "viewer"):
        assert env.client.get("/api/egenkontrol/week",
                              headers=env.h(env.member(o, role))).status_code == 403
    assert env.client.get("/api/egenkontrol/week", headers=env.h(env.accountant(o))).status_code == 403


def test_the_pdf_prints_the_review_escaped(env):
    o = env.owner()
    env.setup(o)
    env.clock.set(AFTER_WEEK_46)
    env.client.post("/api/egenkontrol/week/2026-W46/reviewed",
                    json={"name": "Mia <b>&</b> co", "note": "Køl 1 & 2 <i>ok</i>"}, headers=env.h(o))
    r = env.client.get("/api/egenkontrol/folder.pdf", params={"from": "2026-11-09", "to": "2026-11-17"},
                       headers=env.h(o))
    assert r.status_code == 200
    text = " ".join(p.extract_text() for p in PdfReader(io.BytesIO(r.content)).pages)
    assert "Ugentlig gennemgang af registreringerne" in text
    flat = text.replace("\n", " ")
    assert "Uge 46 (9.–15. nov 2026) · gennemgået 17. nov 2026 kl. 10:00 · Mia <b>&</b> co" in flat
    assert "Note: Køl 1 & 2 <i>ok</i>" in flat
    empty = env.client.get("/api/egenkontrol/folder.pdf", params={"from": "2026-11-01", "to": "2026-11-08"},
                           headers=env.h(o))
    t2 = " ".join(p.extract_text() for p in PdfReader(io.BytesIO(empty.content)).pages)
    assert "Ingen ugentlig gennemgang registreret i perioden." in t2


def test_the_730_day_purge_removes_an_old_review(env, monkeypatch):
    from app.jobs import privacy_purges as pp
    o = env.owner()
    env.setup(o)
    env.clock.set(AFTER_WEEK_46)
    env.client.post("/api/egenkontrol/week/2026-W46/reviewed", json={}, headers=env.h(o))
    monkeypatch.setattr(pp, "SessionLocal", env.SL)
    assert pp.purge_old_egenkontrol_reviews(now=AFTER_WEEK_46 + timedelta(days=729))["deleted"] == 0
    assert pp.dry_run_counts(env.SL(), now=AFTER_WEEK_46 + timedelta(days=731))["egenkontrol_reviews"] == 1
    out = pp.purge_old_egenkontrol_reviews(now=AFTER_WEEK_46 + timedelta(days=731))
    assert out == {"due": 1, "deleted": 1, "dry_run": False}
    env.db.expire_all()
    assert env.db.query(FoodCheckReview).count() == 0
