"""Tier-gate coverage for the supplier auto-detection feature.

Retroactively gates the supplier-dictionary + auto-categorization layer
shipped in commit 142e278 to Starter+, while Free continues to receive
the generic Claude Vision inventory extraction. Follows the multi-barrier
defense doctrine — every layer that touches the feature is asserted here:

  • L3 (router)  — POST /api/inventory/smart-import/file image as Free
                   returns supplier_match=None even when the underlying
                   inventory_ocr extraction surfaces a Hørkram match.
  • L3 (router)  — Same POST as Starter / Pro / Trial returns the full
                   enrichment (supplier_match.canonical set, per-line
                   category populated).
  • L4 (service) — enrich_with_supplier(..., user=free) short-circuits
                   even when called directly, so a future caller that
                   bypasses the router gate still can't leak the feature.
  • L6 (caps)    — PLAN_FEATURES["supplier_auto_detection"] = False on
                   Free + trial=True on starter/pro/trial.
  • L7 (audit)   — A SecurityEvent row with
                   event_type='gate_skipped.supplier_auto_detection' is
                   written when Free hits the gate.

The Claude Vision call itself is mocked — same pattern as
test_inventory_ocr.py. We install a fake `anthropic` SDK whose
Messages.create returns a canned Hørkram tool_use block, then drive the
router through TestClient.
"""
from __future__ import annotations

import io
import sys
import types
import uuid

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.security_event import SecurityEvent
from app.models.user import User
from app.services import inventory_ocr
from app.services.auth import get_current_user, hash_password
from app.services.billing import PLAN_FEATURES, has_feature


_db_ready.set()


# ─── Shared in-memory DB + TestClient fixture ──────────────────────────


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
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session, monkeypatch):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db

    # billing._record_gate_refusal opens its OWN short-lived SessionLocal
    # via app.database.SessionLocal — point that at the in-memory engine
    # too so the SecurityEvent rows land where the assertions can see
    # them. Without this the audit write succeeds against a different
    # connection and the test sees zero rows.
    monkeypatch.setattr("app.services.billing.SessionLocal", SessionLocal, raising=False)
    # Some pythonpath layouts expose the symbol via app.database too —
    # patch defensively so the helper finds the test session either way.
    import app.database as _db_mod
    monkeypatch.setattr(_db_mod, "SessionLocal", SessionLocal, raising=False)

    # Reset slowapi rate limiter on the smart-import router between
    # tests so back-to-back uploads don't 429.
    try:
        from app.routers.inventory_smart_import import _limiter
        _limiter.reset()
    except Exception:
        pass

    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User | None):
    if user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = lambda: user


def _user(db, *, plan: str = "free", email: str = "owner@bonbox.dk") -> User:
    u = User(
        email=email,
        password_hash=hash_password("pw"),
        business_name="Mirabelle",
        business_type="restaurant",
        currency="DKK",
        plan=plan,
        role="owner",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


# ─── Fake anthropic SDK — same pattern as test_inventory_ocr.py ───────


class _FakeBlock:
    def __init__(self, btype: str, **kwargs):
        self.type = btype
        for k, v in kwargs.items():
            setattr(self, k, v)


class _FakeUsage:
    def __init__(self, input_tokens=1000, output_tokens=400):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _FakeResponse:
    def __init__(self, content, usage=None):
        self.content = content
        self.usage = usage or _FakeUsage()


class _FakeMessages:
    def __init__(self, response):
        self._response = response

    def create(self, **_kwargs):
        return self._response


def _install_fake_anthropic(monkeypatch, payload: dict) -> None:
    """Patch ``import anthropic`` so inventory_ocr's call returns the
    canned Hørkram payload via a tool_use block."""
    fake_module = types.ModuleType("anthropic")
    response = _FakeResponse(content=[_FakeBlock("tool_use", input=payload)])

    class _Client:
        def __init__(self, *_args, **_kwargs):
            self.messages = _FakeMessages(response)

    fake_module.Anthropic = _Client
    monkeypatch.setitem(sys.modules, "anthropic", fake_module)


def _make_jpeg_bytes(size=(64, 64)) -> bytes:
    img = Image.new("RGB", size, color=(255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def _horkram_payload() -> dict:
    """Canned extraction shaped like a Hørkram delivery slip — would
    hit the supplier dict if enrichment ran."""
    return {
        "doc_type": "delivery_slip",
        "supplier": {
            "name": "Hørkram Foodservice A/S",
            "cvr": "12345678",
            "invoice_number": "INV-2026-00042",
            "invoice_date": "2026-05-24",
        },
        "line_items": [
            {
                "name": "Oksefilet 200g",
                "qty": 10,
                "unit": "stk",
                "unit_cost": 45.50,
                "vat_rate": 0.25,
                "confidence": 0.94,
            },
            {
                "name": "Røget Laks Slices 150g",
                "qty": 5,
                "unit": "pakke",
                "unit_cost": 32.50,
                "vat_rate": 0.25,
                "confidence": 0.91,
            },
        ],
        "invoice_totals": {
            "subtotal": 617.50,
            "vat_total": 154.38,
            "grand_total": 771.88,
            "currency": "DKK",
        },
        "confidence": {
            "supplier_name": 0.99,
            "cvr": 0.97,
            "line_items": 0.93,
            "totals": 0.99,
            "overall": 0.96,
        },
        "notes": None,
    }


def _post_invoice_image(client: TestClient) -> dict:
    """POST a fake supplier-invoice image to the smart-import endpoint
    and return the parsed JSON response. Helper de-duplicates the call
    setup across the per-tier assertions."""
    files = {"file": ("horkram.jpg", _make_jpeg_bytes(), "image/jpeg")}
    res = client.post(
        "/api/inventory/smart-import/file",
        files=files,
        data={"source_kind": "image"},
    )
    assert res.status_code in (200, 201), (
        f"unexpected status={res.status_code} body={res.text}"
    )
    return res.json()


# ─── L6 — PLAN_FEATURES contract ───────────────────────────────────────


def test_supplier_auto_detection_present_on_every_plan():
    """Every plan must declare the flag explicitly so adding a new tier
    can't silently fall through to free's value. Same contract as
    schedule_autopilot / inventory_autopilot."""
    for plan in ("free", "starter", "trial", "pro"):
        assert "supplier_auto_detection" in PLAN_FEATURES[plan], (
            f"Plan {plan} missing supplier_auto_detection key"
        )
    assert PLAN_FEATURES["free"]["supplier_auto_detection"] is False
    assert PLAN_FEATURES["starter"]["supplier_auto_detection"] is True
    assert PLAN_FEATURES["trial"]["supplier_auto_detection"] is True
    assert PLAN_FEATURES["pro"]["supplier_auto_detection"] is True


# ─── L3 — Router gate, per-tier ────────────────────────────────────────


def test_free_user_gets_extraction_without_supplier_match(
    client, db, monkeypatch,
):
    """Free tier: line items still come through (generic Claude inventory
    OCR works) but supplier_match is None even when the Hørkram dict
    match would otherwise succeed. Category is NOT auto-populated."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic(monkeypatch, _horkram_payload())

    user = _user(db, plan="free")
    _override_user(user)

    body = _post_invoice_image(client)

    # The L3 gate must NOT block extraction — line items still flow.
    assert body["item_count"] == 2
    assert any("oksefilet" in (it.get("name") or "").lower() for it in body["items"])

    # But the supplier dictionary match is suppressed.
    assert body["supplier_match"] is None
    # supplier header itself (raw extraction) is allowed through — only
    # the dictionary canonicalisation + category enrichment is gated.
    assert body.get("supplier") is not None
    assert body["supplier"].get("name", "").lower().startswith("hørkram")

    # No item should carry an auto-detected category from the supplier
    # dictionary. (The generic categorizer may still tag items via its
    # own keyword rules — we only assert that supplier-derived
    # category_confidence isn't attached.)
    for it in body["items"]:
        assert "category_confidence" not in it, (
            f"Free user got supplier-derived category_confidence on item: {it}"
        )


def test_starter_user_gets_full_enrichment(client, db, monkeypatch):
    """Starter: supplier_match resolved to Hørkram + per-item categories
    populated (meat / fish via the Danish keyword hints)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic(monkeypatch, _horkram_payload())

    user = _user(db, plan="starter", email="starter@bonbox.dk")
    _override_user(user)

    body = _post_invoice_image(client)

    assert body["supplier_match"] is not None
    assert body["supplier_match"]["canonical"] == "hørkram"

    # Per-line category hints — confidence comes from
    # categorize_line_item() which returns 0.85 on a Danish-keyword hit.
    cats = {(it.get("name") or "").lower(): it.get("category") for it in body["items"]}
    assert any("meat" in (v or "") for v in cats.values()) or any(
        "fish" in (v or "") for v in cats.values()
    ), f"expected meat/fish auto-category on Starter, got {cats}"


def test_pro_user_gets_full_enrichment(client, db, monkeypatch):
    """Pro mirrors Starter for this feature — same enrichment shape."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic(monkeypatch, _horkram_payload())

    user = _user(db, plan="pro", email="pro@bonbox.dk")
    _override_user(user)

    body = _post_invoice_image(client)

    assert body["supplier_match"] is not None
    assert body["supplier_match"]["canonical"] == "hørkram"


def test_trial_user_gets_full_enrichment(client, db, monkeypatch):
    """Trial == full Pro entitlements — supplier auto-detection unlocked
    for the 14-day window."""
    from datetime import timedelta
    from app.utils.time import utc_now

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic(monkeypatch, _horkram_payload())

    user = _user(db, plan="free", email="trialist@bonbox.dk")
    user.trial_ends_at = utc_now() + timedelta(days=7)
    db.add(user)
    db.commit()
    db.refresh(user)
    # Sanity check effective plan really resolves to trial.
    assert has_feature(user, "supplier_auto_detection") is True
    _override_user(user)

    body = _post_invoice_image(client)
    assert body["supplier_match"] is not None
    assert body["supplier_match"]["canonical"] == "hørkram"


# ─── L4 — service-layer defensive gate ─────────────────────────────────


def test_enrich_with_supplier_respects_user_param(db):
    """L4 defensive layer: calling enrich_with_supplier directly with a
    Free user must NOT attach supplier_match or per-item category, even
    though the function is otherwise public. Catches any future caller
    that forgets the router-level L3 gate."""
    free = _user(db, plan="free", email="l4-free@bonbox.dk")
    starter = _user(db, plan="starter", email="l4-starter@bonbox.dk")

    raw_free = {
        "supplier": {"name": "Hørkram Foodservice A/S", "cvr": "12345678"},
        "line_items": [
            {"name": "Oksefilet 200g", "qty": 10},
            {"name": "Røget Laks Slices 150g", "qty": 5},
        ],
    }
    raw_starter = {
        "supplier": {"name": "Hørkram Foodservice A/S", "cvr": "12345678"},
        "line_items": [
            {"name": "Oksefilet 200g", "qty": 10},
            {"name": "Røget Laks Slices 150g", "qty": 5},
        ],
    }

    out_free = inventory_ocr.enrich_with_supplier(raw_free, user=free)
    out_starter = inventory_ocr.enrich_with_supplier(raw_starter, user=starter)

    # Free: NO supplier_match attached, NO category fields.
    assert "supplier_match" not in out_free
    for it in out_free["line_items"]:
        assert "category" not in it
        assert "category_confidence" not in it

    # Starter: full enrichment as before the gate.
    assert out_starter["supplier_match"] is not None
    assert out_starter["supplier_match"]["canonical"] == "hørkram"
    for it in out_starter["line_items"]:
        assert "category" in it
        assert "category_confidence" in it


def test_enrich_with_supplier_user_none_still_enriches():
    """Backward compatibility: passing user=None (the default) leaves
    the original behaviour intact for tests / CLI scripts / admin tools
    that legitimately have no user context."""
    raw = {
        "supplier": {"name": "Hørkram Foodservice A/S", "cvr": "12345678"},
        "line_items": [{"name": "Oksefilet 200g", "qty": 10}],
    }
    out = inventory_ocr.enrich_with_supplier(raw)  # no user kwarg
    assert out["supplier_match"] is not None
    assert out["supplier_match"]["canonical"] == "hørkram"
    assert out["line_items"][0]["category"] == "meat"


# ─── L7 — audit row ────────────────────────────────────────────────────


def test_security_event_written_on_free_gate_skip(client, db, monkeypatch):
    """Every L3 gate skip writes a SecurityEvent row with event_type
    `gate_skipped.supplier_auto_detection`. Lets Manoj observe how
    often the upgrade upsell would have fired this week."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic(monkeypatch, _horkram_payload())

    user = _user(db, plan="free", email="audit-free@bonbox.dk")
    _override_user(user)

    _post_invoice_image(client)

    rows = (
        db.query(SecurityEvent)
        .filter(SecurityEvent.event_type == "gate_skipped.supplier_auto_detection")
        .filter(SecurityEvent.user_id == user.id)
        .all()
    )
    assert len(rows) >= 1, (
        "expected at least one gate_skipped.supplier_auto_detection "
        "SecurityEvent row for the Free-tier audit"
    )
    # Detail JSON should carry the upgrade-to hint so an analytics
    # dashboard can pivot on "free users we'd convert to starter".
    detail = rows[0].detail or ""
    assert "supplier_auto_detection" in detail
    assert "starter" in detail.lower()


def test_no_security_event_when_starter_uses_feature(client, db, monkeypatch):
    """Starter tier USES the feature, so no `gate_skipped` row should be
    written — only the gate path should audit. (Refusal counts should
    reflect Free-tier traffic only.)"""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic(monkeypatch, _horkram_payload())

    user = _user(db, plan="starter", email="audit-starter@bonbox.dk")
    _override_user(user)

    _post_invoice_image(client)

    rows = (
        db.query(SecurityEvent)
        .filter(SecurityEvent.event_type == "gate_skipped.supplier_auto_detection")
        .filter(SecurityEvent.user_id == user.id)
        .all()
    )
    assert rows == [], (
        f"Starter user should not produce gate_skipped rows; got {len(rows)}"
    )
