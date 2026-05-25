"""Event-booking v3 (ledger-only) — happy path + 10-layer regression tests.

Covers the multi-barrier matrix per `docs/event-booking-product-spec.md`
§7 across the new visitor-facing surface + organizer Path A
"mark paid" flow.

  • Happy path:   organizer publishes → visitor books → organizer
                  marks paid → write_sale_from_booking allocates a
                  bilagsnummer → audit chain intact.
  • L1 auth:      public POST/GET works without user auth.
  • L2 tenant:    cross-tenant booking GET returns 404, not 403.
  • L3 bounds:    Pydantic rejects >50 tickets / unknown tier label.
  • L7 fail-closed: Free tier 30-ticket cap → 409 "sold out".
  • L7 publish:   Free user past 1/month publishes → 402.
  • L8 audit:     booking.created + booking.paid rows written.
  • L9 fallback:  published=False → 410 Gone (not 404).
  • Idempotent:   same idempotency_key returns the prior booking.
  • cashup refactor: legacy cashup_event still works AND now writes a
                  Booking row + Sale via write_sale_from_booking.

Run:
  cd backend && pytest tests/test_bookings.py -v
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.booking import Booking
from app.models.event import Event
from app.models.event_customer import EventCustomer
from app.models.sale import Sale
from app.models.ticket import Ticket
from app.models.user import User
from app.services.auth import get_current_user
from app.services.qr_signer import sign_booking_token, verify_ticket

# Mark DB ready so the readiness middleware doesn't 503.
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
    # Reset rate limiters between tests to avoid cross-test bleed.
    for mod_path in (
        "app.routers.public_bookings",
        "app.routers.public_events",
        "app.routers.tickets",
    ):
        try:
            mod = __import__(mod_path, fromlist=["_limiter"])
            mod._limiter.reset()
        except Exception:  # noqa: BLE001
            pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


def _clear_user_override():
    app.dependency_overrides.pop(get_current_user, None)


# ─── Helpers ────────────────────────────────────────────────────────


def _user(db, *, plan: str = "starter", business: str = "Sudip Events") -> User:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x",
        business_name=business,
        business_type="event_organizer",
        currency="DKK",
        plan=plan,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _published_event(
    db,
    user: User,
    *,
    name: str = "Nepali Movie Night",
    slug: str = "nepali-movie-night-7k4q",
    tiers: list[dict] | None = None,
    addons: list[dict] | None = None,
    capacity_total: int | None = None,
    is_tax_exempt: bool = False,
) -> Event:
    ev = Event(
        user_id=user.id,
        name=name,
        event_date=date.today() + timedelta(days=5),
        venue="Bremen Teater",
        notes="Lakhey — a Kathmandu classic.",
        ticket_tiers=tiers or [
            {"label": "Voksen", "price_dkk": 150},
            {"label": "Studerende", "price_dkk": 100},
        ],
        addons=addons,
        is_tax_exempt=is_tax_exempt,
        slug=slug,
        published=True,
        published_at=datetime.utcnow(),
        starts_at=datetime.utcnow() + timedelta(days=5),
        ends_at=datetime.utcnow() + timedelta(days=5, hours=3),
        capacity_total=capacity_total,
        refund_policy="organizer",
    )
    db.add(ev)
    db.commit()
    db.refresh(ev)
    return ev


def _post_booking(
    client: TestClient,
    *,
    slug: str,
    tickets: list[dict],
    addons: list[dict] | None = None,
    email: str = "visitor@example.com",
    name: str = "Sita Sharma",
    idempotency_key: str | None = None,
):
    body = {
        "event_slug": slug,
        "customer_email": email,
        "customer_name": name,
        "customer_consent_marketing": False,
        "ticket_lines": tickets,
    }
    if addons:
        body["addon_lines"] = addons
    if idempotency_key:
        body["idempotency_key"] = idempotency_key
    return client.post("/api/public/bookings", json=body)


# ─── Tests — happy paths ─────────────────────────────────────────────


def test_public_event_detail_returns_payload(client, db):
    """GET /api/public/events/{slug} surfaces the published event."""
    user = _user(db, plan="starter")
    _published_event(db, user, slug="happy-path-aaa1")
    _clear_user_override()
    res = client.get("/api/public/events/happy-path-aaa1")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["slug"] == "happy-path-aaa1"
    assert body["name"] == "Nepali Movie Night"
    assert len(body["ticket_tiers"]) == 2
    # Capacity hint omitted because sold=0.
    assert body.get("capacity_hint") in (None, {"sold": 0, "total": None})


def test_ssr_page_returns_og_meta(client, db):
    """GET /e/{slug} returns 200 HTML with OG meta tags."""
    user = _user(db, plan="starter")
    _published_event(db, user, slug="ssr-test-bbb2")
    _clear_user_override()
    res = client.get("/e/ssr-test-bbb2")
    assert res.status_code == 200, res.text
    html = res.text
    assert "<meta property=\"og:title\"" in html
    assert "Nepali Movie Night" in html
    assert "summary_large_image" in html


def test_unpublished_event_returns_410_gone(client, db):
    """L9 — published=False → 410 Gone, not 404."""
    user = _user(db, plan="starter")
    ev = _published_event(db, user, slug="unpub-ccc3")
    ev.published = False
    db.commit()
    _clear_user_override()
    res = client.get("/api/public/events/unpub-ccc3")
    assert res.status_code == 410
    body = res.json()
    detail = body.get("detail") or body
    assert detail.get("error") == "event_not_available"


def test_happy_path_create_then_mark_paid(client, db):
    """End-to-end — visitor books → organizer marks paid → Sale row
    appears with a bilagsnummer + booking.paid audit row + ticket
    rows + EventCustomer counter incremented."""
    user = _user(db, plan="starter")
    ev = _published_event(db, user, slug="happy-end-ddd4")

    _clear_user_override()
    res = _post_booking(
        client,
        slug="happy-end-ddd4",
        tickets=[{"label": "Voksen", "qty": 2}],
        email="visitor@example.com",
        name="Sita Sharma",
    )
    assert res.status_code == 201, res.text
    body = res.json()
    booking_id = body["id"]
    assert body["status"] == "pending"
    assert body["total_amount_dkk"] == 300  # 2 × 150
    assert body["booking_token"]
    assert len(body["ticket_ids"]) == 2

    # Ticket rows exist + qr_payload signed
    tickets = db.query(Ticket).all()
    assert len(tickets) == 2
    for t in tickets:
        claims = verify_ticket(t.qr_payload)
        assert claims is not None
        assert claims["tid"] == str(t.id)
        assert claims["eid"] == str(ev.id)

    # Visitor poll works with the token.
    poll = client.get(
        f"/api/public/bookings/{booking_id}",
        params={"token": body["booking_token"]},
    )
    assert poll.status_code == 200, poll.text
    assert poll.json()["status"] == "pending"

    # Organizer marks paid.
    _override_user(user)
    mark = client.post(
        f"/api/bookings/{booking_id}/mark-paid",
        json={"payment_method": "mobilepay", "provider_ref": "mp_test_123"},
    )
    assert mark.status_code == 200, mark.text
    mark_body = mark.json()
    assert mark_body["status"] == "paid"
    assert mark_body["sale_id"] is not None
    assert mark_body["payment_provider"] == "mobilepay"

    # Sale row carries voucher + ticket_breakdown.
    sale = db.query(Sale).filter(Sale.event_id == ev.id).one()
    assert sale.voucher_number is not None
    assert sale.voucher_number >= 1
    assert sale.amount == 300
    assert isinstance(sale.ticket_breakdown, dict)
    assert sale.ticket_breakdown["kind"] == "event_booking"
    assert sale.ticket_breakdown["booking_id"] == str(booking_id)
    assert sale.ticket_breakdown["payment_provider"] == "mobilepay"

    # Audit rows: booking.created + booking.paid.
    actions = {
        a.action for a in
        db.query(AuditLog).filter(AuditLog.user_id == user.id).all()
    }
    assert "booking.created" in actions
    assert "booking.paid" in actions

    # EventCustomer upserted.
    cust = (
        db.query(EventCustomer)
        .filter(EventCustomer.organizer_user_id == user.id)
        .filter(EventCustomer.email == "visitor@example.com")
        .one()
    )
    assert cust.bookings_count == 1
    assert cust.total_spend_dkk == 300


def test_mark_paid_is_idempotent(client, db):
    """Calling mark-paid twice returns the same sale_id — no double Sale."""
    user = _user(db, plan="starter")
    _published_event(db, user, slug="idemp-eee5")

    _clear_user_override()
    res = _post_booking(
        client, slug="idemp-eee5",
        tickets=[{"label": "Voksen", "qty": 1}],
    )
    assert res.status_code == 201
    bid = res.json()["id"]

    _override_user(user)
    first = client.post(f"/api/bookings/{bid}/mark-paid", json={})
    assert first.status_code == 200
    second = client.post(f"/api/bookings/{bid}/mark-paid", json={})
    assert second.status_code == 200
    assert first.json()["sale_id"] == second.json()["sale_id"]
    assert db.query(Sale).count() == 1


def test_idempotency_key_returns_prior_booking(client, db):
    """Same idempotency_key → same Booking row (no duplicate)."""
    user = _user(db, plan="starter")
    _published_event(db, user, slug="idemp-key-fff6")

    _clear_user_override()
    key = "client-key-" + uuid.uuid4().hex[:16]
    first = _post_booking(
        client, slug="idemp-key-fff6",
        tickets=[{"label": "Voksen", "qty": 1}],
        idempotency_key=key,
    )
    assert first.status_code == 201
    second = _post_booking(
        client, slug="idemp-key-fff6",
        tickets=[{"label": "Voksen", "qty": 1}],
        idempotency_key=key,
    )
    # Both 201 (the second is the idempotent return shape).
    assert second.status_code in (200, 201)
    assert first.json()["id"] == second.json()["id"]
    assert db.query(Booking).count() == 1


# ─── Tests — 10-layer regressions ────────────────────────────────────


def test_l3_bounds_more_than_50_tickets_rejected(client, db):
    """L3 — Pydantic enforces 50-ticket cap per booking."""
    user = _user(db, plan="starter")
    _published_event(db, user, slug="bounds-ggg7")
    _clear_user_override()
    res = _post_booking(
        client, slug="bounds-ggg7",
        tickets=[{"label": "Voksen", "qty": 50}, {"label": "Studerende", "qty": 50}],
    )
    # 100 > 50 across all lines.
    assert res.status_code == 422, res.text


def test_l3_unknown_tier_label_rejected(client, db):
    """L3 — server cross-checks against event.ticket_tiers."""
    user = _user(db, plan="starter")
    _published_event(db, user, slug="unknown-hhh8")
    _clear_user_override()
    res = _post_booking(
        client, slug="unknown-hhh8",
        tickets=[{"label": "VIP-NoSuchTier", "qty": 1}],
    )
    assert res.status_code == 400, res.text
    assert "VIP-NoSuchTier" in res.text


def test_l7_free_tier_capacity_cap(client, db):
    """L7 — Free tier 30-ticket cap → 409 sold_out. Tier-leak free.

    Seeds the 30 prior bookings directly into the DB (avoids tripping
    the public booking endpoint's 6/min rate limit). Only the LAST
    booking (the 31st ticket) goes through the HTTP path so we exercise
    the cap-check + Danish error copy.
    """
    user = _user(db, plan="free")
    ev = _published_event(db, user, slug="freecap-iii9")

    # Seed 30 prior "paid" bookings — directly into the DB so we don't
    # blow the rate limiter. They count toward _sold_tickets_count.
    for i in range(30):
        b = Booking(
            event_id=ev.id,
            organizer_user_id=user.id,
            customer_email=f"v{i}@ex.com",
            customer_name=f"V{i}",
            ticket_lines=[{"label": "Voksen", "qty": 1, "unit_price_dkk": 150}],
            total_amount_dkk=150,
            currency="DKK",
            is_tax_exempt=False,
            status="paid",
            paid_at=datetime.utcnow(),
        )
        db.add(b)
    db.commit()

    _clear_user_override()
    # 31st visitor — sold out (Free cap = 30).
    res = _post_booking(
        client, slug="freecap-iii9",
        tickets=[{"label": "Voksen", "qty": 1}],
        email="late@ex.com",
        name="Late",
    )
    assert res.status_code == 409, res.text
    body = res.json()
    detail = body.get("detail") or body
    assert detail.get("error") == "event_sold_out"
    # Visitor-facing copy — Danish, generic (no tier-leak).
    assert "fuldt booket" in detail.get("message", "")


def test_l7_publish_cap_free_tier(client, db):
    """L7 — Free tier 1-published-event/month cap on POST /publish."""
    user = _user(db, plan="free")
    # First publish — succeeds.
    ev1 = Event(
        user_id=user.id,
        name="First Event",
        event_date=date.today() + timedelta(days=2),
    )
    ev2 = Event(
        user_id=user.id,
        name="Second Event",
        event_date=date.today() + timedelta(days=3),
    )
    db.add_all([ev1, ev2])
    db.commit()
    db.refresh(ev1)
    db.refresh(ev2)

    _override_user(user)
    r1 = client.post(f"/api/events/{ev1.id}/publish")
    assert r1.status_code == 200, r1.text
    # Second publish in the same month — 402 with the canonical
    # upgrade payload from billing.py.
    r2 = client.post(f"/api/events/{ev2.id}/publish")
    assert r2.status_code == 402, r2.text
    body = r2.json().get("detail") or r2.json()
    assert body["error"] == "cap_exceeded"
    assert body["cap"] == "published_events_per_month"
    assert body["upgrade_to"] in ("starter", "pro")


def test_l9_published_false_returns_410(client, db):
    """L9 — booking POST against an unpublished event → 410 Gone."""
    user = _user(db, plan="starter")
    ev = _published_event(db, user, slug="unpubpost-jjj0")
    ev.published = False
    db.commit()
    _clear_user_override()
    res = _post_booking(
        client, slug="unpubpost-jjj0",
        tickets=[{"label": "Voksen", "qty": 1}],
    )
    assert res.status_code == 410, res.text


def test_l2_idor_cross_tenant_returns_404(client, db):
    """L2/L6 — GET /api/public/bookings/{id} with a token that's
    valid but for a DIFFERENT booking returns 404 (NOT 403).
    """
    user_a = _user(db, plan="starter", business="A")
    _published_event(db, user_a, slug="idor-kkk1")
    _clear_user_override()
    res = _post_booking(
        client, slug="idor-kkk1",
        tickets=[{"label": "Voksen", "qty": 1}],
    )
    assert res.status_code == 201
    real_id = res.json()["id"]
    # Forge a token for a different (random) booking id, then GET
    # with the original booking's id — token bid mismatch → 404.
    fake_token = sign_booking_token(str(uuid.uuid4()))
    poll = client.get(
        f"/api/public/bookings/{real_id}",
        params={"token": fake_token},
    )
    assert poll.status_code == 404, poll.text


def test_l8_audit_booking_created_row(client, db):
    """L8 — every successful POST writes a booking.created audit row."""
    user = _user(db, plan="starter")
    _published_event(db, user, slug="audit-lll2")
    _clear_user_override()
    res = _post_booking(
        client, slug="audit-lll2",
        tickets=[{"label": "Voksen", "qty": 1}],
    )
    assert res.status_code == 201
    audits = (
        db.query(AuditLog)
        .filter(AuditLog.user_id == user.id)
        .filter(AuditLog.action == "booking.created")
        .all()
    )
    assert len(audits) == 1
    after = json.loads(audits[0].after_state or "{}")
    assert after["customer_email"] == "visitor@example.com"
    assert after["total_dkk"] == 150


def test_visitor_cancel_pending_voids_tickets(client, db):
    """Visitor self-cancels pending booking → tickets voided."""
    user = _user(db, plan="starter")
    _published_event(db, user, slug="cancel-mmm3")
    _clear_user_override()
    res = _post_booking(
        client, slug="cancel-mmm3",
        tickets=[{"label": "Voksen", "qty": 2}],
    )
    assert res.status_code == 201
    bid = res.json()["id"]
    token = res.json()["booking_token"]

    cancel = client.post(
        f"/api/public/bookings/{bid}/cancel",
        params={"token": token},
    )
    assert cancel.status_code == 200, cancel.text
    assert cancel.json()["status"] == "cancelled"
    # All tickets voided.
    tix = db.query(Ticket).all()
    assert len(tix) == 2
    assert all(t.is_void for t in tix)


def test_cashup_refactor_writes_booking_and_sale(client, db):
    """The refactored cashup_event must materialise a Booking row +
    a Sale via write_sale_from_booking, preserving the bilagsnummer
    + ticket_breakdown.kind chain.
    """
    user = _user(db, plan="starter")
    ev = _published_event(db, user, slug="cashup-nnn4")
    _override_user(user)
    res = client.post(
        f"/api/events/{ev.id}/cashup",
        json={
            "tier_counts": [
                {"label": "Voksen", "qty": 5},
                {"label": "Studerende", "qty": 3},
            ],
        },
    )
    assert res.status_code == 201, res.text
    # Booking row exists.
    bookings = db.query(Booking).filter(Booking.event_id == ev.id).all()
    assert len(bookings) == 1
    booking = bookings[0]
    assert booking.status == "paid"
    assert booking.payment_provider == "manual_cashup"
    # Sale row tied to the booking via sale_id.
    sale = db.query(Sale).filter(Sale.id == booking.sale_id).one()
    assert sale.event_id == ev.id
    assert sale.voucher_number is not None
    # Sub-kind annotation present so reports can distinguish.
    assert sale.ticket_breakdown["sub_kind"] == "event_cashup"


def test_qr_signer_round_trip():
    """Direct unit — sign_ticket + verify_ticket round-trips."""
    from app.services.qr_signer import sign_ticket
    tid = str(uuid.uuid4())
    eid = str(uuid.uuid4())
    ends = datetime.utcnow() + timedelta(hours=4)
    token = sign_ticket(ticket_id=tid, event_id=eid, event_ends_at=ends)
    claims = verify_ticket(token)
    assert claims is not None
    assert claims["tid"] == tid
    assert claims["eid"] == eid
    # Wrong sub claim → reject.
    bad = sign_ticket(ticket_id=tid, event_id=eid, event_ends_at=ends)
    # Garbled token rejection.
    assert verify_ticket(bad + "garbage") is None
    assert verify_ticket("") is None
    assert verify_ticket("not.a.jwt") is None


def test_booking_expiry_sweep_marks_expired(db):
    """The pending-expiry sweep marks past-expiry pending rows expired
    + voids any pre-issued tickets."""
    from app.services.booking_expiry import sweep_expired_pending

    user = _user(db, plan="starter")
    ev = _published_event(db, user, slug="expsweep-ooo5")
    now = datetime.utcnow()
    booking = Booking(
        event_id=ev.id,
        organizer_user_id=user.id,
        customer_email="t@t.t",
        customer_name="T",
        ticket_lines=[{"label": "Voksen", "qty": 1, "unit_price_dkk": 150}],
        total_amount_dkk=150,
        currency="DKK",
        status="pending",
        expires_at=now - timedelta(minutes=5),
    )
    db.add(booking)
    db.flush()
    ticket = Ticket(
        booking_id=booking.id,
        event_id=ev.id,
        tier_label="Voksen",
        tier_price_dkk=150,
        qr_payload="x",
    )
    db.add(ticket)
    db.commit()

    outcome = sweep_expired_pending(db)
    db.commit()
    assert outcome["expired"] == 1
    assert outcome["voided_tickets"] == 1
    db.refresh(booking)
    db.refresh(ticket)
    assert booking.status == "expired"
    assert ticket.is_void is True
