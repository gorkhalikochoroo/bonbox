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
- **Auth**: JWT tokens, stored in localStorage
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
