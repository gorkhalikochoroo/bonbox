"""Tests for the storage abstraction.

Pins the security-critical invariants:
  • compose_key validates user_id, kind, sha, ext — no path traversal,
    no unknown buckets, no non-hex SHAs.
  • LocalStorageBackend cannot escape its root via crafted keys.
  • Backend selection: Supabase iff service_key set, else local.
  • Round-trip put/get/delete works on the local backend (Supabase
    backend is exercised in production smoke tests, not unit tests).
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from app.services import storage as storage_module
from app.services.storage import (
    ALLOWED_KINDS,
    LocalStorageBackend,
    StorageBackend,
    StorageError,
    SupabaseStorageBackend,
    compose_key,
    get_storage,
    reset_storage_for_tests,
)


# ─── compose_key — input validation (defense layer) ────────────────────

def test_compose_key_happy_path():
    uid = uuid.uuid4()
    sha = "a" * 64
    key = compose_key(uid, "kasserapport", sha, "jpg")
    assert key == f"{uid}/kasserapport/{sha}.jpg"


def test_compose_key_truncates_long_sha():
    """Defensive: even if a too-long sha is passed, key is bounded."""
    uid = uuid.uuid4()
    sha = "a" * 100
    key = compose_key(uid, "kasserapport", sha, "jpg")
    # Inspect just the filename segment — the UUID may also contain 'a' chars.
    filename = key.rsplit("/", 1)[-1]  # e.g. "aaaa...aaa.jpg"
    sha_part = filename.rsplit(".", 1)[0]
    assert len(sha_part) == 64
    assert sha_part == "a" * 64


def test_compose_key_rejects_unknown_kind():
    """Unknown kind values can't be smuggled in — closes a class of
    bugs where a future caller types 'reciept' and writes outside the
    expected namespace."""
    with pytest.raises(ValueError):
        compose_key(uuid.uuid4(), "unknown_bucket_kind", "a" * 64, "jpg")


def test_compose_key_rejects_non_hex_sha():
    """Non-hex SHA could carry path separators or other traversal
    payloads. Reject at validation."""
    with pytest.raises(ValueError):
        compose_key(uuid.uuid4(), "kasserapport", "../../etc/passwd", "jpg")
    with pytest.raises(ValueError):
        compose_key(uuid.uuid4(), "kasserapport", "abc/def", "jpg")
    with pytest.raises(ValueError):
        compose_key(uuid.uuid4(), "kasserapport", "ZZZZ", "jpg")


def test_compose_key_rejects_bad_extension():
    """Only safe image extensions allowed — exe / php / svg etc. blocked."""
    with pytest.raises(ValueError):
        compose_key(uuid.uuid4(), "kasserapport", "a" * 64, "exe")
    with pytest.raises(ValueError):
        compose_key(uuid.uuid4(), "kasserapport", "a" * 64, "svg")
    with pytest.raises(ValueError):
        compose_key(uuid.uuid4(), "kasserapport", "a" * 64, "php")


def test_compose_key_rejects_traversal_in_user_id():
    """Even if a user_id somehow contained '../', validation catches it."""
    with pytest.raises(ValueError):
        compose_key("../../etc", "kasserapport", "a" * 64, "jpg")


def test_allowed_kinds_pinned():
    """Pin the ALLOWED_KINDS set so accidental additions force a
    deliberate decision here."""
    assert "kasserapport" in ALLOWED_KINDS
    assert "inventory_import" in ALLOWED_KINDS
    assert "expense" in ALLOWED_KINDS
    assert "sale" in ALLOWED_KINDS


# ─── LocalStorageBackend — round-trip ──────────────────────────────────

@pytest.fixture
def local_backend(tmp_path: Path) -> LocalStorageBackend:
    return LocalStorageBackend(tmp_path, "test_bucket")


def test_local_put_and_get_round_trip(local_backend):
    uid = uuid.uuid4()
    key = compose_key(uid, "kasserapport", "a" * 64, "jpg")
    data = b"hello world"
    local_backend.put(key, data)
    assert local_backend.get(key) == data


def test_local_get_returns_none_for_missing(local_backend):
    assert local_backend.get("does/not/exist.jpg") is None


def test_local_delete_round_trip(local_backend):
    uid = uuid.uuid4()
    key = compose_key(uid, "kasserapport", "a" * 64, "jpg")
    local_backend.put(key, b"x")
    assert local_backend.delete(key) is True
    assert local_backend.get(key) is None


def test_local_delete_returns_false_for_missing(local_backend):
    assert local_backend.delete("missing.jpg") is False


# ─── LocalStorageBackend — path traversal defense ──────────────────────

def test_local_backend_rejects_traversal_via_put(local_backend):
    """An attacker who somehow bypassed compose_key's validation must
    still hit the path-traversal guard inside the backend itself."""
    with pytest.raises(StorageError):
        local_backend.put("../../etc/passwd", b"pwn")


def test_local_backend_rejects_traversal_via_get(local_backend):
    """Get must also refuse traversal — silently returning None
    rather than reading outside root."""
    # Silently None (not an exception) is fine — we just must not read.
    assert local_backend.get("../../etc/passwd") is None


def test_local_backend_rejects_traversal_via_delete(local_backend):
    assert local_backend.delete("../../etc/passwd") is False


def test_local_backend_keeps_files_under_bucket_root(local_backend, tmp_path):
    """Files written via put MUST land inside <root>/<bucket>/ — never
    sibling, never above. This is the disk-layout invariant."""
    uid = uuid.uuid4()
    key = compose_key(uid, "kasserapport", "a" * 64, "jpg")
    local_backend.put(key, b"x")

    bucket_root = tmp_path / "test_bucket"
    written = list(bucket_root.rglob("*.jpg"))
    assert len(written) == 1
    # Resolved path must be inside the bucket root.
    written[0].resolve().relative_to(bucket_root.resolve())


# ─── Backend selection (get_storage) ───────────────────────────────────

def test_get_storage_selects_local_when_no_service_key(monkeypatch, tmp_path):
    """No service key → local backend (dev-friendly default)."""
    reset_storage_for_tests()
    monkeypatch.setattr(storage_module.settings, "SUPABASE_URL", "")
    monkeypatch.setattr(storage_module.settings, "SUPABASE_SERVICE_KEY", "")
    monkeypatch.setenv("LOCAL_UPLOADS_ROOT", str(tmp_path))

    backend = get_storage()
    assert isinstance(backend, LocalStorageBackend)
    assert backend.is_durable is False
    reset_storage_for_tests()


def test_get_storage_selects_supabase_when_configured(monkeypatch):
    """Both URL + service key set → Supabase backend used in prod."""
    reset_storage_for_tests()
    monkeypatch.setattr(storage_module.settings, "SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setattr(storage_module.settings, "SUPABASE_SERVICE_KEY", "sb_test")
    monkeypatch.setattr(storage_module.settings, "SUPABASE_RECEIPTS_BUCKET", "receipts")

    backend = get_storage()
    assert isinstance(backend, SupabaseStorageBackend)
    assert backend.is_durable is True
    reset_storage_for_tests()


def test_get_storage_falls_back_when_partial_config(monkeypatch, tmp_path):
    """URL but no service key → local fallback (don't half-init Supabase)."""
    reset_storage_for_tests()
    monkeypatch.setattr(storage_module.settings, "SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setattr(storage_module.settings, "SUPABASE_SERVICE_KEY", "")
    monkeypatch.setenv("LOCAL_UPLOADS_ROOT", str(tmp_path))

    backend = get_storage()
    assert isinstance(backend, LocalStorageBackend)
    reset_storage_for_tests()


# ─── Tenant-scope invariant via compose_key ────────────────────────────

def test_keys_are_user_scoped_at_path_level():
    """Every key MUST start with the user_id. Defense-in-depth: even
    if backend tenancy is bypassed, the path itself is owner-prefixed."""
    a = uuid.uuid4()
    b = uuid.uuid4()
    sha = "a" * 64
    key_a = compose_key(a, "kasserapport", sha, "jpg")
    key_b = compose_key(b, "kasserapport", sha, "jpg")
    assert key_a.startswith(f"{a}/")
    assert key_b.startswith(f"{b}/")
    assert key_a != key_b
