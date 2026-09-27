"""error_logs stored raw request paths — and several links are their own
credential (staff portal, host stand, gavekort, invites). Secrets are now
redacted before a row is written; ids are kept."""
from app.utils.log_redact import redact_path


def test_link_tokens_are_redacted():
    assert redact_path("/s/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEyMzQ") == "/s/:redacted"
    assert redact_path("/api/stand/abcDEF123_-abcDEF123_-xyz/book") == "/api/stand/:redacted/book"


def test_ids_and_ordinary_segments_stay():
    p = "/api/public/reservations/booking/4fd3ef6d-26a6-4138-bd6b-6a27ecdbf997"
    assert redact_path(p) == p
    assert redact_path("/reservations/stand") == "/reservations/stand"
    assert redact_path("/api/staff/hours/resolve") == "/api/staff/hours/resolve"


def test_credential_query_values_are_redacted():
    out = redact_path("/booking?party=10&booking=4fd3ef6d-26a6-4138-bd6b-6a27ecdbf997&token=SECRETSECRETSECRET")
    assert "SECRET" not in out
    assert "party=10" in out and "token=:redacted" in out


def test_empty_is_empty():
    assert redact_path(None) is None
    assert redact_path("") == ""
