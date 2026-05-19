# Aiia (Mastercard Open Banking) Integration Spec

> **Status:** Draft for implementation
> **Author:** Design pass — May 2026
> **Owner:** Manoj
> **Implements:** Real-time bank feed → existing reconciliation engine
> **Replaces:** CSV upload friction on `/bank-import`

---

## 1. Decision summary

**Recommendation: use Aiia Data (Mastercard Open Banking Europe — unlicensed product).**

| Criterion | Aiia Data | Tink | Salt Edge |
|---|---|---|---|
| Their PSD2 licence covers us (no FSA auth needed) | ✅ "no licence required" | ✅ | ✅ |
| Danish bank coverage | ✅ DK-native | ⚠️ Sweden-first | ⚠️ broad EU, thinner DK |
| Self-serve sandbox, no business verification | ✅ | ⚠️ sales contact | ✅ |
| Webhooks (Event Notifications) | ✅ | ✅ | ✅ |
| Pricing transparency | ❌ | ❌ | ❌ |
| Stable owner | ✅ Mastercard | ⚠️ Visa | ⚠️ smaller |

All three are functionally equivalent for read-only AIS. **Aiia wins on** Copenhagen ops (DA-speaking support), an explicit unlicensed product so we never need our own TPP authorisation, and Mastercard backing post-2022.

**Caveat we can't verify without sandbox access:** public sources suggest **Nordea may not be in Aiia's coverage** (~20% of DK SMBs). Day-1 sandbox check; if confirmed, ship with "Nordea coming soon — use CSV" copy. Pricing is opaque — assume ~5–20 DKK/connection/month + per-txn øre fees until quoted. If the real number is > 30 DKK, Starter margin gets thin and we may need Pro-only gating.

---

## 2. Architecture

```mermaid
sequenceDiagram
    Owner->>Frontend: Click "Connect bank"
    Frontend->>Backend: POST /bank-connect/init
    Backend->>Aiia: Create user, get Connect URL
    Backend-->>Frontend: connect_url + signed state
    Frontend->>Aiia: Redirect (SCA / NemID at bank)
    Aiia-->>Backend: GET /callback?code=…&state=…
    Backend->>Aiia: Exchange code → access+refresh tokens
    Backend->>DB: Insert bank_connections (refresh_token_enc)
    Backend-->>Frontend: Redirect /bank-import?connected=1

    loop Nightly cron 03:00 CET
        Backend->>Aiia: Refresh access token
        Backend->>Aiia: GET /accounts/{id}/transactions
        Backend->>DB: Insert Sale/Expense (reference_id='bank_<slug>_<txn>')
        Backend->>Backend: bank_reconciliation.match_transactions()
        Backend->>DB: Auto-confirm HIGH+CVR; queue rest as suggestions
    end
```

Webhook path (v0.2+): Aiia Event Notifications hits `POST /bank-connect/webhook` on new transactions; nightly cron stays as safety net.

---

## 3. Database changes

All migrations follow the project convention: append `ALTER TABLE … IF NOT EXISTS` (or `CREATE TABLE IF NOT EXISTS`) entries to `_migrations` in `backend/app/main.py`. No Alembic.

### 3.1 New table: `bank_connections`

```sql
CREATE TABLE IF NOT EXISTS bank_connections (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id),
  provider        VARCHAR(20) NOT NULL DEFAULT 'aiia',
  aiia_consent_id VARCHAR(100) NOT NULL,           -- Aiia's identifier for the consent
  aiia_account_id VARCHAR(100) NOT NULL,           -- one row per linked account
  bank_slug       VARCHAR(60) NOT NULL,            -- 'danske_bank', 'jyske', 'lunar', …
  account_label   VARCHAR(120) NOT NULL DEFAULT '',-- "Erhverv driftskonto" etc.
  iban_last4      VARCHAR(8),                      -- never store full IBAN
  currency        VARCHAR(3) NOT NULL DEFAULT 'DKK',
  status          VARCHAR(20) NOT NULL DEFAULT 'active',  -- active|expired|revoked|error
  refresh_token_enc BYTEA NOT NULL,                -- Fernet-encrypted refresh token
  access_token_enc  BYTEA,                         -- short-lived; cache between syncs
  access_token_expires_at TIMESTAMP,
  consent_expires_at TIMESTAMP NOT NULL,           -- ~90d under DK SCA
  last_synced_at  TIMESTAMP,
  last_sync_error TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (user_id, aiia_account_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_connections_user ON bank_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_bank_connections_consent_expires ON bank_connections(consent_expires_at);
```

### 3.2 `bank_transactions` — deliberately **not** adding a new table

The existing reconciliation engine in `bank_reconciliation.py` reads `Sale` + `Expense` rows where `reference_id LIKE 'bank_%'`. Aiia plugs in by inserting `Sale` (credits) and `Expense` (debits) rows with `reference_id='bank_<bank_slug>_<aiia_txn_id>'`. Existing dedup handles idempotency. Net: zero engine changes.

### 3.3 Audit log integration

Reuse `audit_service.record(...)`. New action verbs:

- `bank_connect.consent_granted` — entity_type `bank_connection`
- `bank_connect.consent_revoked` — manual disconnect
- `bank_connect.consent_expired` — cron job sets status='expired'
- `bank_connect.sync_completed` — actor_type='system.cron', count + duration in `after`
- `bank_connect.sync_failed` — error captured in `after.error`

These flow into the existing append-only `audit_logs` table for Bogføringsloven §9.

---

## 4. Backend routes

All under `/api/bank-connect` prefix in a new router `backend/app/routers/bank_connect.py`. Every route requires `get_current_user` and the listed routes also require `enforce_feature(user, "bank_auto_reconcile")` (Starter+).

| Route | Auth | Tier | Description |
|---|---|---|---|
| `POST /bank-connect/init` | ✅ | Starter+ | Body: `{redirect_after?: string}`. Calls Aiia "Create user" + "Get Connect URL". Returns `{connect_url, state}` where `state` is a signed JWT bound to user_id, expires 10 min. |
| `GET /bank-connect/callback?code=…&state=…` | public (state validates) | — | Aiia redirects here. Validates state, exchanges code → access + refresh tokens, calls Aiia `/accounts` to enumerate linked accounts, inserts one `bank_connections` row per account, redirects back to frontend `/bank-import?connected=1`. |
| `GET /bank-connections` | ✅ | Starter+ | Lists current user's bank_connections (no token fields exposed). |
| `DELETE /bank-connections/{id}` | ✅ | Starter+ | Calls Aiia "Delete user" or revoke endpoint, marks status='revoked'. Writes audit. |
| `POST /bank-connect/{id}/sync` | ✅ | Starter+ | Manual sync trigger. Same code path the cron uses. Rate-limit: 1/min per connection. |
| `POST /bank-connect/{id}/reconnect` | ✅ | Starter+ | When consent expires. Returns a fresh Connect URL bound to the existing `bank_connections.id` so we keep the same row + history. |
| `POST /bank-connect/webhook` | HMAC-signature | — | Aiia Event Notifications. Validates signature header, enqueues a sync job for the affected consent. **v0.2+.** |

Service layer split:

- `services/aiia_client.py` — thin HTTP wrapper. Env: `AIIA_CLIENT_ID` / `AIIA_CLIENT_SECRET` / `AIIA_BASE_URL`. One method per Aiia endpoint we touch.
- `services/bank_connect_service.py` — orchestration (init, callback, sync, txn→Sale/Expense mapping).
- `services/token_crypto.py` — Fernet wrapper. Env: `BONBOX_TOKEN_ENCRYPTION_KEY` (32-byte url-safe base64). Tokens never cross the API boundary.

---

## 5. Daily cron job

Reuse cron-job.org. New endpoint `/api/internal/bank-sync-tick`, authed via `X-Cron-Secret` header.

**Schedule:** 03:00 CET nightly. Selects `bank_connections WHERE status='active' AND (last_synced_at IS NULL OR last_synced_at < now() - interval '20h')`. Capped at 200 connections per tick (Render free runtime safety).

Per connection:

1. Decrypt refresh token → fresh access token via Aiia.
2. `GET /accounts/{aiia_account_id}/transactions?bookedFrom=<last_synced_at - 7d>`. The 7-day overlap catches late-clearing txns; `reference_id` dedup handles duplicates.
3. Credits → `Sale` (`payment_method='bank_transfer'`). Debits → `Expense` (category via existing `suggest_category_for`). `reference_id='bank_<bank_slug>_<aiia_txn_id>'`. Skip if already present.
4. Call `bank_reconciliation.match_transactions(db, user_id, import_id='aiia_<conn.id>')` to generate suggestions.
5. **Auto-confirm:** suggestions with `confidence='high'` AND `amount_diff <= 0.01` AND CVR-or-fakturanummer text signal → `bank_reconciliation.confirm_matches([...])` with `actor_type='system.cron'`. Everything else waits for owner review.
6. Update `last_synced_at`. On `401` post-refresh → mark `status='expired'`, write audit, send one expiry email (guarded). On 5xx → record `last_sync_error`, retry next tick.

---

## 6. Frontend changes

**`/bank-import` page restructure** (URL stays for backwards compat):

1. **"Connect a bank" CTA card** — primary. Calls `POST /bank-connect/init`, redirects to Aiia Connect URL.
2. **Active connections list** — bank logo, account label, relative `last_synced_at`, status pill (green active / amber expiring / red expired), Sync-now button, overflow menu with Disconnect.
3. **CSV upload (collapsed accordion)** — fallback for free tier and unsupported banks.
4. **Reconciliation suggestions** — unchanged; cron passes `import_id='aiia_<conn.id>'` into the existing `/api/bank-import/{import_id}/suggestions` endpoint.

**Settings → Bank connections** — same list, plus consent expiry countdown and "Renew consent" button at T-14d.

**Re-consent flow:** when `status='expired'`, dashboard banner "Your [bank] connection needs renewal — [Renew now]". Calls `POST /bank-connect/{id}/reconnect`, reuses the same row with a fresh refresh token + new `consent_expires_at`.

**i18n keys** under `frontend/src/hooks/useLanguage.jsx`: `bankConnect.cta`, `.synced`, `.expiring`, `.expired`, `.disconnect`, `.renew`, `.noBanks`. EN + DA priority; NP can defer.

---

## 7. Security & privacy

| Concern | Plan |
|---|---|
| Refresh token storage | Fernet (symmetric) at the app layer. Key in `BONBOX_TOKEN_ENCRYPTION_KEY` env var. `cryptography` already transitively present via `python-jose[cryptography]`. `key_version` column on `bank_connections` allows multi-key decryption during rotation. |
| Access tokens | Encrypted the same way but treated as cache — refresh on miss. Never logged. |
| GDPR data stored | IBAN last 4 only, bank_slug, account label, transaction lines (date / amount / description / counterparty). No address. Keyed by `user_id` so account-deletion cascade already covers it. |
| Retention | Transactions kept for 5y (Bogføringsloven). `bank_connections` row hard-deleted on disconnect; audit row persists. |
| SCA / re-consent | DK SCA forces re-consent every 90d. Track `consent_expires_at`, email at T-14d / T-3d / T-0. One-click re-consent. |
| TPP licensing | **Aiia Data (unlicensed flavour)** — Mastercard's licence covers us. **Risk:** PIS would require Aiia Enterprise + our own FSA auth; out of scope. |
| Audit trail | Every connect / disconnect / expiry / sync → `audit_logs` (§3.3). |
| Webhook signature | Validate `X-Aiia-Signature` HMAC against `AIIA_WEBHOOK_SECRET`. Reject on mismatch. |
| Tenant isolation | All routes filter by `user_id`. Callback validates signed `state` JWT bound to the initiating user. |
| Tier gating | `enforce_feature(user, "bank_auto_reconcile")` on every route except the public callback. |

---

## 8. Risks & open questions

1. **Opaque pricing.** Sandbox is free; production needs a sales call. Cannot announce GA until we have a written quote. Re-tier if > 30 DKK/connection/month.
2. **Nordea coverage gap.** Day-1 sandbox confirmation; if missing, copy says "Nordea coming soon" + CSV fallback. Tink-for-Nordea is a possible v1.x patch.
3. **Render free-tier cold starts** may time out the OAuth callback. Almost certainly need the $7/mo Starter plan before public launch.
4. **Webhook reliability on free Render** — not in v0.1. Poll-only until we have a paid plan.
5. **Docs accessibility** — couldn't fetch per-endpoint detail pages on `developer.mastercard.com` from this research env. Day-1 task: pull the Postman collection from `github.com/Mastercard/open-banking-eu-postman-collections` as source of truth.
6. **Bankdata-shared banks** (Spar Nord, Arbejdernes Landsbank, Vestjysk) — share a backend. Unclear if Aiia exposes them as one connector or many. Affects bank-picker copy.
7. **No existing app-level encryption** in the codebase — the Fernet wrapper is a new primitive; needs unit tests around key rotation.
8. **Auto-confirm risk.** A wrong HIGH+CVR auto-confirm forces the owner to un-pay an invoice. Gate behind a per-user toggle that defaults OFF for the first 30 days post-connect.

---

## 9. Effort estimate

| Phase | Working hours |
|---|---|
| Sandbox onboarding, Postman exploration, OAuth flow PoC (one bank, hardcoded user) | 6 h |
| `aiia_client.py` + `token_crypto.py` (Fernet wrapper, env wiring, tests) | 5 h |
| `bank_connections` migration + model + audit verbs | 2 h |
| Routes: init / callback / list / delete / manual sync | 6 h |
| Cron tick + reconciliation wiring + auto-confirm gate | 6 h |
| Frontend: Connect CTA, connections list, re-consent banner, i18n | 8 h |
| Real-bank smoke test (Manoj's own account, end-to-end) | 3 h |
| Webhook receiver + signature validation (v0.2) | 4 h |
| Production credentials + sales call + go-live checklist | 2 h |
| Polish, monitoring, error pages | 3 h |
| **Total v0.1 + v0.2 (sandbox-complete + multi-bank + cron)** | **~45 h** |
| **v1.0 polish + webhook + monitoring** | **+10 h** |

Realistic: **one dedicated working week for v0.1, second week for v0.2.** v1.0 polish slots into a third week alongside other work.

---

## 10. Phase plan

**v0.1 — sandbox proof.** Aiia sandbox creds; one (test) bank; init/callback/sync/list routes; manual sync only; no cron; no webhook. Behind feature flag `bank_connect_enabled=false` in prod — internal dogfood only.

**v0.2 — multi-bank + cron + production.** All Aiia-supported DK banks live; nightly cron; auto-confirm for HIGH+CVR (per-user toggle, default OFF for first 30d); re-consent flow with T-14d/3d/0d emails; audit verbs firing; flag flipped on for Starter+.

**v1.0 — webhook + polish.** Event Notifications webhook (cron as safety net); Settings → Integrations; dashboard expiry banner; Sentry alerts on consent expiry waves and sync error spikes; runbook in `docs/runbooks/bank-connect-troubleshooting.md`; CSV demoted to "Advanced" accordion.

---

## Sources

- [Aiia — Mastercard product page](https://developer.mastercard.com/product/aiia)
- [Aiia Data (unlicensed) docs index](https://developer.mastercard.com/open-banking-europe/documentation/unlicensed/aiia-data/)
- [Aiia Enterprise (licensed) docs index](https://developer.mastercard.com/open-banking-europe/documentation/licensed/aiia-enterprise/)
- [Aiia Event Notifications (Webhooks)](https://developer.mastercard.com/open-finance-europe/documentation/unlicensed/aiia-data/event-notifications/)
- [Aiia token refresh flow](https://developer.mastercard.com/open-banking-europe/documentation/unlicensed/aiia-pay/connect/refreshing/)
- [Aiia Postman collections (GitHub)](https://github.com/Mastercard/open-banking-eu-postman-collections)
- [Aiia FAQ — unlicensed](https://developer.mastercard.com/open-banking-europe/documentation/unlicensed/aiia-data/faq/)
- [EBA Q&A on 90-day SCA re-consent](https://www.eba.europa.eu/single-rule-book-qa/qna/view/publicId/2018_4177)
- [Open Banking Tracker — Denmark coverage](https://www.openbankingtracker.com/country/denmark)
- [Aiia main marketing page](https://www.aiia.eu/)

**Could not directly fetch:** the per-endpoint reference pages on `developer.mastercard.com` (WebFetch was denied in the research environment). Implementer should pull the Postman collection above on day 1 and treat it as the source of truth for request/response shapes.
