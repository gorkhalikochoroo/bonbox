"""
Staff profile photo — portal self-upload + owner-visible, end-to-end.

Locks the bug an adversarial review caught pre-merge: the upload composed the
storage key with an UNREGISTERED kind ("staff_profile"), so compose_key raised
and EVERY upload 500'd — and that kind wasn't in the GDPR purge set either. This
test uploads a real JPEG, asserts 200 + a stored blob, and asserts the storage
kind used is one the GDPR account-delete purge actually covers.

Run:
  cd backend && python3 -m pytest tests/test_portal_profile_photo.py -x -q
"""

import io
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from PIL import Image

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember, StaffLink
from app.models.user import User
from app.services.auth import hash_password
from app.services import storage as storage_mod

_db_ready.set()


@pytest.fixture(autouse=True)
def _local_storage(tmp_path, monkeypatch):
    # Force the on-disk local backend into a throwaway dir (no Supabase creds
    # in CI → get_storage() already picks Local, but pin the root + reset the
    # cached singleton so blobs land under tmp).
    monkeypatch.setenv("LOCAL_UPLOADS_ROOT", str(tmp_path / "uploads"))
    monkeypatch.setattr(storage_mod.settings, "SUPABASE_URL", "", raising=False)
    monkeypatch.setattr(storage_mod.settings, "SUPABASE_SERVICE_KEY", "", raising=False)
    storage_mod.reset_storage_for_tests()
    yield
    storage_mod.reset_storage_for_tests()


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(db):
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    a = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Agnes", role="server")
    db.add(a); db.commit(); db.refresh(a)
    link = StaffLink(
        id=uuid.uuid4(), user_id=u.id, staff_id=a.id, token="tokP", active=True,
    )
    db.add(link); db.commit(); db.refresh(link)
    return u, a, link


def _jpeg(size=(1200, 900), color=(30, 90, 200)):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def test_upload_serve_delete_profile_photo(client, db):
    _, a, _ = _seed(db)

    # No photo yet → serve 404, validate reports profile_photo_at None.
    assert client.get("/api/portal/tokP/profile-photo").status_code == 404
    assert client.get("/api/portal/tokP").json()["profile_photo_at"] is None

    # Upload a real JPEG → 200 with a fresh stamp. (This 500'd before the fix.)
    r = client.post(
        "/api/portal/tokP/profile-photo",
        files={"file": ("me.jpg", _jpeg(), "image/jpeg")},
    )
    assert r.status_code == 200, r.text
    assert r.json()["profile_photo_at"]

    # The blob is stored under a kind the GDPR delete-account purge covers.
    db.refresh(a)
    assert a.profile_photo_key and "staff_avatar" in a.profile_photo_key
    assert "staff_avatar" in storage_mod.ERASURE_PURGE_KINDS

    # Serve returns the (re-encoded) JPEG.
    r = client.get("/api/portal/tokP/profile-photo")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert Image.open(io.BytesIO(r.content)).format == "JPEG"

    # Owner sees it too (owner endpoint is tenant-scoped; here we hit the portal
    # validate to confirm the stamp is exposed once set).
    assert client.get("/api/portal/tokP").json()["profile_photo_at"]

    # Delete → cleared.
    assert client.delete("/api/portal/tokP/profile-photo").status_code == 200
    db.refresh(a)
    assert a.profile_photo_key is None
    assert client.get("/api/portal/tokP/profile-photo").status_code == 404


def test_upload_rejects_non_image(client, db):
    _seed(db)
    r = client.post(
        "/api/portal/tokP/profile-photo",
        files={"file": ("evil.jpg", b"not an image at all", "image/jpeg")},
    )
    assert r.status_code in (400, 415)  # magic-byte / decode rejection, never 200
