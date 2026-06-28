"""Gavekort ONLINE ORDERS — "order online, owner collects" contract.

The red-line-safe purchase flow: a customer REQUESTS a gavekort on a public
/g/buy/<slug> page; the owner confirms payment out-of-band and ISSUES the
real card. BonBox never takes custody of money — the order row is a request
log, the GiftCard is only minted on owner-issue.

Covers:
  (a) owner PUT /order-settings enables online orders + allocates a slug;
      amount min/max persist; max<min → 422.
  (b) public GET /buy/<slug> returns venue + bounds (no card/code leak);
      unknown / disabled slug → 410 (never reveal which slugs exist).
  (c) public POST /buy/<slug> logs a PENDING order — NO card, NO code in the
      response; amount out of range → 422; bad email → 422.
  (d) owner GET /orders is tenant-scoped (never sees another owner's orders).
  (e) owner POST /orders/<id>/issue mints a real card via the SHARED issue
      path (ledger anchor + qr_token), links it, flips status → issued;
      double-issue → 409; cross-tenant → 404.
  (f) owner POST /orders/<id>/decline → declined; re-decline → 409.

App-level in-memory SQLite, mirroring tests/test_gavekort.py.

Run:
  cd backend && python3 -m pytest tests/test_gavekort_orders.py -q
"""
from __future__ import annotations

import uuid
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.gift_card import GiftCard, GiftCardTransaction
from app.models.gift_card_order import GiftCardOrder
from app.models.user import User
from app.routers.gavekort import limiter as _gk_limiter
from app.routers.public_gavekort import limiter as _pub_limiter
from app.services.auth import get_current_user

_db_ready.set()

# All TestClient requests share one "testclient" IP, so the public /buy 10/min
# and owner-issue 30/min per-IP caps would bleed across tests and 429 later
# ones. Rate-limiting isn't what this suite verifies — disable both module
# limiters so dedup / validation / atomic-claim assertions run cleanly.
_gk_limiter.enabled = False
_pub_limiter.enabled = False


# ─── Fixtures (mirror test_gavekort.py) ──────────────────────────────
@pytest.fixture
def engine_and_session():
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(eng)
    return eng, sessionmaker(bind=eng)


@pytest.fixture
def db(engine_and_session) -> Iterator:
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

    # Reset the per-IP rate-limiter between tests — all TestClient requests
    # share one "testclient" IP, so the public /buy 10/min cap would otherwise
    # bleed across tests and 429 later ones.
    try:
        app.state.limiter.reset()
    except Exception:
        pass

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


def _clear_user_override():
    app.dependency_overrides.pop(get_current_user, None)


def _owner(db, *, name="Café Hygge") -> User:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name=name,
        business_type="cafe", currency="DKK", plan="starter",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    db.add(BusinessProfile(user_id=u.id))
    db.commit()
    return u


def _enable_orders(client, *, min_minor=5000, max_minor=500000) -> dict:
    r = client.put("/api/gavekort/order-settings", json={
        "enabled": True,
        "min_amount_minor": min_minor,
        "max_amount_minor": max_minor,
        "instructions": "MobilePay 12 34 56 78",
    })
    assert r.status_code == 200, r.text
    return r.json()


# ═════════════════════════════════════════════════════════════════════
# (a) owner settings — enable + slug allocation + bounds
# ═════════════════════════════════════════════════════════════════════
def test_enable_allocates_slug_and_persists_bounds(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        out = _enable_orders(client, min_minor=10000, max_minor=200000)
        assert out["enabled"] is True
        assert out["slug"]                       # allocated on first enable
        assert out["public_url"].endswith(f"/g/buy/{out['slug']}")
        assert out["min_amount_minor"] == 10000
        assert out["max_amount_minor"] == 200000

        # max < min is rejected, not silently swapped.
        bad = client.put("/api/gavekort/order-settings", json={
            "enabled": True, "min_amount_minor": 50000, "max_amount_minor": 1000})
        assert bad.status_code == 422
    finally:
        _clear_user_override()


# ═════════════════════════════════════════════════════════════════════
# (b) public buy page — venue + bounds, 410 when closed/unknown
# ═════════════════════════════════════════════════════════════════════
def test_public_buy_page_and_closed_410(client, db):
    owner = _owner(db, name="Bageriet")
    _override_user(owner)
    try:
        slug = _enable_orders(client)["slug"]
    finally:
        _clear_user_override()

    # Public — no auth needed.
    r = client.get(f"/api/public/gavekort/buy/{slug}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["business_name"] == "Bageriet"
    assert body["min_amount_minor"] == 5000 and body["max_amount_minor"] == 500000
    # No card/code/balance fields leak onto the buy page.
    assert "code_last4" not in body and "balance_minor" not in body

    # Unknown slug → 410 (closed-not-found shape, never reveals existence).
    assert client.get("/api/public/gavekort/buy/does-not-exist").status_code == 410


# ═════════════════════════════════════════════════════════════════════
# (c) public create order — pending, no card/code revealed; bounds + email
# ═════════════════════════════════════════════════════════════════════
def test_public_create_order_is_pending_no_card(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        slug = _enable_orders(client, min_minor=5000, max_minor=100000)["slug"]
    finally:
        _clear_user_override()

    r = client.post(f"/api/public/gavekort/buy/{slug}", json={
        "amount_minor": 30000,
        "buyer_name": "Anders",
        "buyer_email": "anders@example.com",
        "recipient_name": "Mor",
        "message": "Tillykke!",
    })
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["ok"] is True
    # The buyer gets NO card, NO code, NO balance — just a wait-for-owner ack.
    assert "qr_token" not in out and "code_last4" not in out and "id" not in out

    # A pending order row exists; NO card minted yet.
    order = db.query(GiftCardOrder).filter(GiftCardOrder.user_id == owner.id).first()
    assert order is not None and order.status == "pending"
    assert order.gift_card_id is None
    assert db.query(GiftCard).filter(GiftCard.user_id == owner.id).count() == 0

    # Out-of-range amount and bad email are rejected.
    assert client.post(f"/api/public/gavekort/buy/{slug}", json={
        "amount_minor": 1, "buyer_email": "x@y.com"}).status_code == 422
    assert client.post(f"/api/public/gavekort/buy/{slug}", json={
        "amount_minor": 30000, "buyer_email": "not-an-email"}).status_code == 422


# ═════════════════════════════════════════════════════════════════════
# (d) owner orders list is tenant-scoped
# ═════════════════════════════════════════════════════════════════════
def test_orders_list_is_tenant_scoped(client, db):
    a = _owner(db, name="A")
    b = _owner(db, name="B")
    _override_user(a)
    try:
        slug_a = _enable_orders(client)["slug"]
    finally:
        _clear_user_override()
    # A customer orders from A.
    client.post(f"/api/public/gavekort/buy/{slug_a}", json={
        "amount_minor": 20000, "buyer_email": "c@example.com"})

    # B must never see A's order.
    _override_user(b)
    try:
        rb = client.get("/api/gavekort/orders")
        assert rb.status_code == 200
        assert rb.json()["orders"] == [] and rb.json()["pending_count"] == 0
    finally:
        _clear_user_override()

    _override_user(a)
    try:
        ra = client.get("/api/gavekort/orders")
        assert ra.json()["pending_count"] == 1
        assert len(ra.json()["orders"]) == 1
    finally:
        _clear_user_override()


# ═════════════════════════════════════════════════════════════════════
# (e) owner issue mints + links; double-issue 409; cross-tenant 404
# ═════════════════════════════════════════════════════════════════════
def test_owner_issue_mints_and_links(client, db):
    owner = _owner(db)
    other = _owner(db, name="Other")
    _override_user(owner)
    try:
        slug = _enable_orders(client)["slug"]
    finally:
        _clear_user_override()
    client.post(f"/api/public/gavekort/buy/{slug}", json={
        "amount_minor": 40000, "buyer_email": "buyer@example.com", "recipient_name": "Far"})
    order = db.query(GiftCardOrder).filter(GiftCardOrder.user_id == owner.id).first()
    oid = str(order.id)

    # Cross-tenant issue is a 404 (IDOR → 404, never 403).
    _override_user(other)
    try:
        assert client.post(f"/api/gavekort/orders/{oid}/issue",
                           json={"payment_method": "mobilepay"}).status_code == 404
    finally:
        _clear_user_override()

    # Owner issues: a real card is minted via the shared path + linked.
    _override_user(owner)
    try:
        r = client.post(f"/api/gavekort/orders/{oid}/issue",
                        json={"payment_method": "mobilepay"})
        assert r.status_code == 201, r.text
        out = r.json()
        assert out["face_value_minor"] == 40000 and out["balance_minor"] == 40000
        assert out["status"] == "active"
        assert out["qr_token"].startswith("BB1.G.")
        assert out["payment_method"] == "mobilepay"
        assert out["order_id"] == oid

        # Order is now issued + linked to the new card.
        db.expire_all()
        order2 = db.query(GiftCardOrder).filter(GiftCardOrder.id == order.id).first()
        assert order2.status == "issued"
        assert str(order2.gift_card_id) == out["id"]

        # Recipient carried through; the card has its anchor ledger row.
        card = db.query(GiftCard).filter(GiftCard.id == uuid.UUID(out["id"])).first()
        assert card.recipient_name == "Far"
        txns = db.query(GiftCardTransaction).filter(
            GiftCardTransaction.gift_card_id == card.id).all()
        assert len(txns) == 1 and txns[0].kind == "issue"

        # Double-issue is refused — never mint two cards for one request.
        assert client.post(f"/api/gavekort/orders/{oid}/issue",
                           json={"payment_method": "cash"}).status_code == 409
    finally:
        _clear_user_override()


# ═════════════════════════════════════════════════════════════════════
# (f) decline → declined; re-decline 409
# ═════════════════════════════════════════════════════════════════════
def test_owner_decline_order(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        slug = _enable_orders(client)["slug"]
    finally:
        _clear_user_override()
    client.post(f"/api/public/gavekort/buy/{slug}", json={
        "amount_minor": 20000, "buyer_email": "buyer@example.com"})
    order = db.query(GiftCardOrder).filter(GiftCardOrder.user_id == owner.id).first()
    oid = str(order.id)

    _override_user(owner)
    try:
        r = client.post(f"/api/gavekort/orders/{oid}/decline")
        assert r.status_code == 200 and r.json()["status"] == "declined"
        # No card was minted by a decline.
        assert db.query(GiftCard).filter(GiftCard.user_id == owner.id).count() == 0
        # Re-declining an already-resolved order is a 409.
        assert client.post(f"/api/gavekort/orders/{oid}/decline").status_code == 409
    finally:
        _clear_user_override()


# ═════════════════════════════════════════════════════════════════════
# (g) email header-injection is rejected (the stored address later → to:/reply_to:)
# ═════════════════════════════════════════════════════════════════════
def test_buyer_email_rejects_header_injection(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        slug = _enable_orders(client)["slug"]
    finally:
        _clear_user_override()

    for bad in ["a@b.co\nBcc: x@y.com", "a@b.co\r\nx", "no-at-sign", "a b@c.dk", "a@b"]:
        r = client.post(f"/api/public/gavekort/buy/{slug}", json={
            "amount_minor": 20000, "buyer_email": bad})
        assert r.status_code == 422, f"{bad!r} should be rejected, got {r.status_code}"
    # No order rows were created from the rejected attempts.
    assert db.query(GiftCardOrder).filter(GiftCardOrder.user_id == owner.id).count() == 0


# ═════════════════════════════════════════════════════════════════════
# (h) a refresh-burst of the SAME request is deduped (one row, one owner email)
# ═════════════════════════════════════════════════════════════════════
def test_duplicate_burst_is_deduped(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        slug = _enable_orders(client)["slug"]
    finally:
        _clear_user_override()

    body = {"amount_minor": 25000, "buyer_email": "burst@example.com"}
    r1 = client.post(f"/api/public/gavekort/buy/{slug}", json=body)
    r2 = client.post(f"/api/public/gavekort/buy/{slug}", json=body)
    r3 = client.post(f"/api/public/gavekort/buy/{slug}", json=body)
    assert r1.status_code == 201 and r2.status_code == 201 and r3.status_code == 201
    # All three return the same honest ack, but only ONE pending row exists.
    assert (
        db.query(GiftCardOrder)
        .filter(GiftCardOrder.user_id == owner.id, GiftCardOrder.status == "pending")
        .count()
        == 1
    )
    # A different amount is a genuinely different order → not deduped.
    client.post(f"/api/public/gavekort/buy/{slug}",
                json={"amount_minor": 30000, "buyer_email": "burst@example.com"})
    assert (
        db.query(GiftCardOrder)
        .filter(GiftCardOrder.user_id == owner.id, GiftCardOrder.status == "pending")
        .count()
        == 2
    )
