"""GET /api/auth/export-data covers every table the erasure walks (8 Oct).

Before: ~20 hand-written sections; daily closes, kasserapport, staff,
schedules, hours, reservations, customers, invoices, events, gavekort, chat
and documents were missing — an incomplete Art. 15/20 answer. Now the export
appends one section per table reached by _owned_by_uid_predicate, the same
walk delete-account erases with, minus credential columns.
"""
import csv
import io
import uuid
from datetime import date, datetime, timedelta

from app.database import Base
from app.models.customer import Customer
from app.models.daily_close import DailyClose
from app.models.reservation import Reservation
from app.models.staff import StaffLink, StaffMember
from app.models.user import User
from app.routers import auth as auth_router
from app.services.auth import get_current_user, hash_password
from tests.test_delete_account_completeness import (  # noqa: F401 — fixtures
    client, db_session,
)
from app.main import app


def _user(db, email):
    u = User(email=email, password_hash=hash_password("pw123456"), business_name="Café",
             business_type="cafe", currency="DKK", role="owner")
    db.add(u); db.commit(); db.refresh(u)
    return u


def _sections(text):
    out, cur = {}, None
    for row in csv.reader(io.StringIO(text)):
        if row and row[0].startswith("=== table: "):
            cur = row[0][len("=== table: "):].split(" (")[0]
            out[cur] = []
        elif cur and row:
            out[cur].append(row)
        elif not row:
            pass
    return out


def test_export_walk_matches_the_erasure_walk():
    """Static: every table the erasure deletes from is a table the export
    reads from (same predicate, same metadata) — no hand list to drift."""
    uid = uuid.uuid4()
    retained = {"audit_logs", "security_events", "error_logs"}
    erased = {t.name for t in Base.metadata.sorted_tables
              if t.name != "users" and t.name not in retained
              and auth_router._owned_by_uid_predicate(t, uid) is not None}
    exported = {t.name for t in Base.metadata.sorted_tables
                if t.name not in auth_router._EXPORT_SKIPPED_TABLES
                and auth_router._owned_by_uid_predicate(t, uid) is not None}
    assert erased <= exported, erased - exported
    for must in ("daily_closes", "staff_members", "reservations", "customers",
                 "invoices", "gift_cards", "schedules", "hours_logged"):
        assert must in exported, must


def test_export_includes_the_missing_tables_and_no_credentials(db_session, client):
    me = _user(db_session, "me@example.com")
    other = _user(db_session, "other@example.com")
    db_session.add(DailyClose(user_id=me.id, date=date(2026, 10, 7), revenue_total=4321,
                              notes="=HYPERLINK(\"http://x\")"))
    db_session.add(DailyClose(user_id=other.id, date=date(2026, 10, 7), revenue_total=9999))
    staff = StaffMember(user_id=me.id, name="Mette Jensen")
    db_session.add(staff); db_session.flush()
    db_session.add(StaffLink(user_id=me.id, staff_id=staff.id, token="SECRET-PORTAL-TOKEN",
                             join_code="JOIN99", pin_hash="$2b$pinhash"))
    db_session.add(Customer(user_id=me.id, name="Hansen ApS", email="kunde@example.dk"))
    starts = datetime(2026, 10, 10, 18, 0)
    db_session.add(Reservation(user_id=me.id, guest_name="Ole", party_size=4,
                               starts_at=starts, ends_at=starts + timedelta(minutes=90)))
    db_session.commit()

    app.dependency_overrides[get_current_user] = lambda: me
    r = client.get("/api/auth/export-data")
    assert r.status_code == 200, r.text
    text = r.text
    secs = _sections(text)
    for t in ("daily_closes", "staff_members", "staff_links", "customers", "reservations"):
        assert t in secs, (t, list(secs))
    # Only my rows.
    assert "4321" in text and "9999" not in text
    assert len(secs["daily_closes"]) == 2  # header + my one row
    # No credentials, ever.
    for secret in ("SECRET-PORTAL-TOKEN", "JOIN99", "$2b$pinhash"):
        assert secret not in text, secret
    header = secs["staff_links"][0]
    assert "token" not in header and "pin_hash" not in header and "join_code" not in header
    # Cells pass csv_safe — a stored formula does not run in Excel.
    assert "'=HYPERLINK" in text or "\t=HYPERLINK" in text
    # The readable summary is still on top, unchanged.
    assert text.index("=== Profile ===") < text.index("=== Complete record")
