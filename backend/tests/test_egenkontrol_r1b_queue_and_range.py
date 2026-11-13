"""Egenkontrol R1b — the offline queue's server contract and the 92-day range.

  • client_id: three queued readings sent twice each are three rows.
  • client_business_date: a reading typed on another business day is refused
    409 business_day_changed with NO row — but a replay of a saved client_id
    still answers 200 first (it already landed on its own day).
  • the folder and the PDF take up to 92 days (93 → 422), default 30; the
    kitchen keeps 30.
  • a dense 92-day PDF renders in reasonable time (printed; the assert is a
    runaway guard only).
"""
import io
import json
import time
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal

from pypdf import PdfReader

from app.models.food_check import FoodCheck, FoodCheckEntry, FoodCheckRevision
from tests._ek_support import T0, env  # noqa: F401 — fixture


def _body(check_id, value=3.0, **kw):
    return {"client_id": str(uuid.uuid4()), "check_id": check_id, "value_c": value,
            "typed_name": "Mia", **kw}


def test_three_queued_readings_sent_twice_are_three_rows(env):
    o = env.owner()
    c = env.setup(o)
    token = env.pair(o)
    bodies = [_body(c["fridge"]["id"], client_business_date="2026-11-12"),
              _body(c["freezer"]["id"], -20.0, client_business_date="2026-11-12"),
              _body(c["hot_holding"]["id"], 60.0)]
    first = [env.client.post("/api/egenkontrol/entries", json=b, headers=env.h(o)) for b in bodies]
    assert [r.status_code for r in first] == [201, 201, 201]
    again = [env.client.post("/api/egenkontrol/entries", json=b, headers=env.h(o)) for b in bodies]
    assert [r.status_code for r in again] == [200, 200, 200]
    assert all(r.json()["replayed"] is True for r in again)
    assert [r.json()["id"] for r in again] == [r.json()["id"] for r in first]
    k = _body(c["fridge"]["id"], 3.3, client_business_date="2026-11-12")
    assert env.client.post(f"/api/kitchen/{token}/entries", json=k).status_code == 201
    assert env.client.post(f"/api/kitchen/{token}/entries", json=k).status_code == 200
    env.db.expire_all()
    assert env.db.query(FoodCheckEntry).filter(FoodCheckEntry.user_id == o.id).count() == 4


def test_a_reading_from_another_business_day_is_refused_without_a_row(env):
    o = env.owner()
    c = env.setup(o)
    token = env.pair(o)
    saved = _body(c["fridge"]["id"], client_business_date="2026-11-12")
    assert env.client.post("/api/egenkontrol/entries", json=saved, headers=env.h(o)).status_code == 201
    env.clock.tick(days=1)                                        # the 13th
    stale = _body(c["fridge"]["id"], client_business_date="2026-11-12")
    for url, h in (("/api/egenkontrol/entries", env.h(o)), (f"/api/kitchen/{token}/entries", None)):
        r = env.client.post(url, json=stale, headers=h)
        assert r.status_code == 409, r.text
        assert r.json()["detail"] == {"code": "business_day_changed",
                                      "server_business_date": "2026-11-13"}
    # a replay of the already-saved reading is still 200
    r = env.client.post("/api/egenkontrol/entries", json=saved, headers=env.h(o))
    assert r.status_code == 200 and r.json()["replayed"] is True
    # old clients (no client_business_date) are not checked
    assert env.client.post("/api/egenkontrol/entries", json=_body(c["fridge"]["id"]),
                           headers=env.h(o)).status_code == 201
    r = env.client.post("/api/egenkontrol/entries", headers=env.h(o),
                        json=_body(c["fridge"]["id"], client_business_date="2026-11-13"))
    assert r.status_code == 201
    env.db.expire_all()
    assert env.db.query(FoodCheckEntry).filter(FoodCheckEntry.user_id == o.id).count() == 3


def test_92_days_ok_93_refused_default_30(env):
    o = env.owner()
    env.setup(o)
    h = env.h(o)
    for url in ("/api/egenkontrol/folder", "/api/egenkontrol/folder.pdf"):
        r = env.client.get(url, params={"from": "2026-08-13", "to": "2026-11-12"}, headers=h)
        assert r.status_code == 200, (url, r.text)
        r = env.client.get(url, params={"from": "2026-08-12", "to": "2026-11-12"}, headers=h)
        assert r.status_code == 422 and r.json()["detail"] == {"code": "range_too_long", "max_days": 92}
    f = env.folder(o)
    assert f["from"] == "2026-10-14" and f["to"] == "2026-11-12"
    assert f["range"] == {"from": "2026-10-14", "to": "2026-11-12", "max_days": 92}
    f = env.folder(o, to="2026-11-10")
    assert f["from"] == "2026-10-12"
    token = env.pair(o)
    assert env.client.get(f"/api/kitchen/{token}/folder", params={"days": 31}).status_code == 422
    kf = env.client.get(f"/api/kitchen/{token}/folder").json()
    assert kf["range"]["max_days"] == 30 and kf["from"] == "2026-10-14"


def test_readings_only_on_request(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    env.save(o, fridge, 3.0)
    assert "readings" not in env.folder(o)
    f = env.folder(o, include_readings=1)
    assert len(f["readings"]) == 1 and f["readings"][0]["check_name"] == "Køl 1"
    assert env.client.get("/api/egenkontrol/folder", params={"include_readings": 2},
                          headers=env.h(o)).status_code == 422


def _dense(env, o, days=92, checks=12, per_day=2):
    """12 checks, daily, 2 readings a day, 92 days — written straight to the
    database (the API would take minutes)."""
    start = T0 - timedelta(days=days + 1)
    ids = []
    for i in range(checks):
        c = FoodCheck(user_id=o.id, kind="temp_max", template_key="fridge", group_key="temperatures",
                      name=f"Køl {i + 1}", sort_order=i, active=True, created_at=start)
        env.db.add(c)
        env.db.flush()
        rev = FoodCheckRevision(user_id=o.id, check_id=c.id, valid_from=start, name=c.name,
                                active=True, limit_c=Decimal("5.0"), limit_source="law",
                                schedule=json.dumps({"type": "daily", "due": "08:00"}),
                                action_codes=json.dumps(["thermostat_adjusted", "moved_goods", "other"]),
                                fate_codes=json.dumps(["moved", "discarded", "assessed_ok", "awaiting_recheck", "other"]),
                                recheck_min=30, created_at=start)
        env.db.add(rev)
        env.db.flush()
        ids.append((c.id, rev.id))
    first = date(2026, 11, 12) - timedelta(days=days - 1)
    for d in range(days):
        day = first + timedelta(days=d)
        for cid, rid in ids:
            for k in range(per_day):
                at = datetime.combine(day, datetime.min.time()) + timedelta(hours=7, minutes=5 + 300 * k)
                dev = (d + k) % 23 == 0
                env.db.add(FoodCheckEntry(
                    user_id=o.id, check_id=cid, revision_id=rid, client_id=str(uuid.uuid4()),
                    business_date=day, slot_due_at=at.replace(minute=0) if k == 0 else None,
                    recorded_at=at, value_c=Decimal("7.0") if dev else Decimal("3.5"),
                    limit_c=Decimal("5.0"), limit_direction="max", in_limit=not dev,
                    late=False, action_code="thermostat_adjusted" if dev else None,
                    fate_code="moved" if dev else None, deviation_state="closed" if dev else None,
                    staff_name="Mia", name_source="typed", via="kitchen"))
    env.db.commit()


def test_a_dense_92_day_pdf_renders(env):
    o = env.owner()
    _dense(env, o)
    t = time.perf_counter()
    r = env.client.get("/api/egenkontrol/folder.pdf", params={"from": "2026-08-13", "to": "2026-11-12"},
                       headers=env.h(o))
    seconds = time.perf_counter() - t
    assert r.status_code == 200, r.text
    pages = len(PdfReader(io.BytesIO(r.content)).pages)
    print(f"\n[ek-r1b] dense 92-day PDF: 12 checks x 2/day x 92 days = 2208 readings, "
          f"{pages} pages, {len(r.content) // 1024} kB, {seconds:.2f} s")
    assert seconds < 20, seconds                                   # runaway guard only
    t = time.perf_counter()
    f = env.client.get("/api/egenkontrol/folder", params={"from": "2026-08-13", "to": "2026-11-12",
                                                          "include_readings": 1}, headers=env.h(o))
    print(f"[ek-r1b] dense 92-day folder JSON (with readings): {len(f.content) // 1024} kB, "
          f"{time.perf_counter() - t:.2f} s")
    assert f.status_code == 200 and len(f.json()["readings"]) == 2208
