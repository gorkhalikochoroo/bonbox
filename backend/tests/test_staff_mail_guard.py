"""SEC-1 + SEC-10 + PQ-19 (R-f) — staff schedule mail.

Every staff mail goes from BonBox's own domain to an address the OWNER typed.
These pin services/staff_mail_guard on every path that sends one:

  automatic   send_shift_notifications (publish), send_single_shift_notification
              (edit / delete / sick-call cover)
  explicit    POST /staff/schedules/share-with-staff, POST /staff/schedules/email

  • an unconfirmed owner (or one whose "did you create this account?" question
    is open) mails nobody: the automatic paths still write the in-app alert and
    fire the push, publish says why (mail_held), the explicit sends answer 403
    email_unverified before anything is sent;
  • per owner at most 100 staff mails a day, per mailbox at most 10 (a "+tag"
    is the same mailbox), counted from audit_logs; boundaries both sides;
  • an unreadable count mails nobody;
  • a staff address must be one ordinary mailbox; a new shift is draft or
    published;
  • Danish staff get Danish subjects, English ones keep theirs.
"""
import json
import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.staff import NotificationLog, Schedule, StaffMember
from app.models.user import User
from app.routers import staff as staff_router
from app.services import notification_service as ns
from app.services import staff_mail_guard as guard
from app.services.auth import get_current_user, hash_password
from app.services.notification_service import ShiftChange
from app.utils.time import utc_now

_db_ready.set()

MONDAY = date(2026, 6, 1)


# ─── fixtures ────────────────────────────────────────────────────────────


@pytest.fixture
def SL():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture
def db(SL):
    s = SL()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(SL, monkeypatch):
    def _get_test_db():
        s = SL()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    # Publish hands the real mailer to BackgroundTasks; keep it on this DB.
    monkeypatch.setattr(staff_router, "SessionLocal", SL)
    lim = getattr(staff_router, "_limiter", None)
    if lim is not None:
        lim.reset()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        if lim is not None:
            lim.reset()


@pytest.fixture
def mails(monkeypatch):
    """Every mail any staff path hands to the mail provider."""
    out: list[dict] = []

    def _send_email(to=None, subject=None, html=None, **k):
        out.append({"to": to, "subject": subject})
        return True

    def _send_att(addr, subject, *a, **k):
        out.append({"to": addr, "subject": subject})
        return True, None

    monkeypatch.setattr(ns, "send_email", _send_email)
    monkeypatch.setattr(staff_router, "send_email", _send_email)
    import app.services.email_service as email_service
    monkeypatch.setattr(email_service, "send_email_with_attachment", _send_att)
    return out


@pytest.fixture
def pushes(monkeypatch):
    out: list[str] = []
    monkeypatch.setattr(
        ns, "_send_staff_schedule_push",
        lambda **k: out.append(str(k["staff_id"])) or {"attempted": 1, "sent": 1, "removed": 0},
    )
    return out


def _owner(db, *, verified=True, plan="pro", email="owner@bonbox.dk") -> User:
    u = User(
        email=email, password_hash=hash_password("ownerpw123"),
        business_name="Bon Bistro", business_type="cafe", currency="DKK",
        plan=plan, role="owner", timezone="Europe/Copenhagen",
        email_verified=verified,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _open_claim_question(db, owner):
    from app.models.account_claim_ticket import AccountClaimTicket
    db.add(AccountClaimTicket(
        user_id=owner.id, token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
        kind="mail", via="magic_link", expires_at=utc_now() + timedelta(days=1),
    ))
    db.commit()


def _staff(db, owner, *, name="Anna", email="anna@cafe.dk") -> StaffMember:
    s = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role="server",
                    active=True, is_deleted=False, email=email)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _shift(db, owner, staff, *, day=0, status="draft", week=MONDAY) -> Schedule:
    s = Schedule(id=uuid.uuid4(), user_id=owner.id, staff_id=staff.id,
                 date=week + timedelta(days=day), start_time="16:00",
                 end_time="23:00", break_minutes=0, role_on_shift="server",
                 status=status)
    db.add(s)
    db.commit()
    return s


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user


def _prior_mails(db, owner, n, address="anna@cafe.dk"):
    """n staff mails already sent today (the audit counter rows)."""
    key = guard.recipient_key(address)
    for _ in range(n):
        db.add(AuditLog(user_id=owner.id, actor_type="system.staff_mail",
                        action=guard.STAFF_MAIL_ACTION, entity_type="staff_member",
                        after_state=json.dumps({"r": key, "kind": "x"})))
    db.commit()


def _change(kind="modified", day="2026-11-25"):
    return ShiftChange(change_type=kind, date=day, old_start="10:00", old_end="16:00",
                       new_start="11:00", new_end="17:00", role="server")


def _next_monday():
    today = date.today()
    return today + timedelta(days=(7 - today.weekday()) % 7 or 7)


# ─── 1. the confirmed sender ─────────────────────────────────────────────


def test_unconfirmed_owner_publish_mails_nobody_but_staff_still_hear(db, mails, pushes):
    owner = _owner(db, verified=False)
    anna = _staff(db, owner)
    ns.send_shift_notifications(db, owner.id, {str(anna.id): [_change("added")]},
                                "Week of 1 Jun 2026", week_start=MONDAY)
    assert mails == []
    assert pushes == [str(anna.id)], "the push still goes"
    row = db.query(NotificationLog).filter_by(staff_id=anna.id).one()
    assert row.channel == "in_app" and row.event_type == "schedule_published"


def test_claim_question_open_holds_the_mail_too(db, mails, pushes):
    owner = _owner(db, verified=True)
    _open_claim_question(db, owner)
    anna = _staff(db, owner)
    ns.send_single_shift_notification(db, owner.id, anna.id, _change("removed"), "shift_deleted")
    assert mails == []
    assert pushes == [str(anna.id)]
    assert db.query(NotificationLog).filter_by(staff_id=anna.id).one().channel == "in_app"


@pytest.mark.parametrize("kind,event", [("modified", "shift_changed"),
                                        ("removed", "shift_deleted"),
                                        ("added", "shift_changed")])
def test_unconfirmed_owner_edit_delete_cover_mail_nobody(db, mails, pushes, kind, event):
    owner = _owner(db, verified=False)
    anna = _staff(db, owner)
    ns.send_single_shift_notification(db, owner.id, anna.id, _change(kind), event)
    assert mails == []
    assert pushes == [str(anna.id)]
    assert db.query(NotificationLog).filter_by(staff_id=anna.id).one().channel == "in_app"


def test_confirmed_owner_mails_and_counts_without_storing_the_address(db, mails, pushes):
    owner = _owner(db)
    anna = _staff(db, owner, email="Anna@Cafe.DK")
    ns.send_shift_notifications(db, owner.id, {str(anna.id): [_change("added")]},
                                "Week of 1 Jun 2026", week_start=MONDAY)
    assert [m["to"] for m in mails] == ["Anna@cafe.dk"]
    rows = db.query(AuditLog).filter_by(user_id=owner.id, action=guard.STAFF_MAIL_ACTION).all()
    assert len(rows) == 1
    assert "anna" not in (rows[0].after_state or "").lower(), "a fingerprint, never the address"
    assert db.query(NotificationLog).filter_by(staff_id=anna.id).one().channel == "email"


def test_publish_says_why_nobody_was_mailed(client, db, mails, pushes):
    owner = _owner(db, verified=False)
    anna = _staff(db, owner)
    _shift(db, owner, anna)
    _as(owner)
    body = client.post("/api/staff/schedules/publish",
                       params={"week_start": MONDAY.isoformat()}).json()
    assert body["published"] == 1
    assert body["mail_held"] == "email_unverified"
    assert body["notify_count"] == 0, "nobody is e-mailed — the count must say so"
    # ...and the background send (TestClient runs it) indeed mails nobody.
    assert mails == []
    assert pushes == [str(anna.id)]


def test_publish_names_the_claim_question(client, db, mails, pushes):
    owner = _owner(db, verified=True)
    _open_claim_question(db, owner)
    anna = _staff(db, owner)
    _shift(db, owner, anna)
    _as(owner)
    body = client.post("/api/staff/schedules/publish",
                       params={"week_start": MONDAY.isoformat()}).json()
    assert body["mail_held"] == "claim_question_open"
    assert body["notify_count"] == 0


def test_explicit_sends_refuse_an_unconfirmed_owner_before_anything(client, db, mails):
    owner = _owner(db, verified=False)
    anna = _staff(db, owner)
    week = _next_monday()
    _shift(db, owner, anna, status="published", week=week)
    _as(owner)
    r = client.post("/api/staff/schedules/email",
                    json={"week_start": week.isoformat(), "lang": "da", "cc_self": True})
    assert r.status_code == 403, r.text
    d = r.json()["detail"]
    assert d["code"] == "email_unverified"
    assert d["message_da"] == guard.STAFF_MAIL_HELD_DA
    r = client.post("/api/staff/schedules/share-with-staff",
                    json={"week_start": week.isoformat()}, params={"lang": "da"})
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "email_unverified"
    assert mails == []
    from app.models.staff import StaffLink
    assert db.query(StaffLink).count() == 0, "nothing minted on a refused send"


def test_share_without_any_mailable_address_still_mints_links(client, db, mails):
    """The gate is about mail. With no address to mail, the share still does
    its other job (a link per scheduled staffer) for an unconfirmed owner."""
    owner = _owner(db, verified=False)
    nomail = _staff(db, owner, name="NoMail", email=None)
    week = _next_monday()
    _shift(db, owner, nomail, status="published", week=week)
    _as(owner)
    r = client.post("/api/staff/schedules/share-with-staff",
                    json={"week_start": week.isoformat()}, params={"lang": "da"})
    assert r.status_code == 200, r.text
    assert r.json()["links_issued"] == 1 and r.json()["emailed_count"] == 0
    assert mails == []


# ─── 2. the ceilings (both sides of each boundary) ───────────────────────


def test_recipient_ceiling_boundary(db, mails, pushes):
    owner = _owner(db)
    anna = _staff(db, owner, email="anna@cafe.dk")
    _prior_mails(db, owner, guard.STAFF_MAIL_RECIPIENT_DAILY_CAP - 1)
    ns.send_single_shift_notification(db, owner.id, anna.id, _change(), "shift_changed")
    assert len(mails) == 1, "the 10th mail of the day still goes"
    ns.send_single_shift_notification(db, owner.id, anna.id, _change(), "shift_changed")
    assert len(mails) == 1, "the 11th does not"
    assert len(pushes) == 2, "the push is not capped by the mail ceiling"
    rows = db.query(NotificationLog).filter_by(staff_id=anna.id).order_by(NotificationLog.created_at).all()
    assert sorted(r.channel for r in rows) == ["email", "in_app"]


def test_a_plus_tag_is_the_same_mailbox(db, mails, pushes):
    owner = _owner(db)
    tagged = _staff(db, owner, email="anna+bonbox@cafe.dk")
    _prior_mails(db, owner, guard.STAFF_MAIL_RECIPIENT_DAILY_CAP, address="anna@cafe.dk")
    ns.send_single_shift_notification(db, owner.id, tagged.id, _change(), "shift_changed")
    assert mails == []


def test_owner_ceiling_boundary(db, mails, pushes):
    owner = _owner(db)
    a = _staff(db, owner, name="A", email="a@cafe.dk")
    b = _staff(db, owner, name="B", email="b@cafe.dk")
    # 99 mails to other mailboxes today: one more fits, the next does not.
    for i in range(guard.STAFF_MAIL_OWNER_DAILY_CAP - 1):
        _prior_mails(db, owner, 1, address=f"x{i}@cafe.dk")
    ns.send_shift_notifications(db, owner.id,
                                {str(a.id): [_change("added")], str(b.id): [_change("added")]},
                                "Week of 1 Jun 2026", week_start=MONDAY)
    assert len(mails) == 1
    assert len(pushes) == 2
    assert db.query(AuditLog).filter_by(action=guard.STAFF_MAIL_ACTION).count() == guard.STAFF_MAIL_OWNER_DAILY_CAP


def test_old_rows_do_not_count(db, mails, pushes):
    owner = _owner(db)
    anna = _staff(db, owner)
    _prior_mails(db, owner, guard.STAFF_MAIL_RECIPIENT_DAILY_CAP)
    db.query(AuditLog).update({AuditLog.created_at: utc_now() - timedelta(hours=25)})
    db.commit()
    ns.send_single_shift_notification(db, owner.id, anna.id, _change(), "shift_changed")
    assert len(mails) == 1


def test_an_unreadable_count_mails_nobody(db, mails, pushes, monkeypatch):
    owner = _owner(db)
    anna = _staff(db, owner)
    monkeypatch.setattr(guard, "third_party_sends", lambda *a, **k: None)
    ns.send_single_shift_notification(db, owner.id, anna.id, _change(), "shift_changed")
    assert mails == []
    assert pushes == [str(anna.id)]


def test_publish_count_and_names_respect_the_ceiling(client, db, mails, pushes):
    owner = _owner(db)
    anna = _staff(db, owner, name="Anna", email="anna@cafe.dk")
    bo = _staff(db, owner, name="Bo", email="bo@cafe.dk")
    _prior_mails(db, owner, guard.STAFF_MAIL_RECIPIENT_DAILY_CAP, address="anna@cafe.dk")
    _shift(db, owner, anna)
    _shift(db, owner, bo, day=1)
    _as(owner)
    body = client.post("/api/staff/schedules/publish",
                       params={"week_start": MONDAY.isoformat()}).json()
    assert body["mail_held"] is None
    assert body["notify_count"] == 1
    assert body["skipped_mail_limit_names"] == ["Anna"]
    assert [m["to"] for m in mails] == ["bo@cafe.dk"], "the count matches the send"


def test_explicit_send_owner_ceiling_is_all_or_nothing(client, db, mails):
    owner = _owner(db)
    a = _staff(db, owner, name="A", email="a@cafe.dk")
    b = _staff(db, owner, name="B", email="b@cafe.dk")
    week = _next_monday()
    _shift(db, owner, a, status="published", week=week)
    _shift(db, owner, b, day=1, status="published", week=week)
    for i in range(guard.STAFF_MAIL_OWNER_DAILY_CAP - 1):
        _prior_mails(db, owner, 1, address=f"x{i}@cafe.dk")
    _as(owner)
    body = {"week_start": week.isoformat(), "lang": "da", "cc_self": False}
    r = client.post("/api/staff/schedules/email", json=body)
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["code"] == "staff_mail_daily_cap"
    assert "100 mails om dagen" in r.json()["detail"]["message"]
    assert mails == []
    # One fewer earlier mail: both fit exactly (98 + 2 = 100).
    oldest =db.query(AuditLog).filter(AuditLog.action == guard.STAFF_MAIL_ACTION).first()
    db.delete(oldest)
    db.commit()
    r = client.post("/api/staff/schedules/email", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["sent"] == 2


def test_explicit_send_skips_a_mailbox_at_its_ceiling_by_name(client, db, mails):
    owner = _owner(db)
    anna = _staff(db, owner, name="Anna", email="anna@cafe.dk")
    bo = _staff(db, owner, name="Bo", email="bo@cafe.dk")
    week = _next_monday()
    _shift(db, owner, anna, status="published", week=week)
    _shift(db, owner, bo, day=1, status="published", week=week)
    _prior_mails(db, owner, guard.STAFF_MAIL_RECIPIENT_DAILY_CAP, address="anna@cafe.dk")
    _as(owner)
    r = client.post("/api/staff/schedules/share-with-staff",
                    json={"week_start": week.isoformat()}, params={"lang": "da"})
    assert r.status_code == 200, r.text
    assert r.json()["emailed_count"] == 1
    assert r.json()["skipped_mail_limit_names"] == ["Anna"]
    assert [m["to"] for m in mails] == ["bo@cafe.dk"]
    r = client.post("/api/staff/schedules/email",
                    json={"week_start": week.isoformat(), "lang": "en", "cc_self": False})
    assert r.status_code == 200, r.text
    assert r.json()["skipped_mail_limit_names"] == ["Anna"]
    assert r.json()["sent"] == 1


# ─── 3. strict address, status ───────────────────────────────────────────


@pytest.mark.parametrize("bad", [
    "anna", "anna@cafe", "Anna <anna@cafe.dk>", "anna@cafe.dk, bo@cafe.dk",
    "anna@cafe.dk\nBcc: x@y.dk", '"a b"@cafe.dk', "anna@[127.0.0.1]",
])
def test_a_staff_address_must_be_one_ordinary_mailbox(client, db, bad):
    owner = _owner(db)
    _as(owner)
    r = client.post("/api/staff/members", json={"name": "Anna", "email": bad})
    assert r.status_code == 422, (bad, r.status_code)
    m = _staff(db, owner, email="anna@cafe.dk")
    r = client.put(f"/api/staff/members/{m.id}", json={"email": bad})
    assert r.status_code == 422, (bad, r.status_code)
    db.refresh(m)
    assert m.email == "anna@cafe.dk"


def test_a_good_address_is_trimmed_and_a_blank_clears(client, db):
    owner = _owner(db)
    _as(owner)
    r = client.post("/api/staff/members", json={"name": "Anna", "email": "  Anna@Cafe.DK "})
    assert r.status_code in (200, 201), r.text
    assert r.json()["email"] == "Anna@cafe.dk"
    r = client.put(f"/api/staff/members/{r.json()['id']}", json={"email": ""})
    assert r.status_code == 200, r.text
    assert r.json()["email"] is None


def test_a_stored_bad_address_is_never_mailed(db, mails, pushes):
    owner = _owner(db)
    legacy = _staff(db, owner, email="Anna <anna@cafe.dk>")
    ns.send_single_shift_notification(db, owner.id, legacy.id, _change(), "shift_changed")
    assert mails == []
    assert pushes == [str(legacy.id)]


@pytest.mark.parametrize("status,ok", [("draft", True), ("published", True),
                                       ("PUBLISHED", True), ("confirmed", False),
                                       ("live", False), ("", False)])
def test_a_new_shift_is_draft_or_published(client, db, status, ok):
    owner = _owner(db)
    anna = _staff(db, owner)
    _as(owner)
    r = client.post("/api/staff/schedules", json={
        "staff_id": str(anna.id), "date": MONDAY.isoformat(),
        "start_time": "10:00", "end_time": "16:00", "status": status,
    })
    assert r.status_code == (200 if ok else 422), (status, r.status_code, r.text)
    if ok:
        assert r.json()["status"] == status.lower()


# ─── 4. PQ-19: Danish subjects ───────────────────────────────────────────


def test_publish_subject_in_danish_and_english(db, mails, pushes):
    owner = _owner(db)
    anna = _staff(db, owner)
    ns.send_shift_notifications(db, owner.id, {str(anna.id): [_change("added")]},
                                "Uge 23", lang="da", week_start=MONDAY)
    ns.send_shift_notifications(db, owner.id, {str(anna.id): [_change("added")]},
                                "Week of 01 Jun 2026", lang="en", week_start=MONDAY)
    assert [m["subject"] for m in mails] == [
        "Vagtplanen er opdateret – uge 23",
        "Schedule updated - Week of 01 Jun 2026",
    ]
    # The feed row keeps the English verb the portal reads.
    subjects = {r.subject for r in db.query(NotificationLog).all()}
    assert subjects == {"Schedule updated - 2026-06-01"}


@pytest.mark.parametrize("kind,da,en", [
    ("removed", "Vagt aflyst – ons. 25. nov.", "Shift cancelled - Wed 25 Nov"),
    ("added", "Ny vagt – ons. 25. nov.", "Shift updated - Wed 25 Nov"),
    ("modified", "Vagt ændret – ons. 25. nov.", "Shift updated - Wed 25 Nov"),
])
def test_single_shift_subject_in_danish_and_english(db, mails, pushes, kind, da, en):
    owner = _owner(db)
    anna = _staff(db, owner)
    ns.send_single_shift_notification(db, owner.id, anna.id, _change(kind), "shift_changed", lang="da")
    ns.send_single_shift_notification(db, owner.id, anna.id, _change(kind), "shift_changed", lang="en")
    assert [m["subject"] for m in mails] == [da, en]
    for r in db.query(NotificationLog).all():
        assert r.subject.startswith(("Shift cancelled - 2026-11-25", "Shift updated - 2026-11-25"))


def test_staff_self_edit_uses_the_same_strict_rule(client, db):
    """The staffer's own e-mail from the portal is mailed the same way."""
    from app.models.staff import StaffLink
    from app.routers import staff_portal as sp
    sp.limiter.reset()
    owner = _owner(db)
    anna = _staff(db, owner, email=None)
    db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=anna.id,
                     token="tokM", active=True))
    db.commit()
    r = client.put("/api/portal/tokM/email", json={"email": "anna..x@cafe.dk"})
    assert r.status_code == 400, r.text
    db.refresh(anna)
    assert anna.email is None
    r = client.put("/api/portal/tokM/email", json={"email": " Anna@Cafe.DK "})
    assert r.status_code == 200, r.text
    db.refresh(anna)
    assert anna.email == "anna@cafe.dk"
    sp.limiter.reset()


def test_publish_names_the_sender_only_when_someone_could_be_mailed(client, db, mails, pushes):
    """Held, but nobody has an address: the true reason is "no address", so
    mail_held stays None and the no-address names carry the message."""
    owner = _owner(db, verified=False)
    nomail = _staff(db, owner, name="NoMail", email=None)
    _shift(db, owner, nomail)
    _as(owner)
    body = client.post("/api/staff/schedules/publish",
                       params={"week_start": MONDAY.isoformat()}).json()
    assert body["mail_held"] is None
    assert body["skipped_no_email_names"] == ["NoMail"]
    assert body["notify_count"] == 0


# ─── 5. review fix-ups (10 Oct) ──────────────────────────────────────────


def test_publish_with_an_unreadable_count_claims_no_limit(client, db, mails, pushes, monkeypatch):
    """Release gate rule 5: no limit was reached — the count failed. Publish
    says it could not confirm (notify_count null), names nobody as over the
    limit, and the background send mails nobody (fail closed)."""
    owner = _owner(db)
    anna = _staff(db, owner, name="Anna", email="anna@cafe.dk")
    _shift(db, owner, anna)
    _as(owner)
    monkeypatch.setattr(guard, "third_party_sends", lambda *a, **k: None)
    body = client.post("/api/staff/schedules/publish",
                       params={"week_start": MONDAY.isoformat()}).json()
    assert body["published"] == 1
    assert body["notify_count"] is None
    assert body["skipped_mail_limit_names"] == []
    assert body["mail_held"] is None
    assert mails == []
    assert pushes == [str(anna.id)]


def test_explicit_sends_with_an_unreadable_count_report_not_sent_not_a_limit(
        client, db, mails, monkeypatch):
    owner = _owner(db)
    anna = _staff(db, owner, name="Anna", email="anna@cafe.dk")
    week = _next_monday()
    _shift(db, owner, anna, status="published", week=week)
    _as(owner)
    monkeypatch.setattr(guard, "third_party_sends", lambda *a, **k: None)
    r = client.post("/api/staff/schedules/share-with-staff",
                    json={"week_start": week.isoformat()}, params={"lang": "da"})
    assert r.status_code == 200, r.text
    assert r.json()["emailed_count"] == 0
    assert r.json()["email_failed_count"] == 1
    assert r.json()["skipped_mail_limit_names"] == []
    assert r.json()["links_issued"] == 1, "the link is still minted"
    r = client.post("/api/staff/schedules/email",
                    json={"week_start": week.isoformat(), "lang": "da", "cc_self": False})
    assert r.status_code == 200, r.text
    assert r.json()["sent"] == 0
    assert [f["name"] for f in r.json()["failed"]] == ["Anna"]
    assert r.json()["failed"][0]["reason"] == "count_unavailable"
    assert r.json()["skipped_mail_limit_names"] == []
    assert mails == []


def test_a_minted_link_survives_a_later_staffers_error(client, db, mails, monkeypatch):
    """Each staffer's mail is one committed turn: Anna's link (already in her
    inbox) is not rolled back when the next staffer's send throws."""
    from app.models.staff import StaffLink
    owner = _owner(db)
    anna = _staff(db, owner, name="Anna", email="anna@cafe.dk")
    bo = _staff(db, owner, name="Bo", email="bo@cafe.dk")
    week = _next_monday()
    _shift(db, owner, anna, status="published", week=week)
    _shift(db, owner, bo, day=1, status="published", week=week)
    _as(owner)

    def _send(to=None, subject=None, html=None, **k):
        if to == "bo@cafe.dk":
            raise RuntimeError("provider exploded")
        mails.append({"to": to, "subject": subject})
        return True

    monkeypatch.setattr(staff_router, "send_email", _send)
    r = client.post("/api/staff/schedules/share-with-staff",
                    json={"week_start": week.isoformat()}, params={"lang": "da"})
    assert r.status_code == 200, r.text
    assert [m["to"] for m in mails] == ["anna@cafe.dk"]
    db.expire_all()
    assert db.query(StaffLink).filter_by(staff_id=anna.id, active=True).count() == 1
    assert db.query(AuditLog).filter_by(action=guard.STAFF_MAIL_ACTION).count() == 1
