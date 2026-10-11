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
     export older than DB_MAX_AGE (88 days). /privacy (push 3) says "copies
     in our backups disappear when those backups expire", and a DB export
     cannot be edited to drop one account, so every export must expire; the
     88-day cap is that expiry (below the 90 days /privacy used to name).
     Today it leaves 30 nightly + 2-3 monthly; keeping more is Manoj's call.
     Incomplete exports older than 2 days are removed. The AGE cut runs
     every night whatever tonight's export did (a failing export must not
     stop old ones expiring) — also when the run lock is lost or cannot be
     taken, and on a night misconfigured only in the encryption key, because
     it needs neither: it deletes only exports past DB_MAX_AGE and
     incomplete ones past 2 days, never a concurrent run's fresh export.
     The count-based thinning only runs after tonight's export landed, under
     the lock.
Every run that does work writes a MonitorState row (service="nightly_backup")
with counts / bytes / duration / outcome, and on failure an ErrorLog row
(method="JOB") that /api/admin/recent-errors shows. It never raises.

Alerts (operator email + push, the frontend monitor's channel), never with
personal data — counts and error kinds only, details stay behind
/api/admin/backup-health:
  • FAILED — once per incident: the first failed run (or a failed run after
    a recovery) alerts; further failures while the incident is open do not.
    A failed run after a STALE mail alerts once too (that mail blames a
    skipped night; a failing run is a different problem).
  • STALE — check_backup_staleness() (hourly) alerts once when the last run
    is older than STALE_AFTER (26 h) and no incident is open.
  • MASS DELETION in the source bucket — always alerts (each is a new event),
    in the same mail as a FAILED alert when both happen in one run, and stays
    listed in last_summary["alarms"] for DELETED_GRACE (30 days).
  • RECOVERED — one note when a run succeeds after an alert.

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
# /privacy (EN + DA, push 3): "Copies in our backups disappear when those
# backups expire" — no number. A DB export cannot be edited to drop one
# account, so every export must expire: this is that expiry, kept below the
# 90 days the old /privacy text promised. 88 days leaves room for the nightly
# cadence (an export is pruned on the first run after it ages out). The age
# cut runs every night, also when tonight's export failed. Raising it is
# Manoj's call (12 monthly exports = a year of a deleted account's data).
DB_MAX_AGE = timedelta(days=88)
DB_INCOMPLETE_MAX_AGE = timedelta(days=2)
DB_PART_BYTES = 32 << 20

DELETED_GRACE = timedelta(days=30)
# Same window as accounting_retention._purge_erased_account_blobs
# ((MIN_RETENTION_YEARS + 1) * 366 days).
ACCOUNTING_KEEP = timedelta(days=6 * 366)

# Uploads are capped at 12 MB (kasserapport / smart scan / daily close); 25 MB
# leaves room for a format the caps don't cover without letting one odd object
# take the run's memory (an object is held in memory to hash and encrypt it).
MAX_OBJECT_BYTES = 25 << 20
MASS_DELETE_MIN = 10          # this many vanished objects in one night …
MASS_DELETE_SHARE = 0.2       # … and more than this share of them → alarm
VERIFY_SAMPLE = 3
RUN_DEADLINE_SECONDS = 45 * 60
HEARTBEAT_EVERY_SECONDS = 15
LOCK_KEY = "bonbox:nightly_backup"
LOCK_IDLE_TIMEOUT = "15min"
# A night is skipped when the process is down at 04:20 (e.g. a deploy); the
# hourly watch alerts once the last recorded run is older than this.
STALE_AFTER = timedelta(hours=26)
HEALTH_URL = "https://api.bonbox.dk/api/admin/backup-health"

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
    # "misconfigured" only in the encryption key: url / service_key / bucket
    # are valid and set, so the nightly age cut (which needs no key) can run.
    storage_ok: bool = False


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
    key_problems = 0 if vals["BACKUP_ENCRYPTION_KEY"] else 1
    fernet = None
    if vals["BACKUP_ENCRYPTION_KEY"]:
        try:
            fernet = load_backup_fernet(vals["BACKUP_ENCRYPTION_KEY"], previous)
        except BackupConfigError as e:
            problems.append(str(e))
            key_problems += 1
    if not _BUCKET_RE.match(bucket):
        problems.append("BACKUP_BUCKET is not a valid bucket name")
    url = vals["BACKUP_SUPABASE_URL"]
    if url and not url.startswith("https://"):
        problems.append("BACKUP_SUPABASE_URL must start with https://")
    main_url = (getattr(s, "SUPABASE_URL", "") or "").strip()
    if url and main_url and _norm_url(url) == _norm_url(main_url):
        problems.append("BACKUP_SUPABASE_URL points at the main project; the backup must "
                        "live in a separate project")
    main_key = (getattr(s, "SUPABASE_SERVICE_KEY", "") or "").strip()
    if vals["BACKUP_SUPABASE_SERVICE_KEY"] and vals["BACKUP_SUPABASE_SERVICE_KEY"] == main_key:
        problems.append("BACKUP_SUPABASE_SERVICE_KEY equals SUPABASE_SERVICE_KEY; use the "
                        "backup project's own secret key (one leaked key must not reach both)")
    if problems:
        if len(problems) == key_problems:      # only the encryption key is wrong
            return BackupConfig(status="misconfigured", problems=problems, secrets=secrets,
                                url=url, service_key=vals["BACKUP_SUPABASE_SERVICE_KEY"],
                                bucket=bucket, storage_ok=True)
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


def bucket_privacy(cfg: Optional[BackupConfig] = None, *, client=None) -> dict:
    """Live check for /api/admin/backup-health: is the backup bucket private?
    {"private": True | False | None, "error": str | None}; None = could not
    check (never reported as private). Only when the backup is enabled."""
    cfg = cfg or load_config()
    if cfg.status != "enabled":
        return {"private": None, "error": None}
    import httpx
    own = None
    if client is None:
        own = client = httpx.Client(timeout=httpx.Timeout(10.0, connect=5.0))
    try:
        b = SupabaseBucket(cfg.url, cfg.service_key, cfg.bucket, client=client)
        return {"private": not b.bucket_public(), "error": None}
    except Exception as e:  # noqa: BLE001 — report, never break the endpoint
        return {"private": None, "error": _redact(f"{type(e).__name__}: {e}", cfg.secrets)}
    finally:
        if own is not None:
            own.close()


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
             "backup_bytes": 0, "errors": [], "error_count": 0,
             # kind → count: fixed labels, no paths — what an alert may show
             "error_kinds": {}, "mass_deletions": []}

    def err(msg: str, kind: str) -> None:
        stats["error_count"] += 1
        stats["error_kinds"][kind] = stats["error_kinds"].get(kind, 0) + 1
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
                err(f"list source bucket {bucket}: {type(e).__name__}: {e}", "list_source")
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
                        err(f"{bucket}/{path}: {obj.size} bytes is over the per-object limit",
                            "too_large")
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
                    err(f"{bucket}/{path}: {type(e).__name__}: {e}", f"copy:{type(e).__name__}")

            # The listing was complete: whatever it lacks is gone from the source.
            gone = 0
            gone_erased = 0      # an erased account's files: expected to go
            for k, e in entries.items():
                if e.get("bucket") == bucket and not e.get("source_deleted_at") and e["path"] not in live:
                    e["source_deleted_at"] = now_s
                    gone += 1
                    if e.get("uid") and e["uid"] in tombstones:
                        gone_erased += 1
            stats["marked_deleted"] += gone
            # A wiped or mass-deleted bucket must page a human while the copies
            # are still inside their grace window, not be mirrored silently:
            # it fails the run AND is an alarm of its own (run_nightly_backup
            # alerts on every one, and keeps it listed for DELETED_GRACE).
            unexplained = gone - gone_erased
            if unexplained >= MASS_DELETE_MIN and unexplained > MASS_DELETE_SHARE * max(was_live, 1):
                stats["mass_deletions"].append({"bucket": bucket, "gone": unexplained,
                                                "of": was_live})
                err(f"mass deletion in source bucket {bucket}: {unexplained} objects disappeared "
                    "since the last run (backup copies are kept; check the bucket)",
                    "mass_deletion")

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
                err(f"purge {len(due)} backup copies: {type(e).__name__}: {e}",
                    f"purge:{type(e).__name__}")

        live_keys = [k for k, e in entries.items() if not e.get("source_deleted_at")]
        sample = (rng or random.Random()).sample(live_keys, min(VERIFY_SAMPLE, len(live_keys)))
        for k in sample:
            check()
            try:
                blob = dst.download(k)
                if blob is None:
                    err(f"verify {k}: backup copy missing", "verify_missing")
                    continue
                if hashlib.sha256(decrypt_bytes(blob, fernet)).hexdigest() != entries[k]["sha256"]:
                    err(f"verify {k}: sha256 mismatch", "verify_mismatch")
                    continue
                stats["verified"] += 1
            except BackupAborted:
                raise
            except Exception as e:  # noqa: BLE001
                err(f"verify {k}: {type(e).__name__}: {e}", f"verify:{type(e).__name__}")
    finally:
        stats["backup_objects"] = len(entries)
        stats["backup_bytes"] = sum(int(e.get("size") or 0) for e in entries.values())
        try:
            save_photo_manifest(dst, fernet, manifest, now)
        except Exception as e:  # noqa: BLE001
            err(f"save photo manifest: {type(e).__name__}: {e}", f"save_manifest:{type(e).__name__}")
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


def app_table_names() -> frozenset[str]:
    """Every table the app's models declare (Base.metadata)."""
    import app.models  # noqa: F401 — register every model
    from app.database import Base
    return frozenset(Base.metadata.tables)


def export_db_to_backup(engine, dst, fernet, *, now: datetime,
                        check: Callable[[], None] = lambda: None,
                        part_bytes: int = DB_PART_BYTES, verify: bool = True,
                        expect_tables: frozenset[str] = frozenset()) -> dict:
    """Export, encrypt, upload, verify; the manifest is written last and marks
    the export complete. Every name in `expect_tables` should be in the
    export (the nightly run passes the app's model tables); the ones that are
    not — a wrong search_path, a table in another schema — are returned as
    `missing_tables` (and kept in the manifest) for the run to report and
    alert on. The export itself still lands: a partial backup beats none."""
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
        missing = sorted(set(expect_tables) - set(meta["tables"]))
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
        "missing_tables": missing,
    }
    dst.upload(f"{prefix}/{DB_MANIFEST_NAME}",
               encrypt_bytes(json.dumps(manifest, separators=(",", ":")).encode(), fernet),
               upsert=False)
    return {"ok": True, "export_id": export_id, "tables": meta["table_count"],
            "rows": meta["total_rows"], "plain_bytes": meta["total_csv_bytes"],
            "encrypted_bytes": size, "parts": len(parts), "verified": bool(verify),
            "missing_tables": missing, "seconds": round(time.monotonic() - t0, 1)}


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


def prune_db_exports(dst, *, now: datetime, protect: set[str], age_only: bool = False) -> dict:
    """Delete the exports retention no longer keeps. `age_only` (a night
    whose export failed): only the DB_MAX_AGE cut and stale incomplete
    exports — the count-based thinning waits for a night with a new export,
    but nothing may outlive DB_MAX_AGE because an export failed."""
    complete, incomplete = list_db_exports(dst)
    if age_only:
        keep = {c for c in complete if now - parse_export_id(c) <= DB_MAX_AGE} | set(protect)
    else:
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


def expire_old_exports(cfg: "BackupConfig", dst=None, *, now: datetime) -> dict:
    """The DB_MAX_AGE cut alone (prune_db_exports age_only), for a night that
    cannot run the backup: the run lock is lost or cannot be taken, or only
    the encryption key is misconfigured. It needs neither the lock nor the
    key: it deletes only complete exports older than DB_MAX_AGE and
    incomplete ones older than DB_INCOMPLETE_MAX_AGE, so a concurrent run's
    fresh export is never touched, and deleting an object another run just
    deleted is a no-op (Supabase and LocalDirBucket)."""
    if dst is None:
        dst = SupabaseBucket(cfg.url, cfg.service_key, cfg.bucket)
    return prune_db_exports(dst, now=now, protect=set(), age_only=True)


# ── recording ────────────────────────────────────────────────────────────

def _load_tombstones(session_factory) -> dict:
    from app.models.erasure_tombstone import ErasureTombstone
    db = session_factory()
    try:
        return {str(r.user_id).lower(): r.erased_at for r in db.query(ErasureTombstone).all()}
    finally:
        db.close()


# ── alerts ───────────────────────────────────────────────────────────────

def _notify(db, subject: str, lines: list[str], push_title: str, push_body: str) -> None:
    """Operator email + push through the frontend monitor's channel
    (jobs/frontend_monitor_job.notify_operators). Fail-soft. Callers pass
    counts, kinds and bucket names only — never paths, ids or row data."""
    try:
        from app.jobs.frontend_monitor_job import notify_operators
        notify_operators(db, subject, lines, push_title, push_body)
    except Exception as e:  # noqa: BLE001 — an alert must never break the job
        logger.error("backup: operator alert failed: %s", type(e).__name__)


def _kind_lines(kinds: Optional[dict]) -> list[str]:
    return [f"  - {k}: {n}" for k, n in sorted((kinds or {}).items())][:15]


def _mass_deletion_lines(alarms: list[dict]) -> list[str]:
    out = [f"MASS DELETION: {a.get('gone')} of {a.get('of')} backed-up files disappeared from the "
           f"source bucket '{a.get('bucket')}' since the previous run." for a in alarms]
    out.append("The backup copies are kept (30 days for avatars, logos, chat images and staff "
               "documents; 6 years for accounting documents). Check the main project's Storage "
               "now; files can be put back with scripts/restore_from_backup.py (runbook section 4).")
    return out


def _incident_alert(summary: dict, st, run_now: datetime, *, failed: bool,
                    new_alarms: list[dict], after_stale: bool = False) -> tuple[str, list[str], str, str]:
    when = run_now.strftime("%Y-%m-%d %H:%M")
    lines: list[str] = []
    if new_alarms:
        lines += _mass_deletion_lines(new_alarms) + [""]
    if failed:
        lines += [f"The nightly off-project backup FAILED at {when} UTC "
                  f"(failed runs in a row: {st.fail_streak})."]
        if after_stale:
            lines += ["This follows the 'nightly backup has not run' mail: the backup ran again "
                      "and failed, so this is a real failure, not a skipped night."]
        lines += ["What failed (kinds and counts only; no file names or account data by design):"]
        lines += _kind_lines(summary.get("error_kinds")) or ["  - (no detail recorded)"]
        lines += ["You get one mail per incident; the next one is the recovery note."]
    lines += ["", f"Details: {HEALTH_URL} (super-admin) and /api/admin/recent-errors (method JOB).",
              "Runbook: bonbox-lab-state/backup_runbook.md, section 2."]
    if new_alarms:
        subject = "BonBox: MASS DELETION in file storage (backup copies kept)"
        push = ("BonBox: mass deletion in storage",
                f"{sum(int(a.get('gone') or 0) for a in new_alarms)} files vanished from the source bucket.")
    else:
        subject = "BonBox: nightly backup FAILED"
        push = ("BonBox: nightly backup FAILED", "The nightly backup failed. See backup-health.")
    return subject, lines, push[0], push[1]


def _summary_json(summary: dict, limit: int = 8000) -> str:
    """JSON that stays parseable under the column budget (the alarms list is
    read back from it the next night)."""
    text = json.dumps(summary, default=str)
    if len(text) <= limit:
        return text
    errors = summary.get("errors") or []
    slim = {**summary, "errors": [e[:150] for e in errors[:5]] + [f"… {len(errors)} errors in all"]}
    text = json.dumps(slim, default=str)
    return text if len(text) <= limit else json.dumps(
        {k: slim.get(k) for k in ("status", "started_at", "duration_s", "error_kinds", "alarms",
                                  "bucket_private")}, default=str)[:limit]


_unrecorded_alerted = False      # see _record: once per process while runs can't be saved


def _record(session_factory, summary: dict, ok: bool, error_type: str,
            run_now: Optional[datetime] = None) -> None:
    """MonitorState row (service="nightly_backup") + an ErrorLog row on failure,
    and the once-per-incident alerts (see the module docstring). `summary`
    holds counts and already-redacted error strings only. The state is
    committed BEFORE an alert is sent, so a crash or a slow mail server can
    never make the next run alert the same incident again."""
    global _unrecorded_alerted
    from app.models.error_log import ErrorLog
    from app.models.monitor_state import MonitorState
    try:
        db = session_factory()
    except Exception:  # noqa: BLE001
        logger.exception("backup: could not open a session to record the run")
        return
    alert = None
    try:
        st = db.query(MonitorState).filter(MonitorState.service == SERVICE).first()
        if st is None:
            st = MonitorState(service=SERVICE, state="HEALTHY", fail_streak=0, consecutive_ok=0)
            db.add(st)
        now = utc_now()
        run_now = run_now or now
        # Mass deletions stay listed for DELETED_GRACE — the window in which
        # the copies of the no-legal-basis kinds still exist — instead of
        # vanishing from the status after one night.
        try:
            prev = json.loads(st.last_summary) if st.last_summary else {}
        except ValueError:
            prev = {}
        carried = [a for a in (prev.get("alarms") or []) if isinstance(a, dict)
                   and (_parse_iso(a.get("at")) or datetime.min) > run_now - DELETED_GRACE]
        new_alarms = [{"kind": "mass_deletion", "at": _iso(run_now), **m}
                      for m in ((summary.get("photos") or {}).get("mass_deletions") or [])]
        summary["alarms"] = carried + new_alarms

        st.last_check_at = now
        if ok:
            st.state = "HEALTHY"
            st.fail_streak = 0
            st.consecutive_ok = (st.consecutive_ok or 0) + 1
            st.broken_since = None
            if st.last_alert_at is not None:
                mins = int((now - st.last_alert_at).total_seconds() // 60)
                alert = ("BonBox: nightly backup recovered",
                         [f"The nightly off-project backup succeeded at {run_now.strftime('%Y-%m-%d %H:%M')} "
                          f"UTC, {mins} min after the alert.", f"Status: {HEALTH_URL}"],
                         "BonBox: nightly backup recovered", "The nightly backup works again.")
                st.last_alert_at = None
                st.incident_entry = None
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
            first = st.last_alert_at is None          # no incident open yet
            # The "has not run" mail opened this incident and blames a skipped
            # night; a run that then fails is a different problem, so it gets
            # its one FAILED mail too (still one mail per kind per incident).
            after_stale = not first and st.incident_entry == "stale"
            failed_mail = first or after_stale
            if failed_mail or new_alarms:
                alert = _incident_alert(summary, st, run_now, failed=failed_mail,
                                        new_alarms=new_alarms, after_stale=after_stale)
            if failed_mail:
                st.last_alert_at = now
                st.incident_entry = "failed"
        st.last_summary = _summary_json(summary)
        db.commit()
    except Exception:  # noqa: BLE001 — recording must never crash the job
        logger.exception("backup: could not record the run")
        alert = None
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        # Without the row there is no incident state to say "already
        # alerted", and the stale watch reads the same database. Mail once
        # per process until a run is recorded again (email needs no DB).
        if not _unrecorded_alerted:
            _unrecorded_alerted = True
            alert = ("BonBox: nightly backup could not be recorded",
                     [f"The nightly off-project backup ended with status '{summary.get('status')}' at "
                      f"{(run_now or utc_now()).strftime('%Y-%m-%d %H:%M')} UTC, but its result could "
                      "not be saved (database unreachable?).",
                      "What failed (kinds and counts only):"]
                     + (_kind_lines(summary.get("error_kinds")) or ["  - (none)"])
                     + [f"Status: {HEALTH_URL}", "You get this once until a run is saved again."],
                     "BonBox: backup result not saved", "The nightly backup could not record its result.")
    else:
        _unrecorded_alerted = False
    try:
        if alert:
            _notify(db, *alert)
    finally:
        db.close()


def check_backup_staleness(*, cfg: Optional[BackupConfig] = None, session_factory=None,
                           now: Optional[datetime] = None) -> dict:
    """Hourly watch: alert ONCE when the last recorded run is older than
    STALE_AFTER (a skipped night — the process was down at 04:20, or the job
    is not registered). Quiet when the backup is off, while a run is in
    progress here, before the first run (the runbook's manual first run
    creates the row) and while an incident is already open. Never raises."""
    try:
        cfg = cfg or load_config()
        if cfg.status == "disabled":
            return {"status": "disabled"}
        if _process_lock.locked():
            return {"status": "running"}
        if session_factory is None:
            from app.database import SessionLocal as session_factory  # noqa: N813
        from app.models.monitor_state import MonitorState
        db = session_factory()
        try:
            st = db.query(MonitorState).filter(MonitorState.service == SERVICE).first()
            if st is None or st.last_check_at is None:
                return {"status": "never_run"}
            now = now or utc_now()
            age = now - st.last_check_at
            if age <= STALE_AFTER:
                return {"status": "fresh"}
            if st.last_alert_at is not None:
                return {"status": "stale", "alerted": False}
            st.state = "BROKEN"
            st.broken_since = st.broken_since or now
            st.last_alert_at = now
            st.incident_entry = "stale"
            db.commit()
            hours = int(age.total_seconds() // 3600)
            _notify(db, "BonBox: nightly backup has not run",
                    [f"The last nightly off-project backup ran {hours} h ago "
                     f"({st.last_check_at.strftime('%Y-%m-%d %H:%M')} UTC); it should run every night "
                     "at 04:20 UTC.",
                     "Usually a deploy or restart at 04:20 skipped one night. Two in a row: check the "
                     "Render logs for 'nightly backup job not registered', or run it by hand "
                     "(runbook section 2).",
                     f"Status: {HEALTH_URL}",
                     "You get one mail per incident; the next one is the recovery note."],
                    "BonBox: nightly backup has not run", f"No backup for {hours} h.")
            return {"status": "stale", "alerted": True, "hours": hours}
        finally:
            db.close()
    except Exception as e:  # noqa: BLE001
        logger.error("backup: staleness check failed: %s", type(e).__name__)
        # backup_watch_error: a key ending in "_error" is what R-i's job
        # listener (jobs/job_events.py) records as one JOB row for the ops
        # triage; "status": "error" alone never reached an operator.
        return {"status": "error", "backup_watch_error": type(e).__name__}


# ── run ──────────────────────────────────────────────────────────────────

def run_nightly_backup(*, cfg: Optional[BackupConfig] = None, engine=None, session_factory=None,
                       sources: Optional[dict] = None, dst=None, now: Optional[datetime] = None,
                       deadline_seconds: int = RUN_DEADLINE_SECONDS,
                       expect_tables: Optional[frozenset[str]] = None) -> dict:
    """The scheduled entry point. Never raises; returns the run summary.
    `expect_tables` defaults to every app model table (app_table_names)."""
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
        summary = {"status": "failed", "errors": [f"misconfigured: {p}" for p in cfg.problems],
                   # problems name variables only (load_config), never values
                   "error_kinds": {f"misconfigured: {p}": 1 for p in cfg.problems}}
        logger.error("backup: misconfigured: %s", "; ".join(cfg.problems))
        if cfg.storage_ok:
            # Only the encryption key is wrong: the age cut needs no key, and
            # old exports must not outlive DB_MAX_AGE while it is being fixed.
            try:
                summary["retention"] = expire_old_exports(cfg, dst, now=now or utc_now())
            except Exception as e:  # noqa: BLE001
                summary["errors"].append(_redact(f"retention: {type(e).__name__}: {e}", cfg.secrets))
                summary["error_kinds"][f"retention:{type(e).__name__}"] = 1
        _record(session_factory, summary, ok=False, error_type="backup:misconfigured")
        return summary

    if engine is None:
        from app.database import engine as _engine
        engine = _engine
    now = now or utc_now()
    summary: dict = {"status": "running", "started_at": _iso(now), "bucket_private": None,
                     "photos": None, "db": None, "retention": None, "errors": [],
                     "error_kinds": {}}
    secrets = cfg.secrets
    kinds: dict = summary["error_kinds"]

    def kind(label: str, n: int = 1) -> None:
        kinds[label] = kinds.get(label, 0) + n

    def note(phase: str, e: BaseException) -> None:
        summary["errors"].append(_redact(f"{phase}: {type(e).__name__}: {e}", secrets))
        kind(f"{phase.split(':')[0]}:{type(e).__name__}")

    retention_tried = False
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

            # 0. The backup bucket must be private. Reported, never a reason
            #    to stop: everything in it is encrypted. A check that cannot be
            #    made is "unknown" (None), never "private".
            try:
                public = dst.bucket_public()
                summary["bucket_private"] = not public
                if public:
                    summary["errors"].append("bucket: the backup bucket is PUBLIC; make it private "
                                             "in the backup project (Storage, bucket settings)")
                    kind("bucket:public")
            except Exception as e:  # noqa: BLE001
                summary["bucket_check"] = _redact(f"{type(e).__name__}: {e}", secrets)

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
                        kind("photos:source_not_configured")
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
                    for k, n in stats["error_kinds"].items():
                        kind(f"photos:{k}", n)
                    summary["photos"] = {k: v for k, v in stats.items() if k != "errors"}
            except Exception as e:  # noqa: BLE001
                note("photos", e)

            # 2. database
            try:
                check()
                summary["db"] = export_db_to_backup(
                    engine, dst, cfg.fernet, now=now, check=check,
                    expect_tables=app_table_names() if expect_tables is None else expect_tables)
                missing = summary["db"].get("missing_tables") or []
                if missing:
                    summary["errors"].append(
                        f"db: the export lacks {len(missing)} app table(s): {', '.join(missing[:10])} "
                        "(check the database's schema / search_path)")
                    kind("db:missing_tables")
            except Exception as e:  # noqa: BLE001
                note("db", e)

            # 3. export retention — EVERY night. Tonight's export failed, the
            #    deadline passed or the lock connection is gone: still the
            #    DB_MAX_AGE cut (no export may outlive it because runs keep
            #    failing; it needs no lock, see expire_old_exports). The
            #    count-based thinning only after tonight's export landed and
            #    while the lock still holds. No deadline check here.
            retention_tried = True
            db_ok = bool(summary["db"] and summary["db"].get("ok"))
            try:
                lock.heartbeat(force=True)
                locked = True
            except Exception as e:  # noqa: BLE001
                note("retention", e)
                locked = False
            try:
                summary["retention"] = prune_db_exports(
                    dst, now=now, protect={summary["db"]["export_id"]} if db_ok else set(),
                    age_only=not (db_ok and locked))
            except Exception as e:  # noqa: BLE001
                note("retention", e)
    except Exception as e:  # noqa: BLE001 — the lock itself, or anything unforeseen
        note("run", e)
    if not retention_tried:
        # The run lock could not be taken (database unreachable?) or the run
        # broke before step 3: the age cut still runs, without the lock.
        try:
            summary["retention"] = expire_old_exports(cfg, dst, now=now)
        except Exception as e:  # noqa: BLE001
            note("retention", e)

    summary["duration_s"] = round(time.monotonic() - t0, 1)
    ok = not summary["errors"] and bool(summary["db"] and summary["db"].get("ok"))
    summary["status"] = "ok" if ok else "failed"
    if ok:
        logger.info("backup: ok in %ss", summary["duration_s"])
    else:
        logger.error("backup: failed: %s", "; ".join(summary["errors"])[:1000])
    _record(session_factory, summary, ok=ok, error_type="backup:failed", run_now=now)
    return summary


def register_backup_job(scheduler) -> None:
    """Add the nightly run and its hourly watch to the app's APScheduler
    (called from app/main.py).

    04:20 UTC: after the 02:30 maintenance + retention sweep and every 03:xx
    job, after 04:00 recurring expenses, before the 06:00 brief push. One
    instance at a time; missed ticks coalesce into one run; a start delayed by
    a busy pool still runs within 3 h. The job store is in memory, so a process
    that is down at 04:20 skips that night — the hourly watch (:50) then
    alerts once the last run is older than STALE_AFTER (26 h), and
    /api/admin/backup-health reports it as stale."""
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
    scheduler.add_job(
        check_backup_staleness,
        trigger=CronTrigger(minute=50, timezone="UTC"),
        id="nightly_backup_watch",
        name="Nightly backup watch (alerts once when no run for 26 h)",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        # The scheduler-wide floor (R-i, OPS-10: no job below one hour). An
        # hourly tick that runs late is merged with the next by coalesce.
        misfire_grace_time=3600,
    )
