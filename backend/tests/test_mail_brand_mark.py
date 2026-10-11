"""Every mail with a logo carries the kit's mark as a hosted <img> (docs/brand).

Five templates once drew the retired notepad as inline SVG on old tiles; they
moved to the kit's b as inline SVG on a forest box (BRAND_MARK_SVG). But Gmail
and Outlook strip <svg> from a mail, so in the two clients most owners read
the forest tile arrived EMPTY. Every mail now shows BRAND_MARK_IMG — an <img>
of the frontend's own apple-touch-icon (forest tile, paper b) — and the staff
shift mail shows VAGTPLAN_MARK_IMG (paper tile, forest b). The digest, the
expense alert and the shift mail had a typed letter "B" on a green/blue/red
tile; the team and revisor invites had no mark at all.

These tests pin the path to the kit file, pin both images to real 180 px
files in frontend/public, render every template and keep the notepad and
inline SVG out of every mail. send_email is stubbed — nothing is mailed.
"""
import re
import struct
from pathlib import Path

import pytest

from app.services.brand_mark import (
    BRAND_FOREST, BRAND_MARK_IMG, BRAND_MARK_PATH, BRAND_MARK_SRC,
    BRAND_MARK_SVG, BRAND_PAPER, VAGTPLAN_MARK_IMG, VAGTPLAN_MARK_SRC,
    brand_tile_svg, mail_mark_img,
)
from tests.test_password_reset_revocation import (  # noqa: F401 — fixtures
    _make_user, client, db_session,
)

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
PUBLIC = REPO / "frontend" / "public"
NOTEPAD = ("M9 8h10M9 12h10M9 16h6", "M8 8h8M8 12h8M8 16h5")
OLD_LETTER_TILE = re.compile(r'font-weight:bold">B</span>')


def _assert_kit_mark(html: str, mark: str = BRAND_MARK_IMG) -> None:
    assert html.count(mark) == 1, html[:600]
    # Mail clients strip inline SVG: no mail may depend on one.
    assert "<svg" not in html
    assert not OLD_LETTER_TILE.search(html)
    for glyph in NOTEPAD:
        assert glyph not in html


def _png_size(path: Path) -> tuple[int, int]:
    head = path.read_bytes()[:24]
    assert head[:8] == b"\x89PNG\r\n\x1a\n", path
    return struct.unpack(">II", head[16:24])


def test_the_mark_is_the_kit_symbol_in_paper():
    kit = (REPO / "docs/brand/symbol/bonbox-symbol.svg").read_text()
    assert re.search(r'<path d="([^"]+)"', kit).group(1) == BRAND_MARK_PATH
    jsx = (REPO / "frontend/src/components/BonBoxMark.jsx").read_text()
    assert f'"{BRAND_MARK_PATH}"' in jsx
    assert (BRAND_FOREST, BRAND_PAPER) == ("#093A26", "#F6F4EC")
    assert f'fill="{BRAND_PAPER}"' in BRAND_MARK_SVG
    assert 'width="28" height="28" viewBox="0 0 24 24"' in BRAND_MARK_SVG
    assert BRAND_MARK_SVG.count("<path") == 1


@pytest.mark.parametrize("src, alt, png", [
    (BRAND_MARK_SRC, "BonBox", "apple-touch-icon.png"),
    (VAGTPLAN_MARK_SRC, "BonBox Vagtplan", "vagtplan-apple-touch-icon.png"),
])
def test_the_mail_images_are_the_shipped_kit_icons(src, alt, png):
    # The URL is the production frontend + a file the frontend ships, with the
    # same cache key index.html links (so a re-cut icon busts both at once).
    assert src == f"https://www.bonbox.dk/{png}?v=3"
    assert _png_size(PUBLIC / png) == (180, 180)
    index = (REPO / "frontend/index.html").read_text()
    assert f"/{png}?v=3" in index
    img = mail_mark_img(src, alt=alt)
    assert f'src="{src}"' in img and f'alt="{alt}"' in img
    assert 'width="52" height="52"' in img and "display:block" in img


def test_the_owner_and_staff_marks_differ_only_by_file_and_name():
    assert 'src="https://www.bonbox.dk/apple-touch-icon.png?v=3"' in BRAND_MARK_IMG
    assert 'alt="BonBox"' in BRAND_MARK_IMG
    assert 'src="https://www.bonbox.dk/vagtplan-apple-touch-icon.png?v=3"' in VAGTPLAN_MARK_IMG
    assert 'alt="BonBox Vagtplan"' in VAGTPLAN_MARK_IMG


def test_the_page_tile_is_csp_safe_inline_svg():
    svg = brand_tile_svg(40)
    assert svg.startswith('<svg width="40" height="40" viewBox="0 0 30 30"')
    assert f'fill="{BRAND_FOREST}"' in svg and f'fill="{BRAND_PAPER}"' in svg
    assert f'd="{BRAND_MARK_PATH}"' in svg
    # No style= (a strict CSP blocks inline styles) and nothing fetched.
    assert "style=" not in svg and "href" not in svg
    assert 'role="img" aria-label="BonBox"' in svg
    assert 'aria-hidden="true"' in brand_tile_svg(40, title="")


@pytest.mark.parametrize("lang", ["en", "da"])
def test_verification_and_welcome_mails(lang):
    from app.services.signup_mail import verification_mail, welcome_mail
    v = verification_mail("123456", lang)[1]
    _assert_kit_mark(v)
    _assert_kit_mark(welcome_mail("Mette", lang)[1])
    # The footer names BonBox in ONE colour (it was "Bon" grey + "Box" green).
    assert ">Bon</span>" not in v and '<span style="color:#94a3b8">BonBox</span>' in v


@pytest.mark.parametrize("is_danish", [False, True])
def test_magic_link_mail(is_danish):
    from app.routers.auth_magic_link import _magic_link_email_html
    html = _magic_link_email_html("https://bonbox.dk/m/x", is_danish)
    _assert_kit_mark(html)
    assert ">Bon</span>" not in html and '<span style="color:#64748b">BonBox</span>' in html


def test_admin_new_signup_mail():
    from app.routers.auth import _admin_signup_email_html
    _assert_kit_mark(_admin_signup_email_html("a@b.dk", "Café", "cafe"))


def test_password_reset_mail(db_session, client, monkeypatch):
    sent = []
    monkeypatch.setattr(
        "app.routers.auth.send_email",
        lambda to, subject, html, *a, **kw: sent.append(html) or True,
    )
    from app.routers.auth import limiter
    limiter.reset()
    _make_user(db_session)
    r = client.post("/api/auth/forgot-password", json={"email": "owner@example.com"})
    assert r.status_code == 200, r.text
    assert len(sent) == 1
    _assert_kit_mark(sent[0])


def test_daily_brief_header_is_the_mark_and_the_forest_word():
    from app.models.user import User
    from app.services import daily_brief_email as dbe
    u = User(email="t@example.com", password_hash="x", business_name="Café",
             business_type="restaurant", currency="DKK")
    html = dbe.build_brief_html(
        {"greeting": "Good morning", "date_label": "Tuesday · 19 May",
         "headline": "A quiet Monday.", "insights": []}, u)
    small = mail_mark_img(BRAND_MARK_SRC, 28, alt="", centered=False)
    _assert_kit_mark(html, small)
    assert f'color:{BRAND_FOREST};letter-spacing:-0.01em;">BonBox</td>' in html
    # The old header: the word alone, uppercase, in emerald.
    assert 'text-transform:uppercase;">BonBox</td>' not in html


@pytest.mark.parametrize("lang", ["en", "da"])
def test_shift_mail_wears_the_vagtplan_mark(lang):
    from datetime import date
    from app.services.notification_service import ShiftChange, build_shift_email_html
    html = build_shift_email_html(
        staff_name="Mette Hansen",
        changes=[ShiftChange(date=date(2026, 9, 25), change_type="removed",
                             old_start="17:00", old_end="23:00", new_start=None, new_end=None)],
        portal_url="https://bonbox.dk/s/tok", restaurant_name="Café Manoj",
        week_label="Uge 39", lang=lang,
    )
    _assert_kit_mark(html, VAGTPLAN_MARK_IMG)
    assert BRAND_MARK_IMG not in html


def test_digest_mail():
    from app.services.digest_service import build_digest_html
    _assert_kit_mark(build_digest_html({
        "date": "Monday, 05 October 2026", "currency": "DKK",
        "revenue": 1000.0, "expenses": 400.0, "profit": 600.0, "margin": 60.0,
        "wow_change": 5.0, "mtd_revenue": 9000.0, "top_expenses": [],
        "low_stock": [], "business_name": "Café",
    }))


def test_expense_alert_mail_keeps_its_warning_in_the_heading():
    from app.services.alert_service import build_alert_html
    html = build_alert_html([{"type": "large_transaction", "message": "Large expense"}], "Café")
    _assert_kit_mark(html)
    assert ">⚠️ Expense Alert - Café</h1>" in html
    assert "background:#dc2626;border-radius:14px" not in html


@pytest.mark.parametrize("is_danish", [False, True])
def test_team_invite_mail(is_danish):
    from app.routers.team import _invite_email_html
    html = _invite_email_html("Café", "manager", "https://bonbox.dk/accept-invite/team/x", is_danish)
    _assert_kit_mark(html)
    assert f'<div style="text-align:center;margin-bottom:20px">{BRAND_MARK_IMG}</div>' in html


@pytest.mark.parametrize("is_danish", [False, True])
def test_revisor_invite_mail(is_danish):
    from app.routers.accountants import _invite_email_html
    html = _invite_email_html("Café", "https://bonbox.dk/accept-invite/x", is_danish)
    _assert_kit_mark(html)
    assert f'<div style="text-align:center;margin-bottom:20px">{BRAND_MARK_IMG}</div>' in html


def test_no_file_in_backend_app_draws_the_notepad():
    offenders = [
        str(p.relative_to(BACKEND))
        for p in (BACKEND / "app").rglob("*.py")
        if any(g in p.read_text(encoding="utf-8") for g in NOTEPAD)
    ]
    assert offenders == []


def test_no_mail_template_types_a_letter_b_as_the_logo():
    offenders = [
        str(p.relative_to(BACKEND))
        for p in (BACKEND / "app").rglob("*.py")
        if OLD_LETTER_TILE.search(p.read_text(encoding="utf-8"))
    ]
    assert offenders == []
