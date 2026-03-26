# ADR-001: Auto-migrations on startup

## Status: Accepted

## Context
Render free tier does not provide shell access. Alembic migrations cannot be run manually.

## Decision
Use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements in `backend/app/main.py` that run on every app startup. These are idempotent and safe to run multiple times.

## Consequences
- No manual migration step needed
- New columns are added automatically on deploy
- Cannot do complex migrations (rename columns, data transforms)
- Must always use IF NOT EXISTS to avoid errors
