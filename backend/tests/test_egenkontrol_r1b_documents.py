"""Egenkontrol R1b — the owner's documents in the Kontrolmappe.

Private EU storage (kind food_check_document, in ALLOWED_KINDS AND
ERASURE_PURGE_KINDS), sniffed from the bytes, images re-encoded without
EXIF, titles verbatim and never cut, served only as an attachment through
the tenant-re-checked proxies, "Uploadet … · gennemgås igen senest …" —
never "Aktuel".
"""
import io
import re
import uuid
from datetime import datetime
from pathlib import Path

from PIL import Image
from sqlalchemy import text

from app.models.food_check import FoodCheckDocument, FoodCheckPhoto, FoodCheckReview
from app.services import storage as storage_mod
from tests._ek_support import PDF_BYTES, env, jpeg_bytes, store  # noqa: F401 — fixtures

APP = Path(__file__).resolve().parents[1] / "app"


def _docs(env, uid):
    env.db.expire_all()
    return env.db.query(FoodCheckDocument).filter(FoodCheckDocument.user_id == uid).all()


def test_a_pdf_is_stored_as_is_under_the_owner(env, store):
    o = env.owner()
    r = env.doc(o)
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["doc_type"] == "programme" and d["content_type"] == "application/pdf"
    assert d["size_bytes"] == len(PDF_BYTES)
    row = _docs(env, o.id)[0]
    assert re.fullmatch(rf"{o.id}/food_check_document/[0-9a-f]{{64}}\.pdf", row.storage_key)
    assert len(row.storage_key) <= 200
    assert store.get(row.storage_key) == PDF_BYTES
    lst = env.client.get("/api/egenkontrol/documents", headers=env.h(o)).json()
    assert lst["max"] == 30 and [x["id"] for x in lst["documents"]] == [d["id"]]
    assert "storage_key" not in d


def test_an_image_loses_its_exif(env, store):
    o = env.owner()
    src = jpeg_bytes(gps=True)
    assert Image.open(io.BytesIO(src)).getexif().get(0x8825) is not None
    r = env.doc(o, src, title="Hygiejnebevis", doc_type="hygiene_cert", name="bevis.jpg")
    assert r.status_code == 201, r.text
    assert r.json()["content_type"] == "image/jpeg"
    row = _docs(env, o.id)[0]
    assert row.storage_key.endswith(".jpg")
    stored = Image.open(io.BytesIO(store.get(row.storage_key)))
    exif = stored.getexif()
    assert exif.get(0x8825) is None and exif.get(0x010F) is None


def test_file_refusals(env, store):
    o = env.owner()
    r = env.doc(o, b"<html><script>alert(1)</script></html>", name="evil.pdf")
    assert r.status_code == 422 and r.json()["detail"] == {"code": "unsupported_type"}
    r = env.doc(o, b"%PDF-" + b"0" * (10 * 1024 * 1024 + 1 - 5))
    assert r.status_code == 413 and r.json()["detail"]["code"] == "too_large"
    r = env.doc(o, b"")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "empty"
    assert _docs(env, o.id) == []


def test_title_and_type_rules(env, store):
    o = env.owner()
    t = "<b>Plan & co</b>"
    r = env.doc(o, title=t)
    assert r.status_code == 201 and r.json()["title"] == t
    r = env.doc(o, title="x" * 121)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "title_too_long"
    r = env.doc(o, title="   ")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "title_required"
    r = env.doc(o, title=None)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "title_required"
    r = env.doc(o, doc_type="contract")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "doc_type_unknown"
    assert [d.title for d in _docs(env, o.id)] == [t]           # never truncated


def test_at_most_30(env, store):
    o = env.owner()
    assert env.doc(o, title="Dok 0").status_code == 201
    row = _docs(env, o.id)[0]
    for i in range(1, 30):                     # rows, not uploads: 10/min limiter
        env.db.add(FoodCheckDocument(
            user_id=o.id, doc_type="other", title=f"Dok {i}", storage_key=row.storage_key,
            content_type=row.content_type, size_bytes=row.size_bytes,
            uploaded_at=row.uploaded_at))
    env.db.commit()
    assert len(_docs(env, o.id)) == 30
    r = env.doc(o, title="Dok 31")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "too_many_documents"


def test_review_dates_and_states(env, store):
    o = env.owner()
    env.clock.set(datetime(2028, 2, 29, 11, 0))
    d = env.doc(o).json()
    assert d["uploaded_local_date"] == "2028-02-29" and d["review_due"] == "2029-02-28"
    assert d["review_state"] == "ok" and d["reviewed_at"] is None

    def state_at(t):
        env.clock.set(t)
        return env.client.get("/api/egenkontrol/documents", headers=env.h(o)).json()["documents"][0]

    assert state_at(datetime(2029, 1, 20, 12))["review_state"] == "ok"        # 39 days
    assert state_at(datetime(2029, 1, 29, 12))["review_state"] == "soon"      # 30 days
    assert state_at(datetime(2029, 2, 28, 12))["review_state"] == "soon"
    assert state_at(datetime(2029, 3, 1, 12))["review_state"] == "overdue"
    r = env.client.post(f"/api/egenkontrol/documents/{d['id']}/reviewed", headers=env.h(o))
    assert r.status_code == 200, r.text
    assert r.json()["reviewed_local_date"] == "2029-03-01"
    assert r.json()["review_due"] == "2030-03-01" and r.json()["review_state"] == "ok"
    for key in ("review_state",):
        assert r.json()[key] in ("ok", "soon", "overdue")


def test_delete_keeps_a_blob_another_row_still_uses(env, store):
    o = env.owner()
    a = env.doc(o, title="A").json()
    b = env.doc(o, title="B").json()
    key = _docs(env, o.id)[0].storage_key
    assert {d.storage_key for d in _docs(env, o.id)} == {key}
    assert env.client.delete(f"/api/egenkontrol/documents/{a['id']}", headers=env.h(o)).json() == {"ok": True}
    assert store.get(key) == PDF_BYTES
    assert env.client.delete(f"/api/egenkontrol/documents/{b['id']}", headers=env.h(o)).status_code == 200
    assert store.get(key) is None
    assert env.client.delete(f"/api/egenkontrol/documents/{b['id']}", headers=env.h(o)).status_code == 404


def test_the_title_never_reaches_the_audit_log(env, store):
    """audit_logs cannot be deleted and outlive the account erasure; the title
    is the owner's free text (a hygiejnebevis often names an employee)."""
    from app.models.audit_log import AuditLog

    o = env.owner()
    title = "Hygiejnebevis Sara Jensen"
    d = env.doc(o, title=title, doc_type="hygiene_cert")
    assert d.status_code == 201, d.text
    did = d.json()["id"]
    assert env.client.post(f"/api/egenkontrol/documents/{did}/reviewed",
                           headers=env.h(o)).status_code == 200
    assert env.client.delete(f"/api/egenkontrol/documents/{did}", headers=env.h(o)).status_code == 200
    env.db.expire_all()
    rows = (env.db.query(AuditLog)
            .filter(AuditLog.user_id == o.id, AuditLog.action.like("egenkontrol.document_%"))
            .all())
    assert {r.action for r in rows} >= {"egenkontrol.document_added", "egenkontrol.document_removed"}
    for r in rows:
        blob = f"{r.before_state or ''} {r.after_state or ''}"
        assert "Sara" not in blob and "Jensen" not in blob and title not in blob, r.action
        assert "hygiene_cert" in blob


def test_who_may_download(env, store):
    o = env.owner()
    d = env.doc(o, title='Plan: "ny"/2026 æøå').json()
    url = f"/api/egenkontrol/documents/{d['id']}/file"
    for who in (o, env.member(o, "manager")):
        r = env.client.get(url, headers=env.h(who))
        assert r.status_code == 200, r.text
        assert r.content == PDF_BYTES and r.headers["content-type"] == "application/pdf"
        cd = r.headers["content-disposition"]
        assert cd.startswith("attachment;") and 'filename="Plan ny2026 aeoeaa.pdf"' in cd
        assert r.headers["x-content-type-options"] == "nosniff"
        assert "no-store" in r.headers["cache-control"]
    assert env.client.get(url, headers=env.h(env.member(o, "cashier"))).status_code == 403
    assert env.client.get(url, headers=env.h(env.accountant(o))).status_code == 403
    other = env.owner(name="Anden")
    assert env.client.get(url, headers=env.h(other)).status_code == 404
    # members never write documents
    m = env.member(o, "manager")
    assert env.doc(o, headers=env.h(m)).status_code == 403
    assert env.client.delete(f"/api/egenkontrol/documents/{d['id']}", headers=env.h(m)).status_code == 403


def test_the_kitchen_ipad_can_only_view(env, store):
    o = env.owner()
    env.setup(o)
    d = env.doc(o).json()
    token = env.pair(o)
    r = env.client.get(f"/api/kitchen/{token}/documents/{d['id']}/file")
    assert r.status_code == 200 and r.content == PDF_BYTES
    assert r.headers["content-disposition"].startswith("attachment;")
    other = env.owner(name="Anden")
    od = env.doc(other).json()
    assert env.client.get(f"/api/kitchen/{token}/documents/{od['id']}/file").status_code == 404
    for path in ("documents", f"documents/{d['id']}", f"documents/{d['id']}/reviewed"):
        assert env.client.post(f"/api/kitchen/{token}/{path}",
                               files={"file": ("x.pdf", PDF_BYTES, "application/pdf")}
                               ).status_code in (404, 405), path
        assert env.client.delete(f"/api/kitchen/{token}/{path}").status_code in (404, 405), path
    folder = env.client.get(f"/api/kitchen/{token}/folder").json()
    assert [x["id"] for x in folder["documents"]] == [d["id"]]
    assert "readings" not in folder and folder["range"]["max_days"] == 30


def test_no_aktuel_anywhere_and_the_storage_lists():
    for p in list((APP / "services").glob("egenkontrol*.py")) + list((APP / "routers").glob("egenkontrol*.py")) \
            + [APP / "routers" / "kitchen_link.py"]:
        src = p.read_text()
        assert "Aktuel" not in src and '"current"' not in src, p.name
    for kind in ("food_check_document", "food_check_photo"):
        assert kind in storage_mod.ALLOWED_KINDS and kind in storage_mod.ERASURE_PURGE_KINDS
        assert kind not in storage_mod.ACCOUNTING_RETENTION_KINDS
    key = storage_mod.compose_key(uuid.uuid4(), "food_check_document", "a" * 64, "pdf")
    assert len(key) == 125 and len(key) <= FoodCheckDocument.__table__.c.storage_key.type.length
    assert len(key) <= FoodCheckPhoto.__table__.c.storage_key.type.length


def test_delete_account_removes_rows_and_blobs(env, store):
    with env.engine.connect() as c:
        c.execute(text("PRAGMA foreign_keys=ON"))
    o = env.owner(email=f"gone-{uuid.uuid4().hex[:6]}@bonbox.dk")
    fridge = env.setup(o)["fridge"]["id"]
    env.doc(o)
    dev = env.save(o, fridge, 9.0, action_code="thermostat_adjusted", fate_code="moved").json()
    assert env.photo(o, dev["id"]).status_code == 201
    env.clock.set(datetime(2026, 11, 17, 9, 0))
    assert env.client.post("/api/egenkontrol/week/2026-W46/reviewed", json={},
                           headers=env.h(o)).status_code == 201
    kept = env.owner(name="Kept")
    env.doc(kept, title="Keep me")
    uid, kid = o.id, kept.id
    root = Path(store.root)
    assert any((root / str(uid) / "food_check_document").iterdir())
    assert any((root / str(uid) / "food_check_photo").iterdir())
    r = env.client.request("DELETE", "/api/auth/delete-account",
                           json={"password": "ownerpw123"}, headers=env.h(o))
    assert r.status_code == 200, r.text
    env.db.expunge_all()
    for m in (FoodCheckDocument, FoodCheckPhoto, FoodCheckReview):
        assert env.db.query(m).filter(m.user_id == uid).count() == 0, m.__tablename__
    for kind in ("food_check_document", "food_check_photo"):
        folder = root / str(uid) / kind
        assert not folder.exists() or not any(folder.iterdir()), kind
    assert len(_docs(env, kid)) == 1
    assert any((root / str(kid) / "food_check_document").iterdir())


def test_no_future_annotations_in_the_limiter_routers_or_the_schemas():
    """A string annotation makes FastAPI read a body (JSON or multipart) as
    query parameters behind slowapi — a silent 422 on every upload."""
    for p in (APP / "routers" / "egenkontrol.py", APP / "routers" / "egenkontrol_files.py",
              APP / "routers" / "kitchen_link.py", APP / "schemas" / "egenkontrol.py"):
        code = [ln for ln in p.read_text().splitlines() if ln.startswith("from __future__")]
        assert code == [], p.name
