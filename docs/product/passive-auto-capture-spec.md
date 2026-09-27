# Passive Sales Auto-Capture — Design Spec

**Status:** Pre-implementation. Parked from a strategy session on 2026-05-24.
**Author:** Synthesized from 3 expert agents (DK payments / DK competitive landscape / architecture).
**Maintainer:** Manoj.
**Adjacent work shipped:** Ticket-sheet "Cash up event" flow (commit `6dcd686`) which solves the *episodic* event-organizer shape. This spec is for the *daily-grind* shape — cafés / restaurants / retail.

---

## 1. Why

Manual one-by-one Quick Sale entry is too high-friction for businesses that take 30–500 payments per day. The promise has to be: owner plugs in MobilePay / bank / Stripe once, then sales just appear in BonBox with sequential `bilagsnummer` and a revisor-ready audit trail. Owner only intervenes when something needs review.

**Target customer:** café (Toast/Square shape), restaurant, small retail, salon. Not event organizers — they're covered by the ticket-sheet cash-up.

**Anti-customer for v1:** Sudip-shape event organizer. The ticket-sheet pattern is the right answer there. Don't muddle the two.

---

## 2. DK Payment Channel Reality Matrix

What each payment-acceptance channel a DK SMB can plug into actually gives us:

| Channel | API | Per-Tx Metadata | Granularity | SMB Setup | DK Adoption |
|---|---|---|---|---|---|
| **MobilePay Business** | REST + webhooks (`payment.completed`). ~2–5s latency. | amount, tx ID, merchant ref, payer alias (masked), source | **Per-transaction** | Self-service, CVR + bank, OAuth2 ISV app via Developer Portal | **~90%** — near-universal |
| **Nets / Nexi (Easy / Net Axept)** | Easy = REST + webhooks. Physical terminals = T+1 settlement files only (no real-time SMB API). | Easy = full per-tx. Terminal = batch + per-tx in next-day file. | Easy per-tx; terminals practically batch | Direct Nets agreement, weeks | High for terminals; Easy moderate |
| **Clearhaus** | REST + webhooks for auth/capture/payout. **Best-in-class reconciliation** — links each tx to its payout batch. | amount, scheme, fee per tx, payout batch ID, dispute hooks | Per-tx + payout-batch correlation | Acquirer agreement (~1 week) + a gateway in front (QuickPay, Reepay, etc.) | High among DK e-com, growing in hybrid |
| **Aiia (Mastercard Open Banking)** | PSD2 AIS — polling 4–24h + push on new tx. Hours of latency. | bank-line: amount, counterparty, value date, free-text | **Bank statement granularity only** — 27 card swipes = one settlement deposit | MitID Erhverv every 90–180 days; ISV partner agreement | High — modern accountants' default |
| **GoCardless Bank Account Data** | PSD2 AIS, polling. Hours of latency. | Same statement-level fields | **Statement-level only** | Same MitID reauth | Lower than Aiia in DK, rising; good fallback |
| **Salt Edge** | PSD2 AIS, polling + webhooks. | Statement-level | **Statement-level only** | Same MitID | Niche in DK |
| **Billetto** | Public API + webhooks (`order.created`, `order.completed`, refunds). Seconds. | Order ID, attendee name+email, ticket type, qty, gross, Billetto fee, payout date, event ID | **Per-ticket-order** | Self-service org account, API key | **Dominant** for indie DK events |
| **Eventbrite** | Mature REST API + webhooks. Seconds. | Similar to Billetto + richer marketing fields | Per-order | Self-service OAuth | Moderate; loses to Billetto for local DK |
| **Stripe / Stripe Terminal** | Best-in-class REST + webhooks. <1s latency. `balance_transactions` auto-reconciliation. | Full PaymentIntent — amount, fee, net, balance_tx, customer, payment_method, receipt | **Per-transaction + automatic payout reconciliation** | Self-service, live in hours | Moderate (growing) |
| **Shopify Payments** | Admin API + webhooks (`orders/create`, `orders/paid`) + payouts API. Seconds. | Order, line items, customer, fee, payout batch | Per-order + payout batch | Self-service inside Shopify | Moderate (e-com only) |
| **Zettle (PayPal)** | REST API + webhooks (limited; some polling). Seconds–minutes. | Purchase ID, items, amount, scheme, fee, location | **Per-transaction** | Self-service merchant signup, fast | **High** for market stalls, micro-merchants |
| **CCV / Verifone (legacy terminals)** | SFTP/portal batch files. No real-time API for SMB tier. | Settlement-level | **Batch-only** | Direct reseller contract | Moderate (declining) |

### Top-3 Priority for BonBox

1. **MobilePay Business API** — universal DK consumer payment, real-time webhooks, low setup friction. Without this, BonBox is not credible in DK. **Already partially built** at `backend/app/routers/mobilepay.py` (sandbox).
2. **Aiia PSD2** — covers the "everything else lands in the bank account" catch-all (Nets settlements, Clearhaus payouts, supplier transfers, Stripe payouts). Statement-level only, but it's the only path to capture legacy terminals and matches Sudip's existing accountant workflow. **Already partially built** at `backend/app/routers/bank_connect.py`.
3. **Billetto API** — for event-organizer segment (a defensible niche no DK incumbent has). Per-ticket-order granularity with customer email/name (CRM gold).

### The Always-Manual Gap

These will always need manual entry (or the ticket-sheet cash-up pattern, not auto-capture):
- **Cash at the door** — no API on the planet captures physical kroner
- **Gift cards / vouchers / comp tickets** — issuance captured; redemption is a non-payment event no PSP sees
- **MobilePay person-to-person** (private wallet, not Business) — common SMB shortcut, lands in personal bank, no API
- **Cash IOUs / "I'll pay Friday"** — receivable, not a sale
- **Old terminals (CCV/Verifone batch-only)** — best you can do: one "Card sales — terminal X" row per batch
- **Tips paid in cash directly to staff** — personalskat issue, outside till
- **Foreign-bank invoicing** — PSD2 may not reach non-DK accounts

---

## 3. Competitive Landscape

How DK incumbents and global competitors handle auto-capture today:

| Tool | Auto-capture sources | "Set & forget" | Review UX | Sudip / café gap |
|---|---|---|---|---|
| **Dinero** (Visma) | PSD2 (Aiia/Tink), Stripe, recurring invoices, receipt-scan inbox. No native MobilePay sales-line. | Partial | Bank-line review queue, suggest-match | No Billetto, no MobilePay-MyShop per-tx |
| **Billy.dk** | PSD2, Stripe, recurring invoices, receipt OCR. API for POS connectors. | Partial | "Suggested matches", 1-click confirm | Same — Billetto + MobilePay-Box splits done by hand |
| **e-conomic** (Visma) | PSD2 (Banking add-on ~50 DKK/mo), Continia, Pleo, Shopify, Wolt/Just Eat (via partners), Lightspeed. ~500-app marketplace. | True if you pay for Banking + Continia | Auto-posting rules, accountant-driven | Built for accountants. Sudip won't configure this. |
| **Uniconta** | PSD2 (via partner), Continia, Shopify, custom ERP integrations. | True for mid-market | Accountant workspace, batch posting | Wrong segment — for 10+ employee firms |
| **Lunar Business** | Bank account + card; "Bogføring" tab uses Dinero under the hood. | Partial via Dinero | Lunar app shows tx, accounting in Dinero | Lunar = bank, not accounting |
| **Toast** (US restaurants) | Native POS — every sale, tip, refund auto-captured. Integrates QuickBooks/Xero. | **True** within Toast | Sales just *are* the books | Not sold standalone in DK |
| **Square** | Native POS + online + Tap-to-Pay iPhone. | **True** within Square | None — sales are source-of-truth | Limited DK presence (no Square Terminal in DK as of 2026); no DK MOMS module |
| **Shopify + Shopify Payments** | Every order auto-booked; Shopify Tax for VAT; Shopify POS. Connectors to Dinero/Billy. | True for e-com | Order list = ledger source | Wrong shape for door/cinema events |
| **Stripe Terminal + Stripe Tax** | API-first. Excellent dev story. | True if you build it | Stripe Dashboard, programmable | Requires technical setup |
| **Zettle (PayPal)** | POS terminal common in DK markets/cafés. Auto-export to e-conomic/Dinero/Billy. MobilePay at terminal supported. | True if connected | POS = source-of-truth | No Billetto link; only captures door sales |
| **QuickBooks / Xero** | Bank feeds, Stripe, PayPal, Shopify, 1000+ apps. | Partial | ML review queue | Not DK-localized for MOMS/SKAT filing |

### Table Stakes (Must-Have to Be Credible in DK 2026)

1. **PSD2 bank feed** (Aiia or Tink) with auto-suggest matching + one-tap confirm
2. **Stripe + card-terminal ingestion** with fee/gross/net auto-posted
3. **Receipt-forwarding email inbox** with OCR + auto-suggested account (Pleo/Dinero parity)
4. **MOMS-correct posting** to standard DK chart of accounts + quarterly MOMS-angivelse export
5. **Accountant share / SAF-T export** so the revisor doesn't have to re-key

If any of these is missing in 2026, BonBox is not in the conversation.

### Where We Can Win

Dinero/Billy stop at the bank line. Sudip's pain is **upstream** of the bank line — he has 4 channels and only sees one gross number arrive a few days later, after Billetto skim + MobilePay fee + acquirer fee.

- **First-party Billetto ingestion** — public API, nobody in DK incumbent set has built it because their ICP isn't event organizers
- **MobilePay MyShop / Business webhook** at line level (not just bank summary) — book gross sale + fee expense + net deposit, reconciled when bank settlement arrives 1-2 days later
- **Cross-channel event reconciliation** — one event = one "project" rolling up Billetto + door MobilePay + door card + cash float, with one P&L per event. No incumbent does this.
- **"Show the owner what the accountant sees"** — glassbox dashboard. Incumbents target the bookkeeper. Owner-visible bookkeeping with zero accounting jargon (Danish-locked terms: `kasserapport`, `MOMS`, `revisor`) is the wedge.
- **Honest auto-confirm with audit trail** — most tools require manual confirm because they fear misposting. BonBox can auto-confirm HIGH confidence AND show undo-with-audit-trail (Bogføringsloven §10 already requires the log).

### The Kill Shot — One Feature

**Native Billetto → BonBox → bank reconciliation auto-pipe**, with per-event rollup.

Bank feeds eventually catch MobilePay/card settlements; accountants tolerate that lag. But **Billetto payouts arrive as a single net lump sum** with no line-level breakdown in the bank feed — that's where every event organizer in Denmark loses hours per show reconciling ticket revenue vs Billetto's service fee vs MOMS on the ticket. Nobody has built it.

Pipe: Billetto API → ticket-line ingest (gross, Billetto fee, MOMS) → posted as draft → bank settlement arrives → auto-match → confirmed. Sudip sees: *"Movie night Oct 14: 247 tickets, 49.400 DKK gross, 2.470 service fee, 9.886 MOMS, 36.044 net to bank."* Done.

---

## 4. Architecture

```
┌─────────────── CAPTURE SOURCES (push + pull) ────────────────────────┐
│  MobilePay webhook ──┐     Aiia PSD2 cron (daily 03:00) ──┐          │
│  Stripe webhook ─────┤     Billetto webhook + nightly CSV ─┤         │
│  Card terminal feed ─┤     Smart Scan OCR (mobile upload) ─┤         │
│  Manual /sales POST ─┘     CSV reupload (rare, backstop) ──┘         │
└──────────────────────┬───────────────────────────────────────────────┘
                       ▼
┌── INGEST EDGE (per-source adapter → captured_payments row) ──────────┐
│  Normalises to {source, source_ref, occurred_at, amount_minor,       │
│  currency, method, raw_payload_hash, idempotency_key}                │
│  Writes status='ingested', never to `sales`.                         │
│  Idempotent on (user_id, source, source_ref).                        │
└──────────────────────┬───────────────────────────────────────────────┘
                       ▼
┌── DEDUPE / RECONCILE (capture_reconciler.py) ────────────────────────┐
│  PASS A — exact-ref dedup (UNIQUE constraint at DB level)            │
│  PASS B — cross-source same-instrument (MobilePay psp_ref ↔ Aiia)   │
│  PASS C — amount+window subset-sum heuristic                         │
│  PASS D — manual-entry collision detection                           │
│  Output: capture_links rows + status updates                         │
└──────────────────────┬───────────────────────────────────────────────┘
                       ▼
┌── ENRICHMENT (capture_enricher.py) ──────────────────────────────────┐
│  bilagsnummer via voucher_service.allocate_voucher                   │
│  doc-hash, provenance_footer                                          │
│  event_id suggestion from active filter + date window                │
│  payment_method canonicalisation, MOMS class hint                    │
└──────────────────────┬───────────────────────────────────────────────┘
                       ▼
┌── REVIEW QUEUE (Sales Inbox UI + /capture/inbox API) ────────────────┐
│  Three lanes by confidence:                                           │
│   • Auto-posted (HIGH)    — already a Sale row, "auto" tag            │
│   • Awaiting review (MED) — 1-tap confirm, batch-confirm available    │
│   • Needs attention (LOW) — amount ambiguity, dup risk, missing tag   │
└──────────────────────┬───────────────────────────────────────────────┘
                       ▼
┌── COMMIT (capture_service.commit) ───────────────────────────────────┐
│  1. INSERT sales row with voucher_number + source + source_ref        │
│  2. INSERT audit_logs (event='capture.commit')                        │
│  3. Update captured_payments.status='committed', link sale_id         │
│  4. If cash → sync_cash_in_for_sale; if event → tag                   │
│  Failures roll back the sale insert only; capture row reopens.        │
└──────────────────────────────────────────────────────────────────────┘
```

**Key invariant:** a `captured_payments` row never becomes a `sales` row until commit. This keeps L6 fail-closed clean — a half-ingested payment cannot pollute the kasserapport.

### Database Schema Deltas

Builds on the existing `payment_match_suggestions` model pattern (which handles invoice↔bank-line). This handles raw-feed↔sale.

```sql
-- Migration NNN — captured_payments + capture_links

CREATE TABLE captured_payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source          TEXT NOT NULL CHECK (source IN (
                    'mobilepay','aiia','billetto','stripe',
                    'terminal','ocr','csv','manual'
                  )),
  source_ref      TEXT NOT NULL,           -- vendor's idempotency key
  occurred_at     TIMESTAMPTZ NOT NULL,    -- when money moved, vendor time
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount_minor    BIGINT NOT NULL,         -- ører; avoid float
  currency        CHAR(3) NOT NULL DEFAULT 'DKK',
  payment_method  TEXT,                    -- canonicalised
  raw_payload     JSONB NOT NULL,          -- full original event (Fernet-encrypted)
  raw_hash        CHAR(64) NOT NULL,       -- sha256(canonical(raw_payload))
  doc_hash        CHAR(64),                -- assigned at enrichment
  bilagsnummer    INTEGER,                 -- allocated at enrichment
  voucher_year    INTEGER,
  status          TEXT NOT NULL DEFAULT 'ingested'
                  CHECK (status IN (
                    'ingested','reconciled','needs_review',
                    'merged_into','committed','rejected','duplicate'
                  )),
  confidence      TEXT CHECK (confidence IN ('high','medium','low')),
  reason          TEXT,
  sale_id         UUID REFERENCES sales(id) ON DELETE SET NULL,
  parent_capture_id UUID REFERENCES captured_payments(id),
  event_id_hint   UUID REFERENCES events(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, source, source_ref)     -- L4: DB-level idempotency
);

CREATE INDEX ix_cp_user_status   ON captured_payments(user_id, status);
CREATE INDEX ix_cp_user_occurred ON captured_payments(user_id, occurred_at DESC);
CREATE INDEX ix_cp_dedupe_window ON captured_payments(
  user_id, currency, amount_minor, occurred_at
) WHERE status IN ('ingested','reconciled','needs_review');

CREATE TABLE capture_links (
  parent_id  UUID NOT NULL REFERENCES captured_payments(id) ON DELETE CASCADE,
  child_id   UUID NOT NULL REFERENCES captured_payments(id) ON DELETE CASCADE,
  link_type  TEXT NOT NULL CHECK (link_type IN ('settles','duplicates','refunds')),
  confidence TEXT NOT NULL,
  rationale  JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_id, child_id)
);

-- Sale-side delta — bidirectional audit chain
ALTER TABLE sales
  ADD COLUMN capture_id UUID REFERENCES captured_payments(id),
  ADD COLUMN capture_source TEXT,
  ADD COLUMN auto_committed_at TIMESTAMPTZ;  -- NULL = human confirmed
CREATE INDEX ix_sales_capture ON sales(capture_id) WHERE capture_id IS NOT NULL;
```

### API Endpoint Sketch

| # | Router | Method | Path | 10-layer coverage |
|---|---|---|---|---|
| 1 | `mobilepay.py` (extend) | POST | `/webhooks/mobilepay` | L1 HMAC sig, L4 schema, L6 enc, L7 audit, L9 graceful 200 always |
| 2 | `bank_connect.py` (extend) | POST | `/aiia/sync-now` | L1 auth, L2 tier (`bank_autosync`), L3 rate 5/min, L7 audit |
| 3 | `billetto.py` (new) | POST | `/webhooks/billetto` | L1 sig, L4 schema, L7 audit |
| 4 | `capture_inbox.py` (new) | GET | `/capture/inbox` | L1, L2, L3 tenant, L4 paging cap 100, L7 read-audit |
| 5 | `capture_inbox.py` | GET | `/capture/pending-count` | L1, L2, cheap COUNT (mirrors `payment_suggestions.pending_count`) |
| 6 | `capture_inbox.py` | POST | `/capture/{id}/accept` | L1, L2, L3 owner check, L7 audit `capture.accept`, L9 idempotent on retry |
| 7 | `capture_inbox.py` | POST | `/capture/{id}/reject` | L1, L3, L7 audit, L8 fallback: 30d undo window |
| 8 | `capture_inbox.py` | POST | `/capture/batch-accept` | L1, L2, L4 body cap 50 IDs, L3 rate 10/min, L7 audit-per-row |
| 9 | `capture_inbox.py` | POST | `/capture/{id}/merge-into/{parent_id}` | L1, L3 both rows must be user's, L7 audit, L6 fail-closed if either committed |
| 10 | `capture_inbox.py` | POST | `/capture/{id}/tag-event` | L1, L3 event ownership IDOR-defended, L7 audit |

Webhook routers return `200 OK` even on dedupe (L9 honest-claims caveat: response body distinguishes `{accepted:true}` vs `{duplicate:true, original_id:...}`).

### UX Flow

**Sales Inbox** — `/sales/inbox` — three-lane Kanban, mobile-first:

```
┌─ Sales Inbox ────────────────────── 24 new ─┐
│  [Auto-posted 18]  [Review 4]  [Attention 2]│
├─────────────────────────────────────────────┤
│ REVIEW (medium confidence — tap to confirm) │
│ ┌─────────────────────────────────────────┐ │
│ │ ⚡ MobilePay  •  kr. 4.250,00            │ │
│ │ Sat 18 May 21:14  •  via terminal       │ │
│ │ Suggested event: Sommerfest Vesterbro ▾ │ │
│ │             [Decline]  [Confirm sale]   │ │
│ └─────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────┐ │
│ │ ◐ Billetto  •  kr. 12.400,00 (32 tickets│ │
│ │ Order #BIL-9X4K  •  fee kr. 372,-       │ │
│ │ Event suggested from CSV column ✓       │ │
│ │ [Confirm + tag]   [Confirm without tag] │ │
│ └─────────────────────────────────────────┘ │
│ [✓ Confirm all 4 reviewable]    (batch)     │
└─────────────────────────────────────────────┘
```

- **Auto-posted lane** — already Sale rows; read-only proof owner can scan
- **Review lane** — 1-tap accept/reject. Batch-confirm only when every row is same-source + confidence ≥ medium
- **Attention lane** — each row shows the *why* (amount conflict / dup-suspect / missing event)

**Notification policy:**
- HIGH → silent auto-post
- MED → digest at 08:00 CET
- LOW → immediate push only when `amount > 5000 DKK` OR `dup-suspect`

**Trust calibration:** each row carries a provenance chip — `MobilePay • matched Aiia line • bilagsnummer 2026-S-0214`. Tap → drawer shows raw payload + reconcile rationale ("amount equal, +1 day, terminal_id matches"). Gmail "show original" pattern.

**Event interleave (Sudip's killer feature):** when an event filter is active in the top bar, the inbox header shows *"Tagging captures to: Sommerfest Vesterbro (18-19 May)"* and all MED-lane confirms auto-apply that tag.

---

## 5. Multi-barrier Matrix

For each capture source, which of the 10 layers protect it. Cross-source independence: each source has its own webhook router, its own connection row, its own Fernet-encrypted token. MobilePay revoked does NOT stop Aiia sync.

| Source | L1 | L2 | L3 | L4 | L5 | L6 | L7 | L8 | L9 | L10 |
|---|---|---|---|---|---|---|---|---|---|---|
| MobilePay webhook | HMAC + replay-window | Pydantic + amount bounds | 60/min/merchant | swallow & log non-fatal | merchant_id ↔ user_id | reject if user disconnected | every receive | Aiia catches later | 200 on dup, body says so | sandbox badge in UI |
| Aiia PSD2 sync | OAuth bearer | account-id allowlist | 5/min user-trigger | partial-page tolerated | account ↔ user | reject if consent expired | sync.start/end | manual CSV import | 503→retry-after | "PSD2 sandbox" badge |
| Billetto webhook | HMAC | Pydantic ticket schema | 30/min | row-level try/except | api_key ↔ user | reject if event deleted | per-row | CSV reupload | 200 always | "Beta — Billetto API v3" chip |
| Stripe webhook | Stripe-Signature | event.type allowlist | 200/min global | non-charge events dropped | account ↔ user | refunds halt commit | full payload archived | manual entry | 200 always | future-tier badge |
| OCR Smart Scan | session | 5 MB cap, MIME allowlist | 10/min | low-conf → MED queue | upload ↔ user | reject if photo missing | upload event | manual sale | 400 honest | "AI guess" chip |
| CSV import | session | 2 MB cap, row cap 2000 | 10/min | per-row try/except | session.user | rollback within 5 min | per-batch | manual sale | 400 honest | banner always shown |
| Manual /sales POST | session | Pydantic | sales router rate | n/a | n/a | n/a | already logged | n/a | n/a | unchanged |

---

## 6. Tier Strategy

Slots into existing `PLAN_FEATURES` + `PLAN_CAPS`. Starter-centric ("most users will be Starter") doctrine preserved.

```python
# PLAN_FEATURES additions
"auto_capture_mobilepay":   {free: True,  starter: True,  pro: True}
"auto_capture_bank_psd2":   {free: False, starter: True,  pro: True}
"auto_capture_billetto":    {free: False, starter: True,  pro: True}
"auto_capture_stripe":      {free: False, starter: False, pro: True}
"auto_capture_batch":       {free: False, starter: True,  pro: True}
"auto_capture_event_link":  {free: True,  starter: True,  pro: True}  # taste-on-free

# PLAN_CAPS additions  (-1 = unlimited)
"auto_capture_inbox_keep_days":  {free: 14,  starter: 90,  pro: 365}
"auto_capture_committed_month":  {free: 50,  starter: -1,  pro: -1}
"auto_capture_sources_active":   {free: 1,   starter: 3,   pro: -1}
```

**Free** gets MobilePay auto-capture + event-link tagging at low caps so the magic is felt — but only 1 active source + 50 commits/month + 14-day retention. Past the cap, capture continues into review queue but cannot commit until next month (L10 honest claim: shows "Upgrade to commit").

**Starter** unlocks the killer combo (MobilePay + Aiia + Billetto = the Sudip stack). 90-day inbox retention matches typical revisor monthly cadence. No commit cap.

**Pro** adds Stripe + unlimited sources for multi-channel operators + full-year retention.

**Accountant-grade artifact rule preserved:** every committed sale carries identical bilagsnummer, doc-hash, provenance footer regardless of tier. Tier only affects what gets committed and how long the inbox keeps history.

---

## 7. Dedupe Algorithm

```python
# capture_reconciler.py — pseudocode
def reconcile_user(db, user_id, *, window_hours=72):
    candidates = fetch_open_captures(db, user_id, window_hours)

    # PASS A — exact source_ref dedup (handled by UNIQUE at INSERT)

    # PASS B — cross-source SAME-INSTRUMENT (psp_ref → bank line text)
    for cap in candidates_of_source(candidates, 'mobilepay'):
        psp_ref = cap.raw_payload.get('reference')
        if not psp_ref: continue
        match = find_aiia_line_with_text(candidates, psp_ref)
        if match:
            link(parent=match, child=cap, type='settles', conf='high')
            cap.status = 'merged_into'

    # PASS C — amount+window subset-sum for orphans
    # Aiia bank settlement of 12.400 DKK = 4 MobilePay webhooks of 3.100
    for aiia in unmatched_aiia_lines(candidates):
        same = [c for c in unmatched_mobilepay(candidates)
                if c.currency == aiia.currency
                and aiia.occurred_at - c.occurred_at < 96h
                and c.occurred_at < aiia.occurred_at]
        subset = subset_sum_exact(same, aiia.amount_minor,
                                  max_size=20, time_budget_ms=200)
        if subset:
            for cap in subset:
                link(parent=aiia, child=cap, type='settles', conf='medium')
                cap.status = 'merged_into'
            aiia.status = 'reconciled'
            aiia.confidence = 'high' if len(subset) <= 3 else 'medium'
        else:
            aiia.status = 'needs_review'
            aiia.confidence = 'low'
            aiia.reason = 'aggregate_unmatched'

    # PASS D — manual entry collision
    # Owner manually entered 4.250 DKK MobilePay sale at 21:14 before webhook
    # landed. Find sales WHERE auto_committed_at IS NULL within ±24h, same
    # amount + method → flag as duplicate (don't auto-merge; ask owner).
    for cap in candidates_of_source(candidates, ('mobilepay','stripe')):
        if cap.status != 'ingested': continue
        twin = find_manual_sale_near(db, user_id, cap)
        if twin:
            cap.status = 'needs_review'
            cap.confidence = 'low'
            cap.reason = f'possible_dup_of_manual_sale:{twin.id}'

    # Auto-commit gate
    for cap in candidates:
        if cap.status == 'reconciled' and cap.confidence == 'high':
            commit_to_sales(db, cap, actor='system')
        elif cap.status in ('ingested','reconciled') and cap.confidence == 'medium':
            cap.status = 'needs_review'
```

**Confidence tiers:**
- **HIGH** → auto-commit silently. PASS B match OR PASS C with subset_size ≤ 3 AND no manual-dup candidate.
- **MEDIUM** → inbox review lane. PASS C with subset_size 4-20, or single-source no-match within window.
- **LOW** → attention lane. Aggregate unmatched, manual-dup suspect, OCR ambiguity, or amount outside historical range (e.g. 50× median sale).

**Partial aggregation edge case:** if 12.400 DKK Aiia line equals 3.100 × 3 of 4 MobilePay rows (one webhook missing/delayed), reconciler does NOT greedy-fit a 9.300 subset and leave the orphan. Marks all 4 candidates `needs_review` with `reason='partial_aggregate_window_open'` and retries next cron tick. Safer to wait than to commit wrong.

---

## 8. 30-Day MVP Cut

|  | In | Out |
|---|---|---|
| **Sources** | MobilePay webhook (sandbox) only | Aiia, Billetto, Stripe, terminal, OCR |
| **Dedupe** | PASS A (exact ref) + PASS D (manual collision) | PASS B, PASS C, subset-sum |
| **UI** | Single Sales Inbox page, one lane "Review", individual confirm | Three lanes, batch confirm, attention lane |
| **Tier** | Starter only, hardcoded feature flag | Free taste, Pro Stripe, cap enforcement |
| **Notification** | Inbox badge count, no push/email | Digest, push, threshold alerts |
| **Event tagging** | Manual on confirm via existing dropdown | Auto-suggest, date-window inference |
| **Audit** | Full L7 (non-negotiable) | — |

**Why this cut:** MobilePay-only because (a) Sudip already uses it, (b) sandbox is partially built, (c) one source has no inter-source dedupe complexity. PASS D non-negotiable because without it, owner double-counts on day one.

**v0.2 (days 31-60):** Aiia + PASS B + PASS C subset-sum + Billetto CSV (route existing `import-csv?source=billetto` through `captured_payments` instead of direct `sales` insert). Three-lane UI.

**v0.3 (days 61-90):** Stripe, batch confirm, push/digest notifications, event auto-suggest from active filter, free-tier caps live, Pro tier Stripe flag.

---

## 9. Risk Register

| # | Risk | Detection | Mitigation |
|---|---|---|---|
| 1 | **Double-commit on webhook re-delivery** — MobilePay retries on 5xx | Unique constraint raises IntegrityError; daily alert on `capture.duplicate.count` | DB-level UNIQUE is floor. Idempotency-Key middleware is ceiling. L9: 200 even on dup with `{duplicate:true}` body |
| 2 | **Wrong subset-sum match** (PASS C ties 4 unrelated MobilePay rows to coincidentally-equal Aiia line) | Same `source_ref` in two `capture_links` parents. Nightly orphan-inversion grep | Cap PASS C confidence at MEDIUM → always review. Never silently auto-commit subset-sum |
| 3 | **GDPR — raw_payload contains PII** (MobilePay customer name, phone) | DPIA before launch | `raw_payload` Fernet-encrypted at column level. Auto-purge after 180 days. Never returned by any API — only canonical normalised fields surface |
| 4 | **Voucher sequence corruption** if commit crashes between `allocate_voucher` and `INSERT sales` | `voucher_audit` already detects gaps | Two-phase: allocate in same transaction as INSERT. Roll-back means voucher wasted but not gapped |
| 5 | **Vendor downtime cascades silence** (Aiia 4-hour outage → Sudip thinks "nothing sold yesterday") | Health check per source. Inbox banner: "Aiia last sync: 14 hours ago — values may be incomplete" | L8 fallback: MobilePay covers real-time leg. L10 honest-claims banner. Kasserapport footer always shows source coverage |

---

## 10. Open Questions for Manoj

1. **MobilePay Erhverv production credentials — when?** Sandbox is fine for design, but PASS B (psp_ref ↔ Aiia text) needs real-world data to tune. Ship v0.1 with sandbox-only and a "Beta — Sandbox" banner, OR wait for prod keys?
2. **Auto-commit policy on HIGH confidence — opt-in or default-on?** Gmail Promotions doesn't ask. Should BonBox auto-commit HIGH MobilePay → Sale rows silently for new users, or require one-time consent during `/settings/auto-capture` onboarding? GDPR Article 22 lean: explicit consent.
3. **Cash sales — does auto-capture have any reach here?** Sudip mentioned "some cash". OCR receipts can do it but cash has no event source. v0.3 "Cash blitz" mode (photo till tape, OCR parses N rows)?
4. **Refund / kreditnota flow.** When MobilePay sends a refund webhook, auto-create negative Sale or surface to `needs_review` so owner explicitly maps it to original sale?
5. **Free-tier cap of 50 commits/month — what happens at 51?** (a) capture continues, commits halt, surplus rows sit in `needs_review` with 402 banner; (b) capture halts and webhooks dropped (worse — silently loses data). Recommend (a).

---

## 11. Bottom Line

The 3-pill MOMS toggle modal + ticket-sheet cash-up (already shipped) is fine for the *event-organizer* shape. It is **not** the product for the daily-grind café/restaurant shape. The product for that shape is BonBox quietly ingesting MobilePay + Billetto + card terminal + bank, posting MOMS-correctly with full audit trail, and showing the owner a per-event P&L their revisor can sign off on.

Build order when we're ready:
1. **Billetto pipe** (the kill shot — no incumbent has it)
2. **MobilePay webhook → inbox**
3. **Aiia bank-feed reconciliation**
4. **Stripe Terminal** when we have an e-com+retail SMB on the line

Park this doc until we have our first non-event customer on the pipeline. The schema, the multi-barrier matrix, the tier strategy — they're all here. Re-read this before starting v0.1, then go.
