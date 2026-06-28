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


# ── 8. Bank-ingest surface is IN SCOPE — a NEW unaudited mint is CAUGHT ─────
# Regression for the coverage gap: bank_connect._ingest_transactions mints
# Sale rows but writes its audit row one frame up (sync_bank_connection /
# aiia_sync_job emit the system actor), so there is no 'system.' string in the
# mint fn's own body. Before the fix, _BACKGROUND_FILE_RE didn't match
# bank_connect.py / aiia_sync_job.py, so a NEW unaudited write there self-
# identified as interactive and slipped through. It must now be flagged.
def test_new_unaudited_write_inside_bank_ingest_surface_is_caught():
    code = (
        "def _ingest_extra(db, user, conn, txns):\n"
        "    for txn in txns:\n"
        "        sale = Sale(amount=abs(txn.amount), payment_method='bank_transfer')\n"
        "        db.add(sale)\n"
        "    db.flush()\n"
    )
    violations, debt = guard.scan(_staged("app/routers/bank_connect.py", code))
    assert len(violations) == 1, violations
    assert "audit_service.record(...)" in violations[0]["missing"]
    assert "a reversibility/undo marker" in violations[0]["missing"]


def test_new_offender_in_different_bank_connect_fn_still_caught():
    # The allowlist covers only the named ingest closures — a NEW unaudited
    # mint added in a DIFFERENT function in the same in-scope file must still
    # be flagged (the file-level pattern doesn't blanket-allow the file).
    code = (
        "def _backfill_legacy(db, user, txns):\n"
        "    for txn in txns:\n"
        "        sale = Sale(amount=abs(txn.amount), payment_method='bank_transfer')\n"
        "        db.add(sale); db.flush()\n"
    )
    violations, _ = guard.scan(_staged("app/routers/bank_connect.py", code))
    assert len(violations) == 1, violations


def test_new_unaudited_write_inside_jobs_module_is_caught():
    # Any module under app/jobs/ is in scope via the `/jobs/` pattern, even a
    # brand-new background job that doesn't match a more specific keyword.
    code = (
        "def _import_feed(db, user, txns):\n"
        "    for txn in txns:\n"
        "        sale = Sale(amount=abs(txn.amount), payment_method='bank_transfer')\n"
        "        db.add(sale); db.flush()\n"
    )
    violations, _ = guard.scan(_staged("app/jobs/new_feed_job.py", code))
    assert len(violations) == 1, violations


# ── 9. The REAL allowlisted ingest path still PASSES ───────────────────────
# bank_connect._ingest_transactions / aiia_sync_job._sync_one are on the
# ALLOWLIST (idempotent dedupe on reference_id, foreign-currency quarantine,
# reversible soft-delete, audit row one frame up). Mirrors today's shipped
# code shape — no inline audit/reversible marker in the body — and must NOT
# be flagged.
def test_real_allowlisted_bank_ingest_path_passes():
    # Mirror the SHIPPED shape: the Sale row is minted inside the `for txn`
    # loop, but the nearest enclosing `def` above it is the nested `_allocate`
    # voucher closure — so the guard resolves the key to `_allocate`, which is
    # what the allowlist must (and does) cover for this file.
    code = (
        "def _ingest_transactions(db, user, conn, txns):\n"
        "    def _allocate(kind, year):\n"
        "        return allocate_voucher(db, user.id, kind, year)\n"
        "    for txn in txns:\n"
        "        ref_id = f'bank_{conn.bank_slug}_{txn.aiia_txn_id}'\n"
        "        sale = Sale(amount=abs(txn.amount), payment_method='bank_transfer',\n"
        "                    reference_id=ref_id, voucher_number=_allocate('sale', 2026))\n"
        "        db.add(sale); db.flush()\n"
    )
    violations, debt = guard.scan(_staged("app/routers/bank_connect.py", code))
    assert violations == [] and debt == [], (violations, debt)


def test_real_allowlisted_aiia_sync_one_passes():
    code = (
        "def _sync_one(db, conn):\n"
        "    ns, ne, sk, sf = _ingest_transactions(db, user, conn, txns)\n"
        "    audit_service.record(db, user, 'bank_connect.sync',\n"
        "        after={'new_sales': ns}, actor_type='system.cron')\n"
    )
    violations, debt = guard.scan(_staged("app/jobs/aiia_sync_job.py", code))
    assert violations == [] and debt == [], (violations, debt)


# ── 10. Smoke test the real WhatsApp inbound mint constructs a Sale ─────────
# whatsapp_service.handle_message built Sale(... description="WhatsApp"), but
# the Sale model has no `description` column (it uses `notes`) → TypeError at
# construction, killing the inbound log-revenue feature silently. This test
# constructs a Sale on that exact path so the TypeError can't return.
def test_whatsapp_inbound_sale_constructs_with_notes_field():
    import uuid
    from datetime import date

    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.database import Base
    from app.models.sale import Sale

    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        user_id = uuid.uuid4()
        # Exactly the kwargs whatsapp_service.handle_message passes.
        sale = Sale(
            user_id=user_id,
            amount=14500,
            date=date.today(),
            payment_method="cash",
            notes="WhatsApp",
        )
        db.add(sale)
        db.flush()
        assert sale.id is not None
        assert sale.notes == "WhatsApp"
        # The model must NOT accept the old (removed) `description` kwarg.
        with pytest.raises(TypeError):
            Sale(user_id=user_id, amount=1, date=date.today(),
                 payment_method="cash", description="WhatsApp")
    finally:
        db.close()


# ── 11. The fixed WhatsApp service source still passes the money-write guard ─
# Guards against a regression that drops the audit row or reversibility marker
# from whatsapp_service.handle_message when the file is edited again.
def test_whatsapp_service_source_passes_guard():
    import os

    src_path = os.path.abspath(
        os.path.join(
            os.path.dirname(__file__), "..", "app", "services", "whatsapp_service.py"
        )
    )
    with open(src_path) as fh:
        content = fh.read()
    violations, debt = guard.scan(_staged("app/services/whatsapp_service.py", content))
    assert violations == [] and debt == [], (violations, debt)
