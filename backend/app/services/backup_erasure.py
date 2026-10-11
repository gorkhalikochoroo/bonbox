"""Re-apply account erasures after a restore from the off-project backup.

A DB export is a snapshot. Restoring one brings back every account that was
erased AFTER that snapshot — GDPR Art.17 erasures the owner was told are done.
The erasure_tombstones table (one row per erased account, written in the same
commit as the delete, kept for the 6-year accounting window) says which
accounts those are, so after a restore this module erases them again in the
target, the way /api/auth/delete-account does it in the database:

  • every row of every app table that belongs to the account
    (routers/auth._owned_by_uid_predicate, children before parents), except
    the tables delete_account keeps (RETAINED_TABLES: the change log, the
    security log and the error log);
  • its team members are UNLINKED, never erased (team.remove_member: an owner
    can only delete the account once the team is removed, and a removed
    member is an independent account);
  • any other users row that points at it (invited_by_user_id) is cleared;
  • the users row goes, and the tombstone is (re)written so the retention
    sweep still finds the account's retained accounting images.

Only the database: the outside steps of the original erasure (Stripe, the
PSD2 consent, the storage blobs) are not repeated — the restore did not undo
them. Photos restored from the backup are filtered by the same tombstones in
scripts/restore_from_backup.py.

One transaction: it commits only when every account is erased (a table that
cannot be cleaned is reported, and the account's users-row delete then fails
the whole run). Tombstones come from the newest export in the backup and/or
the live database (read-only) — see the restore script.
"""
from __future__ import annotations

import csv
import io
import sys
import uuid
from datetime import datetime, timezone
from typing import Iterable, Optional

# = delete_account's _ERASURE_RETAINED_TABLES (routers/auth.py); a test reads
# both and fails when they drift apart.
RETAINED_TABLES = frozenset({"audit_logs", "security_events", "error_logs"})


def _parse_dt(value) -> Optional[datetime]:
    if isinstance(value, datetime):
        dt = value
    else:
        s = str(value or "").strip()
        if not s:
            return None
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def parse_tombstone_rows(rows: Iterable) -> dict[str, datetime]:
    """{lowercase uuid str: erased_at} from (user_id, erased_at) pairs or
    {"user_id", "erased_at"} dicts (an export's CSV, a DB query). A row that
    does not parse is an error, never silently skipped: a skipped tombstone
    is an erased account that comes back."""
    out: dict[str, datetime] = {}
    for r in rows:
        uid, at = (r["user_id"], r["erased_at"]) if isinstance(r, dict) else (r[0], r[1])
        try:
            key = str(uuid.UUID(str(uid))).lower()
        except (ValueError, TypeError):
            raise ValueError("erasure_tombstones holds a user_id that is not a uuid") from None
        when = _parse_dt(at)
        if when is None:
            raise ValueError("erasure_tombstones holds an erased_at that is not a timestamp")
        out[key] = min(when, out.get(key, when))
    return out


def merge_tombstones(*sources: dict) -> dict[str, datetime]:
    out: dict[str, datetime] = {}
    for src in sources:
        for k, v in (src or {}).items():
            out[k] = min(v, out.get(k, v))
    return out


def tombstones_from_csv_text(text: str) -> dict[str, datetime]:
    old = csv.field_size_limit()
    csv.field_size_limit(min(sys.maxsize, 1 << 20))
    try:
        return parse_tombstone_rows(csv.DictReader(io.StringIO(text)))
    finally:
        csv.field_size_limit(old)


def tombstones_from_engine(engine) -> dict[str, datetime]:
    """Read erasure_tombstones from a database (SQLAlchemy engine), read-only."""
    from sqlalchemy import text
    with engine.connect() as conn:
        if engine.dialect.name == "postgresql":
            conn.execute(text("SET TRANSACTION READ ONLY"))
        rows = conn.execute(text("SELECT user_id, erased_at FROM erasure_tombstones")).fetchall()
        conn.rollback()
    return parse_tombstone_rows(rows)


def reapply_erasures(engine, tombstones: dict[str, datetime], *, dry_run: bool = False) -> dict:
    """Erase, in the database behind `engine`, every account in `tombstones`
    that is (back) in it. Counts only in the report — no ids, no row data.
    `dry_run`: count, change nothing."""
    import app.models  # noqa: F401 — register every model
    from sqlalchemy import inspect, select
    from app.database import Base
    from app.routers.auth import _owned_by_uid_predicate

    users = Base.metadata.tables["users"]
    tomb = Base.metadata.tables["erasure_tombstones"]
    user_refs = [c for c in users.columns
                 if c.name != "owner_id" and any(fk.column.table.name == "users" for fk in c.foreign_keys)]
    report = {"dry_run": dry_run, "tombstones": len(tombstones), "accounts_in_target": 0,
              "accounts_erased": 0, "rows_deleted": 0, "team_members_unlinked": 0,
              "user_refs_cleared": 0, "tombstones_written": 0, "tables_failed": []}
    with engine.connect() as conn:
        trans = conn.begin()
        try:
            present = set(inspect(conn).get_table_names())
            have = {str(r[0]).lower() for r in conn.execute(select(tomb.c.user_id))} \
                if "erasure_tombstones" in present else set()
            for key, erased_at in sorted(tombstones.items()):
                uid = uuid.UUID(key)
                back = conn.execute(select(users.c.id).where(users.c.id == uid)).first() is not None
                if back:
                    report["accounts_in_target"] += 1
                if dry_run:
                    continue
                if back:
                    for table in reversed(Base.metadata.sorted_tables):
                        if table.name == "users" or table.name in RETAINED_TABLES \
                                or table.name not in present:
                            continue
                        pred = _owned_by_uid_predicate(table, uid)
                        if pred is None:
                            continue
                        try:
                            with conn.begin_nested():
                                res = conn.execute(table.delete().where(pred))
                                report["rows_deleted"] += max(res.rowcount or 0, 0)
                        except Exception:  # noqa: BLE001 — reported; the users delete decides
                            if table.name not in report["tables_failed"]:
                                report["tables_failed"].append(table.name)
                    res = conn.execute(users.update().where(users.c.owner_id == uid).values(
                        owner_id=None, role="owner", invite_token_hash=None, invite_expires_at=None))
                    report["team_members_unlinked"] += max(res.rowcount or 0, 0)
                    for col in user_refs:
                        res = conn.execute(users.update().where(col == uid).values({col.name: None}))
                        report["user_refs_cleared"] += max(res.rowcount or 0, 0)
                    try:
                        with conn.begin_nested():
                            conn.execute(users.delete().where(users.c.id == uid))
                    except Exception as e:  # noqa: BLE001 — no ids or row data in the message
                        raise RuntimeError(
                            f"an erased account could not be deleted again ({type(e).__name__}); "
                            f"tables that could not be cleaned: {report['tables_failed'] or 'none'}. "
                            "Nothing was changed.") from None
                    report["accounts_erased"] += 1
                if "erasure_tombstones" in present and key not in have:
                    conn.execute(tomb.insert().values(user_id=uid, erased_at=erased_at))
                    report["tombstones_written"] += 1
            if dry_run:
                trans.rollback()
            else:
                trans.commit()
        except Exception:
            trans.rollback()
            raise
    return report
