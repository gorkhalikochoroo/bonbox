"""Schema for the revisor package: the schedule columns and the send ledger.

Postgres runs main._migrations (no Alembic); SQLite dev databases need the
hand-kept mirror. Both additive and idempotent.
"""
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.business_profile import BusinessProfile
from app.models.revisor_package import RevisorPackageSend


def test_columns_are_nullable_without_default():
    for name in ("revisor_package_schedule", "revisor_package_schedule_at"):
        col = BusinessProfile.__table__.c[name]
        assert col.nullable is True and col.default is None and col.server_default is None


def test_postgres_list_has_the_alters_and_the_table():
    from app import main
    stmts = [s for s in main._migrations if isinstance(s, str)]
    assert "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS revisor_package_schedule VARCHAR(10)" in stmts
    assert "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS revisor_package_schedule_at TIMESTAMP" in stmts
    create = [s for s in stmts if s.lstrip().startswith("CREATE TABLE IF NOT EXISTS revisor_package_sends")]
    assert len(create) == 1
    # Every model column is in the hand-written CREATE (create_all-bypassed net).
    for col in RevisorPackageSend.__table__.columns:
        assert f"\n        {col.name} " in create[0], col.name
    assert "UNIQUE (user_id, dedup_key)" in create[0]


def test_the_sqlite_mirror_adds_the_columns_and_a_second_boot_is_a_no_op(tmp_path, monkeypatch):
    from app import main
    eng = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("ALTER TABLE business_profiles DROP COLUMN revisor_package_schedule"))
        conn.execute(text("ALTER TABLE business_profiles DROP COLUMN revisor_package_schedule_at"))
    monkeypatch.setattr(main, "engine", eng)
    main._run_migrations()
    main._run_migrations()
    with eng.connect() as conn:
        info = {r[1]: r for r in conn.execute(text("PRAGMA table_info('business_profiles')"))}
    assert info["revisor_package_schedule"][2].upper() == "VARCHAR(10)"
    assert info["revisor_package_schedule_at"][2].upper() == "TIMESTAMP"
    eng.dispose()


def test_dedup_key_is_unique_per_owner_and_null_never_collides(tmp_path):
    import uuid
    from datetime import date
    import pytest
    from sqlalchemy.exc import IntegrityError
    from app.models.user import User
    eng = create_engine(f"sqlite:///{tmp_path / 'u.db'}")
    Base.metadata.create_all(eng)
    db = sessionmaker(bind=eng)()
    u = User(email="a@b.dk", password_hash="x", business_name="X", currency="DKK")
    db.add(u); db.commit()

    def row(key):
        return RevisorPackageSend(user_id=u.id, period_kind="month", period_start=date(2026, 9, 1),
                                  period_end=date(2026, 9, 30), send_trigger="manual",
                                  dedup_key=key, status="claimed")
    db.add_all([row(None), row(None), row("sched:a")]); db.commit()
    db.add(row("sched:a"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
    assert uuid.UUID(str(u.id))
    eng.dispose()


def test_split_and_fingerprint_columns_exist_everywhere_with_a_server_default(tmp_path):
    """12 Oct review (M7/M8): parts_json, figures_json, figures_fp,
    is_correction — in the model, the PG CREATE, a PG ALTER each, the SQLite
    mirror; is_correction carries DEFAULT FALSE on every path (create_all on
    a fresh Postgres gave it none: a raw INSERT failed NOT NULL on PG16)."""
    import inspect
    from app import main
    stmts = [" ".join(s.split()) for s in main._migrations if isinstance(s, str)]
    for col, typ in (("parts_json", "TEXT"), ("figures_json", "TEXT"), ("figures_fp", "VARCHAR(64)"),
                     ("is_correction", "BOOLEAN NOT NULL DEFAULT FALSE")):
        assert col in RevisorPackageSend.__table__.c
        assert f"ALTER TABLE revisor_package_sends ADD COLUMN IF NOT EXISTS {col} {typ}" in stmts
        assert f'_add("revisor_package_sends", "{col}"' in inspect.getsource(main._run_migrations)
    assert RevisorPackageSend.__table__.c.is_correction.server_default is not None
    from app.models.user import User
    eng = create_engine(f"sqlite:///{tmp_path / 'raw.db'}")
    Base.metadata.create_all(eng)
    db = sessionmaker(bind=eng)()
    u = User(email="x@y.dk", password_hash="x", business_name="X", currency="DKK")
    db.add(u); db.commit()
    uid = str(u.id)
    db.close()
    with eng.begin() as conn:      # a raw INSERT that does not name is_correction
        conn.execute(text("INSERT INTO revisor_package_sends (id, user_id, period_kind, period_start, "
                          "period_end, send_trigger, status, attempts, created_at) VALUES ('r1', :u, "
                          "'month', '2026-09-01', '2026-09-30', 'manual', 'claimed', 1, CURRENT_TIMESTAMP)"),
                     {"u": uid})
        assert conn.execute(text("SELECT is_correction FROM revisor_package_sends")).scalar() in (0, False)
    eng.dispose()
