"""
Audit service — append-only mutation log.

Used by every financial mutation (invoice.mark_paid, invoice.void,
business_profile.logo_upload, payment_suggestion.accept, etc.) to leave
an immutable trail for Bogføringsloven §9 compliance + dispute defense.

Design notes:
  • Defensive — wrapped in try/except so an audit-log write failure can
    NEVER block a legitimate business mutation. We log the error and
    move on. The alternative (block the mutation if audit fails) would
    let a DB hiccup take down user actions, which is worse.
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
) -> None:
    """Insert one audit row. Best-effort: failures are logged, not raised.

    Args:
      db: active SQLAlchemy session — the caller is responsible for the
          commit. We add+flush so the row is visible in the same
          transaction (atomic with the parent mutation), but don't commit.
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
    """
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
        db.add(log)
        db.flush()
    except Exception as e:
        # Never let audit-log failure block a real mutation. Log loudly.
        logger.exception(
            "audit.record FAILED action=%s entity=%s:%s user=%s err=%s",
            action, entity_type, entity_id, user, e,
        )
