# MobilePay Business (Vipps MobilePay) Integration Spec

> **Status:** Draft for implementation
> **Author:** Design pass — May 2026
> **Owner:** Manoj
> **Implements:** Direct settlement feed from MobilePay → existing reconciliation engine
> **Pairs with:** [Aiia integration](./aiia-integration-spec.md) — Aiia = full bank, MobilePay = MobilePay-only detail

> **Verification note:** `developer.vippsmobilepay.com` was not reachable from the research environment. Endpoint names, OAuth shapes, and Settlement Reports API specifics below are inferred from (a) the documented post-2024 Vipps MobilePay merger, (b) standard merchant payment API patterns (Stripe, Adyen, Vipps pre-merger), and (c) the public eCom API products. The implementer **must** verify all endpoint shapes against the live docs on day 1 and adjust DB columns / payload parsers accordingly.

---

## 1. Decision summary

**Recommendation: YES, integrate — but as the *second* connector, after Aiia is live.**

| Criterion | Verdict |
|---|---|
| Share of café revenue routed via MobilePay | ✅ 30–50 % (the single biggest blind spot in BonBox today) |
| Owner pain today | ✅ Manual typing or copy-paste from the MobilePay app/CSV |
| Reconciliation value-add | ✅ Daily settlement granularity, MobilePay-only fee detail Aiia doesn't expose |
| Vendor stability | ✅ Vipps MobilePay merged 2022, fully unified 2024, Nordics' largest mobile wallet |
| Regulatory complexity for us | ✅ Low — MobilePay holds the PSD2 licence; we read settlements only, never card data |
| Time-to-value vs Aiia overlap | ⚠️ Aiia already imports MobilePay payouts as one bank line per day. MobilePay direct adds *per-transaction* detail and faster latency. |
| Onboarding friction | ❌ Production access requires a Sales / partner agreement — sandbox is self-serve, prod is not |

**Why second, not first.** Aiia gives the owner *all* their bank money (Dankort, invoices, salaries, MobilePay aggregate). MobilePay direct adds *granularity* on the MobilePay slice — useful for receipt-level matching, fee transparency, and faster than the T+1 bank payout. Aiia ships first because one connection covers everything; MobilePay is the high-value follow-on. They are complementary, not redundant. See §13.

**Hard caveat:** all MobilePay merchant APIs require a signed merchant agreement and partner approval before production keys are issued. Sandbox is open. Plan for a 2–6 week sales-cycle gap between v0.1 (sandbox-complete) and v0.2 (real merchant connected).

---

## 2. Architecture

```mermaid
sequenceDiagram
    Owner->>Frontend: Click "Connect MobilePay"
    Frontend->>Backend: POST /mobilepay/connect/init
    Backend->>MobilePay: Build merchant authorisation URL (state-bound)
    Backend-->>Frontend: consent_url
    Frontend->>MobilePay: Redirect (MitID Business sign-in)
    MobilePay-->>Backend: GET /mobilepay/connect/callback?code=…&state=…
    Backend->>MobilePay: Exchange code → access + refresh tokens, fetch merchant_id
    Backend->>DB: Insert mobilepay_connections (refresh_token_enc)
    Backend-->>Frontend: Redirect /bank-import?mobilepay_connected=1

    loop Nightly cron 03:30 CET (after Aiia)
        Backend->>MobilePay: Refresh access token
        Backend->>MobilePay: GET /report/v2/settlements?from=last_synced-7d
        loop per settlement
            Backend->>DB: Insert Sale (reference_id='bank_mobilepay_<settlement_id>')
            Backend->>DB: Insert Expense (fee, reference_id='bank_mobilepay_fee_<settlement_id>')
        end
        Backend->>Backend: bank_reconciliation.match_transactions(import_id='mobilepay')
        Backend->>DB: Auto-confirm HIGH+CVR matches; queue rest as suggestions
    end
```

**Webhook path (v1.0+):** If MobilePay's Reports/Settlement product exposes settlement-completed webhooks (Vipps eCom does for payments; Reports webhook availability TBC), subscribe and trigger the same sync code path. Nightly cron remains the safety net.

---

## 3. Database changes

Same convention as Aiia: append `CREATE TABLE IF NOT EXISTS` to `_migrations` in `backend/app/main.py`. No Alembic.

### 3.1 New table: `mobilepay_connections`

```sql
CREATE TABLE IF NOT EXISTS mobilepay_connections (
  id                    UUID PRIMARY KEY,
  user_id               UUID NOT NULL REFERENCES users(id),
  merchant_id           VARCHAR(64) NOT NULL,         -- MobilePay's merchant identifier
  merchant_name         VARCHAR(160) NOT NULL DEFAULT '',
  cvr                   VARCHAR(12),                  -- denormalised from MobilePay agreement
  currency              VARCHAR(3) NOT NULL DEFAULT 'DKK',
  status                VARCHAR(20) NOT NULL DEFAULT 'active', -- active|expired|revoked|error
  refresh_token_enc     BYTEA NOT NULL,               -- Fernet-encrypted refresh token
  access_token_enc      BYTEA,                        -- short-lived cache
  access_token_expires_at TIMESTAMP,
  consent_expires_at    TIMESTAMP,                    -- if MobilePay enforces a consent TTL; NULL = static API key
  last_synced_at        TIMESTAMP,
  last_settlement_id    VARCHAR(64),                  -- cursor for incremental polling
  last_sync_error       TEXT,
  key_version           SMALLINT NOT NULL DEFAULT 1,  -- token_crypto rotation
  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (user_id, merchant_id)
);
CREATE INDEX IF NOT EXISTS idx_mobilepay_connections_user
  ON mobilepay_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_mobilepay_connections_expires
  ON mobilepay_connections(consent_expires_at);
```

### 3.2 Settlements — extend `Sale` + `Expense`, **don't** add a new table

Same call we made for Aiia. The reconciliation engine in `bank_reconciliation.py` already reads any `Sale` / `Expense` row where `reference_id LIKE 'bank_%'`. MobilePay settlements plug straight in:

| Settlement field | Becomes | reference_id |
|---|---|---|
| Net amount (gross − fee), settlement date | `Sale` (payment_method='mobilepay') | `bank_mobilepay_<settlement_id>` |
| Fee | `Expense` (category='Payment fees') | `bank_mobilepay_fee_<settlement_id>` |
| Full JSON payload | `Sale.notes` (truncated) + `audit_logs.after` (full) | — |

**Tradeoff vs a dedicated `mobilepay_settlements` table:** a dedicated table preserves the raw provider payload forever in a typed form and isolates MobilePay-specific columns (e.g. `dispute_status`). Cost: every reconciliation read needs a UNION across `Sale`/`Expense`/`mobilepay_settlements`, and the matcher (`bank_reconciliation.py`) would need rewiring. **Decision:** reuse `Sale`/`Expense` with a `reference_id` namespace + store the raw payload in `audit_logs.after` for forensics. Zero engine changes. If MobilePay-specific reporting becomes a feature (e.g. fee dashboard), add a materialised view later.

### 3.3 Audit log integration

Reuse `audit_service.record(...)`. New action verbs:

- `mobilepay.consent_granted` — entity_type `mobilepay_connection`
- `mobilepay.consent_revoked` — manual disconnect, includes whether MobilePay-side revoke succeeded
- `mobilepay.consent_expired` — cron job sets status='expired'
- `mobilepay.sync_completed` — actor_type='system.cron', settlement count + DKK total in `after`
- `mobilepay.sync_failed` — error in `after.error`, MobilePay request_id if available
- `mobilepay.settlement_imported` — one row per imported settlement (entity_type='sale', entity_id=Sale.id)

Bogføringsloven §9 covered.

---

## 4. Backend routes

All under `/api/mobilepay` in a new router `backend/app/routers/mobilepay.py`. Every route except the callback requires `get_current_user` + `enforce_feature(user, "mobilepay_connect")` (Starter+, §8).

| Route | Auth | Tier | Description |
|---|---|---|---|
| `POST /mobilepay/connect/init` | ✅ | Starter+ | Body: `{redirect_after?: string}`. Builds the MobilePay merchant-auth URL with signed `state` JWT (10-min TTL, bound to user_id). Returns `{consent_url, state}`. |
| `GET /mobilepay/connect/callback?code=…&state=…` | public (state validates) | — | MobilePay redirects here. Validates state, exchanges `code` → access + refresh tokens, fetches `merchant_id` + display name, inserts `mobilepay_connections`. Redirects to `/bank-import?mobilepay_connected=1`. |
| `GET /mobilepay/connections` | ✅ | Starter+ | Lists current user's mobilepay_connections (no token fields exposed). |
| `DELETE /mobilepay/connections/{id}` | ✅ | Starter+ | Best-effort revoke against MobilePay, mark `status='revoked'`, write audit. Tokens zeroed. |
| `POST /mobilepay/connections/{id}/sync` | ✅ | Starter+ | Manual sync trigger (same code path as cron). Rate-limit: 1/min per connection. |
| `POST /mobilepay/connections/{id}/reconnect` | ✅ | Starter+ | Returns a fresh consent URL bound to the existing row so history persists across re-consents. |
| `POST /mobilepay/webhook` | HMAC signature | — | Reserved for v1.0. Verifies `X-MobilePay-Signature` against `MOBILEPAY_WEBHOOK_SECRET`. Enqueues a sync job. |

**Service-layer split** (mirrors the Aiia split for consistency):

- `services/mobilepay_client.py` — thin HTTP wrapper. Env: `MOBILEPAY_CLIENT_ID`, `MOBILEPAY_CLIENT_SECRET`, `MOBILEPAY_SUBSCRIPTION_KEY` (Azure APIM-style), `MOBILEPAY_BASE_URL`. One method per endpoint we touch (`exchange_code`, `refresh_token`, `get_settlements`, `revoke`).
- `services/mobilepay_service.py` — orchestration (init, callback, sync, settlement → Sale/Expense mapping).
- `services/token_crypto.py` — **reuse** the Fernet wrapper shipped with the Aiia integration. `key_version` column lets us decrypt across rotations.

---

## 5. Auth flow

```
Owner clicks "Connect MobilePay"
  → BonBox builds MobilePay merchant-authorisation URL
      ?client_id=<APP_ID>
      &redirect_uri=https://api.bonbox.dk/api/mobilepay/connect/callback
      &response_type=code
      &scope=settlements:read merchant:read
      &state=<signed-jwt-bound-to-user-id, 10min>
  → Owner signs in with MitID Business (MobilePay's hosted flow)
  → Owner reviews scopes ("BonBox wants to read your settlements and merchant info")
  → MobilePay redirects to /api/mobilepay/connect/callback?code=…&state=…
  → BonBox exchanges code → access_token (1h) + refresh_token (long-lived)
  → BonBox stores Fernet(refresh_token), merchant_id, merchant_name
  → Subsequent calls: refresh access token on-demand, never store it long-term
```

**Verification needed on day 1:** whether MobilePay uses standard OAuth 2.0 authorization-code with refresh tokens (assumed above), or a different pattern — e.g. partner-issued static API keys per merchant, or a pure subscription-key (APIM) model with no per-merchant token at all. If static keys, swap the consent UX for a "paste your MobilePay API key" form (worse UX but simpler integration). The DB shape supports both: `refresh_token_enc` can hold a static key, and `consent_expires_at` is nullable.

---

## 6. Daily cron job

Reuse cron-job.org. New endpoint `/api/internal/mobilepay-sync-tick`, authed via `X-Cron-Secret`.

**Schedule:** 03:30 CET nightly — 30 minutes *after* Aiia, so bank-side payout rows already exist and the matcher can dedupe a MobilePay settlement against the Aiia-imported aggregate payout (same date, same DKK total → keep the MobilePay one for granularity, soft-delete the Aiia one or annotate). See §13.

Selects `mobilepay_connections WHERE status='active' AND (last_synced_at IS NULL OR last_synced_at < now() - interval '20h')`. Capped at 200 connections per tick.

Per connection:

1. Decrypt refresh token → fresh access token.
2. `GET /report/v2/settlements?from=<last_synced_at - 7d>&to=<now>` (7-day overlap catches late settlements; `reference_id` dedup handles duplicates).
3. For each settlement:
   - Insert `Sale` for net amount, `payment_method='mobilepay'`, `reference_id='bank_mobilepay_<settlement_id>'`.
   - Insert `Expense` for fee, `category='Payment fees'`, `reference_id='bank_mobilepay_fee_<settlement_id>'`.
   - Skip if `reference_id` already present (idempotency).
4. `bank_reconciliation.match_transactions(db, user_id, import_id='mobilepay')` to generate suggestions.
5. Auto-confirm HIGH + (CVR or fakturanummer) signal AND amount_diff ≤ 0.01 via `bank_reconciliation.confirm_matches(..., actor_type='system.cron')`. Everything else waits for owner review. Same auto-confirm safety toggle as Aiia (default OFF for first 30 days post-connect).
6. Update `last_synced_at`, `last_settlement_id`. On 401 post-refresh → `status='expired'` + audit + one re-consent email (guarded). On 5xx → record `last_sync_error`, retry next tick with exponential backoff.

---

## 7. Frontend changes

**`/bank-import` page** (already restructured for Aiia in the Aiia spec):

1. "Connect a bank" Aiia card (existing).
2. **NEW "Connect MobilePay" CTA card** — placed beside or below the Aiia card. Calls `POST /mobilepay/connect/init`, redirects to MobilePay consent URL.
3. **Active connections list** — Aiia rows + MobilePay rows, distinguished by a provider icon (Aiia bank logo / MobilePay logo). Same status pill, Sync-now button, overflow menu.
4. CSV upload accordion (unchanged).

**Settings → Integrations** — a single page listing all external connections (Aiia, MobilePay, future Stripe). For MobilePay rows: merchant name, CVR, last sync, status, fee summary (last 30d total fees) as a small upsell to "see all fees".

**Re-consent flow** — same banner pattern as Aiia. `status='expired'` → "Your MobilePay connection needs renewal — [Renew now]". Calls `POST /mobilepay/connections/{id}/reconnect`.

**i18n** (`frontend/src/hooks/useLanguage.jsx`): `mobilepay.cta`, `.connected`, `.synced`, `.expired`, `.disconnect`, `.renew`, `.fees30d`. EN + DA priority; NP defer.

---

## 8. Tier gate

New feature flag `mobilepay_connect` added to `services/billing.py PLAN_FEATURES`:

| Plan | `mobilepay_connect` |
|---|---|
| free | False |
| starter | True |
| pro | True |
| trial | True (= full Pro) |

Identical pattern to `bank_auto_reconcile`. Free still types MobilePay sales manually (or uploads the MobilePay CSV via the existing bank-import flow). The auto-feed + reconciliation auto-match is the paid value.

`enforce_feature(user, "mobilepay_connect")` on every route except the public callback and the internal cron endpoint.

---

## 9. Security & privacy

| Concern | Plan |
|---|---|
| Refresh token storage | Fernet (reuse `token_crypto.py` from Aiia). Env: `BONBOX_TOKEN_ENCRYPTION_KEY`. `key_version` column for rotation. |
| Access tokens | Encrypted cache, refreshed on miss, never logged. |
| GDPR data stored | Only merchant-level data: `merchant_id`, merchant name, CVR (already public), settlement amounts, settlement dates, fee. **No customer info** (MobilePay does not share end-customer identities with the merchant by default — and we don't ask for that scope). Account-deletion cascade by `user_id` already covers it. |
| PCI / card data | **Zero scope.** MobilePay handles card vaulting + tokenisation. BonBox never sees PAN, CVV, or card-network data. We receive aggregated settlements only. |
| PSD2 / e-money licence | MobilePay holds the licence (Danish FSA-supervised). BonBox is *not* a TPP for MobilePay data — we are a merchant-side data consumer with explicit owner consent. No FSA authorisation needed for us. |
| Retention | Settlements kept 5y (Bogføringsloven §10). `mobilepay_connections` row hard-deleted on disconnect; audit rows persist. |
| Consent TTL | TBD until docs verified. If MobilePay enforces e.g. 90-day consents (PSD2-aligned), track `consent_expires_at` + email T-14 / T-3 / T-0 same as Aiia. If static partner keys, `consent_expires_at` is NULL and the "renewal" UX is dormant. |
| Tenant isolation | All routes filter by `user_id`. Callback validates signed `state` JWT bound to the initiating user. |
| Webhook signature | HMAC verify against `MOBILEPAY_WEBHOOK_SECRET`. v1.0 only. |
| Secrets in transit | All calls HTTPS. `MOBILEPAY_SUBSCRIPTION_KEY` (if APIM gating exists) sent as request header per provider convention. |
| Audit trail | Every connect / disconnect / expiry / sync / settlement import → `audit_logs` (§3.3). |
| Tier gating | `enforce_feature(user, "mobilepay_connect")` everywhere. |

---

## 10. Risks & open questions

1. **Production access requires sales conversation.** Sandbox is self-serve; production merchant API keys typically require an active MobilePay Business agreement + partner approval. Realistic 2–6 weeks of email back-and-forth before v0.2 can go live for real merchants. **Mitigation:** build v0.1 against sandbox and dogfood on Manoj's own merchant account before booking the sales call.
2. **Docs not verifiable from this environment.** `developer.vippsmobilepay.com` was blocked. Endpoint shapes, OAuth specifics, settlement payload schema are *inferred* from public knowledge + Aiia parity. Day-1 implementer task: read the live API reference and adjust the `services/mobilepay_client.py` skeleton + DB columns accordingly.
3. **Auth model uncertainty.** Could be standard OAuth, could be partner-issued static API keys. Both are supported by the schema, but the consent UX changes dramatically — OAuth is one click + MitID, static key is "paste this string from your MobilePay portal". Verify before promising owners "one-click connect".
4. **Aiia / MobilePay double-count.** Aiia imports the daily MobilePay payout as one aggregate bank line. MobilePay direct imports the same total broken down per settlement. Without dedup logic, the owner sees revenue twice. **Mitigation:** at MobilePay sync time, detect Aiia-imported bank lines matching `reference_id LIKE 'bank_%' AND amount = sum(mobilepay_settlements_for_date)` and either soft-delete the Aiia row or annotate it as "covered by MobilePay direct" so the matcher skips it. Needs a unit test fence.
5. **Settlement granularity** — MobilePay rolls up many in-store payments into one daily settlement. Per-receipt detail (one Sale per tap) may not be available via the settlement endpoint; if a Sales/Transactions endpoint exists separately, it likely costs more and may require a different scope. v0.1 uses settlement-level only.
6. **Fee handling** — MobilePay fees are roughly 0.85–1.5 % + 0.49 DKK fixed (public price-list, varies by merchant volume tier). Whether the settlement payload includes fee broken out vs already-netted is critical for the dual-row `Sale + Expense` write. If fee isn't broken out we lose the deductible-expense bookkeeping value. Verify on day 1; if no break-out, fall back to net-only `Sale` and tell the owner "fees not itemised — see your MobilePay statement".
7. **MitID Business friction.** First-time setup on a small café where the owner authenticates with their personal MitID and then has to elevate to MitID Erhverv can fail silently. Build a clear error state with a "How to get MitID Business" support link.
8. **Render free-tier cold-start** can time out the OAuth callback. Same constraint as Aiia — plan for Render Starter ($7/mo) before public launch.
9. **No public pricing for API access.** Card-processing fees are well known (0.85–1.5 % + 0.49 DKK). API access itself for the settlement product *appears* free for active merchants based on Vipps pre-merger pricing, but this is not confirmed for the post-merger Vipps MobilePay product. Verify before announcing GA.
10. **Auto-confirm risk.** Same as Aiia. A wrong HIGH+CVR auto-confirm forces the owner to un-pay an invoice. Gate behind the same per-user toggle as Aiia, default OFF for the first 30 days.

---

## 11. Effort estimate

| Phase | Working hours |
|---|---|
| Sandbox onboarding, docs read-through, OAuth PoC (one merchant, hardcoded user) | 6 h |
| `mobilepay_client.py` (HTTP wrapper, env wiring) | 5 h |
| `mobilepay_connections` migration + model + audit verbs + tier flag | 3 h |
| Routes: init / callback / list / delete / manual sync / reconnect | 6 h |
| Settlement → Sale/Expense mapping (fee handling, idempotency, edge cases) | 5 h |
| Cron tick + reconciliation wiring + Aiia/MobilePay dedup logic | 6 h |
| Frontend: Connect CTA, connections list, re-consent banner, i18n, fee summary card | 8 h |
| Real-merchant smoke test (Manoj's own MobilePay business account, sandbox → prod) | 4 h |
| Webhook receiver + signature validation (v1.0) | 4 h |
| Sales-call coordination, partner agreement paperwork, production key provisioning | 3 h (calendar: 2–6 weeks) |
| Polish, monitoring, error pages, runbook | 4 h |
| **Total v0.1 + v0.2 (sandbox-complete + first-merchant + cron + dedup)** | **~46 h** |
| **v1.0 polish + webhook + monitoring** | **+10 h** |

Realistic: **one dedicated working week for v0.1**, then a **2–6 week wall-clock pause** for the sales/partner approval, then **one more week** for v0.2 + dedup hardening once production keys are in hand. v1.0 polish slots into a third active week.

---

## 12. Phase plan

**v0.1 — sandbox proof.** Sandbox credentials; one (test) merchant; init/callback/sync/list routes; manual sync only; no cron; no webhook; no Aiia dedup. Behind feature flag `mobilepay_enabled=false` in prod — internal dogfood only.

**v0.2 — first real merchant + cron + dedup.** Production credentials for Manoj's own MobilePay merchant; nightly cron at 03:30 CET; Aiia ↔ MobilePay dedup logic; auto-confirm for HIGH+CVR (per-user toggle, default OFF for first 30d); re-consent flow with T-14/T-3/T-0 emails (if applicable); audit verbs firing; flag flipped on for Starter+. **Gate:** Manoj's own books reconcile cleanly for 30 consecutive days before public launch.

**v1.0 — webhook + polish.** Settlement-completed webhook if available (cron as safety net); Settings → Integrations page; fee-summary card; dashboard expiry banner; Sentry alerts on consent expiry waves + sync error spikes; `docs/runbooks/mobilepay-troubleshooting.md`.

---

## 13. Comparison vs Aiia — when does an owner need both?

| | Aiia | MobilePay direct |
|---|---|---|
| What it covers | **All** bank movements: Dankort, invoices, salaries, MobilePay aggregate payout | **Only** MobilePay settlements |
| Latency | T+1 (next-day bank statement) | Same-day settlement; T+1 if MobilePay batches |
| Granularity for MobilePay | One aggregate payout per day ("MobilePay DKK 12 480.00") | Per-settlement break-out + fee detail |
| Fee visibility | ❌ Fee already netted into payout | ✅ Fee broken out as Expense |
| Auth | MitID Personal → bank SCA | MitID Business → MobilePay |
| Per-consent TTL | 90 days (DK SCA) | TBD (likely longer or static) |
| Bank coverage gaps | Possible Nordea gap | N/A (single provider) |
| Goes through PSD2 TPP | Aiia (Mastercard) — yes | No — direct merchant API |

**Recommendation for owners:**

- **Tier-up café (Starter+):** connect **both**. Aiia covers everything, MobilePay direct adds the fee transparency and faster per-settlement detail. Dedup logic ensures revenue counts once.
- **Free tier:** can still upload the MobilePay CSV via the existing bank-import flow — no auto-feed.
- **MobilePay-light business (B2B invoicing only, no MobilePay at POS):** Aiia alone is sufficient. Hide the MobilePay CTA via a `business_type` heuristic once we collect it; v0.2 ships it visible to everyone.

---

## Sources

- **Could not directly fetch:** `developer.vippsmobilepay.com` and `developer.vippsmobilepay.com/docs/APIs/` — WebFetch was denied in the research environment. Endpoint shapes (OAuth + Reports/Settlement API), scopes (`settlements:read`, `merchant:read`), and consent-TTL specifics in this doc are **best-effort inferences** from the Vipps + MobilePay pre-merger products and standard merchant-payment API patterns. Implementer **must** verify against the live docs on day 1 and treat this spec as a starting skeleton, not as accurate API surface.
- General knowledge — Vipps MobilePay merger ([press 2022 announcement](https://www.vippsmobilepay.com/about), full unification 2024).
- MobilePay merchant pricing — public price-list typically 0.85–1.5 % + 0.49 DKK per transaction; verify the merchant's actual rate during onboarding.
- PSD2 / merchant data scopes — standard practice that merchant-side reporting APIs do not require TPP authorisation when consent flows through the merchant's own login.
- Internal: [`docs/aiia-integration-spec.md`](./aiia-integration-spec.md) — the sibling pattern this spec mirrors.
- Internal: `backend/app/services/bank_reconciliation.py` — the matcher MobilePay settlements feed into.
- Internal: `backend/app/services/billing.py` — `PLAN_FEATURES` tier-gate pattern.
