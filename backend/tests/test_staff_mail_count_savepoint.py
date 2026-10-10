"""SEC-1/SEC-10 fix-up (R-f review, 10 Oct): an unreadable staff-mail count
never poisons the caller's transaction.

third_party_sends caught a failing count and returned None (no mail: fail
closed), but on Postgres a failed statement aborts the whole transaction:
every later statement of the caller failed with InFailedSqlTransaction. A
publish answered 500 with the week already published and its background
notifications never scheduled; a shift edit lost its in-app alert. Reproduced
on Postgres 16 by the review. The count (and the "did you create this
account?" lookup, same pattern) now runs in a SAVEPOINT.

SQLite does not abort the transaction on a failed statement, so these pin the
savepoint itself: the failing statement must run after a SAVEPOINT and be
followed by ROLLBACK TO SAVEPOINT.
"""
import uuid

from sqlalchemy import event

from app.models.staff import NotificationLog
from app.models.user import User
from app.services import notification_service as ns
from app.services import revisor_mail
from app.services import staff_mail_guard as guard
from tests.test_staff_mail_guard import (  # noqa: F401 — fixtures + builders
    SL, _change, _owner, _staff, db, mails, pushes,
)


def _fail(engine, statements, needle):
    """Make every statement touching `needle` fail AT THE DATABASE (a real SQL
    error, as a statement timeout would be on Postgres); record what ran."""
    def before(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT") and needle in statement:
            statement, parameters = "SELECT * FROM no_such_table_for_this_test", ()
        statements.append(statement)
        return statement, parameters
    event.listen(engine, "before_cursor_execute", before, retval=True)
    return before


def _assert_inside_a_savepoint(statements):
    ran = [s.strip().upper() for s in statements]
    i = next(k for k, s in enumerate(ran) if "NO_SUCH_TABLE" in s)
    assert any(s.startswith("SAVEPOINT") for s in ran[:i]), ran
    assert any(s.startswith("ROLLBACK TO SAVEPOINT") for s in ran[i:]), ran


def test_count_failure_runs_inside_a_savepoint(db):
    owner = _owner(db)
    statements: list[str] = []
    engine = db.get_bind()
    hook = _fail(engine, statements, "audit_logs")
    try:
        assert revisor_mail.third_party_sends(db, owner, (guard.STAFF_MAIL_ACTION,)) is None
        _assert_inside_a_savepoint(statements)
        # The session is still usable.
        db.add(NotificationLog(id=uuid.uuid4(), user_id=owner.id, channel="in_app",
                               event_type="shift_changed", subject="x", status="sent"))
        db.commit()
    finally:
        event.remove(engine, "before_cursor_execute", hook)


def test_claim_question_lookup_failure_runs_inside_a_savepoint(db):
    owner = _owner(db)
    statements: list[str] = []
    engine = db.get_bind()
    hook = _fail(engine, statements, "account_claim_tickets")
    try:
        assert revisor_mail.claim_question_pending(db.get(User, owner.id)) is True, "fails closed"
        _assert_inside_a_savepoint(statements)
    finally:
        event.remove(engine, "before_cursor_execute", hook)


def test_single_shift_in_app_row_survives_a_failing_count(db, mails, pushes):
    owner = _owner(db)
    anna = _staff(db, owner)
    owner_id, anna_id = owner.id, anna.id
    statements: list[str] = []
    engine = db.get_bind()
    hook = _fail(engine, statements, "audit_logs")
    try:
        ns.send_single_shift_notification(db, owner_id, anna_id, _change(), "shift_changed")
    finally:
        event.remove(engine, "before_cursor_execute", hook)
    assert mails == [], "fail closed: no mail without a count"
    assert pushes == [str(anna_id)]
    assert db.query(NotificationLog).filter_by(staff_id=anna_id, channel="in_app").count() == 1
