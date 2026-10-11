"""R-h H-5 (LEG-06): the owner's own e-mail address is not written into the
change log (audit_logs).

The row's user_id already says whose account it was, so the address added
nothing but a copy of personal data in an immutable log. Third-party
recipients (the revisor, an invoice customer, an invitee, a supplier) stay:
the send caps and the delivery history read them back. The IP stays in its
own column — /privacy and Terms § 4 say the change log keeps it.

Pins:
  13. AST guard over app/**/*.py: inside any audit_service.record /
      record_many call (however it is imported), before/after/rows may not
      hold <user|current_user|owner|u>.email nor the names owner_email /
      owner_addr. One allowlisted writer (close.auto_emailed).
  14. Daily brief, sent and failed paths: no "@" in after_state.
  15. Magic-link verify: the row exists, after_state is NULL, ip_address set.
  16. OAuth sign-in (Google stub): provider kept, no "email"; ip_address set.
  17. send_to_accountant with cc_self, then the same key: the replay answers
      cc_to with the login address; the audit after_state has no cc_to.
  18. redact_emails unit cases.

Run:
  cd backend && python3 -m pytest tests/test_audit_no_owner_email.py -q
"""
from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

from app.utils.log_redact import redact_emails

_APP = Path(__file__).resolve().parents[1] / "app"

_OWNER_NAMES = {"user", "current_user", "owner", "u"}
_OWNER_VARS = {"owner_email", "owner_addr"}

# (file relative to backend/, action) → why the owner address may stay.
_ALLOWLIST = {
    # Delivery proof matched BY ADDRESS: _latest_delivery and the resend paths
    # read before.recipients / after.sent_to back to say whether the owner's
    # copy of a kasserapport went out. A fingerprint design must replace
    # writer and readers together first (R-h out of scope; 0 such rows in prod).
    ("app/routers/daily_close.py", "close.auto_emailed"),
}


def _aliases(tree: ast.Module) -> tuple[set[str], set[str]]:
    """Names bound to the audit_service module, and to its record functions."""
    mods, funcs = {"audit_service"}, set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "app.services":
            for a in node.names:
                if a.name == "audit_service":
                    mods.add(a.asname or a.name)
        elif isinstance(node, ast.ImportFrom) and node.module == "app.services.audit_service":
            for a in node.names:
                if a.name in ("record", "record_many"):
                    funcs.add(a.asname or a.name)
        elif isinstance(node, ast.Import):
            for a in node.names:
                if a.name == "app.services.audit_service" and a.asname:
                    mods.add(a.asname)
    return mods, funcs


def _audit_call_kind(call: ast.Call, mods: set[str], funcs: set[str]) -> str | None:
    f = call.func
    if isinstance(f, ast.Attribute) and f.attr in ("record", "record_many"):
        v = f.value
        if isinstance(v, ast.Name) and v.id in mods:
            return f.attr
        if isinstance(v, ast.Attribute) and v.attr == "audit_service":
            return f.attr
    if isinstance(f, ast.Name) and f.id in funcs:
        return "record_many" if f.id.endswith("many") else "record"
    return None


def _owner_email_refs(expr: ast.AST) -> list[str]:
    out = []
    for sub in ast.walk(expr):
        if (isinstance(sub, ast.Attribute) and sub.attr == "email"
                and isinstance(sub.value, ast.Name) and sub.value.id in _OWNER_NAMES):
            out.append(f"{sub.value.id}.email")
        elif isinstance(sub, ast.Name) and sub.id in _OWNER_VARS:
            out.append(sub.id)
    return out


def _scan() -> tuple[list[str], int]:
    offenders, n_calls = [], 0
    for path in sorted(_APP.rglob("*.py")):
        rel = path.relative_to(_APP.parent).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"))
        mods, funcs = _aliases(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            kind = _audit_call_kind(node, mods, funcs)
            if kind is None:
                continue
            n_calls += 1
            positional = (["db", "user", "rows"] if kind == "record_many"
                          else ["db", "user", "action", "entity_type", "entity_id", "before", "after"])
            args = dict(zip(positional, node.args))
            args.update({k.arg: k.value for k in node.keywords if k.arg})
            action = args.get("action")
            action = action.value if isinstance(action, ast.Constant) else None
            for key in ("before", "after", "rows"):
                if key not in args:
                    continue
                refs = _owner_email_refs(args[key])
                if refs and (rel, action) not in _ALLOWLIST:
                    offenders.append(f"{rel}:{node.lineno} {action or kind} {key} → {refs}")
    return offenders, n_calls


def test_no_audit_writer_stores_the_owner_email():
    offenders, n_calls = _scan()
    # The scan must actually see the writers (an import-shape change that
    # hid them all would otherwise pass vacuously).
    assert n_calls > 100, n_calls
    assert offenders == [], "\n".join(offenders)


def test_the_allowlisted_writer_is_still_the_only_one_holding_the_address():
    """If close.auto_emailed stops holding the address, drop it from the
    allowlist — an allowlist entry with nothing behind it hides the next one."""
    path = _APP / "routers" / "daily_close.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    mods, funcs = _aliases(tree)
    found = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _audit_call_kind(node, mods, funcs):
            kw = {k.arg: k.value for k in node.keywords if k.arg}
            act = kw.get("action")
            if isinstance(act, ast.Constant) and act.value == "close.auto_emailed":
                found = found or bool(_owner_email_refs(kw.get("before", ast.Constant(None))))
    assert found
    assert len(_ALLOWLIST) == 1


def test_the_guard_catches_a_new_writer():
    """The scanner itself flags the shapes it exists to stop."""
    src = (
        "from app.services import audit_service as A\n"
        "from app.services.audit_service import record as rec\n"
        "def f(db, user, owner_addr):\n"
        "    A.record(db, user, 'x.y', 'user', after={'to': user.email})\n"
        "    rec(db, user, 'x.z', 'user', None, {'a': owner_addr})\n"
        "    A.record_many(db, user, [{'action': 'q', 'entity_type': 'u', 'after': {'e': user.email}}])\n"
        "    A.record(db, user, 'x.ok', 'user', after={'recipient': 'revisor@x.dk'})\n"
    )
    tree = ast.parse(src)
    mods, funcs = _aliases(tree)
    hits = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _audit_call_kind(node, mods, funcs):
            kind = _audit_call_kind(node, mods, funcs)
            positional = (["db", "user", "rows"] if kind == "record_many"
                          else ["db", "user", "action", "entity_type", "entity_id", "before", "after"])
            args = dict(zip(positional, node.args))
            args.update({k.arg: k.value for k in node.keywords if k.arg})
            if any(_owner_email_refs(args[k]) for k in ("before", "after", "rows") if k in args):
                hits += 1
    assert hits == 3


# ── 18. redact_emails ──

@pytest.mark.parametrize("raw, clean", [
    ("550 owner@x.dk rejected", "550 [e-mail] rejected"),
    ("Recipient <anna.b+tag@cafe-nord.dk> refused", "Recipient <[e-mail]> refused"),
    ("to a@b.dk, cc c@d.com", "to [e-mail], cc [e-mail]"),
    ("no address here", "no address here"),
    (None, None),
    ("", ""),
])
def test_redact_emails(raw, clean):
    assert redact_emails(raw) == clean


# ── 14-17: the writers, end to end ───────────────────────────────────────
#
# One set of fixtures for all four (the revisor suite's in-memory DB, client
# and stubbed Resend), so no two imported fixtures share a name.

import uuid  # noqa: E402
from unittest.mock import patch  # noqa: E402

from app.models.audit_log import AuditLog  # noqa: E402
from app.services import daily_brief_email as dbe  # noqa: E402
from tests.test_daily_brief_email import (  # noqa: E402 — builders only
    _make_user as _brief_user,
    _patch_brief_pipeline,
)
from tests.test_revisor_artifacts import (  # noqa: E402,F401 — fixtures + builders
    _auth,
    _lock,
    _make_profile,
    _make_user,
    client,
    db_session,
    mailbox,
)


def _rows(db, action):
    db.expire_all()
    rows = db.query(AuditLog).filter(AuditLog.action == action).all()
    assert rows, f"no {action} row"
    return rows


# 14. Daily brief — sent and failed paths

def test_daily_brief_sent_row_holds_no_address(db_session, monkeypatch):
    _patch_brief_pipeline(monkeypatch)
    monkeypatch.setattr(dbe, "send_email", lambda *a, **kw: True)
    user = _brief_user(db_session)
    out = dbe.send_brief_to_user(db_session, user, force=True)
    assert out["ok"], out
    (row,) = _rows(db_session, "daily_brief.email_sent")
    assert "@" not in (row.after_state or "")
    after = json.loads(row.after_state)
    assert {"subject", "insight_count", "ai_polished", "tier", "forced"} <= set(after)
    assert "to" not in after
    assert row.user_id == user.id


def test_daily_brief_failed_rows_hold_no_address(db_session, monkeypatch):
    _patch_brief_pipeline(monkeypatch)
    user = _brief_user(db_session)
    # Resend answered False.
    monkeypatch.setattr(dbe, "send_email", lambda *a, **kw: False)
    dbe.send_brief_to_user(db_session, user, force=True)

    # The provider raised, quoting the address.
    def _raise(*a, **kw):
        raise RuntimeError(f"550 {user.email} rejected")
    monkeypatch.setattr(dbe, "send_email", _raise)
    dbe.send_brief_to_user(db_session, user, force=True)

    rows = _rows(db_session, "daily_brief.email_failed")
    assert len(rows) == 2
    for r in rows:
        assert "@" not in (r.after_state or ""), r.after_state
    afters = [json.loads(r.after_state) for r in rows]
    assert {"reason": "resend_returned_false"} in afters
    assert any(a.get("msg") == "550 [e-mail] rejected" and a.get("error") == "RuntimeError"
               for a in afters)


# 15. Magic-link verify

def test_magic_link_verify_row_has_no_snapshot_and_keeps_the_ip(db_session, client, monkeypatch):
    from app.routers import auth_magic_link
    from app.services import magic_link_service as mls
    auth_magic_link.limiter.reset()
    monkeypatch.setattr(auth_magic_link, "send_email", lambda *a, **kw: True)
    user = _make_user(db_session, email="ml-owner@mirabelle.dk")
    raw, _ = mls.create_token(db_session, user.email, request_ip="testclient")
    db_session.commit()
    r = client.post("/api/auth/magic-link/verify", json={"token": raw})
    assert r.status_code == 200, r.text
    (row,) = _rows(db_session, "auth.magic_link.verified")
    assert row.user_id == user.id
    assert row.after_state is None
    assert row.ip_address == "testclient"


# 16. OAuth sign-in (Google stub)

def test_oauth_signin_row_keeps_provider_not_the_address(db_session, client, monkeypatch):
    from app.config import settings as _settings
    from app.routers import auth_oauth
    from app.services.oauth_jti_cache import _reset_for_tests
    monkeypatch.setattr(_settings, "GOOGLE_CLIENT_ID",
                        "google-test-client.apps.googleusercontent.com", raising=False)
    auth_oauth.limiter.reset()
    _reset_for_tests()
    claims = {"sub": "g-sub-rh", "email": "g-owner@bonbox.test", "email_verified": True,
              "name": "Anna G", "picture": "", "jti": f"jti-{uuid.uuid4().hex}", "exp": None}
    with patch("app.routers.auth_oauth.verify_google_token", return_value=claims):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    assert r.status_code == 200, r.text
    (row,) = _rows(db_session, "auth.oauth_signin")
    after = json.loads(row.after_state)
    assert after["provider"] == "google" and "is_new" in after and "was_linked" in after
    assert "email" not in after and "@" not in row.after_state
    assert row.ip_address


# 17. send_to_accountant with cc_self, then the same key again

LOGIN = "anders@mirabelle.dk"


def test_period_send_replay_answers_cc_to_from_the_login(db_session, client, mailbox):
    user = _make_user(db_session)
    _make_profile(db_session, user)
    assert _lock(client, user).status_code == 200
    body = {"fmt": "xlsx", "cc_self": True, "key": "rh-leg06-key-001"}
    url = "/api/daily-close/send-to-accountant?from=2026-09-01&to=2026-09-30"
    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(True, None)) as sender:
        first = client.post(url, json=body, headers=_auth(user))
        assert first.status_code == 200, first.text
        assert first.json()["cc_to"] == LOGIN and first.json()["cc_self"] is True
        n_sent = sender.call_count
        again = client.post(url, json=body, headers=_auth(user))
    assert again.status_code == 200, again.text
    assert again.json()["replayed"] is True
    assert again.json()["cc_to"] == LOGIN and again.json()["cc_self"] is True
    assert sender.call_count == n_sent  # the retry mailed nothing
    (row,) = _rows(db_session, "daily_close.send_to_accountant")
    after = json.loads(row.after_state)
    assert "cc_to" not in after and after["cc_self"] is True
    assert after["recipient"] == "anna@revisor.dk"  # a third party: kept
    assert LOGIN not in row.after_state
    # The lasting record the period panel reads answers as before.
    rec = client.get("/api/daily-close/accountant-sends", headers=_auth(user)).json()
    assert rec[0]["cc_to"] == LOGIN
