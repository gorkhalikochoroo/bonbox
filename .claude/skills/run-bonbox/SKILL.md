---
name: run-bonbox
description: Build, launch, drive, screenshot, and smoke-test the BonBox app (Vite React frontend + FastAPI backend). Use when asked to run/start/serve BonBox locally, take a screenshot of a screen, reproduce a UI or API flow, or verify the app boots from a clean database.
---

# Run BonBox

BonBox is a full-stack app: a **Vite + React** SPA in `frontend/` and a
**FastAPI** backend in `backend/`. It's driven headlessly by
`.claude/skills/run-bonbox/driver.mjs`, which boots the backend against a
**throwaway sqlite** (schema auto-creates on startup — ~99 tables), boots the
frontend, registers + email-verifies a demo owner through the real API, and
smoke-tests the endpoints this repo's PRs touch (reservations, day-rail
month-load, billing entitlements, staff). For the visual layer, run it in `up`
mode and open the app in the **Browser pane** (there is no Playwright/chromium
installed — the pane is the screenshot mechanism).

All paths below are relative to the repo root (`<unit>/`). Backend on **8000**,
frontend on **5173** — the frontend hardcodes `http://localhost:8000/api` as its
dev API base, so those ports must match for the browser flow to work.

## Prerequisites

Node 22, Python 3.12+ (repo ships a `backend/venv`). On this machine deps were
already installed; the from-scratch setup is:

```bash
npm install --prefix frontend
```

```bash
cd backend && python3 -m venv venv && venv/bin/pip install -r requirements.txt
```

(The `venv` already existed here; re-running the `pip install` completed a
partial env — it pulled in `mindee`, `stripe`, `pypdfium2`, `h2`, `sentry-sdk`.)

## Run — agent path (this is the one to use)

Boot everything, verify the API, tear down — one command, exits 0/1:

```bash
node .claude/skills/run-bonbox/driver.mjs smoke
```

Leave it running to drive the UI (registers a demo owner, prints its login):

```bash
node .claude/skills/run-bonbox/driver.mjs up
```

`up` prints `demo owner: <email> / RunSkill123!` and holds on `Ctrl-C`. Then in
the **Browser pane**: `preview_start {"url":"http://localhost:5173/login"}`,
type those credentials into the email/password fields, click **Sign In** — a
fresh owner lands on `/onboarding`. Screenshot with the pane's `computer`
`{"action":"screenshot"}`. (This session drove exactly that flow and captured
"Welcome to BonBox" from a clean DB.)

Env knobs: `BONBOX_API_PORT` / `BONBOX_WEB_PORT` to move ports, `BONBOX_VERBOSE=1`
to stream backend/frontend logs.

## Run — human path

Two terminals, real dev servers (backend `--reload`, seeded against your own
`smallbiz.db`, not a throwaway):

```bash
cd backend && venv/bin/uvicorn app.main:app --reload --port 8000
```

```bash
npm run dev --prefix frontend
```

Open `http://localhost:5173`. Useless headless — it just spawns servers and
waits; use the driver instead.

## Test

The suite ran all session under the repo's `python` (conda 3.12), which carries
the extra `pypdf` the PDF-export tests import:

```bash
cd backend && python -m pytest tests/ -q
```

Full suite is ~3000 tests / ~4 min. Scope with `-k`, e.g.
`python -m pytest tests/test_reservation_month_load.py -q`.

## Gotchas

- **Ports are load-bearing.** The frontend's dev API base is a hardcoded
  `http://localhost:8000/api` (`frontend/src/services/api.js`). Run the backend
  anywhere but 8000 and the UI silently talks to nothing. The driver keeps them
  aligned; only override both ports together.
- **`backend/venv` is Python 3.13 and can be a *partial* install.** It ran the
  app fine (missing `pypdf`, `mindee`, etc. only bite lazily), so a green boot
  doesn't mean a complete env. Run the `pip install -r requirements.txt` above
  before trusting PDF export or OCR paths. `pypdf` is used by the range-export
  **tests** but is NOT in `requirements.txt` — the test suite passes under the
  conda `python`, which happens to have it.
- **Fresh signups hit a `/verify-email` wall.** A registered owner is
  `email_verified=false`, and dev sends no mail, so the app parks you there
  forever. The driver flips the flag directly in its throwaway DB (via
  `python3` + sqlite) right after registering — that's why its owner reaches
  `/onboarding`. If you register by hand, you must set `email_verified=1`
  yourself.
- **`.test`/`.example` emails are rejected at register** (`EmailStr` +
  reserved-TLD + MX check). The driver uses `…@gmail.com`, which is on the app's
  mail-domain whitelist so the MX lookup is skipped (works with no network).
- **Backend startup logs look alarming but aren't.** `crypto: APP_SECRET_KEY is
  not a Fernet-formatted key…` and a wall of `Schedulers started:` lines are
  normal — the app derives a key via SHA-256 and boots. Health is green in ~2–4s.
- **The Browser pane is the only screenshot path here.** No Playwright, no
  chromium-cli. `preview_start {"url": …}` opens a tab; `computer` screenshots
  it. A future agent without the pane can still use the `smoke` driver for
  headless API verification.

## Troubleshooting

- `register -> 422 … special-use or reserved name` → email domain not
  whitelisted / not real. Use `@gmail.com` (what the driver does).
- `frontend` never ready / `EADDRINUSE` → port 8000 or 5173 already held. Free
  them: `lsof -ti tcp:8000 tcp:5173 | xargs kill -9`, then re-run.
- Backend exits early right after launch → re-run with `BONBOX_VERBOSE=1` to see
  the stack; most often a missing dep (run the `pip install`) or port clash.
- Login lands on `/verify-email` → the owner wasn't verified; see the gotcha.
  Re-run the driver (it verifies its own owner) rather than reusing a
  hand-made account.
