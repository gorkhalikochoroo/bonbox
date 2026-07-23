"""OCR must read the receipt it just saved — not "the newest file".

Four upload paths (expense scan, burst pile, sale receipt, Z-report) all
stored the image, threw away the path, and then re-derived a local path
by globbing `uploads/receipts/{user_id}_*` sorted by mtime, newest first.

With two receipts in flight for one owner — a double-tap, a second
device, the burst path running alongside a single scan — the newest file
is the OTHER receipt. The row keeps photo A while its amount, vendor and
date come from photo B. Nothing downstream can catch it: the OCR is
perfectly confident, because it read the image it was handed correctly.

The kasserapport path was the worst of the four. A Z-report IS the day's
revenue, so reading the wrong photo books another day's figures as this
close.

These tests pin the contract at the source (save_receipt_photo_ex hands
back the local path it wrote) and then prove the race is gone by
interleaving two saves the way concurrent requests would.

Run:
  cd backend && python3 -m pytest tests/test_receipt_path_race.py -q
"""
from __future__ import annotations

import io
import os
import uuid
from pathlib import Path

import pytest
from PIL import Image

from app.services import receipt_ocr


def _jpeg(color: tuple[int, int, int]) -> bytes:
    """A distinguishable 1-colour JPEG, so we can tell the files apart."""
    buf = io.BytesIO()
    Image.new("RGB", (40, 60), color).save(buf, "JPEG", quality=90)
    return buf.getvalue()


@pytest.fixture
def uploads(tmp_path, monkeypatch):
    """Point the module's UPLOAD_DIR at a throwaway dir and disable the
    Supabase leg so we exercise the local-path branch deterministically."""
    d = tmp_path / "receipts"
    d.mkdir(parents=True)
    monkeypatch.setattr(receipt_ocr, "UPLOAD_DIR", d)
    monkeypatch.setattr(receipt_ocr, "_upload_to_supabase", lambda *a, **k: None)
    return d


def test_ex_returns_the_path_it_actually_wrote(uploads):
    uid = str(uuid.uuid4())
    stored, local = receipt_ocr.save_receipt_photo_ex(_jpeg((200, 30, 30)), "a.jpg", uid)
    assert Path(local).exists()
    assert Path(local).parent == uploads
    # No Supabase → both are the same local file.
    assert stored == local


def test_ex_returns_local_path_even_when_durable_is_a_remote_url(uploads, monkeypatch):
    """In production the durable path is a Supabase URL that OCR cannot
    open — which is exactly why the old code went looking on disk."""
    monkeypatch.setattr(
        receipt_ocr, "_upload_to_supabase",
        lambda *a, **k: "https://xyz.supabase.co/storage/v1/object/public/r/abc.jpg",
    )
    uid = str(uuid.uuid4())
    stored, local = receipt_ocr.save_receipt_photo_ex(_jpeg((30, 200, 30)), "b.jpg", uid)
    assert stored.startswith("https://")
    assert Path(local).exists() and local.endswith(".jpg")


def test_interleaved_saves_each_keep_their_own_file(uploads):
    """THE RACE. Two receipts for ONE owner, saved back to back the way
    two concurrent requests would. Each caller must hold the path to its
    own image; picking newest-by-mtime hands both callers the same file.
    """
    uid = str(uuid.uuid4())
    red, green = _jpeg((220, 20, 20)), _jpeg((20, 220, 20))

    _, local_a = receipt_ocr.save_receipt_photo_ex(red, "a.jpg", uid)
    _, local_b = receipt_ocr.save_receipt_photo_ex(green, "b.jpg", uid)

    assert local_a != local_b, "two receipts must not share a path"

    def pixel(path):
        # Each fixture is a single flat colour, so any pixel identifies it.
        return Image.open(path).convert("RGB").getpixel((0, 0))

    r_a, g_a, _ = pixel(local_a)
    r_b, g_b, _ = pixel(local_b)
    assert r_a > g_a, "A still holds the red receipt"
    assert g_b > r_b, "B still holds the green receipt"

    # What the old code did: newest-by-mtime, for BOTH callers.
    newest = sorted(uploads.glob(f"{uid}_*"), key=os.path.getmtime, reverse=True)[0]
    assert str(newest) == local_b
    assert str(newest) != local_a, (
        "the old glob handed receipt A's request receipt B's image — "
        "this is the wrong-amount generator"
    )


def test_no_router_re_derives_the_path_by_mtime():
    """Static guard. The fix is only as durable as the pattern staying
    out of the codebase — a future upload path that copy-pastes the old
    idiom reintroduces a silent wrong-amount bug that no test of ITS
    behaviour would catch."""
    routers = Path(__file__).resolve().parent.parent / "app" / "routers"
    offenders = []
    for py in routers.glob("*.py"):
        text = py.read_text()
        if "getmtime" in text or "st_mtime" in text:
            offenders.append(py.name)
    assert not offenders, (
        f"{offenders} re-derive an upload path by mtime; use "
        "save_receipt_photo_ex()'s local path instead"
    )
