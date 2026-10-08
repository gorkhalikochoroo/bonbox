"""Revisor artifacts, round 6 — the review's findings on the demo fence.

1. Saving the owner's own company dropped the " · demo" tag BEFORE it looked
   for the seeded revisor: on a pre-r6 seed with a typed name beside the old
   deliverable address (anna@revisor.dk), that address became "your revisor".
2. "Ryd demodata" did the same — the stamp restore first, the seeded-revisor
   test after it — and kept anna@revisor.dk with auto-send on.
3. Pre-r6 builds copied the sample name into users.business_name; after the
   clear (no snapshot) every revisor mail fell back to it: the real revisor got
   "Mirabelle ApS". The fence reads the name the mail would carry.
4. An opt-out from "pia+bonbox@" did not stop mail to "pia@".
5. A period-send key replayed "sent" for another period / format.
7. The Profile save that replaces the sample company set the owner's pre-seed
   address, phone and e-mail to NULL (and kept the sample's company type and
   VAT flag); the clear after it then dropped the snapshot.

Every send is stubbed — nothing leaves the process.
"""
from __future__ import annotations

import json
from datetime import date, datetime

from app.models.business_profile import BusinessProfile
from tests.test_revisor_artifacts import (  # noqa: F401 — fixtures
    _auth,
    _lock,
    _make_profile,
    _make_user,
    client,
    db_session,
    mailbox,
    unsub_db,
)
from tests.test_revisor_r6_demo_identity import (  # noqa: F401 — fixtures
    OWN_COMPANY,
    PIA,
    _fresh_route_limiters,
    _profile,
    _row,
    _seeded_owner,
    _to,
)

ANNA = "anna@revisor.dk"

_SENDS = (
    ("/api/daily-close/send-to-accountant?from=2026-10-01&to=2026-10-07", {"fmt": "pdf"}),
    ("/api/tax/filing-pdf/send-to-accountant?period_start=2026-10-01&period_end=2026-10-07",
     {"cc_self": True}),
    ("/api/staff/payroll/send-to-accountant",
     {"period_start": "2026-10-01", "period_end": "2026-10-07"}),
)


def _legacy_seed(db, user, **kw):
    """A profile the demo seeder wrote BEFORE round 6: tagged, the old
    deliverable seed address, auto-send NULL (= on), no snapshot."""
    p = BusinessProfile(
        user_id=user.id, company_name="Mirabelle ApS", org_number="39842851",
        vat_number="DK39842851", address="Vestergade 1", zipcode="1456",
        city="København K", country="DK", phone="+45 33 11 22 33",
        email="info@mirabelle.dk", industry="Restauranter", industry_code="56.10.10",
        company_type="Anpartsselskab", vat_registered=True, day_cutoff_hour=4,
        source="cvrapi.dk", founded="2018-03-12",
        cvr_verified_source="cvrapi.dk · demo", cvr_verified_at=datetime(2026, 9, 1),
        **{"accountant_email": ANNA, "accountant_name": "Anna Hansen",
           "accountant_auto_send": None, **kw},
    )
    db.add(p); db.commit(); db.refresh(p)
    return p


# ═══ 1. The identity fix never turns the seed address into "your revisor" ══


def test_fixing_the_company_on_a_legacy_seed_never_frees_the_seed_address(
        db_session, client, mailbox):
    user = _make_user(db_session, plan="pro", email="owner@testcafe.dk")
    _legacy_seed(db_session, user)
    # (1) The owner types their revisor's NAME and leaves the sample address.
    r = client.put("/api/business", json={
        "company_name": "Mirabelle ApS", "accountant_email": ANNA,
        "accountant_name": "Pia Jensen", "accountant_auto_send": True,
    }, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert r.json()["accountant_is_demo"] is True
    # (2) … then their own company, as the notice tells them to.
    r = client.put("/api/business", json=OWN_COMPANY, headers=_auth(user))
    assert r.status_code == 200, r.text
    prof = r.json()
    assert prof["identity_is_demo"] is False
    assert prof["accountant_email"] != ANNA
    assert prof["accountant_auto_send_effective"] is False

    # (3) Nothing goes to the seed address on any path.
    ritual = _lock(client, user, d="2026-10-07").json()["close_ritual"]
    assert ritual["accountant_included"] is False
    _row(db_session, user, date(2026, 10, 2), 1000.0)
    for url, body in _SENDS:
        s = client.post(url, json=body, headers=_auth(user))
        assert s.status_code in (400, 409), (url, s.status_code, s.text)
    assert _to(mailbox, ANNA) == []


def test_a_rename_keeps_the_seed_address_fenced_even_after_the_tag_goes(db_session, client):
    """The general guard: whatever a save does to the stamp, a seeded address
    that was the sample before it is never "your revisor" after it."""
    user = _make_user(db_session)
    _legacy_seed(db_session, user, accountant_name="Pia Jensen")
    r = client.put("/api/business", json={**OWN_COMPANY, "accountant_email": ANNA,
                                           "accountant_name": "Pia Jensen"},
                   headers=_auth(user))
    assert r.status_code == 200, r.text
    assert r.json()["accountant_email"] in (None, "", "revisor@mirabelle.example")


# ═══ 2. Ryd demodata decides "seeded revisor" before the stamp goes ═══════


def test_clearing_a_legacy_seed_with_a_typed_name_drops_the_seed_address(
        db_session, client, mailbox):
    user = _make_user(db_session, email="owner@testcafe.dk")
    _legacy_seed(db_session, user, accountant_name="Pia Jensen")
    r = client.post("/api/demo/clear", headers=_auth(user))
    assert r.status_code == 200, r.text
    assert "revisor" not in r.json()["kept"]
    p = _profile(db_session, user)
    assert p is None or (p.accountant_email or "") == ""
    _lock(client, user, d="2026-10-07")
    assert _to(mailbox, ANNA) == []


def test_clearing_still_keeps_an_owner_typed_real_revisor(db_session):
    from app.services.demo_seed import clear_for_user
    user = _make_user(db_session)
    _legacy_seed(db_session, user, accountant_email=PIA, accountant_name="Pia Jensen",
                 accountant_auto_send=True)
    out = clear_for_user(db_session, user)
    p = _profile(db_session, user)
    assert p.accountant_email == PIA and p.accountant_auto_send is True
    assert "revisor" in out["kept"]


# ═══ 3. The name the mail carries: users.business_name ═════════════════════


def _legacy_owner_with_sample_signup_name(db):
    """A pre-r6 demo user who saved Profile: the old build copied the
    sample's name over the signup name — and the owner saved their real
    revisor on the seeded profile."""
    user = _make_user(db, plan="pro", email="owner@testcafe.dk")
    user.business_name = "Mirabelle ApS"
    db.commit()
    _legacy_seed(db, user, accountant_email=PIA, accountant_name="Pia Jensen")
    return user


def test_after_the_clear_a_sample_signup_name_still_fences_every_send(
        db_session, client, mailbox):
    user = _legacy_owner_with_sample_signup_name(db_session)
    r = client.post("/api/demo/clear", headers=_auth(user))
    assert r.status_code == 200 and "revisor" in r.json()["kept"]
    prof = client.get("/api/business", headers=_auth(user)).json()
    assert prof["company_name"] == "" and prof["accountant_email"] == PIA
    # The mail would say "Mirabelle ApS" (the signup name): still the sample.
    assert prof["identity_is_demo"] is True
    assert prof["accountant_auto_send_effective"] is False

    ritual = _lock(client, user, d="2026-10-07").json()["close_ritual"]
    assert ritual["accountant_skip_reason"] == "demo_identity"
    _row(db_session, user, date(2026, 10, 2), 1000.0)
    for url, body in (*_SENDS, ("/api/accountants/invite", {"email": PIA})):
        s = client.post(url, json=body, headers=_auth(user))
        assert s.status_code == 409, (url, s.status_code, s.text)
        assert s.json()["detail"]["code"] == "demo_identity", url
    assert _to(mailbox, PIA) == []
    assert not any("Mirabelle" in (m.get("subject") or "") and m["to"] == [PIA]
                   for m in mailbox.sent)

    # The owner saves their own company: the name follows, the sends work.
    r = client.put("/api/business", json=OWN_COMPANY, headers=_auth(user))
    assert r.json()["identity_is_demo"] is False
    db_session.refresh(user)
    assert user.business_name == "Testcafé ApS"
    mailbox.sent.clear()
    ritual = _lock(client, user, d="2026-10-06").json()["close_ritual"]
    assert ritual["accountant_included"] is True
    m = _to(mailbox, PIA)[0]
    assert "Testcafé ApS" in m["subject"] and "Mirabelle" not in m["subject"]


def test_an_old_clear_then_a_revisor_save_is_fenced_too(db_session, client, mailbox):
    """Cleared under an old build (the profile row deleted), then only a
    revisor saved: the profile has no company name, the mail would carry the
    sample signup name."""
    user = _make_user(db_session, plan="pro", email="owner@testcafe.dk")
    user.business_name = "Mirabelle ApS"
    db_session.commit()
    r = client.put("/api/business", json={
        "company_name": "", "accountant_email": PIA, "accountant_name": "Pia",
        "accountant_auto_send": True,
    }, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert r.json()["identity_is_demo"] is True
    ritual = _lock(client, user, d="2026-10-07").json()["close_ritual"]
    assert ritual["accountant_skip_reason"] == "demo_identity"
    inv = client.post("/api/accountants/invite", json={"email": PIA}, headers=_auth(user))
    assert inv.status_code == 409 and inv.json()["detail"]["code"] == "demo_identity"
    assert _to(mailbox, PIA) == []


def test_the_signup_name_rule():
    from types import SimpleNamespace as U
    from app.services.revisor_mail import is_demo_identity, signup_name_is_sample
    P = BusinessProfile
    sample = U(business_name=" mirabelle  aps ")
    own = U(business_name="Testcafé ApS")
    assert signup_name_is_sample(None, sample) is True
    assert is_demo_identity(P(company_name="", accountant_email=PIA), sample) is True
    assert is_demo_identity(P(company_name="", accountant_email=PIA), own) is False
    # Without the user (the documents, the clear) the profile alone decides.
    assert is_demo_identity(P(company_name="", accountant_email=PIA)) is False
    # A register-verified CVR of the owner's own outranks the name.
    verified = P(company_name="Mirabelle ApS", org_number="12345678",
                 cvr_verified_at=datetime(2026, 9, 1), cvr_verified_source="cvrapi.dk")
    assert is_demo_identity(verified, sample) is False
    # … the demo's own stamp does not.
    tagged = P(company_name="X", org_number="12345678",
               cvr_verified_at=datetime(2026, 9, 1), cvr_verified_source="cvrapi.dk · demo")
    assert signup_name_is_sample(tagged, sample) is True


def test_a_real_owner_is_untouched_by_the_signup_name_rule(db_session, client, mailbox):
    user = _make_user(db_session, email="owner@testcafe.dk")  # "Mirabelle Café"
    _make_profile(db_session, user, accountant_email=PIA, accountant_name="Pia")
    prof = client.get("/api/business", headers=_auth(user)).json()
    assert prof["identity_is_demo"] is False
    assert _lock(client, user, d="2026-10-07").json()["close_ritual"]["accountant_included"] is True
    assert len(_to(mailbox, PIA)) == 1


# ═══ 4. An opt-out stops the mailbox, from either side of a "+tag" ════════


def _opt_out_via(client, url):
    token = url.split("token=", 1)[1]
    return client.post(f"/api/email/unsubscribe?token={token}")


def test_an_opt_out_from_a_plus_tag_stops_the_plain_address(
        db_session, unsub_db, client, mailbox):
    from app.services.revisor_mail import revisor_opted_out, revisor_unsubscribe_url
    user = _make_user(db_session, email="owner@testcafe.dk")
    _make_profile(db_session, user, accountant_email="pia+bonbox@realrevisor.dk",
                  accountant_name="Pia")
    r = _opt_out_via(client, revisor_unsubscribe_url(user.id, "pia+bonbox@realrevisor.dk"))
    assert r.status_code == 200, r.text
    p = _profile(db_session, user)
    p.accountant_email = PIA
    db_session.commit()
    assert revisor_opted_out(p) is True
    assert revisor_opted_out(p, "pia+other@realrevisor.dk") is True
    assert revisor_opted_out(p, "kim@realrevisor.dk") is False
    ritual = _lock(client, user, d="2026-10-07").json()["close_ritual"]
    assert ritual["accountant_included"] is False
    assert _to(mailbox, PIA) == []


def test_a_token_minted_before_on_the_plus_tag_also_stops_the_mailbox(
        db_session, unsub_db, client):
    """Tokens already in revisors' inboxes carry the raw "+tag" fingerprint."""
    from app.services.revisor_mail import REVISOR_TOPIC, address_fingerprint, revisor_opted_out
    from app.utils.email_unsubscribe_token import make_unsubscribe_token
    user = _make_user(db_session)
    _make_profile(db_session, user, accountant_email="pia+bonbox@realrevisor.dk")
    token = make_unsubscribe_token(str(user.id), REVISOR_TOPIC, ttl_days=180,
                                   extra={"r": address_fingerprint("pia+bonbox@realrevisor.dk")})
    assert client.post(f"/api/email/unsubscribe?token={token}").status_code == 200
    p = _profile(db_session, user)
    assert revisor_opted_out(p) is True
    assert revisor_opted_out(p, PIA) is True
    # The revisor's own undo withdraws both.
    assert client.post(f"/api/email/unsubscribe?token={token}&undo=1").status_code == 200
    p = _profile(db_session, user)
    assert revisor_opted_out(p) is False and revisor_opted_out(p, PIA) is False


# ═══ 5. A period-send key answers only for its own send ═══════════════════


def test_a_period_key_reused_for_another_period_or_format_is_refused(
        db_session, client, mailbox):
    user = _make_user(db_session)
    _make_profile(db_session, user, accountant_email=PIA, accountant_name="Pia")
    _row(db_session, user, date(2026, 9, 25), 1000.0)
    _row(db_session, user, date(2026, 9, 26), 1000.0)
    body = {"fmt": "pdf", "cc_self": False, "key": "tap-period-777"}
    a = client.post("/api/daily-close/send-to-accountant?from=2026-09-01&to=2026-09-30",
                    json=body, headers=_auth(user))
    assert a.status_code == 200, a.text
    b = client.post("/api/daily-close/send-to-accountant?from=2026-09-26&to=2026-09-26",
                    json=body, headers=_auth(user))
    assert b.status_code == 409, b.text
    assert b.json()["detail"]["code"] == "send_key_reused"
    c = client.post("/api/daily-close/send-to-accountant?from=2026-09-01&to=2026-09-30",
                    json={**body, "fmt": "csv"}, headers=_auth(user))
    assert c.status_code == 409 and c.json()["detail"]["code"] == "send_key_reused"
    assert len(_to(mailbox, PIA)) == 1
    # The same send again still replays (never a second mail).
    d = client.post("/api/daily-close/send-to-accountant?from=2026-09-01&to=2026-09-30",
                    json=body, headers=_auth(user))
    assert d.status_code == 200 and d.json()["replayed"] is True
    assert len(_to(mailbox, PIA)) == 1


# ═══ 7. Fixing the company restores the owner's own pre-seed details ══════


def test_fixing_the_company_restores_what_the_owner_had_before_the_seed(db_session, client):
    from app.services.demo_seed import seed_for_user
    user = _make_user(db_session, email="owner@testcafe.dk")
    p = BusinessProfile(user_id=user.id, company_name="Testcafé", address="Nørregade 5",
                        zipcode="1165", city="København K", phone="+45 11 22 33 44",
                        email="info@testcafe.dk", day_cutoff_hour=5)
    db_session.add(p); db_session.commit()
    assert seed_for_user(db_session, user)["ok"] is True
    p = _profile(db_session, user)
    assert p.company_name == "Mirabelle ApS" and p.company_type == "Anpartsselskab"
    snap = json.loads(p.demo_snapshot_json)["fields"]
    assert snap["address"] == "Nørregade 5" and snap["email"] == "info@testcafe.dk"

    r = client.put("/api/business", json={"company_name": "Testcafé",
                                           "org_number": "12345678"}, headers=_auth(user))
    assert r.status_code == 200, r.text
    prof = r.json()
    assert prof["identity_is_demo"] is False
    assert (prof["address"], prof["zipcode"], prof["city"]) == ("Nørregade 5", "1165", "København K")
    assert prof["phone"] == "+45 11 22 33 44" and prof["email"] == "info@testcafe.dk"
    # The sample's company facts are not "theirs" now.
    assert prof["company_type"] in (None, "") and prof["vat_registered"] is None
    assert prof["industry"] in (None, "") and prof["industry_code"] in (None, "")
    assert prof["vat_number"] in (None, "")
    p = _profile(db_session, user)
    assert p.demo_snapshot_json is not None  # the clear still restores the cutoff

    r = client.post("/api/demo/clear", headers=_auth(user))
    assert r.status_code == 200, r.text
    p = _profile(db_session, user)
    assert (p.company_name, p.org_number) == ("Testcafé", "12345678")
    assert (p.address, p.zipcode, p.phone, p.email) == (
        "Nørregade 5", "1165", "+45 11 22 33 44", "info@testcafe.dk")
    assert p.company_type in (None, "") and p.vat_registered is None
    assert p.day_cutoff_hour == 5 and p.demo_snapshot_json is None


def test_a_company_form_that_echoes_the_sample_contact_details_still_resets_them(
        db_session, client):
    """BusinessLookup sends every field: the sample's street, phone and e-mail
    echoed back are not the owner's — an industry the owner leaves is."""
    user = _seeded_owner(db_session)
    r = client.put("/api/business", json={
        **OWN_COMPANY, "address": "Vestergade 1", "zipcode": "1456", "city": "København K",
        "phone": "+45 33 11 22 33", "email": "info@mirabelle.example",
        "industry": "Restauranter", "source": "manual",
    }, headers=_auth(user))
    assert r.status_code == 200, r.text
    prof = r.json()
    assert prof["identity_is_demo"] is False
    assert prof["address"] is None and prof["phone"] is None and prof["email"] is None
    assert prof["industry"] == "Restauranter"
