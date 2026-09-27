# BonBox Reservations — System Architecture

*Last updated: 2026-05-30. The target architecture for the reservation system: from the shipped v1 to a robust, best-in-class engine. DK-first restaurants + appointment verticals.*

---

## 0. Scope & status

**Shipped (v1, live on prod):** generic `BookableResource` + `Reservation` models · pure availability engine (16 unit tests) · owner page (book / floor / settings) · public `/r/<slug>` widget · tier gates · confirmation email · reminder + GDPR-purge crons · owner push · SMS reminders (Starter+Pro). Migration 022 on Supabase.

**What this doc fixes** — the v1 was built fast and has three architectural gaps that a "proper" system must close:
1. **No DB-level guarantee against double-booking.** The engine does a best-effort `find_slot_resource` recheck, but between the recheck and the `INSERT` two concurrent requests can both grab the same table (TOCTOU race). Nothing in the schema forbids overlapping bookings on a resource.
2. **Single-resource occupancy.** `Reservation.resource_id` is one table → no **combinable tables** (party of 6 across two 4-tops), the single most-requested real-world capability.
3. **Shallow operator surface.** A list, not a **visual floor** or **timeline/grid**; no **walk-in** or **waitlist**.

---

## 1. Principles

1. **The database is the source of truth for integrity, not the application.** Overlap prevention, idempotency, and tenancy are enforced by constraints, not hope.
2. **One generic engine, many verticals.** Tables, providers (salon/clinic), and rooms are all `bookable_resource`s; availability comes from operating-hours (restaurant) or staff shifts (appointments).
3. **Append-only-ish + auditable.** Reservations transition through an explicit state machine; every mutation writes an `AuditLog` row.
4. **Tenant-scoped + GDPR-bounded.** Every query filters by `user_id`; guest PII + Art.9 allergy data are retention-purged.
5. **Graceful + honest.** Public surface degrades to clear 409/410s; nothing silently double-books or over-promises.

---

## 2. The integrity backbone — *no double-booking, ever* ⭐

This is the heart of a "proper" booking system and the #1 fix.

### The problem with v1
```
recheck_and_assign() → picks a free resource   # reads "busy" set
Reservation(resource_id=…); db.add; db.commit   # …another request inserts here
```
Two simultaneous bookings for the same table both pass the recheck → both commit → **double-booked**. Advisory checks can't prevent it; only the DB can.

### The fix — a Postgres **exclusion constraint** on occupancy
Model physical occupancy as its own table and let Postgres forbid overlaps declaratively:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- enables "=" in a gist exclusion

-- one row per physically-occupied resource for a reservation
CREATE TABLE reservation_occupancy (
  id            VARCHAR(36) PRIMARY KEY,
  reservation_id VARCHAR(36) NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  resource_id   VARCHAR(36) NOT NULL REFERENCES bookable_resources(id),
  user_id       VARCHAR(36) NOT NULL,        -- tenant (denormalized for the index)
  starts_at     TIMESTAMP NOT NULL,
  ends_at       TIMESTAMP NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,  -- false once cancelled/no-show/completed-released
  EXCLUDE USING gist (
    resource_id WITH =,
    tsrange(starts_at, ends_at) WITH &&        -- [start,end) half-open: touching ends DON'T conflict
  ) WHERE (active)
);
```

- `tsrange(...)` is half-open `[)`, which **exactly matches** the engine's `_overlaps` semantics (a 18:00–19:30 booking frees 19:30 for the next party).
- The partial `WHERE (active)` means cancelled/no-show rows stop blocking the slot automatically.
- **Combinable tables fall out for free:** a party of 6 on two 4-tops = **two `reservation_occupancy` rows**, each individually overlap-protected.

### The create flow becomes *insert-and-catch* (bulletproof)
```
1. availability/assign → candidate resource(s)   # fast path, app-level
2. INSERT reservation + occupancy row(s)
3. on ExclusionViolation (someone won the race) → rollback,
   re-query availability, try next candidate, else 409 slot_unavailable
```
The app-level `assign_resource` stays as the *fast path* (good UX, fewer retries); the constraint is the *backstop* that makes a double-booking physically impossible — on every path (public, owner-manual, walk-in, combo).

### Local-dev caveat
SQLite has no `EXCLUDE`/`tsrange`. The migration adds the constraint **Postgres-only** (guard the DDL); local dev relies on the app-level recheck. Belt (app) + suspenders (DB) on prod.

> Alternative considered: `SELECT … FOR UPDATE` on the resource row + recheck-in-txn (pessimistic lock). Rejected as primary — it serializes per resource and must hold the lock across recheck+insert; the exclusion constraint is declarative, path-agnostic, and combo-friendly. (We can still add a per-resource advisory lock to *reduce* retries under heavy contention.)

---

## 3. Data model (target)

```
bookable_resources           (have)  kind(table|provider|room), capacity_seats, zone,
                                      staff_id?, sort_order, is_active, + floor: pos_x/pos_y/shape
resource_combos              (new)   named joinable sets: "T4+T5 → 8-top"; member resource_ids[],
                                      combined_capacity — booking a combo writes occupancy for each member
service_periods              (new)   per business: lunch/dinner windows, pacing cap, turn-time tiers
                                      (currently flattened in reservation_settings_json → promote to rows)
reservations                 (have)  guest, party_size, starts_at/ends_at, service_name, duration_min,
                                      status, source, allergen_tags/severity/note, occasion, notes,
                                      confirmation/reminder timestamps, seated/cancelled, purge_after,
                                      idempotency_key (UNIQUE), soft-delete
reservation_occupancy        (new)   ⭐ the overlap-protected physical-table rows (§2)
waitlist_entries             (new)   guest + desired date/party/time-window + status(waiting|offered|converted|expired)
reservation_settings (on business_profile)  slug, enabled, settings_json (turn-times, pacing, caps,
                                      lead/advance, retention, sms_reminders, sms_sender)
```
Migration path from v1: keep `reservations.resource_id` as the *primary/display* resource; add `reservation_occupancy` and backfill one row per existing reservation; new bookings write occupancy rows and the constraint takes over.

---

## 4. Reservation state machine

```
                ┌─────────── cancel ───────────┐
requested ──confirm──▶ confirmed ──seat──▶ seated ──complete──▶ completed
   │  (group/large       │                    │
   │   party, approval)  └── no_show ──▶ no_show (frees occupancy; feeds reliability score)
   └── decline ──▶ cancelled
```
- **Triggers:** public create → `requested` (≥ group threshold) or `confirmed`; owner actions → confirm/seat/no_show/cancel/complete; cron → auto-`no_show` if never seated N min past start (Phase 2).
- **Side-effects per transition** (table-driven, one place): occupancy `active` flip · notification (confirm/reminder) · push · audit row · (Phase 2) deposit capture on no_show.
- **Invariant:** occupancy rows are `active` only in `{requested?, confirmed, seated}`. (Requested-without-hold is a config choice — default: requests do NOT hold a table until approved, to avoid blocking inventory on unconfirmed demand.)

---

## 5. Availability engine (keep pure, extend)

The current `app/services/availability_engine.py` (pure, tested) stays the core. Extensions:
- **Windows source** by vertical: restaurant → `operating_hours_json` / `service_periods`; appointment → the provider's published `Schedule` shifts (already wired in `reservation_service`).
- **Combination-aware assignment:** when no single resource fits the party, try configured `resource_combos` (smallest combo that seats them, all members free).
- **Pacing** (covers/party-starts per window) — have; promote to per-service-period.
- **Caching:** availability for `(business, date, party)` is read-heavy on the public widget — cache per (slug, date, party) with a short TTL, invalidated on any write to that day. Protects the DB under a viral link.
- **Server truth:** the public read is advisory; the **occupancy exclusion constraint is the only thing that decides** at write time.

---

## 6. The two verticals on one engine
| | Restaurant (tables) | Salon / clinic (appointments) |
|---|---|---|
| Resource | table / room (capacity = seats) | provider / chair (capacity 1) |
| Availability window | operating hours / service periods | the provider's published shift |
| Duration | turn-time by party size | service length (cut 45m, color 120m) |
| "Party" | covers | 1 client + a service |
| Combos | join tables | n/a |
Same `bookable_resource` + `reservation_occupancy` + engine; `business_type` drives the window source, the guest-facing verb ("Book a table" / "Book an appointment"), and the allergen set. v1 ships restaurant fully; appointment owner-UI is the fast-follow (engine already supports it).

---

## 7. Surfaces

**Owner (host-stand, Windows-PWA-optimized):**
- **Reservation book** (have) — today's service list, status actions, allergy flags.
- **Timeline / grid** (new) — resources × time, the at-a-glance "who's where when" best-in-class view.
- **Visual floor** (new) — table layout with live occupancy colour; `pos_x/pos_y/shape` on resources; drag to arrange.
- **Walk-in** (new) — one-tap seat-now (creates a `seated` reservation + occupancy immediately).
- **Waitlist** (new) — when full, capture demand; auto-offer on a cancellation.

**Public `/r/<slug>` (have):** date → party → live slots → details + allergy → confirm. Hardened: idempotency key, rate-limit, booking-token JWT, 410 when disabled, group→request.

---

## 8. Cross-cutting
- **Idempotency:** `reservations.idempotency_key` UNIQUE (have) — same key returns the same booking.
- **Tenancy:** every query `WHERE user_id = …`; `reservation_occupancy.user_id` denormalized for index locality.
- **Notifications:** confirm (on create) · 24h reminder (cron, SMS-preferred/email fallback) · owner push on new booking — all have. Add: waitlist-offer notification.
- **GDPR:** `purge_after` nulls guest PII + Art.9 allergy after the service date (cron, have). Outreach consent-gated.
- **Tiering:** Free taste (cap) → Starter/Pro unlimited; SMS Starter+Pro. Advanced (combos, floor, deposits) can gate to Pro if desired.
- **Audit + observability:** AuditLog per mutation; log assignment retries (race contention) + availability cache hit-rate.

---

## 9. v1 → target gap list (prioritised)
| # | Gap | Severity | Target (this doc) |
|---|---|---|---|
| 1 | ~~No DB overlap guarantee (race → double-book)~~ | ✅ **SHIPPED** | §2 exclusion constraint + insert-and-catch *(Migration 055; proven on prod)* |
| 2 | ~~Single-resource (no combinable tables)~~ | ✅ **SHIPPED** | §3 `reservation_occupancy` multi-row + `find_combo` engine *(Migration 056; `combinable` flag per table)* |
| 3 | No visual floor / timeline | P1 | §7 floor + timeline views |
| 4 | No walk-in / waitlist | P1 | §7 walk-in + §3 waitlist |
| 5 | Formal state machine + auto-no-show | P2 | §4 |
| 6 | Service-periods as raw JSON | P2 | §3 promote to rows |
| 7 | Availability not cached (public-link load) | P2 | §5 cache |
| 8 | Appointment owner-UI | P2 | §6 fast-follow |
| 9 | Deposits/no-show capture | P2 | needs payment rails (Stripe/Reepay) |

## 10. Build sequence
1. ✅ **P0 — integrity backbone:** `reservation_occupancy` + exclusion constraint + insert-and-catch create flow + tests that hammer concurrent identical bookings and assert exactly one wins. *(Migration 055; Postgres-guarded. Proven on prod: overlap rejected, touching allowed.)*
2. ✅ **P1 — combinable tables** (combos + multi-row occupancy): per-table `combinable` flag + zone-scoped `find_combo` (smallest table-count, then least waste) + `busy_for_day` reads occupancy so each combo member blocks individually. *(Migration 056. 15 engine/occupancy tests.)* → **next: walk-in → timeline grid → visual floor → waitlist.**
3. **P2 — state machine formalization + auto-no-show**, service-periods table, availability cache, appointment owner-UI.
4. **Later — deposits/no-show capture** (payment rails), the Events↔Reservations bridge, guest CRM.

> The P0 backbone is the one that makes the system trustworthy — without it, "best-in-class" is undermined by a race that quietly seats two parties at one table on a busy Friday. Everything else is depth on a sound foundation.

### Combinable tables — how it works (shipped)
- **Opt-in per table:** owners flag tables `combinable` on the Floor tab. Only combinable tables sharing a **zone** can be pushed together (an indoor table can't join a terrace one).
- **Single table first:** the engine always prefers one table that fits; it only combines when no single table seats the party — so two tables are never tied up when one would do.
- **Best-combo heuristic:** fewest tables, then least wasted seats (a party of 5 takes a 4-top + 2-top, not 4-top + 4-top).
- **Integrity preserved:** each combined table gets its **own** `reservation_occupancy` row, all inserted in one transaction. If any member lost a concurrent race the whole booking rolls back (never a half-seated party). Cancel/no-show releases every member row.
- **Bounded:** `combine_enabled` (default on) + `max_combo_size` (default 3) in settings; group-request threshold still routes very large parties to owner approval.
