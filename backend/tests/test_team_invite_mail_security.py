"""Team invite mail — third-party mail rules (security, 8 Oct).

  1. owner_name (the business name the owner typed) is escaped in the HTML
     and the subject is header-safe — it goes to someone who never chose
     BonBox, under BonBox's sender;
  2. only a confirmed account may invite (403 email_unverified) or resend;
  3. ceilings: 3 invite mails per invitee per 24 h (counted on the address,
     so revoke → re-invite does not reset it), 10 minutes between two
     resends, 20 invite mails per owner per 24 h.

The mail sender is stubbed by the shared fixtures — nothing is sent.
"""
import json
import uuid
from datetime import timedelta

from app.models.audit_log import AuditLog
from app.models.user import User
from app.utils.time import utc_now
from tests.test_team_invite import (  # noqa: F401 — pytest fixtures
    _owner, _override_user, _reset_rate_limiter, client, db, engine_and_session,
)


def _invite(client, email="anna@cafe.dk"):
    return client.post("/api/team/invite", json={"email": email, "role": "cashier"})


def test_owner_name_is_escaped_and_subject_header_safe(client, db):
    owner = _owner(db)
    owner.business_name = '<a href="https://evil.example">Klik</a>\r\nBcc: x@example.com'
    db.commit()
    _override_user(owner)
    r = _invite(client)
    assert r.status_code == 200, r.text
    mail = client.sent[-1]
    assert '<a href="https://evil.example">' not in mail["html"]
    assert "&lt;a href=&quot;https://evil.example&quot;&gt;" in mail["html"]
    assert "\r" not in mail["subject"] and "\n" not in mail["subject"]
    # The accept link still works (the token is still in the href).
    assert "/accept-invite/team/" in mail["html"]


def test_unverified_owner_cannot_invite_or_resend(client, db):
    owner = _owner(db)
    _override_user(owner)
    assert _invite(client, "bo@cafe.dk").status_code == 200
    bo = db.query(User).filter(User.email == "bo@cafe.dk").one()
    owner.email_verified = False
    db.commit()
    n = len(client.sent)
    r = _invite(client, "carl@cafe.dk")
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "email_unverified"
    r2 = client.post(f"/api/team/{bo.id}/resend-invite")
    assert r2.status_code == 403, r2.text
    assert len(client.sent) == n


def test_resend_cooldown_and_per_invitee_daily_cap(client, db):
    owner = _owner(db)
    _override_user(owner)
    assert _invite(client).status_code == 200
    anna = db.query(User).filter(User.email == "anna@cafe.dk").one()
    # The first "it didn't arrive" resend may follow the invite at once.
    assert client.post(f"/api/team/{anna.id}/resend-invite").status_code == 200
    # A second resend inside 10 minutes is refused, and nothing is sent.
    n = len(client.sent)
    r = client.post(f"/api/team/{anna.id}/resend-invite")
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["code"] == "team_invite_cooldown"
    assert len(client.sent) == n
    # Past the cooldown: the third mail of the day goes out …
    for row in db.query(AuditLog).filter(AuditLog.action == "team.invite_resent").all():
        row.created_at = utc_now() - timedelta(minutes=11)
    db.commit()
    assert client.post(f"/api/team/{anna.id}/resend-invite").status_code == 200
    # … and a fourth does not (a re-invite after revoke: see the next test).
    for row in db.query(AuditLog).filter(AuditLog.action == "team.invite_resent").all():
        row.created_at = utc_now() - timedelta(minutes=11)
    db.commit()
    n = len(client.sent)
    r = client.post(f"/api/team/{anna.id}/resend-invite")
    assert r.status_code == 429 and r.json()["detail"]["code"] == "team_invite_invitee_cap"
    assert len(client.sent) == n


def test_revoke_then_reinvite_does_not_reset_the_count(client, db):
    owner = _owner(db)
    _override_user(owner)
    for _ in range(3):
        assert _invite(client).status_code == 200
        anna = db.query(User).filter(User.email == "anna@cafe.dk").one()
        assert client.post(f"/api/team/{anna.id}/revoke-invite").status_code == 200
    n = len(client.sent)
    r = _invite(client)
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["code"] == "team_invite_invitee_cap"
    assert len(client.sent) == n


def test_per_owner_daily_cap(client, db):
    owner = _owner(db)
    _override_user(owner)
    for i in range(20):
        db.add(AuditLog(
            user_id=owner.id, actor_id=owner.id, action="team.invited",
            entity_type="user", entity_id=uuid.uuid4(),
            after_state=json.dumps({"email": f"s{i}@cafe.dk", "role": "cashier"}),
            created_at=utc_now() - timedelta(hours=2),
        ))
    db.commit()
    r = _invite(client, "new@cafe.dk")
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["code"] == "team_invite_daily_cap"
