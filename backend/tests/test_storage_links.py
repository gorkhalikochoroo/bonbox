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
  • fix round (23 Oct): only rows written before the 20 Oct cutover are
    ever signed (a tenant's typed Ireland URLs cost no outbound call), a
    process-wide signing budget, the delete flag proves signing itself and
    ignores post-cutover rows, and no key reaches a log line
  • fix round 2 (23 Oct): link-bilag stores a pre-move draft's photo as its
    Frankfurt link (503 and nothing written when it cannot); no write path
    takes a NEW Ireland link (422; the daily-close page's own echo passes);
    a per-owner signing budget inside the process-wide one; storage GET
    logs no key; host log marks cannot silence a reason; the naive-is-UTC
    rule is checked under a forced non-UTC zone; the Z-bon read waits 8 s
  • fix round 3 (23 Oct): a row written after the cutover that still links
    to Ireland holds the delete flag false; the link-bilag 503 says "a few
    minutes" (the signing backoff is 5); a padded Ireland spelling is
    refused on every write path; exists() logs no key on an error

Run:
  cd backend && python -m pytest tests/test_storage_links.py -q
"""
import json
import logging
import os
import time
import uuid
from datetime import date, datetime, timedelta, timezone

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


# A row's created_at as the columns store it (naive UTC): before the move to
# Frankfurt (every legacy Ireland row) and after it (only typed by a client).
OLD = datetime(2026, 10, 1, 9, 30)
NEW = datetime(2026, 10, 21, 9, 30)


def _ref(stored, owner, **kw):
    """client_receipt_ref for a row written before the cutover — the rows
    the re-link exists for. The cutover gate itself is pinned below."""
    kw.setdefault("created_at", OLD)
    return sl.client_receipt_ref(stored, owner, **kw)


class FakeBackend:
    """The storage surface the helper touches, recording every call."""
    is_durable = True

    def __init__(self, objects=None, *, sign="ok", host=FRA_HOST):
        self.objects = dict(objects or {})
        self.sign_mode = sign
        self.host = host
        self.sign_calls: list = []
        self.get_calls: list = []
        self.get_timeouts: list = []
        self.exists_calls: list = []

    def signed_url(self, key, ttl_seconds=3600, timeout=None):
        self.sign_calls.append((key, ttl_seconds, timeout))
        if self.sign_mode == "none":
            return None
        if self.sign_mode == "raise":
            raise httpx.ReadTimeout("slow")
        n = len(self.sign_calls)
        return f"{self.host}/storage/v1/object/sign/receipts/{key}?token=fresh{n}"

    def get(self, key, timeout=None):
        self.get_calls.append(key)
        self.get_timeouts.append(timeout)
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
    out = _ref(_irl(k, access), OWNER, source="expenses")
    assert out.startswith(f"{FRA_HOST}/storage/v1/object/sign/receipts/{k}?token=")
    assert IRL not in out
    assert backend.sign_calls == [(k, ONE_YEAR, sl.SIGN_TIMEOUT_SECONDS)]


@pytest.mark.parametrize("kind", ["expense", "sale", "kasserapport"])
def test_every_receipt_kind_is_relinked(backend, kind):
    k = _key(OWNER, kind)
    assert _ref(_irl(k), OWNER).startswith(FRA_HOST)


def test_owner_may_be_a_uuid_object_and_host_case_is_ignored(backend):
    k = _key(OWNER)
    url = _irl(k).replace(IRL_HOST, f"https://{IRL.upper()}.SUPABASE.CO")
    assert _ref(url, uuid.UUID(OWNER)).startswith(FRA_HOST)


def test_percent_encoded_slashes_resolve_to_the_canonical_key(backend):
    k = _key(OWNER)
    url = _irl(k.replace("/", "%2F"))
    out = _ref(url, OWNER)
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
    assert _ref(stored, OWNER) == stored
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
    assert _ref(stored, OWNER, source="expenses") == stored
    assert backend.sign_calls == []
    assert sl.relink_stats().get(reason) == 1


@pytest.mark.parametrize("stored", [
    f"https://{IRL}.supabase.co.evil.example/storage/v1/object/sign/receipts/{_key(OWNER)}",
    f"https://{IRL}.supabase.co@evil.example/storage/v1/object/sign/receipts/{_key(OWNER)}",
    f"https://evil.example/storage/v1/object/sign/receipts/{_key(OWNER)}?token=t",
    "https://bonbox-api.onrender.com/uploads/receipts/abc_1.jpg",     # the legacy sales row
])
def test_foreign_hosts_are_unchanged(backend, stored):
    assert _ref(stored, OWNER) == stored
    assert backend.sign_calls == []
    assert sl.relink_stats().get("foreign_host") == 1


def test_malformed_url_is_unchanged_and_never_raises(backend):
    stored = "https://[::1/storage/v1/object/sign/receipts/x"
    assert _ref(stored, OWNER) == stored
    assert backend.sign_calls == []


def test_no_owner_means_no_relink(backend):
    stored = _irl(_key(OWNER))
    assert _ref(stored, None) == stored
    assert backend.sign_calls == []


def test_non_durable_storage_means_no_relink(monkeypatch):
    b = FakeBackend()
    b.is_durable = False
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    stored = _irl(_key(OWNER))
    assert _ref(stored, OWNER) == stored
    assert b.sign_calls == []


@pytest.mark.parametrize("mode", ["none", "raise"])
def test_signing_failure_or_timeout_returns_the_stored_value(monkeypatch, mode):
    b = FakeBackend(sign=mode)
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    stored = _irl(_key(OWNER))
    assert _ref(stored, OWNER) == stored
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
        assert _ref(stored, OWNER) == stored
    assert len(b.sign_calls) == 1 and sl.relink_stats()["sign_backoff"] == 2
    clock[0] += sl.SIGN_FAIL_BACKOFF_SECONDS + 1
    b.sign_mode = "ok"
    assert _ref(stored, OWNER).startswith(FRA_HOST)
    assert len(b.sign_calls) == 2


def test_a_signed_url_on_a_retired_host_is_never_handed_out(monkeypatch):
    b = FakeBackend(host=IRL_HOST)
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    stored = _irl(_key(OWNER))
    assert _ref(stored, OWNER) == stored
    assert sl.relink_stats()["sign_failed"] == 1


# ─── cache + logs ──────────────────────────────────────────────────────

def test_cache_hit_makes_no_second_signing_call(backend):
    stored = _irl(_key(OWNER))
    first = _ref(stored, OWNER)
    second = _ref(stored, OWNER)
    assert first == second and len(backend.sign_calls) == 1
    assert sl.relink_stats()["cache_hit"] == 1


def test_cache_entry_is_reminted_after_30_days(backend, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(sl.time, "monotonic", lambda: clock[0])
    stored = _irl(_key(OWNER))
    first = _ref(stored, OWNER)
    clock[0] += sl.CACHE_FRESH_SECONDS + 1
    second = _ref(stored, OWNER)
    assert first != second and len(backend.sign_calls) == 2


def test_a_cached_link_is_never_served_for_another_owners_row(backend):
    k = _key(OWNER)
    assert _ref(_irl(k), OWNER).startswith(FRA_HOST)
    # the same object named on a row of ANOTHER owner: refused before the cache
    assert _ref(_irl(k), OTHER) == _irl(k)


def test_cache_is_bounded(backend, monkeypatch):
    monkeypatch.setattr(sl, "CACHE_MAX_ENTRIES", 3)
    for i in range(5):
        _ref(_irl(f"{OWNER}/expense/{format(i, 'x') * 64}.jpg"), OWNER)
    assert sl.relink_stats()["cached_objects"] == 3


def test_logs_carry_no_path_key_or_token(backend, caplog):
    caplog.set_level(logging.DEBUG)
    secret = "eyJ.SECRET-TOKEN.x"
    _ref(_irl(_key(OTHER), token=secret), OWNER, source="expenses")
    _ref(f"https://evil.example/storage/v1/object/sign/receipts/{_key(OWNER)}?token={secret}",
                          OWNER, source="sales")
    _ref(_irl(_key(OWNER), token=secret), OWNER, source="expenses")   # relinked
    text = caplog.text
    assert "foreign_host" in text and "evil.example" in text
    for needle in (secret, OWNER, OTHER, "a" * 64, "/receipts/"):
        assert needle not in text


def test_unknown_host_is_logged_once(backend, caplog):
    caplog.set_level(logging.WARNING)
    for _ in range(3):
        _ref("https://bonbox-api.onrender.com/uploads/receipts/x.jpg", OWNER, source="sales")
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
    out = _ref(_irl(k), OWNER)
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
                     description="booked", payment_method="card", receipt_photo=_irl(k1), created_at=OLD)
    draft = Expense(user_id=u.id, category_id=cat.id, date=date(2026, 7, 2), amount=20,
                    description="draft", payment_method="card", receipt_photo=_irl(k2), status="pending",
                    created_at=OLD)
    foreign = Expense(user_id=u.id, category_id=cat.id, date=date(2026, 7, 3), amount=30,
                      description="someone else's key", payment_method="card", receipt_photo=_irl(k3),
                      created_at=OLD)
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
                receipt_photo=_irl(k), created_at=OLD)
    legacy = Sale(user_id=u.id, date=date(2026, 5, 6), amount=50, payment_method="card",
                  receipt_photo="https://bonbox-api.onrender.com/uploads/receipts/old_1.jpg", created_at=OLD)
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
                    status="confirmed", receipt_photo=_irl(k), created_at=OLD)
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
    r = client.post("/api/daily-close", json=_close_payload(None), headers=_hdr(u))
    assert r.status_code == 200, r.text
    # A NEW Ireland link is refused on save (fix round 2), so the legacy
    # draft it stands for — written before the move — is planted directly.
    row = db.query(DailyClose).filter(DailyClose.user_id == u.id).one()
    row.receipt_photo = irl
    row.created_at = OLD
    db.commit()
    r = client.get(f"/api/daily-close/{row.id}", headers=_hdr(u))
    assert r.status_code == 200, r.text
    handed = r.json()["receipt_photo"]
    assert handed.startswith(FRA_HOST) and k in handed        # the page now holds the re-link
    db.expire_all()
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


def _legacy_draft_close(db, u, photo):
    """A draft close written before the move, its Z-bon on Ireland — the only
    way one can exist since fix round 2 refuses a NEW Ireland link."""
    dc = DailyClose(user_id=u.id, date=date(2026, 5, 23), revenue_total=0, payment_total=0,
                    status="draft", receipt_photo=photo, created_at=OLD)
    db.add(dc); db.commit()
    return dc


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
    _legacy_draft_close(db, u, _irl(k))
    r = TestClient(app).post("/api/daily-close", json=_close_payload(_irl(k), status="confirmed"),
                             headers=_hdr(u))
    assert r.status_code == 200, r.text
    ritual = r.json()["close_ritual"]
    assert ritual["has_scan"] is True and ritual["scan_degraded"] is False
    assert b.get_calls == [k]
    assert b.get_timeouts == [8.0]            # fix round 2: a short read inside the confirm request
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
    _legacy_draft_close(db, u, _irl(foreign))    # the echo of the stored string passes the save
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
                       is_deleted=(n == 1), created_at=OLD))
    db.add(Sale(user_id=u.id, date=date(2026, 5, 7), amount=1, payment_method="card",
                receipt_photo="uploads/receipts/legacy_1.jpg", created_at=OLD))
    db.add(Sale(user_id=u.id, date=date(2026, 5, 7), amount=2, payment_method="card",
                receipt_photo="https://bonbox-api.onrender.com/uploads/receipts/x.jpg", created_at=OLD))
    db.add(DailyClose(user_id=u.id, date=date(2026, 5, 23), revenue_total=1, payment_total=1,
                      receipt_photo=_irl(_key(u.id, "kasserapport")), created_at=OLD))
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
    assert (e["retired_signable"], e["retired_sign_failed"], e["retired_after_cutover"]) == (2, 0, 0)
    assert e["retired_refused_by_reason"] == {"refused_not_owner_key": 1}
    s = cols["sales"]
    assert (s["rows_with_value"], s["not_url"], s["other_url"], s["retired_host"]) == (2, 1, 1, 0)
    d = cols["daily_closes"]
    assert (d["retired_host"], d["retired_missing"]) == (1, 1)
    assert body["unresolvable"] == 4 and body["safe_to_delete_retired_project"] is False
    assert body["totals"]["retired_host"] == 6
    assert len(b.exists_calls) == 4                          # one per distinct object
    # one short-lived signing per object that exists — the delete proof
    assert b.sign_calls == [(there, sl.REPORT_SIGN_TTL_SECONDS, sl.SIGN_TIMEOUT_SECONDS)]
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
                      receipt_photo=_irl(k), created_at=OLD))
    db.commit()
    app.dependency_overrides[require_super_admin] = lambda: u
    body = TestClient(app).get("/api/admin/storage-links").json()
    assert body["unresolvable"] == 0 and body["safe_to_delete_retired_project"] is True
    assert body["totals"]["retired_signable"] == 1


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


# ─── fix round 23 Oct: B1 — only rows written before the cutover sign ──

@pytest.mark.parametrize("created_at, reason", [
    (None, "refused_no_created_at"),
    ("2026-10-01T09:30:00", "refused_no_created_at"),          # not a datetime: fail closed
    (datetime(2026, 10, 20, 0, 0), "refused_after_cutover"),     # the instant itself (naive UTC)
    (NEW, "refused_after_cutover"),
    (datetime(2026, 10, 20, 2, 30, tzinfo=timezone(timedelta(hours=2))), "refused_after_cutover"),
])
def test_rows_without_a_legacy_created_at_are_never_signed(backend, created_at, reason):
    stored = _irl(_key(OWNER))
    assert sl.client_receipt_ref(stored, OWNER, created_at=created_at, source="expenses") == stored
    assert backend.sign_calls == []
    assert sl.relink_stats().get(reason) == 1


@pytest.mark.parametrize("created_at", [
    datetime(2026, 10, 19, 23, 59, 59),                                   # naive UTC, just before
    datetime(2026, 10, 20, 1, 0, tzinfo=timezone(timedelta(hours=2))),   # 19 Oct 23:00 UTC
    datetime(2026, 5, 7, 12, 0, tzinfo=timezone.utc),
])
def test_rows_written_before_the_cutover_are_relinked(backend, created_at):
    out = sl.client_receipt_ref(_irl(_key(OWNER)), OWNER, created_at=created_at)
    assert out.startswith(FRA_HOST) and len(backend.sign_calls) == 1


def test_cutover_is_the_frankfurt_move():
    assert sl.RETIRED_CUTOVER == datetime(2026, 10, 20, tzinfo=timezone.utc)


def _bulk_expenses(db, u, photos, created_at):
    cat = ExpenseCategory(user_id=u.id, name=f"R{uuid.uuid4().hex[:4]}", color="#3B82F6")
    db.add(cat); db.commit()
    db.bulk_save_objects([
        Expense(user_id=u.id, category_id=cat.id, date=date(2026, 7, 1), amount=1,
                description=f"x{i}", payment_method="card", receipt_photo=photo, created_at=created_at)
        for i, photo in enumerate(photos)])
    db.commit()


def test_typed_ireland_urls_on_new_rows_cost_no_signing_call(env, monkeypatch):
    """Probe P2/P3: a tenant stores 1,100 made-up Ireland URLs naming its OWN
    key. Before the fix every GET /api/expenses made 1,100 outbound signing
    calls (the 1,024-entry failure list evicts itself). Rows written after
    the cutover are never signed: 0 calls, and the stored value comes back."""
    db, _ = env
    b = FakeBackend(sign="none")                       # Supabase: "object not found"
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    u = _owner(db)
    photos = [_irl(f"{u.id}/expense/{format(i, '064x')}.jpg") for i in range(1100)]
    _bulk_expenses(db, u, photos, NEW)
    app.dependency_overrides[get_current_user] = lambda: u
    client = TestClient(app)
    for _ in range(3):
        r = client.get("/api/expenses")
        assert r.status_code == 200 and len(r.json()) == 1100
    assert b.sign_calls == []
    assert sorted(x["receipt_photo"] for x in r.json()) == sorted(photos)
    # a NEW typed one is refused at the door since fix round 2 (422) — no
    # row, no signing call
    r = client.post("/api/expenses", json={"date": "2026-10-22", "amount": 5, "description": "typed",
                                           "payment_method": "card",
                                           "receipt_photo": _irl(_key(u.id, n="f"))})
    assert r.status_code == 422, r.text
    assert db.query(Expense).filter(Expense.description == "typed").count() == 0
    assert b.sign_calls == []


def test_signing_is_capped_per_minute_process_wide(env, monkeypatch):
    """Backstop: 100 legacy rows with made-up keys (each signing fails) make
    at most SIGN_BUDGET_PER_MIN outbound calls a minute, however often the
    list is read."""
    db, _ = env
    clock = [5000.0]
    monkeypatch.setattr(sl, "_now", lambda: clock[0])
    b = FakeBackend(sign="none")
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    # 5 owners x 25 rows: each owner's own budget (10) is not the limit
    # here, the process-wide one (30) is
    uids = [_owner(db).id for _ in range(5)]
    for uid in uids:
        _bulk_expenses(db, db.get(User, uid),
                       [_irl(f"{uid}/expense/{format(i, '064x')}.jpg") for i in range(25)], OLD)
    client = TestClient(app)

    def read_all():
        for uid in uids:
            app.dependency_overrides[get_current_user] = lambda uid=uid: db.get(User, uid)
            assert client.get("/api/expenses").status_code == 200

    read_all()
    assert len(b.sign_calls) == sl.SIGN_BUDGET_PER_MIN
    for _ in range(3):                                  # same minute: nothing more goes out
        read_all()
    assert len(b.sign_calls) == sl.SIGN_BUDGET_PER_MIN
    assert sl.relink_stats()["sign_budget"] >= 70
    clock[0] += 60                                      # a minute later: one more minute's worth
    read_all()
    assert len(b.sign_calls) == 2 * sl.SIGN_BUDGET_PER_MIN
    assert len({c[0] for c in b.sign_calls}) == 2 * sl.SIGN_BUDGET_PER_MIN   # no key asked twice


def test_a_spent_budget_still_serves_cached_links(backend, monkeypatch):
    clock = [5000.0]
    monkeypatch.setattr(sl, "_now", lambda: clock[0])
    monkeypatch.setattr(sl, "SIGN_BUDGET_PER_MIN", 2)
    sl.reset_for_tests()
    a, bb, c = (_irl(_key(OWNER, n=x)) for x in "abc")
    first = _ref(a, OWNER)
    assert first.startswith(FRA_HOST) and _ref(bb, OWNER).startswith(FRA_HOST)
    assert _ref(c, OWNER) == c                          # budget spent: stored value
    assert _ref(a, OWNER) == first                      # cached: no budget needed
    assert len(backend.sign_calls) == 2
    clock[0] += 30                                      # half a minute: one token back
    assert _ref(c, OWNER).startswith(FRA_HOST)


# ─── fix round 23 Oct: the delete flag proves signing, ignores new rows ──

def _admin_get(env, monkeypatch, b, u):
    from app.services.admin_security import require_super_admin
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    app.dependency_overrides[require_super_admin] = lambda: u
    r = TestClient(app).get("/api/admin/storage-links")
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.parametrize("mode", ["none", "raise", "retired_host"])
def test_not_safe_to_delete_when_the_current_project_cannot_sign(env, monkeypatch, mode):
    """Right after a deploy relink_stats.sign_failed is 0 because nothing was
    tried. The flag must not lean on that: it signs each legacy object
    itself, and an object that exists but cannot be signed is unresolvable."""
    db, _ = env
    u = _owner(db)
    k = _key(u.id, "kasserapport")
    # "retired_host": signing answers, but with a link on the retired host
    b = FakeBackend({k: b"x"}, sign=("ok" if mode == "retired_host" else mode),
                    host=(IRL_HOST if mode == "retired_host" else FRA_HOST))
    db.add(DailyClose(user_id=u.id, date=date(2026, 5, 23), revenue_total=1, payment_total=1,
                      receipt_photo=_irl(k), created_at=OLD))
    db.commit()
    body = _admin_get(env, monkeypatch, b, u)
    assert body["relink_stats"].get("sign_failed", 0) == 0          # the counter says nothing
    t = body["totals"]
    assert (t["retired_resolvable"], t["retired_signable"], t["retired_sign_failed"]) == (1, 0, 1)
    assert body["unresolvable"] == 1
    assert body["safe_to_delete_retired_project"] is False
    assert b.exists_calls == [k] and [c[0] for c in b.sign_calls] == [k]


def test_rows_written_after_the_cutover_never_starve_the_check_but_hold_the_flag(env, monkeypatch):
    """Probe P5: one real legacy row, then a tenant adds 501 made-up own-key
    rows and one naming another owner's key — all written after the cutover.
    They are counted apart and never checked (the legacy row still gets its
    check). Since fix round 3 they hold the flag false: no write path stores
    a new Ireland link since fix round 2, so a post-cutover Ireland row has
    to be explained before the delete — the flag cannot tell typed junk
    from a real photo."""
    db, _ = env
    owner = _owner(db)
    k = _key(owner.id, "kasserapport")
    db.add(DailyClose(user_id=owner.id, date=date(2026, 5, 23), revenue_total=1, payment_total=1,
                      receipt_photo=_irl(k), created_at=OLD))
    db.commit()
    attacker = _owner(db)
    fakes = [_irl(f"{attacker.id}/expense/{format(i, '064x')}.jpg") for i in range(501)]
    _bulk_expenses(db, attacker, fakes + [_irl(_key(owner.id, n="z"))], NEW)
    b = FakeBackend({k: b"x"})
    body = _admin_get(env, monkeypatch, b, owner)
    t = body["totals"]
    assert t["retired_host"] == 503 and t["retired_after_cutover"] == 502
    assert (t["retired_signable"], t["retired_missing"], t["retired_unchecked"], t["retired_refused"]) == (1, 0, 0, 0)
    assert body["unresolvable"] == 0 and body["safe_to_delete_retired_project"] is False
    assert b.exists_calls == [k] and [c[0] for c in b.sign_calls] == [k]


def test_report_checks_the_oldest_legacy_rows_first_and_holds_no_transaction(env, monkeypatch):
    """Rows are read oldest first (the check budget reaches the real legacy
    rows before anything newer), and the read transaction is over before the
    first storage call — no DB connection is held while storage answers."""
    db, _ = env
    u = _owner(db)
    cat = ExpenseCategory(user_id=u.id, name="R", color="#3B82F6")
    db.add(cat); db.commit()
    newer, older = _key(u.id, n="b"), _key(u.id, n="a")
    for k, at in ((newer, OLD), (older, OLD - timedelta(days=30))):     # inserted newest first
        db.add(Expense(user_id=u.id, category_id=cat.id, date=date(2026, 7, 1), amount=1,
                       description="x", payment_method="card", receipt_photo=_irl(k), created_at=at))
    db.commit()
    in_tx = []

    class Watching(FakeBackend):
        def exists(self, key):
            in_tx.append(db.in_transaction())
            return super().exists(key)

    b = Watching({newer: b"x", older: b"x"})
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    body = sl.storage_link_report(db, check_limit=1)
    assert b.exists_calls == [older]
    assert body["totals"]["retired_unchecked"] == 1 and body["safe_to_delete_retired_project"] is False
    assert in_tx == [False]


# ─── fix round 23 Oct: no key or error body in a storage log line ──────

def test_real_backend_signing_failures_log_no_key_or_body(monkeypatch, caplog):
    """Probe P4: a 400 'Object not found' from Supabase (its body echoes the
    path) and a transport error whose message names the URL — the WARNING
    lines carry neither the owner id nor the file name. (WARNING is what the
    web process emits: it configures no root level, so httpx's own INFO
    request line, which does name the URL, is not written there.)"""
    caplog.set_level(logging.WARNING)
    k = _key(OWNER)
    b = storage_mod.SupabaseStorageBackend(FRA_HOST, "service-key", "receipts")
    b._client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(
        400, json={"statusCode": "404", "error": "not_found",
                   "message": f"Object not found: receipts/{r.url.path}"})))
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    assert _ref(_irl(k), OWNER) == _irl(k)                  # re-link failed -> stored value
    assert "signed_url -> 400" in caplog.text

    def boom(request):
        raise httpx.ConnectError(f"cannot reach {request.url}")
    b._client = httpx.Client(transport=httpx.MockTransport(boom))
    assert b.signed_url(k) is None
    assert "ConnectError" in caplog.text
    for needle in (OWNER, "a" * 64, "/receipts/", "Object not found"):
        assert needle not in caplog.text


def test_upload_prints_no_key(monkeypatch, capsys):
    from app.services import receipt_ocr
    _mock_supabase(monkeypatch, [])
    stored = receipt_ocr._upload_to_supabase(b"\xff\xd8jpeg", "x.jpg", user_id=OWNER, kind="expense")
    assert stored.startswith(FRA_HOST)
    out = capsys.readouterr().out
    assert "Uploaded receipt" in out and OWNER not in out


# ─── fix round 2 (23 Oct) ──────────────────────────────────────────────
# 1 link-bilag re-links a pre-move draft's photo at WRITE time
# 2 no write path accepts a NEW retired-host link; a per-owner signing budget
# 3 SupabaseStorageBackend.get logs no key
# 4 host log marks cannot silence reason-only warnings
# 5 'naive created_at is UTC' is guarded under a non-UTC local zone in CI too
# 6 the Z-bon attachment read is bounded (8 s)

def _cat(db, u):
    c = ExpenseCategory(user_id=u.id, name=f"R{uuid.uuid4().hex[:4]}", color="#3B82F6")
    db.add(c); db.commit()
    return c


def _draft_and_typed(db, u, photo, *, draft_at=OLD, typed_at=NEW):
    """A pre-move Godkend-kø draft with its bilag on Ireland, and an expense
    the owner typed after the move (the 'Knyt til eksisterende udgift' case:
    2 of the 4 Ireland expense photos in production are such drafts)."""
    cat = _cat(db, u)
    draft = Expense(user_id=u.id, category_id=cat.id, date=date(2026, 10, 2), amount=80,
                    description="scan", payment_method="card", receipt_photo=photo,
                    receipt_source="scan", status="pending", created_at=draft_at)
    typed = Expense(user_id=u.id, category_id=cat.id, date=date(2026, 10, 2), amount=80,
                    description="typed", payment_method="card", created_at=typed_at)
    db.add_all([draft, typed]); db.commit()
    return draft, typed


def _bilag_audits(db, u):
    return db.query(AuditLog).filter(AuditLog.user_id == u.id,
                                     AuditLog.action == "expense.bilag_linked").all()


def test_is_retired_link():
    k = _key(OWNER)
    assert sl.is_retired_link(_irl(k))
    assert sl.is_retired_link("  " + _irl(k).replace("https://", "http://").upper() + " ")
    assert sl.is_retired_link(f"//{IRL}.supabase.co/storage/v1/object/sign/receipts/{k}")
    for v in (None, "", 42, k, f"{FRA_HOST}/storage/v1/object/sign/receipts/{k}?token=t",
              f"https://{IRL}.supabase.co.evil.example/x", f"https://{IRL}.supabase.co@evil.example/x",
              "https://[::1/x", f"uploads/receipts/{OWNER}_1.jpg"):
        assert not sl.is_retired_link(v), v


def test_link_bilag_stores_the_frankfurt_link_for_a_pre_move_draft(env, monkeypatch):
    """Probe P8: the draft's Ireland link used to move as is onto a typed
    expense written after the move — never re-linked there, counted as
    'after the cutover', so the delete flag said safe while a real photo
    stayed on Ireland. It is now stored as the Frankfurt link to the same
    file; nothing on Ireland is left behind and the audit row says so."""
    db, _ = env
    u = _owner(db)
    k = _key(u.id, "expense", "7")
    draft, typed = _draft_and_typed(db, u, _irl(k))
    draft_id, typed_id = draft.id, typed.id
    b = FakeBackend({k: b"x"})
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    app.dependency_overrides[get_current_user] = lambda: u
    c = TestClient(app)
    r = c.post(f"/api/expenses/{typed_id}/link-bilag", json={"draft_id": str(draft_id)})
    assert r.status_code == 200, r.text
    db.expire_all()
    stored = db.get(Expense, typed_id).receipt_photo
    assert stored.startswith(f"{FRA_HOST}/storage/v1/object/sign/receipts/{k}?token=")
    assert not sl.is_retired_link(stored)
    assert b.sign_calls == [(k, ONE_YEAR, sl.SIGN_TIMEOUT_SECONDS)]
    assert db.get(Expense, draft_id) is None                       # the draft went, as before
    (audit,) = _bilag_audits(db, u)
    after = json.loads(audit.after_state)
    assert after["receipt_photo"] == stored and after["receipt_relinked"] is True
    # a later deploy (cold cache): the row hands out what it stores, and the
    # delete check finds nothing on Ireland
    sl.reset_for_tests()
    listed = {x["description"]: x["receipt_photo"] for x in c.get("/api/expenses").json()}
    assert listed["typed"] == stored
    from app.services.admin_security import require_super_admin
    app.dependency_overrides[require_super_admin] = lambda: u
    body = TestClient(app).get("/api/admin/storage-links").json()
    assert body["totals"]["retired_host"] == 0 and body["totals"]["retired_after_cutover"] == 0


def test_link_bilag_reuses_the_link_the_queue_was_handed(env, monkeypatch):
    """The Godkend-kø list already re-linked the draft's photo: the write
    takes the cached link — no second signing call."""
    db, _ = env
    u = _owner(db)
    k = _key(u.id, "expense", "8")
    draft, typed = _draft_and_typed(db, u, _irl(k))
    draft_id, typed_id = draft.id, typed.id
    b = FakeBackend({k: b"x"})
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    app.dependency_overrides[get_current_user] = lambda: u
    c = TestClient(app)
    handed = c.get("/api/expenses/pending").json()[0]["receipt_photo"]
    assert handed.startswith(FRA_HOST)
    r = c.post(f"/api/expenses/{typed_id}/link-bilag", json={"draft_id": str(draft_id)})
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.get(Expense, typed_id).receipt_photo == handed and len(b.sign_calls) == 1


@pytest.mark.parametrize("mode", ["none", "raise", "budget", "retired_host"])
def test_link_bilag_writes_nothing_when_the_draft_photo_cannot_be_relinked(env, monkeypatch, mode):
    """Signing fails, times out, the budget is spent, or it answers with an
    Ireland link: 503 with a DA/EN message, and nothing is written — the
    draft stays in the queue, the typed expense has no bilag, no audit row."""
    db, statements = env
    u = _owner(db)
    k = _key(u.id, "expense", "9")
    draft, typed = _draft_and_typed(db, u, _irl(k))
    if mode == "budget":
        monkeypatch.setattr(sl, "SIGN_BUDGET_PER_OWNER_PER_MIN", 0)
        b = FakeBackend({k: b"x"})
    elif mode == "retired_host":
        b = FakeBackend({k: b"x"}, host=IRL_HOST)
    else:
        b = FakeBackend({k: b"x"}, sign=mode)
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    app.dependency_overrides[get_current_user] = lambda: u
    statements.clear()
    r = TestClient(app).post(f"/api/expenses/{typed.id}/link-bilag", json={"draft_id": str(draft.id)})
    assert r.status_code == 503, r.text
    d = r.json()["detail"]
    assert d["code"] == "bilag_relink_unavailable" and d["message"] and d["message_da"]
    assert _writes_to(statements, "expenses") == []
    db.expire_all()
    assert db.get(Expense, typed.id).receipt_photo is None
    still = db.get(Expense, draft.id)
    assert still is not None and still.status == "pending" and still.receipt_photo == _irl(k)
    assert _bilag_audits(db, u) == []


def test_link_bilag_refuses_a_typed_ireland_link(env, monkeypatch):
    """Probe P1: a tenant could put a chosen own-key Ireland link on a
    PRE-move expense through link-bilag's receipt_photo body (it passes
    is_own_upload) — then every read signed it. Refused before the owner
    check; nothing stored, no signing call."""
    db, _ = env
    b = FakeBackend(sign="none")
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    u = _owner(db)
    target = Expense(user_id=u.id, category_id=_cat(db, u).id, date=date(2026, 7, 1), amount=1,
                     description="old", payment_method="card", created_at=OLD)
    db.add(target); db.commit()
    typed = _irl(f"{u.id}/expense/{'e' * 64}.jpg")
    app.dependency_overrides[get_current_user] = lambda: u
    r = TestClient(app).post(f"/api/expenses/{target.id}/link-bilag", json={"receipt_photo": typed})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "retired_receipt_link" and r.json()["detail"]["message_da"]
    db.expire_all()
    assert db.get(Expense, target.id).receipt_photo is None
    assert b.sign_calls == [] and _bilag_audits(db, u) == []
    # a real upload's link (Frankfurt) still links
    ok = f"{FRA_HOST}/storage/v1/object/sign/receipts/{u.id}/expense/{'d' * 64}.jpg?token=t"
    r = TestClient(app).post(f"/api/expenses/{target.id}/link-bilag", json={"receipt_photo": ok})
    assert r.status_code == 200, r.text


def test_create_paths_refuse_a_typed_ireland_link(env, backend):
    db, _ = env
    u = _owner(db)
    irl = _irl(_key(u.id, n="f"))
    app.dependency_overrides[get_current_user] = lambda: u
    c = TestClient(app)
    exp = {"date": "2026-10-22", "amount": 5, "description": "typed", "payment_method": "card"}
    for path in ("/api/expenses", "/api/expenses/from-receipt"):
        r = c.post(path, json={**exp, "receipt_photo": irl})
        assert r.status_code == 422, (path, r.text)
    r = c.post("/api/sales/from-receipt", params={"amount": 10, "receipt_path": irl})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "retired_receipt_link"
    assert db.query(Expense).filter(Expense.user_id == u.id).count() == 0
    assert db.query(Sale).filter(Sale.user_id == u.id).count() == 0
    # Frankfurt links and other hosts are stored as before
    fra = f"{FRA_HOST}/storage/v1/object/sign/receipts/{_key(u.id, n='g')}?token=t"
    assert c.post("/api/expenses", json={**exp, "receipt_photo": fra}).status_code == 201
    r = c.post("/api/sales/from-receipt", params={"amount": 10, "receipt_path": fra})
    assert r.status_code == 201, r.text
    assert backend.sign_calls == []


def test_daily_close_refuses_a_new_ireland_link_but_keeps_the_echo(env, monkeypatch):
    """Probe P1b: unlock a pre-move close and re-save it with a typed Ireland
    link — it used to be stored (and signed on every read). A new close with
    one, and a re-save naming ANOTHER Ireland file, are refused (422, nothing
    saved). The page sending back the stored string itself still saves."""
    db, _ = env
    b = FakeBackend(sign="none")
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    u = _owner(db)
    c = TestClient(app)
    # a new close
    r = c.post("/api/daily-close", json=_close_payload(_irl(_key(u.id, "kasserapport", "e"))),
               headers=_hdr(u))
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "retired_receipt_link" and r.json()["detail"]["message_da"]
    assert db.query(DailyClose).filter(DailyClose.user_id == u.id).count() == 0
    # a pre-move close, locked, unlocked, re-saved with a typed link
    dc = DailyClose(user_id=u.id, date=date(2026, 5, 23), revenue_total=100, payment_total=100,
                    status="confirmed", created_at=OLD)
    db.add(dc); db.commit()
    r = c.post(f"/api/daily-close/{dc.id}/unlock", json={"reason": "typo"}, headers=_hdr(u))
    assert r.status_code == 200, r.text
    db.expire_all()
    base = db.get(DailyClose, dc.id).updated_at
    typed = _irl(_key(u.id, "kasserapport", "f"))
    r = c.post("/api/daily-close", json=_close_payload(typed, base=base.isoformat()), headers=_hdr(u))
    assert r.status_code == 422, r.text
    db.expire_all()
    row = db.get(DailyClose, dc.id)
    assert row.receipt_photo is None and row.status == "draft" and row.updated_at == base
    # a legacy draft's own Ireland link sent back as is (the read could not
    # re-link it): saved, the stored string kept
    legacy = _irl(_key(u.id, "kasserapport", "g"))
    row.receipt_photo = legacy
    db.commit()
    db.expire_all()
    base = db.get(DailyClose, dc.id).updated_at
    r = c.post("/api/daily-close", json=_close_payload(legacy, base=base.isoformat()), headers=_hdr(u))
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.get(DailyClose, dc.id).receipt_photo == legacy
    # …but not another Ireland file in its place
    base = db.get(DailyClose, dc.id).updated_at
    r = c.post("/api/daily-close", json=_close_payload(typed, base=base.isoformat()), headers=_hdr(u))
    assert r.status_code == 422, r.text
    db.expire_all()
    assert db.get(DailyClose, dc.id).receipt_photo == legacy
    assert b.sign_calls == []


def test_one_owner_cannot_spend_the_signing_budget_of_another(env, monkeypatch):
    """Probe P2: one tenant's 40 pre-move rows on made-up keys spent the
    whole process-wide minute, and another owner's real legacy photo was
    handed out as its Ireland link. A tenant now gets at most
    SIGN_BUDGET_PER_OWNER_PER_MIN signings a minute; the other owner's photo
    is re-linked in the same minute."""
    db, _ = env
    clock = [10_000.0]
    monkeypatch.setattr(sl, "_now", lambda: clock[0])
    victim = _owner(db)
    vk = _key(victim.id, "expense", n="9")
    db.add(Expense(user_id=victim.id, category_id=_cat(db, victim).id, date=date(2026, 5, 7), amount=50,
                   description="legacy", payment_method="card", receipt_photo=_irl(vk), created_at=OLD))
    db.commit()

    class Mixed(FakeBackend):
        def signed_url(self, key, ttl_seconds=3600, timeout=None):
            self.sign_calls.append((key, ttl_seconds, timeout))
            if key in self.objects:
                return f"{FRA_HOST}/storage/v1/object/sign/receipts/{key}?token=t{len(self.sign_calls)}"
            return None                                    # a made-up file
    b = Mixed({vk: b"x"})
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    attacker = _owner(db)
    _bulk_expenses(db, attacker, [_irl(f"{attacker.id}/expense/{format(i, '064x')}.jpg") for i in range(40)], OLD)
    c = TestClient(app)
    app.dependency_overrides[get_current_user] = lambda: attacker
    for _ in range(3):
        assert c.get("/api/expenses").status_code == 200
    assert len(b.sign_calls) == sl.SIGN_BUDGET_PER_OWNER_PER_MIN == 10
    assert sl.relink_stats()["sign_budget_owner"] >= 30
    app.dependency_overrides[get_current_user] = lambda: victim
    got = {x["description"]: x["receipt_photo"] for x in c.get("/api/expenses").json()}["legacy"]
    assert got.startswith(f"{FRA_HOST}/storage/v1/object/sign/receipts/{vk}")
    assert len(b.sign_calls) == 11


def test_owner_budget_map_is_bounded(backend, monkeypatch):
    monkeypatch.setattr(sl, "OWNER_BUDGETS_MAX", 3)
    for _ in range(6):
        o = str(uuid.uuid4())
        assert _ref(_irl(_key(o)), o).startswith(FRA_HOST)
    assert len(sl._owner_buckets) == 3


def test_foreign_hosts_cannot_silence_a_later_warning(backend, caplog):
    """Probe P7: 100 typed foreign hosts filled the one log-once set, and a
    real sign_failed afterwards was counted but never logged. Host marks are
    capped on their own; a reason-only mark always logs once."""
    caplog.set_level(logging.WARNING)
    for i in range(150):
        _ref(f"https://h{i}.example.org/x.jpg", OWNER, source="expenses")
    assert caplog.text.count("reason=foreign_host") == sl._MAX_NOTED_HOSTS     # still capped
    caplog.clear()
    backend.sign_mode = "none"
    _ref(_irl(_key(OWNER)), OWNER, source="expenses")
    _ref(_irl(_key(OWNER, n="b")), OWNER, source="expenses")
    assert caplog.text.count("reason=sign_failed source=expenses") == 1
    assert sl.relink_stats()["sign_failed"] == 2


def test_real_backend_get_logs_no_key_or_body(monkeypatch, caplog):
    """Probe P6: a missing Z-bon file (400 'Object not found', its body echoes
    the path) and a transport error naming the URL — the WARNING lines from
    SupabaseStorageBackend.get carry neither the owner id nor the file name."""
    from app.routers.daily_close import _fetch_scan_bytes_best_effort
    caplog.set_level(logging.WARNING)
    k = _key(OWNER, "kasserapport", "d")
    b = storage_mod.SupabaseStorageBackend(FRA_HOST, "service-key", "receipts")
    b._client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(
        400, json={"statusCode": "404", "error": "not_found",
                   "message": f"Object not found: {r.url.path}"})))
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    assert _fetch_scan_bytes_best_effort(_irl(k), OWNER) == (None, None)
    assert "Supabase storage GET -> 400" in caplog.text

    def boom(request):
        raise httpx.ConnectError(f"cannot reach {request.url}")
    b._client = httpx.Client(transport=httpx.MockTransport(boom))
    assert b.get(k) is None
    assert "Supabase storage GET failed: ConnectError" in caplog.text
    for needle in (OWNER, "d" * 64, "/receipts/", "Object not found", "cannot reach"):
        assert needle not in caplog.text


def test_zbon_read_is_bounded_to_eight_seconds(monkeypatch):
    """The Z-bon attachment is read inside the close-confirm request, which
    holds a DB connection (15 per instance): the read waits 8 s at most, not
    the client's 30 s upload default."""
    from app.routers.daily_close import ZBON_READ_TIMEOUT_SECONDS, _fetch_scan_bytes_best_effort
    seen = []

    def handler(request):
        seen.append(request)
        assert request.url.host == f"{FRA}.supabase.co"
        return httpx.Response(200, content=b"\xff\xd8 z-bon")
    b = storage_mod.SupabaseStorageBackend(FRA_HOST, "service-key", "receipts")
    own = b._client.timeout                               # the backend's own: 30 s read, 10 s connect
    b._client = httpx.Client(transport=httpx.MockTransport(handler), timeout=own)
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    k = _key(OWNER, "kasserapport")
    assert _fetch_scan_bytes_best_effort(_irl(k), OWNER) == (b"\xff\xd8 z-bon", "z_report.jpg")
    assert ZBON_READ_TIMEOUT_SECONDS == 8.0
    assert len(seen) == 1 and seen[0].url.path == f"/storage/v1/object/receipts/{k}"
    assert {seen[0].extensions["timeout"][x] for x in ("connect", "read", "write", "pool")} == {8.0}
    # other reads keep the backend's own timeout
    seen.clear()
    assert b.get(k) == b"\xff\xd8 z-bon"
    assert seen[0].extensions["timeout"]["read"] == 30.0


@pytest.fixture(params=["Etc/GMT+12", "Etc/GMT-14"])
def local_tz_far_from_utc(request):
    """The process's local zone forced to UTC-12 / UTC+14 for one test (and
    put back after it), so a naive created_at read as LOCAL time — instead
    of UTC — fails in CI's TZ=UTC run too, in both directions."""
    if not hasattr(time, "tzset"):
        pytest.skip("time.tzset is POSIX-only")
    old = os.environ.get("TZ")
    os.environ["TZ"] = request.param
    time.tzset()
    try:
        assert time.timezone != 0, "the forced zone did not take"
        yield request.param
    finally:
        if old is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = old
        time.tzset()


def test_naive_created_at_is_utc_whatever_the_local_zone(backend, local_tz_far_from_utc):
    just_before = datetime(2026, 10, 19, 23, 59, 59)        # naive UTC, the last pre-move second
    at_cutover = datetime(2026, 10, 20, 0, 0)
    k = _key(OWNER)
    assert sl.client_receipt_ref(_irl(k), OWNER, created_at=just_before).startswith(FRA_HOST)
    assert sl.client_receipt_ref(_irl(_key(OWNER, n="b")), OWNER, created_at=at_cutover) == \
        _irl(_key(OWNER, n="b"))
    assert [c[0] for c in backend.sign_calls] == [k]
    assert sl.retired_link_key(_irl(k), OWNER, created_at=just_before) == (k, "ok")
    assert sl.retired_link_key(_irl(k), OWNER, created_at=at_cutover) == (None, "refused_after_cutover")


# ─── fix round 3 (23 Oct) ──────────────────────────────────────────────
# 1 a row written after the cutover that links to Ireland holds the flag false
# 3 the link-bilag 503 says "a few minutes": a failed signing backs off 5 min
# 4 a padded Ireland spelling is refused on every write path that refuses
#   one; exists() never logs the key on an error status or transport error

def test_not_safe_to_delete_while_a_row_written_after_the_cutover_links_to_ireland(env, monkeypatch):
    """Packet item 3: every legacy row resolves and is signed, but one row
    written after the move still links to Ireland (on the old code
    "Knyt til eksisterende udgift" moved a pre-move draft's Ireland link
    onto a newer expense). The read path never re-links it, so that photo
    breaks with the project: the flag stays false until the row is
    explained and fixed — then it turns true. The late row uses no check."""
    db, _ = env
    u = _owner(db)
    k = _key(u.id, "kasserapport")
    moved = _key(u.id, "expense", "7")
    db.add(DailyClose(user_id=u.id, date=date(2026, 5, 23), revenue_total=1, payment_total=1,
                      receipt_photo=_irl(k), created_at=OLD))
    late = Expense(user_id=u.id, category_id=_cat(db, u).id, date=date(2026, 10, 2), amount=80,
                   description="typed", payment_method="card", receipt_photo=_irl(moved),
                   created_at=NEW)
    db.add(late); db.commit()
    late_id = late.id
    b = FakeBackend({k: b"x", moved: b"x"})
    body = _admin_get(env, monkeypatch, b, u)
    t = body["totals"]
    assert (t["retired_host"], t["retired_after_cutover"], t["retired_signable"]) == (2, 1, 1)
    assert body["unresolvable"] == 0 and t["retired_signable"] == t["retired_host"] - t["retired_after_cutover"]
    assert body["safe_to_delete_retired_project"] is False
    assert b.exists_calls == [k] and [c[0] for c in b.sign_calls] == [k]
    # explained and fixed (the same file's Frankfurt link stored): true
    db.get(Expense, late_id).receipt_photo = f"{FRA_HOST}/storage/v1/object/sign/receipts/{moved}?token=t"
    db.commit()
    body = _admin_get(env, monkeypatch, FakeBackend({k: b"x"}), u)
    assert body["totals"]["retired_after_cutover"] == 0 and body["unresolvable"] == 0
    assert body["safe_to_delete_retired_project"] is True


def test_link_bilag_503_says_a_few_minutes_because_a_failed_signing_backs_off(env, monkeypatch):
    """The 503 said "prøv igen om et minut", but a failed signing is not
    tried again for SIGN_FAIL_BACKOFF_SECONDS (5 min): a retry a minute
    later got the same 503 without a signing call. The DA and EN texts now
    say a few minutes, and that is what happens: inside the backoff no call
    and 503 again; after it, signed and linked."""
    db, _ = env
    clock = [5000.0]
    monkeypatch.setattr(sl, "_now", lambda: clock[0])
    u = _owner(db)
    k = _key(u.id, "expense", "6")
    draft, typed = _draft_and_typed(db, u, _irl(k))
    draft_id, typed_id = draft.id, typed.id
    b = FakeBackend({k: b"x"}, sign="none")
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    app.dependency_overrides[get_current_user] = lambda: u
    c = TestClient(app)

    def link():
        return c.post(f"/api/expenses/{typed_id}/link-bilag", json={"draft_id": str(draft_id)})

    r = link()
    assert r.status_code == 503, r.text
    d = r.json()["detail"]
    assert d["message_da"] == ("Bilagsbilledet kunne ikke flyttes lige nu. Intet er ændret — "
                               "prøv igen om nogle minutter.")
    assert d["message"] == ("The receipt picture could not be moved right now. Nothing was "
                            "changed — try again in a few minutes.")
    assert len(b.sign_calls) == 1
    assert sl.SIGN_FAIL_BACKOFF_SECONDS >= 2 * 60          # why the text says minutes
    clock[0] += 60                                         # "om et minut": still backed off
    assert link().status_code == 503 and len(b.sign_calls) == 1
    b.sign_mode = "ok"
    clock[0] += sl.SIGN_FAIL_BACKOFF_SECONDS               # past the backoff: tried again
    r = link()
    assert r.status_code == 200, r.text
    assert len(b.sign_calls) == 2
    db.expire_all()
    assert db.get(Expense, typed_id).receipt_photo.startswith(FRA_HOST)


_PADS = {
    "spaces": ("   ", "  "),
    "tab_newline": ("\t", "\r\n"),
    # urlsplit drops leading ASCII blanks by itself, but not these: only the
    # .strip() before the host check refuses them
    "unicode_spaces": ("  ", "　 "),
}


def _write_padded(path, db, u, photo):
    """Send `photo` through one write path that refuses an Ireland link.
    Returns (response, check) — check() asserts nothing of it was stored."""
    c = TestClient(app)
    exp = {"date": "2026-10-22", "amount": 5, "description": "padded", "payment_method": "card"}
    if path in ("expenses", "expenses_from_receipt"):
        url = "/api/expenses" if path == "expenses" else "/api/expenses/from-receipt"
        r = c.post(url, json={**exp, "receipt_photo": photo})
        return r, lambda: db.query(Expense).filter(Expense.user_id == u.id).count() == 0
    if path == "sales_from_receipt":
        r = c.post("/api/sales/from-receipt", params={"amount": 10, "receipt_path": photo})
        return r, lambda: db.query(Sale).filter(Sale.user_id == u.id).count() == 0
    if path == "link_bilag":
        target = Expense(user_id=u.id, category_id=_cat(db, u).id, date=date(2026, 7, 1), amount=1,
                         description="old", payment_method="card", created_at=OLD)
        db.add(target); db.commit()
        tid = target.id
        r = c.post(f"/api/expenses/{tid}/link-bilag", json={"receipt_photo": photo})
        return r, lambda: (db.get(Expense, tid).receipt_photo is None
                           and _bilag_audits(db, u) == [])
    if path == "daily_close_new":
        r = c.post("/api/daily-close", json=_close_payload(photo), headers=_hdr(u))
        return r, lambda: db.query(DailyClose).filter(DailyClose.user_id == u.id).count() == 0
    if path == "daily_close_move":
        body = {"from_date": "2026-05-22", "to_date": "2026-05-23", "body": _close_payload(photo),
                "save_id": f"pad-{uuid.uuid4().hex[:8]}"}
        r = c.post("/api/daily-close/move", json=body, headers=_hdr(u))
        return r, lambda: db.query(DailyClose).filter(DailyClose.user_id == u.id).count() == 0
    if path == "daily_close_resave":
        # a pre-move draft that stores a legacy photo, re-saved naming ANOTHER Ireland file
        legacy = _irl(_key(u.id, "kasserapport", "c"))
        dc = DailyClose(user_id=u.id, date=date(2026, 5, 23), revenue_total=100, payment_total=100,
                        status="draft", receipt_photo=legacy, created_at=OLD)
        db.add(dc); db.commit()
        dc_id, base = dc.id, dc.updated_at
        r = c.post("/api/daily-close", json=_close_payload(photo, base=base.isoformat()), headers=_hdr(u))
        db.expire_all()
        return r, lambda: (db.get(DailyClose, dc_id).receipt_photo == legacy
                           and db.get(DailyClose, dc_id).updated_at == base)
    raise AssertionError(path)


@pytest.mark.parametrize("pad", list(_PADS), ids=list(_PADS))
@pytest.mark.parametrize("path", ["expenses", "expenses_from_receipt", "sales_from_receipt",
                                  "link_bilag", "daily_close_new", "daily_close_move",
                                  "daily_close_resave"])
def test_a_padded_ireland_link_is_refused_on_every_write_path(env, monkeypatch, path, pad):
    """The refusal reads the host of the value with its surrounding blanks
    removed, so a leading/trailing pad (spaces, tab/newline, or Unicode
    spaces urlsplit leaves in place) never gets an Ireland link past it:
    on every write path that refuses one, 422, nothing stored, no signing
    call. Stored on a pre-move row, the read path (which strips) would sign
    it on every read."""
    db, _ = env
    b = FakeBackend(sign="none")
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u
    lead, trail = _PADS[pad]
    kind = {"sales_from_receipt": "sale", "daily_close_new": "kasserapport",
            "daily_close_move": "kasserapport", "daily_close_resave": "kasserapport"}.get(path, "expense")
    photo = f"{lead}{_irl(_key(u.id, kind, 'e'))}{trail}"
    r, nothing_stored = _write_padded(path, db, u, photo)
    assert r.status_code == 422, (path, pad, r.status_code, r.text)
    detail = r.json()["detail"]
    if isinstance(detail, dict):
        assert detail["code"] == "retired_receipt_link" and detail["message_da"]
    else:                                   # ExpenseCreate's validator: pydantic's list
        assert any("retired storage project" in str(e.get("msg", "")) for e in detail), detail
    db.expire_all()
    assert nothing_stored(), (path, pad)
    assert b.sign_calls == []


@pytest.mark.parametrize("pad", list(_PADS), ids=list(_PADS))
def test_the_daily_close_padded_echo_still_saves_and_keeps_the_stored_string(env, monkeypatch, pad):
    """The one Ireland link a write may carry is the page's own echo of what
    the close stores. Padded, it is still that echo: saved, and the stored
    string stays byte-identical (the pad is not stored)."""
    db, _ = env
    b = FakeBackend(sign="none")
    monkeypatch.setattr(storage_mod, "get_storage", lambda: b)
    u = _owner(db)
    legacy = _irl(_key(u.id, "kasserapport", "c"))
    dc = DailyClose(user_id=u.id, date=date(2026, 5, 23), revenue_total=100, payment_total=100,
                    status="draft", receipt_photo=legacy, created_at=OLD)
    db.add(dc); db.commit()
    dc_id, base = dc.id, dc.updated_at
    lead, trail = _PADS[pad]
    r = TestClient(app).post("/api/daily-close", json=_close_payload(f"{lead}{legacy}{trail}",
                                                                     base=base.isoformat()),
                             headers=_hdr(u))
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.get(DailyClose, dc_id).receipt_photo == legacy


def _exists_needles(k):
    return (OWNER, k.rsplit("/", 1)[1], "/receipts/", "Object not found", "cannot reach",
            "timed out reading", "/object/list/")


@pytest.mark.parametrize("status", [400, 401, 403, 404, 409, 429, 500, 502, 503])
def test_real_backend_exists_logs_no_key_on_an_error_status(monkeypatch, caplog, status):
    """exists() (the delete check's lookup) on a 4xx/5xx whose body echoes
    the folder and file name: None ("could not check"), and its log line
    carries the status only — at any level the storage module logs, not
    just WARNING. (httpx's own INFO request line is a separate, known
    limit: the web process does not write INFO.)"""
    caplog.set_level(logging.WARNING)
    caplog.set_level(logging.DEBUG, logger="app.services.storage")
    k = _key(OWNER, "kasserapport", "d")
    b = storage_mod.SupabaseStorageBackend(FRA_HOST, "service-key", "receipts")
    b._client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(
        status, json={"statusCode": str(status), "error": "x",
                      "message": f"Object not found: {r.url.path} {json.loads(r.content)}"})))
    assert b.exists(k) is None
    assert f"Supabase exists check -> {status}" in caplog.text
    for needle in _exists_needles(k):
        assert needle not in caplog.text, needle


@pytest.mark.parametrize("exc", [httpx.ConnectError, httpx.ReadTimeout, httpx.RemoteProtocolError])
def test_real_backend_exists_logs_no_key_on_a_transport_error(monkeypatch, caplog, exc):
    caplog.set_level(logging.WARNING)
    caplog.set_level(logging.DEBUG, logger="app.services.storage")
    k = _key(OWNER, "kasserapport", "d")

    def boom(request):
        raise exc(f"cannot reach {request.url} — timed out reading {json.loads(request.content)}",
                  request=request)
    b = storage_mod.SupabaseStorageBackend(FRA_HOST, "service-key", "receipts")
    b._client = httpx.Client(transport=httpx.MockTransport(boom))
    assert b.exists(k) is None
    assert f"Supabase exists check failed: {exc.__name__}" in caplog.text
    for needle in _exists_needles(k):
        assert needle not in caplog.text, needle
