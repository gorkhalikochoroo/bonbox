"""A Danish line item must not break the invoice.

THE DEFECT, and it is a live correctness bug before it is a security one.
ReportLab's Paragraph does not render plain text — it parses a small HTML
dialect. So the two characters a Danish owner is most likely to type into an
invoice line are exactly the two that break it:

    "Rengøring & vedligehold"   a bare & is an illegal entity
    "Levering <5 km"            an unclosed tag swallows the rest of the line

Either mangles the document or raises inside the PDF build — on an artifact a
customer receives and a revisor files. 1 of 71 Paragraph interpolation sites in
this codebase escaped its input; invoice_pdf.py escaped none.

And the same hole accepts markup: `<font color=...>`, an `<img>`, a `<para>`
— injected through a line description into a PDF somebody else opens.

ESCAPE AT THE PARAGRAPH BOUNDARY, NEVER EARLIER. Escaping on the way into the
database would store "&amp;" and corrupt the value for the API, the CSV export
and the screen. The <b>/<i>/<br/> wrappers this codebase adds are applied
around the ALREADY-ESCAPED value, so its own formatting survives.
"""
from __future__ import annotations

import inspect

from app.services.bonbox_pdf_kit import escape_pdf_text


class TestTheHelper:
    def test_the_ampersand_that_breaks_a_real_invoice(self):
        assert escape_pdf_text("Rengøring & vedligehold") == "Rengøring &amp; vedligehold"

    def test_the_less_than_that_breaks_a_real_invoice(self):
        assert escape_pdf_text("Levering <5 km") == "Levering &lt;5 km"

    def test_markup_cannot_be_injected(self):
        out = escape_pdf_text('<font color="red">gratis</font>')
        assert "<font" not in out and "&lt;font" in out

    def test_danish_letters_are_untouched(self):
        # Escaping must not mangle the alphabet the document is written in.
        assert escape_pdf_text("Søren Bæk, Ålborg") == "Søren Bæk, Ålborg"

    def test_none_is_empty_not_the_string_none(self):
        assert escape_pdf_text(None) == ""

    def test_numbers_survive(self):
        assert escape_pdf_text(42) == "42"

    def test_quotes_are_left_alone(self):
        # quote=False on purpose: these are text nodes, not attribute values,
        # and &#x27; in a printed invoice line is ugly and wrong.
        assert escape_pdf_text("5\" rør") == "5\" rør"


class TestTheInvoiceUsesIt:
    """Source-level, because building a full PDF needs a DB, an owner and an
    invoice — and the thing worth pinning is that no interpolation site was
    left unwrapped."""

    @staticmethod
    def _src():
        import app.services.invoice_pdf as m
        return inspect.getsource(m)

    def test_the_line_description_is_escaped(self):
        assert "Paragraph(escape_pdf_text(line.description)" in self._src()

    def test_the_notes_are_escaped(self):
        assert "escape_pdf_text(invoice.notes)" in self._src()

    def test_the_party_blocks_are_escaped(self):
        src = self._src()
        for frag in (
            "escape_pdf_text(issuer_name)",
            "escape_pdf_text(cust_name)",
            "escape_pdf_text(x) for x in issuer_addr_lines",
            "escape_pdf_text(x) for x in cust_addr_lines",
        ):
            assert frag in src, f"unescaped party field: {frag}"

    def test_no_raw_user_field_reaches_a_paragraph(self):
        """The specific shapes that were there before. If one comes back, the
        invoice starts failing on an ampersand again."""
        src = self._src()
        for bad in (
            "Paragraph(line.description,",
            'Paragraph(f"<i>{invoice.notes}</i>"',
            'issuer_lines = [f"<b>{issuer_name}</b>"]',
            'cust_lines = [f"<b>{cust_name}</b>"]',
        ):
            assert bad not in src, f"unescaped interpolation is back: {bad}"

    def test_formatting_tags_survive_the_escape(self):
        """<b> must wrap the escaped value, not be escaped itself — otherwise
        the invoice prints a literal <b> instead of bold."""
        src = self._src()
        assert '<b>{escape_pdf_text(issuer_name)}</b>' in src
