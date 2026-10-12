"""Vertical-fit boot fixes, hardened (Push 8, 12 Oct 2026).

The two boot data fixes (archetype_defaults.rename_legacy_module_ids and
align_member_business_types) and the owner-write sync
(sync_team_business_type) were reviewed on Postgres 16. Prod had 0 affected
rows, but each of these was reachable:

  L1  one shared try/session: a failure in the module rename skipped the
      member alignment (and the reverse) until a later boot;
  L2  (Postgres) no lock_timeout: a boot UPDATE queued behind a live row lock
      for as long as that lock was held — tests/test_pg_vertical_fit_boot.py;
  L3  read-then-write without a guard: a value an owner saved between the
      boot's read and its write was overwritten with the boot's stale answer;
  L4  every row with an owner_id was aligned/synced, whatever its role;
  L5  a member was aligned to an owner whose type is "personal";
  L6  the writes bumped users.updated_at ("last profile change");
  L7  the boot printed the exception text, SQL parameters included;
  M1  the rename used the live plan's cap, so a trial bar's result depended
      on whether the deploy landed before or after its trial ended.

Run: cd backend && python -m pytest -q tests/test_vertical_fit_boot_hardening.py
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.user import User
from app.services import archetype_defaults as ad
from app.services.auth import hash_password
from app.services.modules import get_enabled
from app.utils.time import utc_now

_OLD_STAMP = utc_now().replace(microsecond=0) - timedelta(days=40)


@pytest.fixture
def factory(tmp_path):
    # A FILE database with a normal pool: two sessions are two connections,
    # so "another request changed the row meanwhile" is a real interleaving.
    eng = create_engine(f"sqlite:///{tmp_path / 'vf.db'}",
                        connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    yield sessionmaker(bind=eng, autoflush=False, autocommit=False)
    eng.dispose()


def _user(s, email, *, business_type="cafe", role="owner", owner=None,
          enabled_modules=None, trial_days=None):
    u = User(
        email=email,
        password_hash=hash_password("hunter2pass"),
        business_name="Test Biz",
        business_type=business_type,
        currency="DKK",
        role=role,
        email_verified=True,
        enabled_modules=enabled_modules,
        trial_ends_at=(utc_now() + timedelta(days=trial_days)) if trial_days else None,
        owner_id=owner.id if owner is not None else None,
    )
    s.add(u)
    s.commit()
    # A known, old "last profile change" so a bump is visible.
    s.execute(text("UPDATE users SET updated_at = :t WHERE id = :i"),
              {"t": _OLD_STAMP, "i": str(u.id)})
    s.commit()
    s.refresh(u)
    return u


def _row(factory, uid):
    s = factory()
    try:
        return s.execute(
            text("SELECT business_type, enabled_modules, updated_at FROM users WHERE id = :i"),
            {"i": str(uid)},
        ).one()
    finally:
        s.close()


def _stamp(v):
    # SQLite hands a raw DATETIME back as text.
    return str(v)[:19]


# ── L1 — the two fixes are independent ──────────────────────────────────


def test_a_failing_rename_does_not_stop_the_member_alignment(factory, monkeypatch):
    s = factory()
    owner = _user(s, "o1@bonbox.test", business_type="salon")
    mgr = _user(s, "m1@bonbox.test", business_type="cafe", role="manager", owner=owner)
    s.close()

    def boom(_db):
        raise RuntimeError("rename broke")

    monkeypatch.setattr(ad, "rename_legacy_module_ids", boom)
    out = ad.run_vertical_fit_boot_fixes(factory, log=lambda *_: None)
    assert out["modules"] is None
    assert out["members"] == 1
    assert _row(factory, mgr.id).business_type == "salon"


def test_a_failing_alignment_does_not_undo_the_rename(factory, monkeypatch):
    s = factory()
    bar = _user(s, "bar1@bonbox.test", business_type="bar", enabled_modules="pour,competitor")
    s.close()

    def boom(_db):
        raise RuntimeError("align broke")

    monkeypatch.setattr(ad, "align_member_business_types", boom)
    out = ad.run_vertical_fit_boot_fixes(factory, log=lambda *_: None)
    assert out["members"] is None
    assert out["modules"]["renamed"] == 1
    assert _row(factory, bar.id).enabled_modules == "bar_pour,competitor"


# ── L7 — the boot log names the error type, never its text ──────────────


def test_boot_log_carries_the_type_name_only(factory, monkeypatch):
    lines: list[str] = []

    def boom(_db):
        raise RuntimeError("UPDATE users SET business_type='salon' WHERE email='anna@cafe.dk'")

    monkeypatch.setattr(ad, "rename_legacy_module_ids", boom)
    monkeypatch.setattr(ad, "align_member_business_types", boom)
    ad.run_vertical_fit_boot_fixes(factory, log=lines.append)
    joined = "\n".join(lines)
    assert "RuntimeError" in joined
    assert "anna@cafe.dk" not in joined and "UPDATE users" not in joined


def test_main_boot_calls_the_independent_runner():
    import inspect

    import app.main as main
    src = inspect.getsource(main._init_db)
    assert "run_vertical_fit_boot_fixes" in src
    # The old shared block printed the exception text.
    assert "Vertical-fit backfill warning: {e}" not in src


# ── L3 — a value saved between the boot's read and its write survives ───


def test_rename_never_overwrites_a_concurrent_module_choice(factory, monkeypatch):
    s = factory()
    bar = _user(s, "bar2@bonbox.test", business_type="bar", enabled_modules="pour,competitor")
    s.close()

    real_cap = ad._boot_module_cap
    fired = {"n": 0}

    def cap_then_owner_saves(user):
        # The owner saves /modules in another request after the boot read
        # the row and before it writes.
        if not fired["n"]:
            fired["n"] += 1
            other = factory()
            other.execute(text("UPDATE users SET enabled_modules = 'workshop' WHERE id = :i"),
                          {"i": str(user.id)})
            other.commit()
            other.close()
        return real_cap(user)

    monkeypatch.setattr(ad, "_boot_module_cap", cap_then_owner_saves)
    s = factory()
    out = ad.rename_legacy_module_ids(s)
    s.close()
    assert out == {"renamed": 0, "kept": 1}
    assert _row(factory, bar.id).enabled_modules == "workshop"


def test_alignment_never_writes_a_type_the_owner_changed_meanwhile(factory, monkeypatch):
    s = factory()
    owner = _user(s, "o3@bonbox.test", business_type="salon")
    owner_id = owner.id
    mgr_id = _user(s, "m3@bonbox.test", business_type="cafe", role="viewer", owner=owner).id
    s.close()

    real_select = ad._drifted_members
    fired = {"n": 0}

    def read_then_owner_changes(db):
        rows = real_select(db)
        if not fired["n"]:
            fired["n"] += 1
            # The owner becomes a café (and the request syncs the team) after
            # the boot read "owner = salon".
            other = factory()
            other.execute(text("UPDATE users SET business_type = 'cafe' WHERE id = :i"),
                          {"i": str(owner_id)})
            other.commit()
            other.close()
        return rows

    monkeypatch.setattr(ad, "_drifted_members", read_then_owner_changes)
    s = factory()
    assert ad.align_member_business_types(s) == 0
    s.close()
    assert _row(factory, mgr_id).business_type == "cafe"


# ── L4 — only manager / cashier / viewer rows follow the owner ──────────


def test_only_member_roles_are_aligned_and_synced(factory):
    s = factory()
    owner = _user(s, "o4@bonbox.test", business_type="salon")
    owner_id = owner.id
    cashier_id = _user(s, "c4@bonbox.test", business_type="cafe", role="cashier", owner=owner).id
    odd_id = _user(s, "a4@bonbox.test", business_type="cafe", role="accountant", owner=owner).id
    other_id = _user(s, "x4@bonbox.test", business_type="cafe", role="owner", owner=owner).id
    assert ad.align_member_business_types(s) == 1
    s.close()
    assert _row(factory, cashier_id).business_type == "salon"
    assert _row(factory, odd_id).business_type == "cafe"
    assert _row(factory, other_id).business_type == "cafe"

    s = factory()
    o = s.get(User, owner_id)
    o.business_type = "clothing"
    assert ad.sync_team_business_type(s, o) == 1
    s.commit()
    s.close()
    assert _row(factory, cashier_id).business_type == "clothing"
    assert _row(factory, odd_id).business_type == "cafe"
    assert _row(factory, other_id).business_type == "cafe"


def test_the_member_roles_are_the_team_routers_roles():
    from app.routers.team import VALID_ROLES
    assert set(ad._MEMBER_ROLES) == VALID_ROLES


# ── L5 — never to a personal owner ──────────────────────────────────────


def test_never_aligned_or_synced_to_a_personal_owner(factory):
    s = factory()
    owner = _user(s, "o5@bonbox.test", business_type="personal")
    owner_id = owner.id
    mgr_id = _user(s, "m5@bonbox.test", business_type="cafe", role="manager", owner=owner).id
    assert ad.align_member_business_types(s) == 0
    o = s.get(User, owner_id)
    assert ad.sync_team_business_type(s, o) == 0
    s.commit()
    s.close()
    assert _row(factory, mgr_id).business_type == "cafe"


# ── L6 — users.updated_at is not "last boot" ────────────────────────────


def test_no_write_bumps_updated_at(factory):
    s = factory()
    owner_id = _user(s, "o6@bonbox.test", business_type="salon").id
    mgr_id = _user(s, "m6@bonbox.test", business_type="cafe", role="manager",
                   owner=s.get(User, owner_id)).id
    bar_id = _user(s, "b6@bonbox.test", business_type="bar", enabled_modules="pour").id
    assert ad.align_member_business_types(s) == 1
    assert ad.rename_legacy_module_ids(s)["renamed"] == 1
    s.close()
    assert _row(factory, mgr_id).business_type == "salon"
    assert _stamp(_row(factory, mgr_id).updated_at) == _stamp(_OLD_STAMP)
    assert _row(factory, bar_id).enabled_modules == "bar_pour"
    assert _stamp(_row(factory, bar_id).updated_at) == _stamp(_OLD_STAMP)

    s = factory()
    o = s.get(User, owner_id)
    o.business_type = "clothing"
    assert ad.sync_team_business_type(s, o) == 1
    s.commit()
    s.close()
    assert _row(factory, mgr_id).business_type == "clothing"
    assert _stamp(_row(factory, mgr_id).updated_at) == _stamp(_OLD_STAMP)


# ── M1 — a live trial is renamed with the Free cap ──────────────────────


def test_trial_bar_is_kept_like_after_its_trial(factory):
    s = factory()
    two_id = _user(s, "t2@bonbox.test", business_type="bar",
                   enabled_modules="pour,wine,competitor", trial_days=10).id
    one_id = _user(s, "t1@bonbox.test", business_type="bar",
                   enabled_modules="pour,competitor", trial_days=10).id
    out = ad.rename_legacy_module_ids(s)
    assert out == {"renamed": 1, "kept": 1}
    s.close()
    # Two old ids → two real modules: over the Free cap, left exactly as it
    # was — the same answer the boot gives once the trial has ended.
    assert _row(factory, two_id).enabled_modules == "pour,wine,competitor"
    assert _row(factory, one_id).enabled_modules == "bar_pour,competitor"


def test_onboarding_still_grants_the_trial_both_bar_modules(factory):
    s = factory()
    u = _user(s, "fresh@bonbox.test", business_type="bar", trial_days=10)
    ad.apply_archetype_defaults(s, u)
    s.refresh(u)
    assert set(get_enabled(u)) == {"bar_pour", "wine_sommelier"}
    s.close()
