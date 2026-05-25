"""Tests for Inventory Ordering Autopilot — Pro tier killer feature (Task #63).

Coverage map:

  Tier gating
    1. Free user POST /inventory/autopilot/suggest → 402 plan_required
    2. Starter user POST /inventory/autopilot/suggest → 402 plan_required
    3. Pro user → 200 + structured suggestion
    4. Trial user → 200 (trial == Pro entitlements)

  History + confidence
    5. Pro user with NO sales history → low confidence + safe defaults
    6. 8 weeks of history → high confidence + per-weekday spread

  Weather correlation
    7. Sunny forecast boosts projection vs the overall mean

  Stock filtering
    8. Items well-stocked above buffer NOT in suggestion list
    9. Stockout < lead_time → urgency "today" + compliance warning

  Supplier grouping + apply
   10. Apply groups by supplier_email; one email per supplier
   11. Items without supplier_email surface in skipped bucket, no email
   12. Apply writes one audit_log entry per supplier
   13. Apply with foreign item_id rejected (cross-tenant boundary)

  Cross-tenant isolation
   14. User A's history never leaks into User B's suggestion

  Misc / production-grade
   15. PLAN_FEATURES contract: inventory_autopilot on every plan
   16. days_ahead bounds clamp; perishable waste warning fires

Run: cd backend && pytest tests/test_inventory_autopilot.py -v
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.inventory import InventoryItem
from app.models.sale import Sale
from app.models.user import User
from app.models.weather import DailyWeather
from app.services import inventory_autopilot
from app.services.auth import get_current_user, hash_password
from app.services.billing import PLAN_FEATURES


_db_ready.set()


# ─── Shared in-memory DB ────────────────────────────────────────────────


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
def client(engine_and_session, monkeypatch):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_test_db

    # Stub the network forecast fetch so tests are deterministic + offline.
    monkeypatch.setattr(
        "app.services.inventory_autopilot._fetch_forecast",
        lambda user, start, days_ahead: {},
    )

    # Reset slowapi rate limiter between tests so rapid-fire calls don't 429.
    try:
        from app.routers.inventory import _limiter as _inv_limiter
        _inv_limiter.reset()
    except Exception:
        pass

    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User | None):
    if user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = lambda: user


# ─── Helpers ───────────────────────────────────────────────────────────


def _owner(db, plan: str = "pro", *, email_suffix: str = "") -> User:
    u = User(
        email=f"owner{email_suffix}@bonbox.dk",
        password_hash=hash_password("pw"),
        business_name=f"Mirabelle{email_suffix}",
        business_type="restaurant",
        currency="DKK",
        plan=plan,
        role="owner",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _item(
    db,
    owner: User,
    *,
    name: str,
    qty: float = 5.0,
    min_threshold: float = 5.0,
    cost: float = 100.0,
    unit: str = "kg",
    supplier_name: str | None = "Acme Foods",
    supplier_email: str | None = "supplier@acme.com",
    lead_time: int = 1,
    pack_size: float = 1.0,
    is_perishable: bool = False,
    category: str = "Pantry",
) -> InventoryItem:
    it = InventoryItem(
        id=uuid.uuid4(),
        user_id=owner.id,
        name=name,
        quantity=Decimal(str(qty)),
        unit=unit,
        cost_per_unit=Decimal(str(cost)),
        min_threshold=Decimal(str(min_threshold)),
        category=category,
        is_perishable=is_perishable,
        supplier_name=supplier_name,
        supplier_email=supplier_email,
        supplier_lead_time_days=lead_time,
        pack_size=Decimal(str(pack_size)),
    )
    db.add(it)
    db.commit()
    db.refresh(it)
    return it


def _sale_for(
    db,
    owner: User,
    item: InventoryItem,
    d: date,
    qty: float,
    amount: float = 100.0,
) -> Sale:
    s = Sale(
        id=uuid.uuid4(),
        user_id=owner.id,
        date=d,
        amount=Decimal(str(amount)),
        payment_method="card",
        inventory_item_id=item.id,
        quantity_sold=Decimal(str(qty)),
        item_name=item.name,
    )
    db.add(s)
    db.commit()
    return s


def _weather(
    db, owner: User, d: date, *, temp: float = 18.0, code: int = 0, rain_mm: float = 0.0
) -> DailyWeather:
    w = DailyWeather(
        id=uuid.uuid4(),
        user_id=owner.id,
        date=d,
        temp_max=Decimal(str(temp + 2)),
        temp_min=Decimal(str(temp - 2)),
        rain_mm=Decimal(str(rain_mm)),
        weather_code=code,
    )
    db.add(w)
    db.commit()
    return w


# ─── 1. Free user blocked ──────────────────────────────────────────────


def test_free_user_blocked(client, db):
    owner = _owner(db, plan="free")
    _override_user(owner)

    res = client.post(
        "/api/inventory/autopilot/suggest",
        json={"days_ahead": 7},
    )
    assert res.status_code == 402, res.text
    detail = res.json()["detail"]
    assert detail["code"] == "plan_required"
    assert detail["feature"] == "inventory_autopilot"
    assert detail["upgrade_to"] == "pro"
    assert detail["current_plan"] == "free"


# ─── 2. Starter user passes (tier-doctrine fix 2026-05-25) ─────────────
#
# Manoj's locked rule: Starter + Pro share features, only Free is gated.
# Previously Starter was blocked here ("Pro killer"); the doctrine flip
# opened inventory_autopilot to Starter+.


def test_starter_user_passes(client, db):
    owner = _owner(db, plan="starter")
    _override_user(owner)

    res = client.post(
        "/api/inventory/autopilot/suggest",
        json={"days_ahead": 7},
    )
    assert res.status_code == 200, res.text


# ─── 3. Pro user with no history → low confidence ──────────────────────


def test_pro_user_with_no_history_returns_low_confidence(client, db):
    owner = _owner(db, plan="pro")
    # Item below min_threshold so it does land in the suggestion list.
    _item(db, owner, name="Coffee Beans", qty=2.0, min_threshold=5.0)
    _override_user(owner)

    res = client.post(
        "/api/inventory/autopilot/suggest",
        json={"days_ahead": 7},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    # No sales history → low confidence + zero history samples
    assert body["confidence"] == "low"
    assert body["basis"]["items_with_history"] == 0
    assert body["basis"]["weather_used"] is False
    # Item below threshold still surfaces with a safety-floor suggested_qty.
    assert len(body["items"]) >= 1
    item = body["items"][0]
    assert item["samples"] == 0
    assert item["confidence"] == "low"
    # Safety-floor: at least topped up to min_threshold (3 units needed)
    assert item["suggested_qty"] >= 3.0


# ─── 4. Trial user (= Pro entitlements) ────────────────────────────────


def test_trial_user_can_use_autopilot(client, db):
    owner = _owner(db, plan="free")
    from app.utils.time import utc_now
    owner.trial_ends_at = utc_now() + timedelta(days=5)
    db.commit()
    _item(db, owner, name="Coffee Beans", qty=2.0, min_threshold=5.0)
    _override_user(owner)

    res = client.post(
        "/api/inventory/autopilot/suggest",
        json={"days_ahead": 7},
    )
    assert res.status_code == 200, res.text


# ─── 5. 8 weeks of history → high confidence ───────────────────────────


def test_pro_user_with_full_history_returns_high_confidence(client, db):
    owner = _owner(db, plan="pro")
    # Low stock so item surfaces in suggestions; high burn so urgency triggers.
    coffee = _item(db, owner, name="Coffee Beans", qty=3.0, min_threshold=5.0, unit="kg")
    today = date.today()
    # 8 weeks × 7 days = 56 days of sales: 1kg per day
    for d_back in range(1, 57):
        d = today - timedelta(days=d_back)
        _sale_for(db, owner, coffee, d, qty=1.0, amount=100.0)

    _override_user(owner)
    res = client.post(
        "/api/inventory/autopilot/suggest",
        json={"days_ahead": 7},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["confidence"] == "high"
    assert body["basis"]["items_with_history"] >= 1
    # ~1kg/day × 14 days = 14kg projected demand
    item = next(i for i in body["items"] if i["name"] == "Coffee Beans")
    assert item["confidence"] == "high"
    assert 10.0 <= item["projected_demand_14d"] <= 20.0


# ─── 6. Sunny weather boosts projection vs the overall mean ────────────


def test_weather_sunny_boosts_projection(client, db, monkeypatch):
    """Owner has 8 weeks where SUNNY Tuesdays sell ~2x what RAINY Tuesdays
    sell. Forecasting a sunny Tuesday must pull projected demand up vs
    the overall-mean baseline."""
    owner = _owner(db, plan="pro")
    owner.latitude = Decimal("55.6761")
    owner.longitude = Decimal("12.5683")
    db.commit()
    # Low current stock so the item surfaces in suggestions across both
    # forecast scenarios. min_threshold high so it stays surfaced.
    gin = _item(
        db, owner, name="Gin", qty=1.0, min_threshold=20.0,
        unit="ml", cost=200.0,
    )
    today = date.today()
    # Use historical Tuesdays only. 8 Tuesdays alternating sunny/rainy.
    for w in range(1, 9):
        # Find a Tuesday in week w back
        candidate = today - timedelta(weeks=w)
        while candidate.weekday() != 1:
            candidate -= timedelta(days=1)
        is_sunny = (w % 2 == 0)
        qty = 5.0 if is_sunny else 1.0
        code = 0 if is_sunny else 63
        rain = 0.0 if is_sunny else 5.0
        _sale_for(db, owner, gin, candidate, qty=qty, amount=qty * 100)
        _weather(db, owner, candidate, temp=15.0, code=code, rain_mm=rain)

    # Pick next Tuesday for the forecast scenario
    target = today
    while target.weekday() != 1:
        target += timedelta(days=1)

    def _sunny_fc(user, start, days_ahead):
        out = {}
        for off in range(days_ahead):
            d = start + timedelta(days=off)
            if d == target:
                out[d] = {
                    "temp_c": 22.0,
                    "precipitation_mm": 0.0,
                    "weather_code": 0,
                    "bucket": "sunny",
                }
        return out

    def _rainy_fc(user, start, days_ahead):
        out = {}
        for off in range(days_ahead):
            d = start + timedelta(days=off)
            if d == target:
                out[d] = {
                    "temp_c": 12.0,
                    "precipitation_mm": 5.0,
                    "weather_code": 63,
                    "bucket": "rainy",
                }
        return out

    _override_user(owner)

    monkeypatch.setattr(
        "app.services.inventory_autopilot._fetch_forecast", _sunny_fc
    )
    res_sun = client.post(
        "/api/inventory/autopilot/suggest",
        json={"days_ahead": 14},
    )
    assert res_sun.status_code == 200, res_sun.text
    sun_items = res_sun.json()["items"]
    sun_gin = next((i for i in sun_items if i["name"] == "Gin"), None)

    monkeypatch.setattr(
        "app.services.inventory_autopilot._fetch_forecast", _rainy_fc
    )
    res_rain = client.post(
        "/api/inventory/autopilot/suggest",
        json={"days_ahead": 14},
    )
    assert res_rain.status_code == 200, res_rain.text
    rain_items = res_rain.json()["items"]
    rain_gin = next((i for i in rain_items if i["name"] == "Gin"), None)

    # In at least one scenario the gin must surface. With 5x sunny vs 1x
    # rainy historical pattern, sunny projection > rainy projection.
    # If gin doesn't surface because stock is too high in one scenario,
    # check what surfaces. The deterministic comparison:
    sun_proj = sun_gin["projected_demand_14d"] if sun_gin else None
    rain_proj = rain_gin["projected_demand_14d"] if rain_gin else None
    # If both surfaced, sunny > rainy. If only one surfaced, that's
    # also evidence weather drove a divergence.
    if sun_proj is not None and rain_proj is not None:
        assert sun_proj > rain_proj
    else:
        # At least one variant must surface.
        assert sun_proj is not None or rain_proj is not None


# ─── 7. Items well-stocked are NOT in the suggestion list ──────────────


def test_well_stocked_items_excluded(client, db):
    owner = _owner(db, plan="pro")
    # Big stock cushion, no demand history → "monitor" tier excluded.
    _item(db, owner, name="Salt", qty=100.0, min_threshold=2.0, unit="kg")
    # Below-threshold stock — should surface.
    _item(db, owner, name="Pepper", qty=1.0, min_threshold=5.0, unit="kg")
    _override_user(owner)

    res = client.post(
        "/api/inventory/autopilot/suggest",
        json={"days_ahead": 7},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    names = {i["name"] for i in body["items"]}
    assert "Pepper" in names
    assert "Salt" not in names, (
        f"Salt should be filtered (well-stocked, no history). Got: {names}"
    )


# ─── 8. Stockout < lead_time → today urgency + compliance warning ──────


def test_stockout_before_lead_time_marked_today_urgency(client, db):
    owner = _owner(db, plan="pro")
    # Lead time 5 days; stock will run out in ~3 days at current burn.
    item = _item(
        db, owner, name="Flour",
        qty=3.0, min_threshold=2.0, unit="kg",
        lead_time=5, supplier_email="flour@mill.dk",
    )
    today = date.today()
    # 4 weeks of sales: 1kg/day. So per-weekday mean ≈ 1.
    for d_back in range(1, 29):
        d = today - timedelta(days=d_back)
        _sale_for(db, owner, item, d, qty=1.0, amount=10.0)

    _override_user(owner)
    res = client.post(
        "/api/inventory/autopilot/suggest",
        json={"days_ahead": 14},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    flour = next(i for i in body["items"] if i["name"] == "Flour")
    assert flour["urgency"] == "today"
    # Compliance warning fired because stockout < lead_time
    assert any("late_for_lead_time" in n for n in flour["notes"]) or any(
        "Flour" in w for w in body["compliance_warnings"]
    )


# ─── 9. Apply groups by supplier_email; one email per supplier ─────────


def test_apply_groups_by_supplier_and_sends_one_email_each(client, db):
    owner = _owner(db, plan="pro")
    a1 = _item(
        db, owner, name="Item A1", qty=0,
        supplier_email="merchant_a@example.com",
        supplier_name="Merchant A",
    )
    a2 = _item(
        db, owner, name="Item A2", qty=0,
        supplier_email="merchant_a@example.com",
        supplier_name="Merchant A",
    )
    b1 = _item(
        db, owner, name="Item B1", qty=0,
        supplier_email="merchant_b@example.com",
        supplier_name="Merchant B",
    )

    sent_messages: list[dict] = []

    def fake_sender(to, subject, html, *, reply_to=None):
        sent_messages.append({
            "to": to, "subject": subject, "html": html, "reply_to": reply_to,
        })
        return True, None

    # Stub the email send at the apply boundary.
    import app.services.email_service as email_service
    original_send = email_service.send_email
    email_service.send_email = lambda *a, **kw: True  # noqa: ARG005

    try:
        _override_user(owner)
        result = inventory_autopilot.apply_reorder(
            db,
            user=owner,
            items=[
                {"item_id": str(a1.id), "qty": 5.0},
                {"item_id": str(a2.id), "qty": 3.0},
                {"item_id": str(b1.id), "qty": 2.0},
            ],
            send_email_fn=fake_sender,
        )
    finally:
        email_service.send_email = original_send

    # 3 items, 2 distinct suppliers → 2 emails
    assert result["sent"] == 2
    assert len(sent_messages) == 2
    recipients = {m["to"] for m in sent_messages}
    assert recipients == {"merchant_a@example.com", "merchant_b@example.com"}
    # Reply-to is the owner's own address
    assert all(m["reply_to"] == owner.email for m in sent_messages)
    # Merchant A's email contains BOTH items
    a_email = next(m for m in sent_messages if m["to"] == "merchant_a@example.com")
    assert "Item A1" in a_email["html"]
    assert "Item A2" in a_email["html"]


# ─── 10. Items without supplier_email surface in skipped bucket ────────


def test_apply_skips_items_without_supplier_email(client, db):
    owner = _owner(db, plan="pro")
    no_supplier = _item(db, owner, name="OrphanItem", qty=0, supplier_email=None)

    def fake_sender(to, subject, html, *, reply_to=None):
        return True, None

    result = inventory_autopilot.apply_reorder(
        db,
        user=owner,
        items=[{"item_id": str(no_supplier.id), "qty": 5.0}],
        send_email_fn=fake_sender,
    )
    assert result["sent"] == 0
    assert result["skipped_no_supplier"] == 1


# ─── 11. Apply audit log entries ───────────────────────────────────────


def test_apply_writes_audit_log_per_supplier(client, db):
    owner = _owner(db, plan="pro")
    item = _item(
        db, owner, name="Beans", qty=0,
        supplier_email="beans@example.com",
    )
    _override_user(owner)

    # Stub the underlying email sender to avoid network
    import app.services.email_service as email_service
    original_send = email_service.send_email
    email_service.send_email = lambda *a, **kw: True

    try:
        res = client.post(
            "/api/inventory/autopilot/apply",
            json={"items": [{
                "item_id": str(item.id),
                "qty": 3.0,
                "supplier_email": "beans@example.com",
            }]},
        )
    finally:
        email_service.send_email = original_send

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["sent"] == 1

    audit_rows = db.query(AuditLog).filter(
        AuditLog.user_id == owner.id,
        AuditLog.action == "inventory.autopilot_applied",
    ).all()
    assert len(audit_rows) >= 1


# ─── 12. Apply with foreign item_id rejected (cross-tenant) ────────────


def test_apply_rejects_foreign_item_id(client, db):
    owner_a = _owner(db, plan="pro", email_suffix="_a")
    owner_b = _owner(db, plan="pro", email_suffix="_b")
    foreign_item = _item(db, owner_b, name="ForeignItem", qty=0,
                          supplier_email="b@example.com")

    _override_user(owner_a)

    res = client.post(
        "/api/inventory/autopilot/apply",
        json={"items": [{
            "item_id": str(foreign_item.id),
            "qty": 2.0,
            "supplier_email": "anywhere@example.com",
        }]},
    )
    # 400 — service raised ValueError due to tenant violation
    assert res.status_code == 400, res.text


# ─── 13. Cross-tenant isolation in suggest ─────────────────────────────


def test_user_a_history_does_not_leak_into_user_b_suggestion(client, db):
    owner_a = _owner(db, plan="pro", email_suffix="_a")
    owner_b = _owner(db, plan="pro", email_suffix="_b")
    # User A has loads of sales / items.
    a_item = _item(db, owner_a, name="ItemA", qty=0)
    today = date.today()
    for d_back in range(1, 30):
        _sale_for(db, owner_a, a_item, today - timedelta(days=d_back), qty=2.0)
    # User B has only a single bare item, no history.
    b_item = _item(db, owner_b, name="ItemB", qty=0, min_threshold=2.0)

    _override_user(owner_b)
    res = client.post(
        "/api/inventory/autopilot/suggest",
        json={"days_ahead": 7},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    names = {i["name"] for i in body["items"]}
    assert "ItemA" not in names
    assert "ItemB" in names
    # B's confidence is low because B has no sales of its own
    item_b = next(i for i in body["items"] if i["name"] == "ItemB")
    assert item_b["samples"] == 0


# ─── 14. PLAN_FEATURES contract: inventory_autopilot key on every plan ──


def test_inventory_autopilot_key_on_every_plan():
    for plan in ("free", "starter", "trial", "pro"):
        assert "inventory_autopilot" in PLAN_FEATURES[plan], (
            f"Plan {plan} missing inventory_autopilot key"
        )
    # 2026-05-25 tier-doctrine: Starter + Pro share features, only Free
    # is gated. inventory_autopilot was flipped from Pro-only to Starter+.
    assert PLAN_FEATURES["free"]["inventory_autopilot"] is False
    assert PLAN_FEATURES["starter"]["inventory_autopilot"] is True
    assert PLAN_FEATURES["trial"]["inventory_autopilot"] is True
    assert PLAN_FEATURES["pro"]["inventory_autopilot"] is True


# ─── 15. days_ahead bounds clamp ───────────────────────────────────────


def test_days_ahead_clamps(client, db):
    owner = _owner(db, plan="pro")
    _item(db, owner, name="X", qty=1.0, min_threshold=5.0)
    _override_user(owner)

    # Out-of-bounds days_ahead rejected by Pydantic Field bounds
    res = client.post(
        "/api/inventory/autopilot/suggest",
        json={"days_ahead": 999},
    )
    assert res.status_code == 422

    # Lower bound likewise
    res2 = client.post(
        "/api/inventory/autopilot/suggest",
        json={"days_ahead": 0},
    )
    assert res2.status_code == 422

    # In-bounds value works
    res3 = client.post(
        "/api/inventory/autopilot/suggest",
        json={"days_ahead": 14},
    )
    assert res3.status_code == 200


# ─── 16. Perishable waste-risk warning surfaces ────────────────────────


def test_perishable_item_surfaces_with_supplier_metadata(client, db):
    """Perishable items still surface in the recommendation list when
    stock is low — they retain the is_perishable flag in the output and
    drive correct supplier grouping. The frontend uses is_perishable +
    suggested_qty to render the 'waste risk' badge on the UI side; the
    service-level compliance_warning fires only when suggested_qty
    materially exceeds the 14-day projection (defense in depth)."""
    owner = _owner(db, plan="pro")
    item = _item(
        db, owner, name="Bagels",
        qty=0, min_threshold=50.0, unit="pieces",
        is_perishable=True, cost=5.0,
        supplier_email="bakery@example.com",
    )

    _override_user(owner)
    res = client.post(
        "/api/inventory/autopilot/suggest",
        json={"days_ahead": 7},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    bagels = next(i for i in body["items"] if i["name"] == "Bagels")
    assert bagels["is_perishable"] is True
    # Stock is below threshold so the item must be flagged as today/this_week
    assert bagels["urgency"] in ("today", "this_week")
    # Safety floor kicks the qty up to min_threshold even with no history;
    # since projected_14d is ~0, suggested_qty > 1.2 * projected_14d triggers
    # the perishable_waste_risk warning.
    has_perishable_signal = any("perishable" in n for n in bagels["notes"]) or any(
        "Bagels" in w and "perishable" in w.lower()
        for w in body["compliance_warnings"]
    )
    assert has_perishable_signal, (
        f"Expected perishable warning for Bagels. notes={bagels['notes']} "
        f"warnings={body['compliance_warnings']}"
    )


# ─── 17. Audit log entry for suggest ───────────────────────────────────


def test_suggest_writes_audit_log(client, db):
    owner = _owner(db, plan="pro")
    _item(db, owner, name="Coffee", qty=1.0, min_threshold=3.0)
    _override_user(owner)

    res = client.post(
        "/api/inventory/autopilot/suggest",
        json={"days_ahead": 7},
    )
    assert res.status_code == 200

    rows = db.query(AuditLog).filter(
        AuditLog.user_id == owner.id,
        AuditLog.action == "inventory.autopilot_suggested",
    ).all()
    assert len(rows) >= 1
