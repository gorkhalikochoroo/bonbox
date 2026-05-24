"""Tests for terminal_inference — propose terminals from kasserapport scans.

Multi-layer pinned:
  • Tenant boundary: extraction_ids from another owner are silently
    excluded (the service never reads their data, never writes).
  • Vertical defaults: cafe vs restaurant vs retail get sensible name
    proposals.
  • Friendly-label promotion: "Front bar" beats vertical default;
    "Term 1" gets replaced with the vertical default.
  • Capability inference: dankort/mobilepay flag from positive amounts;
    amex stays conservative (False) since slips don't reliably show it.
  • Existing-terminal match: if a label matches an existing terminal,
    the proposal carries `matches_existing_id` so the UI can dedupe.
  • Bulk-create atomicity: malformed proposal aborts the whole batch.
  • Bulk-create cap: refuses to exceed DEFAULT_TERMINAL_LIMIT counting
    already-existing rows.
  • Auto-route: case-insensitive equality on receipt_label or name;
    tenant-scoped; returns None on junk.
  • Empty-extractions fail-closed: still proposes one default.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.kasserapport import KasserapportExtraction
from app.models.terminal import Terminal
from app.models.user import User
from app.services.terminal_inference import (
    DEFAULT_TERMINAL_LIMIT,
    TerminalInferenceError,
    bulk_create_terminals,
    find_terminal_for_label,
    infer_terminals_from_extractions,
)
from app.utils.time import utc_now


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


def _user(db, *, vertical: str = "restaurant", email: str | None = None) -> User:
    u = User(
        email=email or f"{vertical}-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x",
        business_name=vertical.title(),
        business_type=vertical,
        currency="DKK",
        plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _extraction(
    db, owner: User, *,
    label: str | None,
    dankort: float | None = 100.0,
    mobilepay: float | None = 50.0,
):
    """Build a kasserapport extraction with a session.terminal label and
    a payments block. Returns the saved row."""
    payload = {
        "session": {"date": "2026-05-08", "terminal": label},
        "revenue": {"subtotal_excl_moms": 800, "moms_amount": 200, "total_incl_moms": 1000},
        "payments": {
            "card_betalingskort": dankort,
            "card_softpay": None,
            "card_total": dankort or 0,
            "mobilepay": mobilepay,
            "cash_closing": None,
        },
        "operations": {"pax_covers": 10, "transactions": 5},
    }
    ext = KasserapportExtraction(
        id=uuid.uuid4(),
        user_id=owner.id,
        document_type="kasserapport",
        pos_system="oasis",
        extracted_json=payload,
        manual_review_needed=False,
        created_at=utc_now(),
    )
    db.add(ext); db.commit(); db.refresh(ext)
    return ext


# ─── Vertical defaults ────────────────────────────────────────────────


def test_vertical_default_names_restaurant(db):
    """A restaurant with no labels → default 'Front bar'."""
    user = _user(db, vertical="restaurant")
    out = infer_terminals_from_extractions(db, user=user)
    assert len(out["proposals"]) == 1
    assert out["proposals"][0]["name"] == "Front bar"
    assert out["confidence"] == "low"  # no data


def test_vertical_default_names_cafe(db):
    user = _user(db, vertical="cafe")
    out = infer_terminals_from_extractions(db, user=user)
    assert out["proposals"][0]["name"] == "Front counter"


def test_vertical_default_names_retail(db):
    user = _user(db, vertical="retail")
    out = infer_terminals_from_extractions(db, user=user)
    assert out["proposals"][0]["name"] == "POS 1"


def test_unknown_vertical_uses_fallback(db):
    user = _user(db, vertical="some-future-vertical")
    out = infer_terminals_from_extractions(db, user=user)
    assert out["proposals"][0]["name"] == "Terminal 1"


# ─── Label extraction & promotion ─────────────────────────────────────


def test_friendly_label_used_as_name(db):
    """If the OCR pulled a human-friendly label like 'Front bar', that
    becomes the name verbatim — owner doesn't see a vertical default."""
    user = _user(db, vertical="restaurant")
    _extraction(db, user, label="Front bar")
    out = infer_terminals_from_extractions(db, user=user)
    assert len(out["proposals"]) == 1
    assert out["proposals"][0]["name"] == "Front bar"
    assert out["proposals"][0]["receipt_label"] == "Front bar"


def test_terminal_n_label_replaced_with_vertical_default(db):
    """If the OCR only saw 'Term 1' / 'Terminal 2' (machine-style label),
    we use the vertical default name and keep the raw label as
    receipt_label for auto-routing later."""
    user = _user(db, vertical="restaurant")
    _extraction(db, user, label="Term 1")
    _extraction(db, user, label="Term 2")
    out = infer_terminals_from_extractions(db, user=user)
    names = [p["name"] for p in out["proposals"]]
    assert "Term 1" not in names
    assert "Term 2" not in names
    assert "Front bar" in names
    # The raw label survives for auto-routing
    receipt_labels = [p["receipt_label"] for p in out["proposals"]]
    assert "Term 1" in receipt_labels
    assert "Term 2" in receipt_labels


def test_distinct_labels_grouped_correctly(db):
    """Two scans with the same label → one proposal; different labels →
    two proposals."""
    user = _user(db, vertical="restaurant")
    _extraction(db, user, label="Front bar")
    _extraction(db, user, label="Front bar")  # same
    _extraction(db, user, label="Terrace")
    out = infer_terminals_from_extractions(db, user=user)
    assert len(out["proposals"]) == 2
    by_label = {p["receipt_label"]: p for p in out["proposals"]}
    assert by_label["Front bar"]["source_count"] == 2
    assert by_label["Terrace"]["source_count"] == 1


def test_labels_normalised_for_grouping(db):
    """Punctuation/case differences shouldn't split into multiple groups
    ('Front Bar', 'front-bar', 'frontbar' are all one terminal)."""
    user = _user(db, vertical="restaurant")
    _extraction(db, user, label="Front Bar")
    _extraction(db, user, label="front-bar")
    _extraction(db, user, label="frontbar")
    out = infer_terminals_from_extractions(db, user=user)
    assert len(out["proposals"]) == 1
    assert out["proposals"][0]["source_count"] == 3


# ─── Capability inference ─────────────────────────────────────────────


def test_capabilities_inferred_from_positive_payments(db):
    """A slip with dankort=100 and mobilepay=50 → both flags True."""
    user = _user(db, vertical="restaurant")
    _extraction(db, user, label="Front bar", dankort=100.0, mobilepay=50.0)
    out = infer_terminals_from_extractions(db, user=user)
    p = out["proposals"][0]
    assert p["accepts_dankort"] is True
    assert p["accepts_mobilepay"] is True
    assert p["accepts_amex"] is False  # conservative — slips rarely show it


def test_amex_stays_false_even_when_payments_present(db):
    """We never auto-flip amex on, even when other payments are non-zero —
    Danish slips don't reliably show Amex on its own line."""
    user = _user(db, vertical="restaurant")
    _extraction(db, user, label="Bar 1", dankort=500.0, mobilepay=200.0)
    out = infer_terminals_from_extractions(db, user=user)
    assert out["proposals"][0]["accepts_amex"] is False


def test_zero_or_null_payments_still_default_true_for_dk_mp(db):
    """Even a quiet day (cash-only slip) → dankort/mobilepay default True
    so the close UI shows those fields. Owner toggles them off in
    confirm if the terminal genuinely doesn't take them."""
    user = _user(db, vertical="restaurant")
    _extraction(db, user, label="Front bar", dankort=None, mobilepay=None)
    out = infer_terminals_from_extractions(db, user=user)
    p = out["proposals"][0]
    assert p["accepts_dankort"] is True
    assert p["accepts_mobilepay"] is True


# ─── Existing terminals — match & dedupe ──────────────────────────────


def test_existing_terminal_matches_via_receipt_label(db):
    """If a terminal already exists with receipt_label='Term 2' and the
    proposal would also be 'Term 2', the proposal carries the existing
    terminal's id so the UI can highlight 'already configured'."""
    user = _user(db, vertical="restaurant")
    existing = Terminal(
        id=uuid.uuid4(), user_id=user.id, name="Bar 2", receipt_label="Term 2",
    )
    db.add(existing); db.commit()
    _extraction(db, user, label="Term 2")
    out = infer_terminals_from_extractions(db, user=user)
    assert len(out["proposals"]) == 1
    assert out["proposals"][0]["matches_existing_id"] == str(existing.id)
    # Name is taken from existing terminal, not vertical default
    assert out["proposals"][0]["name"] == "Bar 2"


def test_existing_terminals_returned_alongside_proposals(db):
    user = _user(db, vertical="restaurant")
    e = Terminal(id=uuid.uuid4(), user_id=user.id, name="Front bar")
    db.add(e); db.commit()
    out = infer_terminals_from_extractions(db, user=user)
    assert any(t["name"] == "Front bar" for t in out["existing_terminals"])


# ─── Tenant boundary ──────────────────────────────────────────────────


def test_tenant_boundary_other_owners_extractions_excluded(db):
    """Owner A's inference should never see Owner B's extractions, even
    if Owner A passes Owner B's extraction_ids."""
    a = _user(db, vertical="restaurant", email="a@bonbox.test")
    b = _user(db, vertical="restaurant", email="b@bonbox.test")
    ext_b = _extraction(db, b, label="Hidden Bar")
    out = infer_terminals_from_extractions(db, user=a, extraction_ids=[ext_b.id])
    # No data for A → fail-closed default proposal
    assert len(out["proposals"]) == 1
    assert out["proposals"][0]["receipt_label"] is None
    # Owner B's label NEVER appears in A's proposals
    receipt_labels = [p["receipt_label"] for p in out["proposals"]]
    assert "Hidden Bar" not in receipt_labels


def test_tenant_boundary_existing_terminals_filtered(db):
    a = _user(db, email="a@bonbox.test")
    b = _user(db, email="b@bonbox.test")
    db.add(Terminal(id=uuid.uuid4(), user_id=b.id, name="B's Bar"))
    db.commit()
    out = infer_terminals_from_extractions(db, user=a)
    assert all(t["name"] != "B's Bar" for t in out["existing_terminals"])


# ─── Confidence calibration ───────────────────────────────────────────


def test_confidence_high_when_every_group_has_at_least_two(db):
    user = _user(db, vertical="restaurant")
    _extraction(db, user, label="Bar 1")
    _extraction(db, user, label="Bar 1")
    _extraction(db, user, label="Bar 2")
    _extraction(db, user, label="Bar 2")
    out = infer_terminals_from_extractions(db, user=user)
    assert out["confidence"] == "high"


def test_confidence_medium_when_some_groups_have_only_one(db):
    user = _user(db, vertical="restaurant")
    _extraction(db, user, label="Bar 1")
    _extraction(db, user, label="Bar 2")  # only one each
    out = infer_terminals_from_extractions(db, user=user)
    assert out["confidence"] == "medium"


def test_confidence_low_when_no_labels_anywhere(db):
    user = _user(db, vertical="restaurant")
    out = infer_terminals_from_extractions(db, user=user)
    assert out["confidence"] == "low"


# ─── Output shape ─────────────────────────────────────────────────────


def test_proposal_always_has_complete_shape(db):
    user = _user(db, vertical="restaurant")
    _extraction(db, user, label="Front bar")
    out = infer_terminals_from_extractions(db, user=user)
    for key in ("proposals", "existing_terminals", "confidence",
                "data_quality", "reasoning"):
        assert key in out
    for p in out["proposals"]:
        for k in ("receipt_label", "name", "accepts_dankort",
                  "accepts_mobilepay", "accepts_amex", "display_order",
                  "source_count", "matches_existing_id"):
            assert k in p


# ─── bulk_create_terminals — atomic write ─────────────────────────────


def test_bulk_create_writes_all_or_nothing(db):
    # multi-terminal flow → needs Pro (Free is capped at 1 terminal by L4).
    user = _user(db, vertical="restaurant")
    user.plan = "pro"; db.commit()
    proposals = [
        {"name": "Front bar", "display_order": 0,
         "accepts_dankort": True, "accepts_mobilepay": True, "accepts_amex": False},
        {"name": "Back bar", "display_order": 1,
         "accepts_dankort": True, "accepts_mobilepay": True, "accepts_amex": False},
    ]
    created = bulk_create_terminals(db, user=user, proposals=proposals)
    assert len(created) == 2
    rows = db.query(Terminal).filter(Terminal.user_id == user.id).all()
    assert len(rows) == 2


def test_bulk_create_aborts_if_one_proposal_invalid(db):
    """One bad proposal in the batch → NOTHING is written (atomic)."""
    # multi-terminal flow → needs Pro (L4 caps Free at 1 terminal).
    user = _user(db, vertical="restaurant")
    user.plan = "pro"; db.commit()
    proposals = [
        {"name": "Front bar", "display_order": 0,
         "accepts_dankort": True, "accepts_mobilepay": True, "accepts_amex": False},
        {"name": "", "display_order": 1,  # empty name — invalid
         "accepts_dankort": True, "accepts_mobilepay": True, "accepts_amex": False},
    ]
    with pytest.raises(TerminalInferenceError):
        bulk_create_terminals(db, user=user, proposals=proposals)
    rows = db.query(Terminal).filter(Terminal.user_id == user.id).all()
    assert rows == []


def test_bulk_create_respects_terminal_limit(db):
    """Cap counts existing rows — not just the batch size."""
    # Tests the hard-ceiling cap; Pro needed so the L4 Free-tier cap
    # doesn't pre-empt the DEFAULT_TERMINAL_LIMIT check.
    user = _user(db, vertical="restaurant")
    user.plan = "pro"; db.commit()
    # Pre-fill near the cap
    for i in range(DEFAULT_TERMINAL_LIMIT - 1):
        db.add(Terminal(id=uuid.uuid4(), user_id=user.id, name=f"Old {i}"))
    db.commit()
    proposals = [
        {"name": "New 1", "display_order": 0,
         "accepts_dankort": True, "accepts_mobilepay": True, "accepts_amex": False},
        {"name": "New 2", "display_order": 1,
         "accepts_dankort": True, "accepts_mobilepay": True, "accepts_amex": False},
    ]
    with pytest.raises(TerminalInferenceError, match="exceed terminal limit"):
        bulk_create_terminals(db, user=user, proposals=proposals)


def test_bulk_create_rejects_too_many_in_one_request(db):
    user = _user(db, vertical="restaurant")
    proposals = [
        {"name": f"T{i}", "display_order": i,
         "accepts_dankort": True, "accepts_mobilepay": True, "accepts_amex": False}
        for i in range(DEFAULT_TERMINAL_LIMIT + 1)
    ]
    with pytest.raises(TerminalInferenceError, match="Too many"):
        bulk_create_terminals(db, user=user, proposals=proposals)


def test_bulk_create_rejects_empty_payload(db):
    user = _user(db, vertical="restaurant")
    with pytest.raises(TerminalInferenceError):
        bulk_create_terminals(db, user=user, proposals=[])


def test_bulk_create_rejects_forged_branch_id(db):
    """A branch_id from another owner must be refused."""
    a = _user(db, vertical="restaurant", email="a@bonbox.test")
    # Fake a UUID — the branch doesn't exist for owner A
    fake_branch_id = uuid.uuid4()
    proposals = [
        {"name": "Bar", "display_order": 0,
         "accepts_dankort": True, "accepts_mobilepay": True, "accepts_amex": False}
    ]
    with pytest.raises(TerminalInferenceError, match="Branch not found"):
        bulk_create_terminals(db, user=a, proposals=proposals, branch_id=fake_branch_id)


def test_bulk_create_l4_refuses_free_user_past_one_terminal(db):
    """L4 defense — service refuses a Free user creating >1 terminal even
    if the router gate is somehow bypassed. Multi-barrier check."""
    user = _user(db, vertical="restaurant")  # plan="free" (fixture default)
    proposals = [
        {"name": "T1", "display_order": 0,
         "accepts_dankort": True, "accepts_mobilepay": True, "accepts_amex": False},
        {"name": "T2", "display_order": 1,
         "accepts_dankort": True, "accepts_mobilepay": True, "accepts_amex": False},
    ]
    with pytest.raises(PermissionError, match="multi_terminal_close"):
        bulk_create_terminals(db, user=user, proposals=proposals)
    # And nothing was written
    rows = db.query(Terminal).filter(Terminal.user_id == user.id).all()
    assert rows == []


# ─── find_terminal_for_label — auto-route ─────────────────────────────


def test_auto_route_case_insensitive(db):
    user = _user(db, vertical="restaurant")
    t = Terminal(id=uuid.uuid4(), user_id=user.id, name="Front bar",
                 receipt_label="Term 1")
    db.add(t); db.commit()
    assert find_terminal_for_label(db, user=user, label="term 1") == t.id
    assert find_terminal_for_label(db, user=user, label="TERM 1") == t.id
    assert find_terminal_for_label(db, user=user, label="Term-1") == t.id


def test_auto_route_falls_back_to_name_when_no_receipt_label(db):
    user = _user(db, vertical="restaurant")
    t = Terminal(id=uuid.uuid4(), user_id=user.id, name="Bar 2", receipt_label=None)
    db.add(t); db.commit()
    assert find_terminal_for_label(db, user=user, label="Bar 2") == t.id


def test_auto_route_returns_none_for_no_match(db):
    user = _user(db, vertical="restaurant")
    db.add(Terminal(id=uuid.uuid4(), user_id=user.id, name="Bar 1",
                    receipt_label="Term 1"))
    db.commit()
    assert find_terminal_for_label(db, user=user, label="something else") is None


def test_auto_route_returns_none_for_empty_input(db):
    user = _user(db, vertical="restaurant")
    db.add(Terminal(id=uuid.uuid4(), user_id=user.id, name="Bar"))
    db.commit()
    assert find_terminal_for_label(db, user=user, label=None) is None
    assert find_terminal_for_label(db, user=user, label="") is None
    assert find_terminal_for_label(db, user=user, label="   ") is None


def test_auto_route_tenant_scoped(db):
    """Owner A's terminal label must NOT match for Owner B's lookup."""
    a = _user(db, email="a@bonbox.test")
    b = _user(db, email="b@bonbox.test")
    db.add(Terminal(id=uuid.uuid4(), user_id=a.id, name="Bar A",
                    receipt_label="Term 1"))
    db.commit()
    assert find_terminal_for_label(db, user=b, label="Term 1") is None


def test_auto_route_skips_inactive_terminals(db):
    user = _user(db, vertical="restaurant")
    t = Terminal(id=uuid.uuid4(), user_id=user.id, name="Old bar",
                 receipt_label="Term 1", is_active=False)
    db.add(t); db.commit()
    assert find_terminal_for_label(db, user=user, label="Term 1") is None


def test_auto_route_skips_soft_deleted(db):
    user = _user(db, vertical="restaurant")
    t = Terminal(id=uuid.uuid4(), user_id=user.id, name="Old bar",
                 receipt_label="Term 1", is_deleted=True)
    db.add(t); db.commit()
    assert find_terminal_for_label(db, user=user, label="Term 1") is None
