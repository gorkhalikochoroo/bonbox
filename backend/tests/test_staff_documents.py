"""
Employment documents — upload validation and storage-kind registration.

A PDF cannot be re-encoded on the way in the way an image can, so the accept
side is magic-bytes containment and the serve side is attachment+nosniff. The
tests that matter prove the containment holds:

  • the sniffed type wins over the filename and the client's Content-Type
  • an HTML file renamed .pdf is refused
  • the stored extension is derived, never supplied
  • the storage kind is in BOTH allow-lists, or GDPR erasure silently skips it
"""

import pytest

from app.services import staff_documents
from app.services.staff_documents import DocumentRejected

PDF = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\nrest of a contract"
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 40
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40


class TestAcceptedTypes:
    @pytest.mark.parametrize(
        "raw,ctype,ext",
        [(PDF, "application/pdf", "pdf"), (JPEG, "image/jpeg", "jpg"), (PNG, "image/png", "png")],
    )
    def test_sniffs_type_and_derives_extension(self, raw, ctype, ext):
        got_ctype, got_ext, sha, label = staff_documents.inspect_upload(raw, "Kontrakt 2026")
        assert (got_ctype, got_ext) == (ctype, ext)
        assert len(sha) == 64 and all(c in "0123456789abcdef" for c in sha)
        assert label == "Kontrakt 2026"

    def test_extension_comes_from_the_bytes_not_the_caller(self):
        # The caller never supplies an extension — there is no parameter for it.
        # A PDF is a pdf no matter what the upload was named.
        _, ext, _, _ = staff_documents.inspect_upload(PDF, "totally-an-image.png")
        assert ext == "pdf"

    def test_same_bytes_hash_the_same(self):
        # Content-addressed keys: two staffers given the identical contract share
        # one blob, which is why deletion checks for other referrers.
        a = staff_documents.inspect_upload(PDF, "A")[2]
        b = staff_documents.inspect_upload(PDF, "B")[2]
        assert a == b


class TestRejected:
    def test_html_renamed_as_pdf_is_refused(self):
        # THE attack: a same-origin HTML page served from the app's own domain.
        evil = b"<!doctype html><script>fetch('/api/portal/steal')</script>"
        with pytest.raises(DocumentRejected) as e:
            staff_documents.inspect_upload(evil, "contract.pdf")
        assert e.value.code == "unsupported_type"

    @pytest.mark.parametrize(
        "raw,code",
        [
            (b"", "empty"),
            (b"PK\x03\x04zipfile", "unsupported_type"),
            (b"GIF89a", "unsupported_type"),
            (b"%PDF", "unsupported_type"),        # truncated magic — not "%PDF-"
            (b" %PDF-1.7", "unsupported_type"),   # leading byte shifts the magic
        ],
    )
    def test_refuses_with_a_stable_code(self, raw, code):
        with pytest.raises(DocumentRejected) as e:
            staff_documents.inspect_upload(raw, "Doc")
        assert e.value.code == code

    def test_refuses_an_oversized_file(self):
        with pytest.raises(DocumentRejected) as e:
            staff_documents.inspect_upload(PDF + b"\x00" * staff_documents.MAX_BYTES, "Doc")
        assert e.value.code == "too_large"

    def test_requires_a_label(self):
        for label in [None, "", "   "]:
            with pytest.raises(DocumentRejected) as e:
                staff_documents.inspect_upload(PDF, label)
            assert e.value.code == "label_missing"

    def test_truncates_a_very_long_label_rather_than_failing(self):
        _, _, _, label = staff_documents.inspect_upload(PDF, "x" * 500)
        assert len(label) == 120


class TestStorageKindRegistration:
    """The recurring trap: a kind in ALLOWED_KINDS but missing from
    ERASURE_PURGE_KINDS is accepted for upload and then never GDPR-purged."""

    def test_kind_is_in_both_lists(self):
        from app.services.storage import ALLOWED_KINDS, ERASURE_PURGE_KINDS

        assert "staff_document" in ALLOWED_KINDS
        assert "staff_document" in ERASURE_PURGE_KINDS

    def test_kind_is_not_treated_as_an_accounting_record(self):
        # Employment documents are not covered by Bogføringsloven §10 — if they
        # were, Art.17 erasure would be required to KEEP them.
        from app.services.storage import ACCOUNTING_RETENTION_KINDS

        assert "staff_document" not in ACCOUNTING_RETENTION_KINDS

    def test_compose_key_accepts_pdf_for_this_kind(self):
        from app.services.storage import compose_key

        key = compose_key("11111111-1111-1111-1111-111111111111", "staff_document", "abc123", ext="pdf")
        assert key.endswith(".pdf")
        assert "/staff_document/" in key

    def test_compose_key_still_rejects_an_arbitrary_extension(self):
        from app.services.storage import compose_key

        with pytest.raises(ValueError):
            compose_key("11111111-1111-1111-1111-111111111111", "staff_document", "abc123", ext="html")


class TestErasureCoverage:
    def test_the_metadata_table_is_swept_by_account_erasure(self):
        # Erasure is metadata-driven: every table carrying a users.id FK is
        # purged. A staff_documents row without that FK would survive Art.17.
        from app.database import Base
        import app.models.staff  # noqa: F401 — registers the table

        table = Base.metadata.tables["staff_documents"]
        targets = [fk.column.table.name for c in table.columns for fk in c.foreign_keys]
        assert "users" in targets
