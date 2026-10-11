"""R-h: the nightly privacy jobs.

Pins:
  • H-1 the two nightly privacy jobs survive a busy thread pool
    (misfire grace + coalesce + one instance), so a night is not skipped.

Run:
  cd backend && python3 -m pytest tests/test_privacy_purges.py -q
"""
from __future__ import annotations

import ast
from pathlib import Path

_MAIN = Path(__file__).resolve().parents[1] / "app" / "main.py"


def _add_job_kwargs(job_id: str) -> dict:
    """The keyword arguments of the add_job(...) call whose id= is job_id."""
    tree = ast.parse(_MAIN.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "add_job"):
            continue
        kw = {k.arg: k.value for k in node.keywords if k.arg}
        idv = kw.get("id")
        if isinstance(idv, ast.Constant) and idv.value == job_id:
            return {k: (v.value if isinstance(v, ast.Constant) else v) for k, v in kw.items()}
    raise AssertionError(f"no add_job(..., id={job_id!r}) in app/main.py")


def test_nightly_privacy_jobs_have_misfire_grace():
    for job_id in ("daily_maintenance", "reservation_gdpr_purge"):
        kw = _add_job_kwargs(job_id)
        assert kw.get("misfire_grace_time") == 3600, job_id
        assert kw.get("coalesce") is True, job_id
        assert kw.get("max_instances") == 1, job_id


# ── H-2 / H-3 ────────────────────────────────────────────────────────────
#
#   • H-2 LEG-05: Venteliste guest name/phone/e-mail/note are nulled past
#     purge_after — flag OFF only counts. The party, its status and the
#     convert facts (Genvundet) survive; readers still answer.
#   • H-3 LEG-18: whatsapp_messages > 90 d, magic-link tokens 30 d past
#     expiry, anonymous paid-plan waitlist > 12 months — deleted only with
#     the flag ON; a row just inside each window is kept.
#   • The guard: with every flag ON, no row in the tables /privacy says are
#     kept (or that the accounting rules keep) moves.
#   • One failing purge never stops the others or accounting_retention.

import uuid
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.config import settings
from app.database import Base
from app.jobs import privacy_purges as pp
from app.models.audit_log import AuditLog
from app.models.customer import Customer
from app.models.daily_close import DailyClose
from app.models.event_log import EventLog
from app.models.invoice import Invoice
from app.models.magic_link_token import MagicLinkToken
from app.models.reservation import Reservation
from app.models.reservation_waitlist import ReservationWaitlistEntry
from app.models.security_event import SecurityEvent
from app.models.staff import NotificationLog
from app.models.user import User
from app.models.waitlist import WaitlistEntry
from app.models.whatsapp import WhatsAppMessage
from app.utils.time import utc_now

NOW = datetime(2026, 10, 12, 2, 30)


@pytest.fixture
def Session(monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    S = sessionmaker(bind=engine)
    monkeypatch.setattr(pp, "SessionLocal", S)
    return S


def _owner(s) -> User:
    u = User(email=f"o-{uuid.uuid4().hex[:6]}@bonbox.dk", password_hash="x",
             business_name="Bon", business_type="restaurant", currency="DKK", role="owner")
    s.add(u); s.commit(); s.refresh(u)
    return u


def _wl(s, user, *, purge_after, **kw) -> ReservationWaitlistEntry:
    row = ReservationWaitlistEntry(
        user_id=user.id, guest_name="Agnes Hansen", guest_phone="+4520202020",
        guest_email="agnes@example.dk", note="vil sidde ved vinduet",
        party_size=4, waitlist_date=date(2026, 7, 1), status=kw.pop("status", "converted"),
        purge_after=purge_after, **kw,
    )
    s.add(row); s.commit(); s.refresh(row)
    return row


# ── H-2 ──

def test_waitlist_flag_off_counts_and_writes_nothing(Session, monkeypatch):
    monkeypatch.setattr(settings, "PRIVACY_PURGE_WAITLIST_ENABLED", False)
    s = Session(); u = _owner(s)
    row = _wl(s, u, purge_after=NOW - timedelta(days=1))
    res = pp.purge_waitlist_guest_pii(now=NOW)
    assert res == {"due": 1, "purged": 0, "dry_run": True}
    s.expire_all()
    r = s.get(ReservationWaitlistEntry, row.id)
    assert r.guest_name == "Agnes Hansen" and r.guest_phone == "+4520202020"
    assert r.guest_email == "agnes@example.dk" and r.note and r.purged_at is None


def test_waitlist_flag_on_nulls_guest_fields_and_keeps_the_party(Session, monkeypatch):
    monkeypatch.setattr(settings, "PRIVACY_PURGE_WAITLIST_ENABLED", True)
    s = Session(); u = _owner(s)
    rid = uuid.uuid4()
    conv_at = datetime(2026, 7, 1, 19, 5)
    row = _wl(s, u, purge_after=NOW - timedelta(days=1),
              converted_reservation_id=rid, converted_at=conv_at)
    res = pp.purge_waitlist_guest_pii(now=NOW)
    assert res == {"due": 1, "purged": 1, "dry_run": False}
    s.expire_all()
    r = s.get(ReservationWaitlistEntry, row.id)
    assert (r.guest_name, r.guest_phone, r.guest_email, r.note) == (None, None, None, None)
    assert r.purged_at == NOW
    assert r.party_size == 4 and r.status == "converted"
    assert r.converted_at == conv_at and r.converted_reservation_id == rid
    assert r.waitlist_date == date(2026, 7, 1)


def test_waitlist_purge_is_idempotent(Session, monkeypatch):
    monkeypatch.setattr(settings, "PRIVACY_PURGE_WAITLIST_ENABLED", True)
    s = Session(); u = _owner(s)
    row = _wl(s, u, purge_after=NOW - timedelta(days=1))
    pp.purge_waitlist_guest_pii(now=NOW)
    again = pp.purge_waitlist_guest_pii(now=NOW + timedelta(days=1))
    assert again == {"due": 0, "purged": 0, "dry_run": False}
    s.expire_all()
    assert s.get(ReservationWaitlistEntry, row.id).purged_at == NOW


def test_waitlist_rows_not_yet_due_or_without_purge_after_are_untouched(Session, monkeypatch):
    monkeypatch.setattr(settings, "PRIVACY_PURGE_WAITLIST_ENABLED", True)
    s = Session(); u = _owner(s)
    tomorrow = _wl(s, u, purge_after=NOW + timedelta(days=1))
    never = _wl(s, u, purge_after=None)
    assert pp.purge_waitlist_guest_pii(now=NOW) == {"due": 0, "purged": 0, "dry_run": False}
    s.expire_all()
    for rid in (tomorrow.id, never.id):
        r = s.get(ReservationWaitlistEntry, rid)
        assert r.guest_name == "Agnes Hansen" and r.guest_phone and r.purged_at is None


def test_waitlist_batch_limit_leaves_the_rest_for_the_next_night(Session, monkeypatch):
    monkeypatch.setattr(settings, "PRIVACY_PURGE_WAITLIST_ENABLED", True)
    s = Session(); u = _owner(s)
    for d in (3, 2, 1):
        _wl(s, u, purge_after=NOW - timedelta(days=d))
    first = pp.purge_waitlist_guest_pii(now=NOW, batch=2, max_batches=1)
    assert first == {"due": 3, "purged": 2, "dry_run": False}
    second = pp.purge_waitlist_guest_pii(now=NOW, batch=2, max_batches=1)
    assert second == {"due": 1, "purged": 1, "dry_run": False}
    s.expire_all()
    assert s.query(ReservationWaitlistEntry).filter(
        ReservationWaitlistEntry.purged_at.is_(None)).count() == 0


def test_owner_venteliste_still_reads_a_purged_row(monkeypatch):
    from tests.test_reservation_waitlist import _TODAY, _add, _as, _seed
    from fastapi.testclient import TestClient
    from app.database import get_db
    from app.main import app

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    S = sessionmaker(bind=engine)
    monkeypatch.setattr(pp, "SessionLocal", S)

    def _get_test_db():
        s = S()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    try:
        client = TestClient(app)
        s = S()
        u = _seed(s)
        _as(u)
        r = _add(client, guest_email="agnes@example.dk", note="ved vinduet")
        assert r.status_code == 201, r.text
        eid = uuid.UUID(r.json()["id"])
        # Past its retention date: purge_after is in the past.
        row = s.get(ReservationWaitlistEntry, eid)
        row.purge_after = utc_now() - timedelta(days=1)
        s.commit()

        res = pp.purge_waitlist_guest_pii(enabled=True)
        assert res["purged"] == 1

        lst = client.get(f"/api/reservations/waitlist?day={_TODAY}")
        assert lst.status_code == 200, lst.text
        (entry,) = lst.json()["waitlist"]
        assert entry["id"] == str(eid)
        assert entry["guest_name"] is None and entry["guest_phone"] is None
        assert entry.get("guest_email") is None and entry.get("note") is None
        assert entry["party_size"] == 2
    finally:
        app.dependency_overrides.clear()


# ── H-3 ──

def _seed_orphans(s, user, now=NOW):
    """One row just past and one just inside each window, measured from `now`."""
    rows = {}
    rows["wa_old"] = WhatsAppMessage(phone_number="+4511111111", direction="inbound", body="hej",
                                     created_at=now - timedelta(days=90, minutes=1))
    rows["wa_new"] = WhatsAppMessage(phone_number="+4511111111", direction="inbound", body="hej",
                                     created_at=now - timedelta(days=89, hours=23))
    rows["ml_old_nouser"] = MagicLinkToken(email="a@x.dk", token_hash=uuid.uuid4().hex * 2,
                                           created_at=now - timedelta(days=31),
                                           expires_at=now - timedelta(days=30, minutes=1),
                                           request_ip="10.0.0.1")
    rows["ml_old_user"] = MagicLinkToken(email="b@x.dk", user_id=user.id,
                                         token_hash=uuid.uuid4().hex * 2,
                                         created_at=now - timedelta(days=40),
                                         expires_at=now - timedelta(days=40) + timedelta(minutes=15),
                                         used_at=now - timedelta(days=40), used_ip="10.0.0.2")
    rows["ml_new"] = MagicLinkToken(email="c@x.dk", token_hash=uuid.uuid4().hex * 2,
                                    created_at=now - timedelta(days=29, hours=23),
                                    expires_at=now - timedelta(days=29, hours=22))
    rows["wle_old_anon"] = WaitlistEntry(email="anon@x.dk", tier="pro",
                                         created_at=now - timedelta(days=366))
    rows["wle_new_anon"] = WaitlistEntry(email="anon2@x.dk", tier="pro",
                                         created_at=now - timedelta(days=364))
    rows["wle_old_user"] = WaitlistEntry(email=user.email, user_id=user.id, tier="pro",
                                         created_at=now - timedelta(days=900))
    for r in rows.values():
        s.add(r)
    s.commit()
    return {k: v.id for k, v in rows.items()}


def _orphan_purges(**kw):
    return {
        "whatsapp_messages": pp.purge_old_whatsapp_messages(now=NOW, **kw),
        "magic_link_tokens": pp.purge_expired_magic_links(now=NOW, **kw),
        "anonymous_paid_waitlist": pp.purge_anonymous_paid_waitlist(now=NOW, **kw),
    }


def test_orphans_flag_off_counts_only(Session, monkeypatch):
    monkeypatch.setattr(settings, "PRIVACY_PURGE_ORPHANS_ENABLED", False)
    s = Session(); u = _owner(s)
    _seed_orphans(s, u)
    res = _orphan_purges()
    assert res == {
        "whatsapp_messages": {"due": 1, "deleted": 0, "dry_run": True},
        "magic_link_tokens": {"due": 2, "deleted": 0, "dry_run": True},
        "anonymous_paid_waitlist": {"due": 1, "deleted": 0, "dry_run": True},
    }
    assert s.query(WhatsAppMessage).count() == 2
    assert s.query(MagicLinkToken).count() == 3
    assert s.query(WaitlistEntry).count() == 3


def test_orphans_flag_on_deletes_only_rows_past_the_window(Session, monkeypatch):
    monkeypatch.setattr(settings, "PRIVACY_PURGE_ORPHANS_ENABLED", True)
    s = Session(); u = _owner(s)
    ids = _seed_orphans(s, u)
    res = _orphan_purges()
    assert res["whatsapp_messages"] == {"due": 1, "deleted": 1, "dry_run": False}
    assert res["magic_link_tokens"] == {"due": 2, "deleted": 2, "dry_run": False}
    assert res["anonymous_paid_waitlist"] == {"due": 1, "deleted": 1, "dry_run": False}
    s.expire_all()
    assert [r.id for r in s.query(WhatsAppMessage).all()] == [ids["wa_new"]]
    assert [r.id for r in s.query(MagicLinkToken).all()] == [ids["ml_new"]]
    assert {r.id for r in s.query(WaitlistEntry).all()} == {ids["wle_new_anon"], ids["wle_old_user"]}
    # Nothing left to do.
    assert _orphan_purges() == {
        "whatsapp_messages": {"due": 0, "deleted": 0, "dry_run": False},
        "magic_link_tokens": {"due": 0, "deleted": 0, "dry_run": False},
        "anonymous_paid_waitlist": {"due": 0, "deleted": 0, "dry_run": False},
    }


def test_a_fresh_magic_link_still_verifies_and_the_rate_limit_is_unchanged(Session, monkeypatch):
    from app.services import magic_link_service as mls
    monkeypatch.setattr(settings, "PRIVACY_PURGE_ORPHANS_ENABLED", True)
    s = Session()
    raw, _row = mls.create_token(s, "fresh@bonbox.dk", request_ip="10.0.0.9")
    s.commit()

    def _recent(email):
        cutoff = utc_now() - timedelta(minutes=mls.RATE_LIMIT_WINDOW_MIN)
        return s.query(MagicLinkToken).filter(MagicLinkToken.email == email,
                                              MagicLinkToken.created_at >= cutoff,
                                              MagicLinkToken.used_at.is_(None)).count()

    before = _recent("fresh@bonbox.dk")
    res = pp.purge_expired_magic_links()  # real clock: the token is minutes old
    assert res["deleted"] == 0
    s.expire_all()
    assert _recent("fresh@bonbox.dk") == before == 1
    user = mls.verify_token(s, raw, used_ip="10.0.0.9")
    s.commit()
    assert user.email == "fresh@bonbox.dk"


def test_a_logged_in_paid_waitlist_row_of_any_age_is_kept(Session, monkeypatch):
    monkeypatch.setattr(settings, "PRIVACY_PURGE_ORPHANS_ENABLED", True)
    s = Session(); u = _owner(s)
    s.add(WaitlistEntry(email=u.email, user_id=u.id, tier="pro",
                        created_at=NOW - timedelta(days=3650)))
    s.commit()
    assert pp.purge_anonymous_paid_waitlist(now=NOW) == {"due": 0, "deleted": 0, "dry_run": False}
    assert s.query(WaitlistEntry).count() == 1


_KEPT = (Reservation, AuditLog, SecurityEvent, NotificationLog, EventLog, Invoice, DailyClose)


def test_purges_never_touch_kept_or_accounting_records(Session, monkeypatch):
    monkeypatch.setattr(settings, "PRIVACY_PURGE_WAITLIST_ENABLED", True)
    monkeypatch.setattr(settings, "PRIVACY_PURGE_ORPHANS_ENABLED", True)
    s = Session(); u = _owner(s)
    ancient = NOW - timedelta(days=4000)
    cust = Customer(user_id=u.id, name="Kunde A/S")
    s.add(cust); s.commit()
    s.add_all([
        Reservation(user_id=u.id, guest_name="Gæst", guest_phone="+4530303030",
                    starts_at=ancient, ends_at=ancient + timedelta(hours=2),
                    purge_after=ancient, created_at=ancient),
        AuditLog(user_id=u.id, action="daily_brief.email_sent", entity_type="user",
                 after_state='{"to": "o@bonbox.dk"}', ip_address="10.0.0.1", created_at=ancient),
        SecurityEvent(user_id=u.id, event_type="login_success", ip_address="10.0.0.1",
                      created_at=ancient),
        NotificationLog(user_id=u.id, channel="email", event_type="x", created_at=ancient),
        EventLog(user_id=u.id, event="page_view", created_at=ancient),
        Invoice(user_id=u.id, customer_id=cust.id, fakturanummer=1,
                due_date=ancient.date(), created_at=ancient),
        DailyClose(user_id=u.id, date=ancient.date(), created_at=ancient),
    ])
    s.commit()
    # run_privacy_purges runs on the real clock, so seed relative to it.
    _seed_orphans(s, u, now=utc_now())
    _wl(s, u, purge_after=utc_now() - timedelta(days=1))

    before = {m.__tablename__: s.query(m).count() for m in _KEPT}
    assert all(before.values()), before
    out = pp.run_privacy_purges()
    assert out["waitlist_guest_pii"]["purged"] == 1
    assert out["whatsapp_messages"]["deleted"] == 1
    s.expire_all()
    after = {m.__tablename__: s.query(m).count() for m in _KEPT}
    assert after == before
    # The reservation's own guest data is the reservation purge's job, not this one.
    assert s.query(Reservation).one().guest_name == "Gæst"


def test_one_failing_purge_never_stops_the_others_or_accounting_retention(Session, monkeypatch):
    from app.jobs import retention_and_patterns as rp
    from app.services import accounting_retention

    monkeypatch.setattr(settings, "PRIVACY_PURGE_ORPHANS_ENABLED", True)
    s = Session(); u = _owner(s)
    _seed_orphans(s, u, now=utc_now())  # daily_maintenance runs on the real clock

    def _boom(**_kw):
        raise RuntimeError("guest +4520202020 agnes@example.dk")

    monkeypatch.setattr(pp, "purge_old_whatsapp_messages", _boom)
    # The rest of nightly maintenance is not under test here.
    for name in ("purge_old_events", "expire_stale_patterns", "purge_old_error_logs",
                 "purge_expired_signup_refs"):
        monkeypatch.setattr(rp, name, lambda: 0)
    monkeypatch.setattr(rp, "detect_patterns_for_all", lambda: {})
    monkeypatch.setattr(rp, "smart_drift_scan_for_all", lambda: {})
    import app.jobs.reservation_request_expiry as rre
    monkeypatch.setattr(rre, "expire_stale_requests", lambda: {})
    from app.services import audit_email_cleanup as aec
    monkeypatch.setattr(aec, "run_cleanup", lambda: {"stub": True})
    ran = []
    monkeypatch.setattr(accounting_retention, "run_retention_sweep",
                        lambda: ran.append(1) or {"ok": True})

    summary = rp.daily_maintenance()
    pps = summary["privacy_purges"]
    assert pps["whatsapp_messages"] == {"error": "RuntimeError"}
    assert pps["magic_link_tokens"]["deleted"] == 2
    assert pps["anonymous_paid_waitlist"]["deleted"] == 1
    assert pps["waitlist_guest_pii"]["dry_run"] is True  # its own flag is OFF
    assert summary["accounting_retention"] == {"ok": True} and ran == [1]
    # Counts and error names only — never the exception text.
    assert "agnes" not in repr(summary) and "+4520" not in repr(summary)


def test_dry_run_counts_match_what_the_purges_would_do(Session):
    s = Session(); u = _owner(s)
    _seed_orphans(s, u)
    _wl(s, u, purge_after=NOW - timedelta(days=1))
    assert pp.dry_run_counts(s, now=NOW) == {
        "waitlist_guest_pii": 1, "whatsapp_messages": 1,
        "magic_link_tokens": 2, "anonymous_paid_waitlist": 1,
    }


def test_flags_default_off():
    from app.config import Settings
    for name in ("PRIVACY_PURGE_WAITLIST_ENABLED", "PRIVACY_PURGE_ORPHANS_ENABLED",
                 "AUDIT_EMAIL_CLEANUP_ENABLED"):
        assert Settings.model_fields[name].default is False, name
