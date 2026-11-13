"""Egenkontrol R1a + R1b — POSTGRES-ONLY checks (plan "Postgres-only checks").

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
R1B_TABLES = ("food_check_reviews", "food_check_documents", "food_check_photos")


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
    assert set(R1B_TABLES) <= set(rows)                 # R1b: the sweep covers 089 too


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
                # R1b: Migration 089's two ADD COLUMNs on 088 tables run too —
                # create_all now builds those columns.
                if sql.lstrip().startswith(("CREATE TABLE", "CREATE INDEX", "CREATE UNIQUE",
                                            "ALTER TABLE")):
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
        # R1b: the three 089 tables, typed as create_all types them
        with pg["engine"].connect() as c:
            created = c.execute(text(q), {"s": pg["schema"], "t": list(R1B_TABLES)}).all()
        with eng.connect() as c:
            migrated = c.execute(text(q), {"s": ddl, "t": list(R1B_TABLES)}).all()
            ix = set(c.execute(text(q_ix), {"s": ddl, "t": list(R1B_TABLES)}).scalars().all())
        assert created and [tuple(r) for r in created] == [tuple(r) for r in migrated]
        assert {"ux_food_check_reviews_week", "ix_food_check_documents_user",
                "ux_food_check_photos_entry", "ix_food_check_photos_user"} <= ix
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


# ── R1b (Migration 089) ─────────────────────────────────────────────────

def test_r1b_a_correction_void_once_then_nothing(pg, clock):
    eng, s = pg["engine"], pg["Session"]()
    o = _owner(s, "Ret")
    fridge = _setup(s, o)["fridge"]
    p = {"id": _save(s, o, fridge, 3.1)}
    _ok(eng, "UPDATE food_check_entries SET voided_at = now(), void_reason = 'correction' "
             "WHERE id = :id", p)
    _refused(eng, "UPDATE food_check_entries SET void_reason = 'undo' WHERE id = :id", p)
    _refused(eng, "UPDATE food_check_entries SET voided_at = NULL, void_reason = NULL WHERE id = :id", p)
    _refused(eng, "UPDATE food_check_entries SET value_c = 9.9 WHERE id = :id", p)
    q = {"id": _save(s, o, fridge, 3.2)}
    _refused(eng, "UPDATE food_check_entries SET voided_at = now(), void_reason = 'x' WHERE id = :id", q)
    s.close()


def test_r1b_reason_text_is_immutable_after_insert(pg, clock):
    from app.schemas.egenkontrol import PaperEntryIn
    from app.services import egenkontrol_records as REC

    eng, s = pg["engine"], pg["Session"]()
    o = _owner(s, "Papir")
    fridge = _setup(s, o)["fridge"]
    clock.t = datetime(2026, 11, 13, 9, 0)
    body = PaperEntryIn(client_id=str(uuid.uuid4()), check_id=fridge, value_c=3.0,
                        typed_name="Mia", measured_date=date(2026, 11, 12),
                        measured_time="08:10", paper_reason="Nettet var nede")
    out, _ = REC.save_paper_entry(s, o, body, via="owner_app", actor_user_id=o.id)
    p = {"id": out["id"]}
    _refused(eng, "UPDATE food_check_entries SET reason_text = 'andet' WHERE id = :id", p)
    _refused(eng, "UPDATE food_check_entries SET correction_text = 'andet' WHERE id = :id", p)
    _refused(eng, "UPDATE food_check_entries SET paper_measured_at = now() WHERE id = :id", p)
    s.close()


def _r1b_rows(s, o, entry_id):
    from app.models.food_check import FoodCheckDocument, FoodCheckPhoto, FoodCheckReview
    s.add(FoodCheckPhoto(user_id=o.id, entry_id=uuid.UUID(entry_id), storage_key=None,
                         content_type="image/jpeg", size_bytes=1, via="owner_app",
                         uploaded_at=datetime(2026, 11, 12, 7)))
    s.add(FoodCheckDocument(user_id=o.id, doc_type="other", title="T", storage_key="k",
                            content_type="application/pdf", size_bytes=1,
                            uploaded_at=datetime(2026, 11, 12, 7)))
    s.add(FoodCheckReview(user_id=o.id, iso_week="2026-W45", week_start=date(2026, 11, 2),
                          reviewed_at=datetime(2026, 11, 10, 9)))
    s.commit()


def test_r1b_erasure_walk_with_photos_documents_and_reviews(pg, clock):
    from app.database import Base
    from app.routers.auth import _owned_by_uid_predicate

    from app.models.kitchen_link import KitchenLink

    s = pg["Session"]()
    try:
        gone, kept = _owner(s, "Gone2"), _owner(s, "Kept2")
        for o in (gone, kept):
            ids = _setup(s, o)
            e = _save(s, o, ids["fridge"], 9.0, action_code="thermostat_adjusted", fate_code="moved")
            _r1b_rows(s, o, e)
            # TABLES includes kitchen_links, so each owner needs one (as in the R1a twin).
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
        for t in TABLES + R1B_TABLES:
            n_gone = s.execute(text(f"SELECT count(*) FROM {t} WHERE user_id = :u"), {"u": str(uid)}).scalar()
            n_kept = s.execute(text(f"SELECT count(*) FROM {t} WHERE user_id = :u"), {"u": str(kept.id)}).scalar()
            assert n_gone == 0, t
            assert n_kept > 0, t
    finally:
        # A failed assert must not leave the session idle in a transaction:
        # the module teardown's DROP SCHEMA would wait on it forever.
        s.rollback()
        s.close()


def test_r1b_purges_run_on_postgres(pg, clock, monkeypatch, tmp_path):
    from app.jobs import privacy_purges as pp
    from app.models.food_check import FoodCheckPhoto, FoodCheckReview
    from app.services import storage as storage_mod

    monkeypatch.setenv("LOCAL_UPLOADS_ROOT", str(tmp_path / "uploads"))
    monkeypatch.setattr(storage_mod.settings, "SUPABASE_URL", "", raising=False)
    monkeypatch.setattr(storage_mod.settings, "SUPABASE_SERVICE_KEY", "", raising=False)
    storage_mod.reset_storage_for_tests()
    try:
        s = pg["Session"]()
        o = _owner(s, "Purge2")
        clock.t = datetime(2024, 9, 1, 7, 0)
        fridge = _setup(s, o)["fridge"]
        old = _save(s, o, fridge, 9.0, action_code="thermostat_adjusted", fate_code="moved")
        key = storage_mod.compose_key(o.id, "food_check_photo", "b" * 64, "jpg")
        storage_mod.get_storage().put(key, b"jpeg", "image/jpeg")
        s.add(FoodCheckPhoto(user_id=o.id, entry_id=uuid.UUID(old), storage_key=key,
                             content_type="image/jpeg", size_bytes=4, via="owner_app",
                             uploaded_at=datetime(2024, 9, 1, 7, 1)))
        s.add(FoodCheckReview(user_id=o.id, iso_week="2024-W35", week_start=date(2024, 8, 26),
                              reviewed_at=datetime(2024, 9, 2, 9)))
        s.commit()
        monkeypatch.setattr(pp, "SessionLocal", pg["Session"])
        now = datetime(2026, 11, 12)
        assert pp.purge_old_egenkontrol_entries(now=now)["deleted"] == 0     # photo still there
        assert pp.purge_old_egenkontrol_photos(now=now)["deleted"] == 1
        assert pp.purge_old_egenkontrol_entries(now=now)["deleted"] >= 1
        assert pp.purge_old_egenkontrol_reviews(now=now)["deleted"] == 1
        assert storage_mod.get_storage().get(key) is None
        left = s.execute(text("SELECT count(*) FROM food_check_entries WHERE id = :i"), {"i": old}).scalar()
        assert left == 0
        s.close()
    finally:
        storage_mod.reset_storage_for_tests()
