"""
Fieldwork leave-behinds (scripts/fieldwork_leave_behinds.py) — read the
rendered PDF, not its size: a renderer that fails into a blank page still
produces bytes.

  • one page, A5 by default (A4 on request), title names the code
  • the founder's door line for the code's argument and the closing line are
    on the page word for word; the other argument's line is not
  • the QR target is printed as text (the QR itself is decoded by hand, see
    the build notes) and carries the code
  • the company line is there
  • no number other than "14" outside the URL and the CVR — no "30
    sekunder", no price, nothing unmeasured
  • a code that is not a valid signup ref, or names no known argument, is
    refused instead of printed

Run:
  cd backend && python3 -m pytest tests/test_fieldwork_leave_behinds.py -x -q
"""
from __future__ import annotations

import io
import re

import pytest
from pypdf import PdfReader

from scripts.fieldwork_leave_behinds import (
    CLOSE_LINE, COMPANY_LINE, CONTENT, default_codes, render_leave_behind, write_all,
)


def _text(pdf: bytes) -> tuple[PdfReader, str]:
    reader = PdfReader(io.BytesIO(pdf))
    raw = " ".join(p.extract_text() or "" for p in reader.pages)
    return reader, re.sub(r"\s+", " ", raw).strip()


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


@pytest.mark.parametrize("code,arg,other", [("r1-a-03", "a", "b"), ("r2-b-10", "b", "a")])
def test_page_carries_the_right_copy(code, arg, other):
    reader, text = _text(render_leave_behind(code))
    assert len(reader.pages) == 1
    w, h = (float(v) for v in reader.pages[0].mediabox[2:])
    assert (round(w), round(h)) == (420, 595)  # A5 portrait
    assert reader.metadata.title == f"BonBox – {code}"

    assert "BonBox" in text
    assert _norm(CONTENT[arg]["door"]) in text
    assert _norm(CONTENT[other]["door"]) not in text
    for bullet in CONTENT[arg]["bullets"]:
        assert _norm(bullet) in text, bullet
    assert _norm(CLOSE_LINE) in text
    assert COMPANY_LINE in text
    assert f"www.bonbox.dk/register?ref={code}" in text


def test_founders_lines_are_verbatim():
    assert CONTENT["a"]["door"] == (
        "Når I lukker, tager I et billede af Z-bonen og skriver, hvad der ligger i "
        "kassen. BonBox læser tallene, viser en eventuel kassedifference og laver "
        "kasserapporten som PDF til jeres revisor."
    )
    assert CONTENT["b"]["door"] == (
        "Booking, vagtplan, timer og kasserapport i ét system – og personalet ser "
        "vagtplanen og stempler ind på mobilen. Kassesystemet og bogføringen beholder I."
    )
    assert CLOSE_LINE == (
        "Det er gratis at prøve i 14 dage uden betalingskort, og der bliver aldrig "
        "trukket penge, medmindre I selv vælger at betale."
    )
    assert COMPANY_LINE == "DukaanAI v/Manoz Chaudhary · CVR 46417321 · bonbox.dk"


@pytest.mark.parametrize("code", ["r1-a-01", "r2-b-07"])
def test_no_unmeasured_number_price_or_time(code):
    _, text = _text(render_leave_behind(code))
    rest = text.replace(f"www.bonbox.dk/register?ref={code}", "").replace(COMPANY_LINE, "")
    assert re.findall(r"\d+", rest) == ["14"], re.findall(r"\d+", rest)
    low = rest.lower()
    for banned in ("sekund", "minut", " kr", "kr.", "pris", "%"):
        assert banned not in low, banned


def test_a4_is_the_same_page_scaled():
    reader, text = _text(render_leave_behind("r1-a-02", size="a4"))
    w, h = (float(v) for v in reader.pages[0].mediabox[2:])
    assert (round(w), round(h)) == (595, 842)
    assert _norm(CONTENT["a"]["door"]) in text


@pytest.mark.parametrize("bad", ["R1-A-03", "r1_a_03", "r3-c-01", "flyer-01", "", "a" * 25])
def test_bad_codes_are_refused(bad):
    with pytest.raises(ValueError):
        render_leave_behind(bad)


def test_default_set_and_writing(tmp_path):
    codes = default_codes()
    assert codes[:2] == ["r1-a-01", "r1-a-02"] and codes[-1] == "r2-b-10"
    assert len(codes) == 20 and len(set(codes)) == 20
    paths = write_all(str(tmp_path), ["r1-a-01", "r2-b-01"])
    assert [p.rsplit("/", 1)[-1] for p in paths] == ["bonbox-r1-a-01.pdf", "bonbox-r2-b-01.pdf"]
    _, text = _text(open(paths[1], "rb").read())
    assert "ref=r2-b-01" in text


def test_print_sheet_is_one_page_per_code_in_order(tmp_path):
    paths = write_all(str(tmp_path), ["r1-a-01", "r1-a-02", "r2-b-01"], print_sheets=True)
    names = [p.rsplit("/", 1)[-1] for p in paths]
    assert "print-r1-a.pdf" in names and "print-r2-b.pdf" in names
    reader = PdfReader(str(tmp_path / "print-r1-a.pdf"))
    assert len(reader.pages) == 2
    for page, code in zip(reader.pages, ["r1-a-01", "r1-a-02"]):
        text = re.sub(r"\s+", " ", page.extract_text() or "")
        assert f"ref={code}" in text
        assert _norm(CONTENT["a"]["door"]) in text
        w, h = (float(v) for v in page.mediabox[2:])
        assert (round(w), round(h)) == (420, 595)
