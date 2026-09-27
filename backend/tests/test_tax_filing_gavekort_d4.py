"""The MOMS filing PDF the owner downloads carries the gavekort warning.

build_moms_filing_pdf renders twice: pass 1 to hash, pass 2 (_rebuild_filing_story)
for the bytes it returns. Section D4 — "gavekort redeemed; check the meal is
bogført so it enters the MOMS base" — existed only in pass 1, so the delivered
document never showed it: the revisor was never asked the question the section
exists to ask. (Found Sep 2026.)

  cd backend && pytest tests/test_tax_filing_gavekort_d4.py -v
"""
from datetime import date

import pytest

from tests.test_pdf_markup_escape import _owner, _text, db_session  # noqa: F401 — fixture


@pytest.mark.parametrize("currency,heading", [("DKK", "D4 \\267 GAVEKORT-INDL"),
                                              ("EUR", "D4 \\267 GIFT CARD")])
def test_the_delivered_pdf_shows_the_gavekort_section(db_session, monkeypatch, currency, heading):
    import app.services.tax_filing_pdf as tf

    real = tf.compute_filing_data

    def _with_redemptions(*a, **k):
        data = real(*a, **k)
        data["gavekort_warnings"] = [
            {"date": "2026-05-09", "redeemed": 450.0, "status": "unmatched_redemption"},
        ]
        return data

    monkeypatch.setattr(tf, "compute_filing_data", _with_redemptions)
    user = _owner(db_session)
    user.currency = currency
    db_session.commit()

    pdf = tf.build_moms_filing_pdf(db_session, user, date(2026, 5, 1), date(2026, 5, 31))

    text = _text(pdf)
    assert heading in text, "the gavekort section is missing from the PDF the owner gets"
    assert "2026-05-09" in text


def test_no_redemptions_no_section(db_session):
    import app.services.tax_filing_pdf as tf
    user = _owner(db_session)
    pdf = tf.build_moms_filing_pdf(db_session, user, date(2026, 5, 1), date(2026, 5, 31))
    assert "GAVEKORT-INDL" not in _text(pdf)
