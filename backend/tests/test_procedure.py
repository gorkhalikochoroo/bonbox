"""Procedurebeskrivelse (Bogføringsloven § 6) — prefill honesty + PDF flow.

Pins the honesty rails:
  • prefill marks facts as observed ONLY when real rows back them
  • the PDF requires SAVED (owner-confirmed) answers — 404 on prefill-only
  • answers are bounded + key-validated (unknown key = loud 422, not silent)
  • the generated PDF is a real PDF and an export audit row is written
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register all models
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose
from app.models.user import User
from app.services import procedure_service
from app.services.auth import hash_password, get_current_user
from app.utils.time import utc_now

_db_ready.set()


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
    s.execute(text("PRAGMA foreign_keys=ON"))

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


def _seed_owner(db, with_closes: int = 0) -> User:
    u = User(
        email="procedure@example.com",
        password_hash=hash_password("Secret1234"),
        business_name="Café Procedure",
        business_type="restaurant",
        currency="DKK",
        role="owner",
        email_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    db.add(BusinessProfile(user_id=u.id, org_number="12345678"))
    today = utc_now().date()
    for i in range(with_closes):
        db.add(DailyClose(
            user_id=u.id,
            date=today - timedelta(days=i + 1),
            closed_at=utc_now() - timedelta(days=i + 1),
        ))
    db.commit()
    return u


# ── prefill honesty ────────────────────────────────────────────────────

def test_prefill_observes_only_whats_real(db_session, client):
    user = _seed_owner(db_session, with_closes=5)
    app.dependency_overrides[get_current_user] = lambda: user

    r = client.get("/api/reports/procedure")
    assert r.status_code == 200, r.text
    body = r.json()

    # CVR observed from the profile.
    assert body["prefill"]["cvr"]["basis"] == "observed"
    assert "12345678" in body["prefill"]["cvr"]["suggested"]
    # Daily-close cadence observed (5 real closes seeded).
    assert body["prefill"]["registrering"]["basis"] == "observed"
    assert "dagsafslutning" in body["prefill"]["transaktionstyper"]["suggested"] or \
           "Dagens salg" in body["prefill"]["registrering"]["suggested"]
    # Nothing saved yet.
    assert body["answers"] is None


def test_prefill_declares_when_no_data(db_session, client):
    user = _seed_owner(db_session, with_closes=0)
    app.dependency_overrides[get_current_user] = lambda: user

    r = client.get("/api/reports/procedure")
    assert r.status_code == 200
    pre = r.json()["prefill"]
    # No closes/invoices/scans → registration procedure is owner-declared,
    # never asserted from thin air.
    assert pre["registrering"]["basis"] == "declare"
    assert pre["transaktionstyper"]["basis"] == "declare"


# ── save validation ────────────────────────────────────────────────────

def test_save_rejects_unknown_key_and_oversize(db_session, client):
    user = _seed_owner(db_session)
    app.dependency_overrides[get_current_user] = lambda: user

    r = client.put("/api/reports/procedure", json={"answers": {"hacking": "x"}})
    assert r.status_code == 422

    r = client.put("/api/reports/procedure", json={
        "answers": {"cvr": "x" * (procedure_service.MAX_ANSWER_LEN + 1)},
    })
    assert r.status_code == 422

    r = client.put("/api/reports/procedure", json={"answers": {"cvr": "   "}})
    assert r.status_code == 422  # effectively empty document


def test_save_roundtrip(db_session, client):
    user = _seed_owner(db_session)
    app.dependency_overrides[get_current_user] = lambda: user

    answers = {"cvr": "CVR-nr. 12345678", "opbevaring": "Opbevares i BonBox, EU."}
    r = client.put("/api/reports/procedure", json={"answers": answers})
    assert r.status_code == 200
    assert r.json()["answers"]["cvr"] == "CVR-nr. 12345678"

    r = client.get("/api/reports/procedure")
    assert r.json()["answers"] == answers
    assert r.json()["saved_at"]


# ── PDF flow ───────────────────────────────────────────────────────────

def test_pdf_requires_saved_answers(db_session, client):
    user = _seed_owner(db_session)
    app.dependency_overrides[get_current_user] = lambda: user

    r = client.get("/api/reports/procedure/pdf")
    assert r.status_code == 404  # prefill alone must never become a document


def test_pdf_generates_from_saved(db_session, client):
    user = _seed_owner(db_session)
    app.dependency_overrides[get_current_user] = lambda: user

    client.put("/api/reports/procedure", json={"answers": {
        "cvr": "CVR-nr. 12345678",
        "ansvarlige": "Ejeren er ansvarlig for bogføringen.",
        "opbevaring": "Regnskabsmateriale opbevares digitalt i EU i 5 år.",
    }})
    r = client.get("/api/reports/procedure/pdf")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/pdf")
    assert r.content[:5] == b"%PDF-"
    # Audit row written (L7 trail on revisor-artifact egress).
    from app.models.audit_log import AuditLog
    rows = db_session.query(AuditLog).all()
    assert any(
        row.entity_type == "procedurebeskrivelse"
        or "procedurebeskrivelse" in (row.after_state or "")
        for row in rows
    )
