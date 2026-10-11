"""Nightly off-project backup (services/backup_service) — no network.

The backup is the last line of defence for receipt photos (accounting source
documents) and the database, so every promise it makes is pinned here:

  • OFF unless all three BACKUP_* vars are set; partial config is REPORTED
    (names only, never values)
  • client-side encryption: round trip, and wrong key / tamper / truncation /
    reordering / splicing all refused
  • photos: incremental (nothing re-copied), new versions never overwrite,
    manifest records path/size/sha256/copied_at, sample hash verification
    catches a corrupted copy
  • retention: deleted-in-source copies kept 30 days (no-basis kinds) or the
    6-year accounting window; erasure tombstones purge backup copies; a failed
    source listing marks NOTHING deleted
  • DB export: consistent, encrypted, memory-bounded, verified by re-download,
    readable by scripts/restore_from_backup.py --dry-run (which catches a
    corrupted part); export retention = 30 newest + 12 monthly
  • one run at a time; the job never raises; failures land in ErrorLog +
    MonitorState; the scheduler registers it; the admin endpoint reports it

Storage is a directory-backed bucket (LocalDirBucket) or a failing stub; the
database is SQLite. The Postgres COPY path and the real advisory lock are in
tests/test_pg_backup.py (opt-in, BONBOX_TEST_PG_URL).
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import random
import sqlite3
import struct
import sys
import threading
import tracemalloc
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app import models as _all_models  # noqa: F401 — register every model
from app.models.erasure_tombstone import ErasureTombstone
from app.models.error_log import ErrorLog
from app.models.monitor_state import MonitorState
from app.services import backup_service as bs
from app.services.backup_crypto import (
    BackupConfigError,
    BackupCryptoError,
    DecryptingReader,
    EncryptingWriter,
    decrypt_bytes,
    encrypt_bytes,
    load_backup_fernet,
)
from app.services.backup_storage import BackupStorageError, LocalDirBucket

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import restore_from_backup as restore  # noqa: E402

NOW = datetime(2026, 10, 12, 4, 20, 0)
UID_A = str(uuid.UUID(int=0xA))
UID_B = str(uuid.UUID(int=0xB))
SERVICE_KEY = "sb_secret_backupservicekey_DO_NOT_LEAK_123"


# ── fixtures ─────────────────────────────────────────────────────────────

@pytest.fixture
def key():
    return Fernet.generate_key().decode()


@pytest.fixture
def fernet(key):
    return load_backup_fernet(key)


@pytest.fixture
def db_env():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


@pytest.fixture
def buckets(tmp_path):
    src = LocalDirBucket(tmp_path / "receipts")
    dst = LocalDirBucket(tmp_path / "bonbox-backup")
    return src, dst


def _cfg(fernet, key=""):
    return bs.BackupConfig(status="enabled", url="https://backup.example.supabase.co",
                           service_key=SERVICE_KEY, bucket="bonbox-backup", fernet=fernet,
                           source_url="https://main.example.supabase.co", source_key="srckey",
                           source_buckets=("receipts",), secrets=(SERVICE_KEY, key))


def _put(src, path, data: bytes, when: datetime = NOW):
    """Write a source object with a fixed creation time (the retention clock
    must not depend on the day the suite runs)."""
    src.upload(path, data, upsert=True)
    ts = when.replace(tzinfo=timezone.utc).timestamp()
    os.utime(src.root / path, (ts, ts))


def _photo(n: int, size: int = 2000) -> bytes:
    return hashlib.sha256(str(n).encode()).digest() * (size // 32)


def _run(fernet, db_env, buckets, *, now=NOW, key="", sources=None, dst=None, **kw):
    engine, Session = db_env
    src, d = buckets
    return bs.run_nightly_backup(cfg=_cfg(fernet, key), engine=engine, session_factory=Session,
                                 sources=sources if sources is not None else {"receipts": src},
                                 dst=dst or d, now=now, **kw)


def _manifest(dst, fernet):
    return json.loads(decrypt_bytes(dst.download(bs.MANIFEST_KEY), fernet))


def _rows(Session, model):
    s = Session()
    try:
        return s.query(model).all()
    finally:
        s.close()


# ── config ───────────────────────────────────────────────────────────────

def _settings(**kw):
    base = dict(BACKUP_SUPABASE_URL="", BACKUP_SUPABASE_SERVICE_KEY="", BACKUP_ENCRYPTION_KEY="",
                BACKUP_ENCRYPTION_KEY_PREVIOUS="", BACKUP_BUCKET="bonbox-backup",
                SUPABASE_URL="https://main.supabase.co", SUPABASE_SERVICE_KEY="mainkey",
                SUPABASE_RECEIPTS_BUCKET="receipts")
    base.update(kw)
    return SimpleNamespace(**base)


class _ExplodingBucket:
    """Any storage call is a test failure."""

    def __getattr__(self, name):
        raise AssertionError(f"storage touched: {name}")


def test_disabled_when_env_missing(db_env, monkeypatch):
    engine, Session = db_env
    monkeypatch.setattr(bs, "settings", _settings())
    assert bs.load_config().status == "disabled"
    out = bs.run_nightly_backup(engine=engine, session_factory=Session, dst=_ExplodingBucket(),
                                sources={"receipts": _ExplodingBucket()})
    assert out == {"status": "disabled"}
    assert _rows(Session, MonitorState) == []
    assert _rows(Session, ErrorLog) == []


def test_partial_config_is_reported_by_name_never_by_value(db_env, monkeypatch, key):
    engine, Session = db_env
    monkeypatch.setattr(bs, "settings", _settings(
        BACKUP_SUPABASE_URL="https://backup.supabase.co", BACKUP_SUPABASE_SERVICE_KEY=SERVICE_KEY))
    cfg = bs.load_config()
    assert cfg.status == "misconfigured"
    assert cfg.problems == ["BACKUP_ENCRYPTION_KEY is not set"]
    out = bs.run_nightly_backup(engine=engine, session_factory=Session, dst=_ExplodingBucket())
    assert out["status"] == "failed"
    errs = _rows(Session, ErrorLog)
    assert len(errs) == 1 and errs[0].error_type == "backup:misconfigured"
    assert "BACKUP_ENCRYPTION_KEY" in errs[0].message
    st = _rows(Session, MonitorState)[0]
    for blob in (errs[0].message, st.last_summary, json.dumps(out)):
        assert SERVICE_KEY not in blob


@pytest.mark.parametrize("override, problem", [
    (dict(BACKUP_ENCRYPTION_KEY="not-a-fernet-key"), "BACKUP_ENCRYPTION_KEY is not a Fernet key"),
    (dict(BACKUP_SUPABASE_URL="https://main.supabase.co/"), "points at the main project"),
    (dict(BACKUP_SUPABASE_URL="http://backup.supabase.co"), "must start with https://"),
    (dict(BACKUP_BUCKET="Bad Bucket!"), "BACKUP_BUCKET is not a valid bucket name"),
])
def test_bad_config_values_are_refused(monkeypatch, key, override, problem):
    full = dict(BACKUP_SUPABASE_URL="https://backup.supabase.co",
                BACKUP_SUPABASE_SERVICE_KEY=SERVICE_KEY, BACKUP_ENCRYPTION_KEY=key)
    full.update(override)
    cfg = bs.load_config(_settings(**full))
    assert cfg.status == "misconfigured"
    assert any(problem in p for p in cfg.problems), cfg.problems
    assert all("not-a-fernet-key" not in p and SERVICE_KEY not in p for p in cfg.problems)


def test_full_config_enables(key):
    cfg = bs.load_config(_settings(BACKUP_SUPABASE_URL="https://backup.supabase.co",
                                   BACKUP_SUPABASE_SERVICE_KEY=SERVICE_KEY,
                                   BACKUP_ENCRYPTION_KEY=key))
    assert cfg.status == "enabled" and cfg.bucket == "bonbox-backup"
    assert cfg.source_buckets == ("receipts",)
    assert SERVICE_KEY not in repr(cfg) and key not in repr(cfg)


# ── encryption ───────────────────────────────────────────────────────────

def _frames(blob: bytes):
    header, rest = blob[:21], blob[21:]
    frames = []
    while rest:
        (n,) = struct.unpack(">I", rest[:4])
        frames.append(rest[:4 + n])
        rest = rest[4 + n:]
    return header, frames


def test_encryption_round_trip_multi_frame(fernet):
    data = os.urandom(50_000)
    blob = encrypt_bytes(data, fernet, chunk_bytes=4096)
    assert data not in blob
    assert len(_frames(blob)[1]) == 13           # 12 full frames + final
    assert decrypt_bytes(blob, fernet) == data
    assert decrypt_bytes(encrypt_bytes(b"", fernet), fernet) == b""
    # streaming reader, small reads
    r = DecryptingReader(io.BytesIO(blob), fernet)
    out = bytearray()
    while True:
        chunk = r.read(777)
        if not chunk:
            break
        out += chunk
    assert bytes(out) == data and r.verify_complete() == 0


def test_encryption_refuses_wrong_key_and_tampering(fernet):
    data = os.urandom(20_000)
    blob = encrypt_bytes(data, fernet, chunk_bytes=4096)
    other = load_backup_fernet(Fernet.generate_key().decode())
    with pytest.raises(BackupCryptoError, match="authentication"):
        decrypt_bytes(blob, other)

    flipped = bytearray(blob)
    flipped[len(flipped) // 2] ^= 0x01
    with pytest.raises(BackupCryptoError):
        decrypt_bytes(bytes(flipped), fernet)

    header, frames = _frames(blob)
    with pytest.raises(BackupCryptoError, match="final frame missing"):
        decrypt_bytes(header + b"".join(frames[:-1]), fernet)          # truncated
    with pytest.raises(BackupCryptoError, match="out of order"):
        decrypt_bytes(header + frames[1] + frames[0] + b"".join(frames[2:]), fernet)
    with pytest.raises(BackupCryptoError, match="after the final frame"):
        decrypt_bytes(blob + frames[-1], fernet)
    foreign_header, foreign = _frames(encrypt_bytes(data, fernet, chunk_bytes=4096))
    with pytest.raises(BackupCryptoError, match="another backup file"):
        decrypt_bytes(header + foreign[0] + b"".join(frames[1:]), fernet)
    with pytest.raises(BackupCryptoError, match="bad magic"):
        decrypt_bytes(b"XXXX" + blob[4:], fernet)


def test_previous_key_still_decrypts_after_rotation(key):
    old = load_backup_fernet(key)
    blob = encrypt_bytes(b"receipt", old)
    rotated = load_backup_fernet(Fernet.generate_key().decode(), previous=key)
    assert decrypt_bytes(blob, rotated) == b"receipt"
    with pytest.raises(BackupConfigError):
        load_backup_fernet("")
    with pytest.raises(BackupConfigError) as e:
        load_backup_fernet("hunter2-secret-value")
    assert "hunter2" not in str(e.value)


def test_writer_memory_is_one_frame(fernet):
    sink = io.BytesIO()
    w = EncryptingWriter(sink, fernet, chunk_bytes=1024)
    for _ in range(200):
        w.write(b"z" * 999)
        assert len(w._buf) <= 1024
    w.close()
    assert w.bytes_in == 199_800
    assert decrypt_bytes(sink.getvalue(), fernet) == b"z" * 199_800


# ── photos: incremental mirror ───────────────────────────────────────────

def test_incremental_copy_and_manifest(fernet, db_env, buckets):
    src, dst = buckets
    _put(src, f"{UID_A}/expense/{'a' * 64}.jpg", _photo(1))
    _put(src, f"{UID_A}/kasserapport/{'b' * 64}.jpg", _photo(2, 5000))
    _put(src, f"{UID_B}/staff_avatar/{'c' * 64}.png", _photo(3, 300))

    out = _run(fernet, db_env, buckets)
    assert out["status"] == "ok", out["errors"]
    p = out["photos"]
    assert (p["listed"], p["copied"], p["unchanged"], p["verified"]) == (3, 3, 0, 3)

    m = _manifest(dst, fernet)
    assert len(m["entries"]) == 3
    for k, e in m["entries"].items():
        assert k == f"photos/receipts/{e['path']}.{e['sha256']}.enc"
        plain = src.download(e["path"])
        assert e["sha256"] == hashlib.sha256(plain).hexdigest() and e["size"] == len(plain)
        assert e["copied_at"] == "2026-10-12T04:20:00Z" and e["source_deleted_at"] is None
        blob = dst.download(k)
        assert plain not in blob and plain[:64] not in blob      # really encrypted
        assert decrypt_bytes(blob, fernet) == plain
    assert {e["kind"] for e in m["entries"].values()} == {"expense", "kasserapport", "staff_avatar"}

    # second night: nothing new is copied
    out = _run(fernet, db_env, buckets, now=NOW + timedelta(days=1))
    assert (out["photos"]["copied"], out["photos"]["unchanged"]) == (0, 3)

    # a new object is the only one copied
    _put(src, f"{UID_A}/sale/{'d' * 64}.jpg", _photo(4))
    out = _run(fernet, db_env, buckets, now=NOW + timedelta(days=2))
    assert (out["photos"]["copied"], out["photos"]["unchanged"]) == (1, 3)

    # changed content at the same path → a NEW version; the old one is kept
    path = f"{UID_A}/expense/{'a' * 64}.jpg"
    _put(src, path, _photo(99, 2100))
    out = _run(fernet, db_env, buckets, now=NOW + timedelta(days=3))
    assert out["photos"]["copied"] == 1 and out["photos"]["marked_deleted"] == 1
    versions = [e for e in _manifest(dst, fernet)["entries"].values() if e["path"] == path]
    assert len(versions) == 2
    assert sorted(bool(v["source_deleted_at"]) for v in versions) == [False, True]


def test_lost_manifest_is_rebuilt_without_recopying(fernet, db_env, buckets):
    src, dst = buckets
    _put(src, f"{UID_A}/expense/{'a' * 64}.jpg", _photo(1))
    _put(src, f"{UID_A}/sale/{'b' * 64}.jpg", _photo(2))
    _run(fernet, db_env, buckets)
    dst.delete_many([bs.MANIFEST_KEY])
    out = _run(fernet, db_env, buckets, now=NOW + timedelta(days=1))
    assert out["status"] == "ok", out["errors"]
    assert out["photos"]["manifest_rebuilt"] is True
    assert (out["photos"]["copied"], out["photos"]["refreshed"]) == (0, 2)


def test_unreadable_manifest_fails_loud_and_is_not_overwritten(fernet, db_env, buckets):
    src, dst = buckets
    _put(src, f"{UID_A}/expense/{'a' * 64}.jpg", _photo(1))
    _run(fernet, db_env, buckets)
    before = dst.download(bs.MANIFEST_KEY)
    wrong = load_backup_fernet(Fernet.generate_key().decode())
    out = _run(wrong, db_env, buckets, now=NOW + timedelta(days=1))
    assert out["status"] == "failed"
    assert any("photos" in e for e in out["errors"])
    assert dst.download(bs.MANIFEST_KEY) == before


def test_sample_verification_catches_a_corrupted_copy(fernet, db_env, buckets):
    src, dst = buckets
    _put(src, f"{UID_A}/expense/{'a' * 64}.jpg", _photo(1))
    _run(fernet, db_env, buckets)
    k = next(iter(_manifest(dst, fernet)["entries"]))
    dst.upload(k, encrypt_bytes(b"something else", fernet), upsert=True)
    out = _run(fernet, db_env, buckets, now=NOW + timedelta(days=1))
    assert out["status"] == "failed"
    assert any("sha256 mismatch" in e for e in out["errors"])
    _, Session = db_env
    assert any(r.error_type == "backup:failed" for r in _rows(Session, ErrorLog))
    # and the restore dry-run refuses it too
    assert restore.main(["--dry-run", "--skip-db", "--source-dir", str(dst.root)],
                        env={"BACKUP_ENCRYPTION_KEY": _key_of(fernet)}) == 1


_KEYS: dict = {}


def _key_of(fernet):
    return _KEYS[id(fernet)]


@pytest.fixture(autouse=True)
def _remember_keys(key, fernet):
    _KEYS[id(fernet)] = key
    yield
    _KEYS.clear()


class _ListingFails:
    def __init__(self, inner):
        self.inner = inner

    def list_all(self, prefix=""):
        raise BackupStorageError("list receipts -> HTTP 500: upstream timeout")

    def __getattr__(self, name):
        return getattr(self.inner, name)


def test_failed_listing_marks_nothing_deleted(fernet, db_env, buckets):
    src, dst = buckets
    for i in range(3):
        _put(src, f"{UID_A}/expense/{str(i) * 64}.jpg", _photo(i))
    _run(fernet, db_env, buckets)
    out = _run(fernet, db_env, buckets, now=NOW + timedelta(days=40),
               sources={"receipts": _ListingFails(src)})
    assert out["status"] == "failed"
    m = _manifest(dst, fernet)
    assert len(m["entries"]) == 3
    assert all(e["source_deleted_at"] is None for e in m["entries"].values())
    _, Session = db_env
    assert _rows(Session, MonitorState)[0].state == "BROKEN"


# ── photos: retention + erasure ──────────────────────────────────────────

def test_deleted_in_source_retention_by_kind(fernet, db_env, buckets):
    src, dst = buckets
    avatar = f"{UID_A}/staff_avatar/{'a' * 64}.png"
    expense = f"{UID_A}/expense/{'b' * 64}.jpg"
    odd = "legacy/receipt-0001.jpg"                     # unknown layout
    for i, p in enumerate((avatar, expense, odd)):
        _put(src, p, _photo(i))
    _run(fernet, db_env, buckets)
    src.delete_many([avatar, expense, odd])

    out = _run(fernet, db_env, buckets, now=NOW + timedelta(days=1))
    assert out["photos"]["marked_deleted"] == 3 and out["photos"]["purged"] == 0

    def paths():
        return {e["path"] for e in _manifest(dst, fernet)["entries"].values()}

    # inside the 30-day grace everything is still restorable
    _run(fernet, db_env, buckets, now=NOW + timedelta(days=30))
    assert paths() == {avatar, expense, odd}
    # after it: the no-basis kind goes, accounting + unknown stay
    out = _run(fernet, db_env, buckets, now=NOW + timedelta(days=32))
    assert out["photos"]["purged"] == 1 and paths() == {expense, odd}
    assert not dst.list_all(f"photos/receipts/{UID_A}/staff_avatar")
    # accounting documents are kept for the 6-year window from creation
    _run(fernet, db_env, buckets, now=NOW + bs.ACCOUNTING_KEEP - timedelta(days=2))
    assert paths() == {expense, odd}
    _run(fernet, db_env, buckets, now=NOW + bs.ACCOUNTING_KEEP + timedelta(days=2))
    assert paths() == set()
    assert dst.list_all("photos") == []


def _tombstone(Session, uid, erased_at):
    s = Session()
    s.add(ErasureTombstone(user_id=uuid.UUID(uid), erased_at=erased_at))
    s.commit()
    s.close()


def test_erasure_tombstone_purges_backup_copies(fernet, db_env, buckets):
    src, dst = buckets
    _, Session = db_env
    avatar = f"{UID_A}/staff_avatar/{'a' * 64}.png"
    doc = f"{UID_A}/staff_document/{'e' * 64}.pdf"
    expense = f"{UID_A}/expense/{'b' * 64}.jpg"
    other = f"{UID_B}/staff_avatar/{'c' * 64}.png"
    for i, p in enumerate((avatar, doc, expense, other)):
        _put(src, p, _photo(i))
    _run(fernet, db_env, buckets)
    assert len(_manifest(dst, fernet)["entries"]) == 4

    # Account A erased tonight. Even if the source still holds the avatar
    # (purge_user_blobs is best-effort), the backup copy goes, and is not re-copied.
    _tombstone(Session, UID_A, NOW + timedelta(hours=1))
    out = _run(fernet, db_env, buckets, now=NOW + timedelta(days=1))
    assert out["status"] == "ok", out["errors"]
    assert out["photos"]["purged"] == 2 and out["photos"]["skipped_erased"] == 2
    left = {e["path"] for e in _manifest(dst, fernet)["entries"].values()}
    assert left == {expense, other}
    assert dst.list_all(f"photos/receipts/{UID_A}/staff_avatar") == []
    assert dst.list_all(f"photos/receipts/{UID_A}/staff_document") == []

    # After the legal window the accounting copy goes too (same 6-year rule
    # as accounting_retention._purge_erased_account_blobs).
    out = _run(fernet, db_env, buckets, now=NOW + bs.ACCOUNTING_KEEP + timedelta(days=2))
    left = {e["path"] for e in _manifest(dst, fernet)["entries"].values()}
    assert left == {other}


def test_erasure_rules_track_storage_kind_lists():
    from app.services.storage import ACCOUNTING_RETENTION_KINDS, ERASURE_PURGE_KINDS
    now = NOW
    gone = bs._iso(now - timedelta(days=31))
    for kind in ERASURE_PURGE_KINDS:
        assert bs._photo_due({"kind": kind, "source_deleted_at": gone,
                              "source_created_at": bs._iso(now)}, now, {})
    for kind in ACCOUNTING_RETENTION_KINDS | {"unknown"}:
        assert not bs._photo_due({"kind": kind, "source_deleted_at": gone,
                                  "source_created_at": bs._iso(now - timedelta(days=40))}, now, {})


# ── DB export + restore dry-run ──────────────────────────────────────────

def _seed_sqlite(engine):
    with engine.begin() as c:
        c.execute(text("CREATE TABLE bk_items (id INTEGER PRIMARY KEY, note TEXT, pic BLOB, amt REAL)"))
        c.execute(text("INSERT INTO bk_items VALUES (1, 'kaffe, \"stor\"\nlinje 2', x'00ff', 42.5),"
                       " (2, '', NULL, NULL), (3, NULL, x'', 0)"))


def test_db_export_is_encrypted_verified_and_dry_run_restorable(fernet, key, db_env, buckets):
    engine, Session = db_env
    _seed_sqlite(engine)
    src, dst = buckets
    out = _run(fernet, db_env, buckets)
    assert out["status"] == "ok", out["errors"]
    d = out["db"]
    assert d["verified"] and d["parts"] == 1 and d["tables"] >= 2
    export_id = d["export_id"]
    assert export_id == "2026-10-12T042000Z"
    keys = [o.key for o in dst.list_all(f"db/{export_id}")]
    assert sorted(k.rsplit("/", 1)[1] for k in keys) == ["manifest.json.enc", "part-00000.enc"]
    part = dst.download(f"db/{export_id}/part-00000.enc")
    assert b"bk_items" not in part and b"kaffe" not in part
    man = bs.load_export_manifest(dst, export_id, fernet)
    assert man["tables"]["bk_items"]["rows"] == 3

    env = {"BACKUP_ENCRYPTION_KEY": key}
    assert restore.main(["--list", "--source-dir", str(dst.root)], env=env) == 0
    assert restore.main(["--dry-run", "--source-dir", str(dst.root)], env=env) == 0
    # wrong key → refused
    bad = {"BACKUP_ENCRYPTION_KEY": Fernet.generate_key().decode()}
    assert restore.main(["--dry-run", "--skip-photos", "--source-dir", str(dst.root)], env=bad) == 1
    # a corrupted part → refused
    p = dst.root / f"db/{export_id}/part-00000.enc"
    raw = bytearray(p.read_bytes())
    raw[200] ^= 0xFF
    p.write_bytes(bytes(raw))
    assert restore.main(["--dry-run", "--skip-photos", "--source-dir", str(dst.root)], env=env) == 1


def test_export_split_into_parts_round_trips(fernet, key, db_env, buckets):
    engine, _ = db_env
    with engine.begin() as c:
        c.execute(text("CREATE TABLE bk_big (id INTEGER PRIMARY KEY, blob TEXT)"))
    raw = engine.raw_connection()
    raw.executemany("INSERT INTO bk_big VALUES (?, ?)",
                    ((i, os.urandom(100).hex()) for i in range(3000)))
    raw.commit()
    _, dst = buckets
    res = bs.export_db_to_backup(engine, dst, fernet, now=NOW, part_bytes=64 * 1024)
    assert res["parts"] > 3
    assert restore.main(["--dry-run", "--skip-photos", "--source-dir", str(dst.root)],
                        env={"BACKUP_ENCRYPTION_KEY": key}) == 0


def _export_peak(fernet, tmp_path, rows: int, name: str) -> tuple[int, int]:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    with engine.begin() as c:
        c.execute(text("CREATE TABLE bk_huge (id INTEGER PRIMARY KEY, payload TEXT)"))
    raw = engine.raw_connection()
    rnd = random.Random(7)
    raw.executemany("INSERT INTO bk_huge VALUES (?, ?)",
                    ((i, rnd.randbytes(200).hex()) for i in range(rows)))
    raw.commit()
    dst = LocalDirBucket(tmp_path / name)
    tracemalloc.start()
    try:
        res = bs.export_db_to_backup(engine, dst, fernet, now=NOW)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
        engine.dispose()
    assert res["verified"]
    return peak, res["plain_bytes"]


def test_export_streaming_is_memory_bounded(fernet, tmp_path):
    """Incompressible table data, 12 MB then 24 MB: the export (COPY → spool →
    tar → gzip → encrypt → upload → re-download → verify) must not hold the
    table — doubling the data must not move the peak."""
    peak_small, small = _export_peak(fernet, tmp_path, 30_000, "small")
    peak_big, big = _export_peak(fernet, tmp_path, 60_000, "big")
    assert big > 24_000_000 and big > 1.9 * small
    assert peak_big < 16 * 1024 * 1024, f"peak {peak_big / 1e6:.1f} MB"
    assert peak_big - peak_small < 2 * 1024 * 1024, (peak_small, peak_big)


def test_export_retention_keeps_30_nightly_and_12_monthly():
    start = datetime(2025, 6, 1, 4, 20)
    ids = [bs.export_id_for(start + timedelta(days=i)) for i in range(500)]
    keep = bs.select_exports_to_keep(ids)                 # no age cap
    newest = sorted(ids)[-30:]
    assert set(newest) <= keep
    monthly = keep - set(newest)
    assert len(monthly) == 12 - 1      # the newest month's first export is already in the 30
    assert all(bs.parse_export_id(i).day == 1 for i in monthly)
    assert len(keep) == 30 + len(monthly)
    assert bs.select_exports_to_keep(ids[:5]) == set(ids[:5])
    assert bs.select_exports_to_keep(["not-an-id"]) == set()


def test_export_retention_honours_the_90_day_privacy_promise():
    """/privacy: "Backups are purged within 90 days" of an account deletion. A
    DB export cannot be edited to drop one account, so no export may outlive
    DB_MAX_AGE (< 90 days) — whatever the nightly/monthly counts say."""
    root = Path(__file__).resolve().parents[2]
    page = (root / "frontend/src/pages/PrivacyPolicyPage.jsx").read_text(encoding="utf-8")
    assert "Backups are purged within 90 days" in page
    assert "Sikkerhedskopier slettes inden for 90 dage" in page
    assert bs.DB_MAX_AGE < timedelta(days=90)

    start = datetime(2025, 6, 1, 4, 20)
    ids = [bs.export_id_for(start + timedelta(days=i)) for i in range(500)]
    now = start + timedelta(days=499, hours=1)
    keep = bs.select_exports_to_keep(ids, now=now)
    assert all(now - bs.parse_export_id(i) <= bs.DB_MAX_AGE for i in keep)
    assert set(sorted(ids)[-30:]) <= keep
    # monthly = the earliest export of each month still inside the window
    # (window starts 07-18: 2026-10-13 minus 88 days)
    assert {bs.parse_export_id(i).strftime("%m-%d") for i in keep - set(sorted(ids)[-30:])} \
        == {"07-18", "08-01", "09-01"}


def test_prune_db_exports(fernet, buckets):
    _, dst = buckets
    start = datetime(2026, 1, 1, 4, 20)
    ids = [bs.export_id_for(start + timedelta(days=i)) for i in range(60)]
    for i in ids:
        dst.upload(f"db/{i}/part-00000.enc", b"x", upsert=True)
        dst.upload(f"db/{i}/manifest.json.enc", b"m", upsert=True)
    stale_incomplete = bs.export_id_for(start + timedelta(days=10, hours=1))
    fresh_incomplete = bs.export_id_for(start + timedelta(days=59, hours=1))
    dst.upload(f"db/{stale_incomplete}/part-00000.enc", b"x", upsert=True)
    dst.upload(f"db/{fresh_incomplete}/part-00000.enc", b"x", upsert=True)
    dst.upload("db/README/notes.txt", b"not an export", upsert=True)
    now = start + timedelta(days=59, hours=2)
    res = bs.prune_db_exports(dst, now=now, protect={ids[-1]})
    complete, incomplete = bs.list_db_exports(dst)
    # newest 30 = Jan 31 .. Mar 1 (holds Feb 1 and Mar 1) + Jan 1 as a monthly
    assert len(complete) == 31 and set(ids[-30:]) | {ids[0]} == set(complete)
    assert stale_incomplete not in incomplete and fresh_incomplete in incomplete
    assert dst.download("db/README/notes.txt") == b"not an export"
    assert res["exports_deleted"] == (60 - 31) + 1          # + the stale incomplete one


# ── single run, never raises, recorded ──────────────────────────────────

class _GatedBucket:
    """Blocks inside the first storage call until released."""

    def __init__(self, inner):
        self.inner = inner
        self.entered = threading.Event()
        self.release = threading.Event()

    def download(self, key):
        self.entered.set()
        assert self.release.wait(10)
        return self.inner.download(key)

    def __getattr__(self, name):
        return getattr(self.inner, name)


def test_single_run_lock(fernet, db_env, buckets):
    src, dst = buckets
    _put(src, f"{UID_A}/expense/{'a' * 64}.jpg", _photo(1))
    gated = _GatedBucket(dst)
    results = {}
    t = threading.Thread(target=lambda: results.setdefault(
        "first", _run(fernet, db_env, buckets, dst=gated)))
    t.start()
    assert gated.entered.wait(10)
    second = _run(fernet, db_env, buckets)
    assert second == {"status": "skipped_locked"}
    gated.release.set()
    t.join(20)
    assert results["first"]["status"] == "ok", results["first"]["errors"]
    assert _run(fernet, db_env, buckets, now=NOW + timedelta(days=1))["status"] == "ok"


class _BrokenBucket:
    def __getattr__(self, name):
        def boom(*a, **k):
            raise BackupStorageError(f"{name} -> HTTP 500: apikey={SERVICE_KEY} rejected")
        return boom


def test_job_never_raises_and_records_failure_without_secrets(fernet, key, db_env, buckets, caplog):
    src, _ = buckets
    _put(src, f"{UID_A}/expense/{'a' * 64}.jpg", _photo(1))
    _, Session = db_env
    out = _run(fernet, db_env, buckets, key=key, dst=_BrokenBucket())
    assert out["status"] == "failed" and out["errors"]
    st = _rows(Session, MonitorState)[0]
    assert st.service == "nightly_backup" and st.state == "BROKEN" and st.fail_streak == 1
    errs = [r for r in _rows(Session, ErrorLog) if r.error_type == "backup:failed"]
    assert len(errs) == 1 and errs[0].method == "JOB"
    for blob in (st.last_summary, errs[0].message, json.dumps(out), caplog.text):
        assert SERVICE_KEY not in blob and key not in blob

    # recovery resets the streak; no new ErrorLog row
    out = _run(fernet, db_env, buckets, key=key, now=NOW + timedelta(days=1))
    assert out["status"] == "ok", out["errors"]
    st = _rows(Session, MonitorState)[0]
    assert st.state == "HEALTHY" and st.fail_streak == 0 and st.broken_since is None
    summary = json.loads(st.last_summary)
    assert summary["photos"]["copied"] == 1 and summary["db"]["verified"] is True
    assert summary["duration_s"] >= 0
    assert len([r for r in _rows(Session, ErrorLog) if r.error_type == "backup:failed"]) == 1


def test_run_deadline_aborts_cleanly(fernet, db_env, buckets):
    src, _ = buckets
    _put(src, f"{UID_A}/expense/{'a' * 64}.jpg", _photo(1))
    out = _run(fernet, db_env, buckets, deadline_seconds=-1)
    assert out["status"] == "failed"
    assert any("deadline" in e for e in out["errors"])


# ── restore script: photos + safety ──────────────────────────────────────

def test_restore_photos_to_directory(fernet, key, db_env, buckets, tmp_path):
    src, dst = buckets
    paths = [f"{UID_A}/expense/{'a' * 64}.jpg", f"{UID_B}/kasserapport/{'b' * 64}.jpg"]
    for i, p in enumerate(paths):
        _put(src, p, _photo(i, 4000))
    _run(fernet, db_env, buckets)
    target = tmp_path / "restored"
    rc = restore.main(["--skip-db", "--photos-target-dir", str(target), "--source-dir", str(dst.root)],
                      env={"BACKUP_ENCRYPTION_KEY": key})
    assert rc == 0
    for p in paths:
        assert (target / "receipts" / p).read_bytes() == src.download(p)


def test_restore_refuses_production_and_unconfirmed_targets(fernet, key, db_env, buckets):
    _, dst = buckets
    _run(fernet, db_env, buckets)
    env = {"BACKUP_ENCRYPTION_KEY": key}
    prod = "postgresql://postgres.ahlqhztujpeccmaivkhr:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"
    args = restore.build_parser().parse_args(["--db-target", prod, "--source-dir", str(dst.root)])
    res = restore.run_db(dst, fernet, args, env)
    assert not res["ok"] and "refused" in res["error"]
    live = "postgresql://u:p@db.internal:5432/app"
    args = restore.build_parser().parse_args(["--db-target", live])
    res = restore.run_db(dst, fernet, args, {**env, "DATABASE_URL": live})
    assert not res["ok"] and "DATABASE_URL" in res["error"]
    # nothing to write and no --dry-run → refuse
    assert restore.main(["--source-dir", str(dst.root)], env=env) == 1


# ── wiring ───────────────────────────────────────────────────────────────

def test_scheduler_registers_nightly_backup():
    from apscheduler.schedulers.background import BackgroundScheduler
    sched = BackgroundScheduler()          # never started
    bs.register_backup_job(sched)
    job = sched.get_job("nightly_backup")
    assert job is not None and job.func is bs.run_nightly_backup
    assert job.coalesce is True and job.max_instances == 1
    assert job.misfire_grace_time >= 3600
    fields = {f.name: str(f) for f in job.trigger.fields}
    assert (fields["hour"], fields["minute"]) == ("4", "20")
    assert str(job.trigger.timezone) == "UTC"
    # …and the app registers it before it starts the scheduler. (Not via
    # main._scheduler: any `with TestClient(app)` earlier in the run shuts the
    # scheduler down at lifespan exit, which empties its job store.)
    src = (Path(__file__).resolve().parents[1] / "app/main.py").read_text(encoding="utf-8")
    assert 0 < src.index("register_backup_job(_scheduler)") < src.index("\n    _scheduler.start()\n")


def test_admin_backup_health(fernet, db_env, buckets, monkeypatch):
    from fastapi.testclient import TestClient
    from app.database import get_db
    from app.main import app, _db_ready
    from app.services.admin_security import require_super_admin
    _db_ready.set()
    engine, Session = db_env

    def _get_db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[require_super_admin] = lambda: None
    monkeypatch.setattr(bs, "settings", _settings())
    try:
        c = TestClient(app)
        r = c.get("/api/admin/backup-health")
        assert r.status_code == 200
        assert r.json()["state"] == "NEVER_RUN" and r.json()["config"]["status"] == "disabled"
        from app.utils.time import utc_now
        _run(fernet, db_env, buckets, now=utc_now().replace(microsecond=0))
        body = c.get("/api/admin/backup-health").json()
        assert body["state"] == "HEALTHY" and body["healthy"] is True and body["stale"] is False
        assert body["last_run"]["db"]["verified"] is True
        monkeypatch.setattr(bs, "settings", _settings(BACKUP_SUPABASE_SERVICE_KEY=SERVICE_KEY))
        body = c.get("/api/admin/backup-health").json()
        assert body["config"]["status"] == "misconfigured"
        assert SERVICE_KEY not in json.dumps(body)
    finally:
        app.dependency_overrides.clear()


# ── the real Supabase client, against a mocked Storage API ──────────────

class _FakeStorageAPI:
    """Just enough of Supabase Storage's REST API (list / get / upload /
    bulk delete) to drive SupabaseBucket through httpx.MockTransport."""

    def __init__(self, key):
        self.key = key
        self.buckets: dict[str, dict[str, bytes]] = {"receipts": {}, "bonbox-backup": {}}
        self.requests: list = []

    def __call__(self, request):
        import httpx
        self.requests.append(request)
        assert request.headers["apikey"] == self.key
        assert request.headers["authorization"] == f"Bearer {self.key}"
        path = request.url.path
        assert path.startswith("/storage/v1/object")
        rest = path[len("/storage/v1/object"):]

        def missing_bucket():
            return httpx.Response(400, json={"statusCode": "404", "error": "Bucket not found",
                                             "message": "Bucket not found"})

        if request.method == "POST" and rest.startswith("/list/"):
            b = rest[len("/list/"):]
            if b not in self.buckets:
                return missing_bucket()
            body = json.loads(request.content)
            prefix = body["prefix"].strip("/")
            items = {}
            for k, v in self.buckets[b].items():
                if prefix and not k.startswith(prefix + "/"):
                    continue
                tail = k[len(prefix) + 1:] if prefix else k
                head, _, more = tail.partition("/")
                if more:
                    items[head] = {"name": head, "id": None, "metadata": None}
                else:
                    items[head] = {"name": head, "id": str(uuid.uuid4()),
                                   "created_at": "2026-10-01T10:00:00.000Z",
                                   "updated_at": "2026-10-01T10:00:00.000Z",
                                   "metadata": {"size": len(v),
                                                "eTag": '"' + hashlib.md5(v).hexdigest() + '"'}}
            ordered = [items[n] for n in sorted(items)]
            return httpx.Response(200, json=ordered[body["offset"]:body["offset"] + body["limit"]])
        if request.method == "DELETE":
            b = rest.strip("/")
            for k in json.loads(request.content)["prefixes"]:
                self.buckets[b].pop(k, None)
            return httpx.Response(200, json=[])
        b, _, key = rest.strip("/").partition("/")
        if b not in self.buckets:
            return missing_bucket()
        if request.method == "GET":
            if key not in self.buckets[b]:
                return httpx.Response(400, json={"statusCode": "404", "error": "not_found",
                                                 "message": "Object not found"})
            return httpx.Response(200, content=self.buckets[b][key])
        if request.method == "POST":
            if key in self.buckets[b] and request.headers.get("x-upsert") != "true":
                return httpx.Response(400, json={"statusCode": "409", "error": "Duplicate",
                                                 "message": "The resource already exists"})
            self.buckets[b][key] = request.read()
            return httpx.Response(200, json={"Key": f"{b}/{key}"})
        return httpx.Response(405)


def test_supabase_bucket_client_against_mock_api(fernet, monkeypatch):
    import httpx
    from app.services import backup_storage
    from app.services.backup_storage import ObjectExistsError, SupabaseBucket
    monkeypatch.setattr(backup_storage, "LIST_PAGE", 2)          # force pagination
    api = _FakeStorageAPI(SERVICE_KEY)
    client = httpx.Client(transport=httpx.MockTransport(api))
    src = SupabaseBucket("https://main.example.co", SERVICE_KEY, "receipts", client=client)
    dst = SupabaseBucket("https://backup.example.co", SERVICE_KEY, "bonbox-backup", client=client)
    paths = [f"{UID_A}/expense/{c * 64}.jpg" for c in "abc"] + [f"{UID_B}/sale/{'d' * 64}.jpg"]
    for i, p in enumerate(paths):
        api.buckets["receipts"][p] = _photo(i)

    listed = src.list_all()
    assert sorted(o.key for o in listed) == sorted(paths)
    assert all(o.size == len(_photo(0)) and o.etag and o.created_at == datetime(2026, 10, 1, 10) for o in listed)
    assert src.download("nope/x.jpg") is None
    with pytest.raises(BackupStorageError):
        SupabaseBucket("https://x.co", SERVICE_KEY, "gone", client=client).download("a")
    with pytest.raises(BackupStorageError):
        SupabaseBucket("https://x.co", SERVICE_KEY, "gone", client=client).list_all()

    stats = bs.mirror_photos({"receipts": src}, dst, fernet, now=NOW, tombstones={})
    assert stats["copied"] == 4 and stats["errors"] == [], stats["errors"]
    stats = bs.mirror_photos({"receipts": src}, dst, fernet, now=NOW, tombstones={})
    assert (stats["copied"], stats["unchanged"]) == (0, 4)

    # streamed part upload: explicit Content-Length, never chunked
    api.requests.clear()
    dst.upload_file("db/x/part-00000.enc", io.BytesIO(b"p" * 3_000_000), 3_000_000, upsert=False)
    req = api.requests[-1]
    assert req.headers["content-length"] == "3000000"
    assert "transfer-encoding" not in req.headers
    assert api.buckets["bonbox-backup"]["db/x/part-00000.enc"] == b"p" * 3_000_000
    with pytest.raises(ObjectExistsError) as e:
        dst.upload("db/x/part-00000.enc", b"again", upsert=False)
    assert SERVICE_KEY not in str(e.value)
    sink = io.BytesIO()
    assert dst.download_to("db/x/part-00000.enc", sink) and sink.getvalue() == b"p" * 3_000_000
    assert dst.download_to("db/x/missing.enc", io.BytesIO()) is False
    dst.delete_many(["db/x/part-00000.enc"])
    assert "db/x/part-00000.enc" not in api.buckets["bonbox-backup"]


def test_mass_deletion_in_source_raises_an_alarm(fernet, db_env, buckets):
    src, dst = buckets
    paths = [f"{UID_A}/expense/{i:064x}.jpg" for i in range(12)]
    for i, p in enumerate(paths):
        _put(src, p, _photo(i, 64))
    assert _run(fernet, db_env, buckets)["status"] == "ok"
    src.delete_many(paths)
    out = _run(fernet, db_env, buckets, now=NOW + timedelta(days=1))
    assert out["status"] == "failed"
    assert any("mass deletion" in e for e in out["errors"])
    assert len(_manifest(dst, fernet)["entries"]) == 12      # copies kept


def test_restore_photos_into_a_bucket_never_overwrites(fernet, key, db_env, buckets, monkeypatch):
    """A wiped receipts bucket: photos go back (only with --allow-main-project
    for the main project) and an object already there is never replaced."""
    import httpx
    from app.services.backup_storage import SupabaseBucket
    src, dst = buckets
    paths = [f"{UID_A}/expense/{'a' * 64}.jpg", f"{UID_A}/sale/{'b' * 64}.jpg"]
    for i, p in enumerate(paths):
        _put(src, p, _photo(i))
    _run(fernet, db_env, buckets)

    api = _FakeStorageAPI("target-key")
    api.buckets["receipts"][paths[0]] = b"already here"
    real_init = SupabaseBucket.__init__
    monkeypatch.setattr(SupabaseBucket, "__init__", lambda self, url, k, b, **kw: real_init(
        self, url, k, b, client=httpx.Client(transport=httpx.MockTransport(api))))
    env = {"BACKUP_ENCRYPTION_KEY": key,
           "RESTORE_TARGET_SUPABASE_URL": "https://ahlqhztujpeccmaivkhr.supabase.co",
           "RESTORE_TARGET_SUPABASE_SERVICE_KEY": "target-key"}
    base = ["--skip-db", "--source-dir", str(dst.root), "--photos-target-bucket", "receipts"]
    assert restore.main(base + ["--confirm-target", "receipts"], env=env) == 1     # main project
    assert restore.main(base + ["--allow-main-project"], env=env) == 1             # unconfirmed
    assert paths[1] not in api.buckets["receipts"]
    assert restore.main(base + ["--allow-main-project", "--confirm-target", "receipts"], env=env) == 0
    assert api.buckets["receipts"][paths[0]] == b"already here"
    assert api.buckets["receipts"][paths[1]] == src.download(paths[1])
