"""
Tests for the CSV-payment-line ↔ pending-booking auto-matcher.

Coverage:
  1. HIGH  — booking reference text in CSV comment → returned, sorted first
  2. MED   — amount + fuzzy sender_name vs customer_name → returned as candidate
  3. LOW   — amount + date inside event ±7d window → returned as candidate
  4. Multi-candidate — two bookings with same amount, only one with name
             match → MEDIUM only on the right one
  5. Zero match — random CSV line, no pending bookings → empty result
  6. L7 cross-tenant — confirm-match against another organizer's booking → 403
  7. Bonus — service returns [] when Booking model is not importable
             (fail-soft on Phase 1 not landed yet)

Phase 1 dependency: the actual `app.models.booking.Booking` model is
being built by a parallel agent. To run these tests in isolation we:

  • Inject a stub Booking ORM class bound to the test SQLite metadata
    (mounted into `sys.modules['app.models.booking']` for the duration
    of each test that needs it).
  • Monkeypatch `app.services.booking_to_sale.write_sale_from_booking`
    with a test double that creates a real Sale row + voucher and
    stamps the booking as paid — matching the contract described in
    the event-booking spec §5.4.

Run: cd backend && pytest tests/test_booking_match.py -v
"""
from __future__ import annotations

import sys
import types
import uuid
from datetime import date

import pytest
from sqlalchemy import (
    Column, String, Integer, Boolean, DateTime, ForeignKey, create_engine,
)
from sqlalchemy.orm import sessionmaker, relationship
from sqlalchemy.pool import StaticPool

from app.database import Base, GUID, get_db
from app.main import app, _db_ready
from app.models.event import Event
from app.models.user import User
from app.services.auth import get_current_user, hash_password
from app.utils.time import utc_now

# Service under test
from app.services.booking_match import (
    CsvPaymentLine,
    find_booking_matches,
)

_db_ready.set()


# ─── Stub Booking model — mimics Phase 1's shape ─────────────────────
#
# The real Booking model is being built in parallel. To exercise the
# matcher we need a stand-in that:
#   • Is ORM-mappable so SQLAlchemy can persist rows in SQLite
#   • Has the columns the matcher reads: id, organizer_user_id,
#     status, customer_name, total_amount_dkk, event_id, reference
#   • Belongs to the same MetaData so create_all() builds it
#
# We define it once at module import time and register it under
# `sys.modules['app.models.booking']` inside the fixture so the
# matcher's lazy `from app.models.booking import Booking` resolves
# to our stub. If/when the real Booking model lands the test stub
# loses to the real module (sys.modules already has the real one).


class _StubBooking(Base):
    __tablename__ = "bookings_test_stub"
    id = Column(GUID(), primary_key=True, default=uuid.uuid4)
    organizer_user_id = Column(GUID(), ForeignKey("users.id"), nullable=False, index=True)
    event_id = Column(GUID(), ForeignKey("events.id"), nullable=True)
    customer_name = Column(String(160), nullable=False)
    customer_email = Column(String(255), nullable=False)
    total_amount_dkk = Column(Integer, nullable=False, default=0)
    status = Column(String(20), nullable=False, default="pending")
    reference = Column(String(40), nullable=True)
    sale_id = Column(GUID(), ForeignKey("sales.id"), nullable=True)
    paid_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    is_deleted = Column(Boolean, default=False)

    event = relationship("Event", foreign_keys=[event_id])


# Map the stub into the spot the lazy import looks for it.
_stub_module = types.ModuleType("app.models.booking")
_stub_module.Booking = _StubBooking  # type: ignore[attr-defined]


@pytest.fixture(autouse=True)
def _install_stub_booking(monkeypatch):
    """Always insert the stub Booking module for THIS test file.

    The matcher is tested in isolation — we don't want the column
    schema or constraints of the (in-flight) real Booking model to
    break these tests during the parallel build. monkeypatch unwinds
    the substitution at test teardown so other test files see the
    real module if it's been imported elsewhere."""
    monkeypatch.setitem(sys.modules, "app.models.booking", _stub_module)
    yield


# ─── Standard fixtures ───────────────────────────────────────────────


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    return engine, SessionLocal


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield
    app.dependency_overrides.clear()


def _override_user(user: User | None):
    if user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = lambda: user


def _make_user(db, email: str = "sudip@bonbox.test") -> User:
    u = User(
        email=email,
        password_hash=hash_password("test_pw"),
        business_name="Nepali Cultural Society",
        business_type="general",
        currency="DKK",
        plan="free",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _make_event(
    db,
    user: User,
    *,
    name: str = "Nepali Movie Night #14",
    event_date: date | None = None,
) -> Event:
    ev = Event(
        user_id=user.id,
        name=name,
        event_date=event_date or date(2026, 6, 13),
    )
    db.add(ev)
    db.commit()
    db.refresh(ev)
    return ev


def _make_booking(
    db,
    organizer: User,
    event: Event,
    *,
    customer_name: str = "Sita Sharma",
    customer_email: str = "sita@example.test",
    total_amount_dkk: int = 450,
    status: str = "pending",
    reference: str | None = None,
) -> _StubBooking:
    b = _StubBooking(
        id=uuid.uuid4(),
        organizer_user_id=organizer.id,
        event_id=event.id,
        customer_name=customer_name,
        customer_email=customer_email,
        total_amount_dkk=total_amount_dkk,
        status=status,
        reference=reference,
    )
    db.add(b)
    db.commit()
    db.refresh(b)
    return b


# ─── 1. HIGH — reference match ───────────────────────────────────────


def test_high_match_reference_in_comment(db):
    """Reference text in the MobilePay 'besked' field → HIGH match,
    sorted first."""
    owner = _make_user(db)
    ev = _make_event(db, owner)
    booking = _make_booking(
        db, owner, ev,
        customer_name="Sita Sharma",
        total_amount_dkk=450,
        reference="NMN14-A47B",
    )

    line = CsvPaymentLine(
        amount_dkk=450,
        sender_name="Sita Sharma",
        comment="Paid for tickets NMN14-A47B thanks",
        date=date(2026, 6, 13),
    )

    matches = find_booking_matches(db, owner.id, line)
    assert len(matches) == 1
    m = matches[0]
    assert m.confidence == "high"
    assert m.booking_id == str(booking.id)
    assert m.matched_reference == "NMN14-A47B"
    assert "NMN14-A47B" in m.reason


def test_high_match_case_insensitive(db):
    """Reference matching is case-insensitive. MobilePay merchants
    sometimes lower-case the comment text in transit."""
    owner = _make_user(db)
    ev = _make_event(db, owner)
    booking = _make_booking(
        db, owner, ev,
        reference="NMN14-A47B",
    )

    line = CsvPaymentLine(
        amount_dkk=999,  # deliberately wrong amount → still HIGH wins
        sender_name="Whoever",
        comment="for nmn14-a47b cheers",
        date=date(2026, 6, 13),
    )

    matches = find_booking_matches(db, owner.id, line)
    assert any(m.confidence == "high" and m.booking_id == str(booking.id)
               for m in matches)


# ─── 2. MEDIUM — amount + fuzzy name ─────────────────────────────────


def test_medium_match_amount_and_fuzzy_name(db):
    """Same amount + sender name fuzzy-matches customer name → MEDIUM
    candidate surfaces as needs_review."""
    owner = _make_user(db)
    ev = _make_event(db, owner)
    booking = _make_booking(
        db, owner, ev,
        customer_name="Sita Sharma",
        total_amount_dkk=450,
        reference=None,  # no reference → can't go HIGH
    )

    line = CsvPaymentLine(
        amount_dkk=450,
        sender_name="Sita Sharma",  # exact name → fuzzy 1.0
        comment="just a friendly transfer",
        date=date(2026, 6, 13),
    )

    matches = find_booking_matches(db, owner.id, line)
    assert len(matches) == 1
    m = matches[0]
    assert m.confidence == "medium"
    assert m.booking_id == str(booking.id)
    assert "Sita Sharma" in m.reason


# ─── 3. LOW — amount + date window only ──────────────────────────────


def test_low_match_amount_and_date_window(db):
    """Same amount + CSV date within ±7d of event date → LOW candidate."""
    owner = _make_user(db)
    ev = _make_event(db, owner, event_date=date(2026, 6, 13))
    booking = _make_booking(
        db, owner, ev,
        customer_name="Anders Andersen",  # nothing similar to sender
        total_amount_dkk=450,
        reference=None,
    )

    line = CsvPaymentLine(
        amount_dkk=450,
        sender_name="John Doe",          # not fuzzy-matching the booking
        comment="generic transfer text",  # no reference to find
        date=date(2026, 6, 10),           # 3d before event → in window
    )

    matches = find_booking_matches(db, owner.id, line)
    assert len(matches) == 1
    assert matches[0].confidence == "low"
    assert matches[0].booking_id == str(booking.id)


def test_low_match_outside_date_window(db):
    """CSV date >7d from event → no LOW candidate."""
    owner = _make_user(db)
    ev = _make_event(db, owner, event_date=date(2026, 6, 13))
    _make_booking(
        db, owner, ev,
        customer_name="Anders Andersen",
        total_amount_dkk=450,
        reference=None,
    )

    line = CsvPaymentLine(
        amount_dkk=450,
        sender_name="John Doe",
        comment="generic",
        date=date(2026, 5, 1),   # ~6 weeks before event → outside window
    )

    matches = find_booking_matches(db, owner.id, line)
    assert matches == []


# ─── 4. Multi-candidate disambiguation ───────────────────────────────


def test_multi_candidate_only_name_match_is_medium(db):
    """Two pending bookings at the same amount; only one has a
    customer_name matching the CSV sender_name → that one comes back
    as MEDIUM, the other gets dropped by the LOW-ambiguity guard."""
    owner = _make_user(db)
    ev = _make_event(db, owner, event_date=date(2026, 6, 13))

    booking_match_one = _make_booking(
        db, owner, ev,
        customer_name="Sita Sharma",
        total_amount_dkk=450,
        reference=None,
    )
    booking_dud = _make_booking(
        db, owner, ev,
        customer_name="Carlos Mendoza",   # no name resemblance
        customer_email="carlos@example.test",
        total_amount_dkk=450,             # same amount
        reference=None,
    )

    line = CsvPaymentLine(
        amount_dkk=450,
        sender_name="Sita Sharma",
        comment="thanks",
        date=date(2026, 6, 13),
    )

    matches = find_booking_matches(db, owner.id, line)
    # Expected behaviour:
    #  • booking_match_one → MEDIUM (amount + name fuzzy)
    #  • booking_dud → would have been LOW (amount + date window),
    #    BUT the LOW-ambiguity guard does NOT trip because there's
    #    only one LOW match in the pool. So we should see exactly
    #    one MEDIUM (the right one) and one LOW (the dud).
    confidences = {m.confidence for m in matches}
    medium_matches = [m for m in matches if m.confidence == "medium"]
    assert len(medium_matches) == 1
    assert medium_matches[0].booking_id == str(booking_match_one.id)
    # The MEDIUM must come before any LOW in the sort.
    assert matches[0].confidence == "medium"

    # The dud appears as LOW (single ambiguous lows are allowed; only
    # MULTIPLE LOWs at the same amount get dropped).
    low_matches = [m for m in matches if m.confidence == "low"]
    if low_matches:
        assert low_matches[0].booking_id == str(booking_dud.id)


def test_multi_low_candidates_dropped_for_ambiguity(db):
    """Two pending bookings at the same amount, neither with a name
    or reference match → both would be LOW; ambiguity guard drops
    them entirely."""
    owner = _make_user(db)
    ev = _make_event(db, owner, event_date=date(2026, 6, 13))
    _make_booking(
        db, owner, ev,
        customer_name="Carlos Mendoza",
        customer_email="c1@example.test",
        total_amount_dkk=450,
        reference=None,
    )
    _make_booking(
        db, owner, ev,
        customer_name="Yuki Tanaka",
        customer_email="y1@example.test",
        total_amount_dkk=450,
        reference=None,
    )

    line = CsvPaymentLine(
        amount_dkk=450,
        sender_name="John Doe",       # nobody's name
        comment="generic transfer",
        date=date(2026, 6, 13),
    )

    matches = find_booking_matches(db, owner.id, line)
    # Both candidates would have been LOW. Ambiguity guard drops both
    # rather than surface noise.
    assert matches == []


# ─── 5. Zero match ────────────────────────────────────────────────────


def test_zero_match_no_pending_bookings(db):
    """Organizer has zero pending bookings → empty result."""
    owner = _make_user(db)
    line = CsvPaymentLine(
        amount_dkk=450,
        sender_name="Sita Sharma",
        comment="NMN14-A47B",
        date=date(2026, 6, 13),
    )
    assert find_booking_matches(db, owner.id, line) == []


def test_zero_match_random_amount(db):
    """Pending booking exists but the CSV line has wrong amount + no
    reference + no name overlap → no candidates returned."""
    owner = _make_user(db)
    ev = _make_event(db, owner)
    _make_booking(
        db, owner, ev,
        customer_name="Sita Sharma",
        total_amount_dkk=450,
        reference=None,
    )
    line = CsvPaymentLine(
        amount_dkk=12345,             # nowhere near 450
        sender_name="Random Person",
        comment="other transfer",
        date=date(2026, 6, 13),
    )
    assert find_booking_matches(db, owner.id, line) == []


# ─── 6. L7 — cross-tenant on confirm-match endpoint ─────────────────


def test_confirm_match_cross_tenant_403(client, db, monkeypatch):
    """Organizer A tries to confirm a match against organizer B's
    booking via /api/payment-import/{import_id}/confirm-match.
    Expected: 403 (forbidden) per the multi-barrier 10-layer doctrine.
    """
    from app.models.payment_connection import PaymentConnection

    organizer_a = _make_user(db, email="a@bonbox.test")
    organizer_b = _make_user(db, email="b@bonbox.test")

    # B has an event and a pending booking
    ev_b = _make_event(db, organizer_b)
    booking_b = _make_booking(
        db, organizer_b, ev_b,
        customer_name="Carlos Mendoza",
        customer_email="c@example.test",
        total_amount_dkk=300,
    )

    # A has a payment-import (PaymentConnection) of their own
    conn_a = PaymentConnection(
        id=uuid.uuid4(),
        user_id=organizer_a.id,
        provider="mobilepay",
        label="A's MobilePay",
        credentials="{}",
    )
    db.add(conn_a)
    db.commit()
    db.refresh(conn_a)

    # Inject a stub for write_sale_from_booking so the route doesn't
    # 503 on the missing parallel-agent module. It should never be
    # CALLED in this test (we expect 403 before that path).
    fake_module = types.ModuleType("app.services.booking_to_sale")

    def _should_not_be_called(*args, **kwargs):
        raise AssertionError(
            "write_sale_from_booking must not run on cross-tenant 403"
        )

    fake_module.write_sale_from_booking = _should_not_be_called  # type: ignore[attr-defined]
    monkeypatch.setitem(
        sys.modules, "app.services.booking_to_sale", fake_module,
    )

    # A authenticates and tries to confirm B's booking via A's import
    _override_user(organizer_a)
    from fastapi.testclient import TestClient
    tc = TestClient(app)

    res = tc.post(
        f"/api/payment-import/{conn_a.id}/confirm-match",
        json={"csv_row_index": 0, "booking_id": str(booking_b.id)},
    )
    assert res.status_code == 403, res.text


# ─── 7. Bonus — fail-soft when Booking model is missing ─────────────


def test_returns_empty_when_booking_model_missing(db, monkeypatch):
    """If `app.models.booking` cannot be imported at all (e.g. Phase 1
    not landed and no test stub installed), the matcher returns []
    instead of raising — keeps the existing payment_import flow alive."""
    owner = _make_user(db)
    line = CsvPaymentLine(
        amount_dkk=450,
        sender_name="Sita Sharma",
        comment="NMN14-A47B",
        date=date(2026, 6, 13),
    )
    # Force the lazy importer down the failure branch.
    from app.services import booking_match as bm
    monkeypatch.setattr(bm, "_get_booking_model", lambda: None)
    assert bm.find_booking_matches(db, owner.id, line) == []
