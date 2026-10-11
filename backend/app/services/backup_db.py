"""Logical database export / verify / restore for the off-project backup.

Why not pg_dump: Render's apt Postgres client is older than the server
(Supabase PG 17), and pg_dump refuses to dump a newer server. COPY over the
app's own psycopg2 connection has no version coupling.

Export format (plaintext, before services/backup_crypto encrypts it) is a
gzip-compressed tar stream with members in this order:

    schema.json         format, server version, alembic_version (if any),
                        app commit, and every table with its column list
    data/0001.csv ...   one CSV per table (COPY ... TO STDOUT, CSV, HEADER)
    meta.json           per-table row count, sha256 and size of its CSV

Consistency: every COPY runs inside ONE `REPEATABLE READ, READ ONLY`
transaction, so all tables come from the same snapshot (what pg_dump does).
COPY takes only ACCESS SHARE locks; lock_timeout and statement_timeout bound
how long it can wait or run.

Memory: each table is spooled through a SpooledTemporaryFile (spills to disk
past SPOOL_BYTES) so its size is known for the tar header; tar, gzip and the
encrypting writer all stream. Peak memory is a few MiB whatever the table size.

SQLite (dev/tests) is exported through SELECT with the same CSV conventions
(unquoted empty = NULL, quoted "" = empty string), so the verifier is the same.
Restore targets Postgres only.
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import sys
import tarfile
import tempfile
import time
from typing import BinaryIO, Callable, Optional

EXPORT_FORMAT = "bonbox-logical-export/1"
SPOOL_BYTES = 4 << 20
STATEMENT_TIMEOUT_MS = 10 * 60 * 1000
LOCK_TIMEOUT_MS = 15 * 1000
_CSV_FIELD_LIMIT = 256 << 20

Check = Optional[Callable[[], None]]


class ExportError(RuntimeError):
    pass


class VerifyError(RuntimeError):
    pass


def _qi(name: str) -> str:
    """Quote an SQL identifier."""
    return '"' + str(name).replace('"', '""') + '"'


class _HashingWriter:
    def __init__(self, inner):
        self.inner = inner
        self.sha = hashlib.sha256()
        self.size = 0

    def write(self, b):
        if isinstance(b, str):
            b = b.encode("utf-8")
        self.sha.update(b)
        self.size += len(b)
        return self.inner.write(b)


class _HashingReader(io.RawIOBase):
    def __init__(self, inner):
        super().__init__()
        self.inner = inner
        self.sha = hashlib.sha256()
        self.size = 0

    def readable(self):
        return True

    def readinto(self, b):
        data = self.inner.read(len(b))
        if not data:
            return 0
        n = len(data)
        b[:n] = data
        self.sha.update(data)
        self.size += n
        return n


# ── catalog ──────────────────────────────────────────────────────────────

def _pg_catalog(cur) -> dict:
    cur.execute("SHOW server_version")
    server_version = cur.fetchone()[0]
    cur.execute("SELECT current_schema()")
    schema = cur.fetchone()[0]
    cur.execute(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') "
        "AND NOT c.relispartition ORDER BY c.relname"
    )
    names = [r[0] for r in cur.fetchall()]
    tables = []
    for name in names:
        cur.execute(
            "SELECT a.attname, format_type(a.atttypid, a.atttypmod) "
            "FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid "
            "JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = current_schema() AND c.relname = %s "
            "AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' "
            "ORDER BY a.attnum",
            (name,),
        )
        tables.append({"name": name, "columns": [[r[0], r[1]] for r in cur.fetchall()]})
    alembic = None
    if "alembic_version" in names:
        cur.execute("SELECT version_num FROM alembic_version")
        alembic = [r[0] for r in cur.fetchall()]
    return {"server": f"postgresql {server_version}", "schema": schema,
            "alembic_version": alembic, "tables": tables}


def _sqlite_catalog(cur) -> dict:
    cur.execute("SELECT sqlite_version()")
    ver = cur.fetchone()[0]
    cur.execute("SELECT name FROM sqlite_master WHERE type = 'table' "
                "AND name NOT LIKE 'sqlite_%' ORDER BY name")
    names = [r[0] for r in cur.fetchall()]
    tables = []
    for name in names:
        cur.execute(f"PRAGMA table_info({_qi(name)})")
        tables.append({"name": name, "columns": [[r[1], r[2] or ""] for r in cur.fetchall()]})
    alembic = None
    if "alembic_version" in names:
        cur.execute("SELECT version_num FROM alembic_version")
        alembic = [r[0] for r in cur.fetchall()]
    return {"server": f"sqlite {ver}", "schema": "main",
            "alembic_version": alembic, "tables": tables}


def _schema_fingerprint(tables: list[dict]) -> str:
    canon = json.dumps([[t["name"], t["columns"]] for t in tables], separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()


# ── CSV writers ──────────────────────────────────────────────────────────

def _sqlite_field(v) -> str:
    if v is None:
        return ""
    if isinstance(v, (bytes, bytearray, memoryview)):
        s = "\\x" + bytes(v).hex()
    elif isinstance(v, bool):
        s = "t" if v else "f"
    else:
        s = str(v)
    return '"' + s.replace('"', '""') + '"'


def _copy_sqlite_table(cur, table: dict, sink) -> int:
    cols = [c[0] for c in table["columns"]]
    sink.write((",".join(_sqlite_field(c) for c in cols) + "\n").encode("utf-8"))
    cur.execute(f"SELECT {', '.join(_qi(c) for c in cols)} FROM {_qi(table['name'])}")
    rows = 0
    while True:
        batch = cur.fetchmany(500)
        if not batch:
            break
        buf = "".join(",".join(_sqlite_field(v) for v in row) + "\n" for row in batch)
        sink.write(buf.encode("utf-8"))
        rows += len(batch)
    return rows


def _copy_pg_table(cur, schema: str, table: dict, sink) -> int:
    cols = ", ".join(_qi(c[0]) for c in table["columns"])
    sql = (f"COPY (SELECT {cols} FROM {_qi(schema)}.{_qi(table['name'])}) "
           "TO STDOUT WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')")
    cur.copy_expert(sql, sink)
    return int(cur.rowcount)


def _add_bytes(tar: tarfile.TarFile, name: str, data: bytes, mtime: float) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mtime = int(mtime)
    info.mode = 0o600
    tar.addfile(info, io.BytesIO(data))


# ── export ───────────────────────────────────────────────────────────────

def export_database(dbapi_conn, dialect: str, out: BinaryIO, *, check: Check = None,
                    app_commit: str | None = None, spool_bytes: int = SPOOL_BYTES) -> dict:
    """Write the gzip-tar export of every table to `out` (a plaintext stream,
    normally a backup_crypto.EncryptingWriter). Returns the meta dict.

    `dbapi_conn` is a raw DBAPI connection (psycopg2 or sqlite3). On Postgres
    the work runs in one REPEATABLE READ READ ONLY transaction, rolled back at
    the end. `check()` is called between tables (deadline / lock heartbeat) and
    may raise to abort."""
    started = time.time()
    cur = dbapi_conn.cursor()
    try:
        if dialect == "postgresql":
            dbapi_conn.rollback()
            cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            cur.execute(f"SET LOCAL statement_timeout = {int(STATEMENT_TIMEOUT_MS)}")
            cur.execute(f"SET LOCAL lock_timeout = {int(LOCK_TIMEOUT_MS)}")
            catalog = _pg_catalog(cur)
        elif dialect == "sqlite":
            catalog = _sqlite_catalog(cur)
        else:
            raise ExportError(f"unsupported dialect {dialect!r}")

        tables = catalog["tables"]
        for i, t in enumerate(tables, start=1):
            t["file"] = f"data/{i:04d}.csv"
        schema_doc = {
            "format": EXPORT_FORMAT,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
            "server": catalog["server"],
            "schema": catalog["schema"],
            "alembic_version": catalog["alembic_version"],
            "app_commit": app_commit,
            "schema_fingerprint": _schema_fingerprint(tables),
            "tables": tables,
        }

        gz = gzip.GzipFile(fileobj=out, mode="wb", compresslevel=6, mtime=0)
        tar = tarfile.open(fileobj=gz, mode="w|", format=tarfile.PAX_FORMAT)
        _add_bytes(tar, "schema.json", json.dumps(schema_doc, indent=1).encode(), started)

        results: dict[str, dict] = {}
        total_rows = 0
        total_bytes = 0
        for t in tables:
            if check:
                check()
            with tempfile.SpooledTemporaryFile(max_size=spool_bytes) as spool:
                sink = _HashingWriter(spool)
                if dialect == "postgresql":
                    rows = _copy_pg_table(cur, catalog["schema"], t, sink)
                else:
                    rows = _copy_sqlite_table(cur, t, sink)
                spool.seek(0)
                info = tarfile.TarInfo(t["file"])
                info.size = sink.size
                info.mtime = int(started)
                info.mode = 0o600
                tar.addfile(info, spool)
            results[t["name"]] = {"file": t["file"], "rows": rows,
                                  "sha256": sink.sha.hexdigest(), "bytes": sink.size}
            total_rows += rows
            total_bytes += sink.size

        meta = {
            "format": EXPORT_FORMAT,
            "schema_fingerprint": schema_doc["schema_fingerprint"],
            "created_at": schema_doc["created_at"],
            "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "table_count": len(tables),
            "total_rows": total_rows,
            "total_csv_bytes": total_bytes,
            "tables": results,
        }
        _add_bytes(tar, "meta.json", json.dumps(meta, indent=1).encode(), started)
        tar.close()
        gz.close()
        meta["server"] = schema_doc["server"]
        meta["alembic_version"] = schema_doc["alembic_version"]
        meta["app_commit"] = app_commit
        return meta
    finally:
        try:
            cur.close()
        finally:
            if dialect == "postgresql":
                try:
                    dbapi_conn.rollback()
                except Exception:  # noqa: BLE001 — connection may be gone
                    pass


# ── verify (dry run) ─────────────────────────────────────────────────────

def _count_csv_rows(fileobj) -> int:
    text = io.TextIOWrapper(fileobj, encoding="utf-8", newline="")
    old = csv.field_size_limit()
    csv.field_size_limit(min(sys.maxsize, _CSV_FIELD_LIMIT))
    try:
        n = sum(1 for _ in csv.reader(text))
    finally:
        csv.field_size_limit(old)
        text.detach()
    return max(0, n - 1)  # header line


def verify_export_stream(plain: BinaryIO, *, count_rows: bool = True, check: Check = None) -> dict:
    """Read an export (plaintext stream) end to end. Every table CSV is hashed
    and, with count_rows, parsed; both are compared with meta.json. Raises
    VerifyError on any mismatch; returns a report otherwise."""
    gz = gzip.GzipFile(fileobj=plain, mode="rb")
    tar = tarfile.open(fileobj=gz, mode="r|")
    schema_doc = None
    meta = None
    seen: dict[str, dict] = {}
    by_file: dict[str, str] = {}
    for member in tar:
        if check:
            check()
        f = tar.extractfile(member) if member.isfile() else None
        if f is None:
            raise VerifyError(f"unexpected tar member {member.name!r}")
        if member.name == "schema.json":
            schema_doc = json.loads(f.read())
            if schema_doc.get("format") != EXPORT_FORMAT:
                raise VerifyError("unknown export format")
            by_file = {t["file"]: t["name"] for t in schema_doc["tables"]}
        elif member.name == "meta.json":
            meta = json.loads(f.read())
        elif member.name.startswith("data/"):
            if schema_doc is None:
                raise VerifyError("data before schema.json")
            name = by_file.get(member.name)
            if name is None:
                raise VerifyError(f"data file {member.name} not in schema.json")
            hr = _HashingReader(f)
            if count_rows:
                rows = _count_csv_rows(io.BufferedReader(hr, 1 << 16))
            else:
                rows = None
                while hr.read(1 << 16):
                    pass
            seen[name] = {"sha256": hr.sha.hexdigest(), "bytes": hr.size, "rows": rows}
        else:
            raise VerifyError(f"unexpected tar member {member.name!r}")
    tar.close()
    if schema_doc is None or meta is None:
        raise VerifyError("export is missing schema.json or meta.json")
    expected = meta.get("tables") or {}
    problems = []
    if set(expected) != set(seen) or set(seen) != set(by_file.values()):
        problems.append("table set differs between schema.json, meta.json and data")
    for name, exp in expected.items():
        got = seen.get(name)
        if not got:
            continue
        if got["sha256"] != exp["sha256"]:
            problems.append(f"{name}: sha256 mismatch")
        if got["bytes"] != exp["bytes"]:
            problems.append(f"{name}: size mismatch")
        if count_rows and got["rows"] != exp["rows"]:
            problems.append(f"{name}: {got['rows']} rows, meta says {exp['rows']}")
    if problems:
        raise VerifyError("; ".join(problems[:20]))
    return {
        "tables": len(seen),
        "rows": sum(v["rows"] or 0 for v in seen.values()) if count_rows else None,
        "csv_bytes": sum(v["bytes"] for v in seen.values()),
        "rows_checked": count_rows,
        "schema_fingerprint": schema_doc.get("schema_fingerprint"),
        "created_at": schema_doc.get("created_at"),
        "per_table": {k: {"rows": v["rows"], "sha256": v["sha256"]} for k, v in sorted(seen.items())},
        "_meta": meta,
    }


# ── restore (Postgres target) ────────────────────────────────────────────

def _target_columns(cur, table: str) -> list[str] | None:
    cur.execute(
        "SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid "
        "JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = current_schema() AND c.relname = %s AND c.relkind IN ('r','p') "
        "AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
        (table,),
    )
    rows = cur.fetchall()
    return [r[0] for r in rows] if rows else None


def restore_export_stream(plain: BinaryIO, target_conn, *, truncate: bool = False,
                          skip_missing_tables: bool = False, check: Check = None) -> dict:
    """Load an export into the target Postgres (psycopg2 connection), in ONE
    transaction: every table's CSV is hashed while COPY FROM streams it, and the
    transaction commits only if every row count and hash matches meta.json.

    The target must already have the schema (the app's startup creates it, or
    a 'Restore to new project' copy has it). Target tables must be empty unless
    `truncate`. FK triggers are disabled for the load with
    session_replication_role = replica (needs the postgres/superuser role).
    With `skip_missing_tables`, export tables the target does not have are
    skipped and listed in the report (a column missing from a table that does
    exist is always an error: loading would drop data)."""
    cur = target_conn.cursor()
    target_conn.rollback()
    report = {"tables": 0, "rows": 0, "per_table": {}}
    ok = False
    try:
        cur.execute(f"SET LOCAL statement_timeout = {int(STATEMENT_TIMEOUT_MS)}")
        try:
            cur.execute("SET LOCAL session_replication_role = replica")
        except Exception as e:  # noqa: BLE001
            raise VerifyError(
                "cannot disable FK triggers for the load (session_replication_role needs "
                f"the postgres/superuser role): {type(e).__name__}") from None
        skipped: list[str] = []
        file_table: dict[str, str] = {}
        gz = gzip.GzipFile(fileobj=plain, mode="rb")
        tar = tarfile.open(fileobj=gz, mode="r|")
        schema_doc = None
        meta = None
        by_file: dict[str, dict] = {}
        loaded: dict[str, dict] = {}
        for member in tar:
            if check:
                check()
            f = tar.extractfile(member) if member.isfile() else None
            if f is None:
                raise VerifyError(f"unexpected tar member {member.name!r}")
            if member.name == "schema.json":
                schema_doc = json.loads(f.read())
                if schema_doc.get("format") != EXPORT_FORMAT:
                    raise VerifyError("unknown export format")
                missing = []
                file_table = {t["file"]: t["name"] for t in schema_doc["tables"]}
                for t in schema_doc["tables"]:
                    cols = _target_columns(cur, t["name"])
                    if cols is None:
                        if skip_missing_tables:
                            skipped.append(t["name"])
                        else:
                            missing.append(f"table {t['name']}")
                        continue
                    for c, _type in t["columns"]:
                        if c not in cols:
                            missing.append(f"{t['name']}.{c}")
                    by_file[t["file"]] = t
                if missing:
                    raise VerifyError("target schema lacks: " + ", ".join(missing[:20])
                                      + " (boot the app at the export's app_commit against the "
                                      "target first, or pass --skip-missing-tables)")
                names = [t["name"] for t in by_file.values()]
                if truncate and names:
                    cur.execute("TRUNCATE " + ", ".join(_qi(n) for n in names))
                else:
                    nonempty = []
                    for n in names:
                        cur.execute(f"SELECT EXISTS (SELECT 1 FROM {_qi(n)})")
                        if cur.fetchone()[0]:
                            nonempty.append(n)
                    if nonempty:
                        raise VerifyError(
                            "target tables are not empty (pass --truncate to replace): "
                            + ", ".join(nonempty[:10]))
            elif member.name == "meta.json":
                meta = json.loads(f.read())
            elif member.name.startswith("data/"):
                t = by_file.get(member.name)
                if t is None:
                    if file_table.get(member.name) in skipped:
                        continue      # a skipped table; tarfile skips its bytes
                    raise VerifyError(f"data file {member.name} not in schema.json")
                cols = ", ".join(_qi(c[0]) for c in t["columns"])
                hr = _HashingReader(f)
                cur.copy_expert(
                    f"COPY {_qi(t['name'])} ({cols}) FROM STDIN WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')",
                    io.BufferedReader(hr, 1 << 16),
                )
                loaded[t["name"]] = {"rows": int(cur.rowcount), "sha256": hr.sha.hexdigest()}
            else:
                raise VerifyError(f"unexpected tar member {member.name!r}")
        tar.close()
        if schema_doc is None or meta is None:
            raise VerifyError("export is missing schema.json or meta.json")
        problems = []
        for name, exp in (meta.get("tables") or {}).items():
            if name in skipped:
                continue
            got = loaded.get(name)
            if got is None:
                problems.append(f"{name}: not loaded")
            elif got["rows"] != exp["rows"] or got["sha256"] != exp["sha256"]:
                problems.append(f"{name}: loaded {got['rows']} rows, expected {exp['rows']}")
        if problems:
            raise VerifyError("; ".join(problems[:20]))
        # Serial/identity sequences restart after the highest restored id.
        for t in by_file.values():
            for c, _type in t["columns"]:
                cur.execute("SELECT pg_get_serial_sequence(%s, %s)", (_qi(t["name"]), c))
                seq = cur.fetchone()[0]
                if seq:
                    cur.execute(
                        f"SELECT setval(%s, COALESCE((SELECT max({_qi(c)}) FROM {_qi(t['name'])}), 1), "
                        f"(SELECT max({_qi(c)}) FROM {_qi(t['name'])}) IS NOT NULL)",
                        (seq,),
                    )
        report["tables"] = len(loaded)
        report["rows"] = sum(v["rows"] for v in loaded.values())
        report["per_table"] = loaded
        report["skipped_tables"] = skipped
        target_conn.commit()
        ok = True
        return report
    finally:
        if not ok:
            try:
                target_conn.rollback()
            except Exception:  # noqa: BLE001
                pass
        cur.close()
