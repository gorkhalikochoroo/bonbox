# BonBox — Small Business Analytics Dashboard

## Project Overview
Full-stack analytics platform for small businesses (restaurants, kiosks, shops).
React frontend + FastAPI backend + PostgreSQL (Supabase).

## Architecture
```
├── frontend/          React + Tailwind CSS (Vite, deployed on Vercel)
│   ├── src/pages/     Page components (Dashboard, Sales, Expenses, etc.)
│   ├── src/components/ Shared components (Modal, QuickAdd, Layout, etc.)
│   ├── src/hooks/     Custom hooks (useLanguage, useAuth, etc.)
│   └── src/services/  API client (axios)
├── backend/           FastAPI + SQLAlchemy (deployed on Render)
│   ├── app/routers/   API endpoints (auth, sales, expenses, etc.)
│   ├── app/models.py  SQLAlchemy models
│   ├── app/schemas.py Pydantic schemas
│   └── app/main.py    App entry + auto-migrations
├── docs/              Architecture decisions & runbooks
└── .claude/           Claude Code config, hooks, skills
```

## Key Technical Decisions
- **i18n**: Custom `useLanguage()` hook with `t(key)` — supports EN 🇬🇧, DA 🇩🇰, NP 🇳🇵
- **Auth**: JWT — web rides on an HttpOnly `bonbox_session` cookie (set by `/auth/login`); native iOS (Capacitor) keeps the JWT in localStorage because cross-site cookies aren't reliable inside WKWebView. Backend's `get_current_user` accepts either source.
- **DB Migrations**: Auto-run on startup via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in main.py (no shell access on Render free tier)
- **Lazy Loading**: `lazyRetry()` wrapper around React.lazy() with retry delays
- **Service Worker**: bonbox-v3 cache with auto-clear on errors
- **Rate Limiting**: SlowAPI, 15/min on registration (CGNAT-aware for Nepal)
- **Email**: Resend API for welcome emails and password reset codes

## Deployment
- **Frontend**: Vercel (auto-deploy from GitHub main branch) → bonbox.dk
- **Backend**: Render free tier → bonbox-api.onrender.com
- **Database**: Supabase PostgreSQL (EU region)
- **Keep-alive**: cron-job.org pings /api/health every 2 min

## Common Commands
```bash
# Frontend dev
cd frontend && npm run dev

# Backend dev
cd backend && uvicorn app.main:app --reload

# Database migrations (add to _migrations list in backend/app/main.py)
# No alembic needed — auto-runs on startup
```

## Conventions
- All user-facing strings must use `t("key")` from useLanguage hook
- Payment methods: cash, card, mobilepay, dankort, bank_transfer, mixed
- Translation keys go in `frontend/src/hooks/useLanguage.jsx`
- New DB columns: add `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` to main.py _migrations list
- Commit messages: concise, include Co-Authored-By for Claude

## Schema changes — DO NOT use Alembic

**BonBox runs schema changes via `_run_migrations()` in `backend/app/main.py`, NOT via `alembic upgrade head`.** Render's start command is `uvicorn app.main:app …`, which only runs `_init_db()` (which calls `_run_migrations()`). It does NOT run `alembic upgrade head`.

When you add or change a column, table, or index:

1. Add an `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` (or `CREATE INDEX IF NOT EXISTS`) statement to the ALTER list in `backend/app/main.py` (currently ending around line ~1480 with the events/bookings indexes).
2. Every statement MUST be idempotent (`IF NOT EXISTS`) so re-deploys are no-ops.
3. New columns MUST be nullable with no server default (or carry a default the existing rows can adopt) so the ALTER is non-locking on a large prod table.
4. The Alembic infrastructure (`backend/alembic/`) is kept for documentation only. Do NOT rely on `alembic upgrade head` — Render never invokes it.
5. The startup self-test (`_verify_schema_no_drift`) will fail-loud at boot if a SQLAlchemy model declares a column the DB doesn't have. If you see `SCHEMA_DRIFT:` in the logs, the missing ALTER is your bug — fix it in `main.py` and re-deploy.

**Behaviour of the self-test:**
- **Postgres (prod)**: hard-fail. `_db_ready.set()` is NOT called, the readiness gate keeps returning 503, Render rolls back to the previous deploy.
- **SQLite (dev)**: log-and-continue. You see the `SCHEMA_DRIFT:` warning but the worker still starts so contributors don't get stuck on a partial fixture.

**Local guard:** run `bash scripts/check-migration-pattern.sh` (or wire it into `.git/hooks/pre-commit`) before you commit a change that touches `backend/alembic/versions/`. The script blocks if the Alembic file changed but `backend/app/main.py` did not.

**Reference incident:** 2026-05-26 production-down for ~10 min when commit `7c0e4c2` shipped a User column via Alembic instead of the ALTER list. Fix landed as `d3dc5ae`.
