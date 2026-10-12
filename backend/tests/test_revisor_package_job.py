"""Scheduled revisor packages — fixed clock, mocked e-mail.

Once per period per recipient; only periods that fell due after the owner
switched the schedule on; skipped (with a reason) while the owner's e-mail is
unconfirmed and sent once it is; failures retried 3 times and reported to ops
through `send_error`; expired ZIPs purged.

Run:
  cd backend && python3 -m pytest tests/test_revisor_package_job.py -q
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.jobs.revisor_package_job import (
    due_period, next_due_period, purge_expired, run_revisor_package_schedule,
)
from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose
from app.models.revisor_package import RevisorPackageSend
from app.models.user import User
from app.services import storage as storage_mod

# Every model on the metadata before create_all (the package reads gift-card
# orders, reservations … that app.models/__init__ does not import).
import importlib as _il
import pkgutil as _pu
import app.models as _models
for _m in _pu.iter_modules(_models.__path__):
    _il.import_module(f"app.models.{_m.name}")

CPH = ZoneInfo("Europe/Copenhagen")


def utc(y, m, d, hh=0, mm=0):
    """A Copenhagen wall time as naive UTC (what utc_now() returns)."""
    return datetime(y, m, d, hh, mm, tzinfo=CPH).astimezone(ZoneInfo("UTC")).replace(tzinfo=None)


class FakeStorage(storage_mod.StorageBackend):
    is_durable = True

    def __init__(self):
        self.blobs = {}

    def put(self, key, data, content_type="image/jpeg"):
        self.blobs[key] = data
        return key

    def get(self, key):
        return self.blobs.get(key)

    def delete(self, key):
        return self.blobs.pop(key, None) is not None


@pytest.fixture
def store(monkeypatch):
    fake = FakeStorage()
    monkeypatch.setattr(storage_mod, "_backend", fake)
    yield fake
    storage_mod.reset_storage_for_tests()


@pytest.fixture
def factory(monkeypatch):
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    SessionLocal = sessionmaker(bind=eng)
    import app.database as _dbm
    monkeypatch.setattr(_dbm, "SessionLocal", SessionLocal, raising=False)
    monkeypatch.setattr("app.services.billing.SessionLocal", SessionLocal, raising=False)
    return SessionLocal


class _Mailbox(list):
    state: dict


@pytest.fixture
def mailbox(monkeypatch):
    sent = _Mailbox()
    state = {"fail": False}

    def _send(payload):
        if state["fail"]:
            raise RuntimeError("resend down")
        sent.append(payload)
        return {"id": "x"}

    monkeypatch.setattr("app.services.email_service.resend.Emails.send", _send)
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")
    sent.state = state  # type: ignore[attr-defined]
    return sent


def _revisor_mails(mailbox):
    return [m for m in mailbox if m["to"] == ["pia@revisorhuset.dk"]]


def _owner(factory, *, schedule="monthly", since=None, verified=True, plan="starter"):
    db = factory()
    u = User(email=f"ejer-{uuid.uuid4().hex[:6]}@cafe.dk", password_hash="x",
             business_name="Café Hygge", business_type="cafe", currency="DKK",
             plan=plan, email_verified=verified, timezone="Europe/Copenhagen")
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(user_id=u.id, company_name="Café Hygge ApS", org_number="12345678",
                           accountant_email="pia@revisorhuset.dk",
                           revisor_package_schedule=schedule,
                           revisor_package_schedule_at=since or utc(2026, 9, 1)))
    db.add(DailyClose(user_id=u.id, date=date(2026, 10, 1), revenue_total=1000,
                      moms_total=200, status="confirmed"))
    db.commit()
    uid = u.id
    db.close()
    return uid


def test_due_period_monthly_and_weekly():
    assert due_period("monthly", utc(2026, 11, 3, 7, 20), CPH)[:3] == (
        "month", date(2026, 10, 1), date(2026, 10, 31))
    # Before 07:00 on the 3rd it is still the previous month's run.
    assert due_period("monthly", utc(2026, 11, 3, 6, 59), CPH)[1:3] == (
        date(2026, 9, 1), date(2026, 9, 30))
    # Monday 07:20 → the Monday–Sunday before.
    assert due_period("weekly", utc(2026, 10, 12, 7, 20), CPH)[:3] == (
        "week", date(2026, 10, 5), date(2026, 10, 11))
    assert due_period("weekly", utc(2026, 10, 12, 6, 0), CPH)[1:3] == (
        date(2026, 9, 28), date(2026, 10, 4))
    nxt = next_due_period("monthly", utc(2026, 11, 3, 7, 20), CPH)
    assert nxt[1:3] == (date(2026, 11, 1), date(2026, 11, 30))


def test_monthly_sends_once_per_period_and_recipient(factory, store, mailbox):
    uid = _owner(factory)
    s1 = run_revisor_package_schedule(db_factory=factory, now=utc(2026, 11, 3, 7, 20))
    assert s1["sent"] == 1 and "send_error" not in s1
    assert len(_revisor_mails(mailbox)) == 1
    assert _revisor_mails(mailbox)[0]["subject"].startswith("Revisorpakke oktober 2026")
    # The next hour, the next day: nothing more for October.
    run_revisor_package_schedule(db_factory=factory, now=utc(2026, 11, 3, 8, 20))
    run_revisor_package_schedule(db_factory=factory, now=utc(2026, 11, 4, 9, 20))
    assert len(_revisor_mails(mailbox)) == 1
    db = factory()
    row = db.query(RevisorPackageSend).filter(RevisorPackageSend.user_id == uid).one()
    assert row.send_trigger == "scheduled" and row.status == "sent"
    assert row.dedup_key.startswith("sched:2026-10-01:2026-10-31:")
    assert "automatisk" in _revisor_mails(mailbox)[0]["html"]


def test_switching_on_after_the_due_moment_waits_for_the_next_period(factory, store, mailbox):
    _owner(factory, since=utc(2026, 11, 3, 9, 0))
    run_revisor_package_schedule(db_factory=factory, now=utc(2026, 11, 3, 10, 20))
    assert _revisor_mails(mailbox) == []
    run_revisor_package_schedule(db_factory=factory, now=utc(2026, 12, 3, 7, 20))
    mails = _revisor_mails(mailbox)
    assert len(mails) == 1 and mails[0]["subject"].startswith("Revisorpakke november 2026")


def test_weekly_monday_morning_previous_week(factory, store, mailbox):
    _owner(factory, schedule="weekly")
    run_revisor_package_schedule(db_factory=factory, now=utc(2026, 10, 12, 7, 20))
    mails = _revisor_mails(mailbox)
    assert len(mails) == 1 and mails[0]["subject"].startswith("Revisorpakke uge 41")


def test_unverified_owner_is_skipped_then_sent_once_confirmed(factory, store, mailbox):
    uid = _owner(factory, verified=False)
    s = run_revisor_package_schedule(db_factory=factory, now=utc(2026, 11, 3, 7, 20))
    assert s["skipped"] == 1 and _revisor_mails(mailbox) == []
    db = factory()
    row = db.query(RevisorPackageSend).filter(RevisorPackageSend.user_id == uid).one()
    assert row.status == "skipped" and row.skip_reason == "email_unverified"
    assert db.query(AuditLog).filter(AuditLog.action == "revisor_package.skipped").count() == 1
    # A second hour does not log the same skip again.
    db.close()
    run_revisor_package_schedule(db_factory=factory, now=utc(2026, 11, 3, 8, 20))
    db = factory()
    assert db.query(AuditLog).filter(AuditLog.action == "revisor_package.skipped").count() == 1
    db.query(User).filter(User.id == uid).update({"email_verified": True})
    db.commit(); db.close()
    s = run_revisor_package_schedule(db_factory=factory, now=utc(2026, 11, 3, 9, 20))
    assert s["sent"] == 1 and len(_revisor_mails(mailbox)) == 1


def test_mail_failure_is_retried_three_times_and_reported(factory, store, mailbox):
    uid = _owner(factory)
    mailbox.state["fail"] = True
    s = run_revisor_package_schedule(db_factory=factory, now=utc(2026, 11, 3, 7, 20))
    assert s["failed"] == 1 and s["send_error"].startswith("mail")
    for h in (8, 9, 10, 11):
        run_revisor_package_schedule(db_factory=factory, now=utc(2026, 11, 3, h, 20))
    db = factory()
    row = db.query(RevisorPackageSend).filter(RevisorPackageSend.user_id == uid).one()
    assert row.status == "failed" and row.attempts == 3
    assert store.blobs == {}                          # no orphan ZIP left behind
    mailbox.state["fail"] = False
    run_revisor_package_schedule(db_factory=factory, now=utc(2026, 11, 3, 12, 20))
    assert _revisor_mails(mailbox) == []              # gave up — ops was told


def test_a_crashed_claim_is_never_sent_twice(factory, store, mailbox):
    uid = _owner(factory)
    db = factory()
    from app.services import revisor_mail as rm
    fp = rm.address_fingerprint("pia@revisorhuset.dk")
    db.add(RevisorPackageSend(user_id=uid, period_kind="month", period_start=date(2026, 10, 1),
                              period_end=date(2026, 10, 31), send_trigger="scheduled",
                              dedup_key=f"sched:2026-10-01:2026-10-31:{fp}", status="claimed",
                              attempts=1, created_at=utc(2026, 11, 3, 6, 20),
                              updated_at=utc(2026, 11, 3, 6, 20)))
    db.commit(); db.close()
    s = run_revisor_package_schedule(db_factory=factory, now=utc(2026, 11, 3, 7, 20))
    assert _revisor_mails(mailbox) == [] and s["send_error"] == "stale_claim"


def test_plan_without_the_flag_is_skipped(factory, store, mailbox):
    uid = _owner(factory, plan="free")
    run_revisor_package_schedule(db_factory=factory, now=utc(2026, 11, 3, 7, 20))
    db = factory()
    assert db.query(RevisorPackageSend).filter(
        RevisorPackageSend.user_id == uid).one().skip_reason == "plan"
    assert _revisor_mails(mailbox) == []


def test_expired_zip_is_purged(factory, store, mailbox):
    uid = _owner(factory)
    run_revisor_package_schedule(db_factory=factory, now=utc(2026, 11, 3, 7, 20))
    assert len(store.blobs) == 1
    db = factory()
    n = purge_expired(db, now=utc(2026, 11, 18, 8, 0))   # 15 days later
    assert n == 1 and store.blobs == {}
    row = db.query(RevisorPackageSend).filter(RevisorPackageSend.user_id == uid).one()
    assert row.purged_at is not None
