"""Home's reorder card and the Stock page must answer the same question.

WHAT WAS ON SCREEN. The founder's own production account rendered
"Reorder needed (23)" on Home and an empty state on /inventory at the same
moment. Read out of production, the 23 rows were the pour-tracked half of the
Bar template — Vodka, Gin, Rum, Draft Beer, the wines, the mixers — written in
a single batch on 2026-05-04, every one at quantity 0.00 with the template's
own min_threshold, `updated_at` still within a fraction of a millisecond of
`created_at`. Across the whole account, `inventory_logs` held zero rows for any
of them and no sale had ever named one. They were placeholders.

Two independent faults produced one number:

  1. /inventory drops pour-tracked rows client-side (they live on /bar), while
     /dashboard/batch returned every row — so the card counted items the page
     it links to will never show.
  2. `quantity <= min_threshold` calls an untouched placeholder maximally
     urgent. Zero stock with zero demand is not urgency.

And the endpoint that fed /inventory's own "Low stock" count had the mirror
fault: `quantity > 0` hid genuine stock-outs, the one row an owner most needs.

THE FIRST FIX THEN INTRODUCED TWO MORE, both of which are pinned below because
they are the same class of defect wearing the opposite sign:

  3. The card counted the flagged rows of a 50-ROW DISPLAY SAMPLE. On a 316-row
     shop account whose six genuinely low rows were older than its newest 50,
     every one fell outside the window: /inventory said "Low stock (6)" and
     Home said nothing. The two screens still disagreed — now about real stock.
  4. "Bottles live on /bar" was applied unconditionally, and /bar is gated on
     the `bar_pour` module which NO production account has enabled. A bottle
     running down was therefore in no table, no count and no list anywhere.

THE CONTRACT PINNED HERE, because fixing any one part alone still leaves a
screen that lies:

  • a pour-tracked row never reaches the Home card WHILE /bar can hold it, and
    is listed and flagged like any other stock row when it cannot;
  • zero stock with zero demand is not flagged;
  • zero stock the venue ACTUALLY SELLS is flagged — this is the case that must
    survive every future attempt to quieten the card;
  • the count and the list agree: what Home counts is exactly what
    /inventory/alerts returns, over exactly the rows InventoryPage renders,
    at any row count — the card's number is never a count of a window.
"""
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register tables
from app.main import app, _db_ready
from app.models.inventory import InventoryItem, InventoryLog
from app.models.sale import Sale
from app.models.user import User
from app.services.auth import create_access_token, hash_password
from app.utils.time import utc_now

_db_ready.set()


# ─── Fixtures (mirrors tests/test_dashboard_first_run.py) ─────────────


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

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


def _make_user(db, *, email="bar@venue.dk", bar_pour=False):
    """An owner. `bar_pour` is the vertical module that puts /bar in the
    sidebar — the ONLY thing that makes "bottles live on /bar" a true
    statement. Default False because that is production: 0 of 72 accounts have
    it (or any module) enabled, so for every real owner today /inventory is the
    only stock page there is.
    """
    u = User(
        email=email,
        password_hash=hash_password("x"),
        business_name="Test Bar",
        business_type="bar",
        currency="DKK",
        plan="free",
        created_at=utc_now() - timedelta(days=30),
        email_verified=True,
        enabled_modules="bar_pour" if bar_pour else "",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _item(db, user, *, name, quantity, min_threshold, pour_size=None):
    it = InventoryItem(
        user_id=user.id,
        name=name,
        quantity=quantity,
        min_threshold=min_threshold,
        unit="ml" if pour_size else "kg",
        pour_size=pour_size,
    )
    db.add(it); db.commit(); db.refresh(it)
    return it


def _sell(db, user, *, name, days_ago=3):
    """A sale naming the item — the venue demonstrably sells this."""
    s = Sale(
        user_id=user.id,
        item_name=name,
        amount=49,
        quantity_sold=1,
        date=date.today() - timedelta(days=days_ago),
    )
    db.add(s); db.commit()
    return s


def _log(db, item, *, days_ago=3, change=-1):
    """A stock movement — a pour, a restock, a stocktake correction."""
    row = InventoryLog(
        item_id=item.id,
        change_qty=change,
        reason="adjustment",
        date=date.today() - timedelta(days=days_ago),
    )
    db.add(row); db.commit()
    return row


def _auth_headers(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id))}"}


def _batch(client, user):
    r = client.get("/api/dashboard/batch", headers=_auth_headers(user))
    assert r.status_code == 200, r.text
    return r.json()


def _batch_inventory(client, user):
    """The DISPLAY sample — capped at 50, for cards that want a glance."""
    return _batch(client, user)["inventory"]


def _home_reorder(client, user):
    """What InventoryPanel renders: `inventory_reorder`, the complete flagged
    set — NOT the flagged part of the display sample.

    That distinction is the second bug this file has now seen. Counting the
    flagged rows of a 50-row window makes the card's number a count of the
    window, and on an account whose low rows are older than its newest 50 the
    window contains none of them.
    """
    return _batch(client, user)["inventory_reorder"]


def _flagged_in_sample(rows):
    """The display sample's own flags — pinned only to prove they agree with
    the authoritative list, never used as the card's number."""
    return [r for r in rows if r.get("needs_reorder") is True]


def _inventory_page_rows(client, user, *, bar_reachable=False):
    """What InventoryPage lists: GET /inventory, then its own pour filter.

    That filter is conditional on the same thing the backend clause is — the
    page only hides a bottle while /bar exists to hold it — so this mirror
    takes the same flag rather than hard-coding one side of it.
    """
    r = client.get("/api/inventory", headers=_auth_headers(user))
    assert r.status_code == 200, r.text
    rows = r.json()
    if not bar_reachable:
        return rows
    return [row for row in rows if not row.get("pour_size") or row["pour_size"] <= 0]


def _stock_page_alerts(client, user):
    """What /inventory prints as "Low stock (N)"."""
    r = client.get("/api/inventory/alerts", headers=_auth_headers(user))
    assert r.status_code == 200, r.text
    return r.json()


# ─── 1. The rows the owner cannot see ─────────────────────────────────


def test_pour_tracked_rows_never_reach_the_home_card(db_session, client):
    """The founder's exact fixture, on an account where /bar exists."""
    user = _make_user(db_session, bar_pour=True)
    for name in ("Vodka", "Gin", "Rum", "Tequila"):
        _item(db_session, user, name=name, quantity=0, min_threshold=200, pour_size=30)

    inventory = _batch_inventory(client, user)
    assert inventory == []
    assert _home_reorder(client, user) == []
    assert _stock_page_alerts(client, user) == []


def test_the_founders_template_is_quiet_even_with_no_bar_page(db_session, client):
    """The same 23 rows on the account shape production actually has.

    With `bar_pour` off the bottles ARE listed — /inventory is the only stock
    page, so hiding them there hides them everywhere. They are still not
    shouted about: untouched placeholders are silenced by the demand half of
    the rule, not by the visibility half. Which is the point — the two halves
    are independent, and the headline defect stays fixed without the visibility
    clause having to swallow rows it cannot account for.
    """
    user = _make_user(db_session)
    for name in ("Vodka", "Gin", "Rum", "Tequila"):
        _item(db_session, user, name=name, quantity=0, min_threshold=200, pour_size=30)

    inventory = _batch_inventory(client, user)
    assert sorted(r["name"] for r in inventory) == ["Gin", "Rum", "Tequila", "Vodka"]
    assert _home_reorder(client, user) == []
    assert _stock_page_alerts(client, user) == []


def test_a_pour_tracked_bottle_the_bar_really_pours_is_still_not_on_home(db_session, client):
    """Demand does not buy a bottle its way onto the wrong page.

    Half-empty gin that sells every night is real and urgent — but on an
    account with /bar in the sidebar, /inventory does not list it, so Home may
    not send the owner there for it. This is the boundary between the two
    halves of the rule: visibility is decided before urgency is even asked.
    """
    user = _make_user(db_session, bar_pour=True)
    gin = _item(db_session, user, name="Gin", quantity=100, min_threshold=200, pour_size=30)
    _sell(db_session, user, name="Gin")
    _log(db_session, gin)

    assert _batch_inventory(client, user) == []
    assert _stock_page_alerts(client, user) == []


def test_a_bottle_with_no_bar_page_raises_its_hand_on_the_stock_page(db_session, client):
    """The failure mode the whole rule is written to avoid.

    Same half-empty, nightly-selling gin, on an account with no /bar — which
    is every account in production. "It belongs to the other page" is only a
    reason to drop a row while the other page EXISTS. Without it the bottle
    was in no table, no count and no list: /inventory filtered it out,
    /inventory/alerts filtered it out, Home filtered it out, and /bar was in
    nobody's sidebar. Hiding a genuine stock-out is worse than the phantom
    count this file replaced, so it is pinned here explicitly.
    """
    user = _make_user(db_session)
    gin = _item(db_session, user, name="Gin", quantity=100, min_threshold=200, pour_size=30)
    _sell(db_session, user, name="Gin")
    _log(db_session, gin)

    assert [r["name"] for r in _home_reorder(client, user)] == ["Gin"]
    assert [r["name"] for r in _stock_page_alerts(client, user)] == ["Gin"]


def test_zero_pour_size_is_general_stock_not_a_bottle(db_session, client):
    """`pour_size` 0 means "not pour-tracked" — the same boundary
    InventoryPage uses (`|| i.pour_size <= 0`), so the two cannot drift."""
    user = _make_user(db_session)
    _item(db_session, user, name="Sirup", quantity=2, min_threshold=5, pour_size=0)

    assert [r["name"] for r in _batch_inventory(client, user)] == ["Sirup"]


# ─── 2. Zero stock with zero demand is not urgency ────────────────────


def test_an_untouched_template_placeholder_is_not_urgent(db_session, client):
    """A general-stock row from a loaded template: empty, below its threshold,
    and nothing has ever sold or moved it. It is listed — the owner can see and
    edit it — but it is not an alarm."""
    user = _make_user(db_session)
    _item(db_session, user, name="Takeaway Boxes", quantity=0, min_threshold=50)

    rows = _batch_inventory(client, user)
    assert [r["name"] for r in rows] == ["Takeaway Boxes"]   # visible…
    assert _home_reorder(client, user) == []                  # …but not shouted
    assert _stock_page_alerts(client, user) == []


# ─── 3. A real stock-out still raises its hand ────────────────────────


def test_zero_stock_the_venue_sells_is_flagged(db_session, client):
    """The case that matters most. Same row as the test above — zero stock,
    below threshold — except the till has named it. Hiding this would be a
    worse bug than the phantom the rest of this file removes."""
    user = _make_user(db_session)
    _item(db_session, user, name="Kaffebønner", quantity=0, min_threshold=5)
    _sell(db_session, user, name="Kaffebønner")

    assert [r["name"] for r in _home_reorder(client, user)] == ["Kaffebønner"]
    assert [r["name"] for r in _stock_page_alerts(client, user)] == ["Kaffebønner"]


def test_a_stock_log_counts_as_demand_when_the_till_never_names_the_item(db_session, client):
    """Flour is weighed into dough, not rung up. An owner who counts it every
    month is using it, and a till that never says "Flour" must not be read as
    "nobody wants this"."""
    user = _make_user(db_session)
    flour = _item(db_session, user, name="Mel", quantity=0, min_threshold=10)
    _log(db_session, flour)

    assert [r["name"] for r in _home_reorder(client, user)] == ["Mel"]


def test_stock_running_down_is_urgent_without_any_demand_history(db_session, client):
    """Above zero, the rule does not ask about demand at all: somebody put this
    on the shelf and it is nearly gone. Only the EMPTY case needs a reason."""
    user = _make_user(db_session)
    _item(db_session, user, name="Servietter", quantity=2, min_threshold=10)

    assert [r["name"] for r in _home_reorder(client, user)] == ["Servietter"]


def test_demand_older_than_the_window_stops_counting(db_session, client):
    """The lookback is 90 days and it is a real boundary, not decoration."""
    user = _make_user(db_session)
    _item(db_session, user, name="Julebryg", quantity=0, min_threshold=24)
    _sell(db_session, user, name="Julebryg", days_ago=200)

    assert _home_reorder(client, user) == []


def test_an_item_with_no_threshold_is_never_urgent(db_session, client):
    """min_threshold 0 means the owner never said what "low" is for this row."""
    user = _make_user(db_session)
    _item(db_session, user, name="Dekoration", quantity=0, min_threshold=0)
    _sell(db_session, user, name="Dekoration")

    assert _home_reorder(client, user) == []


# ─── 4. The count and the list agree ──────────────────────────────────


def test_the_home_card_and_the_stock_page_flag_the_same_rows(db_session, client):
    """The assertion that would have caught "Reorder needed (23)" over an empty
    page. One mixed account: a bar template, a placeholder, a real stock-out, a
    running-down item and a well-stocked one."""
    user = _make_user(db_session, bar_pour=True)
    _item(db_session, user, name="Vodka", quantity=0, min_threshold=200, pour_size=30)
    _item(db_session, user, name="Takeaway Boxes", quantity=0, min_threshold=50)
    _item(db_session, user, name="Kaffebønner", quantity=0, min_threshold=5)
    _sell(db_session, user, name="Kaffebønner")
    _item(db_session, user, name="Servietter", quantity=2, min_threshold=10)
    _item(db_session, user, name="Mælk", quantity=20, min_threshold=5)

    batch = _batch_inventory(client, user)

    # Everything Home can talk about is something /inventory will list.
    assert sorted(r["name"] for r in batch) == sorted(
        r["name"] for r in _inventory_page_rows(client, user, bar_reachable=True)
    )
    # And the two "needs reordering" answers are the same set.
    assert sorted(r["name"] for r in _home_reorder(client, user)) == [
        "Kaffebønner",
        "Servietter",
    ]
    assert sorted(r["name"] for r in _stock_page_alerts(client, user)) == [
        "Kaffebønner",
        "Servietter",
    ]


def test_the_count_survives_more_rows_than_the_display_window(db_session, client):
    """The shape production actually has, which a 5-row fixture cannot reach.

    A 316-item shop account: 310 rows sitting at 0/0 (untouched template
    stock), and six genuinely low ones — all older than the 310. The batch
    payload samples 50 rows for display, so the six fell outside it and Home's
    card, computed over that sample, rendered NOTHING while /inventory read
    "Low stock (6)". The direction of the lie had flipped; the disagreement had
    not gone away, and now it was about REAL low stock.

    Scaled down here: 60 placeholders created after 6 low rows, so recency
    alone would bury every one of them.
    """
    user = _make_user(db_session)
    low = ["Candles", "Sandals", "Cola", "Cups", "Smør", "Havremælk"]
    for name in low:
        _item(db_session, user, name=name, quantity=1, min_threshold=8)
    for n in range(60):
        # The tie-breaker that used to decide the window: every one of these
        # satisfies `quantity <= min_threshold` (0 <= 0) without ever being
        # flaggable, and every one is NEWER than the six above.
        _item(db_session, user, name=f"Placeholder {n}", quantity=0, min_threshold=0)

    assert sorted(r["name"] for r in _home_reorder(client, user)) == sorted(low)
    assert sorted(r["name"] for r in _stock_page_alerts(client, user)) == sorted(low)


def test_the_display_sample_prefers_rows_that_can_actually_be_flagged(db_session, client):
    """`quantity <= min_threshold` is vacuously true at 0/0, so ordering by it
    let 310 unflaggable rows crowd the window. The sample must lead with rows
    the rule can actually act on."""
    user = _make_user(db_session)
    _item(db_session, user, name="Smør", quantity=1, min_threshold=2)
    for n in range(60):
        _item(db_session, user, name=f"Placeholder {n}", quantity=0, min_threshold=0)

    sample = _batch_inventory(client, user)
    assert len(sample) == 50
    assert sample[0]["name"] == "Smør"


def test_every_batch_row_carries_the_flag(db_session, client):
    """The client fails CLOSED on a missing field — it renders no card rather
    than falling back to its own arithmetic. That is only safe while the field
    is always present, so pin it."""
    user = _make_user(db_session)
    _item(db_session, user, name="Mælk", quantity=20, min_threshold=5)
    _item(db_session, user, name="Kaffebønner", quantity=1, min_threshold=5)

    sample = _batch_inventory(client, user)
    for row in sample:
        assert isinstance(row.get("needs_reorder"), bool), row
    for row in _home_reorder(client, user):
        assert row.get("needs_reorder") is True, row


def test_the_sample_flags_agree_with_the_authoritative_list(db_session, client):
    """Two payload keys answering one question can drift. Whatever the display
    sample flags must be a subset of the flagged set — never a row the card
    does not know about, and never a contradiction about the same row."""
    user = _make_user(db_session)
    _item(db_session, user, name="Servietter", quantity=2, min_threshold=10)
    _item(db_session, user, name="Takeaway Boxes", quantity=0, min_threshold=50)
    _item(db_session, user, name="Mælk", quantity=20, min_threshold=5)

    flagged = {r["id"] for r in _home_reorder(client, user)}
    in_sample = {r["id"] for r in _flagged_in_sample(_batch_inventory(client, user))}
    assert in_sample <= flagged
    assert in_sample == flagged  # …and with 3 rows the window holds them all
