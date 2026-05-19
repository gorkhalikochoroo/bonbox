"""
MobilePay nightly sync — task #71.

Runs at 03:45 UTC (~04:45/05:45 Copenhagen) — 15 minutes after the
Aiia sync at 03:30 so the bank-side payout rows already exist and the
MobilePay-direct settlements can be reconciled against them.

Iterates active MobilePayConnections. Skip if synced within the last
12 hours (so manual syncs from the UI a few hours earlier don't get
double-pulled). Per-connection transaction boundary keeps one bad
row from poisoning others.

Defensive notes:
  * Each connection runs in its own try/commit/rollback. Failures
    write `mobilepay.sync` audit + continue.
  * 401 from MobilePay -> mark status='expired' (consent needs
    renewal). Owner sees the expiry in /connections.
  * Cron is in-process — no HTTP surface. Zero attack surface for an
    external trigger of MobilePay syncs.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.mobilepay_connection import MobilePayConnection
from app.models.user import User
from app.services import audit_service
from app.services.mobilepay_client import (
    MobilePayClientError,
    get_mobilepay_client,
)
from app.utils.time import utc_now

logger = logging.getLogger(__name__)


# Cron skips connections last-synced within this window. 12h chosen so
# the nightly run still hits connections that the owner manually
# synced earlier in the day (>12h ago) but skips fresh ones.
_SKIP_IF_SYNCED_WITHIN = timedelta(hours=12)


def _due_connections(db: Session, now: datetime) -> list[MobilePayConnection]:
    """Active connections that haven't been synced in the skip window.
    Capped at 200 rows per tick to stay inside Render free-runtime."""
    cutoff = now - _SKIP_IF_SYNCED_WITHIN
    q = db.query(MobilePayConnection).filter(MobilePayConnection.status == "active")
    q = q.filter(
        or_(
            MobilePayConnection.last_synced_at.is_(None),
            MobilePayConnection.last_synced_at < cutoff,
        )
    )
    return (
        q.order_by(MobilePayConnection.last_synced_at.asc().nullsfirst())
        .limit(200)
        .all()
    )


def _sync_one(db: Session, conn: MobilePayConnection) -> dict:
    """Sync a single connection. Returns a dict summary. Never raises —
    failures go into the summary's `error` key + write an audit row."""
    user = db.query(User).filter(User.id == conn.user_id).first()
    if not user:
        return {
            "connection_id": str(conn.id),
            "skipped": True,
            "reason": "user_missing",
        }

    summary = {
        "connection_id": str(conn.id),
        "new_payments": 0,
        "auto_matched": 0,
        "total_fetched": 0,
        "error": None,
    }

    if not conn.mp_merchant_id:
        summary["error"] = "no_merchant_id"
        return summary

    # Inline import to avoid a circular dep (router -> services -> cron
    # -> router). The helper does both refresh-on-near-expiry and the
    # auto-match write path, so the cron reuses the same code as the
    # manual sync endpoint.
    from app.routers.mobilepay import (
        _auto_match_payments,
        _refresh_token_if_needed,
    )

    try:
        access_token = _refresh_token_if_needed(db, user, conn, request=None)
    except MobilePayClientError as e:
        before = {"status": conn.status}
        if e.kind in ("revoked", "unauthorized", "missing_refresh") or e.status == 401:
            conn.status = "expired"
            audit_service.record(
                db, user, "mobilepay.sync",
                entity_type="mobilepay_connection", entity_id=conn.id,
                before=before,
                after={"status": "expired", "error": str(e)[:200], "source": "cron"},
                actor_type="system.cron",
            )
            db.commit()
            summary["error"] = "expired"
            return summary
        logger.exception(
            "mobilepay_sync_job: token refresh failed for conn=%s", conn.id,
        )
        audit_service.record(
            db, user, "mobilepay.sync",
            entity_type="mobilepay_connection", entity_id=conn.id,
            after={"error": str(e)[:200], "source": "cron", "phase": "refresh"},
            actor_type="system.cron",
        )
        db.commit()
        summary["error"] = str(e)[:200]
        return summary

    since = (
        conn.last_synced_at - timedelta(days=1)
        if conn.last_synced_at else None
    )

    try:
        client = get_mobilepay_client()
        payments = client.list_payments(
            conn.mp_merchant_id, access_token, since=since,
        )
    except MobilePayClientError as e:
        if e.kind in ("revoked", "unauthorized") or e.status == 401:
            before = {"status": conn.status}
            conn.status = "expired"
            audit_service.record(
                db, user, "mobilepay.sync",
                entity_type="mobilepay_connection", entity_id=conn.id,
                before=before,
                after={"status": "expired", "error": str(e)[:200], "source": "cron"},
                actor_type="system.cron",
            )
            db.commit()
            summary["error"] = "expired"
            return summary
        logger.exception(
            "mobilepay_sync_job: list_payments failed for conn=%s", conn.id,
        )
        audit_service.record(
            db, user, "mobilepay.sync",
            entity_type="mobilepay_connection", entity_id=conn.id,
            after={"error": str(e)[:200], "source": "cron", "phase": "list"},
            actor_type="system.cron",
        )
        db.commit()
        summary["error"] = str(e)[:200]
        return summary

    try:
        new_payments, auto_matched, _ = _auto_match_payments(db, user, payments)
        conn.last_synced_at = utc_now()
        audit_service.record(
            db, user, "mobilepay.sync",
            entity_type="mobilepay_connection", entity_id=conn.id,
            after={
                "new_payments": new_payments,
                "auto_matched": auto_matched,
                "total_fetched": len(payments),
                "source": "cron",
            },
            actor_type="system.cron",
        )
        db.commit()
        summary.update({
            "new_payments": new_payments,
            "auto_matched": auto_matched,
            "total_fetched": len(payments),
        })
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.exception(
            "mobilepay_sync_job: ingest/match failed for conn=%s", conn.id,
        )
        audit_service.record(
            db, user, "mobilepay.sync",
            entity_type="mobilepay_connection", entity_id=conn.id,
            after={"error": str(e)[:200], "source": "cron", "phase": "ingest"},
            actor_type="system.cron",
        )
        db.commit()
        summary["error"] = str(e)[:200]

    return summary


def run_mobilepay_sync_tick() -> dict:
    """Cron entrypoint. Returns an aggregate summary dict suitable for
    a future health endpoint."""
    db: Session = SessionLocal()
    try:
        connections = _due_connections(db, utc_now())
        logger.info("mobilepay_sync_job: %s connections due", len(connections))
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
