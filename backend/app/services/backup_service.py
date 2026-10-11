"""Nightly off-project backup: receipt photos + a logical database export,
encrypted client-side, copied to a SEPARATE Supabase project.

Why: Supabase's own daily backups (Pro, 7 days, no PITR) live in the same
project and do NOT include Storage objects. A deleted bucket, a compromised
service key or a lost project takes the receipt photos — accounting source
documents under Bogføringsloven — with it. This job keeps a second copy in a
different project, under a key that project never sees.

OFF unless BACKUP_SUPABASE_URL, BACKUP_SUPABASE_SERVICE_KEY and
BACKUP_ENCRYPTION_KEY are all set (BACKUP_BUCKET defaults to "bonbox-backup").
Some-but-not-all set is a misconfiguration and is reported, not ignored.

One run (scheduled nightly in app/main.py; at most one at a time):
  1. Photos — incremental mirror of every object in the source bucket(s).
     Backup key = photos/<bucket>/<original path>.<sha256>.enc, so a changed
     object becomes a new version and nothing is overwritten. An encrypted
     manifest (manifest/photos.json.enc) records path, size, sha256, etag,
     copied_at and, once the source object is gone, source_deleted_at.
     Retention of copies whose source is gone:
       • ERASURE_PURGE_KINDS (no legal basis, e.g. staff_avatar): kept
         DELETED_GRACE (30 days, the same window as the nightly DB exports),
         and purged at once for an erased account (erasure_tombstones) —
         the Art.17 erasure reaches the backup within a night.
       • everything else (accounting source documents; unknown kinds are
         treated the same, like storage.ACCOUNTING_RETENTION_KINDS): kept
         until max(deleted + 30 days, source created + 6 years) — the same
         6-year window accounting_retention uses before it purges an erased
         account's documents — so an accidental or malicious deletion in the
         source never shortens the legal retention, and the end-of-retention
         purge reaches the backup 30 days later.
     Deletion is only inferred from a COMPLETE source listing; a failed
     listing marks nothing deleted.
  2. Database — backup_db.export_database (one consistent snapshot, per-table
     COPY), gzip + encrypted, streamed through a temp file in bounded memory,
     uploaded as db/<export id>/part-NNNNN.enc, re-downloaded and verified,
     then db/<export id>/manifest.json.enc marks it complete.
  3. Retention of exports: the newest DB_KEEP_NIGHTLY (30) plus the first
     export of each of the newest DB_KEEP_MONTHLY (12) months — but never an
     export older than DB_MAX_AGE (88 days), because /privacy promises that
     backups are purged within 90 days of an account deletion and a DB export
     cannot be edited to drop one account. Today that cap leaves 30 nightly
     + 2-3 monthly; raising it is a /privacy change first. Incomplete
     exports older than 2 days are removed. Pruning runs only after tonight's
     export succeeded.
Every run that does work writes a MonitorState row (service="nightly_backup")
with counts / bytes / duration / outcome, and on failure an ErrorLog row
(method="JOB") that /api/admin/recent-errors shows. It never raises.

Single run: a process lock plus, on Postgres, pg_try_advisory_xact_lock held
by an open transaction for the whole run (the pooler is in transaction mode,
so a session-level lock would not survive; a transaction-scoped one does and
is released if the process dies). The run heartbeats that connection and
aborts if it is lost.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import re
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Callable, Optional

from app.config import settings
from app.services.backup_crypto import (
    BackupConfigError,
    DecryptingReader,
    EncryptingWriter,
    decrypt_bytes,
    encrypt_bytes,
    load_backup_fernet,
)
from app.services.backup_db import export_database, verify_export_stream
from app.services.backup_storage import BackupStorageError, SupabaseBucket
from app.services.storage import ALLOWED_KINDS, ERASURE_PURGE_KINDS
from app.utils.time import utc_now

logger = logging.getLogger("bonbox.backup")

SERVICE = "nightly_backup"
REQUIRED_ENV = ("BACKUP_SUPABASE_URL", "BACKUP_SUPABASE_SERVICE_KEY", "BACKUP_ENCRYPTION_KEY")
DEFAULT_BUCKET = "bonbox-backup"

MANIFEST_KEY = "manifest/photos.json.enc"
PHOTO_PREFIX = "photos"
DB_PREFIX = "db"
DB_MANIFEST_NAME = "manifest.json.enc"

DB_KEEP_NIGHTLY = 30
DB_KEEP_MONTHLY = 12
# /privacy (EN + DA): "Backups are purged within 90 days" of account deletion.
# 88 days leaves room for the nightly cadence (an export is pruned on the first
# run after it ages out). Change ONLY together with the privacy text.
DB_MAX_AGE = timedelta(days=88)
DB_INCOMPLETE_MAX_AGE = timedelta(days=2)
DB_PART_BYTES = 32 << 20

DELETED_GRACE = timedelta(days=30)
# Same window as accounting_retention._purge_erased_account_blobs
# ((MIN_RETENTION_YEARS + 1) * 366 days).
ACCOUNTING_KEEP = timedelta(days=6 * 366)

MAX_OBJECT_BYTES = 100 << 20
MASS_DELETE_MIN = 10          # this many vanished objects in one night …
MASS_DELETE_SHARE = 0.2       # … and more than this share of them → alarm
VERIFY_SAMPLE = 3
RUN_DEADLINE_SECONDS = 45 * 60
HEARTBEAT_EVERY_SECONDS = 15
LOCK_KEY = "bonbox:nightly_backup"
LOCK_IDLE_TIMEOUT = "15min"

_EXPORT_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{6}Z$")
_PHOTO_KEY_RE = re.compile(r"^photos/(?P<bucket>[^/]+)/(?P<path>.+)\.(?P<sha>[0-9a-f]{64})\.enc$")
_BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}$")


class BackupAborted(RuntimeError):
    pass


# ── config ───────────────────────────────────────────────────────────────

@dataclass
class BackupConfig:
    status: str                       # "enabled" | "disabled" | "misconfigured"
    problems: list[str] = field(default_factory=list)
    url: str = ""
    service_key: str = field(default="", repr=False)
    bucket: str = DEFAULT_BUCKET
    fernet: object = field(default=None, repr=False)
    source_url: str = ""
    source_key: str = field(default="", repr=False)
    source_buckets: tuple[str, ...] = ()
    secrets: tuple[str, ...] = field(default=(), repr=False)


def _norm_url(u: str) -> str:
    return (u or "").strip().rstrip("/").lower()


def load_config(s=None) -> BackupConfig:
    """Read the BACKUP_* settings. Never logs or returns a secret in `problems`."""
    s = s or settings
    vals = {name: (getattr(s, name, "") or "").strip() for name in REQUIRED_ENV}
    previous = (getattr(s, "BACKUP_ENCRYPTION_KEY_PREVIOUS", "") or "").strip()
    bucket = (getattr(s, "BACKUP_BUCKET", "") or "").strip() or DEFAULT_BUCKET
    secrets = tuple(v for v in (vals["BACKUP_SUPABASE_SERVICE_KEY"], vals["BACKUP_ENCRYPTION_KEY"],
                                previous, (getattr(s, "SUPABASE_SERVICE_KEY", "") or "").strip())
                    if v)
    set_names = [n for n, v in vals.items() if v]
    if not set_names:
        return BackupConfig(status="disabled")
    problems = [f"{n} is not set" for n, v in vals.items() if not v]
    fernet = None
    if vals["BACKUP_ENCRYPTION_KEY"]:
        try:
            fernet = load_backup_fernet(vals["BACKUP_ENCRYPTION_KEY"], previous)
        except BackupConfigError as e:
            problems.append(str(e))
    if not _BUCKET_RE.match(bucket):
        problems.append("BACKUP_BUCKET is not a valid bucket name")
    url = vals["BACKUP_SUPABASE_URL"]
    if url and not url.startswith("https://"):
        problems.append("BACKUP_SUPABASE_URL must start with https://")
    main_url = (getattr(s, "SUPABASE_URL", "") or "").strip()
    if url and main_url and _norm_url(url) == _norm_url(main_url):
        problems.append("BACKUP_SUPABASE_URL points at the main project; the backup must "
                        "live in a separate project")
    if problems:
        return BackupConfig(status="misconfigured", problems=problems, secrets=secrets)
    source_bucket = (getattr(s, "SUPABASE_RECEIPTS_BUCKET", "") or "receipts").strip()
    return BackupConfig(
        status="enabled", url=url, service_key=vals["BACKUP_SUPABASE_SERVICE_KEY"],
        bucket=bucket, fernet=fernet,
        source_url=main_url, source_key=(getattr(s, "SUPABASE_SERVICE_KEY", "") or "").strip(),
        source_buckets=(source_bucket,), secrets=secrets,
    )


def config_status(s=None) -> dict:
    """Names-only view for the admin endpoint."""
    cfg = load_config(s)
    return {"status": cfg.status, "problems": cfg.problems,
            "bucket": cfg.bucket if cfg.status == "enabled" else None}


def _redact(msg, secrets: tuple[str, ...] = ()) -> str:
    text = str(msg)
    for sec in secrets:
        if sec and len(sec) >= 6:
            text = text.replace(sec, "***")
    return text[:300]


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


# ── single-run lock ──────────────────────────────────────────────────────

_process_lock = threading.Lock()


class RunLock:
    def __init__(self, acquired: bool, conn=None):
        self.acquired = acquired
        self._conn = conn
        self._last_beat = time.monotonic()

    def heartbeat(self, force: bool = False) -> None:
        if self._conn is None:
            return
        now = time.monotonic()
        if not force and now - self._last_beat < HEARTBEAT_EVERY_SECONDS:
            return
        from sqlalchemy import text
        try:
            self._conn.execute(text("SELECT 1"))
        except Exception as e:  # noqa: BLE001
            raise BackupAborted(f"lost the backup lock connection: {type(e).__name__}") from None
        self._last_beat = now


@contextmanager
def backup_run_lock(engine):
    """Yield a RunLock; .acquired is False when another run holds it."""
    plock = _process_lock
    if not plock.acquire(blocking=False):
        yield RunLock(False)
        return
    conn = None
    try:
        if engine is not None and engine.dialect.name == "postgresql":
            from sqlalchemy import text
            conn = engine.connect()
            conn.execute(text(f"SET LOCAL idle_in_transaction_session_timeout = '{LOCK_IDLE_TIMEOUT}'"))
            got = conn.execute(
                text("SELECT pg_try_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": LOCK_KEY}
            ).scalar()
            yield RunLock(bool(got), conn if got else None)
        else:
            yield RunLock(True)
    finally:
        if conn is not None:
            try:
                conn.rollback()  # releases the xact lock
            except Exception:  # noqa: BLE001
                pass
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
        plock.release()


# ── photos ───────────────────────────────────────────────────────────────

def classify_path(path: str) -> tuple[Optional[str], str]:
    """(uid, kind) from a storage key `<uid>/<kind>/<file>`. Unknown layouts get
    kind 'unknown' (retained like accounting documents)."""
    parts = path.split("/")
    if len(parts) >= 3 and parts[1] in ALLOWED_KINDS:
        return parts[0].lower(), parts[1]
    return (parts[0].lower() if len(parts) >= 2 else None), "unknown"


def photo_backup_key(bucket: str, path: str, sha256: str) -> str:
    return f"{PHOTO_PREFIX}/{bucket}/{path}.{sha256}.enc"


def _empty_manifest() -> dict:
    return {"version": 1, "updated_at": None, "entries": {}}


def load_photo_manifest(dst, fernet) -> tuple[dict, bool]:
    """(manifest, rebuilt). A missing manifest is rebuilt from the backup
    listing; an unreadable one raises (never silently start over)."""
    blob = dst.download(MANIFEST_KEY)
    if blob is not None:
        doc = json.loads(decrypt_bytes(blob, fernet))
        if not isinstance(doc, dict) or not isinstance(doc.get("entries"), dict):
            raise BackupStorageError("photo manifest has an unexpected shape")
        return doc, False
    doc = _empty_manifest()
    for obj in dst.list_all(PHOTO_PREFIX):
        m = _PHOTO_KEY_RE.match(obj.key)
        if not m:
            continue
        uid, kind = classify_path(m["path"])
        doc["entries"][obj.key] = {
            "bucket": m["bucket"], "path": m["path"], "uid": uid, "kind": kind,
            "sha256": m["sha"], "size": None, "etag": None, "source_created_at": None,
            "copied_at": _iso(obj.created_at), "source_deleted_at": None,
        }
    return doc, True


def save_photo_manifest(dst, fernet, doc: dict, now: datetime) -> None:
    doc["updated_at"] = _iso(now)
    dst.upload(MANIFEST_KEY, encrypt_bytes(json.dumps(doc, separators=(",", ":")).encode(), fernet),
               upsert=True)


def _photo_due(entry: dict, now: datetime, tombstones: dict) -> bool:
    """Is this backup copy due for purging?"""
    uid, kind = entry.get("uid"), entry.get("kind")
    erased_at = tombstones.get(uid) if uid else None
    if erased_at is not None:
        if kind in ERASURE_PURGE_KINDS:
            return True                                   # Art.17: erased now
        if erased_at < now - ACCOUNTING_KEEP:
            return True                                   # legal window over
    deleted = _parse_iso(entry.get("source_deleted_at"))
    if deleted is None:
        return False
    if kind in ERASURE_PURGE_KINDS:
        return now >= deleted + DELETED_GRACE
    base = _parse_iso(entry.get("source_created_at")) or _parse_iso(entry.get("copied_at")) or deleted
    return now >= max(deleted + DELETED_GRACE, base + ACCOUNTING_KEEP)


def _skip_copy(uid: Optional[str], kind: str, now: datetime, tombstones: dict) -> bool:
    erased_at = tombstones.get(uid) if uid else None
    if erased_at is None:
        return False
    return kind in ERASURE_PURGE_KINDS or erased_at < now - ACCOUNTING_KEEP


def mirror_photos(sources: dict, dst, fernet, *, now: datetime, tombstones: dict,
                  check: Callable[[], None] = lambda: None,
                  rng: Optional[random.Random] = None) -> dict:
    """Mirror every object of every source bucket into `dst`. `sources` maps a
    bucket name to its client. Returns stats with an `errors` list."""
    stats = {"listed": 0, "unchanged": 0, "copied": 0, "copied_bytes": 0, "refreshed": 0,
             "vanished": 0, "skipped_erased": 0, "marked_deleted": 0, "purged": 0,
             "verified": 0, "manifest_rebuilt": False, "backup_objects": 0,
             "backup_bytes": 0, "errors": [], "error_count": 0}

    def err(msg: str) -> None:
        stats["error_count"] += 1
        if len(stats["errors"]) < 20:
            stats["errors"].append(msg[:300])

    manifest, rebuilt = load_photo_manifest(dst, fernet)
    stats["manifest_rebuilt"] = rebuilt
    entries: dict = manifest["entries"]
    now_s = _iso(now)
    try:
        for bucket, src in sources.items():
            check()
            try:
                listing = src.list_all("")
            except Exception as e:  # noqa: BLE001 — incomplete listing: copy nothing, delete nothing
                err(f"list source bucket {bucket}: {type(e).__name__}: {e}")
                continue
            live = {o.key: o for o in listing}
            stats["listed"] += len(live)
            by_path: dict[str, list[str]] = {}
            for k, e in entries.items():
                if e.get("bucket") == bucket and not e.get("source_deleted_at"):
                    by_path.setdefault(e["path"], []).append(k)
            was_live = len(by_path)          # paths backed up before tonight

            for path in sorted(live):
                check()
                obj = live[path]
                uid, kind = classify_path(path)
                if _skip_copy(uid, kind, now, tombstones):
                    stats["skipped_erased"] += 1
                    continue
                current = by_path.get(path, [])
                if obj.etag and any(entries[k].get("etag") == obj.etag
                                    and entries[k].get("size") == obj.size for k in current):
                    stats["unchanged"] += 1
                    continue
                try:
                    if obj.size is not None and obj.size > MAX_OBJECT_BYTES:
                        err(f"{bucket}/{path}: {obj.size} bytes is over the per-object limit")
                        continue
                    data = src.download(path)
                    if data is None:
                        stats["vanished"] += 1
                        continue
                    sha = hashlib.sha256(data).hexdigest()
                    key = photo_backup_key(bucket, path, sha)
                    if key in entries:
                        entries[key].update({"size": len(data), "etag": obj.etag,
                                             "source_deleted_at": None})
                        if not entries[key].get("source_created_at"):
                            entries[key]["source_created_at"] = _iso(obj.created_at)
                        stats["refreshed"] += 1
                    else:
                        dst.upload(key, encrypt_bytes(data, fernet), upsert=True)
                        entries[key] = {
                            "bucket": bucket, "path": path, "uid": uid, "kind": kind,
                            "sha256": sha, "size": len(data), "etag": obj.etag,
                            "source_created_at": _iso(obj.created_at), "copied_at": now_s,
                            "source_deleted_at": None,
                        }
                        stats["copied"] += 1
                        stats["copied_bytes"] += len(data)
                    for other in current:
                        if other != key:   # an older version of this path
                            entries[other]["source_deleted_at"] = now_s
                            stats["marked_deleted"] += 1
                    by_path[path] = [key]
                except BackupAborted:
                    raise
                except Exception as e:  # noqa: BLE001 — one object never stops the run
                    err(f"{bucket}/{path}: {type(e).__name__}: {e}")

            # The listing was complete: whatever it lacks is gone from the source.
            gone = 0
            for k, e in entries.items():
                if e.get("bucket") == bucket and not e.get("source_deleted_at") and e["path"] not in live:
                    e["source_deleted_at"] = now_s
                    gone += 1
            stats["marked_deleted"] += gone
            # A wiped or mass-deleted bucket must page a human while the copies
            # are still inside their grace window, not be mirrored silently.
            if gone >= MASS_DELETE_MIN and gone > MASS_DELETE_SHARE * max(was_live, 1):
                err(f"mass deletion in source bucket {bucket}: {gone} objects disappeared "
                    "since the last run (backup copies are kept; check the bucket)")

        due = [k for k, e in entries.items() if _photo_due(e, now, tombstones)]
        if due:
            check()
            try:
                dst.delete_many(due)
                for k in due:
                    entries.pop(k, None)
                stats["purged"] = len(due)
            except BackupAborted:
                raise
            except Exception as e:  # noqa: BLE001 — keep entries, retry next night
                err(f"purge {len(due)} backup copies: {type(e).__name__}: {e}")

        live_keys = [k for k, e in entries.items() if not e.get("source_deleted_at")]
        sample = (rng or random.Random()).sample(live_keys, min(VERIFY_SAMPLE, len(live_keys)))
        for k in sample:
            check()
            try:
                blob = dst.download(k)
                if blob is None:
                    err(f"verify {k}: backup copy missing")
                    continue
                if hashlib.sha256(decrypt_bytes(blob, fernet)).hexdigest() != entries[k]["sha256"]:
                    err(f"verify {k}: sha256 mismatch")
                    continue
                stats["verified"] += 1
            except BackupAborted:
                raise
            except Exception as e:  # noqa: BLE001
                err(f"verify {k}: {type(e).__name__}: {e}")
    finally:
        stats["backup_objects"] = len(entries)
        stats["backup_bytes"] = sum(int(e.get("size") or 0) for e in entries.values())
        try:
            save_photo_manifest(dst, fernet, manifest, now)
        except Exception as e:  # noqa: BLE001
            err(f"save photo manifest: {type(e).__name__}: {e}")
    return stats


# ── database export ──────────────────────────────────────────────────────

class _HashingSlice:
    def __init__(self, f):
        self.f = f
        self.sha = hashlib.sha256()

    def read(self, n: int) -> bytes:
        data = self.f.read(n)
        self.sha.update(data)
        return data


def export_id_for(now: datetime) -> str:
    return now.strftime("%Y-%m-%dT%H%M%SZ")


class _HashingSink:
    def __init__(self, out):
        self.out = out
        self.sha = hashlib.sha256()
        self.n = 0

    def write(self, b):
        self.sha.update(b)
        self.n += len(b)
        return self.out.write(b)


def fetch_export(dst, parts: list[dict], out) -> None:
    """Download an export's parts in order into `out`, checking each part's
    size and sha256 against the manifest."""
    for p in parts:
        sink = _HashingSink(out)
        if not dst.download_to(p["key"], sink):
            raise BackupStorageError(f"export part missing: {p['key']}")
        if sink.n != p["bytes"] or sink.sha.hexdigest() != p["sha256"]:
            raise BackupStorageError(f"export part corrupt: {p['key']}")


def load_export_manifest(dst, export_id: str, fernet) -> Optional[dict]:
    blob = dst.download(f"{DB_PREFIX}/{export_id}/{DB_MANIFEST_NAME}")
    if blob is None:
        return None
    return json.loads(decrypt_bytes(blob, fernet))


def export_db_to_backup(engine, dst, fernet, *, now: datetime,
                        check: Callable[[], None] = lambda: None,
                        part_bytes: int = DB_PART_BYTES, verify: bool = True) -> dict:
    """Export, encrypt, upload, verify; the manifest is written last and marks
    the export complete."""
    export_id = export_id_for(now)
    prefix = f"{DB_PREFIX}/{export_id}"
    t0 = time.monotonic()
    app_commit = (os.getenv("RENDER_GIT_COMMIT") or os.getenv("GIT_COMMIT") or "").strip()[:12] or None
    with tempfile.TemporaryFile() as enc:
        writer = EncryptingWriter(enc, fernet)
        raw = engine.raw_connection()
        try:
            meta = export_database(raw, engine.dialect.name, writer, check=check, app_commit=app_commit)
        finally:
            try:
                raw.close()
            except Exception:  # noqa: BLE001
                pass
        writer.close()
        size = enc.tell()
        enc.seek(0)
        parts = []
        idx = 0
        offset = 0
        while offset < size:
            check()
            n = min(part_bytes, size - offset)
            key = f"{prefix}/part-{idx:05d}.enc"
            hs = _HashingSlice(enc)
            dst.upload_file(key, hs, n, upsert=False)
            parts.append({"key": key, "bytes": n, "sha256": hs.sha.hexdigest()})
            offset += n
            idx += 1

    if verify:
        with tempfile.TemporaryFile() as back:
            fetch_export(dst, parts, back)
            back.seek(0)
            reader = DecryptingReader(back, fernet)
            report = verify_export_stream(reader, count_rows=False, check=check)
            reader.verify_complete()
            for name, t in meta["tables"].items():
                if report["per_table"].get(name, {}).get("sha256") != t["sha256"]:
                    raise BackupStorageError(f"export verification failed for table {name}")

    manifest = {
        "export_id": export_id,
        "created_at": _iso(now),
        "format": meta["format"],
        "server": meta.get("server"),
        "alembic_version": meta.get("alembic_version"),
        "app_commit": meta.get("app_commit"),
        "schema_fingerprint": meta["schema_fingerprint"],
        "table_count": meta["table_count"],
        "total_rows": meta["total_rows"],
        "plain_bytes": meta["total_csv_bytes"],
        "encrypted_bytes": size,
        "parts": parts,
        "tables": {k: {"rows": v["rows"], "sha256": v["sha256"], "bytes": v["bytes"]}
                   for k, v in meta["tables"].items()},
        "verified": bool(verify),
        "verified_at": _iso(utc_now()) if verify else None,
    }
    dst.upload(f"{prefix}/{DB_MANIFEST_NAME}",
               encrypt_bytes(json.dumps(manifest, separators=(",", ":")).encode(), fernet),
               upsert=False)
    return {"ok": True, "export_id": export_id, "tables": meta["table_count"],
            "rows": meta["total_rows"], "plain_bytes": meta["total_csv_bytes"],
            "encrypted_bytes": size, "parts": len(parts), "verified": bool(verify),
            "seconds": round(time.monotonic() - t0, 1)}


# ── export retention ─────────────────────────────────────────────────────

def parse_export_id(export_id: str) -> Optional[datetime]:
    if not _EXPORT_ID_RE.match(export_id or ""):
        return None
    try:
        return datetime.strptime(export_id, "%Y-%m-%dT%H%M%SZ")
    except ValueError:
        return None


def select_exports_to_keep(ids: list[str], nightly: int = DB_KEEP_NIGHTLY,
                           monthly: int = DB_KEEP_MONTHLY, *, now: Optional[datetime] = None,
                           max_age: Optional[timedelta] = DB_MAX_AGE) -> set[str]:
    """Newest `nightly` exports, plus the FIRST export of each of the newest
    `monthly` calendar months — none older than `max_age` (when `now` given)."""
    dated = sorted(((parse_export_id(i), i) for i in ids if parse_export_id(i)), reverse=True)
    if now is not None and max_age is not None:
        dated = [(dt, i) for dt, i in dated if now - dt <= max_age]
    keep = {i for _, i in dated[:nightly]}
    first_of_month: dict[tuple[int, int], tuple[datetime, str]] = {}
    for dt, i in dated:
        ym = (dt.year, dt.month)
        if ym not in first_of_month or dt < first_of_month[ym][0]:
            first_of_month[ym] = (dt, i)
    for ym in sorted(first_of_month, reverse=True)[:monthly]:
        keep.add(first_of_month[ym][1])
    return keep


def list_db_exports(dst) -> tuple[list[str], dict[str, list[str]]]:
    """(complete export ids, {incomplete id: its object keys})."""
    complete, incomplete = [], {}
    for folder in dst.list_folders(DB_PREFIX):
        export_id = folder.rsplit("/", 1)[-1]
        if not parse_export_id(export_id):
            continue
        keys = [o.key for o in dst.list_files(f"{DB_PREFIX}/{export_id}")]
        if not keys:
            continue
        if any(k.endswith("/" + DB_MANIFEST_NAME) for k in keys):
            complete.append(export_id)
        else:
            incomplete[export_id] = keys
    return sorted(complete), incomplete


def prune_db_exports(dst, *, now: datetime, protect: set[str]) -> dict:
    complete, incomplete = list_db_exports(dst)
    keep = select_exports_to_keep(complete, now=now) | set(protect)
    doomed_keys: list[str] = []
    deleted_ids: list[str] = []
    for export_id in complete:
        if export_id not in keep:
            doomed_keys += [o.key for o in dst.list_files(f"{DB_PREFIX}/{export_id}")]
            deleted_ids.append(export_id)
    for export_id, keys in incomplete.items():
        dt = parse_export_id(export_id)
        if export_id not in protect and dt and now - dt > DB_INCOMPLETE_MAX_AGE:
            doomed_keys += keys
            deleted_ids.append(export_id)
    if doomed_keys:
        dst.delete_many(doomed_keys)
    return {"exports_kept": len([c for c in complete if c in keep]),
            "exports_deleted": len(deleted_ids), "objects_deleted": len(doomed_keys)}


# ── run ──────────────────────────────────────────────────────────────────

def _load_tombstones(session_factory) -> dict:
    from app.models.erasure_tombstone import ErasureTombstone
    db = session_factory()
    try:
        return {str(r.user_id).lower(): r.erased_at for r in db.query(ErasureTombstone).all()}
    finally:
        db.close()


def _record(session_factory, summary: dict, ok: bool, error_type: str) -> None:
    """MonitorState row (service="nightly_backup") + an ErrorLog row on failure.
    `summary` holds counts and already-redacted error strings only."""
    from app.models.error_log import ErrorLog
    from app.models.monitor_state import MonitorState
    try:
        db = session_factory()
    except Exception:  # noqa: BLE001
        logger.exception("backup: could not open a session to record the run")
        return
    try:
        st = db.query(MonitorState).filter(MonitorState.service == SERVICE).first()
        if st is None:
            st = MonitorState(service=SERVICE, state="HEALTHY", fail_streak=0, consecutive_ok=0)
            db.add(st)
        now = utc_now()
        st.last_check_at = now
        st.last_summary = json.dumps(summary, default=str)[:8000]
        if ok:
            st.state = "HEALTHY"
            st.fail_streak = 0
            st.consecutive_ok = (st.consecutive_ok or 0) + 1
            st.broken_since = None
        else:
            st.state = "BROKEN"
            st.fail_streak = (st.fail_streak or 0) + 1
            st.consecutive_ok = 0
            st.broken_since = st.broken_since or now
            db.add(ErrorLog(
                method="JOB", path="/jobs/nightly_backup", status_code=0,
                error_type=error_type,
                message=("; ".join(summary.get("errors") or []) or "backup failed")[:2000],
            ))
        db.commit()
    except Exception:  # noqa: BLE001 — recording must never crash the job
        logger.exception("backup: could not record the run")
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
    finally:
        db.close()


def run_nightly_backup(*, cfg: Optional[BackupConfig] = None, engine=None, session_factory=None,
                       sources: Optional[dict] = None, dst=None, now: Optional[datetime] = None,
                       deadline_seconds: int = RUN_DEADLINE_SECONDS) -> dict:
    """The scheduled entry point. Never raises; returns the run summary."""
    t0 = time.monotonic()
    try:
        cfg = cfg or load_config()
    except Exception as e:  # noqa: BLE001
        logger.error("backup: config could not be read: %s", type(e).__name__)
        return {"status": "failed", "errors": ["config could not be read"]}
    if cfg.status == "disabled":
        logger.info("backup: disabled (BACKUP_* env vars not set)")
        return {"status": "disabled"}

    if session_factory is None:
        from app.database import SessionLocal as session_factory  # noqa: N813
    if cfg.status == "misconfigured":
        summary = {"status": "failed", "errors": [f"misconfigured: {p}" for p in cfg.problems]}
        logger.error("backup: misconfigured: %s", "; ".join(cfg.problems))
        _record(session_factory, summary, ok=False, error_type="backup:misconfigured")
        return summary

    if engine is None:
        from app.database import engine as _engine
        engine = _engine
    now = now or utc_now()
    summary: dict = {"status": "running", "started_at": _iso(now), "photos": None,
                     "db": None, "retention": None, "errors": []}
    secrets = cfg.secrets

    def note(phase: str, e: BaseException) -> None:
        summary["errors"].append(_redact(f"{phase}: {type(e).__name__}: {e}", secrets))

    try:
        with backup_run_lock(engine) as lock:
            if not lock.acquired:
                logger.info("backup: another run holds the lock; skipping")
                return {"status": "skipped_locked"}
            deadline = t0 + deadline_seconds

            def check() -> None:
                if time.monotonic() > deadline:
                    raise BackupAborted("run deadline exceeded")
                lock.heartbeat()

            if dst is None:
                dst = SupabaseBucket(cfg.url, cfg.service_key, cfg.bucket)

            # 1. photos
            try:
                if sources is None:
                    if cfg.source_url and cfg.source_key:
                        sources = {b: SupabaseBucket(cfg.source_url, cfg.source_key, b)
                                   for b in cfg.source_buckets}
                    else:
                        sources = {}
                        summary["errors"].append("photos: main SUPABASE_URL / SUPABASE_SERVICE_KEY "
                                                 "not set, so photos were not backed up")
                if sources:
                    try:
                        tombstones = _load_tombstones(session_factory)
                    except Exception as e:  # noqa: BLE001
                        note("photos: read erasure_tombstones", e)
                        tombstones = {}
                    stats = mirror_photos(sources, dst, cfg.fernet, now=now,
                                          tombstones=tombstones, check=check)
                    for m in stats["errors"]:
                        summary["errors"].append(_redact(f"photos: {m}", secrets))
                    if stats["error_count"] > len(stats["errors"]):
                        summary["errors"].append(
                            f"photos: {stats['error_count'] - len(stats['errors'])} more errors")
                    summary["photos"] = {k: v for k, v in stats.items() if k != "errors"}
            except Exception as e:  # noqa: BLE001
                note("photos", e)

            # 2. database
            try:
                check()
                summary["db"] = export_db_to_backup(engine, dst, cfg.fernet, now=now, check=check)
            except Exception as e:  # noqa: BLE001
                note("db", e)

            # 3. export retention — only after tonight's export landed
            if summary["db"] and summary["db"].get("ok"):
                try:
                    check()
                    summary["retention"] = prune_db_exports(
                        dst, now=now, protect={summary["db"]["export_id"]})
                except Exception as e:  # noqa: BLE001
                    note("retention", e)
    except Exception as e:  # noqa: BLE001 — the lock itself, or anything unforeseen
        note("run", e)

    summary["duration_s"] = round(time.monotonic() - t0, 1)
    ok = not summary["errors"] and bool(summary["db"] and summary["db"].get("ok"))
    summary["status"] = "ok" if ok else "failed"
    if ok:
        logger.info("backup: ok in %ss", summary["duration_s"])
    else:
        logger.error("backup: failed: %s", "; ".join(summary["errors"])[:1000])
    _record(session_factory, summary, ok=ok, error_type="backup:failed")
    return summary


def register_backup_job(scheduler) -> None:
    """Add the nightly run to the app's APScheduler (called from app/main.py).

    04:20 UTC: after the 02:30 maintenance + retention sweep and every 03:xx
    job, after 04:00 recurring expenses, before the 06:00 brief push. One
    instance at a time; missed ticks coalesce into one run; a start delayed by
    a busy pool still runs within 3 h. The job store is in memory, so a process
    that is down at 04:20 skips that night — /api/admin/backup-health then
    reports the last run as stale (> 26 h)."""
    from apscheduler.triggers.cron import CronTrigger
    scheduler.add_job(
        run_nightly_backup,
        trigger=CronTrigger(hour=4, minute=20, timezone="UTC"),
        id="nightly_backup",
        name="Nightly encrypted off-project backup (photos + DB export)",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=3 * 3600,
    )
