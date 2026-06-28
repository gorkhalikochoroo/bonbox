#!/usr/bin/env python3
"""
Money-write red-line guard — backend pre-commit / CI.

WHY THIS EXISTS
The honesty doctrine's hardest red-line is: a money / MOMS / gavekort /
invoice-paid-state / daily-close-total field must NEVER be mutated on a
NON-INTERACTIVE path (cron, webhook, inbound bot, background sync — no
authenticated human in scope) UNLESS the write is (a) reversible, (b) audited
with an explicit non-user `actor_type`, and (c) human-confirmable/undoable.
The codebase already proves the safe ceiling: payment_match_service auto-flips
invoice.status='paid' on bank ingest with actor_type='system.payment_match',
auto_match_reversible=True, an audit row, and a 7-day unmark_paid undo. The
catastrophic anti-pattern is a background job that silently writes revenue with
no audit + no undo (it can mask theft and poisons the MOMS base with no
provenance) — exactly what payment_autosync / whatsapp_service / khata_sync do
today (tracked debt, see KNOWN_DEBT).

WHAT THIS BLOCKS
A NEW (staged, added-line) money write in a background module, or any new
write that self-identifies as a system actor (`actor_type="system.*"`), that
is not on the ALLOWLIST and is not compliant (audit row + reversibility marker
in the same function). It deliberately does NOT touch interactive request
handlers (a human + L7 audit cover those) or pre-existing debt — added-lines
scoping means today's offenders don't break CI, but no NEW one can land.

INVARIANT (the one a prior adversarial review corrected):
NOT "a human actor id is required" — system.payment_match writes with
actor_id=None and is correct. The rule is reversible + audited-non-user-actor
+ human-confirmable.

Multi-barrier doctrine: this is the commit-time enforcement of Layer 7 (audit)
for the money surface. See memory feature_roadmap_9idea_build / the
map-money-write-surface workflow for the full site map.

Emergency bypass (whole hook): `git commit --no-verify`.
Run standalone: `python3 scripts/check_money_writes_staged.py`
"""
from __future__ import annotations

import re
import subprocess
import sys

# ── Sensitive money-field writes (matched on an ADDED line) ──────────────
SENSITIVE_PATTERNS = [
    r"\.revenue_total\s*=",
    r"\.moms_total\s*=",
    r"\.taxable_sales\s*=",
    r"\.payment_total\s*=",
    r"\.status\s*=\s*['\"]paid['\"]",          # invoice -> paid
    r"\.paid_amount\s*=",
    r"\.paid_via\s*=",
    r"\.amount_minor\s*=",                        # gift card value
    r"\.balance\s*=",                              # gift card balance
    r"\bSale\s*\(",                                # constructing a revenue row
    r"status\s*=\s*['\"]issued['\"]",            # gift_card_order issue
    r"UPDATE\s+gift_card",                         # raw SQL gift-card mutation
]
_SENSITIVE_RE = re.compile("|".join(SENSITIVE_PATTERNS))

# A money write is IN SCOPE for this guard (i.e. treated as non-interactive)
# if its file looks like a background module OR its enclosing function self-
# identifies as a system actor. Interactive request handlers fall outside —
# a human + the L7 audit cover them; a separate audit-coverage guard is the
# place for those.
_BACKGROUND_FILE_RE = re.compile(
    r"(_sync\.py$|autosync|_cron|cron_|scheduler|webhook|payment_match|mobilepay|whatsapp_service)"
)
_SYSTEM_ACTOR_RE = re.compile(r"actor_type\s*=\s*['\"]system\.")

# Compliance signals required inside the enclosing function for an in-scope
# write to be allowed without an explicit allowlist entry.
_AUDIT_RE = re.compile(r"audit_service\.record\(|AuditLog\(|audit_log")
_REVERSIBLE_RE = re.compile(
    r"reversible|auto_match_reversible|delete_khata_synced|def unmark|compensat|undo"
)

# ── Allowlist: sanctioned non-interactive money writes (relpath::func) ────
# Each satisfies the invariant (reversible + audited non-user actor +
# human-undoable). Verified by the map-money-write-surface workflow.
ALLOWLIST = {
    "app/services/payment_match_service.py::try_match_sale_to_invoice",
    "app/services/mobilepay.py::_auto_match_payments",
    "app/services/invoice_service.py::unmark_paid",   # the human-undo leg
    "app/routers/gavekort.py::issue_order",            # race-safe claim; mint audits in _create_gift_card
}
# Whole files that only ever fabricate the synthetic DEMO tenant (never a real
# ledger) — allowlisted by path so seed code can't gate the guard.
ALLOWLIST_FILES = {
    "app/services/demo_seed.py",
}

# ── Known debt: real violations that predate the guard. Tolerated (a warning,
# not a failure) so CI stays green, but tracked for a fix — DO NOT replicate.
# The 3 original offenders (payment_autosync / whatsapp_service / khata_sync)
# were FIXED 2026-06-28: each now writes an audit row with a system actor +
# reversibility marker, so it passes the compliance check on its own merit —
# no allowlist/debt entry needed. This set is intentionally empty; add a
# `file::func` here only as a temporary, tracked exception.
KNOWN_DEBT: set[str] = set()


def _enclosing_function(lines: list[str], idx: int) -> str:
    """Walk upward from a 0-based line index to the nearest `def name(`."""
    for i in range(idx, -1, -1):
        m = re.match(r"\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)", lines[i])
        if m:
            return m.group(1)
    return "<module>"


def _function_body(lines: list[str], func_name: str) -> str:
    """Return the text of `func_name`'s body (best-effort, by indentation)."""
    for i, ln in enumerate(lines):
        m = re.match(r"(\s*)(?:async\s+)?def\s+" + re.escape(func_name) + r"\b", ln)
        if not m:
            continue
        base_indent = len(m.group(1))
        body = [ln]
        for nxt in lines[i + 1:]:
            if nxt.strip() == "":
                body.append(nxt)
                continue
            indent = len(nxt) - len(nxt.lstrip())
            if indent <= base_indent and (
                nxt.lstrip().startswith("def ")
                or nxt.lstrip().startswith("async def ")
                or nxt.lstrip().startswith("class ")
                or indent == 0
            ):
                break
            body.append(nxt)
        return "\n".join(body)
    return ""


def scan(staged: dict) -> tuple[list[dict], list[dict]]:
    """Pure detection core (unit-testable, no git).

    staged: { relpath: {"added": [(lineno_1based, text)], "content": full_text} }
    returns (violations, debt_notices)
    """
    violations: list[dict] = []
    debt: list[dict] = []
    for relpath, info in staged.items():
        content = info.get("content", "")
        lines = content.splitlines()
        for lineno, text in info.get("added", []):
            if not _SENSITIVE_RE.search(text):
                continue
            func = _enclosing_function(lines, max(0, lineno - 1))
            key = f"{relpath}::{func}"
            if relpath in ALLOWLIST_FILES or key in ALLOWLIST:
                continue
            body = _function_body(lines, func) or text
            in_scope = bool(_BACKGROUND_FILE_RE.search(relpath)) or bool(
                _SYSTEM_ACTOR_RE.search(body)
            )
            if not in_scope:
                continue  # interactive path — out of scope for this guard
            if key in KNOWN_DEBT:
                debt.append({"key": key, "line": lineno, "snippet": text.strip()[:90]})
                continue
            compliant = bool(_AUDIT_RE.search(body)) and bool(_REVERSIBLE_RE.search(body))
            if not compliant:
                missing = []
                if not _AUDIT_RE.search(body):
                    missing.append("audit_service.record(...)")
                if not _REVERSIBLE_RE.search(body):
                    missing.append("a reversibility/undo marker")
                violations.append(
                    {
                        "key": key,
                        "line": lineno,
                        "snippet": text.strip()[:90],
                        "missing": missing,
                    }
                )
    return violations, debt


def _staged_from_git() -> dict:
    try:
        names = subprocess.check_output(
            ["git", "diff", "--cached", "--name-only", "--diff-filter=ACM", "--", "backend/app"],
            text=True,
        )
    except Exception:
        return {}
    files = [f.strip() for f in names.splitlines() if f.strip().endswith(".py")]
    staged: dict = {}
    for f in files:
        # Added line numbers from the unified=0 diff.
        try:
            diff = subprocess.check_output(
                ["git", "diff", "--cached", "--unified=0", "--", f], text=True
            )
        except Exception:
            continue
        added: list[tuple[int, str]] = []
        new_ln = 0
        for ln in diff.splitlines():
            h = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", ln)
            if h:
                new_ln = int(h.group(1))
                continue
            if ln.startswith("+") and not ln.startswith("+++"):
                added.append((new_ln, ln[1:]))
                new_ln += 1
            elif not ln.startswith("-"):
                new_ln += 1
        if not added:
            continue
        # Full staged content (the `:f` index blob) to resolve function bodies.
        try:
            content = subprocess.check_output(["git", "show", f":{f}"], text=True)
        except Exception:
            content = ""
        relpath = f[len("backend/"):] if f.startswith("backend/") else f
        staged[relpath] = {"added": added, "content": content}
    return staged


def main() -> int:
    staged = _staged_from_git()
    if not staged:
        return 0
    violations, debt = scan(staged)
    for d in debt:
        print(f"⚠️  money-write guard: touched KNOWN-DEBT site {d['key']}:{d['line']} "
              f"— pre-existing, tracked; don't extend it.")
    if not violations:
        print("✅ money-write guard: no new unaudited non-interactive money writes staged.")
        return 0
    print("\n❌ money-write red-line guard: "
          f"{len(violations)} new non-interactive money write(s) lacking audit + reversibility.\n"
          "   A background/system path must NEVER mutate money/MOMS/gavekort/invoice-paid/close-total\n"
          "   without (a) reversibility, (b) an audit_service.record(...) with a non-user actor_type,\n"
          "   and (c) a human-undoable path. (NOT 'a human actor id' — system.payment_match is fine.)\n")
    for v in violations:
        print(f"   {v['key']}:{v['line']}  ->  {v['snippet']}")
        print(f"      missing: {', '.join(v['missing'])}")
    print("\n   Fix: route the write through an audited+reversible system actor (mirror\n"
          "   payment_match_service), or — if it's genuinely interactive — ensure a human\n"
          "   current_user is in scope. Only add to ALLOWLIST with a written justification.\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
