"""Restore (or just verify) BonBox's off-project backup.

Reads the backup bucket written by app/services/backup_service.py, decrypts it
with BACKUP_ENCRYPTION_KEY, and either
  • --dry-run: proves the backup is readable and intact — every photo's sha256,
    every export part's sha256, every table's CSV sha256 and row count — and
    writes NOTHING anywhere (with --db-target it also compares row counts with
    that database, read-only), or
  • restores the DB export into a target Postgres (--db-target) and/or the
    photos into a directory (--photos-target-dir) or a bucket
    (--photos-target-bucket, with RESTORE_TARGET_SUPABASE_URL and
    RESTORE_TARGET_SUPABASE_SERVICE_KEY).

Run from backend/ with the backup project's values in the environment:

    BACKUP_SUPABASE_URL=… BACKUP_SUPABASE_SERVICE_KEY=… BACKUP_ENCRYPTION_KEY=… \\
        venv/bin/python scripts/restore_from_backup.py --list
    … scripts/restore_from_backup.py --dry-run                 # latest export + all photos
    … scripts/restore_from_backup.py --dry-run --export 2026-10-12T042000Z
    … scripts/restore_from_backup.py --skip-photos \\
          --db-target postgresql://postgres:…@127.0.0.1:55432/restore_drill \\
          --confirm-target 127.0.0.1/restore_drill

Safety:
  • A write needs --confirm-target equal to "<host>/<dbname>" (DB) or
    "<bucket>" (photos bucket), so a pasted URL cannot write by accident.
  • It refuses a DB target in the main production project
    (ahlqhztujpeccmaivkhr) or equal to $DATABASE_URL — restore into a NEW
    project or a local database, then repoint the app. Photos may go back
    into the main project's bucket only with --allow-main-project, and an
    object that already exists there is never overwritten.
  • The DB load is one transaction that commits only if every table's row
    count and sha256 match the export; target tables must be empty unless
    --truncate. The target schema must already exist (boot the app once
    against it, or use a 'Restore to new project' copy with --truncate).
  • --source-dir reads a downloaded copy of the backup bucket instead of
    Supabase (offline drills).
Exit code 0 = everything verified/restored; 1 = any mismatch or failure.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.backup_crypto import (  # noqa: E402
    BackupConfigError,
    DecryptingReader,
    decrypt_bytes,
    load_backup_fernet,
)
from app.services.backup_db import (  # noqa: E402
    VerifyError,
    restore_export_stream,
    verify_export_stream,
)
from app.services.backup_service import (  # noqa: E402
    DEFAULT_BUCKET,
    fetch_export,
    list_db_exports,
    load_export_manifest,
    load_photo_manifest,
)
from app.services.backup_storage import (  # noqa: E402
    LocalDirBucket,
    ObjectExistsError,
    SupabaseBucket,
)

MAIN_PROJECT_REF = "ahlqhztujpeccmaivkhr"

# The extensions storage.compose_key allows, with the types the app uploads
# them as (a restored object must be served like the original).
_CONTENT_TYPES = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                  "webp": "image/webp", "heic": "image/heic", "pdf": "application/pdf"}


def content_type_for(path: str) -> str:
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return (_CONTENT_TYPES.get(ext) or mimetypes.guess_type(path)[0]
            or "application/octet-stream")


def _say(msg: str) -> None:
    print(msg, flush=True)


def _pg_url(url: str) -> str:
    return url.replace("postgresql+psycopg2://", "postgresql://", 1)


def _refuse_main(target: str, env: dict) -> str | None:
    if MAIN_PROJECT_REF in (target or ""):
        return "target is in the main production project; restore into a new project"
    main_db = (env.get("DATABASE_URL") or "").strip()
    if main_db and _pg_url(main_db) == _pg_url(target):
        return "target equals DATABASE_URL (the live database)"
    return None


# ── database ──────────────────────────────────────────────────────────────

def _pick_export(bucket, wanted: str) -> str | None:
    complete, _ = list_db_exports(bucket)
    if not complete:
        return None
    if wanted in (None, "", "latest"):
        return complete[-1]
    return wanted if wanted in complete else None


def run_db(bucket, fernet, args, env) -> dict:
    export_id = _pick_export(bucket, args.export)
    if not export_id:
        return {"ok": False, "error": f"no complete export {args.export!r} in the backup"}
    manifest = load_export_manifest(bucket, export_id, fernet)
    if manifest is None:
        return {"ok": False, "error": f"export {export_id} has no manifest"}
    _say(f"DB export {export_id}: {manifest['table_count']} tables, {manifest['total_rows']} rows, "
         f"{len(manifest['parts'])} part(s), {manifest['encrypted_bytes']} encrypted bytes")
    out = {"export_id": export_id, "ok": False}

    target_conn = None
    if args.db_target:
        why = _refuse_main(args.db_target, env)
        if why:
            return {**out, "error": f"refused: {why}"}
        import psycopg2
        target_conn = psycopg2.connect(_pg_url(args.db_target), connect_timeout=10)
        where = f"{target_conn.info.host}/{target_conn.info.dbname}"
        if MAIN_PROJECT_REF in (target_conn.info.host or "") or MAIN_PROJECT_REF in (target_conn.info.user or ""):
            target_conn.close()
            return {**out, "error": "refused: target is in the main production project"}
        if not args.dry_run and args.confirm_target != where:
            target_conn.close()
            return {**out, "error": f"refused: pass --confirm-target {where} to write to it"}

    try:
        with tempfile.TemporaryFile() as enc:
            fetch_export(bucket, manifest["parts"], enc)   # part sha256 + size
            enc.seek(0)
            reader = DecryptingReader(enc, fernet)
            if args.dry_run or target_conn is None:
                report = verify_export_stream(reader, count_rows=True)
                reader.verify_complete()
                for name, t in manifest["tables"].items():
                    got = report["per_table"].get(name)
                    if not got or got["rows"] != t["rows"] or got["sha256"] != t["sha256"]:
                        raise VerifyError(f"{name}: does not match the export manifest")
                out.update(ok=True, mode="verified", tables=report["tables"], rows=report["rows"])
                _say(f"  verified: {report['tables']} tables, {report['rows']} rows, "
                     "every sha256 and row count matches")
                if target_conn is not None:
                    target_conn.set_session(readonly=True, autocommit=True)
                    cur = target_conn.cursor()
                    diffs = {}
                    for name, t in sorted(manifest["tables"].items()):
                        try:
                            cur.execute(f'SELECT count(*) FROM "{name.replace(chr(34), chr(34) * 2)}"')
                            n = cur.fetchone()[0]
                        except Exception as e:  # noqa: BLE001
                            n = f"error: {type(e).__name__}"
                        if n != t["rows"]:
                            diffs[name] = {"backup": t["rows"], "target": n}
                    out["target_count_differences"] = diffs
                    _say(f"  target comparison: {len(diffs)} table(s) differ in row count "
                         "(expected when the target is from another moment)")
            else:
                report = restore_export_stream(reader, target_conn, truncate=args.truncate,
                                               skip_missing_tables=args.skip_missing_tables)
                reader.verify_complete()
                out.update(ok=True, mode="restored", tables=report["tables"], rows=report["rows"],
                           skipped_tables=report["skipped_tables"])
                if report["skipped_tables"]:
                    _say(f"  skipped (absent in target): {', '.join(report['skipped_tables'])}")
                _say(f"  restored {report['tables']} tables, {report['rows']} rows into "
                     f"{target_conn.info.host}/{target_conn.info.dbname}")
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"[:500]
    finally:
        if target_conn is not None:
            target_conn.close()
    return out


# ── photos ────────────────────────────────────────────────────────────────

def run_photos(bucket, fernet, args, env) -> dict:
    manifest, rebuilt = load_photo_manifest(bucket, fernet)
    entries = manifest["entries"]
    chosen = {k: e for k, e in entries.items()
              if args.include_deleted_photos or not e.get("source_deleted_at")}
    _say(f"Photos: {len(entries)} backup copies ({len(chosen)} selected)"
         + (" — manifest was missing and was rebuilt from the listing" if rebuilt else ""))
    out = {"ok": False, "selected": len(chosen), "verified": 0, "written": 0,
           "already_present": 0, "problems": []}

    target_dir = Path(args.photos_target_dir) if args.photos_target_dir else None
    target_bucket = None
    if args.photos_target_bucket and not args.dry_run:
        url = (env.get("RESTORE_TARGET_SUPABASE_URL") or "").strip()
        key = (env.get("RESTORE_TARGET_SUPABASE_SERVICE_KEY") or "").strip()
        if not url or not key:
            out["problems"].append("RESTORE_TARGET_SUPABASE_URL / _SERVICE_KEY not set")
            return out
        why = _refuse_main(url, env)
        if why and not args.allow_main_project:
            out["problems"].append(f"refused: {why} (photos only: --allow-main-project puts "
                                   "missing objects back without overwriting any)")
            return out
        if args.confirm_target != args.photos_target_bucket:
            out["problems"].append(
                f"refused: pass --confirm-target {args.photos_target_bucket} to write to it")
            return out
        target_bucket = SupabaseBucket(url, key, args.photos_target_bucket)

    for k, e in sorted(chosen.items()):
        blob = bucket.download(k)
        if blob is None:
            out["problems"].append(f"missing: {k}")
            continue
        try:
            data = decrypt_bytes(blob, fernet)
        except Exception as ex:  # noqa: BLE001
            out["problems"].append(f"decrypt failed: {k}: {type(ex).__name__}")
            continue
        if hashlib.sha256(data).hexdigest() != e["sha256"] or not k.endswith(f".{e['sha256']}.enc"):
            out["problems"].append(f"sha256 mismatch: {k}")
            continue
        if e.get("size") is not None and e["size"] != len(data):
            out["problems"].append(f"size mismatch: {k}")
            continue
        out["verified"] += 1
        if args.dry_run:
            continue
        if target_dir is not None:
            p = (target_dir / e["bucket"] / e["path"]).resolve()
            p.relative_to(target_dir.resolve())
            if p.exists():
                out["already_present"] += 1
            else:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)
                out["written"] += 1
        elif target_bucket is not None:
            try:
                target_bucket.upload(e["path"], data, upsert=False,
                                     content_type=content_type_for(e["path"]))
                out["written"] += 1
            except ObjectExistsError:
                out["already_present"] += 1
            except Exception as ex:  # noqa: BLE001
                out["problems"].append(f"upload failed: {e['path']}: {type(ex).__name__}")
    out["ok"] = not out["problems"]
    _say(f"  verified {out['verified']}/{len(chosen)}; written {out['written']}; "
         f"already present {out['already_present']}; problems {len(out['problems'])}")
    for p in out["problems"][:20]:
        _say(f"  ! {p}")
    return out


# ── entry point ───────────────────────────────────────────────────────────

def _list(backup_bucket, fernet) -> int:
    complete, incomplete = list_db_exports(backup_bucket)
    for export_id in complete:
        m = load_export_manifest(backup_bucket, export_id, fernet) or {}
        _say(f"{export_id}  tables={m.get('table_count')} rows={m.get('total_rows')} "
             f"bytes={m.get('encrypted_bytes')} verified={m.get('verified')}")
    if incomplete:
        _say(f"(incomplete exports: {', '.join(sorted(incomplete))})")
    photos, _ = load_photo_manifest(backup_bucket, fernet)
    live = sum(1 for e in photos["entries"].values() if not e.get("source_deleted_at"))
    _say(f"photos: {live} current, {len(photos['entries']) - live} kept after source deletion")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--list", action="store_true", help="list exports and photo counts, then stop")
    ap.add_argument("--export", default="latest", help="export id (e.g. 2026-10-12T042000Z) or 'latest'")
    ap.add_argument("--dry-run", action="store_true", help="verify hashes and row counts only; write nothing")
    ap.add_argument("--skip-db", action="store_true")
    ap.add_argument("--skip-photos", action="store_true")
    ap.add_argument("--include-deleted-photos", action="store_true",
                    help="also verify/restore copies whose source object was deleted")
    ap.add_argument("--db-target", help="target Postgres URL (restore, or read-only compare with --dry-run)")
    ap.add_argument("--truncate", action="store_true", help="empty the target tables before loading")
    ap.add_argument("--skip-missing-tables", action="store_true",
                    help="skip export tables the target does not have (listed in the report)")
    ap.add_argument("--photos-target-dir", help="write decrypted photos under this directory")
    ap.add_argument("--photos-target-bucket", help="upload decrypted photos to this bucket "
                    "(RESTORE_TARGET_SUPABASE_URL / _SERVICE_KEY)")
    ap.add_argument("--confirm-target", help="'<host>/<dbname>' or '<bucket>' of the write target")
    ap.add_argument("--allow-main-project", action="store_true",
                    help="photos only: allow --photos-target-bucket in the main project (a wiped "
                         "receipts bucket); never overwrites an existing object")
    ap.add_argument("--source-dir", help="read the backup from this local directory instead of Supabase")
    return ap


def main(argv=None, *, env=None, backup_bucket=None) -> int:
    env = dict(os.environ if env is None else env)
    args = build_parser().parse_args(argv)
    try:
        fernet = load_backup_fernet(env.get("BACKUP_ENCRYPTION_KEY", ""),
                                    env.get("BACKUP_ENCRYPTION_KEY_PREVIOUS", ""))
    except BackupConfigError as e:
        _say(f"error: {e}")
        return 1
    if backup_bucket is None:
        if args.source_dir:
            backup_bucket = LocalDirBucket(args.source_dir)
        else:
            url = (env.get("BACKUP_SUPABASE_URL") or "").strip()
            key = (env.get("BACKUP_SUPABASE_SERVICE_KEY") or "").strip()
            if not url or not key:
                _say("error: set BACKUP_SUPABASE_URL and BACKUP_SUPABASE_SERVICE_KEY, or pass --source-dir")
                return 1
            backup_bucket = SupabaseBucket(url, key, (env.get("BACKUP_BUCKET") or DEFAULT_BUCKET).strip())

    if args.list:
        try:
            return _list(backup_bucket, fernet)
        except Exception as e:  # noqa: BLE001
            _say(f"error: {type(e).__name__}: {e}"[:500])
            return 1

    if not args.dry_run and not (args.db_target or args.photos_target_dir or args.photos_target_bucket):
        _say("nothing to write: pass --dry-run, or a target (--db-target / --photos-target-*)")
        return 1

    summary = {"dry_run": args.dry_run}
    for part, fn, skip in (("db", run_db, args.skip_db), ("photos", run_photos, args.skip_photos)):
        if skip:
            continue
        try:
            summary[part] = fn(backup_bucket, fernet, args, env)
        except Exception as e:  # noqa: BLE001 — wrong key, unreachable bucket, …
            summary[part] = {"ok": False, "error": f"{type(e).__name__}: {e}"[:500]}
            _say(f"{part}: FAILED: {summary[part]['error']}")
    ok = all(v.get("ok") for k, v in summary.items() if isinstance(v, dict))
    summary["ok"] = ok
    _say(json.dumps(summary, indent=1, default=str))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
