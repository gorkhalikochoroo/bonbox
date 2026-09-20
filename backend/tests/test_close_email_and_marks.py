"""The kasserapport's SIBLING surfaces — the email that delivers it, and the
marks the document draws with.

Two defects pinned here, both of the same family as the eight on the PDF:

  · The lock-time email and the send-to-accountant email each hand-rolled their
    own money formatter and appended the ISO code, so the mail that carries the
    kasserapport to the revisor said "12.500,00 DKK" while the PDF stapled to it
    said "12.500,00 kr." — an artifact disagreeing with its own attachment. They
    also stated a salgsmoms the attachment itself refuses to state.

  · The assurance band's "needs review" heading led with U+26A0 (⚠), which is
    outside the WinAnsi encoding ReportLab uses for Helvetica, so it drew as a
    black tofu box. That is exactly the "▪ GENNEMGÅS" the founder's exported
    PDF showed and the bug report quoted verbatim.
"""
from __future__ import annotations

from datetime import date, datetime

from app.routers.daily_close import _accountant_email_body, _build_close_email_html


class _Row:
    def __init__(self, **kw):
        self.date = date(2026, 9, 17)
        self.status = "confirmed"
        self.closed_at = datetime(2026, 9, 17, 23, 30)
        self.revenue_categories = "food:10000"
        self.revenue_total = 10000.0
        self.payment_categories = None
        self.payment_total = 0.0
        self.moms_total = 2000.0
        self.revenue_ex_moms = 8000.0
        self.moms_mode = "auto"
        self.cash_counted = None
        self.cash_expected = None
        self.cash_difference = None
        for k, v in kw.items():
            setattr(self, k, v)


def _close_email(**kw):
    return _build_close_email_html(
        business_name="Cafe", dc=_Row(**kw), currency="DKK", closed_by="Manoz",
        has_scan=False, scan_degraded=False, is_danish=True,
    )[1]


# ─────────── E1: one money format across the artifact and its envelope ───────


def test_lock_email_renders_kr_not_the_iso_code():
    html = _close_email()
    assert "10.000,00 kr." in html
    assert "DKK" not in html


def test_lock_email_renders_ore():
    assert "10.000,50 kr." in _close_email(revenue_total=10000.5)


def test_lock_email_kassedifference_uses_the_same_formatter():
    html = _close_email(cash_difference=-125.5)
    assert "-125,50 kr." in html
    assert "DKK" not in html


def test_accountant_email_renders_kr_not_the_iso_code():
    html = _accountant_email_body(
        business_name="Cafe", from_iso="2026-05-01", to_iso="2026-05-31",
        n_closes=2, currency="DKK", total_revenue=15000.0, total_moms=3000.0,
        fmt="pdf", message=None, is_danish=True,
    )
    assert "15.000,00 kr." in html and "3.000,00 kr." in html
    assert "DKK" not in html


# ─────────── C: an email must not state what its attachment dashes ──────────


def test_lock_email_dashes_a_moms_the_attached_pdf_cannot_state():
    """auto mode, non-zero revenue, zero salgsmoms — the live 17 Sep shape."""
    html = _close_email(moms_total=0.0, revenue_ex_moms=10000.0)
    assert ">—</td>" in html
    assert ">0,00 kr.</td>" not in html
    # …and the revenue, which IS known, is still stated.
    assert ">10.000,00 kr.</td>" in html


def test_accountant_email_dashes_an_unknown_period_moms_and_says_why():
    html = _accountant_email_body(
        business_name="Cafe", from_iso="2026-05-01", to_iso="2026-05-31",
        n_closes=2, currency="DKK", total_revenue=15000.0, total_moms=None,
        fmt="xlsx", message=None, is_danish=True,
    )
    assert "—" in html
    assert "kan ikke opgøres" in html


# ─────────── The marks the document can actually draw ───────────


def test_every_mark_the_band_draws_is_a_real_glyph():
    """ReportLab's fallback for a character Helvetica cannot place is
    ZapfDingbats "n" — a filled black square. That IS the "\u25aa GENNEMGÅS" the
    founder's export showed: the heading led with "\u26a0" (U+26A0), which has no
    glyph. "\u2713" has no WinAnsi slot either but DOES have a real ZapfDingbats
    substitute, so encoding membership is the wrong test and ReportLab's own
    resolution is the right one."""
    from app.services import kasserapport_claims as k

    for mark in (k.MARK_PASS, k.MARK_FAIL, k.MARK_REVIEW):
        assert k.mark_is_renderable(mark), repr(mark)
    # The guard has to be able to fail, or it pins nothing.
    assert k.mark_is_renderable("\u26a0") is False
    # …and it must not reject a mark that genuinely renders.
    assert k.mark_is_renderable("\u2713") is True


def test_the_renderer_draws_only_the_named_marks():
    """No literal glyph may be reintroduced beside the named constants."""
    import inspect
    from app.routers import daily_close as m

    src = inspect.getsource(m.daily_close_pdf)
    # Strip comments — the prose explains the defect and quotes the glyph.
    code = "\n".join(ln.split("#", 1)[0] for ln in src.splitlines())
    assert "\u26a0" not in code
    assert "MARK_PASS" in code and "MARK_REVIEW" in code and "MARK_FAIL" in code


def test_no_label_the_band_can_print_is_unrenderable():
    """Belt and braces: whatever the heading is assembled from, nothing the
    band can print may fall back to the box."""
    from app.services.kasserapport_claims import close_labels, mark_is_renderable

    for currency in ("DKK", "EUR"):
        for text in close_labels(currency).values():
            assert mark_is_renderable(text), text
