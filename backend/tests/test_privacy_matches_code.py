"""Push 3 (Manoj, 11 Oct 2026): /privacy and Terms § 4 say what THIS code does.

The frontend sibling (frontend/src/__tests__/push3Privacy.test.jsx) pins the
sentences. This file pins the code they describe, so a change on either side
fails a test instead of shipping a policy that is no longer true:

  • error log: purged after 30 days        → "30 days" / "30 dage"
  • analytics events: purged after 180 days → "180 days" / "180 dage"
  • accounting-document images of a deleted account: (5 + 1) × 366 days
    → "about 6 years" / "ca. 6 år", and exactly the four kinds § 4 names
  • change log: the Postgres RULE makes a DELETE do nothing → "no end date"
  • security log: nothing deletes it → "no end date"
  • no retention setting anyone can change → no "adjustable 5–10 years"
  • bank CSV: read in memory, never written → "not saved"
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "backend" / "app"
PRIVACY = (ROOT / "frontend" / "src" / "pages" / "PrivacyPolicyPage.jsx").read_text()
TERMS = (ROOT / "frontend" / "src" / "pages" / "TermsPage.jsx").read_text()


def _app_sources():
    return {p: p.read_text() for p in APP.rglob("*.py")}


def test_error_log_is_kept_30_days_as_privacy_says():
    from app.jobs.retention_and_patterns import ERROR_LOG_RETENTION_DAYS
    assert ERROR_LOG_RETENTION_DAYS == 30
    assert '["Error log (technical errors, incl. IP address)", "30 days, also after you delete your account"]' in PRIVACY
    assert '["Fejllog (tekniske fejl, inkl. IP-adresse)", "30 dage, også efter at du har slettet din konto"]' in PRIVACY


def test_analytics_events_are_kept_180_days_as_privacy_says():
    from app.jobs.retention_and_patterns import EVENT_RETENTION_DAYS
    assert EVENT_RETENTION_DAYS == 180
    assert '["Product analytics events", "180 days (auto-purged daily)"]' in PRIVACY
    assert '["Hændelser til produktanalyse", "180 dage (slettes automatisk hver dag)"]' in PRIVACY


def test_deleted_accounts_images_are_kept_about_6_years_and_only_the_four_kinds():
    from app.services.accounting_retention import MIN_RETENTION_YEARS
    from app.services.storage import ACCOUNTING_RETENTION_KINDS
    src = (APP / "services" / "accounting_retention.py").read_text()
    assert "timedelta(days=(MIN_RETENTION_YEARS + 1) * 366)" in src
    days = (MIN_RETENTION_YEARS + 1) * 366
    assert 5.5 * 365 < days < 6.5 * 365  # "about 6 years" / "ca. 6 år"
    # kasserapport photos, receipt (expense) and sales photos, stock import files
    assert ACCOUNTING_RETENTION_KINDS == {"kasserapport", "expense", "sale", "inventory_import"}
    for doc in (PRIVACY, TERMS):
        assert "about 6 years after the deletion" in doc
        assert "ca. 6 år efter sletningen" in doc
        assert "stock import files" in doc
        assert "filer fra lagerimport" in doc


def test_change_log_has_no_end_date_because_the_database_refuses_deletes():
    main = (APP / "main.py").read_text()
    assert "CREATE OR REPLACE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING" in main
    assert "No end date: it cannot be edited or deleted through BonBox, and it is kept when you delete your account" in PRIVACY
    assert "Ingen slutdato: den kan ikke redigeres eller slettes gennem BonBox, og den beholdes, når du sletter din konto" in PRIVACY
    assert "10-year window" not in PRIVACY and "10-årsperioden" not in PRIVACY


def test_security_log_has_no_end_date_because_nothing_deletes_it():
    pattern = re.compile(r"SecurityEvent\)[^\n]*\.delete\(|DELETE FROM security_events|security_events\.delete\(\)")
    hits = [str(p.relative_to(ROOT)) for p, s in _app_sources().items() if pattern.search(s)]
    assert hits == [], hits
    assert '"No end date; kept when you delete your account"' in PRIVACY
    assert '"Ingen slutdato; beholdes, når du sletter din konto"' in PRIVACY
    assert "365 days" not in PRIVACY and "365 dage" not in PRIVACY


def test_no_one_can_change_the_retention_period():
    # The column exists (default 6) but nothing an owner sends can set it:
    # no schema field, no router, no frontend control.
    writers = [
        str(p.relative_to(ROOT)) for p, s in _app_sources().items()
        if "data_retention_years" in s and ("/schemas/" in str(p) or "/routers/" in str(p))
    ]
    assert writers == [], writers
    frontend = [
        str(p.relative_to(ROOT)) for p in (ROOT / "frontend" / "src").rglob("*.jsx")
        if "data_retention_years" in p.read_text()
    ]
    assert frontend == [], frontend
    for gone in ("adjustable 5–10", "extend up to 10 years", "kan justeres til 5–10", "forlænge op til 10 år",
                 "retention setting", "opbevaringsindstilling"):
        assert gone not in PRIVACY, gone


def test_bank_csv_is_never_written_to_disk_or_storage():
    src = (APP / "routers" / "bank_import.py").read_text()
    for writer in ("open(", "get_storage", "upload_bytes", "save_receipt", "write_bytes", "NamedTemporaryFile"):
        assert writer not in src, writer
    assert '["Bank CSV files (raw)", "Not saved: read in memory during the import"]' in PRIVACY
    assert '["Bank-CSV-filer (rå)", "Gemmes ikke: de læses i hukommelsen under importen"]' in PRIVACY


def test_no_ip_anonymisation_is_promised():
    assert "anonymized after 30 days" not in PRIVACY
    assert "anonymiseres efter 30 dage" not in PRIVACY
    # and the change log really keeps the IP
    from app.models.audit_log import AuditLog
    assert "ip_address" in AuditLog.__table__.columns
