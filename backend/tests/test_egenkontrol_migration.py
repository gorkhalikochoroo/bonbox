"""Egenkontrol R1a — Migration 088 (plan "Migrations").

  • a fresh SQLite boot builds the 5 tables and all 11 named indexes, and the
    _index_stmts mirror restores them on a dev DB built without them;
  • every CREATE TABLE in main._migrations has exactly the model's columns,
    typed as create_all types them on Postgres (so the drift check passes);
  • every model index name is in both the PG list and the SQLite mirror;
  • the trigger SQL is in the list, BEFORE UPDATE only, no ON DELETE CASCADE;
  • _verify_schema_no_drift(strict=True) passes; the PG trigger boot check is
    a no-op on SQLite. The Postgres-only half is tests/test_egenkontrol_pg.py.
"""
import ast
import inspect
import re

from sqlalchemy import create_engine, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.pool import StaticPool
from sqlalchemy.schema import CreateTable

import app.main as main
import app.models as models
from app.database import Base
from app.models.food_check import FoodCheck, FoodCheckEntry, FoodCheckRevision, FoodCheckSettings
from app.models.kitchen_link import KitchenLink

MODELS = (KitchenLink, FoodCheck, FoodCheckRevision, FoodCheckEntry, FoodCheckSettings)
TABLES = [m.__tablename__ for m in MODELS]
INDEXES = {
    "ix_kitchen_links_user_id", "ix_kitchen_links_token", "ix_kitchen_links_join_code",
    "ix_food_checks_user_branch", "ix_food_check_revisions_check_valid",
    "ix_food_check_revisions_user", "ux_food_check_entries_client",
    "ix_food_check_entries_user_day", "ix_food_check_entries_check_time",
    "ix_food_check_entries_open_dev", "ix_food_check_entries_recorded",
}
_SKIP = ("PRIMARY KEY", "FOREIGN KEY", "UNIQUE", "CONSTRAINT", "CHECK")


def _split_top(body: str) -> list[str]:
    out, depth, cur = [], 0, []
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    if "".join(cur).strip():
        out.append("".join(cur).strip())
    return out


def _columns(ddl: str) -> dict:
    """{column: (TYPE, not_null)} from a CREATE TABLE statement."""
    body = ddl[ddl.index("(") + 1: ddl.rindex(")")]
    cols = {}
    for item in _split_top(body):
        if item.upper().startswith(_SKIP):
            continue
        name, rest = item.split(None, 1)
        m = re.match(r"(.+?)(?=\s+(?:NOT\s+NULL|DEFAULT|REFERENCES|UNIQUE|PRIMARY)\b|$)", rest, re.I)
        typ = re.sub(r"\s+", "", m.group(1)).upper().replace("WITHOUTTIMEZONE", "")
        notnull = bool(re.search(r"NOT\s+NULL|PRIMARY\s+KEY", rest, re.I))
        cols[name.strip('"')] = (typ, notnull)
    return cols


def _pg_ddl(table: str) -> str:
    for sql in main._migrations:
        s = " ".join(sql.split())
        if re.match(rf"CREATE TABLE IF NOT EXISTS {table} \(", s):
            return s
    raise AssertionError(f"no CREATE TABLE for {table} in _migrations")


def _added_columns(table: str) -> dict:
    """{column: (TYPE, not_null)} from later ALTER TABLE … ADD COLUMN IF NOT
    EXISTS statements (Migration 089 adds two columns to 088 tables)."""
    out = {}
    for sql in main._migrations:
        s = " ".join(sql.split())
        m = re.match(rf"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS (\w+) (.+)$", s)
        if m:
            out.update(_columns(f"x ({m.group(1)} {m.group(2)})"))
    return out


def _block_088() -> list[str]:
    """The 088 statements: from kitchen_links up to (not including) the first
    Migration 089 statement (food_check_reviews)."""
    start = next(i for i, s in enumerate(main._migrations)
                 if "CREATE TABLE IF NOT EXISTS kitchen_links" in s)
    end = next(i for i, s in enumerate(main._migrations)
               if "CREATE TABLE IF NOT EXISTS food_check_reviews" in s)
    return main._migrations[start:end]


def _index_stmts() -> list[str]:
    """The literal `_index_stmts` list inside _run_migrations (SQLite branch)."""
    tree = ast.parse(inspect.getsource(main._run_migrations).lstrip())
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "_index_stmts":
            return ast.literal_eval(node.value)
    raise AssertionError("_index_stmts not found")


def _fresh():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return eng


def test_fresh_sqlite_has_the_tables_and_every_named_index():
    eng = _fresh()
    with eng.connect() as c:
        tables = {r[0] for r in c.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}
        idx = {r[0]: r[1] for r in c.execute(text(
            "SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"))}
    assert set(TABLES) <= tables
    assert INDEXES <= set(idx), INDEXES - set(idx)
    assert idx["ux_food_check_entries_client"].upper().startswith("CREATE UNIQUE INDEX")
    assert "WHERE deviation_state = 'open'" in idx["ix_food_check_entries_open_dev"]


def test_the_sqlite_mirror_restores_the_indexes_on_an_old_dev_db():
    eng = _fresh()
    mirror = [s for s in _index_stmts() if any(n in s for n in INDEXES)]
    assert len(mirror) == 11
    with eng.begin() as c:
        for name in INDEXES:
            c.execute(text(f"DROP INDEX IF EXISTS {name}"))
        for s in mirror:
            c.execute(text(s))
        idx = {r[0]: r[1] for r in c.execute(text(
            "SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"))}
    assert INDEXES <= set(idx)
    assert idx["ux_food_check_entries_client"].upper().startswith("CREATE UNIQUE INDEX")
    assert "WHERE deviation_state = 'open'" in idx["ix_food_check_entries_open_dev"]


def test_each_create_table_matches_the_model_names_and_pg_types():
    for model in MODELS:
        t = model.__table__
        mine = {**_columns(_pg_ddl(t.name)), **_added_columns(t.name)}
        theirs = _columns(" ".join(str(CreateTable(t).compile(dialect=postgresql.dialect())).split()))
        assert set(mine) == set(theirs), (t.name, set(mine) ^ set(theirs))
        for col, (typ, notnull) in theirs.items():
            assert mine[col][0] == typ, (t.name, col, mine[col][0], typ)
            assert mine[col][1] == notnull, (t.name, col, "NOT NULL differs")


def test_every_index_is_in_the_pg_list_and_the_sqlite_mirror():
    pg = " ".join(main._migrations)
    lite = " ".join(_index_stmts())
    declared = {ix.name for m in MODELS for ix in m.__table__.indexes}
    assert declared == INDEXES
    for name in INDEXES:
        assert f"IF NOT EXISTS {name} ON" in pg, name
        assert f"IF NOT EXISTS {name} ON" in lite, name
    # byte-identical statements in both lists
    pg_ix = {s for s in main._migrations if any(f" {n} ON" in s for n in INDEXES)}
    lite_ix = {s for s in _index_stmts() if any(f" {n} ON" in s for n in INDEXES)}
    assert pg_ix == lite_ix


def test_the_088_block_has_the_triggers_and_no_cascade():
    block = _block_088()
    assert main._EK_ENTRY_GUARD_FN in block and main._EK_REVISION_GUARD_FN in block
    dos = [s for s in block if s.startswith("DO $$")]
    assert len(dos) == 2
    for trg, (table, fn) in main._EK_TRIGGERS.items():
        do = next(s for s in dos if trg in s)
        assert f"BEFORE UPDATE ON {table}" in do and f"EXECUTE FUNCTION {fn}()" in do
        assert "DELETE" not in do
    assert all("ON DELETE CASCADE" not in s.upper() for s in block)
    assert all(not re.search(r"(?<!:):[A-Za-z_]", s) for s in block), "no :name tokens in text()"
    # to_jsonb minus the four allowed keys protects every present and future column
    assert "to_jsonb(NEW) - 'deviation_state' - 'voided_at' - 'void_reason' - 'staff_id'" \
        in main._EK_ENTRY_GUARD_FN
    # 088 ends with its trigger DO blocks; Migration 089 (R1b) follows it
    # directly (tests/test_egenkontrol_r1b_migration.py).
    assert block[-1] == dos[-1]


def test_the_runner_has_no_ledger_so_a_missing_087_is_harmless():
    """Numbers live only in comments; _migration_already_applied decides from
    the live catalog. So 088 running on a branch without 087 is fine."""
    src = inspect.getsource(main._run_migrations)
    assert "schema_migrations" not in src and "alembic_version" not in src
    catalog = {"rels": {"kitchen_links"}, "cols": set(), "cons": set()}
    assert main._migration_already_applied(_pg_ddl("kitchen_links"), catalog) is True
    assert main._migration_already_applied(_pg_ddl("food_checks"), catalog) is False


def test_drift_check_passes_and_the_trigger_check_is_pg_only():
    eng = _fresh()
    with eng.connect() as c:
        main._verify_schema_no_drift(c, strict=True)
        assert main._verify_egenkontrol_immutability(c) == []


def test_models_are_registered():
    for name in ("FoodCheck", "FoodCheckRevision", "FoodCheckEntry", "FoodCheckSettings",
                 "KitchenLink"):
        assert name in models.__all__ and hasattr(models, name)
