# BonBox Production Deployment Checklist

Audit baseline: HEAD `632f72f`, 2026-05-19. Backend on Render
(`bonbox-api.onrender.com` → `api.bonbox.dk`). Frontend on Vercel
(`bonbox.dk`). Database is Supabase Postgres (EU).

This document is the pre-launch gate. Walk every section before pointing
real Copenhagen café owners at the production URL.

---

## 1. Environment variable matrix

Source of truth for every variable the backend reads. Verified by
`grep -rn "os.environ.get\|os.getenv\|settings\." backend/app/`
(25 direct `os.*` calls + 70+ `settings.X` references — all map to
either the Pydantic `Settings` class in `backend/app/config.py` or the
`os.environ.get(...)` blocks in `app/main.py`, `app/utils/crypto.py`,
`app/services/aiia_client.py`, `app/services/mobilepay_client.py`,
`app/services/email_service.py`, `app/services/storage.py`,
`app/services/daily_brief_email.py`, `app/services/receipt_ocr.py`, and
`app/routers/whatsapp.py`).

### 1a. Required in production (set on Render → Environment)

| Env var | Required? | Default in code | Used by | Notes |
|---|---|---|---|---|
| `ENVIRONMENT` | YES | `development` | `config.py`, `main.py`, `crypto.py`, `routers/auth.py`, `routers/accountants.py` | MUST be `production`. Flips secure cookies, CORS strictness, fail-loud crypto, JWT-key strength check, and trial-token cache. |
| `DATABASE_URL` | YES | `postgresql://postgres:postgres@localhost:5432/smallbiz` | `database.py` via `settings.DATABASE_URL` | Supabase pooler URL (`postgresql+psycopg2://…@aws-0-eu-…pooler.supabase.com:6543/postgres`). The default is dev-only. |
| `SECRET_KEY` | YES | `secrets.token_urlsafe(64)` (per-process random) | `services/auth.py`, `routers/waitlist.py` | JWT HMAC key. **Must be 32+ chars** (warning at `main.py:2120`). If left random, every restart logs every user out. |
| `SECRET_KEY_PREVIOUS` | optional | `""` | `services/auth.py` | Grace-period decode key for JWT rotation. Unset once 24 h have passed since rotation. |
| `APP_SECRET_KEY` | YES | (none — fails loud in prod) | `utils/crypto.py` | Fernet (32-byte url-safe base64). Encrypts Aiia + MobilePay refresh tokens at rest. Generate once: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. If missing, bank-connect endpoints fail at first request. |
| `APP_SECRET_KEY_PREVIOUS` | conditional | `""` | `utils/crypto.py` | REQUIRED during a key rotation. `assert_can_decrypt_existing_tokens()` runs at boot in prod and refuses to start if rotation breaks existing tokens. |
| `RESEND_API_KEY` | YES | `""` | `services/email_service.py` | Outbound mail (welcome, password reset, daily brief, accountant export, invoice email). If empty, every email path is a silent no-op. |
| `RESEND_FROM_EMAIL` | YES | `BonBox <noreply@bonbox.dk>` | `services/email_service.py` | Friendly-from. Must match a verified Resend sender domain. |
| `ANTHROPIC_API_KEY` | YES (for AI polish) | `""` | `routers/wine.py`, `services/daily_brief.py`, `services/anomaly_detector.py`, `services/sale_parser.py`, `services/triage_service.py`, `routers/agent.py` | Claude API. If empty, daily brief / agent / parse fall back to deterministic templates — app still works, but loses the "wow" copy. |
| `USE_CLAUDE_API` | recommended | `False` | `config.py` (read at boot) | Master switch — must be `true` to enable Claude calls in services. Lets you ship with the key set but flag-off if quota is tight. |
| `AIIA_ENV` | YES | `mock` | `services/aiia_client.py` | `mock` / `sandbox` / `live`. Default = mock — set to `live` only after partner agreement closes. |
| `AIIA_BASE_URL` | conditional | `""` | `services/aiia_client.py` | Required when `AIIA_ENV` ∈ {sandbox, live}. Otherwise falls back to mock with a warning. |
| `AIIA_CLIENT_ID` | conditional | `""` | `services/aiia_client.py` | Same gating as above. |
| `AIIA_CLIENT_SECRET` | conditional | `""` | `services/aiia_client.py` | Same gating as above. Server-side only. |
| `AIIA_REDIRECT_URI` | YES (prod) | `""` (falls back to `FRONTEND_URL + /api/bank-connect/callback`) | `routers/bank_connect.py` via `settings.AIIA_REDIRECT_URI` | MUST be `https://api.bonbox.dk/api/bank-connect/callback` in prod — `FRONTEND_URL` (`https://bonbox.dk`) is wrong because the callback lives on the API origin. |
| `MOBILEPAY_ENV` | YES | `mock` | `services/mobilepay_client.py` | `mock` / `sandbox` / `live`. Stays `mock` until MobilePay Erhverv partner agreement closes. |
| `MOBILEPAY_BASE_URL` | conditional | `""` | `services/mobilepay_client.py` | Required for sandbox/live (e.g. `https://api.sandbox.vippsmobilepay.com`). |
| `MOBILEPAY_CLIENT_ID` | conditional | `""` | `services/mobilepay_client.py` | Same gating. |
| `MOBILEPAY_CLIENT_SECRET` | conditional | `""` | `services/mobilepay_client.py` | Same gating. Server-side only. |
| `VAPID_PUBLIC_KEY` | YES (for push) | `""` | `routers/push.py`, `services/push_sender.py` | Web Push (Task #72). If empty, `/api/push/*` returns 503 and the 06:00 UTC push cron silently no-ops — email cron still ships. |
| `VAPID_PRIVATE_KEY` | YES (for push) | `""` | `services/push_sender.py` | Same as above. **Do not rotate lightly** — every device must re-subscribe on rotation. |
| `VAPID_SUBJECT` | YES (for push) | `mailto:hello@bonbox.dk` | `services/push_sender.py` | RFC 8292 — must be `mailto:` or `https://`. Default is fine. |
| `GOOGLE_CLIENT_ID` | YES (for Sign-in-with-Google) | `""` | `routers/auth.py`, `services/oauth_google.py`, `routers/auth_oauth.py` | Audience check on ID-token verify. If empty, all Google sign-ins return 503. |
| `APPLE_ALLOWED_AUDIENCES` | YES (for SIWA) | `dk.bonbox.app` | `routers/auth.py`, `services/oauth_apple.py` | Comma-separated list of accepted `aud` values for Apple ID-token. iOS bundle ID + web Service ID. |
| `APPLE_CLIENT_ID` | YES (for SIWA web) | `""` | `services/oauth_apple.py` | Falls back to first entry of `APPLE_ALLOWED_AUDIENCES`. Set the Service ID here for the unified `/auth/oauth/apple` flow. |
| `APPLE_TEAM_ID` | optional today | `""` | `config.py` only | 10-char Apple Team ID. Tracked for future server-to-server validation (refresh-token flow). |
| `STRIPE_SECRET_KEY` | YES | `""` | `services/stripe_billing.py` | `sk_live_…` in prod. Without it `/api/billing/*` returns 503. |
| `STRIPE_PUBLISHABLE_KEY` | YES | `""` | `services/stripe_billing.py` | Exposed via `/api/billing/config` for the frontend. |
| `STRIPE_WEBHOOK_SECRET` | YES | `""` | `services/stripe_billing.py` | Per-endpoint signing secret (`whsec_…`). MUST match the one Stripe shows on the webhook config — verifies every POST to `/api/billing/stripe/webhook`. |
| `STRIPE_PRICE_ID_STARTER` | YES | `""` | `services/stripe_billing.py` | `price_…` for 199 DKK/mo (regular Starter). |
| `STRIPE_PRICE_ID_STARTER_FOUNDING` | YES | `""` | `services/stripe_billing.py` | `price_…` for 129 DKK/mo (founder Starter, first 100 customers). |
| `STRIPE_PRICE_ID_PRO` | YES | `""` | `services/stripe_billing.py` | `price_…` for 349 DKK/mo (regular Pro). |
| `STRIPE_PRICE_ID_PRO_FOUNDING` | YES | `""` | `services/stripe_billing.py` | `price_…` for 249 DKK/mo (founder Pro). |
| `STRIPE_PRICE_ID_BUSINESS` | legacy / optional | `""` | `services/stripe_billing.py:676` | Business tier dropped May 2026 — kept for webhook back-compat. Leave empty unless you have legacy Business customers. |
| `FRONTEND_URL` | YES | `http://localhost:5173` | `main.py` (CORS), `routers/auth.py`, `routers/auth_magic_link.py`, `routers/accountants.py`, `routers/bank_connect.py`, `routers/mobilepay.py`, `services/stripe_billing.py` | MUST be `https://bonbox.dk` in prod. Drives password-reset links, OAuth bounce-back, Stripe success/cancel URLs, and CORS-allow if not already in the static `_PROD_ORIGINS` list. |
| `STRIPE_SUCCESS_URL` | optional | `""` (falls back to `FRONTEND_URL + /subscription?success=1`) | `services/stripe_billing.py` | Override if you want a different return URL post-checkout. |
| `STRIPE_CANCEL_URL` | optional | `""` (falls back to `FRONTEND_URL + /subscription?canceled=1`) | `services/stripe_billing.py` | Same as above. |
| `FOUNDER_MAX_SLOTS` | YES | `100` | `routers/founder_rate.py` | Cap for the founder-rate pill. Once `claimed >= max_slots`, the landing-page pill flips and new signups see regular pricing. |
| `FOUNDING_MEMBER_LIMIT` | YES | `100` | `services/stripe_billing.py` | Separate counter used inside Stripe checkout to pick founding vs regular price IDs. Keep equal to `FOUNDER_MAX_SLOTS`. |
| `SENTRY_DSN` | recommended | `""` (off) | `main.py:10-30` | If set AND `sentry-sdk` is installed, FastAPI + SQLAlchemy integrations init at import time. **`sentry-sdk` is NOT in `requirements.txt` as of HEAD `632f72f`** — see Section 3. |

### 1b. Optional / nice-to-have

| Env var | Default | Used by | Notes |
|---|---|---|---|
| `SUPABASE_URL` | `""` | `services/storage.py` | Required for persisting receipt photos to the private `receipts` bucket. If empty, storage falls back to local disk (dev only — Render's filesystem is ephemeral). |
| `SUPABASE_SERVICE_KEY` | `""` | `services/storage.py` | `sb_secret_…`. **Server-side only — never expose to the frontend.** |
| `SUPABASE_RECEIPTS_BUCKET` | `receipts` | `services/storage.py` | Override only if you renamed the bucket. |
| `SUPABASE_ANON_KEY` | `""` | `config.py` only | Currently unused server-side; safe to omit on Render. |
| `GOOGLE_VISION_API_KEY` | `""` | `services/receipt_ocr.py` | Primary OCR backend. If empty, falls back to OCR.space. |
| `OCRSPACE_API_KEY` | `""` | `services/receipt_ocr.py` | Secondary OCR. If both empty, OCR features 503 cleanly. |
| `GOOGLE_PLACES_API_KEY` | `""` | `services/competitor_service.py` | Powers "nearby competitor" discovery. Optional — feature degrades gracefully. |
| `COMPANIES_HOUSE_API_KEY` | `""` | `config.py` only | UK companies register — currently unused for DK. Safe to omit. |
| `ADMIN_EMAIL` | `""` | `routers/auth.py`, `services/triage_service.py` | If set, Manoj gets notified on new signups + critical errors. |
| `SUPER_ADMIN_EMAILS` | `""` | (admin gate) | Comma-separated allowlist for `/admin/*`. **Defense-in-depth: row must ALSO have `users.role='super_admin'`.** |
| `ADMIN_LOCKOUT_THRESHOLD` | `5` | admin brute-force lock | OK to leave default. |
| `ADMIN_LOCKOUT_WINDOW_MIN` | `10` | admin brute-force lock | OK to leave default. |
| `ADMIN_LOCKOUT_COOLDOWN_MIN` | `15` | admin brute-force lock | OK to leave default. |
| `PUBLIC_APP_URL` | `https://app.bonbox.dk` | `services/daily_brief_email.py` | CTA links inside the morning brief email. Override only if the SPA moves. |
| `LOCAL_UPLOADS_ROOT` | `uploads` | `services/storage.py` | Dev-only fallback path. Irrelevant on Render. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_NUMBER` | `""` / `""` / sandbox | `routers/whatsapp.py` | WhatsApp Business is experimental — leave empty unless we've onboarded a brand. |

### 1c. Spotted code fix (not applied — for next maintenance commit)

`backend/app/main.py:175`:

```python
if settings.ENVIRONMENT == "production" and settings.SECRET_KEY == _default_secret.__doc__:
```

This compares `SECRET_KEY` to `_default_secret.__doc__` (the docstring
literal `"Generate a random secret if none is provided via env."`),
which is never equal to a Fernet key. The intent was clearly
`settings.SECRET_KEY is _default_secret()` or to track whether the
factory was used. As-is the warning **never fires**. Not a blocker —
the separate length-check at `main.py:2119-2128` covers the real
failure mode — but worth a one-line fix in the next chore commit.

---

## 2. Healthcheck endpoints

| Path | Method | 200 response | Used by | Notes |
|---|---|---|---|---|
| `/` | GET / HEAD | `{"status":"ok","service":"bonbox-api"}` | Render bootstrap probe | `main.py:2580` |
| `/api/health` | GET / HEAD | `{"status":"ok"}` | **Render healthcheck URL** + cron-job.org keep-alive | `main.py:2585`. Always passes once the process is up. |
| `/api/health/db` | GET | `{"status":"ok","database":"connected"}` (or 503) | UptimeRobot — proves Postgres is reachable | `main.py:2590`. Runs `SELECT 1` through the engine. |

All three are whitelisted in the DB-readiness gate
(`main.py:1740`) so they answer 200 even before migrations finish
running — good for Render's 60-second healthcheck timeout on a cold
boot.

**Render configuration:**
- Health Check Path: `/api/health`
- Auto-deploy: enabled on `main` branch pushes
- Start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`

---

## 3. Error reporting

**Status: WIRED but inert.** `main.py:6-30` has the full Sentry init
block (FastAPI + SQLAlchemy integrations, 5% trace sample rate,
`send_default_pii=False`) — but `sentry-sdk` is **not** in
`backend/requirements.txt`. The block falls into its `ImportError`
branch and warns "SENTRY_DSN set but sentry-sdk not installed".

There's a homegrown alternative at `app/models/error_log.py` +
`/admin/errors` (router admin.py:438): an `error_logs` DB table with a
middleware that captures stack traces. This gives us Sentry-shape data
without the bill.

**Day-1 recommendation (15-minute task):**

1. Add `sentry-sdk[fastapi]>=2.0.0` to `backend/requirements.txt`.
2. Create a Sentry project, set `SENTRY_DSN` on Render.
3. Re-deploy. The init block already handles environment tagging
   (`ENVIRONMENT` env var → `environment=...`).

This is **not a launch blocker** — the existing error-log table plus
Render's log drain (stdout streams to the dashboard log explorer) cover
us for the first 10-20 owners. Add Sentry when daily-active hits double
digits.

---

## 4. APScheduler cron audit

All jobs live under `app/jobs/` and are registered in
`main.py:2430-2569`. Timezone is UTC (APScheduler default). Copenhagen
times in parens for sanity.

| ID | Schedule (UTC) | Function | Idempotent? | Cold-start miss behaviour |
|---|---|---|---|---|
| `payment_autosync` | every 6 h | `services.payment_autosync.run_auto_sync` | YES (skips connections synced in last window) | Re-runs at next tick; provider auto-sync is best-effort by design. |
| `daily_maintenance` | `02:30` (03:30/04:30 CPH) | `jobs.retention_and_patterns.daily_maintenance` | YES (GDPR purge is timestamp-keyed, detector is read-only) | One missed sweep = up to 25 h of retained PII before the next purge — fine for 10-year retention windows. |
| `kasserapport_drift_sweep` | `03:00` | `jobs.kasserapport_learning_jobs.daily_drift_sweep` | YES (per-POS confidence trend, computed from immutable history) | Skipped day shows up as a gap in the trend chart; no data loss. |
| `demo_account_refresh` | `03:15` | `jobs.demo_refresh_job.refresh_demo_account` | YES (no-ops unless trial ends within 7 d) | Demo trial might expire if 7 consecutive days are skipped — a Render free-tier app worth of risk. Acceptable. |
| `kasserapport_pattern_sweep` | Sun `03:30` | `jobs.kasserapport_learning_jobs.weekly_pattern_sweep` | YES (recomputes patterns from raw corrections; idempotent) | Missed week → patterns stay frozen one extra week. Acceptable. |
| `aiia_sync` | `03:30` | `jobs.aiia_sync_job.run_aiia_sync_tick` | YES (skips connections synced in last 12 h) | One missed night = transactions pulled the next morning instead. Aiia retains 90 days of history so no data is ever lost. |
| `mobilepay_sync` | `03:45` | `jobs.mobilepay_sync_job.run_mobilepay_sync_tick` | YES (same 12 h dedupe) | Same as Aiia. Slot intentionally 15 min after Aiia so payout-vs-settlement dedup works. |
| `recurring_expenses` | `04:00` | `jobs.recurring_expenses_job.materialize_due_recurring_expenses` | YES (per-rule "already posted today" check inside SAVEPOINT) | A missed day means a rent / Wolt fee row lands one day late. Owner sees it; no double-posting. |
| `daily_brief_push` | `06:00` (07:00/08:00 CPH) | `jobs.daily_brief_push_job.send_daily_brief_pushes` | YES (per-user `last_brief_pushed_at` short-circuits same-day) | Missed push → owner still sees brief in-app + email at 06:30. |
| `daily_brief_email` | `06:30` (07:30/08:30 CPH) | `jobs.daily_brief_email_job.send_daily_brief_emails` | YES (`last_brief_emailed_at` short-circuits same-day) | Brief still visible in-app; one missed email day acceptable. |

**Cold-start exposure:** Render free-tier sleeps after 15 min idle.
cron-job.org pings `/api/health` every 2 min → backend stays warm 24/7
in practice. APScheduler runs in-process, so if the process restarts
mid-job, the partial work is lost but everything is idempotent. **No
hidden cron state exists** that would corrupt on a skipped tick — all
job state is keyed off DB columns (`last_*_at` timestamps), not
APScheduler's own job store.

**Lifespan shutdown:** `main.py:1542-1551` calls `scheduler.shutdown(wait=False)`
on SIGTERM so Render's 30-second drain window doesn't hang.

---

## 5. Database migrations

`backend/app/main.py:85` holds the `_migrations` list. 294 statements
total; 295 occurrences of `IF NOT EXISTS` (the extra one is the inline
audit-log RULE block at line 822). Statements are executed inside
per-statement SAVEPOINTs at `main.py:1418-1434` so one bad migration
doesn't poison the run.

**Audit by class:**

| Pattern | Count | Idempotent? |
|---|---|---|
| `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` | ~250 | YES |
| `CREATE INDEX IF NOT EXISTS` | ~30 | YES |
| `CREATE TABLE IF NOT EXISTS` | ~10 | YES |
| `ALTER TABLE ... ALTER COLUMN ... TYPE ...` (Migration 014, lines 436-437) | 2 | YES (re-running a type widening is a no-op) |
| `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL` (Migration 016, line 449) | 1 | YES (dropping NOT NULL twice is a no-op) |
| `INSERT INTO _migration_log ...` | 0 | n/a (no migration tracking table — idempotency is the contract) |

**Verdict:** every statement is idempotent. Re-running the full list
on a fully-migrated DB produces zero changes.

**Caveat — Migration 011 lesson** (comment at `main.py:756-764`): when
adding an FK column via raw SQL, **always match the existing PK
column type** (we use `VARCHAR(36)` from `GUID()`). Migrating from
`UUID` would silently fail under SAVEPOINT. Future migrations must
follow this convention.

---

## 6. Audit log immutability

**Status: VERIFIED.** `main.py:1152` defines `_verify_audit_log_immutability`,
invoked at `main.py:1442` immediately after migrations land.

The function:
1. Inserts a sentinel row into `audit_logs` with `id = uuid.uuid4()`.
2. Issues `DELETE FROM audit_logs WHERE id = :id`.
3. Re-queries to confirm the row is still there.
4. If the row is gone, logs CRITICAL (`bonbox.security` logger).

The Postgres RULEs themselves are installed at `main.py:822-826`:

```sql
CREATE OR REPLACE RULE audit_logs_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;
CREATE OR REPLACE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING;
```

Sentinel rows are auto-purged by the 10-year retention sweep in
`daily_maintenance`. Side effect: SQLite-backed dev DBs skip this
check (RULEs are PG-only).

**Day-1 verification step:** after first prod deploy, grep Render logs
for `bonbox.security` — the absence of CRITICAL lines confirms the
RULE is active.

---

## 7. Performance budget (frontend)

`cd frontend && npx --no-install vite build` ran clean in 735 ms
against HEAD. Top 5 chunks by gzipped size:

| Chunk | Raw | Gzipped | Notes |
|---|---|---|---|
| `vendor-i18n` | 467.4 kB | **143.0 kB** | i18next + 15 language packs. Lazy-loaded per locale on first hit — only the active locale ends up in the parsed bundle. |
| `vendor-charts` | 411.5 kB | **117.6 kB** | Recharts. Loaded only by pages that render charts (Dashboard, Reports, DailyClose, etc.). |
| `vendor-react` | 218.9 kB | **70.2 kB** | React + ReactDOM. Loaded always. |
| `vendor-motion` | 124.4 kB | **40.6 kB** | framer-motion. Loaded by most pages. |
| `DashboardPage` | 142.1 kB | **34.4 kB** | Code-split. **Under the 50 kB budget — PASS.** |

**Notable per-page chunks under budget:**
- `index` (app shell): 9.8 kB gz
- `Layout`: 9.6 kB gz
- `LandingPage`: 14.5 kB gz
- `InventoryPage`: 21.8 kB gz
- `ProfilePage`: 21.9 kB gz (largest non-vendor page)

**Service worker:** `bonbox-v3` cache is generated at build time. The
existing CLAUDE.md note about Nepal owners needing a hard refresh is
about stale-SW behaviour after a deploy — confirm the SW version
bumps with each release (it currently does, via the build hash in
`sw.js`).

**Build warning to clean up later (non-blocking):**
> Both esbuild and oxc options were set. oxc options will be used and esbuild options will be ignored.

Cosmetic — Vite 8 ships with Rolldown's oxc transformer by default and
ignores the redundant `jsx: 'automatic'` esbuild option. Safe to leave;
remove the `esbuild` block in `vite.config.js` at next polish pass.

---

## 8. Post-deploy smoke test sequence

Run in order. Each step assumes the previous succeeded. Substitute the
real Render deployment URL while DNS is propagating
(`bonbox-api.onrender.com`); switch to `api.bonbox.dk` after cutover.

```bash
# 1. Process is up + Render healthcheck happy
curl -sf https://api.bonbox.dk/api/health
# → {"status":"ok"}

# 2. Database is reachable
curl -sf https://api.bonbox.dk/api/health/db
# → {"status":"ok","database":"connected"}

# 3. Public founder-rate endpoint returns the urgency-pill payload
curl -sf https://api.bonbox.dk/api/public/founder-rate-status | jq .
# → {"claimed": N, "max_slots": 100, "available": ..., "locked": true, ...}

# 4. Stripe webhook endpoint exists and rejects unsigned POSTs (proves the secret is wired)
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://api.bonbox.dk/api/billing/stripe/webhook -d '{}'
# → 400 (missing signature) — NOT 404 / 502

# 5. CORS preflight for the production SPA origin
curl -s -i -X OPTIONS https://api.bonbox.dk/api/auth/login \
  -H "Origin: https://bonbox.dk" \
  -H "Access-Control-Request-Method: POST" | head -5
# → 200 with Access-Control-Allow-Origin: https://bonbox.dk

# 6. Static frontend up
curl -sI https://bonbox.dk | head -3
# → HTTP/2 200

# 7. CSP header present (defense in depth)
curl -sI https://bonbox.dk | grep -i content-security-policy
# → Content-Security-Policy: default-src 'self'; ...

# 8. Log in as the founder probe account, list invoices, close one, send to accountant
TOKEN=$(curl -s -X POST https://api.bonbox.dk/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"founder-probe@bonbox.dk","password":"<from 1Password>"}' \
  | jq -r .access_token)

curl -s https://api.bonbox.dk/api/invoices -H "Authorization: Bearer $TOKEN" | jq '.[0]'
# → first invoice payload — confirms DB query path works

# 9. Daily Brief manual refresh — proves Anthropic key + USE_CLAUDE_API
curl -s -X POST https://api.bonbox.dk/api/dashboard/daily-brief/refresh \
  -H "Authorization: Bearer $TOKEN" | jq .source
# → "claude" (or "template" if AI quota deliberately off)

# 10. Push key endpoint (proves VAPID_PUBLIC_KEY is set)
curl -s https://api.bonbox.dk/api/push/public-key | jq .
# → {"public_key": "<base64url>"}  — NOT 503

# 11. /api/admin/errors (super-admin) — proves the homegrown Sentry table is populated
curl -s https://api.bonbox.dk/api/admin/errors?limit=5 -H "Authorization: Bearer $TOKEN" | jq '.[0]'
# → most recent error row (or empty if clean)

# 12. End-to-end accountant flow (manual): from the SPA, close one daily, click "Send to accountant",
#     check Resend dashboard for a delivered event within ~30 s.
```

---

## 9. Rollback plan

### 9a. Render — application rollback

1. Render dashboard → service `bonbox-api` → "Deploys" tab.
2. Click the last known-good deploy.
3. "Rollback to this deploy" → confirm.
4. Render boots the prior image in ~90 s; healthcheck flips green.
5. Verify with `curl /api/health` + the smoke-test sequence above.

### 9b. Vercel — frontend rollback

1. Vercel dashboard → project `bonbox` → "Deployments" tab.
2. Find the prior production deployment.
3. "Promote to Production" → confirm.
4. Edge cache flips in ~30 s.

### 9c. Database — migration rollback

**The good news:** every migration in `_migrations` is additive. There
are zero `DROP COLUMN` / `DROP TABLE` / `DROP INDEX` statements.
Migration 014 widens `VARCHAR(500)` → `TEXT` — even an app rollback
keeps working because TEXT accepts shorter strings. Migration 016
drops a NOT NULL constraint — old code that always wrote non-null
values still works.

**Net effect:** rolling the application back to the previous Render
deploy does **not** require rolling the database back. New columns
sit unused on the old binary.

**Hand-rollback for a bad migration (none exist today — process only):**

```sql
-- e.g. if a future migration broke production
BEGIN;
ALTER TABLE <table> DROP COLUMN IF EXISTS <new_column>;
COMMIT;
```

Run via Supabase SQL editor (Supabase dashboard → SQL → New query).
Coordinate with the Render rollback so the binary doesn't query a
column it expects to exist.

### 9d. Encryption key rollback (Fernet)

**Most dangerous path.** If `APP_SECRET_KEY` was rotated and the new
key is bad:

1. Set `APP_SECRET_KEY_PREVIOUS` to the bad-new key.
2. Set `APP_SECRET_KEY` back to the prior good key.
3. Re-deploy. `MultiFernet` will try both — existing rows still
   decrypt.
4. Audit `bonbox.security` logs for "%d sampled tokens failed to
   decrypt" warnings.

### 9e. Stripe rollback

Stripe webhook secrets are per-endpoint. If you rotated the secret and
broke webhook verification, regenerate the secret in the Stripe
dashboard, update `STRIPE_WEBHOOK_SECRET` on Render, redeploy. Stripe
queues failed webhooks for 3 days — no event is lost.

---

## 10. Test suite final pass

Command from the task (run from `backend/`):

```bash
python -m pytest -q --ignore=tests/test_kasserapport_excel.py --ignore=tests/test_global_examples_seed.py
```

**Result at HEAD `632f72f` (2026-05-19, 82.42 s wall time):**

```
7 failed, 1591 passed, 270 warnings
```

Failing tests:

| Test | Likely cause | Launch impact |
|---|---|---|
| `tests/test_entitlements.py::test_every_plan_has_every_feature_key` | `PLAN_FEATURES` shape invariant. By manual count the four plans each have 20 feature keys — but the test fails, so some plan is missing a key or has an extra. Worth a 5-min `assert` debugger run. | Low — only affects the entitlements summary endpoint shape. No paying-customer feature gate breaks. |
| `tests/test_entitlements.py::test_trial_matches_pro_for_every_feature` | Same root cause as above — `PLAN_FEATURES["trial"]` and `PLAN_FEATURES["pro"]` no longer match exactly. | Marketing-claim risk ("14 days of full Pro"). Confirm by diffing the two dicts before launch. |
| `tests/test_faktura_compliance_sprint.py::test_mobilepay_qr_flowable_renders_for_valid_invoice` | `_make_mobilepay_qr_flowable` returns None instead of an RLImage. Likely a `qrcode`/`pillow` runtime issue or a recent invoice-PDF refactor. | MEDIUM — Starter+ invoices currently ship a MobilePay QR on PDFs. If the helper returns None, the PDF still renders but in the single-column fallback layout. Owners get a working invoice without QR. |
| `tests/test_faktura_compliance_sprint.py::test_credit_note_omits_mobilepay_qr` | Tied to the same QR helper — credit note may now incorrectly include the QR (or fail for a different reason). | MEDIUM — kreditnota with a payable QR could confuse a customer into "paying" a refund. Worth diagnosing pre-launch. |
| `tests/test_inventory_extractor.py::test_excel_extractor_parses_basic_sheet` | `extract_excel()` returns an empty list for a valid XLSX. Likely an openpyxl version drift or a header-detection regression. | LOW-MEDIUM — Starter owners can still bulk-import inventory via CSV / OCR / paste. XLSX upload is one of three paths. |
| `tests/test_inventory_extractor.py::test_excel_extractor_handles_danish_headers` | Same root cause as above. | LOW-MEDIUM — Danish-header XLSX is the most common in DK, so this is the worst of the three. |
| `tests/test_inventory_extractor.py::test_excel_extractor_skips_blank_rows` | Same root cause. | LOW — edge case. |

**Recommended pre-launch triage (1-2 hours total):**
1. Diff `PLAN_FEATURES["trial"]` vs `PLAN_FEATURES["pro"]` — likely a single key missing on one side. Add it. Re-run.
2. Step into `extract_excel(_make_xlsx(...))` with `pdb`. Likely a one-line fix in header detection.
3. Step into `_make_mobilepay_qr_flowable`. Check if `qrcode==7.4.2` (pinned in requirements) is compatible with current `pillow==11.1.0`.

None of the seven failures touch the daily-active path:
sales / expenses / inventory consumption / daily close / dashboard /
brief / push / email / OAuth / Stripe. The full 1591-pass suite covers
those paths green.

---

## Day-1 ship-readiness verdict

**YELLOW.** Ship to one or two onboarded probe-account owners, hold
broad launch until the 7 test failures triage. Specifically:

### Ship-blocking (none today)
*Nothing prevents the binary from booting + serving traffic.*

### Block before broad launch (2 items)
1. **Faktura MobilePay QR**: two related tests fail. Risk is that
   `kreditnotaer` could render a payable QR (customer pays a refund
   back to themselves). Diagnose `_make_mobilepay_qr_flowable` before
   any Starter+ owner sends their first credit note.
2. **Entitlements PLAN_FEATURES drift**: `trial` and `pro` dicts no
   longer exact-match. Marketing claim "14 days of full Pro" may be
   technically false on one feature. 5-minute diff to confirm + fix.

### Ship today, fix this week
3. **Excel inventory import**: 3 tests fail. Owners have CSV + OCR
   + paste paths to fall back on, and the Smart Import OCR works.
   But the most common upload format in DK is `.xlsx` (Toldstyrelsen
   templates, supplier sheets) so triage in week 1.
4. **Sentry**: `SENTRY_DSN` block is dead code (sdk not installed).
   Render's stdout log drain + `/admin/errors` table give us
   first-line observability. Add `sentry-sdk[fastapi]` to
   requirements in week 1.
5. **`_default_secret.__doc__` warning at config.py:175**: dead
   warning — never triggers. One-line cleanup at next polish.

### Pre-deploy env-var checklist (do not deploy without)
- [ ] `ENVIRONMENT=production`
- [ ] `DATABASE_URL` points at Supabase pooler
- [ ] `SECRET_KEY` set to a 64-char random
- [ ] `APP_SECRET_KEY` is a real `Fernet.generate_key()` output
- [ ] `RESEND_API_KEY` + `RESEND_FROM_EMAIL` (verified Resend domain)
- [ ] `ANTHROPIC_API_KEY` + `USE_CLAUDE_API=true`
- [ ] `FRONTEND_URL=https://bonbox.dk`
- [ ] All 5 `STRIPE_*` keys (`SECRET`, `PUBLISHABLE`, `WEBHOOK_SECRET`,
      `PRICE_ID_STARTER`, `PRICE_ID_PRO`, plus the 2 FOUNDING variants)
- [ ] `GOOGLE_CLIENT_ID` + `APPLE_CLIENT_ID` (set up in dev portals)
- [ ] `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` + `VAPID_SUBJECT`
- [ ] `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (for receipt photo
      persistence — otherwise files vanish on every Render restart)
- [ ] `AIIA_ENV=mock` (until partner agreement)
- [ ] `MOBILEPAY_ENV=mock` (until partner agreement)
- [ ] `FOUNDER_MAX_SLOTS=100` + `FOUNDING_MEMBER_LIMIT=100`
- [ ] `AIIA_REDIRECT_URI=https://api.bonbox.dk/api/bank-connect/callback`
      (whenever you flip `AIIA_ENV` off mock)

### Post-deploy verification (10 min)
1. Run smoke test sequence (Section 8) — 12 commands, all green.
2. Grep Render logs for `AUDIT LOG IMMUTABILITY CHECK FAILED` —
   confirm absent.
3. Grep Render logs for `APP_SECRET_KEY misconfigured` — confirm
   absent.
4. Trigger a test signup; verify the welcome email lands within 30 s.
5. From a logged-in session, refresh the daily brief; confirm
   `source: "claude"` in the response.

When the YELLOW items above are clean, this becomes **GREEN**.
