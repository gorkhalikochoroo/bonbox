"""R2 (27 Oct 2026) — spam clean-up on the owner's book, and every promise true.

Booking needs no account; when junk gets into the book anyway the owner
cleans it up, and nothing reaches the address a stranger typed:
  • "Spam" on a booking: cancelled with no guest mail, out of the month's
    count (a Free page a burst closed opens again), its contact MARKED — the
    next online booking from that phone or mailbox (+tags and Gmail dots
    folded) is held quietly as `marked_spam`; with block: true the contact
    is BLOCKED — refused with the generic 409 not_accepting. Undo within
    30 minutes.
  • "Afvis alle fra denne bølge": every open online request made within 10
    minutes of the one opened, declined at once, no mail — only the ids the
    owner was shown.
  • the block list keeps a keyed hash and a masked hint, never the number
    or the address; retention, a cap, and an erase-by-contact path.
  • the screen's same-guest rule counts a mailbox, not a spelling (decision
    5: folded in code, in SQL, no new column).
  • a held booking with a severe allergy that the owner SEATS straight away
    alerts the stand once (only "confirmed" did).
  • the receipt's calendar file gets the booking's real length.

Run: cd backend && python -m pytest tests/test_r2_spam_cleanup.py -q
"""
from __future__ import annotations

import json
import time
import uuid
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import func

from app.models.audit_log import AuditLog
from app.models.reservation import Reservation
from app.models.staff import NotificationLog
from app.services import contact_marks
from app.services.mailbox import canonical_mailbox, mailbox_sql_match
from app.utils import abuse_signals
from app.utils.time import utc_now
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    active_occupancy, as_owner, book, client, db, engine_and_session, outbox,
    reservation, restaurant, salon, shift, today_local, volume_on,
)

DAY = today_local() + timedelta(days=5)


def _held_reason(db, rid):
    db.expire_all()
    row = (db.query(AuditLog)
           .filter(AuditLog.action == "reservation.held_public",
                   AuditLog.entity_id == uuid.UUID(str(rid)))
           .first())
    return json.loads(row.after_state or "{}").get("reason") if row else None


def _settings_json(db, profile) -> str:
    db.expire_all()
    db.refresh(profile)
    return profile.reservation_settings_json or ""


def _spam(client, rid, **body):
    return client.post(f"/api/reservations/reservations/{rid}/spam", json=body)


# ── Spam on one booking ───────────────────────────────────────────────────

def test_spam_cancels_silently_frees_the_table_and_marks_the_contact(client, db, outbox):
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=DAY, time="19:00", name="Falsk Frida",
             email="falsk@example.com", phone="+45 22 33 44 55")
    rid = r.json()["id"]
    assert r.json()["status"] == "confirmed" and len(active_occupancy(db, rid)) == 1
    mails_before = len(outbox)
    as_owner(u)
    res = _spam(client, rid)
    assert res.status_code == 200, res.text
    body = res.json()
    row = reservation(db, rid)
    assert row.status == "cancelled" and row.cancel_reason == "owner_spam"
    assert active_occupancy(db, rid) == []
    # Silently: no mail of any kind went out because of it.
    assert len(outbox) == mails_before
    # The contact is marked (both the phone and the mailbox), masked.
    hints = sorted(e["hint"] for e in body["contact"]["entries"])
    assert hints == sorted(["•• •• •• 55", "f•••@example.com"])
    assert body["contact"]["mode"] == "spam"
    assert {e["mode"] for e in body["contact"]["entries"]} == {"spam"}
    # The audit row carries ids and a status, never the contact.
    a = db.query(AuditLog).filter(AuditLog.action == "reservation.marked_spam").one()
    assert "falsk" not in (a.after_state or "").lower() and "2233" not in (a.after_state or "")
    assert json.loads(a.after_state)["prev_status"] == "confirmed"


def test_the_next_booking_from_a_marked_contact_is_held_quietly(client, db, outbox):
    u, p, _ = restaurant(db)
    slug = p.reservation_slug
    first = book(client, slug, day=DAY, time="18:00", email="anna@gmail.com", phone="22334455")
    as_owner(u)
    assert _spam(client, first.json()["id"]).status_code == 200
    mails_before = len(outbox)
    # The same mailbox spelt another way (+tag, dots) — held, robot-like.
    again = book(client, slug, day=DAY + timedelta(days=1), time="19:00",
                 email="a.nna+igen@gmail.com", ip="10.9.9.9")
    assert again.status_code == 200, again.text
    assert again.json()["status"] == "requested"
    assert _held_reason(db, again.json()["id"]) == "marked_spam"
    assert again.json()["guest_mail"] is False
    assert len(outbox) == mails_before            # no mail to the typed address, no owner mail
    # The same phone, another format, no e-mail: held too.
    by_phone = book(client, slug, day=DAY + timedelta(days=2), time="19:00", email=None,
                    phone="+45 22 33 44 55", ip="10.9.9.8")
    assert by_phone.json()["status"] == "requested"
    assert _held_reason(db, by_phone.json()["id"]) == "marked_spam"
    # A different guest is untouched.
    other = book(client, slug, day=DAY, time="20:00", email="bo@example.dk", ip="10.9.9.7")
    assert other.json()["status"] == "confirmed"


def test_spam_and_block_refuses_the_contact_with_the_generic_answer(client, db, outbox):
    u, p, _ = restaurant(db)
    slug = p.reservation_slug
    first = book(client, slug, day=DAY, time="18:00", email="plage@example.com", phone="99887766")
    as_owner(u)
    res = _spam(client, first.json()["id"], block=True)
    assert res.status_code == 200, res.text
    assert {e["mode"] for e in res.json()["contact"]["entries"]} == {"block"}
    abuse_signals.reset()
    rows_before = db.query(func.count(Reservation.id)).scalar()
    for kw in ({"email": "PLAGE+x@example.com"}, {"email": None, "phone": "+45 99 88 77 66"}):
        r = book(client, slug, day=DAY + timedelta(days=1), time="19:00", ip="10.1.1.1", **kw)
        assert r.status_code == 409, r.text
        assert r.json()["detail"] == {"error": "not_accepting"}     # never "blocked"
    db.expire_all()
    assert db.query(func.count(Reservation.id)).scalar() == rows_before   # no row
    assert abuse_signals.drain().get("booking_blocked") == 2
    ok = book(client, slug, day=DAY + timedelta(days=1), time="19:00", email="ny@example.dk",
              ip="10.1.1.2")
    assert ok.json()["status"] == "confirmed"


def test_the_store_keeps_no_number_and_no_address(client, db, outbox):
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=DAY, email="hemmelig.person@firma.dk",
             phone="+45 31 41 59 26")
    as_owner(u)
    assert _spam(client, r.json()["id"], block=True).status_code == 200
    raw = _settings_json(db, p)
    for secret in ("hemmelig", "31415926", "31 41 59 26"):
        assert secret not in raw, secret
    stored = json.loads(raw)["contact_blocks"]
    assert len(stored) == 2 and all(len(e["h"]) == 32 for e in stored)
    # The app never gets the hashes: not in /settings, not in the list.
    s = client.get("/api/reservations/settings").json()
    assert "contact_blocks" not in s["settings"]
    listed = client.get("/api/reservations/contact-blocks").json()
    assert len(listed["blocks"]) == 2 and all("h" not in e for e in listed["blocks"])
    assert listed["days"] == 180


def test_spam_is_the_owners_own_and_only_for_online_bookings(client, db, outbox):
    u, p, _ = restaurant(db)
    other, _, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=DAY)
    as_owner(other)
    assert _spam(client, r.json()["id"]).status_code == 404
    as_owner(u)
    manual = Reservation(user_id=u.id, guest_name="Telefon", party_size=2,
                         starts_at=datetime.combine(DAY, datetime.min.time()) + timedelta(hours=12),
                         ends_at=datetime.combine(DAY, datetime.min.time()) + timedelta(hours=13),
                         duration_min=60, status="confirmed", source="manual")
    db.add(manual); db.commit()
    res = _spam(client, manual.id)
    assert res.status_code == 409 and res.json()["detail"]["error"] == "not_online"
    seated = reservation(db, r.json()["id"])
    seated.status = "seated"; db.commit()
    res = _spam(client, r.json()["id"])
    assert res.status_code == 409 and res.json()["detail"]["error"] == "not_spam_state"


def test_spam_gives_the_month_back_and_a_closed_free_page_opens_again(client, db, outbox):
    """T8: 20 confirmed online bookings close a Free venue's page (the cap
    takes no requests while the switch is off). Marking ONE as spam gives
    its place back: the page offers times again."""
    u, p, _ = restaurant(db, plan="free")
    slug = p.reservation_slug
    far = datetime.combine(today_local() + timedelta(days=30), datetime.min.time()) + timedelta(hours=12)
    rows = []
    for i in range(20):
        x = Reservation(user_id=u.id, guest_name=f"Bot {i}", guest_email=f"bot{i}@x.test",
                        party_size=2, starts_at=far, ends_at=far + timedelta(minutes=90),
                        duration_min=90, status="confirmed", source="public")
        db.add(x); rows.append(x)
    db.commit()
    s = client.get(f"/api/public/reservations/{slug}/availability-summary",
                   params={"from": DAY.isoformat(), "days": 3, "party": 2}).json()
    assert s.get("closed_reason") == "not_accepting"
    as_owner(u)
    res = _spam(client, rows[0].id)
    assert res.status_code == 200, res.text
    assert res.json()["reservations_used_this_month"] == 19
    assert res.json()["reservations_cap"] == 20
    s = client.get(f"/api/public/reservations/{slug}/availability-summary",
                   params={"from": DAY.isoformat(), "days": 3, "party": 2}).json()
    assert s.get("closed_reason") != "not_accepting" and s["next_open_day"]


def test_undo_gives_the_booking_its_table_back_and_unmarks_the_contact(client, db, outbox):
    u, p, _ = restaurant(db)
    slug = p.reservation_slug
    r = book(client, slug, day=DAY, time="19:00", email="ups@example.com")
    rid = r.json()["id"]
    as_owner(u)
    assert _spam(client, rid, block=True).status_code == 200
    undo = client.post(f"/api/reservations/reservations/{rid}/spam/undo")
    assert undo.status_code == 200, undo.text
    row = reservation(db, rid)
    assert row.status == "confirmed" and row.cancel_reason is None and row.cancelled_at is None
    assert len(active_occupancy(db, rid)) == 1
    assert client.get("/api/reservations/contact-blocks").json()["blocks"] == []
    again = book(client, slug, day=DAY + timedelta(days=1), email="ups@example.com", ip="10.2.2.2")
    assert again.json()["status"] == "confirmed"
    # Twice is nothing to undo.
    assert client.post(f"/api/reservations/reservations/{rid}/spam/undo").status_code == 409


def test_undo_says_so_when_the_table_went_meanwhile(client, db, outbox):
    u, p, _ = restaurant(db, tables=1)
    slug = p.reservation_slug
    r = book(client, slug, day=DAY, time="19:00", email="forste@example.com")
    rid = r.json()["id"]
    as_owner(u)
    assert _spam(client, rid).status_code == 200
    taken = book(client, slug, day=DAY, time="19:00", email="anden@example.com", ip="10.3.3.3")
    assert taken.json()["status"] == "confirmed"
    undo = client.post(f"/api/reservations/reservations/{rid}/spam/undo")
    assert undo.status_code == 409 and undo.json()["detail"]["error"] == "slot_unavailable"
    assert reservation(db, rid).status == "cancelled"


def test_undo_has_a_time_limit(client, db, outbox):
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=DAY, email="sent@example.com")
    rid = r.json()["id"]
    as_owner(u)
    assert _spam(client, rid).status_code == 200
    a = db.query(AuditLog).filter(AuditLog.action == "reservation.marked_spam").one()
    a.created_at = utc_now() - timedelta(minutes=31)
    db.commit()
    undo = client.post(f"/api/reservations/reservations/{rid}/spam/undo")
    assert undo.status_code == 409 and undo.json()["detail"]["error"] == "undo_expired"


def test_the_guests_receipt_never_says_spam(client, db, outbox):
    """A booking marked as spam reads "cancelled by the venue" on the guest's
    receipt; a request that held no table reads "declined" — never "spam"."""
    u, p, _ = restaurant(db)
    slug = p.reservation_slug
    conf = book(client, slug, day=DAY, time="18:00", email="b1@example.com").json()
    req = book(client, slug, day=DAY, time="19:00", email="b2@example.com", form_ms=300,
               ip="10.8.8.8").json()
    assert req["status"] == "requested"
    as_owner(u)
    for x in (conf, req):
        assert _spam(client, x["id"]).status_code == 200
    seen = {x["id"]: client.get(f"/api/public/reservations/booking/{x['id']}",
                                params={"token": x["booking_token"]}).json()["outcome"]
            for x in (conf, req)}
    assert seen == {conf["id"]: "cancelled_by_venue", req["id"]: "declined"}


def test_a_malformed_stored_id_is_fixed_once_so_fjern_finds_it(client, db, outbox):
    u, p, _ = restaurant(db)
    as_owner(u)
    client.post("/api/reservations/contact-blocks", json={"phone": "55667788"})
    raw = json.loads(_settings_json(db, p))
    raw["contact_blocks"][0]["id"] = "not-an-id"
    p.reservation_settings_json = json.dumps(raw)
    db.commit()
    first = client.get("/api/reservations/contact-blocks").json()["blocks"][0]["id"]
    assert first != "not-an-id"
    assert client.get("/api/reservations/contact-blocks").json()["blocks"][0]["id"] == first
    assert client.delete(f"/api/reservations/contact-blocks/{first}").status_code == 200


# ── A wave ────────────────────────────────────────────────────────────────

def _request(db, owner, *, minutes_ago: float, status="requested", source="public", name="Bølge"):
    start = datetime.combine(DAY, datetime.min.time()) + timedelta(hours=19)
    x = Reservation(user_id=owner.id, guest_name=name, guest_email=f"{uuid.uuid4().hex[:8]}@x.test",
                    party_size=12, starts_at=start, ends_at=start + timedelta(minutes=120),
                    duration_min=120, status=status, source=source,
                    created_at=utc_now() - timedelta(minutes=minutes_ago))
    db.add(x); db.commit(); db.refresh(x)
    return x


def test_a_wave_is_the_open_online_requests_made_within_ten_minutes(client, db, outbox):
    u, p, _ = restaurant(db)
    anchor = _request(db, u, minutes_ago=20)
    inside = [_request(db, u, minutes_ago=m) for m in (29, 25, 15, 11)]
    outside = _request(db, u, minutes_ago=31)                      # 11 min before the anchor
    confirmed = _request(db, u, minutes_ago=19, status="confirmed")
    manual = _request(db, u, minutes_ago=18, source="manual")
    as_owner(u)
    w = client.get(f"/api/reservations/spam-wave/{anchor.id}").json()
    assert w["count"] == 5 and w["minutes"] == 10
    assert set(w["ids"]) == {str(x.id) for x in [anchor, *inside]}
    assert w["first_at"].endswith("Z") and w["first_at"] <= w["last_at"]
    mails_before = len(outbox)
    res = client.post(f"/api/reservations/spam-wave/{anchor.id}", json={"ids": w["ids"]})
    assert res.status_code == 200, res.text
    assert res.json()["rejected"] == 5
    db.expire_all()
    for x in [anchor, *inside]:
        row = reservation(db, x.id)
        assert row.status == "cancelled" and row.cancel_reason == "owner_spam"
    for x in (outside, confirmed, manual):
        assert reservation(db, x.id).status == x.status
    assert len(outbox) == mails_before                              # nobody is mailed
    assert db.query(AuditLog).filter(AuditLog.action == "reservation.marked_spam").count() == 5


def test_a_request_that_came_in_after_the_owner_looked_is_never_declined_unseen(client, db, outbox):
    u, p, _ = restaurant(db)
    anchor = _request(db, u, minutes_ago=5)
    as_owner(u)
    w = client.get(f"/api/reservations/spam-wave/{anchor.id}").json()
    late = _request(db, u, minutes_ago=0)
    res = client.post(f"/api/reservations/spam-wave/{anchor.id}", json={"ids": w["ids"]})
    assert res.json()["rejected"] == 1
    assert reservation(db, late.id).status == "requested"


def test_a_wave_is_the_owners_own(client, db, outbox):
    u, p, _ = restaurant(db)
    other, _, _ = restaurant(db)
    anchor = _request(db, u, minutes_ago=1)
    as_owner(other)
    assert client.get(f"/api/reservations/spam-wave/{anchor.id}").status_code == 404
    assert client.post(f"/api/reservations/spam-wave/{anchor.id}",
                       json={"ids": [str(anchor.id)]}).status_code == 404
    # A confirmed booking is no wave.
    as_owner(u)
    c = _request(db, u, minutes_ago=1, status="confirmed")
    assert client.get(f"/api/reservations/spam-wave/{c.id}").json()["count"] == 0


# ── The block list ────────────────────────────────────────────────────────

def test_block_a_typed_phone_then_remove_it(client, db, outbox):
    u, p, _ = restaurant(db)
    slug = p.reservation_slug
    as_owner(u)
    res = client.post("/api/reservations/contact-blocks", json={"phone": "+45 12 34 56 78"})
    assert res.status_code == 201, res.text
    (entry,) = res.json()["blocks"]
    assert entry["kind"] == "phone" and entry["mode"] == "block" and entry["hint"] == "•• •• •• 78"
    assert res.json()["created"] == [entry["id"]]
    assert book(client, slug, day=DAY, email=None, phone="12345678").status_code == 409
    gone = client.delete(f"/api/reservations/contact-blocks/{entry['id']}")
    assert gone.status_code == 200 and gone.json()["blocks"] == []
    assert book(client, slug, day=DAY, email=None, phone="12345678").json()["status"] == "confirmed"
    assert client.delete(f"/api/reservations/contact-blocks/{entry['id']}").status_code == 404


def test_block_needs_a_usable_contact(client, db, outbox):
    u, p, _ = restaurant(db)
    as_owner(u)
    for body in ({}, {"phone": "123"}, {"email": "not-an-address"}):
        res = client.post("/api/reservations/contact-blocks", json=body)
        assert res.status_code == 422 and res.json()["detail"]["error"] == "no_contact", body


def test_unblocking_an_upgraded_mark_keeps_the_mark(client, db, outbox):
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=DAY, email="mark@example.com")
    as_owner(u)
    assert _spam(client, r.json()["id"]).status_code == 200
    up = client.post("/api/reservations/contact-blocks", json={"email": "mark+1@example.com"}).json()
    assert up["created"] == [] and len(up["upgraded"]) == 1
    assert up["blocks"][0]["mode"] == "block"
    back = client.delete(f"/api/reservations/contact-blocks/{up['upgraded'][0]}",
                         params={"keep_mark": 1}).json()
    assert [b["mode"] for b in back["blocks"]] == ["spam"]


def test_a_guest_can_be_forgotten_by_contact(client, db, outbox):
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=DAY, email="glem.mig@gmail.com", phone="40506070")
    as_owner(u)
    assert _spam(client, r.json()["id"], block=True).status_code == 200
    res = client.post("/api/reservations/contact-blocks/erase", json={"email": "glemmig+x@gmail.com"})
    assert res.status_code == 200 and res.json()["removed"] == 1
    res = client.post("/api/reservations/contact-blocks/erase", json={"phone": "+45 40 50 60 70"})
    assert res.json()["removed"] == 1 and res.json()["blocks"] == []
    raw = _settings_json(db, p)
    assert json.loads(raw)["contact_blocks"] == []
    assert db.query(AuditLog).filter(AuditLog.action == "reservation.contact_erased").count() == 2


def test_a_settings_save_never_replaces_the_block_list(client, db, outbox):
    u, p, _ = restaurant(db)
    as_owner(u)
    client.post("/api/reservations/contact-blocks", json={"phone": "11223344"})
    res = client.put("/api/reservations/settings",
                     json={"settings": {"contact_blocks": [], "lead_time_min": 30}})
    assert res.status_code == 200, res.text
    assert len(client.get("/api/reservations/contact-blocks").json()["blocks"]) == 1


def test_expired_entries_never_match_and_are_dropped():
    owner = uuid.uuid4()
    past = date(2025, 1, 1)
    entries, created, _ = contact_marks.add([], owner, phone="12345678", mode="block", today=past)
    assert created and contact_marks.match(entries, owner, phone="12345678", today=past) == "block"
    later = past + timedelta(days=contact_marks.retention_days() + 1)
    assert contact_marks.match(entries, owner, phone="12345678", today=later) is None
    assert contact_marks.clean(entries, later) == []


def test_the_list_is_capped_oldest_marks_first(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "BOOKING_CONTACT_MARKS_MAX", 3)
    owner = uuid.uuid4()
    d0 = date(2026, 10, 1)
    entries, _, _ = contact_marks.add([], owner, phone="10000001", mode="block", today=d0)
    entries, _, _ = contact_marks.add(entries, owner, phone="10000002", mode="spam", today=d0 + timedelta(days=1))
    entries, _, _ = contact_marks.add(entries, owner, phone="10000003", mode="spam", today=d0 + timedelta(days=2))
    entries, _, _ = contact_marks.add(entries, owner, phone="10000004", mode="block", today=d0 + timedelta(days=3))
    hints = sorted(e["hint"] for e in entries)
    assert len(entries) == 3
    assert "•• •• •• 02" not in hints        # the oldest spam mark went
    assert {"•• •• •• 01", "•• •• •• 04"} <= set(hints)   # every block stays


def test_hashes_fold_spellings_but_never_cross_venues(monkeypatch):
    a, b = uuid.uuid4(), uuid.uuid4()
    today = date(2026, 10, 27)
    entries, _, _ = contact_marks.add([], a, email="Anna+booking@GMAIL.com", phone="+45 12 34 56 78",
                                      mode="spam", today=today)
    for email in ("anna@gmail.com", "a.n.n.a@googlemail.com", " ANNA+x@gmail.com "):
        assert contact_marks.match(entries, a, email=email, today=today) == "spam", email
    assert contact_marks.match(entries, a, phone="0045-12345678", today=today) == "spam"
    assert contact_marks.match(entries, a, email="anne@gmail.com", today=today) is None
    assert contact_marks.match(entries, b, email="anna@gmail.com", today=today) is None
    # A key rotation: the previous key still matches while it is set.
    from app.config import settings
    old = settings.SECRET_KEY
    monkeypatch.setattr(settings, "SECRET_KEY", "a-new-key")
    assert contact_marks.match(entries, a, email="anna@gmail.com", today=today) is None
    monkeypatch.setattr(settings, "SECRET_KEY_PREVIOUS", old)
    assert contact_marks.match(entries, a, email="anna@gmail.com", today=today) == "spam"


# ── +tag folding in the same-guest rule (decision 5) ─────────────────────

def test_a_plus_tag_rotation_is_one_guest(client, db, outbox):
    u, p, _ = restaurant(db)
    slug = p.reservation_slug
    got = [book(client, slug, day=DAY, time=t, email=e, ip=f"10.4.0.{i}").json()["status"]
           for i, (t, e) in enumerate((("17:00", "anna+1@gmail.com"), ("18:00", "anna+2@gmail.com"),
                                        ("19:00", "a.nna@gmail.com")))]
    assert got == ["confirmed"] * 3
    fourth = book(client, slug, day=DAY, time="20:00", email="ANNA+4@googlemail.com", ip="10.4.0.9")
    assert fourth.json()["status"] == "requested"
    assert _held_reason(db, fourth.json()["id"]) == "contact_active"


def test_folding_never_joins_two_real_guests(client, db, outbox):
    u, p, _ = restaurant(db)
    slug = p.reservation_slug
    for i, t in enumerate(("17:00", "18:00", "19:00")):
        assert book(client, slug, day=DAY, time=t, email="anna@firma.dk", ip=f"10.5.0.{i}").json()["status"] == "confirmed"
        assert book(client, slug, day=DAY, time=t, email=f"axb+{i}@firma.dk", ip=f"10.6.0.{i}").json()["status"] == "confirmed"
    # Dots fold only at Gmail; "_" is a letter here, not a LIKE wildcard
    # ("a_b+%@firma.dk" unescaped would match the three "axb+…" above).
    assert book(client, slug, day=DAY, time="20:00", email="a.nna@firma.dk", ip="10.5.0.9").json()["status"] == "confirmed"
    assert book(client, slug, day=DAY, time="20:00", email="a_b@firma.dk", ip="10.6.0.9").json()["status"] == "confirmed"
    # …and the three "axb+…" are one guest: the 4th waits.
    assert book(client, slug, day=DAY, time="20:00", email="AXB@firma.dk", ip="10.6.0.8").json()["status"] == "requested"


ADDRESSES = [
    "anna@gmail.com", "Anna+1@gmail.com", "a.nna@gmail.com", "anna@googlemail.com",
    "anna+x@googlemail.com", "anne@gmail.com", "anna@gmai.lcom", "anna@firma.dk",
    "anna+tilbud@firma.dk", "a.nna@firma.dk", "a_b@firma.dk", "axb@firma.dk", "axb+1@firma.dk",
    "a%b@firma.dk", "abb@firma.dk",
    "+tag@firma.dk", "+tag+y@firma.dk", "anna@firma.dk.evil.io", "ANNA@FIRMA.DK ",
]


@pytest.mark.parametrize("typed", ADDRESSES)
def test_the_sql_fold_agrees_with_canonical_mailbox(db, typed):
    """The SQL predicate (SQLite here, the same functions on Postgres) says
    "same mailbox" exactly where canonical_mailbox does — both directions:
    nothing folded the Python side would not, nothing missed."""
    owner = uuid.uuid4()
    for i, stored in enumerate(ADDRESSES):
        db.add(Reservation(user_id=owner, guest_name=f"G{i}", guest_email=stored, party_size=2,
                           starts_at=datetime(2030, 1, 1, 18), ends_at=datetime(2030, 1, 1, 19),
                           duration_min=60))
    db.commit()
    pred = mailbox_sql_match(Reservation.guest_email, typed)
    got = {e for (e,) in db.query(Reservation.guest_email)
           .filter(Reservation.user_id == owner, pred).all()}
    want = {s for s in ADDRESSES if canonical_mailbox(s) == canonical_mailbox(typed)}
    assert got == want, typed


# ── The operator hears about booking bursts (T11) ────────────────────────

def _audit(db, owner_id, action, n, *, minutes_ago=5):
    for _ in range(n):
        db.add(AuditLog(user_id=owner_id, actor_id=owner_id, action=action,
                        entity_type="reservation", entity_id=uuid.uuid4(),
                        created_at=utc_now() - timedelta(minutes=minutes_ago)))
    db.commit()


def test_the_monitor_alerts_on_a_burst_at_one_venue(h_mon):
    h = h_mon
    db = h.Session()
    v = uuid.uuid4()
    _audit(db, v, "reservation.created_public", 29)
    _audit(db, uuid.uuid4(), "reservation.created_public", 10)
    db.close()
    h.tick()
    assert h.row("abuse_booking_burst").state == "HEALTHY"
    db = h.Session()
    _audit(db, v, "reservation.created_public", 1)
    db.close()
    h.tick()
    assert h.row("abuse_booking_burst").state == "BROKEN"
    subjects = [s for _, s, _ in h.mails]
    assert "BonBox: unusual online-booking activity" in subjects
    body = next(b for _, s, b in h.mails if s == "BonBox: unusual online-booking activity")
    assert "busiest venue got 30 online bookings" in body
    assert str(v) not in body and "@" not in body


@pytest.mark.parametrize("action,n", [("reservation.held_public", 15),
                                      ("reservation.public_dropped", 10)])
def test_the_monitor_alerts_on_held_and_dropped_bursts(h_mon, action, n):
    h = h_mon
    db = h.Session()
    _audit(db, uuid.uuid4(), action, n - 1)
    db.close()
    h.tick()
    assert h.row("abuse_booking_burst").state == "HEALTHY"
    db = h.Session()
    _audit(db, uuid.uuid4(), action, 1)
    db.close()
    h.tick()
    assert h.row("abuse_booking_burst").state == "BROKEN"


def test_the_monitor_alerts_when_the_screen_fails(h_mon):
    h = h_mon
    h.tick(booking_screen_error=1)
    assert h.row("abuse_booking_burst").state == "BROKEN"
    body = next(b for _, s, b in h.mails if s == "BonBox: unusual online-booking activity")
    assert "FAILED 1 times" in body and "spam guard is off" in body


def test_old_rows_and_a_zero_threshold_keep_it_quiet(h_mon, monkeypatch):
    from app.config import settings
    h = h_mon
    db = h.Session()
    _audit(db, uuid.uuid4(), "reservation.created_public", 40, minutes_ago=61)
    db.close()
    h.tick()
    assert h.row("abuse_booking_burst").state == "HEALTHY"
    monkeypatch.setattr(settings, "BOOKING_ALERT_HELD_PER_HOUR", 0)
    db = h.Session()
    _audit(db, uuid.uuid4(), "reservation.held_public", 50)
    db.close()
    h.tick()
    assert h.row("abuse_booking_burst").state == "HEALTHY"


@pytest.fixture
def h_mon(h):
    return h


from tests.test_abuse_monitor import h  # noqa: E402,F401 — the monitor's fixture


# ── A held severe allergy seated straight away alerts the stand ──────────

def _changes(client, since):
    return client.get("/api/reservations/changes", params={"since": since.isoformat()}).json()["changes"]


def _held_severe(client, p):
    r = book(client, p.reservation_slug, day=DAY, time="19:00", name="Nød Nielsen",
             email="nod@example.com", form_ms=400, allergy_severity="severe",
             allergy_note="nødder")
    assert r.json()["status"] == "requested"
    return r.json()["id"]


def test_a_held_severe_booking_seated_directly_alerts_once(client, db, outbox):
    u, p, _ = restaurant(db)
    t0 = utc_now()
    time.sleep(0.01)
    rid = _held_severe(client, p)
    as_owner(u)
    first = _changes(client, t0)
    assert [c["held"] for c in first if c["id"] == rid] == [True]       # quiet while held
    t1 = utc_now()
    time.sleep(0.01)
    res = client.patch(f"/api/reservations/reservations/{rid}/status",
                       json={"status": "seated", "notify_guest": False})
    assert res.status_code == 200, res.text
    seen = [c for c in _changes(client, t1) if c["id"] == rid]
    assert len(seen) == 1 and seen[0]["kind"] == "approved" and seen[0]["held"] is False
    assert seen[0]["allergy_severity"] == "severe"
    t2 = utc_now()
    time.sleep(0.01)
    assert [c for c in _changes(client, t2) if c["id"] == rid] == []


def test_confirmed_then_seated_alerts_only_at_the_confirm(client, db, outbox):
    u, p, _ = restaurant(db)
    rid = _held_severe(client, p)
    as_owner(u)
    t1 = utc_now()
    time.sleep(0.01)
    assert client.patch(f"/api/reservations/reservations/{rid}/status",
                        json={"status": "confirmed", "notify_guest": False}).status_code == 200
    assert [c["kind"] for c in _changes(client, t1) if c["id"] == rid] == ["approved"]
    t2 = utc_now()
    time.sleep(0.01)
    assert client.patch(f"/api/reservations/reservations/{rid}/status",
                        json={"status": "seated"}).status_code == 200
    assert [c for c in _changes(client, t2) if c["id"] == rid] == []


# ── The calendar file's length (V5) ──────────────────────────────────────

def test_the_receipt_carries_the_bookings_real_length(client, db, outbox):
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=DAY, time="19:00")
    body = r.json()
    assert body["duration_min"] == 90                 # TABLE_SETTINGS: up to 4 → 90 min
    poll = client.get(f"/api/public/reservations/booking/{body['id']}",
                      params={"token": body["booking_token"]}).json()
    assert poll["duration_min"] == 90
    s = salon(db)
    shift(db, s["user"], s["staff"], DAY)
    r = book(client, s["profile"].reservation_slug, day=DAY, time="10:00",
             behandling_id=str(s["behandling"].id), email="klip@example.com", ip="10.7.7.7")
    assert r.status_code == 200, r.text
    assert r.json()["duration_min"] == 30             # the behandling's length


# ── Spam is no booking in the month's numbers ─────────────────────────────

def test_the_monthly_counts_leave_spam_out(db):
    from app.services.reservation_monthly import month_totals

    class R:
        def __init__(self, status, reason=None):
            self.starts_at = datetime(2026, 10, 10, 19)
            self.status, self.cancel_reason = status, reason
            self.party_size, self.source = 2, "public"

    counts = month_totals([R("confirmed"), R("cancelled", "guest_cancelled"),
                           R("cancelled", "owner_spam"), R("cancelled", "owner_spam")],
                          6, date(2026, 10, 1), date(2026, 10, 31))
    assert counts["bookings"] == 1 and counts["cancelled"] == 1


# ── Fix round 27 Oct (F): "Glem" is a real erase, at this venue ───────────
# Review P2-2: Glem only edited the block list while its toast said nothing
# was kept; bookings kept the name, phone and allergy notes ~90 days and
# waitlist rows up to 30. Now: exact phone / exact mailbox (R2's fold),
# never a tail or a LIKE; waitlist rows and PAST bookings nulled as the
# nightly purge nulls them; upcoming bookings counted and kept; counts-only
# audit.
def _now_cph():
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo("Europe/Copenhagen")).replace(tzinfo=None, second=0, microsecond=0)


def _row(db, owner, *, days, name, phone=None, email=None, status="confirmed", **extra):
    start = _now_cph() + timedelta(days=days)
    r = Reservation(id=uuid.uuid4(), user_id=owner.id, guest_name=name, guest_phone=phone,
                    guest_email=email, party_size=2, starts_at=start,
                    ends_at=start + timedelta(minutes=90), duration_min=90, status=status,
                    is_deleted=False, source="public", **extra)
    db.add(r)
    db.commit()
    return r.id


def _wl(db, owner, *, name, phone, source="manual", days=1, status="waiting"):
    from app.models.reservation_waitlist import ReservationWaitlistEntry as WL
    w = WL(user_id=owner.id, guest_name=name, guest_phone=phone, party_size=2,
           waitlist_date=(_now_cph() + timedelta(days=days)).date(), source=source, status=status)
    db.add(w)
    db.commit()
    return w.id


def _glem_world(client, db):
    u, p, _ = restaurant(db)
    other_u, other_p, _ = restaurant(db)
    ids = {
        # Anna, at this venue: the same number in three spellings, the same
        # mailbox in three spellings.
        "past_both": _row(db, u, days=-3, name="Anna Bord", phone="+45 12 34 56 78",
                          email="A.nna+bord@Gmail.com", guest_notes="Vindue, tak",
                          allergy_note="Nødder (alvorlig)", allergy_severity="severe",
                          allergen_tags=["nuts"], occasion="birthday", note_intent="celebration",
                          guest_consent_marketing=True),
        "past_phone": _row(db, u, days=-10, name="Anna", phone="0045-1234-5678"),
        "past_mail": _row(db, u, days=-20, name="A. Bord", email="anna@googlemail.com",
                          status="completed"),
        "cancelled_ahead": _row(db, u, days=4, name="Anna", phone="12345678",
                                status="cancelled"),
        "upcoming": _row(db, u, days=2, name="Anna", phone="12 34 56 78"),
        # Not Anna: a foreign number with the same last 8 digits, another
        # Gmail mailbox, a prefix-alike address.
        "uk_tail": _row(db, u, days=-3, name="Brit", phone="+44 77 1234 5678"),
        "other_mail": _row(db, u, days=-3, name="Anna B", email="anna.b@gmail.com"),
        "prefix_mail": _row(db, u, days=-3, name="Annabel", email="annabel+x@gmail.com"),
        # Anna at ANOTHER venue: never reached.
        "other_venue": _row(db, other_u, days=-3, name="Anna", phone="12345678",
                            email="anna@gmail.com"),
    }
    wl = {
        "door": _wl(db, u, name="Anna", phone="0045 12345678"),
        "online": _wl(db, u, name="Anna", phone="+45 12 34 56 78", source="public"),
        "uk": _wl(db, u, name="Brit", phone="+447712345678"),
        "other_venue": _wl(db, other_u, name="Anna", phone="12345678"),
    }
    as_owner(u)
    blk = client.post("/api/reservations/contact-blocks",
                      json={"phone": "+4512345678", "email": "anna@gmail.com"})
    assert blk.status_code == 201
    return u, p, other_u, ids, wl


def test_fix_f_glem_previews_then_erases_only_this_contact_at_this_venue(client, db, outbox):
    from app.models.reservation_waitlist import ReservationWaitlistEntry as WL
    u, p, other_u, ids, wl = _glem_world(client, db)
    body = {"phone": "12 34 56 78", "email": "anna+glem@gmail.com"}
    prev = client.post("/api/reservations/contact-blocks/erase-preview", json=body)
    assert prev.status_code == 200, prev.text
    assert prev.json() == {"would_erase": {"blocks": 2, "reservations": 4, "waitlist": 2},
                           "future_kept": 1}
    db.expire_all()
    assert reservation(db, ids["past_both"]).guest_name == "Anna Bord"     # a preview writes nothing
    assert db.query(AuditLog).filter(AuditLog.action == "reservation.contact_erased").count() == 0

    res = client.post("/api/reservations/contact-blocks/erase", json=body)
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["erased"] == {"blocks": 2, "reservations": 4, "waitlist": 2}
    assert out["future_kept"] == 1 and out["removed"] == 2 and out["blocks"] == []
    db.expire_all()
    # Past (and cancelled) bookings: exactly the nightly purge's fields.
    for k in ("past_both", "past_phone", "past_mail", "cancelled_ahead"):
        r = reservation(db, ids[k])
        assert (r.guest_name, r.guest_phone, r.guest_email, r.guest_notes) == (None,) * 4, k
        assert r.purged_at is not None, k
    r = reservation(db, ids["past_both"])
    assert (r.allergy_note, r.allergy_severity, r.allergen_tags, r.occasion, r.note_intent) == (None,) * 5
    assert r.guest_consent_marketing is False and r.party_size == 2 and r.status == "confirmed"
    # The upcoming booking keeps its contact until the visit.
    up = reservation(db, ids["upcoming"])
    assert (up.guest_name, up.guest_phone, up.purged_at) == ("Anna", "12 34 56 78", None)
    # Never a tail, never a lookalike mailbox, never another venue.
    assert reservation(db, ids["uk_tail"]).guest_phone == "+44 77 1234 5678"
    assert reservation(db, ids["other_mail"]).guest_email == "anna.b@gmail.com"
    assert reservation(db, ids["prefix_mail"]).guest_email == "annabel+x@gmail.com"
    assert reservation(db, ids["other_venue"]).guest_name == "Anna"
    # Waitlist rows: nulled; a waiting one leaves the list.
    for k in ("door", "online"):
        w = db.get(WL, wl[k])
        assert (w.guest_name, w.guest_phone, w.guest_email, w.note) == (None,) * 4, k
        assert w.purged_at is not None and w.status == "cancelled", k
    assert db.get(WL, wl["uk"]).guest_phone == "+447712345678"
    assert db.get(WL, wl["other_venue"]).guest_name == "Anna"
    # The audit row: counts only.
    (a,) = db.query(AuditLog).filter(AuditLog.action == "reservation.contact_erased").all()
    after = json.loads(a.after_state)
    assert after == {"removed": 2, "blocks": 2, "reservations": 4, "waitlist": 2, "future_kept": 1}
    for pii in ("anna", "1234", "gmail", "+45"):
        assert pii not in (a.after_state or "").lower() and pii not in (a.before_state or "").lower()
    # Again: nothing left to erase, the upcoming booking still counted.
    again = client.post("/api/reservations/contact-blocks/erase", json=body).json()
    assert again["erased"] == {"blocks": 0, "reservations": 0, "waitlist": 0}
    assert again["future_kept"] == 1


def test_fix_f_a_cancelled_upcoming_booking_is_then_forgotten(client, db, outbox):
    u, p, other_u, ids, wl = _glem_world(client, db)
    body = {"phone": "+45 12 34 56 78"}
    assert client.post("/api/reservations/contact-blocks/erase", json=body).json()["future_kept"] == 1
    db.expire_all()
    up = reservation(db, ids["upcoming"])
    up.status = "cancelled"                       # the owner cancels it first
    db.commit()
    out = client.post("/api/reservations/contact-blocks/erase", json=body).json()
    assert out["erased"]["reservations"] == 1 and out["future_kept"] == 0
    assert reservation(db, ids["upcoming"]).guest_name is None


def test_fix_f_exact_phone_spellings_never_a_tail():
    from app.services.guest_erase import phone_spellings
    dk = ["004512345678", "12345678", "4512345678"]
    for typed in ("12345678", "+45 12 34 56 78", "0045-1234-5678", "(+45) 12.34.56.78"):
        assert phone_spellings(typed) == dk, typed
    assert phone_spellings("+44 77 1234 5678") == ["00447712345678", "447712345678"]
    assert phone_spellings("12345") == []
    assert "12345678" not in phone_spellings("+44 77 1234 5678")


def test_fix_f_a_preview_or_erase_that_fails_says_so_and_changes_nothing(client, db, outbox, monkeypatch):
    from app.services import guest_erase
    u, p, other_u, ids, wl = _glem_world(client, db)

    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(guest_erase, "counts", boom)
    r = client.post("/api/reservations/contact-blocks/erase-preview", json={"phone": "12345678"})
    assert r.status_code == 503
    monkeypatch.setattr(guest_erase, "erase", boom)
    r = client.post("/api/reservations/contact-blocks/erase", json={"phone": "12345678"})
    assert r.status_code == 503
    db.expire_all()
    assert len(json.loads(_settings_json(db, p))["contact_blocks"]) == 2    # the list too
    assert reservation(db, ids["past_both"]).guest_name == "Anna Bord"
    assert client.post("/api/reservations/contact-blocks/erase-preview",
                       json={"phone": "12"}).status_code == 422


# ── Fix round 27 Oct (J): the owner's spam is never news ─────────────────
# Backend F3: after a clean-up at 22:01 the night's summaries still said
# "37 nye" (and "51 nye" at 07:00) — public_rows_since counted online rows of
# any status. Rows the owner cancelled as spam, and rows held because the
# owner had marked the contact as spam, now count toward no summary; with
# nothing real left, no summary is sent at all.
def _spam_world(client, db, *, real=3, junk=4):
    u, p, _ = restaurant(db)
    real_ids = [book(client, p.reservation_slug, day=DAY, time=f"{12 + i}:00", name=f"Gæst {i}",
                     email=f"gaest{i}@example.com").json()["id"] for i in range(real)]
    junk_ids = [book(client, p.reservation_slug, day=DAY + timedelta(days=1), time=f"{12 + i}:00",
                     name=f"Bot {i}", email=f"bot{i}@example.com").json()["id"] for i in range(junk)]
    as_owner(u)
    for rid in junk_ids:
        assert _spam(client, rid).status_code == 200
    # The marked contact books again: held quietly (marked_spam), "requested".
    again = book(client, p.reservation_slug, day=DAY + timedelta(days=2), time="12:00",
                 name="Bot igen", email="bot0@example.com").json()["id"]
    assert _held_reason(db, again) == "marked_spam"
    return u, p, real_ids, junk_ids, again


def test_fix_j_summary_counts_leave_out_the_owners_spam(client, db, outbox):
    from app.services import booking_screen as bs
    from app.services import owner_booking_alerts as alerts
    from app.routers.reservation_spam import SPAM_REASON
    assert bs.SPAM_CANCEL_REASON == SPAM_REASON
    u, p, real_ids, junk_ids, again = _spam_world(client, db)
    now = utc_now()
    since = now - timedelta(hours=1)
    assert alerts.summary_counts(db, u.id, now_utc=now, since=since) == (3, 0)
    assert bs.news_since(db, u.id, since) == 3
    # The SCREEN keeps counting everything (fix round 4, review2 #2): 3 real,
    # 4 cleaned up as spam, 1 held as marked_spam — passed = public − held.
    assert bs.public_rows_since(db, u.id, since) == 8
    assert bs.held_since(db, u.id, since) == 1
    assert bs.passed_since(db, u.id, since) == 7
    # Both directions of the correlated EXISTS: a hold for another reason
    # still counts as waiting news.
    other = book(client, p.reservation_slug, day=DAY + timedelta(days=3), time="12:00",
                 name="Http://x", email="person@example.com").json()["id"]
    assert _held_reason(db, other) == "link_in_name"
    assert alerts.summary_counts(db, u.id, now_utc=now, since=since) == (4, 1)
    assert bs.held_since(db, u.id, since) == 2 and bs.passed_since(db, u.id, since) == 7


def test_fix_r4_cleaning_a_burst_up_as_spam_never_reopens_the_venue_hour(client, db, outbox, volume_on):
    """Review2 #2: with the ceilings on, the hour's max(6, tables) online
    bookings passed; the owner marks all six as spam; the next one is STILL
    held (venue_hour). The summaries leave the spam out — the screen never."""
    from app.services import booking_screen as bs
    from app.services import owner_booking_alerts as alerts
    u, p, _ = restaurant(db, tables=2)
    ids = []
    for i in range(6):
        r = book(client, p.reservation_slug, day=DAY + timedelta(days=i), time="12:00",
                 name=f"Bot {i}", email=f"burst{i}@example.com", ip=f"10.9.0.{i}")
        assert r.json()["status"] == "confirmed", r.text
        ids.append(r.json()["id"])
    as_owner(u)
    for rid in ids:
        assert _spam(client, rid).status_code == 200
    since = utc_now() - timedelta(hours=1)
    assert alerts.summary_counts(db, u.id, now_utc=utc_now(), since=since)[0] == 0   # no news
    assert bs.passed_since(db, u.id, since) == 6                                    # the screen still sees them
    nxt = book(client, p.reservation_slug, day=DAY + timedelta(days=8), time="12:00",
               name="Next One", email="next@example.com", ip="10.9.1.1")
    assert nxt.json()["status"] == "requested", nxt.text
    assert _held_reason(db, nxt.json()["id"]) == "venue_hour"


def test_fix_j_no_summary_when_only_spam_was_held_back(client, db, outbox):
    from app.services import owner_booking_alerts as alerts
    u, p, real_ids, junk_ids, again = _spam_world(client, db, real=0, junk=5)
    # Pings held back over the budget while the junk came in (before the
    # clean-up), as the night of the attack logged them.
    for _ in range(5):
        db.add(NotificationLog(id=uuid.uuid4(), user_id=u.id, staff_id=None, channel="push",
                               event_type="reservation_created", status=alerts.SUPPRESSED,
                               error_message=alerts.OVER_BUDGET,
                               created_at=utc_now() - timedelta(minutes=20)))
    db.commit()
    before = [x for x in db.query(NotificationLog).filter(
        NotificationLog.user_id == u.id, NotificationLog.event_type == alerts.BURST_EVENT).all()]
    out = alerts.flush_digests(db, now_utc=utc_now() + timedelta(minutes=70))
    assert out["owner_digests_sent"] == 0
    after = db.query(NotificationLog).filter(
        NotificationLog.user_id == u.id, NotificationLog.event_type == alerts.BURST_EVENT).all()
    assert len(after) == len(before)                     # no push, no mail, no ledger row
    # One real booking among them: the summary says exactly that one.
    real = book(client, p.reservation_slug, day=DAY, time="19:00", name="Ægte",
                email="aegte@example.com").json()["id"]
    assert reservation(db, real).status == "confirmed"
    now = utc_now()
    assert alerts.summary_counts(db, u.id, now_utc=now, since=now - timedelta(hours=1)) == (1, 0)
