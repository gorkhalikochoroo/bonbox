"""GDPR "kept 5 years, THEN DELETED" — the erasure-tombstone loop.

delete_account retains accounting source blobs (kasserapport / expense /
sale / inventory_import) under Bogføringsloven §10 and PROMISES they are
deleted after 5 years. The pointer rows die at erasure, so the tombstone
written in the delete_account commit is the only remaining way to find
those blobs. These tests pin the full loop:

1. erasure writes a tombstone (same request that deletes the user)
2. the nightly sweep ignores tombstones inside the legal window
3. an expired tombstone purges EXACTLY the retained kinds, then drops
4. a storage failure keeps the tombstone (retry next night) — never a
   silently orphaned remainder
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register all models on Base
from app.main import app, _db_ready
from app.models.erasure_tombstone import ErasureTombstone
from app.models.user import User
from app.routers import auth as auth_router
from app.services.accounting_retention import (
    MIN_RETENTION_YEARS,
    _purge_erased_account_blobs,
)
from app.services.auth import hash_password, get_current_user
from app.services.storage import ACCOUNTING_RETENTION_KINDS
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
    try:
        auth_router.limiter.reset()
    except Exception:
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


class _FakeStorage:
    """Records delete_prefix calls; optionally fails on chosen kinds."""

    def __init__(self, fail_kinds=()):
        self.deleted_prefixes = []
        self.fail_kinds = set(fail_kinds)

    def delete_prefix(self, prefix: str) -> int:
        kind = prefix.split("/", 1)[1] if "/" in prefix else prefix
        if kind in self.fail_kinds:
            raise RuntimeError(f"storage down for {kind}")
        self.deleted_prefixes.append(prefix)
        return 1


def _seed_user(db) -> User:
    u = User(
        email="tombstone@example.com",
        password_hash=hash_password("deleteMeNow1"),
        business_name="Doomed Café",
        business_type="restaurant",
        currency="DKK",
        role="owner",
        email_verified=True,
        created_at=utc_now() - timedelta(days=2),
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _tombstone(db, age_days: int) -> ErasureTombstone:
    row = ErasureTombstone(
        user_id=__import__("uuid").uuid4(),
        erased_at=utc_now() - timedelta(days=age_days),
    )
    db.add(row)
    db.commit()
    return row


EXPIRED_DAYS = (MIN_RETENTION_YEARS + 1) * 366 + 1


def test_delete_account_writes_tombstone(db_session, client):
    user = _seed_user(db_session)
    uid = user.id
    app.dependency_overrides[get_current_user] = lambda: user

    r = client.request(
        "DELETE", "/api/auth/delete-account",
        json={"password": "deleteMeNow1"},
    )
    assert r.status_code == 200, r.text

    assert db_session.query(User).filter(User.id == uid).first() is None
    ts = db_session.query(ErasureTombstone).filter(
        ErasureTombstone.user_id == uid
    ).first()
    assert ts is not None, "erasure must leave a tombstone or the retained blobs orphan forever"
    assert ts.erased_at is not None


def test_sweep_ignores_fresh_tombstones(db_session, monkeypatch):
    _tombstone(db_session, age_days=30)
    fake = _FakeStorage()
    monkeypatch.setattr("app.services.storage.get_storage", lambda: fake)

    done = _purge_erased_account_blobs(db_session)
    db_session.commit()

    assert done == 0
    assert fake.deleted_prefixes == []
    assert db_session.query(ErasureTombstone).count() == 1


def test_sweep_purges_expired_tombstone_exact_kinds(db_session, monkeypatch):
    row = _tombstone(db_session, age_days=EXPIRED_DAYS)
    uid = str(row.user_id)
    fake = _FakeStorage()
    monkeypatch.setattr("app.services.storage.get_storage", lambda: fake)

    done = _purge_erased_account_blobs(db_session)
    db_session.commit()

    assert done == 1
    # Exactly the retained accounting kinds — no personal-data kinds (those
    # were purged at erasure), no extras.
    assert sorted(fake.deleted_prefixes) == sorted(
        f"{uid}/{k}" for k in ACCOUNTING_RETENTION_KINDS
    )
    assert db_session.query(ErasureTombstone).count() == 0


def test_sweep_keeps_tombstone_on_storage_failure(db_session, monkeypatch):
    _tombstone(db_session, age_days=EXPIRED_DAYS)
    fake = _FakeStorage(fail_kinds={"kasserapport"})
    monkeypatch.setattr("app.services.storage.get_storage", lambda: fake)

    done = _purge_erased_account_blobs(db_session)
    db_session.commit()

    # Partial failure → tombstone survives so the next sweep retries.
    assert done == 0
    assert db_session.query(ErasureTombstone).count() == 1
