"""One rule for "does the owner need to reorder this?", shared by every surface.

THE DEFECT THIS EXISTS TO CLOSE. The founder's own account rendered
"Reorder needed (23)" on Home and an empty state on /inventory, at the same
moment, for the same 23 rows. Read out of production, those rows were the
pour-tracked half of the Bar template — Vodka, Gin, Rum, Draft Beer, the
wines, the mixers — inserted in one batch on 2026-05-04, every one of them
quantity 0.00 with the template's own min_threshold, `updated_at` still within
a fraction of a millisecond of `created_at`. Not one had ever been sold, and
`inventory_logs` held zero rows for any of them. They were placeholders from a
template the owner loaded once and never used.

Two independent things were wrong, and fixing either alone leaves a lie:

  1. THE ROWS WERE INVISIBLE. /inventory drops pour-tracked items client-side
     (`!i.pour_size || i.pour_size <= 0`) because bottles live on /bar. The
     Home card counted every row the batch endpoint returned and then navigated
     to /inventory — so it urged the owner toward a page that shows none of
     them. An owner must never be told to reorder something they cannot see.

  2. ZERO STOCK IS NOT URGENCY. Quantity 0 against a threshold the owner never
     chose (the template picked it) reads as maximum urgency under any
     `quantity <= min_threshold` rule, even though nothing has ever moved.

The rule below therefore has BOTH halves, and the second one is written so it
cannot be used to silence a genuine problem: an item at zero stock that the
venue actually sells still raises its hand. Hiding a real stock-out would be a
worse bug than the phantom this replaces, so the demand window is deliberately
generous (90 days, wider than the autopilot's own 8-week lookback) and every
`needs_reorder` above zero stock is unconditional.
"""
from datetime import date, timedelta
from typing import Iterable, Optional

from sqlalchemy import or_, true
from sqlalchemy.orm import Session

from app.models.inventory import InventoryItem, InventoryLog
from app.models.sale import Sale
from app.models.user import User
from app.services import modules

# How far back a movement still counts as "the venue sells this". Wider than
# inventory_autopilot's LOOKBACK_WEEKS (8) on purpose: a seasonal line that
# last sold eleven weeks ago and is now empty is a real stock-out, and the
# asymmetry of the two mistakes is not close — a phantom reorder wastes a
# glance, a hidden one loses a service.
DEMAND_LOOKBACK_DAYS = 90


def bar_surface_is_reachable(user: User) -> bool:
    """Does this owner have a page where a pour-tracked bottle is shown?

    /bar is gated on the `bar_pour` vertical module (navManifest.js), so for an
    owner who has not enabled it the route is in no sidebar and on no More
    page. "Bottles live on /bar" is then not a routing fact but a place the
    row goes to disappear — and a bottle that is genuinely running down would
    raise its hand nowhere: not in /inventory's table, not in its Low stock
    list, not on Home. That is a strictly worse failure than the phantom count
    this module exists to remove, so the visibility rule below asks this
    question first.
    """
    return modules.is_enabled(user, "bar_pour")


def stock_page_visible_clause(user: User):
    """The rows /inventory actually renders FOR THIS OWNER.

    Mirrors InventoryPage.jsx's own filter (`!i.pour_size || i.pour_size <= 0`)
    including its boundary: pour_size 0 means "not pour-tracked", so such a row
    is general stock and stays. Anything counted on Home must pass this, or the
    card promises a page that cannot keep it.

    The filter is conditional for the reason above: it may only hide a bottle
    while there is a /bar to hide it ON. InventoryPage applies the same
    condition client-side, so the two halves cannot drift.
    """
    if not bar_surface_is_reachable(user):
        return true()
    return or_(InventoryItem.pour_size.is_(None), InventoryItem.pour_size <= 0)


def reorder_items(
    db: Session,
    *,
    user: User,
    today: Optional[date] = None,
) -> list[InventoryItem]:
    """THE flagged set — every visible row this owner needs to reorder.

    Deliberately unbounded. Home's card used to be computed from the first 50
    rows /dashboard/batch happened to return, which made its number a count of
    a WINDOW rather than a count of the thing. On a 316-row shop account whose
    low rows were all older than the 50 newest, every genuinely low item fell
    outside that window: /inventory said "Low stock (6)" and Home said nothing.
    Same two screens, same disagreement, opposite direction.

    Both surfaces now call this. Agreement is structural, not a convention two
    endpoints are each asked to remember.
    """
    candidates = (
        db.query(InventoryItem)
        .filter(
            InventoryItem.user_id == user.id,
            stock_page_visible_clause(user),
            # Covered by ix_inventory_user_stock (user_id, quantity,
            # min_threshold) — the same index /inventory/alerts already used.
            InventoryItem.min_threshold > 0,
            InventoryItem.quantity <= InventoryItem.min_threshold,
        )
        .all()
    )
    moving = moving_item_ids(db, user=user, items=candidates, today=today)
    return [
        item
        for item in candidates
        if needs_reorder(
            quantity=float(item.quantity),
            min_threshold=float(item.min_threshold or 0),
            is_moving=item.id in moving,
        )
    ]


def moving_item_ids(
    db: Session,
    *,
    user: User,
    items: Iterable[InventoryItem],
    today: Optional[date] = None,
) -> set:
    """Ids of the items the venue actually sells or handles.

    Two signals, because a venue proves demand in two different ways and only
    one of them is guaranteed to be wired up:

      • a Sale naming the item — the same `Sale.item_name == InventoryItem.name`
        join /inventory/dead-stock already uses, so "this sells" means the same
        thing on both screens;
      • an InventoryLog row — a pour, a restock, a stocktake correction. An item
        the owner counts every month is in use even if the till never names it.

    One query each, both bounded to the lookback window and to this tenant.
    """
    items = list(items)
    if not items:
        return set()

    since = (today or date.today()) - timedelta(days=DEMAND_LOOKBACK_DAYS)
    ids = [i.id for i in items]

    log_rows = (
        db.query(InventoryLog.item_id)
        .filter(InventoryLog.item_id.in_(ids), InventoryLog.date >= since)
        .distinct()
        .all()
    )
    moving = {r[0] for r in log_rows}

    # Sales carry a free-text item_name, so match the way the rest of the app
    # does: case-folded and trimmed. Pulling the venue's sold names once and
    # matching in Python beats a per-item query and keeps the comparison in one
    # place.
    sale_rows = (
        db.query(Sale.item_name)
        .filter(
            Sale.user_id == user.id,
            Sale.is_deleted.isnot(True),
            Sale.item_name.isnot(None),
            Sale.item_name != "",
            Sale.date >= since,
        )
        .distinct()
        .all()
    )
    sold = {(r[0] or "").strip().casefold() for r in sale_rows}
    sold.discard("")

    for item in items:
        if (item.name or "").strip().casefold() in sold:
            moving.add(item.id)
    return moving


def needs_reorder(*, quantity: float, min_threshold: float, is_moving: bool) -> bool:
    """The one predicate. Three cases, in the order they decide.

    No threshold      → the owner never said what "low" means for this item.
    Above threshold   → there is stock; nothing to say.
    At or below it    → urgent if there IS stock running down (unconditional:
                        someone put it on the shelf and it is nearly gone), or
                        if it is empty AND the venue actually moves it.

    The last clause is the whole fix: empty-and-never-moved is a placeholder,
    empty-and-selling is a stock-out.
    """
    if min_threshold <= 0:
        return False
    if quantity > min_threshold:
        return False
    if quantity > 0:
        return True
    return is_moving
