"""abuse_monitor_job — one alert per incident, counts only, never raises.

The caps act in the request path and bump in-process counters; this job turns
them into at most one operator alert per kind per incident (and per 6 hours),
a "back to normal" note after 30 quiet minutes, and one ErrorLog row per
incident for /admin/recent-errors. Drives the job tick by tick on an in-memory
DB with send_email and the push fan-out captured.

Run: cd backend && python -m pytest tests/test_abuse_monitor.py -q
"""
from __future__ import annotations

import re
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.jobs.abuse_monitor_job as amj
from app.config import settings
from app.database import Base
from app.models.error_log import ErrorLog
from app.models.monitor_state import MonitorState
from app.models.user import User
from app.utils import abuse_signals
from app.utils.time import utc_now

OPS = ["ops1@example.com", "ops2@example.com"]
IP_RE = re.compile(r"\d+\.\d+\.\d+\.\d+")


@pytest.fixture
def h(monkeypatch):
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    monkeypatch.setattr(amj, "SessionLocal", Session)
    monkeypatch.setattr(settings, "SUPER_ADMIN_EMAILS", ",".join(OPS))
    monkeypatch.setattr(settings, "ADMIN_EMAIL", "")

    mails, pushes = [], []
    monkeypatch.setattr(amj, "send_email",
                        lambda to, subject, html, **k: mails.append((to, subject, html)) or True)
    monkeypatch.setattr(amj, "_push_operators",
                        lambda db, title, body: pushes.append((title, body)))
    abuse_signals.reset()

    class H:
        pass

    x = H()
    x.Session, x.mails, x.pushes = Session, mails, pushes

    def tick(**signals):
        for kind, n in signals.items():
            abuse_signals.bump(kind, n)
        return amj.run_abuse_monitor_tick()

    def row(service):
        db = Session()
        try:
            return db.query(MonitorState).filter(MonitorState.service == service).one()
        finally:
            db.close()

    def incidents(service=None):
        db = Session()
        try:
            q = db.query(ErrorLog).filter(ErrorLog.method == "MONITOR")
            if service:
                q = q.filter(ErrorLog.error_type == f"monitor:{service}")
            return q.all()
        finally:
            db.close()

    def quiet(n):
        for _ in range(n):
            tick()

    x.tick, x.row, x.incidents, x.quiet = tick, row, incidents, quiet
    yield x
    abuse_signals.reset()


def test_no_signals_six_healthy_rows_and_no_mail(h):
    out = h.tick()
    assert out == {s: "HEALTHY" for s in amj.SERVICES}
    for s in amj.SERVICES:
        r = h.row(s)
        assert r.state == "HEALTHY" and r.last_check_at is not None and r.last_summary
    assert h.mails == [] and h.pushes == [] and h.incidents() == []


def test_no_edge_summary_is_readable_counts(h):
    h.tick(edge=412, no_edge=0)
    assert h.row("abuse_no_edge").last_summary == "edge=412 no_edge=0"


def test_magic_link_trip_alerts_once(h):
    h.tick(magic_link_fleet=1)
    r = h.row("abuse_magic_link")
    assert r.state == "BROKEN" and r.broken_since is not None and r.last_alert_at is not None
    assert len(h.incidents("abuse_magic_link")) == 1
    assert sorted(to for to, _, _ in h.mails) == sorted(OPS)
    assert all(subj == "BonBox: sign-in link ceiling reached, links held back" for _, subj, _ in h.mails)
    assert h.pushes == [("BonBox: sign-in links held back",
                         "Sign-in mail ceiling reached. Existing owners still get links. Details by e-mail.")]
    # The other kinds are untouched.
    assert h.row("abuse_guest_mail").state == "HEALTHY"

    # A second tripped tick: still BROKEN, no new mail, no new incident row.
    h.tick(magic_link_domain=3)
    assert h.row("abuse_magic_link").state == "BROKEN"
    assert len(h.mails) == 2 and len(h.pushes) == 1
    assert len(h.incidents("abuse_magic_link")) == 1


def test_fifteen_quiet_ticks_recover_with_one_mail_and_no_push(h):
    h.tick(magic_link_fleet=1)
    h.mails.clear(), h.pushes.clear()
    h.quiet(14)
    assert h.row("abuse_magic_link").state == "BROKEN"
    assert h.mails == []
    h.quiet(1)
    r = h.row("abuse_magic_link")
    assert r.state == "HEALTHY" and r.broken_since is None
    assert r.last_alert_at is not None                      # kept: the 6-hour gap holds
    assert [subj for _, subj, _ in h.mails] == ["BonBox: sign-in link ceiling back to normal"] * len(OPS)
    assert "No more sign-in link ceiling events for 30 minutes" in h.mails[0][2]
    assert h.pushes == []
    h.quiet(5)
    assert len(h.mails) == len(OPS)                          # recovered once


def test_a_new_trip_within_six_hours_logs_but_does_not_mail(h):
    h.tick(guest_mail_fleet=2)
    h.quiet(15)
    assert h.row("abuse_guest_mail").state == "HEALTHY"
    h.mails.clear(), h.pushes.clear()

    h.tick(guest_mail_fleet=1)
    assert h.row("abuse_guest_mail").state == "BROKEN"
    assert len(h.incidents("abuse_guest_mail")) == 2           # a row per incident
    assert h.mails == [] and h.pushes == []                    # but no second alert in 6 h
    # This incident sent no alert, so its recovery sends no "back to normal".
    h.quiet(15)
    assert h.row("abuse_guest_mail").state == "HEALTHY"
    assert h.mails == []


def test_a_trip_after_six_hours_alerts_again(h):
    h.tick(staff_join_cooloff=1)
    h.quiet(15)
    db = h.Session()
    st = db.query(MonitorState).filter(MonitorState.service == "abuse_staff_join").one()
    st.last_alert_at = utc_now() - timedelta(hours=6, minutes=1)
    db.commit()
    db.close()
    h.mails.clear(), h.pushes.clear()
    h.tick(staff_join_cooloff=1)
    assert len(h.mails) == len(OPS)
    assert h.mails[0][1] == "BonBox: staff join codes paused (global cool-off)"
    assert h.pushes == [("BonBox: staff join paused", "Burst of wrong join codes from many addresses.")]


def test_stand_join_has_its_own_row_and_copy(h):
    h.tick(stand_join_cooloff=1)
    assert h.row("abuse_stand_join").state == "BROKEN"
    assert h.row("abuse_staff_join").state == "HEALTHY"
    subj, body = h.mails[0][1], h.mails[0][2]
    assert subj == "BonBox: host-stand pairing codes paused (global cool-off)"
    assert "wrong host-stand pairing codes" in body
    assert "Paired stands are not affected." in body


def _add_users(Session, n):
    db = Session()
    for _ in range(n):
        db.add(User(email=f"u-{uuid.uuid4().hex[:10]}@example.com", password_hash="x",
                    business_name="Cafe", created_at=utc_now()))
    db.commit()
    db.close()


def test_twenty_new_accounts_in_an_hour_is_a_signup_burst(h):
    _add_users(h.Session, 19)
    h.tick()
    assert h.row("abuse_signups").state == "HEALTHY"
    _add_users(h.Session, 1)
    h.tick()
    assert h.row("abuse_signups").state == "BROKEN"
    assert h.mails[0][1] == "BonBox: unusual number of new accounts"
    assert h.pushes == [("BonBox: signup burst", "20 new accounts in the last hour.")]
    assert "Nothing is blocked." in h.mails[0][2]


def test_signup_day_threshold_and_zero_switches_off(h, monkeypatch):
    monkeypatch.setattr(settings, "SIGNUP_ALERT_PER_HOUR", 0)
    monkeypatch.setattr(settings, "SIGNUP_ALERT_PER_DAY", 0)
    _add_users(h.Session, 25)
    h.tick()
    assert h.row("abuse_signups").state == "HEALTHY"
    monkeypatch.setattr(settings, "SIGNUP_ALERT_PER_DAY", 25)
    h.tick()
    assert h.row("abuse_signups").state == "BROKEN"


def test_no_edge_threshold(h):
    h.tick(no_edge=19, edge=5)
    assert h.row("abuse_no_edge").state == "HEALTHY"
    h.tick(no_edge=20, edge=5)
    assert h.row("abuse_no_edge").state == "BROKEN"
    assert h.mails[0][1] == "BonBox: requests arriving without the edge address header"
    assert "20 requests in the last 2 minutes" in h.mails[0][2]
    assert "CLIENT_IP_FAIL_CLOSED=false" in h.mails[0][2]


def test_no_edge_zero_switches_the_alert_off(h, monkeypatch):
    monkeypatch.setattr(settings, "NO_EDGE_ALERT_PER_TICK", 0)
    h.tick(no_edge=10_000)
    assert h.row("abuse_no_edge").state == "HEALTHY"


def test_a_db_error_returns_a_dict_and_keeps_the_counts(monkeypatch):
    broken = sessionmaker(bind=create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool))
    monkeypatch.setattr(amj, "SessionLocal", broken)       # no tables → OperationalError
    abuse_signals.reset()
    abuse_signals.bump("magic_link_fleet", 2)
    out = amj.run_abuse_monitor_tick()
    assert isinstance(out, dict) and "error" in out
    assert abuse_signals.drain() == {"magic_link_fleet": 2}  # put back for the next tick


def test_alerts_carry_no_address_and_no_ip(h, monkeypatch):
    _add_users(h.Session, 20)
    h.tick(magic_link_fleet=2, magic_link_domain=1, guest_mail_fleet=3,
           staff_join_cooloff=1, stand_join_cooloff=1, no_edge=50, edge=7)
    assert {h.row(s).state for s in amj.SERVICES} == {"BROKEN"}
    # The 20 accounts stay in the window; raise the bar so every kind goes quiet.
    monkeypatch.setattr(settings, "SIGNUP_ALERT_PER_HOUR", 1000)
    monkeypatch.setattr(settings, "SIGNUP_ALERT_PER_DAY", 1000)
    h.quiet(15)
    assert {h.row(s).state for s in amj.SERVICES} == {"HEALTHY"}
    assert len(h.mails) == 2 * len(amj.SERVICES) * len(OPS)   # alert + recovered, per operator
    assert len(h.pushes) == len(amj.SERVICES)
    texts = [subj for _, subj, _ in h.mails] + [body for _, _, body in h.mails]
    texts += [t for p in h.pushes for t in p]
    texts += [r.message for r in h.incidents()]
    texts += [h.row(s).last_summary for s in amj.SERVICES]
    for t in texts:
        assert "@" not in t, t
        assert not IP_RE.search(t), t


def test_service_names_fit_the_column():
    assert all(len(s) <= 50 for s in amj.SERVICES)
    assert len(set(amj.SERVICES)) == 6
    assert "frontend_prod" not in amj.SERVICES
