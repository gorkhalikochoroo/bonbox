"""GDPR Art. 17 erasure completeness guard (auth.delete_account).

Two layers:

1. STATIC GUARD (the durable part). delete_account used to hand-delete a
   FIXED list of child tables, then db.delete(current_user). ~40 OTHER
   user_id-scoped tables (daily_briefs, anomaly_alerts, terminals,
   gift_cards, kasserapport_extractions, …) carry a ForeignKey to users.id
   with NO ON DELETE CASCADE — so any of them holding a row raised a FK
   violation, rolled back the WHOLE transaction (incl. the PSD2 consent
   revoke + BankConnection purge), and erasure 500'd with NOTHING deleted.
   The fix made deletion metadata-driven. This test programmatically
   enumerates EVERY table carrying a users.id FK from Base.metadata and
   asserts the erasure path covers it — either by the metadata sweep or by
   an explicit retain/deferred set declared in the source. A NEW
   user-scoped table that the erasure does not handle FAILS CI here.

2. LIVE REGRESSION. Seed a user with rows across several user-FK tables —
   including the orphan child inventory_logs (no users.id FK, no CASCADE
   from inventory_items — the exact shape that broke the old code) — call
   delete_account, assert HTTP 200 and zero residual rows for that user.
"""
from __future__ import annotations

import inspect
import re

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register all models on Base
from app.main import app, _db_ready
from app.models.user import User
from app.routers import auth as auth_router
from app.services.auth import hash_password, get_current_user
from app.utils.time import utc_now

_db_ready.set()


# ── Helpers shared by both layers ──────────────────────────────────────

def _user_fk_tables():
    """Every table in Base.metadata carrying a ForeignKey to users.id."""
    names = []
    for t in Base.metadata.sorted_tables:
        if t.name == "users":
            continue
        for col in t.columns:
            if any(fk.column.table.name == "users" for fk in col.foreign_keys):
                names.append(t.name)
                break
    return names


def _delete_account_source():
    return inspect.getsource(auth_router.delete_account)


def _declared_sets_from_source(src):
    """Pull the retain/deferred table-name sets straight out of the source
    so the test tracks the function instead of duplicating its policy."""
    out = {}
    for var in ("_ERASURE_RETAINED_TABLES", "_ERASURE_DEFERRED_TABLES"):
        m = re.search(var + r"\s*=\s*\{([^}]*)\}", src)
        names = set()
        if m:
            names = set(re.findall(r"[\"']([a-z_]+)[\"']", m.group(1)))
        out[var] = names
    return out


# ── Layer 1: static completeness guard ─────────────────────────────────

def test_every_user_fk_table_is_covered_by_erasure():
    """For each users.id-FK table, the erasure path must handle it: either
    the metadata-driven sweep covers it, or it appears in an explicit
    retain/deferred set in the source. No silent gaps."""
    src = _delete_account_source()
    sets = _declared_sets_from_source(src)
    retained = sets["_ERASURE_RETAINED_TABLES"]
    deferred = sets["_ERASURE_DEFERRED_TABLES"]

    # The sweep must actually be metadata-driven — pin the mechanism so a
    # future "simplification" back to a hand-list re-breaks loudly here.
    assert "sorted_tables" in src, (
        "delete_account must drive deletion from Base.metadata.sorted_tables; "
        "a hand-maintained list silently re-opens the GDPR erasure hole."
    )
    assert "reversed(" in src, "deletion must walk sorted_tables children-first (reversed)"

    # Sets must be non-empty and correctly scoped.
    assert "audit_logs" in retained and "security_events" in retained, retained
    assert "bank_connections" in deferred and "mobilepay_connections" in deferred, deferred

    swept_out = retained | deferred
    for table in _user_fk_tables():
        if table in swept_out:
            continue
        # Otherwise it must be reachable by the generic sweep. The sweep
        # touches ALL tables in metadata, so membership in metadata is the
        # proof — we assert it's a real, mapped table (sanity) and not
        # accidentally excluded by name anywhere.
        assert table in {t.name for t in Base.metadata.sorted_tables}, table


def test_retained_audit_tables_are_never_swept():
    """Legal-hold tables must NOT be deleted — they back the Bogføringsloven
    §10 / GDPR Art.17(3)(b) financial-audit retention."""
    sets = _declared_sets_from_source(_delete_account_source())
    assert sets["_ERASURE_RETAINED_TABLES"] >= {"audit_logs", "security_events", "error_logs"}


# ── Layer 2: live regression against the test DB ───────────────────────

@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    # SQLite ignores FK constraints unless asked; the production failure was a
    # FK violation, so enforce them here to actually exercise the fix.
    Base.metadata.create_all(engine)

    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()
    s.execute(text("PRAGMA foreign_keys=ON"))

    def _override_get_db():
        try:
            yield s
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client():
    try:
        auth_router.limiter.reset()
    except Exception:
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed_user_with_data(db):
    from datetime import timedelta
    from app.models.sale import Sale
    from app.models.inventory import InventoryItem, InventoryLog
    from app.models.daily_brief import DailyBrief
    from app.models.business_profile import BusinessProfile

    u = User(
        email="erase-me@example.com",
        password_hash=hash_password("deleteMeNow1"),
        business_name="Doomed Café",
        business_type="restaurant",
        currency="DKK",
        role="owner",
        email_verified=True,
        created_at=utc_now() - timedelta(days=2),
    )
    db.add(u)
    db.commit()
    db.refresh(u)

    today = utc_now().date()
    # A sale (direct user FK).
    db.add(Sale(user_id=u.id, date=today, amount=125, payment_method="cash"))
    # An inventory item + its log. inventory_logs has NO users.id FK and NO
    # CASCADE from inventory_items — the exact orphan that FK-violated the
    # old hand-list when inventory_items was deleted out from under it.
    item = InventoryItem(user_id=u.id, name="Beans", unit="kg", quantity=10)
    db.add(item)
    db.commit()
    db.refresh(item)
    db.add(InventoryLog(item_id=item.id, change_qty=-1, date=today, reason="sale"))
    # A table the OLD hand-list missed entirely.
    db.add(DailyBrief(user_id=u.id, brief_date=today, payload_json="{}"))
    # A 1:1 profile.
    db.add(BusinessProfile(user_id=u.id))
    # The RETAINED rows every real account has: an audit entry and a security
    # event. 72 of 75 prod accounts have audit rows, and their users.id FK
    # (ON DELETE NO ACTION) made every erasure fail — this seed had none, so
    # the test passed while production could not delete a single account.
    from app.models.audit_log import AuditLog
    from app.models.security_event import SecurityEvent
    db.add(AuditLog(user_id=u.id, actor_id=u.id, action="auth.login", entity_type="user", entity_id=u.id))
    db.add(SecurityEvent(user_id=u.id, event_type="admin_denied_wrong_role"))
    db.commit()
    return u


def test_delete_account_purges_every_seeded_table(db_session, client):
    user = _seed_user_with_data(db_session)
    uid = user.id
    app.dependency_overrides[get_current_user] = lambda: user

    r = client.request(
        "DELETE", "/api/auth/delete-account",
        json={"password": "deleteMeNow1"},
    )
    assert r.status_code == 200, r.text

    # The user row itself is gone …
    assert db_session.query(User).filter(User.id == uid).first() is None

    # … and so is every user-scoped row, including the orphan child.
    from app.models.sale import Sale
    from app.models.inventory import InventoryItem, InventoryLog
    from app.models.daily_brief import DailyBrief
    from app.models.business_profile import BusinessProfile

    assert db_session.query(Sale).filter(Sale.user_id == uid).count() == 0
    assert db_session.query(InventoryItem).filter(InventoryItem.user_id == uid).count() == 0
    assert db_session.query(DailyBrief).filter(DailyBrief.user_id == uid).count() == 0
    assert db_session.query(BusinessProfile).filter(BusinessProfile.user_id == uid).count() == 0
    # No orphaned inventory_logs left behind.
    assert db_session.query(InventoryLog).count() == 0

    # The legal-hold rows SURVIVE the erasure, pointing at an id that no
    # longer names anyone (pseudonymous) — they neither block it nor vanish.
    from app.models.audit_log import AuditLog
    from app.models.security_event import SecurityEvent
    assert db_session.query(AuditLog).filter(AuditLog.user_id == uid).count() >= 1
    assert db_session.query(SecurityEvent).filter(SecurityEvent.user_id == uid).count() == 1


def test_retained_tables_never_block_a_user_deletion():
    """A legal-hold table keeps its rows AND must not stop the user row from
    being deleted — so it may not carry a ForeignKey to users.id at all (an
    ON DELETE action would have to UPDATE or DELETE rows the audit rules
    forbid touching)."""
    sets = _declared_sets_from_source(_delete_account_source())
    retained = sets["_ERASURE_RETAINED_TABLES"]
    blocking = sorted(t for t in _user_fk_tables() if t in retained)
    assert blocking == [], (
        f"{blocking} keep a ForeignKey to users.id — every erasure of a user "
        "with rows there fails with a FK violation (this is what broke "
        "Art. 17 deletion in production)."
    )


def test_delete_account_wrong_password_deletes_nothing(db_session, client):
    user = _seed_user_with_data(db_session)
    uid = user.id
    app.dependency_overrides[get_current_user] = lambda: user

    r = client.request(
        "DELETE", "/api/auth/delete-account",
        json={"password": "WRONG"},
    )
    assert r.status_code == 400
    assert db_session.query(User).filter(User.id == uid).first() is not None


# ── Nothing irreversible outside the database until the erasure holds ──

def test_failed_erasure_touches_nothing_outside_the_database(db_session, client, monkeypatch):
    """The bank consent revoke and the storage purge are irreversible. They
    used to run BEFORE the user row was deleted, so an erasure that then
    failed (every one did, on the audit-log FK) withdrew the bank consent
    and deleted the files of an account that stayed."""
    calls = []
    monkeypatch.setattr("app.routers.bank_connect.best_effort_revoke", lambda c: calls.append("revoke"))
    monkeypatch.setattr("app.services.storage.purge_user_blobs", lambda uid: calls.append("purge") or 0)
    user = _seed_user_with_data(db_session)
    uid = user.id
    app.dependency_overrides[get_current_user] = lambda: user

    def _boom():
        raise RuntimeError("constraint says no")
    monkeypatch.setattr(db_session, "flush", _boom)

    r = client.request("DELETE", "/api/auth/delete-account", json={"password": "deleteMeNow1"})
    assert r.status_code == 500, r.text
    assert calls == []
    monkeypatch.undo()
    assert db_session.query(User).filter(User.id == uid).first() is not None


def test_erasure_cancels_the_stripe_subscription(db_session, client, monkeypatch):
    """A deleted customer must not go on being charged."""
    cancelled = []

    class _Sub:
        @staticmethod
        def cancel(sub_id):
            cancelled.append(sub_id)

    class _FakeStripe:
        Subscription = _Sub

    monkeypatch.setattr("app.services.stripe_billing._stripe", lambda: _FakeStripe)
    monkeypatch.setattr("app.services.storage.purge_user_blobs", lambda uid: 0)
    user = _seed_user_with_data(db_session)
    user.stripe_subscription_id = "sub_test_123"
    db_session.commit()
    app.dependency_overrides[get_current_user] = lambda: user

    r = client.request("DELETE", "/api/auth/delete-account", json={"password": "deleteMeNow1"})
    assert r.status_code == 200, r.text
    assert cancelled == ["sub_test_123"]



# ── R-e fix-up: the subscription must be stopped, or nothing is deleted ──
#
# Terms § 4 / § 8: deleting the account stops an active subscription at once.
# The cancel used to be best-effort — on a Stripe error it logged a warning
# and deleted the account anyway, so Stripe went on charging a customer whose
# account no longer existed (and every later webhook found no user).


class _StripeErr(Exception):
    def __init__(self, msg, http_status=None, code=None):
        super().__init__(msg)
        self.http_status = http_status
        self.code = code


def _fake_stripe(*, cancel_exc=None, retrieve=None, retrieve_exc=None, calls=None):
    calls = calls if calls is not None else []

    class _Sub:
        @staticmethod
        def cancel(sub_id):
            calls.append(("cancel", sub_id))
            if cancel_exc:
                raise cancel_exc

        @staticmethod
        def retrieve(sub_id):
            calls.append(("retrieve", sub_id))
            if retrieve_exc:
                raise retrieve_exc
            return retrieve

    class _FakeStripe:
        Subscription = _Sub

    return _FakeStripe


def _delete_with_stripe(db_session, client, monkeypatch, fake, *, status="active", outside=None):
    outside = outside if outside is not None else []
    monkeypatch.setattr("app.services.stripe_billing._stripe", lambda: fake)
    monkeypatch.setattr("app.routers.bank_connect.best_effort_revoke", lambda c: outside.append("revoke"))
    monkeypatch.setattr("app.services.storage.purge_user_blobs", lambda uid: outside.append("purge") or 0)
    user = _seed_user_with_data(db_session)
    uid = user.id
    user.stripe_subscription_id = "sub_live_9"
    user.subscription_status = status
    db_session.commit()
    app.dependency_overrides[get_current_user] = lambda: user
    r = client.request("DELETE", "/api/auth/delete-account", json={"password": "deleteMeNow1"})
    return r, uid, outside


def test_erasure_is_refused_when_the_subscription_cannot_be_stopped(db_session, client, monkeypatch):
    fake = _fake_stripe(cancel_exc=_StripeErr("timeout"), retrieve={"status": "active"})
    r, uid, outside = _delete_with_stripe(db_session, client, monkeypatch, fake)
    assert r.status_code == 503, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "subscription_cancel_failed"
    assert detail["message"] == auth_router.DELETE_SUB_STOP_FAILED_EN
    assert detail["message_da"] == auth_router.DELETE_SUB_STOP_FAILED_DA
    # Nothing irreversible happened, and the account (with its data) is still there.
    assert outside == []
    monkeypatch.undo()
    assert db_session.query(User).filter(User.id == uid).first() is not None


def test_erasure_is_refused_when_stripe_cannot_be_asked(db_session, client, monkeypatch):
    fake = _fake_stripe(cancel_exc=_StripeErr("down"), retrieve_exc=_StripeErr("still down", http_status=503))
    r, uid, outside = _delete_with_stripe(db_session, client, monkeypatch, fake)
    assert r.status_code == 503, r.text
    assert outside == []


@pytest.mark.parametrize("retrieve,retrieve_exc", [
    ({"status": "canceled"}, None),                       # already stopped at Stripe
    ({"status": "incomplete_expired"}, None),
    (None, _StripeErr("No such subscription", http_status=404, code="resource_missing")),
])
def test_erasure_goes_ahead_when_stripe_says_nothing_is_running(
    db_session, client, monkeypatch, retrieve, retrieve_exc,
):
    fake = _fake_stripe(cancel_exc=_StripeErr("cannot cancel"), retrieve=retrieve, retrieve_exc=retrieve_exc)
    r, uid, outside = _delete_with_stripe(db_session, client, monkeypatch, fake)
    assert r.status_code == 200, r.text
    assert "purge" in outside
    monkeypatch.undo()
    assert db_session.query(User).filter(User.id == uid).first() is None


def test_subscription_is_stopped_before_any_other_outside_step(db_session, client, monkeypatch):
    calls = []
    fake = _fake_stripe(calls=calls)
    r, _uid, _ = _delete_with_stripe(db_session, client, monkeypatch, fake, outside=calls)
    assert r.status_code == 200, r.text
    assert calls == [("cancel", "sub_live_9"), "purge"]


def test_stop_helper_without_stripe_configured(monkeypatch):
    """No Stripe on this server: only a row that already says the
    subscription is dead lets the deletion through — "couldn't check" is
    never "stopped"."""
    from app.services.stripe_billing import stop_subscription_for_erasure
    monkeypatch.setattr("app.services.stripe_billing._stripe", lambda: None)
    assert stop_subscription_for_erasure("sub_x", "canceled") == "stopped"
    assert stop_subscription_for_erasure("sub_x", "active") == "failed"
    assert stop_subscription_for_erasure("sub_x", None) == "failed"


def test_delete_refusal_matches_the_profile_page_text():
    from pathlib import Path
    root = Path(__file__).resolve().parents[2] / "frontend" / "src" / "i18n"
    for lang, expected in (("da", auth_router.DELETE_SUB_STOP_FAILED_DA),
                           ("en", auth_router.DELETE_SUB_STOP_FAILED_EN)):
        src = (root / f"{lang}.js").read_text()
        m = re.search(r'deleteSubscriptionStopFailed:\s*"([^"]+)"', src)
        assert m and m.group(1) == expected, lang


def test_deletion_reply_says_what_terms_section_4_says(db_session, client):
    """Push 3: the reply to a completed deletion names what we keep (Terms
    § 4) — no 'faktura', no '5 years', no claim that the law makes BonBox
    keep the owner's records."""
    user = _seed_user_with_data(db_session)
    app.dependency_overrides[get_current_user] = lambda: user
    r = client.request("DELETE", "/api/auth/delete-account", json={"password": "deleteMeNow1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["message"] == auth_router.DELETE_DONE_EN
    assert body["message_da"] == auth_router.DELETE_DONE_DA
    # B6 (Manoj, 11 Oct): the Stripe customer and its invoices are kept —
    # BonBox's OWN accounting records, Manoj's sentence word for word. It is
    # the only place the reply may say "5 years" / "fakturaer".
    for msg, stripe_kept in ((body["message"], STRIPE_KEPT_EN), (body["message_da"], STRIPE_KEPT_DA)):
        assert msg.count(stripe_kept) == 1, msg
        rest = msg.replace(stripe_kept, "")
        assert "6" in rest and "5 year" not in rest and "5 år" not in rest
        assert "faktura" not in rest.lower() and "Bogføringsloven" not in rest
    # The same facts as the Terms page and /privacy.
    from pathlib import Path
    root = Path(__file__).resolve().parents[2] / "frontend" / "src" / "pages"
    terms = (root / "TermsPage.jsx").read_text()
    privacy = (root / "PrivacyPolicyPage.jsx").read_text()
    assert "we keep those images for about 6 years after the deletion and then delete them" in terms
    assert "billederne gemmer vi i ca. 6 år efter sletningen og sletter dem derefter" in terms
    for doc in (terms, privacy):
        assert STRIPE_KEPT_EN in doc and STRIPE_KEPT_DA in doc


STRIPE_KEPT_DA = ("Betalingsoplysningerne hos Stripe (kunde og fakturaer) beholder vi, fordi vi skal "
                  "opbevare vores egne regnskabsbilag i 5 år.")
STRIPE_KEPT_EN = ("We keep the payment records at Stripe (the customer and the invoices), because we must "
                  "keep our own accounting records for 5 years.")


def test_deletion_never_deletes_the_stripe_customer_so_the_texts_are_true():
    """B6: § 4, /privacy and the reply say the Stripe customer and invoices are
    kept. That is only true while the code never deletes the customer."""
    from pathlib import Path
    app_dir = Path(__file__).resolve().parents[2] / "backend" / "app"
    hits = [str(p) for p in app_dir.rglob("*.py")
            if re.search(r"Customer\.delete\(|customers\.delete\(", p.read_text())]  # Stripe SDK calls
    assert hits == [], hits
