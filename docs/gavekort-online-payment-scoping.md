# Gavekort — online card checkout (Option B) scoping

> Status: **scoping only — not built.** Option A ("order online, owner collects")
> is built and red-line-safe. This document scopes the bigger step: letting a
> customer **pay online and get the gavekort instantly**. That step moves money,
> so it cannot be built without a payments partner and a custody decision that is
> the founder's to make.

---

## 1. Why this is a separate, gated decision

BonBox's hard rule: **BonBox never takes custody of money.** Option A honours
that — no card field, no charge, the owner collects payment their own way.

"Pay online → instant gavekort" necessarily moves money. The only question is
**whose money, through whose account**. That single choice decides whether this
stays a clean integration or becomes a regulated money operation:

| | Who is "merchant of record" | Where funds land | What BonBox becomes | Regulatory load |
|---|---|---|---|---|
| **B1 — Platform / pass-through** *(recommended)* | the **business** (its own payment account) | the **business's** bank, directly | a technical orchestrator | low — BonBox never holds funds |
| **B2 — Aggregator / MoR** *(not recommended)* | **BonBox** | BonBox, then remitted to the business | a payment intermediary holding client money | **high** — e-money / PSD2 licensing, safeguarding, audits |

**B2 crosses the red line.** It makes BonBox hold other people's money, which in
the EU is a licensed activity (e-money institution or payment institution under
PSD2 + the Danish FSA, Finanstilsynet). Do **not** go there unless BonBox is
deliberately becoming a regulated PSP. Everything below assumes **B1**.

---

## 2. B1 architecture — the business pays, BonBox orchestrates

```
Customer → public /g/buy/<slug>  →  pays via the BUSINESS's own checkout
                                          (Stripe Connect acct / MobilePay agmt)
        ↓ funds settle to the BUSINESS, never to BonBox
        ↓ payment-partner webhook → BonBox backend (payment_intent.succeeded)
        ↓ BonBox verifies signature + amount, then issues the gavekort
          via the SAME _create_gift_card path the owner-issue uses
        ↓ buyer is emailed the live /g/<token> card
```

The order row we already have (`gift_card_orders`) becomes the join point: it
gains a `payment_status` and a `payment_ref`, and the webhook flips
`pending → paid → issued`. **BonBox still never touches the money** — it only
listens for "the business got paid" and then mints the card. PCI is fully
offloaded: card data never reaches BonBox (the PSP hosts the card field).

This reuses ~80% of Option A. The new surface is: connect-a-payment-account
onboarding, a hosted-checkout redirect, and a signed webhook handler.

---

## 3. DK payment partners (evaluated for B1)

Denmark-first. The realistic shortlist, best fit first:

### 3a. Stripe (Connect — **Standard** accounts) — recommended default
- **Why:** cleanest platform model. Each business connects its **own** Stripe
  account (Stripe Connect Standard via OAuth). Funds settle to the business;
  Stripe is the regulated party; BonBox is a "platform" that never holds funds.
- **Methods:** cards + **MobilePay** (Stripe added MobilePay as a payment method
  for DK/FI), Apple Pay, Google Pay, Klarna. Dankort runs as co-badged Visa.
- **Webhook:** `checkout.session.completed` / `payment_intent.succeeded`, signed
  with the connected account's secret — we already verify Stripe webhook
  signatures for subscriptions (multi-secret support shipped, task #117), so the
  verification plumbing exists.
- **Cost to the business:** ~1.4% + 1.80 kr (EEA cards); BonBox can add an
  `application_fee` later if it ever wants to monetise (not required for v1).
- **Onboarding friction:** owner clicks "Connect Stripe" → Stripe-hosted OAuth.
  Businesses without a Stripe account must create one (a few minutes).

### 3b. Vipps MobilePay (direct merchant agreement) — strongest DK consumer pull
- **Why:** MobilePay is the dominant DK wallet; "betal med MobilePay" converts
  best for a gavekort impulse buy. Post Vipps-merger the product is **Vipps
  MobilePay**; the relevant API is **MobilePay Checkout / ePayments (Online)**.
- **Model:** the business holds its **own** MobilePay merchant agreement; funds
  settle to the business. BonBox integrates the API on the business's behalf
  (technical, not custodial).
- **Trade-off:** MobilePay-only (no international cards) → pair with 3a for
  tourists/foreign buyers, or accept DK-only. Merchant onboarding is heavier than
  Stripe OAuth (a real MobilePay agreement per business).

### 3c. Quickpay / Reepay (Billwerk+) / OnPay — DK gateway aggregators
- **Why:** Danish gateways that bundle Dankort + MobilePay + cards behind one
  integration; each business has its own acquirer agreement (e.g. Clearhaus/Nets).
- **Use when:** a business already uses one of these for its webshop and wants
  gavekort to settle the same way. More integrations to maintain; pick only on
  demand, not as the default.

**Recommendation:** ship **Stripe Connect Standard** as the universal default
(lowest onboarding friction, cards + MobilePay in one), and add **direct Vipps
MobilePay** as a second connector once there's pull for MobilePay-native UX.

---

## 4. What stays the same (the honesty + accounting invariants)

These do **not** change just because money now moves online:

- **Gavekort MOMS treatment.** A multi-purpose voucher (MPV) is **not** revenue
  at sale — it enters revenue/MOMS only on **redemption**. There is a known hole
  (gavekort redemption doesn't yet enter `revenue_total`); paid online sale makes
  fixing that more urgent, not less. The online sale must reconcile identically
  to a counter sale. **Never** treat the online payment as taxable sales revenue
  at purchase.
- **"registreret", never "bogført".** Even paid online, the card is recorded, not
  posted to a real ledger, until the economic bridge exists.
- **Refund = kreditnota path**, reusing the existing void/compensating-row model;
  a refund must reverse the PSP charge AND void the card atomically.
- **SCA / 3-D Secure** is the PSP's job; **PCI** never touches BonBox.

---

## 5. What BonBox cannot provision (the founder's calls)

1. **Custody decision: B1 vs B2.** Recommended B1 — do not become MoR.
2. **BonBox's own Stripe Connect *platform* account** (one-time, BonBox-level)
   + the Connect client id. Founder action in the Stripe dashboard.
3. **Each business's** payment credentials — by design these are the *business's*
   to connect (Stripe OAuth) or hold (MobilePay agreement). BonBox can't create
   them on their behalf.
4. A short **Finanstilsynet sanity check** that the B1 platform model keeps
   BonBox outside payment-institution scope (it should, since funds never settle
   to BonBox — but confirm before launch copy promises "pay online").

---

## 6. Rough effort (B1, Stripe-Connect-first)

| Slice | Work | Size |
|---|---|---|
| S1 | Connect onboarding: "Connect Stripe" OAuth in Orders settings; persist `connected_account_id` on BusinessProfile | M |
| S2 | `gift_card_orders` gains `payment_status` + `payment_ref`; public buy page swaps "Send order" → hosted Stripe Checkout redirect (when the business is connected) | M |
| S3 | Signed webhook handler → verify amount + connected account → call `_create_gift_card` → email buyer (reuses the issue path) | M |
| S4 | Idempotent webhook (reuse `webhook_events` dedup), refund→void bridge, failure/timeout states | M |
| S5 | Honesty + MOMS: ensure online sale reconciles like a counter sale; copy review ("the business is paid", never "BonBox charges you") | S |
| (later) | Direct Vipps MobilePay connector as a 2nd option | M |

Total ≈ one focused sprint for the Stripe-Connect path, **gated on** the founder
completing §5.1–5.2.

---

## 7. Recommendation

1. Keep **Option A** as the always-available, zero-setup path (built, live-safe).
2. When ready to add instant online payment, build **B1 with Stripe Connect
   Standard** — it preserves the red line (funds settle to the business, BonBox
   only orchestrates + issues on webhook) and reuses the existing issue path and
   Stripe webhook verification.
3. **Do not** build B2 (BonBox as merchant of record) — it turns BonBox into a
   regulated money operation and breaks the never-holds-money rule.
4. Confirm §5.1–5.4 with the founder before any "pay online" copy goes public.
