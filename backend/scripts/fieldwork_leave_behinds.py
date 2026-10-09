"""Fieldwork leave-behinds — one printable Danish page per door-visit code.

Oct 2026 door rounds (thesis fieldwork): round 1 (8–14 Oct) uses argument A,
round 2 (15–21 Oct) argument B. At each visit Manoj leaves one sheet. Its QR
opens https://www.bonbox.dk/register?ref=<code>; the code ("r1-a-03" = round
1, argument A, visit 3) is kept by the app until the account exists and then
lands on users.signup_ref, where /api/admin/signup-refs counts it.

  cd backend && python -m scripts.fieldwork_leave_behinds \\
      --out ../../founder-private/leave-behinds

writes r1-a-01 … r1-a-10 and r2-b-01 … r2-b-10 as A5 PDFs (prints full-page
on A4 with "fit to page"; --size a4 renders A4 directly). --codes picks other
codes; a code must match the signup-ref rule and name argument a or b.

A SCRIPT, NOT A ROUTE: pure, no database, no network, no personal data. The
output belongs in founder-private/, never in the repo.

To test a QR, stop at the signup page, or use a code outside the rounds (e.g. test-01); an account created through a real round code counts as a door-visit signup — add its id to app/services/internal_accounts.py if it happens.

PRECONDITION — DO NOT HAND OUT A SHEET UNTIL THE CODE-KEEPING BUILD IS LIVE.
Production before it ignores ?ref=, and a visit whose code was dropped is lost
for good (it does not show up later as a 0). Both halves must be deployed:
  • backend: https://api.bonbox.dk/api/health → "commit" is the last commit
    that changed backend/app/services/signup_ref.py, or a later one
    (git log --format=%h -1 -- backend/app/services/signup_ref.py; then
    git merge-base --is-ancestor <that> <health commit> && echo OK);
  • frontend: one of the scripts www.bonbox.dk/register loads contains
    "bonbox_signup_ref" (today it sits in the useAuth-*.js chunk, not index):
      for a in $(curl -s https://www.bonbox.dk/register | grep -o 'assets/[^"]*\.js'); do
        curl -s "https://www.bonbox.dk/$a" | grep -q bonbox_signup_ref && echo "LIVE $a"; done
    No "LIVE" line = not deployed yet.
Counts in /api/admin/signup-refs are a LOWER BOUND even then (same browser,
from the deploy onward) — see the endpoint's notes.

COPY RULES (checked against production 9ec1d6ae before writing a word):
  • The door lines and the closing line are the founder's, verbatim.
  • Every bullet is something production does today, on any plan, or is said
    the way production says it. No competitor, no price, no time ("30
    sekunder" is unmeasured), no number that was not counted.
"""
from __future__ import annotations

import argparse
import io
import os
import re
import sys

from reportlab.graphics import renderPDF
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, A5
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

# Allow `python scripts/fieldwork_leave_behinds.py` as well as `-m`.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.services.signup_ref import clean_signup_ref  # noqa: E402

REGISTER_URL = "https://www.bonbox.dk/register?ref={code}"
COMPANY_LINE = "DukaanAI v/Manoz Chaudhary · CVR 46417321 · bonbox.dk"
CLOSE_LINE = (
    "Det er gratis at prøve i 14 dage uden betalingskort, og der bliver aldrig "
    "trukket penge, medmindre I selv vælger at betale."
)

# Per door argument: the founder's door line (verbatim) + three bullets.
# Evidence for each bullet on origin/main 9ec1d6ae:
#   A1 — the Z-bon scan prefills fields the owner can change; typing is the
#        fallback when a photo can't be read (daily_close.py POST /scan-report).
#   A2 — GET /daily-close/{id}/pdf (one day, no plan gate) and GET
#        /daily-close/export.pdf (several days; every plan, Free spans 7).
#   A3 — BonBox is a web app; nothing to install (an iPhone app also exists).
#   B1 — public booking page per venue (public_reservations.py POST /{slug}).
#   B2 — hours collected per staffer; GET /staff/payroll/csv (no plan gate);
#        BonBox exports hours, it does not run payroll — so "fil", not "løn".
#   B3 — same as argument A (scan-report + kasserapport PDF).
CONTENT = {
    "a": {
        "door": (
            "Når I lukker, tager I et billede af Z-bonen og skriver, hvad der "
            "ligger i kassen. BonBox læser tallene, viser en eventuel "
            "kassedifference og laver kasserapporten som PDF til jeres revisor."
        ),
        "bullets": (
            "Tallene kan altid rettes, og kan billedet ikke læses, skriver I dem selv.",
            "Hent kasserapporten som PDF – for én dag eller flere dage samlet.",
            "Det virker i browseren på mobil og computer. Intet skal installeres.",
        ),
    },
    "b": {
        "door": (
            "Booking, vagtplan, timer og kasserapport i ét system – og "
            "personalet ser vagtplanen og stempler ind på mobilen. "
            "Kassesystemet og bogføringen beholder I."
        ),
        "bullets": (
            "Gæsterne booker bord på jeres egen bookingside.",
            "Timerne samles ét sted og kan hentes som fil til jeres lønsystem.",
            "Et billede af Z-bonen bliver til en kasserapport som PDF til revisoren.",
        ),
    },
}

_CODE_RE = re.compile(r"r\d{1,2}-([a-z])-\d{1,3}")

# Palette — premium via restraint: ink, one muted grey, one calm accent.
INK = colors.HexColor("#14120f")
MUTED = colors.HexColor("#6b665e")
HAIRLINE = colors.HexColor("#e3e0d9")
PANEL = colors.HexColor("#f5f3ee")
ACCENT = colors.HexColor("#166b4f")

# Layout is drawn in A5 points and scaled for A4 (same √2 aspect).
_W, _H = A5
_M = 40.0                       # side margin
_CONTENT_W = _W - 2 * _M
_QR = 104.0                     # QR side incl. quiet zone
_FOOTER_Y = 26.0
_QR_Y = 58.0


def argument_for(code: str) -> str:
    """The door argument ("a"/"b") a code belongs to. Raises on anything else."""
    if clean_signup_ref(code) != code:
        raise ValueError(f"not a valid signup ref: {code!r}")
    m = _CODE_RE.fullmatch(code)
    if not m or m.group(1) not in CONTENT:
        raise ValueError(f"no leave-behind copy for {code!r} (expected r<round>-a|b-<visit>)")
    return m.group(1)


def default_codes() -> list[str]:
    return [f"r1-a-{i:02d}" for i in range(1, 11)] + [f"r2-b-{i:02d}" for i in range(1, 11)]


def _lines(text: str, font: str, size: float, width: float) -> list[str]:
    """Greedy wrap that never leaves a one-letter word ("i", "I", "à") at the
    end of a line — it moves down to the word it belongs to."""
    lines = simpleSplit(text, font, size, width)
    for i in range(len(lines) - 1):
        words = lines[i].split(" ")
        if len(words) > 1 and len(words[-1]) == 1 and words[-1].isalpha():
            candidate = words[-1] + " " + lines[i + 1]
            if stringWidth(candidate, font, size) <= width:
                lines[i] = " ".join(words[:-1])
                lines[i + 1] = candidate
    return lines


def _layout(copy: dict, door_size: float, text_top: float) -> tuple[list, float]:
    """Draw operations for the text block and the y of its lowest edge.

    One function both measures and places, so the fit check and the page can
    never disagree.
    """
    ops: list = []
    door_lead = door_size * 1.38
    y = text_top
    for line in _lines(copy["door"], "Helvetica", door_size, _CONTENT_W):
        ops.append(("text", "Helvetica", door_size, INK, _M, y, line))
        y -= door_lead
    y += door_lead - 34                     # gap below the last door line

    for b in copy["bullets"]:
        ops.append(("dot", _M + 1, y + 2.6))
        for line in _lines(b, "Helvetica", 10.5, _CONTENT_W - 16):
            ops.append(("text", "Helvetica", 10.5, INK, _M + 16, y, line))
            y -= 14.5
        y -= 7
    y += 14.5 + 7                           # back to the last bullet baseline

    close_lines = _lines(CLOSE_LINE, "Helvetica", 10, _CONTENT_W - 24)
    panel_top = y - 20
    panel_h = len(close_lines) * 14 + 18
    ops.append(("panel", _M, panel_top - panel_h, _CONTENT_W, panel_h))
    ty = panel_top - 9 - 10
    for line in close_lines:
        ops.append(("text", "Helvetica", 10, INK, _M + 12, ty, line))
        ty -= 14
    return ops, panel_top - panel_h


def _page_size(size: str):
    return A4 if (size or "").lower() == "a4" else A5


def _new_canvas(buf, size: str, title: str):
    c = canvas.Canvas(buf, pagesize=_page_size(size))
    c.setTitle(title)
    c.setAuthor("DukaanAI v/Manoz Chaudhary")
    c.setSubject("BonBox – prøv gratis i 14 dage")
    c.setCreator("BonBox fieldwork leave-behind")
    return c


def render_leave_behind(code: str, size: str = "a5") -> bytes:
    """One finished page for `code` as PDF bytes."""
    argument_for(code)  # refuse a bad code before opening a canvas
    buf = io.BytesIO()
    c = _new_canvas(buf, size, f"BonBox – {code}")
    _draw_page(c, code, size)
    c.save()
    return buf.getvalue()


def render_print_sheet(codes: list[str], size: str = "a5", title: str = "BonBox") -> bytes:
    """Several codes, one page each, in ONE file — a single print job."""
    for code in codes:
        argument_for(code)
    buf = io.BytesIO()
    c = _new_canvas(buf, size, title)
    for code in codes:
        _draw_page(c, code, size)
    c.save()
    return buf.getvalue()


def _draw_page(c, code: str, size: str) -> None:
    """Draw the page for `code` on `c` and end the page."""
    copy = CONTENT[argument_for(code)]
    url = REGISTER_URL.format(code=code)
    c.saveState()
    scale = _page_size(size)[0] / _W
    c.scale(scale, scale)

    # ── Wordmark + hairline ──
    top = _H - 52
    c.setFillColor(ACCENT)
    c.rect(_M, top - 2, 5, 19, stroke=0, fill=1)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 21)
    c.drawString(_M + 12, top, "BonBox")
    c.setStrokeColor(HAIRLINE)
    c.setLineWidth(0.8)
    c.line(_M, top - 18, _W - _M, top - 18)

    # ── Text block: the largest door-line size that clears the QR block ──
    text_top = top - 56
    text_floor = _QR_Y + _QR + 18
    door_size = 18.0
    ops, bottom = _layout(copy, door_size, text_top)
    while bottom < text_floor and door_size > 11.5:
        door_size -= 0.5
        ops, bottom = _layout(copy, door_size, text_top)
    if bottom < text_floor:
        raise ValueError(f"copy for {code!r} does not fit the page")
    for op in ops:
        if op[0] == "text":
            _, font, fsize, color, x, y, line = op
            c.setFillColor(color)
            c.setFont(font, fsize)
            c.drawString(x, y, line)
        elif op[0] == "dot":
            c.setFillColor(ACCENT)
            c.rect(op[1], op[2], 4.2, 4.2, stroke=0, fill=1)
        elif op[0] == "panel":
            c.setFillColor(PANEL)
            c.roundRect(op[1], op[2], op[3], op[4], 6, stroke=0, fill=1)

    # ── QR + how to use it ──
    widget = QrCodeWidget(url, barLevel="M", barBorder=2)
    x0, y0, x1, y1 = widget.getBounds()
    d = Drawing(_QR, _QR, transform=[_QR / (x1 - x0), 0, 0, _QR / (y1 - y0), 0, 0])
    widget.barFillColor = INK
    d.add(widget)
    renderPDF.draw(d, c, _M - 4, _QR_Y)

    cx = _M + _QR + 12
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(cx, _QR_Y + _QR - 26, "Prøv BonBox")
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 9.5)
    c.drawString(cx, _QR_Y + _QR - 42, "Scan koden med telefonens kamera,")
    c.drawString(cx, _QR_Y + _QR - 55, "eller skriv adressen:")
    c.setFillColor(INK)
    c.setFont("Helvetica", 9)
    c.drawString(cx, _QR_Y + _QR - 71, url.replace("https://", ""))

    # ── Footer ──
    c.setStrokeColor(HAIRLINE)
    c.line(_M, _FOOTER_Y + 16, _W - _M, _FOOTER_Y + 16)
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 7.5)
    c.drawString(_M, _FOOTER_Y, COMPANY_LINE)

    c.restoreState()
    c.showPage()


# Printed after every run — the sheets are useless until both halves are live.
PRECONDITION = (
    "BEFORE HANDING OUT ANY SHEET: the code-keeping build must be live. "
    "Check https://api.bonbox.dk/api/health ('commit' = the last signup_ref.py "
    "commit or later) and that a script www.bonbox.dk/register loads contains "
    "'bonbox_signup_ref' (command in this script's docstring). "
    "Sheets handed out earlier are lost, not counted as 0. "
    "Counts are a lower bound (same browser, from the deploy onward)."
)


def write_all(out_dir: str, codes: list[str], size: str = "a5",
              print_sheets: bool = False) -> list[str]:
    """One PDF per code; with print_sheets, also one multi-page file per
    round/argument (print-r1-a.pdf …) so a round prints as one job."""
    os.makedirs(out_dir, exist_ok=True)
    paths = []
    for code in codes:
        path = os.path.join(out_dir, f"bonbox-{code}.pdf")
        with open(path, "wb") as fh:
            fh.write(render_leave_behind(code, size=size))
        paths.append(path)
    if print_sheets:
        groups: dict[str, list[str]] = {}
        for code in codes:
            groups.setdefault(code.rsplit("-", 1)[0], []).append(code)
        for prefix, group in groups.items():
            path = os.path.join(out_dir, f"print-{prefix}.pdf")
            with open(path, "wb") as fh:
                fh.write(render_print_sheet(group, size=size, title=f"BonBox – {prefix} ({len(group)})"))
            paths.append(path)
    return paths


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="output dir (founder-private, NOT the repo)")
    ap.add_argument("--codes", nargs="*", help="codes to render (default r1-a-01…10, r2-b-01…10)")
    ap.add_argument("--size", choices=("a5", "a4"), default="a5")
    ap.add_argument("--print-sheets", action="store_true",
                    help="also write one multi-page print file per round (print-r1-a.pdf …)")
    args = ap.parse_args()
    written = write_all(args.out, args.codes or default_codes(), size=args.size,
                        print_sheets=args.print_sheets)
    print(f"wrote {len(written)} files to {args.out}")
    print(PRECONDITION)
