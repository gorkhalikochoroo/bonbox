"""Fix round 4 (27 Oct, review2 #1) — a repeat join tells nobody the number
is on the list, also once the night's held rows are full.

A repeat join (the same phone, the same night) is stored as a HELD shadow row
— the same answer as a first join. Past the night's held bound it used to get
a stand-in: a receipt with a signed token for an id with no row behind it, so
its GET answered 404 where a first join's answered 200. Fifteen fast-fill
joins filled the bound, and then any number could be probed. Now the repeat
row is always written: join, receipt, leave and the receipt after leaving
answer as a first join's do.

Run: cd backend && python -m pytest tests/test_fix27_round4_waitlist_repeat.py -q
"""
from __future__ import annotations

from app.services import public_waitlist as pwl
from tests.test_r12_guest_waitlist import (  # noqa: F401 — fixtures
    WED, _fill, _held_ids, _join, _rows, _venue, client, db, engine_and_session,
)


def _receipt(client, body):
    return client.get(f"/api/public/reservations/booking/waitlist/{body['id']}",
                      params={"token": body["waitlist_token"]})


def _leave(client, body):
    return client.post(f"/api/public/reservations/booking/waitlist/{body['id']}/cancel",
                       params={"token": body["waitlist_token"]})


def _shape(r):
    return r.status_code, sorted(r.json().keys()), r.json().get("status"), r.json().get("erased")


def test_a_repeat_join_past_the_held_bound_answers_as_a_first_join(client, db, monkeypatch):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, WED)
    guest = _join(client, profile, WED, guest_phone="+45 30 30 30 30")      # on the list
    assert guest.status_code == 201, guest.text
    monkeypatch.setattr(pwl, "HELD_PER_NIGHT", 0)                          # the held bound: full
    repeat = _join(client, profile, WED, guest_phone="+45 30 30 30 30", guest_name="Probe")
    first = _join(client, profile, WED, guest_phone="+45 40 40 40 40", guest_name="Probe")
    # The join: the same status and the same keys.
    assert repeat.status_code == first.status_code == 201
    assert sorted(repeat.json().keys()) == sorted(first.json().keys())
    assert repeat.json()["status"] == first.json()["status"] == "waiting"
    # The receipt: a stored row behind both — 200 and the same shape.
    r_get, f_get = _receipt(client, repeat.json()), _receipt(client, first.json())
    assert r_get.status_code == f_get.status_code == 200, (r_get.text, f_get.text)
    assert _shape(r_get) == _shape(f_get)
    # Leaving, and reading the receipt after it: the same again.
    assert _shape(_leave(client, repeat.json())) == _shape(_leave(client, first.json()))
    assert _shape(_receipt(client, repeat.json())) == _shape(_receipt(client, first.json()))
    # The repeat is a held shadow row; the guest's own entry is untouched.
    rows = _rows(db, owner)
    assert len(rows) == 3
    assert str(rows[1].id) in _held_ids(db, owner)
    assert rows[0].guest_name == "Agnes" and rows[0].purged_at is None


def test_a_robot_like_join_past_the_held_bound_still_writes_nothing(client, db, monkeypatch):
    """Control: the held bound still holds for robot-like joins (the trap at
    a person's pace) — a stand-in, whether the number is on the list or not."""
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, WED)
    _join(client, profile, WED, guest_phone="+45 30 30 30 30")
    monkeypatch.setattr(pwl, "HELD_PER_NIGHT", 0)
    for phone in ("+45 30 30 30 30", "+45 50 50 50 50"):
        r = _join(client, profile, WED, guest_phone=phone, website="http://x.example")
        assert r.status_code == 201
        assert _receipt(client, r.json()).status_code == 404
    assert len(_rows(db, owner)) == 1
