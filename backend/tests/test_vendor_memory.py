"""Per-vendor memory — slice 1.

The product claim: the 2nd/3rd scan of a supplier you've already
confirmed arrives pre-filled, and BonBox can say why in countable terms
("kort — som de sidste 3 gange hos Netto").

The claim that matters more: it is never confidently wrong. These tests
pin the asymmetry that buys that — one correction outranks several
confirmations, paper always beats memory, and a batch sweep mints no
evidence at all.

Covers:
  (a) canonical_vendor_key — one key space for every spelling, None for junk.
  (b) The band rule at n=0/1/2/3, and after a disagreement.
  (c) record_signal correction semantics: the OLD value takes the
      disagreement and a sit-out; the NEW value starts at streak 1
      rather than inheriting the old value's trust.
  (d) kind="batch" records nothing — auto-fill must not validate itself.
  (e) THE REGRESSION TEST: scan -> correct -> confirm x3 -> the 4th scan
      prefills the corrected value, and the originally-wrong value still
      carries disagree_count=1 / streak=0. This is the bug that made the
      existing category_mappings loop forget corrections.
  (f) update_expense records against the STORED vendor_key, not a
      re-derived description.
  (g) recall winner is chosen by live streak, not lifetime count.

Run:
  cd backend && python3 -m pytest tests/test_vendor_memory.py -q
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.models.vendor_profile import VendorProfile
from app.routers.expenses import _limiter as _exp_limiter
from app.services.auth import get_current_user
from app.services.vendor_identity import canonical_vendor_key, display_name_for
from app.services.vendor_memory import (
    recall, record_signal, forget_vendor,
    BAND_NONE, BAND_SUGGEST, BAND_PREFILL,
)
from app.utils.time import utc_now

_db_ready.set()
_exp_limiter.enabled = False


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

    try:
        app.state.limiter.reset()
    except Exception:
        pass
    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db) -> User:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name="Café Hygge",
        business_type="cafe", currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _cat(db, user, name) -> ExpenseCategory:
    c = ExpenseCategory(user_id=user.id, name=name)
    db.add(c); db.commit(); db.refresh(c)
    return c


def _row(db, user, key, field, value) -> VendorProfile | None:
    return db.query(VendorProfile).filter(
        VendorProfile.user_id == user.id, VendorProfile.vendor_key == key,
        VendorProfile.field == field, VendorProfile.value == value,
    ).first()


# ── (a) one key space ────────────────────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("Føtex", "fotex"), ("FOETEX", "fotex"), ("Fotex", "fotex"), ("føtex A/S", "fotex"),
    ("Netto", "netto"), ("NETTO 1284 LYNGBY", "netto lyngby"),
    ("REMA 1000 nr. 412", "rema"), ("Cafe Noir ApS", "cafe noir"),
    ("CVR 12345678 Bilka", "bilka"), ("Restaurant Måler I/S", "restaurant maler"),
    ("Århus Kaffe", "arhus kaffe"), ("Aarhus Kaffe", "arhus kaffe"),
])
def test_canonical_vendor_key_collapses_spellings(raw, expected):
    assert canonical_vendor_key(raw) == expected


@pytest.mark.parametrize("raw", ["", "  ", None, "1234", "ab", "42", "kr.", 12345])
def test_canonical_vendor_key_rejects_junk(raw):
    """None means 'don't learn from this' — a junk key would accrue
    evidence across unrelated suppliers."""
    assert canonical_vendor_key(raw) is None


def test_display_name_uses_owner_words_not_the_key():
    assert display_name_for("Føtex A/S") == "Føtex A/S"
    assert display_name_for(None, "fotex") == "Fotex"


# ── (b) the band rule ────────────────────────────────────────────────

def test_band_progression_none_suggest_prefill(db):
    u = _owner(db)
    # n=0 → nothing known
    assert recall(db, u.id, "netto") == {}

    # n=1 → still nothing. One sighting is not a habit.
    record_signal(db, u.id, "netto", "payment_method", "card", kind="confirm")
    db.commit()
    assert recall(db, u.id, "netto")["payment_method"]["band"] == BAND_NONE

    # n=2 → suggest (highlight, do NOT preselect)
    record_signal(db, u.id, "netto", "payment_method", "card", kind="confirm")
    db.commit()
    assert recall(db, u.id, "netto")["payment_method"]["band"] == BAND_SUGGEST

    # n=3, streak 3 → prefill
    record_signal(db, u.id, "netto", "payment_method", "card", kind="confirm")
    db.commit()
    mem = recall(db, u.id, "netto")["payment_method"]
    assert mem["band"] == BAND_PREFILL
    assert mem["agree"] == 3 and mem["streak"] == 3


def test_stale_habit_stops_autofilling(db):
    u = _owner(db)
    for _ in range(5):
        record_signal(db, u.id, "netto", "payment_method", "card", kind="confirm")
    db.commit()
    assert recall(db, u.id, "netto")["payment_method"]["band"] == BAND_PREFILL

    row = _row(db, u, "netto", "payment_method", "card")
    row.last_agree_at = utc_now() - timedelta(days=400)
    db.commit()
    # A habit older than a year is a guess about a business that moved on.
    assert recall(db, u.id, "netto")["payment_method"]["band"] == BAND_NONE


def test_locked_vendor_never_autofills(db):
    u = _owner(db)
    for _ in range(5):
        record_signal(db, u.id, "netto", "payment_method", "card", kind="confirm")
    db.commit()
    forget_vendor(db, u.id, "netto")
    db.commit()
    assert recall(db, u.id, "netto")["payment_method"]["band"] == BAND_NONE


# ── (c) the correction asymmetry ─────────────────────────────────────

def test_correction_marks_the_old_value_and_restarts_the_new(db):
    u = _owner(db)
    for _ in range(4):
        record_signal(db, u.id, "netto", "payment_method", "card", kind="confirm")
    db.commit()
    assert recall(db, u.id, "netto")["payment_method"]["band"] == BAND_PREFILL

    record_signal(db, u.id, "netto", "payment_method", "cash",
                  kind="correction", previous_value="card")
    db.commit()

    old = _row(db, u, "netto", "payment_method", "card")
    new = _row(db, u, "netto", "payment_method", "cash")
    assert old.disagree_count == 1 and old.streak == 0
    assert old.demote_sightings > 0, "corrected value must sit out, not just lose streak"
    # The corrected value earns trust from scratch — inheriting the old
    # value's streak would let one tap immediately re-arm auto-fill.
    assert new.agree_count == 1 and new.streak == 1
    assert recall(db, u.id, "netto")["payment_method"]["band"] == BAND_NONE


def test_one_correction_outranks_several_confirmations(db):
    """The whole safety property in one assertion."""
    u = _owner(db)
    for _ in range(5):
        record_signal(db, u.id, "netto", "category_name", "Vareforbrug", kind="confirm")
    db.commit()
    record_signal(db, u.id, "netto", "category_name", "Emballage",
                  kind="correction", previous_value="Vareforbrug")
    db.commit()
    # Five agreements do not outvote one correction.
    assert recall(db, u.id, "netto")["category_name"]["band"] == BAND_NONE


def test_demotion_blocks_the_rejected_value_not_the_relearned_one(db):
    """Demotion is scoped to the value the owner REJECTED.

    Design choice, stated explicitly because the alternative is
    defensible too: after a correction we do NOT hold the whole
    vendor+field hostage for N sightings. The corrected value already
    restarts at streak 1, so it cannot auto-fill immediately — it has to
    clear the same 3-agreement bar as anything else. Making the owner
    ALSO wait out a sit-out after they told us the right answer would
    read as "I keep telling it card and it never learns", which is the
    failure mode that makes people stop correcting at all.

    What the sit-out does buy: the rejected value cannot win the recall
    on lifetime count while it is serving its demotion.
    """
    u = _owner(db)
    for _ in range(4):
        record_signal(db, u.id, "netto", "payment_method", "cash", kind="confirm")
    db.commit()
    record_signal(db, u.id, "netto", "payment_method", "card",
                  kind="correction", previous_value="cash")
    db.commit()

    # Immediately after the correction nothing auto-fills: the new value
    # is at streak 1, the old one is demoted.
    assert recall(db, u.id, "netto")["payment_method"]["band"] == BAND_NONE
    assert _row(db, u, "netto", "payment_method", "cash").demote_sightings > 0

    # The owner confirms the corrected value three times -> it earns prefill.
    for _ in range(3):
        record_signal(db, u.id, "netto", "payment_method", "card", kind="confirm")
    db.commit()
    mem = recall(db, u.id, "netto")["payment_method"]
    assert mem["value"] == "card" and mem["band"] == BAND_PREFILL

    # The rejected value still carries its mark and never silently returns.
    assert _row(db, u, "netto", "payment_method", "cash").disagree_count == 1


def test_demoted_value_cannot_win_recall_while_serving_its_sit_out(db):
    """The sit-out's actual job: a rejected value with a big lifetime
    count must not reclaim the winner slot on the very next scan."""
    u = _owner(db)
    for _ in range(6):
        record_signal(db, u.id, "netto", "category_name", "Vareforbrug", kind="confirm")
    db.commit()
    record_signal(db, u.id, "netto", "category_name", "Emballage",
                  kind="correction", previous_value="Vareforbrug")
    db.commit()

    row = _row(db, u, "netto", "category_name", "Vareforbrug")
    assert row.streak == 0 and row.demote_sightings > 0
    mem = recall(db, u.id, "netto")["category_name"]
    assert mem["value"] == "Emballage", "the rejected value must not win on lifetime count"
    assert mem["band"] == BAND_NONE

    # And the sit-out is consumed by real sightings, not by wall-clock.
    before = _row(db, u, "netto", "category_name", "Vareforbrug").demote_sightings
    recall(db, u.id, "netto", consume_demotion=True)
    db.commit()
    assert _row(db, u, "netto", "category_name", "Vareforbrug").demote_sightings == before - 1


# ── (d) a batch sweep is not evidence ────────────────────────────────

def test_batch_approval_grants_no_evidence(db):
    """One tap on 'Godkend alle 8' must not mint 8 agreements, or the
    loop validates itself: auto-fill -> batch approve -> streak -> more
    auto-fill, with the owner never having looked."""
    u = _owner(db)
    for _ in range(8):
        record_signal(db, u.id, "netto", "payment_method", "card", kind="batch")
    db.commit()
    assert recall(db, u.id, "netto") == {}
    assert _row(db, u, "netto", "payment_method", "card") is None


# ── (g) winner selection ─────────────────────────────────────────────

def test_recall_winner_is_live_streak_not_lifetime_count(db):
    """A value corrected yesterday can still hold the highest lifetime
    count. Re-applying it is exactly the confidently-wrong failure this
    feature exists to avoid."""
    u = _owner(db)
    for _ in range(6):
        record_signal(db, u.id, "netto", "payment_method", "card", kind="confirm")
    db.commit()
    record_signal(db, u.id, "netto", "payment_method", "cash",
                  kind="correction", previous_value="card")
    db.commit()
    for _ in range(3):
        record_signal(db, u.id, "netto", "payment_method", "cash", kind="confirm")
    db.commit()

    card = _row(db, u, "netto", "payment_method", "card")
    cash = _row(db, u, "netto", "payment_method", "cash")
    assert card.agree_count > cash.agree_count, "card still leads on lifetime count"
    assert recall(db, u.id, "netto")["payment_method"]["value"] == "cash"


def test_memory_is_account_scoped(db):
    """No cross-tenant learning — user_id is NOT NULL by construction."""
    a, b = _owner(db), _owner(db)
    for _ in range(5):
        record_signal(db, a.id, "netto", "payment_method", "card", kind="confirm")
    db.commit()
    assert recall(db, b.id, "netto") == {}


# ── (e)+(f) end to end through the API ───────────────────────────────

def test_scan_correct_then_confirmations_flip_the_prefill(client, db):
    """THE REGRESSION TEST. Save with a wrong proposal, correct it, then
    confirm the corrected value until it earns prefill — and the
    originally-wrong value must still carry its disagreement."""
    u = _owner(db)
    _cat(db, u, "Vareforbrug")
    _cat(db, u, "Emballage")
    app.dependency_overrides[get_current_user] = lambda: u

    def _save(method, cat_name, proposed=None):
        cat = db.query(ExpenseCategory).filter(
            ExpenseCategory.user_id == u.id, ExpenseCategory.name == cat_name).one()
        body = {
            "amount": 199.0, "description": "Netto", "vendor_hint": "NETTO 1284 LYNGBY",
            "date": date.today().isoformat(), "payment_method": method,
            "category_id": str(cat.id),
        }
        if proposed:
            body["autofill"] = proposed
        r = client.post("/api/expenses", json=body)
        assert r.status_code in (200, 201), r.text
        return r.json()

    # 1st save: nothing proposed, owner picks cash + Vareforbrug.
    _save("cash", "Vareforbrug")
    key = canonical_vendor_key("NETTO 1284 LYNGBY")
    assert db.query(Expense).filter(Expense.user_id == u.id).one().vendor_key == key

    # 2nd save: we PROPOSED cash, owner overrode to card. That is a
    # correction, not a confirmation — recording it as agreement is how
    # a streak gets poisoned into auto-filling a rejected value.
    _save("card", "Vareforbrug", proposed={"payment_method": "cash"})
    cash_row = _row(db, u, key, "payment_method", "cash")
    assert cash_row.disagree_count == 1 and cash_row.streak == 0

    # Three clean confirmations of the corrected value.
    for _ in range(3):
        _save("card", "Vareforbrug", proposed={"payment_method": "card"})

    mem = recall(db, u.id, key)
    assert mem["payment_method"]["value"] == "card"
    assert mem["payment_method"]["agree"] >= 3
    # And the wrong value never quietly recovers.
    assert _row(db, u, key, "payment_method", "cash").disagree_count == 1


def test_update_expense_records_against_stored_key_not_description(client, db):
    """A correction must land on the key that MADE the suggestion. If we
    re-derived from the (owner-editable) description, an owner who also
    retitles the row would teach a vendor that never guessed."""
    u = _owner(db)
    c1, c2 = _cat(db, u, "Vareforbrug"), _cat(db, u, "Emballage")
    app.dependency_overrides[get_current_user] = lambda: u

    r = client.post("/api/expenses", json={
        "amount": 120.0, "description": "Netto", "vendor_hint": "Netto",
        "date": date.today().isoformat(), "payment_method": "card",
        "category_id": str(c1.id),
    })
    assert r.status_code in (200, 201), r.text
    exp_id = r.json()["id"]

    # Owner re-categorises AND retitles in one edit.
    r2 = client.put(f"/api/expenses/{exp_id}", json={
        "category_id": str(c2.id), "description": "Noget helt andet",
    })
    assert r2.status_code == 200, r2.text

    # The correction landed on 'netto' — the stored key.
    assert _row(db, u, "netto", "category_name", "Emballage").agree_count == 1
    assert _row(db, u, "netto", "category_name", "Vareforbrug").disagree_count == 1
    # ...and nothing was written under the new description.
    assert _row(db, u, canonical_vendor_key("Noget helt andet"), "category_name", "Emballage") is None


def test_payment_method_change_via_update_is_a_correction(client, db):
    u = _owner(db)
    c1 = _cat(db, u, "Vareforbrug")
    app.dependency_overrides[get_current_user] = lambda: u

    r = client.post("/api/expenses", json={
        "amount": 80.0, "description": "Rema", "vendor_hint": "REMA 1000",
        "date": date.today().isoformat(), "payment_method": "card",
        "category_id": str(c1.id),
    })
    exp_id = r.json()["id"]
    client.put(f"/api/expenses/{exp_id}", json={"payment_method": "cash"})

    assert _row(db, u, "rema", "payment_method", "card").disagree_count == 1
    assert _row(db, u, "rema", "payment_method", "cash").agree_count == 1


def test_expense_without_vendor_key_never_writes_memory(client, db):
    """A junk vendor must not accrue evidence under a junk key."""
    u = _owner(db)
    c1 = _cat(db, u, "Vareforbrug")
    app.dependency_overrides[get_current_user] = lambda: u
    r = client.post("/api/expenses", json={
        "amount": 50.0, "description": "42", "vendor_hint": "42",
        "date": date.today().isoformat(), "payment_method": "cash",
        "category_id": str(c1.id),
    })
    assert r.status_code in (200, 201), r.text
    assert db.query(VendorProfile).filter(VendorProfile.user_id == u.id).count() == 0


# ── The /upload-receipt contract: what the confirm screen is told ────
#
# These are the tests the browser can't do locally (dev has no OCR API
# keys, so `vendor` comes back None and the memory branch is never
# reached). Monkeypatching the parse result exercises the real endpoint.

def _fake_parse(**over):
    base = {
        "vendor": "NETTO 1284 LYNGBY", "amount": 248.5, "date": "2026-07-24",
        "currency": "DKK", "raw_text": "", "ocr_available": True,
        "confidence": "high", "confidence_per_field": {}, "claude_notes": None,
        "vat_amount": None, "vat_rate": None, "line_items": [],
        "payment_method": None, "_provider": "test",
    }
    base.update(over)
    return base


@pytest.fixture
def scan_client(client, monkeypatch):
    import app.routers.expenses as exp_router
    monkeypatch.setattr(
        exp_router, "save_receipt_photo",
        lambda *a, **k: "uploads/receipts/x.jpg", raising=False,
    )
    return client


def _upload(client):
    return client.post(
        "/api/expenses/upload-receipt",
        files={"file": ("k.jpg", b"\xff\xd8\xff\xe0fake", "image/jpeg")},
    )


def test_upload_returns_learned_payment_when_receipt_is_silent(scan_client, db, monkeypatch):
    import app.services.receipt_ocr as ocr
    u = _owner(db)
    _cat(db, u, "Vareforbrug")
    app.dependency_overrides[get_current_user] = lambda: u

    key = canonical_vendor_key("NETTO 1284 LYNGBY")
    for _ in range(3):
        record_signal(db, u.id, key, "payment_method", "card",
                      kind="confirm", display_name="NETTO 1284 LYNGBY")
    db.commit()

    monkeypatch.setattr(ocr, "parse_expense_receipt", lambda p: _fake_parse(), raising=False)
    monkeypatch.setattr(ocr, "save_receipt_photo", lambda *a, **k: "uploads/receipts/x.jpg", raising=False)

    r = _upload(scan_client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["vendor_key"] == key
    lp = body["learned_payment_method"]
    assert lp is not None
    assert lp["value"] == "card"
    assert lp["source"] == "learned"      # never "detected"
    assert lp["band"] == "prefill"
    assert lp["evidence_n"] == 3          # the raw count, not a score
    assert lp["vendor_label"] == "NETTO 1284 LYNGBY"


def test_paper_beats_memory(scan_client, db, monkeypatch):
    """The receipt printed 'Kontant'. Memory says card, 9 times. The
    receipt wins, and no 'you usually...' line is offered at all."""
    import app.services.receipt_ocr as ocr
    u = _owner(db)
    _cat(db, u, "Vareforbrug")
    app.dependency_overrides[get_current_user] = lambda: u

    key = canonical_vendor_key("NETTO 1284 LYNGBY")
    for _ in range(9):
        record_signal(db, u.id, key, "payment_method", "card", kind="confirm")
    db.commit()

    monkeypatch.setattr(
        ocr, "parse_expense_receipt",
        lambda p: _fake_parse(payment_method="cash"), raising=False,
    )
    monkeypatch.setattr(ocr, "save_receipt_photo", lambda *a, **k: "uploads/receipts/x.jpg", raising=False)

    body = _upload(scan_client).json()
    assert body["suggested_payment_method"] == "cash"
    assert body["learned_payment_method"] is None, "memory must not be consulted or rendered"


def test_legacy_keyword_suggestion_can_never_prefill(scan_client, db, monkeypatch):
    """The old 0.9/0.7/0.6 numbers are hardcoded constants, not measured
    accuracy. They may suggest; they must never auto-fill."""
    import app.services.receipt_ocr as ocr
    u = _owner(db)
    _cat(db, u, "Ingredients")   # DEFAULT_KEYWORDS maps "netto" -> Ingredients
    app.dependency_overrides[get_current_user] = lambda: u

    monkeypatch.setattr(ocr, "parse_expense_receipt",
                        lambda p: _fake_parse(vendor="Netto"), raising=False)
    monkeypatch.setattr(ocr, "save_receipt_photo", lambda *a, **k: "uploads/receipts/x.jpg", raising=False)

    sc = _upload(scan_client).json()["suggested_category"]
    assert sc is not None
    assert sc["source"] == "keyword"
    assert sc["band"] == "suggest", "cold-start keywords must never auto-fill"


def test_two_sightings_only_suggests(scan_client, db, monkeypatch):
    import app.services.receipt_ocr as ocr
    u = _owner(db)
    _cat(db, u, "Vareforbrug")
    app.dependency_overrides[get_current_user] = lambda: u

    key = canonical_vendor_key("NETTO 1284 LYNGBY")
    for _ in range(2):
        record_signal(db, u.id, key, "payment_method", "card", kind="confirm")
    db.commit()

    monkeypatch.setattr(ocr, "parse_expense_receipt", lambda p: _fake_parse(), raising=False)
    monkeypatch.setattr(ocr, "save_receipt_photo", lambda *a, **k: "uploads/receipts/x.jpg", raising=False)

    lp = _upload(scan_client).json()["learned_payment_method"]
    assert lp["band"] == "suggest", "two sightings is a hint, not a habit"


# ── Regressions the adversarial review caught ────────────────────────

def test_from_receipt_endpoint_still_works(client, db):
    """ExpenseCreate gained vendor_hint/autofill, which are NOT columns.
    This endpoint splats the whole dump into Expense(), so every new
    schema field is a live 500 until it's excluded."""
    u = _owner(db)
    c = _cat(db, u, "Vareforbrug")
    app.dependency_overrides[get_current_user] = lambda: u
    r = client.post("/api/expenses/from-receipt", json={
        "amount": 120.0, "description": "Netto", "date": date.today().isoformat(),
        "payment_method": "cash", "category_id": str(c.id),
    })
    assert r.status_code in (200, 201), r.text


def test_unsent_payment_method_is_never_learned(client, db):
    """QuickAdd's expense tab has no payment-method UI, so the schema
    default ("card") arrives on every save. Minting that as an owner
    confirmation would let the app later claim 'kort — som de sidste 3
    gange' about a choice the owner never made, and accepting that
    prefill on a cash receipt skips the cash-out sync."""
    u = _owner(db)
    c = _cat(db, u, "Vareforbrug")
    app.dependency_overrides[get_current_user] = lambda: u
    for i in range(3):
        r = client.post("/api/expenses", json={
            "amount": 100.0 + i, "description": "Netto", "vendor_hint": "Netto",
            "date": date.today().isoformat(), "category_id": str(c.id),
        })
        assert r.status_code in (200, 201), r.text
    assert _row(db, u, "netto", "payment_method", "card") is None, \
        "a schema default is not evidence"
    # The category the owner DID choose is still learned.
    assert _row(db, u, "netto", "category_name", "Vareforbrug").agree_count == 3


def test_server_chosen_andet_fallback_is_never_learned(client, db):
    """When the owner omits a category we file it under Andet so the scan
    isn't lost — but that is OUR choice, not their habit."""
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u
    for _ in range(3):
        r = client.post("/api/expenses", json={
            "amount": 60.0, "description": "Netto", "vendor_hint": "Netto",
            "date": date.today().isoformat(), "payment_method": "cash",
        })
        assert r.status_code in (200, 201), r.text
    assert _row(db, u, "netto", "category_name", "Andet") is None
    # ...but the method the owner explicitly sent is learned.
    assert _row(db, u, "netto", "payment_method", "cash").agree_count == 3


def test_confirming_one_value_breaks_the_rival_streak(db):
    """Switching habit without ever seeing a proposal: five card saves,
    then three cash saves. Card must not still be the prefill winner."""
    u = _owner(db)
    for _ in range(5):
        record_signal(db, u.id, "netto", "payment_method", "card", kind="confirm")
    db.commit()
    for _ in range(3):
        record_signal(db, u.id, "netto", "payment_method", "cash", kind="confirm")
    db.commit()
    assert _row(db, u, "netto", "payment_method", "card").streak == 0
    assert recall(db, u.id, "netto")["payment_method"]["value"] == "cash"


def test_evidence_count_is_the_consecutive_streak_not_lifetime(scan_client, db, monkeypatch):
    """The copy says 'som de sidste N gange' — the last N times. If we
    quote a lifetime count that includes corrected-away sightings, the
    sentence is checkably false, which is worse than showing nothing."""
    import app.services.receipt_ocr as ocr
    u = _owner(db)
    _cat(db, u, "Vareforbrug")
    app.dependency_overrides[get_current_user] = lambda: u

    key = canonical_vendor_key("NETTO 1284 LYNGBY")
    for _ in range(5):
        record_signal(db, u.id, key, "payment_method", "card", kind="confirm")
    db.commit()
    record_signal(db, u.id, key, "payment_method", "cash",
                  kind="correction", previous_value="card")
    db.commit()
    for _ in range(4):
        record_signal(db, u.id, key, "payment_method", "card", kind="confirm")
    db.commit()

    row = _row(db, u, key, "payment_method", "card")
    assert row.agree_count == 9 and row.streak == 4, "setup: lifetime != consecutive"

    monkeypatch.setattr(ocr, "parse_expense_receipt", lambda p: _fake_parse(), raising=False)
    monkeypatch.setattr(ocr, "save_receipt_photo", lambda *a, **k: "uploads/receipts/x.jpg", raising=False)
    lp = _upload(scan_client).json()["learned_payment_method"]
    assert lp["evidence_n"] == 4, "must quote the consecutive run the copy claims"
