"""Shared harness for the Egenkontrol R1a + R1b tests (not a test module).

A fresh in-memory SQLite per test, real bearer tokens (so the member write
guard, the member read guard and the shared-device PIN gate all run for
real — they open their own SessionLocal, which is pointed at this engine),
and ONE frozen clock: egenkontrol_service.now_utc, the feature's only clock.
"""
import uuid
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.database as _dbmod
import app.models  # noqa: F401 — register every model
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.accountant_grant import AccountantGrant
from app.models.branch import Branch
from app.models.business_profile import BusinessProfile
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.services import egenkontrol_service as S
from app.services.auth import create_access_token, hash_password

_db_ready.set()

# Thursday 12 Nov 2026, 07:30 in Copenhagen (UTC+1). The fridge is due 08:00.
T0 = datetime(2026, 11, 12, 6, 30)

START = [
    {"template_key": "fridge", "name": "Køl 1"},
    {"template_key": "freezer", "name": "Frost 1"},
    {"template_key": "hot_holding", "name": "Varmholdelse"},
    {"template_key": "reheating", "name": "Genopvarmning"},
    {"template_key": "receiving", "name": "Varemodtagelse"},
]


class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t

    def set(self, t):
        self.t = t

    def tick(self, **kw):
        self.t = self.t + timedelta(**kw)
        return self.t


class Env:
    def __init__(self, engine, SL, client, clock):
        self.engine, self.SL, self.client, self.clock = engine, SL, client, clock
        self.db = SL()

    # ── people ──────────────────────────────────────────────────────────
    def owner(self, *, name="Bistro Nørrebro", business_type="restaurant", plan="pro",
              cutoff=None, tz="Europe/Copenhagen", email=None):
        u = User(
            email=email or f"o-{uuid.uuid4().hex[:8]}@bonbox.dk",
            password_hash=hash_password("ownerpw123"),
            business_name=name, business_type=business_type, currency="DKK",
            role="owner", timezone=tz, plan=plan, email_verified=True,
        )
        self.db.add(u)
        self.db.commit()
        self.db.refresh(u)
        p = BusinessProfile(user_id=u.id, address="Jægersborggade 1", zipcode="2200",
                            city="København N", org_number="12345678")
        if cutoff is not None:
            p.day_cutoff_hour = cutoff
        self.db.add(p)
        self.db.commit()
        return u

    def member(self, owner, role):
        u = User(
            email=f"{role}-{uuid.uuid4().hex[:6]}@bonbox.dk",
            password_hash=hash_password("memberpw123"), business_name="",
            currency="DKK", plan="pro", role=role, owner_id=owner.id,
        )
        self.db.add(u)
        self.db.commit()
        self.db.refresh(u)
        return u

    def accountant(self, owner):
        a = User(
            email=f"revisor-{uuid.uuid4().hex[:6]}@bonbox.dk",
            password_hash=hash_password("revisorpw1"), business_name="",
            currency="DKK", plan="free", role="accountant",
        )
        self.db.add(a)
        self.db.commit()
        self.db.refresh(a)
        self.db.add(AccountantGrant(
            accountant_user_id=a.id, accountant_email=a.email, owner_user_id=owner.id,
            granted_by=owner.id, status="active",
        ))
        self.db.commit()
        return a

    def staff(self, owner, name, *, on_shift=False, active=True, deleted=False):
        s = StaffMember(user_id=owner.id, name=name, active=active, is_deleted=deleted)
        self.db.add(s)
        self.db.commit()
        self.db.refresh(s)
        if on_shift:
            self.db.add(Schedule(user_id=owner.id, staff_id=s.id, date=self.today(),
                                 start_time="07:00", end_time="15:00", status="published"))
            self.db.commit()
        return s

    def branch(self, owner, name="Vesterbro"):
        b = Branch(user_id=owner.id, name=name, business_type="restaurant")
        self.db.add(b)
        self.db.commit()
        self.db.refresh(b)
        return b

    def today(self):
        from zoneinfo import ZoneInfo
        from app.services.egenkontrol_rules import business_date_of
        return business_date_of(self.clock(), ZoneInfo("Europe/Copenhagen"), 6)

    # ── HTTP ────────────────────────────────────────────────────────────
    def h(self, user, *, shared=False, nonce="dev-nonce-1", proof=None):
        tok = create_access_token(str(user.id), 0, shared_device=shared,
                                  device_nonce=nonce if shared else None)
        out = {"Authorization": f"Bearer {tok}"}
        if proof:
            out["X-BonBox-Device-Pin"] = proof
        return out

    def setup(self, owner, items=None, **kw):
        r = self.client.post("/api/egenkontrol/setup", json={"items": items or START, **kw},
                             headers=self.h(owner))
        assert r.status_code == 201, r.text
        return {c["template_key"]: c for c in r.json()["checks"]}

    def save(self, owner, check_id, value, *, headers=None, **kw):
        body = {"client_id": str(uuid.uuid4()), "check_id": check_id, "value_c": value}
        if "staff_id" not in kw and "typed_name" not in kw:
            body["typed_name"] = "Mia"
        body.update(kw)
        return self.client.post("/api/egenkontrol/entries", json=body,
                                headers=headers or self.h(owner))

    def today_json(self, owner, **params):
        r = self.client.get("/api/egenkontrol/today", params=params, headers=self.h(owner))
        assert r.status_code == 200, r.text
        return r.json()

    # ── R1b helpers ─────────────────────────────────────────────────────
    def folder(self, owner, **params):
        r = self.client.get("/api/egenkontrol/folder", params=params, headers=self.h(owner))
        assert r.status_code == 200, r.text
        return r.json()

    def pair(self, owner, **body):
        """A paired kitchen iPad → its token."""
        r = self.client.post("/api/egenkontrol/devices", json=body, headers=self.h(owner))
        assert r.status_code == 201, r.text
        j = self.client.post("/api/stand/join", json={"code": r.json()["code"]})
        assert j.status_code == 200, j.text
        return j.json()["path"].rsplit("/", 1)[-1]

    def paper(self, owner, check_id, value, measured_date, measured_time, *,
              reason="Nettet var nede", headers=None, **kw):
        body = {"client_id": str(uuid.uuid4()), "check_id": check_id, "value_c": value,
                "measured_date": str(measured_date), "measured_time": measured_time,
                "paper_reason": reason}
        if "staff_id" not in kw and "typed_name" not in kw:
            body["typed_name"] = "Mia"
        body.update(kw)
        return self.client.post("/api/egenkontrol/paper-entries", json=body,
                                headers=headers or self.h(owner))

    def correct(self, owner, entry_id, reason_code="typo", *, headers=None, client_id=None, **kw):
        body = {"client_id": client_id or str(uuid.uuid4()), "entry_id": entry_id,
                "reason_code": reason_code}
        body.update(kw)
        return self.client.post("/api/egenkontrol/corrections", json=body,
                                headers=headers or self.h(owner))

    def photo(self, owner, entry_id, data=None, *, headers=None, name="foto.jpg"):
        return self.client.post(f"/api/egenkontrol/entries/{entry_id}/photo",
                                files={"file": (name, data if data is not None else jpeg_bytes(),
                                                "image/jpeg")},
                                headers=headers or self.h(owner))

    def doc(self, owner, data=None, *, title="Egenkontrolprogram 2026",
            doc_type="programme", headers=None, name="program.pdf"):
        form = {}
        if title is not None:
            form["title"] = title
        if doc_type is not None:
            form["doc_type"] = doc_type
        return self.client.post("/api/egenkontrol/documents", data=form,
                                files={"file": (name, data if data is not None else PDF_BYTES,
                                                "application/pdf")},
                                headers=headers or self.h(owner))


# ── R1b files ───────────────────────────────────────────────────────────

PDF_BYTES = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
             b"2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")


def jpeg_bytes(size=(640, 480), color=(30, 90, 200), gps=False) -> bytes:
    import io
    from PIL import Image
    img = Image.new("RGB", size, color)
    buf = io.BytesIO()
    if gps:
        exif = Image.Exif()
        exif[0x010F] = "PhoneMaker"            # Make
        exif[0x8825] = {1: "N", 2: (55.0, 40.0, 0.0), 3: "E", 4: (12.0, 34.0, 0.0)}
        img.save(buf, format="JPEG", quality=90, exif=exif)
    else:
        img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def png_bytes(size=(320, 240)) -> bytes:
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGBA", size, (200, 40, 40, 128)).save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def store(tmp_path, monkeypatch):
    """A LocalStorageBackend in a throwaway dir (never Supabase)."""
    from app.services import storage as storage_mod
    monkeypatch.setenv("LOCAL_UPLOADS_ROOT", str(tmp_path / "uploads"))
    monkeypatch.setattr(storage_mod.settings, "SUPABASE_URL", "", raising=False)
    monkeypatch.setattr(storage_mod.settings, "SUPABASE_SERVICE_KEY", "", raising=False)
    storage_mod.reset_storage_for_tests()
    yield storage_mod.get_storage()
    storage_mod.reset_storage_for_tests()


def _reset_limiters():
    from app.routers import egenkontrol as ek_router
    from app.routers import egenkontrol_files as ek_files_router
    from app.routers import kitchen_link as kitchen_router
    from app.routers import stand_link as stand_router
    for lim in (ek_router.limiter, ek_files_router.limiter, kitchen_router.limiter,
                stand_router.limiter):
        try:
            lim.reset()
        except Exception:  # noqa: BLE001
            pass


@pytest.fixture
def env(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SL = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    def _get_db():
        s = SL()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_db
    monkeypatch.setattr(_dbmod, "SessionLocal", SL)
    _reset_limiters()
    clock = Clock(T0)
    monkeypatch.setattr(S, "now_utc", clock)
    e = Env(engine, SL, TestClient(app), clock)
    try:
        yield e
    finally:
        e.db.close()
        app.dependency_overrides.pop(get_db, None)
        _reset_limiters()
