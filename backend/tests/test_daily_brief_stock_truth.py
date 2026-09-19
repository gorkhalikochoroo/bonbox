"""The morning brief must not name stock the Stock page refuses to show.

WHY THIS FILE EXISTS

Home's "Reorder needed (23)" and /inventory's empty state were reconciled in
Sep 2026: both now ask inventory_reorder for the flagged set, so a placeholder
row nobody has ever counted or sold cannot be presented as urgent. The brief
was the THIRD surface that talks about stock, and it was still deriving "low"
on its own (`quantity <= min_threshold`) — so the morning after that fix, the
live app still said:

    "Vodka, Tequila, and Rum are running low — reorder before the weekend rush."

about 23 bar-template rows written in one batch on 2026-05-04, every one at
quantity 0, zero movements, zero sales, ever.

The brief is the worst place for that particular untruth. The cards at least
sit next to the page that contradicts them; the brief is pushed at 06:00 and
the owner cannot click it to see the list.
"""
import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.inventory import InventoryItem, InventoryLog
from app.models.sale import Sale
from app.models.user import User
from app.services.daily_brief import compute_precompute


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def owner(db) -> User:
    u = User(
        email="owner@bonbox.dk", password_hash="x", business_name="Bon Café",
        business_type="restaurant", currency="DKK", plan="pro",
        email_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _item(db, owner, name, qty, threshold=10.0, pour_size=None):
    it = InventoryItem(
        id=uuid.uuid4(), user_id=owner.id, name=name,
        quantity=qty, min_threshold=threshold, unit="stk",
        pour_size=pour_size,
    )
    db.add(it)
    db.commit()
    return it


def _names(db, owner):
    return {i["name"] for i in compute_precompute(owner, db).low_stock_items}


def test_an_empty_placeholder_nobody_sells_is_not_low_stock(db, owner):
    """The live defect, reproduced: a template row at zero that has never
    moved and never sold. The old rule named it every morning."""
    _item(db, owner, "Vodka", qty=0.0)
    _item(db, owner, "Tequila", qty=0.0)
    _item(db, owner, "Rum", qty=0.0)

    assert _names(db, owner) == set()


def test_an_empty_item_the_venue_actually_sells_is_still_named(db, owner):
    """The failure that would be worse than the phantom: going quiet about a
    real stock-out. A sale in the window is what separates the two."""
    _item(db, owner, "Kaffebønner", qty=0.0)
    db.add(Sale(
        id=uuid.uuid4(), user_id=owner.id, amount=120.0,
        date=date.today() - timedelta(days=3),
        item_name="Kaffebønner", payment_method="card",
    ))
    db.commit()

    assert "Kaffebønner" in _names(db, owner)


def test_stock_running_down_is_named_without_needing_a_sale(db, owner):
    """Someone put it on the shelf and it is nearly gone — that is urgent on
    its own, with no movement history required."""
    _item(db, owner, "Mælk", qty=2.0, threshold=10.0)

    assert "Mælk" in _names(db, owner)


def test_a_movement_counts_as_use_even_with_no_sale(db, owner):
    """A counted delivery or waste entry is the venue handling the item, which
    is the other half of "does this place use this"."""
    it = _item(db, owner, "Rengøringsmiddel", qty=0.0)
    db.add(InventoryLog(
        id=uuid.uuid4(), item_id=it.id,
        change_qty=-4.0, reason="waste",
        date=date.today() - timedelta(days=5),
    ))
    db.commit()

    assert "Rengøringsmiddel" in _names(db, owner)


def test_a_pour_bottle_is_named_when_the_owner_has_no_bar_page(db, owner):
    """NOT the symmetry it looks like. The Stock page hides pour-tracked rows
    only when the bar module gives them a /bar page to live on. Without that
    module there is no such page, so hiding the bottle here would mean a
    genuinely empty one raises its hand NOWHERE — a worse failure than the
    phantom count this whole change removed. So it is named."""
    _item(db, owner, "Gin", qty=0.0, pour_size=4.0)
    db.add(Sale(
        id=uuid.uuid4(), user_id=owner.id, amount=90.0,
        date=date.today() - timedelta(days=1),
        item_name="Gin", payment_method="card",
    ))
    db.commit()

    assert "Gin" in _names(db, owner)


def test_a_pour_bottle_leaves_the_brief_once_the_bar_page_exists(db, owner):
    """With bar_pour on, the bottle lives on /bar and the Stock page stops
    listing it — so the brief stops naming it too, and the two agree."""
    from app.services import modules

    _item(db, owner, "Gin", qty=0.0, pour_size=4.0)
    db.add(Sale(
        id=uuid.uuid4(), user_id=owner.id, amount=90.0,
        date=date.today() - timedelta(days=1),
        item_name="Gin", payment_method="card",
    ))
    db.commit()
    modules.set_enabled(db, owner, ["bar_pour"])

    assert "Gin" not in _names(db, owner)


def test_the_brief_still_caps_what_it_names(db, owner):
    """It names a few items, never a list — the cap survived the rewrite."""
    for n in range(8):
        _item(db, owner, f"Vare {n}", qty=1.0, threshold=10.0)

    assert len(compute_precompute(owner, db).low_stock_items) == 5
