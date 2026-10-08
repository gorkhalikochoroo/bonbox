"""Revisor artifacts, round 5 — a demo day says it is an example, the sample
revisor's name never greets the real one.

1. A demo seeder's sample close (notes end in " · demo") renders a
   kasserapport titled "KASSERAPPORT — EKSEMPEL", with the demo banner in the
   draft-banner slot, "Eksempel — ikke til bogføring" in place of the
   readiness band, no bilag number, no retention note, an "EKSEMPEL …" file
   name and without the seeder's "sample · demo" as the owner's note. A real
   close's kasserapport is unchanged.
2. Replacing the seeded revisor address clears the seeded name server-side
   (raw PUT too), so the next mail greets "Hej,". A real revisor's name is
   never cleared.
3. Period PDF polish: a short period is one page (the statutory line is in the
   page footer, never alone on a page 2), "Salgsmoms (25 %)" never breaks
   mid-parenthesis, page 1 says "Kasserapporter" like the running header, and
   a locked day that needs review says so on its row.
4. Mail polish that reaches the revisor: an explicit table font-size, a signed
   cash difference in the correction table, "Ændret:" on its own line in the
   text part, the period voucher number named, and an opt-out page that names
   every mail it stops.

These tests READ THE CONTENT (pypdf for the PDFs, the HTML/text of the mails).
Every send is stubbed — nothing leaves the process.
"""
from __future__ import annotations

import io
import re
import uuid
from datetime import date, datetime

import pytest

from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose
from tests.test_revisor_artifacts import (  # noqa: F401 — fixtures
    _auth,
    _close,
    _lock,
    _make_profile,
    _make_user,
    _sep25,
    client,
    db_session,
    mailbox,
    pdf_text,
    unsub_db,
)

DEMO_BANNER = ("EKSEMPELDATA (DEMO) — ikke et bilag. Tallene er lavet af BonBox' demo "
               "og må ikke bogføres.")


def _flat(txt: str) -> str:
    return " ".join((txt or "").replace("\xa0", " ").split())


def _pages(pdf: bytes):
    from pypdf import PdfReader
    return PdfReader(io.BytesIO(pdf))


def _demo_profile(db, user, *, accountant_email="anna@revisor.dk"):
    """As the demo seeder left it: tagged " · demo", the sample revisor."""
    p = BusinessProfile(
        user_id=user.id, company_name="Mirabelle ApS", org_number="39842851",
        country="DK", email="info@mirabelle.dk", accountant_email=accountant_email,
        accountant_name="Anna Hansen", accountant_auto_send=None,
        cvr_verified_source="cvrapi.dk · demo", cvr_verified_at=datetime(2026, 9, 1),
    )
    db.add(p); db.commit(); db.refresh(p)
    return p


# ─── 1. A demo day's kasserapport says it is an example ──────────────────


def test_a_demo_close_kasserapport_is_marked_example_and_claims_no_voucher(db_session):
    from app.services.close_kasserapport_pdf import build_close_kasserapport_pdf
    user = _make_user(db_session)
    prof = _make_profile(db_session, user, address="Vestergade 1", zipcode="1456",
                         city="København K")
    dc = _sep25(db_session, user, notes="sample · demo")
    out = build_close_kasserapport_pdf(db_session, user, dc, profile=prof)
    reader = _pages(out["pdf"])
    txt = _flat(pdf_text(out["pdf"]))

    assert "KASSERAPPORT — EKSEMPEL" in txt
    assert DEMO_BANNER in txt
    assert "Eksempel — ikke til bogføring" in txt
    # No readiness verdict over figures nobody took.
    assert "KLAR TIL BOGFØRING" not in txt and "GENNEMGÅS" not in txt
    # Not a voucher: no bilag number anywhere, no retention duty.
    assert "Bilagsnr." not in txt and "KR-20260925" not in txt
    assert "Opbevares i 5 år" not in txt and "bogføringsloven" not in txt
    assert out["bilagsnummer"] == ""
    # The seeder's English marker is not the owner's note.
    assert "sample" not in txt.lower() and "· demo" not in txt
    assert "BEMÆRKNINGER" not in txt
    # The figures are still the day's, and the document still identifies itself.
    assert "28.469,00 kr." in txt and f"Dokument-id: {out['doc_id']}" in txt
    assert "Side 1 af 1" in txt and len(reader.pages) == 1
    # Its name and its document properties say EKSEMPEL too.
    assert out["filename"] == "EKSEMPEL Kasserapport Mirabelle ApS 2026-09-25.pdf"
    assert reader.metadata.title == "KASSERAPPORT — EKSEMPEL"


def test_a_demo_close_keeps_the_owners_own_words_without_the_marker(db_session):
    from app.services.close_kasserapport_pdf import build_close_kasserapport_pdf
    user = _make_user(db_session)
    prof = _make_profile(db_session, user)
    dc = _sep25(db_session, user, notes="Travl fredag · demo")
    txt = _flat(pdf_text(build_close_kasserapport_pdf(db_session, user, dc, profile=prof)["pdf"]))
    assert "BEMÆRKNINGER Travl fredag" in txt
    assert "· demo" not in txt


def test_a_real_close_kasserapport_is_unchanged(db_session):
    from app.services.close_kasserapport_pdf import build_close_kasserapport_pdf
    user = _make_user(db_session)
    prof = _make_profile(db_session, user)
    dc = _sep25(db_session, user)
    out = build_close_kasserapport_pdf(db_session, user, dc, profile=prof)
    txt = _flat(pdf_text(out["pdf"]))
    assert "EKSEMPEL" not in txt and "Eksempel" not in txt and "DEMO" not in txt
    assert "KLAR TIL BOGFØRING" in txt
    assert "Bilagsnr. KR-20260925-20260925" in txt
    assert out["bilagsnummer"] == "KR-20260925-20260925"
    assert "Opbevares i 5 år efter bogføringsloven." in txt
    assert "BEMÆRKNINGER Travl fredag. Kortterminal 2 genstartet kl. 20." in txt
    assert out["filename"] == "Kasserapport Mirabelle ApS 2026-09-25.pdf"
    assert _pages(out["pdf"]).metadata.title == "KASSERAPPORT"


def test_the_pdf_route_serves_a_demo_day_under_an_eksempel_name(db_session, client):
    user = _make_user(db_session)
    _make_profile(db_session, user)
    dc = _sep25(db_session, user, notes="sample · demo")
    r = client.get(f"/api/daily-close/{dc.id}/pdf", headers=_auth(user))
    assert r.status_code == 200, r.text
    assert "EKSEMPEL" in r.headers["content-disposition"]
    txt = _flat(pdf_text(r.content))
    assert "KASSERAPPORT — EKSEMPEL" in txt and "KLAR TIL BOGFØRING" not in txt


def test_demo_claims_in_english_and_the_figures_verdict_is_unchanged():
    from app.services.kasserapport_claims import build_close_claims, close_readiness
    dc = _close(date(2026, 9, 25), 1000.0, 200.0, notes="sample · demo")
    c = build_close_claims(dc, currency="EUR")
    assert c["is_demo"] is True
    assert c["title"] == "KASSERAPPORT — SAMPLE"
    assert c["assurance"] is None
    assert c["demo_verdict"] == "Sample — not for bookkeeping"
    assert c["notes"] is None
    assert "Keep for 5 years" not in c["footer"]
    # A draft demo day is still an example first (not "KLADDE").
    d = build_close_claims(_close(date(2026, 9, 26), 1000.0, 200.0, status="draft",
                                  notes="sample · demo"))
    assert d["title"] == "KASSERAPPORT — EKSEMPEL" and d["draft_banner"] == DEMO_BANNER
    # close_readiness is about the figures (the period artifacts never hold a
    # sample close): unchanged.
    assert close_readiness(dc, "DKK") == close_readiness(
        _close(date(2026, 9, 25), 1000.0, 200.0), "DKK")


def test_the_owners_lock_mail_for_a_demo_day_says_example_not_klar():
    from app.routers.daily_close import _build_close_email_html
    dc = _close(date(2026, 9, 25), 1000.0, 200.0, notes="sample · demo")
    _s, html = _build_close_email_html(
        business_name="Mirabelle ApS", dc=dc, currency="DKK", closed_by="Lars",
        has_scan=False, scan_degraded=False, is_danish=True,
        attachment_name="EKSEMPEL Kasserapport Mirabelle ApS 2026-09-25.pdf",
        audience="owner", bilagsnummer="", doc_id="abc")
    plain = _flat(re.sub(r"<[^>]+>", " ", html))
    assert "Eksempel — ikke til bogføring" in plain
    assert "Klar til bogføring" not in plain and "bilagsnr." not in plain
    # The inbox list and the top of the body say so too — not only the last
    # table row: the subject leads with EKSEMPEL (as the file name does) and
    # the kasserapport's demo banner sits right under the intro.
    assert _s == "EKSEMPEL: Kasserapport fre. 25.09.2026 — Mirabelle ApS"
    assert DEMO_BANNER in plain
    assert plain.index("er låst af Lars") < plain.index(DEMO_BANNER) < plain.index("Omsætning")
    _s_en, html_en = _build_close_email_html(
        business_name="Mirabelle ApS", dc=dc, currency="DKK", closed_by="Lars",
        has_scan=False, scan_degraded=False, is_danish=False,
        attachment_name="SAMPLE Kasserapport Mirabelle ApS 2026-09-25.pdf",
        audience="owner", bilagsnummer="", doc_id="abc")
    assert _s_en.startswith("SAMPLE: Kasserapport ")
    assert "SAMPLE DATA (DEMO) — not a voucher." in html_en
    # A real day's subject and body are unchanged.
    real = _close(date(2026, 9, 25), 1000.0, 200.0, notes="rigtig dag")
    s_real, html_real = _build_close_email_html(
        business_name="Mirabelle ApS", dc=real, currency="DKK", closed_by="Lars",
        has_scan=False, scan_degraded=False, is_danish=True,
        attachment_name="Kasserapport Mirabelle ApS 2026-09-25.pdf",
        audience="owner", bilagsnummer="KR-20260925", doc_id="abc")
    assert s_real == "Kasserapport fre. 25.09.2026 — Mirabelle ApS"
    assert "EKSEMPEL" not in html_real and "EKSEMPELDATA" not in html_real


def test_locking_a_demo_day_sends_the_owner_the_eksempel_document(db_session, client, mailbox):
    """End to end: a seeded day locked unchanged keeps its marker, the revisor
    gets nothing, the owner's copy carries the EKSEMPEL kasserapport."""
    import base64
    user = _make_user(db_session)
    _make_profile(db_session, user, accountant_email="pia@realrevisor.dk",
                  accountant_name="Pia Jensen", accountant_auto_send=True)
    seeded = DailyClose(
        id=uuid.uuid4(), user_id=user.id, branch_id=None, date=date(2026, 9, 25),
        revenue_categories="food:12500", revenue_total=12500.0,
        payment_categories="cash:2500|card:10000", payment_total=12500.0,
        moms_total=2500.0, revenue_ex_moms=10000.0, moms_mode="auto",
        cash_expected=2500.0, cash_counted=2525.0, cash_difference=25.0,
        status="draft", notes="sample · demo", closed_by="Lars", is_deleted=False,
    )
    db_session.add(seeded); db_session.commit()
    r = _lock(client, user, notes="sample · demo")
    assert r.status_code == 200, r.text
    ritual = r.json()["close_ritual"]
    assert ritual["accountant_skip_reason"] == "demo_close"
    assert all("pia@realrevisor.dk" not in p["to"] for p in mailbox.sent)
    owner = [p for p in mailbox.sent if p["to"] == ["anders@mirabelle.dk"]]
    assert len(owner) == 1
    att = owner[0]["attachments"][0]
    assert att["filename"].startswith("EKSEMPEL Kasserapport")
    raw = att["content"]
    pdf = base64.b64decode(raw) if isinstance(raw, str) else bytes(raw)
    txt = _flat(pdf_text(pdf))
    assert "KASSERAPPORT — EKSEMPEL" in txt and "KLAR TIL BOGFØRING" not in txt
    plain = _flat(re.sub(r"<[^>]+>", " ", owner[0]["html"]))
    assert "Eksempel — ikke til bogføring" in plain and "bilagsnr." not in plain
    assert owner[0]["subject"].startswith("EKSEMPEL: Kasserapport ")
    assert DEMO_BANNER in plain


# ─── 2. The sample revisor's name never greets the real one ──────────────


def _put(client, user, **payload):
    return client.put("/api/business", json={"company_name": "Mirabelle ApS", **payload},
                      headers=_auth(user))


def test_replacing_the_seeded_address_clears_the_seeded_name(db_session, client):
    user = _make_user(db_session)
    _demo_profile(db_session, user)
    # What the Profile form sends: the name field echoed back unchanged.
    r = _put(client, user, accountant_email="pia@realrevisor.dk",
             accountant_name="Anna Hansen", accountant_auto_send=True)
    assert r.status_code == 200, r.text
    assert r.json()["accountant_name"] is None
    assert r.json()["accountant_email"] == "pia@realrevisor.dk"


def test_a_raw_put_with_only_the_address_clears_the_seeded_name(db_session, client):
    user = _make_user(db_session)
    _demo_profile(db_session, user, accountant_email="revisor@mirabelle.example")
    r = _put(client, user, accountant_email="pia@realrevisor.dk")
    assert r.status_code == 200, r.text
    assert r.json()["accountant_name"] is None


def test_the_next_mail_to_the_real_revisor_greets_hej(db_session, client, mailbox):
    user = _make_user(db_session)
    _demo_profile(db_session, user)
    assert _put(client, user, accountant_email="pia@realrevisor.dk",
                accountant_name="Anna Hansen", accountant_auto_send=True).status_code == 200
    r = _lock(client, user)  # a REAL day
    assert r.status_code == 200, r.text
    to_pia = [p for p in mailbox.sent if p["to"] == ["pia@realrevisor.dk"]]
    assert len(to_pia) == 1
    assert "<p>Hej,</p>" in to_pia[0]["html"]
    assert "Anna Hansen" not in to_pia[0]["html"] and "Anna Hansen" not in to_pia[0]["text"]
    # The period mail greets the same way with no name saved.
    from app.routers.daily_close import _accountant_email_body
    from app.services.daily_close_range_export import period_totals
    html = _accountant_email_body(
        business_name="Mirabelle ApS", from_date=date(2026, 9, 1), to_date=date(2026, 9, 30),
        totals=period_totals([_close(date(2026, 9, 24), 1000.0, 200.0)]), currency="DKK",
        fmt="pdf", message=None, is_danish=True, attachment_name="x.pdf", accountant_name=None)
    assert "<p>Hej,</p>" in html


@pytest.mark.parametrize("start, payload, expect", [
    # A real revisor changes firm: the name the owner typed stays.
    (dict(accountant_email="pia@realrevisor.dk", accountant_name="Pia Jensen"),
     dict(accountant_email="pia@nytfirma.dk"), "Pia Jensen"),
    # A REAL Anna Hansen at a real address (not the seeded pair): kept.
    (dict(accountant_email="anna@hansenrevision.dk", accountant_name="Anna Hansen"),
     dict(accountant_email="anna@nyrevision.dk"), "Anna Hansen"),
    # Same address saved again (only auto-send changes): name untouched.
    (dict(accountant_email="pia@realrevisor.dk", accountant_name="Pia Jensen"),
     dict(accountant_email="pia@realrevisor.dk", accountant_auto_send=True), "Pia Jensen"),
])
def test_a_real_revisors_name_is_never_cleared(db_session, client, start, payload, expect):
    user = _make_user(db_session)
    _make_profile(db_session, user, **start)
    r = _put(client, user, **payload)
    assert r.status_code == 200, r.text
    assert r.json()["accountant_name"] == expect


def test_on_a_demo_profile_a_typed_name_and_a_sample_address_keep_their_name(db_session, client):
    user = _make_user(db_session)
    _demo_profile(db_session, user)
    # The owner typed their revisor's own name with the new address: kept.
    r = _put(client, user, accountant_email="pia@realrevisor.dk", accountant_name="Pia Jensen")
    assert r.json()["accountant_name"] == "Pia Jensen"
    user2 = _make_user(db_session, email="b@cafe.dk")
    _demo_profile(db_session, user2)
    # Moving to the OTHER sample address is still the sample revisor: kept.
    r2 = _put(client, user2, accountant_email="revisor@mirabelle.example")
    assert r2.json()["accountant_name"] == "Anna Hansen"


# A name-first save must not un-fence the old seed address. On a profile
# without the " · demo" tag (the shared demo account, or a tag lost before
# r4) anna@revisor.dk is fenced only while "Anna Hansen" sits beside it; the
# demo notice asks the owner to type their own revisor's NAME and mail.


def _assert_still_fenced(db_session, client, user, mailbox):
    from fastapi import HTTPException
    from app.services.revisor_mail import resolve_revisor_recipient
    prof = client.get("/api/business", headers=_auth(user)).json()
    assert prof["accountant_is_demo"] is True
    assert prof["accountant_auto_send_effective"] is False
    assert prof["accountant_email"] != "anna@revisor.dk"
    p = db_session.query(BusinessProfile).filter_by(user_id=user.id).first()
    db_session.refresh(p)
    with pytest.raises(HTTPException) as exc:
        resolve_revisor_recipient(p)
    assert exc.value.status_code == 409 and exc.value.detail["code"] == "demo_recipient"
    # A real lock, then an explicit resend: nothing to the sample address.
    r = _lock(client, user)
    assert r.status_code == 200, r.text
    assert r.json()["close_ritual"]["accountant_skip_reason"] == "demo_recipient"
    rr = client.post(f"/api/daily-close/{r.json()['id']}/resend-email",
                     json={"key": f"rename-{user.id}", "force": True}, headers=_auth(user))
    assert rr.status_code == 200, rr.text
    assert rr.json()["close_ritual"]["accountant_skip_reason"] == "demo_recipient"
    assert all("anna@revisor.dk" not in m["to"] for m in mailbox.sent)
    assert all("revisor@mirabelle.example" not in m["to"] for m in mailbox.sent)


def test_renaming_the_untagged_sample_revisor_keeps_its_address_fenced(db_session, client, mailbox):
    from tests.test_revisor_r4_review import _shared_demo_profile
    user = _make_user(db_session)
    _shared_demo_profile(db_session, user)
    # The exact payload ProfilePage.saveAccountant sends: the sample address
    # echoed back, the owner's own revisor's name typed first.
    r = _put(client, user, accountant_email="anna@revisor.dk", accountant_name="Pia Jensen",
             accountant_auto_send=False)
    assert r.status_code == 200, r.text
    assert r.json()["accountant_name"] == "Pia Jensen"
    assert r.json()["accountant_email"] == "revisor@mirabelle.example"
    _assert_still_fenced(db_session, client, user, mailbox)
    # Then the owner types the real address: their typed name stays, and the
    # real revisor is mailed from now on.
    r2 = _put(client, user, accountant_email="pia@realrevisor.dk", accountant_name="Pia Jensen",
              accountant_auto_send=True)
    assert r2.status_code == 200, r2.text
    assert r2.json()["accountant_name"] == "Pia Jensen"
    assert r2.json()["accountant_is_demo"] is False


def test_a_raw_name_only_put_leaves_the_sample_address_fenced(db_session, client, mailbox):
    """No accountant_email in the body, auto-send left NULL (on): the next
    real lock used to mail anna@revisor.dk."""
    from tests.test_revisor_r4_review import _shared_demo_profile
    user = _make_user(db_session)
    _shared_demo_profile(db_session, user)
    r = _put(client, user, accountant_name="Pia Jensen")
    assert r.status_code == 200, r.text
    assert r.json()["accountant_auto_send"] is None
    _assert_still_fenced(db_session, client, user, mailbox)


def test_a_tagged_profile_rename_and_a_real_anna_are_left_as_they_are(db_session, client):
    # Tagged: the tag already fences the address — nothing is rewritten.
    user = _make_user(db_session)
    _demo_profile(db_session, user)
    r = _put(client, user, accountant_email="anna@revisor.dk", accountant_name="Pia Jensen")
    assert r.status_code == 200, r.text
    assert r.json()["accountant_email"] == "anna@revisor.dk"
    assert r.json()["accountant_is_demo"] is True
    # A real revisor called Anna at anna@revisor.dk (never the seeded pair):
    # renaming them touches nothing.
    user2 = _make_user(db_session, email="b@cafe.dk")
    _make_profile(db_session, user2, accountant_email="anna@revisor.dk", accountant_name="Anna")
    r2 = _put(client, user2, accountant_email="anna@revisor.dk", accountant_name="Anna Berg")
    assert r2.json()["accountant_email"] == "anna@revisor.dk"
    assert r2.json()["accountant_is_demo"] is False


# ─── 3. Period PDF polish ─────────────────────────────────────────────


def _profile_obj():
    return BusinessProfile(company_name="Mirabelle ApS", org_number="39842851",
                           address="Vestergade 1", zipcode="1456", city="København K",
                           country="DK")


def _september(n_locked, *, draft=True, variant=0):
    cs = []
    for i in range(n_locked):
        d = date(2026, 9, 1 + i)
        if variant == 0:
            cs.append(_close(d, 1000.0 + i, round((1000.0 + i) / 5, 2)))
        elif variant == 1:
            cs.append(_close(d, 2500.0, 500.0,
                             pay={"cash": 500.0, "card": 1500.0, "gift_card": 500.0},
                             cash_difference=(-180.0 if i == 1 else 0.0)))
        else:
            cs.append(_close(d, 2500.0, 500.0,
                             pay={"cash": 500.0, "card": 1500.0, "mobilepay": 300.0, "wolt": 200.0},
                             cats={"food": 1500.0, "drinks": 1000.0},
                             cash_difference=25.0 * i))
    if draft:
        cs.append(_close(date(2026, 9, 26), 30053.0, 6010.6, status="draft"))
    return cs


def _range_pdf(closes):
    from app.services.daily_close_range_export import build_daily_close_range_pdf
    return build_daily_close_range_pdf(
        closes, from_date=date(2026, 9, 1), to_date=date(2026, 9, 30),
        business_name="Mirabelle ApS", profile=_profile_obj(),
        bilagsnummer="KRP-20260901-20260930")


@pytest.mark.parametrize("variant", [0, 1, 2])
def test_a_short_period_pdf_is_one_page_with_its_footer(variant):
    # 3 locked days + 1 kladde — the rating's short September. Variant 2 put
    # only the footer sentence on a page 2 before.
    pdf = _range_pdf(_september(3, variant=variant))
    reader = _pages(pdf)
    assert len(reader.pages) == 1
    txt = _flat(reader.pages[0].extract_text())
    assert "Optalt af:" in txt and "Godkendt af:" in txt
    assert "Opbevares i 5 år efter bogføringsloven." in txt
    assert "Side 1 af 1" in txt


def test_no_period_pdf_page_holds_only_the_footer():
    """Every size from 1 to 14 days, with and without a kladde: the last page
    always carries the signature line, and every page carries the statutory
    line (in the page footer)."""
    for variant in (0, 1, 2):
        for draft in (False, True):
            for n in range(1, 15):
                reader = _pages(_range_pdf(_september(n, draft=draft, variant=variant)))
                pages = [_flat(p.extract_text()) for p in reader.pages]
                assert "Optalt af:" in pages[-1], (variant, draft, n, len(pages))
                for i, t in enumerate(pages):
                    assert "Opbevares i 5 år efter bogføringsloven." in t, (variant, draft, n, i)
                    # More than the running header + footer on every page.
                    body = t.replace("Opbevares i 5 år efter bogføringsloven.", "")
                    assert ("Optalt af:" in body or "kr." in body), (variant, draft, n, i)


def test_period_pdf_header_never_breaks_inside_the_parenthesis_and_title_is_plural():
    pdf = _range_pdf(_september(3))
    raw = _pages(pdf).pages[0].extract_text().replace("\xa0", " ")
    # "Salgsmoms" over "(25 %)" — the parenthesis is one piece.
    assert "(25 %)" in raw
    assert not re.search(r"\(25\s*\n", raw), raw
    assert "Salgsmoms (25" not in raw.replace("\n", " ").replace("Salgsmoms (25 %)", "")
    txt = _flat(raw)
    assert "Kasserapporter 1. sep 2026" in txt
    assert _pages(pdf).metadata.title == "Kasserapporter — Mirabelle ApS"


def test_period_pdf_header_helper_keeps_label_text():
    from app.services.daily_close_range_export import _two_line_head
    assert _two_line_head("Salgsmoms (25 %)") == "Salgsmoms<br/>(25&nbsp;%)"
    assert _two_line_head("Output VAT (25 %)") == "Output VAT<br/>(25&nbsp;%)"
    assert _two_line_head("Salgsmoms") == "Salgsmoms"
    assert _two_line_head("A & B (x)") == "A &amp; B<br/>(x)"


def test_a_locked_day_that_needs_review_says_so_on_its_row():
    closes = [
        _close(date(2026, 9, 4), 3000.0, 600.0),
        _close(date(2026, 9, 5), 3000.0, 600.0, cash_counted=2820.0, cash_difference=-180.0),
    ]
    txt = _flat(_pages(_range_pdf(closes)).pages[0].extract_text())
    assert txt.count("gennemgås") >= 1
    m = re.search(r"5\. sep 2026 KR-20260905-20260905.*?Låst( gennemgås)?", txt)
    assert m and m.group(1), txt
    m4 = re.search(r"4\. sep 2026 KR-20260904-20260904.*?Låst( gennemgås)?", txt)
    assert m4 and not m4.group(1), txt


# ─── 4. Mail polish that reaches the revisor ─────────────────────────────


def test_mail_tables_carry_an_explicit_font_size():
    from app.routers.daily_close import _accountant_email_body, _build_close_email_html
    from app.services.daily_close_range_export import period_totals
    dc = _close(date(2026, 9, 25), 1000.0, 200.0)
    _s, html = _build_close_email_html(
        business_name="Mirabelle ApS", dc=dc, currency="DKK", closed_by="Lars",
        has_scan=False, scan_degraded=False, is_danish=True, attachment_name="x.pdf",
        audience="revisor", accountant_name="Pia")
    assert "border-collapse:collapse;margin:16px 0;font-size:14px;" in html
    body = _accountant_email_body(
        business_name="Mirabelle ApS", from_date=date(2026, 9, 1), to_date=date(2026, 9, 30),
        totals=period_totals([dc]), currency="DKK", fmt="pdf", message=None,
        is_danish=True, attachment_name="Kasserapporter.pdf",
        bilagsnummer="KRP-20260901-20260930")
    assert "border-collapse:collapse;margin:16px 0;font-size:14px;" in body
    # The period voucher number the attachment carries is named.
    assert "Vedhæftet fil: Kasserapporter.pdf (bilagsnr. KRP-20260901-20260930)" in body


def test_correction_table_signs_the_cash_difference_and_text_part_breaks_the_label():
    from app.routers.daily_close import _changes_table, _figure_changes
    from app.services.email_service import html_to_text
    dc = _close(date(2026, 9, 25), 1000.0, 200.0, cash_difference=-10.0)
    changes, _known = _figure_changes({"cash_difference": 25.0, "revenue_total": 1000.0}, dc, "DKK")
    assert ("Kassedifference", "+25,00 kr.", "-10,00 kr.") in changes
    text = html_to_text("<div>" + _changes_table(changes, True) + "</div>")
    assert "Ændret:Linje" not in text
    assert re.search(r"Ændret:\s*\n", text), text


def test_opt_out_pages_name_every_mail_they_stop():
    from app.routers.email_unsubscribe import (
        _revisor_confirm_page, _revisor_resubscribed_page, _revisor_success_page,
    )
    confirm = _revisor_confirm_page("tok", "Mirabelle ApS")
    assert "<title>Afmeld mails fra BonBox" in confirm or "Afmeld mails fra BonBox" in confirm
    assert "Afmeld kasserapporter" not in confirm
    assert "kasserapporter, momsangivelser" in confirm and "lønlister" in confirm
    assert "kasserapporter, momsangivelser og" in _flat(_revisor_resubscribed_page("Mirabelle ApS"))
    assert "kasserapporterne igen" not in _revisor_success_page("Mirabelle ApS", "tok")
