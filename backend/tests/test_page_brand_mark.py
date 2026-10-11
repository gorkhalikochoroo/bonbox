"""The HTML pages the API serves itself wear the kit's logo (docs/brand).

The e-mail opt-out page said "BONBOX" in uppercase emerald with an SVG favicon
link, and the ticket pages said <h1>BonBox</h1> with no favicon at all. Each
now draws the kit's forest tile as ONE inline <svg> (brand_tile_svg — fill=
attributes only, nothing fetched) and links the frontend's favicon.ico?v=3.

The API's CSP is default-src 'none'. An inline <svg> needs no source, so the
tile renders under it; a favicon loads under img-src, so the opt-out page
(PAGE_CSP) and the /t/ and /e/ HTML routes allow images from www.bonbox.dk —
and only those routes, and only images.
"""
import uuid

from app.services.brand_mark import BRAND_FOREST, brand_tile_svg
from tests.test_password_reset_revocation import (  # noqa: F401 — fixtures
    client, db_session,
)

FAVICON = '<link rel="icon" href="https://www.bonbox.dk/favicon.ico?v=3" sizes="16x16 32x32"'
IMG_CSP = "default-src 'none'; img-src https://www.bonbox.dk; frame-ancestors 'none'"


def test_opt_out_page_has_the_tile_the_forest_word_and_the_ico(client):
    r = client.get("/api/email/unsubscribe?token=not-a-token")
    assert r.status_code == 410
    html = r.text
    assert FAVICON in html
    assert "favicon.svg" not in html
    assert f'<div class="brand">{brand_tile_svg(32, title="")}<span>BonBox</span></div>' in html
    assert f"color:{BRAND_FOREST}" in html
    assert "text-transform:uppercase" not in html
    # The page's own CSP still allows images from the frontend only, and the
    # tile adds no style="" for the hash-only policy to block.
    csp = r.headers["content-security-policy"]
    assert "img-src https://www.bonbox.dk;" in csp and "default-src 'none'" in csp
    assert 'style="' not in html


def test_ticket_error_page_has_the_tile_and_the_ico(db_session, client):
    r = client.get(f"/t/{uuid.uuid4()}")
    assert r.status_code == 404
    assert FAVICON in r.text
    assert f"<h1>{brand_tile_svg(40)}</h1>" in r.text
    assert "<h1>BonBox</h1>" not in r.text
    assert r.headers["content-security-policy"] == IMG_CSP


def test_ticket_page_has_the_tile_above_the_event():
    from app.routers.tickets import _ticket_html
    html = _ticket_html(
        event_name="Jazz", event_venue="Café", starts_at="2026-10-20T19:00",
        tier_label="Standard", tier_price_dkk=150, customer_name="Mette",
        qr_payload="x", scanned_at=None,
    )
    assert FAVICON in html
    assert f'<div class="brand">{brand_tile_svg(40)}</div>\n  <h1>Jazz</h1>' in html


def test_event_share_page_links_the_ico(db_session, client):
    r = client.get("/e/no-such-event")
    assert r.status_code == 410
    assert FAVICON in r.text
    assert r.headers["content-security-policy"] == IMG_CSP


def test_json_routes_keep_the_strict_default(client):
    r = client.get("/api/health")
    assert r.headers["content-security-policy"] == "default-src 'none'; frame-ancestors 'none'"
