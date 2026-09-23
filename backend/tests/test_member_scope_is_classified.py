"""Every API prefix must be a DECISION about delegated seats, not an oversight.

THE SHAPE OF THE PROBLEM. A cashier/manager/viewer you invite gets a session
that resolves to the OWNER user, so every tenant-scoped query returns your
business. Two guards decide what they may do, and they are opposite shapes:

  WRITES — default DENY. `_MEMBER_WRITE_ALLOWED` is an allow-list, and it
           currently contains exactly one path (/api/auth/logout). A delegated
           seat is effectively read-only. This is the right shape and it is
           already built.

  READS  — default ALLOW. `_MEMBER_READ_DENY_PREFIXES` is a DENY-list of 11
           prefixes out of ~80. Everything not on it is readable.

So the read side fails OPEN: ship a new router next month and a cashier reads
it from day one, because nobody remembered to add a prefix. The comments in
that block already document this happening before.

WHY THIS TEST RATHER THAN INVERTING THE LIST. The deny-list is not a careless
list — it encodes per-field decisions with stated reasons (/api/staff/hours is
deliberately NOT denied as a prefix because the register a manager needs is
mixed in with money that is redacted field-by-field instead; denying it made
the Detaljer tab print "No hours logged" above real entries). Inverting it
wholesale at runtime would discard that reasoning and risk locking a real
manager out mid-service. This converts "somebody must remember" into "the
build stops you", which is the part that was actually missing.

HOW TO FIX A FAILURE: a new prefix appeared and nobody classified it. Put it in
exactly one bucket below, with a reason. Do not add it to OPEN_TO_MEMBERS just
to go green — that is the oversight this exists to prevent, written down.
"""
from __future__ import annotations

import app.main as main_mod

# ── Denied to delegated seats, enforced at runtime ────────────────────
# Source of truth is main.py; mirrored here only so the arithmetic below works.
DENIED = set(main_mod._MEMBER_READ_DENY_PREFIXES)

# ── Operational: a manager or cashier genuinely needs these to work a shift ──
OPEN_TO_MEMBERS = {
    "/api/activation", "/api/agent", "/api/ai", "/api/auth", "/api/bookings",
    "/api/branches", "/api/business", "/api/config", "/api/customers",
    "/api/demo", "/api/diagnostics", "/api/email", "/api/event-log",
    "/api/events", "/api/expiry", "/api/feedback", "/api/gavekort",
    "/api/health", "/api/inbox", "/api/inventory", "/api/keepalive",
    "/api/modules", "/api/onboarding", "/api/order-channels", "/api/outlets",
    "/api/output-channels", "/api/patterns", "/api/pillars", "/api/portal",
    "/api/public", "/api/push", "/api/reservations", "/api/retention",
    "/api/sales", "/api/search", "/api/smart-drift", "/api/smart-scan",
    "/api/staffing", "/api/stand", "/api/support", "/api/terminals",
    "/api/tickets", "/api/waitlist", "/api/waste", "/api/weather",
    "/api/whatsapp", "/api/wines", "/api/workshop", "/api/dashboard",
    "/api/staff",  # field-redacted in routers/staff.py, see the deny-list note
}

# ── Gated inside the router itself, verified ──────────────────────────
SELF_GATED = {
    # routers/admin.py:40 — Depends(require_super_admin), plus an email
    # allowlist. Not reachable by a delegated seat.
    "/api/admin",
    # routers/team.py — 8 explicit owner-actor gates.
    "/api/team",
}

# ── Readable by a delegated seat TODAY, and arguably should not be ────
#
# Flagged for the founder, not silently changed: moving one of these to DENIED
# changes what an invited manager can see mid-service, which is a product call
# about what a seat is FOR, not a bug to fix inside a test file.
#
# All are READ-only exposure — the write allow-list contains one path — so the
# risk is financial visibility and customer PII, not tampering.
NEEDS_OWNER_DECISION = {
    "/api/daily-close",        # kasserapport: revenue, MOMS, cash difference
    "/api/kasserapport",       # the same figures, export side
    "/api/invoices",           # fakturaer + customer names/addresses
    "/api/cashbook",
    "/api/billing",            # plan, payment method, invoices
    "/api/budgets",
    "/api/khata",
    "/api/loans",
    "/api/accountant-savings",
    "/api/accountants",        # revisor grants — delegation of delegation
    "/api/property-report",
    "/api/expenses",
    "/api/recurring-expenses",
    "/api/payment-import",
    "/api/payment-suggestions",
    "/api/mobilepay",
    "/api/mileage",
    "/api/pricing",            # margins
    "/api/smart-pricing",      # margins
    "/api/competitors",
    "/api/internal",
}

CLASSIFIED = DENIED | OPEN_TO_MEMBERS | SELF_GATED | NEEDS_OWNER_DECISION


def _api_prefixes() -> set[str]:
    """Every /api/<top-level> prefix the app actually serves."""
    out = set()
    for route in main_mod.app.routes:
        path = getattr(route, "path", "") or ""
        if not path.startswith("/api/"):
            continue
        parts = path.split("/")
        if len(parts) > 2 and parts[2]:
            out.add(f"/api/{parts[2]}")
    return out


def _is_covered(prefix: str) -> bool:
    # A prefix is covered if it, or a parent of it, is classified.
    return any(prefix == c or prefix.startswith(c.rstrip("/") + "/") or c.startswith(prefix + "/")
               for c in CLASSIFIED)


class TestEveryPrefixIsADecision:
    def test_no_unclassified_prefix(self):
        """THE POINT OF THIS FILE. A new router must not become readable by a
        delegated seat just because nobody thought about it."""
        unclassified = sorted(p for p in _api_prefixes() if not _is_covered(p))
        assert unclassified == [], (
            "These API prefixes are not classified for delegated seats:\n  "
            + "\n  ".join(unclassified)
            + "\n\nPut each in exactly ONE bucket in this file with a reason: "
            "DENIED (add to _MEMBER_READ_DENY_PREFIXES in main.py), "
            "OPEN_TO_MEMBERS, SELF_GATED (and cite the gate), or "
            "NEEDS_OWNER_DECISION. Do not default to OPEN_TO_MEMBERS."
        )

    def test_the_buckets_do_not_overlap(self):
        """A prefix in two buckets means two people decided differently."""
        buckets = {
            "DENIED": DENIED, "OPEN_TO_MEMBERS": OPEN_TO_MEMBERS,
            "SELF_GATED": SELF_GATED, "NEEDS_OWNER_DECISION": NEEDS_OWNER_DECISION,
        }
        names = list(buckets)
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                clash = buckets[a] & buckets[b]
                assert not clash, f"{a} and {b} both claim: {sorted(clash)}"

    def test_the_classification_is_not_stale(self):
        """A bucket naming a prefix the app no longer serves is a decision
        about nothing, and hides that the real one went unclassified."""
        served = _api_prefixes()
        for name, bucket in (("OPEN_TO_MEMBERS", OPEN_TO_MEMBERS),
                             ("SELF_GATED", SELF_GATED),
                             ("NEEDS_OWNER_DECISION", NEEDS_OWNER_DECISION)):
            gone = sorted(p for p in bucket if p not in served)
            assert gone == [], f"{name} lists prefixes that no longer exist: {gone}"


class TestTheRuntimeGuardStillHasTheShapeThisAssumes:
    def test_writes_are_default_deny(self):
        """If writes ever become a deny-list too, everything above is the
        wrong analysis and a delegated seat can change money."""
        assert isinstance(main_mod._MEMBER_WRITE_ALLOWED, frozenset)
        assert len(main_mod._MEMBER_WRITE_ALLOWED) < 20, (
            "the member WRITE allow-list has grown a lot — re-check that a "
            "delegated seat still cannot touch money"
        )

    def test_reads_are_still_a_deny_list(self):
        """This test exists BECAUSE reads fail open. If someone inverts the
        runtime guard to an allow-list, this file's whole premise changes and
        it should be rewritten rather than left asserting the old shape."""
        assert main_mod._is_sensitive_member_read_path("/api/tax/overview") is True
        assert main_mod._is_sensitive_member_read_path("/api/sales") is False

    def test_the_denied_set_is_not_silently_shrinking(self):
        assert len(DENIED) >= 11, "a prefix was removed from the runtime deny-list"
