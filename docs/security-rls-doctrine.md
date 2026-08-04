# RLS Hardening Doctrine

**Status:** Locked, 2026-05-27.

## The rule

Every new table in `public` schema MUST ship with:

1. `ALTER TABLE … ENABLE ROW LEVEL SECURITY;`
2. `CREATE POLICY rls_deny_anon ON … AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);`

This is non-negotiable. New tables that ship without this are blockers, not
backlog items.

## Why

BonBox's backend connects as the `postgres` role, which has `BYPASSRLS=true`
— so application code is unaffected by RLS. RLS exists purely as
**defense in depth** against the scenario where the Supabase anon key + project
URL get exposed (frontend bundle leak, GitHub accident, screenshot, dependency
breach). With RLS off, that one leak gives an attacker `SELECT *` on every
table. With RLS + the deny policy above, the anon key returns zero rows
across the entire schema.

The `RESTRICTIVE` qualifier is critical. If a future migration accidentally
adds a permissive policy (e.g. `USING (true)` for a public-read use case),
the restrictive deny policy still wins. RESTRICTIVE policies are ANDed;
they cannot be loosened by adding permissive policies later.

## The migration

Applied 2026-05-27 via Supabase MCP (`harden_rls_close_13_red_tables`
+ `harden_rls_explicit_deny_remaining_tables`). Closed:

- 13 RED findings (tables with no RLS at all, including `magic_link_tokens`,
  `accountant_grants`, `bank_connections`, `mobilepay_connections`)
- 46 INFO findings (tables with RLS enabled but no explicit policy)

Result: Supabase advisor went from 60 security findings to 1 (pg_net
extension in public schema — low priority, BonBox doesn't use pg_net
directly).

## Verifying after new migrations

After any migration that adds a table:

```sql
-- Any public table without our deny policy is a violation.
SELECT c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND (
    c.relrowsecurity = false
    OR NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = c.oid AND p.polname = 'rls_deny_anon'
    )
  );
```

An empty result means doctrine holds. Any rows = tables that need the fix
above.

You can also run the idempotent backfill from
`harden_rls_explicit_deny_remaining_tables` — it loops over any public table
with RLS enabled but no policy and applies the deny policy.

## What does NOT count as "RLS hardened"

- ❌ `ENABLE RLS` without any policy — relies on implicit deny, breaks if a
  future migration adds a permissive policy
- ❌ Permissive deny policy (`AS PERMISSIVE`) — can be overridden by other
  permissive policies
- ❌ `FOR SELECT` only — must cover `FOR ALL`
- ❌ Forgetting `WITH CHECK (false)` — INSERT/UPDATE paths slip through

The canonical form is in `harden_rls_close_13_red_tables` migration. Copy it.

## Related doctrine

- Multi-barrier 10-layer doctrine (auth → bounds → rate-limit → fail-soft →
  tenant → fail-closed → audit → fallback → graceful HTTP → honest claims).
  RLS is **Layer 12** — the database-level final backstop when application
  layers fail or the anon key leaks.
- Schema-drift self-test (Layer 11) — verifies model columns exist in DB at
  boot. RLS hardening is a sibling: verifies the DB is locked at boot too.
- `CLAUDE.md` migration rule — DDL goes through `main.py:_run_migrations()`,
  NOT Alembic. RLS DDL follows the same path.

## 2026-08-04 — the doctrine drifted, and is now self-enforcing

Documenting the rule did not hold it. Between the 2026-05-27 hardening and
2026-08-04, three tables shipped without it, and the Supabase anon key could:

- **read `stand_links`, including pairing `token` values** (4 rows)
- **read `staff_chat_members`** (3 rows)
- **write**: an anon `INSERT` failed on the table's own NOT NULL constraint
  (`23502`), not on a permission check — the write path was open
- `staff_documents` was empty, but would have exposed staff contracts and IDs
  the moment it was used

`staff_chat_members` came from migration 073 in this repo. The rule was written
down; the person writing the migration did not recall it. That is the failure
mode, and it recurs by default: `app/main.py` ships 55 `CREATE TABLE`
statements and set RLS on exactly one of them.

**A second, quieter drift:** `bookable_resources`, `reservation_occupancy` and
`reservations` carried a policy *named* `rls_deny_anon` that was PERMISSIVE, not
RESTRICTIVE. They denied — but they were one "public booking page" feature away
from someone adding a permissive `USING (true)` that a permissive deny cannot
override. Upgraded to RESTRICTIVE.

**The control is now a sweep, not a habit.** `_migrations` in `app/main.py`
carries a `DO $$` block that, on every boot, finds any public table lacking a
**RESTRICTIVE** `rls_deny_anon` and applies it. It keys on the restrictive
*property*, not the policy name — an earlier version checked the name and would
have skipped exactly those three reservation tables forever.

State after: **103/103 public tables** have RLS with a RESTRICTIVE deny.
Supabase security advisor: 0 ERROR, 0 INFO.

### Deliberately not fixed

Both remaining WARNs are `extension_in_public`, and both should stay:

- **`btree_gist`** backs `reservation_occupancy_no_overlap`, the `EXCLUDE`
  constraint that prevents double-booking a table. Moving the extension to
  another schema to silence a linter would break double-booking prevention.
- **`pg_net`** is Supabase-managed; BonBox does not use it.
