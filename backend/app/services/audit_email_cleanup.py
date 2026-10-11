"""
R-h H-6 (LEG-06): a one-off cleanup of the owner's e-mail address in old
change-log (audit_logs) rows.

Since R-h H-5 the writers below no longer store the owner's own address
(the row's user_id already says whose account it was). This removes the
same keys from the rows written before that. Nothing else in a row changes:
the ip_address column, third-party recipients (the revisor's "recipient",
an invoice customer, an invitee, a supplier) and every other action are
left exactly as they are.

It ships OFF (settings.AUDIT_EMAIL_CLEANUP_ENABLED). OFF = count only.
Turn it on only after the R-j text names this one edit in every place that
says the change log is never edited, in EN and DA: the /privacy "Change
log" paragraph, the /privacy retention-table row and Terms § 4 ("neither by
you nor by us"). See the comment on the flag in config.py.

On Postgres the change log is guarded by two rules, audit_logs_no_update and
audit_logs_no_delete (main.py). An UPDATE under the update rule silently
does nothing, so each batch, in ONE transaction:
    SET LOCAL lock_timeout = '3s'
    DROP RULE IF EXISTS audit_logs_no_update
    UPDATE ... (at most `batch` rows)
    CREATE OR REPLACE RULE audit_logs_no_update ...
Postgres DDL is transactional: any failure rolls the whole batch back,
DROP included, so the update rule is never left off. The delete rule is
never touched. Rowcount is never trusted: after each batch the rows are
re-read and the keys must be gone, or the run stops and says so.

After the batches one marker row per affected account records the edit
("audit.owner_email_removed"), so the change to the immutable log is itself
in the log. Idempotent: once nothing is due, a run does nothing (the rule
is not toggled and no marker is written).

Logs carry counts and exception names only — never an id or an address.
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict

from sqlalchemy import String, Text, and_, column, or_, text, update
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal, engine
from app.models.audit_log import AuditLog
from app.utils.log_redact import redact_emails

logger = logging.getLogger(__name__)

# action -> keys removed from before_state / after_state
OWNER_EMAIL_KEYS = {
    "daily_brief.email_sent": ("to",),
    "daily_brief.email_failed": ("to",),          # + "msg" passed through redact_emails
    "auth.oauth_signin": ("email",),
    "auth.oauth_link_refused": ("email",),
    "auth.magic_link.verified": ("email", "ip"),  # the ip_address column is untouched
    "daily_close.unlock": ("unlocked_by_email",),
    "daily_close.send_to_accountant": ("cc_to",),
}

MARKER_ACTION = "audit.owner_email_removed"
PAGE = 1000


class CleanupStopped(Exception):
    """A batch did not take (a live rule, a role that does not own the
    table, a lock timeout): nothing pretends to be done."""


def _load(raw):
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return raw  # not JSON (an old repr fallback): never touched


def _dump(state):
    if state is None:
        return None
    return json.dumps(state, default=str, ensure_ascii=False)


def _clean_state(action: str, state):
    """(cleaned state, removed keys). A key is removed only when it holds a
    value: a null cc_to carries no address and is left alone, so a row is
    edited only where it actually held personal data."""
    if not isinstance(state, dict):
        return state, set()
    keys = OWNER_EMAIL_KEYS.get(action, ())
    out = dict(state)
    removed = set()
    for k in keys:
        if k in out and out[k] is not None:
            del out[k]
            removed.add(k)
    if action == "daily_brief.email_failed" and isinstance(out.get("msg"), str):
        red = redact_emails(out["msg"])
        if red != out["msg"]:
            out["msg"] = red
            removed.add("msg")
    if removed and not out:
        out = None  # nothing left: store NULL, as the fixed writer does
    return out, removed


def clean_row(action: str, before_raw, after_raw):
    """(new_before_json, new_after_json, removed_keys). removed_keys empty =
    the row is not due."""
    b, a = _load(before_raw), _load(after_raw)
    nb, rb = _clean_state(action, b)
    na, ra = _clean_state(action, a)
    removed = rb | ra
    if not removed:
        return before_raw, after_raw, set()
    return (_dump(nb) if rb else before_raw), (_dump(na) if ra else after_raw), removed


def _candidates_filter():
    A = AuditLog
    return and_(
        A.action.in_(tuple(OWNER_EMAIL_KEYS)),
        or_(
            A.after_state.like("%@%"),
            and_(A.action == "auth.magic_link.verified", A.after_state.like('%"ip"%')),
        ),
    )


def _iter_due(db: Session, after_id=None):
    """Yield (id, user_id, action, new_before, new_after, removed) for every
    due row with an id above `after_id`, keyset-paged by id, PAGE rows at a
    time."""
    A = AuditLog
    last = after_id
    while True:
        q = db.query(A.id, A.user_id, A.action, A.before_state, A.after_state).filter(
            _candidates_filter())
        if last is not None:
            q = q.filter(A.id > last)
        page = q.order_by(A.id).limit(PAGE).all()
        if not page:
            return
        for rid, uid, action, before, after in page:
            nb, na, removed = clean_row(action, before, after)
            if removed:
                yield rid, uid, action, nb, na, removed
        last = page[-1][0]


def count_due(db: Session) -> int:
    """How many change-log rows still hold an owner address. Count only."""
    return sum(1 for _ in _iter_due(db))


def _batch_values(rows: list[dict]):
    """The batch as one VALUES list, (id, before, after) per row, every value
    a bound parameter. VALUES columns are named column1..column3 on both
    Postgres and SQLite, so no column-alias syntax is needed."""
    tuples, params = [], {}
    for i, r in enumerate(rows):
        tuples.append(f"(:i{i}, :b{i}, :a{i})")
        params[f"i{i}"] = str(r["_id"])  # audit_logs.id is VARCHAR(36), as GUID binds it
        params[f"b{i}"] = r["_b"]
        params[f"a{i}"] = r["_a"]
    return (text("VALUES " + ", ".join(tuples)).bindparams(**params)
            .columns(column("column1", String), column("column2", Text), column("column3", Text))
            .cte("v"))


def _write_batch(rows: list[dict]) -> None:
    with engine.begin() as conn:
        pg = conn.dialect.name == "postgresql"
        if pg:
            conn.execute(text("SET LOCAL lock_timeout = '3s'"))
            conn.execute(text("DROP RULE IF EXISTS audit_logs_no_update ON audit_logs"))
        t = AuditLog.__table__
        # ONE statement for the whole batch (WITH v AS (VALUES ...) UPDATE ...
        # FROM v). The batch runs while DROP RULE holds the ACCESS EXCLUSIVE
        # lock on audit_logs, and every read or write of the change log waits
        # behind it. Sent as executemany, psycopg2 made one round trip per
        # row: 500 rows at ~20 ms (Render Frankfurt -> Supabase eu-west-1)
        # held the lock for ~13 s. One statement is one round trip.
        v = _batch_values(rows)
        conn.execute(
            update(t).add_cte(v).where(t.c.id == v.c.column1)
            .values(before_state=v.c.column2, after_state=v.c.column3)
        )
        if pg:
            conn.execute(text("CREATE OR REPLACE RULE audit_logs_no_update AS "
                              "ON UPDATE TO audit_logs DO INSTEAD NOTHING"))


def _confirm(ids: list) -> None:
    """Re-read the batch: every row must now be clean. Never trust rowcount
    (a live update rule makes the UPDATE a silent no-op)."""
    db: Session = SessionLocal()
    try:
        rows = (db.query(AuditLog.action, AuditLog.before_state, AuditLog.after_state)
                .filter(AuditLog.id.in_(ids)).all())
        if len(rows) != len(ids):
            raise CleanupStopped("unchanged")
        for action, before, after in rows:
            if clean_row(action, before, after)[2]:
                raise CleanupStopped("unchanged")
    finally:
        db.close()


def _write_markers(per_tenant: dict) -> None:
    from app.services import audit_service
    db: Session = SessionLocal()
    try:
        for user_id, info in per_tenant.items():
            audit_service.record(
                db, user=user_id, action=MARKER_ACTION, entity_type="audit_log",
                after={"rows": info["rows"], "fields": sorted(info["fields"]),
                       "reason": "R-h LEG-06"},
                actor_type="system.privacy_cleanup",
            )
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.warning("[audit_cleanup] marker rows failed: %s", type(e).__name__)
        raise
    finally:
        db.close()


def run_cleanup(*, enabled: bool | None = None, batch: int = 500, max_batches: int = 20) -> dict:
    """Remove the owner's address from old change-log rows. Flag OFF (the
    default) = count only. Returns counts, never ids or addresses."""
    if enabled is None:
        enabled = bool(settings.AUDIT_EMAIL_CLEANUP_ENABLED)
    db: Session = SessionLocal()
    try:
        due = count_due(db)
    finally:
        db.close()
    if not enabled:
        return {"due": due, "changed": 0, "dry_run": True}
    if due == 0:
        return {"due": 0, "changed": 0, "dry_run": False}

    changed = 0
    per_tenant: dict = defaultdict(lambda: {"rows": 0, "fields": set()})
    error = None
    resume = None  # rows are taken in id order; each batch starts after the last
    try:
        for _ in range(max_batches):
            db = SessionLocal()
            try:
                pending = []
                for rid, uid, _action, nb, na, removed in _iter_due(db, after_id=resume):
                    pending.append((rid, uid, nb, na, removed))
                    if len(pending) >= batch:
                        break
            finally:
                db.close()
            if not pending:
                break
            _write_batch([{"_id": rid, "_b": nb, "_a": na} for rid, _u, nb, na, _r in pending])
            _confirm([rid for rid, *_ in pending])
            resume = pending[-1][0]
            changed += len(pending)
            for _rid, uid, _nb, _na, removed in pending:
                per_tenant[uid]["rows"] += 1
                per_tenant[uid]["fields"] |= removed
    except Exception as e:  # noqa: BLE001
        error = str(e) if isinstance(e, CleanupStopped) else type(e).__name__
        logger.warning("[audit_cleanup] stopped: %s", error)

    if per_tenant:
        # What did change is recorded even when a later batch stopped.
        try:
            _write_markers(per_tenant)
        except Exception as e:  # noqa: BLE001
            error = error or f"markers:{type(e).__name__}"

    out = {"due": due, "changed": changed, "dry_run": False, "tenants": len(per_tenant)}
    if error:
        out["error"] = error
    logger.info("[audit_cleanup] %s", out)
    return out
