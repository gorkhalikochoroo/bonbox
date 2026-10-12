"""Forwarded bilag go to durable storage, not Render's disk (Push 8, 12 Oct 2026).

THE DEFECT. inbox_service.persist_attachment_blob wrote every forwarded
attachment to ./uploads/receipts/<sha>.enc on the web instance's local disk —
which Render wipes on every deploy — so a bilag forwarded on Monday was gone
after Tuesday's push, while its expense still pointed at the path. The file
name was the content hash alone, shared by every tenant.

THE FIX. The attachment goes through the storage abstraction like every
other upload (services/storage.py: Supabase in production, which refuses
rather than fall back to the ephemeral disk) under
<user_id>/inbox_receipt/<sha>.<ext>. Other uploads are stored as their own
bytes in the private bucket, so this one is too (the Fernet layer was the
inbox's alone). A path written before the move (uploads/receipts/<sha>.enc,
Fernet) is still read. The kind is in ALLOWED_KINDS and ERASURE_PURGE_KINDS,
so account erasure takes it.

Run: cd backend && python -m pytest -q tests/test_inbox_bilag_durable_storage.py
"""
from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

import pytest

from app.config import settings
from app.services import inbox_service, storage
from app.utils.crypto import fernet_encrypt_bytes

PDF = b"%PDF-1.4\n% forwarded bilag\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"


@pytest.fixture
def local_store(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_UPLOADS_ROOT", str(tmp_path / "store"))
    monkeypatch.setattr(settings, "SUPABASE_URL", "", raising=False)
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_KEY", "", raising=False)
    monkeypatch.chdir(tmp_path)  # a local-disk write would land in ./uploads/receipts
    storage.reset_storage_for_tests()
    yield storage.get_storage()
    storage.reset_storage_for_tests()


def test_the_bilag_is_stored_per_tenant_in_the_storage_abstraction(local_store, tmp_path):
    uid = uuid.uuid4()
    sha = hashlib.sha256(PDF).hexdigest()
    key = inbox_service.persist_attachment_blob(PDF, sha, user_id=uid, content_type="application/pdf")
    assert key == f"{uid}/inbox_receipt/{sha}.pdf"
    assert local_store.get(key) == PDF                       # the bytes, like other uploads
    assert not (tmp_path / "uploads" / "receipts").exists()  # nothing on the instance's disk
    assert inbox_service.load_attachment_blob(key) == PDF


def test_two_tenants_forwarding_the_same_file_get_two_keys(local_store):
    sha = hashlib.sha256(PDF).hexdigest()
    a = inbox_service.persist_attachment_blob(PDF, sha, user_id=uuid.uuid4(), content_type="application/pdf")
    b = inbox_service.persist_attachment_blob(PDF, sha, user_id=uuid.uuid4(), content_type="application/pdf")
    assert a != b


@pytest.mark.parametrize("ctype,ext", [
    ("application/pdf", "pdf"), ("image/jpeg", "jpg"), ("image/png", "png"),
    ("image/heic", "heic"), ("image/heif", "heic"), ("image/webp", "webp"),
    ("image/gif", "gif"), ("image/tiff", "tiff"), ("IMAGE/JPEG; name=x.jpg", "jpg"),
])
def test_the_key_names_the_file_type(local_store, ctype, ext):
    sha = "ab" * 32
    key = inbox_service.persist_attachment_blob(b"x", sha, user_id=uuid.uuid4(), content_type=ctype)
    assert key.endswith(f"/inbox_receipt/{sha}.{ext}")


def test_a_type_with_no_safe_file_name_is_not_stored(local_store):
    with pytest.raises(ValueError):
        inbox_service.persist_attachment_blob(b"<svg/>", "cd" * 32, user_id=uuid.uuid4(),
                                              content_type="image/svg+xml")


def test_production_without_durable_storage_refuses_instead_of_using_the_disk(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SUPABASE_URL", "", raising=False)
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_KEY", "", raising=False)
    monkeypatch.setattr(settings, "ENVIRONMENT", "production", raising=False)
    monkeypatch.chdir(tmp_path)
    storage.reset_storage_for_tests()
    try:
        with pytest.raises(storage.StorageError):
            inbox_service.persist_attachment_blob(PDF, "ef" * 32, user_id=uuid.uuid4(),
                                                  content_type="application/pdf")
        assert not (tmp_path / "uploads").exists()
    finally:
        storage.reset_storage_for_tests()


def test_a_path_written_before_the_move_is_still_read(local_store, tmp_path):
    sha = hashlib.sha256(PDF).hexdigest()
    legacy = tmp_path / "uploads" / "receipts" / f"{sha}.enc"
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(fernet_encrypt_bytes(PDF))
    assert inbox_service.load_attachment_blob(f"uploads/receipts/{sha}.enc") == PDF


def test_a_missing_blob_is_a_clean_file_not_found(local_store):
    with pytest.raises(FileNotFoundError):
        inbox_service.load_attachment_blob(f"{uuid.uuid4()}/inbox_receipt/{'0' * 64}.pdf")
    with pytest.raises(FileNotFoundError):
        inbox_service.load_attachment_blob("")


def test_the_kind_is_registered_for_upload_and_for_erasure(local_store):
    assert "inbox_receipt" in storage.ALLOWED_KINDS
    assert "inbox_receipt" in storage.ERASURE_PURGE_KINDS
    # The retained (Bogføringsloven) set the privacy policy names is unchanged.
    assert storage.ACCOUNTING_RETENTION_KINDS == {"kasserapport", "expense", "sale", "inventory_import"}
    uid = uuid.uuid4()
    key = inbox_service.persist_attachment_blob(PDF, "12" * 32, user_id=uid, content_type="application/pdf")
    assert storage.purge_user_blobs(uid) >= 1
    assert local_store.get(key) is None
