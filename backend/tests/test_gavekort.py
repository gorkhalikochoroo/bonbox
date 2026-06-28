"""Gavekort (gift card) issue / track / redeem / void — the slice's contract.

Covers:
  (a) issue persists + returns short_code / qr_token / face_value / balance.
  (b) list summary math (issued / redeemed / outstanding / active_count).
  (c) redeem partial decrements + writes a ledger row with the LINK fields.
  (d) IDEMPOTENT redeem — same key ⇒ exactly ONE debit (replay = original).
  (e) concurrent / over-redeem rejected — atomic decrement, never negative.
  (f) cross-tenant 404 (IDOR → 404, never 403).
  (g) expired / voided ⇒ 410.
  (h) code identity: plaintext code is NEVER stored; balance == ledger sum.

App-level (in-memory SQLite) tests — TestClient + get_current_user override,
mirroring tests/test_provider_booking.py. The Postgres atomic-decrement +
ON CONFLICT path is the prod backstop; on SQLite the conditional UPDATE +
INSERT-OR-IGNORE give the same single-spend guarantee, which is exactly what
(d)/(e) prove here.

Run:
  cd backend && python3 -m pytest tests/test_gavekort.py -q
"""
from __future__ import annotations

import uuid
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.gift_card import GiftCard, GiftCardTransaction
from app.models.user import User
from app.services.auth import get_current_user

_db_ready.set()


# ─── Fixtures ────────────────────────────────────────────────────────
@pytest.fixture
def engine_and_session():
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(eng)
    SessionLocal = sessionmaker(bind=eng)
    return eng, SessionLocal


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

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


def _clear_user_override():
    app.dependency_overrides.pop(get_current_user, None)


# ─── Builders ────────────────────────────────────────────────────────
def _owner(db, *, plan: str = "starter") -> User:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name="Café Hygge",
        business_type="cafe", currency="DKK", plan=plan,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _issue(client, *, amount_minor=50000, **extra) -> dict:
    body = {"amount_minor": amount_minor}
    body.update(extra)
    r = client.post("/api/gavekort/issue", json=body)
    assert r.status_code == 201, r.text
    return r.json()


# ═════════════════════════════════════════════════════════════════════
# (a) issue persists + returns short_code / qr / balance
# ═════════════════════════════════════════════════════════════════════
def test_issue_persists_and_returns_shape(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        out = _issue(client, amount_minor=50000, recipient_name="Mette", note="Tak!")
    finally:
        _clear_user_override()

    assert out["face_value_minor"] == 50000
    assert out["balance_minor"] == 50000
    assert out["voucher_class"] == "mpv"          # default, not auto-decided
    assert out["status"] == "active"
    assert out["short_code"].startswith("GK-")
    parts = out["short_code"].split("-")
    assert len(parts) == 4 and parts[0] == "GK"   # GK-XXXX-XXXX-C
    assert out["qr_token"].startswith("BB1.G.")
    assert len(out["code_last4"]) == 4

    # Persisted, and the plaintext code is NOT stored anywhere on the row.
    card = db.query(GiftCard).filter(GiftCard.id == uuid.UUID(out["id"])).first()
    assert card is not None
    assert card.code_hash and len(card.code_hash) == 64   # HMAC-SHA256 hex
    assert card.short_code == out["short_code"]
    # No column holds the raw code — only hash + short_code + last4.
    row = dict(db.execute(text("SELECT * FROM gift_cards WHERE id=:i"),
                          {"i": str(card.id)}).mappings().first())
    assert "code" not in row  # no plaintext-code column at all

    # Issue ledger anchor row exists; balance == ledger sum.
    txns = db.query(GiftCardTransaction).filter(
        GiftCardTransaction.gift_card_id == card.id).all()
    assert len(txns) == 1 and txns[0].kind == "issue"
    assert txns[0].amount_minor == 50000
    assert card.balance_minor == sum(t.amount_minor for t in txns)


def test_voucher_class_is_owner_set_not_auto(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        out = _issue(client, amount_minor=10000, voucher_class="spv")
    finally:
        _clear_user_override()
    assert out["voucher_class"] == "spv"


def test_payment_method_captured_recorded_not_required(client, db):
    """The SELL slice captures HOW the card was paid for (tender). It is
    recorded on the card + echoed back + listed, persisted as-sent. Optional
    (older callers still work → NULL); an unknown tender is a 422."""
    owner = _owner(db)
    _override_user(owner)
    try:
        # Captured + echoed when sent.
        sold = _issue(client, amount_minor=20000, payment_method="mobilepay")
        assert sold["payment_method"] == "mobilepay"
        card = db.query(GiftCard).filter(GiftCard.id == uuid.UUID(sold["id"])).first()
        assert card.payment_method == "mobilepay"   # persisted

        # Shows up on the tracking list so the owner sees the tender.
        lst = client.get("/api/gavekort").json()
        row = next(c for c in lst["cards"] if c["id"] == sold["id"])
        assert row["payment_method"] == "mobilepay"

        # Optional — omitting it is fine and lands NULL (backward compatible).
        none_out = _issue(client, amount_minor=10000)
        assert none_out["payment_method"] is None

        # An unknown tender is rejected at the schema (422), never inferred.
        bad = client.post("/api/gavekort/issue",
                          json={"amount_minor": 10000, "payment_method": "bitcoin"})
        assert bad.status_code == 422, bad.text
    finally:
        _clear_user_override()


def test_public_gavekort_page_is_pii_safe(client, db):
    """The recipient's /g/<token> page shows the LIVE saldo + venue, PII-safe.
    Garbage → 404 (no leak). A voided card → 410."""
    owner = _owner(db)
    _override_user(owner)
    try:
        out = _issue(client, amount_minor=50000, recipient_name="Mette",
                     note="hemmelig note", payment_method="card")
        voided = _issue(client, amount_minor=10000)
    finally:
        _clear_user_override()

    token = out["qr_token"]                      # BB1.G.<jwt>
    assert token.startswith("BB1.G.")

    # No auth needed — the signed token IS the credential.
    pub = client.get(f"/api/public/gavekort/{token}")
    assert pub.status_code == 200, pub.text
    body = pub.json()
    assert body["balance_minor"] == 50000        # the live saldo
    assert body["face_value_minor"] == 50000
    assert body["status"] == "active"
    assert body["code_last4"] == out["code_last4"]
    # PII-MINIMAL: the recipient name + internal note + code_hash never leak.
    assert "recipient_name" not in body
    assert "note" not in body
    assert "code_hash" not in body
    assert "Mette" not in pub.text and "hemmelig" not in pub.text

    # Garbage / forged token → IDOR-safe 404, never a leak.
    assert client.get("/api/public/gavekort/BB1.G.not-a-real-jwt").status_code == 404

    # A voided card is gone → 410, not a zero-balance render.
    _override_user(owner)
    try:
        client.post(f"/api/gavekort/{voided['id']}/void")
    finally:
        _clear_user_override()
    assert client.get(f"/api/public/gavekort/{voided['qr_token']}").status_code == 410


def test_scan_resolve_reads_card_tenant_scoped(client, db):
    """The scanner's /scan-resolve reads a scanned QR (URL or envelope) → the
    card, WITHOUT redeeming. Tenant-scoped: another owner's token → 404.
    Voided → 410."""
    owner = _owner(db)
    other = _owner(db)
    _override_user(owner)
    try:
        out = _issue(client, amount_minor=50000, payment_method="card")
        voided = _issue(client, amount_minor=10000)
        client.post(f"/api/gavekort/{voided['id']}/void")
    finally:
        _clear_user_override()

    token = out["qr_token"]                       # BB1.G.<jwt>

    _override_user(owner)
    try:
        # Bare envelope resolves to the card (no redeem — balance untouched).
        r = client.post("/api/gavekort/scan-resolve", json={"token": token})
        assert r.status_code == 200, r.text
        assert r.json()["id"] == out["id"]
        assert r.json()["balance_minor"] == 50000

        # The public-URL form (what the camera actually reads) also resolves.
        url = f"https://www.bonbox.dk/g/{token}"
        r2 = client.post("/api/gavekort/scan-resolve", json={"token": url})
        assert r2.status_code == 200 and r2.json()["id"] == out["id"]

        # Garbage → IDOR-safe 404.
        assert client.post("/api/gavekort/scan-resolve",
                           json={"token": "BB1.G.nope"}).status_code == 404

        # A voided card → 410 (scanner shows "can't redeem").
        assert client.post("/api/gavekort/scan-resolve",
                           json={"token": voided["qr_token"]}).status_code == 410
    finally:
        _clear_user_override()

    # Cross-tenant: a DIFFERENT owner scanning owner's token → 404 (never leak).
    _override_user(other)
    try:
        assert client.post("/api/gavekort/scan-resolve",
                           json={"token": token}).status_code == 404
    finally:
        _clear_user_override()


# ═════════════════════════════════════════════════════════════════════
# (b) list summary math
# ═════════════════════════════════════════════════════════════════════
def test_list_summary_math(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        a = _issue(client, amount_minor=50000)   # 500 kr
        _issue(client, amount_minor=20000)        # 200 kr
        # Redeem 150 kr off card a.
        r = client.post(f"/api/gavekort/{a['id']}/redeem",
                        json={"amount_minor": 15000, "idempotency_key": "k1"})
        assert r.status_code == 200, r.text

        lst = client.get("/api/gavekort").json()
    finally:
        _clear_user_override()

    s = lst["summary"]
    assert s["issued_minor"] == 70000          # 500 + 200
    assert s["redeemed_minor"] == 15000        # the one 150 kr redeem
    assert s["outstanding_minor"] == 55000     # (500-150) + 200 = 350 + 200
    assert s["active_count"] == 2
    assert len(lst["cards"]) == 2


def test_list_status_and_search_filters(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        _issue(client, amount_minor=10000, recipient_name="Anders")
        b = _issue(client, amount_minor=10000, recipient_name="Bodil")
        # Void b → status filter should split them.
        client.post(f"/api/gavekort/{b['id']}/void")

        active = client.get("/api/gavekort?status=active").json()
        voided = client.get("/api/gavekort?status=voided").json()
        search = client.get("/api/gavekort?q=Anders").json()
    finally:
        _clear_user_override()

    assert len(active["cards"]) == 1
    assert len(voided["cards"]) == 1 and voided["cards"][0]["status"] == "voided"
    assert len(search["cards"]) == 1 and search["cards"][0]["recipient_name"] == "Anders"


# ═════════════════════════════════════════════════════════════════════
# (c) redeem partial decrements + ledger row + link fields
# ═════════════════════════════════════════════════════════════════════
def test_redeem_partial_decrements_and_writes_ledger(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        out = _issue(client, amount_minor=50000)
        r = client.post(f"/api/gavekort/{out['id']}/redeem",
                        json={"amount_minor": 12500, "idempotency_key": "kk",
                              "sale_ref": "SALE-42"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["applied_minor"] == 12500
        assert body["balance_remaining_minor"] == 37500
        assert body["status"] == "active"

        detail = client.get(f"/api/gavekort/{out['id']}").json()
    finally:
        _clear_user_override()

    assert detail["card"]["balance_minor"] == 37500
    # Ledger oldest→newest: issue then redeem.
    kinds = [t["kind"] for t in detail["transactions"]]
    assert kinds == ["issue", "redeem"]
    redeem_row = detail["transactions"][1]
    assert redeem_row["amount_minor"] == -12500          # debit stored negative
    assert redeem_row["balance_after_minor"] == 37500
    assert redeem_row["sale_ref"] == "SALE-42"           # LINK field captured
    assert redeem_row["staff_name"] is not None          # created_by resolved

    # Balance is the ledger's running sum — they must agree.
    card = db.query(GiftCard).filter(GiftCard.id == uuid.UUID(out["id"])).first()
    txns = db.query(GiftCardTransaction).filter(
        GiftCardTransaction.gift_card_id == card.id).all()
    assert card.balance_minor == sum(t.amount_minor for t in txns)


def test_redeem_to_zero_flips_status_redeemed(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        out = _issue(client, amount_minor=10000)
        r = client.post(f"/api/gavekort/{out['id']}/redeem",
                        json={"amount_minor": 10000, "idempotency_key": "full"})
        assert r.status_code == 200
        assert r.json()["status"] == "redeemed"
        assert r.json()["balance_remaining_minor"] == 0
        # A further redeem on a fully-redeemed card → 410.
        r2 = client.post(f"/api/gavekort/{out['id']}/redeem",
                         json={"amount_minor": 100, "idempotency_key": "again"})
        assert r2.status_code == 410
    finally:
        _clear_user_override()


# ═════════════════════════════════════════════════════════════════════
# (d) IDEMPOTENT redeem — same key ⇒ ONE debit
# ═════════════════════════════════════════════════════════════════════
def test_idempotent_redeem_same_key_one_debit(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        out = _issue(client, amount_minor=50000)
        first = client.post(f"/api/gavekort/{out['id']}/redeem",
                            json={"amount_minor": 10000, "idempotency_key": "IDEM-1"})
        assert first.status_code == 200
        # Replay the SAME request 4 more times.
        for _ in range(4):
            again = client.post(f"/api/gavekort/{out['id']}/redeem",
                                json={"amount_minor": 10000, "idempotency_key": "IDEM-1"})
            assert again.status_code == 200
            assert again.json()["applied_minor"] == 10000
            assert again.json()["balance_remaining_minor"] == 40000  # original result
    finally:
        _clear_user_override()

    # Exactly ONE redeem ledger row; balance debited exactly once.
    card = db.query(GiftCard).filter(GiftCard.id == uuid.UUID(out["id"])).first()
    redeems = db.query(GiftCardTransaction).filter(
        GiftCardTransaction.gift_card_id == card.id,
        GiftCardTransaction.kind == "redeem").all()
    assert len(redeems) == 1
    assert card.balance_minor == 40000


def test_idempotency_key_accepted_via_header(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        out = _issue(client, amount_minor=20000)
        r = client.post(f"/api/gavekort/{out['id']}/redeem",
                        json={"amount_minor": 5000},
                        headers={"Idempotency-Key": "HDR-1"})
        assert r.status_code == 200, r.text
        assert r.json()["balance_remaining_minor"] == 15000
        # Replay via header → same result, no 2nd debit.
        r2 = client.post(f"/api/gavekort/{out['id']}/redeem",
                         json={"amount_minor": 5000},
                         headers={"Idempotency-Key": "HDR-1"})
        assert r2.status_code == 200
        assert r2.json()["balance_remaining_minor"] == 15000
    finally:
        _clear_user_override()


def test_redeem_requires_idempotency_key(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        out = _issue(client, amount_minor=20000)
        r = client.post(f"/api/gavekort/{out['id']}/redeem",
                        json={"amount_minor": 5000})
        assert r.status_code == 422
    finally:
        _clear_user_override()


# ═════════════════════════════════════════════════════════════════════
# (e) over-redeem rejected — atomic, never negative
# ═════════════════════════════════════════════════════════════════════
def test_over_redeem_rejected_409_never_negative(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        out = _issue(client, amount_minor=10000)
        # Ask for more than the balance.
        r = client.post(f"/api/gavekort/{out['id']}/redeem",
                        json={"amount_minor": 15000, "idempotency_key": "over"})
        assert r.status_code == 409
        assert r.json()["detail"]["balance_remaining_minor"] == 10000
    finally:
        _clear_user_override()

    card = db.query(GiftCard).filter(GiftCard.id == uuid.UUID(out["id"])).first()
    assert card.balance_minor == 10000           # untouched, never negative
    # No redeem ledger row written for the rejected attempt.
    redeems = db.query(GiftCardTransaction).filter(
        GiftCardTransaction.gift_card_id == card.id,
        GiftCardTransaction.kind == "redeem").count()
    assert redeems == 0


def test_distinct_keys_two_redeems_cannot_overspend(client, db):
    """Two DIFFERENT idempotency keys each try to take more than half — only
    what fits is allowed; the balance never goes negative (atomic decrement)."""
    owner = _owner(db)
    _override_user(owner)
    try:
        out = _issue(client, amount_minor=10000)
        r1 = client.post(f"/api/gavekort/{out['id']}/redeem",
                         json={"amount_minor": 7000, "idempotency_key": "a"})
        assert r1.status_code == 200
        assert r1.json()["balance_remaining_minor"] == 3000
        # Second redeem of 7000 can't fit in the remaining 3000 → 409.
        r2 = client.post(f"/api/gavekort/{out['id']}/redeem",
                         json={"amount_minor": 7000, "idempotency_key": "b"})
        assert r2.status_code == 409
        assert r2.json()["detail"]["balance_remaining_minor"] == 3000
    finally:
        _clear_user_override()

    card = db.query(GiftCard).filter(GiftCard.id == uuid.UUID(out["id"])).first()
    assert card.balance_minor == 3000            # never negative
    txns = db.query(GiftCardTransaction).filter(
        GiftCardTransaction.gift_card_id == card.id).all()
    assert card.balance_minor == sum(t.amount_minor for t in txns)


# ═════════════════════════════════════════════════════════════════════
# (f) cross-tenant 404 (IDOR → 404, never 403)
# ═════════════════════════════════════════════════════════════════════
def test_cross_tenant_404(client, db):
    owner_a = _owner(db)
    owner_b = _owner(db)

    _override_user(owner_a)
    try:
        out = _issue(client, amount_minor=10000)
    finally:
        _clear_user_override()

    # owner_b tries to read / redeem / void owner_a's card → 404, never 403.
    _override_user(owner_b)
    try:
        assert client.get(f"/api/gavekort/{out['id']}").status_code == 404
        rr = client.post(f"/api/gavekort/{out['id']}/redeem",
                         json={"amount_minor": 100, "idempotency_key": "x"})
        assert rr.status_code == 404
        assert client.post(f"/api/gavekort/{out['id']}/void").status_code == 404
    finally:
        _clear_user_override()

    # owner_a's card is untouched.
    card = db.query(GiftCard).filter(GiftCard.id == uuid.UUID(out["id"])).first()
    assert card.balance_minor == 10000


# ═════════════════════════════════════════════════════════════════════
# (g) expired / voided ⇒ 410
# ═════════════════════════════════════════════════════════════════════
def test_voided_redeem_410_and_compensating_ledger(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        out = _issue(client, amount_minor=50000)
        v = client.post(f"/api/gavekort/{out['id']}/void")
        assert v.status_code == 200
        assert v.json()["status"] == "voided"
        assert v.json()["balance_minor"] == 0
        # Redeem on a voided card → 410.
        r = client.post(f"/api/gavekort/{out['id']}/redeem",
                        json={"amount_minor": 100, "idempotency_key": "z"})
        assert r.status_code == 410
        assert r.json()["detail"]["error"] == "voided"
    finally:
        _clear_user_override()

    card = db.query(GiftCard).filter(GiftCard.id == uuid.UUID(out["id"])).first()
    assert card.status == "voided" and card.balance_minor == 0
    # A compensating void ledger row exists; balance still == ledger sum.
    txns = db.query(GiftCardTransaction).filter(
        GiftCardTransaction.gift_card_id == card.id).all()
    kinds = [t.kind for t in txns]
    assert "void" in kinds
    assert card.balance_minor == sum(t.amount_minor for t in txns)


def test_expired_redeem_410(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        # Issue with a valid FUTURE expiry (D6 rejects already-past expiry at
        # issue with 422), then backdate expires_at to the past in the DB to
        # exercise the lazy expire-on-touch redeem path.
        out = _issue(client, amount_minor=50000,
                     expires_at="2099-01-01T00:00:00+00:00")
        db.execute(
            text("UPDATE gift_cards SET expires_at = :exp WHERE id = :id"),
            {"exp": "2000-01-01 00:00:00", "id": out["id"]},
        )
        db.commit()
        r = client.post(f"/api/gavekort/{out['id']}/redeem",
                        json={"amount_minor": 100, "idempotency_key": "e"})
        assert r.status_code == 410
        assert r.json()["detail"]["error"] == "expired"
    finally:
        _clear_user_override()

    # Lazily flipped to 'expired' on the touch.
    card = db.query(GiftCard).filter(GiftCard.id == uuid.UUID(out["id"])).first()
    assert card.status == "expired"


def test_issue_rejects_past_expiry_422(client, db):
    """D6 — minting an already-expired card is refused with 422."""
    owner = _owner(db)
    _override_user(owner)
    try:
        r = client.post("/api/gavekort/issue",
                        json={"amount_minor": 50000,
                              "expires_at": "2000-01-01T00:00:00+00:00"})
        assert r.status_code == 422, r.text
        assert r.json()["detail"]["error"] == "expires_at_in_past"
    finally:
        _clear_user_override()


def test_void_is_idempotent(client, db):
    owner = _owner(db)
    _override_user(owner)
    try:
        out = _issue(client, amount_minor=10000)
        client.post(f"/api/gavekort/{out['id']}/void")
        again = client.post(f"/api/gavekort/{out['id']}/void")
        assert again.status_code == 200
        assert again.json()["status"] == "voided"
    finally:
        _clear_user_override()

    # Exactly one void ledger row despite two void calls.
    card = db.query(GiftCard).filter(GiftCard.id == uuid.UUID(out["id"])).first()
    voids = db.query(GiftCardTransaction).filter(
        GiftCardTransaction.gift_card_id == card.id,
        GiftCardTransaction.kind == "void").count()
    assert voids == 1
