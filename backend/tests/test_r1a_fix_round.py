"""R1a fix round (24 Oct 2026) — R1a is never worse than live for a real guest.

The R1a verify found one blocker and five should-fixes. Each is pinned here,
through the real public create path where it can be:

  1. BLOCKER (food safety). R1 rewrote anything link-like in what a guest
     typed to "[link]" when the booking was saved: "Glutenfri.Laktosefri.
     Nøddeallergi" became "[link]" and the AI allergy reading found nothing.
     Now the name, notes, allergy note and occasion are stored EXACTLY as
     typed, the AI reads the stored text, and a link is made harmless only
     where the text is SHOWN — every e-mail (utils/text.defang_links) and the
     owner's screens (frontend/src/utils/guestText.js, the same rules). Only
     an EXPLICIT link in the name (http://, https://, www. — after NFKC) is
     robot-like; "Anne.Marie.Jensen" is a name.
  2. A booking with NO fill time is "unknown" — a guest on a page loaded
     before the frontend deploy — and books as on live. Only a fill time
     that was sent and is under 2 s is robot-like.
  3. A held booking still waiting for the owner counts toward no guest's
     same-contact rule (a robot's posts with a regular's e-mail held her
     real booking).
  4. A robot-like hold the owner APPROVED is a normal booking: its later
     cancellation tells the owner and nudges the waitlist.
  5. A chair venue counts the same guest's DAYS, so a parent books the
     family on one Saturday; and a held guest's "request received" and its
     answer go out past the per-address cap (by a small bound).
  6. No request is declined in the night: the owner's answer window is
     counted in daytime (08–22), and a deadline never falls after 21:00 or
     before 08:00 — across both summer-time changes.

Run: cd backend && python -m pytest tests/test_r1a_fix_round.py -q
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from app.jobs.reservation_request_expiry import (
    answer_deadline, expire_stale_requests, owner_daytime_after,
)
from app.models.audit_log import AuditLog
from app.models.reservation import Reservation
from app.services import booking_screen
from app.services import owner_booking_alerts as alerts
from app.services import reservation_emails as mail
from app.services.allergy_detector import detect_allergy_signals
from app.utils import abuse_signals
from app.utils import text as text_mod
from app.utils.text import defang_links, has_explicit_link
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    as_owner, book, client, clock, db, engine_and_session, logs, outbox, reservation,
    restaurant, salon, shift, today_local, volume_both, volume_off,
)

CPH = ZoneInfo("Europe/Copenhagen")


def _reason(db, rid):
    db.expire_all()
    a = (db.query(AuditLog).filter(AuditLog.entity_id == uuid.UUID(str(rid)),
                                   AuditLog.action == "reservation.held_public").first())
    return json.loads(a.after_state)["reason"] if a else None


def _owner_pings(db, owner, event=None):
    """Owner pushes that went out (sent, or failed for want of a device)."""
    return [x for x in logs(db, owner, channel="push")
            if x.status in ("sent", "failed") and (event is None or x.event_type == event)]


def _at(day, hh, mm=0) -> datetime:
    return datetime.combine(day, datetime.min.time()).replace(hour=hh, minute=mm)


def _approve(client, owner, rid):
    as_owner(owner)
    return client.patch(f"/api/reservations/reservations/{rid}/status",
                        json={"status": "confirmed", "notify_guest": False})


# ═══ 1. The guest's words are kept; links are defanged where shown ═══════

# The verify's 20 real-looking notes (sec/run/link_table.py): R1 garbled 11.
REAL_NOTES = [
    "Vi kommer kl.19.Vi er 4", "Nut allergy.No sesame please",
    "Allergic to peanuts.Is the kitchen nut free?", "Laktoseallergi.Is uden mælk tak",
    "Celiac.It must be 100% gluten free", "Jordnødder.De skal undgås helt",
    "Glutenfri.Laktosefri.Nøddeallergi", "Skaldyrsallergi.Meget alvorlig",
    "f.eks. nødder, bl.a. mandler", "kl.19.30 tak", "Fødselsdag.Kage medbringes",
    "Peanut allergy.Me and my son", "Severe shellfish allergy.Co-eliac too",
    "Bord ved vinduet.Tak!", "Anna.Se menukort", "vegan.No dairy.No eggs",
    "Allergi: sesam.Se venligst bort fra brød", "Mælkeprotein allergi.Er der alternativ?",
    "Glutenfri.Nu med børn", "Allergisk.Co2 i øl? nej",
]
# What the AI must find in them — the allergies R1 lost, named one by one.
MUST_TAG = {
    "Glutenfri.Laktosefri.Nøddeallergi": {"gluten", "milk", "nuts"},
    "Jordnødder.De skal undgås helt": {"peanuts"},
    "Allergi: sesam.Se venligst bort fra brød": {"sesame"},
    "Allergic to peanuts.Is the kitchen nut free?": {"peanuts", "nuts"},
    "Laktoseallergi.Is uden mælk tak": {"milk"},
    "Celiac.It must be 100% gluten free": {"gluten"},
    "Nut allergy.No sesame please": {"nuts", "sesame"},
    "Glutenfri.Nu med børn": {"gluten"},
}
DOTTED_NAMES = ["Anne.Marie.Jensen", "Hans.Chr.Andersen", "Jørgen.Ærø.Østergaard",
                "Mette.Lise.Hansen", "Lars.Co", "Ole Hansen (firma.dk)", "Sofie @sofie.dk",
                "J.P.Hansen"]


def test_twenty_real_notes_are_stored_verbatim_and_allergy_tagged(client, db, outbox):
    """The blocker, through the public create path: every field as typed,
    and the AI allergy reading on the stored text finds every allergy."""
    u, p, _ = restaurant(db, tables=10)
    for i, note in enumerate(REAL_NOTES):
        name = DOTTED_NAMES[i % len(DOTTED_NAMES)]
        r = book(client, p.reservation_slug, day=today_local() + timedelta(days=3 + i),
                 time="19:00", name=name, email=f"note{i}@example.dk", form_ms=41000,
                 guest_notes=note, allergy_note=note, occasion=note[:60], ip=f"10.70.0.{i}")
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "confirmed", (name, note)
        row = reservation(db, r.json()["id"])
        assert (row.guest_name, row.guest_notes, row.allergy_note, row.occasion) == (
            name, note, note, note[:60])
        want = (detect_allergy_signals(note, note, "restaurant") or {}).get("suggested_tags") or []
        assert sorted(row.allergy_ai_tags or []) == sorted(want), note
        assert MUST_TAG.get(note, set()) <= set(row.allergy_ai_tags or []), note


@pytest.mark.parametrize("name", DOTTED_NAMES)
def test_a_dotted_name_is_a_name(client, db, outbox, name):
    """R1 held these silently as links (no mail, declined unmailed)."""
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             name=name, email="dotted@example.dk", form_ms=30000)
    assert r.json()["status"] == "confirmed" and r.json()["guest_mail"] is True
    assert reservation(db, r.json()["id"]).guest_name == name
    assert [m["to"] for m in outbox].count("dotted@example.dk") == 1


@pytest.mark.parametrize("name", [
    "http://x.dk", "Mette https://evil.com/a", "WWW.EVIL.COM", "Hej www.mobilepay-refund.dk",
    "ｗｗｗ．evil．com",           # full-width: NFKC makes it "www.evil.com"
    "Ｈｔｔｐｓ://evil",            # full-width scheme
])
def test_an_explicit_link_in_the_name_is_robot_like_and_kept_as_typed(client, db, outbox, name):
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             name=name, email="victim@example.dk", form_ms=30000)
    assert r.json()["status"] == "requested" and r.json()["guest_mail"] is False
    assert _reason(db, r.json()["id"]) == "link_in_name"
    assert reservation(db, r.json()["id"]).guest_name == name
    assert outbox == []


@pytest.mark.parametrize("text,explicit", [
    ("https://a.dk", True), ("HTTP://A", True), ("hej www.x", True), ("ＷＷＷ.x", True),
    ("Anne.Marie.Jensen", False), ("evil.com", False), ("hxxp://evil.com", False),
    ("http:/x", False), ("www dot evil", False), ("", False), (None, False),
])
def test_only_an_explicit_link_counts_in_a_name(text, explicit):
    assert has_explicit_link(text) is explicit


LINKS = [
    "evil.com", "login.bonbox-refund.com/claim", "www2.evil.com", "my.evil.dk", "claim-prize.eu",
    "evil.co.uk", "1.2.3.4/login", "t.me/x", "wa.me/4512345678", "goo.gl/x", "evil[.]com",
    "evil。com", "Mette secure.mobilepay-refund.dk/x", "WIN cash.xyz", "https://bit.ly/abc",
    "ｅｖｉｌ.com", "https://secure-refund.com/claim?u=@me", "www.@refund.dk",
    "https://user@evil.com/login", "user@evil.com/login", "evil.com/claim@x",
    "secure-pay.zip", "bonbox-refund.lol", "refund.nu", "mitid-login.casa", "pay.sbs",
    "secure.mobilepay-refund.rocks", "evil.lol/claim", "evil.com:8080/x", "www.evil.dk",
    # an ending no list names, with a path after it: a link all the same
    "refund.banana/claim", "secure.pay-dk.zzz/login",
]
_HOSTISH = re.compile(r"(?i)https?://|www\.|[\w-]\.(?:" + text_mod._DISPLAY_TLDS + r")\b")


@pytest.mark.parametrize("link", LINKS)
def test_a_link_is_shown_defanged(link):
    out = defang_links(f"Se {link} nu")
    if "[.]" not in link:                       # "evil[.]com" is shown as it came
        assert out != f"Se {link} nu"
    assert _HOSTISH.search(out) is None, out
    assert defang_links(out) == out            # showing it twice changes nothing


@pytest.mark.parametrize("text", [
    "Glutenfri.Laktosefri.Nøddeallergi", "Anne.Marie.Jensen", "Hans.Chr.Andersen",
    "Vi kommer kl.19.Vi er 4", "kl.19.30 tak", "f.eks. nødder, bl.a. mandler",
    "Skaldyrsallergi.Meget alvorlig", "Fødselsdag.Kage medbringes", "Bord ved vinduet.Tak!",
    "anna@cafe.dk", "Kontakt: anna.hansen@gmail.com", "ring 12.34.56.78", "J.P.Hansen",
    "Vi er ca.4 personer", "Første linje\nAnden linje", "Allergisk.Co2 i øl? nej",
])
def test_ordinary_text_is_shown_exactly_as_typed(text):
    assert defang_links(text) == text


def test_a_long_note_is_defanged_in_linear_time():
    """2,000 characters of "a.a.a…" — the first display regex took 0.7 s."""
    import time
    worst = 0.0
    for note in ("a." * 1000, ("ab." * 700)[:2000], ("abc.d" * 400), "a@" * 1000):
        t = time.perf_counter()
        defang_links(note)
        worst = max(worst, time.perf_counter() - t)
    assert worst < 0.05


_PHISH = SimpleNamespace(
    name="Mette secure.refund-dk.com",
    notes="Klik login.mobilepay-refund.dk/x for refusion",
    allergy="Nødder — se https://evil.com/allergi",
    occasion="Fødselsdag www.evil-party.dk",
)
_RAW_HOSTS = ("secure.refund-dk.com", "login.mobilepay-refund.dk", "https://evil.com",
              "evil.com/allergi", "www.evil-party.dk")


def _phish_row(status="confirmed"):
    start = datetime(2026, 11, 20, 19, 0)
    return SimpleNamespace(
        id=uuid.uuid4(), user_id=uuid.uuid4(), status=status, starts_at=start,
        ends_at=start + timedelta(hours=2), party_size=4, guest_name=_PHISH.name,
        guest_email="mette@example.dk", guest_phone="+45 20 30 40 50",
        guest_notes=_PHISH.notes, allergy_note=_PHISH.allergy, allergen_tags=["nuts"],
        allergy_severity="severe", occasion=_PHISH.occasion, service_name=None,
        guest_lang="da", confirmation_sent_at=None,
    )


def _all_templates(lang):
    v = mail.Venue(name="Bistro Nord", phone="+45 33 33 33 33", address="Nørregade 1",
                   booking_url="https://bonbox.dk/bistro", reply_to="ejer@bistro.dk")
    now = datetime(2026, 11, 18, 12, 0)
    url = "https://bonbox.dk/r/x/cancel"
    req = _phish_row("requested")
    row = _phish_row()
    cancelled = _phish_row("cancelled")
    return {
        "guest_confirmation": mail.render_guest_confirmation(row, v, lang, cancel_url=url, now=now),
        "guest_request_received": mail.render_guest_confirmation(req, v, lang, cancel_url=url, now=now),
        "guest_cancelled_by_guest": mail.render_guest_cancelled_by_guest(cancelled, v, lang, now=now),
        "guest_cancelled_by_venue": mail.render_guest_cancelled_by_venue(cancelled, v, lang, now=now),
        "guest_declined": mail.render_guest_cancelled_by_venue(cancelled, v, lang, was_request=True, now=now),
        "guest_request_confirmed": mail.render_guest_request_confirmed(row, v, lang, cancel_url=url, now=now),
        "guest_moved": mail.render_guest_moved(row, v, lang, old_starts_at=row.starts_at - timedelta(hours=1),
                                               cancel_url=url, now=now),
        "guest_reminder": mail.render_guest_reminder(row, v, lang, cancel_url=url, now=now),
        "guest_request_expired": mail.render_guest_request_expired(req, v, lang, now=now),
        "owner_new_booking": mail.render_owner_new_booking(row, v, lang, booking_url=url, now=now),
        "owner_new_request": mail.render_owner_new_booking(req, v, lang, booking_url=url, now=now),
        "owner_guest_cancelled": mail.render_owner_guest_cancelled(cancelled, v, lang, booking_url=url, now=now),
        "owner_request_withdrawn": mail.render_owner_guest_cancelled(cancelled, v, lang, booking_url=url,
                                                                     was_request=True, now=now),
    }


@pytest.mark.parametrize("lang", ["da", "en"])
def test_every_email_shows_the_guests_links_defanged(lang):
    """A phishing name, note, allergy note and occasion: no template — guest
    or owner, Danish or English — carries a host a mail client would link;
    where a template shows the field, it shows it defanged."""
    shown = {
        "name": "Mette secure[.]refund-dk[.]com",
        "notes": "login[.]mobilepay-refund[.]dk/x",
        "allergy": "hxxps://evil[.]com/allergi",
        "occasion": "www[.]evil-party[.]dk",
    }
    shows = {   # which fields each template shows at all
        "guest_confirmation": ("name", "allergy"), "guest_request_received": ("name", "allergy"),
        "guest_cancelled_by_guest": ("name",), "guest_cancelled_by_venue": ("name",),
        "guest_declined": ("name",), "guest_request_confirmed": ("name", "allergy"),
        "guest_moved": ("name",), "guest_reminder": ("name",), "guest_request_expired": ("name",),
        "owner_new_booking": ("name", "notes", "allergy", "occasion"),
        "owner_new_request": ("name", "notes", "allergy", "occasion"),
        "owner_guest_cancelled": ("name",), "owner_request_withdrawn": ("name",),
    }
    rendered = _all_templates(lang)
    assert set(rendered) == set(shows)
    for key, (subject, html) in rendered.items():
        for raw in _RAW_HOSTS:
            assert raw not in html and raw not in subject, (key, raw)
        # Our own links (href, bonbox.dk) and e-mail addresses (a mailto, never
        # a web page) aside, nothing in the mail is a host a client links.
        bare = re.sub(r'href="[^"]*"|[\w.+-]+@[\w-]+(?:\.[\w-]+)+', "", html).replace("bonbox.dk", "")
        assert _HOSTISH.search(bare) is None, (key, _HOSTISH.search(bare))
        for field in shows[key]:
            assert shown[field] in html, (key, field)


def test_the_owners_screens_use_the_same_endings_as_the_emails():
    """frontend/src/utils/guestText.js defangs the owner's screens by the
    same rules; its list of domain endings must stay the backend's."""
    js = (Path(__file__).resolve().parents[2] / "frontend/src/utils/guestText.js").read_text()
    block = js.split("export const DISPLAY_TLDS =", 1)[1].split(";", 1)[0]
    endings = "".join(re.findall(r'"([^"]*)"', block)).split("|")
    assert set(endings) == set(text_mod._DISPLAY_TLDS.split("|"))
    assert len(endings) == len(set(endings))


# ═══ 2. No fill time is unknown, never a robot ═══════════════════════════

def test_a_booking_with_no_fill_time_books_as_on_live(client, db, outbox):
    """The body a guest page loaded before the frontend deploy sends: no
    form_ms, no trap field. Confirmed on a table, mailed, the owner told —
    and the abuse monitor counts it."""
    abuse_signals.reset()
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             name="Pia Krogh", email="pia.krogh@example.dk", form_ms=None)
    body = r.json()
    assert body["status"] == "confirmed" and body["guest_mail"] is True
    row = reservation(db, body["id"])
    assert row.resource_id is not None and _reason(db, body["id"]) is None
    assert sorted(m["to"] for m in outbox) == sorted(["pia.krogh@example.dk", u.email])
    assert len(_owner_pings(db, u, "reservation_created")) == 1
    assert abuse_signals.drain().get("booking_no_fill_time") == 1


@pytest.mark.parametrize("form_ms,status", [(0, "requested"), (1999, "requested"),
                                            (2000, "confirmed"), (None, "confirmed")])
def test_only_a_fill_time_sent_under_two_seconds_is_robot_like(client, db, outbox, form_ms, status):
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             email="g@example.dk", form_ms=form_ms)
    assert r.json()["status"] == status
    assert _reason(db, r.json()["id"]) == ("fast_fill" if status == "requested" else None)


# ═══ 3. A pending hold counts toward no guest ════════════════════════════

def test_robot_holds_never_hold_a_regulars_real_booking(client, db, outbox, volume_both):
    """Verify S2: three robot-speed posts with a regular's e-mail — and,
    separately, with her phone under three other e-mails — then her real
    booking. Live confirms her; so does R1a."""
    u, p, _ = restaurant(db)
    for i in range(3):
        book(client, p.reservation_slug, day=today_local() + timedelta(days=10 + i), time="19:00",
             email="lone.berg@example.dk", form_ms=300, ip=f"10.71.0.{i}")
        book(client, p.reservation_slug, day=today_local() + timedelta(days=10 + i), time="20:00",
             email=f"x{i}@example.dk", phone="+45 22 33 44 55", form_ms=300, ip=f"10.71.1.{i}")
    real = book(client, p.reservation_slug, day=today_local() + timedelta(days=20), time="19:00",
                name="Lone Berg", email="lone.berg@example.dk", form_ms=38000)
    assert real.json()["status"] == "confirmed"
    by_phone = book(client, p.reservation_slug, day=today_local() + timedelta(days=21), time="19:00",
                    name="Victim Two", email="v2@example.dk", phone="22334455", form_ms=38000)
    assert by_phone.json()["status"] == "confirmed"


def test_bookings_that_count_still_count(client, db, outbox):
    """Both directions: three CONFIRMED bookings hold the 4th — and three
    robot holds the owner APPROVED are confirmed bookings that count too."""
    u, p, _ = restaurant(db)
    for i in range(3):
        assert book(client, p.reservation_slug, day=today_local() + timedelta(days=10 + i),
                    email="same@example.dk", form_ms=40000).json()["status"] == "confirmed"
    fourth = book(client, p.reservation_slug, day=today_local() + timedelta(days=15),
                  email="same@example.dk", form_ms=40000)
    assert fourth.json()["status"] == "requested"
    assert _reason(db, fourth.json()["id"]) == "contact_active"
    held = [book(client, p.reservation_slug, day=today_local() + timedelta(days=30 + i),
                 email="approved@example.dk", form_ms=300).json()["id"] for i in range(3)]
    for rid in held:
        assert _approve(client, u, rid).status_code == 200
    nxt = book(client, p.reservation_slug, day=today_local() + timedelta(days=40),
               email="approved@example.dk", form_ms=40000)
    assert nxt.json()["status"] == "requested" and _reason(db, nxt.json()["id"]) == "contact_active"


def test_the_contact_count_leaves_out_only_pending_holds(db):
    """The SQL both ways (a correlated NOT EXISTS that matched nothing would
    shadow every row): 2 confirmed + 1 confirmed-after-hold count, 2 pending
    holds do not."""
    u, _p, _ = restaurant(db)
    now = datetime.now(CPH).replace(tzinfo=None)
    rows = []
    for status, held in (("confirmed", False), ("confirmed", False), ("confirmed", True),
                         ("requested", True), ("requested", True), ("requested", False)):
        start = now + timedelta(days=5 + len(rows))
        r = Reservation(user_id=u.id, guest_name="K", guest_email="k@example.dk", party_size=2,
                        starts_at=start, ends_at=start + timedelta(hours=2), duration_min=120,
                        status=status, source="public")
        db.add(r); db.commit(); db.refresh(r)
        if held:
            db.add(AuditLog(user_id=u.id, action=booking_screen.HELD_ACTION,
                            entity_type="reservation", entity_id=r.id,
                            after_state=json.dumps({"reason": "fast_fill"})))
            db.commit()
        rows.append(r)
    n = booking_screen.contact_active_count(db, u.id, email="k@example.dk", phone=None, now_local=now)
    assert n == 4      # 3 confirmed (one approved after a hold) + the plain request
    days = booking_screen.contact_active_days(db, u.id, email="k@example.dk", phone=None, now_local=now)
    assert len(days) == 4 and sum(days.values()) == 4


# ═══ 4. An approved hold is a normal booking ═════════════════════════════

@pytest.mark.parametrize("waiting_party", [True, False])
def test_an_approved_robot_hold_cancelled_later_tells_the_owner(client, db, outbox, monkeypatch,
                                                                waiting_party):
    """Verify S1: a fast-fill hold (an old page, a guest the owner knows),
    approved, then cancelled by the guest with the receipt token: the owner
    gets the push, the "aflyst af gæsten" mail, and the freed-table nudge
    when a waiting party fits — as for any booking."""
    import app.services.notification_service as ns
    calls = []
    monkeypatch.setattr(ns, "notify_owner_freed_table",
                        lambda db, owner, r, match, **k: calls.append(("freed", match["guest_name"])))
    monkeypatch.setattr(ns, "notify_owner_new_reservation",
                        lambda db, owner, r, cancelled=False: calls.append(("cancel" if cancelled else "new", None)))
    u, p, _ = restaurant(db)
    day = today_local() + timedelta(days=4)
    if waiting_party:
        from app.models.reservation_waitlist import ReservationWaitlistEntry
        db.add(ReservationWaitlistEntry(user_id=u.id, guest_name="Venter Hansen", party_size=2,
                                        waitlist_date=day, purge_after=datetime.utcnow() + timedelta(days=30)))
        db.commit()
    body = book(client, p.reservation_slug, day=day, time="19:00", name="Kendt Gæst",
                email="kendt@example.dk", form_ms=300).json()
    assert body["status"] == "requested" and _reason(db, body["id"]) == "fast_fill"
    assert _approve(client, u, body["id"]).status_code == 200
    calls.clear()
    outbox.clear()
    c = client.post(f"/api/public/reservations/booking/{body['id']}/cancel",
                    params={"token": body["booking_token"]})
    assert c.status_code == 200 and c.json()["status"] == "cancelled"
    assert calls == ([("freed", "Venter Hansen")] if waiting_party else [("cancel", None)])
    owner_mail = [m for m in outbox if m["to"] == u.email]
    assert len(owner_mail) == 1 and "aflyst" in owner_mail[0]["subject"].lower()
    assert not [x for x in logs(db, u, channel="push")
                if x.event_type == "reservation_cancelled" and x.error_message == alerts.HELD_BOT]


# ═══ 5. A family at a chair venue; the held guest's mails ═══════════════

def _barber(db, day, *, end="18:00"):
    s = salon(db)
    s["user"].business_type = "salon"
    db.commit()
    shift(db, s["user"], s["staff"], day, "10:00", end)
    return s


def _cut(client, s, day, time, *, name="Far Lund", email="familien.lund@example.dk",
         phone="+45 26 26 26 26", ip=None):
    return book(client, s["profile"].reservation_slug, day=day, time=time, party=1, name=name,
                email=email, phone=phone, form_ms=45000, behandling_id=str(s["behandling"].id),
                ip=ip)


def test_a_parent_books_four_childrens_haircuts_on_one_saturday(client, db, outbox):
    """Verify S4 / the barber simulation: the 4th child was held as the same
    guest (live confirms it). One day is one day."""
    day = today_local() + timedelta(days=6)
    s = _barber(db, day)
    got = [_cut(client, s, day, t, name=n).json() for t, n in
           (("10:00", "Far Lund"), ("10:30", "Barn 1"), ("11:00", "Barn 2"), ("11:30", "Barn 3"))]
    assert [g["status"] for g in got] == ["confirmed"] * 4
    # The per-address cap (3 a day, as on live) — and the page says so.
    assert [g["guest_mail"] for g in got] == [True, True, True, False]
    assert len([m for m in outbox if m["to"] == "familien.lund@example.dk"]) == 3


def test_a_fourth_day_ahead_is_still_held(client, db, outbox):
    days = [today_local() + timedelta(days=5 + i) for i in range(4)]
    s = _barber(db, days[0])
    for d in days[1:]:
        shift(db, s["user"], s["staff"], d, "10:00", "18:00")
    got = [_cut(client, s, d, "10:00", ip=f"10.72.0.{i}").json() for i, d in enumerate(days)]
    assert [g["status"] for g in got] == ["confirmed"] * 3 + ["requested"]
    assert _reason(db, got[3]["id"]) == "contact_active"


def test_one_day_takes_at_most_six_of_one_guests_bookings(client, db, outbox):
    day = today_local() + timedelta(days=6)
    s = _barber(db, day)
    times = ["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00"]
    got = [_cut(client, s, day, t, ip=f"10.73.0.{i}").json()["status"] for i, t in enumerate(times)]
    assert got == ["confirmed"] * 6 + ["requested"]


def test_a_restaurant_still_counts_bookings(client, db, outbox):
    """Four tables on one evening by one guest is not a family haircut."""
    u, p, _ = restaurant(db)
    day = today_local() + timedelta(days=6)
    got = [book(client, p.reservation_slug, day=day, time=t, email="fire@example.dk",
                form_ms=40000).json()["status"] for t in ("17:00", "18:00", "19:00", "20:00")]
    assert got == ["confirmed"] * 3 + ["requested"]


def test_a_held_guest_hears_past_the_address_cap_and_the_answer_follows(client, db, outbox, clock):
    """Three appointments on three days, booked this morning, used the
    address's 3 mails. A 4th day — tomorrow — is held, and the guest IS told
    "request received" (the page promises it); the expiry declines it
    tomorrow at 08:00, inside the same 24 h, and its answer reaches the guest
    although the address count is past the cap. Bounded: the extra is
    BOOKING_HELD_MAILS_PER_ADDRESS_EXTRA (1) a day — the next held one's page
    says no mail is coming."""
    from app.config import settings
    today = today_local()
    clock.local = _at(today, 10)
    tomorrow = today + timedelta(days=1)
    later = [today + timedelta(days=3 + i) for i in range(3)]
    more = [today + timedelta(days=7 + i) for i in range(2)]
    s = _barber(db, tomorrow)
    for d in later + more:
        shift(db, s["user"], s["staff"], d, "10:00", "18:00")
    got = []
    for i, d in enumerate(later + [tomorrow] + more):
        clock.local += timedelta(minutes=3)
        got.append(_cut(client, s, d, "10:00", ip=f"10.74.0.{i}").json())
    assert [g["status"] for g in got] == ["confirmed"] * 3 + ["requested"] * 3
    assert _reason(db, got[3]["id"]) == "contact_active"
    extra = settings.BOOKING_HELD_MAILS_PER_ADDRESS_EXTRA
    assert extra == 1
    assert [g["guest_mail"] for g in got] == [True] * 3 + [True] * extra + [False] * (3 - extra)
    assert len([m for m in outbox if m["to"] == "familien.lund@example.dk"]) == 3 + extra
    # Tomorrow 08:00 — under 24 h after the four mails — the promised
    # request is declined, and its answer goes out.
    clock.local = _at(tomorrow, 8)
    out = expire_stale_requests(db, now_local=_at(tomorrow, 8))
    assert out["requests_expired"] == 1 and out["guests_notified"] == 1
    assert reservation(db, got[3]["id"]).cancel_reason == "request_expired_no_answer"
    assert len([m for m in outbox if m["to"] == "familien.lund@example.dk"]) == 3 + extra + 1


def test_a_group_requests_expiry_keeps_the_address_cap(db, outbox):
    """THE CANNON stays shut: the held exception is for a HELD booking whose
    own request mail went out — a group request's expiry is capped as on
    live."""
    u, _p, _ = restaurant(db)
    now = datetime.now(CPH).replace(tzinfo=None, hour=14, minute=0, second=0, microsecond=0)
    for i in range(4):
        start = now + timedelta(hours=2)
        r = Reservation(user_id=u.id, guest_name="Parked", guest_email="victim@example.dk",
                        party_size=12, starts_at=start, ends_at=start + timedelta(hours=2),
                        duration_min=120, status="requested", source="public",
                        created_at=datetime.utcnow() - timedelta(days=2),
                        confirmation_sent_at=datetime.utcnow() - timedelta(hours=1))
        db.add(r)
    db.commit()
    out = expire_stale_requests(db, now_local=now)
    assert out["requests_expired"] == 4 and out["guests_notified"] == 0
    assert outbox == []


# ═══ 6. Never declined in the night ══════════════════════════════════════

def test_an_evening_request_for_the_morning_waits_for_the_owner(db, outbox):
    """Verify S5: sent at 21:00 for 09:30 tomorrow — declined at 09:00 (the
    owner's 21:00–22:00 and 08:00–09:00), never at 05:30."""
    u, _p, _ = restaurant(db)
    day = today_local() + timedelta(days=3)
    asked = _at(day - timedelta(days=1), 21)
    start = _at(day, 9, 30)
    assert answer_deadline(start, asked) == _at(day, 9)
    r = Reservation(user_id=u.id, guest_name="Morgen", guest_email="morgen@example.dk", party_size=10,
                    starts_at=start, ends_at=start + timedelta(hours=2), duration_min=120,
                    status="requested", source="public",
                    created_at=asked.replace(tzinfo=CPH).astimezone(timezone.utc).replace(tzinfo=None))
    db.add(r); db.commit()
    for t in (_at(day, 3, 30), _at(day, 5, 30), _at(day, 7, 59), _at(day, 8, 30)):
        assert expire_stale_requests(db, now_local=t)["requests_expired"] == 0, t
    assert expire_stale_requests(db, now_local=_at(day, 9))["requests_expired"] == 1
    assert reservation(db, r.id).cancel_reason == "request_expired_no_answer"


@pytest.mark.parametrize("created,start,deadline", [
    # winter time
    ((2026, 11, 12, 21, 0), (2026, 11, 13, 9, 30), (2026, 11, 13, 9, 0)),
    ((2026, 11, 12, 23, 30), (2026, 11, 13, 13, 0), (2026, 11, 13, 10, 0)),
    ((2026, 11, 10, 10, 0), (2026, 11, 13, 11, 0), (2026, 11, 13, 8, 0)),    # was 05:00
    ((2026, 11, 10, 10, 0), (2026, 11, 13, 8, 30), (2026, 11, 12, 21, 0)),   # breakfast: the evening before
    ((2026, 11, 12, 21, 30), (2026, 11, 12, 23, 0), (2026, 11, 13, 8, 30)),  # as the nightly run left it
    ((2026, 11, 13, 15, 0), (2026, 11, 13, 17, 30), (2026, 11, 13, 16, 30)), # same day: unchanged
    # the spring-forward night (29 Mar 2026, 02:00 → 03:00)
    ((2026, 3, 28, 21, 0), (2026, 3, 29, 9, 30), (2026, 3, 29, 9, 0)),
    ((2026, 3, 28, 23, 0), (2026, 3, 29, 12, 0), (2026, 3, 29, 10, 0)),
    ((2026, 3, 27, 12, 0), (2026, 3, 29, 10, 0), (2026, 3, 29, 8, 0)),
    # the fall-back night (25 Oct 2026, 03:00 → 02:00)
    ((2026, 10, 24, 21, 0), (2026, 10, 25, 9, 30), (2026, 10, 25, 9, 0)),
    ((2026, 10, 24, 23, 0), (2026, 10, 25, 12, 0), (2026, 10, 25, 10, 0)),
    ((2026, 10, 23, 12, 0), (2026, 10, 25, 10, 0), (2026, 10, 25, 8, 0)),
])
def test_the_deadline_leaves_the_owner_a_daytime_window(created, start, deadline):
    assert answer_deadline(datetime(*start), datetime(*created)) == datetime(*deadline)


@pytest.mark.parametrize("day", [(2026, 1, 14), (2026, 3, 28), (2026, 7, 15), (2026, 10, 24)])
def test_no_deadline_ever_falls_in_the_night(day):
    """Every request sent in a day (each half hour), for every sitting from
    30 minutes to 3 days ahead: the deadline is between 08:00 and 21:00, and
    the owner had their daytime window (2 h, or the shorter one a same-day
    request leaves) before it — across a summer-time change."""
    base = datetime(*day)
    for k in range(48):
        created = base + timedelta(minutes=30 * k)
        for m in range(1, 145):
            start = created + timedelta(minutes=30 * m)
            d = answer_deadline(start, created)
            assert d.replace(hour=8, minute=0) <= d <= d.replace(hour=21, minute=0), (created, start, d)
            far = start - timedelta(hours=6)
            grace = min(created + timedelta(hours=2),
                        max(start - timedelta(hours=1), created + timedelta(hours=1)))
            window = min(timedelta(hours=2), max(far, grace) - created)
            assert owner_daytime_after(created, window.total_seconds() / 3600) <= d, (created, start, d)
    assert answer_deadline(datetime(*day, 9, 30), None).hour == 8      # no creation time: old row


def test_the_sweep_across_the_spring_forward_night(db, outbox):
    """created_at is UTC: a request at 21:00 CET on Saturday 28 Mar for 09:30
    CEST on Sunday — still open at 05:30, declined at 09:00."""
    u, _p, _ = restaurant(db)
    start = datetime(2026, 3, 29, 9, 30)
    r = Reservation(user_id=u.id, guest_name="Sommertid", guest_email="dst@example.dk", party_size=10,
                    starts_at=start, ends_at=start + timedelta(hours=2), duration_min=120,
                    status="requested", source="public", created_at=datetime(2026, 3, 28, 20, 0))
    db.add(r); db.commit()
    assert expire_stale_requests(db, now_local=datetime(2026, 3, 29, 5, 30))["requests_expired"] == 0
    assert expire_stale_requests(db, now_local=datetime(2026, 3, 29, 8, 59))["requests_expired"] == 0
    assert expire_stale_requests(db, now_local=datetime(2026, 3, 29, 9, 0))["requests_expired"] == 1


def test_the_owners_decline_of_a_promised_request_reaches_the_guest(client, db, outbox, clock):
    """3 confirmations + the held 4th day's "request received" = 4 mails to
    the mailbox; the owner's decline is the 5th — inside the per-mailbox
    bound (GUEST_MAILS_PER_MAILBOX_PER_DAY), so the promised answer goes."""
    first = today_local() + timedelta(days=4)
    clock.local = _at(today_local(), 10)
    days = [first + timedelta(days=i) for i in range(4)]
    s = _barber(db, days[0])
    for d in days[1:]:
        shift(db, s["user"], s["staff"], d, "10:00", "18:00")
    got = []
    for i, d in enumerate(days):
        clock.local += timedelta(minutes=3)
        got.append(_cut(client, s, d, "10:00", ip=f"10.75.0.{i}").json())
    assert got[3]["status"] == "requested" and got[3]["guest_mail"] is True
    as_owner(s["user"])
    d = client.patch(f"/api/reservations/reservations/{got[3]['id']}/status",
                     json={"status": "cancelled"})
    assert d.status_code == 200 and "guest_email_skipped" not in d.json()
    assert len([m for m in outbox if m["to"] == "familien.lund@example.dk"]) == 5
