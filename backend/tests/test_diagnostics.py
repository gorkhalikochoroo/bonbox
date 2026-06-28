"""Diagnostics "Needs du nu" — read-only detector queue.

Verifies the runner contract (severity sort + fail-soft per detector) and that
the real detectors don't crash on an empty account (they all return None).

Run:
  cd backend && python3 -m pytest tests/test_diagnostics.py -x -q
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.user import User
from app.services import diagnostics_service as ds
from app.services.auth import hash_password


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


def _owner(db):
    u = User(
        email="owner@bonbox.dk",
        password_hash=hash_password("pw12345678"),
        business_name="Bon",
        business_type="cafe",
        currency="DKK",
        plan="starter",
        role="owner",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def test_runner_sorts_by_severity_and_is_fail_soft(db, monkeypatch):
    user = _owner(db)

    def info_d(db, user, now):
        return ds._finding("c_info", "info", "/a")

    def urgent_d(db, user, now):
        return ds._finding("c_urgent", "urgent", "/b")

    def warn_d(db, user, now):
        return ds._finding("c_warn", "warn", "/c")

    def boom_d(db, user, now):
        raise RuntimeError("detector blew up")

    def none_d(db, user, now):
        return None

    monkeypatch.setattr(ds, "_DETECTORS", [info_d, boom_d, urgent_d, none_d, warn_d])

    findings = ds.run_diagnostics(db, user)
    # The raiser is dropped (fail-soft); the None is skipped; the rest are
    # sorted urgent → warn → info.
    assert [f["code"] for f in findings] == ["c_urgent", "c_warn", "c_info"]


def test_empty_account_yields_no_findings_and_does_not_crash(db):
    user = _owner(db)
    findings = ds.run_diagnostics(db, user)
    assert findings == []


def test_finding_shape_is_structured_not_human_strings():
    f = ds._finding("x", "warn", "/path", {"count": 2})
    # Server returns codes + meta; the frontend localizes (DK terms stay client).
    assert set(f.keys()) == {"code", "severity", "deep_link", "meta"}
    assert f["meta"] == {"count": 2}
    assert "title" not in f and "message" not in f
