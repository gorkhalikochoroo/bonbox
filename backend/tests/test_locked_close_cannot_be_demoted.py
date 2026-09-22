"""A locked kasserapport must not be rewritten by a timer.

THE DEFECT. The lock guard in create_daily_close read:

    if existing_status == "confirmed" and status != "draft":
        raise HTTPException(409, "This daily close is locked...")

so a POST carrying status="draft" walked PAST the guard into the unconditional
update block below it — which ends with `existing.status = status` and
overwrites revenue_total, payment_total, moms_total, cash figures and notes.

WHY THAT IS NOT A THEORETICAL HOLE. DailyClosePage auto-saves a draft two
seconds after any step or amount change:

    autoSaveRef.current = setTimeout(async () => {
      try { await api.post("/daily-close", buildPayload("draft")); }
      catch { /* Silent — auto-save is best-effort */ }
    }, 2000);

So an owner who locks the day at 23:40 and reopens Daily Close the next morning
to look at what they filed demotes that signed record to KLADDE and replaces
its MOMS — with no unlock_reason, no unlocked_by, no unlocked_at, and no error,
because the caller swallows the response. Bogføringsloven §10 wants an
append-only trail; this was a silent destructive edit performed by a timer.

THE ONE LEGITIMATE WAY OUT of "confirmed" is POST /{close_id}/unlock, which
refuses without a written reason (422) and writes its own audit row. These
tests pin that the wizard path cannot imitate it.
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.daily_close import DailyClose
from app.models.user import User
from app.services.auth import hash_password, create_access_token
from app.utils.time import utc_now

_db_ready.set()

DAY = "2026-09-19"


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

    def _override_get_db():
        try:
            yield s
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client():
    yield TestClient(app)
    app.dependency_overrides.clear()


def _user(db, email="manoj@cafe.dk"):
    u = User(
        email=email,
        password_hash=hash_password("x"),
        business_name="Café Manoj",
        business_type="restaurant",
        currency="DKK",
        created_at=utc_now() - timedelta(days=2),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _headers(u):
    return {"Authorization": f"Bearer {create_access_token(str(u.id))}"}


def _lock_a_day(client, u, revenue=17030):
    """The 23:40 close: a real day, confirmed."""
    r = client.post("/api/daily-close", headers=_headers(u), json={
        "date": DAY,
        "status": "confirmed",
        "revenue_breakdown": {"food": revenue},
        "payment_breakdown": {"kontant": revenue},
    })
    assert r.status_code == 200, r.text
    return r


class TestTheAutoSaveCannotUnlockTheDay:
    def test_a_draft_post_over_a_confirmed_close_is_refused(self, db_session, client):
        """The exact shape the wizard's timer sends."""
        u = _user(db_session)
        _lock_a_day(client, u)

        r = client.post("/api/daily-close", headers=_headers(u), json={
            "date": DAY,
            "status": "draft",
            "revenue_breakdown": {"food": 1},
        })
        assert r.status_code == 409, (
            f"a status=draft POST was accepted over a locked close ({r.status_code}) "
            f"— the lock exemption is back"
        )

    def test_the_row_still_says_confirmed(self, db_session, client):
        u = _user(db_session)
        _lock_a_day(client, u)

        client.post("/api/daily-close", headers=_headers(u), json={
            "date": DAY, "status": "draft", "revenue_breakdown": {"food": 1},
        })

        db_session.expire_all()
        dc = db_session.query(DailyClose).filter(DailyClose.user_id == u.id).first()
        assert (dc.status or "confirmed") == "confirmed", "the close was demoted to draft"

    def test_the_money_is_untouched(self, db_session, client):
        """The part that reaches the revisor. A demotion also rewrote the
        figures, so pin the figures and not just the status flag."""
        u = _user(db_session)
        _lock_a_day(client, u, revenue=17030)

        client.post("/api/daily-close", headers=_headers(u), json={
            "date": DAY, "status": "draft", "revenue_breakdown": {"food": 1},
        })

        db_session.expire_all()
        dc = db_session.query(DailyClose).filter(DailyClose.user_id == u.id).first()
        assert float(dc.revenue_total) == 17030.0, (
            f"the filed revenue became {dc.revenue_total} — a signed record was rewritten"
        )

    def test_no_phantom_unlock_trail_is_written(self, db_session, client):
        """If a close ever DOES leave 'confirmed', it must carry the reason the
        unlock endpoint demands. A demotion through this path left all three
        unlock columns NULL, which is what made it invisible."""
        u = _user(db_session)
        _lock_a_day(client, u)
        client.post("/api/daily-close", headers=_headers(u), json={
            "date": DAY, "status": "draft", "revenue_breakdown": {"food": 1},
        })

        db_session.expire_all()
        dc = db_session.query(DailyClose).filter(DailyClose.user_id == u.id).first()
        if (dc.status or "confirmed") != "confirmed":
            assert dc.unlock_reason, "left 'confirmed' with no reason recorded"


class TestTheRealUnlockStillWorks:
    """The fix must close the hole without sealing the door."""

    def test_unlock_demands_a_reason(self, db_session, client):
        u = _user(db_session)
        _lock_a_day(client, u)
        dc = db_session.query(DailyClose).filter(DailyClose.user_id == u.id).first()

        r = client.post(f"/api/daily-close/{dc.id}/unlock",
                        headers=_headers(u), json={"reason": ""})
        assert r.status_code in (400, 422), r.text

    def test_unlock_with_a_reason_releases_the_day_and_records_why(self, db_session, client):
        u = _user(db_session)
        _lock_a_day(client, u)
        dc = db_session.query(DailyClose).filter(DailyClose.user_id == u.id).first()

        r = client.post(f"/api/daily-close/{dc.id}/unlock", headers=_headers(u),
                        json={"reason": "Forkert kontantbeløb indtastet"})
        assert r.status_code == 200, r.text

        db_session.expire_all()
        dc = db_session.query(DailyClose).filter(DailyClose.user_id == u.id).first()
        assert (dc.status or "") == "draft"
        assert dc.unlock_reason == "Forkert kontantbeløb indtastet"

    def test_and_then_the_wizard_may_save_again(self, db_session, client):
        """After a real unlock the auto-save is legitimate — the guard keys on
        the row's status, not on a blanket ban."""
        u = _user(db_session)
        _lock_a_day(client, u)
        dc = db_session.query(DailyClose).filter(DailyClose.user_id == u.id).first()
        client.post(f"/api/daily-close/{dc.id}/unlock", headers=_headers(u),
                    json={"reason": "Rettelse"})

        r = client.post("/api/daily-close", headers=_headers(u), json={
            "date": DAY, "status": "draft", "revenue_breakdown": {"food": 900},
        })
        assert r.status_code == 200, r.text
        db_session.expire_all()
        dc = db_session.query(DailyClose).filter(DailyClose.user_id == u.id).first()
        assert float(dc.revenue_total) == 900.0


class TestConfirmingOverAConfirmedDayIsStillRefused:
    def test_a_second_confirm_still_409s(self, db_session, client):
        """Unchanged behaviour — pinned so the fix cannot be 'simplified' into
        allowing re-confirmation without an unlock."""
        u = _user(db_session)
        _lock_a_day(client, u)
        r = client.post("/api/daily-close", headers=_headers(u), json={
            "date": DAY, "status": "confirmed", "revenue_breakdown": {"food": 5},
        })
        assert r.status_code == 409, r.text
