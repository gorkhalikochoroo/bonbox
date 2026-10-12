"""services/receipt_ref — the one strict parser for stored receipt references
(the revisor package reads these files and sends them to a third party)."""
import uuid

from app.services.receipt_ref import is_own_upload, parse_receipt_ref

U = str(uuid.uuid4())
OTHER = str(uuid.uuid4())
SHA = "a" * 64
BASE = "https://proj.supabase.co/storage/v1/object/sign/receipts"


def test_signed_url_bare_key_local_and_inbox_shapes():
    assert parse_receipt_ref(f"{BASE}/{U}/expense/{SHA}.jpg?token=t", U) == ("storage", f"{U}/expense/{SHA}.jpg")
    assert parse_receipt_ref(f"{U}/expense/{SHA}.jpg", U) == ("storage", f"{U}/expense/{SHA}.jpg")
    assert parse_receipt_ref(f"uploads/receipts/{U}_1760000000_0a1b2c3d.jpg", U)[0] == "local"
    assert parse_receipt_ref(f"uploads/receipts/{SHA}.enc", U) == ("inbox", f"uploads/receipts/{SHA}.enc")


def test_another_owners_files_are_refused():
    assert parse_receipt_ref(f"{BASE}/{OTHER}/expense/{SHA}.jpg?token=t", U) is None
    assert parse_receipt_ref(f"{OTHER}/expense/{SHA}.jpg", U) is None
    assert parse_receipt_ref(f"uploads/receipts/{OTHER}_1760000000_0a1b2c3d.jpg", U) is None


def test_traversal_encoding_and_foreign_hosts_are_refused():
    for bad in (
        f"{BASE}/{U}/../{OTHER}/expense/{SHA}.jpg",
        f"{BASE}/{U}/%2e%2e/{OTHER}/expense/{SHA}.jpg",
        f"{U}/expense/../../etc/passwd",
        f"uploads/receipts/../../app/config.py",
        f"uploads/receipts/{U}_1_0a1b2c3d.jpg\\..\\x",
        "https://evil.example/x.jpg",
        f"https://evil.example/{U}/expense/{SHA}.jpg",
        f"uploads/receipts/{SHA[:10]}.enc",
        "",
        None,
    ):
        assert parse_receipt_ref(bad, U) is None, bad


def test_only_own_expense_uploads_may_be_linked():
    assert is_own_upload(f"{BASE}/{U}/expense/{SHA}.jpg?token=t", U)
    assert is_own_upload(f"uploads/receipts/{U}_1760000000_0a1b2c3d.jpg", U)
    assert not is_own_upload(f"{U}/kasserapport/{SHA}.jpg", U)      # not an expense photo
    assert not is_own_upload(f"uploads/receipts/{SHA}.enc", U)        # no owner in the name
    assert not is_own_upload(f"{OTHER}/expense/{SHA}.jpg", U)
