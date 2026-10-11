"""R-h H-4: GET /api/admin/privacy-purges — the dry-run counts Manoj reads
before turning a purge flag on (and after, to see each count drop to 0).

Pins (12):
  • a super admin gets {"flags": {...3 flags...}, "due": {...5 counts...}}
    with the right numbers for seeded rows;
  • counts only: no id, name, phone or address in the payload;
  • a plain owner is refused through the EXISTING guard, which answers every
    refusal with a deliberate 404 (services/admin_security.py), never data;
  • read-only: the purge tables and audit_logs count the same before and
    after the call (the guard's own SecurityEvent is its existing behaviour).

Run:
  cd backend && python3 -m pytest tests/test_admin_privacy_purges.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.config import settings
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.magic_link_token import MagicLinkToken
from app.models.reservation_waitlist import ReservationWaitlistEntry
from app.models.user import User
from app.models.waitlist import WaitlistEntry
from app.models.whatsapp import WhatsAppMessage
from app.services.auth import create_access_token, hash_password
from app.utils.time import utc_now

_db_ready.set()

ADMIN_MAIL = "founder@bonbox.dk"


@pytest.fixture
def S():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture
def client(S, monkeypatch):
    def _get_test_db():
        s = S()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    monkeypatch.setattr(settings, "SUPER_ADMIN_EMAILS", ADMIN_MAIL, raising=False)
    yield TestClient(app)
    app.dependency_overrides.clear()


def _user(s, *, email, role="owner") -> User:
    u = User(email=email, password_hash=hash_password("pw123456"), business_name="Bon",
             business_type="restaurant", currency="DKK", role=role, email_verified=True,
             created_at=utc_now() - timedelta(days=30))
    s.add(u); s.commit(); s.refresh(u)
    return u


def _bearer(u: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(str(u.id), u.token_version or 0)}"}


def _seed(s, owner):
    now = utc_now()
    for d in (3, 2, 1):
        s.add(ReservationWaitlistEntry(user_id=owner.id, guest_name="Agnes", guest_phone="+4520202020",
                                       party_size=2, waitlist_date=date(2026, 7, 1),
                                       purge_after=now - timedelta(days=d)))
    s.add(ReservationWaitlistEntry(user_id=owner.id, guest_name="Bo", guest_phone="+4521212121",
                                   party_size=2, waitlist_date=date(2026, 12, 1),
                                   purge_after=now + timedelta(days=60)))
    for _ in range(2):
        s.add(WhatsAppMessage(phone_number="+4511111111", direction="inbound", body="hej",
                              created_at=now - timedelta(days=200)))
    s.add(WhatsAppMessage(phone_number="+4511111111", direction="inbound", body="hej",
                          created_at=now - timedelta(days=5)))
    s.add(MagicLinkToken(email="old@x.dk", token_hash=uuid.uuid4().hex * 2,
                         created_at=now - timedelta(days=60), expires_at=now - timedelta(days=60),
                         request_ip="10.0.0.1"))
    s.add(WaitlistEntry(email="anon@x.dk", tier="pro", created_at=now - timedelta(days=400)))
    s.add(WaitlistEntry(email=owner.email, user_id=owner.id, tier="pro",
                        created_at=now - timedelta(days=400)))
    for i in range(4):
        s.add(AuditLog(user_id=owner.id, action="daily_brief.email_sent", entity_type="user",
                       after_state=json.dumps({"to": owner.email, "subject": f"b{i}"})))
    s.add(AuditLog(user_id=owner.id, action="invoice.email_sent", entity_type="invoice",
                   after_state=json.dumps({"to": "kunde@firma.dk"})))
    s.commit()


_TABLES = (ReservationWaitlistEntry, WhatsAppMessage, MagicLinkToken, WaitlistEntry, AuditLog)


def _counts(s):
    s.expire_all()
    return {m.__tablename__: s.query(m).count() for m in _TABLES}


def test_super_admin_gets_flags_and_due_counts(S, client):
    s = S()
    admin = _user(s, email=ADMIN_MAIL, role="super_admin")
    owner = _user(s, email="owner@cafe.dk")
    _seed(s, owner)
    before = _counts(s)
    r = client.get("/api/admin/privacy-purges", headers=_bearer(admin))
    assert r.status_code == 200, r.text
    assert r.json() == {
        "flags": {"PRIVACY_PURGE_WAITLIST_ENABLED": False,
                  "PRIVACY_PURGE_ORPHANS_ENABLED": False,
                  "AUDIT_EMAIL_CLEANUP_ENABLED": False},
        "due": {"waitlist_guest_pii": 3, "whatsapp_messages": 2, "magic_link_tokens": 1,
                "anonymous_paid_waitlist": 1, "audit_rows_with_owner_email": 4},
    }
    # Counts only.
    assert "@" not in r.text and "+45" not in r.text and "Agnes" not in r.text
    # Read-only: nothing it counts moved.
    assert _counts(s) == before


def test_flags_are_reported_as_set(S, client, monkeypatch):
    s = S()
    admin = _user(s, email=ADMIN_MAIL, role="super_admin")
    monkeypatch.setattr(settings, "PRIVACY_PURGE_ORPHANS_ENABLED", True)
    r = client.get("/api/admin/privacy-purges", headers=_bearer(admin))
    assert r.status_code == 200
    assert r.json()["flags"]["PRIVACY_PURGE_ORPHANS_ENABLED"] is True
    assert r.json()["flags"]["PRIVACY_PURGE_WAITLIST_ENABLED"] is False


def test_an_owner_is_refused_with_no_data(S, client):
    s = S()
    owner = _user(s, email="owner@cafe.dk")
    _seed(s, owner)
    before = _counts(s)
    r = client.get("/api/admin/privacy-purges", headers=_bearer(owner))
    # The existing guard answers every non-admin with a generic 404.
    assert r.status_code == 404, r.text
    assert "due" not in r.text and "flags" not in r.text
    assert _counts(s) == before


def test_unauthenticated_is_refused(client):
    r = client.get("/api/admin/privacy-purges")
    assert r.status_code in (401, 403), r.text
    assert "due" not in r.text
