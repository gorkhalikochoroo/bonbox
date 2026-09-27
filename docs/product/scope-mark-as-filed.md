# Scope: "mark as filed" — the prerequisite for overdue MOMS alerts

**Status: scoped, not built.** Written 8 Sep 2026 alongside the frist-day fix.

## Why this exists

The MOMS countdown now reaches "due today". It still cannot reach **"overdue"**,
and that is deliberate: BonBox has no idea whether an owner filed.

Verified against production, not assumed:

- No `filings` / `vat` / `tax` / `moms` table exists — the only matches in the
  schema are `reservation*`
- No `filed` flag on any model
- No endpoint that marks a period settled
- No SKAT / eIndkomst integration (we are not a certified provider — see the
  payroll CSV docstring for the same constraint)
- The one filing-adjacent trace is `audit_logs.action =
  'reports.vat_export_pdf_generated'`, which has **6 rows ever** and means
  *"generated a PDF"*, not *"filed"*

Most DK small businesses file through their revisor. BonBox never sees it. So an
"overdue — file before SKAT fines accrue" alert today would fire at owners who
filed on time, **every morning, with no way to dismiss it**, about a tax
liability. That is worse than silence, which is why the branches stay dead.

## The smallest thing that makes overdue honest

### 1. A filings record

New table, one row per settled period per owner:

```
moms_filings
  id            uuid pk
  user_id       fk users
  period_start  date          -- from _derive_period, not typed by the owner
  period_end    date
  period_label  text          -- "H1 2026" — display only, never a key
  frequency     text          -- the frequency AT filing time; a venue can switch
  filed_at      timestamptz   -- when the owner says they filed
  marked_at     timestamptz   -- when they told us (≠ filed_at)
  amount_minor  bigint null   -- optional; what they actually filed
  note          text null
  UNIQUE (user_id, period_start, period_end)
```

`filed_at` and `marked_at` are separate on purpose. Someone files on the frist at
23:00 and taps the next morning — conflating them would make the record wrong and
would defeat the grace logic below.

Migration goes in the `_migrations` list in `app/main.py` (this repo has no
`alembic upgrade` in the deploy command — migrations run at application startup),
with the SQLite `_add()` mirror. See `gotcha_sqlite_migration_mirror`.

### 2. Two endpoints

- `POST /api/tax/filings` — `{period_start, period_end, filed_at?, amount_minor?}`
- `DELETE /api/tax/filings/{id}` — **required, not optional.** This is a record
  about a tax filing; a mis-tap must be undoable.

Both audit-logged (`tax.filing_marked` / `tax.filing_unmarked`) per the
Bogføringsloven §10 posture the rest of the tax surface already keeps.

Owner-only. A member must not be able to assert that the business filed — same
gate as the rest of the owner tax surface (`member_read_guard`).

### 3. One control on `/tax`

A single tap next to the countdown. Danish, jurisdiction-locked per
`convention_dk_terminology_lock`:

> **Jeg har indberettet** — *I have filed*

And once marked, the countdown for that period is replaced by a quiet line
stating what the owner told us and when, with an undo.

## The wording invariant, which matters more than the schema

**BonBox must never say "filed with SKAT".** It does not know that. It knows the
owner tapped a button. Every surface says so:

- ✅ "Du har markeret H1 2026 som indberettet den 1. september."
- ❌ "H1 2026 er indberettet til SKAT."

Same discipline as `computed ≠ measured` elsewhere in the product.

## What overdue may then say — and what it still may not

Even with the signal, the overdue copy should be a **question, not an
accusation**, because the signal is self-reported and an owner who filed may
simply not have tapped:

- ✅ "H1 2026 var due 1. september og er ikke markeret som indberettet. Har du
  sendt den?" — with the mark-as-filed tap right there
- ❌ "MOMS filing is 7 days overdue — file before SKAT fines accrue."

Gating rules for firing it at all:

| Rule | Why |
|---|---|
| deadline passed **and** no filing row | the basic condition |
| grace of ≥ 2 days after the frist | someone filing at 23:00 on the frist should not be accused at 06:00 the next morning |
| **at most once per period**, ever | a daily nag about a tax liability we cannot confirm is its own harm — this is the rule that most needs writing down |
| suppressed entirely once marked | obvious, but it is the whole point |

The daily brief's overdue candidate carries weight **0.98**, the highest in
`generate_candidates` — so it becomes the headline *and* the morning push. That
weight is correct for a real overdue filing and unacceptable for a guess. Do not
enable the branch until the once-per-period cap exists.

## Effort

Roughly a day: table + startup migration + SQLite mirror, two endpoints with
audit rows, one `/tax` control, wiring three consumers (`get_tax_overview`
status, `daily_brief` suppression + the gated overdue candidate, Foresight
skipping settled periods), plus tests.

The tests that matter: marking is undoable; a marked period never alerts; an
unmarked past period alerts **once**, not daily; a member cannot mark; and the
copy never claims SKAT confirmed anything.

## Do not

- Infer "filed" from a generated MOMS PDF. That is "looked at it".
- Auto-mark on any schedule.
- Ship the overdue branch before the once-per-period cap.

Related: `test_moms_frist_day.py::test_overdue_is_still_unreachable` is the guard
that fails if someone makes past deadlines reachable before this lands.
