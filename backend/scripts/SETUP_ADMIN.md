# How to enable Admin access (3 steps)

After this, you'll get a signup-notification email at your address every time
someone registers, AND you'll see the full Platform Admin dashboard at `/admin`
when you log into BonBox.

## Step 1 — Set 2 environment variables in Render

Open https://dashboard.render.com → your `bonbox-api` service → **Environment**.

Add (or update) these two entries:

| Key                    | Value                  | What it does                                    |
| ---------------------- | ---------------------- | ----------------------------------------------- |
| `ADMIN_EMAIL`          | `gorkhalikochoroo@gmail.com`   | Receives "new signup" email on every register   |
| `SUPER_ADMIN_EMAILS`   | `gorkhalikochoroo@gmail.com`   | Allows access to `/api/admin/*` endpoints       |

> Multi-tenant: `SUPER_ADMIN_EMAILS` is a comma-separated list. If you ever add
> another admin (e.g. a co-founder), use `gorkhalikochoroo@gmail.com,otheremail@example.com`.

Click **Save Changes** — Render auto-redeploys.

## Step 2 — Promote your user in the database

The codebase intentionally has **no API endpoint** to grant `super_admin` role
(that would be a privilege-escalation surface). You set it via this one-time
script. Defense in depth — both env-var allowlist AND DB role must agree.

### From your laptop (against production DB)

1. Get the production DATABASE_URL from Render → Postgres → "External Database URL"
2. Run:
   ```bash
   cd backend
   DATABASE_URL='postgresql://...your-prod-url...' \
     python scripts/promote_admin.py gorkhalikochoroo@gmail.com
   ```
3. You'll see `✓ gorkhalikochoroo@gmail.com promoted: owner → super_admin`

### From the Render Shell (alternative — no copying secrets locally)

1. Render dashboard → `bonbox-api` → **Shell** tab
2. Run:
   ```bash
   python scripts/promote_admin.py gorkhalikochoroo@gmail.com
   ```
   (DATABASE_URL is already in the env, no need to set it)

> ⚠ You must REGISTER your account first via the normal /register UI before
> running this — the script only flips an existing user's role, it doesn't
> create users.

## Step 3 — Verify it worked

1. Log into BonBox with `gorkhalikochoroo@gmail.com`
2. Look at the sidebar: a new **Platform** group with a 🛡 icon should appear
3. Click **Platform Admin** → you should see the dashboard with:
   - Overview KPIs (total users, active users, new signups today)
   - All registered users (up to 100)
   - Per-user activity timeline (drill down into any user)
   - Feature usage (which pages get visited most)
   - Business-type & currency distribution
   - Retention (DAU/WAU/MAU)
   - Signups timeline (30-day chart)
   - Security events audit log

If the sidebar entry doesn't appear or the page is blank, that means one of
the 3 steps was skipped. The 7-layer guard returns 404 silently on any failure
(by design — doesn't leak which layer rejected you).

## What "see all activity" gets you

Once Step 3 works, you can see:

- **`/api/admin/overview`** — total users, active 7d, active 30d, signups today
- **`/api/admin/users?limit=100`** — every user with their last-seen, sale count, expense count, days active
- **`/api/admin/users/{user_id}/timeline`** — every page visit + action a specific user has taken (last 200 events)
- **`/api/admin/feature-usage?days=30`** — which features are used most
- **`/api/admin/signups-timeline?days=30`** — daily signup counts for a 30-day chart
- **`/api/admin/security-events?limit=30`** — recent admin-access attempts, suspicious activity, brute-force lockouts

All of these are surfaced in the Platform Admin page UI. Direct API hits also
work for ad-hoc queries.

## Why we set it up this way

- **Email allowlist** (Render env var) — only specified emails can reach `/admin`
- **Database role** (Postgres) — even with the right email, the DB must say so too
- **Constant-time email comparison** — no timing attacks
- **Generic 404** on every denial — attackers can't distinguish "wrong email" vs "wrong role"
- **Audit log** — every admin access attempt logged to `security_events` table
- **No API path to elevate** — the only way to grant `super_admin` is the script

If a single layer is bypassed (e.g., env var leaked), the other layers still
protect the platform. This is the multi-layer defense pattern Manoj asked for.

## Daily monitoring tip

After the new signup email lands in `gorkhalikochoroo@gmail.com`, click the link, log
into Platform Admin, and click on the new user's row to see exactly what
they're doing. Helpful for early-stage product feedback (which features get
opened first, where they get stuck).
