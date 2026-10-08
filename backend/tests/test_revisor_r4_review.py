"""Revisor artifacts, round 4 — review fixes.

* The demo fence no longer hangs on the " · demo" profile tag alone: saving
  the owner's own company from the register, a CVR re-verify, and the shared
  demo account (seeded untagged) all left anna@revisor.dk with auto-send NULL.
* "Unchanged" re-lock means the whole kasserapport is the same — a tips-,
  float- or notes-only correction still reaches the revisor.
* A MOMS-angivelse built partly from sample data is never mailed.
* Real figures locked on a seeded day stop being sample data.

Every send is stubbed — nothing leaves the process.
"""
from __future__ import annotations

import json
from datetime import date, datetime
from unittest.mock import AsyncMock, patch

import pytest

from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from tests.test_revisor_artifacts import (  # noqa: F401 — fixtures
    _auth,
    _lock,
    _make_user,
    _revisor_mails,
    _unlock,
    client,
    db_session,
    mailbox,
    unsub_db,
)
from tests.test_revisor_r4_demo_fence import (  # noqa: F401 — fixtures
    DEMO_LINE_DA,
    _demo_profile,
    _real_profile,
    _row,
)


@pytest.fixture(autouse=True)
def _fresh_route_limiters():
    from app.routers import accountants as _acc, business_profile as _bp, staff as _staff, tax as _tax
    lims = (_tax._limiter, _staff._limiter, _acc._limiter, _bp._limiter)
    for lim in lims:
        lim.reset()
    yield
    for lim in lims:
        lim.reset()


# The exact payload BusinessLookup.handleSave sends for a company picked from
# the register — no accountant fields.
LOOKUP_PAYLOAD = {
    "company_name": "Café Rigtig ApS", "org_number": "12345678", "country": "DK",
    "address": "Nørregade 2", "city": "København K", "zipcode": "1165",
    "industry": "Caféer", "industry_code": "56.30.00", "phone": "", "email": "",
    "source": "cvrapi.dk", "company_type": "ApS", "founded": "",
    "dawa_address_id": None, "vat_registered": True, "status_flags": None,
}


def _shared_demo_profile(db, user):
    """The shared demo account's shape: seeded WITHOUT the tag (clean
    "cvrapi.dk" source), the old deliverable seed values, auto-send NULL."""
    p = BusinessProfile(
        user_id=user.id, company_name="Mirabelle ApS", org_number="39842851",
        country="DK", email="info@mirabelle.dk", accountant_email="anna@revisor.dk",
        accountant_name="Anna Hansen", accountant_auto_send=None,
        cvr_verified_source="cvrapi.dk", cvr_verified_at=datetime(2026, 9, 1),
    )
    db.add(p); db.commit(); db.refresh(p)
    return p


# ─── The fence without the tag ─────────────────────────────────────────


def test_saving_your_own_company_from_the_register_drops_the_sample_revisor(
        db_session, client, mailbox):
    user = _make_user(db_session)
    _demo_profile(db_session, user)  # tagged, anna@revisor.dk, auto-send NULL
    r = client.put("/api/business", json=LOOKUP_PAYLOAD, headers=_auth(user))
    assert r.status_code == 200, r.text
    prof = r.json()
    assert prof["cvr_verified_source"] == "cvrapi.dk"  # the tag is gone …
    assert prof["accountant_email"] is None              # … and so is the sample revisor
    assert prof["accountant_auto_send_effective"] is False
    p = db_session.query(BusinessProfile).filter_by(user_id=user.id).first()
    db_session.refresh(p)
    assert p.accountant_auto_send is False and p.accountant_name is None

    ritual = _lock(client, user).json()["close_ritual"]
    assert "anna@revisor.dk" not in ritual["sent_to"]
    assert ritual["accountant_included"] is False
    assert all("anna@revisor.dk" not in m["to"] for m in mailbox.sent)


def test_a_real_revisor_typed_in_the_same_save_is_kept(db_session, client):
    user = _make_user(db_session)
    _demo_profile(db_session, user)
    r = client.put("/api/business", json={**LOOKUP_PAYLOAD, "accountant_email": "min@revisor.dk",
                                          "accountant_name": "Mette", "accountant_auto_send": True},
                   headers=_auth(user))
    assert r.status_code == 200, r.text
    assert r.json()["accountant_email"] == "min@revisor.dk"
    assert r.json()["accountant_auto_send_effective"] is True


def test_reverify_drops_the_sample_revisor_with_the_tag(db_session, client, mailbox):
    user = _make_user(db_session)
    _demo_profile(db_session, user)
    fresh = [{"name": "Mirabelle ApS", "source": "cvrapi.dk", "status_flags": [],
              "vat_registered": True}]
    with patch("app.routers.business_profile.lookup_business", new=AsyncMock(return_value=fresh)):
        r = client.post("/api/business/reverify", headers=_auth(user))
    assert r.status_code == 200, r.text
    assert "accountant_email" in r.json()["fields_changed"]
    p = db_session.query(BusinessProfile).filter_by(user_id=user.id).first()
    db_session.refresh(p)
    assert p.cvr_verified_source == "cvrapi.dk"
    assert p.accountant_email is None and p.accountant_auto_send is False

    ritual = _lock(client, user).json()["close_ritual"]
    assert "anna@revisor.dk" not in ritual["sent_to"]
    assert all("anna@revisor.dk" not in m["to"] for m in mailbox.sent)


def test_an_untagged_profile_still_holding_the_seed_is_fenced_on_every_path(
        db_session, client, mailbox):
    """The shared demo account (and any profile whose tag was lost before this
    fix): no tag, anna@revisor.dk + Anna Hansen, auto-send NULL."""
    user = _make_user(db_session)
    _shared_demo_profile(db_session, user)
    prof = client.get("/api/business", headers=_auth(user)).json()
    assert prof["accountant_is_demo"] is True
    assert prof["accountant_auto_send_effective"] is False

    r = _lock(client, user)
    ritual = r.json()["close_ritual"]
    assert ritual["accountant_skip_reason"] == "demo_recipient"
    assert "anna@revisor.dk" not in ritual["sent_to"]
    owner = [m for m in mailbox.sent if m["to"] == ["anders@mirabelle.dk"]]
    assert len(owner) == 1 and DEMO_LINE_DA in owner[0]["html"]

    rr = client.post(f"/api/daily-close/{r.json()['id']}/resend-email",
                     json={"key": "click-shared-1", "force": True}, headers=_auth(user))
    assert rr.status_code == 200, rr.text
    assert rr.json()["close_ritual"]["accountant_skip_reason"] == "demo_recipient"

    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(True, None)) as sender, \
         patch("app.services.email_service.send_email", return_value=True) as plain:
        p = client.post("/api/daily-close/send-to-accountant?from=2026-09-01&to=2026-09-30",
                        json={"fmt": "pdf"}, headers=_auth(user))
        assert p.status_code == 409 and p.json()["detail"]["code"] == "demo_recipient"
        t = client.post("/api/tax/filing-pdf/send-to-accountant"
                        "?period_start=2026-09-01&period_end=2026-09-30",
                        json={"cc_self": True}, headers=_auth(user))
        assert t.status_code == 409 and t.json()["detail"]["code"] == "demo_recipient", t.text
        pr = client.post("/api/staff/payroll/send-to-accountant",
                         json={"period_start": "2026-09-01", "period_end": "2026-09-30"},
                         headers=_auth(user))
        assert pr.status_code == 409 and pr.json()["detail"]["code"] == "demo_recipient", pr.text
        inv = client.post("/api/accountants/invite", json={"email": "anna@revisor.dk"},
                          headers=_auth(user))
        assert inv.status_code == 409 and inv.json()["detail"]["code"] == "demo_recipient", inv.text
        assert sender.call_count == 0 and plain.call_count == 0
    assert all("anna@revisor.dk" not in m["to"] for m in mailbox.sent)


def test_the_fence_reads_the_seed_not_a_name_or_an_address_alone(db_session):
    from app.services.revisor_mail import is_demo_revisor, is_demo_seeded_address
    u1, u2, u3 = (_make_user(db_session, email=f"o{i}@cafe.dk") for i in range(3))
    # A real revisor called Anna at that address (no seed name, no tag): mailed.
    assert is_demo_revisor(_real_profile(db_session, u1)) is False
    # A real revisor who happens to be called Anna Hansen at their own address.
    assert is_demo_revisor(_real_profile(db_session, u2, accountant_email="anna@hansen-revision.dk",
                                         accountant_name="Anna Hansen")) is False
    # The reserved seed address is never a real revisor, whatever the profile.
    real = _real_profile(db_session, u3, accountant_email="revisor@mirabelle.example")
    assert is_demo_revisor(real) is True
    assert is_demo_seeded_address(real, "info@mirabelle.example") is True
    assert is_demo_seeded_address(real, "info@mirabelle.dk") is False


# ─── "Unchanged" means the whole kasserapport ─────────────────────────


def test_a_tips_only_relock_sends_the_correction(db_session, client, mailbox):
    user = _make_user(db_session)
    _real_profile(db_session, user)
    cid = _lock(client, user, rev=12500.0).json()["id"]
    assert len(_revisor_mails(mailbox)) == 1
    _unlock(client, user, cid, reason="Drikkepenge manglede")
    r = _lock(client, user, rev=12500.0, tips_total=850.0, tips_staff_count=2)
    ritual = r.json()["close_ritual"]
    assert ritual["accountant_skip_reason"] is None
    assert ritual["accountant_included"] is True
    assert len(_revisor_mails(mailbox)) == 2
    last = _revisor_mails(mailbox)[-1]
    assert last["subject"].startswith("Rettet kasserapport")
    assert "Drikkepenge" in last["html"] and "850,00 kr." in last["html"]
    assert "Tallene er de samme" not in last["html"]
    owner = [m for m in mailbox.sent if m["to"] == ["anders@mirabelle.dk"]][-1]
    assert "tallene er uændrede" not in owner["html"]
    row = client.get(f"/api/daily-close/{cid}", headers=_auth(user)).json()
    assert row["email_error"] != "revisor_unchanged"


def test_a_float_only_relock_sends_the_correction(db_session, client, mailbox):
    user = _make_user(db_session)
    _real_profile(db_session, user)
    cid = _lock(client, user, rev=12500.0).json()["id"]
    _unlock(client, user, cid, reason="Byttepenge manglede")
    r = _lock(client, user, rev=12500.0, cash_float=1500.0)
    assert r.json()["close_ritual"]["accountant_skip_reason"] is None
    assert len(_revisor_mails(mailbox)) == 2
    last = _revisor_mails(mailbox)[-1]
    assert last["subject"].startswith("Rettet kasserapport")
    assert "Byttepenge" in last["html"]


def test_a_notes_or_closer_only_relock_sends_the_correction(db_session, client, mailbox):
    user = _make_user(db_session)
    _real_profile(db_session, user)
    cid = _lock(client, user, rev=12500.0).json()["id"]
    _unlock(client, user, cid, reason="Note")
    r = _lock(client, user, rev=12500.0, notes="Kassen talt af to")
    assert r.json()["close_ritual"]["accountant_skip_reason"] is None
    assert len(_revisor_mails(mailbox)) == 2
    _unlock(client, user, cid, reason="Forkert navn")
    r = _lock(client, user, rev=12500.0, notes="Kassen talt af to", closed_by="Mette")
    assert r.json()["close_ritual"]["accountant_skip_reason"] is None
    assert len(_revisor_mails(mailbox)) == 3


def test_a_lock_recorded_before_the_signature_is_never_assumed_unchanged(
        db_session, client, mailbox):
    user = _make_user(db_session)
    _real_profile(db_session, user)
    cid = _lock(client, user, rev=12500.0).json()["id"]
    lock_row = (db_session.query(AuditLog).filter(AuditLog.action == "daily_close.lock")
                .order_by(AuditLog.created_at.desc()).first())
    after = json.loads(lock_row.after_state)
    assert after["doc_sig"] and after["tips_total"] is None
    # As an older lock row looked: no signature, no Drikkepenge/float record.
    for k in ("doc_sig", "tips_total", "tips_staff_count", "cash_float", "cash_expected"):
        after.pop(k)
    lock_row.after_state = json.dumps(after)
    db_session.commit()
    _unlock(client, user, cid, reason="Tjek")
    r = _lock(client, user, rev=12500.0)
    assert r.json()["close_ritual"]["accountant_skip_reason"] is None
    assert _revisor_mails(mailbox)[-1]["subject"].startswith("Rettet kasserapport")


# ─── A MOMS-angivelse with sample data is never mailed ─────────────────


def _demo_expense(db, user, d, amount):
    cat = ExpenseCategory(user_id=user.id, name="Råvarer · demo")
    db.add(cat); db.flush()
    e = Expense(user_id=user.id, category_id=cat.id, date=d, amount=amount,
                description="Kaffebønner · demo", is_deleted=False)
    db.add(e); db.commit()
    return e


@pytest.mark.parametrize("shape", ["demo_only", "mixed", "demo_expense"])
def test_the_moms_send_refuses_a_period_holding_sample_data(db_session, client, shape):
    user = _make_user(db_session)
    _real_profile(db_session, user, accountant_email="min@revisor.dk")
    expect = 0
    if shape in ("mixed", "demo_expense"):
        for d in (2, 3, 4):
            _row(db_session, user, date(2026, 9, d), 3000.0)
    if shape in ("demo_only", "mixed"):
        for d in (10, 11, 12, 13):
            _row(db_session, user, date(2026, 9, d), 20000.0, demo=True)
        expect += 4
    if shape == "demo_expense":
        _demo_expense(db_session, user, date(2026, 9, 5), 500.0)
        expect += 1
    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(True, None)) as sender:
        t = client.post("/api/tax/filing-pdf/send-to-accountant"
                        "?period_start=2026-09-01&period_end=2026-09-30",
                        json={"cc_self": True}, headers=_auth(user))
    assert t.status_code == 422, t.text
    detail = t.json()["detail"]
    assert detail["code"] == "demo_in_period" and detail["n_demo"] == expect
    assert "eksempeldata" in detail["message_da"] and "Profil" in detail["message_da"]
    assert sender.call_count == 0
    assert db_session.query(AuditLog).filter(
        AuditLog.action == "tax.filing_sent_to_accountant").count() == 0


def test_the_moms_send_of_a_real_period_still_goes(db_session, client):
    user = _make_user(db_session)
    _real_profile(db_session, user, accountant_email="min@revisor.dk")
    for d in (2, 3, 4):
        _row(db_session, user, date(2026, 9, d), 3000.0)
    # A sample day OUTSIDE the period does not block it.
    _row(db_session, user, date(2026, 8, 30), 20000.0, demo=True)
    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(True, None)) as sender:
        t = client.post("/api/tax/filing-pdf/send-to-accountant"
                        "?period_start=2026-09-01&period_end=2026-09-30",
                        json={"cc_self": True}, headers=_auth(user))
    assert t.status_code == 200, t.text
    assert sender.call_args_list[0].args[0] == "min@revisor.dk"


# ─── Real figures on a seeded day are the owner's own ─────────────────


def _counts(client, user):
    return client.get("/api/daily-close/range-counts",
                      params={"from": "2026-09-01", "to": "2026-09-30"}, headers=_auth(user)).json()


def test_real_figures_locked_on_a_seeded_draft_count_in_the_period(db_session, client):
    user = _make_user(db_session)
    _real_profile(db_session, user, accountant_email="min@revisor.dk")
    _row(db_session, user, date(2026, 9, 25), 777.0, status="draft", demo=True)
    assert _counts(client, user)["n_demo"] == 1
    # "Fortsæt kladden": the wizard sends the seeded notes back with the
    # owner's real Z-bon figures.
    r = _lock(client, user, d="2026-09-25", rev=15000.0, notes="sample · demo")
    assert r.status_code == 200, r.text
    assert r.json()["notes"] is None
    c = _counts(client, user)
    assert (c["n_locked"], c["n_demo"]) == (1, 0)
    from app.services.daily_close_range_export import period_totals
    rows = db_session.query(DailyClose).filter(DailyClose.user_id == user.id).all()
    t = period_totals(rows)
    assert (t["n_confirmed"], t["n_demo"], t["revenue"]) == (1, 0, 15000.0)


def test_an_autosave_then_lock_does_not_bring_the_marker_back(db_session, client):
    user = _make_user(db_session)
    _real_profile(db_session, user, accountant_email="min@revisor.dk")
    _row(db_session, user, date(2026, 9, 25), 777.0, status="draft", demo=True)
    d = _lock(client, user, d="2026-09-25", rev=15000.0, status="draft", notes="sample · demo")
    assert d.status_code == 200, d.text
    assert d.json()["notes"] is None
    # The wizard still holds the seeded notes when the owner locks.
    r = _lock(client, user, d="2026-09-25", rev=15000.0, notes="Travl aften · demo")
    assert r.json()["notes"] == "Travl aften"
    assert _counts(client, user)["n_locked"] == 1


def test_a_seeded_day_saved_unchanged_stays_sample_data(db_session, client):
    user = _make_user(db_session)
    _real_profile(db_session, user, accountant_email="min@revisor.dk")
    _row(db_session, user, date(2026, 9, 25), 777.0, status="draft", demo=True)
    # The _row seed: food 777 / card 777, no counted cash.
    r = _lock(client, user, d="2026-09-25", rev=777.0, notes="sample · demo",
              payment_breakdown={"card": 777.0}, cash_counted=None)
    assert r.status_code == 200, r.text
    assert r.json()["notes"] == "sample · demo"
    c = _counts(client, user)
    assert (c["n_locked"], c["n_demo"]) == (0, 1)
    assert r.json()["close_ritual"]["accountant_skip_reason"] == "demo_close"


def test_a_new_close_never_carries_the_marker(db_session, client):
    user = _make_user(db_session)
    _real_profile(db_session, user, accountant_email="min@revisor.dk")
    r = _lock(client, user, d="2026-09-26", rev=9000.0, notes="sample · demo")
    assert r.json()["notes"] is None
    assert _counts(client, user)["n_locked"] == 1
