"""Egenkontrol R1a — POSTGRES-ONLY checks (plan "Postgres-only checks").

SKIPPED unless BONBOX_PG_TEST_URL points at a THROWAWAY local Postgres
database (superuser; e.g. one Docker container, alone on the Mac). There is no
Postgres CI job (.github/workflows/tests.yml), so these MUST be run by hand
before the release:

    BONBOX_PG_TEST_URL=postgresql://postgres:postgres@127.0.0.1:5432/bonbox_ek_test \\
      DATABASE_URL=sqlite:///./ci_ek.db HEALTHCHECK_BASE=http://127.0.0.1:9 \\
      venv/bin/python -m pytest -q tests/test_egenkontrol_pg.py

Everything runs in its own schemas (dropped at the end): create_all + the 088
trigger SQL + the RLS sweep, then — the immutability triggers refuse an UPDATE
of a saved reading and of any revision and allow DELETE; the boot check logs
CRITICAL for a missing trigger; rls_deny_anon is RESTRICTIVE on the 5 tables;
the 088 DDL types match create_all in information_schema; the erasure walk and
the 730-day purge delete with the triggers installed; and the PDF prints local
times on Postgres in winter and in summer.
"""
import io
import logging
import os
import uuid
from datetime import date, datetime, timedelta

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("BONBOX_PG_TEST_URL"),
    reason="needs a local Postgres (BONBOX_PG_TEST_URL); there is no PG CI job",
)

from sqlalchemy import create_engine, text  # noqa: E402
from sqlalchemy.exc import DBAPIError  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

TABLES = ("kitchen_links", "food_checks", "food_check_revisions", "food_check_entries",
          "food_check_settings")


def _engine(schema: str):
    return create_engine(
        os.environ["BONBOX_PG_TEST_URL"],
        connect_args={"options": f"-csearch_path={schema}"},
        pool_pre_ping=True,
    )


@pytest.fixture(scope="module")
def pg():
    import app.main as main
    import app.models  # noqa: F401
    from app.database import Base

    tag = uuid.uuid4().hex[:8]
    schema, ddl_schema = f"ek_test_{tag}", f"ek_ddl_{tag}"
    admin = create_engine(os.environ["BONBOX_PG_TEST_URL"])
    with admin.begin() as c:
        c.execute(text(f"CREATE SCHEMA {schema}"))
        c.execute(text(f"CREATE SCHEMA {ddl_schema}"))
        for role in ("anon", "authenticated"):
            c.execute(text(
                f"DO $$ BEGIN CREATE ROLE {role}; "
                "EXCEPTION WHEN duplicate_object THEN NULL; END $$"))
    eng = _engine(schema)
    Base.metadata.create_all(eng)
    with eng.begin() as c:
        c.execute(text(main._EK_ENTRY_GUARD_FN))
        c.execute(text(main._EK_REVISION_GUARD_FN))
        for do in main._EK_TRIGGER_DO_BLOCKS:
            c.execute(text(do))
        sweep = next(s for s in main._migrations if "rls_deny_anon" in s and s.lstrip().startswith("DO $$"))
        c.execute(text(sweep.replace("'public'", f"'{schema}'").replace("public.%I", f"{schema}.%I")))
    try:
        yield {"engine": eng, "schema": schema, "ddl_schema": ddl_schema,
               "Session": sessionmaker(bind=eng, autoflush=False), "main": main}
    finally:
        eng.dispose()
        with admin.begin() as c:
            c.execute(text(f"DROP SCHEMA IF EXISTS {schema} CASCADE"))
            c.execute(text(f"DROP SCHEMA IF EXISTS {ddl_schema} CASCADE"))
        admin.dispose()


@pytest.fixture
def clock(monkeypatch):
    from app.services import egenkontrol_service as S

    class _C:
        t = datetime(2026, 11, 12, 6, 30)

        def __call__(self):
            return self.t

    c = _C()
    monkeypatch.setattr(S, "now_utc", c)
    return c


def _owner(s, name="PG Bistro"):
    from app.models.business_profile import BusinessProfile
    from app.models.user import User
    from app.services.auth import hash_password

    u = User(email=f"pg-{uuid.uuid4().hex[:8]}@bonbox.dk", password_hash=hash_password("x12345678"),
             business_name=name, business_type="restaurant", currency="DKK", role="owner",
             timezone="Europe/Copenhagen", plan="pro")
    s.add(u)
    s.commit()
    s.add(BusinessProfile(user_id=u.id))
    s.commit()
    s.refresh(u)
    return u


def _setup(s, owner, items=None):
    from app.schemas.egenkontrol import SetupIn
    from app.services import egenkontrol_service as S
    items = items or [{"template_key": "fridge", "name": "Køl 1"},
                      {"template_key": "freezer", "name": "Frost 1"}]
    return {c["template_key"]: c["id"] for c in
            S.setup(s, owner, SetupIn(items=items), actor_id=owner.id)}


def _save(s, owner, check_id, value, **kw):
    from app.schemas.egenkontrol import EntryIn
    from app.services import egenkontrol_service as S
    body = EntryIn(client_id=str(uuid.uuid4()), check_id=check_id, value_c=value,
                   typed_name=kw.pop("typed_name", "Mia"), **kw)
    out, _ = S.save_entry(s, owner, body, via="owner_app", actor_user_id=owner.id)
    return out["id"]


def _refused(eng, sql, params):
    with pytest.raises(DBAPIError):
        with eng.begin() as c:
            c.execute(text(sql), params)


def _ok(eng, sql, params):
    with eng.begin() as c:
        c.execute(text(sql), params)


def test_triggers_refuse_updates_and_allow_deletes(pg, clock):
    eng, s = pg["engine"], pg["Session"]()
    o = _owner(s)
    fridge = _setup(s, o)["fridge"]
    eid = _save(s, o, fridge, 3.1)
    p = {"id": eid}
    _refused(eng, "UPDATE food_check_entries SET value_c = 1.0 WHERE id = :id", p)
    _refused(eng, "UPDATE food_check_entries SET recorded_at = recorded_at - interval '1 hour' WHERE id = :id", p)
    _refused(eng, "UPDATE food_check_entries SET late = TRUE WHERE id = :id", p)
    # An in-limit reading never becomes a deviation in place (NULL -> open).
    _refused(eng, "UPDATE food_check_entries SET deviation_state = 'open' WHERE id = :id", p)
    _refused(eng, "UPDATE food_check_entries SET void_reason = 'undo' WHERE id = :id", p)
    # A void names a known reason: none, or an unknown one, is refused.
    _refused(eng, "UPDATE food_check_entries SET voided_at = now() WHERE id = :id", p)
    _refused(eng, "UPDATE food_check_entries SET voided_at = now(), void_reason = 'x' WHERE id = :id", p)
    _ok(eng, "UPDATE food_check_entries SET voided_at = now(), void_reason = 'undo' WHERE id = :id", p)
    _refused(eng, "UPDATE food_check_entries SET voided_at = now() + interval '1 day' WHERE id = :id", p)
    _refused(eng, "UPDATE food_check_entries SET void_reason = 'correction' WHERE id = :id", p)

    from app.models.staff import StaffMember
    a, b = StaffMember(user_id=o.id, name="Ali Khan"), StaffMember(user_id=o.id, name="Bo B")
    s.add_all([a, b])
    s.commit()
    eid2 = _save(s, o, fridge, 3.2, staff_id=a.id, typed_name=None)
    _refused(eng, "UPDATE food_check_entries SET staff_id = :sid WHERE id = :id", {"id": eid2, "sid": str(b.id)})
    _ok(eng, "UPDATE food_check_entries SET staff_id = NULL WHERE id = :id", {"id": eid2})

    # A deviation moves only open <-> closed: never to NULL (which would drop
    # it from the PDF), never to an unknown state.
    freezer = s.execute(text(
        "SELECT id FROM food_checks WHERE user_id = :u AND template_key = 'freezer'"
    ), {"u": str(o.id)}).scalar()
    dev = {"id": _save(s, o, freezer, -10.0, action_code="thermostat_adjusted",
                       fate_code="awaiting_recheck")}
    _refused(eng, "UPDATE food_check_entries SET deviation_state = NULL WHERE id = :id", dev)
    _refused(eng, "UPDATE food_check_entries SET deviation_state = 'gone' WHERE id = :id", dev)
    _ok(eng, "UPDATE food_check_entries SET deviation_state = 'closed' WHERE id = :id", dev)
    _ok(eng, "UPDATE food_check_entries SET deviation_state = 'open' WHERE id = :id", dev)

    rev = s.execute(text("SELECT id FROM food_check_revisions LIMIT 1")).scalar()
    _refused(eng, "UPDATE food_check_revisions SET name = 'X' WHERE id = :id", {"id": rev})
    _refused(eng, "UPDATE food_check_revisions SET active = active WHERE id = :id", {"id": rev})

    _ok(eng, "DELETE FROM food_check_entries WHERE user_id = :u", {"u": str(o.id)})
    _ok(eng, "DELETE FROM food_check_revisions WHERE user_id = :u", {"u": str(o.id)})
    s.close()


def test_boot_check_logs_critical_for_a_missing_trigger(pg, caplog):
    eng, main = pg["engine"], pg["main"]
    with eng.connect() as c:
        assert main._verify_egenkontrol_immutability(c) == []
    with eng.begin() as c:
        c.execute(text("DROP TRIGGER trg_food_check_revisions_guard ON food_check_revisions"))
    try:
        with caplog.at_level(logging.CRITICAL, logger="bonbox.security"):
            with eng.connect() as c:
                missing = main._verify_egenkontrol_immutability(c)
        assert missing == ["trg_food_check_revisions_guard"]
        assert any("EGENKONTROL IMMUTABILITY CHECK FAILED" in r.getMessage() for r in caplog.records)
    finally:
        with eng.begin() as c:
            for do in main._EK_TRIGGER_DO_BLOCKS:
                c.execute(text(do))
    with eng.connect() as c:
        assert main._verify_egenkontrol_immutability(c) == []


def test_rls_deny_anon_is_restrictive_on_the_five_tables(pg):
    with pg["engine"].connect() as c:
        rows = c.execute(text(
            "SELECT c.relname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid "
            "JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE p.polname = 'rls_deny_anon' AND NOT p.polpermissive AND n.nspname = :s"
        ), {"s": pg["schema"]}).scalars().all()
    assert set(TABLES) <= set(rows)


def test_the_088_ddl_types_match_create_all(pg):
    main, ddl = pg["main"], pg["ddl_schema"]
    eng = _engine(ddl)
    try:
        with eng.begin() as c:
            # The referenced tables, minimal: only the FK target columns matter here.
            for t in ("users", "branches", "staff_members"):
                c.execute(text(f"CREATE TABLE {t} (id VARCHAR(36) PRIMARY KEY)"))
            start = next(i for i, sql in enumerate(main._migrations)
                         if "CREATE TABLE IF NOT EXISTS kitchen_links" in sql)
            for sql in main._migrations[start:]:
                if sql.lstrip().startswith(("CREATE TABLE", "CREATE INDEX", "CREATE UNIQUE")):
                    c.execute(text(sql))
        q = ("SELECT table_name, column_name, data_type, character_maximum_length, "
             "numeric_precision, numeric_scale, is_nullable FROM information_schema.columns "
             "WHERE table_schema = :s AND table_name = ANY(:t) ORDER BY 1, 2")
        with pg["engine"].connect() as c:
            created = c.execute(text(q), {"s": pg["schema"], "t": list(TABLES)}).all()
        with eng.connect() as c:
            migrated = c.execute(text(q), {"s": ddl, "t": list(TABLES)}).all()
        assert [tuple(r) for r in created] == [tuple(r) for r in migrated]
        q_ix = ("SELECT indexname FROM pg_indexes WHERE schemaname = :s AND tablename = ANY(:t)")
        with eng.connect() as c:
            ix = set(c.execute(text(q_ix), {"s": ddl, "t": list(TABLES)}).scalars().all())
        assert {"ux_food_check_entries_client", "ix_food_check_entries_open_dev"} <= ix
    finally:
        eng.dispose()


def test_erasure_walk_deletes_every_row_with_the_triggers_installed(pg, clock):
    from app.database import Base
    from app.routers.auth import _owned_by_uid_predicate

    s = pg["Session"]()
    gone, kept = _owner(s, "Gone"), _owner(s, "Kept")
    for o in (gone, kept):
        ids = _setup(s, o)
        e = _save(s, o, ids["fridge"], 7.1, action_code="thermostat_adjusted", fate_code="awaiting_recheck")
        _save(s, o, ids["fridge"], 4.0, fate_code="assessed_ok")   # closes e (an UPDATE)
        assert e
        from app.models.kitchen_link import KitchenLink
        s.add(KitchenLink(user_id=o.id, token=uuid.uuid4().hex, active=True))
        s.commit()
    uid = gone.id
    for table in reversed(Base.metadata.sorted_tables):
        if table.name in ("users", "audit_logs", "security_events", "error_logs",
                          "bank_connections", "mobilepay_connections"):
            continue
        pred = _owned_by_uid_predicate(table, uid)
        if pred is None:
            continue
        with s.begin_nested():
            s.execute(table.delete().where(pred))
    s.commit()
    for t in TABLES:
        n_gone = s.execute(text(f"SELECT count(*) FROM {t} WHERE user_id = :u"), {"u": str(uid)}).scalar()
        n_kept = s.execute(text(f"SELECT count(*) FROM {t} WHERE user_id = :u"), {"u": str(kept.id)}).scalar()
        assert n_gone == 0, t
        assert n_kept > 0, t
    s.close()


def test_the_730_day_purge_runs_on_postgres(pg, clock, monkeypatch):
    from app.jobs import privacy_purges as pp

    s = pg["Session"]()
    o = _owner(s, "Purge")
    clock.t = datetime(2024, 9, 1, 7, 0)
    fridge = _setup(s, o)["fridge"]
    old = _save(s, o, fridge, 3.0)
    clock.t = datetime(2026, 11, 1, 7, 0)
    young = _save(s, o, fridge, 3.0)
    monkeypatch.setattr(pp, "SessionLocal", pg["Session"])
    out = pp.purge_old_egenkontrol_entries(now=datetime(2026, 11, 12))
    assert out["deleted"] >= 1 and out["dry_run"] is False
    left = set(s.execute(text("SELECT id FROM food_check_entries WHERE user_id = :u"),
                         {"u": str(o.id)}).scalars().all())
    assert young in left and old not in left
    s.close()


def test_pdf_local_times_on_postgres_in_winter_and_summer(pg, clock):
    from pypdf import PdfReader

    from app.services.egenkontrol_pdf import build_folder_pdf

    s = pg["Session"]()
    o = _owner(s, "Tider")
    clock.t = datetime(2026, 1, 15, 5, 10)
    fridge = _setup(s, o, items=[{"template_key": "fridge", "name": "Køl 1"}])["fridge"]
    clock.t = datetime(2026, 1, 15, 7, 30)          # 08:30 CET
    _save(s, o, fridge, 3.4)
    clock.t = datetime(2026, 7, 15, 6, 30)          # 08:30 CEST
    _save(s, o, fridge, 4.4)
    clock.t = datetime(2026, 7, 16, 12, 0)
    for day, value in ((date(2026, 1, 15), "3,4 °C"), (date(2026, 7, 15), "4,4 °C")):
        pdf, _, _ = build_folder_pdf(s, o, day, day)
        txt = " ".join("\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(pdf)).pages).split())
        assert f"kl. 08:00 {value} kl. 08:30" in txt, txt[:400]
    s.close()
    assert timedelta  # noqa: B018
