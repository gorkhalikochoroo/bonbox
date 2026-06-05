# BonBox — repo map

A guide to *where things live*, so you can find any feature fast. Nothing here
moves code — it just documents the layout. For conventions & rules, see
`CLAUDE.md`.

**Stack:** FastAPI backend (`api.bonbox.dk`, Render) · Vite/React frontend
(`bonbox.dk`, Vercel) · Supabase Postgres (prod). DK-first SMB SaaS.

```
smallbiz-dashboard/
├── backend/          FastAPI API + tests
├── frontend/         Vite + React app
├── docs/             specs, notes, design docs
├── scripts/          one-off / maintenance scripts (e.g. check-i18n-keys.cjs)
├── deploy.sh         one-tap frontend prod deploy (vercel --prod)
├── CLAUDE.md         project rules & conventions (read this first)
└── STRUCTURE.md      ← you are here
```

---

## Backend — `backend/`

```
backend/
├── app/
│   ├── main.py            app wiring: routers, middleware (CORS, CSRF, security
│   │                      headers, rate-limit), and the `_migrations` list
│   │                      (idempotent ADD COLUMN IF NOT EXISTS — see CLAUDE.md)
│   ├── config.py          Settings / env vars (SECRET_KEY, SUPABASE_*, Stripe…)
│   ├── database.py        SQLAlchemy engine, Base, get_db, GUID type
│   ├── routers/           HTTP endpoints — one file per feature (~80 files)
│   │                        auth, daily_close, reservations, staff, staff_portal,
│   │                        invoices, kasserapport, tax, billing, bank_connect, …
│   ├── models/            SQLAlchemy ORM tables (~70 files), one per entity
│   ├── schemas/           Pydantic request/response shapes
│   ├── services/          business logic (~100 files) — PDF builders, OCR,
│   │                        reconciliation, payroll, email, storage, auth helpers
│   ├── jobs/              scheduled/cron jobs (daily brief, syncs, maintenance)
│   ├── utils/             small helpers (time, crypto, csv_safe, …)
│   └── data/              static reference data
├── tests/                pytest suite (run with the venv — see below)
├── alembic/              migration history (documentation-only; the live
│                          migrations run from main.py `_migrations`)
└── venv/                 local virtualenv (Python 3.13, all deps) — gitignored
```

**Auth model:** every authed endpoint resolves the owner via
`get_current_user` (`services/auth.py`); queries scope by `user_id`.
Public surfaces: `routers/public_*` (token-verified) and `routers/staff_portal.py`
(per-staff 192-bit URL token, mounted at `/api/portal`).

**Run tests** (use the venv — system `python3` is too old to import the app):
```bash
backend/venv/bin/python -m pytest backend/tests/ -q
```

---

## Frontend — `frontend/`

```
frontend/
├── index.html            entry HTML (PWA manifest logic, meta, SW registration)
├── vite.config.js        Vite config
└── src/
    ├── main.jsx          React entry
    ├── App.jsx           routes (owner app, /r/:slug public booking, /s/:token portal)
    ├── pages/            one component per screen (DashboardPage, ReservationsPage,
    │                       StaffSchedulePage, StaffPortalPage, …)
    ├── components/        feature components (FloorPlan, GlobalSearchModal, cards…)
    │   └── ui/           LOCKED design system primitives — Button, Input, Chip,
    │                       EntryCard, DataTable, FilterBar, PageShell, StatCard,
    │                       TabPills, Icon (Lucide), UpgradeNudge  (+ index.js)
    ├── hooks/            useAuth, useLanguage (i18n), useFeatures, useEntitlements…
    ├── services/         API client (axios `api` = authed, `portalApi` = public)
    ├── i18n/             translation bundles (da/en + th/vi/tr/np)
    ├── config/           frontend config
    ├── assets/           images / fonts
    └── utils/            helpers
```

**Design system (LOCKED — see CLAUDE.md):** gray-900 primary, status colors
only, Lucide outline icons, Inter, rounded-xl. Build UI from `components/ui/*`.

**i18n discipline:** every `t("key")` needs a real entry (en + da) in
`hooks/useLanguage.jsx` — `t()` returns the *key string* when missing, so a
missing key renders as raw text. Guard: `node scripts/check-i18n-keys.cjs`.

**Verify frontend:** `cd frontend && npm run build` ·
`node scripts/check-i18n-keys.cjs`.

---

## "Where do I find…?"

| Looking for | Go to |
|---|---|
| An API endpoint | `backend/app/routers/<feature>.py` |
| A DB table | `backend/app/models/<entity>.py` |
| Business logic / PDF / OCR | `backend/app/services/` |
| A DB column add | `backend/app/main.py` → `_migrations` **and** the model |
| A screen | `frontend/src/pages/<Name>Page.jsx` |
| A reusable UI primitive | `frontend/src/components/ui/` |
| Translations | `frontend/src/hooks/useLanguage.jsx` (+ `src/i18n/`) |
| Auth / current user | backend `services/auth.py` · frontend `hooks/useAuth.jsx` |
| Tier gating / caps | `backend/app/services/billing.py` |
| Deploy | backend → push (Render auto) · frontend → `./deploy.sh` |
| Rules & conventions | `CLAUDE.md` |

---

## Deploy

- **Backend:** `git push` → Render auto-deploys (~2–5 min; cold start can 503).
  Pending `_migrations` run automatically on boot.
- **Frontend:** `./deploy.sh` (pins the Vercel link to the `bonbox` project and
  runs `vercel --prod`). Vercel does **not** reliably auto-deploy on push.
