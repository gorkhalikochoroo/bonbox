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
