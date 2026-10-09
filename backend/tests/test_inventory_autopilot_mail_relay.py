"""POST /api/inventory/autopilot/apply is not a mail relay (review, 8 Oct).

1e6a9a8f made the 50-distinct-recipient cap count the addresses that are
really mailed. Three gaps stayed open, each closed here:

  * a confirmed sender — an unconfirmed (possibly squatted) account mails no
    supplier, the same rule as faktura mail and team invites;
  * a per-account daily TOTAL of supplier mails (the distinct cap alone let
    the same 50 addresses be mailed again and again), and a per-mailbox daily
    limit counted by mailbox ("+tags" fold into one inbox);
  * the order mail escapes every typed value (item name, unit, supplier name,
    business name) and the subject is header-safe.

No mail leaves a test: the sender is replaced by a list.

  cd backend && pytest tests/test_inventory_autopilot_mail_relay.py -v
"""
from __future__ import annotations

import pytest

from app.services import audit_service
from tests.test_inventory_autopilot import (  # noqa: F401 — fixtures
    _item,
    _override_user,
    _owner,
    client,
    db,
    engine_and_session,
)

EVIL = '<img src=x onerror="alert(1)">'


@pytest.fixture
def outbox(monkeypatch):
    sent: list[dict] = []

    def _fake(to, subject, html, **kw):
        sent.append({"to": to, "subject": subject, "html": html})
        return True

    monkeypatch.setattr("app.services.email_service.send_email", _fake)
    return sent


def _apply(client, lines):
    return client.post("/api/inventory/autopilot/apply", json={"items": lines})


def _verified_owner(db, **kw):
    owner = _owner(db, **kw)
    owner.email_verified = True
    db.commit()
    db.refresh(owner)
    return owner


def _earlier_sends(db, owner, addresses):
    for a in addresses:
        audit_service.record(db, user=owner, action="inventory.autopilot_applied",
                             entity_type="inventory_order", entity_id=None,
                             after={"supplier_email": a})
    db.commit()


def test_an_unconfirmed_account_mails_no_supplier(client, db, outbox):
    owner = _owner(db)
    owner.email_verified = False
    db.commit()
    item = _item(db, owner, name="Bønner", qty=0, supplier_email="leverandor@example.com")
    _override_user(owner)
    r = _apply(client, [{"item_id": str(item.id), "qty": 2}])
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "email_unverified"
    assert outbox == []


def test_a_confirmed_account_still_sends(client, db, outbox):
    owner = _verified_owner(db)
    item = _item(db, owner, name="Bønner", qty=0, supplier_email="leverandor@example.com")
    _override_user(owner)
    r = _apply(client, [{"item_id": str(item.id), "qty": 2}])
    assert r.status_code == 200, r.text
    assert [m["to"] for m in outbox] == ["leverandor@example.com"]


def test_the_same_address_is_mailed_at_most_three_times_a_day(client, db, outbox):
    owner = _verified_owner(db)
    item = _item(db, owner, name="Bønner", qty=0, supplier_email="leverandor@example.com")
    _override_user(owner)
    for _ in range(3):
        assert _apply(client, [{"item_id": str(item.id), "qty": 1}]).status_code == 200
    r = _apply(client, [{"item_id": str(item.id), "qty": 1}])
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["code"] == "supplier_address_daily_cap"
    assert r.json()["detail"].get("message_da")
    assert len(outbox) == 3


def test_plus_tags_fold_into_one_mailbox(client, db, outbox):
    owner = _verified_owner(db)
    _earlier_sends(db, owner, ["anna+1@gmail.com", "a.nna+2@gmail.com", "ANNA@googlemail.com"])
    item = _item(db, owner, name="Mel", qty=0, supplier_email="anna+4@gmail.com")
    _override_user(owner)
    r = _apply(client, [{"item_id": str(item.id), "qty": 1}])
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["code"] == "supplier_address_daily_cap"
    assert outbox == []


def test_a_daily_total_of_supplier_mails_per_account(client, db, outbox):
    """99 mails earlier today to 40 addresses (under the 50-distinct cap and
    under 3 per address): two more orders would be 101 > 100 — refused before
    anything is sent."""
    owner = _verified_owner(db)
    _earlier_sends(db, owner, [f"s{i % 40}@example.com" for i in range(99)])
    a = _item(db, owner, name="A", qty=0, supplier_email="ny1@example.com")
    b = _item(db, owner, name="B", qty=0, supplier_email="ny2@example.com")
    _override_user(owner)
    r = _apply(client, [{"item_id": str(a.id), "qty": 1}, {"item_id": str(b.id), "qty": 1}])
    assert r.status_code == 429, r.text
    d = r.json()["detail"]
    assert d["code"] == "daily_order_mail_cap"
    assert d["sent_today"] == 99
    assert outbox == []
    # One more fits exactly.
    r = _apply(client, [{"item_id": str(a.id), "qty": 1}])
    assert r.status_code == 200, r.text
    assert [m["to"] for m in outbox] == ["ny1@example.com"]


def test_the_order_mail_escapes_every_typed_value(client, db, outbox):
    owner = _verified_owner(db)
    owner.business_name = f"Café {EVIL}\r\nBcc: x@evil.example"
    db.commit()
    item = _item(db, owner, name=f"Mel {EVIL}", qty=0, supplier_email="leverandor@example.com")
    _override_user(owner)
    r = _apply(client, [{
        "item_id": str(item.id), "qty": 1, "unit": f"kg{EVIL}"[:20],
        "supplier_name": f"Grossist {EVIL}",
    }])
    assert r.status_code == 200, r.text
    mail = outbox[-1]
    assert "<img" not in mail["html"], mail["html"]
    assert "&lt;img" in mail["html"]
    assert "\r" not in mail["subject"] and "\n" not in mail["subject"]


def test_format_order_email_escapes_directly():
    from types import SimpleNamespace
    from app.services.inventory_autopilot import _format_order_email
    user = SimpleNamespace(business_name=EVIL)
    subject, html = _format_order_email(
        user=user, supplier_name=EVIL,
        items=[{"name": EVIL, "unit": "<b>", "qty": 1, "cost_per_unit": 2}],
    )
    assert "<img" not in html and "<b>" not in html
    assert html.count("&lt;img") >= 3
