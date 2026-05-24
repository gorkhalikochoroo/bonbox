"""Tests for the Smart Scan auto-router (smart_scan_service + router).

The Smart Scan feature is the "snap anything" entry point: classify
the upload via the existing Haiku classifier (shipped in #145), route
to the right destination page, and ship pre-extracted JSON. The tests
here pin down the multi-barrier guarantees:

  L3 — router endpoint shape (returns route_to + extracted_data)
  L4 — service defensive: never raises, even on broken inputs
  L6 — unknown / low-confidence routes to manual_picker
  L7 — every classify + every manual override writes an audit row
  L8 — tier-gated features (batch + pdf_direct)
  L9 — image-size limit enforced at router layer

All Anthropic SDK calls are mocked — no live API hits, no network.
"""
from __future__ import annotations

import io
import sys
import types
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.audit_log import AuditLog
from app.models.user import User


# ─── Fake Anthropic SDK shape (copied from test_z_report_extraction) ──

class _FakeBlock:
    def __init__(self, *, type_, text=None, input_=None):
        self.type = type_
        self.text = text
        self.input = input_


class _FakeUsage:
    def __init__(self, input_tokens=100, output_tokens=10):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _FakeResponse:
    def __init__(self, blocks, usage=None):
        self.content = blocks
        self.usage = usage or _FakeUsage()


def _install_fake_anthropic(text_or_callable):
    """Make the anthropic SDK return whatever caller wants.

    `text_or_callable` is either a string ("receipt") for the simple
    classifier path OR a callable(kwargs) -> _FakeResponse.
    """
    fake = types.ModuleType("anthropic")

    class FakeClient:
        def __init__(self, api_key=None, timeout=None):
            self.api_key = api_key
            self.messages = self

        def create(self, **kwargs):
            if callable(text_or_callable):
                return text_or_callable(kwargs)
            return _FakeResponse([_FakeBlock(type_="text", text=text_or_callable)])

    fake.Anthropic = FakeClient
    sys.modules["anthropic"] = fake
    return fake


def _uninstall_fake_anthropic():
    sys.modules.pop("anthropic", None)


# ─── Fixtures ────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def reset_classifier_cache_and_anthropic():
    """The classifier caches by image hash — clear it so tests don't
    accidentally share state. Also drop the fake SDK at teardown."""
    from app.services import claude_vision_ocr
    claude_vision_ocr._CLASSIFIER_CACHE.clear()
    yield
    _uninstall_fake_anthropic()


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


@pytest.fixture
def free_user(db):
    u = User(
        email="manoj@mirabelle.dk",
        password_hash="x",
        business_name="Mirabelle",
        business_type="restaurant",
        currency="DKK",
        plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def starter_user(db):
    u = User(
        email="starter@example.com",
        password_hash="x",
        business_name="Starter",
        business_type="restaurant",
        currency="DKK",
        plan="starter",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def pro_user(db):
    u = User(
        email="pro@example.com",
        password_hash="x",
        business_name="Pro",
        business_type="bar",
        currency="DKK",
        plan="pro",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def jpeg_bytes():
    """Tiny in-memory JPEG so the image-prep code doesn't crash."""
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (200, 300), color="white").save(buf, "JPEG", quality=80)
    return buf.getvalue()


# ─── PLAN_FEATURES matrix ────────────────────────────────────────────

def test_plan_features_smart_scan_matrix():
    """Manoj-confirmed tier matrix:
      Free:    no batch, no pdf-direct (but basic auto-route is universal)
      Starter: batch yes,  pdf-direct no
      Pro:     batch yes,  pdf-direct yes
      Trial:   = Pro (batch yes, pdf-direct yes)
    """
    from app.services.billing import PLAN_FEATURES

    expected = {
        "free":    (False, False),
        "starter": (True,  False),
        "pro":     (True,  True),
        "trial":   (True,  True),
    }
    for plan, (batch, pdf) in expected.items():
        assert PLAN_FEATURES[plan]["smart_scan_batch"] is batch, (
            f"smart_scan_batch wrong for {plan}"
        )
        assert PLAN_FEATURES[plan]["smart_scan_pdf_direct"] is pdf, (
            f"smart_scan_pdf_direct wrong for {plan}"
        )


# ─── Service: classifier routes to the right destination ─────────────

def test_classifier_routes_receipt_to_expenses(monkeypatch, jpeg_bytes):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic("receipt")

    from app.services.smart_scan_service import route_and_extract
    result = route_and_extract(jpeg_bytes)

    assert result["doc_type"] == "receipt"
    assert result["route_to"] == "/expenses"
    assert result["confidence"] >= 0.85


def test_classifier_routes_z_report_to_daily_close(monkeypatch, jpeg_bytes):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic("z_report")

    from app.services.smart_scan_service import route_and_extract
    result = route_and_extract(jpeg_bytes)

    assert result["doc_type"] == "z_report"
    assert result["route_to"] == "/daily-close"
    assert result["confidence"] >= 0.85


def test_classifier_routes_invoice_to_inventory(monkeypatch, jpeg_bytes):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic("invoice")

    from app.services.smart_scan_service import route_and_extract
    result = route_and_extract(jpeg_bytes)

    assert result["doc_type"] == "invoice"
    assert result["route_to"] == "/inventory"
    assert result["confidence"] >= 0.85


# ─── L6 — fail-closed defaults ──────────────────────────────────────

def test_unknown_returns_manual_picker(monkeypatch, jpeg_bytes):
    """Classifier returns "unknown" (and no signals for heuristic) →
    route_to == manual_picker, confidence 0."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic("unknown")

    from app.services.smart_scan_service import route_and_extract
    # No filename, content_type, or dimensions → heuristic stays out
    # of the way (it needs at least one signal to fire).
    result = route_and_extract(jpeg_bytes)

    assert result["doc_type"] == "unknown"
    assert result["route_to"] == "manual_picker"
    assert result["confidence"] == 0.0
    assert result["extracted_data"] is None


def test_missing_api_key_routes_to_manual_picker(monkeypatch, jpeg_bytes):
    """No ANTHROPIC_API_KEY → classifier returns 'unknown' → manual picker."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    # The classifier reads settings.ANTHROPIC_API_KEY too — force empty.
    try:
        from app.config import settings
        monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "", raising=False)
    except Exception:  # noqa: BLE001
        pass

    from app.services.smart_scan_service import route_and_extract
    result = route_and_extract(jpeg_bytes)

    assert result["doc_type"] == "unknown"
    assert result["route_to"] == "manual_picker"


def test_service_never_raises_on_classifier_exception(monkeypatch, jpeg_bytes):
    """Even if classify_document_type explodes, we return a valid shape."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")

    def _boom(image_path):
        raise RuntimeError("simulated network failure")

    monkeypatch.setattr(
        "app.services.claude_vision_ocr.classify_document_type", _boom
    )

    from app.services.smart_scan_service import route_and_extract
    result = route_and_extract(jpeg_bytes)

    assert result["doc_type"] == "unknown"
    assert result["route_to"] == "manual_picker"


def test_empty_bytes_returns_unknown(monkeypatch):
    """Empty upload — no classifier call, no crash."""
    from app.services.smart_scan_service import route_and_extract
    result = route_and_extract(b"")
    assert result["doc_type"] == "unknown"
    assert result["route_to"] == "manual_picker"
    assert result["reason"] == "empty_upload"


def test_image_size_limit_enforced(monkeypatch):
    """Bytes beyond cap → unknown + reason=too_large, no classifier call."""
    from app.services.smart_scan_service import (
        MAX_IMAGE_BYTES, route_and_extract,
    )
    # Use a sentinel so we know the classifier was NOT called.
    called = {"n": 0}

    def _spy(image_path):
        called["n"] += 1
        return "receipt"

    monkeypatch.setattr(
        "app.services.claude_vision_ocr.classify_document_type", _spy
    )

    huge = b"x" * (MAX_IMAGE_BYTES + 1)
    result = route_and_extract(huge)

    assert called["n"] == 0  # classifier was never invoked
    assert result["doc_type"] == "unknown"
    assert result["reason"] == "too_large"


# ─── L8 — heuristic fallback when classifier returns unknown ─────────

def test_heuristic_pdf_routes_to_invoice(monkeypatch, jpeg_bytes):
    """Classifier unknown + PDF content-type → heuristic → invoice."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic("unknown")

    from app.services.smart_scan_service import route_and_extract
    result = route_and_extract(
        jpeg_bytes, filename="bill.pdf", content_type="application/pdf",
    )

    assert result["doc_type"] == "invoice"
    assert result["fallback_used"] == "heuristic"


def test_heuristic_tall_narrow_image_is_z_report(monkeypatch, jpeg_bytes):
    """Aspect ratio > 2.5 → heuristic says z_report (kasserapport roll)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic("unknown")

    from app.services.smart_scan_service import route_and_extract
    result = route_and_extract(
        jpeg_bytes,
        filename="kasse.jpg",
        content_type="image/jpeg",
        image_width=400, image_height=2000,
    )

    assert result["doc_type"] == "z_report"
    assert result["fallback_used"] == "heuristic"


# ─── L6 — low-confidence flagging via verify_hints ───────────────────

def test_low_confidence_fields_appear_in_verify_hints(monkeypatch, jpeg_bytes):
    """When the extractor returns per-field confidences below 0.85,
    those field names show up in verify_hints so the destination page
    can highlight them."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")

    # Classifier path returns "receipt"; extractor path mocked to return
    # a payload with a low-conf field.
    def _route_classify(kwargs):
        # Tiny max_tokens means this is the classifier (max_tokens=10).
        if kwargs.get("max_tokens", 0) <= 20:
            return _FakeResponse([_FakeBlock(type_="text", text="receipt")])
        # Otherwise extractor — but we won't be reached if we mock the
        # extractor at the service level. Fall through just in case.
        return _FakeResponse([_FakeBlock(type_="tool_use", input_={})])

    _install_fake_anthropic(_route_classify)

    fake_extracted = {
        "total": 123.45,
        "confidence_per_field": {
            "total": 0.95,
            "vendor": 0.60,   # below threshold — should hint
            "date":   0.80,   # below threshold — should hint
            "overall": 0.80,
        },
    }

    def _extract_for(doc_type, image_bytes, tmp_path):
        return fake_extracted

    monkeypatch.setattr(
        "app.services.smart_scan_service._extract_for", _extract_for
    )

    from app.services.smart_scan_service import route_and_extract
    result = route_and_extract(jpeg_bytes)

    assert result["doc_type"] == "receipt"
    assert result["route_to"] == "/expenses"
    assert "vendor" in result["verify_hints"]
    assert "date" in result["verify_hints"]
    assert "total" not in result["verify_hints"]
    assert "overall" not in result["verify_hints"]


# ─── L7 — audit rows ────────────────────────────────────────────────

def _write_classify_audit(db, user, result_payload):
    """Use the router's audit helper directly (no TestClient needed)."""
    from app.routers.smart_scan import _log_classify_audit

    class _FakeRequest:
        client = None  # ip_address will be None — fine for audit

    _log_classify_audit(db, user, _FakeRequest(), result_payload, batch_size=1)
    db.commit()


def test_audit_row_written_per_classification(db, free_user):
    """Every classify call leaves an audit_logs row with action
    smart_scan.classified + the detail payload."""
    result_payload = {
        "doc_type": "receipt",
        "confidence": 0.92,
        "route_to": "/expenses",
        "file_size_kb": 42,
        "fallback_used": None,
        "reason": None,
    }
    _write_classify_audit(db, free_user, result_payload)

    rows = db.query(AuditLog).filter(
        AuditLog.user_id == free_user.id,
        AuditLog.action == "smart_scan.classified",
    ).all()
    assert len(rows) == 1
    row = rows[0]
    assert row.entity_type == "smart_scan"
    # The after-state JSON should contain the doc_type / route_to.
    assert "receipt" in (row.after_state or "")
    assert "/expenses" in (row.after_state or "")


def test_audit_row_written_on_manual_override(db, free_user):
    """User clicks "Override" → action=smart_scan.manual_override row."""
    from app.services import audit_service

    audit_service.record(
        db,
        user=free_user,
        action="smart_scan.manual_override",
        entity_type="smart_scan",
        entity_id=None,
        after={
            "original_doc_type": "receipt",
            "chosen_doc_type": "invoice",
            "file_size_kb": 200,
        },
        ip_address="127.0.0.1",
    )
    db.commit()

    rows = db.query(AuditLog).filter(
        AuditLog.user_id == free_user.id,
        AuditLog.action == "smart_scan.manual_override",
    ).all()
    assert len(rows) == 1
    assert "invoice" in (rows[0].after_state or "")


# ─── L4 — tier gates (batch + pdf_direct) ───────────────────────────

def test_batch_upload_gated_to_starter(free_user, starter_user, pro_user):
    """smart_scan_batch is gated to Starter+. Free fails closed,
    Starter and Pro pass."""
    from app.services.billing import has_feature
    assert not has_feature(free_user, "smart_scan_batch")
    assert has_feature(starter_user, "smart_scan_batch")
    assert has_feature(pro_user, "smart_scan_batch")


def test_pdf_direct_gated_to_pro(free_user, starter_user, pro_user):
    """smart_scan_pdf_direct is gated to Pro+. Free + Starter fail closed."""
    from app.services.billing import has_feature
    assert not has_feature(free_user, "smart_scan_pdf_direct")
    assert not has_feature(starter_user, "smart_scan_pdf_direct")
    assert has_feature(pro_user, "smart_scan_pdf_direct")


# ─── L4 — camera-permission denied fallback (frontend semantics
#       enforced via the service contract: when no bytes arrive, we
#       still return a usable shape) ─────────────────────────────────

def test_camera_permission_denied_falls_back_to_upload():
    """If the client can't get camera bytes (permission denied) and
    posts an empty body, the service returns a manual_picker route
    rather than 500ing. The frontend interprets manual_picker as
    'show the 3-button fallback / disk-upload affordance'."""
    from app.services.smart_scan_service import route_and_extract
    result = route_and_extract(b"")
    assert result["route_to"] == "manual_picker"
    assert result["reason"] == "empty_upload"


# ─── L9 — graceful UX: low-confidence still routes ─────────────────

def test_low_confidence_still_routes_with_verify_hints(monkeypatch, jpeg_bytes):
    """When the extractor returns per-field confidence below threshold,
    the user still gets navigated to the right page (route_to is set);
    the verify_hints list tells the destination page which fields to
    highlight. This is the L9 graceful-UI guarantee."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic("receipt")

    fake_extracted = {
        "total": 100.0,
        "confidence_per_field": {
            "total": 0.50,    # very low
            "vendor": 0.50,   # very low
            "overall": 0.50,
        },
    }
    monkeypatch.setattr(
        "app.services.smart_scan_service._extract_for",
        lambda *a, **kw: fake_extracted,
    )

    from app.services.smart_scan_service import route_and_extract
    result = route_and_extract(jpeg_bytes)

    # Still routed (not stuck on manual picker)
    assert result["route_to"] == "/expenses"
    # But verify_hints is populated so the page can highlight uncertain fields
    assert len(result["verify_hints"]) >= 2


# ─── Shape sanity — every response has the required keys ────────────

def test_response_shape_is_stable(monkeypatch, jpeg_bytes):
    """The router contract — every response from route_and_extract has
    the documented keys. Pin this so a future refactor can't silently
    rename `route_to` to `target` etc."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic("receipt")

    from app.services.smart_scan_service import route_and_extract
    result = route_and_extract(jpeg_bytes)

    required_keys = {
        "doc_type", "confidence", "route_to", "route_label",
        "extracted_data", "fallback_used", "file_size_kb",
        "verify_hints", "reason",
    }
    assert required_keys.issubset(result.keys())
