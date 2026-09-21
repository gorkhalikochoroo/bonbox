"""Regression guard for the /expiry/forecast payload contract.

Nothing asserted on `get_expiry_forecast`'s money copy or on the At-Risk
Value weighting before this file, so two things could drift silently:

  1. WEIGHTING. The At-Risk Value tile and the Expiry Timeline beneath it
     have to describe the same rows. The tile used to count the 7-14 day
     bucket at HALF cost while the table printed full cost, so an owner who
     added the "Cost at Risk" column up got a bigger number than the tile.
     Pulling the OTHER direction — folding the 14-30 day "upcoming" bucket
     into the total — turns the tile red and fires "act now to minimize
     loss" at an owner whose nearest date is three weeks away, while the
     alerts banner on the same screen says expiry tracking looks good.
     Both directions are pinned here.

  2. THE COPY CONTRACT. `alerts` and `recommendations` are composed
     server-side and rendered VERBATIM by the clients — including the
     committed ios-scheduler bundle, which prints alert.title/alert.detail
     and rec.icon/rec.title/rec.detail and nothing else. So money has to be
     formatted into those strings here (money_dk, the owner's currency) and
     may not be moved out into side fields no renderer reads.

Run: cd backend && pytest tests/test_expiry_forecast_payload.py -v
"""
from __future__ import annotations

from datetime import date, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401 — register all models
from app.database import Base
from app.models.inventory import InventoryItem
from app.models.user import User
from app.services.auth import hash_password
from app.services.expiry_service import get_expiry_forecast
from app.utils.time import utc_now


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    yield s
    s.close()


def _user(db, currency="DKK"):
    u = User(
        email=f"{uuid4().hex}@mirabelle.dk",
        password_hash=hash_password("x"),
        business_name="Mirabelle",
        business_type="restaurant",
        currency=currency,
        plan="starter",
        email_verified=True,
        created_at=utc_now() - timedelta(days=2),
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _item(db, user, *, days, cost, qty=1.0, name="Fløde"):
    it = InventoryItem(
        id=uuid4(), user_id=user.id, name=name, category="Dairy",
        quantity=qty, unit="l", cost_per_unit=cost, is_perishable=True,
        expiry_date=date.today() + timedelta(days=days),
    )
    db.add(it); db.commit()
    return it


# ─── Weighting ────────────────────────────────────────────────────────


def test_stock_three_weeks_out_is_not_at_risk(db):
    """14-30 days is "upcoming", not at risk. A calm account stays calm:
    zero on the tile, the reassuring advice, the healthy banner."""
    u = _user(db)
    for d in (20, 22, 25):
        _item(db, u, days=d, cost=400.0)
    out = get_expiry_forecast(u.id, db)
    assert out["total_at_risk_value"] == 0.0
    assert [r["type"] for r in out["recommendations"]] == ["all_good"]
    assert [a["type"] for a in out["alerts"]] == ["healthy"]
    # The rows are still listed — they just are not counted as at risk.
    assert len(out["expiring_later"]) == 3


def test_seven_to_fourteen_day_bucket_counts_its_full_cost(db):
    """The tile and the "Cost at Risk" column print the same figure."""
    u = _user(db)
    _item(db, u, days=10, cost=400.0)
    out = get_expiry_forecast(u.id, db)
    assert out["expiring_moderate"][0]["cost_at_risk"] == 400.0
    assert out["total_at_risk_value"] == 400.0  # not 200.0 (cost * 0.5)


def test_total_is_the_sum_of_the_rows_it_covers(db):
    u = _user(db)
    _item(db, u, days=-1, cost=100.0)   # expired
    _item(db, u, days=3, cost=250.5)    # < 7 days
    _item(db, u, days=12, cost=49.5)    # 7-14 days
    _item(db, u, days=28, cost=999.0)   # upcoming — excluded
    out = get_expiry_forecast(u.id, db)
    counted = (
        out["expired_items"] + out["expiring_soon"] + out["expiring_moderate"]
    )
    assert out["total_at_risk_value"] == round(
        sum(i["cost_at_risk"] for i in counted), 2
    ) == 400.0


# ─── Copy contract ────────────────────────────────────────────────────


def test_money_in_the_copy_is_danish_and_carries_the_currency(db):
    u = _user(db)
    _item(db, u, days=3, cost=1200.0)
    out = get_expiry_forecast(u.id, db)
    rec = next(r for r in out["recommendations"] if r["type"] == "value_at_risk")
    # Not "Value at risk: 1,200" — English grouping with no currency.
    assert rec["title"] == "Value at risk: 1.200,00 kr."
    soon = next(a for a in out["alerts"] if a["type"] == "expiring_soon")
    assert soon["detail"].endswith("At-risk value: 1.200,00 kr.")


def test_non_dkk_owner_reads_their_own_currency(db):
    u = _user(db, currency="EUR")
    _item(db, u, days=3, cost=1200.0)
    out = get_expiry_forecast(u.id, db)
    rec = next(r for r in out["recommendations"] if r["type"] == "value_at_risk")
    assert rec["title"] == "Value at risk: 1,200.00 EUR"


def test_alerts_and_recs_keep_the_keys_the_clients_render(db):
    """The committed scheduler bundle reads exactly these keys. A figure
    moved out of `title`/`detail` into a side field disappears there."""
    u = _user(db)
    _item(db, u, days=3, cost=1200.0)
    _item(db, u, days=-1, cost=80.0)
    _item(db, u, days=12, cost=40.0)
    out = get_expiry_forecast(u.id, db)
    for a in out["alerts"]:
        assert set(a) == {"type", "severity", "icon", "title", "detail", "action"}
    for r in out["recommendations"]:
        assert set(r) == {"type", "priority", "icon", "title", "detail"}
