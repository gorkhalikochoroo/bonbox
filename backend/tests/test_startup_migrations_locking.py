"""Startup migrations must not freeze the live tables on every deploy.

They ran in ONE transaction with a SAVEPOINT each and a single commit at the
end. ALTER TABLE … ADD COLUMN IF NOT EXISTS takes an ACCESS EXCLUSIVE lock
even when the column already exists, so every boot held locks on the core
tables for ~35 s while the old instance still served traffic (a live read
waited 28 s on 27 Sep 2026). Now the catalog is read once, anything already
applied is skipped, and whatever runs gets its own short transaction with a
lock_timeout. CI runs SQLite, so the PG branch is pinned here statically and
the skip rules are tested directly.
"""
import inspect

from app import main
from app.main import _migration_already_applied, _migrations

CATALOG = {
    "cols": {("users", "ui_language"), ("reservations", "guest_lang"), ("sales", "is_deleted")},
    "rels": {"users", "ix_sales_user_date", "floor_fixtures"},
    "cons": {("audit_logs", "audit_logs_user_id_fkey")},
}


def applied(sql):
    return _migration_already_applied(sql, CATALOG)


def test_an_existing_column_is_skipped_a_missing_one_runs():
    assert applied("ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_language VARCHAR(8)")
    assert not applied("ALTER TABLE users ADD COLUMN IF NOT EXISTS brand_new VARCHAR(8)")


def test_a_multi_column_add_is_skipped_only_when_every_column_exists():
    both = "ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN, ADD COLUMN IF NOT EXISTS gone TEXT"
    assert not applied(both)


def test_existing_indexes_and_tables_are_skipped():
    assert applied("CREATE INDEX IF NOT EXISTS ix_sales_user_date ON sales (user_id, date)")
    assert not applied("CREATE UNIQUE INDEX IF NOT EXISTS ix_new ON sales (id)")
    assert applied("CREATE TABLE IF NOT EXISTS floor_fixtures (id VARCHAR(36))")
    assert not applied("CREATE TABLE IF NOT EXISTS brand_new_table (id INT)")


def test_dropping_a_constraint_that_is_already_gone_is_skipped():
    assert not applied("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_user_id_fkey")
    assert applied("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_id_fkey")


def test_anything_not_provably_done_still_runs():
    for sql in (
        "ALTER TABLE users ALTER COLUMN ui_language TYPE VARCHAR(16)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_language VARCHAR(8), ALTER COLUMN x SET NOT NULL",
        "UPDATE users SET plan = 'free' WHERE plan IS NULL",
        "DO $$ BEGIN PERFORM 1; END $$",
    ):
        assert not applied(sql), sql


def test_a_normal_deploy_skips_nearly_everything():
    """Against a catalog that already has every column, index and table the
    list creates, the only statements left are the few that are not simple
    IF NOT EXISTS DDL."""
    import re
    cols, rels = set(), set()
    for sql in _migrations:
        s = " ".join(sql.split())
        m = re.match(r'(?i)^ALTER TABLE (?:IF EXISTS )?"?(\w+)"?', s)
        if m:
            for c in re.findall(r'(?i)ADD COLUMN IF NOT EXISTS "?(\w+)"?', s):
                cols.add((m.group(1).lower(), c.lower()))
        for pat in (r'(?i)^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "?(\w+)"?', r'(?i)^CREATE TABLE IF NOT EXISTS "?(\w+)"?'):
            m = re.match(pat, s)
            if m:
                rels.add(m.group(1).lower())
    full = {"cols": cols, "rels": rels, "cons": set()}
    left = [s for s in _migrations if not _migration_already_applied(s, full)]
    assert len(left) <= 40, f"{len(left)} statements still run on a no-change deploy"


def test_the_pg_branch_commits_per_statement_with_a_lock_timeout():
    src = inspect.getsource(main._run_migrations)
    assert 'text(f"SAVEPOINT' not in src, "one long transaction holds every lock until the end"
    assert "with conn.begin():" in src
    assert "lock_timeout" in src
    assert "_migration_already_applied" in src
