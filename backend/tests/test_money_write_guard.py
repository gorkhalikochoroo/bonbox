"""
Money-write red-line guard — unit tests for the pure detection core.

Verifies the guard (scripts/check_money_writes_staged.py) blocks NEW
non-interactive money writes that lack audit + reversibility, while NOT
flagging: interactive handlers, the sanctioned allowlist, or pre-existing
known debt.

Run:
  cd backend && python3 -m pytest tests/test_money_write_guard.py -x -q
"""
import importlib.util
import os

import pytest

_GUARD_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "check_money_writes_staged.py")
)
_spec = importlib.util.spec_from_file_location("money_guard", _GUARD_PATH)
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)


def _staged(relpath, content):
    """Build a staged-dict where every line of `content` counts as added."""
    lines = content.splitlines()
    added = [(i + 1, ln) for i, ln in enumerate(lines)]
    return {relpath: {"added": added, "content": content}}


# ── 1. New background money write, no audit/reversibility → VIOLATION ──────
def test_new_background_sale_write_without_audit_is_blocked():
    code = (
        "def _import_new_feed(conn):\n"
        "    for txn in conn.transactions:\n"
        "        sale = Sale(amount=abs(txn.amount), payment_method='bank')\n"
        "        db.add(sale)\n"
        "    db.commit()\n"
    )
    violations, debt = guard.scan(_staged("app/services/bank_feed_sync.py", code))
    assert len(violations) == 1, violations
    assert "audit_service.record(...)" in violations[0]["missing"]
    assert "a reversibility/undo marker" in violations[0]["missing"]


# ── 2. New system-actor write self-identifies as background → VIOLATION ────
def test_system_actor_write_without_audit_is_blocked():
    code = (
        "def cleanup_job(db):\n"
        "    inv.status = 'paid'\n"
        "    log(actor_type='system.cleanup')\n"
    )
    violations, _ = guard.scan(_staged("app/services/misc_service.py", code))
    assert len(violations) == 1, violations


# ── 3. Compliant background write (audit + reversible) → ALLOWED ───────────
def test_compliant_background_write_passes():
    code = (
        "def try_new_match(db, sale, invoice):\n"
        "    invoice.status = 'paid'\n"
        "    invoice.auto_match_reversible = True\n"
        "    audit_service.record(db, actor_type='system.new_match', action='auto_paid')\n"
    )
    violations, _ = guard.scan(_staged("app/services/new_match_service.py", code))
    assert violations == [], violations


# ── 4. Interactive handler (human, no system actor) → OUT OF SCOPE ─────────
def test_interactive_handler_is_not_flagged():
    code = (
        "def mark_paid(db, current_user, invoice, amount):\n"
        "    invoice.status = 'paid'\n"
        "    invoice.paid_amount = amount\n"
    )
    violations, _ = guard.scan(_staged("app/services/invoice_service.py", code))
    assert violations == [], violations


# ── 5. Sanctioned allowlist site → ALLOWED even without inline markers ─────
def test_allowlisted_site_passes():
    code = (
        "def try_match_sale_to_invoice(db, sale):\n"
        "    invoice.status = 'paid'\n"
    )
    violations, _ = guard.scan(
        _staged("app/services/payment_match_service.py", code)
    )
    assert violations == [], violations


# ── 6. Known-debt mechanism → DEBT NOTICE, not a hard failure ─────────────
def test_known_debt_is_warned_not_failed(monkeypatch):
    # The 3 original offenders are now fixed (compliant), so KNOWN_DEBT is
    # empty by default — inject a temporary entry to exercise the mechanism.
    monkeypatch.setattr(guard, "KNOWN_DEBT", {"app/services/legacy_sync.py::old_import"})
    code = (
        "def old_import(db, msg):\n"
        "    sale = Sale(amount=msg.amount, payment_method='cash')\n"
        "    db.add(sale); db.commit()\n"
    )
    violations, debt = guard.scan(_staged("app/services/legacy_sync.py", code))
    assert violations == [], violations
    assert len(debt) == 1
    assert "legacy_sync" in debt[0]["key"]


# ── 6b. The now-fixed whatsapp write (audit + reversible) → COMPLIANT ──────
def test_fixed_whatsapp_write_now_passes_on_merit():
    code = (
        "def handle_message(db, msg, user):\n"
        "    sale = Sale(amount=msg.amount, payment_method='cash')\n"
        "    db.add(sale); db.flush()\n"
        "    audit_service.record(db, user.id, 'sale.whatsapp_log',\n"
        "        after={'machine_entered': True, 'reversible': True},\n"
        "        actor_type='system.whatsapp_inbound')\n"
        "    db.commit()\n"
    )
    violations, debt = guard.scan(_staged("app/services/whatsapp_service.py", code))
    assert violations == [] and debt == [], (violations, debt)


# ── 7. Non-money write in a background file → IGNORED ──────────────────────
def test_non_money_write_in_background_file_is_ignored():
    code = (
        "def some_sync(db):\n"
        "    cache.last_run = utc_now()\n"
        "    logger.info('synced')\n"
    )
    violations, debt = guard.scan(_staged("app/services/cache_sync.py", code))
    assert violations == [] and debt == []
