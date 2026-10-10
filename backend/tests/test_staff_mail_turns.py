"""SEC-1/SEC-10 fix-up (R-f review, 10 Oct): the staff-mail ceilings hold
under concurrency.

The review found the daily ceilings were check-then-act: each request or
background task read the audit_logs count, called the mail provider (a slow
network round trip) and only then wrote its `staff_mail.sent` row. Twelve
shift edits at the same moment, one mail left under the per-mailbox ceiling,
delivered twelve mails (real uvicorn, 10 Oct). Now every staff mail is one
"turn" per owner (services/staff_mail_guard.StaffMailGate.turn): the count is
re-read under an owner lock, the mail is sent and its counter row committed
before the next turn starts.

These run real threads, each with its own Session, against a file SQLite
database (an in-memory StaticPool shares one connection and cannot race).
"""
import json
import threading
import time
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.audit_log import AuditLog
from app.models.staff import NotificationLog, StaffMember
from app.models.user import User
from app.services import notification_service as ns
from app.services import staff_mail_guard as guard
from app.services.auth import hash_password
from app.services.notification_service import ShiftChange

SEND_DELAY_S = 0.15  # a mail provider round trip, shortened


@pytest.fixture
def SL(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'turns.db'}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    Base.metadata.create_all(engine)
    try:
        yield sessionmaker(bind=engine)
    finally:
        engine.dispose()


@pytest.fixture
def slow_mails(monkeypatch):
    out: list[str] = []
    lock = threading.Lock()

    def _send_email(to=None, subject=None, html=None, **k):
        time.sleep(SEND_DELAY_S)
        with lock:
            out.append(to)
        return True

    monkeypatch.setattr(ns, "send_email", _send_email)
    return out


@pytest.fixture
def pushes(monkeypatch):
    out: list[str] = []
    lock = threading.Lock()

    def _push(**k):
        with lock:
            out.append(str(k["staff_id"]))
        return {"attempted": 1, "sent": 1, "removed": 0}

    monkeypatch.setattr(ns, "_send_staff_schedule_push", _push)
    return out


def _seed(SL, *, staff=1, prior=0, prior_address="anna@cafe.dk", prior_spread=False):
    db = SL()
    try:
        owner = User(
            email="owner@bonbox.dk", password_hash=hash_password("ownerpw123"),
            business_name="Bon Bistro", business_type="cafe", currency="DKK",
            plan="pro", role="owner", timezone="Europe/Copenhagen",
            email_verified=True,
        )
        db.add(owner)
        db.commit()
        ids = []
        for i in range(staff):
            s = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=f"S{i}",
                            role="server", active=True, is_deleted=False,
                            email="anna@cafe.dk" if i == 0 else f"s{i}@cafe.dk")
            db.add(s)
            ids.append(s.id)
        for i in range(prior):
            addr = f"x{i}@cafe.dk" if prior_spread else prior_address
            db.add(AuditLog(user_id=owner.id, actor_type="system.staff_mail",
                            action=guard.STAFF_MAIL_ACTION, entity_type="staff_member",
                            after_state=json.dumps({"r": guard.recipient_key(addr), "kind": "x"})))
        db.commit()
        return owner.id, ids
    finally:
        db.close()


def _change(day=25):
    return ShiftChange(change_type="modified", date=f"2026-11-{day:02d}",
                       old_start="10:00", old_end="16:00",
                       new_start="11:00", new_end="17:00", role="server")


def _race(SL, n, target):
    """n threads, each on its own Session, released at the same moment."""
    barrier = threading.Barrier(n)
    errors: list[BaseException] = []

    def run(i):
        db = SL()
        try:
            barrier.wait()
            target(db, i)
        except BaseException as e:  # noqa: BLE001
            errors.append(e)
        finally:
            db.close()

    ts = [threading.Thread(target=run, args=(i,)) for i in range(n)]
    [t.start() for t in ts]
    [t.join(60) for t in ts]
    assert errors == []


def _count(SL, model, **filters):
    db = SL()
    try:
        return db.query(model).filter_by(**filters).count()
    finally:
        db.close()


# ─── the ceilings hold under concurrency ─────────────────────────────────


def test_concurrent_edits_send_exactly_the_one_mail_left_for_a_mailbox(SL, slow_mails, pushes):
    cap = guard.STAFF_MAIL_RECIPIENT_DAILY_CAP
    owner_id, (anna,) = _seed(SL, prior=cap - 1)
    n = 8
    _race(SL, n, lambda db, i: ns.send_single_shift_notification(
        db, owner_id, anna, _change(10 + i), "shift_changed"))
    assert slow_mails == ["anna@cafe.dk"], "one mail was left under the ceiling"
    assert _count(SL, AuditLog, action=guard.STAFF_MAIL_ACTION) == cap
    # Every staffer still hears in the app and by push.
    assert len(pushes) == n
    assert _count(SL, NotificationLog, staff_id=anna) == n


def test_concurrent_sends_respect_the_owner_ceiling(SL, slow_mails, pushes):
    cap = guard.STAFF_MAIL_OWNER_DAILY_CAP
    n = 6
    owner_id, ids = _seed(SL, staff=n, prior=cap - 1, prior_spread=True)
    _race(SL, n, lambda db, i: ns.send_single_shift_notification(
        db, owner_id, ids[i], _change(), "shift_changed"))
    assert len(slow_mails) == 1
    assert _count(SL, AuditLog, action=guard.STAFF_MAIL_ACTION) == cap
    assert len(pushes) == n


def test_concurrent_publish_batches_and_edits_share_one_ceiling(SL, slow_mails, pushes):
    cap = guard.STAFF_MAIL_RECIPIENT_DAILY_CAP
    owner_id, (anna,) = _seed(SL, prior=cap - 2)

    def go(db, i):
        if i % 2:
            ns.send_shift_notifications(db, owner_id, {str(anna): [_change()]},
                                        "Uge 48", lang="da")
        else:
            ns.send_single_shift_notification(db, owner_id, anna, _change(), "shift_changed")

    _race(SL, 6, go)
    assert len(slow_mails) == 2
    assert _count(SL, AuditLog, action=guard.STAFF_MAIL_ACTION) == cap


def test_concurrent_mails_under_the_ceiling_all_go(SL, slow_mails, pushes):
    """The lock makes concurrent mails wait their turn — it does not drop them."""
    n = 5
    owner_id, ids = _seed(SL, staff=n)
    _race(SL, n, lambda db, i: ns.send_single_shift_notification(
        db, owner_id, ids[i], _change(), "shift_changed"))
    assert len(slow_mails) == n
    assert _count(SL, AuditLog, action=guard.STAFF_MAIL_ACTION) == n


def test_a_turn_that_cannot_start_in_time_mails_nobody(SL, slow_mails, pushes, monkeypatch):
    """Fail closed: when the owner's previous mail does not finish within the
    wait, this one is not sent — the in-app alert and the push still go."""
    owner_id, (anna,) = _seed(SL)
    monkeypatch.setattr(guard, "STAFF_MAIL_TURN_WAIT_S", 0.2)
    held = threading.Event()
    release = threading.Event()

    def holder():
        lock = guard._owner_turn_lock(owner_id)
        with lock:
            held.set()
            release.wait(10)

    t = threading.Thread(target=holder)
    t.start()
    try:
        assert held.wait(5)
        db = SL()
        try:
            ns.send_single_shift_notification(db, owner_id, anna, _change(), "shift_changed")
        finally:
            db.close()
    finally:
        release.set()
        t.join(10)
    assert slow_mails == []
    assert pushes == [str(anna)]
    assert _count(SL, NotificationLog, staff_id=anna, channel="in_app") == 1


def test_a_failed_send_records_nothing_and_frees_the_turn(SL, pushes, monkeypatch):
    owner_id, (anna,) = _seed(SL)
    calls = []
    monkeypatch.setattr(ns, "send_email", lambda **k: calls.append(k["to"]) or False)
    db = SL()
    try:
        ns.send_single_shift_notification(db, owner_id, anna, _change(), "shift_changed")
        ns.send_single_shift_notification(db, owner_id, anna, _change(), "shift_changed")
    finally:
        db.close()
    assert calls == ["anna@cafe.dk", "anna@cafe.dk"]
    assert _count(SL, AuditLog, action=guard.STAFF_MAIL_ACTION) == 0
    assert _count(SL, NotificationLog, staff_id=anna, status="failed") == 2


def test_a_waiting_mail_holds_no_database_connection(tmp_path, slow_mails, pushes):
    """A burst of shift edits queues on the owner's turn. Waiting must not
    hold a pooled connection, or one owner's burst could take the pool from
    every other venue. One connection in the pool: while an edit waits for
    its turn, another session can still use the database."""
    engine = create_engine(
        f"sqlite:///{tmp_path / 'pool.db'}",
        connect_args={"check_same_thread": False, "timeout": 30},
        pool_size=1, max_overflow=0, pool_timeout=3,
    )
    Base.metadata.create_all(engine)
    SLp = sessionmaker(bind=engine)
    owner_id, (anna,) = _seed(SLp)
    held, release, done = threading.Event(), threading.Event(), threading.Event()

    def holder():
        with guard._owner_turn_lock(owner_id):
            held.set()
            release.wait(10)

    def edit():
        db = SLp()
        try:
            ns.send_single_shift_notification(db, owner_id, anna, _change(), "shift_changed")
        finally:
            db.close()
            done.set()

    t = threading.Thread(target=holder)
    t.start()
    try:
        assert held.wait(5)
        e = threading.Thread(target=edit)
        e.start()
        time.sleep(0.5)  # the edit has reached its turn and waits
        assert not done.is_set()
        s = SLp()
        try:
            assert s.query(User).count() == 1, "the only pooled connection is free"
        finally:
            s.close()
    finally:
        release.set()
        t.join(10)
    e.join(30)
    assert done.is_set()
    assert slow_mails == ["anna@cafe.dk"], "it was sent once its turn came"
    engine.dispose()


# ─── push-2 review: the per-owner process locks are bounded ──────────────
#
# _turn_locks used to keep one lock per owner who ever mailed staff, for the
# life of the process. An entry now lives only while a turn holds the lock or
# waits for it; the last one out removes it.


def test_the_turn_lock_entry_is_dropped_once_no_turn_holds_or_waits(SL, slow_mails, pushes):
    before = len(guard._turn_locks)
    owner_id, ids = _seed(SL, staff=3)
    db = SL()
    try:
        for sid in ids:
            ns.send_single_shift_notification(db, owner_id, sid, _change(), "shift_changed")
    finally:
        db.close()
    assert len(slow_mails) == 3, "the mails went"
    assert guard._turn_key(owner_id) not in guard._turn_locks, "no turn in flight, no entry kept"
    assert len(guard._turn_locks) == before


def test_many_owners_leave_no_entries_behind():
    before = len(guard._turn_locks)
    for _ in range(500):
        lock = guard._owner_turn_lock(uuid.uuid4())
        assert lock.acquire(timeout=1)
        lock.release()
    assert len(guard._turn_locks) == before


def test_a_waiting_turn_keeps_the_entry_and_a_timed_out_one_lets_go():
    owner_id = uuid.uuid4()
    key = guard._turn_key(owner_id)
    held, release = threading.Event(), threading.Event()

    def holder():
        with guard._owner_turn_lock(owner_id):
            held.set()
            release.wait(10)

    t = threading.Thread(target=holder)
    t.start()
    try:
        assert held.wait(5)
        assert guard._turn_locks[key].users == 1
        waiting = threading.Event()
        outcome = []

        def waiter():
            waiting.set()
            outcome.append(guard._owner_turn_lock(owner_id).acquire(timeout=0.3))

        w = threading.Thread(target=waiter)
        w.start()
        assert waiting.wait(5)
        time.sleep(0.1)
        assert guard._turn_locks[key].users == 2, "a waiting turn keeps the entry"
        w.join(5)
        assert outcome == [False]
        assert guard._turn_locks[key].users == 1, "a turn that gave up let go"
    finally:
        release.set()
        t.join(10)
    assert key not in guard._turn_locks


def test_dropping_entries_never_lets_two_turns_of_one_owner_overlap():
    """Turns for a few owners from many threads: within one owner never two
    at once (an entry dropped and re-made while someone waited on the old
    lock would allow that), and nothing is left afterwards."""
    owners = [uuid.uuid4() for _ in range(3)]
    inside = {o: 0 for o in owners}
    overlaps: list[uuid.UUID] = []
    counter = threading.Lock()
    n_threads, rounds = 12, 200
    barrier = threading.Barrier(n_threads)
    errors: list[BaseException] = []

    def run(i):
        try:
            barrier.wait()
            for r in range(rounds):
                o = owners[(i + r) % len(owners)]
                lock = guard._owner_turn_lock(o)
                assert lock.acquire(timeout=10)
                try:
                    with counter:
                        inside[o] += 1
                        if inside[o] > 1:
                            overlaps.append(o)
                    time.sleep(0)  # yield inside the turn
                    with counter:
                        inside[o] -= 1
                finally:
                    lock.release()
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    ts = [threading.Thread(target=run, args=(i,)) for i in range(n_threads)]
    [t.start() for t in ts]
    [t.join(60) for t in ts]
    assert errors == []
    assert overlaps == []
    assert not any(guard._turn_key(o) in guard._turn_locks for o in owners)


def test_a_reentrant_turn_in_one_thread_still_works_and_cleans_up():
    owner_id = uuid.uuid4()
    outer = guard._owner_turn_lock(owner_id)
    with outer:
        with guard._owner_turn_lock(owner_id):  # same thread: an RLock
            assert guard._turn_locks[guard._turn_key(owner_id)].users == 2
        assert guard._turn_locks[guard._turn_key(owner_id)].users == 1
    assert guard._turn_key(owner_id) not in guard._turn_locks
