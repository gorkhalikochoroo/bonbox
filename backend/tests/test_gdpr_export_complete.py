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


# ── Review, 8 Oct ────────────────────────────────────────────────────


def test_export_carries_no_portal_token_inside_stored_mails_and_no_ticket_jwt(db_session, client):
    """staff_links.token was filtered, but the same token rode out inside
    notification_log.body (the staff_link_shared / schedule mails are stored
    whole) and tickets.qr_payload is the signed entry JWT. Neither leaves."""
    from app.models.booking import Booking
    from app.models.event import Event
    from app.models.staff import NotificationLog
    from app.models.ticket import Ticket

    me = _user(db_session, "me2@example.com")
    staff = StaffMember(user_id=me.id, name="Mette Jensen")
    db_session.add(staff); db_session.flush()
    token = "PortalTok3n_abcdefghijklmnop"
    html = (f'<p>Hej Mette,</p><a href="https://www.bonbox.dk/s/cafe-x/mette/{token}">Åbn</a>'
            f' or https://www.bonbox.dk/s/{token} and /s/cafe-x/{token}')
    db_session.add(NotificationLog(user_id=me.id, staff_id=staff.id, channel="email",
                                   event_type="staff_link_shared", subject="Café — din vagtplan",
                                   body=html))
    ev = Event(user_id=me.id, name="Vinaften", event_date=date(2026, 11, 1))
    db_session.add(ev); db_session.flush()
    bk = Booking(event_id=ev.id, organizer_user_id=me.id, customer_email="g@example.com",
                 customer_name="Gæst", ticket_lines=[], total_amount_dkk=200)
    db_session.add(bk); db_session.flush()
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOiJ4In0.SIGNATURE-ENTRY-JWT"
    db_session.add(Ticket(booking_id=bk.id, event_id=ev.id, tier_label="Std",
                          tier_price_dkk=200, qr_payload=jwt))
    db_session.commit()

    app.dependency_overrides[get_current_user] = lambda: me
    r = client.get("/api/auth/export-data")
    assert r.status_code == 200, r.text
    text = r.text
    assert token not in text
    assert jwt not in text and "SIGNATURE-ENTRY-JWT" not in text
    secs = _sections(text)
    # The rows themselves are still in the export — only the keys are cut.
    assert "notification_log" in secs and "tickets" in secs
    assert "qr_payload" not in secs["tickets"][0]
    assert "https://www.bonbox.dk/s/[removed]" in text
    assert "Hej Mette" in text and "Vinaften" in text


def test_redaction_leaves_ordinary_text_alone():
    red = auth_router._redact_portal_links
    assert red("1/s/2 kr/s/stk") == "1/s/2 kr/s/stk"
    assert red("https://example.com/docs/s/x") == "https://example.com/docs/s/x"
    assert red('href="/s/a/b/TOKEN"') == 'href="/s/[removed]"'
    assert red("/s/TOKEN") == "/s/[removed]"


def test_revisor_session_cannot_download_the_owners_full_export(db_session, client):
    """An accountant-view session resolves to the OWNER's identity; the full
    Art. 15/20 export (guest allergies, staff addresses, chat) is the data
    subject's, not the revisor's — 403, nothing exported."""
    from fastapi import Depends, Request
    from app.database import get_db
    from app.models.accountant_grant import AccountantGrant
    from app.services.auth import _resolve_accountant_view
    from app.utils.time import utc_now

    owner = _user(db_session, "owner3@example.com")
    rev = User(email="revisor3@example.com", password_hash=hash_password("revisorpw123"),
               business_name="Rev", business_type="", currency="DKK", role="accountant",
               email_verified=True)
    db_session.add(rev); db_session.commit(); db_session.refresh(rev)
    db_session.add(AccountantGrant(accountant_user_id=rev.id, accountant_email=rev.email,
                                   owner_user_id=owner.id, granted_by=owner.id, status="active",
                                   invited_at=utc_now(), activated_at=utc_now()))
    db_session.add(DailyClose(user_id=owner.id, date=date(2026, 10, 7), revenue_total=777))
    db_session.commit()

    def _resolve(request: Request, db=Depends(get_db)):
        return _resolve_accountant_view(rev, request, db)

    app.dependency_overrides[get_current_user] = _resolve
    r = client.get("/api/auth/export-data", headers={"X-Client-ID": str(owner.id)})
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "export_owner_only"
    assert "777" not in r.text
    # The owner's own session still gets it. (This test shares one ORM session
    # across requests, so drop the per-request marker the delegation put on
    # the identity-mapped owner row; production opens a session per request.)
    owner.__dict__.pop("_is_accountant_view", None)
    app.dependency_overrides[get_current_user] = lambda: owner
    r2 = client.get("/api/auth/export-data")
    assert r2.status_code == 200 and "777" in r2.text


def test_export_is_rate_limited(db_session, client):
    me = _user(db_session, "rl@example.com")
    app.dependency_overrides[get_current_user] = lambda: me
    codes = [client.get("/api/auth/export-data").status_code for _ in range(4)]
    assert codes[:3] == [200, 200, 200] and codes[3] == 429, codes
