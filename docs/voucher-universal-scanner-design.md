# Universal voucher/code scanner + owner gavekort generation — design

> Status: **DESIGN** (expert panel + Claude design pass, 2026-06-27). Not built.
> Scope: one door scanner that recognises **gavekort · reservation · ticket · promo**, routes each to the right action, plus owner-side **generation + tracking + linking**. Built on top of the existing `DoorScanPage` / `qr_signer`.

## 0. Two findings that shape everything

1. **A working door scanner already exists** — `DoorScanPage.jsx` + jsQR + the idempotent `POST /api/tickets/{id}/scan`. This is a **generalization**, not a green-field build.
2. **There is a live P0 MOMS hole in gavekort today.** Gavekort is only a line-item in the daily close (`gift_cards_sold`) — no balance, no redemption. When a gavekort is *spent*, the goods bought with it never enter `revenue_total`, so **salgsmoms on them is silently unreported.** The stored-balance ledger below closes this.

---

## 1. Universal code scheme

### Envelope (machine QR)
Every BonBox QR is a typed, signed envelope:

```
BB1.<family>.<jwt>
```
- `BB1` — scheme magic + version; rejects foreign QRs (Wi-Fi/vCard/URLs) in O(1).
- `<family>` — `T` ticket · `R` reservation · `G` gavekort · `P` promo. **Routing hint only — NOT trusted.**
- `<jwt>` — HS256 JWT. Its `sub` claim is **authoritative** and is covered by the signature.

The prefix only picks which verifier/key to try first (no 4× trial-decode on a 60fps loop). A stripped prefix degrades to bare-JWT trial-decode.

### `sub` registry
| Family | Prefix | `sub` | Signing key (env) | Status |
|---|---|---|---|---|
| Ticket | `T` | `bonbox-ticket` | `TICKET_SIGNING_KEY` | exists |
| Reservation | `R` | `bonbox-resv` | `RESV_TOKEN_KEY` | new |
| Gavekort | `G` | `bonbox-gavekort` | `GAVEKORT_SIGNING_KEY` | new |
| Promo | `P` | `bonbox-promo` | `PROMO_SIGNING_KEY` | new |

Distinct key per family is existing doctrine (`qr_signer.py:17-20`). **Value claims carry `uid` + `jti`** (`{gid, sub, uid, jti, iss, exp}`): `uid` = pre-DB cross-tenant reject; `jti` = idempotency anchor. **No balance ever in the token.**

### Routing decision tree
```
raw string → classify()
  ├ "BB1." → family hint + jwt
  ├ 2 dots + looksLikeJwt → bare_jwt (trial-decode)
  ├ "http"+BONBOX_HOST → extract token → re-enter
  ├ short code (GK-/PR-/BX-/#hex) → manual lane
  └ else → REJECT "Ukendt kode"
verify_<fam>(jwt) → claims | None(→reject)
CROSS-CHECK prefix.family == claims.sub ?  ← anti-collision keystone (mismatch = tampered + security audit)
ROUTE on claims.sub (authoritative):
  ├ ticket → consume (idempotent check-in)
  ├ resv   → POST /reservations/{rid}/checkin (→ "seated")
  ├ gavekort → GET /gavekort/{gid} (SHOW balance — redeem is a SEPARATE tap)
  └ promo  → POST /promo/validate (attach to open bill)
```
Trial-decode order `T→R→G→P` puts money paths last.

### Manual entry (mandatory)
Permanent footer "Indtast kode manuelt". Human codes use Crockford base32 + mod-37 check char (fails a typo locally).
| Type | Format | Example |
|---|---|---|
| Gavekort | `GK-XXXX-XXXX-C` | `GK-7Q4F-9H2T-K` |
| Promo | `PR-`+campaign | `PR-SOMMER26` |
| Ticket | `BX-XXXX-XXXX-C` | `BX-3M5K-8P1Q-R` |
| Reservation | `#`+8 hex | `#6F58B6CE` |

---

## 2. Door flow (redemption side)

Returning owner: the **camera IS the screen** (auto-arm, no "Start scanner"). One result card, three glance-answers (who/what · is-it-good · the one action). Status rides the icon tile + one status tag; layout never moves. One ceremonial beat (~450–600ms) then stillness.

**Per-type action:** ticket/reservation = **consume** (one-shot check-in) · gavekort = **show-then-redeem** (scan shows balance only; redeem is the explicit tap) · promo = **attach** (one per bill, server-capped).

**States** — green = good (aktivt/bekræftet/anvendt) · amber = a normal door situation (forkert dag, udløbet, cap nået) · red = rejected (ukendt, annulleret, forkert butik). Honesty: scan reads, tap redeems; gavekort MOMS never auto-decided. **Offline: refuse value redemption** (two offline terminals both seeing 500 kr = overspend); ticket/reservation check-in may queue.

---

## 3. Owner generation, tracking & linking  ⭐ (the owner-facing half)

The scanner is the **redemption** end. This is the **issuance + lifecycle** end the owner lives in.

### 3a. Generate (udsted gavekort)
Owner taps **Udsted gavekort** →
- **Inputs:** beløb (required), modtager (optional), besked (optional), udløber (default `issued + 3 år`, forældelsesloven), **type** (`MPV` default / `SPV` toggle "Fast pris, én ydelse?" — never auto-decided; only the *prompt* nudges the right answer).
- **On issue (atomic):**
  1. mint a high-entropy code → store **`code_hash`** (HMAC, never plaintext) + a human **`short_code`** (`GK-7Q4F-9H2T-K`) + `code_last4`;
  2. mint the QR `BB1.G.<jwt>` (`{gid, uid, jti, sub:"bonbox-gavekort", exp}`);
  3. insert `gift_cards` row (status `active`, `balance = face_value`);
  4. insert `gift_card_transactions` `issue` row (the first ledger entry + L7 audit);
  5. create the **sale** for the purchase — money IN, **outside MOMS** (a `gavekort_sold` tender / liability credit), linked via `transactions.sale_id`. This is what flows into the close as gavekort-solgt.
- **Output artifact:** a card the owner can **print** (QR + `GK-…` code + beløb + udløber + butiksnavn) or **send** (SMS/email/share-link), so the buyer gets something tangible. PII-min; no balance printed beyond face value.

### 3b. Track (the gavekort ledger the owner sees)
A **Gavekort** list, owner-facing:
- **Summary tiles:** *Udstedt* · *Indløst* · **Udestående** (= udstedt − indløst − udløbet; the liability number the revisor + close need; emphasized).
- **Rows:** `…last4` · modtager · pålydende · **saldo** (with a used-bar) · status pill (`aktivt`/`indløst`/`udløbet`/`annulleret`) · udstedt-dato. Filter by status, search by code/modtager.
- Per-tier cap reuses the `salon_services_max`-style `PLAN_CAP` idiom (e.g. `gavekort_active_max`).

### 3c. Link (scanned → where it's supposed to go)
This is the "tracked scanned linked where it's supposed to" requirement. Every `gift_card_transactions` redeem row carries the **full transaktionsspor** (Bogføringslov §8):
- `sale_id` → **which bill** the redemption paid toward,
- `daily_close_id` → **which dagsafslutning / MOMS-period** it landed in,
- `created_by_user_id` → **which staff** scanned it,
- `business_day` (DK 06:00 cutoff via `tz_utils`), `idempotency_key`, `jti`, `door_session_id`, `ip`.

So tapping a gavekort shows its trail end-to-end:
```
Udstedt 500 kr.  · 14. mar 2026 · solgt af Manoj · regning #0934
Indløst 180 kr.  · 28. jun 11:02 · Agnes · regning #1284 · dagsafslutning 28. jun
Saldo   320 kr.
```
The redemption is simultaneously: a **tender** that draws down the gavekort liability, and the trigger that puts the underlying vare/ydelse into `revenue_total` + MOMS at redemption (closing the P0 hole). No new cash enters the drawer at redemption (don't double-count). A revisor export shows *solgt − indløst = udestående* per period, accountant-grade regardless of tier.

---

## 4. Data model
Reuse `daily_close`/`reservation` conventions: denormalized `user_id`, soft-delete, UTC, integer øre, Postgres-first.

**`gift_cards`** — `id, user_id(idx), code_hash UNIQUE, short_code UNIQUE, code_last4, voucher_class(spv|mpv), face_value_minor, balance_minor(CHECK ≥0), currency, status(active|redeemed|expired|voided), issued_at, expires_at(default +3y), recipient_name?, note?, created_by_user_id, deleted_at?`

**`gift_card_transactions`** (append-only ledger = source of truth + audit) — `id, gift_card_id(FK), user_id, kind(issue|redeem|void|refund|expiry|reload), amount_minor(signed), balance_after_minor(CHECK ≥0), idempotency_key, UNIQUE(gift_card_id, idempotency_key), redemption_ref?, sale_id?, daily_close_id?, created_by_user_id, created_at`. Balance = `SUM(amount_minor)`, cached on `gift_cards.balance_minor`, reconciled on every write (cached number must never disagree with the ledger).

**`promos` / `promo_redemptions`** — net-new, same shape (campaign, value, max_uses, used_count, validity; redemption with `UNIQUE(promo_id, idempotency_key)`).

**Reservation check-in: no new table** — `status="seated"` + `seated_at` already exist; only the door endpoint + `sign_resv_token` are missing.

**`door_sessions`** — net-new scoped door token (`id, user_id, scopes, device_id?, expires_at, revoked_at?`).

---

## 5. Security (10-layer)
| L | Target |
|---|---|
| L1 Auth | scoped, revocable **door token** OR owner session via `require_scope("redeem:value")` (least-privilege: scan+redeem only). **Prod fail-closed signing key** — refuse to mint redeemable value with the dev `SECRET_KEY` fallback. |
| L2 Bounds | `algorithms=[HS256]` pinned; amount validated server-side; `applied = min(balance, amount_due)`. |
| L3 Rate-limit | per-IP + **per-`gid` (5 failed/min → temp-lock)** + per-door-token; signature-gate before any DB hit. |
| L5 Tenant | `uid` in token (L1 reject) **AND** `user_id` in the conditional UPDATE WHERE. |
| L6 Fail-closed | **DB-enforced single-spend via conditional atomic decrement** (NOT read-then-write — that's a double-spend TOCTOU): `UPDATE gift_cards SET balance_minor = balance_minor - :amt WHERE id=:gid AND user_id=:uid AND balance_minor >= :amt AND status='active' RETURNING balance_minor` — zero rows ⇒ reject. |
| L7 Audit | the append-only ledger row IS the audit record (who/what/when/where, DK business-day). |
| L8 Idempotency | client `Idempotency-Key` + `UNIQUE(gift_card_id, idempotency_key)` → replay returns the original result, never a 2nd debit. |
| L9 HTTP | 410 redeemed/expired/void · 409 insufficient (honest `balance_remaining`) · 404 IDOR · 423 locked. |
| L10 Honest | exact `amount_redeemed` + `balance_remaining`; never imply a spend that didn't commit. |

---

## 6. MOMS & compliance
- **Gavekort SOLD = outside MOMS** (forudbetaling) — stays as today. **REDEEMED = MOMS** on the underlying vare/ydelse.
- **SPV** (ét formål — fast pris/ydelse) → MOMS at **sale**. **MPV** (flere formål — café/salon default) → MOMS at **redemption** (SKM2022.401.LSR). **Never auto-decide** — surface `voucher_class`, sold, redeemed, outstanding to the revisor.
- **Breakage:** unredeemed MPV at expiry → income recognized; expiry `+3 år`.
- Sale and redemption each get a numbered **bilag**; a gavekort sold in March + redeemed in September must link across periods (transaktionsspor). Keep `gavekort`/`MOMS`/`revisor` Danish.

---

## 7. Reuse map
| Concern | Decision | Ref |
|---|---|---|
| Camera + jsQR + debounce + haptics | **EXTEND** — reuse rig; swap decode→`classify()`+tree; drop the `eid` short-circuit for non-tickets; wire `haptic.success` into the loop | `frontend/src/pages/DoorScanPage.jsx` |
| Scan endpoint | **CLONE skeleton, NOT the idempotency** (TOCTOU) — keep signed-JWT + IDOR-404 + audit; use conditional decrement | `backend/app/routers/tickets.py:70-179` |
| Token sign/verify | **EXTEND** `qr_signer.py` — add resv/gavekort/promo signers (own key + `sub` + `uid`/`jti`); make prod key fail-closed (lines ~66-77) | `backend/app/services/qr_signer.py` |
| Reservation check-in | **BUILD endpoint, reuse model** — `POST /reservations/{rid}/checkin` → `seated` | `backend/app/routers/reservations.py` |
| Gavekort model/issue/redeem/track | **BUILD NEW** — `gift_cards` + `gift_card_transactions` + `gavekort.py` | new |
| Close MOMS wiring | **EXTEND** — ledger-backed sold/redeemed/outstanding; redemption goods enter `revenue_total` | `DailyClosePage.jsx:1354`; `tax_service.py:392` |
| Idempotency precedent | **REUSE** unique-constraint dedup | `webhook_events` Migration 026 |
| Mixed tender | **REUSE** — gavekort is one more method, no phantom cash on sale scope | `useStickyMethod` |
| Per-tier cap | **REUSE** `PLAN_CAP` idiom | `billing.py` |

---

## 8. Build slices
| Slice | Scope | Size |
|---|---|---|
| S1 | **Scanner front-door rewrite** — `classify()` + `BB1.` envelope + prefix↔`sub` cross-check + manual entry. All existing ticket scans keep working. No new tables. | S |
| S2 | **Reservation check-in** — `sign_resv_token` + `POST /reservations/{rid}/checkin` (idempotent, `seated_at`) + BB1.R card. No money. | S |
| S3 | **Gavekort generate + track** — `gift_cards` + `gift_card_transactions`, code gen/hash, `sign_gavekort`, `POST /gavekort/issue` (+ sale link) + `GET /gavekort` list + balance. Owner **Udsted gavekort** + **tracking ledger**. | M |
| S4 | **Gavekort redeem (partial, idempotent)** behind the scanner — conditional atomic decrement + idempotency ledger + sale/close link. Closes the P0 MOMS hole. | M |
| S5 | **Scoped door token** — `door_sessions` + `require_scope("redeem:value")` + revoke UI. Prerequisite for shared-tablet/kiosk. | M |
| S6 | **Promo** — `promos` + `promo_redemptions` + signer + validate (one-per-bill cap). Gate behind real need. | M |
| S7 | **Void / refund / expiry job + breakage** — nightly expiry → ledger rows → MPV breakage; revisor afstemning ("solgt − indløst = udestående"). | M |
| S8 | (optional) plastic **Code128** via `@zxing/browser` — only if pre-printed plastic stock. | S |

## 9. Open questions for Manoj
1. Who holds the scanner — owner only, or shared/floor staff? (decides if the scoped door token is in S1 vs later)
2. Gavekort issuance for v1 — counter (Quick Sale) only, or also online / via faktura?
3. SPV or MPV by default for your verticals? (any fixed-price single-service gavekort?)
4. Plastic cards or digital-only? (decides whether 1D barcode is ever needed)
5. Is rabatkode (promo) a real near-term need, or droppable from scope?
6. Offline value redemption — confirm "refuse when offline" is acceptable.
7. Dedicated `GAVEKORT_SIGNING_KEY` on Render (prod fail-closed prerequisite, parallel to pending `APP_SECRET_KEY` #359).
