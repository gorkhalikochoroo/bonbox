"""The BonBox mark for HTML e-mail: the logo kit's b (docs/brand, 11 Oct 2026).

One filled path on the kit's 24 x 24 grid (docs/brand/symbol/bonbox-symbol.svg,
the same path as frontend/src/components/BonBoxMark.jsx), drawn at 28 px in
paper on the forest tile the template draws around it. The kit's rule for the
main app: forest tile, paper b. Never a circle, never an emerald b.

Two ways to show it, by where it renders:

* E-MAIL — BRAND_MARK_IMG / VAGTPLAN_MARK_IMG: a hosted <img> of the kit's
  180 px apple-touch-icon (forest tile + paper b; Vagtplan: paper tile +
  forest b). Gmail and Outlook strip inline <svg> from a mail, so an SVG mark
  left the forest tile EMPTY in the two clients most owners read. An <img>
  with width/height/alt survives every client, and with images blocked the
  alt text "BonBox" stands in. The files are the frontend's own public/
  icons, served by www.bonbox.dk with the same ?v=3 the app links.
* HTML PAGES the API serves itself (the e-mail opt-out page, the ticket page)
  — brand_tile_svg(): the tile and the b as ONE inline <svg> drawn with
  presentation attributes only (no style=), so it renders under a strict
  CSP that allows no images and no inline styles.

BRAND_MARK_SVG (the bare b, paper fill) stays for a template that draws its
own forest box around it. tests/test_mail_brand_mark.py pins the path to the
kit file, renders every mail and keeps the retired notepad out of backend/app.
"""

BRAND_FOREST = "#093A26"
BRAND_PAPER = "#F6F4EC"

BRAND_MARK_PATH = (
    "M5 2.5V13A7.5 7.5 0 0 0 12.5 20.5A7.5 7.5 0 0 0 20 13A5.5 5.5 0 0 0 "
    "14.5 7.5A5.5 5.5 0 0 0 9 13A3.5 3.5 0 0 0 12.5 16.5V14A1 1 0 0 1 11.5 13"
    "A3 3 0 0 1 14.5 10A3 3 0 0 1 17.5 13A5 5 0 0 1 12.5 18A5 5 0 0 1 7.5 13"
    "V2.5Z"
)

# 28 px, the size of the box the old notepad filled, so no template moves.
BRAND_MARK_SVG = (
    '<svg width="28" height="28" viewBox="0 0 24 24" '
    'xmlns="http://www.w3.org/2000/svg">'
    f'<path fill="{BRAND_PAPER}" d="{BRAND_MARK_PATH}"/></svg>'
)


# ── E-mail: the hosted icon ─────────────────────────────────────────────
# The frontend host, not FRONTEND_URL: the mail must show the shipped icon
# even when it was sent from staging or a laptop.
BRAND_SITE = "https://www.bonbox.dk"
BRAND_MARK_SRC = f"{BRAND_SITE}/apple-touch-icon.png?v=3"
VAGTPLAN_MARK_SRC = f"{BRAND_SITE}/vagtplan-apple-touch-icon.png?v=3"
# 52 px: the height of the old 12 + 28 + 12 px tile, so no header moves.
MAIL_MARK_SIZE = 52


def mail_mark_img(src: str = BRAND_MARK_SRC, size: int = MAIL_MARK_SIZE, *,
                  alt: str = "BonBox", centered: bool = True) -> str:
    """The kit's app icon as a mail-safe <img>.

    width/height as attributes AND in style (Outlook reads the attributes,
    Gmail the style); display:block drops the inline-image gap under it;
    margin:0 auto centres it in the clients that honour a block image, and
    the header's text-align:center centres it in the ones that do not. The
    radius is the iOS corner (~23 %); a client that ignores border-radius
    shows the square icon, which is the kit's own app-icon shape. alt="" when
    the word BonBox already sits next to it.
    """
    radius = round(size * 0.23)
    margin = "margin:0 auto;" if centered else ""
    return (
        f'<img src="{src}" width="{size}" height="{size}" alt="{alt}" '
        f'style="display:block;{margin}border:0;outline:none;text-decoration:none;'
        f'width:{size}px;height:{size}px;border-radius:{radius}px">'
    )


# The owner app's mark (forest tile, paper b) — every owner/team/revisor mail.
BRAND_MARK_IMG = mail_mark_img(BRAND_MARK_SRC)
# The staff app's mark (paper tile, forest b) — mails a staff member gets
# about their shifts. The kit names this symbol "BonBox Vagtplan".
VAGTPLAN_MARK_IMG = mail_mark_img(VAGTPLAN_MARK_SRC, alt="BonBox Vagtplan")


# ── HTML pages: the tile as one inline SVG ──────────────────────────────


def brand_tile_svg(size: int = 40, *, title: str = "BonBox") -> str:
    """Forest tile + paper b in one <svg>, the web tile's proportions (b at
    0.8 x the tile, corner 0.2 x — `w-10 rounded-lg` with BonBoxMark 32).

    Presentation attributes only: under default-src 'none' an inline <svg>
    needs no img-src, and fill= is not a style. Pass title="" when the word
    BonBox sits next to it (it is then aria-hidden).
    """
    a11y = (f'role="img" aria-label="{title}"' if title
            else 'aria-hidden="true" focusable="false"')
    return (
        f'<svg width="{size}" height="{size}" viewBox="0 0 30 30" '
        f'xmlns="http://www.w3.org/2000/svg" {a11y}>'
        f'<rect width="30" height="30" rx="6" fill="{BRAND_FOREST}"/>'
        f'<path transform="translate(3 3)" fill="{BRAND_PAPER}" d="{BRAND_MARK_PATH}"/>'
        '</svg>'
    )
