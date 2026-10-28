"""Restore (or just verify) BonBox's off-project backup.

Reads the backup bucket written by app/services/backup_service.py, decrypts it
with BACKUP_ENCRYPTION_KEY, and either
  • --dry-run: proves the backup is readable and intact — every photo's sha256,
    every export part's sha256, every table's CSV sha256 and row count — and
    writes NOTHING anywhere (with a DB target it also compares row counts with
    that database, read-only), or
  • restores the DB export into a target Postgres and/or the photos into a
    directory (--photos-target-dir) or a bucket (--photos-target-bucket, with
    RESTORE_TARGET_SUPABASE_URL and RESTORE_TARGET_SUPABASE_SERVICE_KEY), and
  • --reapply-erasures: erases again, in the target, every account erased
    after the restored export (services/backup_erasure), and leaves those
    accounts' no-legal-basis photos out of a photo restore. Tombstones come
    from the newest export in the backup and, when ERASURE_SOURCE_DATABASE_URL
    is set, from that database (the live one; read-only).

Secrets come from the environment only — never type them on a command line
(shell history, `ps`). Run from backend/:

    read -rs BACKUP_SUPABASE_SERVICE_KEY && export BACKUP_SUPABASE_SERVICE_KEY
    read -rs BACKUP_ENCRYPTION_KEY && export BACKUP_ENCRYPTION_KEY
    export BACKUP_SUPABASE_URL=https://<backup ref>.supabase.co
    venv/bin/python scripts/restore_from_backup.py --list
    venv/bin/python scripts/restore_from_backup.py --dry-run          # latest export + all photos
    venv/bin/python scripts/restore_from_backup.py --dry-run --export 2026-10-12T042000Z
    read -rs RESTORE_DB_TARGET_URL && export RESTORE_DB_TARGET_URL    # postgresql://…
    venv/bin/python scripts/restore_from_backup.py --skip-photos --reapply-erasures \\
          --confirm-target 127.0.0.1/restore_drill

The DB target is RESTORE_DB_TARGET_URL (or --db-target, which puts the
password in your shell history — avoid it). A password with @ / ? # % or a
space must be URL-encoded in the URL (@ → %40, / → %2F, ? → %3F, # → %23,
% → %25, space → %20); the script refuses such a URL by name. Nothing it
prints carries a password or key: every line is scrubbed of the URLs' user
info and passwords and of the keys in the environment.

Safety:
  • A write needs --confirm-target equal to "<host>/<dbname>" (DB) or
    "<bucket>" (photos bucket), so a pasted URL cannot write by accident.
  • It refuses a DB target in a protected project — the live primary
    (qwogfearhfhaunqpuvgd, Frankfurt, since 20 Oct 2026), the old primary
    (ahlqhztujpeccmaivkhr, Ireland; its fallback copy was deleted on
    28 Oct 2026, the ref stays refused), and whatever
    project $SUPABASE_URL / $DATABASE_URL name — or equal to $DATABASE_URL:
    restore into a NEW project or a local database, then repoint the app.
    Photos may go back into a protected project's bucket only with
    --allow-main-project, and an object that already exists there is never
    overwritten.
  • Before it downloads anything for a DB write it checks that the login may
    set session_replication_role (the load needs it) and explains what to do
    when it may not.
  • The DB load is one transaction that commits only if every table's row
    count and sha256 match the export; target tables must be empty unless
    --truncate. The target schema must already exist (boot the app once
    against it, or use a 'Restore to new project' copy with --truncate).
  • Encrypted columns (bank consents, staff bank accounts) can only be read
    by an app that runs with the APP_SECRET_KEY that was live when the
    export was taken.
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
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.backup_erasure import (  # noqa: E402
    merge_tombstones,
    reapply_erasures,
    tombstones_from_csv_text,
    tombstones_from_engine,
)
from app.services.backup_crypto import (  # noqa: E402
    BackupConfigError,
    DecryptingReader,
    decrypt_bytes,
    load_backup_fernet,
)
from app.services.backup_db import (  # noqa: E402
    VerifyError,
    read_export_table,
    replica_role_problem,
    restore_export_stream,
    verify_export_stream,
)
from app.services.backup_service import (  # noqa: E402
    DEFAULT_BUCKET,
    _skip_copy,
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
from app.utils.time import utc_now  # noqa: E402

# Projects a restore never writes into (photos: only with --allow-main-project).
# MAIN_PROJECT_REF is the LIVE primary — Frankfurt since the 20 Oct 2026 move
# (docs/runbooks/INCIDENT.md). Until this release the guard still named the
# old Ireland ref, so only the exact $DATABASE_URL match protected production:
# a pooler URL on the other port, the db.<ref>.supabase.co host, or the photo
# bucket at https://<ref>.supabase.co all got through. The old primary stays
# refused too: it held the unchanged fallback copy ("never restore into it")
# until that copy was deleted on 28 Oct 2026; the ref stays on the list.
# And the refs $SUPABASE_URL / $DATABASE_URL name are added at run time (as
# backup_service derives the main project from settings.SUPABASE_URL), so the
# next move cannot leave the guard naming the wrong project again.
MAIN_PROJECT_REF = "qwogfearhfhaunqpuvgd"
RETIRED_PROJECT_REFS = ("ahlqhztujpeccmaivkhr",)
_PROJECT_REF_RE = re.compile(r"^[a-z0-9]{20}$")


def _project_refs_in(url: str | None) -> set[str]:
    """The Supabase project refs a URL names: the <ref>.supabase.co or
    db.<ref>.supabase.co host, or the pooler login postgres.<ref>."""
    refs: set[str] = set()
    try:
        parts = urlsplit((url or "").strip())
        host = (parts.hostname or "").lower()
        user = unquote(parts.username or "").lower()
    except ValueError:
        return refs
    labels = host.split(".")
    if host.endswith(".supabase.co") and len(labels) >= 3:
        refs.add(labels[-3])
    if "." in user:
        refs.add(user.rsplit(".", 1)[1])
    return {r for r in refs if _PROJECT_REF_RE.match(r)}


def protected_project_refs(env: dict) -> set[str]:
    refs = {MAIN_PROJECT_REF, *RETIRED_PROJECT_REFS}
    for name in ("SUPABASE_URL", "DATABASE_URL"):
        refs |= _project_refs_in(env.get(name))
    return refs


def _names_protected_project(text: str | None, env: dict) -> bool:
    t = (text or "").lower()
    return any(ref in t for ref in protected_project_refs(env))

# The extensions storage.compose_key allows, with the types the app uploads
# them as (a restored object must be served like the original).
_CONTENT_TYPES = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                  "webp": "image/webp", "heic": "image/heic", "pdf": "application/pdf"}


def content_type_for(path: str) -> str:
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return (_CONTENT_TYPES.get(ext) or mimetypes.guess_type(path)[0]
            or "application/octet-stream")


# ── secrets never printed ─────────────────────────────────────────────────
# libpq and SQLAlchemy quote the part of a URL they cannot parse ('could not
# translate host name "<end of password>@host"', 'invalid percent-encoded
# token: "<password>"'), and the runbook says to paste failures to Claude.
# So a URL whose user info needs URL-encoding is refused before any driver
# sees it (_url_problem), a failed connect reports host + a plain reason only
# (_connect_reason), and every printed line goes through _scrub.

_URL_ENV = ("RESTORE_DB_TARGET_URL", "ERASURE_SOURCE_DATABASE_URL", "DATABASE_URL")
_KEY_ENV = ("BACKUP_SUPABASE_SERVICE_KEY", "BACKUP_ENCRYPTION_KEY",
            "BACKUP_ENCRYPTION_KEY_PREVIOUS", "RESTORE_TARGET_SUPABASE_SERVICE_KEY")
_NEEDS_ENCODING = re.compile(r"[@/?#\s]|%(?![0-9A-Fa-f]{2})")
_scrub_terms: list[str] = []


def _userinfo(url: str) -> str:
    """The raw 'user:password' of a URL: from '://' to the LAST '@' (a
    password with an unencoded '@' or '/' still lands in it). '' when the
    URL has no authority part (sqlite:///path, postgresql:///db)."""
    rest = url.split("://", 1)[1] if "://" in url else ""
    return "" if rest.startswith("/") else rest.rpartition("@")[0]


def _url_secret_terms(url: str) -> list[str]:
    info = _userinfo(url or "")
    if not info:
        return []
    password = info.partition(":")[2]
    # Drivers quote pieces of a password they split at @ / ? # % or :.
    pieces = [p for pw in (password, unquote(password))
              for p in re.split(r"[@/?#%:\s]", pw) if p]
    return [url, info, password, unquote(password), *pieces]


def _set_scrub_terms(env: dict, args) -> None:
    terms = []
    for url in (getattr(args, "db_target", None), *(env.get(n) for n in _URL_ENV)):
        terms += _url_secret_terms((url or "").strip())
    terms += [(env.get(n) or "").strip() for n in _KEY_ENV]
    # Longest first; 3+ characters (shorter would blank ordinary words).
    _scrub_terms[:] = sorted({t for t in terms if len(t) >= 3}, key=len, reverse=True)


def _scrub(text) -> str:
    text = str(text)
    for t in _scrub_terms:
        text = text.replace(t, "***")
    return text


def _scrub_obj(obj):
    """_scrub every string in a JSON-able structure (before json.dumps, which
    would escape a quote or a non-ASCII character in a password)."""
    if isinstance(obj, dict):
        return {k: _scrub_obj(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_scrub_obj(v) for v in obj]
    return _scrub(obj) if isinstance(obj, str) else obj


def _url_problem(url: str) -> str | None:
    if _NEEDS_ENCODING.search(_userinfo(url or "")):
        return ("the user name or password has a character that must be URL-encoded "
                "(@ / ? # % or a space). URL-encode the password in the URL (@ -> %40, "
                "/ -> %2F, ? -> %3F, # -> %23, % -> %25, space -> %20; runbook section 4) "
                "and try again")
    return None


def _host_db(url: str) -> str:
    """'<host>/<dbname>' of a URL, for messages (never the user info)."""
    try:
        u = urlsplit(_pg_url(url))
        return f"{u.hostname or 'localhost'}/{u.path.lstrip('/') or '?'}"
    except ValueError:
        return "the database"


_CONNECT_REASONS = (
    ("password authentication failed", "wrong user name or password"),
    ("could not translate host name", "host name not found"),
    ("nodename nor servname", "host name not found"),
    ("name or service not known", "host name not found"),
    ("timeout expired", "timed out"),
    ("connection refused", "connection refused (nothing listens on that host and port)"),
    ("no pg_hba.conf entry", "the server does not accept this login from here"),
    ("does not exist", "the database or user does not exist"),
    ("ssl", "SSL problem"),
    ("tenant or user not found", "wrong user name for this pooler (postgres.<project ref>)"),
)


def _connect_reason(e: BaseException) -> str:
    """A plain reason from a fixed list — never the driver's own text, which
    may quote part of the URL."""
    msg = str(e).lower()
    for needle, reason in _CONNECT_REASONS:
        if needle in msg:
            return reason
    return "see the error type"


def _say(msg: str) -> None:
    print(_scrub(msg), flush=True)


def _pg_url(url: str) -> str:
    return url.replace("postgresql+psycopg2://", "postgresql://", 1)


def _db_target(args, env) -> str:
    """--db-target, else RESTORE_DB_TARGET_URL (the way that keeps the
    password out of shell history)."""
    return (args.db_target or env.get("RESTORE_DB_TARGET_URL") or "").strip()


def _refuse_main(target: str, env: dict) -> str | None:
    if _names_protected_project(target, env):
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


def run_db(bucket, fernet, args, env, ctx: dict | None = None) -> dict:
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
    target = _db_target(args, env)
    if target:
        why = _refuse_main(target, env)
        if why:
            return {**out, "error": f"refused: {why}"}
        import psycopg2
        try:
            target_conn = psycopg2.connect(_pg_url(target), connect_timeout=10)
        except Exception as e:  # noqa: BLE001 — host + a plain reason, never the URL
            error = (f"could not connect to the DB target {_host_db(target)}: "
                     f"{type(e).__name__} ({_connect_reason(e)})")
            _say(f"  {error}")
            return {**out, "error": error}
        where = f"{target_conn.info.host}/{target_conn.info.dbname}"
        if (_names_protected_project(target_conn.info.host, env)
                or _names_protected_project(target_conn.info.user, env)):
            target_conn.close()
            return {**out, "error": "refused: target is in the main production project"}
        if not args.dry_run and args.confirm_target != where:
            target_conn.close()
            return {**out, "error": f"refused: pass --confirm-target {where} to write to it"}
        if not args.dry_run:
            # Before any download: can this login load with FK triggers off?
            problem = replica_role_problem(target_conn)
            if problem:
                target_conn.close()
                _say(f"  refused: {problem}")
                return {**out, "error": f"refused: {problem}"}

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
                if ctx is not None:
                    ctx["restored_export"] = export_id
                if report["skipped_tables"]:
                    _say(f"  skipped (absent in target): {', '.join(report['skipped_tables'])}")
                _say(f"  restored {report['tables']} tables, {report['rows']} rows into "
                     f"{target_conn.info.host}/{target_conn.info.dbname}")
                if not args.reapply_erasures:
                    _say(f"  NOTE: accounts erased after {export_id} are back in this database. "
                         "Run again with --skip-db --skip-photos --reapply-erasures "
                         "(runbook section 4) before anyone uses it.")
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"[:500]
    finally:
        if target_conn is not None:
            target_conn.close()
    return out


# ── erasures ──────────────────────────────────────────────────────────────

def _sa_url(url: str) -> str:
    url = url.strip()
    return "postgresql://" + url[len("postgres://"):] if url.startswith("postgres://") else url


def _engine_for(url: str):
    from sqlalchemy import create_engine
    url = _sa_url(url)
    pg = url.startswith("postgresql")
    return create_engine(url, connect_args={"connect_timeout": 10} if pg else {})


def run_erasures(bucket, fernet, args, env, ctx: dict | None = None) -> dict:
    """--reapply-erasures: collect the erasure tombstones (newest export in
    the backup, ERASURE_SOURCE_DATABASE_URL read-only, the target's own) and
    erase those accounts again in the DB target. Counts only in the output.

    The DB target is written only when this run is about the database (the
    DB step runs, or --skip-db --skip-photos: the erasure step on its own).
    A photos-only run (--skip-db) reads the target's tombstones read-only,
    so it needs no DB --confirm-target next to the photo bucket's."""
    from sqlalchemy.engine import make_url
    ctx = ctx if ctx is not None else {}
    out = {"ok": False, "sources": {}}
    found: list[dict] = []

    complete, _ = list_db_exports(bucket)
    newest = complete[-1] if complete else None
    if newest and newest != ctx.get("restored_export"):
        manifest = load_export_manifest(bucket, newest, fernet)
        if manifest is None:
            return {**out, "error": f"export {newest} has no manifest"}
        with tempfile.TemporaryFile() as enc:
            fetch_export(bucket, manifest["parts"], enc)      # part sha256 + size
            enc.seek(0)
            text = read_export_table(DecryptingReader(enc, fernet), "erasure_tombstones")
        t = tombstones_from_csv_text(text) if text is not None else {}
        out["sources"][f"newest export {newest}"] = len(t)
        found.append(t)

    live = (env.get("ERASURE_SOURCE_DATABASE_URL") or "").strip()
    if live:
        try:
            eng = _engine_for(live)
            try:
                t = tombstones_from_engine(eng)
            finally:
                eng.dispose()
        except Exception as e:  # noqa: BLE001 — host + a plain reason, never the URL
            return {**out, "error": "could not read erasure_tombstones from "
                                    f"ERASURE_SOURCE_DATABASE_URL ({_host_db(live)}): "
                                    f"{type(e).__name__} ({_connect_reason(e)})"}
        out["sources"]["ERASURE_SOURCE_DATABASE_URL (read-only)"] = len(t)
        found.append(t)

    target = _db_target(args, env)
    db_write = not args.dry_run and (not args.skip_db or args.skip_photos)
    engine = None
    try:
        if target:
            why = _refuse_main(target, env)
            if why:
                return {**out, "error": f"refused: {why}"}
            url = make_url(_sa_url(target))
            where = f"{url.host}/{url.database}"
            if db_write and args.confirm_target != where:
                return {**out, "error": f"refused: pass --confirm-target {where} to write to it"}
            engine = _engine_for(target)
            try:
                t = tombstones_from_engine(engine)
            except Exception as e:  # noqa: BLE001 — a target without the table has none
                _say(f"  target has no readable erasure_tombstones ({type(e).__name__})")
                t = {}
            out["sources"]["target"] = len(t)
            found.append(t)
        if not found:
            return {**out, "error": "no tombstone source: the backup has no export, "
                                    "ERASURE_SOURCE_DATABASE_URL is not set and there is no DB target"}
        tombstones = merge_tombstones(*found)
        ctx["tombstones"] = tombstones
        out["tombstones"] = len(tombstones)
        _say(f"Erasures: {len(tombstones)} erased account(s) on record "
             f"({', '.join(f'{k}: {v}' for k, v in out['sources'].items())})")
        if engine is not None:
            report = reapply_erasures(engine, tombstones, dry_run=not db_write)
            out["report"] = report
            if not db_write:
                _say(f"  {report['accounts_in_target']} of them are in the DB target (read only: "
                     "nothing changed there)")
            else:
                _say(f"  erased again: {report['accounts_erased']} account(s), "
                     f"{report['rows_deleted']} row(s); team members unlinked: "
                     f"{report['team_members_unlinked']}; tombstones written: "
                     f"{report['tombstones_written']}")
        out["ok"] = True
        return out
    finally:
        if engine is not None:
            engine.dispose()


# ── photos ────────────────────────────────────────────────────────────────

def run_photos(bucket, fernet, args, env, ctx: dict | None = None) -> dict:
    manifest, rebuilt = load_photo_manifest(bucket, fernet)
    entries = manifest["entries"]
    chosen = {k: e for k, e in entries.items()
              if args.include_deleted_photos or not e.get("source_deleted_at")}
    skipped_erased = 0
    if getattr(args, "reapply_erasures", False):
        tombstones = (ctx or {}).get("tombstones")
        if tombstones is None:
            return {"ok": False, "error": "photos not restored: the erasure tombstones could not "
                                          "be read (see the erasures step)"}
        now = utc_now()
        kept = {}
        for k, e in chosen.items():
            if _skip_copy(e.get("uid"), e.get("kind") or "unknown", now, tombstones):
                skipped_erased += 1
            else:
                kept[k] = e
        chosen = kept
    _say(f"Photos: {len(entries)} backup copies ({len(chosen)} selected"
         + (f", {skipped_erased} of erased accounts left out" if skipped_erased else "") + ")"
         + (" — manifest was missing and was rebuilt from the listing" if rebuilt else ""))
    out = {"ok": False, "selected": len(chosen), "verified": 0, "written": 0,
           "already_present": 0, "skipped_erased": skipped_erased, "problems": []}

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
    ap.add_argument("--db-target", help="target Postgres URL (restore, or read-only compare with "
                    "--dry-run). Prefer RESTORE_DB_TARGET_URL: a URL here lands in shell history")
    ap.add_argument("--reapply-erasures", action="store_true",
                    help="erase again in the DB target the accounts erased after the export "
                         "(tombstones: newest export, ERASURE_SOURCE_DATABASE_URL, the target), "
                         "and leave their no-legal-basis photos out of a photo restore")
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
    _set_scrub_terms(env, args)
    urls = [("--db-target" if args.db_target else "RESTORE_DB_TARGET_URL", _db_target(args, env))]
    if args.reapply_erasures:
        urls.append(("ERASURE_SOURCE_DATABASE_URL",
                     (env.get("ERASURE_SOURCE_DATABASE_URL") or "").strip()))
    for name, url in urls:
        problem = _url_problem(url)
        if problem:
            _say(f"error: {name}: {problem}")
            return 1
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

    if not args.dry_run and not (_db_target(args, env) or args.photos_target_dir
                                 or args.photos_target_bucket):
        _say("nothing to write: pass --dry-run, or a target (RESTORE_DB_TARGET_URL / "
             "--photos-target-*)")
        return 1

    summary = {"dry_run": args.dry_run}
    ctx: dict = {}
    steps = (("db", run_db, args.skip_db),
             ("erasures", run_erasures, not args.reapply_erasures),
             ("photos", run_photos, args.skip_photos))
    for part, fn, skip in steps:
        if skip:
            continue
        if part == "erasures" and "db" in summary and not summary["db"].get("ok"):
            summary[part] = {"ok": False, "error": "skipped: the DB step failed"}
            continue
        try:
            summary[part] = fn(backup_bucket, fernet, args, env, ctx)
        except Exception as e:  # noqa: BLE001 — wrong key, unreachable bucket, …
            summary[part] = {"ok": False, "error": f"{type(e).__name__}: {e}"[:500]}
            _say(f"{part}: FAILED: {summary[part]['error']}")
    ok = all(v.get("ok") for k, v in summary.items() if isinstance(v, dict))
    summary["ok"] = ok
    _say(json.dumps(_scrub_obj(summary), indent=1, default=str))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
