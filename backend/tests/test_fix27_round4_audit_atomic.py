"""Fix round 4 (27 Oct, review2 #4) — an audit row is atomic with its change.

Round 1 put every audit row in a SAVEPOINT: a row that could not be written
was dropped and the change committed without it. Many rows are state, not a
log — the waitlist's HELD mark (the owner's "check this one" and the held
bounds count it), the "left" mark of an erased entry, daily_close.lock (the
Bogføringsloven trail), spam and its undo. Now a row that cannot be written
takes its change with it, as before 27 Oct; the caller's own conflict still
surfaces first (the 409 tests in test_fix27_conflicts_answer_409.py).

The insert is broken for one action only: AuditLog is built with action=None
(NOT NULL), so the flush fails for real.

Run: cd backend && python -m pytest tests/test_fix27_round4_audit_atomic.py -q
"""
from __future__ import annotations

import pytest

from app.models.audit_log import AuditLog
from app.services import audit_service
from app.services import public_waitlist as pwl
from tests.test_r12_guest_waitlist import (  # noqa: F401 — fixtures
    WED, _fill, _held_ids, _join, _rows, _venue, client, db, engine_and_session,
)


def _break(monkeypatch, action):
    """Every audit row for `action` fails at the INSERT (action NOT NULL)."""
    real = audit_service.AuditLog

    def build(**kw):
        if kw.get("action") == action:
            kw["action"] = None
        return real(**kw)

    monkeypatch.setattr(audit_service, "AuditLog", build)


def test_a_held_join_whose_held_mark_cannot_be_written_keeps_no_row(client, db, monkeypatch):
    """The HELD mark is what keeps a held row out of the owner's normal list
    and inside the held bounds — a row without it would pass as a guest's."""
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, WED)
    ok = _join(client, profile, WED, guest_phone="+45 30 30 30 30")
    assert ok.status_code == 201, ok.text                      # a real join (control)
    _break(monkeypatch, pwl.HELD_ACTION)
    with pytest.raises(Exception):
        # The trap field filled: held.
        _join(client, profile, WED, guest_phone="+45 40 40 40 40", website="http://x.example")
    rows = _rows(db, owner)
    assert [r.guest_phone for r in rows] == ["+45 30 30 30 30"]   # the held one is not kept
    assert _held_ids(db, owner) == set()


def test_leaving_whose_left_mark_cannot_be_written_erases_nothing(client, db, monkeypatch):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, WED)
    j = _join(client, profile, WED).json()
    _break(monkeypatch, pwl.LEFT_ACTION)
    with pytest.raises(Exception):
        client.post(f"/api/public/reservations/booking/waitlist/{j['id']}/cancel",
                    params={"token": j["waitlist_token"]})
    (row,) = _rows(db, owner)
    assert row.purged_at is None and row.guest_name == "Agnes"   # not erased without its mark
    assert db.query(AuditLog).filter(AuditLog.action == pwl.LEFT_ACTION).count() == 0


def test_a_written_mark_commits_with_its_change(client, db):
    """Control: nothing broken, the left mark and the erase commit together."""
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, WED)
    j = _join(client, profile, WED).json()
    r = client.post(f"/api/public/reservations/booking/waitlist/{j['id']}/cancel",
                    params={"token": j["waitlist_token"]})
    assert r.status_code == 200, r.text
    (row,) = _rows(db, owner)
    assert row.purged_at is not None
    assert db.query(AuditLog).filter(AuditLog.action == pwl.LEFT_ACTION).count() == 1
