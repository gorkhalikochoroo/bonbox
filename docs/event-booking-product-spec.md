# BonBox Event Hosting & Ticket Reservations — Product Spec

**Status:** v3 (simplified payment model — ledger-only) — 2026-05-25
**Authored:** Senior PM agent + Claude
**Scope:** Public-facing booking surface + CSV-reconciliation-based payment matching. BonBox is the LEDGER; the merchant rails stay with the organizer (their own MobilePay Erhverv + Dankort terminal).

> **Tier rule (Manoj):** Free is constrained. Starter and Pro get IDENTICAL event features.
>
> **Payment model (Manoj 2026-05-25):** *"payment just mobile pay or dankort cant he use his own ... can import the csv in here ... or also like they can set price stuff and can input data how much they sold and enter in bonbox that way it doesnot need to go as well with csv"*
>
> **Translation:** **BonBox never touches money.** Sudip uses his own MobilePay Erhverv + Dankort terminal. Then he reconciles in BonBox via ONE OF THREE paths (organizer's choice per event):
>
> | Path | When | How |
> |---|---|---|
> | **A — Per-booking "Mark paid"** | Default; small events | Tap a checkmark on each row in the bookings guest list → Sale row + bilagsnummer |
> | **B — CSV auto-match** | High-volume events | Import MobilePay/Dankort CSV → auto-matches by reference text + amount + name → batch Sale creation |
> | **C — Existing EventCashupModal** | Cash event / no booking link used | Manual totals entry — unchanged from today |
>
> All three paths call the same `write_sale_from_booking` / `cashup_event` keystone. Same bilagsnummer chain, same MOMS, same revisor PDF.
>
> **What this kills:** Stripe Connect, MobilePay Online Payments API, Payment Intents, webhook idempotency, payment-provider race conditions, DK fintech lawyer review for v1. **3-4 week ship instead of 12.**

## 0. IA placement

- `/events` (existing) — organizer event list. Extended with **Publish** toggle, share link, bookings tab.
- `/events/{id}` (existing) — organizer event detail. Adds **Bookings** tab (guest list, status, reconciliation badges) alongside the existing cash-up flow.
- `/e/{slug}` (NEW) — public bookable event page. Mobile-first, FB-unfurl-ready via SSR meta.
- `/t/{ticket_id}?sig=...` (NEW) — visitor's web ticket page.
- `/payment-imports` (existing) — extended with "Auto-match to bookings" review when imported CSV contains payment lines that reference pending bookings.
- `/scan` (NEW) — organizer's PWA camera door-scan page.

No new top-level nav items. Everything bookings-related lives under the existing **Events** sidebar entry; reconciliation lives under existing **Payment Imports** sidebar entry.

---

## 1. Honest audit — what we have, what we don't

| Capability | State | Verdict |
|---|---|---|
| `Event` entity (uuid, name, date, venue, notes, ticket_tiers JSONB, is_tax_exempt, soft-delete) | Shipped, migration 013/015 | **KEEP** — model is sufficient for v1. Add `cover_image_url`, `slug`, `published`, `ends_at`, `capacity`, `bookings_open_at` / `bookings_close_at` columns |
| `Event.ticket_tiers` JSONB `[{label, price_dkk}]` | Shipped — used by `EventCashupModal` | **EXTEND** — needs `quantity_available` and `sort_order` per tier. Widen the JSON shape; no new table |
| `Sale.event_id` FK + `ticket_breakdown` JSONB | Shipped, `cashup_event` writes Sale + bilagsnummer + audit | **KEEP** — this is the accounting bridge. Bookings call the same Sale-write path on payment-confirmed |
| Public-facing event page (visitor URL) | **None** | **BUILD-NEW** — `GET /e/{slug}` unauthenticated, mobile-first, SSR meta for FB unfurl |
| Self-service ticket purchase flow | **None** | **BUILD-NEW** — 3-step funnel: pick tickets → contact info → pay. Guest checkout, no account required |
| Booking entity (pending → paid → attended → refunded) | **None** | **BUILD-NEW** — net-new `bookings` table. Sale row created only when payment confirms |
| Capacity management | **Half-shipped** — has total intent but no sold-counter | **EXTEND** — atomic decrement via `SELECT ... FOR UPDATE` on payment-confirmed |
| Add-ons / upsells | **None** | **BUILD-NEW** — new `addons` JSONB column on Event |
| MobilePay end-customer payments | **MOCK + Erhverv settlements-read only** (Task #71) | **BUILD-NEW** — MobilePay Online Payments (formerly Vipps eCom). Distinct API surface, distinct OAuth scope, distinct webhook |
| Card / Dankort via Stripe | **Subscription-only.** `stripe_billing.py` handles BonBox plan checkout | **EXTEND** — Stripe Payment Intents path with Connected Accounts (Stripe Express) so Sudip's money lands in Sudip's bank |
| Apple Pay | **None** | **BUILD-NEW** — trivial once Stripe Payment Intents land (Apple Pay is a payment method on PI; no separate integration) |
| Confirmation email + QR ticket | **None.** Postmark Outbound exists (daily brief, invoice send) | **BUILD-NEW** — reuses `email_service.py`. QR generation: server-side `qrcode` lib → embed PNG in HTML email + render on `/t/{ticket_id}` page |
| Door check-in / scan | **None** | **BUILD-NEW** — PWA-camera scan endpoint, idempotent on scan |
| Bilagsnummer + Sale auto-creation on paid booking | **Half-ready** — `voucher_service.allocate_voucher` works; `cashup_event` writes the Sale | **EXTEND** — pull inner "build Sale row" logic into `services/booking_to_sale.py` so the webhook handler reuses it |
| MOMS handling on bookings | **Half.** `Event.is_tax_exempt` stamps `Sale.is_tax_exempt` | **EXTEND** — booking-confirmed must respect this; refunds need kreditnota chain |
| Customer email collection / GDPR | **None** | **BUILD-NEW** — `event_customers` table (one row per unique email per organizer). Explicit consent checkbox at checkout |

**Headline honesty:** the *accounting back-end* is mostly ready — bilagsnummer, audit, MOMS, Sale-tagging-by-event are all live. The **payments-in** and **public-facing surface** are net-new and the gnarly part. Don't pitch this as a 2-week build.

---

## 2. The tier matrix (v2 — Manoj override applied)

> **Manoj locked this at the binary level:** for event-booking features specifically, there is NO distinction between Starter and Pro. Free is constrained; Starter and Pro are identical.

| Capability | Free | Starter & Pro |
|---|---|---|
| Create event (cash-up only — existing flow) | ✓ (1/mo cap) | ✓ unlimited |
| Publish a public bookable event page | **1 / month** | ✓ unlimited |
| Max tickets sold per event | **30** | **unlimited** |
| MobilePay accept-payments | ✓ (mandatory — no payments = no value) | ✓ |
| Card / Dankort via Stripe | **OFF** | ✓ |
| Apple Pay | **OFF** | ✓ |
| Add-ons / upsells | **OFF** | ✓ unlimited |
| Custom cover image upload | ✓ (1 image, 5 MB) | ✓ |
| Custom branding (logo, accent within doctrine palette) | **OFF** | ✓ |
| QR code email + scan | ✓ | ✓ |
| Per-tier capacity | ✓ | ✓ |
| Customer email collection + post-event outreach | **OFF** | ✓ |
| Multi-language event page (DK + EN) | DK only | ✓ DK + EN |
| Refund / kreditnota chain | ✓ | ✓ |
| Platform fee BonBox takes on ticket sales | **0 DKK v1** | **0 DKK v1** |

**Free philosophy.** 1 public event/month with a 30-ticket cap is the visceral upgrade trigger. Past 30 sold tickets, the next visitor sees: *"Dette arrangement er fuldt booket. Arrangøren kan opgradere for at åbne flere pladser."* — L10 honest, Sudip sees the upgrade nudge in BonBox.

**Pro vs Starter for events:** **identical.** Pro becomes worth it for the rest-of-product (branches, team users, customer outreach segmentation outside events, etc.). The event feature is not the wall.

**Platform fee = 0%** in v1. Argument: MobilePay (~0.45% + 0.75 DKK) and Stripe (1.4% + 1.80 DKK) already take 2-4% of a small ticket. Adding 1% from BonBox makes a 150-kr ticket lose 6+ kr to fees. Conversion killer. Revisit in v2 as an opt-in Pro-tier revenue share if/when BonBox adds paid promotion features.

---

## 3. Sudip's day — end-to-end happy path

**Monday morning.** Sudip wants to host "Nepali Movie Night #14 — Lakhey".

He opens BonBox on iPhone. `/events` already has the EntryCard pattern. He taps **"Plan event"**.

The `EventCreatePage` is a doctrine-compliant `PageShell` with one EntryCard form:

| Field | Primitive | Notes |
|---|---|---|
| Event name | `<Input>` | "Nepali Movie Night #14 — Lakhey" |
| Date + start time | Date + time `<Input>` | Default: 7 days out, 18:00. Europe/Copenhagen |
| End time | `<Input>` | Default: start + 3h |
| Venue | `<Input>` | Free text + autocomplete from past events |
| Cover image | `<FileInput>` | 1 image, 16:9 preferred, JPEG/PNG ≤5 MB, Supabase Storage |
| Ticket tiers | `<Chip>` repeater | Pre-populated: "Voksen 150", "Studerende 100", "Barn 50" |
| Add-ons (optional) | `<Chip>` repeater | "Nepali momo plate +60", "Chai +20" |
| MOMS-fri toggle | `<Chip>` | Default OFF. Tooltip: *"Slå til hvis arrangementet er undtaget MOMS efter Momsloven §13 (kulturelle aktiviteter). Spørg din revisor."* |
| Make publicly bookable | `<Chip>` toggle | Default ON for Starter+; OFF for Free past their 1/mo cap |
| Booking window | Two date inputs | Default: opens immediately, closes 1h before start |

Submit → `POST /api/events` + `POST /api/events/{id}/publish` if "Make publicly bookable" is on. Publish endpoint runs L7 fail-closed cap check.

The EventCard shows `● Live` pill (gray with green dot, doctrine status pattern) + **Copy link** button: `https://bonbox.dk/e/nepali-movie-night-14-lakhey-7k4q` (slug = kebab-name + 4-char random suffix).

He pastes it into Facebook. Link unfurls with cover image as Open Graph preview (server-side meta tags).

**24 hours later.** 47 bookings in. Dashboard shows:
> Nepali Movie Night #14
> ● Live · 47 / 80 booked · 6.450 kr forventet · 3 dage til

**Event day, evening.** Sudip at door. Opens BonBox PWA. Taps QR scanner. Camera opens. Scans tickets → green tick → `attended` flag. Walk-ins via existing `EventCashupModal`.

**Three hours after.** Auto-settled:
> Nepali Movie Night #14 — closed
> 47 pre-bookings · 8 walk-ins · 8.250 kr brutto
> Bilag S-2026-0143 til S-2026-0150 oprettet
> MOMS deklareret: 1.650 kr (25%)

**End of quarter.** `/tax/filing-pdf` pulls ticket revenue with sequential bilagsnumre. Provenance footer: `Event booking #B-2026-0451 · MobilePay #mp_1ABxKn... · paid 2026-03-12`. Revisor sees the audit chain, signs off.

**Zero DMs. Zero "did you transfer MobilePay?". Zero spreadsheet reconciliation. Forty-seven hours of his life back per year.**

---

## 4. The "more dramatic" public event page

This is where the brief's "premium feel" lives. The visitor lands from a Facebook click on their phone. The page has **3.4 seconds** to convince them to tap "Book".

### Layout (mobile-first, 390px viewport)

```
[hero image — 16:9 cover photo, full-bleed]

NEPALI MOVIE NIGHT #14         <- H1, text-[28px] font-semibold tracking-tight
Lakhey · A Kathmandu Classic   <- H2 subtitle (optional)

● Lørdag 13. juni · 18:00–21:00   <- gray-700 metadata strip
● Bremen Teater, Frederiksberg
● 47 af 80 pladser booket          <- only when sold ≥ 25%

──────────────────────────────────

Om arrangementet                 <- H2
[event.notes rendered as markdown, gray-700 body]

──────────────────────────────────

Vælg billet                      <- H2
[ ● Voksen        150 kr  -  + ]   <- qty stepper, doctrine chips
[ ● Studerende    100 kr  -  + ]
[ ● Barn           50 kr  -  + ]

Tilføj (valgfrit)                <- H3
[ ● Nepali momo plate  +60 kr  -  + ]
[ ● Chai               +20 kr  -  + ]

──────────────────────────────────

I alt:  450 kr                    <- sticky bottom on mobile
[Reservér →]                      <- bg-gray-900, full-width sticky CTA
```

### Doctrine compliance

- **No rainbow.** Cover photo is the only color moment. Page chrome = locked 13-token palette.
- **Premium restraint over urgency theater.** Capacity progress *only when true* (L10 honest). Never "5 people are viewing this right now."
- **Typography hierarchy carries the drama.** Linear / Vercel Geist pattern — gray hierarchy + great photo + great typography = premium. No colored callouts.
- **Cover image is the only "decoration"** and it's signal. Supabase Storage `event-covers/` bucket, public-read ACL.

### Steal vs reject

| Reference | Steal | Reject |
|---|---|---|
| Eventbrite | Strong sticky-bottom mobile CTA. Progressive enhancement | Their cluttered side-rail, "Lots of demand!" dark patterns |
| Tito | Minimalist event pages, gray hierarchy, "no logo on event page" aesthetic | Assumption everyone has a 1080×1080 brand mark |
| Resmio | Honest capacity ("3 tables left"), good DK localization, MobilePay-first checkout | Their dense table-grid UI; we have one event |
| AirBnB Experiences | Hero image dominance, "About the host" tile (Pro: short organizer bio) | Their map block (too heavy); link to maps.google.com instead |
| Pleo | Polish of the organizer-side `/events/{id}` dashboard chrome. Activity sidebar pattern for live "47 booked" feed | Pleo's expense-first IA (doesn't apply) |

### Link unfurl (Facebook/Messenger preview)

FastAPI route `GET /e/{slug}` returns HTML with OG/Twitter meta + `<noscript>` fallback + JS client-side render. ~80 LOC, bypasses SPA-crawler problem. FB scraper sees cover image, title, description.

Required meta:
```
og:title = "Nepali Movie Night #14 — Lakhey"
og:description = first 160 chars of event.notes
og:image = event.cover_image_url (HTTPS, ≥1200×630)
og:url = canonical URL
twitter:card = summary_large_image
```

---

## 5. Architecture & data model

### 5.1 New tables

```sql
-- Booking is the durable record across pending → paid → attended.
-- Created on checkout start (status='pending'), promoted on
-- payment-webhook-confirmed (status='paid', sale_id populated),
-- terminal at 'attended' (door scan) or 'refunded' (kreditnota).
CREATE TABLE IF NOT EXISTS bookings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  organizer_user_id     UUID NOT NULL REFERENCES users(id),  -- denormalized for tenant filter
  customer_email        VARCHAR(255) NOT NULL,
  customer_name         VARCHAR(160) NOT NULL,
  customer_phone        VARCHAR(40),
  customer_consent_marketing BOOLEAN NOT NULL DEFAULT FALSE,
  ticket_lines          JSONB NOT NULL,  -- [{label, qty, unit_price_dkk}]
  addon_lines           JSONB,            -- [{label, qty, unit_price_dkk}]
  total_amount_dkk      INTEGER NOT NULL CHECK (total_amount_dkk >= 0),
  currency              VARCHAR(3) NOT NULL DEFAULT 'DKK',
  is_tax_exempt         BOOLEAN NOT NULL DEFAULT FALSE,
  status                VARCHAR(20) NOT NULL CHECK (
    status IN ('pending','paid','attended','refunded','cancelled','expired')
  ),
  payment_provider      VARCHAR(20),     -- 'mobilepay'|'stripe'|null
  payment_provider_ref  VARCHAR(120),    -- UNIQUE indexed
  paid_at               TIMESTAMPTZ,
  sale_id               UUID REFERENCES sales(id) ON DELETE SET NULL,
  refund_sale_id        UUID REFERENCES sales(id) ON DELETE SET NULL,
  attended_at           TIMESTAMPTZ,
  attended_scanner_user_id UUID REFERENCES users(id),
  idempotency_key       VARCHAR(64) UNIQUE,
  is_deleted            BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bookings_event ON bookings(event_id, status);
CREATE INDEX idx_bookings_organizer ON bookings(organizer_user_id, created_at DESC);
CREATE INDEX idx_bookings_pending_expiry ON bookings(expires_at) WHERE status = 'pending';
CREATE INDEX idx_bookings_payment_ref ON bookings(payment_provider, payment_provider_ref) WHERE payment_provider_ref IS NOT NULL;

-- One row per (organizer, unique email).
CREATE TABLE IF NOT EXISTS event_customers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email                 VARCHAR(255) NOT NULL,
  name                  VARCHAR(160),
  phone                 VARCHAR(40),
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  bookings_count        INTEGER NOT NULL DEFAULT 0,
  total_spend_dkk       INTEGER NOT NULL DEFAULT 0,
  marketing_consent     BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (organizer_user_id, email)
);

-- One row per individual ticket. A booking of 4 tickets creates 4 rows.
CREATE TABLE IF NOT EXISTS tickets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id            UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  event_id              UUID NOT NULL REFERENCES events(id),
  tier_label            VARCHAR(40) NOT NULL,
  tier_price_dkk        INTEGER NOT NULL,
  qr_payload            TEXT NOT NULL,  -- JWT signed with TICKET_SIGNING_KEY
  scanned_at            TIMESTAMPTZ,
  scanner_user_id       UUID REFERENCES users(id),
  is_void               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tickets_booking ON tickets(booking_id);
CREATE INDEX idx_tickets_event_scanned ON tickets(event_id, scanned_at);
```

### 5.2 Event table extensions

```sql
ALTER TABLE events
  ADD COLUMN slug                  VARCHAR(80) UNIQUE,
  ADD COLUMN published             BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN published_at          TIMESTAMPTZ,
  ADD COLUMN ends_at               TIMESTAMPTZ,
  ADD COLUMN starts_at             TIMESTAMPTZ,
  ADD COLUMN cover_image_url       TEXT,
  ADD COLUMN subtitle              VARCHAR(255),
  ADD COLUMN bookings_open_at      TIMESTAMPTZ,
  ADD COLUMN bookings_close_at     TIMESTAMPTZ,
  ADD COLUMN capacity_total        INTEGER,
  ADD COLUMN addons                JSONB,
  ADD COLUMN refund_policy         VARCHAR(20) NOT NULL DEFAULT 'organizer'
    CHECK (refund_policy IN ('no_refund','organizer','7day')),
  ADD COLUMN booking_terms_url     TEXT;

CREATE INDEX idx_events_slug ON events(slug) WHERE slug IS NOT NULL;
CREATE INDEX idx_events_published_starts ON events(published, starts_at) WHERE published = TRUE;
```

### 5.3 New endpoints

| Method | Path | Auth | Tier gate | Purpose |
|---|---|---|---|---|
| GET | `/e/{slug}` | public (HTML) | — | SSR meta + event detail |
| GET | `/api/public/events/{slug}` | public | — | JSON for SPA |
| POST | `/api/public/bookings` | public + idempotency_key | — | Create pending booking + payment URL |
| GET | `/api/public/bookings/{id}` | booking-token | — | Poll status post-payment |
| POST | `/api/public/bookings/{id}/cancel` | booking-token | — | Visitor cancels pending |
| POST | `/api/webhooks/mobilepay/payment` | HMAC sig | — | Confirm + write Sale + tickets |
| POST | `/api/webhooks/stripe/payment` | Stripe sig | — | Same for cards/Apple Pay |
| GET | `/api/events/{id}/bookings` | session | Starter+ | Organizer guest list |
| POST | `/api/events/{id}/publish` | session | Starter+ (Free: 1/mo) | Allocate slug, toggle published |
| POST | `/api/events/{id}/unpublish` | session | — | Stop accepting new bookings |
| POST | `/api/bookings/{id}/refund` | session | — | Issue kreditnota + provider refund |
| POST | `/api/bookings/{id}/resend-tickets` | session | — | Re-email |
| POST | `/api/tickets/{id}/scan` | session | — | Door scan; idempotent |
| GET | `/t/{ticket_id}?sig=...` | signed URL | — | Visitor's web ticket |
| POST | `/api/internal/booking-expiry-tick` | X-Cron-Secret | — | Sweep pending expired |

### 5.4 The Booking → Sale bridge

Pull inline logic from `routers/events.py:cashup_event` into `services/booking_to_sale.py::write_sale_from_booking(db, booking) -> Sale`:

1. Resolves `event = booking.event`
2. Constructs `ticket_breakdown = {"kind": "event_booking", "tiers": [...], "addons": [...], "gross": ..., "payment_provider": ..., "provider_ref": ..., "booking_id": str(booking.id), "computed_at": utc_now().isoformat()}`
3. Calls `allocate_voucher(db, organizer.id, "sale", booking.paid_at.year)` for bilagsnummer
4. Writes Sale with `event_id`, `amount`, `payment_method`, `is_tax_exempt`, `ticket_breakdown`, `guest_count`, `voucher_number`
5. Stamps `booking.sale_id = sale.id` + `booking.status = 'paid'`
6. Audit row `booking.paid`

**Called from BOTH webhooks.** One Sale-creation path. Same bilagsnummer chain. Same MOMS handling. Keystone of accountant-grade artifacts.

---

## 6. Payment integration — the real engineering

### 6.1 MobilePay Online Payments (NOT the same as Task #71)

| | |
|---|---|
| Current state | Zero for payment acceptance. Existing `mobilepay.py` is settlements-read. Different API product entirely. Existing mock `payment_provider.py` — discard |
| What it is | MobilePay Online (formerly Vipps eCommerce API) — initiate payment, redirect URL, customer opens app, approves, redirects back |
| Money flow | Sudip's MobilePay Erhverv → his bank T+0/T+1. **BonBox never holds funds** |
| Sudip's fees | ~0.75 DKK + 0.45% per transaction (varies by volume tier) — MobilePay invoices Sudip directly |
| BonBox platform fee | **0% v1** |
| Compliance | Sudip signs the merchant agreement. BonBox = technical integrator under his credentials. No FSA registration for BonBox |
| OAuth scopes | `epayment:write` (initiate), `epayment:read` (status) |
| Webhooks | `payment.completed`, `payment.cancelled`, `payment.expired`. HMAC-SHA256 sig header |
| Settlement | Same-day MobilePay → Sudip's bank |
| Refund | `POST /epayment/v1/payments/{ref}/refund`. We surface as `/api/bookings/{id}/refund` → MobilePay refund + kreditnota Sale (negative amount, `K-2026-NNNN` bilagsnummer) |

**Production access:** sandbox self-serve, prod needs partner-agreement sales-call (2-6 week delay). Plan accordingly.

### 6.2 Stripe Connect Express + Payment Intents

| | |
|---|---|
| Current state | Subscription-only. `stripe_billing.py` does Checkout Sessions for BonBox plan purchases |
| What we add | **Stripe Connect Express.** Each organizer signs up for an Express account during onboarding (~3 min). Tickets via Payment Intents with `transfer_data.destination = <organizer_stripe_account_id>`, `application_fee_amount = 0` (v1) |
| Why Express not Standard | Lowest-friction (Stripe-hosted), BonBox stays the "platform" |
| Money flow | Sudip's Stripe Express balance → his bank T+1/T+2. **BonBox never holds funds** |
| Sudip's fees | Stripe DK: 1.4% + 1.80 DKK on EEA cards; 2.9% + 1.80 DKK non-EEA. Apple Pay no surcharge. Dankort = EEA card |
| BonBox platform fee | **0 DKK v1** |
| Compliance | Stripe Connect with `transfer_data.destination` = funds never touch BonBox's balance. BonBox is platform, not merchant of record. Right legal posture for DK |
| New webhook events | `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`. Use `STRIPE_TICKET_WEBHOOK_SECRET` (separate from sub webhook) |
| Apple Pay | **Free.** Payment method on Payment Intents. Domain verification + Apple Pay button shows on Safari/iOS |
| Dankort | Covered. Native Stripe DK rails. 1.4% rate |
| Settlement | T+1 normal, T+2 for fresh accounts |

### 6.3 Provider selection

Visitor checkout default = MobilePay (DK muscle memory). Tap "Pay with card" → Stripe (Dankort, international, Apple Pay). Both paths land in same Booking row, different `payment_provider`.

**MVP order:** MobilePay first → Stripe Connect second. ~70% DK consumer-to-business under 1,000 DKK is MobilePay. Brief prioritizes it.

**Honest timeline:**
- Phase 2 (MobilePay sandbox → real): ~4-6 weeks incl. sales-call gap
- Phase 3 (Stripe Connect Express): ~2-3 weeks focused work

### 6.4 Webhook idempotency + race conditions

1. `Booking.payment_provider_ref` UNIQUE-indexed. Webhook handler: `SELECT ... WHERE payment_provider_ref = ? FOR UPDATE`
2. If `status='paid'` already → return 200 immediately (idempotent)
3. If `pending` → run `write_sale_from_booking` in same transaction. Commit. Audit
4. If `expired` (swept back) → **rebooking conflict**: apologize, refund the provider, audit `booking.late_payment_refunded`

Visitor polling hides webhook lag: SPA after redirect-back polls `GET /api/public/bookings/{id}?token=...` every 2s for 60s. When status flips to `paid`, render success + QR. If 60s elapses, render "We've received your payment — tickets on the way to {email}."

---

## 7. Multi-barrier 10-layer doctrine (the most security-critical surface)

### L1 — Auth (visitors are guests)
No login. Identity = idempotency key + booking-token (HMAC JWT `{booking_id, exp: now+24h}`). After payment, email = persistent token. Ticket links = `/t/{id}?sig=HMAC` — anyone with the link sees those tickets only.

### L2 — Tenant scope
Every organizer query filters `organizer_user_id = current_user.id`. Webhooks resolve organizer from `booking.organizer_user_id` (denormalized exactly for this).

### L3 — Input bounds
- Max 50 tickets total per booking (anti-bot)
- Per-tier max 50
- Add-ons max 6 distinct lines × 50 each
- Email regex
- Free-text fields max 160 chars, notes max 4 KB

### L4 — Rate limit (per IP)
- `POST /api/public/bookings`: 6/min, 30/hr per IP
- `GET /api/public/events/{slug}`: 60/min per IP
- `POST /api/tickets/{id}/scan`: 120/min per organizer
- Webhooks: no rate limit — providers retry

### L5 — Fail-soft on provider downtime
MobilePay 5xx → 503 with copy + suggest card. Stripe 5xx → same with MobilePay suggestion. Both down → static notice + organizer email visible. Booking stays `pending` so capacity held.

### L6 — Tenant scope on every booking query
IDOR test: visitor trying `GET /api/public/bookings/<UUID-from-someone-else>` returns 404 (not 403 — IDOR convention).

### L7 — Fail-closed on PLAN_FEATURES
- `POST /api/events/{id}/publish`: `enforce_cap(user, "published_events_per_month")`
- `POST /api/public/bookings`: check `Event.published` AND organizer tier allows this many bookings. Free hit 30-ticket cap → 409 with generic "sold out" copy (visitor doesn't see tier limit)

### L8 — Audit trail
Every state transition writes a row:
- `booking.created`, `booking.paid`, `booking.expired`, `booking.refunded`, `booking.scanned`
- `event.published`, `event.unpublished`
- `payment.webhook_received` (one per webhook regardless of action)

### L9 — Fallback / graceful HTTP
Webhook 5xx from us → providers retry. We tolerate up to 4 retries. Idempotent handler swallows duplicates. Deleted event → 410 Gone. Slug collision → retry gen 3× then 500.

### L10 — Honest claims
- Capacity: *"47 af 80 pladser booket"* only when true
- Refund policy surfaced on event page in plain DK + EN
- Email: *"Vi gemmer din email til at sende dig billetter. Marketing-mails kun hvis du sætter kryds nedenfor."* (unchecked by default — GDPR-correct)
- Payment: *"Betaling håndteres af MobilePay. BonBox modtager aldrig dine kortdata."*

---

## 8. Bogføringsloven §10 + tax compliance

### 8.1 Bilagsnummer per Sale, not per ticket
4-ticket booking = 1 Sale row = 1 bilagsnummer. Tickets are line items in `ticket_breakdown.tiers`. Why:
- Audit clarity: one customer, one transaction, one chain
- Refund symmetry: partial refund = kreditnota referencing original bilagsnummer (not 4 kreditnotas)
- Revisor PDF aggregates by Sale row

### 8.2 MOMS handling
Booking inherits `is_tax_exempt` from event. `write_sale_from_booking` stamps `Sale.is_tax_exempt`. Downstream:
- `bookkeeping_export` excludes from MOMS angivelse if exempt, includes in exempt line
- Visitor receipt: *"MOMS-fri arrangement (Momsloven §13)"* OR *"Inkl. moms 25%: 30 kr af 150 kr"*
- **Don't repeat Task #36 MOMS sign bug.** Compute as `amount * 0.25 / 1.25` (gross-incl). Exempt = 0 explicitly

### 8.3 Refund → kreditnota chain
Refund creates new Sale row:
- `amount` = -(refunded) (negative)
- `voucher_number` from kreditnota sequence `K-2026-NNNN`
- `ticket_breakdown.kind = "event_booking_refund"`
- `ticket_breakdown.original_booking_id`, `original_voucher_number`
- Audit `booking.refunded` with kreditnota voucher
- `Booking.refund_sale_id` set, status='refunded'

Partial refunds: same shape, smaller `amount`. Revisor PDF links original + kreditnota.

### 8.4 Foreign customers
Norwegian visiting Copenhagen → B2C service in DK → DK MOMS applies (or exempt per event). Place-of-supply rule for cultural events: where it happens. No special handling needed for tourists.

B2B foreign sales: **v1 punt.** No "company name / VAT" field on booking form. Sudip uses existing faktura flow for B2B (reverse-charge already handled there).

### 8.5 5-year retention
Bookings + Tickets + webhook payloads (in `audit_logs.after` JSON) retained 5 years per Bogføringsloven §10. Extend existing `accounting_retention.py` cron sweep.

### 8.6 Accountant-grade artifact
MOMS angivelse PDF (`tax_filing_pdf.py:build_moms_filing_pdf`) includes ticket-derived Sale rows with same bilagsnummer, doc-hash, signature line, provenance footer:

```
Bilag S-2026-0143 · Event booking #B-2026-0451 ·
MobilePay payment mp_4xyz... · paid 2026-03-12 19:48 ·
Booking source: bonbox.dk/e/nepali-movie-night-14
```

Traceable to specific MobilePay transaction ID. Defensible at SKAT audit 5 years later.

---

## 9. Build phases — realistic 6-12 week timeline

| Phase | Weeks | Scope | LOC |
|---|---|---|---|
| **P1 — Pre-payment foundation** | 1-2 | Event extensions (slug, published, cover_image, addons, capacity). EventCreatePage polish. `GET /e/{slug}` SSR shell + JSON detail. Bookings table + visitor-facing **"manual confirm"** flow (no payment yet — organizer confirms in app). Cover image upload to Supabase Storage. **Sudip can start using this immediately** | ~2,200 |
| **P2 — MobilePay Online Payments** | 3-4 (cal. 4-6 w/ sales-call gap) | Sandbox integration. Webhook handler. `write_sale_from_booking`. Pending → paid state machine. Idempotency. Capacity decrement with `FOR UPDATE`. Pending-expiry cron. Confirmation email + QR | ~1,400 |
| **P3 — Stripe Connect + Apple Pay** | 5-6 | Stripe Connect Express onboarding flow at `/settings/payments`. Payment Intents with `transfer_data.destination`. Second webhook handler. Apple Pay domain verification. "Pay with card" toggle | ~1,100 |
| **P4 — Capacity, add-ons, branding** | 7-8 | Per-tier capacity. Add-on JSONB. Custom branding (logo, accent within doctrine palette). Multi-language event page (DK + EN) | ~900 |
| **P5 — QR check-in + post-event outreach** | 9-10 | Camera-scan PWA endpoint. Door-rush rate-limit. Auto-email "Tak fordi du kom" with optional NPS. Past-attendees list per event | ~700 |
| **P6 — Polish, lint, ship** | 11-12 | Tier-gate audit. Doctrine lint pass. Honest-claims copy review. §10 retention extension. Performance Lighthouse ≥90 mobile. Runbook. Sandbox → prod cutover | ~500 |

**Total: ~6,800 net new LOC. 12 calendar weeks including the MobilePay sales-call gap that runs parallel with P3. Engineering time ~9 weeks; rest is calendar / credentials / approval.**

**Risk dependency:** if MobilePay prod creds slip beyond week 6, ship P1+P3 (Stripe-only) first. Stripe sandbox → prod = 2 days. Launch with card-only initially, MobilePay flips on when approved.

---

## 10. Risks

1. **MobilePay merchant-agreement timeline** (2-6 weeks of sales calls). **Mitigation:** start week 1, parallel P3.
2. **Stripe Connect onboarding friction kills conversion.** **Mitigation:** make Connect onboarding required only at first publish moment.
3. **Refund-storm:** Sudip cancels 200-ticket event. **Mitigation:** background job, idempotent per booking, progress notification.
4. **DK fintech regulation.** With Stripe Connect `transfer_data.destination` + MobilePay merchant-of-record being the organizer, BonBox never holds funds → SaaS platform, not PSP. **Mitigation:** verify with DK fintech lawyer (4-6 hours). Written opinion before launch.
5. **GDPR retention.** Guest checkout collects PII. **Mitigation:** `marketing_consent` gates non-transactional email. Right-to-deletion: redact name/phone but keep email-hash + booking for 5-year financial requirement.
6. **Postmark deliverability.** New domain spam risk. **Mitigation:** SPF + DKIM + DMARC aligned, warm IP, plain-text alternative, PWA "view ticket online" link as backup.
7. **Ticket scalping bots.** **Mitigation:** 6/min/IP + Cloudflare. v2 optional waitlist.
8. **Race condition on capacity.** Two simultaneous bookings for last ticket. **Mitigation:** `SELECT ... FOR UPDATE` inside booking-create transaction. **MUST have a regression test before P2 ships.**

---

## 11. The ship dream

> Sudip opens BonBox on iPhone, taps **Plan event**, fills 5 fields (name, date, venue, ticket tiers, cover photo), taps **Publish**. He copies the link. He pastes it into a Nepali-Danish FB group with his 27k following. Within 90 seconds, the first booking arrives. He gets a push: *"1 ny booking · 450 kr · Sita Sharma."* By Saturday morning, 47 bookings are in BonBox `/events`. Saturday night at the door he opens the QR scanner inside BonBox PWA, scans phones for 30 minutes, closes the door at 80. 8 walk-ins he rings up via the existing cash-up tab. He goes home. Sunday morning — no action needed. Bilag S-2026-0143 through S-2026-0150 in his ledger. MOMS calculated. Each row has a MobilePay transaction ID in the provenance footer. End of quarter, he runs `/tax/filing-pdf`, ticket revenue on the right line, revisor signs off. **Zero DMs. Zero "did you send the MobilePay?". Zero spreadsheet reconciliation. Forty-seven hours of his life back per year.**

---

## 12. Decisions — all locked 2026-05-25 by Manoj

1. ~~**Platform fee on tickets in v1.**~~ **DECIDED:** 0% v1. Revisit Pro-opt-in in v2.
2. ~~**Starter/Pro feature gating.**~~ **DECIDED:** Starter and Pro identical for events. Free is the only constrained tier.
3. ~~**Cover photo storage.**~~ **DECIDED:** Supabase Storage (existing `receipts/`-adjacent infra, new `event-covers/` bucket with public-read ACL).
4. **Merchant of record posture** — **PRECONDITION before any code touches main:** confirm via DK fintech lawyer (4-6 lawyer hours, written opinion). Plan target: organizer as MoR via Stripe Connect Express `transfer_data.destination` + MobilePay merchant agreement. BonBox = platform, never holds funds, no PSP licence needed.
5. ~~**Refund policy default.**~~ **DECIDED:** `'organizer'` default (manual approval per booking). Organizer can override per event to `'7day'` or `'no_refund'`. Matches Sudip's mental model.
6. ~~**Repeat-customer accounts.**~~ **DECIDED:** v1 punt. Guest checkout for v1. v2 wedge as loyalty layer once data justifies.
7. ~~**Multi-language event page.**~~ **DECIDED:** DK + EN at launch. NP deferred to v3 if Sudip's beta data justifies.
8. ~~**Free tier specifics.**~~ **DECIDED:** 1 published event/month + 30 tickets sold/event cap. Past the 30-ticket floor, visitors see *"Dette arrangement er fuldt booket. Arrangøren kan opgradere for at åbne flere pladser."* + organizer sees an inline upgrade nudge in BonBox.

**Hard precondition remaining:** the DK fintech lawyer opinion on #4. **No payment-acceptance code lands without it.** Phase 1 (no-payments-yet manual-confirm flow) can ship in parallel with the legal review since it doesn't move money.

---

## TL;DR for the engineer

- **New tables:** `bookings`, `event_customers`, `tickets`. Migrations added to `_migrations` in `backend/app/main.py`
- **Event extensions:** slug, published, cover_image_url, starts_at, ends_at, capacity_total, addons, refund_policy
- **New service:** `services/booking_to_sale.py::write_sale_from_booking`
- **New routers:** `routers/public_events.py`, `routers/public_bookings.py`, `routers/event_payments.py`, `routers/tickets.py`. Extend `mobilepay.py` or add `routers/mobilepay_payments.py`; new card webhook on `stripe_billing.py`
- **New services:** `services/mobilepay_payments_client.py` (epayment scope), `services/stripe_connect.py`, `services/qr_signer.py`, `services/booking_expiry.py`
- **New frontend pages:** EventCreatePage extend, EventDetailOrganizer extend, EventPublicPage (NEW), BookingCheckoutPage (NEW), BookingSuccessPage (NEW), TicketPage `/t/{id}` (NEW), DoorScanPage (NEW)
- **New PLAN_CAPS:** `published_events_per_month`, `bookings_per_event_max_free`
- **New PLAN_FEATURES:** `event_payments_card`, `event_addons`, `event_custom_branding`, `event_multilang` — all set Starter=Pro=true, Free=false per Manoj's lock
- **Doctrine:** 13-token palette only on public event page. Cover image is the only color moment. Sticky CTA = `bg-gray-900`
- **DK terminology lock:** revisor, MOMS, bilagsnummer, faktura, kreditnota, Momsloven §13, Bogføringsloven §10 stay Danish in all UI
- **Multi-barrier 10-layer:** every endpoint per §7. Webhook `payment_provider_ref` UNIQUE pattern non-negotiable

**Ship Phase 1 first.** Manual confirmation flow replaces 80% of Sudip's FB-DM-to-MobilePay loop on its own. Don't try to ship all six phases at once.

*Last updated: 2026-05-25*
