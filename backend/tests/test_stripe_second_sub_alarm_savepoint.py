"""Combined fix round (11 Oct): a failing double-billing alarm statement can
never cost the relink it reports.

_alarm_second_live_subscription caught its own errors, but on Postgres a
failed statement aborts the WHOLE transaction: the dedupe SELECT on
error_logs failing (a statement timeout, a lock) left every later statement
of the webhook failing with InFailedSqlTransaction — the audit row, the
user UPDATE, the commit. The webhook answered 500 and Stripe retried; the
alarm meant to report a double billing broke the billing write. The lookup
and the insert now run in a SAVEPOINT (db.begin_nested()).

SQLite does not abort a transaction on a failed statement, so these tests
make the error_logs statement fail AT THE DATABASE (a real SQL error, not a
patched constructor) and emulate Postgres's aborted-transaction rule on the
engine: after the failure every statement fails until ROLLBACK [TO
SAVEPOINT]. Then they assert the relink and the plan commit,
and pin the SAVEPOINT / ROLLBACK TO SAVEPOINT around the failing statement.

Run: cd backend && python3 -m pytest tests/test_stripe_second_sub_alarm_savepoint.py -q
"""
from __future__ import annotations

import json
import time
from datetime import timedelta
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401 — register all models
from app.config import settings
from app.database import Base
from app.models.error_log import ErrorLog
from app.models.user import User
from app.services import stripe_billing as sb
from app.utils.time import utc_now

ALARM = "Billing:SecondLiveSubscription"
_FAIL_SQL = "SELECT * FROM no_such_table_for_this_test"


@pytest.fixture
def engine():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return eng


@pytest.fixture
def db(engine):
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield s
    finally:
        s.close()


class _PostgresAbort:
    """Fail the first statement matching `match` at the database, then fail
    every statement until a ROLLBACK / ROLLBACK TO SAVEPOINT — what Postgres
    does to a transaction after an error (InFailedSqlTransaction)."""

    def __init__(self, engine, match):
        self.engine, self.match = engine, match
        self.aborted = False
        self.fired = False
        self.ran: list[str] = []

    def _before(self, conn, cursor, statement, parameters, context, executemany):
        up = statement.lstrip().upper()
        if up.startswith("ROLLBACK"):
            self.aborted = False
        elif self.aborted:
            statement, parameters = _FAIL_SQL, ()
        elif not self.fired and self.match(up):
            self.fired = True
            self.aborted = True
            statement, parameters = _FAIL_SQL, ()
        self.ran.append(statement)
        return statement, parameters

    def _rollback(self, conn):
        self.aborted = False

    def __enter__(self):
        event.listen(self.engine, "before_cursor_execute", self._before, retval=True)
        event.listen(self.engine, "rollback", self._rollback)
        return self

    def __exit__(self, *exc):
        event.remove(self.engine, "before_cursor_execute", self._before)
        event.remove(self.engine, "rollback", self._rollback)

    def assert_inside_a_savepoint(self):
        ran = [s.strip().upper() for s in self.ran]
        i = ran.index(_FAIL_SQL.upper())
        assert any(s.startswith("SAVEPOINT") for s in ran[:i]), ran
        assert any(s.startswith("ROLLBACK TO SAVEPOINT") for s in ran[i:]), ran


def _sub(sub_id):
    ts = int(time.time()) + 30 * 86400
    return {"id": sub_id, "status": "active", "current_period_end": ts,
            "items": {"data": [{"price": {"id": "price_pro"}, "current_period_end": ts}]},
            "latest_invoice": {"status": "paid", "paid": True}}


def _subscriber(db, status="active"):
    u = User(email="savepoint@alarm.dk", password_hash="x", business_name="T",
             currency="DKK", plan="pro", stripe_customer_id="cus_sp",
             stripe_subscription_id="sub_A", subscription_status=status,
             subscription_period_end=utc_now() + timedelta(days=20),
             created_at=utc_now() - timedelta(days=40))
    db.add(u)
    db.commit()
    return u.id


def _deliver(db, evt):
    mock = MagicMock()
    mock.Subscription.retrieve.side_effect = lambda sid: _sub(sid)
    with patch.object(sb, "_stripe", return_value=mock), \
         patch.object(settings, "STRIPE_WEBHOOK_SECRET", "whsec_test"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro"):
        return sb.handle_webhook(json.dumps(evt).encode(), "sig", db)


def _created(eid):
    return {"id": eid, "type": "customer.subscription.created",
            "data": {"object": {"id": "sub_B", "customer": "cus_sp", "status": "active"}}}


def _checkout_unpaid(eid):
    # The async-pending checkout path: links the subscription and commits.
    return {"id": eid, "type": "checkout.session.completed",
            "data": {"object": {"id": "cs_B", "customer": "cus_sp", "subscription": "sub_B",
                                "payment_status": "unpaid"}}}


def _fresh(engine):
    return sessionmaker(bind=engine)()


def _is_alarm_select(up):
    return up.startswith("SELECT") and "ERROR_LOGS" in up


def _is_alarm_insert(up):
    return up.startswith("INSERT INTO ERROR_LOGS")


@pytest.mark.parametrize("match", [_is_alarm_select, _is_alarm_insert],
                         ids=["dedupe_select_fails", "insert_fails"])
def test_a_failing_alarm_statement_still_commits_the_relink(engine, db, match):
    uid = _subscriber(db)
    with _PostgresAbort(engine, match) as pg:
        r = _deliver(db, _created("evt_sp_" + match.__name__))
    assert pg.fired, "the alarm statement never ran — the test proves nothing"
    assert r["status"] == "ok"
    pg.assert_inside_a_savepoint()
    s = _fresh(engine)
    try:
        u = s.get(User, uid)
        assert u.stripe_subscription_id == "sub_B"
        assert u.subscription_status == "active" and u.plan == "pro"
        # Only the alarm row is lost (the operator still has the log.error line).
        assert s.query(ErrorLog).filter(ErrorLog.error_type == ALARM).count() == 0
    finally:
        s.close()


def test_checkout_path_survives_a_failing_dedupe_select(engine, db):
    uid = _subscriber(db)
    with _PostgresAbort(engine, _is_alarm_select) as pg:
        r = _deliver(db, _checkout_unpaid("evt_sp_checkout"))
    assert pg.fired and r["status"] == "ok"
    pg.assert_inside_a_savepoint()
    s = _fresh(engine)
    try:
        assert s.get(User, uid).stripe_subscription_id == "sub_B"
    finally:
        s.close()


def test_the_healthy_alarm_still_lands_with_the_relink(engine, db):
    uid = _subscriber(db)
    assert _deliver(db, _created("evt_sp_ok"))["status"] == "ok"
    s = _fresh(engine)
    try:
        rows = s.query(ErrorLog).filter(ErrorLog.error_type == ALARM).all()
        assert [r.message.split(" | ")[0] for r in rows] == [
            "second live subscription: sub_A -> sub_B"]
        assert s.get(User, uid).stripe_subscription_id == "sub_B"
    finally:
        s.close()


# Review (12 Oct): a lost alarm row must not be lost silently ────────────────
MARKER = "BILLING_ALARM_UNRECORDED"


@pytest.mark.parametrize("match", [_is_alarm_select, _is_alarm_insert],
                         ids=["dedupe_select_fails", "insert_fails"])
def test_a_lost_alarm_row_logs_critical_with_ids_only(engine, db, match, caplog):
    """The R-i ops-alert path needs the DB (dedupe, cooldown and cap rows), so
    the out-of-band trace is one CRITICAL log line with a stable marker and
    ids only — never the owner's e-mail or business name."""
    uid = _subscriber(db)
    caplog.set_level("INFO", logger="bonbox.stripe")
    with _PostgresAbort(engine, match) as pg:
        r = _deliver(db, _created("evt_lost_" + match.__name__))
    assert pg.fired and r["status"] == "ok"
    crit = [rec for rec in caplog.records
            if rec.levelname == "CRITICAL" and MARKER in rec.getMessage()]
    assert len(crit) == 1, [rec.getMessage() for rec in caplog.records]
    msg = crit[0].getMessage()
    for part in (str(uid), "sub_A", "sub_B", "evt_lost_" + match.__name__):
        assert part in msg, msg
    assert "savepoint@alarm.dk" not in msg and "business" not in msg.lower()
    s = _fresh(engine)
    try:
        assert s.get(User, uid).stripe_subscription_id == "sub_B"   # relink still commits
    finally:
        s.close()


def test_a_healthy_alarm_logs_no_critical(engine, db, caplog):
    _subscriber(db)
    caplog.set_level("INFO", logger="bonbox.stripe")
    assert _deliver(db, _created("evt_ok_nocrit"))["status"] == "ok"
    assert not [rec for rec in caplog.records if MARKER in rec.getMessage()]
