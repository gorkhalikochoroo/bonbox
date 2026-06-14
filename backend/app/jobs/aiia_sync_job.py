"""
Aiia nightly sync — task #67.

Runs at 03:30 UTC (~04:30/05:30 Copenhagen) — before owners check the
app for the day, after the existing maintenance cron at 02:30.

Iterates active BankConnections. Skip if synced within the last 12
hours (so manual syncs from the UI a few hours earlier don't get
double-pulled). Per-connection transaction boundary keeps one bad
row from poisoning others.

Defensive notes:
  • Each connection runs in its own try/commit/rollback. Failures
    write `bank_connect.sync_failed` audit + continue.
  • 401 from Aiia → mark status='expired' (DK SCA / 90-day re-consent
    needed). Owner sees the expiry in /connections.
  • Cron is in-process — no HTTP surface. Zero attack surface for an
    external trigger of bank syncs.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.bank_connection import BankConnection
from app.models.user import User
from app.services import audit_service, bank_reconciliation
from app.services.aiia_client import AiiaClientError, get_aiia_client
from app.utils.time import utc_now

logger = logging.getLogger(__name__)


# Cron skips connections last-synced within this window. 12h chosen so
# the nightly run still hits connections that the owner manually
# synced earlier in the day (>12h ago) but skips fresh ones.
_SKIP_IF_SYNCED_WITHIN = timedelta(hours=12)


def _due_connections(db: Session, now: datetime) -> list[BankConnection]:
    """Active connections that haven't been synced in the skip window.
    Capped at 200 rows per tick to stay inside Render free-runtime."""
    cutoff = now - _SKIP_IF_SYNCED_WITHIN
    q = db.query(BankConnection).filter(BankConnection.status == "active")
    # SQLAlchemy treats `is None OR < cutoff` correctly with or_().
    from sqlalchemy import or_
    q = q.filter(
        or_(
            BankConnection.last_synced_at.is_(None),
            BankConnection.last_synced_at < cutoff,
        )
    )
    return q.order_by(BankConnection.last_synced_at.asc().nullsfirst()).limit(200).all()


def _sync_one(db: Session, conn: BankConnection) -> dict:
    """Sync a single connection. Returns a dict summary. Never raises —
    failures go into the summary's `error` key + write an audit row."""
    user = db.query(User).filter(User.id == conn.user_id).first()
    if not user:
        return {"connection_id": str(conn.id), "skipped": True, "reason": "user_missing"}

    # Run the same code path as the manual sync endpoint, minus the
    # HTTPException-raising parts. Inlined here to avoid a circular
    # import (router → service → cron → router).
    from app.routers.bank_connect import (
        _auto_confirm_high_confidence,
        _ingest_transactions,
    )

    summary = {
        "connection_id": str(conn.id),
        "new_sales": 0,
        "new_expenses": 0,
        "skipped": 0,
        "suggestions": 0,
        "auto_confirmed": 0,
        "error": None,
    }

    if not conn.aiia_account_id:
        summary["error"] = "no_account_id"
        return summary

    since = (
        conn.last_synced_at - timedelta(days=1)
        if conn.last_synced_at else None
    )

    try:
        client = get_aiia_client()
        txns = client.list_transactions(conn.aiia_account_id, since=since)
    except AiiaClientError as e:
        # 401 → expired
        if e.kind in ("revoked", "unauthorized") or e.status == 401:
            before = {"status": conn.status}
            conn.status = "expired"
            audit_service.record(
                db, user, "bank_connect.expired",
                entity_type="bank_connection", entity_id=conn.id,
                before=before, after={"status": "expired", "error": str(e)[:200]},
                actor_type="system.cron",
            )
            db.commit()
            summary["error"] = "expired"
            return summary
        logger.exception("aiia_sync_job: list_transactions failed for conn=%s", conn.id)
        audit_service.record(
            db, user, "bank_connect.sync_failed",
            entity_type="bank_connection", entity_id=conn.id,
            after={"error": str(e)[:200]},
            actor_type="system.cron",
        )
        db.commit()
        summary["error"] = str(e)[:200]
        return summary

    try:
        ns, ne, sk, sf = _ingest_transactions(db, user, conn, txns)
        db.flush()
        suggestions = bank_reconciliation.match_transactions(
            db, user.id, import_id="latest", lookback_days=90,
        )
        auto_confirmed = _auto_confirm_high_confidence(db, user, suggestions, request=None)
        conn.last_synced_at = utc_now()
        audit_service.record(
            db, user, "bank_connect.sync",
            entity_type="bank_connection", entity_id=conn.id,
            after={
                "new_sales": ns, "new_expenses": ne,
                "skipped": sk, "skipped_foreign": sf,
                "suggestions": len(suggestions),
                "auto_confirmed": auto_confirmed,
                "source": "cron",
            },
            actor_type="system.cron",
        )
        db.commit()
        summary.update({
            "new_sales": ns, "new_expenses": ne,
            "skipped": sk, "skipped_foreign": sf,
            "suggestions": len(suggestions),
            "auto_confirmed": auto_confirmed,
        })
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.exception("aiia_sync_job: ingest/match failed for conn=%s", conn.id)
        audit_service.record(
            db, user, "bank_connect.sync_failed",
            entity_type="bank_connection", entity_id=conn.id,
            after={"error": str(e)[:200]},
            actor_type="system.cron",
        )
        db.commit()
        summary["error"] = str(e)[:200]

    return summary


def run_aiia_sync_tick() -> dict:
    """Cron entrypoint. Returns an aggregate summary dict suitable for
    a future health endpoint."""
    db: Session = SessionLocal()
    try:
        connections = _due_connections(db, utc_now())
        logger.info("aiia_sync_job: %s connections due", len(connections))
        results = []
        for conn in connections:
            results.append(_sync_one(db, conn))
        return {
            "tick_at": utc_now().isoformat(),
            "total": len(connections),
            "ok": sum(1 for r in results if not r.get("error")),
            "errors": sum(1 for r in results if r.get("error")),
            "results": results,
        }
    finally:
        db.close()
