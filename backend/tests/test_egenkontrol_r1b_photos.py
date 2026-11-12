"""Egenkontrol R1b — the optional photo on a deviation or a goods delivery.

One per reading, within 24 h, re-encoded JPEG without EXIF/GPS, private EU
storage, served only through the tenant-re-checked proxies. The owner can
remove one (tombstone: "Foto fjernet af ejeren <dato>"). Photos live 2 years
with their reading: the purge removes them first, then the readings.
"""
import io
import uuid
from datetime import timedelta

from PIL import Image
from pypdf import PdfReader

from app.models.food_check import FoodCheckEntry, FoodCheckPhoto
from app.services.storage import StorageError
from tests._ek_support import T0, env, jpeg_bytes, png_bytes, store  # noqa: F401 — fixtures


def _dev(env, o, fridge, value=9.0, headers=None):
    r = env.save(o, fridge, value, action_code="thermostat_adjusted", fate_code="moved",
                 headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


def _photos(env, uid=None):
    env.db.expire_all()
    q = env.db.query(FoodCheckPhoto)
    if uid is not None:
        q = q.filter(FoodCheckPhoto.user_id == uid)
    return q.all()


def _kitchen_save(env, token, check_id, value, **kw):
    body = {"client_id": str(uuid.uuid4()), "check_id": check_id, "value_c": value,
            "typed_name": "Bo", **kw}
    r = env.client.post(f"/api/kitchen/{token}/entries", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _kitchen_photo(env, token, entry_id, data=None):
    return env.client.post(f"/api/kitchen/{token}/entries/{entry_id}/photo",
                           files={"file": ("f.jpg", data or jpeg_bytes(), "image/jpeg")})


def test_which_readings_take_a_photo(env, store):
    o = env.owner()
    c = env.setup(o)
    dev = _dev(env, o, c["fridge"]["id"])
    r = env.photo(o, dev["id"])
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["entry_id"] == dev["id"] and p["via"] == "owner_app" and p["removed_at"] is None
    assert p["uploaded_local"] == "07:30" and p["uploaded_local_date"] == "2026-11-12"
    rec = env.save(o, c["receiving"]["id"], 3.0, product_type="chilled", label_ok=True).json()
    assert env.photo(o, rec["id"]).status_code == 201                      # delivery, in limit
    ok = env.save(o, c["freezer"]["id"], -20.0).json()
    r = env.photo(o, ok["id"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "photo_not_allowed"
    r = env.photo(o, dev["id"])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "photo_exists"
    undone = _dev(env, o, c["fridge"]["id"], 10.0)
    assert env.client.post(f"/api/egenkontrol/entries/{undone['id']}/undo",
                           headers=env.h(o)).status_code == 200
    r = env.photo(o, undone["id"])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_voided"
    late = _dev(env, o, c["fridge"]["id"], 11.0)
    env.clock.tick(hours=24, seconds=1)
    r = env.photo(o, late["id"])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "photo_window_passed"
    assert env.photo(o, str(uuid.uuid4())).status_code == 404
    other = env.owner(name="Anden")
    assert env.photo(other, dev["id"]).status_code == 404
    # EntryOut carries the photo (batch-loaded), the folder too
    f = env.folder(o)
    d = next(x for x in f["deviations"] if x["id"] == dev["id"])
    assert d["photo"]["id"] == p["id"]


def test_exif_is_stripped_and_a_png_becomes_a_jpeg(env, store):
    o = env.owner()
    c = env.setup(o)
    src = jpeg_bytes(size=(2400, 1800), gps=True)
    assert Image.open(io.BytesIO(src)).getexif().get(0x8825) is not None
    a = _dev(env, o, c["fridge"]["id"])
    assert env.photo(o, a["id"], src).status_code == 201
    b = _dev(env, o, c["freezer"]["id"], -5.0)
    assert env.photo(o, b["id"], png_bytes(), name="x.png").status_code == 201
    for row in _photos(env, o.id):
        assert row.content_type == "image/jpeg" and row.storage_key.endswith(".jpg")
        assert row.storage_key.startswith(f"{o.id}/food_check_photo/")
        img = Image.open(io.BytesIO(store.get(row.storage_key)))
        assert img.format == "JPEG" and max(img.size) <= 1600
        assert img.getexif().get(0x8825) is None and img.getexif().get(0x010F) is None
        assert row.size_bytes == len(store.get(row.storage_key))


def test_size_garbage_and_storage_errors(env, store, monkeypatch):
    o = env.owner()
    c = env.setup(o)
    a = _dev(env, o, c["fridge"]["id"])
    r = env.photo(o, a["id"], b"\xff\xd8\xff" + b"\0" * (8_000_001 - 3))
    assert r.status_code == 413 and r.json()["detail"]["code"] == "photo_too_large"
    r = env.photo(o, a["id"], b"definitely not an image")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "photo_unreadable"

    def boom(*a, **k):
        raise StorageError("down")
    monkeypatch.setattr(store, "put", boom)
    r = env.photo(o, a["id"])
    assert r.status_code == 503 and r.json()["detail"]["code"] == "storage_unavailable"
    assert _photos(env, o.id) == []


def test_who_may_view(env, store):
    o = env.owner()
    c = env.setup(o)
    a = _dev(env, o, c["fridge"]["id"])
    pid = env.photo(o, a["id"]).json()["id"]
    url = f"/api/egenkontrol/photos/{pid}"
    for who in (o, env.member(o, "manager")):
        r = env.client.get(url, headers=env.h(who))
        assert r.status_code == 200
        assert r.headers["content-type"] == "image/jpeg"
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["content-disposition"] == "inline"
        assert "private" in r.headers["cache-control"]
    assert env.client.get(url, headers=env.h(env.member(o, "cashier"))).status_code == 403
    assert env.client.get(url, headers=env.h(env.accountant(o))).status_code == 403
    assert env.client.get(url, headers=env.h(env.owner(name="Anden"))).status_code == 404
    m = env.member(o, "manager")
    assert env.photo(o, _dev(env, o, c["freezer"]["id"], -5.0)["id"],
                     headers=env.h(m)).status_code == 403


def test_the_kitchen_photo_routes(env, store):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    t1, t2 = env.pair(o, label="A"), env.pair(o, label="B")
    e1 = _kitchen_save(env, t1, fridge, 9.0, action_code="thermostat_adjusted", fate_code="moved")
    assert _kitchen_photo(env, t2, e1["id"]).status_code == 404          # another iPad's reading
    r = _kitchen_photo(env, t1, e1["id"])
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["via"] == "kitchen"
    row = _photos(env, o.id)[0]
    assert row.actor_user_id is None and str(row.kitchen_link_id)
    other = env.owner(name="Anden")
    ofridge = env.setup(other)["fridge"]["id"]
    oe = _dev(env, other, ofridge)
    assert _kitchen_photo(env, t1, oe["id"]).status_code == 404          # another venue
    owner_entry = _dev(env, o, fridge, 8.0)
    assert _kitchen_photo(env, t1, owner_entry["id"]).status_code == 404  # not this iPad's
    g = env.client.get(f"/api/kitchen/{t1}/photos/{p['id']}")
    assert g.status_code == 200 and g.headers["content-type"] == "image/jpeg"
    assert g.headers["x-content-type-options"] == "nosniff"
    env.clock.tick(days=29)
    assert env.client.get(f"/api/kitchen/{t2}/photos/{p['id']}").status_code == 200
    env.clock.tick(days=1)
    assert env.client.get(f"/api/kitchen/{t1}/photos/{p['id']}").status_code == 404
    assert env.client.delete(f"/api/kitchen/{t1}/photos/{p['id']}").status_code in (404, 405)


def test_removal_leaves_a_tombstone(env, store):
    o = env.owner()
    c = env.setup(o)
    a = _dev(env, o, c["fridge"]["id"])
    pid = env.photo(o, a["id"]).json()["id"]
    key = _photos(env, o.id)[0].storage_key
    m = env.member(o, "manager")
    assert env.client.delete(f"/api/egenkontrol/photos/{pid}", headers=env.h(m)).status_code == 403
    env.clock.tick(hours=2)
    r = env.client.delete(f"/api/egenkontrol/photos/{pid}", headers=env.h(o))
    assert r.status_code == 200, r.text
    assert r.json()["removed_at"] and r.json()["removed_local_date"] == "2026-11-12"
    row = _photos(env, o.id)[0]
    assert row.storage_key is None and row.removed_at is not None
    assert str(row.removed_by_user_id) == str(o.id)
    assert store.get(key) is None
    g = env.client.get(f"/api/egenkontrol/photos/{pid}", headers=env.h(o))
    assert g.status_code == 410 and g.json()["detail"]["code"] == "photo_removed"
    r = env.client.delete(f"/api/egenkontrol/photos/{pid}", headers=env.h(o))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_removed"
    f = env.folder(o)
    assert f["deviations"][0]["photo"]["removed_at"]
    pdf = env.client.get("/api/egenkontrol/folder.pdf", headers=env.h(o))
    text = " ".join(p.extract_text() for p in PdfReader(io.BytesIO(pdf.content)).pages)
    assert "Foto fjernet af ejeren 12. nov 2026" in text.replace("\n", " ")
    # a removed photo cannot be replaced (one per reading)
    assert env.photo(o, a["id"]).json()["detail"]["code"] == "photo_exists"


def test_the_pdf_says_photo_attached_never_the_photo(env, store):
    o = env.owner()
    c = env.setup(o)
    a = _dev(env, o, c["fridge"]["id"])
    env.photo(o, a["id"])
    rec = env.save(o, c["receiving"]["id"], 3.0, product_type="chilled", label_ok=True).json()
    env.clock.tick(minutes=30)
    env.photo(o, rec["id"])
    r = env.client.get("/api/egenkontrol/folder.pdf", headers=env.h(o))
    reader = PdfReader(io.BytesIO(r.content))
    text = " ".join(p.extract_text() for p in reader.pages).replace("\n", " ")
    assert "Foto vedlagt" in text
    assert "Foto vedlagt (tilføjet 12. nov 2026 kl. 08:00)" in text
    assert "Fotos er ikke med i udskriften." in text
    for page in reader.pages:
        assert not page.images                                  # never embedded


def test_photos_go_with_their_reading_after_730_days(env, store, monkeypatch):
    from app.jobs import privacy_purges as pp
    o = env.owner()
    c = env.setup(o)
    old = _dev(env, o, c["fridge"]["id"])
    env.photo(o, old["id"])
    old_key = _photos(env, o.id)[0].storage_key
    env.clock.tick(days=2)
    young = _dev(env, o, c["freezer"]["id"], -5.0)
    env.photo(o, young["id"], jpeg_bytes(color=(1, 2, 3)))
    monkeypatch.setattr(pp, "SessionLocal", env.SL)
    now = T0 + timedelta(days=731)                      # old: 731 days, young: 729
    counts = pp.dry_run_counts(env.SL(), now=now)
    assert counts["egenkontrol_photos"] == 1 and counts["egenkontrol_entries"] == 0

    # storage refuses the delete: the photo stays, so does its reading
    def boom(key):
        raise StorageError("down")
    real_delete = store.delete
    monkeypatch.setattr(store, "delete", boom)
    assert pp.purge_old_egenkontrol_photos(now=now) == {"due": 1, "deleted": 0, "dry_run": False}
    assert pp.purge_old_egenkontrol_entries(now=now)["deleted"] == 0
    assert len(_photos(env, o.id)) == 2 and store.get(old_key) is not None

    # the next night
    monkeypatch.setattr(store, "delete", real_delete)
    order = [k for k, _ in pp._PURGES]
    assert order.index("egenkontrol_photos") < order.index("egenkontrol_entries") \
        < order.index("egenkontrol_reviews")
    assert pp.purge_old_egenkontrol_photos(now=now)["deleted"] == 1
    assert pp.purge_old_egenkontrol_entries(now=now)["deleted"] == 1
    assert store.get(old_key) is None
    left = _photos(env, o.id)
    assert [str(p.entry_id) for p in left] == [young["id"]]
    env.db.expire_all()
    assert {str(e.id) for e in env.db.query(FoodCheckEntry).all()} == {young["id"]}


def test_a_shared_blob_survives_the_purge_of_one_row(env, store, monkeypatch):
    from app.jobs import privacy_purges as pp
    o = env.owner()
    c = env.setup(o)
    same = jpeg_bytes(color=(9, 9, 9))
    a = _dev(env, o, c["fridge"]["id"])
    env.photo(o, a["id"], same)
    env.clock.tick(days=5)
    b = _dev(env, o, c["freezer"]["id"], -5.0)
    env.photo(o, b["id"], same)
    keys = {p.storage_key for p in _photos(env, o.id)}
    assert len(keys) == 1
    monkeypatch.setattr(pp, "SessionLocal", env.SL)
    assert pp.purge_old_egenkontrol_photos(now=T0 + timedelta(days=731))["deleted"] == 1
    assert store.get(next(iter(keys))) is not None                     # b still uses it


def test_the_app_and_the_pdf_share_the_photo_added_later_rule():
    """The Kontrolmappe on screen says "Foto vedlagt (tilføjet …)" by the same
    threshold as the PDF — the frontend constant is pinned to the PDF's."""
    import re
    from pathlib import Path

    from app.services import egenkontrol_pdf as P

    src = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "components"
           / "egenkontrol" / "ekLogic.js").read_text(encoding="utf-8")
    m = re.search(r"export const PHOTO_LATE_AFTER_MIN = (\d+);", src)
    assert m, "PHOTO_LATE_AFTER_MIN missing in ekLogic.js"
    assert int(m.group(1)) * 60 == P.PHOTO_LATE_AFTER.total_seconds()
