"""Dead stock may only report what it actually observed.

THE ORIGINAL DEFECT. `/inventory/dead-stock` read demand from ONE signal —
`Sale.item_name` joined to `InventoryItem.name` — a column only the manual
item-sale flow writes. The ICP is a cafe running its own till that types the
Z-report total into BonBox at closing, so it never produces that column. Every
stocked item therefore fell to the "no sale found" branch, got days_since=999,
and the venue's ten most valuable items rendered under a red "Dødt lager /
Aldrig solgt" heading with a delete button beside each. Not an occasional bug:
that is what the feature did, by construction, for the customer it was for.

THE SECOND DEFECT, WHICH IS THE POINT OF THIS FILE. The obvious repair — ask
"does this tenant emit ANY demand signal?" and stay quiet if not — is also
wrong, and fails in a way that is easy to miss. `inventory_count_reconcile`
writes an InventoryLog row only where the count DIFFERED (`if delta != 0`). So
an owner who follows the empty state's own advice and counts 40 items, 2 of
them off, creates 2 log rows. A venue-level gate flips to "readable" and the
endpoint immediately accuses the other 38 items of being dead — the original
false claim, now armed by the very action the UI recommended.

So the decision is PER ITEM: an item with no observation at all is skipped, not
reported. Everything in the list is backed by a real observation that is old.

WINDOW. One 30-day window, read directly. `moving_item_ids` is not reused
because it answers over 90 days (DEMAND_LOOKBACK_DAYS), which is correct for
"should I reorder this" and would make this panel's own "30+ days" heading a
lie — the 30-day cutoff would be unreachable behind a 90-day exclusion.

LABELS. An InventoryLog is a pour, a restock or a stocktake correction —
handling, not selling. The response says which signal the clock measured
(`last_movement_kind`) so the UI cannot print "days since last sale" over a
delivery.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.inventory import InventoryItem, InventoryLog
from app.models.sale import Sale
from app.models.user import User
from app.services.auth import hash_password, create_access_token
from app.utils.time import utc_now

_db_ready.set()

TODAY = date.today()
LONG_AGO = TODAY - timedelta(days=400)


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()

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
    yield TestClient(app)
    app.dependency_overrides.clear()


def _user(db):
    u = User(
        email=f"cafe-{uuid.uuid4().hex[:6]}@bonbox.dk",
        password_hash=hash_password("x"),
        business_name="Café Manoj",
        business_type="restaurant",
        currency="DKK",
        created_at=utc_now() - timedelta(days=400),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _headers(u):
    return {"Authorization": f"Bearer {create_access_token(str(u.id))}"}


def _item(db, u, name, *, cost=100.0, qty=10.0, age_days=365):
    it = InventoryItem(
        id=uuid.uuid4(), user_id=u.id, name=name, quantity=qty, unit="stk",
        cost_per_unit=cost, min_threshold=0, is_perishable=False,
        supplier_lead_time_days=2,
        created_at=utc_now() - timedelta(days=age_days),
        updated_at=utc_now(),
    )
    db.add(it); db.commit(); db.refresh(it)
    return it


def _log(db, item, when, qty=-1.0, reason="count"):
    db.add(InventoryLog(id=uuid.uuid4(), item_id=item.id, change_qty=qty,
                        reason=reason, date=when, created_at=utc_now()))
    db.commit()


def _sale(db, u, name, when, amount=50.0):
    db.add(Sale(id=uuid.uuid4(), user_id=u.id, date=when, amount=amount,
                item_name=name, status="completed", is_deleted=False))
    db.commit()


def _get(client, u):
    r = client.get("/api/inventory/dead-stock", headers=_headers(u))
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body, dict), f"expected the object shape, got {type(body)}"
    return body


class TestTheVenueBonBoxIsNotTheTillFor:
    """The ICP. Nothing here is instrumented; nothing may be accused."""

    def test_no_signals_means_no_accusations(self, db_session, client):
        u = _user(db_session)
        for n in ("Kaffebønner", "Havremælk", "Croissant"):
            _item(db_session, u, n)

        body = _get(client, u)
        assert body["items"] == [], (
            "items with no observation at all were reported as dead — this is "
            "the red 'Aldrig solgt' banner the ICP saw on every visit"
        )

    def test_and_it_says_it_cannot_see_sales(self, db_session, client):
        u = _user(db_session)
        _item(db_session, u, "Kaffebønner")
        assert _get(client, u)["measurable"] is False


class TestOneStockCountDoesNotArmTheAccusation:
    """The regression that a venue-level gate would reintroduce."""

    def test_counting_two_items_does_not_condemn_the_other_thirty_eight(self, db_session, client):
        u = _user(db_session)
        counted = [_item(db_session, u, f"Talt {i}", cost=5.0) for i in range(2)]
        untouched = [_item(db_session, u, f"Urørt {i}", cost=500.0) for i in range(38)]

        # A stocktake writes a log ONLY where the count was off.
        for it in counted:
            _log(db_session, it, TODAY)

        body = _get(client, u)
        names = {row["name"] for row in body["items"]}
        bad = {n for n in names if n.startswith("Urørt")}
        assert not bad, (
            f"a 2-item stocktake made {len(bad)} never-observed items 'dead' — "
            f"and these are the most valuable ones, with delete buttons"
        )

    def test_a_single_old_sale_elsewhere_does_not_condemn_the_rest(self, db_session, client):
        """Same shape, supply swapped for a stale demand signal."""
        u = _user(db_session)
        _item(db_session, u, "Solgt engang", cost=5.0)
        _sale(db_session, u, "Solgt engang", LONG_AGO)
        for i in range(5):
            _item(db_session, u, f"Aldrig set {i}", cost=500.0)

        names = {r["name"] for r in _get(client, u)["items"]}
        assert not {n for n in names if n.startswith("Aldrig set")}


class TestWhatItSHOULDStillCatch:
    """A guard that only ever returns nothing is not a guard."""

    def test_an_item_that_sold_long_ago_is_dead(self, db_session, client):
        u = _user(db_session)
        _item(db_session, u, "Julebryg")
        _sale(db_session, u, "Julebryg", LONG_AGO)

        rows = _get(client, u)["items"]
        assert [r["name"] for r in rows] == ["Julebryg"]
        assert rows[0]["days_since_last_movement"] >= 30

    def test_an_item_that_sold_this_week_is_not(self, db_session, client):
        u = _user(db_session)
        _item(db_session, u, "Latte")
        _sale(db_session, u, "Latte", TODAY - timedelta(days=3))
        assert _get(client, u)["items"] == []

    def test_an_item_logged_last_week_is_not_dead(self, db_session, client):
        """Handling counts as movement even when the till never names it."""
        u = _user(db_session)
        it = _item(db_session, u, "Gin")
        _log(db_session, it, TODAY - timedelta(days=5))
        assert _get(client, u)["items"] == []

    def test_a_brand_new_item_gets_no_verdict(self, db_session, client):
        u = _user(db_session)
        _item(db_session, u, "Ny sirup", age_days=3)
        _sale(db_session, u, "Ny sirup", LONG_AGO)  # observed, but the item is new
        assert _get(client, u)["items"] == []


class TestItSaysWhichClockItRead:
    def test_a_sale_is_reported_as_a_sale(self, db_session, client):
        u = _user(db_session)
        _item(db_session, u, "Julebryg")
        _sale(db_session, u, "Julebryg", LONG_AGO)
        assert _get(client, u)["items"][0]["last_movement_kind"] == "sale"

    def test_a_stock_log_is_not_called_a_sale(self, db_session, client):
        """The whole point of the field. A delivery 200 days ago must not print
        as 'dage siden sidste salg'."""
        u = _user(db_session)
        it = _item(db_session, u, "Tonic")
        _log(db_session, it, LONG_AGO, reason="restock")

        row = _get(client, u)["items"][0]
        assert row["last_movement_kind"] == "movement"
        assert row["days_since_last_sale"] is None, (
            "a restock was reported as a sale date"
        )
