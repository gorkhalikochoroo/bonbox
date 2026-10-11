"""The BonBox mark for HTML e-mail: the logo kit's b (docs/brand, 11 Oct 2026).

One filled path on the kit's 24 x 24 grid (docs/brand/symbol/bonbox-symbol.svg,
the same path as frontend/src/components/BonBoxMark.jsx), drawn at 28 px in
paper on the forest tile the template draws around it. The kit's rule for the
main app: forest tile, paper b. Never a circle, never an emerald b.

Every owner mail that shows the logo puts BRAND_MARK_SVG inside a box with
background BRAND_FOREST. tests/test_mail_brand_mark.py pins the path to the
kit file and keeps the retired notepad glyph out of backend/app.
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
