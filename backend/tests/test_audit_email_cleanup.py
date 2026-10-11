"""R-h H-6 (LEG-06): the one-off cleanup of the owner's address in old
change-log rows — SQLite (the Postgres rule toggle is in
tests/test_pg_audit_email_cleanup.py).

Pins:
  19. Flag OFF: count_due = the number of target rows; nothing changes.
  20. Flag ON: the listed keys are gone, every other key intact, the
      ip_address column unchanged, non-target rows byte-identical.
  21. Rerun: due 0, changed 0, no new marker rows.
  22. Exactly one marker row per account, with counts and no "@".
  23. An email_failed msg "550 owner@x.dk rejected" → "550 [e-mail] rejected".
  + a null cc_to (no copy was sent) is not an address: that row is not due.
  + the admin endpoint and the nightly step see the same count.

Run:
  cd backend && python3 -m pytest tests/test_audit_email_cleanup.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.config import settings
from app.database import Base
from app.models.audit_log import AuditLog
from app.services import audit_email_cleanup as aec
from app.utils.time import utc_now

A_ID = uuid.uuid4()
B_ID = uuid.uuid4()
A_MAIL = "owner-a@cafe.dk"
B_MAIL = "owner-b@bar.dk"


@pytest.fixture
def Session(monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    S = sessionmaker(bind=engine)
    monkeypatch.setattr(aec, "SessionLocal", S)
    monkeypatch.setattr(aec, "engine", engine)
    return S


def _row(s, uid, action, *, before=None, after=None, ip="10.0.0.1", minutes_ago=60):
    r = AuditLog(user_id=uid, actor_id=uid, actor_type="user", action=action,
                 entity_type="user", ip_address=ip,
                 before_state=json.dumps(before, ensure_ascii=False) if before is not None else None,
                 after_state=json.dumps(after, ensure_ascii=False) if after is not None else None,
                 created_at=utc_now() - timedelta(minutes=minutes_ago))
    s.add(r)
    return r


def _seed(s):
    """Every target action with an address, plus rows that must not move."""
    t = {}
    t["brief_sent"] = _row(s, A_ID, "daily_brief.email_sent", after={
        "to": A_MAIL, "subject": "I dag hos BonBox", "insight_count": 3,
        "ai_polished": False, "tier": "pro", "forced": False})
    t["brief_failed"] = _row(s, A_ID, "daily_brief.email_failed",
                             after={"reason": "resend_returned_false", "to": A_MAIL})
    t["brief_exc"] = _row(s, B_ID, "daily_brief.email_failed",
                          after={"error": "RuntimeError", "msg": "550 owner@x.dk rejected"})
    t["oauth"] = _row(s, A_ID, "auth.oauth_signin", after={
        "email": A_MAIL, "provider": "google", "is_new": False, "was_linked": False})
    t["oauth_refused"] = _row(s, B_ID, "auth.oauth_link_refused", after={
        "email": B_MAIL, "provider": "apple", "is_new": False, "was_linked": False})
    t["magic"] = _row(s, B_ID, "auth.magic_link.verified",
                      after={"email": B_MAIL, "ip": "10.0.0.7"}, ip="10.0.0.7")
    t["unlock"] = _row(s, A_ID, "daily_close.unlock",
                       before={"status": "confirmed", "date": "2026-09-25"},
                       after={"status": "draft", "unlock_reason": "Forkert kortbeløb",
                              "unlocked_by": "owner", "unlocked_by_email": A_MAIL,
                              "unlocked_at": "2026-09-26T08:00:00"})
    t["send_cc"] = _row(s, A_ID, "daily_close.send_to_accountant", after={
        "recipient": "anna@revisor.dk", "cc_self": True, "cc_to": A_MAIL, "format": "xlsx",
        "from_date": "2026-09-01", "to_date": "2026-09-30", "send_key": "k-0000001"})
    keep = {}
    keep["send_nocc"] = _row(s, A_ID, "daily_close.send_to_accountant", after={
        "recipient": "anna@revisor.dk", "cc_self": False, "cc_to": None, "format": "csv",
        "from_date": "2026-08-01", "to_date": "2026-08-31", "send_key": "k-0000002"})
    keep["invoice"] = _row(s, A_ID, "invoice.email_sent", after={"to": "kunde@firma.dk"})
    keep["auto"] = _row(s, A_ID, "close.auto_emailed",
                        before={"recipients": ["anna@revisor.dk", A_MAIL]},
                        after={"email_status": "sent", "sent_to": ["anna@revisor.dk", A_MAIL]})
    keep["team"] = _row(s, B_ID, "team.invited", after={"email": "kok@bar.dk", "role": "staff"})
    keep["brief_new"] = _row(s, A_ID, "daily_brief.email_sent", after={
        "subject": "I dag hos BonBox", "insight_count": 1})  # written after H-5: nothing to do
    s.commit()
    return {k: v.id for k, v in t.items()}, {k: v.id for k, v in keep.items()}


def _snapshot(s, ids):
    s.expire_all()
    out = {}
    for k, rid in ids.items():
        r = s.get(AuditLog, rid)
        out[k] = (r.before_state, r.after_state, r.ip_address, r.action, r.user_id, r.created_at)
    return out


def _markers(s):
    s.expire_all()
    return s.query(AuditLog).filter(AuditLog.action == aec.MARKER_ACTION).all()


def test_flag_off_counts_the_targets_and_changes_nothing(Session, monkeypatch):
    monkeypatch.setattr(settings, "AUDIT_EMAIL_CLEANUP_ENABLED", False)
    s = Session()
    targets, keep = _seed(s)
    before = _snapshot(s, {**targets, **keep})
    assert aec.count_due(s) == len(targets) == 8
    assert aec.run_cleanup() == {"due": 8, "changed": 0, "dry_run": True}
    assert _snapshot(s, {**targets, **keep}) == before
    assert _markers(s) == []


def test_flag_on_removes_only_the_listed_keys(Session, monkeypatch):
    monkeypatch.setattr(settings, "AUDIT_EMAIL_CLEANUP_ENABLED", True)
    s = Session()
    targets, keep = _seed(s)
    kept_before = _snapshot(s, keep)
    ips_before = {k: v[2] for k, v in _snapshot(s, targets).items()}

    res = aec.run_cleanup(batch=3)  # three batches: the resume cursor is exercised
    assert res == {"due": 8, "changed": 8, "dry_run": False, "tenants": 2}

    s.expire_all()
    a = {k: json.loads(s.get(AuditLog, rid).after_state or "null") for k, rid in targets.items()}
    assert a["brief_sent"] == {"subject": "I dag hos BonBox", "insight_count": 3,
                               "ai_polished": False, "tier": "pro", "forced": False}
    assert a["brief_failed"] == {"reason": "resend_returned_false"}
    assert a["oauth"] == {"provider": "google", "is_new": False, "was_linked": False}
    assert a["oauth_refused"] == {"provider": "apple", "is_new": False, "was_linked": False}
    assert a["magic"] is None  # both keys gone: NULL, like the fixed writer
    assert a["unlock"] == {"status": "draft", "unlock_reason": "Forkert kortbeløb",
                           "unlocked_by": "owner", "unlocked_at": "2026-09-26T08:00:00"}
    assert a["send_cc"]["cc_self"] is True and "cc_to" not in a["send_cc"]
    assert a["send_cc"]["recipient"] == "anna@revisor.dk"  # third party: kept
    assert json.loads(s.get(AuditLog, targets["unlock"]).before_state) == {
        "status": "confirmed", "date": "2026-09-25"}
    # The IP column is untouched.
    assert {k: v[2] for k, v in _snapshot(s, targets).items()} == ips_before
    # Non-target rows are byte-identical.
    assert _snapshot(s, keep) == kept_before
    for k in ("brief_sent", "brief_failed", "oauth", "oauth_refused", "unlock", "send_cc"):
        assert A_MAIL not in (s.get(AuditLog, targets[k]).after_state or "")
        assert B_MAIL not in (s.get(AuditLog, targets[k]).after_state or "")


def test_email_failed_msg_is_redacted(Session, monkeypatch):
    monkeypatch.setattr(settings, "AUDIT_EMAIL_CLEANUP_ENABLED", True)
    s = Session()
    targets, _ = _seed(s)
    aec.run_cleanup()
    s.expire_all()
    after = json.loads(s.get(AuditLog, targets["brief_exc"]).after_state)
    assert after == {"error": "RuntimeError", "msg": "550 [e-mail] rejected"}


def test_rerun_does_nothing_and_writes_no_new_markers(Session, monkeypatch):
    monkeypatch.setattr(settings, "AUDIT_EMAIL_CLEANUP_ENABLED", True)
    s = Session()
    _seed(s)
    aec.run_cleanup()
    n_markers = len(_markers(s))
    assert aec.count_due(s) == 0
    assert aec.run_cleanup() == {"due": 0, "changed": 0, "dry_run": False}
    assert len(_markers(s)) == n_markers


def test_one_marker_row_per_account_with_counts_only(Session, monkeypatch):
    monkeypatch.setattr(settings, "AUDIT_EMAIL_CLEANUP_ENABLED", True)
    s = Session()
    _seed(s)
    aec.run_cleanup()
    marks = _markers(s)
    assert sorted(m.user_id for m in marks) == sorted([A_ID, B_ID])
    by = {m.user_id: json.loads(m.after_state) for m in marks}
    assert by[A_ID] == {"rows": 5, "fields": ["cc_to", "email", "to", "unlocked_by_email"],
                        "reason": "R-h LEG-06"}
    assert by[B_ID] == {"rows": 3, "fields": ["email", "ip", "msg"], "reason": "R-h LEG-06"}
    for m in marks:
        assert "@" not in m.after_state
        assert m.actor_type == "system.privacy_cleanup" and m.ip_address is None
        assert m.entity_type == "audit_log"


def test_a_batch_that_did_not_take_stops_the_run(Session, monkeypatch):
    """Never trust rowcount: if the rows still hold the keys after a batch
    (a live rule), the run stops, says so, and the count stays."""
    monkeypatch.setattr(settings, "AUDIT_EMAIL_CLEANUP_ENABLED", True)
    s = Session()
    _seed(s)
    monkeypatch.setattr(aec, "_write_batch", lambda rows: None)  # a silent no-op UPDATE
    res = aec.run_cleanup()
    assert res["error"] == "unchanged" and res["changed"] == 0
    assert aec.count_due(s) == 8
    assert _markers(s) == []


def test_daily_maintenance_runs_the_step_and_it_counts_only_by_default(Session, monkeypatch):
    from app.jobs import privacy_purges as pp
    from app.jobs import retention_and_patterns as rp
    from app.services import accounting_retention
    import app.jobs.reservation_request_expiry as rre

    monkeypatch.setattr(settings, "AUDIT_EMAIL_CLEANUP_ENABLED", False)
    s = Session()
    _seed(s)
    for name in ("purge_old_events", "expire_stale_patterns", "purge_old_error_logs",
                 "purge_expired_signup_refs"):
        monkeypatch.setattr(rp, name, lambda: 0)
    monkeypatch.setattr(rp, "detect_patterns_for_all", lambda: {})
    monkeypatch.setattr(rp, "smart_drift_scan_for_all", lambda: {})
    monkeypatch.setattr(rre, "expire_stale_requests", lambda: {})
    monkeypatch.setattr(pp, "run_privacy_purges", lambda: {"stub": True})
    monkeypatch.setattr(accounting_retention, "run_retention_sweep", lambda: {"ok": True})
    summary = rp.daily_maintenance()
    assert summary["audit_email_cleanup"] == {"due": 8, "changed": 0, "dry_run": True}
    assert summary["accounting_retention"] == {"ok": True}


def test_each_batch_is_one_update_statement_not_one_per_row(Session, monkeypatch):
    """R-h fix round: the batch UPDATE runs while DROP RULE holds the ACCESS
    EXCLUSIVE lock on audit_logs. Sent as executemany, psycopg2 makes one
    network round trip per row (500 per batch, ~13 s at 20 ms), and every
    audit_logs read or write waits behind it. Each batch must be ONE
    statement, whatever its size."""
    from sqlalchemy import event
    monkeypatch.setattr(settings, "AUDIT_EMAIL_CLEANUP_ENABLED", True)
    s = Session()
    _seed(s)
    seen = []

    def _spy(conn, cursor, statement, params, context, executemany):
        if statement.lstrip().upper().startswith(("UPDATE", "WITH")) and "audit_logs" in statement:
            seen.append(executemany)

    engine = aec.engine
    event.listen(engine, "before_cursor_execute", _spy)
    try:
        res = aec.run_cleanup(batch=500)
    finally:
        event.remove(engine, "before_cursor_execute", _spy)
    assert res["changed"] == 8 and "error" not in res
    assert seen == [False]  # one batch of 8 rows = one plain statement


def test_old_unlock_rows_with_the_address_in_unlocked_by_are_cleaned_and_history_reads_the_same(Session, monkeypatch):
    """R-h fix round: from 10 Apr to 8 Oct 2026 (ca440183 .. 31f09bab) the
    unlock writer put the owner's sign-in address in "unlocked_by" itself, with
    no "unlocked_by_email" key. Those rows were never due, so count_due said 0
    while an address remained. Now the address becomes "owner" (the role the
    fixed writer stores); the key stays, because close_history reads it, and
    the kasserapport / Excel history line is byte-identical."""
    from types import SimpleNamespace
    from app.services.close_history import close_history_events, format_history

    monkeypatch.setattr(settings, "AUDIT_EMAIL_CLEANUP_ENABLED", True)
    s = Session()
    close_id = uuid.uuid4()
    unlock = AuditLog(user_id=A_ID, actor_id=A_ID, actor_type="user", action="daily_close.unlock",
                      entity_type="daily_close", entity_id=close_id, ip_address="10.0.0.1",
                      before_state=json.dumps({"status": "confirmed", "date": "2026-06-02"}),
                      after_state=json.dumps({"status": "draft", "unlock_reason": "Forkert kortbeløb",
                                              "unlocked_by": A_MAIL,
                                              "unlocked_at": "2026-06-03T08:00:00"}),
                      created_at=utc_now() - timedelta(days=100))
    relock = AuditLog(user_id=A_ID, actor_id=A_ID, actor_type="user", action="daily_close.lock",
                      entity_type="daily_close", entity_id=close_id, ip_address="10.0.0.1",
                      after_state=json.dumps({"status": "confirmed", "closed_by": "owner"}),
                      created_at=utc_now() - timedelta(days=99))
    s.add_all([unlock, relock])
    s.commit()
    owner, closes = SimpleNamespace(id=A_ID), [SimpleNamespace(id=close_id)]

    def _lines():
        s.expire_all()
        evs = close_history_events(s, owner, closes)[str(close_id)]
        return format_history(evs, danish=True), format_history(evs, danish=False)

    lines_before = _lines()
    assert "ejeren" in lines_before[0] and "the owner" in lines_before[1]
    assert aec.count_due(s) == 1

    res = aec.run_cleanup()
    assert res["changed"] == 1 and "error" not in res
    assert aec.count_due(s) == 0
    s.expire_all()
    after = json.loads(s.get(AuditLog, unlock.id).after_state)
    assert after == {"status": "draft", "unlock_reason": "Forkert kortbeløb",
                     "unlocked_by": "owner", "unlocked_at": "2026-06-03T08:00:00"}
    assert A_MAIL not in s.get(AuditLog, unlock.id).after_state
    assert _lines() == lines_before  # the printed history does not move
    marks = _markers(s)
    assert len(marks) == 1
    assert json.loads(marks[0].after_state)["fields"] == ["unlocked_by"]


def test_a_role_or_name_in_unlocked_by_is_not_an_address(Session):
    """Only an address is replaced: "owner", "manager" or a person's name stay."""
    for who in ("owner", "manager", "Anna Jensen"):
        nb, na, removed = aec.clean_row("daily_close.unlock", None,
                                        json.dumps({"status": "draft", "unlocked_by": who}))
        assert removed == set() and json.loads(na)["unlocked_by"] == who


# ── The flag's precondition: every "never edited" promise names the edit ──
# AUDIT_EMAIL_CLEANUP_ENABLED edits the change log once. Six places (three
# per language) say BonBox never edits it. The R-j paragraph for /privacy is
# drafted for only one of them, so turning the flag on after that paragraph
# alone would leave Terms § 4 and the /privacy retention-table row untrue.
# This trips the moment the R-j paragraph lands while another place still
# promises no edit without the October 2026 exception.
from pathlib import Path  # noqa: E402

_FRONT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "pages"
_RJ_PARAGRAPH = ("we removed, once, the e-mail addresses", "fjernede vi én gang de e-mailadresser")
_NO_EDIT = {
    "terms_en": ("TermsPage.jsx", "cannot be edited or deleted through BonBox &mdash; neither by you nor by us"),
    "terms_da": ("TermsPage.jsx", "kan ikke redigeres eller slettes gennem BonBox — hverken af dig eller af os"),
    "privacy_row_en": ("PrivacyPolicyPage.jsx", "No end date: it cannot be edited or deleted through BonBox"),
    "privacy_row_da": ("PrivacyPolicyPage.jsx", "Ingen slutdato: den kan ikke redigeres eller slettes gennem BonBox"),
    "privacy_par_en": ("PrivacyPolicyPage.jsx", "The log cannot be edited or deleted through BonBox — neither by you nor by us"),
    "privacy_par_da": ("PrivacyPolicyPage.jsx", "Loggen kan ikke redigeres eller slettes gennem BonBox — hverken af dig eller af os"),
}
_EXCEPTION = ("October 2026", "oktober 2026")


def _places_without_the_exception(sources: dict) -> list:
    """Every place that still says 'never edited' with no October 2026
    exception within the same few sentences."""
    gaps = []
    for place, (page, phrase) in _NO_EDIT.items():
        src = sources[page]
        i = src.find(phrase)
        if i < 0:
            continue  # reworded: the R-j text took this sentence out
        window = src[i:i + len(phrase) + 400]
        if not any(e in window for e in _EXCEPTION):
            gaps.append(place)
    return gaps


def _sources():
    return {p: (_FRONT / p).read_text(encoding="utf-8")
            for p in ("TermsPage.jsx", "PrivacyPolicyPage.jsx")}


def test_cleanup_precondition_every_no_edit_promise_names_the_exception():
    src = _sources()
    if any(m in src["PrivacyPolicyPage.jsx"] for m in _RJ_PARAGRAPH):
        assert _places_without_the_exception(src) == [], (
            "The R-j change-log exception is on /privacy, but these places still say the "
            "change log is never edited — add the exception there before "
            "AUDIT_EMAIL_CLEANUP_ENABLED is turned on")
    else:
        # Today: no R-j text yet, all six places promise no edit, and the flag
        # must stay off (see config.py).
        assert len(_places_without_the_exception(src)) == 6
        assert type(settings).model_fields["AUDIT_EMAIL_CLEANUP_ENABLED"].default is False


def test_the_precondition_check_catches_the_r_j_paragraph_alone():
    """Not vacuous: the drafted R-j (a) paragraph on /privacy alone leaves the
    four other places flagged."""
    src = _sources()
    p = src["PrivacyPolicyPage.jsx"]
    p = p.replace("and we have set no end date for it.",
                  "and we have set no end date for it. One exception: in October 2026 "
                  "we removed, once, the e-mail addresses that older entries held.")
    p = p.replace("og vi har ikke sat en slutdato for den.",
                  "og vi har ikke sat en slutdato for den. Én undtagelse: I oktober 2026 "
                  "fjernede vi én gang de e-mailadresser, som ældre poster indeholdt.")
    gaps = _places_without_the_exception({**src, "PrivacyPolicyPage.jsx": p})
    assert sorted(gaps) == ["privacy_row_da", "privacy_row_en", "terms_da", "terms_en"]
