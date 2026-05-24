import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

# Optional Sentry init — only loaded if SENTRY_DSN env var set AND the
# sentry-sdk package is installed. Wrapped in try/except so missing dep
# never crashes the app. Add `sentry-sdk[fastapi]` to requirements.txt
# only when you're ready to use it.
_SENTRY_DSN = os.environ.get("SENTRY_DSN", "").strip()
if _SENTRY_DSN:
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.sqlalchemy import SqlalchemyIntegration
        sentry_sdk.init(
            dsn=_SENTRY_DSN,
            traces_sample_rate=0.05,   # 5% transaction sampling — keeps quota cheap
            profiles_sample_rate=0.0,  # disabled by default
            send_default_pii=False,    # never include user IPs / cookies
            integrations=[FastApiIntegration(), SqlalchemyIntegration()],
            environment=os.environ.get("ENVIRONMENT", "development"),
        )
    except ImportError:
        # sentry-sdk not installed — env var alone doesn't hurt, just log noise
        import warnings
        warnings.warn("SENTRY_DSN set but sentry-sdk not installed; skipping init")
    except Exception as e:
        import warnings
        warnings.warn(f"Sentry init failed: {e}")

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from sqlalchemy import text

from app.config import settings
from app.routers import auth, sales, expenses, inventory, reports, dashboard, staffing, waste, feedback, cashbook, events, khata, budget, loan, email_settings, whatsapp, weather, agent, bank_import, team, business_profile, payment_import, cashflow, tax, pricing, retention, expiry, outlet, competitor, branch, daily_close, workshop, wine, staff, staff_portal, admin, patterns, exports, waitlist, billing, property_report, kasserapport, terminal, output_channel, order_channel_config, inventory_smart_import, smart_drift, support, search as search_router, modules as modules_router, ai as ai_router, smart_pricing as smart_pricing_router
# Invoicing — Customer/Invoice/Mileage. Gated to Starter+ at the route level.
from app.routers import customers as customers_router, invoices as invoices_router, mileage as mileage_router
from app.routers import payment_suggestions as payment_suggestions_router
from app.routers import recurring_expenses as recurring_expenses_router
# Task #49 — accountant read-only login (many-to-many revisor grants)
from app.routers import accountants as accountants_router
# Task #61 — magic-link passwordless login. Separate router so the
# enumeration-safe + rate-limited request/verify endpoints aren't
# tangled with the password-based /login + /register surface in auth.py.
from app.routers import auth_magic_link as auth_magic_link_router
# Task #68 — per-user demo data toggle. Lets new owners populate
# their own account with sample rows so the dashboard / brief light up
# instantly, and clear them with one tap.
from app.routers import demo as demo_router
# Task #85 — public founder-rate status (landing page urgency pill).
# Single unauthenticated endpoint, rate-limited, aggregate-only.
from app.routers import founder_rate as founder_rate_router
# Task #65 — unified OAuth (Apple + Google). Separate router so the
# new find-or-create / link semantics + token-verification multi-layer
# stays cleanly isolated from the legacy /auth/apple + /auth/google
# code paths in auth.py (which we keep for back-compat).
from app.routers import auth_oauth as auth_oauth_router
# Task #67 — Aiia (Mastercard Open Banking) connect + sync. Replaces
# the CSV-upload-hassle pain on /bank-import with a real PSD2 feed.
# Sandbox-mode default so we ship without real Aiia creds.
from app.routers import bank_connect as bank_connect_router
# Task #71 — MobilePay Erhverv (Vipps MobilePay Business) connect +
# sync. Sibling of Aiia for the OTHER half of the payment story:
# per-settlement granularity that Aiia's aggregate payout line hides.
# Mock-mode default until the partner agreement closes for prod creds.
from app.routers import mobilepay as mobilepay_router
# Task #72 — Web Push (VAPID) subscribe / unsubscribe / public-key /
# test endpoints. Mounted under /api/push. The 8am morning brief
# delivery cron lives in app.jobs.daily_brief_push_job.
from app.routers import push as push_router
from app.database import engine, Base, get_db
from app.models import *  # noqa: ensure all models are loaded

# DB readiness flag — set once tables + migrations are done
_db_ready = threading.Event()

# Run schema migrations (idempotent — safe to run multiple times)
_migrations = [
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) DEFAULT 'card'",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS notes TEXT",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP",
    "ALTER TABLE waste_logs ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false",
    "ALTER TABLE waste_logs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP",
    "ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false",
    "ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP",
    "ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS reference_id VARCHAR(100)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(100)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS is_personal BOOLEAN DEFAULT false",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS reference_id VARCHAR(100)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_digest_enabled BOOLEAN DEFAULT false",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS expense_alerts_enabled BOOLEAN DEFAULT true",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS currency VARCHAR(10)",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS reference_id VARCHAR(100)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_goal NUMERIC(12,2) DEFAULT 0",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS bottle_size NUMERIC(10,2)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS pour_size NUMERIC(10,2)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS pour_unit VARCHAR(20)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sell_price_per_pour NUMERIC(12,2)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,6)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,6)",
    # Returns / exchange tracking on sales
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'completed'",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS return_reason TEXT",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS return_action VARCHAR(20)",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS return_amount NUMERIC(12,2)",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS returned_at TIMESTAMP",
    # Item-sale columns
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS inventory_item_id VARCHAR(36) REFERENCES inventory_items(id) ON DELETE SET NULL",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS quantity_sold NUMERIC(10,2)",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS unit_price NUMERIC(12,2)",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS cost_at_sale NUMERIC(12,2)",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS item_name TEXT",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_tax_exempt BOOLEAN DEFAULT false",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_photo VARCHAR(500)",
    # Inventory items — columns that may have been added after initial create
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sell_price NUMERIC(12,2)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS barcode TEXT",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS expiry_date DATE",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS image_url TEXT",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_perishable BOOLEAN DEFAULT false",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'General'",
    # Expenses
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS is_tax_exempt BOOLEAN DEFAULT false",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_photo VARCHAR(500)",
    # Inventory logs
    "ALTER TABLE inventory_logs ADD COLUMN IF NOT EXISTS batch_id TEXT",
    # Users
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS business_type VARCHAR(50) DEFAULT 'restaurant'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_goal NUMERIC(12,2) DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'owner'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS owner_id VARCHAR(36) REFERENCES users(id)",
    # Khata / Loans soft-delete
    "ALTER TABLE khata_customers ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false",
    "ALTER TABLE loan_persons ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false",
    # Payment connections — auto-sync
    "ALTER TABLE payment_connections ADD COLUMN IF NOT EXISTS auto_sync BOOLEAN DEFAULT true",
    "ALTER TABLE payment_connections ADD COLUMN IF NOT EXISTS last_auto_imported INTEGER DEFAULT 0",
    # Branch-based bookkeeping — nullable branch_id on core tables
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS branch_id VARCHAR(36)",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS branch_id VARCHAR(36)",
    "ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS branch_id VARCHAR(36)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS branch_id VARCHAR(36)",
    "ALTER TABLE waste_logs ADD COLUMN IF NOT EXISTS branch_id VARCHAR(36)",
    # Sell-unit conversion (stock in dozen, sell in pieces)
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sell_unit VARCHAR(20)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS pieces_per_unit NUMERIC(10,2)",
    # Daily Close — MOMS / VAT fields
    "ALTER TABLE daily_closes ADD COLUMN IF NOT EXISTS moms_total NUMERIC(12,2)",
    "ALTER TABLE daily_closes ADD COLUMN IF NOT EXISTS revenue_ex_moms NUMERIC(12,2)",
    "ALTER TABLE daily_closes ADD COLUMN IF NOT EXISTS moms_mode VARCHAR(10)",
    # Daily Close — status & lock/unlock
    "ALTER TABLE daily_closes ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'confirmed'",
    "ALTER TABLE daily_closes ADD COLUMN IF NOT EXISTS unlock_reason TEXT",
    "ALTER TABLE daily_closes ADD COLUMN IF NOT EXISTS unlocked_by VARCHAR(255)",
    "ALTER TABLE daily_closes ADD COLUMN IF NOT EXISTS unlocked_at TIMESTAMP",
    # Business profile — night shift cutoff
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS day_cutoff_hour INTEGER DEFAULT 0",
    # Wine menu — display name + glass pricing
    "ALTER TABLE wines ADD COLUMN IF NOT EXISTS menu_name VARCHAR(255)",
    "ALTER TABLE wines ADD COLUMN IF NOT EXISTS glass_price NUMERIC(12,2)",
    # Competitor — Google Places fields
    "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS place_id VARCHAR(255)",
    "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS google_rating FLOAT",
    "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS price_level INTEGER",
    "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS latitude FLOAT",
    "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS longitude FLOAT",
    "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS photo_ref VARCHAR(500)",
    "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS total_ratings INTEGER",
    # Email verification
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code VARCHAR(10)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code_expires TIMESTAMP",
    # GDPR — opt-out toggle for product analytics
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS analytics_opt_out BOOLEAN DEFAULT false",
    # User-local timezone — IANA name, e.g. "Europe/Copenhagen". Drives
    # "today" / "this week" boundaries in pattern detection.
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT 'Europe/Copenhagen'",
    # 14-day Pro trial mechanics
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS plan VARCHAR(20) DEFAULT 'free'",
    # Stripe subscription state — webhook is source-of-truth, never client-set
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(64)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(64)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(32)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_period_end TIMESTAMP",
    "CREATE INDEX IF NOT EXISTS ix_users_stripe_customer ON users (stripe_customer_id)",
    "CREATE INDEX IF NOT EXISTS ix_users_stripe_subscription ON users (stripe_subscription_id)",
    # Branch business_type — added to model in branch.py but never migrated.
    # Missing column was crashing user→branches relationship loading on every
    # /billing/me, /billing/stripe/sync, and webhook handler that touched the
    # user object. Default 'general' matches the model default.
    "ALTER TABLE branches ADD COLUMN IF NOT EXISTS business_type VARCHAR(50) DEFAULT 'general'",
    # Tax filing preferences (DK SMBs <5M kr file half_yearly by default; quarterly is opt-in for larger)
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_filing_frequency VARCHAR(20)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS prices_include_moms BOOLEAN DEFAULT true",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS has_employees BOOLEAN DEFAULT false",
    # Wine sales — distinguish bottle vs glass sales (legacy rows default to "bottle")
    "ALTER TABLE wine_sales ADD COLUMN IF NOT EXISTS unit_type VARCHAR(10) DEFAULT 'bottle'",
    # Bilagsnummer — DK Bogføringsloven 2024 compliance
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS voucher_number INTEGER",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voucher_number INTEGER",
    "CREATE INDEX IF NOT EXISTS ix_sales_voucher ON sales (user_id, voucher_number)",
    "CREATE INDEX IF NOT EXISTS ix_expenses_voucher ON expenses (user_id, voucher_number)",
    # Error log — observability without external dependencies (Sentry alternative)
    """CREATE TABLE IF NOT EXISTS error_logs (
        id VARCHAR(36) PRIMARY KEY,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        method VARCHAR(10),
        path VARCHAR(500),
        status_code INTEGER,
        user_id VARCHAR(36),
        ip_address VARCHAR(64),
        user_agent VARCHAR(500),
        error_type VARCHAR(100),
        message TEXT,
        traceback TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS ix_error_logs_created ON error_logs (created_at DESC)",
    "CREATE INDEX IF NOT EXISTS ix_error_logs_status ON error_logs (status_code)",
    # Danish restaurant operations — Property Financial Report fields.
    # Modeled on the Sticks'n'Sushi closing format: order channel, guest count,
    # service charge, discount, and the void/error-correct ladder.
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS order_channel VARCHAR(20) DEFAULT 'dine_in'",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS guest_count INTEGER",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS service_charge_amount NUMERIC(12,2)",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2)",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_void BOOLEAN DEFAULT false",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_manager_void BOOLEAN DEFAULT false",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_error_correct BOOLEAN DEFAULT false",
    "CREATE INDEX IF NOT EXISTS ix_sale_user_channel ON sales (user_id, order_channel, date)",
    # Performance indexes for dashboard queries
    "CREATE INDEX IF NOT EXISTS ix_sale_user_date ON sales (user_id, date, is_deleted)",
    "CREATE INDEX IF NOT EXISTS ix_sale_user_payment ON sales (user_id, payment_method, date)",
    "CREATE INDEX IF NOT EXISTS ix_expense_user_date ON expenses (user_id, date, is_deleted)",
    "CREATE INDEX IF NOT EXISTS ix_expense_user_category ON expenses (user_id, category_id, date)",
    "CREATE INDEX IF NOT EXISTS ix_inventory_user_stock ON inventory_items (user_id, quantity, min_threshold)",
    # Indexes on event_logs for fast admin queries (DAU/WAU/MAU and per-user timelines)
    "CREATE INDEX IF NOT EXISTS ix_event_user_created ON event_logs (user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_event_created ON event_logs (created_at)",
    "CREATE INDEX IF NOT EXISTS ix_event_event ON event_logs (event)",
    # security_events — audit log for admin access attempts (multi-layer guard)
    """CREATE TABLE IF NOT EXISTS security_events (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) REFERENCES users(id),
        event_type VARCHAR(64) NOT NULL,
        ip_address VARCHAR(64),
        user_agent VARCHAR(500),
        detail TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_security_events_user ON security_events (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_security_events_event_created ON security_events (event_type, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_security_events_created ON security_events (created_at)",
    # owner_patterns — AI-detected behavioural / business patterns per user
    """CREATE TABLE IF NOT EXISTS owner_patterns (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        pattern_type VARCHAR(64) NOT NULL,
        severity VARCHAR(20) DEFAULT 'info',
        title VARCHAR(200) NOT NULL,
        detail TEXT NOT NULL,
        suggested_action TEXT,
        detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        valid_until TIMESTAMP,
        state VARCHAR(20) DEFAULT 'active',
        feedback VARCHAR(20),
        feedback_at TIMESTAMP,
        raw_data TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS ix_owner_patterns_user ON owner_patterns (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_owner_patterns_user_state ON owner_patterns (user_id, state)",
    "CREATE INDEX IF NOT EXISTS ix_owner_patterns_user_type ON owner_patterns (user_id, pattern_type)",
    "CREATE INDEX IF NOT EXISTS ix_owner_patterns_detected ON owner_patterns (detected_at)",
    # waitlist_entries — interest capture for paid tiers
    """CREATE TABLE IF NOT EXISTS waitlist_entries (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) REFERENCES users(id),
        email VARCHAR(255) NOT NULL,
        tier VARCHAR(32) NOT NULL,
        source VARCHAR(64),
        notes VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_waitlist_user ON waitlist_entries (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_waitlist_email ON waitlist_entries (email)",
    "CREATE INDEX IF NOT EXISTS ix_waitlist_email_tier ON waitlist_entries (email, tier)",
    "CREATE INDEX IF NOT EXISTS ix_waitlist_created ON waitlist_entries (created_at)",
    # Daily AI brief — one cached row per user per day. Schema mirrors
    # app/models/daily_brief.py. Created here (rather than via SQLAlchemy
    # create_all) so we don't need to bounce the whole DB schema on deploy.
    """CREATE TABLE IF NOT EXISTS daily_briefs (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        brief_date DATE NOT NULL,
        payload_json TEXT NOT NULL,
        tier VARCHAR(16) NOT NULL DEFAULT 'free',
        model VARCHAR(64) NOT NULL DEFAULT 'deterministic',
        input_tokens INTEGER,
        output_tokens INTEGER,
        refresh_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_daily_brief_user_date UNIQUE (user_id, brief_date)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_daily_brief_user_date ON daily_briefs (user_id, brief_date)",
    # Anomaly alerts — flagged unusual events surfaced on the dashboard.
    # Schema mirrors app/models/anomaly_alert.py.
    """CREATE TABLE IF NOT EXISTS anomaly_alerts (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        scan_date DATE NOT NULL,
        kind VARCHAR(40) NOT NULL,
        severity VARCHAR(16) NOT NULL DEFAULT 'medium',
        title VARCHAR(140) NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        reference_id VARCHAR(64),
        reference_type VARCHAR(32),
        polished_by_ai BOOLEAN NOT NULL DEFAULT FALSE,
        dismissed_at TIMESTAMP,
        dismissed_reason VARCHAR(40),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_anomaly_user_date ON anomaly_alerts (user_id, scan_date)",
    "CREATE INDEX IF NOT EXISTS ix_anomaly_user_open ON anomaly_alerts (user_id, dismissed_at)",
    # AI Triage notes — first-responder summary of error fingerprints.
    """CREATE TABLE IF NOT EXISTS triage_notes (
        id UUID PRIMARY KEY,
        fingerprint VARCHAR(32) NOT NULL,
        severity VARCHAR(16) NOT NULL DEFAULT 'medium',
        error_type VARCHAR(100),
        path_template VARCHAR(500),
        sample_message TEXT,
        probable_cause TEXT NOT NULL DEFAULT '',
        blast_radius TEXT NOT NULL DEFAULT '',
        suggested_actions TEXT NOT NULL DEFAULT '',
        polished_by_ai BOOLEAN NOT NULL DEFAULT FALSE,
        sample_error_id UUID,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        affected_users INTEGER NOT NULL DEFAULT 0,
        first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        latest_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        email_sent BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_triage_fingerprint ON triage_notes (fingerprint)",
    "CREATE INDEX IF NOT EXISTS ix_triage_created ON triage_notes (created_at)",
    # ── Migration 009 (alembic equivalent): role on output_channels ──
    # Stakes the closer ≠ owner segment in the recipient model.
    "ALTER TABLE output_channels ADD COLUMN IF NOT EXISTS role VARCHAR(20)",
    # ── Migration 010 (alembic equivalent): enabled_modules on users ──
    # Vertical-module gating storage (CSV of module IDs from
    # services/modules.py:MODULES). NULL = no modules picked yet.
    # Without this column, the User model SELECT crashes with
    # 'column users.enabled_modules does not exist' → all auth fails.
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS enabled_modules TEXT",
    # ── Migration 011: inventory_imports — smart-import audit table ──
    # Mirrors KasserapportExtraction shape. Logs every smart-inventory
    # import attempt (text/CSV/Excel/image upload → AI extraction →
    # categorization → user review → commit) for cost/learning/audit.
    # Bogføringsloven §10: 5-year retention since these rows feed real
    # InventoryItem stock used in COGS / margin reports.
    """CREATE TABLE IF NOT EXISTS inventory_imports (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        source_kind VARCHAR(20) NOT NULL DEFAULT 'text',
        source_filename VARCHAR(255),
        source_size_bytes INTEGER,
        source_sha256 VARCHAR(64),
        extracted_json JSON,
        categorized_json JSON,
        final_json JSON,
        item_count INTEGER NOT NULL DEFAULT 0,
        committed_count INTEGER NOT NULL DEFAULT 0,
        user_corrected BOOLEAN NOT NULL DEFAULT FALSE,
        manual_review_needed BOOLEAN NOT NULL DEFAULT TRUE,
        extraction_confidence FLOAT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        model_used VARCHAR(60),
        timing_ms JSON,
        error TEXT,
        prompt_version VARCHAR(80),
        status VARCHAR(20) NOT NULL DEFAULT 'created',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        committed_at TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_inventory_imports_user_id ON inventory_imports (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_inventory_imports_user_created ON inventory_imports (user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_inventory_imports_user_status ON inventory_imports (user_id, status)",
    "CREATE INDEX IF NOT EXISTS ix_inventory_imports_sha256 ON inventory_imports (source_sha256)",
    "CREATE INDEX IF NOT EXISTS ix_inventory_imports_created_at ON inventory_imports (created_at)",
    # ── Migration 012: inventory_import_examples — per-owner few-shot ──
    # Captures owner corrections from smart-import /commit so the next
    # extraction prompt for the same owner gets few-shot examples.
    # Per-user only (no global sharing — vocabularies are owner-private).
    """CREATE TABLE IF NOT EXISTS inventory_import_examples (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        kind VARCHAR(30) NOT NULL DEFAULT 'name_correction',
        extracted_name VARCHAR(200) NOT NULL,
        extracted_category VARCHAR(60),
        final_name VARCHAR(200) NOT NULL,
        final_category VARCHAR(60),
        promoted_from_import_id UUID REFERENCES inventory_imports(id) ON DELETE SET NULL,
        hit_count INTEGER NOT NULL DEFAULT 1,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_inv_imp_examples_user_id ON inventory_import_examples (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_inv_imp_examples_user_kind ON inventory_import_examples (user_id, kind)",
    "CREATE INDEX IF NOT EXISTS ix_inv_imp_examples_user_extracted ON inventory_import_examples (user_id, extracted_name)",
    # ── Migration 013: storage_key on inventory_imports ──
    # Path to the original uploaded image in Supabase Storage so the
    # owner can re-view their upload from the review screen + we have
    # a Bogføringsloven §10 source-document trail. NULL for text/CSV/
    # Excel imports (no image to retain).
    "ALTER TABLE inventory_imports ADD COLUMN IF NOT EXISTS storage_key VARCHAR(300)",
    # ── Migration 014: widen receipt_photo to TEXT ──
    # When the legacy save_receipt_photo flow was migrated to private
    # bucket + signed URLs (commit 35fdeb6), the returned URL grew from
    # ~150 chars (public URL) to ~700 chars (signed URL with JWT token).
    # The old VARCHAR(500) overflows on insert → 500 errors on
    # POST /api/sales/from-receipt. TEXT has no length cap.
    "ALTER TABLE sales ALTER COLUMN receipt_photo TYPE TEXT",
    "ALTER TABLE expenses ALTER COLUMN receipt_photo TYPE TEXT",
    # ── Migration 015: receipt_photo on daily_closes ──
    # The Z-report / kasserapport photo was uploaded to storage but
    # never persisted on the close row, so owners couldn't re-view
    # the source document later. Bogføringsloven §10 retention.
    "ALTER TABLE daily_closes ADD COLUMN IF NOT EXISTS receipt_photo TEXT",
    # ── Migration 016: is_global on inventory_import_examples ──
    # When the founder (super_admin) uploads + corrects a smart import,
    # those corrections become global training data benefiting every
    # owner — same pattern as KasserapportExample.is_global. user_id
    # becomes nullable so global examples don't pin to one owner.
    "ALTER TABLE inventory_import_examples ADD COLUMN IF NOT EXISTS is_global BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE inventory_import_examples ALTER COLUMN user_id DROP NOT NULL",
    "CREATE INDEX IF NOT EXISTS ix_inv_imp_examples_is_global ON inventory_import_examples (is_global)",
    # ── Migration 017: accountant_email on business_profiles ──
    # Lets the owner save their bookkeeper's email once so the
    # "Send to accountant" button on Daily Close range export can
    # pre-fill the To: field. Stored on BusinessProfile rather than
    # User because in multi-branch / multi-business setups each
    # business may have its own accountant.
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS accountant_email VARCHAR(255)",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS accountant_name VARCHAR(255)",
    # ── Migration 018: multilayer CVR verification trail ──
    # Tracks when + how the business profile was last verified against
    # the official register, plus DAWA address verification + status
    # flags + MOMS registration. Powers the Re-verify button, the
    # "✓ Verified · CVR · 39842851 · 2 days ago" stamp, and the
    # warning banners (konkurs / not-VAT-registered / protected).
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS cvr_verified_at TIMESTAMP",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS cvr_verified_source VARCHAR(50)",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS dawa_address_id VARCHAR(50)",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS vat_registered BOOLEAN",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS status_flags TEXT",
    # ── Migration 019: staff_absences (sick calls + PTO + future) ──
    # Net-new table backing app/models/absence.py:StaffAbsence. Backs
    # the Planday-class scheduling story (sick-call flow this commit;
    # PTO/no-show/late will reuse the same table via the `kind` field).
    # Kept idempotent — re-running on a populated DB is a no-op.
    """CREATE TABLE IF NOT EXISTS staff_absences (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        staff_id UUID NOT NULL REFERENCES staff_members(id),
        kind VARCHAR(20) NOT NULL DEFAULT 'sick',
        schedule_id UUID REFERENCES schedules(id),
        date DATE NOT NULL,
        reason TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        replacement_staff_id UUID REFERENCES staff_members(id),
        acknowledged_at TIMESTAMP,
        called_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_staff_absence_user_date ON staff_absences (user_id, date)",
    "CREATE INDEX IF NOT EXISTS ix_staff_absence_staff_date_kind ON staff_absences (staff_id, date, kind)",
    # ── Migration 020: shift_swap_requests (peer-to-peer swap state machine) ──
    # Net-new table backing app/models/shift_swap.py:ShiftSwapRequest.
    # Phase 2 of SmartShift — staff trade shifts via the magic-link
    # portal, owner approves with one tap. to_staff_id + to_shift_id
    # nullable so the same table can host the future "shift sale"
    # / give-away mode (v2) without a migration.
    """CREATE TABLE IF NOT EXISTS shift_swap_requests (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        from_staff_id UUID NOT NULL REFERENCES staff_members(id),
        from_shift_id UUID NOT NULL REFERENCES schedules(id),
        to_staff_id UUID REFERENCES staff_members(id),
        to_shift_id UUID REFERENCES schedules(id),
        status VARCHAR(20) NOT NULL DEFAULT 'proposed',
        reason TEXT,
        owner_note TEXT,
        responded_at TIMESTAMP,
        decided_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_shift_swap_user_status ON shift_swap_requests (user_id, status)",
    "CREATE INDEX IF NOT EXISTS ix_shift_swap_from_staff ON shift_swap_requests (from_staff_id)",
    "CREATE INDEX IF NOT EXISTS ix_shift_swap_to_staff ON shift_swap_requests (to_staff_id)",
    # ── Migration 021: Smart Staffing operating profile + role targets ──
    # Three additive columns on business_profiles, plus a new
    # staff_role_targets table. All idempotent.
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS open_days_mask VARCHAR(7)",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS operating_hours_json TEXT",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS peak_windows_json TEXT",
    """CREATE TABLE IF NOT EXISTS staff_role_targets (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        role VARCHAR(50) NOT NULL,
        default_count NUMERIC(4,1) NOT NULL DEFAULT 1.0,
        notes VARCHAR(200),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_staff_role_target_user_role UNIQUE (user_id, role)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_staff_role_target_user ON staff_role_targets (user_id)",
    # ── Migration 022: Smart Inventory consumption metadata ──
    # Four additive columns on inventory_items. Items without these
    # set stay on the legacy quantity-tracking path; auto-decrement
    # only activates when consumption_pattern is set.
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS consumption_pattern VARCHAR(20)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS consumption_unit VARCHAR(20)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS serving_size NUMERIC(12,4)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS usage_keywords TEXT",
    # ── Migration 023: Smart Terminals — per-sale terminal scoping ──
    # Optional terminal_id on the sales table. Auto-routed by
    # terminal_inference.find_terminal_for_label() when the sale source
    # carries a "Term 2"-style label (POS export rows, kasserapport
    # ingest). NULL is fine for single-terminal venues. Index on the
    # column so per-terminal revenue reports stay fast at scale.
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(36)",
    "CREATE INDEX IF NOT EXISTS ix_sales_user_terminal ON sales (user_id, terminal_id)",
    # ── Migration 024: Smart drift findings ──
    # Surfaces "things have changed" suggestions detected by the weekly
    # re-inference job. Idempotent — running the scan twice doesn't
    # duplicate the banner row. Indexed on (user_id, kind, dismissed_at)
    # so the dashboard "open findings" query stays cheap.
    """CREATE TABLE IF NOT EXISTS smart_drift_findings (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        kind VARCHAR(20) NOT NULL,
        title VARCHAR(140) NOT NULL,
        payload_json TEXT,
        summary TEXT,
        detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        dismissed_at TIMESTAMP,
        applied_at TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_smart_drift_user_kind_open ON smart_drift_findings (user_id, kind, dismissed_at)",
    # ── Migration 025: Support triage inbox ──
    # In-app support requests routed to the founder. Lifecycle:
    # open → responded → closed. Indexed for the admin's "open queue"
    # query and the owner's "my tickets" page.
    """CREATE TABLE IF NOT EXISTS support_tickets (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        kind VARCHAR(40) NOT NULL DEFAULT 'other',
        subject VARCHAR(140) NOT NULL,
        body TEXT NOT NULL,
        context TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'open',
        response_text TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        responded_at TIMESTAMP,
        closed_at TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_support_user_created ON support_tickets (user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_support_open_status ON support_tickets (status, created_at)",
    # ── Migration 026: Schedule.confirmed_at — bidirectional schedule
    # confirmation flow (May 2026). When staff taps "I've got it" on
    # their portal, we stamp this timestamp; the owner's dashboard
    # shows a calm "N of M confirmed for this week" signal. NULL = not
    # yet confirmed (or shift predates the feature).
    "ALTER TABLE schedules ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP",
    # ── Migration 027: Sign in with Apple — stable user identifier ──
    # `apple_user_id` is Apple's `sub` claim from the verified identity
    # token; we use it for find-or-create when Apple returns a private
    # relay email (which can change later). Idempotent column add.
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_user_id VARCHAR(64)",
    "CREATE INDEX IF NOT EXISTS ix_users_apple_user_id ON users (apple_user_id)",
    # ── Migration 028: Danish payroll tax-card columns ──
    # StaffMember.tax_card_type ("hovedkort" / "bikort" / "frikort") and
    # tax_card_rate (optional 0..0.6 override) have been on the model for
    # a while, but the ALTER never made it into the migrations list. On
    # any prod DB that pre-dates them, GET /api/staff/members blows up
    # with `UndefinedColumn: tax_card_type` → FastAPI 500 → Render 503.
    # That broke /staff/schedule and /staff/tips for existing tenants.
    # Idempotent — safe to re-run.
    "ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS tax_card_type VARCHAR(20)",
    "ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS tax_card_rate NUMERIC(5,4)",
    # ── Migration 029: kasserapport_extractions audit-trail columns ──
    # Added to the model in commit 92677296 ("harden pipeline") to make
    # extractions idempotent on re-upload (image_sha256) and to track
    # which prompt version produced each result (prompt_version). The
    # table itself dates back to d230a039 — model-vs-migration drift.
    # SELECT * from this table will UndefinedColumn → 503 if either
    # ever gets used on a pre-existing prod DB. Idempotent ADD COLUMN.
    "ALTER TABLE kasserapport_extractions ADD COLUMN IF NOT EXISTS image_sha256 VARCHAR(64)",
    "ALTER TABLE kasserapport_extractions ADD COLUMN IF NOT EXISTS prompt_version VARCHAR(80)",
    "CREATE INDEX IF NOT EXISTS ix_kr_extractions_image_sha256 ON kasserapport_extractions (image_sha256)",
    # ── Migration 030: Customer (debitor) records ──
    # Used by the Faktura flow on Starter tier and up. Distinct from
    # khata_customers (informal credit) — these are formal billing entities
    # with CVR + statutory address per Bogføringsloven.
    """CREATE TABLE IF NOT EXISTS customers (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        branch_id UUID REFERENCES branches(id),
        name VARCHAR(255) NOT NULL,
        cvr VARCHAR(8),
        is_company BOOLEAN NOT NULL DEFAULT FALSE,
        email VARCHAR(255),
        phone VARCHAR(50),
        address TEXT,
        zipcode VARCHAR(10),
        city VARCHAR(100),
        country VARCHAR(2) NOT NULL DEFAULT 'DK',
        dawa_address_id VARCHAR(36),
        payment_terms_days INTEGER NOT NULL DEFAULT 14,
        default_lang VARCHAR(2) NOT NULL DEFAULT 'da',
        is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_customers_user_id ON customers (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_customers_branch_id ON customers (branch_id)",
    "CREATE INDEX IF NOT EXISTS ix_customers_user_name ON customers (user_id, name)",
    "CREATE INDEX IF NOT EXISTS ix_customers_user_cvr ON customers (user_id, cvr)",

    # ── Migration 031: Invoices (faktura) + lines ──
    # Faktura with gap-less sequential `fakturanummer` per (user, branch, year).
    # voiding generates a kreditnota (credit-note Invoice) — never delete.
    """CREATE TABLE IF NOT EXISTS invoices (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        branch_id UUID REFERENCES branches(id),
        customer_id UUID NOT NULL REFERENCES customers(id),
        fakturanummer INTEGER NOT NULL,
        issue_date DATE NOT NULL,
        due_date DATE NOT NULL,
        sent_at TIMESTAMP,
        paid_at TIMESTAMP,
        status VARCHAR(20) NOT NULL DEFAULT 'draft',
        subtotal_net NUMERIC(12,2) NOT NULL DEFAULT 0,
        moms_total NUMERIC(12,2) NOT NULL DEFAULT 0,
        total_gross NUMERIC(12,2) NOT NULL DEFAULT 0,
        paid_amount NUMERIC(12,2),
        currency VARCHAR(3) NOT NULL DEFAULT 'DKK',
        notes TEXT,
        customer_lang VARCHAR(2) NOT NULL DEFAULT 'da',
        credited_by_id UUID REFERENCES invoices(id),
        is_credit_note BOOLEAN NOT NULL DEFAULT FALSE,
        locked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_invoices_seq_per_branch UNIQUE (user_id, branch_id, fakturanummer)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_invoices_user_id ON invoices (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_invoices_branch_id ON invoices (branch_id)",
    "CREATE INDEX IF NOT EXISTS ix_invoices_customer_id ON invoices (customer_id)",
    "CREATE INDEX IF NOT EXISTS ix_invoices_fakturanummer ON invoices (fakturanummer)",
    "CREATE INDEX IF NOT EXISTS ix_invoices_status ON invoices (user_id, status)",
    "CREATE INDEX IF NOT EXISTS ix_invoices_due ON invoices (user_id, due_date)",

    """CREATE TABLE IF NOT EXISTS invoice_lines (
        id UUID PRIMARY KEY,
        invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        line_order INTEGER NOT NULL DEFAULT 0,
        description TEXT NOT NULL,
        quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
        unit VARCHAR(20),
        unit_price_net NUMERIC(10,2) NOT NULL,
        moms_rate NUMERIC(4,3) NOT NULL DEFAULT 0.250,
        line_net NUMERIC(12,2) NOT NULL,
        line_moms NUMERIC(12,2) NOT NULL,
        line_gross NUMERIC(12,2) NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS ix_invoice_lines_invoice_id ON invoice_lines (invoice_id)",

    # ── Migration 032: Mileage entries (kørselsgodtgørelse) ──
    # Per-trip log with Skattestyrelsen-mandated fields. Rate frozen at
    # write-time so historical entries stay correct when 2027 rates land.
    """CREATE TABLE IF NOT EXISTS mileage_entries (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        branch_id UUID REFERENCES branches(id),
        trip_date DATE NOT NULL,
        from_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        km NUMERIC(8,2) NOT NULL,
        purpose TEXT NOT NULL,
        vehicle_reg VARCHAR(20),
        rate_per_km NUMERIC(5,4) NOT NULL,
        deduction_amount NUMERIC(10,2) NOT NULL,
        invoice_id UUID REFERENCES invoices(id),
        locked BOOLEAN NOT NULL DEFAULT FALSE,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_mileage_user_id ON mileage_entries (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_mileage_branch_id ON mileage_entries (branch_id)",
    "CREATE INDEX IF NOT EXISTS ix_mileage_trip_date ON mileage_entries (trip_date)",
    "CREATE INDEX IF NOT EXISTS ix_mileage_invoice_id ON mileage_entries (invoice_id)",
    "CREATE INDEX IF NOT EXISTS ix_mileage_user_year ON mileage_entries (user_id, trip_date)",

    # ── Migration 033: Faktura Danish-compliance fields ──
    # Adds the fields Momsbekendtgørelsen §57 requires for a valid Danish
    # faktura. Without these the PDF was missing seller payment details,
    # EAN-nummer for public-sector customers, and the optional separate
    # leveringsdato. All nullable — existing rows stay valid.
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS bank_reg_number VARCHAR(8)",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS bank_account_number VARCHAR(20)",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS mobilepay_number VARCHAR(20)",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS iban VARCHAR(34)",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS bic VARCHAR(11)",
    "ALTER TABLE customers ADD COLUMN IF NOT EXISTS ean_nummer VARCHAR(13)",
    "ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_public_sector BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS delivery_date DATE",

    # ── Migration 034: Faktura safety + branding + audit trail ──
    # Additive columns + two new tables. All nullable / defaulted so the
    # migration is safe to re-run and never blocks existing data.
    #
    # business_profiles — logo + brand customization + retention policy
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS logo_url TEXT",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS accent_color VARCHAR(7)",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS logo_position VARCHAR(10) NOT NULL DEFAULT 'left'",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS data_retention_years INTEGER NOT NULL DEFAULT 6",

    # invoices — payment provenance + 7-day reversibility flag
    "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_via VARCHAR(20)",
    "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_reference TEXT",
    "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS auto_match_reversible BOOLEAN NOT NULL DEFAULT FALSE",

    # sales — link to invoice for revenue-dedup queries (Tax Autopilot).
    #
    # CRITICAL TYPE NOTE — Postgres FK type mismatch hotfix (2026-05-13):
    # The GUID() TypeDecorator in app/database.py maps to VARCHAR(36) on
    # both SQLite AND Postgres (it does NOT use native UUID). So
    # invoices.id and sales.id are VARCHAR(36) on prod. Declaring the new
    # FK column as native UUID would fail with "foreign key constraint
    # type mismatch" — and because _run_migrations swallows per-statement
    # errors via SAVEPOINT, the failure goes silent. The column never
    # gets created and every query that auto-selects Sale.invoice_id
    # (i.e. every Sale query SQLAlchemy issues) returns 500.
    # Lesson: always match the existing column type when adding FKs via
    # raw SQL. Use VARCHAR(36) to match GUID().
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_id VARCHAR(36) REFERENCES invoices(id) ON DELETE SET NULL",
    "CREATE INDEX IF NOT EXISTS ix_sales_invoice_id ON sales (invoice_id)",

    # payment_match_suggestions — confidence-tiered review queue.
    # NOTE: This CREATE TABLE is a safety net — the table is already
    # created via Base.metadata.create_all() in startup (uses GUID() →
    # VARCHAR(36)), so this is normally a no-op. Kept here in case
    # create_all is bypassed in an emergency-restore scenario.
    # IMPORTANT: column types must match what create_all produces
    # (VARCHAR(36) for ids), otherwise FKs to existing tables fail.
    """CREATE TABLE IF NOT EXISTS payment_match_suggestions (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        sale_id VARCHAR(36) NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        invoice_id VARCHAR(36) NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        confidence VARCHAR(10) NOT NULL,
        reason TEXT NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_payment_match_user_status ON payment_match_suggestions (user_id, status, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_payment_match_invoice ON payment_match_suggestions (invoice_id, status)",

    # audit_logs — append-only mutation history
    # JSONB on Postgres, plain TEXT on SQLite. Switched at runtime in
    # _run_migrations (the SQLite path uses TEXT for both state cols).
    # audit_logs — same VARCHAR(36) pattern as payment_match_suggestions.
    # Matches what Base.metadata.create_all() produces via GUID() type;
    # avoids the foreign-key type-mismatch failure that bit Sale.invoice_id.
    """CREATE TABLE IF NOT EXISTS audit_logs (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        actor_id VARCHAR(36) REFERENCES users(id),
        actor_type VARCHAR(50) NOT NULL DEFAULT 'user',
        ip_address VARCHAR(45),
        action VARCHAR(80) NOT NULL,
        entity_type VARCHAR(50) NOT NULL,
        entity_id VARCHAR(36),
        before_state TEXT,
        after_state TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_logs (entity_type, entity_id, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_audit_user_time ON audit_logs (user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_audit_action_time ON audit_logs (action, created_at)",
    # Postgres-only: reject UPDATE/DELETE at the DB layer. Defense-in-
    # depth — if app code has a bug that tries to modify an audit row,
    # the DB refuses silently rather than corrupting the trail.
    # CREATE RULE is Postgres-specific; wrapped in DO so it no-ops on SQLite.
    #
    # Failure surfacing: previously this swallowed all exceptions with
    # WHEN OTHERS THEN NULL, which made a missed RULE install invisible
    # (audit-log tamper resistance silently disappears). Now we RAISE
    # NOTICE so the failure appears in Postgres logs, and we perform a
    # startup self-test below to verify the rule is actually active.
    """DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_class WHERE relname='audit_logs') THEN
            EXECUTE 'CREATE OR REPLACE RULE audit_logs_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING';
            EXECUTE 'CREATE OR REPLACE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING';
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'audit_logs immutability RULE install failed: %', SQLERRM;
    END $$""",

    # ── Migration 035: account lockdown for hostile / probe users ──
    # is_locked = True causes get_current_user to reject the JWT, which
    # effectively kills the session even though the token itself remains
    # cryptographically valid. Reversible via the /unlock endpoint.
    # locked_at / locked_reason are forensic — who/why/when.
    # Default false + nullable timestamps = safe for existing rows.
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT false",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_reason VARCHAR(255)",
    "CREATE INDEX IF NOT EXISTS ix_users_is_locked ON users (is_locked) WHERE is_locked = true",

    # ── Migration 036: cuisine / specialization on business profile ──
    # Powers the "Same cuisine market" card on Competitor Scan — we use
    # this string as the Google Places `keyword` to surface nearby
    # restaurants serving the same food. Free text (max 60), nullable
    # so existing tenants don't break.
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS cuisine VARCHAR(60)",
    "CREATE INDEX IF NOT EXISTS ix_business_profiles_cuisine ON business_profiles (cuisine)",

    # ── Migration 037: Khata user_id indexes (dashboard perf) ──
    # The dashboard's "receivable" computation joins khata_customers +
    # khata_transactions and filters by user_id on both. Neither column
    # was indexed, so Postgres seq-scanned both tables on every batch.
    # The new ix_khata_*_user_id indexes are idempotent (IF NOT EXISTS)
    # so re-runs are safe.
    "CREATE INDEX IF NOT EXISTS ix_khata_customers_user_id ON khata_customers (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_khata_transactions_user_id ON khata_transactions (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_khata_transactions_customer_id ON khata_transactions (customer_id)",

    # ── Migration 038: order_channel_configs — user-editable channels ──
    # Per-tenant catalogue of order channels (Wolt / Uber Eats / Foodora /
    # plus custom additions like Foodpanda or Hungry.dk). System defaults
    # live in services/channel_defaults.SYSTEM_CHANNELS and are merged in
    # at read time — this table only stores custom + override rows.
    #
    # Tenant isolation: UNIQUE(user_id, slug) + every router query
    # filters by user_id. Sales rows reference channel by slug string,
    # not FK, so archiving a row here NEVER detaches historical data.
    # Idempotent — re-running on a populated DB is a no-op.
    """CREATE TABLE IF NOT EXISTS order_channel_configs (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        slug VARCHAR(50) NOT NULL,
        label VARCHAR(100) NOT NULL,
        emoji VARCHAR(8),
        color VARCHAR(32) DEFAULT 'gray-500',
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_archived BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_order_channel_user_slug UNIQUE (user_id, slug)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_order_channel_user_id ON order_channel_configs (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_order_channel_user_slug ON order_channel_configs (user_id, slug)",

    # ── Migration 039: recurring_expenses (Task #47) ────────────────────
    # Starter+ feature — owner-configured monthly expense templates that
    # the nightly cron materializes into Expense rows on schedule. Rent,
    # internet, Microsoft 365, Spotify Business, Wolt commission etc.
    # Materialized expenses are real accounting entries with sequential
    # bilagsnummer — the RecurringExpense template itself is just the
    # saved schedule. Soft-archive via is_active=False to preserve audit
    # trail of past materializations.
    #
    # VARCHAR(36) for ids matches the GUID() type — same lesson as the
    # invoice.id FK fiasco (see Migration 034 comment): native UUID type
    # mismatch silently fails inside the SAVEPOINT wrapper.
    """CREATE TABLE IF NOT EXISTS recurring_expenses (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        branch_id VARCHAR(36) REFERENCES branches(id) ON DELETE SET NULL,
        category_id VARCHAR(36) REFERENCES expense_categories(id),
        name VARCHAR(100) NOT NULL,
        description VARCHAR(200),
        amount NUMERIC(12,2) NOT NULL,
        payment_method VARCHAR(20) NOT NULL DEFAULT 'card',
        frequency VARCHAR(20) NOT NULL DEFAULT 'monthly',
        day_of_month INTEGER NOT NULL DEFAULT 1,
        next_run_date DATE NOT NULL,
        last_run_date DATE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        is_personal BOOLEAN NOT NULL DEFAULT FALSE,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_recurring_expense_user_name UNIQUE (user_id, name)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_recurring_expenses_user_next_run ON recurring_expenses (user_id, next_run_date, is_active)",

    # ── Migration 040: accountant_grants (Task #49) ─────────────────────
    # Many-to-many bridge between accountants (User.role='accountant',
    # owner_id=NULL) and the business owners whose books they keep. A
    # single revisor typically handles 20–100 client businesses so
    # User.owner_id (single FK) won't model this; we need a separate
    # grants table.
    #
    # Lifecycle: pending → active → revoked. Grants stay in the table
    # forever (10y Skatteforvaltningsloven window via audit trail) so
    # owners can later answer "who had access to my books on date X".
    #
    # VARCHAR(36) matches the existing GUID() pattern — same lesson
    # learned in earlier migrations (native UUID type silently breaks
    # FK joins inside SAVEPOINT wrappers). UNIQUE on (accountant, owner)
    # prevents duplicate invites; re-inviting a revoked pair updates the
    # existing row rather than inserting a dupe.
    """CREATE TABLE IF NOT EXISTS accountant_grants (
        id VARCHAR(36) PRIMARY KEY,
        accountant_user_id VARCHAR(36) REFERENCES users(id),
        accountant_email VARCHAR(255) NOT NULL,
        accountant_name VARCHAR(255),
        owner_user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        granted_by VARCHAR(36) NOT NULL REFERENCES users(id),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        invite_token VARCHAR(128) UNIQUE,
        invite_token_expires_at TIMESTAMP,
        invited_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        activated_at TIMESTAMP,
        revoked_at TIMESTAMP,
        last_used_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_accountant_grant_pair UNIQUE (accountant_user_id, owner_user_id)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_accountant_grant_accountant ON accountant_grants (accountant_user_id)",
    "CREATE INDEX IF NOT EXISTS ix_accountant_grant_owner ON accountant_grants (owner_user_id)",
    "CREATE INDEX IF NOT EXISTS ix_accountant_grant_accountant_status ON accountant_grants (accountant_user_id, status)",
    "CREATE INDEX IF NOT EXISTS ix_accountant_grant_owner_status ON accountant_grants (owner_user_id, status)",
    "CREATE INDEX IF NOT EXISTS ix_accountant_grant_invite_token ON accountant_grants (invite_token)",

    # ── Migration 041: target_labor_pct on business_profiles (Task #50) ──
    # The Pro-only Staff Schedule Autopilot uses this to size next week's
    # labor demand: predicted_revenue × target_labor_pct = how many DKK
    # of staff cost we can spend. Bounded [0.10, 0.50] at the service
    # layer; default 0.30 matches the Copenhagen restaurant baseline.
    # NUMERIC(4,3) holds 0.000 - 9.999 with millipoint precision — plenty
    # for a fraction we clamp to 0.10 - 0.50.
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS target_labor_pct NUMERIC(4,3) NOT NULL DEFAULT 0.30",

    # ── Migration 042: first-run onboarding wizard completion (Task #55) ──
    # NULL = user has never finished the welcome wizard → AuthProvider
    # auto-redirects them to /onboarding. Non-null timestamp = they've
    # been through it once (or explicitly skipped) and we leave them on
    # /dashboard. Users can re-trigger the wizard from Profile, which
    # nulls this back out.
    # Backfill: existing users get NOW() so they don't suddenly get
    # forced through onboarding after this deploy. New signups land
    # with NULL (column default) and are walked through the flow.
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMP",
    "UPDATE users SET onboarding_completed_at = NOW() WHERE onboarding_completed_at IS NULL AND created_at < NOW() - INTERVAL '1 day'",

    # ── Migration 043: magic_link_tokens (Task #61) ──────────────────────
    # Single-use, sha256-hashed sign-in tokens for passwordless login.
    # user_id is NULLABLE on purpose: the request flow stamps the row
    # BEFORE we know whether the email maps to a real user, so the
    # response shape stays identical for unknown/known emails (the
    # whole enumeration-safe contract hinges on this). On verify we
    # resolve-or-create the user and back-patch user_id.
    #
    # VARCHAR(36) matches the GUID() pattern (same lesson learned in
    # earlier migrations — native UUID silently breaks FK joins inside
    # SAVEPOINT wrappers). token_hash is sha256 hex (64 chars) and
    # UNIQUE to enable single-row verify lookups + prevent dupe inserts.
    #
    # Indexes:
    #   • (email, created_at)  — rate-limit lookup (3 unused / 10 min)
    #   • (token_hash)         — UNIQUE column already serves verify
    """CREATE TABLE IF NOT EXISTS magic_link_tokens (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) REFERENCES users(id),
        email VARCHAR(255) NOT NULL,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP,
        request_ip VARCHAR(45),
        used_ip VARCHAR(45)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_magic_link_email_created ON magic_link_tokens (email, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_magic_link_token_hash ON magic_link_tokens (token_hash)",
    "CREATE INDEX IF NOT EXISTS ix_magic_link_user_id ON magic_link_tokens (user_id)",

    # ── Migration 044: Unified OAuth columns (Task #65) ──────────────────
    # Apple Sign-In + Google Sign-In each carry a stable subject claim
    # we use as the primary identity key (email can change; sub can't).
    #
    # apple_sub is intentionally separate from the legacy apple_user_id
    # column. The old /auth/apple endpoint keeps writing apple_user_id;
    # the new /auth/oauth/apple endpoint writes BOTH (so a User row
    # created through either path can be looked up either way). Down the
    # road we can drop apple_user_id once /auth/apple migrates fully.
    #
    # oauth_provider stamps the LAST sign-in method so the UI can prompt
    # "you signed in with Google last time" on the next visit. Allowed
    # values are enforced at the application layer (not via CHECK
    # constraint) because the set evolves: apple | google | email |
    # magic_link | password.
    #
    # Both *_sub columns are UNIQUE. Postgres ADD COLUMN IF NOT EXISTS
    # with UNIQUE produces a deferred unique constraint, so we add the
    # column then the index separately for back-compat.
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_sub VARCHAR(255)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider VARCHAR(20)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_apple_sub ON users (apple_sub) WHERE apple_sub IS NOT NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL",

    # ── Migration 045: Inventory Ordering Autopilot (Task #63) ──────────
    # Per-item supplier metadata so the Pro reorder autopilot can group
    # recommendations by supplier_email and send one consolidated order
    # email per merchant. Four additive columns on inventory_items —
    # items without these set still show up in the suggestion list,
    # they just skip the email-send step and surface in the "Add
    # supplier email to send" bucket of the UI.
    #
    # supplier_lead_time_days drives the "today" urgency tier (stockout
    # < lead_time means already-late). Default 1 = same-day local
    # delivery, the conservative small-merchant default.
    #
    # pack_size rounds suggested_qty up to whole supplier-side packs
    # (5kg tomato box → 10kg order, not 6.2kg). Default 1 leaves
    # everything in stocking units.
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(120)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS supplier_email VARCHAR(255)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS supplier_lead_time_days INTEGER DEFAULT 1",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS pack_size NUMERIC(10,3) DEFAULT 1",

    # ── Migration 046: Aiia bank connections (Task #67) ─────────────────
    # PSD2 / Mastercard Open Banking consent + 90-day refresh token per
    # linked account. refresh_token_enc is Fernet-encrypted BYTEA so a
    # DB dump alone never yields a usable bank token. consent_state is
    # cleared once the OAuth callback resolves — single-use.
    #
    # UNIQUE(user_id, aiia_account_id) means re-connecting the same
    # bank account flips the existing row rather than inserting a dupe.
    # aiia_account_id is NULL during the pending state (we don't know
    # the account id until callback), so the unique constraint is
    # effectively (user_id, NULL) for pending — Postgres treats NULLs
    # as distinct so multiple pending rows coexist fine.
    """CREATE TABLE IF NOT EXISTS bank_connections (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        provider VARCHAR(20) NOT NULL DEFAULT 'aiia',
        aiia_account_id VARCHAR(100),
        bank_slug VARCHAR(60),
        account_label VARCHAR(120),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        consent_state VARCHAR(64),
        consent_expires_at TIMESTAMP,
        last_synced_at TIMESTAMP,
        refresh_token_enc BYTEA,
        sandbox_mode BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_bank_connection_user_account UNIQUE (user_id, aiia_account_id)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_bank_connections_user_status ON bank_connections (user_id, status)",
    "CREATE INDEX IF NOT EXISTS ix_bank_connections_status_synced ON bank_connections (status, last_synced_at)",

    # ── Migration 047: MobilePay Erhverv connections (Task #71) ─────────
    # MobilePay's merchant API gives per-settlement granularity that
    # Aiia's aggregate payout line hides. Same Fernet-encrypted token
    # storage as bank_connections, same audit verbs, same Starter+ gate.
    #
    # UNIQUE(user_id) means one MobilePay merchant per BonBox user for
    # v1 — re-connecting flips the existing row rather than inserting a
    # duplicate. v2 may relax this for chains with multiple merchant
    # agreements per outlet.
    """CREATE TABLE IF NOT EXISTS mobilepay_connections (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        mp_merchant_id VARCHAR(100),
        merchant_name VARCHAR(160),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        consent_state VARCHAR(64),
        scopes VARCHAR(255),
        access_token_enc BYTEA,
        refresh_token_enc BYTEA,
        token_expires_at TIMESTAMP,
        consent_expires_at TIMESTAMP,
        last_synced_at TIMESTAMP,
        connected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_mobilepay_connection_user UNIQUE (user_id)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_mobilepay_connections_status_synced ON mobilepay_connections (status, last_synced_at)",

    # ── Migration 048: Web Push subscriptions (Task #72) ─────────────────
    # One row per (user, device endpoint). The morning push cron at
    # 06:00 UTC iterates the active rows and fans the brief out to each.
    # fail_count tracks consecutive 5xx/timeout responses; rows hitting
    # >= 3 OR returning 410 Gone (subscription expired client-side) get
    # hard-deleted by the cron so we never burn budget on dead devices.
    #
    # Privacy: endpoint URLs are PII (~ email addresses for devices) —
    # never log them at INFO; audit rows record counts only, never
    # endpoints. UNIQUE(user_id, endpoint) so re-subscribing the same
    # device on the same user is an idempotent upsert.
    """CREATE TABLE IF NOT EXISTS push_subscriptions (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent VARCHAR(500),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP,
        last_failed_at TIMESTAMP,
        fail_count INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT uq_push_subscription_user_endpoint UNIQUE (user_id, endpoint)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_push_subscriptions_user_id ON push_subscriptions (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_push_subscriptions_fail_count ON push_subscriptions (fail_count)",

    # ── Migration 049: Aiia consent_state TTL (Audit P1 — Task #75) ─────
    # The Aiia /init flow mints a 32-byte CSRF state token and stores
    # it on the row.  Without a TTL, a phished state value can be
    # replayed days later to bind another bank to the victim's row.
    # Stamp now+10min at /init; refuse exchange after that.
    "ALTER TABLE bank_connections ADD COLUMN IF NOT EXISTS consent_state_expires_at TIMESTAMP",

    # ── Migration 050: Daily Brief email opt-in columns (Task #98) ──────
    # Critical hotfix — these two columns were added to the User SQLA
    # model when Task #54 shipped the 8am Brief email digest, but the
    # ALTER TABLE migration was never added to this list.  Prod DB
    # didn't have the columns → every SELECT on `users` (e.g. /auth/login,
    # /auth/me) crashed with "no such column: users.daily_brief_email_enabled".
    # Login was 500-ing for every owner.  Adding the migration now.
    #
    # daily_brief_email_enabled — owner-controlled toggle on the brief
    #   email (Profile → Notifications).  Default TRUE so the brief
    #   actually arrives without an opt-in step.
    # last_brief_emailed_at    — idempotency stamp the morning cron
    #   uses to skip a second send if the job runs twice in one day.
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_brief_email_enabled BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_brief_emailed_at TIMESTAMP",

    # ── Migration 051: GoCardless / multi-provider bank linking (Task #104) ─
    # provider_requisition_id stores the GoCardless requisition UUID we
    # mint at /init time.  At /callback we need to fetch the requisition
    # to discover linked account IDs — GoCardless doesn't do an
    # OAuth-style code exchange (a single requisition ID grants 90-day
    # access).  Nullable because Aiia (the existing provider) doesn't
    # use it.  100 chars is plenty for any provider's identifier.
    "ALTER TABLE bank_connections ADD COLUMN IF NOT EXISTS provider_requisition_id VARCHAR(100)",
    # institution_id stores the GoCardless bank identifier (e.g.
    # "DANSKEBANK_DABADKKK"). Aiia uses bank_slug for the same purpose;
    # we keep both so each provider's native id stays addressable.
    "ALTER TABLE bank_connections ADD COLUMN IF NOT EXISTS provider_institution_id VARCHAR(100)",
    # ── Migration 052: Priority support flag (P10 honesty fix) ───────────
    # Pro-tier tickets get is_priority=true at submit-time so the founder's
    # triage queue can sort priority-first regardless of the ticket's
    # subject prefix. Backfill default = FALSE: pre-existing tickets are
    # treated as standard until/unless the founder edits them, which
    # matches the "started priority on the day the Pro flag landed"
    # contract — we don't retroactively re-tier closed tickets.
    "ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS is_priority BOOLEAN NOT NULL DEFAULT FALSE",
    "CREATE INDEX IF NOT EXISTS ix_support_priority_status ON support_tickets (is_priority, status, created_at)",

    # ── Migration 053: Lane A close-ritual upgrades (Manoj-confirmed) ────
    # `auto_email_on_close` — when True AND tier has close_auto_email,
    # the lock handler fires one email with kasserapport PDF + Z-report
    # photo to owner + accountant. Default TRUE: the Lane A value
    # proposition is "no extra tap" so the opt-in friction belongs on
    # the toggle, not the default. Free users still have the row, the
    # router-layer gate refuses to send for them either way.
    # `bank_drop_dismissed_ids` — comma-separated DailyClose ids the
    # owner has dismissed the bank-drop reminder card on. Capped client-
    # side to ~30 entries with FIFO rolloff (a few thousand chars max).
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_email_on_close BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_drop_dismissed_ids TEXT",
]


def _verify_audit_log_immutability(conn) -> None:
    """Postgres-only startup self-test: insert a sentinel audit row,
    try to DELETE it, and confirm the row is still there. If the DELETE
    succeeded, the RULE is missing and we log a CRITICAL warning so an
    operator can investigate before audit history can be tampered with.

    Runs once per startup. SQLite skips it.
    """
    import uuid as _uuid
    from datetime import datetime as _dt
    from sqlalchemy import text as _text

    if not str(engine.url).startswith("postgresql"):
        return
    try:
        sentinel = _uuid.uuid4()
        conn.execute(_text(
            "INSERT INTO audit_logs (id, user_id, actor_type, action, entity_type, created_at) "
            "VALUES (:id, :uid, 'system.selftest', 'audit.selftest', 'system', :now)"
        ), {"id": sentinel, "uid": _uuid.uuid4(), "now": _dt.utcnow()})
        conn.execute(_text("DELETE FROM audit_logs WHERE id = :id"), {"id": sentinel})
        still_there = conn.execute(_text(
            "SELECT 1 FROM audit_logs WHERE id = :id"
        ), {"id": sentinel}).first()
        if not still_there:
            # DELETE succeeded — RULE is missing. Audit log is mutable.
            import logging as _lg
            _lg.getLogger("bonbox.security").critical(
                "AUDIT LOG IMMUTABILITY CHECK FAILED — audit_logs_no_delete RULE is not active. "
                "Audit history can be tampered with. Investigate immediately."
            )
        else:
            # RULE blocked DELETE — clean up the sentinel by leaving it
            # (it'll be auto-purged by the 10-year retention sweep).
            pass
        conn.commit()
    except Exception as e:
        import logging as _lg
        _lg.getLogger("bonbox.security").warning(
            "audit_logs immutability self-test could not run: %s", e
        )

def _run_migrations():
    """Run schema migrations — works with both PostgreSQL and SQLite."""
    from sqlalchemy import inspect as sa_inspect
    is_sqlite = str(engine.url).startswith("sqlite")

    with engine.connect() as conn:
        if is_sqlite:
            # SQLite: no IF NOT EXISTS, so check columns first then add missing ones
            insp = sa_inspect(engine)
            _cache = {}
            def _has_col(table, col):
                if table not in _cache:
                    try:
                        _cache[table] = {c["name"] for c in insp.get_columns(table)}
                    except Exception:
                        _cache[table] = set()
                return col in _cache[table]

            def _add(table, col, typedef):
                if not _has_col(table, col):
                    try:
                        conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {typedef}"))
                        _cache.setdefault(table, set()).add(col)
                        return True
                    except Exception:
                        pass
                return False

            ok = 0
            # Existing columns
            ok += _add("expenses", "payment_method", "VARCHAR(20) DEFAULT 'card'")
            ok += _add("expenses", "notes", "TEXT")
            ok += _add("sales", "is_deleted", "BOOLEAN DEFAULT 0")
            ok += _add("sales", "deleted_at", "TIMESTAMP")
            ok += _add("expenses", "is_deleted", "BOOLEAN DEFAULT 0")
            ok += _add("expenses", "deleted_at", "TIMESTAMP")
            ok += _add("waste_logs", "is_deleted", "BOOLEAN DEFAULT 0")
            ok += _add("waste_logs", "deleted_at", "TIMESTAMP")
            ok += _add("cash_transactions", "is_deleted", "BOOLEAN DEFAULT 0")
            ok += _add("cash_transactions", "deleted_at", "TIMESTAMP")
            ok += _add("cash_transactions", "reference_id", "VARCHAR(100)")
            ok += _add("users", "reset_token", "VARCHAR(100)")
            ok += _add("users", "reset_token_expires", "TIMESTAMP")
            ok += _add("expenses", "is_personal", "BOOLEAN DEFAULT 0")
            ok += _add("sales", "reference_id", "VARCHAR(100)")
            ok += _add("users", "daily_digest_enabled", "BOOLEAN DEFAULT 0")
            ok += _add("users", "expense_alerts_enabled", "BOOLEAN DEFAULT 1")
            ok += _add("users", "currency", "VARCHAR(10)")
            ok += _add("expenses", "reference_id", "VARCHAR(100)")
            ok += _add("users", "monthly_goal", "NUMERIC(12,2) DEFAULT 0")
            ok += _add("inventory_items", "bottle_size", "NUMERIC(10,2)")
            ok += _add("inventory_items", "pour_size", "NUMERIC(10,2)")
            ok += _add("inventory_items", "pour_unit", "VARCHAR(20)")
            ok += _add("inventory_items", "sell_price_per_pour", "NUMERIC(12,2)")
            ok += _add("users", "latitude", "NUMERIC(10,6)")
            ok += _add("users", "longitude", "NUMERIC(10,6)")
            # Item sale columns (may be missing on older SQLite DBs)
            ok += _add("sales", "inventory_item_id", "VARCHAR(36)")
            ok += _add("sales", "quantity_sold", "NUMERIC(10,2)")
            ok += _add("sales", "unit_price", "NUMERIC(12,2)")
            ok += _add("sales", "cost_at_sale", "NUMERIC(12,2)")
            ok += _add("sales", "item_name", "TEXT")
            # Returns / exchange columns
            ok += _add("sales", "status", "VARCHAR(20) DEFAULT 'completed'")
            ok += _add("sales", "return_reason", "TEXT")
            ok += _add("sales", "return_action", "VARCHAR(20)")
            ok += _add("sales", "return_amount", "NUMERIC(12,2)")
            ok += _add("sales", "returned_at", "TIMESTAMP")
            ok += _add("sales", "is_tax_exempt", "BOOLEAN DEFAULT 0")
            ok += _add("sales", "receipt_photo", "VARCHAR(500)")
            # Inventory items — columns that may have been added after initial create
            ok += _add("inventory_items", "sell_price", "NUMERIC(12,2)")
            ok += _add("inventory_items", "barcode", "TEXT")
            ok += _add("inventory_items", "expiry_date", "DATE")
            ok += _add("inventory_items", "image_url", "TEXT")
            ok += _add("inventory_items", "is_perishable", "BOOLEAN DEFAULT 0")
            ok += _add("inventory_items", "category", "TEXT DEFAULT 'General'")
            # Expenses
            ok += _add("expenses", "is_tax_exempt", "BOOLEAN DEFAULT 0")
            ok += _add("expenses", "receipt_photo", "VARCHAR(500)")
            # Inventory logs
            ok += _add("inventory_logs", "batch_id", "TEXT")
            # Users
            ok += _add("users", "business_type", "VARCHAR(50) DEFAULT 'restaurant'")
            ok += _add("users", "daily_goal", "NUMERIC(12,2) DEFAULT 0")
            ok += _add("users", "role", "VARCHAR(20) DEFAULT 'owner'")
            ok += _add("users", "owner_id", "VARCHAR(36)")
            # Email verification
            ok += _add("users", "email_verified", "BOOLEAN DEFAULT 0")
            ok += _add("users", "verification_code", "VARCHAR(10)")
            ok += _add("users", "verification_code_expires", "TIMESTAMP")
            # Khata / Loans soft-delete
            ok += _add("khata_customers", "is_deleted", "BOOLEAN DEFAULT 0")
            ok += _add("loan_persons", "is_deleted", "BOOLEAN DEFAULT 0")
            # Payment connections — auto-sync
            ok += _add("payment_connections", "auto_sync", "BOOLEAN DEFAULT 1")
            ok += _add("payment_connections", "last_auto_imported", "INTEGER DEFAULT 0")
            # Stripe subscription state (mirrors PG migrations)
            ok += _add("users", "stripe_customer_id", "VARCHAR(64)")
            ok += _add("users", "stripe_subscription_id", "VARCHAR(64)")
            ok += _add("users", "subscription_status", "VARCHAR(32)")
            ok += _add("users", "subscription_period_end", "TIMESTAMP")
            # Danish restaurant ops (mirrors PG migrations above)
            ok += _add("sales", "order_channel", "VARCHAR(20) DEFAULT 'dine_in'")
            ok += _add("sales", "guest_count", "INTEGER")
            ok += _add("sales", "service_charge_amount", "NUMERIC(12,2)")
            ok += _add("sales", "discount_amount", "NUMERIC(12,2)")
            ok += _add("sales", "is_void", "BOOLEAN DEFAULT 0")
            ok += _add("sales", "is_manager_void", "BOOLEAN DEFAULT 0")
            ok += _add("sales", "is_error_correct", "BOOLEAN DEFAULT 0")
            # Branch-based bookkeeping
            ok += _add("sales", "branch_id", "VARCHAR(36)")
            ok += _add("expenses", "branch_id", "VARCHAR(36)")
            ok += _add("cash_transactions", "branch_id", "VARCHAR(36)")
            ok += _add("inventory_items", "branch_id", "VARCHAR(36)")
            ok += _add("waste_logs", "branch_id", "VARCHAR(36)")
            # Sell-unit conversion
            ok += _add("inventory_items", "sell_unit", "VARCHAR(20)")
            ok += _add("inventory_items", "pieces_per_unit", "NUMERIC(10,2)")
            # Task #63 — Inventory Ordering Autopilot supplier metadata
            ok += _add("inventory_items", "supplier_name", "VARCHAR(120)")
            ok += _add("inventory_items", "supplier_email", "VARCHAR(255)")
            ok += _add("inventory_items", "supplier_lead_time_days", "INTEGER DEFAULT 1")
            ok += _add("inventory_items", "pack_size", "NUMERIC(10,3) DEFAULT 1")
            # Daily Close — MOMS / VAT fields
            ok += _add("daily_closes", "moms_total", "NUMERIC(12,2)")
            ok += _add("daily_closes", "revenue_ex_moms", "NUMERIC(12,2)")
            ok += _add("daily_closes", "moms_mode", "VARCHAR(10)")
            # Daily Close — status & lock/unlock
            ok += _add("daily_closes", "status", "VARCHAR(20) DEFAULT 'confirmed'")
            ok += _add("daily_closes", "unlock_reason", "TEXT")
            ok += _add("daily_closes", "unlocked_by", "VARCHAR(255)")
            ok += _add("daily_closes", "unlocked_at", "TIMESTAMP")
            # Business profile — night shift cutoff
            ok += _add("business_profiles", "day_cutoff_hour", "INTEGER DEFAULT 0")
            # Wine menu — display name + glass pricing
            ok += _add("wines", "menu_name", "VARCHAR(255)")
            ok += _add("wines", "glass_price", "NUMERIC(12,2)")
            # Competitor — Google Places fields
            ok += _add("competitors", "place_id", "VARCHAR(255)")
            ok += _add("competitors", "google_rating", "FLOAT")
            ok += _add("competitors", "price_level", "INTEGER")
            ok += _add("competitors", "latitude", "FLOAT")
            ok += _add("competitors", "longitude", "FLOAT")
            ok += _add("competitors", "photo_ref", "VARCHAR(500)")
            ok += _add("competitors", "total_ratings", "INTEGER")
            # Migration 009 mirror — recipient role tag
            ok += _add("output_channels", "role", "VARCHAR(20)")
            # Migration 010 mirror — vertical-module gating
            ok += _add("users", "enabled_modules", "TEXT")
            # Migration 013 mirror — storage_key for inventory_imports
            ok += _add("inventory_imports", "storage_key", "VARCHAR(300)")
            # Migration 015 mirror — receipt_photo on daily_closes
            ok += _add("daily_closes", "receipt_photo", "TEXT")
            # Migration 016 mirror — is_global flag for founder-curated
            # smart-inventory examples. SQLite is permissive about
            # nullable columns; existing rows with NOT NULL user_id
            # stay valid because we only ADD columns, never relax
            # existing constraints (SQLite ALTER COLUMN isn't supported
            # — fresh installs use the model definition which already
            # has user_id nullable).
            ok += _add("inventory_import_examples", "is_global", "BOOLEAN NOT NULL DEFAULT 0")
            # Migration 017 mirror — accountant contact on business profile
            ok += _add("business_profiles", "accountant_email", "VARCHAR(255)")
            ok += _add("business_profiles", "accountant_name", "VARCHAR(255)")
            # Migration 018 mirror — multilayer CVR verification trail
            ok += _add("business_profiles", "cvr_verified_at", "TIMESTAMP")
            ok += _add("business_profiles", "cvr_verified_source", "VARCHAR(50)")
            ok += _add("business_profiles", "dawa_address_id", "VARCHAR(50)")
            ok += _add("business_profiles", "vat_registered", "BOOLEAN")
            ok += _add("business_profiles", "status_flags", "TEXT")
            # Migration 041 mirror — target_labor_pct for Schedule Autopilot
            ok += _add(
                "business_profiles", "target_labor_pct",
                "NUMERIC(4,3) NOT NULL DEFAULT 0.30",
            )
            # Migration 042 mirror — onboarding wizard completion (Task #55)
            ok += _add("users", "onboarding_completed_at", "TIMESTAMP")
            # Migration 044 mirror — unified OAuth identity columns (Task #65).
            # SQLite gets the columns added here (Postgres got them via the
            # ALTER above). Unique constraints come from the ORM model
            # (unique=True on apple_sub/google_sub) — SQLite will enforce
            # them via SQLAlchemy on INSERT.
            ok += _add("users", "apple_sub", "VARCHAR(255)")
            ok += _add("users", "google_sub", "VARCHAR(255)")
            ok += _add("users", "oauth_provider", "VARCHAR(20)")
            # Migration 053 mirror — Lane A close-ritual prefs.
            ok += _add("users", "auto_email_on_close", "BOOLEAN NOT NULL DEFAULT 1")
            ok += _add("users", "bank_drop_dismissed_ids", "TEXT")
            # Migration 033 — Faktura Danish-compliance fields
            ok += _add("business_profiles", "bank_reg_number", "VARCHAR(8)")
            ok += _add("business_profiles", "bank_account_number", "VARCHAR(20)")
            ok += _add("business_profiles", "mobilepay_number", "VARCHAR(20)")
            ok += _add("business_profiles", "iban", "VARCHAR(34)")
            ok += _add("business_profiles", "bic", "VARCHAR(11)")
            ok += _add("customers", "ean_nummer", "VARCHAR(13)")
            ok += _add("customers", "is_public_sector", "BOOLEAN DEFAULT 0")
            ok += _add("invoices", "delivery_date", "DATE")
            # Migration 034 — branding + payment provenance + audit trail.
            # Two new tables (created via the main MIGRATIONS list above —
            # CREATE TABLE IF NOT EXISTS works on SQLite). Columns added here.
            ok += _add("business_profiles", "logo_url", "TEXT")
            ok += _add("business_profiles", "accent_color", "VARCHAR(7)")
            ok += _add("business_profiles", "logo_position", "VARCHAR(10) DEFAULT 'left'")
            ok += _add("business_profiles", "data_retention_years", "INTEGER DEFAULT 6")
            ok += _add("invoices", "paid_via", "VARCHAR(20)")
            ok += _add("invoices", "paid_reference", "TEXT")
            ok += _add("invoices", "auto_match_reversible", "BOOLEAN DEFAULT 0")
            ok += _add("sales", "invoice_id", "VARCHAR(36)")
            # Performance indexes (CREATE INDEX IF NOT EXISTS works on SQLite 3.3+)
            _index_stmts = [
                "CREATE INDEX IF NOT EXISTS ix_sale_user_date ON sales (user_id, date, is_deleted)",
                "CREATE INDEX IF NOT EXISTS ix_sale_user_payment ON sales (user_id, payment_method, date)",
                "CREATE INDEX IF NOT EXISTS ix_expense_user_date ON expenses (user_id, date, is_deleted)",
                "CREATE INDEX IF NOT EXISTS ix_expense_user_category ON expenses (user_id, category_id, date)",
                "CREATE INDEX IF NOT EXISTS ix_inventory_user_stock ON inventory_items (user_id, quantity, min_threshold)",
            ]
            ix_ok = 0
            for stmt in _index_stmts:
                try:
                    conn.execute(text(stmt))
                    ix_ok += 1
                except Exception:
                    pass
            conn.commit()
            print(f"Schema migrations (SQLite): {ok} new columns added, {ix_ok} indexes ensured")
        else:
            # PostgreSQL: supports IF NOT EXISTS
            # IMPORTANT: Use SAVEPOINT per migration so one failure
            # doesn't abort the entire transaction (PG behaviour).
            ok = 0
            failed = 0
            for i, sql in enumerate(_migrations):
                sp = f"sp_{i}"
                try:
                    conn.execute(text(f"SAVEPOINT {sp}"))
                    conn.execute(text(sql))
                    conn.execute(text(f"RELEASE SAVEPOINT {sp}"))
                    ok += 1
                except Exception as e:
                    conn.execute(text(f"ROLLBACK TO SAVEPOINT {sp}"))
                    failed += 1
                    print(f"Migration {i} skipped: {e}")
            conn.commit()
            print(f"Schema migrations (PG): {ok} applied, {failed} skipped")

            # After all migrations land, run the audit-log immutability
            # self-test. If the RULE didn't install we want to know NOW,
            # not the first time a malicious INSERT-INTO-DELETE-FROM
            # sequence successfully tampers with audit history.
            try:
                _verify_audit_log_immutability(conn)
            except Exception as e:
                print(f"audit_logs self-test wrapper failed: {e}")


def _run_data_migration():
    """Fix cashbook auto-synced entries (runs once at startup)."""
    is_sqlite_db = str(engine.url).startswith("sqlite")
    with engine.connect() as conn:
        if is_sqlite_db:
            conn.execute(text("""
                DELETE FROM cash_transactions
                WHERE reference_id LIKE 'expense_%'
                AND reference_id IN (
                    SELECT 'expense_' || CAST(e.id AS TEXT)
                    FROM expenses e
                    WHERE e.is_personal = 1
                )
            """))
            conn.execute(text("""
                UPDATE cash_transactions
                SET category = (
                    SELECT ec.name
                    FROM expenses e
                    JOIN expense_categories ec ON e.category_id = ec.id
                    WHERE cash_transactions.reference_id = 'expense_' || CAST(e.id AS TEXT)
                )
                WHERE category = 'Purchase'
                AND reference_id LIKE 'expense_%'
                AND EXISTS (
                    SELECT 1 FROM expenses e
                    JOIN expense_categories ec ON e.category_id = ec.id
                    WHERE cash_transactions.reference_id = 'expense_' || CAST(e.id AS TEXT)
                )
            """))
        else:
            conn.execute(text("""
                DELETE FROM cash_transactions
                WHERE reference_id LIKE 'expense_%'
                AND reference_id IN (
                    SELECT 'expense_' || e.id::text
                    FROM expenses e
                    WHERE e.is_personal = true
                )
            """))
            conn.execute(text("""
                UPDATE cash_transactions ct
                SET category = ec.name
                FROM expenses e
                JOIN expense_categories ec ON e.category_id = ec.id
                WHERE ct.reference_id = 'expense_' || e.id::text
                AND ct.category = 'Purchase'
            """))
        conn.commit()
    print("Data migration: cashbook entries fixed")

# --- Rate Limiter ---
limiter = Limiter(key_func=get_remote_address, default_limits=["120/minute"])

# --- App Setup ---
is_prod = settings.ENVIRONMENT == "production"


# ─── Lifespan context manager (replaces @app.on_event) ─────────────
#
# FastAPI 0.93+ deprecated @app.on_event in favour of an ASGI
# lifespan async context manager. on_event is scheduled for removal
# in a future FastAPI release; migrating now removes 3 deprecation
# warnings + future-proofs the bootstrap.
#
# Two phases — order pinned by yield:
#
#   STARTUP (runs before the app accepts requests)
#     • Kick off DB init + idempotent migrations + demo seed in a
#       BACKGROUND thread so uvicorn can bind the port immediately.
#       The db_readiness_gate middleware returns 503 until _db_ready
#       fires, so requests that arrive during init are rejected
#       cleanly rather than blocking the event loop.
#
#   SHUTDOWN (runs as the app drains)
#     • Stop the APScheduler if it was ever started. The scheduler
#       lives in module-level _scheduler (assigned in the try block
#       further down). It may NOT exist if scheduler init failed at
#       import time — we use globals().get() to handle that without
#       a NameError. wait=False so shutdown doesn't block on a long-
#       running job; the daemon thread will be cleaned up by the
#       process exit.
#
# Forward-reference safety: this function REFERENCES _init_db and
# _scheduler (defined / assigned later in the module). Python looks
# up names lazily at call time — by the time ASGI fires the lifespan
# protocol, the whole module is loaded.
@asynccontextmanager
async def lifespan(app):
    # ─── STARTUP ─────────────────────────────────────────────────
    _startup_thread = threading.Thread(target=_init_db, daemon=True)
    _startup_thread.start()

    yield

    # ─── SHUTDOWN ────────────────────────────────────────────────
    sched = globals().get("_scheduler")
    if sched is not None:
        try:
            sched.shutdown(wait=False)
        except Exception:  # noqa: BLE001
            # APScheduler.shutdown() should be quiet, but guard
            # anyway so a transient error here doesn't poison
            # graceful shutdown.
            pass


app = FastAPI(
    title="BonBox",
    description="Din digitale bonkasse — smart analytics for small businesses",
    version="1.0.0",
    docs_url=None if is_prod else "/docs",
    redoc_url=None if is_prod else "/redoc",
    openapi_url=None if is_prod else "/openapi.json",
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


# --- Multi-layer defense: global exception handler ---
# Last line of defense. If a router raises an unhandled exception, this catches
# it and returns a clean JSON error instead of crashing the worker (which Render
# turns into a 503). The actual stack trace is logged so we can debug, but the
# user gets a helpful message and the rest of the app keeps working.
#
# Defense in depth: even if a router forgets its try/except, the global handler
# still gives the client a proper response. One layer breaks → next catches it.
#
# Security: the response body NEVER includes query strings (which can hold PII
# like start/end dates, customer IDs) or auth tokens. We strip the path to its
# route template only, and never echo body contents back.
import logging
import time as _time
import traceback as _tb
_security_logger = logging.getLogger("bonbox.security")
_error_logger = logging.getLogger("bonbox.errors")

# Track repeat-exception fingerprints per IP so we can audit-log spikes that
# suggest probing/scanning rather than honest bugs.
_recent_exception_fingerprints: dict[str, list[float]] = {}
_EXCEPTION_FINGERPRINT_WINDOW = 60  # seconds
_EXCEPTION_SPIKE_THRESHOLD = 10  # exceptions/min from one IP triggers audit log


def _audit_exception_spike(ip: str, fingerprint: str):
    """Record an audit event when one IP keeps triggering exceptions —
    likely a scanner. Cheap in-memory check, doesn't block legit traffic.
    """
    if not ip:
        return
    now = _time.time()
    cutoff = now - _EXCEPTION_FINGERPRINT_WINDOW
    bucket = _recent_exception_fingerprints.setdefault(ip, [])
    bucket[:] = [t for t in bucket if t > cutoff]
    bucket.append(now)
    if len(bucket) >= _EXCEPTION_SPIKE_THRESHOLD:
        _security_logger.warning(
            "exception_spike: ip=%s count=%d fingerprint=%s",
            ip, len(bucket), fingerprint,
        )
        bucket.clear()  # reset so we don't spam the same alert


@app.exception_handler(Exception)
async def _global_exception_handler(request: Request, exc: Exception):
    """Catch-all so an uncaught backend bug never returns 503.

    Logs the full stack trace for diagnosis, but returns a safe shape to the
    client so the frontend can render a graceful error banner.
    """
    path = request.url.path
    # Don't log stack traces for client-cancelled requests
    if exc.__class__.__name__ in ("ClientDisconnect", "CancelledError"):
        return JSONResponse(status_code=499, content={"detail": "Client disconnected"})
    # Log details server-side, but be careful not to leak query params / body
    # into the response (those may contain dates / IDs / etc.).
    _error_logger.exception(
        "Unhandled exception in %s %s: %s",
        request.method, path, exc,
    )
    # Persist to ErrorLog for super-admin observability — wrapped in
    # try/except so logging failures NEVER break the response path.
    try:
        from app.models.error_log import ErrorLog as _ErrorLog
        from app.database import SessionLocal as _SessionLocal
        _db = _SessionLocal()
        try:
            _db.add(_ErrorLog(
                method=request.method,
                path=path[:500] if path else None,
                status_code=500,
                user_id=getattr(getattr(request, "state", None), "user_id", None),
                ip_address=(request.client.host if request.client else None),
                user_agent=(request.headers.get("user-agent") or "")[:500],
                error_type=type(exc).__name__[:100],
                message=str(exc)[:1000],
                traceback=_tb.format_exc()[:5000],  # cap at 5KB to keep DB lean
            ))
            _db.commit()
        finally:
            _db.close()
    except Exception:  # noqa: BLE001 — observability MUST never raise
        pass
    # Audit spike detection: many exceptions from same IP looks like probing
    try:
        ip = request.client.host if request.client else ""
        _audit_exception_spike(ip, f"{request.method}:{path}:{type(exc).__name__}")
    except Exception:
        pass
    # Don't leak stack traces in prod. Dev gets the trace for debugging.
    body = {
        "detail": "Something went wrong on our side. Please try again.",
        "_error": True,
        "_recoverable": True,
    }
    if not is_prod:
        body["debug_trace"] = _tb.format_exc()
        body["path"] = path  # only in dev; prod hides path to avoid recon
    return JSONResponse(status_code=500, content=body)


# --- DB init in background thread with readiness gate ---
def _init_db():
    """Create tables & run migrations, then signal readiness."""
    import time
    for attempt in range(3):
        try:
            Base.metadata.create_all(bind=engine)
            print("DB tables created")
            break
        except Exception as e:
            print(f"DB create_all attempt {attempt + 1} failed: {e}")
            if attempt < 2:
                time.sleep(5)  # wait for sleeping PG to wake up
            else:
                print("DB create_all gave up after 3 attempts")
    try:
        _run_migrations()
    except Exception as e:
        print(f"Migration warning: {e}")
    try:
        _run_data_migration()
    except Exception as e:
        print(f"Data migration warning: {e}")
    # Pre-seed canonical global smart-inventory examples on first deploy.
    # Idempotent — skips entirely if any global example already exists,
    # so founder-curated corrections that flow into is_global via the
    # super_admin path are never clobbered.
    try:
        from app.services.global_inventory_examples_seed import seed_if_empty
        from app.database import SessionLocal
        with SessionLocal() as seed_db:
            result = seed_if_empty(seed_db)
        if result.get("inserted"):
            print(f"Global smart-import examples seeded: +{result['inserted']} canonical entries")
    except Exception as e:
        # Non-fatal — the AI extraction still works without bootstrap
        # examples (it just starts colder for fresh tenants).
        print(f"Global examples seed warning: {e}")
    # Demo account seed — populates demo@bonbox.dk with realistic
    # Mirabelle data for sales demos / investor walkthroughs.
    # Idempotent: only seeds when the demo user exists AND has zero
    # DailyClose rows. Day-2 startups skip silently.
    try:
        from app.services.demo_seed import seed_demo_account
        from app.database import SessionLocal
        with SessionLocal() as seed_db:
            demo_result = seed_demo_account(seed_db)
        if not demo_result.get("skipped"):
            print(
                f"Demo account seeded: {demo_result['closes']} closes, "
                f"{demo_result['inventory']} inventory items, "
                f"{demo_result['expenses']} expenses"
            )
    except Exception as e:
        # Non-fatal — demo data is nice-to-have, not critical
        print(f"Demo seed warning: {e}")
    _db_ready.set()
    print("DB init complete — ready to serve requests")


# Startup behaviour migrated to the `lifespan` async context manager
# defined alongside the FastAPI() constructor (replaces the deprecated
# @app.on_event("startup") API). See the lifespan docstring for why.


# --- DB readiness middleware: block API requests until DB is ready ---
@app.middleware("http")
async def db_readiness_gate(request: Request, call_next):
    path = request.url.path
    # Always allow health checks, root, docs, and CORS preflight through
    if path in ("/", "/api/health", "/api/health/db", "/api/keepalive", "/api/config/features", "/api/email/unsubscribe", "/docs", "/redoc", "/openapi.json") or request.method == "OPTIONS":
        return await call_next(request)
    # Return 503 instantly if DB isn't ready yet (non-blocking — won't freeze event loop)
    if not _db_ready.is_set():
        return JSONResponse(
            status_code=503,
            content={"detail": "Server is starting up, please retry in a moment"},
            headers={"Retry-After": "3"},
        )
    return await call_next(request)


# --- CORS (tightened, environment-aware) ---
# Production:    only canonical bonbox.dk + Capacitor iOS shell
# Non-production: also allow vercel.app preview alias + localhost for dev
# This stops attackers using a stale or malicious preview origin to send
# authenticated XHR with allow_credentials=True.
_PROD_ORIGINS = [
    "https://bonbox.dk",
    "https://www.bonbox.dk",
    "capacitor://localhost",   # iOS native via Capacitor
    "https://localhost",       # iOS native fallback scheme
]
_DEV_ORIGINS = [
    "http://localhost:5173",   # Vite dev server
    "http://localhost",        # generic dev
    "https://bonbox.vercel.app",  # preview alias
]
if settings.ENVIRONMENT == "production":
    origins = _PROD_ORIGINS + ([settings.FRONTEND_URL] if settings.FRONTEND_URL and "vercel.app" not in settings.FRONTEND_URL else [])
else:
    origins = _PROD_ORIGINS + _DEV_ORIGINS + ([settings.FRONTEND_URL] if settings.FRONTEND_URL else [])
# Dedup while preserving order
origins = list(dict.fromkeys([o for o in origins if o]))

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-BonBox-Platform", "Stripe-Signature", "X-CSRF-Token"],
    max_age=600,  # cache preflights for 10min — fewer OPTIONS roundtrips
)


# --- Admin path scan-blocker ---
# In-memory IP block list for the /admin/* path. If an IP gets too many 4xx
# responses on /admin, it gets a temporary ban regardless of any later auth.
# This protects against scanners and credential-stuffing tools sweeping for
# admin endpoints.
_admin_ip_strikes: dict[str, list[float]] = {}
_admin_ip_banned: dict[str, float] = {}
_ADMIN_STRIKE_WINDOW_SEC = 60
_ADMIN_STRIKE_LIMIT = 20  # 4xx hits in window before ban
_ADMIN_BAN_DURATION_SEC = 600  # 10-minute ban


@app.middleware("http")
async def admin_scan_blocker(request: Request, call_next):
    if not request.url.path.startswith("/api/admin"):
        return await call_next(request)
    import time
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    # Already banned?
    ban_until = _admin_ip_banned.get(ip)
    if ban_until and now < ban_until:
        return JSONResponse(
            status_code=404,
            content={"detail": "Not found"},
            headers={"Retry-After": str(int(ban_until - now))},
        )
    # Run the request
    response = await call_next(request)
    # Track strikes on 4xx responses
    if 400 <= response.status_code < 500:
        strikes = _admin_ip_strikes.setdefault(ip, [])
        # Drop expired strikes
        cutoff = now - _ADMIN_STRIKE_WINDOW_SEC
        strikes[:] = [t for t in strikes if t > cutoff]
        strikes.append(now)
        if len(strikes) >= _ADMIN_STRIKE_LIMIT:
            _admin_ip_banned[ip] = now + _ADMIN_BAN_DURATION_SEC
            strikes.clear()
    return response


# --- CSRF Protection (double-submit cookie) ---
# State-changing requests authenticated via cookie must echo the bonbox_csrf
# cookie back as the X-CSRF-Token header. An attacker on another origin can't
# read the cookie (Same-Origin Policy) so they can't forge the header — even
# if the user is logged in, a malicious page can't trigger writes on their
# behalf. Defense-in-depth on top of CORS allow-credentials origin pinning.
#
# Bypassed when:
#   • Method is GET / HEAD / OPTIONS (no state change)
#   • Request authenticates via Authorization: Bearer (native iOS — bearer
#     token is itself unforgeable cross-origin, same protection as a CSRF token)
#   • Path is in the public-auth allowlist (login, register, password reset,
#     Google OAuth, Stripe webhook — these MUST work without prior session)
#   • Path is the staff portal (/api/staff-portal/*) — uses URL-token auth
#     scoped to that staff member, not the JWT cookie
from app.services.auth import AUTH_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME

# Endpoints that legitimately have no prior session, so a CSRF cookie can't
# exist yet. Each one has its own anti-abuse mitigation (rate limiting,
# verification codes, signed Stripe webhook, etc.) — CSRF is the wrong layer.
_CSRF_EXEMPT_PATHS = frozenset({
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/google",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    # Task #61 — magic-link is a public, unauthenticated auth flow. Both
    # endpoints have their own multi-layer rate limit (IP + email) and
    # the token itself is single-use + sha256-hashed + 15-min TTL — CSRF
    # is the wrong layer of defence here, just like /login + /register.
    "/api/auth/magic-link/request",
    "/api/auth/magic-link/verify",
    # Stripe webhook is signed; CSRF would just block legitimate Stripe POSTs.
    # The handler verifies Stripe-Signature inside, no cookie is involved.
    "/api/billing/stripe/webhook",
})


@app.middleware("http")
async def csrf_protect(request: Request, call_next):
    method = request.method
    if method in ("GET", "HEAD", "OPTIONS"):
        return await call_next(request)
    # Bearer-authenticated requests skip CSRF — the bearer token itself is in
    # a header that browsers won't auto-attach cross-origin, so CSRF for cookie
    # auth doesn't apply. Native iOS uses this path.
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        return await call_next(request)
    path = request.url.path
    if path in _CSRF_EXEMPT_PATHS or path.startswith("/api/staff-portal"):
        return await call_next(request)
    # Only enforce on authenticated cookie-based requests. If there's no
    # session cookie, there's nothing to protect — the underlying handler
    # will 401 anyway. This avoids 403-ing public unauthenticated POSTs we
    # might add later without remembering to update the exempt list.
    if not request.cookies.get(AUTH_COOKIE_NAME):
        return await call_next(request)
    header_token = request.headers.get(CSRF_HEADER_NAME.lower(), "")
    cookie_token = request.cookies.get(CSRF_COOKIE_NAME, "")
    # Round 2 cutover: the API now lives at api.bonbox.dk (same registrable
    # domain as the frontend), so cookies are scoped to .bonbox.dk and
    # readable by JS on bonbox.dk. The frontend echoes the CSRF cookie back
    # as X-CSRF-Token; the middleware strictly enforces match.
    #
    # Legacy host bonbox-api.onrender.com still works for native iOS
    # (Bearer auth, bypassed at the top of this handler) and as a fallback
    # for any in-flight cookie-auth client during the migration. Such a
    # request would arrive with the auth cookie + no CSRF header — we let
    # it through with a log line to avoid breaking those clients while
    # they pick up the new api.bonbox.dk URL on their next page load.
    import logging as _logging
    import secrets as _s
    host = (request.headers.get("host") or "").split(":")[0].lower()
    is_first_party = host == "bonbox.dk" or host.endswith(".bonbox.dk")

    if not header_token:
        if is_first_party:
            # First-party request — no excuse for missing CSRF header.
            return JSONResponse(
                status_code=403,
                content={
                    "detail": "CSRF token missing",
                    "_error": "Please refresh the page and try again.",
                    "_recoverable": True,
                },
            )
        # Legacy onrender.com path — log and let through (transition only;
        # tighten or remove this branch once analytics show no traffic
        # hitting the legacy host)
        _logging.getLogger(__name__).info(
            "csrf_protect: header missing on legacy host %s %s %s — passing through",
            host, method, path,
        )
        return await call_next(request)
    if not cookie_token or not _s.compare_digest(
        header_token.encode("utf-8"), cookie_token.encode("utf-8")
    ):
        return JSONResponse(
            status_code=403,
            content={
                "detail": "CSRF token mismatched",
                "_error": "Session expired — please refresh the page",
                "_recoverable": True,
            },
        )
    return await call_next(request)


# --- Accountant read-only enforcement (Task #49) ---
# Belt-and-braces alongside the get_current_user delegation:
#   • Every POST/PUT/PATCH/DELETE that's NOT on the accountant allowlist
#     is refused with 403 read_only when the requesting user has
#     role='accountant'.
#   • GET requests pass through unmodified — read-only semantics permit
#     all queries; tenant scoping in get_current_user limits WHICH data
#     they see.
#
# Why a middleware (rather than per-route deps): the codebase has 70+
# router files. A middleware gives us a single chokepoint that's
# impossible to forget when adding a new endpoint. The dep
# require_write_access exists as a per-route option for clarity but
# the middleware is the safety net.
#
# The middleware resolves the JWT itself (mirroring get_current_user)
# rather than calling the dep, so it doesn't depend on FastAPI route
# resolution. Read-only design: only inspects role + path + method.
from app.services.auth import (
    ACCOUNTANT_ALLOWED_WRITE_PATHS as _ACCT_ALLOWED,
    AUTH_COOKIE_NAME as _AUTH_COOKIE,
    _decode_token as _decode_jwt,
)


_ACCOUNTANT_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _is_path_allowlisted_for_accountant_write(path: str) -> bool:
    """True iff this path is allowed to be mutated by an accountant.
    Exact match for short paths; prefix match for paths that contain a
    dynamic segment (e.g. /api/accountants/switch-client/{owner_id}).
    """
    if path in _ACCT_ALLOWED:
        return True
    # Prefix-match anchors — these are the dynamic-segment write paths.
    if path.startswith("/api/accountants/switch-client/"):
        return True
    # Revoke endpoint — accountant CAN revoke their own grants.
    if path.startswith("/api/accountants/grants/"):
        return True
    return False


@app.middleware("http")
async def accountant_write_guard(request: Request, call_next):
    """Refuse mutations from accountant sessions unless the path is on
    the allowlist. Returns 403 with code='read_only' so the frontend
    can surface a clear "Accountants can view but not modify" message.

    Multi-layer defense — paired with get_current_user delegation,
    which already returns the OWNER user (so tenant-scoped queries
    are safe to run as a read). This middleware adds the second
    layer: even if a router skipped the standard auth dep and called
    its own logic, an accountant POST would still be blocked here.
    """
    method = request.method
    if method not in _ACCOUNTANT_WRITE_METHODS:
        return await call_next(request)

    # Cheap pre-filter: anonymous requests can't be accountants. We
    # don't have a session if no Authorization header AND no cookie.
    bearer = request.headers.get("authorization", "")
    has_bearer = bearer.lower().startswith("bearer ")
    has_cookie = bool(request.cookies.get(_AUTH_COOKIE))
    if not has_bearer and not has_cookie:
        return await call_next(request)

    # Resolve the JWT ourselves (don't call get_current_user — we
    # don't want to trigger delegation here; we need the RAW user's
    # role).
    token = None
    if has_bearer:
        token = bearer.split(" ", 1)[1].strip()
    if not token:
        token = request.cookies.get(_AUTH_COOKIE)
    if not token:
        return await call_next(request)

    try:
        payload = _decode_jwt(token)
        user_id = payload.get("sub")
        if not user_id:
            return await call_next(request)
    except Exception:  # noqa: BLE001
        return await call_next(request)

    # Quick role lookup — DB-only, no relationship loading
    from app.database import SessionLocal as _Session
    from sqlalchemy import text as _text
    db = _Session()
    try:
        row = db.execute(
            _text("SELECT role FROM users WHERE id = :uid LIMIT 1"),
            {"uid": user_id},
        ).first()
    except Exception:  # noqa: BLE001
        row = None
    finally:
        db.close()

    if not row:
        return await call_next(request)

    role = (row[0] or "").lower() if row[0] else ""
    if role != "accountant":
        return await call_next(request)

    path = request.url.path or ""
    if _is_path_allowlisted_for_accountant_write(path):
        return await call_next(request)

    return JSONResponse(
        status_code=403,
        content={
            "detail": {
                "code": "read_only",
                "message": "Accountants can view but not modify.",
            },
        },
    )


# --- Security Headers Middleware ---
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    # Disable browser features the API never needs — defense against pivot attacks
    response.headers["Permissions-Policy"] = (
        "geolocation=(), microphone=(), camera=(), payment=(), usb=(), accelerometer=(), gyroscope=()"
    )
    # Cross-origin isolation (defense against side-channel attacks)
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Resource-Policy"] = "same-site"
    # Content-Security-Policy for the API. Frontend is a separate origin (Vercel)
    # and gets its own CSP via meta tag in index.html; this CSP scopes the API's
    # OWN responses (which are JSON only — no scripts, no embeds, no images).
    # default-src 'none' is the strictest — API responses can't render anything.
    response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
    # Cache nothing for /api/admin/* — security telemetry should never be cached
    if request.url.path.startswith("/api/admin"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, private"
        response.headers["Pragma"] = "no-cache"
    if is_prod:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains; preload"
    return response


# --- Request body size limit ---
# Reject huge bodies before they hit the handler. Prevents memory-exhaustion
# DoS where an attacker streams a 1GB request to a handler that never reads
# Content-Length. Receipt OCR uploads are the largest legitimate payload at
# ~5MB; we set a generous 10MB cap.
_MAX_REQUEST_BYTES = 10 * 1024 * 1024  # 10 MB


@app.middleware("http")
async def enforce_request_size(request: Request, call_next):
    # Trust Content-Length header for the cheap rejection path. Real clients
    # always send it; missing/zero is fine (GET/empty bodies). For chunked
    # uploads without Content-Length the underlying ASGI server (uvicorn)
    # has its own request-line limits.
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > _MAX_REQUEST_BYTES:
        return JSONResponse(
            status_code=413,
            content={
                "detail": f"Request body too large (max {_MAX_REQUEST_BYTES // (1024*1024)} MB)",
                "_error": True,
                "_recoverable": False,
            },
        )
    return await call_next(request)


# --- JWT secret strength check on startup ---
# In prod, refuse to serve if SECRET_KEY is too short or auto-generated.
# Auto-generated means tokens invalidate on every restart — bad UX, also
# weak entropy guarantee. Configured via env in prod.
if is_prod:
    _key = settings.SECRET_KEY or ""
    if len(_key) < 32:
        # Don't crash — log loudly and refuse to issue tokens via a flag elsewhere
        # would be ideal, but a clear log warning lets operators see + fix
        import warnings
        warnings.warn(
            f"SECURITY WARNING: SECRET_KEY in production is only {len(_key)} chars. "
            f"Set a 64+ char SECRET_KEY env var on Render to harden token signing."
        )

# --- Task #67: validate Fernet key for at-rest token encryption ---
# In prod we fail loud if APP_SECRET_KEY is missing — otherwise the
# bank-connect router will explode at first request, which is worse
# than failing at boot. Dev mode generates an ephemeral per-process
# key inside the crypto module so local + test runs work without setup.
try:
    from app.utils.crypto import (
        assert_key_configured,
        assert_can_decrypt_existing_tokens,
        CryptoConfigError,
    )
    assert_key_configured()
    # Audit P3 (Task #82): also probe a few existing encrypted rows
    # to catch silent key-rotation losses.  If the primary key has
    # rotated AND APP_SECRET_KEY_PREVIOUS is not set, every previously-
    # encrypted token would be undecryptable from this boot onward;
    # we'd rather refuse to start than serve broken /sync calls.
    # Production only — dev/test always uses an ephemeral key by design.
    if is_prod:
        from app.database import SessionLocal as _SessionLocal
        with _SessionLocal() as _probe_db:
            assert_can_decrypt_existing_tokens(_probe_db)
except CryptoConfigError as _crypto_err:
    if is_prod:
        # Don't crash the entire app — the rest of BonBox still works
        # without bank-connect. Log loudly + let bank-connect endpoints
        # fail naturally if anyone calls them. Operator gets to see this
        # in Render logs immediately.
        import warnings
        warnings.warn(f"APP_SECRET_KEY misconfigured: {_crypto_err}")
    # In dev, crypto.py already auto-generated an ephemeral key + logged
    # a warning. Nothing to do here.


# --- Routers ---
app.include_router(auth.router, prefix="/api/auth", tags=["Auth"])
app.include_router(sales.router, prefix="/api/sales", tags=["Sales"])
app.include_router(expenses.router, prefix="/api/expenses", tags=["Expenses"])
app.include_router(inventory.router, prefix="/api/inventory", tags=["Inventory"])
app.include_router(reports.router, prefix="/api/reports", tags=["Reports"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["Dashboard"])
app.include_router(staffing.router, prefix="/api/staffing", tags=["Staffing"])
app.include_router(waste.router, prefix="/api/waste", tags=["Waste"])
app.include_router(feedback.router, prefix="/api/feedback", tags=["Feedback"])
app.include_router(cashbook.router, prefix="/api/cashbook", tags=["Cash Book"])
app.include_router(events.router, prefix="/api/events", tags=["Events"])
app.include_router(khata.router, prefix="/api/khata", tags=["Khata"])
app.include_router(budget.router, prefix="/api/budgets", tags=["Budgets"])
app.include_router(loan.router, prefix="/api/loans", tags=["Loans"])
app.include_router(email_settings.router, prefix="/api/email", tags=["Email"])
# Task #108 — public one-click unsubscribe (GDPR Art. 7(3) + RFC 8058).
from app.routers import email_unsubscribe as email_unsubscribe_router
app.include_router(email_unsubscribe_router.router, prefix="/api/email", tags=["Email"])
app.include_router(whatsapp.router, prefix="/api/whatsapp", tags=["WhatsApp"])
app.include_router(weather.router, prefix="/api/weather", tags=["Weather"])
app.include_router(agent.router, prefix="/api/agent", tags=["AI Agent"])
app.include_router(bank_import.router, prefix="/api/bank-import", tags=["Bank Import"])
app.include_router(payment_import.router, prefix="/api/payment-import", tags=["Payment Import"])
app.include_router(team.router, prefix="/api/team", tags=["Team"])
app.include_router(business_profile.router, prefix="/api/business", tags=["Business Profile"])
app.include_router(search_router.router, prefix="/api/search", tags=["Search"])
app.include_router(cashflow.router, prefix="/api/cashflow", tags=["Cash Flow"])
app.include_router(tax.router, prefix="/api/tax", tags=["Tax Autopilot"])
app.include_router(pricing.router, prefix="/api/pricing", tags=["Price Optimization"])
app.include_router(smart_pricing_router.router, prefix="/api/smart-pricing", tags=["Smart Pricing"])
app.include_router(retention.router, prefix="/api/retention", tags=["Customer Retention"])
app.include_router(expiry.router, prefix="/api/expiry", tags=["Expiry Forecasting"])
app.include_router(outlet.router, prefix="/api/outlets", tags=["Cross-Outlet Intelligence"])
app.include_router(competitor.router, prefix="/api/competitors", tags=["Competitor Scan"])
app.include_router(branch.router, prefix="/api/branches", tags=["Branch Bookkeeping"])
app.include_router(daily_close.router, prefix="/api/daily-close", tags=["Daily Close / Kasserapport"])
app.include_router(workshop.router, prefix="/api/workshop", tags=["Automobile Workshop"])
app.include_router(wine.router, prefix="/api/wines", tags=["Wine List"])
app.include_router(staff.router, prefix="/api/staff", tags=["Staff Management"])
app.include_router(staff_portal.router, prefix="/api/portal", tags=["Staff Portal (Public)"])
# Per-user pattern recognition (AI insights, dismiss/feedback)
app.include_router(patterns.router, prefix="/api/patterns", tags=["Owner Patterns"])
# Bookkeeping export (Dinero / Billy / e-conomic / generic CSV)
app.include_router(exports.router, prefix="/api/exports", tags=["Bookkeeping Export"])
# Waitlist for paid tiers (founding-member Pro etc.)
app.include_router(waitlist.router, prefix="/api/waitlist", tags=["Waitlist"])
# Billing / trial state — read-only, no payment processing yet
app.include_router(billing.router, prefix="/api/billing", tags=["Billing"])
app.include_router(ai_router.router, prefix="/api/ai", tags=["AI"])
app.include_router(kasserapport.router, prefix="/api/kasserapport", tags=["Kasserapport"])
app.include_router(terminal.router, prefix="/api/terminals", tags=["Terminals"])
app.include_router(smart_drift.router, prefix="/api/smart-drift", tags=["SmartDrift"])
app.include_router(support.router, prefix="/api/support", tags=["Support"])
app.include_router(output_channel.router, prefix="/api/output-channels", tags=["OutputChannels"])
app.include_router(order_channel_config.router, prefix="/api/order-channels", tags=["OrderChannels"])
app.include_router(modules_router.router, prefix="/api/modules", tags=["Modules"])
# Smart inventory import — paste/CSV/Excel/photo → AI parse + categorize
# → review draft → commit. Six-layer defense (auth, bounds, rate limit,
# tenant scope, daily quota, idempotency, audit) — see router docstring.
app.include_router(
    inventory_smart_import.router,
    prefix="/api/inventory/smart-import",
    tags=["Smart Inventory Import"],
)
# Property Financial Report — Danish-restaurant daily close in the format
# Aloha / Restwave / Pos+ users already recognize. Sales conversation hook.
app.include_router(property_report.router, prefix="/api/property-report", tags=["PropertyReport"])
# /admin/* — guarded by 6-layer require_super_admin (see services/admin_security.py).
# Mounted last so any earlier router can't accidentally shadow these paths.
app.include_router(admin.router, prefix="/api/admin", tags=["Super Admin"])

# Invoicing — Starter-tier feature set. All three routers gate the plan
# server-side via _require_invoicing_plan; the frontend additionally hides
# the menu items for Free-tier users.
app.include_router(customers_router.router, prefix="/api/customers", tags=["Customers"])
app.include_router(invoices_router.router, prefix="/api/invoices", tags=["Invoices"])
app.include_router(payment_suggestions_router.router, prefix="/api/payment-suggestions", tags=["Payment match"])
app.include_router(mileage_router.router, prefix="/api/mileage", tags=["Mileage"])
# Task #47 — Recurring expenses (Starter+ feature). Tier-gated server-
# side via has_feature(user, "recurring_expenses"). Frontend renders an
# UpgradeNudge for Free users; backend enforces every mutation.
app.include_router(
    recurring_expenses_router.router,
    prefix="/api/recurring-expenses",
    tags=["RecurringExpenses"],
)
# Task #68 — per-user demo data toggle. Lets a new owner light up
# their dashboard / brief / reports instantly with sample data, then
# clear it with one tap. All endpoints are auth-gated + tenant-scoped
# inside the seed_for_user / clear_for_user services.
app.include_router(
    demo_router.router,
    prefix="/api/demo",
    tags=["Demo Data"],
)
# Task #85 — public founder-rate status. PREFIX `/api/public` is
# intentional: any route under this prefix is unauthenticated by
# convention (mirrors the same pattern used by other public surfaces
# like /api/staff/portal).  Only aggregate data — no PII.
app.include_router(
    founder_rate_router.router,
    prefix="/api/public",
    tags=["Public Marketing"],
)
# Task #49 — accountant read-only login. The router exposes /invite,
# /grants, /signup (public), /switch-client, /clients. The write-blocking
# middleware in this module (see accountant_write_guard) refuses any
# POST/PUT/PATCH/DELETE for accountant sessions outside an allowlist —
# the router itself is one explicit allowlist entry.
app.include_router(
    accountants_router.router,
    prefix="/api/accountants",
    tags=["Accountants"],
)
# Task #61 — magic-link passwordless login. Mounted under /api/auth so
# the endpoints land at /api/auth/magic-link/request and
# /api/auth/magic-link/verify. Both are PUBLIC (no auth required — they
# ARE the auth). Enumeration-safe response shape + multi-layer rate
# limiting; see the router docstring for the full defence stack.
app.include_router(
    auth_magic_link_router.router,
    prefix="/api/auth",
    tags=["Auth"],
)
# Task #65 — unified Apple + Google OAuth endpoints at
# /api/auth/oauth/apple and /api/auth/oauth/google. Both verify the
# provider's signed identity token, find-or-create the User, link the
# stable sub to existing email-based accounts, and return the same
# Token shape as /auth/login. Rate-limited 30/hour per IP (slowapi).
app.include_router(
    auth_oauth_router.router,
    prefix="/api/auth",
    tags=["Auth"],
)
# Task #67 — Aiia (Mastercard Open Banking) v0.1. Two mount points:
#   /api/bank-connect/{init,callback}   OAuth-flow endpoints
#   /api/bank-connections/{...}         Connection CRUD + sync
# Sandbox-mode default — runs end-to-end without real Aiia creds via
# MockAiiaClient. Set AIIA_ENV=sandbox or =live to switch on real HTTP.
app.include_router(
    bank_connect_router.router,
    prefix="/api/bank-connect",
    tags=["Bank Connect (Aiia)"],
)
app.include_router(
    bank_connect_router.connections_router,
    prefix="/api/bank-connections",
    tags=["Bank Connect (Aiia)"],
)
# Task #71 — MobilePay Erhverv connect + payments sync. Auth-gated,
# Starter+ via mobilepay_autosync feature flag. Mock-mode default —
# set MOBILEPAY_ENV=sandbox/live to switch on real HTTP calls.
app.include_router(
    mobilepay_router.router,
    prefix="/api/mobilepay",
    tags=["MobilePay (Erhverv)"],
)
# Task #72 — Web Push (VAPID) subscribe / unsubscribe / public-key /
# test. The /vapid-public-key sub-route is public; the rest are auth-
# gated. Endpoints return 503 cleanly when VAPID env vars are unset.
app.include_router(
    push_router.router,
    prefix="/api/push",
    tags=["Push Notifications"],
)


# --- Protected Uploads — owner can only access own receipts ---
#
# Multi-layer defense (parity with the rest of the codebase):
#   L1 — auth: require_current_user dep.
#   L2 — tenant scope: filename MUST start with `<user_id>_`. The
#        legacy filename convention prefixes every upload with the
#        owner's user_id, so a path like `4d6e..._a1b2.jpg` belongs
#        to user 4d6e... and only that user.
#   L3 — path-traversal guard: resolved path must stay inside uploads_dir.
#   L4 — generic 404 on any failure so an attacker can't probe for
#        existence vs ownership.
#
# Note: this endpoint serves the legacy local-disk uploads. Going
# forward, new receipts persist to Supabase Storage and are served
# via the model-specific endpoints (e.g. /api/kasserapport/{id}/image)
# which scope by row.user_id directly. This local-disk path stays for
# backwards-compat with already-uploaded files, with the IDOR closed.
uploads_dir = Path("uploads/receipts")
uploads_dir.mkdir(parents=True, exist_ok=True)


def _serve_receipt_unauth_404(detail: str = "File not found"):
    """Generic 404 — never leak whether the path exists, who owns it,
    or whether auth is the issue. An attacker probing this endpoint
    sees the same response for every failure mode."""
    return JSONResponse(status_code=404, content={"detail": detail})


@app.get("/uploads/receipts/{filename}")
@limiter.limit("120/minute")
def serve_receipt(filename: str, request: Request):
    """Serve a receipt image. Auth-required + filename must be
    prefixed with the requesting user's id (legacy convention).

    Rate-limited at 120/minute per IP — high enough that a real owner
    re-loading their dashboard with many receipts works, low enough
    that an attacker enumerating filenames hits the brake quickly.
    Uses the global app limiter (declared above) since this endpoint
    sits outside the API router groups."""
    # Resolve auth manually — this endpoint sits outside the API
    # routers (mounted at root) so we can't use Depends(get_current_user)
    # cleanly without restructuring. Manual call replicates the same
    # JWT/cookie resolution.
    from app.services.auth import get_current_user
    from app.database import SessionLocal
    db = SessionLocal()
    try:
        # Manually resolve the token because FastAPI's Depends won't
        # inject here. We support both bearer header and session cookie,
        # matching app/services/auth.py:get_current_user.
        from app.services.auth import (
            AUTH_COOKIE_NAME, _decode_token,
        )
        from jose import JWTError
        from app.models.user import User as _User

        bearer = request.headers.get("authorization", "")
        token = None
        if bearer.lower().startswith("bearer "):
            token = bearer.split(" ", 1)[1].strip()
        if not token:
            token = request.cookies.get(AUTH_COOKIE_NAME)
        if not token:
            return _serve_receipt_unauth_404()

        try:
            payload = _decode_token(token)
            user_id = payload.get("sub")
            if not user_id:
                return _serve_receipt_unauth_404()
        except JWTError:
            return _serve_receipt_unauth_404()

        user = db.query(_User).filter(_User.id == user_id).first()
        if not user:
            return _serve_receipt_unauth_404()

        # L2 — tenant scope: filename MUST begin with `<user_id>_`.
        user_prefix = f"{user.id}_"
        if not filename.startswith(user_prefix):
            return _serve_receipt_unauth_404()

        file_path = uploads_dir / filename
        if not file_path.exists() or not file_path.is_file():
            return _serve_receipt_unauth_404()

        # L3 — path traversal guard.
        try:
            file_path.resolve().relative_to(uploads_dir.resolve())
        except ValueError:
            return _serve_receipt_unauth_404()

        return Response(
            content=file_path.read_bytes(),
            media_type="image/jpeg",
            headers={"Cache-Control": "private, max-age=3600"},
        )
    finally:
        db.close()


# --- Background scheduler: auto-sync payment providers + nightly maintenance ---
try:
    from apscheduler.schedulers.background import BackgroundScheduler
    from apscheduler.triggers.interval import IntervalTrigger
    from apscheduler.triggers.cron import CronTrigger
    from app.services.payment_autosync import run_auto_sync
    from app.jobs.retention_and_patterns import daily_maintenance
    from app.jobs.kasserapport_learning_jobs import (
        daily_drift_sweep,
        weekly_pattern_sweep,
    )
    from app.jobs.demo_refresh_job import refresh_demo_account
    from app.jobs.recurring_expenses_job import materialize_due_recurring_expenses
    from app.jobs.daily_brief_email_job import send_daily_brief_emails
    # Task #67 — Aiia nightly sync. 03:30 UTC = ~04:30/05:30 Copenhagen.
    # Iterates active BankConnections, pulls bank transactions via Aiia,
    # writes them as Sale/Expense rows, runs them through reconciliation,
    # auto-confirms HIGH+exact matches.
    from app.jobs.aiia_sync_job import run_aiia_sync_tick
    # Task #71 — MobilePay nightly sync. 03:45 UTC = ~04:45/05:45
    # Copenhagen — 15 minutes after Aiia so bank-side payout rows
    # already exist and the matcher can dedupe MobilePay settlements
    # against the Aiia-imported aggregate payout.
    from app.jobs.mobilepay_sync_job import run_mobilepay_sync_tick
    # Task #72 — Native push fan-out at 06:00 UTC ≈ 07:00/08:00 Copenhagen
    # — slightly before the email cron at 06:30 UTC because push provider
    # fan-out can take 15-30 s when there's a backlog. Per-user errors
    # isolated; the brief cache means the second-fired (email) cron hits
    # the same DailyBrief row and adds no extra LLM cost.
    from app.jobs.daily_brief_push_job import send_daily_brief_pushes

    _scheduler = BackgroundScheduler()
    _scheduler.add_job(
        run_auto_sync,
        trigger=IntervalTrigger(hours=6),
        id="payment_autosync",
        name="Auto-sync payment providers",
        replace_existing=True,
    )
    # Nightly: GDPR purge old events + expire stale patterns + run detectors.
    # 02:30 UTC = 03:30/04:30 Copenhagen — well outside business hours.
    _scheduler.add_job(
        daily_maintenance,
        trigger=CronTrigger(hour=2, minute=30),
        id="daily_maintenance",
        name="GDPR retention + pattern detection",
        replace_existing=True,
    )
    # Kasserapport learning loop — daily drift sweep (03:00 UTC) +
    # weekly correction-pattern sweep (Sunday 03:30 UTC). These run
    # AFTER nightly maintenance so they see fresh data.
    _scheduler.add_job(
        daily_drift_sweep,
        trigger=CronTrigger(hour=3, minute=0),
        id="kasserapport_drift_sweep",
        name="Kasserapport drift monitor — confidence trend per POS",
        replace_existing=True,
    )
    _scheduler.add_job(
        weekly_pattern_sweep,
        trigger=CronTrigger(day_of_week="sun", hour=3, minute=30),
        id="kasserapport_pattern_sweep",
        name="Kasserapport correction-pattern sweep (weekly)",
        replace_existing=True,
    )
    # Demo account refresh — idempotent daily nudge so demo@bonbox.dk
    # never falls out of trial state. The job itself no-ops if the
    # trial is far from expiring, so cost is one DB read per day. Runs
    # at 03:15 UTC — between the kasserapport sweeps to spread DB load.
    # In-process only; never wired to an HTTP endpoint (security: zero
    # attack surface for demo-data manipulation).
    _scheduler.add_job(
        refresh_demo_account,
        trigger=CronTrigger(hour=3, minute=15),
        id="demo_account_refresh",
        name="Demo account trial refresh",
        replace_existing=True,
    )
    # Task #47 — Materialize due recurring expenses. 04:00 UTC = ~05:00-
    # 06:00 Copenhagen — before owners check the app for the day. Per-
    # rule SAVEPOINT-style commits so one bad row doesn't poison the
    # whole sweep. Idempotent (skips today's already-posted rules).
    _scheduler.add_job(
        materialize_due_recurring_expenses,
        trigger=CronTrigger(hour=4, minute=0),
        id="recurring_expenses",
        name="Materialize due recurring expenses",
        replace_existing=True,
    )
    # Task #54 — Daily Brief email at 06:30 UTC ≈ 07:30 (CET winter) /
    # 08:30 (CEST summer) Copenhagen. Same brief as the in-app card,
    # delivered to inbox so BonBox arrives without the owner having to
    # open the app. Per-user errors are isolated; one bad email never
    # poisons the batch. Idempotent — last_brief_emailed_at stamps
    # short-circuit any same-day re-send.
    _scheduler.add_job(
        send_daily_brief_emails,
        trigger=CronTrigger(hour=6, minute=30),
        id="daily_brief_email",
        name="Daily Brief morning email",
        replace_existing=True,
    )
    # Task #67 — Aiia bank sync. 03:30 UTC — after maintenance + drift
    # sweeps, before owners check the app in the morning. Skips
    # connections synced in the last 12h so manual syncs from the UI
    # earlier in the day don't get double-pulled.
    _scheduler.add_job(
        run_aiia_sync_tick,
        trigger=CronTrigger(hour=3, minute=30),
        id="aiia_sync",
        name="Aiia nightly bank sync",
        replace_existing=True,
    )
    # Task #71 — MobilePay nightly sync. 03:45 UTC — 15 min after
    # Aiia. Skips connections synced in the last 12h so manual syncs
    # from the UI earlier in the day don't get double-pulled.
    _scheduler.add_job(
        run_mobilepay_sync_tick,
        trigger=CronTrigger(hour=3, minute=45),
        id="mobilepay_sync",
        name="MobilePay nightly payments sync",
        replace_existing=True,
    )
    # Task #72 — Daily Brief native push at 06:00 UTC ≈ 07:00/08:00
    # Copenhagen. Slightly ahead of the email cron (06:30 UTC) because
    # push fan-out is slower (many small per-device HTTPS calls vs one
    # Resend call). Both surfaces deliver the SAME brief (get_or_create_brief
    # caches per day). Failed devices auto-pruned (410 Gone or fail_count>=3).
    _scheduler.add_job(
        send_daily_brief_pushes,
        trigger=CronTrigger(hour=6, minute=0),
        id="daily_brief_push",
        name="Daily Brief morning push",
        replace_existing=True,
    )
    _scheduler.start()
    print("Schedulers started: payment auto-sync (6h), nightly maintenance (02:30), "
          "kasserapport drift (03:00), demo refresh (03:15), kasserapport patterns (Sun 03:30), "
          "recurring expenses (04:00), daily brief push (06:00), daily brief email (06:30), "
          "aiia sync (03:30), mobilepay sync (03:45)")

    # Scheduler shutdown migrated to the `lifespan` context manager
    # near the FastAPI() constructor. It checks globals() for the
    # _scheduler symbol so it cleanly no-ops if THIS try block
    # failed before assignment.

except Exception as e:
    print(f"Scheduler warning: {e}")


@app.api_route("/", methods=["GET", "HEAD"])
def root():
    return {"status": "ok", "service": "bonbox-api"}


@app.api_route("/api/health", methods=["GET", "HEAD"])
def health_check():
    return {"status": "ok"}


@app.api_route("/api/keepalive", methods=["GET", "HEAD"])
def keepalive():
    """Cheap warm-keep endpoint — Task #97 multi-layer defense.

    External uptime pinger (UptimeRobot / cron-job.org / BetterStack)
    hits this every 10 minutes to keep Render's free dyno warm and
    prevent the 20-30s cold-start that ate the first sign-in flow
    every day.  Returns 204 No Content with zero DB hit, no
    middleware overhead, no JSON serialization — cheapest endpoint
    we can offer.

    Why a separate endpoint instead of just /api/health?
      • /api/health is documented as a Render healthcheck — it sits
        behind the DB-readiness gate's allowlist but it's still
        conceptually "is the app alive".  Pinging it works but
        muddies the operator's metrics (healthcheck graph vs
        keepalive traffic).
      • /api/keepalive is explicitly opted into by the operator,
        with a documented external pinger.  Both metrics stay clean.

    See docs/DEPLOYMENT.md §11 for the setup instructions.
    """
    from fastapi import Response
    return Response(status_code=204)


@app.get("/api/config/features")
def public_features():
    """Public feature flags — Task #106.

    Drives conditional UI render so we don't claim "Connect bank
    automatically" when only the in-process mock is wired in.
    Read once on app boot; the SPA caches the result for the
    session.  Returns booleans only — no secrets, no env values,
    just what each integration tile should render or hide.
    """
    from app.utils.features import feature_flags
    return feature_flags()


@app.get("/api/health/db")
def health_db():
    """Check database connectivity."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"status": "ok", "database": "connected"}
    except Exception:
        return JSONResponse(status_code=503, content={"status": "error", "database": "unreachable"})
