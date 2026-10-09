"""POST /api/inventory/autopilot/apply — the daily recipient cap counts the
addresses that will ACTUALLY be mailed (sweep 8 Oct, item 2).

The 50-distinct-suppliers-a-day cap (Audit P3, Task #81) is what stops the
endpoint being a spam relay. It was computed from `supplier_email` in the
request body only, but apply_reorder mails the item's STORED
InventoryItem.supplier_email whenever a line leaves it out. So 500 owned
items with 500 stored addresses went out in one call before the cap saw any
of them. Now the cap resolves every line the way apply_reorder does (body
address, else the stored one — owned items only) before anything is sent.

No mail leaves a test: the sender is replaced by a list.

  cd backend && pytest tests/test_inventory_autopilot_recipient_cap.py -v
"""
from __future__ import annotations

import json

import pytest

from app.models.audit_log import AuditLog
from tests.test_inventory_autopilot import (  # noqa: F401 — fixtures
    _item,
    _override_user,
    _owner,
    client,
    db,
    engine_and_session,
)

CAP = 50


@pytest.fixture
def outbox(monkeypatch):
    sent: list[str] = []

    def _fake(to, subject, html, **kw):
        sent.append(to)
        return True

    monkeypatch.setattr("app.services.email_service.send_email", _fake)
    return sent


def _apply(client, lines):
    return client.post("/api/inventory/autopilot/apply", json={"items": lines})


def _stored_items(db, owner, n, prefix="sup"):
    return [
        _item(db, owner, name=f"Vare {i}", qty=0, supplier_email=f"{prefix}{i}@example.com")
        for i in range(n)
    ]


def test_stored_addresses_count_toward_the_cap(client, db, outbox):
    """51 owned items, each with its own stored supplier address, body lines
    without supplier_email: the call is refused BEFORE any mail goes out."""
    owner = _owner(db)
    items = _stored_items(db, owner, CAP + 1)
    _override_user(owner)
    r = _apply(client, [{"item_id": str(it.id), "qty": 2} for it in items])
    assert r.status_code == 429, r.text
    d = r.json()["detail"]
    assert d["code"] == "daily_recipient_cap"
    assert d["projected"] == CAP + 1
    assert outbox == []


def test_stored_addresses_add_to_todays_recipients(client, db, outbox):
    """Recipients already mailed today + stored addresses in this call."""
    from app.services import audit_service
    owner = _owner(db)
    for i in range(CAP - 2):
        audit_service.record(db, user=owner, action="inventory.autopilot_applied",
                             entity_type="inventory_order", entity_id=None,
                             after={"supplier_email": f"earlier{i}@example.com"})
    db.commit()
    items = _stored_items(db, owner, 3, prefix="new")
    _override_user(owner)
    r = _apply(client, [{"item_id": str(it.id), "qty": 1} for it in items])
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["projected"] == CAP + 1
    assert outbox == []


def test_a_body_address_replaces_the_stored_one_in_the_count(client, db, outbox):
    """The owner may redirect lines to one supplier on the way to send: the
    stored addresses those lines no longer use are not counted."""
    owner = _owner(db)
    items = _stored_items(db, owner, CAP + 5)
    _override_user(owner)
    r = _apply(client, [
        {"item_id": str(it.id), "qty": 1, "supplier_email": "grossist@example.com"}
        for it in items
    ])
    assert r.status_code == 200, r.text
    assert r.json()["sent"] == 1
    assert outbox == ["grossist@example.com"]


def test_under_the_cap_stored_addresses_are_mailed_as_before(client, db, outbox):
    owner = _owner(db)
    items = _stored_items(db, owner, 3)
    # One item with no address anywhere: skipped, never counted.
    bare = _item(db, owner, name="Uden leverandør", qty=0, supplier_email=None)
    _override_user(owner)
    r = _apply(client, [{"item_id": str(it.id), "qty": 1} for it in items + [bare]])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["sent"] == 3 and body["skipped_no_supplier"] == 1
    assert sorted(outbox) == sorted(f"sup{i}@example.com" for i in range(3))
    rows = db.query(AuditLog).filter(AuditLog.user_id == owner.id,
                                     AuditLog.action == "inventory.autopilot_applied").all()
    assert sorted(json.loads(r.after_state)["supplier_email"] for r in rows) == \
        sorted(f"sup{i}@example.com" for i in range(3))


def test_only_owned_items_are_counted(client, db, outbox):
    """Another venue's items are never read into the count (their stored
    addresses are none of this caller's business): the foreign ids are still
    refused by the tenant check (400), not answered with a cap that reflects
    the other venue's supplier list."""
    owner_a = _owner(db, email_suffix="_a")
    owner_b = _owner(db, email_suffix="_b")
    foreign = _stored_items(db, owner_b, CAP + 10, prefix="b")
    _override_user(owner_a)
    r = _apply(client, [{"item_id": str(it.id), "qty": 1} for it in foreign])
    assert r.status_code == 400, r.text
    assert outbox == []
