"""Receipt photos still linked on the retired Ireland project are handed out
as links to the same file in Frankfurt — at READ time, never written back
(services/storage_links, receipt-relink release 23 Oct 2026).

Pinned here:
  • the helper's mapping for every stored shape found in production and the
    hostile ones (another owner's key, wrong bucket or kind, encoded / literal
    dot segments, backslash, lookalike hosts, user-info, query-string tricks,
    malformed URLs) — refused shapes come back unchanged with NO signing call
  • signing: the one-year TTL new uploads get, a short timeout, fallback to
    the stored value on failure, the 30-day cache, no path/token in a log line
  • the real SupabaseStorageBackend signs on the configured (Frankfurt) host
    and never sends a request to Ireland — also for a new upload
  • every read path (GET /expenses, /expenses/pending, /sales, /sales/receipts,
    /dashboard/batch, /daily-close and /daily-close/{id}) hands out the
    Frankfurt link, and the stored value is byte-identical with no UPDATE
  • the daily-close page echoing the re-link back keeps the stored string,
    the content signature and the audit trail (a real change still lands)
  • the Z-bon e-mail attachment reads the file by key from current storage
    (no URL fetch), and refuses another owner's key
  • GET /api/admin/storage-links: aggregate counts only, admin-only

Run:
  cd backend && python -m pytest tests/test_storage_links.py -q
"""
import json
import logging
import uuid
from datetime import date, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401 — register every model
from app.config import settings
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.user import User
from app.services import storage as storage_mod
from app.services import storage_links as sl
from app.services.auth import create_access_token, get_current_user, hash_password
from app.utils.time import utc_now

_db_ready.set()

IRL = "ahlqhztujpeccmaivkhr"
FRA = "qwogfearhfhaunqpuvgd"
IRL_HOST = f"https://{IRL}.supabase.co"
FRA_HOST = f"https://{FRA}.supabase.co"
ONE_YEAR = 31_536_000


def _key(uid, kind="expense", n="a"):
    return f"{uid}/{kind}/{n * 64}.jpg"


def _irl(key, access="sign", bucket="receipts", token="eyJhbGciOiJIUzI1NiJ9.irl.secret"):
    return f"{IRL_HOST}/storage/v1/object/{access}/{bucket}/{key}?token={token}"


class FakeBackend:
    """The storage surface the helper touches, recording every call."""
    is_durable = True

    def __init__(self, objects=None, *, sign="ok", host=FRA_HOST):
        self.objects = dict(objects or {})
        self.sign_mode = sign
        self.host = host
        self.sign_calls: list = []
        self.get_calls: list = []
        self.exists_calls: list = []

    def signed_url(self, key, ttl_seconds=3600, timeout=None):
        self.sign_calls.append((key, ttl_seconds, timeout))
        if self.sign_mode == "none":
            return None
        if self.sign_mode == "raise":
            raise httpx.ReadTimeout("slow")
        n = len(self.sign_calls)
        return f"{self.host}/storage/v1/object/sign/receipts/{key}?token=fresh{n}"

    def get(self, key):
        self.get_calls.append(key)
        return self.objects.get(key)

    def exists(self, key):
        self.exists_calls.append(key)
        if self.objects.get(key) == "unknown":
            return None
        return key in self.objects


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    sl.reset_for_tests()
    monkeypatch.setattr(settings, "SUPABASE_URL", FRA_HOST)
    monkeypatch.setattr(settings, "SUPABASE_RECEIPTS_BUCKET", "receipts")
    yield
    sl.reset_for_tests()


@pytest.fixture
def backend(monkeypatch):
    b = FakeBackend()
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    return b


OWNER = str(uuid.uuid4())
OTHER = str(uuid.uuid4())


# ─── the helper: what is re-linked ─────────────────────────────────────

@pytest.mark.parametrize("access", ["sign", "public", "authenticated"])
def test_owned_ireland_link_becomes_a_frankfurt_link(backend, access):
    k = _key(OWNER)
    out = sl.client_receipt_ref(_irl(k, access), OWNER, source="expenses")
    assert out.startswith(f"{FRA_HOST}/storage/v1/object/sign/receipts/{k}?token=")
    assert IRL not in out
    assert backend.sign_calls == [(k, ONE_YEAR, sl.SIGN_TIMEOUT_SECONDS)]


@pytest.mark.parametrize("kind", ["expense", "sale", "kasserapport"])
def test_every_receipt_kind_is_relinked(backend, kind):
    k = _key(OWNER, kind)
    assert sl.client_receipt_ref(_irl(k), OWNER).startswith(FRA_HOST)


def test_owner_may_be_a_uuid_object_and_host_case_is_ignored(backend):
    k = _key(OWNER)
    url = _irl(k).replace(IRL_HOST, f"https://{IRL.upper()}.SUPABASE.CO")
    assert sl.client_receipt_ref(url, uuid.UUID(OWNER)).startswith(FRA_HOST)


def test_percent_encoded_slashes_resolve_to_the_canonical_key(backend):
    k = _key(OWNER)
    url = _irl(k.replace("/", "%2F"))
    out = sl.client_receipt_ref(url, OWNER)
    assert out.startswith(FRA_HOST) and backend.sign_calls[0][0] == k


def test_ttl_is_the_one_new_uploads_get():
    assert sl.RECEIPT_URL_TTL_SECONDS == ONE_YEAR


# ─── the helper: what comes back unchanged ─────────────────────────────

@pytest.mark.parametrize("stored", [
    None, "", "   ",
    _key(OWNER),                                            # bare key (signing failed at upload)
    f"uploads/receipts/{OWNER}_1716900000_abcdef12.jpg",     # local fallback
    "uploads/receipts/" + "c" * 64 + ".enc",                 # inbox blob
    f"{FRA_HOST}/storage/v1/object/sign/receipts/{_key(OWNER)}?token=t",   # already Frankfurt
])
def test_non_retired_values_are_unchanged_and_never_signed(backend, stored):
    assert sl.client_receipt_ref(stored, OWNER) == stored
    assert backend.sign_calls == []


@pytest.mark.parametrize("stored, reason", [
    (_irl(_key(OTHER)), "refused_not_owner_key"),                        # another owner's file
    (_irl(_key(OWNER), bucket="other-bucket"), "refused_bucket"),
    (_irl(_key(OWNER, "staff_document")), "refused_kind"),
    (_irl(_key(OWNER, "business_logo")), "refused_kind"),
    (_irl(f"{OWNER}/expense/../../{OTHER}/expense/{'a' * 64}.jpg"), "refused_not_owner_key"),
    (_irl(f"{OWNER}/expense/%2e%2e/%2e%2e/{OTHER}/expense/{'a' * 64}.jpg"), "refused_not_owner_key"),
    (_irl(f"{OWNER}/expense/%252e%252e/{'a' * 64}.jpg"), "refused_not_owner_key"),
    (_irl(f"{OWNER}\\expense\\{'a' * 64}.jpg"), "refused_not_owner_key"),
    (_irl(f"{OWNER}/expense/{'a' * 64}.jpg%00.png"), "refused_not_owner_key"),
    (_irl(f"{OWNER}/expense/{'a' * 64}.jpg#frag"), "refused_not_owner_key"),
    (f"{IRL_HOST}/storage/v1/object/sign/receipts/{_key(OTHER)}?x=/object/sign/receipts/{_key(OWNER)}",
     "refused_not_owner_key"),                                           # query-string smuggling
    (f"{IRL_HOST}/rest/v1/object/receipts/{_key(OWNER)}", "refused_bucket"),  # not a storage path
    (f"{IRL_HOST}/storage/v1/object/sign/receipts", "refused_not_owner_key"),
    (_irl(_key(OWNER)).replace("https://", "http://"), "refused_scheme"),
])
def test_refused_retired_links_come_back_unchanged_without_signing(backend, stored, reason):
    assert sl.client_receipt_ref(stored, OWNER, source="expenses") == stored
    assert backend.sign_calls == []
    assert sl.relink_stats().get(reason) == 1


@pytest.mark.parametrize("stored", [
    f"https://{IRL}.supabase.co.evil.example/storage/v1/object/sign/receipts/{_key(OWNER)}",
    f"https://{IRL}.supabase.co@evil.example/storage/v1/object/sign/receipts/{_key(OWNER)}",
    f"https://evil.example/storage/v1/object/sign/receipts/{_key(OWNER)}?token=t",
    "https://bonbox-api.onrender.com/uploads/receipts/abc_1.jpg",     # the legacy sales row
])
def test_foreign_hosts_are_unchanged(backend, stored):
    assert sl.client_receipt_ref(stored, OWNER) == stored
    assert backend.sign_calls == []
    assert sl.relink_stats().get("foreign_host") == 1


def test_malformed_url_is_unchanged_and_never_raises(backend):
    stored = "https://[::1/storage/v1/object/sign/receipts/x"
    assert sl.client_receipt_ref(stored, OWNER) == stored
    assert backend.sign_calls == []


def test_no_owner_means_no_relink(backend):
    stored = _irl(_key(OWNER))
    assert sl.client_receipt_ref(stored, None) == stored
    assert backend.sign_calls == []


def test_non_durable_storage_means_no_relink(monkeypatch):
    b = FakeBackend()
    b.is_durable = False
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    stored = _irl(_key(OWNER))
    assert sl.client_receipt_ref(stored, OWNER) == stored
    assert b.sign_calls == []


@pytest.mark.parametrize("mode", ["none", "raise"])
def test_signing_failure_or_timeout_returns_the_stored_value(monkeypatch, mode):
    b = FakeBackend(sign=mode)
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    stored = _irl(_key(OWNER))
    assert sl.client_receipt_ref(stored, OWNER) == stored
    assert sl.relink_stats()["sign_failed"] == 1


def test_a_failed_signing_is_not_retried_on_every_read(monkeypatch):
    """A slow Supabase costs one short timeout per object per 5 minutes, not
    one per read of a list endpoint."""
    clock = [1000.0]
    monkeypatch.setattr(sl.time, "monotonic", lambda: clock[0])
    b = FakeBackend(sign="raise")
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    stored = _irl(_key(OWNER))
    for _ in range(3):
        assert sl.client_receipt_ref(stored, OWNER) == stored
    assert len(b.sign_calls) == 1 and sl.relink_stats()["sign_backoff"] == 2
    clock[0] += sl.SIGN_FAIL_BACKOFF_SECONDS + 1
    b.sign_mode = "ok"
    assert sl.client_receipt_ref(stored, OWNER).startswith(FRA_HOST)
    assert len(b.sign_calls) == 2


def test_a_signed_url_on_a_retired_host_is_never_handed_out(monkeypatch):
    b = FakeBackend(host=IRL_HOST)
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    stored = _irl(_key(OWNER))
    assert sl.client_receipt_ref(stored, OWNER) == stored
    assert sl.relink_stats()["sign_failed"] == 1


# ─── cache + logs ──────────────────────────────────────────────────────

def test_cache_hit_makes_no_second_signing_call(backend):
    stored = _irl(_key(OWNER))
    first = sl.client_receipt_ref(stored, OWNER)
    second = sl.client_receipt_ref(stored, OWNER)
    assert first == second and len(backend.sign_calls) == 1
    assert sl.relink_stats()["cache_hit"] == 1


def test_cache_entry_is_reminted_after_30_days(backend, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(sl.time, "monotonic", lambda: clock[0])
    stored = _irl(_key(OWNER))
    first = sl.client_receipt_ref(stored, OWNER)
    clock[0] += sl.CACHE_FRESH_SECONDS + 1
    second = sl.client_receipt_ref(stored, OWNER)
    assert first != second and len(backend.sign_calls) == 2


def test_a_cached_link_is_never_served_for_another_owners_row(backend):
    k = _key(OWNER)
    assert sl.client_receipt_ref(_irl(k), OWNER).startswith(FRA_HOST)
    # the same object named on a row of ANOTHER owner: refused before the cache
    assert sl.client_receipt_ref(_irl(k), OTHER) == _irl(k)


def test_cache_is_bounded(backend, monkeypatch):
    monkeypatch.setattr(sl, "CACHE_MAX_ENTRIES", 3)
    for i in range(5):
        sl.client_receipt_ref(_irl(f"{OWNER}/expense/{format(i, 'x') * 64}.jpg"), OWNER)
    assert sl.relink_stats()["cached_objects"] == 3


def test_logs_carry_no_path_key_or_token(backend, caplog):
    caplog.set_level(logging.DEBUG)
    secret = "eyJ.SECRET-TOKEN.x"
    sl.client_receipt_ref(_irl(_key(OTHER), token=secret), OWNER, source="expenses")
    sl.client_receipt_ref(f"https://evil.example/storage/v1/object/sign/receipts/{_key(OWNER)}?token={secret}",
                          OWNER, source="sales")
    sl.client_receipt_ref(_irl(_key(OWNER), token=secret), OWNER, source="expenses")   # relinked
    text = caplog.text
    assert "foreign_host" in text and "evil.example" in text
    for needle in (secret, OWNER, OTHER, "a" * 64, "/receipts/"):
        assert needle not in text


def test_unknown_host_is_logged_once(backend, caplog):
    caplog.set_level(logging.WARNING)
    for _ in range(3):
        sl.client_receipt_ref("https://bonbox-api.onrender.com/uploads/receipts/x.jpg", OWNER, source="sales")
    assert caplog.text.count("foreign_host") == 1
    assert sl.relink_stats()["foreign_host"] == 3


def test_same_receipt_object_compares_by_key():
    k = _key(OWNER, "kasserapport")
    fra = f"{FRA_HOST}/storage/v1/object/sign/receipts/{k}?token=new"
    assert sl.same_receipt_object(fra, _irl(k), OWNER)
    assert sl.same_receipt_object(k, _irl(k), OWNER)
    assert not sl.same_receipt_object(fra, _irl(_key(OWNER, "kasserapport", "b")), OWNER)
    assert not sl.same_receipt_object(_irl(_key(OTHER)), _irl(_key(OTHER)), OWNER)
    assert not sl.same_receipt_object(None, _irl(k), OWNER)
    assert not sl.same_receipt_object(fra, _irl(k), None)


# ─── the real Supabase backend: Frankfurt only, short timeout ──────────

def _mock_supabase(monkeypatch, seen, objects=()):
    def handler(request):
        seen.append(request)
        assert request.url.host == f"{FRA}.supabase.co", "a request left for a non-live project"
        path = request.url.path
        if path.startswith("/storage/v1/object/sign/receipts/"):
            key = path[len("/storage/v1/object/sign/receipts/"):]
            return httpx.Response(200, json={"signedURL": f"/object/sign/receipts/{key}?token=fresh"})
        if path == "/storage/v1/object/list/receipts":
            body = json.loads(request.content)
            names = [o.rsplit("/", 1)[1] for o in objects if o.rsplit("/", 1)[0] == body["prefix"]]
            return httpx.Response(200, json=[{"name": n} for n in names if n.startswith(body["search"])])
        if path.startswith("/storage/v1/object/receipts/"):
            return httpx.Response(200, json={"Key": path})
        return httpx.Response(404)
    b = storage_mod.SupabaseStorageBackend(FRA_HOST, "service-key", "receipts")
    b._client = httpx.Client(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    return b


def test_real_backend_relinks_on_frankfurt_with_one_year_and_short_timeout(monkeypatch):
    seen = []
    _mock_supabase(monkeypatch, seen)
    k = _key(OWNER)
    out = sl.client_receipt_ref(_irl(k), OWNER)
    assert out == f"{FRA_HOST}/storage/v1/object/sign/receipts/{k}?token=fresh"
    assert len(seen) == 1
    assert json.loads(seen[0].content) == {"expiresIn": ONE_YEAR}
    assert seen[0].extensions["timeout"]["read"] == sl.SIGN_TIMEOUT_SECONDS


def test_a_new_upload_never_stores_an_ireland_link(monkeypatch):
    """New uploads sign on the configured project — Frankfurt — with the same
    TTL constant the re-link uses; nothing is sent to Ireland."""
    from app.services import receipt_ocr
    seen = []
    _mock_supabase(monkeypatch, seen)
    stored = receipt_ocr._upload_to_supabase(b"\xff\xd8jpeg", "x.jpg", user_id=OWNER, kind="expense")
    assert stored.startswith(f"{FRA_HOST}/storage/v1/object/sign/receipts/{OWNER}/expense/")
    assert IRL not in stored
    sign = [r for r in seen if "/object/sign/" in r.url.path]
    assert json.loads(sign[0].content) == {"expiresIn": sl.RECEIPT_URL_TTL_SECONDS}


def test_no_app_code_names_the_retired_project_outside_the_retired_list():
    """Only storage_links (the retired list) and the restore script (refused
    targets) may name the Ireland ref — no read or upload path can aim at it."""
    from pathlib import Path
    root = Path(__file__).resolve().parents[1] / "app"
    hits = sorted(str(p.relative_to(root)) for p in root.rglob("*.py") if IRL in p.read_text(encoding="utf-8"))
    assert hits == ["services/storage_links.py"]


def test_real_backend_exists_answers_three_ways(monkeypatch):
    seen = []
    k = _key(OWNER)
    b = _mock_supabase(monkeypatch, seen, objects=[k])
    assert b.exists(k) is True
    assert b.exists(_key(OWNER, n="b")) is False
    b._client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    assert b.exists(k) is None

    def boom(request):
        raise httpx.ConnectError("down")
    b._client = httpx.Client(transport=httpx.MockTransport(boom))
    assert b.exists(k) is None


# ─── read paths over HTTP ──────────────────────────────────────────────

@pytest.fixture
def env(monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = Session()

    def _get_db():
        yield s

    app.dependency_overrides[get_db] = _get_db
    import app.database as _db_mod
    monkeypatch.setattr(_db_mod, "SessionLocal", Session, raising=False)
    monkeypatch.setattr("app.services.billing.SessionLocal", Session, raising=False)
    from app.routers.expenses import _limiter as exp_limiter
    from app.routers.daily_close import _limiter as dc_limiter
    from app.routers.dashboard import _ai_limiter
    for lim in (exp_limiter, dc_limiter, _ai_limiter):
        monkeypatch.setattr(lim, "enabled", False)
    try:
        app.state.limiter.reset()
    except Exception:  # noqa: BLE001
        pass
    statements: list[str] = []

    def _record(conn, cursor, statement, params, context, executemany):
        statements.append(statement.strip().upper())

    event.listen(engine, "before_cursor_execute", _record)
    yield s, statements
    event.remove(engine, "before_cursor_execute", _record)
    s.close()
    app.dependency_overrides.clear()


def _owner(db, plan="starter"):
    u = User(email=f"o-{uuid.uuid4().hex[:8]}@bonbox.test", password_hash=hash_password("x"),
             business_name="Café Test", business_type="cafe", currency="DKK", plan=plan,
             email_verified=True, created_at=utc_now() - timedelta(days=3))
    db.add(u); db.commit(); db.refresh(u)
    return u


def _writes_to(statements, table):
    t = table.upper()
    return [st for st in statements
            if (st.startswith("UPDATE") and f"UPDATE {t}" in st)
            or (st.startswith("INSERT") and f"INTO {t}" in st)
            or (st.startswith("DELETE") and f"FROM {t}" in st)]


def _assert_nothing_written(db, statements, table, model, raw):
    """The request shares this session: an ORM attribute the read path set
    would show as dirty here, and the commit below would flush it as an
    UPDATE. Neither may happen, and the stored value stays byte-identical."""
    rows = db.query(model).filter(model.id.in_(list(raw))).all()
    assert not db.dirty
    assert not any(db.is_modified(r) for r in rows)
    db.commit()
    assert _writes_to(statements, table) == []
    db.expire_all()
    for r in db.query(model).filter(model.id.in_(list(raw))).all():
        assert r.receipt_photo == raw[r.id]


def _hdr(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id))}"}


def test_expense_read_paths_hand_out_frankfurt_and_write_nothing(env, backend):
    db, statements = env
    u = _owner(db)
    cat = ExpenseCategory(user_id=u.id, name="Råvarer", color="#3B82F6")
    db.add(cat); db.commit()
    k1, k2, k3 = _key(u.id, n="a"), _key(u.id, n="b"), _key(OTHER, n="c")
    posted = Expense(user_id=u.id, category_id=cat.id, date=date(2026, 7, 1), amount=10,
                     description="booked", payment_method="card", receipt_photo=_irl(k1))
    draft = Expense(user_id=u.id, category_id=cat.id, date=date(2026, 7, 2), amount=20,
                    description="draft", payment_method="card", receipt_photo=_irl(k2), status="pending")
    foreign = Expense(user_id=u.id, category_id=cat.id, date=date(2026, 7, 3), amount=30,
                      description="someone else's key", payment_method="card", receipt_photo=_irl(k3))
    db.add_all([posted, draft, foreign]); db.commit()
    raw = {e.id: e.receipt_photo for e in (posted, draft, foreign)}
    app.dependency_overrides[get_current_user] = lambda: u
    client = TestClient(app)
    statements.clear()

    listed = {r["description"]: r["receipt_photo"] for r in client.get("/api/expenses").json()}
    assert listed["booked"].startswith(f"{FRA_HOST}/storage/v1/object/sign/receipts/{k1}")
    assert listed["someone else's key"] == _irl(k3)          # refused: not this owner's file
    pending = client.get("/api/expenses/pending").json()
    assert pending[0]["receipt_photo"].startswith(f"{FRA_HOST}/storage/v1/object/sign/receipts/{k2}")
    assert [c[0] for c in backend.sign_calls] == [k1, k2]   # k3 never signed

    _assert_nothing_written(db, statements, "expenses", Expense, raw)


def test_sales_read_paths_hand_out_frankfurt_and_write_nothing(env, backend):
    db, statements = env
    u = _owner(db)
    k = _key(u.id, "expense")      # prod: the one Ireland sale points at an expense-kind file
    sale = Sale(user_id=u.id, date=date(2026, 5, 7), amount=99, payment_method="card",
                receipt_photo=_irl(k))
    legacy = Sale(user_id=u.id, date=date(2026, 5, 6), amount=50, payment_method="card",
                  receipt_photo="https://bonbox-api.onrender.com/uploads/receipts/old_1.jpg")
    db.add_all([sale, legacy]); db.commit()
    raw = {sale.id: sale.receipt_photo, legacy.id: legacy.receipt_photo}
    app.dependency_overrides[get_current_user] = lambda: u
    client = TestClient(app)
    statements.clear()

    for path in ("/api/sales", "/api/sales/receipts"):
        rows = {r["amount"]: r["receipt_photo"] for r in client.get(path).json()}
        assert rows[99.0].startswith(f"{FRA_HOST}/storage/v1/object/sign/receipts/{k}"), path
        assert rows[50.0] == raw[legacy.id], path
    r = client.get("/api/dashboard/batch?weather=0")
    assert r.status_code == 200, r.text
    receipts = {x["amount"]: x["receipt_photo"] for x in r.json()["receipts"]}
    assert receipts[99.0].startswith(f"{FRA_HOST}/storage/v1/object/sign/receipts/{k}")

    assert len(backend.sign_calls) == 1                      # cached across the three paths
    _assert_nothing_written(db, statements, "sales", Sale, raw)


def _close_payload(photo, *, status="draft", base=None):
    p = {
        "date": "2026-05-23", "branch_id": None, "status": status,
        "revenue_breakdown": {"food": 8000, "drinks": 4500},
        "payment_breakdown": {"cash": 3200, "card": 9300},
        "moms_total": 2500, "moms_mode": "auto", "tips_total": 450, "tips_staff_count": 3,
        "cash_counted": 3200, "closed_by": "Anders", "notes": "Friday night.",
        "receipt_photo": photo,
    }
    if base:
        p["base_updated_at"] = base
    return p


def test_daily_close_read_paths_hand_out_frankfurt_and_write_nothing(env, backend):
    db, statements = env
    u = _owner(db)
    k = _key(u.id, "kasserapport")
    dc = DailyClose(user_id=u.id, date=date(2026, 5, 23), revenue_total=100, payment_total=100,
                    status="confirmed", receipt_photo=_irl(k))
    db.add(dc); db.commit()
    raw = dc.receipt_photo
    client = TestClient(app)
    statements.clear()

    listed = client.get("/api/daily-close", headers=_hdr(u)).json()
    one = client.get(f"/api/daily-close/{dc.id}", headers=_hdr(u)).json()
    for out in (listed[0]["receipt_photo"], one["receipt_photo"]):
        assert out.startswith(f"{FRA_HOST}/storage/v1/object/sign/receipts/{k}")
    _assert_nothing_written(db, statements, "daily_closes", DailyClose, {dc.id: raw})


def test_daily_close_echo_back_keeps_the_stored_photo_and_signature(env, backend):
    """The page loads the close, gets the Frankfurt re-link, and sends it back
    on its next autosave. The stored Ireland string, the content signature and
    the audit trail must not move — or a re-lock reads as 'changed' to the
    revisor. A real new photo still replaces it."""
    from app.routers.daily_close import _content_signature
    db, _ = env
    u = _owner(db)
    k = _key(u.id, "kasserapport")
    irl = _irl(k)
    client = TestClient(app)
    r = client.post("/api/daily-close", json=_close_payload(irl), headers=_hdr(u))
    assert r.status_code == 200, r.text
    handed = r.json()["receipt_photo"]
    assert handed.startswith(FRA_HOST) and k in handed        # the page now holds the re-link
    row = db.query(DailyClose).filter(DailyClose.user_id == u.id).one()
    assert row.receipt_photo == irl
    sig_before = _content_signature(row)
    audits_before = db.query(AuditLog).filter(AuditLog.user_id == u.id).count()

    r = client.post("/api/daily-close", json=_close_payload(handed, base=r.json()["updated_at"]),
                    headers=_hdr(u))
    assert r.status_code == 200, r.text
    db.expire_all()
    row = db.query(DailyClose).filter(DailyClose.user_id == u.id).one()
    assert row.receipt_photo == irl                           # stored string kept
    assert _content_signature(row) == sig_before              # re-lock stays "unchanged"
    new_audits = (db.query(AuditLog).filter(AuditLog.user_id == u.id)
                  .order_by(AuditLog.created_at).all()[audits_before:])
    assert all("receipt_photo" not in (a.before_state or "") for a in new_audits)

    # a genuinely different photo still lands
    other = f"{FRA_HOST}/storage/v1/object/sign/receipts/{_key(u.id, 'kasserapport', 'b')}?token=t"
    r = client.post("/api/daily-close", json=_close_payload(other, base=r.json()["updated_at"]),
                    headers=_hdr(u))
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.query(DailyClose).filter(DailyClose.user_id == u.id).one().receipt_photo == other


def _starter_with_profile(db):
    u = _owner(db, plan="starter")
    db.add(BusinessProfile(user_id=u.id, company_name="Test ApS", org_number="12345678", country="DK",
                           email="owner@test.dk", accountant_email="revisor@bonbox.dk"))
    db.commit()
    return u


def _no_url_fetch(monkeypatch):
    def refuse(*a, **k):
        raise AssertionError("the Z-bon photo must be read from storage, not fetched by URL")
    monkeypatch.setattr("urllib.request.urlopen", refuse)


def test_zbon_mail_attaches_the_frankfurt_copy_of_an_ireland_photo(env, monkeypatch):
    db, _ = env
    sent = []
    monkeypatch.setattr("app.services.email_service.resend.Emails.send", lambda p: sent.append(p) or None)
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")
    _no_url_fetch(monkeypatch)
    u = _starter_with_profile(db)
    k = _key(u.id, "kasserapport")
    b = FakeBackend({k: b"\xff\xd8\xff\xe0 the z-bon"})
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    r = TestClient(app).post("/api/daily-close", json=_close_payload(_irl(k), status="confirmed"),
                             headers=_hdr(u))
    assert r.status_code == 200, r.text
    ritual = r.json()["close_ritual"]
    assert ritual["has_scan"] is True and ritual["scan_degraded"] is False
    assert b.get_calls == [k]
    assert all(len(p["attachments"]) == 2 for p in sent) and sent


def test_zbon_mail_refuses_another_owners_key(env, monkeypatch):
    db, _ = env
    sent = []
    monkeypatch.setattr("app.services.email_service.resend.Emails.send", lambda p: sent.append(p) or None)
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")
    _no_url_fetch(monkeypatch)
    u = _starter_with_profile(db)
    foreign = _key(OTHER, "kasserapport")
    b = FakeBackend({foreign: b"someone else's z-bon"})
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    r = TestClient(app).post("/api/daily-close", json=_close_payload(_irl(foreign), status="confirmed"),
                             headers=_hdr(u))
    assert r.status_code == 200, r.text
    ritual = r.json()["close_ritual"]
    assert ritual["has_scan"] is False and ritual["scan_degraded"] is True
    assert b.get_calls == []
    assert all(len(p["attachments"]) == 1 for p in sent)


def test_zbon_fetch_never_requests_a_url_on_any_host(monkeypatch):
    from app.routers.daily_close import _fetch_scan_bytes_best_effort
    _no_url_fetch(monkeypatch)
    b = FakeBackend()
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    for url in ("https://169.254.169.254/latest/meta-data", f"{FRA_HOST}/rest/v1/users",
                f"{FRA_HOST}/storage/v1/object/sign/receipts/{_key(OTHER, 'kasserapport')}?token=t"):
        assert _fetch_scan_bytes_best_effort(url, OWNER) == (None, None)
    assert b.get_calls == []
    # a staff document of the owner's is not a Z-bon
    assert _fetch_scan_bytes_best_effort(_irl(_key(OWNER, "staff_document")), OWNER) == (None, None)
    assert b.get_calls == []


# ─── GET /api/admin/storage-links ──────────────────────────────────────

def test_admin_storage_links_counts_only(env, monkeypatch):
    from app.services.admin_security import require_super_admin
    db, statements = env
    u = _owner(db)
    cat = ExpenseCategory(user_id=u.id, name="R", color="#3B82F6")
    db.add(cat); db.commit()
    there, gone, unknown = _key(u.id, n="a"), _key(u.id, n="b"), _key(u.id, n="c")
    b = FakeBackend({there: b"x", unknown: "unknown"})
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    for n, photo in enumerate([_irl(there), _irl(there), _irl(gone), _irl(unknown), _irl(_key(OTHER)),
                               f"{FRA_HOST}/storage/v1/object/sign/receipts/{_key(u.id, n='d')}?token=t",
                               _key(u.id, n="e"), None, ""]):
        db.add(Expense(user_id=u.id, category_id=cat.id, date=date(2026, 7, 1), amount=n + 1,
                       description=f"e{n}", payment_method="card", receipt_photo=photo,
                       is_deleted=(n == 1)))
    db.add(Sale(user_id=u.id, date=date(2026, 5, 7), amount=1, payment_method="card",
                receipt_photo="uploads/receipts/legacy_1.jpg"))
    db.add(Sale(user_id=u.id, date=date(2026, 5, 7), amount=2, payment_method="card",
                receipt_photo="https://bonbox-api.onrender.com/uploads/receipts/x.jpg"))
    db.add(DailyClose(user_id=u.id, date=date(2026, 5, 23), revenue_total=1, payment_total=1,
                      receipt_photo=_irl(_key(u.id, "kasserapport"))))
    db.commit()
    app.dependency_overrides[require_super_admin] = lambda: u
    statements.clear()
    r = TestClient(app).get("/api/admin/storage-links")
    assert r.status_code == 200, r.text
    body = r.json()
    cols = {c["table"]: c for c in body["columns"]}
    e = cols["expenses"]
    assert (e["rows_with_value"], e["retired_host"], e["current_host"], e["not_url"]) == (7, 5, 1, 1)
    assert (e["retired_resolvable"], e["retired_missing"], e["retired_unchecked"],
            e["retired_refused"]) == (2, 1, 1, 1)
    assert e["retired_refused_by_reason"] == {"refused_not_owner_key": 1}
    s = cols["sales"]
    assert (s["rows_with_value"], s["not_url"], s["other_url"], s["retired_host"]) == (2, 1, 1, 0)
    d = cols["daily_closes"]
    assert (d["retired_host"], d["retired_missing"]) == (1, 1)
    assert body["unresolvable"] == 4 and body["safe_to_delete_retired_project"] is False
    assert body["totals"]["retired_host"] == 6
    assert len(b.exists_calls) == 4                          # one per distinct object
    assert b.sign_calls == []
    # aggregates only: no key, owner id, path, token or host in the answer
    text = r.text
    for needle in (str(u.id), OTHER, "a" * 64, "token", "supabase.co", "onrender"):
        assert needle not in text
    for table in ("expenses", "sales", "daily_closes"):
        assert _writes_to(statements, table) == []


def test_admin_storage_links_safe_when_every_row_resolves(env, monkeypatch):
    from app.services.admin_security import require_super_admin
    db, _ = env
    u = _owner(db)
    k = _key(u.id, "kasserapport")
    b = FakeBackend({k: b"x"})
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    db.add(DailyClose(user_id=u.id, date=date(2026, 5, 23), revenue_total=1, payment_total=1,
                      receipt_photo=_irl(k)))
    db.commit()
    app.dependency_overrides[require_super_admin] = lambda: u
    body = TestClient(app).get("/api/admin/storage-links").json()
    assert body["unresolvable"] == 0 and body["safe_to_delete_retired_project"] is True


def test_admin_storage_links_is_admin_only(env, monkeypatch):
    """The real guard (no override): an ordinary owner is turned away with
    the admin routes' generic 404 and gets no counts."""
    db, _ = env
    monkeypatch.setattr(settings, "SUPER_ADMIN_EMAILS", "founder@bonbox.dk", raising=False)
    u = _owner(db)
    b = FakeBackend()
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    r = TestClient(app).get("/api/admin/storage-links", headers=_hdr(u))
    assert r.status_code in (403, 404), r.text
    assert "columns" not in r.text and b.exists_calls == []
    r = TestClient(app).get("/api/admin/storage-links")
    assert r.status_code in (401, 403, 404)
