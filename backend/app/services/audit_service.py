"""
Audit service — append-only mutation log.

Used by every financial mutation (invoice.mark_paid, invoice.void,
business_profile.logo_upload, payment_suggestion.accept, etc.) to leave
an immutable trail for Bogføringsloven §9 compliance + dispute defense.

Design notes:
  • Defensive — wrapped in try/except so an audit-log write failure is
    logged here and never raised from here. It does NOT let the mutation
    through without its row: see ATOMIC below (the failed flush has rolled
    the transaction back, so the caller's commit fails — as it always
    effectively did before 27 Oct).
  • …but never the CALLER's error (fix round 27 Oct, backend F1). The
    caller's own pending change is flushed first, OUTSIDE the guard: its
    unique or exclusion conflict (two venues taking one link, two screens
    seating two parties on one table) reaches the caller's IntegrityError
    handler and becomes a 409. It used to be flushed inside the guard,
    swallowed, and the caller's commit then failed with PendingRollbackError
    — a 500.
  • ATOMIC with the caller's change (fix round 4, 27 Oct, review2 #4). An
    audit row that cannot be written is logged here, and the failed flush
    leaves the caller's transaction rolled back: its commit raises and
    NEITHER the change nor its row is kept. Many rows are state, not just a
    log — the waitlist's HELD and left marks, daily_close.lock (the
    Bogføringsloven trail), spam and its undo, the usage counters billing
    reads — and a change must never commit without its row.
    `best_effort=True` (opt-in, plain logging that carries no state only)
    puts the row in a SAVEPOINT instead: if it fails, only the savepoint is
    rolled back and the change still commits. No caller opts in today.
  • Size discipline — `before` and `after` should include identity
    fields (id, user_id, status) plus only the fields that changed.
    Don't dump 50-field model blobs into the JSON snapshots.
  • IP capture — caller passes `request.client.host` when available.
    For scheduled jobs / system actions, pass `actor_type='system.X'`
    and `ip_address=None`.
"""
from __future__ import annotations

import json
import logging
from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog
from app.models.user import User

logger = logging.getLogger(__name__)


def _serialize(state: dict | None) -> str | None:
    """JSON-encode a state dict safely. Returns None if input is None.
    Converts non-JSON types (UUID, datetime, Decimal) to strings."""
    if state is None:
        return None
    try:
        return json.dumps(state, default=str, ensure_ascii=False)
    except Exception as e:
        logger.warning("audit._serialize: %s — using repr fallback", e)
        return repr(state)[:5000]  # cap, never let an audit row blow up


def _flush_callers_change(db) -> None:
    """Flush what the CALLER changed before the audit row exists — outside
    every guard, so its IntegrityError (a lost race) reaches the caller's
    handler. A stand-in session without flush (a test's fake) has nothing
    pending to flush."""
    flush = getattr(db, "flush", None)
    if flush is not None:
        flush()


def _savepoint(db: Session):
    """db.begin_nested() with the caller's transaction really open first —
    the house pattern, shared in app/utils/savepoint.py."""
    from app.utils.savepoint import savepoint
    return savepoint(db)


def record(
    db: Session,
    user: User | UUID,
    action: str,
    entity_type: str,
    entity_id: UUID | None = None,
    before: dict | None = None,
    after: dict | None = None,
    *,
    ip_address: str | None = None,
    actor_id: UUID | None = None,
    actor_type: str = "user",
    best_effort: bool = False,
) -> None:
    """Insert one audit row, atomic with the caller's change (see above).

    Args:
      db: active SQLAlchemy session — the caller is responsible for the
          commit. We add+flush so the row is visible in the same
          transaction (atomic with the parent mutation), but don't commit.
          A row that cannot be written is logged, and the session is left
          rolled back: the caller's commit fails, nothing is kept.
      user: the User or user_id this audit row belongs to (tenant key).
      action: namespaced verb like 'invoice.mark_paid'. Required.
      entity_type: 'invoice', 'business_profile', 'payment_suggestion', ...
      entity_id: UUID of the affected entity, or None for collection-level
          actions ('retention.run').
      before, after: state snapshots — small dicts of changed fields.
      ip_address: from request.client.host. None for system actions.
      actor_id: if mutation was performed by a different user than the
          tenant owner (future admin support). Defaults to user.id.
      actor_type: 'user' | 'system.retention' | 'system.payment_match' | 'admin'.
      best_effort: opt-in, for plain logging that carries no state: the row
          goes in a SAVEPOINT, and if it fails the change still commits.
    """
    # The caller's own change first, outside the guard: its error is the
    # caller's to answer (a 409), never swallowed here.
    _flush_callers_change(db)
    try:
        user_id = user.id if hasattr(user, "id") else user
        if actor_id is None and actor_type == "user":
            actor_id = user_id

        log = AuditLog(
            user_id=user_id,
            actor_id=actor_id,
            actor_type=actor_type,
            ip_address=ip_address,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            before_state=_serialize(before),
            after_state=_serialize(after),
        )
        if best_effort:
            with _savepoint(db):
                db.add(log)
        else:
            db.add(log)
            db.flush()
    except Exception as e:
        # Logged loudly. Atomic (the default): the failed flush has rolled
        # the caller's transaction back, so its commit fails and the change
        # goes with the row. best_effort: only the savepoint went.
        logger.exception(
            "audit.record FAILED action=%s entity=%s:%s user=%s best_effort=%s err=%s",
            action, entity_type, entity_id, user, best_effort, e,
        )


def record_many(
    db: Session,
    user: User | UUID,
    rows: list[dict],
    *,
    ip_address: str | None = None,
    actor_id: UUID | None = None,
    actor_type: str = "user",
) -> None:
    """Insert several audit rows with ONE flush — `record` in a loop is a
    round trip per row (the lønseddel wrote one per employee: 24 staff, 24
    INSERTs). Still one row per entity; nothing is merged.

    Each dict in `rows` carries `record`'s per-row arguments: `action`,
    `entity_type`, and optionally `entity_id`, `before`, `after`. The shared
    ones (tenant, actor, ip) are given once. Same contract as `record`: the
    caller commits, and a failure is logged, never raised.
    """
    if not rows:
        return
    _flush_callers_change(db)   # the caller's own change first (see record)
    try:
        user_id = user.id if hasattr(user, "id") else user
        if actor_id is None and actor_type == "user":
            actor_id = user_id
        db.add_all([
            AuditLog(
                user_id=user_id,
                actor_id=actor_id,
                actor_type=actor_type,
                ip_address=ip_address,
                action=r["action"],
                entity_type=r["entity_type"],
                entity_id=r.get("entity_id"),
                before_state=_serialize(r.get("before")),
                after_state=_serialize(r.get("after")),
            )
            for r in rows
        ])
        db.flush()
    except Exception as e:
        logger.exception(
            "audit.record_many FAILED actions=%s rows=%d user=%s err=%s",
            sorted({r.get("action") for r in rows}), len(rows), user, e,
        )
