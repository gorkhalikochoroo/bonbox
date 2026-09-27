"""Security review, September 2026 — the boundaries it found open.

Each test pins one finding so a later edit cannot quietly reopen it:
  • the GDPR data export (the owner's whole business in one CSV) is not a
    member read — get_current_user hands a member the OWNER's identity, so a
    cashier downloaded it with their own token;
  • the schedule autopilot and demand forecast carry per-shift `cost` and the
    roster's `avg_rate` — per-person pay by another name — and sat on no wage
    deny-list: they are redacted for every audience _wage_visible() excludes.

  cd backend && pytest tests/test_security_review_sep2026.py -v
"""
from app.main import (
    _MANAGER_READ_DENY_PREFIXES,
    _MEMBER_READ_DENY_PREFIXES,
    _is_sensitive_member_read_path,
)
from app.routers.staff import _SCHEDULE_WAGE_FIELDS, _strip_schedule_wages


class TestTheGdprExportIsOwnerOnly:
    def test_members_and_managers_are_denied(self):
        assert "/api/auth/export-data" in _MEMBER_READ_DENY_PREFIXES
        assert "/api/auth/export-data" in _MANAGER_READ_DENY_PREFIXES

    def test_the_real_url_is_caught(self):
        assert _is_sensitive_member_read_path("/api/auth/export-data") is True
        assert _is_sensitive_member_read_path("/api/auth/export-data?format=csv") is True

    def test_a_members_own_auth_reads_stay_open(self):
        # The deny must not swallow /api/auth/me and friends.
        assert _is_sensitive_member_read_path("/api/auth/me") is False


class TestScheduleMoneyIsRedactedForNonOwners:
    SUGGESTION = {
        "week_start": "2026-09-28",
        "week_total_cost": 18450.0,
        "week_total_hours": 112.5,
        "last_week_cost": 17200.0,
        "days": [
            {"date": "2026-09-28", "total_cost": 2300.0, "total_hours": 14.0,
             "shifts": [{"staff_id": "a", "start": "10:00", "end": "18:00",
                         "hours": 7.5, "cost": 1237.5}]},
        ],
        "forecast": {"avg_rate": 163.5, "predicted_covers": 140},
    }

    def test_every_money_field_is_nulled_at_any_depth(self):
        out = _strip_schedule_wages(self.SUGGESTION)
        assert out["week_total_cost"] is None and out["last_week_cost"] is None
        assert out["days"][0]["total_cost"] is None
        assert out["days"][0]["shifts"][0]["cost"] is None
        assert out["forecast"]["avg_rate"] is None

    def test_the_plan_itself_survives(self):
        out = _strip_schedule_wages(self.SUGGESTION)
        assert out["week_total_hours"] == 112.5
        assert out["days"][0]["shifts"][0]["hours"] == 7.5
        assert out["days"][0]["shifts"][0]["start"] == "10:00"
        assert out["forecast"]["predicted_covers"] == 140

    def test_the_field_set_covers_what_the_service_emits(self):
        # If schedule_autopilot grows a new money field, it must be added here.
        import re
        from pathlib import Path
        src = (Path(__file__).resolve().parents[1] / "app/services/schedule_autopilot.py").read_text()
        emitted = set(re.findall(r'"([a-z_]*(?:cost|rate|wage|pay)[a-z_]*)":', src))
        assert emitted <= _SCHEDULE_WAGE_FIELDS, f"unredacted money fields: {emitted - _SCHEDULE_WAGE_FIELDS}"


class TestAnExpiredHoldDoesNotSellOutAnEvent:
    """One anonymous POST with a large qty created a pending hold that counted
    toward capacity forever: expiry was left to a sweep nothing schedules. The
    capacity count now reads the hold's own expires_at."""

    def _setup(self):
        from datetime import date
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from sqlalchemy.pool import StaticPool
        from app.database import Base
        from app.models.event import Event
        from app.models.user import User

        eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                            poolclass=StaticPool)
        Base.metadata.create_all(eng)
        db = sessionmaker(bind=eng)()
        u = User(email="org@bonbox.test", password_hash="x", business_name="Forening",
                 currency="DKK", plan="free")
        db.add(u); db.commit(); db.refresh(u)
        ev = Event(user_id=u.id, name="Dashain", event_date=date(2026, 10, 10),
                   published=True, capacity_total=100)
        db.add(ev); db.commit(); db.refresh(ev)
        return db, u, ev

    def _hold(self, db, u, ev, qty, status="pending", expires_at=None):
        from app.models.booking import Booking
        db.add(Booking(event_id=ev.id, organizer_user_id=u.id, customer_email="g@example.com",
                       customer_name="G", ticket_lines=[{"label": "Voksen", "qty": qty,
                                                          "unit_price_dkk": 150}],
                       total_amount_dkk=150 * qty, status=status, expires_at=expires_at))
        db.commit()

    def test_a_lapsed_hold_frees_its_seats(self):
        from datetime import timedelta
        from app.routers.public_bookings import _sold_tickets_count
        from app.utils.time import utc_now
        db, u, ev = self._setup()
        self._hold(db, u, ev, 100, expires_at=utc_now() - timedelta(minutes=1))
        assert _sold_tickets_count(db, ev) == 0

    def test_a_live_hold_and_paid_tickets_still_count(self):
        from datetime import timedelta
        from app.routers.public_bookings import _sold_tickets_count
        from app.utils.time import utc_now
        db, u, ev = self._setup()
        self._hold(db, u, ev, 4, expires_at=utc_now() + timedelta(minutes=20))
        self._hold(db, u, ev, 3, status="paid")
        self._hold(db, u, ev, 2, status="attended")
        self._hold(db, u, ev, 9, status="cancelled")
        assert _sold_tickets_count(db, ev) == 9


def test_no_rate_limiter_keys_on_the_proxy():
    """Behind Render's proxy the socket peer is the proxy: a limiter keyed on
    get_remote_address puts every client on the internet in one bucket. The
    stand pairing-code limiter was the last one."""
    import re
    from pathlib import Path
    app_dir = Path(__file__).resolve().parents[1] / "app"
    offenders = [str(p.relative_to(app_dir)) for p in app_dir.rglob("*.py")
                 if re.search(r"Limiter\(\s*key_func\s*=\s*get_remote_address", p.read_text())]
    assert offenders == [], f"limiters keyed on the proxy address: {offenders}"
