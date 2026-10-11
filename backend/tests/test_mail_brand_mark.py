"""The owner mails carry the logo kit's b on the forest tile (docs/brand).

Five templates drew the retired notepad mark as inline SVG on old tiles
(#16a34a green, #0f172a slate, #2563eb blue): the verification and welcome
mails, the magic-link mail, the password reset and the admin new-signup mail.
They now share app.services.brand_mark. These tests pin that mark to the kit
file, render every template, and keep the notepad glyph out of backend/app.

send_email is stubbed — nothing is mailed.
"""
import re
from pathlib import Path

import pytest

from app.services.brand_mark import (
    BRAND_FOREST, BRAND_MARK_PATH, BRAND_MARK_SVG, BRAND_PAPER,
)
from tests.test_password_reset_revocation import (  # noqa: F401 — fixtures
    _make_user, client, db_session,
)

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
NOTEPAD = ("M9 8h10M9 12h10M9 16h6", "M8 8h8M8 12h8M8 16h5")
TILE = re.compile(
    r'background:(#[0-9A-Fa-f]{6})[^"]*">\s*' + re.escape(BRAND_MARK_SVG)
)


def _assert_kit_tile(html: str) -> None:
    assert BRAND_MARK_SVG in html
    tiles = TILE.findall(html)
    assert tiles == [BRAND_FOREST], tiles
    for glyph in NOTEPAD:
        assert glyph not in html


def test_the_mark_is_the_kit_symbol_in_paper():
    kit = (REPO / "docs/brand/symbol/bonbox-symbol.svg").read_text()
    assert re.search(r'<path d="([^"]+)"', kit).group(1) == BRAND_MARK_PATH
    jsx = (REPO / "frontend/src/components/BonBoxMark.jsx").read_text()
    assert f'"{BRAND_MARK_PATH}"' in jsx
    assert (BRAND_FOREST, BRAND_PAPER) == ("#093A26", "#F6F4EC")
    assert f'fill="{BRAND_PAPER}"' in BRAND_MARK_SVG
    assert 'width="28" height="28" viewBox="0 0 24 24"' in BRAND_MARK_SVG
    assert BRAND_MARK_SVG.count("<path") == 1


@pytest.mark.parametrize("lang", ["en", "da"])
def test_verification_and_welcome_mails(lang):
    from app.services.signup_mail import verification_mail, welcome_mail
    _assert_kit_tile(verification_mail("123456", lang)[1])
    _assert_kit_tile(welcome_mail("Mette", lang)[1])


@pytest.mark.parametrize("is_danish", [False, True])
def test_magic_link_mail(is_danish):
    from app.routers.auth_magic_link import _magic_link_email_html
    _assert_kit_tile(_magic_link_email_html("https://bonbox.dk/m/x", is_danish))


def test_admin_new_signup_mail():
    from app.routers.auth import _admin_signup_email_html
    _assert_kit_tile(_admin_signup_email_html("a@b.dk", "Café", "cafe"))


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
    _assert_kit_tile(sent[0])


def test_no_file_in_backend_app_draws_the_notepad():
    offenders = [
        str(p.relative_to(BACKEND))
        for p in (BACKEND / "app").rglob("*.py")
        if any(g in p.read_text(encoding="utf-8") for g in NOTEPAD)
    ]
    assert offenders == []
