"""R-d round 3 — chat and profile photos: the decode gate, a 25 MP PNG
ceiling and a reduced JPEG decode; and no decode site outside the gate.

Measured under Linux, 1 CPU / 2 GB, no swap (10 Oct): a 214 KB 50 MP RGBA PNG
through sanitize_chat_photo peaked at 766 MB (the canvas, a convert() copy,
a white canvas and split() into four bands, all at full size); two at once
1.6 GB, three at once OOM-killed the instance. Anyone with a staff link can
post three photos a message. What is pinned here:

  * chat and profile photos hold the decode gate; busy is a 503 with a clear
    Danish "try again" (and Retry-After), before any message row is written;
  * a PNG is decoded in full only up to 25 MP — above it is refused before
    anything is decoded; a JPEG keeps the 50 MP ceiling and is decoded at a
    reduced scale, so a 48 MP phone photo still goes through (chat 1600 px,
    avatar 512 px) and decodes at 2016x1512 / 1008x756, not 8064x6048;
  * transparency is still flattened onto white;
  * every app module that opens an image with Pillow goes through the gate.

Run:
  cd backend && python -m pytest tests/test_chat_photo_decode.py -q
"""

from __future__ import annotations

import ast
import io
import pathlib
import random
import uuid

import pytest
from fastapi import HTTPException
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.user import User
from app.services import chat_image, image_guard
from app.services.auth import hash_password

_db_ready.set()

APP_DIR = pathlib.Path(__file__).resolve().parents[1] / "app"


@pytest.fixture
def SessionLocal():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture
def db(SessionLocal):
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


def _owner(db) -> User:
    u = User(
        id=str(uuid.uuid4()),
        email=f"{uuid.uuid4().hex[:10]}@cafe-example.dk",
        password_hash=hash_password("pw123456"),
        business_name="Venue", business_type="cafe", currency="DKK",
        plan="free", role="owner", email_verified=True,
    )
    db.add(u)
    db.commit()
    return u


def _ip() -> dict:
    return {"CF-Connecting-IP": f"10.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}"}


def _img(fmt: str, size=(64, 48), mode="RGB", color=(240, 240, 240), **kw) -> bytes:
    buf = io.BytesIO()
    if mode == "RGBA" and len(color) == 3:
        color = (*color, 128)
    Image.new(mode, size, color).save(buf, fmt, **kw)
    return buf.getvalue()


@pytest.fixture
def all_decode_slots_taken(monkeypatch):
    monkeypatch.setattr(image_guard, "DECODE_WAIT_S", 0.2)
    taken = 0
    for _ in range(image_guard.DECODE_MAX_CONCURRENT):
        assert image_guard._decode_slots.acquire(timeout=5)
        taken += 1
    try:
        yield
    finally:
        for _ in range(taken):
            image_guard._decode_slots.release()


@pytest.fixture
def no_decoder(monkeypatch):
    from PIL import ImageFile

    def boom(self, *a, **k):  # pragma: no cover - must not run
        raise AssertionError("an image was decoded without a decode slot")

    monkeypatch.setattr(ImageFile.ImageFile, "load", boom)


# ─── 1. The decode gate ─────────────────────────────────────────────

@pytest.mark.parametrize("fn_name", ["sanitize_chat_photo", "sanitize_profile_photo"])
def test_chat_and_profile_photos_refuse_busy_with_a_clear_try_again(all_decode_slots_taken, no_decoder, fn_name):
    # An AIBusyError (main.py answers it 503 + Retry-After, never sanitized),
    # Danish by default — a staffer has no stored language.
    from app.services.ai_limits import AIBusyError, busy_message

    with pytest.raises(AIBusyError) as ei:
        getattr(chat_image, fn_name)(_img("PNG"))
    assert ei.value.lang == "da"
    assert "Prøv igen" in str(ei.value) == busy_message("da")
    with pytest.raises(AIBusyError) as ei:
        getattr(chat_image, fn_name)(_img("PNG"), lang="en")
    assert str(ei.value) == busy_message("en")


def test_the_portal_chat_photo_answers_try_again_and_writes_no_message(SessionLocal, db, all_decode_slots_taken):
    from fastapi.testclient import TestClient

    from app.models.staff import StaffChatMessage, StaffLink, StaffMember
    from app.routers import staff_chat as sc

    sc._limiter.reset()
    owner = _owner(db)
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name="Agnes", role="server")
    db.add(m)
    db.commit()
    token = f"tok-{uuid.uuid4().hex[:8]}"
    db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=m.id, token=token, active=True))
    db.commit()

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    try:
        r = TestClient(app).post(
            f"/api/portal/{token}/chat/photos",
            files=[("photos", ("a.png", _img("PNG"), "image/png"))],
            headers=_ip(),
        )
    finally:
        app.dependency_overrides.pop(get_db, None)
        sc._limiter.reset()
    assert r.status_code == 503, r.text
    assert "Prøv igen" in r.json()["detail"]
    assert r.headers.get("retry-after")
    assert db.query(StaffChatMessage).count() == 0


def _make_staff_link(db, owner):
    from app.models.staff import StaffLink, StaffMember

    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name="Agnes", role="server")
    db.add(m)
    db.commit()
    token = f"tok-{uuid.uuid4().hex[:8]}"
    db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=m.id, token=token, active=True))
    db.commit()
    return m, token


@pytest.mark.parametrize("route,owner_lang_value,expected_lang", [
    ("portal_chat", "en", "da"),       # a staffer: Danish (the portal stores no language)
    ("portal_profile", "en", "da"),
    ("owner_chat", "en", "en"),        # the owner: their own language
    ("owner_chat", "da", "da"),
    ("owner_group_chat", "en", "en"),
    ("logo", "en", "en"),
    ("logo", "da", "da"),
])
def test_busy_photo_refusals_survive_the_production_5xx_sanitizer(
    SessionLocal, db, monkeypatch, all_decode_slots_taken, route, owner_lang_value, expected_lang,
):
    """In production every HTTPException >= 500 is replaced with "Something
    went wrong on our side" (main._http_exception_sanitizer). The busy
    refusals of chat photos, the staff avatar and the logo must reach the
    person as "busy, try again" in their language, with Retry-After — the
    AIBusyError handler, like every other busy photo route. Nothing stored."""
    import app.main as main_mod
    from fastapi.testclient import TestClient

    from app.models.business_profile import BusinessProfile
    from app.models.staff import StaffChatMessage, StaffChatThread
    from app.routers import business_profile as bp
    from app.routers import staff_chat as sc
    from app.services.ai_limits import BUSY_RETRY_AFTER_S, busy_message
    from app.services.auth import get_current_user

    monkeypatch.setattr(main_mod, "is_prod", True)
    owner = _owner(db)
    owner.plan = "pro"
    owner.ui_language = owner_lang_value
    db.commit()
    member, token = _make_staff_link(db, owner)

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    app.dependency_overrides[get_current_user] = lambda: owner
    sc._limiter.reset()
    bp._limiter.reset()
    png = _img("PNG")
    c = TestClient(app)
    try:
        if route == "portal_chat":
            r = c.post(f"/api/portal/{token}/chat/photos",
                       files=[("photos", ("a.png", png, "image/png"))], headers=_ip())
        elif route == "portal_profile":
            r = c.post(f"/api/portal/{token}/profile-photo",
                       files={"file": ("a.png", png, "image/png")}, headers=_ip())
        elif route == "owner_chat":
            r = c.post(f"/api/staff/chat/threads/{member.id}/photos",
                       files=[("photos", ("a.png", png, "image/png"))], headers=_ip())
        elif route == "owner_group_chat":
            g = StaffChatThread(user_id=owner.id, kind="group", title="Køkken")
            db.add(g)
            db.commit()
            r = c.post(f"/api/staff/chat/groups/{g.id}/photos",
                       files=[("photos", ("a.png", png, "image/png"))], headers=_ip())
        else:
            r = c.post("/api/business/logo", files={"file": ("a.png", png, "image/png")}, headers=_ip())
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)
        sc._limiter.reset()
        bp._limiter.reset()
    assert r.status_code == 503, r.text
    body = r.json()
    assert body["detail"] == busy_message(expected_lang), body
    assert body["code"] == "ai_busy"
    assert r.headers.get("retry-after") == str(BUSY_RETRY_AFTER_S)
    db.expire_all()
    assert db.query(StaffChatMessage).count() == 0
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == owner.id).first()
    assert profile is None or profile.logo_url is None
    assert db.get(type(member), member.id).profile_photo_key is None


# A call-level guard (round-3 review): the first version was file-level — a
# module that already used decode_slot once could add a second, ungated
# Image.open and stay green — and it missed reportlab's ImageReader,
# Image.frombytes / frombuffer and pillow_heif.read_heif / open_heif.

#: Decode sites that never see an upload's bytes. Keyed (module, call).
_NOT_AN_UPLOAD = {
    # The stored logo (logo_service re-encodes every upload to <= 800 px
    # PNG inside the gate) and QR codes BonBox renders itself.
    ("services/gavekort_pdf.py", "ImageReader"): "stored logo + generated QR",
    ("services/invoice_pdf.py", "reportlab Image"): "stored logo + generated MobilePay QR",
    ("services/kasserapport_pdf.py", "reportlab Image"): "stored logo",
}


def _callee(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _decode_calls(tree: ast.Module) -> list[tuple[ast.Call, str]]:
    """Every call that decodes image bytes, with a label."""
    pil, rl_image, image_reader = set(), set(), set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for a in node.names:
                name = a.asname or a.name
                if node.module == "PIL" and a.name == "Image":
                    pil.add(name)
                elif node.module == "reportlab.platypus" and a.name == "Image":
                    rl_image.add(name)
                elif node.module == "reportlab.lib.utils" and a.name == "ImageReader":
                    image_reader.add(name)
        elif isinstance(node, ast.Import):
            for a in node.names:
                if a.name == "PIL.Image" and a.asname:
                    pil.add(a.asname)
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        f = node.func
        if (isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id in pil
                and f.attr in ("open", "frombytes", "frombuffer")):
            found.append((node, f"Image.{f.attr}"))
        elif _callee(f) == "open_upload_image":
            found.append((node, "open_upload_image"))
        elif _callee(f) in ("read_heif", "open_heif"):
            found.append((node, _callee(f)))
        elif _callee(f) == "ImageReader" or (isinstance(f, ast.Name) and f.id in image_reader):
            found.append((node, "ImageReader"))
        elif isinstance(f, ast.Name) and f.id in rl_image:
            found.append((node, "reportlab Image"))
    return found


def _gated(tree: ast.Module, node: ast.AST, parents: dict, depth: int = 0) -> bool:
    """The call runs inside ``with decode_slot(...)``: lexically in the
    same function (a with-block, or a later item of the same with), or
    inside a helper whose every use is itself such a gated call."""
    cur = node
    while cur in parents:
        par = parents[cur]
        if isinstance(par, (ast.With, ast.AsyncWith)):
            if isinstance(cur, ast.withitem):
                prior = par.items[: par.items.index(cur)]
            else:
                prior = par.items if cur in par.body else []
            if any(isinstance(i.context_expr, ast.Call) and _callee(i.context_expr.func) == "decode_slot"
                   for i in prior):
                return True
        if isinstance(par, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            break
        cur = par
    fn = cur if isinstance(cur, (ast.FunctionDef, ast.AsyncFunctionDef)) else parents.get(cur)
    if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) or depth >= 4:
        return False
    uses = [n for n in ast.walk(tree)
            if isinstance(n, (ast.Name, ast.Attribute)) and _callee(n) == fn.name
            and isinstance(getattr(n, "ctx", None), ast.Load)]
    if not uses:
        return False
    for use in uses:
        call = parents.get(use)
        if not (isinstance(call, ast.Call) and call.func is use):
            return False  # handed around as a value: cannot tell where it runs
        if not _gated(tree, call, parents, depth + 1):
            return False
    return True


def _ungated_decodes(src: str, rel: str) -> list[str]:
    tree = ast.parse(src)
    parents = {c: p for p in ast.walk(tree) for c in ast.iter_child_nodes(p)}
    out = []
    for call, label in _decode_calls(tree):
        if (rel, label) in _NOT_AN_UPLOAD:
            continue
        if not _gated(tree, call, parents):
            out.append(f"{rel}:{call.lineno} {label}")
    return out


def test_every_module_that_decodes_an_upload_goes_through_the_gate():
    """A new decode site must not bypass the gate: every call that decodes
    image bytes (Image.open / frombytes / frombuffer, open_upload_image,
    reportlab's ImageReader / Image, pillow_heif read_heif / open_heif)
    must run inside ``with decode_slot()`` — checked per CALL, so a module
    that already uses the gate once cannot add a second, ungated decode.
    image_guard.open_upload_image's own Image.open is the exception by
    contract: its every caller is checked instead."""
    offenders, decoding = [], set()
    for path in sorted(APP_DIR.rglob("*.py")):
        rel = str(path.relative_to(APP_DIR))
        if rel == "services/image_guard.py":
            continue
        src = path.read_text(encoding="utf-8")
        if _decode_calls(ast.parse(src)):
            decoding.add(rel)
        offenders += _ungated_decodes(src, rel)
    assert offenders == []
    # Guards the guard: the known upload decoders were really looked at.
    assert {
        "services/receipt_ocr.py", "services/kasserapport_extractor.py", "services/inventory_ocr.py",
        "services/chat_image.py", "services/logo_service.py",
    } <= decoding, decoding


def test_the_gate_guard_catches_a_second_ungated_decode_in_a_gated_module():
    src = """
import io
from PIL import Image
from reportlab.lib.utils import ImageReader
import pillow_heif
from app.services.image_guard import decode_slot, open_upload_image

def gated(raw):
    with decode_slot():
        img = open_upload_image(raw)
    with decode_slot(), Image.open(io.BytesIO(raw)) as im:
        pass
    return img

def _helper(raw):
    return Image.open(io.BytesIO(raw))  # every use of _helper is gated

def gated_too(raw):
    with decode_slot():
        return _helper(raw)

def sneaky(raw):
    a = Image.open(io.BytesIO(raw))
    b = Image.frombytes("RGB", (1, 1), raw)
    c = ImageReader(io.BytesIO(raw))
    d = pillow_heif.read_heif(raw)
    with Image.open(io.BytesIO(raw)) as e, decode_slot():  # opened BEFORE the slot
        pass
    return open_upload_image(raw)
"""
    bad = _ungated_decodes(src, "services/x.py")
    lines = sorted(int(b.split(":")[1].split()[0]) for b in bad)
    assert len(bad) == 6, bad
    assert all(n >= 20 for n in lines), bad  # nothing in gated(), _helper() or gated_too()


# ─── 2. The chat sanitizer: 25 MP for PNG, phone JPEGs reduced ──────

def test_the_chat_png_ceiling_is_25_mp_and_the_jpeg_ceiling_stays_50_mp():
    assert chat_image._MAX_FULL_DECODE_PIXELS == 25_000_000
    assert chat_image._MAX_DECODED_PIXELS == 50_000_000 >= 8160 * 6120  # Samsung 50 MP


_TOO_MANY_PX_DA = "Billedet har for mange pixels – tag det i normal opløsning, eller brug et skærmbillede."
_TOO_MANY_PX_EN = "This photo has too many pixels – take it at normal resolution, or use a screenshot."


@pytest.mark.parametrize("fn_name", ["sanitize_chat_photo", "sanitize_profile_photo"])
@pytest.mark.parametrize("lang,msg", [(None, _TOO_MANY_PX_DA), ("da", _TOO_MANY_PX_DA), ("en", _TOO_MANY_PX_EN)])
def test_a_png_over_25_mp_is_refused_before_it_is_decoded(monkeypatch, fn_name, lang, msg):
    # 5001 x 5001 = 25.01 MP, RGBA: a few KB on the wire, 100 MB decoded.
    raw = _img("PNG", size=(5001, 5001), mode="RGBA", color=(255, 0, 0, 0))
    from PIL import ImageFile

    loads = []
    real_load = ImageFile.ImageFile.load
    monkeypatch.setattr(ImageFile.ImageFile, "load", lambda self: loads.append(1) or real_load(self))
    kw = {} if lang is None else {"lang": lang}  # no lang: a staffer, Danish
    with pytest.raises(HTTPException) as ei:
        getattr(chat_image, fn_name)(raw, **kw)
    assert ei.value.status_code == 413
    # The one "too many pixels" text every photo route uses (image_guard),
    # in the sender's language.
    assert ei.value.detail == msg
    assert ei.value.detail == image_guard.too_many_pixels_message(lang or "da")
    assert loads == [], "nothing may be decoded before the refusal"


@pytest.mark.parametrize("fn_name", ["sanitize_chat_photo", "sanitize_profile_photo"])
def test_a_jpeg_over_50_mp_gets_the_same_too_many_pixels_text(monkeypatch, fn_name):
    monkeypatch.setattr(chat_image, "_MAX_DECODED_PIXELS", 100 * 100)
    raw = _img("JPEG", size=(400, 300))
    with pytest.raises(HTTPException) as ei:
        getattr(chat_image, fn_name)(raw, lang="en")
    assert ei.value.status_code == 413
    assert ei.value.detail == _TOO_MANY_PX_EN


def test_an_rgba_png_under_the_ceiling_is_flattened_onto_white_as_before():
    raw = _img("PNG", size=(1200, 800), mode="RGBA", color=(0, 0, 0, 0))  # fully transparent
    data, ctype, _sha = chat_image.sanitize_chat_photo(raw)
    assert ctype == "image/jpeg"
    out = Image.open(io.BytesIO(data))
    assert out.size == (1200, 800)
    assert min(out.convert("L").getextrema()) >= 250  # white, not black


def test_a_48_mp_phone_jpeg_goes_through_chat_and_profile_decoded_reduced(monkeypatch):
    """iPhone 48 MP = 8064 x 6048. It must still work everywhere it worked,
    and the decoder must run at a reduced scale (draft), not 146 MB of RGB."""
    raw = _img("JPEG", size=(8064, 6048), color=(200, 210, 220), quality=60)
    from PIL import ImageFile

    loaded_sizes = []
    real_load = ImageFile.ImageFile.load

    def spy(self):
        loaded_sizes.append(self.size)
        return real_load(self)

    monkeypatch.setattr(ImageFile.ImageFile, "load", spy)
    data, _, _ = chat_image.sanitize_chat_photo(raw)
    assert Image.open(io.BytesIO(data)).size == (1600, 1200)
    assert loaded_sizes and loaded_sizes[0] == (2016, 1512)

    loaded_sizes.clear()
    data, _, _ = chat_image.sanitize_profile_photo(raw)
    assert Image.open(io.BytesIO(data)).size == (512, 512)
    assert loaded_sizes and loaded_sizes[0] == (1008, 756)


