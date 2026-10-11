"""INFRA-07 — storage fails closed in production; /api/health/storage (R-i).

Production without SUPABASE_URL/SUPABASE_SERVICE_KEY used to fall back to the
local disk, which Render wipes at every deploy: uploads "succeeded" and were
silently lost. Now production gets UnavailableStorageBackend (every operation
raises StorageError), dev/CI/tests keep LocalStorageBackend, and a config-only
probe reports durability. /api/health/ready deliberately ignores storage (a
503 there would restart-loop the whole app over a missing env var — D2).
"""
from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.main as main
import app.services.storage as storage
from app.config import settings
from app.database import Base
from app import models as _all_models  # noqa: F401 — register all models
from app.main import app, _db_ready
from app.models.erasure_tombstone import ErasureTombstone
from app.services.accounting_retention import MIN_RETENTION_YEARS, _purge_erased_account_blobs
from app.services.storage import (
    LocalStorageBackend,
    StorageError,
    UnavailableStorageBackend,
    get_storage,
    purge_user_blobs,
)
from app.utils.time import utc_now

_db_ready.set()


@pytest.fixture(autouse=True)
def _fresh_backend():
    storage._backend = None
    yield
    storage._backend = None


@pytest.fixture
def prod_no_keys(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_KEY", "")


# 1 ─────────────────────────────────────────────────────────────────────
def test_production_without_keys_fails_closed(prod_no_keys, tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_UPLOADS_ROOT", str(tmp_path))
    backend = get_storage()
    assert isinstance(backend, UnavailableStorageBackend)
    assert backend.is_durable is False
    with pytest.raises(StorageError):
        backend.put("u/kasserapport/ab.jpg", b"x")
    with pytest.raises(StorageError):
        backend.get("u/kasserapport/ab.jpg")
    with pytest.raises(StorageError):
        backend.delete("u/kasserapport/ab.jpg")
    with pytest.raises(StorageError):
        backend.delete_prefix("u/kasserapport")
    assert backend.signed_url("u/kasserapport/ab.jpg") is None
    assert list(tmp_path.rglob("*")) == []                     # nothing on the ephemeral disk


def test_purge_user_blobs_still_never_raises(prod_no_keys):
    assert purge_user_blobs(uuid.uuid4()) == 0


def test_accounting_retention_keeps_the_tombstone(prod_no_keys):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        db.add(ErasureTombstone(
            user_id=uuid.uuid4(),
            erased_at=utc_now() - timedelta(days=(MIN_RETENTION_YEARS + 1) * 366 + 1),
        ))
        db.commit()
        done = _purge_erased_account_blobs(db)
        db.commit()
        assert done == 0                                       # retried next night
        assert db.query(ErasureTombstone).count() == 1         # never orphaned
    finally:
        db.close()


# 2 ─────────────────────────────────────────────────────────────────────
def test_development_without_keys_is_unchanged(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_KEY", "")
    assert isinstance(get_storage(), LocalStorageBackend)


def test_production_with_keys_is_durable(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_KEY", "sb_secret_test")
    backend = get_storage()
    assert backend.is_durable is True
    assert type(backend).__name__ == "SupabaseStorageBackend"


# 3 ─────────────────────────────────────────────────────────────────────
def test_storage_probe_durable_is_200():
    storage._backend = SimpleNamespace(is_durable=True)
    r = TestClient(app).get("/api/health/storage")
    assert r.status_code == 200
    assert r.json() == {"storage": "durable"}
    assert TestClient(app).head("/api/health/storage").status_code == 200


def test_storage_probe_not_durable_is_503_and_names_nothing(prod_no_keys):
    r = TestClient(app).get("/api/health/storage")
    assert r.status_code == 503
    assert r.json() == {"storage": "not_durable"}
    low = r.text.lower()
    for word in ("supabase", "bucket", "key", "unavailable", "backend"):
        assert word not in low
    assert TestClient(app).head("/api/health/storage").status_code == 503


# 4 ─────────────────────────────────────────────────────────────────────
def test_ready_stays_200_while_storage_is_not_durable(prod_no_keys):
    """D2: storage durability must never take the app out of rotation."""
    main._ready_probe["ts"] = 0.0
    main._ready_probe["ok"] = True
    assert get_storage().is_durable is False
    r = TestClient(app).get("/api/health/ready")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
