"""Terminal-provider catalog seeder — idempotent UPSERT at boot.

Reads ``backend/app/data/terminal_providers.json`` and reconciles the
``terminal_providers`` table to match. Safe to run on every boot:

  • New rows (slug not in DB)        → INSERT
  • Existing rows with drifted data  → UPDATE
  • Existing rows already matching   → no-op

The catalog is GLOBAL (no user_id) — adding a provider is a pure
content change (one PR appending a JSON entry), never a schema
migration. The DDL for the table lives in ``main.py:_run_migrations()``
ALTER list per BonBox doctrine (no Alembic, see CLAUDE.md).

Adding a row:
  1. Append the object to ``backend/app/data/terminal_providers.json``
  2. Deploy. Next boot UPSERTs the new row.
  3. No code change required for downstream — the FK on Terminal is
     soft (ON DELETE SET NULL), so legacy terminals keep their NULL
     until the owner / detector picks a provider.

Layer 8 — graceful degradation: caller wraps in try/except and logs
on failure. The OCR / Daily Close paths must continue working even
if the catalog is stale or empty (detection is Commit 2; for Commit 1
this seeder only exists to make the catalog queryable).
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.models.terminal_provider import TerminalProvider
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

# Catalog JSON lives in `backend/app/data/terminal_providers.json`,
# co-located with the model that consumes it. Pre-computed at module
# import time so the path is resolved once, not per call.
_DATA_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
    "terminal_providers.json",
)

# Columns we reconcile on every UPSERT. `slug` is the natural key
# (matched separately); `id`/`created_at` are immutable; `updated_at`
# is stamped by SQLAlchemy onupdate.
_RECONCILED_COLUMNS = (
    "display_name",
    "country_hq",
    "dk_market_tier",
    "industries",
    "psd2_settlement",
    "signature_keywords",
    "is_active",
)


def _load_catalog() -> list[dict[str, Any]]:
    """Read the JSON catalog into a list of provider dicts.

    Returns empty list if the file is missing / malformed — the caller
    can't crash boot for a content-file problem. Logs at WARN so the
    operator notices in Render logs.
    """
    try:
        with open(_DATA_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        logger.warning(
            "terminal_providers seed: catalog file missing at %s — "
            "skipping seed (table will be empty)", _DATA_PATH,
        )
        return []
    except json.JSONDecodeError as e:
        logger.warning(
            "terminal_providers seed: catalog JSON malformed (%s) — "
            "skipping seed to avoid corrupting the table", e,
        )
        return []
    if not isinstance(data, list):
        logger.warning(
            "terminal_providers seed: catalog root is %s, expected list — skipping",
            type(data).__name__,
        )
        return []
    return data


def _normalize_keywords(raw: Any) -> str:
    """Convert JSON `signature_keywords` (list[str]) to the DB storage
    format (newline-separated lowercase). Handles edge cases:
      • None / missing      → ""
      • already a string    → trust the caller (no double-conversion)
      • list of strings     → join with "\\n" after lowercasing
    """
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, (list, tuple)):
        return "\n".join(str(k).strip().lower() for k in raw if k)
    return ""


def seed_terminal_providers(db: Session) -> dict[str, int]:
    """Reconcile the terminal_providers table to match the JSON catalog.

    Idempotent UPSERT on ``slug``. Returns counts for logging:
      {"created": N, "updated": N, "unchanged": N, "total": N}

    The caller is expected to wrap this in try/except — failure of the
    seeder must not crash startup (Layer 8). On success, log the counts.
    """
    catalog = _load_catalog()
    if not catalog:
        return {"created": 0, "updated": 0, "unchanged": 0, "total": 0}

    # Pre-load existing rows keyed by slug — single query, then in-memory
    # comparisons. 18 rows today, max maybe 50 in a year; fits trivially.
    existing = {p.slug: p for p in db.query(TerminalProvider).all()}

    created = 0
    updated = 0
    unchanged = 0

    for entry in catalog:
        slug = (entry.get("slug") or "").strip()
        if not slug:
            logger.warning(
                "terminal_providers seed: row missing slug, skipping: %s", entry,
            )
            continue

        normalized = {
            "display_name": entry.get("display_name") or slug,
            "country_hq": entry.get("country_hq"),
            "dk_market_tier": entry.get("dk_market_tier") or "fallback",
            "industries": entry.get("industries"),
            "psd2_settlement": entry.get("psd2_settlement") or "no",
            "signature_keywords": _normalize_keywords(entry.get("signature_keywords")),
            "is_active": bool(entry.get("is_active", True)),
        }

        row = existing.get(slug)
        if row is None:
            # INSERT path — give it a fresh UUID. created_at + updated_at
            # default to utc_now via the model.
            row = TerminalProvider(
                id=uuid.uuid4(),
                slug=slug,
                **normalized,
            )
            db.add(row)
            created += 1
            continue

        # UPDATE path — apply only columns that drifted. Avoids spurious
        # updated_at bumps when the catalog hasn't actually changed.
        drift = False
        for col in _RECONCILED_COLUMNS:
            current = getattr(row, col, None)
            target = normalized[col]
            if current != target:
                setattr(row, col, target)
                drift = True
        if drift:
            row.updated_at = utc_now()
            updated += 1
        else:
            unchanged += 1

    db.commit()
    total = created + updated + unchanged
    logger.info(
        "terminal_providers seed: %d created, %d updated, %d unchanged (total %d)",
        created, updated, unchanged, total,
    )
    return {
        "created": created,
        "updated": updated,
        "unchanged": unchanged,
        "total": total,
    }
