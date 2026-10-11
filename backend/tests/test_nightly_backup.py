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
  • alerts (operator email + push): a failure once per incident, one
    recovery note, a stale watch, every mass deletion — counts and kinds
    only, never paths, ids or secrets; the 88-day cut runs every night

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


def test_export_retention_makes_backups_expire_as_privacy_says():
    """/privacy (push 3, EN + DA): "Copies in our backups disappear when those
    backups expire" — and no number of days. A DB export cannot be edited to
    drop one account, so every export must expire: none may outlive
    DB_MAX_AGE (kept below the 90 days the old text named), whatever the
    nightly/monthly counts say."""
    root = Path(__file__).resolve().parents[2]
    page = (root / "frontend/src/pages/PrivacyPolicyPage.jsx").read_text(encoding="utf-8")
    assert "Copies in our backups disappear when those backups expire." in page
    assert "Kopier i vores sikkerhedskopier forsvinder, når sikkerhedskopierne udløber." in page
    # push 3 took the number out; the backup must not bring one back
    assert "Backups are purged within 90 days" not in page
    assert "Sikkerhedskopier slettes inden for 90 dage" not in page
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
    watch = sched.get_job("nightly_backup_watch")
    assert watch is not None and watch.func is bs.check_backup_staleness
    assert watch.max_instances == 1 and watch.coalesce is True
    wf = {f.name: str(f) for f in watch.trigger.fields}
    assert (wf["hour"], wf["minute"]) == ("*", "50")          # hourly
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
    # Like production: every model app.main registers exists before the run
    # (the nightly export reports any app table it does not find).
    Base.metadata.create_all(engine)

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
        assert body["alarms"] == [] and body["alerted_at"] is None
        assert body["bucket"] == {"private": None, "error": None}      # backup off: not checked
        assert body["last_run"]["bucket_private"] is True               # the run checked its bucket
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
        self.public: dict[str, bool] = {"receipts": False, "bonbox-backup": False}
        self.page_cap: int | None = None     # a server that returns fewer than `limit`
        self.content_types: dict[tuple[str, str], str | None] = {}
        self.requests: list = []

    def __call__(self, request):
        import httpx
        self.requests.append(request)
        assert request.headers["apikey"] == self.key
        assert request.headers["authorization"] == f"Bearer {self.key}"
        path = request.url.path
        if request.method == "GET" and path.startswith("/storage/v1/bucket/"):
            b = path[len("/storage/v1/bucket/"):]
            if b not in self.buckets:
                return httpx.Response(400, json={"statusCode": "404", "error": "Bucket not found",
                                                 "message": "Bucket not found"})
            return httpx.Response(200, json={"id": b, "name": b, "public": self.public[b]})
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
            limit = min(body["limit"], self.page_cap or body["limit"])
            return httpx.Response(200, json=ordered[body["offset"]:body["offset"] + limit])
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
            self.content_types[(b, key)] = request.headers.get("content-type")
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
    # put back with the type its extension names, as the app stored it
    assert api.content_types[("receipts", paths[1])] == "image/jpeg"


# ── review fixes (Oct 11): listing, bucket privacy, limits, config ──────

def test_listing_pages_until_an_empty_page(fernet):
    """A server that returns fewer items than asked for (a page-size cap
    below LIST_PAGE) must not end the listing early — every unlisted object
    would look deleted in the source."""
    import httpx
    from app.services.backup_storage import LIST_PAGE, SupabaseBucket
    api = _FakeStorageAPI(SERVICE_KEY)
    api.page_cap = 3
    assert LIST_PAGE > api.page_cap
    client = httpx.Client(transport=httpx.MockTransport(api))
    src = SupabaseBucket("https://main.example.co", SERVICE_KEY, "receipts", client=client)
    paths = [f"{UID_A}/expense/{i:064x}.jpg" for i in range(8)] + [f"{UID_B}/sale/{'e' * 64}.jpg"]
    for i, p in enumerate(paths):
        api.buckets["receipts"][p] = _photo(i, 64)
    assert sorted(o.key for o in src.list_all()) == sorted(paths)
    assert len(src.list_files(f"{UID_A}/expense")) == 8


def test_backup_bucket_must_be_private(fernet, db_env, buckets):
    """Reported, never a reason to stop: a PUBLIC bucket fails the run (and
    alerts) but tonight's backup still lands; a check that cannot be made is
    'unknown', never 'private'."""
    import httpx
    from app.services.backup_storage import SupabaseBucket
    api = _FakeStorageAPI(SERVICE_KEY)
    client = httpx.Client(transport=httpx.MockTransport(api))
    bucket = SupabaseBucket("https://backup.example.co", SERVICE_KEY, "bonbox-backup", client=client)
    assert bucket.bucket_public() is False
    api.public["bonbox-backup"] = True
    assert bucket.bucket_public() is True
    with pytest.raises(BackupStorageError):
        SupabaseBucket("https://backup.example.co", SERVICE_KEY, "gone", client=client).bucket_public()
    cfg = _cfg(fernet)
    api.public["bonbox-backup"] = False
    assert bs.bucket_privacy(cfg, client=client) == {"private": True, "error": None}
    api.public["bonbox-backup"] = True
    assert bs.bucket_privacy(cfg, client=client) == {"private": False, "error": None}
    gone = bs.BackupConfig(**{**cfg.__dict__, "bucket": "gone"})
    res = bs.bucket_privacy(gone, client=client)
    assert res["private"] is None and res["error"] and SERVICE_KEY not in res["error"]

    src, dst = buckets
    _put(src, f"{UID_A}/expense/{'a' * 64}.jpg", _photo(1))

    class _Public(LocalDirBucket):
        def bucket_public(self):
            return True

    out = _run(fernet, db_env, buckets, dst=_Public(dst.root))
    assert out["status"] == "failed" and out["bucket_private"] is False
    assert out["error_kinds"].get("bucket:public") == 1
    assert out["db"]["ok"] and out["photos"]["copied"] == 1      # the backup still landed

    class _Unknown(LocalDirBucket):
        def bucket_public(self):
            raise BackupStorageError(f"bucket info -> HTTP 403: key {SERVICE_KEY}")

    out = _run(fernet, db_env, buckets, dst=_Unknown(dst.root), now=NOW + timedelta(days=1))
    assert out["status"] == "ok", out["errors"]
    assert out["bucket_private"] is None and SERVICE_KEY not in out["bucket_check"]


def test_object_size_limit_is_25_mb(fernet, db_env, buckets):
    """Uploads are capped at 12 MB; one object is held in memory to hash and
    encrypt it, so anything over 25 MB is reported, not copied."""
    assert bs.MAX_OBJECT_BYTES == 25 * 1024 * 1024
    src, dst = buckets
    big = src.root / UID_A / "expense" / f"{'f' * 64}.jpg"
    big.parent.mkdir(parents=True)
    with big.open("wb") as f:
        f.truncate(bs.MAX_OBJECT_BYTES + 1)            # sparse: no real 25 MB write
    out = _run(fernet, db_env, buckets)
    assert out["status"] == "failed" and out["error_kinds"] == {"photos:too_large": 1}
    assert out["photos"]["copied"] == 0


def test_backup_key_must_not_be_the_main_projects_key(key):
    cfg = bs.load_config(_settings(BACKUP_SUPABASE_URL="https://backup.supabase.co",
                                   BACKUP_SUPABASE_SERVICE_KEY="mainkey", BACKUP_ENCRYPTION_KEY=key))
    assert cfg.status == "misconfigured"
    assert any("equals SUPABASE_SERVICE_KEY" in p for p in cfg.problems)
    assert not any("mainkey" in p for p in cfg.problems)


def test_export_reports_app_tables_it_does_not_hold(fernet, db_env, buckets):
    """The nightly run checks the export holds every app model table (a wrong
    search_path would export the wrong tables while looking complete). A gap
    fails the run and alerts — but the export itself still lands."""
    out = _run(fernet, db_env, buckets, expect_tables=frozenset({"users", "no_such_table"}))
    assert out["status"] == "failed"
    assert out["error_kinds"] == {"db:missing_tables": 1}
    assert any("no_such_table" in e for e in out["errors"])
    assert out["db"]["ok"] and out["db"]["missing_tables"] == ["no_such_table"]
    _, dst = buckets
    complete, _ = bs.list_db_exports(dst)
    assert complete == [out["db"]["export_id"]]
    man = bs.load_export_manifest(dst, complete[0], fernet)
    assert man["missing_tables"] == ["no_such_table"]
    # the default is every model the app registered
    assert {"users", "erasure_tombstones", "monitor_state"} <= bs.app_table_names()


# ── review fixes (Oct 11): the 88-day cut runs every night ──────────────

def test_old_exports_expire_even_when_tonights_export_fails(fernet, db_env, buckets, monkeypatch):
    """/privacy: copies disappear when the backups expire. If the export
    fails night after night, the exports older than DB_MAX_AGE must still
    go — but the count-based thinning waits for a night with a new export."""
    _, dst = buckets
    ages = [120, 100, 89, 87, 60, 40, 1]
    ids = [bs.export_id_for(NOW - timedelta(days=d)) for d in ages]
    for i in ids:
        dst.upload(f"db/{i}/part-00000.enc", b"x", upsert=True)
        dst.upload(f"db/{i}/manifest.json.enc", b"m", upsert=True)

    def boom(*a, **k):
        raise RuntimeError("database unreachable")

    monkeypatch.setattr(bs, "export_db_to_backup", boom)
    out = _run(fernet, db_env, buckets)
    assert out["status"] == "failed" and out["error_kinds"].get("db:RuntimeError") == 1
    complete, _ = bs.list_db_exports(dst)
    assert sorted(complete) == sorted(ids[3:])                 # 87 days and younger stay
    assert out["retention"]["exports_deleted"] == 3

    # age_only never thins by count: 40 young exports all stay
    many = [bs.export_id_for(NOW - timedelta(days=d, hours=1)) for d in range(40)]
    for i in many:
        dst.upload(f"db/{i}/manifest.json.enc", b"m", upsert=True)
    res = bs.prune_db_exports(dst, now=NOW, protect=set(), age_only=True)
    assert res["exports_deleted"] == 0
    res = bs.prune_db_exports(dst, now=NOW, protect=set())
    assert res["exports_deleted"] > 0                           # a good night thins them


# ── review fixes (Oct 11): operator alerts, once per incident ───────────

@pytest.fixture
def alerts(monkeypatch):
    sent = []
    monkeypatch.setattr(bs, "_notify", lambda db, subject, lines, title, body:
                        sent.append({"subject": subject, "lines": lines, "title": title, "body": body}))
    return sent


def _alert_text(a) -> str:
    return "\n".join([a["subject"], *a["lines"], a["title"], a["body"]])


def test_failure_alerts_once_per_incident_then_one_recovery_note(fernet, key, db_env, buckets, alerts):
    src, _ = buckets
    _put(src, f"{UID_A}/expense/{'a' * 64}.jpg", _photo(1))
    _, Session = db_env
    for day in range(3):                                     # three failed nights …
        out = _run(fernet, db_env, buckets, key=key, dst=_BrokenBucket(), now=NOW + timedelta(days=day))
        assert out["status"] == "failed"
    assert len(alerts) == 1                                  # … one alert
    a = alerts[0]
    assert a["subject"] == "BonBox: nightly backup FAILED"
    text = _alert_text(a)
    for line in ("  - db:BackupStorageError: 1", "  - photos:BackupStorageError: 1",
                 "  - retention:BackupStorageError: 1"):
        assert line in a["lines"], a["lines"]
    # no personal data, no paths, no secrets in an alert
    for bad in (UID_A, "expense/", "a" * 64, SERVICE_KEY, key):
        assert bad not in text
    st = _rows(Session, MonitorState)[0]
    assert st.last_alert_at is not None and st.incident_entry == "failed" and st.fail_streak == 3

    out = _run(fernet, db_env, buckets, key=key, now=NOW + timedelta(days=3))
    assert out["status"] == "ok", out["errors"]
    assert len(alerts) == 2 and alerts[1]["subject"] == "BonBox: nightly backup recovered"
    st = _rows(Session, MonitorState)[0]
    assert st.last_alert_at is None and st.incident_entry is None
    _run(fernet, db_env, buckets, key=key, now=NOW + timedelta(days=4))
    assert len(alerts) == 2                                  # healthy nights are quiet

    # a new failure is a new incident
    _run(fernet, db_env, buckets, key=key, dst=_BrokenBucket(), now=NOW + timedelta(days=5))
    assert len(alerts) == 3 and alerts[2]["subject"] == "BonBox: nightly backup FAILED"


def test_misconfiguration_alerts_once_by_variable_name(db_env, monkeypatch, key, alerts):
    engine, Session = db_env
    monkeypatch.setattr(bs, "settings", _settings(BACKUP_SUPABASE_SERVICE_KEY=SERVICE_KEY))
    for _ in range(2):
        out = bs.run_nightly_backup(engine=engine, session_factory=Session, dst=_ExplodingBucket())
        assert out["status"] == "failed"
    assert len(alerts) == 1
    text = _alert_text(alerts[0])
    assert "BACKUP_ENCRYPTION_KEY is not set" in text and SERVICE_KEY not in text


def test_mass_deletion_alerts_every_time_and_stays_listed_30_days(fernet, db_env, buckets, alerts):
    src, dst = buckets
    paths = [f"{UID_A}/expense/{i:064x}.jpg" for i in range(12)]
    others = [f"{UID_B}/sale/{i:064x}.jpg" for i in range(12)]
    for i, p in enumerate(paths + others):
        _put(src, p, _photo(i, 64))
    assert _run(fernet, db_env, buckets)["status"] == "ok"
    assert alerts == []

    src.delete_many(paths)
    _run(fernet, db_env, buckets, now=NOW + timedelta(days=1))
    assert len(alerts) == 1
    text = _alert_text(alerts[0])
    assert alerts[0]["subject"].startswith("BonBox: MASS DELETION")
    assert "12 of 24 backed-up files disappeared from the source bucket 'receipts'" in text
    assert "nightly off-project backup FAILED" in text          # one mail for both
    assert UID_A not in text and "expense/" not in text

    # the incident is open (no recovery yet): a second mass deletion still alerts
    src.delete_many(others)
    _run(fernet, db_env, buckets, now=NOW + timedelta(days=2))
    assert len(alerts) == 2 and "MASS DELETION" in alerts[1]["subject"]
    assert "nightly off-project backup FAILED" not in _alert_text(alerts[1])

    # it does not vanish after one night: listed until DELETED_GRACE runs out
    out = _run(fernet, db_env, buckets, now=NOW + timedelta(days=3))
    assert out["status"] == "ok", out["errors"]
    assert [a["gone"] for a in out["alarms"]] == [12, 12]
    out = _run(fernet, db_env, buckets, now=NOW + timedelta(days=31, hours=1))
    assert [a["gone"] for a in out["alarms"]] == [12]           # the first one aged out
    out = _run(fernet, db_env, buckets, now=NOW + timedelta(days=33))
    assert out["alarms"] == []


def test_an_erased_accounts_files_vanishing_is_no_mass_deletion(fernet, db_env, buckets, alerts):
    """Account deletion purges the no-legal-basis kinds from the source at
    once; those files going is expected and must not page anyone."""
    src, _ = buckets
    _, Session = db_env
    paths = [f"{UID_A}/staff_avatar/{i:064x}.jpg" for i in range(12)]
    for i, p in enumerate(paths + [f"{UID_B}/sale/{'c' * 64}.jpg"]):
        _put(src, p, _photo(i, 64))
    assert _run(fernet, db_env, buckets)["status"] == "ok"
    src.delete_many(paths)
    _tombstone(Session, UID_A, NOW + timedelta(hours=1))
    out = _run(fernet, db_env, buckets, now=NOW + timedelta(days=1))
    assert out["status"] == "ok", out["errors"]
    assert out["photos"]["mass_deletions"] == [] and alerts == []


def test_stale_watch_alerts_once(fernet, db_env, buckets, alerts, monkeypatch):
    engine, Session = db_env
    cfg = _cfg(fernet)
    assert bs.check_backup_staleness(cfg=cfg, session_factory=Session)["status"] == "never_run"
    assert bs.check_backup_staleness(cfg=bs.BackupConfig(status="disabled"),
                                     session_factory=Session)["status"] == "disabled"
    _run(fernet, db_env, buckets)
    st = _rows(Session, MonitorState)[0]
    last = st.last_check_at
    assert bs.check_backup_staleness(cfg=cfg, session_factory=Session,
                                     now=last + timedelta(hours=25))["status"] == "fresh"
    with bs._process_lock:                                   # a run in progress here
        assert bs.check_backup_staleness(cfg=cfg, session_factory=Session,
                                         now=last + timedelta(hours=30))["status"] == "running"
    assert alerts == []
    res = bs.check_backup_staleness(cfg=cfg, session_factory=Session, now=last + timedelta(hours=27))
    assert res == {"status": "stale", "alerted": True, "hours": 27}
    assert len(alerts) == 1 and alerts[0]["subject"] == "BonBox: nightly backup has not run"
    for h in (28, 40, 70):                                   # hourly, still stale: quiet
        bs.check_backup_staleness(cfg=cfg, session_factory=Session, now=last + timedelta(hours=h))
    assert len(alerts) == 1
    st = _rows(Session, MonitorState)[0]
    assert st.state == "BROKEN" and st.incident_entry == "stale"
    # a failed run inside the open incident: no second alert …
    _run(fernet, db_env, buckets, dst=_BrokenBucket(), now=NOW + timedelta(days=3))
    assert len(alerts) == 1
    # … and the next good run closes it with one note
    assert _run(fernet, db_env, buckets, now=NOW + timedelta(days=4))["status"] == "ok"
    assert len(alerts) == 2 and alerts[1]["subject"] == "BonBox: nightly backup recovered"


def test_alerts_go_through_the_frontend_monitors_email_and_push(fernet, key, db_env, buckets, monkeypatch):
    """The real channel: jobs/frontend_monitor_job.notify_operators — the
    same operator email list and push devices as the prod-frontend alert."""
    import app.jobs.frontend_monitor_job as fmj
    from app.models.push_subscription import PushSubscription
    from app.models.user import User
    from app.services.auth import hash_password
    engine, Session = db_env
    Base.metadata.create_all(engine)
    s = Session()
    ops = User(id=uuid.uuid4(), email="ops@example.dk", password_hash=hash_password("pw123456"),
               business_name="Ops", business_type="cafe", currency="DKK", plan="free", role="owner")
    s.add(ops)
    s.flush()
    s.add(PushSubscription(user_id=ops.id, endpoint="https://push.example/1", p256dh="k", auth="a"))
    s.commit()
    s.close()
    monkeypatch.setattr(fmj.settings, "SUPER_ADMIN_EMAILS", "Ops@example.dk, ops@example.dk")
    monkeypatch.setattr(fmj.settings, "ADMIN_EMAIL", "")
    mails, pushes = [], []
    monkeypatch.setattr(fmj, "send_email", lambda to, subject, html: mails.append((to, subject, html)))
    monkeypatch.setattr(fmj, "send_to_subscription", lambda sub, payload: pushes.append(payload))

    src, _ = buckets
    _put(src, f"{UID_A}/expense/{'a' * 64}.jpg", _photo(1))
    _run(fernet, db_env, buckets, key=key, dst=_BrokenBucket())
    _run(fernet, db_env, buckets, key=key, dst=_BrokenBucket(), now=NOW + timedelta(days=1))
    assert len(mails) == 1 and len(pushes) == 1              # once, to one address
    to, subject, html = mails[0]
    assert to == "ops@example.dk" and subject == "BonBox: nightly backup FAILED"
    assert "backup-health" in html
    for bad in (UID_A, "a" * 64, SERVICE_KEY, key):
        assert bad not in html and bad not in json.dumps(pushes)
    assert pushes[0]["title"] == "BonBox: nightly backup FAILED"


# ── review fixes (Oct 11): a restore re-applies later erasures ──────────

def _user(uid, email, **kw):
    from app.models.user import User
    return User(id=uuid.UUID(uid) if isinstance(uid, str) else uid, email=email,
                password_hash="x", business_name=email.split("@")[0], business_type="cafe",
                currency="DKK", plan="free", role=kw.pop("role", "owner"), **kw)


def test_retained_tables_match_delete_account():
    """reapply_erasures keeps exactly the tables delete_account keeps."""
    import inspect as _inspect
    import re as _re
    from app.routers import auth as auth_router
    from app.services.backup_erasure import RETAINED_TABLES
    src = _inspect.getsource(auth_router.delete_account)
    m = _re.search(r"_ERASURE_RETAINED_TABLES\s*=\s*\{([^}]*)\}", src)
    assert m and set(_re.findall(r"[\"']([a-z_]+)[\"']", m.group(1))) == set(RETAINED_TABLES)


def test_tombstone_rows_parse_strictly():
    from app.services.backup_erasure import merge_tombstones, parse_tombstone_rows
    t = parse_tombstone_rows([{"user_id": UID_A.replace("-", "").upper(),
                               "erased_at": "2026-10-11 10:22:33.123456"},
                              (UID_B, datetime(2026, 10, 1, tzinfo=timezone.utc))])
    assert t == {UID_A: datetime(2026, 10, 11, 10, 22, 33, 123456), UID_B: datetime(2026, 10, 1)}
    assert merge_tombstones(t, {UID_A: datetime(2026, 1, 1)})[UID_A] == datetime(2026, 1, 1)
    for bad in ([{"user_id": "nope", "erased_at": "2026-10-11"}],
                [{"user_id": UID_A, "erased_at": ""}]):
        with pytest.raises(ValueError):
            parse_tombstone_rows(bad)


def test_reapply_erasures_erases_accounts_a_restore_brought_back(db_env):
    """The DB half of delete_account, again: the account's rows and its users
    row go, its team is unlinked (never erased), other pointers at it are
    cleared, the tombstone is written; other accounts are untouched. Dry run
    changes nothing; a second run changes nothing."""
    from app.models.category_mapping import CategoryMapping
    from app.models.feedback import Feedback
    from app.models.user import User
    from app.services.backup_erasure import reapply_erasures
    engine, Session = db_env
    member, invited = str(uuid.UUID(int=0xC)), str(uuid.UUID(int=0xD))
    s = Session()
    s.add_all([_user(UID_A, "a@example.dk"), _user(UID_B, "b@example.dk")])
    s.flush()
    s.add_all([_user(member, "m@example.dk", role="staff", owner_id=uuid.UUID(UID_A)),
               _user(invited, "i@example.dk", invited_by_user_id=uuid.UUID(UID_A))])
    s.add_all([Feedback(user_id=uuid.UUID(UID_A), rating=5, category="x", message="a"),
               Feedback(user_id=uuid.UUID(UID_B), rating=4, category="x", message="b"),
               CategoryMapping(user_id=uuid.UUID(UID_A), keyword="kaffe", category_name="Varer")])
    s.commit()
    s.close()
    tombstones = {UID_A: NOW}

    rep = reapply_erasures(engine, tombstones, dry_run=True)
    assert rep["accounts_in_target"] == 1 and rep["accounts_erased"] == 0
    assert len(_rows(Session, User)) == 4 and len(_rows(Session, Feedback)) == 2

    rep = reapply_erasures(engine, tombstones)
    assert (rep["accounts_erased"], rep["team_members_unlinked"], rep["user_refs_cleared"],
            rep["tombstones_written"], rep["tables_failed"]) == (1, 1, 1, 1, [])
    assert rep["rows_deleted"] >= 2
    users = {str(u.id): u for u in _rows(Session, User)}
    assert set(users) == {UID_B, member, invited}
    assert users[member].owner_id is None and users[member].role == "owner"   # unlinked, kept
    assert users[invited].invited_by_user_id is None
    assert [f.message for f in _rows(Session, Feedback)] == ["b"]
    assert _rows(Session, CategoryMapping) == []
    assert [(str(t.user_id), t.erased_at) for t in _rows(Session, ErasureTombstone)] == [(UID_A, NOW)]

    rep = reapply_erasures(engine, tombstones)
    assert (rep["accounts_erased"], rep["rows_deleted"], rep["tombstones_written"]) == (0, 0, 0)


def test_restore_reads_tombstones_from_the_newest_export(fernet, key, db_env, buckets):
    from app.services.backup_db import read_export_table
    _, Session = db_env
    src, dst = buckets
    _run(fernet, db_env, buckets)
    _tombstone(Session, UID_A, NOW + timedelta(hours=2))
    _run(fernet, db_env, buckets, now=NOW + timedelta(days=1))
    args = restore.build_parser().parse_args(["--dry-run", "--reapply-erasures",
                                              "--source-dir", str(dst.root)])
    ctx = {}
    out = restore.run_erasures(dst, fernet, args, {"BACKUP_ENCRYPTION_KEY": key}, ctx)
    assert out["ok"] and out["tombstones"] == 1
    assert list(out["sources"].values()) == [1]
    assert ctx["tombstones"] == {UID_A: NOW + timedelta(hours=2)}
    # an export without that table answers None, not "no tombstones"
    complete, _ = bs.list_db_exports(dst)
    man = bs.load_export_manifest(dst, complete[-1], fernet)
    with io.BytesIO() as enc:
        bs.fetch_export(dst, man["parts"], enc)
        enc.seek(0)
        assert read_export_table(DecryptingReader(enc, fernet), "no_such_table") is None


def test_photo_restore_leaves_out_erased_accounts_no_basis_files(fernet, key, db_env, buckets, tmp_path):
    """Erased after the last backup run (so the backup still holds the
    avatar): with --reapply-erasures the avatar is not put back; the
    accounting document is (6-year rule); other accounts are."""
    src, dst = buckets
    avatar = f"{UID_A}/staff_avatar/{'a' * 64}.jpg"
    receipt = f"{UID_A}/expense/{'b' * 64}.jpg"
    other = f"{UID_B}/sale/{'c' * 64}.jpg"
    for i, p in enumerate((avatar, receipt, other)):
        _put(src, p, _photo(i))
    _run(fernet, db_env, buckets)
    live = create_engine(f"sqlite:///{tmp_path / 'live.db'}")
    ErasureTombstone.__table__.create(live)
    with live.begin() as c:
        c.execute(ErasureTombstone.__table__.insert().values(user_id=uuid.UUID(UID_A),
                                                             erased_at=NOW + timedelta(hours=1)))
    live.dispose()
    env = {"BACKUP_ENCRYPTION_KEY": key, "ERASURE_SOURCE_DATABASE_URL": f"sqlite:///{tmp_path / 'live.db'}"}
    base = ["--skip-db", "--source-dir", str(dst.root)]

    target = tmp_path / "restored"
    assert restore.main(base + ["--reapply-erasures", "--photos-target-dir", str(target)], env=env) == 0
    assert not (target / "receipts" / avatar).exists()
    assert (target / "receipts" / receipt).read_bytes() == src.download(receipt)
    assert (target / "receipts" / other).read_bytes() == src.download(other)

    # without the option: everything, as before
    every = tmp_path / "every"
    assert restore.main(base + ["--photos-target-dir", str(every)], env=env) == 0
    assert (every / "receipts" / avatar).exists()

    # a tombstone source that cannot be read: photos are NOT restored
    broken = {**env, "ERASURE_SOURCE_DATABASE_URL": f"sqlite:///{tmp_path / 'missing' / 'x.db'}"}
    nothing = tmp_path / "nothing"
    assert restore.main(base + ["--reapply-erasures", "--photos-target-dir", str(nothing)],
                        env=broken) == 1
    assert not nothing.exists() or not any(nothing.rglob("*.jpg"))


def test_restore_takes_the_db_target_from_the_environment(fernet, key, db_env, buckets, capsys):
    """RESTORE_DB_TARGET_URL keeps the password out of shell history; it gets
    the same refusals as --db-target."""
    _, dst = buckets
    _run(fernet, db_env, buckets)
    base = ["--skip-photos", "--source-dir", str(dst.root)]
    prod = "postgresql://postgres.ahlqhztujpeccmaivkhr:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"
    env = {"BACKUP_ENCRYPTION_KEY": key, "RESTORE_DB_TARGET_URL": prod}
    assert restore.main(base, env=env) == 1
    assert "main production project" in capsys.readouterr().out
    live = "postgresql://u:secretpw@db.internal:5432/app"
    env = {"BACKUP_ENCRYPTION_KEY": key, "RESTORE_DB_TARGET_URL": live, "DATABASE_URL": live}
    assert restore.main(base + ["--reapply-erasures"], env=env) == 1
    out = capsys.readouterr().out
    assert "DATABASE_URL" in out and "secretpw" not in out


# ── /privacy: the backup project is a processor row (EN + DA) ───────────

def test_privacy_names_the_encrypted_backup_copy(key):
    """/privacy names the backup project (Supabase, Frankfurt) and says the
    copy is encrypted before it leaves BonBox. The code makes that true: the
    backup does not run at all without BACKUP_ENCRYPTION_KEY, and what lands
    in the backup bucket is ciphertext (test_incremental_copy_and_manifest).
    The frontend sibling is frontend/src/__tests__/backupPrivacyRow.test.jsx."""
    root = Path(__file__).resolve().parents[2]
    page = (root / "frontend/src/pages/PrivacyPolicyPage.jsx").read_text(encoding="utf-8")
    assert ('["Supabase", "Encrypted backup copy (database + receipt photos)", '
            '"EU (Germany, Frankfurt)", "All account and business data, encrypted before it '
            'leaves BonBox"]') in page
    assert ('["Supabase", "Krypteret sikkerhedskopi (database + kvitteringsbilleder)", '
            '"EU (Tyskland, Frankfurt)", "Alle konto- og virksomhedsdata, krypteret før de '
            'forlader BonBox"]') in page
    assert "BACKUP_ENCRYPTION_KEY" in bs.REQUIRED_ENV
    cfg = bs.load_config(_settings(BACKUP_SUPABASE_URL="https://backup.supabase.co",
                                   BACKUP_SUPABASE_SERVICE_KEY=SERVICE_KEY))
    assert cfg.status == "misconfigured" and "BACKUP_ENCRYPTION_KEY is not set" in cfg.problems


def test_photos_only_restore_reads_the_db_targets_tombstones_read_only(fernet, key, db_env, buckets,
                                                                       tmp_path):
    """After a DB restore + re-apply, the target holds every tombstone. A
    later photos-only run (--skip-db) with RESTORE_DB_TARGET_URL still set
    uses them, read-only: no DB --confirm-target needed, nothing written."""
    from app.models.user import User
    src, dst = buckets
    avatar = f"{UID_A}/staff_avatar/{'a' * 64}.jpg"
    other = f"{UID_B}/sale/{'c' * 64}.jpg"
    for i, p in enumerate((avatar, other)):
        _put(src, p, _photo(i))
    _run(fernet, db_env, buckets)
    target_db = tmp_path / "target.db"
    eng = create_engine(f"sqlite:///{target_db}")
    Base.metadata.create_all(eng)
    with eng.begin() as c:
        c.execute(ErasureTombstone.__table__.insert().values(user_id=uuid.UUID(UID_A), erased_at=NOW))
        c.execute(User.__table__.insert().values(id=uuid.UUID(UID_A), email="a@example.dk",
                                                 password_hash="x", business_name="A",
                                                 business_type="cafe", currency="DKK",
                                                 plan="free", role="owner"))
    env = {"BACKUP_ENCRYPTION_KEY": key, "RESTORE_DB_TARGET_URL": f"sqlite:///{target_db}"}
    target = tmp_path / "restored"
    assert restore.main(["--skip-db", "--reapply-erasures", "--source-dir", str(dst.root),
                         "--photos-target-dir", str(target)], env=env) == 0
    assert not (target / "receipts" / avatar).exists()
    assert (target / "receipts" / other).exists()
    with eng.connect() as c:                       # read only: the account row is untouched
        assert c.execute(text("SELECT count(*) FROM users")).scalar() == 1
    eng.dispose()


def test_a_run_that_cannot_be_recorded_still_alerts_once(fernet, db_env, buckets, alerts, monkeypatch):
    """Database unreachable when the run is saved: no incident row to say
    "already alerted", so the job mails once per process until a run is
    saved again — never every night."""
    engine, Session = db_env
    monkeypatch.setattr(bs, "_unrecorded_alerted", False)

    class _NoCommit:
        def __init__(self):
            self.s = Session()

        def commit(self):
            raise RuntimeError("database unreachable")

        def __getattr__(self, name):
            return getattr(self.s, name)

    for day in range(2):
        bs._record(_NoCommit, {"status": "failed", "error_kinds": {"db:OperationalError": 1},
                               "errors": [f"db: {UID_A}"]}, ok=False, error_type="backup:failed",
                   run_now=NOW + timedelta(days=day))
    assert len(alerts) == 1 and alerts[0]["subject"] == "BonBox: nightly backup could not be recorded"
    assert "  - db:OperationalError: 1" in alerts[0]["lines"] and UID_A not in _alert_text(alerts[0])
    # saved again → armed again
    assert _run(fernet, db_env, buckets)["status"] == "ok"
    bs._record(_NoCommit, {"status": "failed"}, ok=False, error_type="backup:failed")
    assert len(alerts) == 2
