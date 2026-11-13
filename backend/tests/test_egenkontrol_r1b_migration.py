"""Egenkontrol R1b — Migration 089 (3 tables, 3 columns, 4 indexes, the
'correction' void reason) and the app-level rules on the new tables.

The Postgres-only half (trigger with 'correction', erasure and purges with
photos, reason_text immutable) is tests/test_egenkontrol_pg.py.
"""
import inspect
import re
import uuid
from datetime import date, datetime

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy.schema import CreateTable

import app.main as main
import app.models as models
from app.database import Base
from app.models.food_check import (
    EntryImmutableError, FoodCheckDocument, FoodCheckEntry, FoodCheckPhoto, FoodCheckReview,
    FoodCheckSettings,
)
from tests.test_egenkontrol_migration import _columns, _index_stmts, _pg_ddl

NEW = (FoodCheckReview, FoodCheckDocument, FoodCheckPhoto)
INDEXES = {"ux_food_check_reviews_week", "ix_food_check_documents_user",
           "ux_food_check_photos_entry", "ix_food_check_photos_user"}
ALTERS = [
    "ALTER TABLE food_check_entries ADD COLUMN IF NOT EXISTS reason_text VARCHAR(120)",
    "ALTER TABLE food_check_entries ADD COLUMN IF NOT EXISTS correction_text VARCHAR(120)",
    "ALTER TABLE food_check_settings ADD COLUMN IF NOT EXISTS opted_in BOOLEAN NOT NULL DEFAULT FALSE",
]


def _block_089() -> list[str]:
    start = next(i for i, s in enumerate(main._migrations)
                 if "CREATE TABLE IF NOT EXISTS food_check_reviews" in s)
    return main._migrations[start:]


def test_the_089_block_is_in_the_list():
    block = _block_089()
    joined = " ".join(" ".join(s.split()) for s in block)
    for t in ("food_check_reviews", "food_check_documents", "food_check_photos"):
        assert f"CREATE TABLE IF NOT EXISTS {t} (" in joined, t
    for a in ALTERS:
        assert a in block, a
    for name in INDEXES:
        assert f"IF NOT EXISTS {name} ON" in joined, name
    assert "ON DELETE CASCADE" not in joined.upper()
    assert all(not re.search(r"(?<!:):[A-Za-z_]", s) for s in block), "no :name tokens"
    assert not any(s.startswith("DO $$") for s in block)       # no new triggers
    # it follows the 088 trigger blocks directly
    i = main._migrations.index(block[0])
    assert main._migrations[i - 1].startswith("DO $$")
    assert "NEW.void_reason NOT IN ('undo', 'correction')" in main._EK_ENTRY_GUARD_FN
    assert "Migration 089" in inspect.getsource(main)


def test_new_tables_match_the_models_as_postgres_types_them():
    for model in NEW:
        t = model.__table__
        mine = _columns(_pg_ddl(t.name))
        theirs = _columns(" ".join(str(CreateTable(t).compile(dialect=postgresql.dialect())).split()))
        assert set(mine) == set(theirs), (t.name, set(mine) ^ set(theirs))
        for col, (typ, notnull) in theirs.items():
            assert mine[col] == (typ, notnull), (t.name, col, mine[col], typ, notnull)
    assert FoodCheckPhoto.__table__.c.storage_key.nullable is True
    assert FoodCheckEntry.__table__.c.reason_text.type.length == 120
    assert FoodCheckEntry.__table__.c.correction_text.type.length == 120
    assert FoodCheckSettings.__table__.c.opted_in.nullable is False


def test_indexes_in_both_lists_and_declared_on_the_models():
    declared = {ix.name for m in NEW for ix in m.__table__.indexes}
    assert declared == INDEXES
    lite = _index_stmts()
    pg_ix = {s for s in main._migrations if any(f" {n} ON" in s for n in INDEXES)}
    lite_ix = {s for s in lite if any(f" {n} ON" in s for n in INDEXES)}
    assert pg_ix == lite_ix and len(pg_ix) == 4
    uniq = {ix.name for m in NEW for ix in m.__table__.indexes if ix.unique}
    assert uniq == {"ux_food_check_reviews_week", "ux_food_check_photos_entry"}


def test_the_sqlite_mirror_adds_the_three_columns():
    src = inspect.getsource(main._run_migrations)
    assert '_add("food_check_entries", "reason_text", "VARCHAR(120)")' in src
    assert '_add("food_check_entries", "correction_text", "VARCHAR(120)")' in src
    assert '_add("food_check_settings", "opted_in", "BOOLEAN NOT NULL DEFAULT 0")' in src
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    with eng.begin() as c:
        # an R1a dev DB: drop the three columns, then re-add them as the mirror does
        c.execute(text("ALTER TABLE food_check_entries DROP COLUMN reason_text"))
        c.execute(text("ALTER TABLE food_check_entries DROP COLUMN correction_text"))
        c.execute(text("ALTER TABLE food_check_settings DROP COLUMN opted_in"))
        c.execute(text("ALTER TABLE food_check_entries ADD COLUMN reason_text VARCHAR(120)"))
        c.execute(text("ALTER TABLE food_check_entries ADD COLUMN correction_text VARCHAR(120)"))
        c.execute(text("ALTER TABLE food_check_settings ADD COLUMN opted_in BOOLEAN NOT NULL DEFAULT 0"))
        for name in INDEXES:
            c.execute(text(f"DROP INDEX IF EXISTS {name}"))
        for s in (s for s in _index_stmts() if any(n in s for n in INDEXES)):
            c.execute(text(s))
        idx = {r[0] for r in c.execute(text("SELECT name FROM sqlite_master WHERE type='index'"))}
        tables = {r[0] for r in c.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}
    assert INDEXES <= idx
    assert {"food_check_reviews", "food_check_documents", "food_check_photos"} <= tables
    with eng.connect() as c:
        main._verify_schema_no_drift(c, strict=True)


def test_a_real_sqlite_boot_restores_the_089_objects(tmp_path, monkeypatch):
    """main._run_migrations() on an R1a-shaped dev DB (column + index
    missing) adds them back."""
    eng = create_engine(f"sqlite:///{tmp_path / 'boot.db'}")
    Base.metadata.create_all(eng)
    with eng.begin() as c:
        c.execute(text("DROP INDEX ux_food_check_photos_entry"))
        c.execute(text("DROP INDEX ux_food_check_reviews_week"))
        c.execute(text("ALTER TABLE food_check_entries DROP COLUMN reason_text"))
        c.execute(text("ALTER TABLE food_check_entries DROP COLUMN correction_text"))
        c.execute(text("ALTER TABLE food_check_settings DROP COLUMN opted_in"))
    monkeypatch.setattr(main, "engine", eng)
    main._run_migrations()
    with eng.connect() as c:
        idx = {r[0] for r in c.execute(text("SELECT name FROM sqlite_master WHERE type='index'"))}
        ent = {r[1] for r in c.execute(text("PRAGMA table_info(food_check_entries)"))}
        st = {r[1] for r in c.execute(text("PRAGMA table_info(food_check_settings)"))}
    assert INDEXES <= idx and "reason_text" in ent and "opted_in" in st
    assert "correction_text" in ent
    eng.dispose()


def test_models_are_registered():
    for name in ("FoodCheckReview", "FoodCheckDocument", "FoodCheckPhoto"):
        assert name in models.__all__ and hasattr(models, name)


def test_rls_sweep_covers_every_public_table():
    sweep = next(s for s in main._migrations if "rls doctrine applied to" in s)
    assert "rls_deny_anon" in sweep and "c.relkind = 'r'" in sweep
    # the sweep runs BEFORE the 089 statements in the list, but on every boot
    # after create_all built the tables — the PG test asserts the policies.
    assert main._migrations.index(sweep) < main._migrations.index(_block_089()[0])


# ── the app-level rules (SQLite twin of the trigger + the new listeners) ──

@pytest.fixture
def session():
    from tests._ek_support import T0
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    s = sessionmaker(bind=eng)()
    from app.models.user import User
    from app.models.food_check import FoodCheck, FoodCheckRevision
    u = User(email=f"m-{uuid.uuid4().hex[:6]}@bonbox.dk", password_hash="x", business_name="B",
             currency="DKK", role="owner")
    s.add(u)
    s.commit()
    c = FoodCheck(user_id=u.id, kind="temp_max", template_key="fridge", group_key="temperatures",
                  name="Køl", active=True)
    s.add(c)
    s.flush()
    r = FoodCheckRevision(user_id=u.id, check_id=c.id, valid_from=T0, name="Køl", schedule="{}",
                          action_codes="[]", fate_codes="[]", recheck_min=30)
    s.add(r)
    s.flush()
    s.info["ids"] = (u.id, c.id, r.id)
    yield s
    s.close()


def _entry(s, **kw):
    uid, cid, rid = s.info["ids"]
    e = FoodCheckEntry(user_id=uid, check_id=cid, revision_id=rid, client_id=str(uuid.uuid4()),
                       business_date=date(2026, 11, 12), recorded_at=datetime(2026, 11, 12, 7),
                       value_c=3, staff_name="Mia", name_source="typed", via="owner_app", **kw)
    s.add(e)
    s.commit()
    return e


def test_a_correction_void_once_and_an_unknown_reason_refused(session):
    s = session
    e = _entry(s, reason_text="papir")
    e.voided_at, e.void_reason = datetime(2026, 11, 12, 8), "correction"
    s.commit()
    e.void_reason = "undo"
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    f = _entry(s)
    f.voided_at, f.void_reason = datetime(2026, 11, 12, 8), "x"
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    g = _entry(s, reason_text="a")
    g.reason_text = "b"                                  # immutable after insert
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    h = _entry(s, correction_text="a")
    h.correction_text = "b"                              # immutable after insert
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()


def test_a_review_is_never_changed(session):
    s = session
    uid = s.info["ids"][0]
    r = FoodCheckReview(user_id=uid, iso_week="2026-W46", week_start=date(2026, 11, 9),
                        reviewed_at=datetime(2026, 11, 17, 9))
    s.add(r)
    s.commit()
    r.note = "changed"
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    s.add(FoodCheckReview(user_id=uid, iso_week="2026-W46", week_start=date(2026, 11, 9),
                          reviewed_at=datetime(2026, 11, 17, 10)))
    with pytest.raises(Exception):
        s.commit()                                       # one per week (unique index)
    s.rollback()


def test_a_photo_row_only_moves_to_removed(session):
    s = session
    uid = s.info["ids"][0]
    e = _entry(s, in_limit=False)
    p = FoodCheckPhoto(user_id=uid, entry_id=e.id, storage_key="k", content_type="image/jpeg",
                       size_bytes=3, via="owner_app", uploaded_at=datetime(2026, 11, 12, 7))
    s.add(p)
    s.commit()
    p.size_bytes = 4
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    p.storage_key = None                                 # no removed_at
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    p.removed_at, p.storage_key, p.removed_by_user_id = datetime(2026, 11, 12, 9), None, uid
    s.commit()
    p.storage_key = "k2"
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    s.add(FoodCheckPhoto(user_id=uid, entry_id=e.id, storage_key="k", content_type="image/jpeg",
                         size_bytes=3, via="owner_app", uploaded_at=datetime(2026, 11, 12, 7)))
    with pytest.raises(Exception):
        s.commit()                                       # one photo per reading
    s.rollback()


def test_a_document_changes_only_its_review_date(session):
    s = session
    uid = s.info["ids"][0]
    d = FoodCheckDocument(user_id=uid, doc_type="other", title="T", storage_key="k",
                          content_type="application/pdf", size_bytes=1,
                          uploaded_at=datetime(2026, 11, 12, 7))
    s.add(d)
    s.commit()
    d.reviewed_at, d.reviewed_by_user_id = datetime(2026, 11, 13), uid
    s.commit()
    d.title = "Other"
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
