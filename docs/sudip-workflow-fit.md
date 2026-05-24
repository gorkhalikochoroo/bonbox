# Sudip Workflow-Fit — Gap Analysis & Design Spec

**Status:** Strategy doc, 2026-05-24. Not committed. Reference before pitching Sudip.
**Author:** Synthesized for Manoj from Sudip's verbatim workflow (Nepali/English, 2026-05-24).
**Audience:** Manoj (founder/builder), future Sudip-shaped prospects.

Sudip runs a Nepali community film/event business in Denmark. He's the canary for the "owner who never touches his own books" segment — high revenue, low accounting comfort, deeply trusts his revisor.

---

## 1. Workflow-by-Workflow Mapping

| # | Sudip's Step | Covered? | Current State | What Hurts | Effort |
|---|---|---|---|---|---|
| 1 | **Bank ↔ accountant via PSD2 + MitID re-auth/6mo** | Partially | `bank_connect.py` (850 LOC): full Aiia OAuth, `consent_expires_at`, `sandbox_mode=True` default. Sandbox-only; no prod creds. Reconciliation parked in `passive-auto-capture-spec.md`. Fallback: manual CSV via `/bank-import`. | Sudip expects "set once + accountant sees it" — manual CSV breaks that. Sandbox state is a credibility risk if not surfaced. | **L** — UI exists; gap is prod credentials + reauth UX. Code ~1 wk, creds is the rate-limit. |
| 2 | **Receipt forwarding to unique inbox** | No | `smart_scan.py` + `smart_scan_service.py` handle in-app upload (Claude Vision → `/expenses`). No SMTP-inbound surface; no per-user alias. | Sudip's muscle memory is `Forward → send`. App context-switch is friction he avoids. Highest-leverage gap. | **M** — Postmark inbound + reuse OCR pipeline. ~1 wk. See §2. |
| 3 | **"Tell accountant to invoice X to Y"** | Yes, different shape | `invoices.py` full self-serve: sequential `fakturanummer`, `InvoiceService.create_draft`, send + kreditnota. Starter=30/mo, Pro=unlimited. | Sudip's input is conversational. Self-serve UI is objectively better but is a behavior change — needs a "tell BonBox" wedge. | **S** — Self-serve exists. Chat-input wedge ~3 days. See §3. |
| 4 | **"I don't see my own books"** | Yes — INVERTED | `accountants.py` (683 LOC) read-only revisor moat. `ACCOUNTANT_ALLOWED_WRITE_PATHS` middleware blocks every write for accountant sessions. L1–L6 in place. | Risk is adoption, not feature gap. See §4 for hardening. | **S** — Polish only. |

**Headline:** Steps 1, 3, 4 are mostly there. Step 2 (forwarding inbox) is the single biggest gap and the most behaviorally important one. Build it.

---

## 2. The Biggest Gap — Receipt-Forwarding Email Inbox

Sudip's current address looks like `sudip-xyz@receipts.accountant.dk`. We need parity.

### a) Address Scheme

`<short>-<random>@in.bonbox.dk` — e.g. `nepali-7k4q@in.bonbox.dk`. `<short>` = 6 chars of slugified `business_name`; `<random>` = 4 chars base32 (~1M space, guessing-resistant). One per user (not per branch v1), stored on `users.inbox_alias`. `POST /inbox/rotate` invalidates old; old keeps receiving 14 days during cutover.

### b) Email-Receiving Infrastructure: **Postmark Inbound**

Pick: **Postmark Inbound** — signed JSON webhook, EU servers, DKIM/SPF parsed for us, attachments as URLs, $1.25/1k, DPA available. Rejected: SES (needs S3+Lambda+manual SPF), Mailgun (similar but worse EU story), Cloudflare Email Routing (forward-only, no webhook). Blobs are re-encrypted at our side regardless of vendor.

### c) Pipeline

```
Email → Postmark MX → POST /api/inbox/postmark-webhook
  → resolve alias → user_id (FK on users.inbox_alias)
  → SPF/DKIM/DMARC check (Postmark-filled)
  → persist email_messages (status='received')
  → per-attachment: MIME allowlist (image/*, pdf), 10 MB cap, sha256,
    Fernet-encrypt to /uploads/receipts/, insert receipt_intake,
    enqueue OCR via existing parse_expense_receipt
  → OCR success → Expense(status='draft', source='inbox')
  → low confidence → Expense(status='needs_review')
  → push: "1 new receipt to confirm"
  → owner taps → existing /expenses Review → Confirm
```

**Reuse**: `smart_scan_service.route_and_extract` already does the receipt path. Inbound webhook is a thin shim feeding bytes to the same function. No new OCR code.

### d) Anti-abuse + Security

- **SPF/DKIM/DMARC**: reject when any fail AND sender not in user's allowlist.
- **Per-user allowlist** (Starter+): outside-allowlist mail lands in a review lane with banner *"From unknown sender — confirm before posting."*
- **Rate limit**: 200/day per `user_id`. Above cap: status=`throttled`, daily digest, never silently dropped.
- **PII**: Bogføringsloven §10 — original PDF + email body encrypted at rest with Fernet (`config.SECRET_KEY` exists). Decrypted blob only over authenticated `/expenses/{id}/receipt` stream.
- **Retention**: 5 years (Bogføringsloven) for confirmed; 30 days for spam/rejected.
- **Anti-enumeration**: unknown-alias hits return 200 (Postmark won't retry) and log to `inbox_orphans`.

### e) Multi-barrier (10 layers) — `POST /api/inbox/postmark-webhook`

| L | Implementation |
|---|---|
| 1 auth | Postmark Basic Auth secret, constant-time. 401 if missing. |
| 2 bounds | 30 MB body, 10 attachments/email, image/* + pdf only, 100 KB body_text cap. |
| 3 rate | 5/sec global; 200/day per resolved user. |
| 4 fail-soft | Per-attachment try/except. One bad PDF never kills the email. Always 200. |
| 5 tenant | Alias → user_id; downstream stamped. Unknown alias = orphan log. |
| 6 fail-closed | `inbox_enabled=False` or deleted user → drop attachments, log, no OCR. |
| 7 audit | `inbox.received` row per email; `inbox.expense_drafted` per draft. |
| 8 fallback | OCR fail → Expense with `description="From <subject>"`, amount blank. Never lose the receipt. |
| 9 graceful | Always 200 (no retry storms). Body distinguishes `accepted/drafted/throttled/rejected`. |
| 10 honest | Free UI says "5 receipts/mo via inbox"; toast *"Receipt forwarded — review the draft"*, never "auto-posted". |

### f) Tier Strategy

```python
PLAN_FEATURES:
  inbox_email_capture:    {free: T, starter: T, pro: T}
  inbox_allowlist:        {free: F, starter: T, pro: T}
  inbox_custom_domain:    {free: F, starter: F, pro: T}   # receipts@your-biz.dk via CNAME
  inbox_per_branch_alias: {free: F, starter: F, pro: T}
PLAN_CAPS:
  inbox_messages_per_month: {free: 5, starter: -1, pro: -1}
  inbox_aliases:            {free: 1, starter: 1,  pro: 5}
```

Free = taste (5/mo); past cap, messages still arrive but quarantine with a 402 banner — held 30 days so upgrade restores them. **Never dropped** (L10 honest-claims). Starter (the workhorse) = unlimited + allowlist. Pro adds custom domain + per-branch aliases.

### g) UX Flow

**Discovery:** (a) onboarding step 3 ("Your receipt inbox" — big mono-font + copy + "Send test email"); (b) ConnectionsPage card with status dot; (c) ExpensesPage dismissable banner showing the alias; (d) `bonbox://share-receipt` deep-link in iOS/Android Share sheet.

**Confirmation:** push *"1 receipt from Nemlig — 247 DKK"* → tap → draft expense → Confirm. Low-OCR case: *"1 receipt waiting (couldn't read amount)"* → owner types it.

### h) Database Schema Deltas

```sql
ALTER TABLE users
  ADD COLUMN inbox_alias VARCHAR(40) UNIQUE,
  ADD COLUMN inbox_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN inbox_alias_rotated_at TIMESTAMPTZ;
CREATE INDEX ix_users_inbox_alias ON users(inbox_alias) WHERE inbox_alias IS NOT NULL;

CREATE TABLE email_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  alias VARCHAR(40) NOT NULL,
  from_addr TEXT NOT NULL,
  subject TEXT, message_id TEXT, body_text_hash CHAR(64),
  spf_pass BOOLEAN, dkim_pass BOOLEAN, dmarc_pass BOOLEAN,
  attachment_ct INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN (
    'received','queued','processed','quarantined',
    'throttled','rejected','orphan')),
  reason TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (alias, message_id)  -- L9: idempotency
);
CREATE INDEX ix_em_user_status ON email_messages(user_id, status);

CREATE TABLE receipt_intake (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_message_id UUID REFERENCES email_messages(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,  -- Fernet-encrypted blob
  filename TEXT, mime_type TEXT, byte_size INTEGER,
  sha256 CHAR(64) NOT NULL,
  ocr_status TEXT NOT NULL DEFAULT 'queued',
  ocr_confidence REAL,
  expense_id UUID REFERENCES expenses(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_ri_user_status ON receipt_intake(user_id, ocr_status);
```

### i) API Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/inbox/postmark-webhook` | Postmark basic | Inbound; always 200. |
| GET | `/api/inbox/me` | session | `{alias, enabled, messages_this_month, cap, allowlist}`. |
| POST | `/api/inbox/rotate` | owner | Old alias usable 14d. 1/day. |
| PATCH | `/api/inbox/settings` | session | `{enabled, allowlist[]}`. Allowlist Starter+. |
| GET | `/api/inbox/messages` | session | Paginated `email_messages` for diagnostics. |
| POST | `/api/inbox/test` | session | Self-test forward from `noreply@in.bonbox.dk`. 5/day. |

### j) Failure Modes

| Failure | Surfacing |
|---|---|
| Bounce (unknown alias) | Postmark auto-bounce; no owner notification. |
| Oversized (>10 MB) | `rejected`; push *"Receipt too big — reply smaller or upload via app."* |
| Unsupported MIME | HEIC accepted (iOS), DOCX rejected. Digest entry, no push. |
| OCR low confidence | Expense draft `needs_review`, values blank, owner notified. No silent post. |
| Spam (DKIM/SPF/DMARC fail) | `quarantined`; visible in `/inbox/messages`. Never auto-drafted. |
| Cap exceeded (Free) | `throttled` + 402 banner *"5/5 used this month — receipts are saved."* |

---

## 3. The "Invoice by Request" Gap

**Honest read:** verbal instruction is a workaround for not trusting a self-serve UI, not a real preference. Sudip is Facebook-savvy (27k audience) and will switch if the UI is calm. **Recommend Option C layered on top of A.**

- **A — Self-serve only (current):** keep as foundation. Power-user OK; not the right primary surface for Sudip.
- **B — Hybrid (owner drafts, revisor sends):** **Reject.** Adds write permissions on the revisor side, breaks the read-only moat from §4.
- **C — "Tell BonBox" chat:** **Pick.** Conversational input → AI extracts `{amount, customer, description, due}` → fills existing `InvoiceService.create_draft` → owner taps Confirm + Send. Same audit trail; different door.

**Minimal build:** new `POST /api/agent/draft-invoice-from-text` reusing `app/services/agent.py` + customer fuzzy-match. Returns a draft (status=`draft`, never auto-sends). New mobile chat input → opens existing FakturaReviewPage. ~3 days, no DB changes. Multi-barrier inherited from `create_invoice` L1–L10.

Pitch line: *"Type one sentence. Confirm. Sent."*

---

## 4. The "I Don't See My Own Books" Gap — Already Inverted

Moat is real and well-coded: `AccountantGrant` model, `_require_real_owner`, `ACCOUNTANT_ALLOWED_WRITE_PATHS` middleware, 7-day invite TTL, full audit on grant create/revoke/login.

**Three polish items before pitching:**
1. Confirm revisor invite email lands in Danish by default (`_invite_email_html` already switches on `is_danish` — verified).
2. **"Export-on-revoke"**: auto-ZIP of last 12 months' accountant-grade artifacts to the owner when a revisor grant is revoked. Prevents "books walked out the door" panic. ~2 days.
3. **Revisor health badge**: *"Revisor sidst logget ind: 3 dage siden"* on owner home. Trust signal. ~½ day.

---

## 5. MitID Erhverv Re-Auth — The Calmest Possible UX

Aiia consent expires every 90-180 days; re-auth requires MitID. `consent_expires_at` is already stored.

- **T-14**: silent log.
- **T-7**: yellow Dashboard + Connections banner *"Bank reauth needed in 7 days. 60 sec with MitID — [Re-authorize now]."* Picked up by Daily Brief email.
- **T-3**: single push + email.
- **T-1**: red banner; card flips to `pending`.
- **T+0**: card → `disconnected`; manual CSV surface comes forward; sync halts.
- **Reauth UI**: one button → `/api/bank-connect/init?is_reauth=true` → MitID → callback extends `consent_expires_at`.
- **Sandbox honesty**: every bank card carries a *"Aiia · Sandbox — coming soon"* chip until prod creds land. `ConnectionsPage.jsx` already has `comingSoonNote` support.

Effort: ~3 days (expiry cron + banners + button wiring).

---

## 6. Quick Wins — Next 1-2 Weeks (Pre-Sudip Pitch)

Build only what changes Sudip's first-week experience:

1. **Receipt-forwarding inbox (§2) — MVP, Starter-only.** Postmark webhook + alias gen + onboarding card. No allowlist/custom-domain/per-branch (v0.2). Single highest-leverage gap. **~5-7 days.**
2. **"Tell BonBox" invoice draft (§3).** Chat input + AI extraction → existing draft path. Demos on a 2-min Messenger video. **~3 days.**
3. **MitID re-auth UX + Aiia sandbox honesty chip (§5).** Trust signal; Sudip will notice the sandbox state himself if we don't surface it. **~3 days.**

**Park:** passive auto-capture spec — that's the café/restaurant shape, not Sudip's (event-organizer is already served by the ticket-sheet cash-up shipped this week).

---

## 7. The Pitch to Sudip (5-Bullet Messenger Draft)

### English

> Bro, I've been studying your workflow and I built BonBox to match how YOU actually work, not how accountants want you to work. Quick rundown:
>
> 1. **Forward any receipt to your own BonBox inbox** — same as what you do today with your accountant, except now YOU own the data. Snap, forward, done. Confirm in the app when you have a minute.
> 2. **Send an invoice by typing one sentence** — "Send 5000 to Cinemateket for July screening" → BonBox drafts it, you tap Confirm, customer gets the faktura. No forms.
> 3. **Your revisor logs in with their own password and only sees, never edits.** You stay in control; they get everything they need. (We're calling them "revisor" — keeping it Danish.)
> 4. **Bank auto-sync via Aiia is plumbed but on sandbox until our prod credentials clear — I'm being upfront about that.** Until then, monthly CSV upload works. You won't notice the difference for tax season.
> 5. **Everything that goes to your revisor is built for revisor-grade audit** — sequential bilagsnummer, doc-hash, Bogføringsloven §10 footer. Same quality whether you're on free or paid.
>
> Want me to set you up with the early access? 20 min over a call, I walk you through your inbox address and we test it live.

### Nepali Notes for Manoj

- Lock Danish terms in any translation: `revisor`, `faktura`, `bilagsnummer`, `MOMS`, `MitID`.
- Bullet 1: frame as *"timi le jasari aafno revisor lai pathauchau, tehi tarika"* ("the way you already send to your revisor").
- Bullet 4: lead with **honesty** — the "being upfront about sandbox" line lands harder than polish; Manoj's 27k-audience credibility depends on not over-promising.
- Bullet 5: drop "accountant-grade audit" jargon; say *"revisor le jun document maag-cha, BonBox bata aauchha"*.
- Closer: *"Yo product tapai jastai owners ko lagi banaako ho — tapai feedback nai feature roadmap banauchha."*

**Don't pitch what isn't built.** Bullets 1-4 + sandbox honesty are the entire pitch. Skip passive auto-capture, multi-branch, Pro. The pitch wins by being exactly what he'd touch week one.

---

## Appendix — File Path Index

- OCR pipeline (reuse): `backend/app/services/smart_scan_service.py`, `services/receipt_ocr.py`, `routers/smart_scan.py`
- Expense draft target: `backend/app/routers/expenses.py`
- Faktura draft target: `backend/app/routers/invoices.py:96` (`create_invoice`)
- Revisor moat: `backend/app/routers/accountants.py`, `backend/app/main.py` (ACCOUNTANT_ALLOWED_WRITE_PATHS)
- Aiia/MitID expiry: `backend/app/routers/bank_connect.py:154`
- Billing: `backend/app/services/billing.py` — `:118` PLAN_CAPS, `:295` PLAN_FEATURES, `:946` enforce_cap, `:972` enforce_feature
- Audit: `backend/app/services/audit_service.py:47`
- Connections UI: `frontend/src/pages/ConnectionsPage.jsx`
- Adjacent parked spec: `docs/passive-auto-capture-spec.md`
