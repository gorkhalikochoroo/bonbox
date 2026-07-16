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
from app.utils.client_ip import client_ip
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from sqlalchemy import text

from app.config import settings
from app.routers import auth, sales, expenses, inventory, reports, dashboard, staffing, waste, feedback, cashbook, events, event_log as event_log_router, khata, budget, loan, email_settings, whatsapp, weather, agent, bank_import, team, business_profile, payment_import, cashflow, tax, pricing, retention, expiry, outlet, competitor, branch, daily_close, workshop, wine, staff, staff_portal, admin, patterns, exports, waitlist, billing, property_report, kasserapport, terminal, output_channel, order_channel_config, inventory_smart_import, smart_drift, support, search as search_router, modules as modules_router, ai as ai_router, smart_pricing as smart_pricing_router, pillars as pillars_router, diagnostics as diagnostics_router
# Invoicing — Customer/Invoice/Mileage. Gated to Starter+ at the route level.
from app.routers import staff_chat as staff_chat_router
from app.routers import activation as activation_router
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
# Smart Scan — the "snap anything" entry point. Reuses the doc-type
# classifier (#145) to route to the right destination page with
# pre-extracted data. Universal feature; batch + PDF-direct are gated.
from app.routers import smart_scan as smart_scan_router
# Receipt-forwarding email inbox (v0.1). Postmark Inbound webhook +
# alias allocator + lightweight test endpoint. Dark-launched behind
# INBOX_ENABLED until prod Postmark creds land — see utils.features.
from app.routers import inbox as inbox_router
# Task #72 — Web Push (VAPID) subscribe / unsubscribe / public-key /
# test endpoints. Mounted under /api/push. The 8am morning brief
# delivery cron lives in app.jobs.daily_brief_push_job.
from app.routers import push as push_router
# 2026-05-24 — Accountant Hours Saved widget. Read-only metric that
# powers the dashboard "Du har sparet revisoren X timer" tile and the
# live tagline on the Starter pricing card. Aggregate-only, tier-gated
# via accountant_hours_widget.
from app.routers import accountant_savings as accountant_savings_router
# 2026-05-25 — Tier 4 Dashboard restructure (Phase F). Pro killer #3
# behind the GrowthLeverCard slot in Zone 2 — simple SQL aggregation
# of event/sale patterns surfaces 1-3 ranked growth signals like
# "Friday events earn 73% more per ticket". Tier-gated on the new
# `growth_intelligence` PLAN_FEATURE; full 10-layer doctrine in the
# router module.
from app.routers import growth_signals as growth_signals_router
# 2026-05-25 — Event-booking product (v3 ledger-only). Public-facing
# event surface + visitor checkout + door scanning. The organizer-side
# publish/unpublish/mark-paid endpoints live on routers.events; this
# trio handles the unauthenticated visitor flow + the scan-time door
# endpoint. BonBox never touches money — payment provider integrations
# stay deferred per Manoj's v3 lock.
from app.routers import public_events as public_events_router
from app.routers import public_bookings as public_bookings_router
from app.routers import tickets as tickets_router
# Reservations (table booking + appointments) — owner CRUD + the public
# /r/<slug> booking surface. Generic bookable-resource engine.
from app.routers import reservations as reservations_router
from app.routers import reservation_insights as reservation_insights_router
from app.routers import public_reservations as public_reservations_router
from app.routers import public_gavekort as public_gavekort_router
from app.routers import gavekort as gavekort_router
# Onboarding — business-archetype detection (keyword fast-path → AI fallback)
from app.routers import onboarding as onboarding_router
from app.database import engine, Base, get_db
from app.models import *  # noqa: ensure all models are loaded

# DB readiness flag — set once tables + migrations are done
_db_ready = threading.Event()

# Run schema migrations (idempotent — safe to run multiple times)
_migrations = [
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) DEFAULT 'card'",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS clock_settings_json TEXT",
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
    # Foresight manual bank-balance seed (no-provider path).
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS manual_bank_balance NUMERIC(14, 2)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS manual_bank_balance_at TIMESTAMP",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(100)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_attempts INTEGER DEFAULT 0",
    # Server-side session revocation epoch (token_version / "sign out all").
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 0 NOT NULL",
    # Shared-device ("Delt enhed") reveal PIN (task #379).
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS device_pin_hash VARCHAR(200)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS device_pin_failed_count INTEGER DEFAULT 0 NOT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS device_pin_locked_until TIMESTAMP",
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
    # Business profile — service-day rollover hour. Default 6 = Danish
    # restaurant convention (02:00 close still counts toward yesterday's
    # shift). Matches the SQLAlchemy model default + tz_utils helper
    # default after migration 012_dk_cutoff_default_6. Pre-migration
    # tenants get backfilled by the migration; this DDL is the safety
    # net for fresh schemas that haven't gone through Alembic.
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS day_cutoff_hour INTEGER DEFAULT 6",
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
    # ── Migration 013: kulturarrangør — Event entity + Sale.event_id ────
    # Cultural-event organizers (Sudip-style customers) tag each Sale with
    # the event it belongs to, so post-event reports can be sliced by show.
    #
    # CRITICAL: this block must run BEFORE migration 014 (which adds the
    # expense FX columns) because migration 014 chained off 013 in alembic.
    # Failure mode if missing: every Dashboard / Sales / Reports query
    # 500s with "column sales.event_id does not exist" because SQLAlchemy
    # auto-selects Sale.event_id once the model declares it. 2026-05-24
    # incident — Agent Y added the alembic file but missed this list,
    # taking the home page offline for ~30 min before hotfix.
    #
    # VARCHAR(36) for event_id matches GUID() (see Migration 034 comment).
    # Native UUID would silently fail inside the SAVEPOINT wrapper.
    """CREATE TABLE IF NOT EXISTS events (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        name VARCHAR(255) NOT NULL,
        event_date DATE NOT NULL,
        venue VARCHAR(255),
        notes TEXT,
        is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_events_user_id ON events (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_event_user_date ON events (user_id, event_date, is_deleted)",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS event_id VARCHAR(36) REFERENCES events(id) ON DELETE SET NULL",
    "CREATE INDEX IF NOT EXISTS ix_sale_event_id ON sales (event_id)",
    "CREATE INDEX IF NOT EXISTS ix_sales_user_event ON sales (user_id, event_id) WHERE event_id IS NOT NULL",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS ticket_breakdown JSONB",
    # ── Migration 014: foreign-currency capture on expenses ─────────────
    # Bogføringsloven §10 / SKAT cross-border compliance. Three nullable
    # columns; existing single-currency rows are unaffected.
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS currency VARCHAR(3)",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(10,6)",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS original_amount NUMERIC(14,2)",
    # receipt_source — distinguishes an OCR scan ('scan'/NULL) from a manual
    # bilag attach ('attach'). Lets the scan-cap meter exclude free attaches
    # so stapling evidence onto an existing row never burns an OCR credit.
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_source VARCHAR(20)",
    # status — Godkend-kø gate. 'approved' (default) = real expense in every
    # money total; 'pending' = unapproved AI draft, excluded until the owner
    # taps Godkend. DEFAULT 'approved' keeps all existing rows live (numbers
    # byte-identical). The exclusion is enforced in app/services/expense_status.py.
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS status VARCHAR(12) DEFAULT 'approved'",
    # Backfill: any inbox-captured '[needs review]' row becomes a pending draft
    # (idempotent — only flips approved→pending for unreviewed rows).
    "UPDATE expenses SET status = 'pending' WHERE status = 'approved' AND description LIKE '%[needs review]%'",
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

    # ── Migration 054: Inventory expiry chain Phase 1 (Manoj-confirmed) ──
    # Two additive InventoryItem columns powering the expiry alert chain:
    # `received_date` — used as the inference base for expiry when the
    #     supplier invoice doesn't carry "Bedst før" / "Udløb". Falls
    #     back to created_at::date when NULL so existing rows keep
    #     working (no backfill needed).
    # `expected_shelf_life_days` — per-item override of the category
    #     default in inventory_perishable.SHELF_LIFE_DAYS. NULL = use
    #     the table.
    # Idempotent — safe to re-run.
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS received_date DATE",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS expected_shelf_life_days INTEGER",

    # ── Migration 015 (alembic n4o5p6q7r8s9): Cash-up event ticket sheet ──
    # events.ticket_tiers — JSONB array of `{label, price_dkk}` rows,
    # defined at event-create time. The "💰 Cash up event" modal reads
    # this back and renders the tiers as a count-per-tier sheet. Nullable
    # so existing events without a ticketed pricing structure keep working
    # (the cash-up button stays disabled for them; tooltip explains).
    # events.is_tax_exempt — whole-event MOMS-fri flag for cases like
    # Momsloven §13 (live theatre, museum). The cash-up handler stamps
    # the resulting Sale row with this flag so the revisor's MOMS extract
    # is correct. Default FALSE = standard 25% MOMS posture, which is
    # what every existing event implicitly is.
    # CRITICAL: list this after migration 013 so the `events` table
    # exists when these ALTERs land. The SAVEPOINT loop below tolerates
    # an idempotent re-run because IF NOT EXISTS guards the ADD COLUMN.
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS ticket_tiers JSONB",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS is_tax_exempt BOOLEAN NOT NULL DEFAULT FALSE",

    # ── Migration 016: Receipt-forwarding email inbox (v0.1) ──────────
    # The Sudip-style "forward like you do to your revisor" workflow.
    # Three users columns + two new tables. ALL ids VARCHAR(36) to match
    # the GUID() TypeDecorator (see Migration 034 comment above). Native
    # UUID would FK-fail on Postgres.
    #
    # Idempotent — every ALTER has IF NOT EXISTS, every CREATE TABLE has
    # IF NOT EXISTS, every CREATE INDEX has IF NOT EXISTS. Safe to re-run.
    #
    # Retention: EmailMessage + ReceiptIntake rows that produced an
    # accounting entry must be retained for 5 years (Bogføringsloven
    # §10). Rejected/quarantined/orphan rows fall under 30d spam
    # retention. The purge job is deferred to v0.2 — see TODO in
    # services/accounting_retention.py once Manoj greenlights it.
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS inbox_alias VARCHAR(40) UNIQUE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS inbox_enabled BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS inbox_alias_rotated_at TIMESTAMP",
    # Partial index — only non-null aliases. Speeds up the alias→user
    # lookup on every webhook hit without bloating the index with NULLs.
    "CREATE INDEX IF NOT EXISTS ix_users_inbox_alias ON users (inbox_alias) WHERE inbox_alias IS NOT NULL",

    # email_messages — one row per inbound Postmark webhook hit.
    # status enum enforced via CHECK so a buggy router can never insert
    # an unknown status. UNIQUE(alias, message_id) is the idempotency
    # key — same email replayed is a no-op.
    """CREATE TABLE IF NOT EXISTS email_messages (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
        alias VARCHAR(40) NOT NULL,
        from_addr TEXT NOT NULL,
        subject TEXT,
        message_id TEXT,
        body_text_hash CHAR(64),
        spf_pass BOOLEAN,
        dkim_pass BOOLEAN,
        dmarc_pass BOOLEAN,
        attachment_ct INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN (
            'received','queued','processed','quarantined',
            'throttled','rejected','orphan')),
        reason TEXT,
        received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (alias, message_id)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_em_user_status ON email_messages (user_id, status)",

    # receipt_intake — one row per accepted attachment.
    # expense_id is nullable: we create the intake row, then the
    # expense, then back-fill in the same transaction.
    # storage_path holds a relative path under uploads/receipts/ with a
    # .enc suffix; the blob itself is Fernet-encrypted.
    """CREATE TABLE IF NOT EXISTS receipt_intake (
        id VARCHAR(36) PRIMARY KEY,
        email_message_id VARCHAR(36) REFERENCES email_messages(id) ON DELETE CASCADE,
        user_id VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
        storage_path TEXT NOT NULL,
        filename TEXT,
        mime_type TEXT,
        byte_size INTEGER,
        sha256 CHAR(64) NOT NULL,
        ocr_status TEXT NOT NULL DEFAULT 'queued',
        ocr_confidence REAL,
        expense_id VARCHAR(36) REFERENCES expenses(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_ri_user_status ON receipt_intake (user_id, ocr_status)",

    # ── Migration: extend_events_for_booking (event-booking v3) ──────
    # Adds the columns the public-bookable surface needs while keeping
    # the existing cash-up flow intact. All ALTER COLUMNs are nullable
    # so pre-existing events stay valid. VARCHAR(36) on slug to match
    # the GUID() convention everywhere else (see migration 034 comment
    # on the cost of native UUID + SAVEPOINT-swallow combo).
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS slug VARCHAR(80)",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS published_at TIMESTAMP",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS starts_at TIMESTAMP",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS ends_at TIMESTAMP",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS cover_image_url TEXT",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS subtitle VARCHAR(255)",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS bookings_open_at TIMESTAMP",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS bookings_close_at TIMESTAMP",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS capacity_total INTEGER",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS addons JSONB",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS refund_policy VARCHAR(20) NOT NULL DEFAULT 'organizer'",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS booking_terms_url TEXT",
    "CREATE UNIQUE INDEX IF NOT EXISTS ix_events_slug ON events (slug) WHERE slug IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS ix_events_published_starts ON events (published, starts_at) WHERE published = TRUE",

    # ── Migration: create_bookings_table (event-booking v3) ──────────
    # Visitor-facing reservations. Status transitions: pending → paid
    # → attended (or → refunded / → cancelled / → expired). Foreign
    # keys use VARCHAR(36) per the GUID() convention.
    """CREATE TABLE IF NOT EXISTS bookings (
        id VARCHAR(36) PRIMARY KEY,
        event_id VARCHAR(36) NOT NULL REFERENCES events(id),
        organizer_user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        customer_email VARCHAR(255) NOT NULL,
        customer_name VARCHAR(160) NOT NULL,
        customer_phone VARCHAR(40),
        customer_consent_marketing BOOLEAN NOT NULL DEFAULT FALSE,
        ticket_lines JSONB NOT NULL,
        addon_lines JSONB,
        total_amount_dkk INTEGER NOT NULL CHECK (total_amount_dkk >= 0),
        currency VARCHAR(3) NOT NULL DEFAULT 'DKK',
        is_tax_exempt BOOLEAN NOT NULL DEFAULT FALSE,
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','paid','attended','refunded','cancelled','expired')),
        payment_provider VARCHAR(20),
        payment_provider_ref VARCHAR(120),
        paid_at TIMESTAMP,
        sale_id VARCHAR(36) REFERENCES sales(id) ON DELETE SET NULL,
        refund_sale_id VARCHAR(36) REFERENCES sales(id) ON DELETE SET NULL,
        attended_at TIMESTAMP,
        attended_scanner_user_id VARCHAR(36) REFERENCES users(id),
        idempotency_key VARCHAR(64) UNIQUE,
        is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        expires_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_bookings_event_status ON bookings (event_id, status)",
    "CREATE INDEX IF NOT EXISTS ix_bookings_organizer ON bookings (organizer_user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_bookings_pending_expiry ON bookings (expires_at) WHERE status = 'pending'",
    "CREATE INDEX IF NOT EXISTS ix_bookings_payment_ref ON bookings (payment_provider, payment_provider_ref) WHERE payment_provider_ref IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS ix_bookings_sale_id ON bookings (sale_id) WHERE sale_id IS NOT NULL",

    # ── Migration: create_tickets_table (event-booking v3) ──────────
    # One row per individual ticket. Fan-out from a booking with N
    # tickets = N rows. Voided rather than deleted on refund/cancel
    # so the audit + QR-payload trail survives.
    """CREATE TABLE IF NOT EXISTS tickets (
        id VARCHAR(36) PRIMARY KEY,
        booking_id VARCHAR(36) NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        event_id VARCHAR(36) NOT NULL REFERENCES events(id),
        tier_label VARCHAR(40) NOT NULL,
        tier_price_dkk INTEGER NOT NULL,
        qr_payload TEXT NOT NULL,
        scanned_at TIMESTAMP,
        scanner_user_id VARCHAR(36) REFERENCES users(id),
        is_void BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_tickets_booking ON tickets (booking_id)",
    "CREATE INDEX IF NOT EXISTS ix_tickets_event_scanned ON tickets (event_id, scanned_at)",

    # ── Migration: create_event_customers_table (event-booking v3) ──
    # De-duplicated visitor profiles per organizer. Updated atomically
    # on booking.paid via services/booking_to_sale.py. UNIQUE
    # (organizer_user_id, email) so consent + counts stay per-tenant.
    """CREATE TABLE IF NOT EXISTS event_customers (
        id VARCHAR(36) PRIMARY KEY,
        organizer_user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        name VARCHAR(160),
        phone VARCHAR(40),
        first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        bookings_count INTEGER NOT NULL DEFAULT 0,
        total_spend_dkk INTEGER NOT NULL DEFAULT 0,
        marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
        CONSTRAINT uq_event_customer_organizer_email UNIQUE (organizer_user_id, email)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_event_customer_organizer_seen ON event_customers (organizer_user_id, last_seen_at)",

    # Migration 017 (2026-05-26): team invite magic-link flow — replaces
    # the plaintext temp_password leak on POST /api/team/invite.  The
    # corresponding Alembic file (`017_team_invite_tokens.py`) is kept
    # for documentation but NOT load-bearing — BonBox runs migrations
    # via this in-process ALTER list, not via `alembic upgrade head`.
    # All three columns nullable, no server default → existing rows are
    # untouched and the deploy is non-locking.  Adding here means a fresh
    # Render database (or a wiped staging DB) picks them up automatically
    # next time `_run_migrations()` runs.
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_token_hash CHAR(64)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMP",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by_user_id VARCHAR(36)",
    "CREATE INDEX IF NOT EXISTS ix_users_invite_token_hash ON users (invite_token_hash)",

    # Migration 018 (2026-05-26): kasserapport_extractions.terminal_id — the
    # optional FK introduced when Mirabelle-style multi-terminal venues
    # started tagging each Z-report scan with the terminal it came from
    # (so the aggregator can sum across them per close).  Declared in
    # `app/models/kasserapport.py:43-45` but never landed in prod because
    # the change shipped without an in-process ALTER.  Schema-drift self-
    # test caught it at boot → `_db_ready` never set → every authenticated
    # request 503'd ("Server is starting up").  Same failure mode as the
    # invite_token_hash drift above; same fix.
    #
    # Type is VARCHAR(36) (not native UUID) because `terminals.id` is
    # CHAR(36) under the GUID() TypeDecorator (load_dialect_impl returns
    # String(36) for every dialect) — adding as native UUID errored with
    # "incompatible types: uuid and character varying" on the FK clause.
    # NULL = single-terminal venue OR pre-migration data, per the model.
    "ALTER TABLE kasserapport_extractions ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(36) REFERENCES terminals(id) ON DELETE SET NULL",
    "CREATE INDEX IF NOT EXISTS ix_kasserapport_extractions_terminal_id ON kasserapport_extractions (terminal_id)",

    # Migration 019 (2026-05-28): terminal_providers registry — Commit 1
    # of the POS terminal auto-detect feature. Global catalog of DK/EU
    # acquirers (Nets, Worldline, MobilePay Point, SumUp, etc.) seeded
    # at boot from backend/app/data/terminal_providers.json. Per-tenant
    # `terminals` row gains a soft FK + confidence + owner-lock columns
    # so future auto-detect (Commit 2) can stamp the provider on each
    # Z-report scan. RLS deny policy applied per docs/security-rls-doctrine.md
    # — global metadata still gets the standard anon/authenticated deny
    # as defense-in-depth.
    #
    # Type is VARCHAR(36) on the FK to match the GUID() TypeDecorator
    # the rest of the schema uses — see the Migration 018 comment above
    # for why we cannot use native UUID here.
    """CREATE TABLE IF NOT EXISTS terminal_providers (
        id VARCHAR(36) PRIMARY KEY,
        slug VARCHAR(40) NOT NULL UNIQUE,
        display_name VARCHAR(80) NOT NULL,
        country_hq VARCHAR(2),
        dk_market_tier VARCHAR(20) NOT NULL,
        industries VARCHAR(200),
        psd2_settlement VARCHAR(10) NOT NULL DEFAULT 'no',
        signature_keywords TEXT NOT NULL DEFAULT '',
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )""",
    "CREATE INDEX IF NOT EXISTS ix_terminal_providers_slug ON terminal_providers (slug)",
    "CREATE INDEX IF NOT EXISTS ix_terminal_providers_active ON terminal_providers (is_active)",
    # RLS doctrine — see docs/security-rls-doctrine.md. Global catalog
    # has no per-tenant PII, but anon/authenticated still get a RESTRICTIVE
    # deny so a leaked Supabase anon key can't SELECT the table. Backend
    # connects as `postgres` (BYPASSRLS=true), unaffected.
    "ALTER TABLE terminal_providers ENABLE ROW LEVEL SECURITY",
    "DROP POLICY IF EXISTS rls_deny_anon ON terminal_providers",
    "CREATE POLICY rls_deny_anon ON terminal_providers AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)",
    # Per-tenant Terminal row — add provider link + confidence + owner-lock.
    "ALTER TABLE terminals ADD COLUMN IF NOT EXISTS provider_id VARCHAR(36) REFERENCES terminal_providers(id) ON DELETE SET NULL",
    "ALTER TABLE terminals ADD COLUMN IF NOT EXISTS provider_confidence NUMERIC(3,2)",
    "ALTER TABLE terminals ADD COLUMN IF NOT EXISTS provider_locked_by_owner BOOLEAN NOT NULL DEFAULT false",
    "CREATE INDEX IF NOT EXISTS ix_terminals_provider_id ON terminals (provider_id)",

    # Migration 020 (2026-05-28): POS terminal auto-detect — Commit 2.
    # Per-scan detection columns on kasserapport_extractions. Populated
    # by the keyword-matcher in services/terminal_provider_detector.py
    # when /daily-close/scan-report runs the OCR pipeline. Distinct from
    # the per-Terminal provider_id columns above — these are PER-SCAN
    # (what we detected on THIS upload), the Terminal row stores the
    # current linked provider (silent-linked when confidence >=0.85 AND
    # the owner has exactly one unlinked terminal). Keeping them apart
    # gives the admin training review honest "detected vs confirmed"
    # signal without trusting Terminal as the ground truth.
    "ALTER TABLE kasserapport_extractions ADD COLUMN IF NOT EXISTS detected_provider_slug VARCHAR(40)",
    "ALTER TABLE kasserapport_extractions ADD COLUMN IF NOT EXISTS detected_provider_confidence NUMERIC(3,2)",
    "CREATE INDEX IF NOT EXISTS ix_kasserapport_extractions_detected_provider_slug ON kasserapport_extractions (detected_provider_slug)",

    # ── Migration 021 (2026-05-28): Staff v2 — push subscription per staff ──
    # Adds a nullable staff_id discriminator to push_subscriptions so the
    # same VAPID infrastructure can serve owner devices (staff_id NULL)
    # AND staff devices subscribed via the magic-link portal (staff_id
    # set). One table, two audiences — matches the existing
    # "multiple devices per user_id" docstring on PushSubscription.
    #
    # Why this column is safe to add:
    #   • Nullable + no default — existing owner rows stay unchanged.
    #   • Reads filtered by (user_id, staff_id IS NULL) for owner fan-out
    #     and (user_id, staff_id = X) for staff fan-out — no ambiguity.
    #   • UNIQUE(user_id, endpoint) constraint already deduplicates rows
    #     so a staff re-subscribe on the same device is still an upsert.
    "ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS staff_id VARCHAR(36) REFERENCES staff_members(id)",
    "CREATE INDEX IF NOT EXISTS ix_push_subscriptions_staff_id ON push_subscriptions (staff_id)",

    # ── Migration 022 (2026-05-29): Reservations (table booking + appts) ──
    # Generic bookable-resource engine. `bookable_resources` = a table /
    # provider / room; `reservations` = a guest holding one for a time
    # range. Mirrors app/models/bookable_resource.py + reservation.py.
    # VARCHAR(36) on every id/FK to match the GUID() TypeDecorator (native
    # UUID breaks FK joins inside the SAVEPOINT wrapper — see Migration 018
    # comment). create_all() builds these from the models on a fresh DB;
    # this block is the load-bearing path on Render/Supabase prod and the
    # net for emergency-restore where create_all is bypassed. JSONB matches
    # what GUID()/JSON().with_variant produces on Postgres (TEXT on SQLite).
    """CREATE TABLE IF NOT EXISTS bookable_resources (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        kind VARCHAR(20) NOT NULL DEFAULT 'table',
        label VARCHAR(120) NOT NULL,
        capacity_seats INTEGER NOT NULL DEFAULT 2,
        zone VARCHAR(60),
        combinable BOOLEAN NOT NULL DEFAULT FALSE,
        staff_id VARCHAR(36) REFERENCES staff_members(id),
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_bookable_resources_user_id ON bookable_resources (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_bookable_resource_user_active ON bookable_resources (user_id, is_active, is_deleted)",
    "CREATE INDEX IF NOT EXISTS ix_bookable_resources_staff_id ON bookable_resources (staff_id)",
    """CREATE TABLE IF NOT EXISTS reservations (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        resource_id VARCHAR(36) REFERENCES bookable_resources(id),
        combined_resource_ids JSONB,
        guest_name VARCHAR(160),
        guest_email VARCHAR(255),
        guest_phone VARCHAR(40),
        guest_consent_marketing BOOLEAN DEFAULT FALSE,
        party_size INTEGER NOT NULL DEFAULT 2,
        starts_at TIMESTAMP NOT NULL,
        ends_at TIMESTAMP NOT NULL,
        service_name VARCHAR(120),
        duration_min INTEGER NOT NULL DEFAULT 90,
        status VARCHAR(20) NOT NULL DEFAULT 'confirmed',
        source VARCHAR(20) NOT NULL DEFAULT 'public',
        allergen_tags JSONB,
        allergy_note TEXT,
        allergy_severity VARCHAR(20),
        occasion VARCHAR(60),
        guest_notes TEXT,
        confirmation_sent_at TIMESTAMP,
        reminder_sent_at TIMESTAMP,
        seated_at TIMESTAMP,
        cancelled_at TIMESTAMP,
        cancel_reason VARCHAR(255),
        purge_after TIMESTAMP,
        purged_at TIMESTAMP,
        idempotency_key VARCHAR(80) UNIQUE,
        is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_reservations_user_id ON reservations (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_reservation_user_start ON reservations (user_id, starts_at, is_deleted)",
    "CREATE INDEX IF NOT EXISTS ix_reservation_resource_start ON reservations (resource_id, starts_at)",
    "CREATE INDEX IF NOT EXISTS ix_reservation_purge ON reservations (purge_after)",
    # Per-business public reservation page: vanity slug + on/off switch +
    # availability settings (turn-times, pacing, party caps, retention) as
    # JSON so we can iterate config without a migration each time.
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS reservation_slug VARCHAR(80)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_business_reservation_slug ON business_profiles (reservation_slug)",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS reservations_enabled BOOLEAN DEFAULT FALSE",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS reservation_settings_json TEXT",
    # ── Migration 055 (2026-05-30): Reservation integrity backbone (P0) ──
    # The DB-enforced "no double-booking, ever" guarantee. See §2 of
    # docs/reservations-architecture.md + app/models/reservation_occupancy.py.
    #
    # POSTGRES-ONLY. Every statement below uses btree_gist / tsrange / a
    # PL/pgSQL DO-block — none of which SQLite understands. This is safe
    # because `_run_migrations()` only iterates this `_migrations` list on
    # the PostgreSQL branch (the SQLite branch uses the hardcoded `_add()`
    # column list + a small index list and NEVER touches `_migrations`). On
    # SQLite the `reservation_occupancy` TABLE is created by
    # `Base.metadata.create_all()` from the model (columns only, no exclusion
    # constraint) — local dev relies on the app-level recheck. On Postgres,
    # each statement runs inside its own SAVEPOINT, so a statement that fails
    # (e.g. btree_gist unavailable) is rolled back and skipped without
    # aborting the rest — the per-statement "swallow" the design relies on.
    #
    # btree_gist enables the `=` (equality) operator class inside a gist
    # exclusion alongside the `&&` range-overlap operator.
    "CREATE EXTENSION IF NOT EXISTS btree_gist",
    # VARCHAR(36) ids match the GUID() TypeDecorator (native UUID breaks FK
    # joins inside the SAVEPOINT wrapper — see Migration 018/022 comments).
    # Mirrors app/models/reservation_occupancy.py.
    """CREATE TABLE IF NOT EXISTS reservation_occupancy (
        id VARCHAR(36) PRIMARY KEY,
        reservation_id VARCHAR(36) NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
        resource_id VARCHAR(36) NOT NULL REFERENCES bookable_resources(id),
        user_id VARCHAR(36) NOT NULL,
        starts_at TIMESTAMP NOT NULL,
        ends_at TIMESTAMP NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    # ⭐ The heart of the P0 fix. A party of 6 across two 4-tops = two rows,
    # each individually overlap-protected. `tsrange(starts_at, ends_at)` is
    # half-open [start, end) — touching ends DON'T conflict, exactly matching
    # the engine's `_overlaps` (a 18:00–19:30 booking frees 19:30). The
    # partial `WHERE (active)` means cancelled/no-show/completed rows (active
    # = FALSE) stop blocking the slot automatically.
    #
    # `ALTER TABLE ... ADD CONSTRAINT` has no `IF NOT EXISTS`, and this list
    # re-runs on every boot — so we wrap it in a DO-block that swallows the
    # `duplicate_object` raised on the second+ boot. (The outer SAVEPOINT
    # would also catch it, but the DO-block keeps the intent local + explicit
    # and avoids a noisy "Migration N skipped" log line every restart.)
    """DO $$ BEGIN
        ALTER TABLE reservation_occupancy
          ADD CONSTRAINT reservation_occupancy_no_overlap
          EXCLUDE USING gist (
            resource_id WITH =,
            tsrange(starts_at, ends_at) WITH &&
          ) WHERE (active);
    EXCEPTION
        WHEN duplicate_object THEN NULL;
        WHEN duplicate_table THEN NULL;
    END $$;""",
    "CREATE INDEX IF NOT EXISTS ix_reservation_occupancy_user_start ON reservation_occupancy (user_id, starts_at)",
    "CREATE INDEX IF NOT EXISTS ix_reservation_occupancy_reservation ON reservation_occupancy (reservation_id)",
    # Backfill: one active occupancy row per existing active reservation that
    # holds a resource and has no occupancy row yet. Active = status IN
    # (requested, confirmed, seated) — matching ACTIVE_STATUSES in
    # reservation_service. Idempotent via the NOT EXISTS guard, so re-running
    # on every boot is a no-op once backfilled. gen_random_uuid() is built in
    # on PG 13+ (Supabase). Soft-deleted reservations are excluded.
    """INSERT INTO reservation_occupancy (id, reservation_id, resource_id, user_id, starts_at, ends_at, active, created_at)
       SELECT gen_random_uuid()::text, r.id, r.resource_id, r.user_id, r.starts_at, r.ends_at, TRUE, CURRENT_TIMESTAMP
       FROM reservations r
       WHERE r.resource_id IS NOT NULL
         AND r.is_deleted = FALSE
         AND r.status IN ('requested', 'confirmed', 'seated')
         AND NOT EXISTS (
           SELECT 1 FROM reservation_occupancy o
           WHERE o.reservation_id = r.id AND o.resource_id = r.resource_id
         )""",
    # ── Migration 056 (2026-05-30): Combinable tables ──
    # Seat a party that fits no single table across 2+ combinable same-zone
    # tables (a 6 across a 4-top + 2-top). Each combined table keeps its OWN
    # reservation_occupancy row, so Migration 055's exclusion constraint still
    # guarantees no double-booking per table — combining never weakens the
    # guarantee. See docs/reservations-architecture.md §10 +
    # app/services/availability_engine.py:find_combo.
    #
    # Both columns ALSO live in the emergency-restore CREATE TABLE blocks
    # above; these idempotent ALTERs add them to the live prod tables (built by
    # create_all from the pre-combine models). REQUIRED by the schema-drift
    # self-test — the new model columns must exist on Postgres or strict
    # startup keeps returning 503 (and the prior healthy deploy stays live).
    # `ADD COLUMN ... NOT NULL DEFAULT FALSE` backfills existing rows with a
    # constant default (no table rewrite on PG 11+); combinable defaults off so
    # existing floors behave exactly as before until an owner opts a table in.
    "ALTER TABLE bookable_resources ADD COLUMN IF NOT EXISTS combinable BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS combined_resource_ids JSONB",
    # updated_at — the host-stand live-alert bell polls GET /reservations/changes
    # which sorts/filters on this. The model has onupdate=utc_now so every booking
    # mutation (incl. a later allergy edit) bumps it. Idempotent ADD + a one-time
    # backfill so legacy rows created before the column get a sane value.
    "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP",
    "UPDATE reservations SET updated_at = created_at WHERE updated_at IS NULL",

    # ── Migration 057 (2026-07-04): reservation_waitlist (Venteliste) ────
    # The reservation waitlist — parties the venue couldn't seat, parked here
    # instead of a paper pad. A DEDICATED table (not a Reservation with
    # status='waitlisted'): a waitlist row holds no resource and writes no
    # reservation_occupancy row, so it is structurally incapable of holding a
    # table or leaking into the availability engine / book / Insights, and
    # Migration 055's no-double-booking constraint stays untouched. Mirrors
    # app/models/reservation_waitlist.py; documented in alembic 023.
    # GUID columns are VARCHAR(36) (GUID() impl is String(36); native-UUID DDL
    # breaks the users/reservations FKs on SQLite dev — see Migration 034).
    # Distinct from the pre-existing `waitlist_entries` (paid-tier interest).
    """CREATE TABLE IF NOT EXISTS reservation_waitlist (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        guest_name VARCHAR(160),
        guest_phone VARCHAR(40),
        guest_email VARCHAR(255),
        party_size INTEGER NOT NULL DEFAULT 2,
        waitlist_date DATE NOT NULL,
        desired_from TIMESTAMP,
        desired_to TIMESTAMP,
        status VARCHAR(20) NOT NULL DEFAULT 'waiting',
        source VARCHAR(20) NOT NULL DEFAULT 'manual',
        note VARCHAR(500),
        notified_at TIMESTAMP,
        notify_count INTEGER NOT NULL DEFAULT 0,
        converted_reservation_id VARCHAR(36) REFERENCES reservations(id),
        cancelled_at TIMESTAMP,
        expired_at TIMESTAMP,
        purge_after TIMESTAMP,
        purged_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_rsvp_waitlist_user_day ON reservation_waitlist (user_id, waitlist_date, status)",
    "CREATE INDEX IF NOT EXISTS ix_rsvp_waitlist_purge ON reservation_waitlist (purge_after)",

    # ── Migration 058 (2026-07-07): notification_log.dedup_key ───────────
    # Idempotency key for event-driven owner pushes. The freed-table ping
    # (waitlist recovery) writes dedup_key = "freed:<freed_id>:<match_id>"
    # so a double-cancel of the same table never double-buzzes the owner.
    # NULL for the many rows that don't need de-dup. Mirrors
    # app/models/staff.py NotificationLog; documented in alembic 024.
    "ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS dedup_key VARCHAR(120)",
    "CREATE INDEX IF NOT EXISTS ix_notiflog_dedup ON notification_log (dedup_key)",

    # ── Migration 059 (2026-07-07): reservation_waitlist.converted_at ────
    # Honest period basis for the Genvundet recovered-covers card: the
    # timestamp a waitlist row was actually converted to a seated booking.
    # Bucketing the recovered count on created_at/updated_at would be a lie;
    # this column is the only truthful "when it was recovered". Mirrors
    # app/models/reservation_waitlist.py; documented in alembic 025.
    "ALTER TABLE reservation_waitlist ADD COLUMN IF NOT EXISTS converted_at TIMESTAMP",

    # ── Migration 023 (2026-05-31): persistent 2D floor-plan layout ──────
    # bookable_resources gains position + shape so the owner's drag-arranged
    # room map persists to the venue. Mirrors app/models/bookable_resource.py
    # and is documented in alembic 018 (documentation-only). REQUIRED by the
    # schema-drift self-test: the model now declares pos_x/pos_y/shape, so on
    # Postgres these three columns MUST exist or strict startup keeps the
    # readiness gate at 503 and the prior healthy deploy stays live.
    #
    # All three are additive + non-locking on PG 11+:
    #   • pos_x / pos_y — nullable DOUBLE PRECISION, no default. NULL = "not
    #     placed on the canvas yet" (legacy rows + new tables) — a first-class
    #     state the frontend renders as an auto-grid until dragged.
    #   • shape — DEFAULT 'round' is a constant, so the backfill is a
    #     metadata-only change (no table rewrite). Cosmetic ('round'|'square').
    "ALTER TABLE bookable_resources ADD COLUMN IF NOT EXISTS pos_x DOUBLE PRECISION",
    "ALTER TABLE bookable_resources ADD COLUMN IF NOT EXISTS pos_y DOUBLE PRECISION",
    "ALTER TABLE bookable_resources ADD COLUMN IF NOT EXISTS shape VARCHAR(12) DEFAULT 'round'",
    # Salon first-booking unlock: owner "self-chair" whose availability follows
    # the confirmed weekly opening hours (booking_hours) instead of a StaffMember's
    # published shifts — lets a solo salon take appointments with zero payroll surface.
    "ALTER TABLE bookable_resources ADD COLUMN IF NOT EXISTS follows_opening_hours BOOLEAN NOT NULL DEFAULT FALSE",

    # ── Migration (2026-06-13): users.hidden_pillars — pillar visibility ──
    # The RELEVANCE axis of the 3-axis IA model (panel-approved declutter,
    # June 2026). CSV OFF-list of pillar IDs from app/services/pillars.py:
    # PILLARS ('reservations','events','inventory','staff','insights').
    # Mirrors app/models/user.py:User.hidden_pillars — REQUIRED by the
    # schema-drift self-test: the model declares the column, so on
    # Postgres it MUST exist or strict startup keeps the readiness gate
    # at 503 (the exact 2026-05-26 invite_token_hash failure mode).
    #
    # Nullable TEXT, NO default → additive + non-locking on prod, and
    # NULL = nothing hidden — every existing account is grandfathered
    # ALL-visible on deploy day with zero backfill ("where did Events
    # go?" is structurally impossible). Deliberately NOT reusing
    # enabled_modules: that column is the tier-capped vertical-module
    # vocabulary; pillars are free + uncapped (founder decision).
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS hidden_pillars TEXT",
    # ── Migration 024 (2026-06-22): open_shifts — Åbne vagter ─────────────
    # Net-new table backing app/models/staff.py:OpenShift. The owner posts an
    # UNASSIGNED roster slot; a staffer claims it one-tap from the portal, which
    # atomically flips it to 'filled' and spawns a PUBLISHED schedules row for
    # the claimer. Kept its own table (NOT a nullable staff_id on schedules) so
    # the cost / payroll / overlap-guard surface stays untouched. Mirrors the
    # model + alembic 019 (documentation-only). REQUIRED by the schema-drift
    # self-test: the model declares this table, so on Postgres it MUST exist or
    # strict startup keeps the readiness gate at 503. create_all() also creates
    # it; this is the canonical + emergency-restore (create_all bypassed) path.
    # claimed_schedule_id is a soft link (no FK) — the spawned shift can be
    # edited/deleted on its own without cascading back here.
    """CREATE TABLE IF NOT EXISTS open_shifts (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        date DATE NOT NULL,
        start_time VARCHAR(5) NOT NULL,
        end_time VARCHAR(5) NOT NULL,
        break_minutes INTEGER NOT NULL DEFAULT 0,
        role_on_shift VARCHAR(50),
        notes TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'open',
        claimed_by_staff_id UUID REFERENCES staff_members(id),
        claimed_schedule_id UUID,
        claimed_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_open_shifts_user_date ON open_shifts (user_id, date)",
    "CREATE INDEX IF NOT EXISTS ix_open_shifts_user_status ON open_shifts (user_id, status)",

    # ── Migration 025 (2026-06-23): Behandlinger — salon service catalog ──
    # S2 of the salon-appointments feature. `behandlinger` = a per-salon list
    # of services (treatments), each with a duration + an OPTIONAL DISPLAY-ONLY
    # price. Owner CRUD via the reservations router (gated behind the
    # "reservations" feature + a `salon_services_max` cap). Mirrors
    # app/models/behandling.py + alembic 020 (documentation-only).
    # VARCHAR(36) on id/user_id to match the GUID() TypeDecorator (native UUID
    # breaks FK joins inside the SAVEPOINT wrapper — see Migration 018/022
    # comments). create_all() builds this from the model on a fresh DB; this
    # block is the canonical + emergency-restore (create_all bypassed) path and
    # satisfies the schema-drift self-test. price_kr is nullable + DISPLAY-ONLY
    # (never charges money / feeds MOMS); duration_min is informational in S2.
    """CREATE TABLE IF NOT EXISTS behandlinger (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        name VARCHAR(120) NOT NULL,
        duration_min INTEGER NOT NULL DEFAULT 30,
        price_kr INTEGER,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_behandlinger_user_id ON behandlinger (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_behandlinger_user_active ON behandlinger (user_id, active)",

    # ── Migration 026 (2026-06-26): webhook_events — Stripe replay guard ──
    # Idempotency ledger for inbound Stripe webhooks. Stripe delivers events
    # at-least-once (it retries after a slow/failed 2xx), so the handler
    # INSERTs (event_id, event_type) BEFORE dispatch; event_id is the PK, so a
    # replayed event hits ON CONFLICT DO NOTHING (Postgres) / INSERT OR IGNORE
    # (SQLite) and the per-event handler is SKIPPED — no double mutation of
    # plan/status, no double audit row. Mirrors app/models/webhook_event.py +
    # alembic 021 (documentation-only). create_all() builds it on SQLite; this
    # block is the canonical Postgres path + emergency-restore. Append-only —
    # no UPDATE/DELETE surface. REQUIRED by the schema-drift self-test: the
    # model declares this table, so on Postgres it MUST exist.
    """CREATE TABLE IF NOT EXISTS webhook_events (
        event_id VARCHAR(255) PRIMARY KEY,
        event_type VARCHAR(120),
        processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_webhook_events_processed ON webhook_events (processed_at)",

    # ── Migration 027 (2026-06-27): Gavekort — gift cards + ledger ────────
    # The gavekort slice: owner ISSUES a gift card, it's TRACKED, staff REDEEM
    # it. Two tables:
    #   • gift_cards               — the card. balance_minor is a CACHE the
    #     ledger reconciles to on every write. Money is INTEGER ØRE (no floats).
    #     code_hash (HMAC of the secret code, UNIQUE) + short_code (UNIQUE,
    #     GK-XXXX-XXXX-C w/ mod-37 check) + code_last4 are stored; the plaintext
    #     code NEVER is. No soft-delete — a card is VOIDED, not deleted.
    #   • gift_card_transactions   — append-only LEDGER, source of truth. One
    #     row per issue/redeem/void. UNIQUE(gift_card_id, idempotency_key) makes
    #     a replayed redeem return the original result, never a 2nd debit (NULL
    #     keys on issue/void rows are exempt — SQL UNIQUE treats NULLs distinct).
    #     amount_minor is SIGNED (redeem = negative). Captures the LINK fields
    #     (created_by_user_id, sale_ref, daily_close_id, business_day,
    #     idempotency_key) = the transaktionsspor. NOT wired into MOMS in this
    #     slice (recorded so it can be later).
    # VARCHAR(36) on UUID cols to match the GUID() TypeDecorator (native UUID
    # breaks FK joins inside the SAVEPOINT wrapper — see Migration 018/022/025).
    # create_all() builds these from the models on a fresh DB; this block is the
    # canonical Postgres path + emergency-restore (create_all bypassed) and
    # satisfies the schema-drift self-test. Mirrors app/models/gift_card.py +
    # alembic 022 (documentation-only). Redeem's single-spend guarantee is the
    # CONDITIONAL ATOMIC decrement in the router, NOT a DB CHECK here.
    """CREATE TABLE IF NOT EXISTS gift_cards (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        code_hash VARCHAR(64) NOT NULL,
        short_code VARCHAR(20) NOT NULL,
        code_last4 VARCHAR(4) NOT NULL,
        face_value_minor INTEGER NOT NULL,
        balance_minor INTEGER NOT NULL,
        voucher_class VARCHAR(8) NOT NULL DEFAULT 'mpv',
        status VARCHAR(12) NOT NULL DEFAULT 'active',
        recipient_name VARCHAR(120),
        note VARCHAR(280),
        payment_method VARCHAR(16),
        issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_gift_cards_code_hash UNIQUE (code_hash),
        CONSTRAINT uq_gift_cards_short_code UNIQUE (short_code)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_gift_cards_user_id ON gift_cards (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_gift_cards_user_status ON gift_cards (user_id, status)",
    # Gavekort SELL slice: capture how the card was paid for at the counter
    # (card | mobilepay | cash | mixed). Recorded for the close/MOMS bridge +
    # tracking; not posted to revenue yet. Idempotent for existing prod DBs.
    "ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS payment_method VARCHAR(16)",
    """CREATE TABLE IF NOT EXISTS gift_card_transactions (
        id VARCHAR(36) PRIMARY KEY,
        gift_card_id VARCHAR(36) NOT NULL REFERENCES gift_cards(id),
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        kind VARCHAR(12) NOT NULL,
        amount_minor INTEGER NOT NULL,
        balance_after_minor INTEGER NOT NULL,
        created_by_user_id VARCHAR(36) REFERENCES users(id),
        sale_ref VARCHAR(120),
        daily_close_id VARCHAR(36),
        business_day TIMESTAMP,
        idempotency_key VARCHAR(120),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_gift_card_tx_idem UNIQUE (gift_card_id, idempotency_key)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_gift_card_tx_gift_card_id ON gift_card_transactions (gift_card_id)",
    "CREATE INDEX IF NOT EXISTS ix_gift_card_tx_user ON gift_card_transactions (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_gift_card_tx_card_created ON gift_card_transactions (gift_card_id, created_at)",
    # ── Migration 029 (2026-06-28): Gavekort ONLINE ORDERS ────────────────
    # "Order online, owner collects" — the red-line-safe online buying flow.
    # A customer requests a gavekort on a public /g/buy/<slug> page; the owner
    # confirms payment out-of-band and issues the real card. gift_card_orders
    # is a REQUEST log, NOT a payment record — no money flows through BonBox.
    #   • gavekort_slug              — the business's public buy-page handle.
    #   • gavekort_orders_enabled    — owner opt-in (off by default).
    #   • gavekort_order_settings_json — min/max amount + payment instructions.
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS gavekort_slug VARCHAR(80)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_business_gavekort_slug ON business_profiles (gavekort_slug)",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS gavekort_orders_enabled BOOLEAN DEFAULT FALSE",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS gavekort_order_settings_json TEXT",
    """CREATE TABLE IF NOT EXISTS gift_card_orders (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL REFERENCES users(id),
        amount_minor INTEGER NOT NULL,
        voucher_class VARCHAR(8) NOT NULL DEFAULT 'mpv',
        buyer_name VARCHAR(120),
        buyer_email VARCHAR(255) NOT NULL,
        recipient_name VARCHAR(120),
        message VARCHAR(280),
        status VARCHAR(12) NOT NULL DEFAULT 'pending',
        gift_card_id VARCHAR(36) REFERENCES gift_cards(id),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_gift_card_orders_user_id ON gift_card_orders (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_gift_card_orders_user_status ON gift_card_orders (user_id, status)",
    # ── Migration 030 (2026-06-30): Owner↔staff 1:1 chat + staff profile self-edit ──
    # Staff self-edit columns (display_name overrides `name` only in chat/portal,
    # never payroll; profile_photo_key is a storage compose_key, served via proxy).
    "ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS display_name VARCHAR(80)",
    "ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS profile_photo_key VARCHAR(200)",
    "ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS profile_photo_at TIMESTAMP",
    # Migration 060 — staff self-edit home address (portal). PII on the
    # tenant-scoped staff_members row; erased by the metadata-driven GDPR sweep.
    "ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS address VARCHAR(200)",
    "ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS postal_code VARCHAR(20)",
    "ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS city VARCHAR(120)",
    "ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS address_updated_at TIMESTAMP",
    """CREATE TABLE IF NOT EXISTS staff_chat_threads (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        staff_id UUID NOT NULL REFERENCES staff_members(id),
        last_message_at TIMESTAMP,
        owner_last_read_at TIMESTAMP,
        staff_last_read_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_staff_chat_thread UNIQUE (user_id, staff_id)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_staff_chat_thread_user_last ON staff_chat_threads (user_id, last_message_at)",
    """CREATE TABLE IF NOT EXISTS staff_chat_messages (
        id UUID PRIMARY KEY,
        thread_id UUID NOT NULL REFERENCES staff_chat_threads(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id),
        sender_type VARCHAR(8) NOT NULL,
        body TEXT,
        photo_count INTEGER NOT NULL DEFAULT 0 CHECK (photo_count BETWEEN 0 AND 3),
        client_msg_id VARCHAR(64),
        is_deleted BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_staff_chat_msg_thread_created ON staff_chat_messages (thread_id, created_at)",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_chat_msg_client ON staff_chat_messages (thread_id, client_msg_id) WHERE client_msg_id IS NOT NULL",
    """CREATE TABLE IF NOT EXISTS staff_chat_photos (
        id UUID PRIMARY KEY,
        message_id UUID NOT NULL REFERENCES staff_chat_messages(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id),
        storage_key VARCHAR(200) NOT NULL,
        content_type VARCHAR(40) NOT NULL,
        size_bytes INTEGER NOT NULL,
        ord INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_staff_chat_photo_msg ON staff_chat_photos (message_id)",
    # photo_count DB-layer cap. Kept as an idempotent ALTER (not just inline in
    # the CREATE TABLE above) because SQLAlchemy create_all may have created the
    # table first — without the inline CHECK — so the CREATE TABLE IF NOT EXISTS
    # is a no-op and the constraint would otherwise never land. Postgres has no
    # ADD CONSTRAINT IF NOT EXISTS, so guard with a DO block.
    """DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'staff_chat_messages_photo_count_check'
          AND conrelid = 'staff_chat_messages'::regclass
      ) THEN
        ALTER TABLE staff_chat_messages
          ADD CONSTRAINT staff_chat_messages_photo_count_check
          CHECK (photo_count BETWEEN 0 AND 3);
      END IF;
    END $$;""",
    # ── Migration 031 (2026-06-30): short join code for staff invite/connect ──
    "ALTER TABLE staff_links ADD COLUMN IF NOT EXISTS join_code VARCHAR(12)",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_links_join_code ON staff_links (join_code) WHERE join_code IS NOT NULL",
    # ── Migration 032 (2026-07-01): staff_availability (standing "kan ikke") ──
    # Net-new table backing app/models/staff.py:StaffAvailability. Proactive,
    # staff-side unavailability the owner sees while building the roster and the
    # autopilot respects — distinct from staff_absences (an EVENT). Idempotent.
    """CREATE TABLE IF NOT EXISTS staff_availability (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        staff_id UUID NOT NULL REFERENCES staff_members(id),
        kind VARCHAR(20) NOT NULL DEFAULT 'unavailable',
        weekday INTEGER,
        specific_date DATE,
        start_time VARCHAR(5),
        end_time VARCHAR(5),
        note VARCHAR(200),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE INDEX IF NOT EXISTS ix_staff_availability_user ON staff_availability (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_staff_availability_staff ON staff_availability (staff_id)",
    # ── Migration 033 (2026-07-02): staff_links PIN lockout (multi-layer link protection) ──
    "ALTER TABLE staff_links ADD COLUMN IF NOT EXISTS pin_failed_count INTEGER DEFAULT 0",
    "ALTER TABLE staff_links ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMP",
    # ── Migration 034 (2026-07-03): staff_device_tokens (native APNs push, Scheduler app) ──
    # Net-new table backing app/models/staff_device_token.py. Web push is dead
    # in the native shell's WKWebView, so the App Store staff app registers an
    # APNs token bound to its magic link. Idempotent.
    """CREATE TABLE IF NOT EXISTS staff_device_tokens (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        staff_id UUID NOT NULL,
        link_id UUID NOT NULL REFERENCES staff_links(id),
        platform VARCHAR(16) NOT NULL DEFAULT 'ios',
        token VARCHAR(200) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_staff_device_token UNIQUE (token)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_staff_device_tokens_user_staff ON staff_device_tokens (user_id, staff_id)",
    # ── Migration 035 (2026-07-04): AI allergy suggestion + note intent ──────
    # Rule-based (see services/allergy_detector.py + note_intent.py) UNCONFIRMED
    # signals read out of a booking's free-text notes. Kept SEPARATE from the
    # confirmed allergen_tags/allergy_severity so they can never overwrite a
    # guest's own entry — the owner confirms/dismisses. Same Art. 9 class →
    # purged by the same reservation PII sweep. All nullable / idempotent.
    "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS allergy_ai_tags JSONB",
    "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS allergy_ai_severity VARCHAR(20)",
    "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS allergy_ai_generic BOOLEAN DEFAULT false",
    "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS allergy_ai_confirmed BOOLEAN DEFAULT false",
    "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS allergy_ai_matched JSONB",
    "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS note_intent VARCHAR(40)",
    "CREATE INDEX IF NOT EXISTS ix_reservations_note_intent ON reservations (user_id, note_intent)",
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


# ─── Schema-drift self-test ────────────────────────────────────────
#
# WHY THIS EXISTS
# ---------------
# Tonight (2026-05-26) production went DOWN for ~10 min when commit
# 7c0e4c2 added 3 SQLAlchemy columns to the `users` model but only
# wrote the DDL into `backend/alembic/versions/017_*.py`.  Render's
# start command is `uvicorn app.main:app …`, which runs `_init_db()`
# / `_run_migrations()` — it does NOT call `alembic upgrade head`.
# Result: model said `users.invite_token_hash` existed, DB said it
# didn't, every authenticated request 500'd with
# `column users.invite_token_hash does not exist`.  Fix landed as
# d3dc5ae (adds the missing ALTERs to the in-process ALTER list).
#
# This self-test makes the same regression PHYSICALLY UNABLE to take
# the site down again:
#
#   • Postgres (prod): if ANY model column is missing in the live DB
#     after `_run_migrations()` completes, the function raises
#     SchemaDriftError.  The caller in `_init_db` catches that BEFORE
#     `_db_ready.set()` fires.  The db_readiness_gate middleware then
#     keeps returning 503 + Retry-After=3 for every API request, so
#     Render's health probe stays red, the deploy is marked unhealthy,
#     and the previous (healthy) deploy stays live.  Hard-fail closed.
#
#   • SQLite (dev): log a clear warning and continue.  Contributors
#     who're mid-fixture shouldn't get stuck — they just see the
#     SCHEMA_DRIFT line in the console.
#
# DESIGN NOTES
# ------------
# • We compare on column-NAME presence only — never on type equality.
#   TypeDecorators (GUID(36) → String(36), JSONEncoded → TEXT, etc.)
#   make type-comparison hostile and high-noise.  The one bug we're
#   guarding against is "model declares a column the DB doesn't have"
#   — that's the only signal we read.
#
# • We only check tables that BOTH (a) exist in `Base.metadata.tables`
#   AND (b) exist in the live DB.  Tables in the model but not in the
#   DB will get created by `Base.metadata.create_all`, which runs
#   BEFORE `_run_migrations` — so any missing TABLE is a bigger bug
#   that surfaces earlier.  This check is column-level only.
#
# • Skip alembic_version / system tables — alembic isn't load-bearing
#   here but the table can exist in old branches.
#
# • Read `information_schema.columns` (Postgres) or `pragma_table_info`
#   (SQLite) directly rather than `inspect(engine).get_columns()` —
#   the inspector caches aggressively across the connection and we
#   want the LIVE post-migration state.
#
class SchemaDriftError(RuntimeError):
    """Raised when SQLAlchemy models declare columns the live DB
    doesn't have.  In prod this blocks `_db_ready.set()` so the
    readiness gate keeps returning 503 and Render rolls back."""


_SCHEMA_DRIFT_SKIP_TABLES = frozenset({
    "alembic_version",
    "spatial_ref_sys",          # PostGIS system table (if extension installed)
    "geography_columns",
    "geometry_columns",
    "raster_columns",
    "raster_overviews",
})


def _live_columns_for_table(conn, table_name: str, is_sqlite: bool) -> set[str]:
    """Return the set of column names that actually exist in the DB for
    `table_name`. Empty set if the table doesn't exist (caller treats
    "table missing" as "create_all will handle it / not our concern")."""
    from sqlalchemy import text as _text
    try:
        if is_sqlite:
            rows = conn.execute(
                _text("SELECT name FROM pragma_table_info(:t)"),
                {"t": table_name},
            ).fetchall()
        else:
            rows = conn.execute(
                _text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = current_schema() AND table_name = :t"
                ),
                {"t": table_name},
            ).fetchall()
    except Exception:
        return set()
    return {r[0] for r in rows}


def _verify_schema_no_drift(conn, *, strict: bool) -> None:
    """Compare every column declared in `Base.metadata.tables` against
    the live DB schema.  Logs CRITICAL `SCHEMA_DRIFT:` lines for each
    missing column.  Raises `SchemaDriftError` if any drift was found
    AND `strict=True` (production / Postgres path).

    Sits next to `_verify_audit_log_immutability` and follows the same
    contract: runs once at startup, idempotent, never mutates schema.
    """
    import logging as _lg
    log = _lg.getLogger("bonbox.security")
    is_sqlite = str(engine.url).startswith("sqlite")

    drifts: list[tuple[str, str]] = []   # (table, column) pairs
    skipped_tables = 0
    checked_tables = 0

    for table_name, table_obj in Base.metadata.tables.items():
        if table_name in _SCHEMA_DRIFT_SKIP_TABLES:
            skipped_tables += 1
            continue
        live_cols = _live_columns_for_table(conn, table_name, is_sqlite)
        if not live_cols:
            # Table doesn't exist in DB yet — create_all should have
            # handled it.  If it didn't, that's a separate failure
            # (Base.metadata.create_all would have logged earlier).
            # Don't double-report; just skip.
            skipped_tables += 1
            continue
        checked_tables += 1
        for col in table_obj.columns:
            if col.name not in live_cols:
                drifts.append((table_name, col.name))
                log.critical(
                    "SCHEMA_DRIFT: model declares %s.%s but DB has no such column. "
                    "Add the ALTER TABLE statement to backend/app/main.py:_run_migrations() "
                    "ALTER list. See d3dc5ae for the canonical pattern.",
                    table_name, col.name,
                )

    if drifts:
        log.critical(
            "SCHEMA_DRIFT summary: %d missing column(s) across %d table(s) "
            "(checked %d, skipped %d). strict=%s",
            len(drifts),
            len({t for t, _ in drifts}),
            checked_tables,
            skipped_tables,
            strict,
        )
        if strict:
            # Hard-fail: caller in _init_db catches this and does NOT
            # set _db_ready, so the readiness gate keeps returning 503
            # and Render's previous healthy deploy stays live.
            raise SchemaDriftError(
                f"{len(drifts)} model column(s) missing in DB: "
                + ", ".join(f"{t}.{c}" for t, c in drifts[:10])
                + (" …" if len(drifts) > 10 else "")
            )
        else:
            log.warning(
                "SCHEMA_DRIFT: log-and-continue mode (SQLite dev) — worker "
                "will start but the affected endpoints will 500 on first hit. "
                "Fix the ALTER list in main.py and restart."
            )
    else:
        print(
            f"Schema-drift self-test: OK ({checked_tables} tables checked, "
            f"{skipped_tables} skipped)"
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
            # Migration 054 — expiry chain Phase 1 (Manoj-confirmed)
            ok += _add("inventory_items", "received_date", "DATE")
            ok += _add("inventory_items", "expected_shelf_life_days", "INTEGER")
            # Migration 015 mirror — Cash-up event ticket sheet.
            # SQLite stores the tier array as TEXT (JSON); Postgres got
            # native JSONB via the main MIGRATIONS list above. is_tax_exempt
            # default 0 = standard 25% MOMS posture for any pre-existing
            # event rows. Both columns are pure additive — never relax an
            # existing constraint.
            ok += _add("events", "ticket_tiers", "TEXT")
            ok += _add("events", "is_tax_exempt", "BOOLEAN NOT NULL DEFAULT 0")
            # Daily Close — MOMS / VAT fields
            ok += _add("daily_closes", "moms_total", "NUMERIC(12,2)")
            ok += _add("daily_closes", "revenue_ex_moms", "NUMERIC(12,2)")
            ok += _add("daily_closes", "moms_mode", "VARCHAR(10)")
            # Daily Close — status & lock/unlock
            ok += _add("daily_closes", "status", "VARCHAR(20) DEFAULT 'confirmed'")
            ok += _add("daily_closes", "unlock_reason", "TEXT")
            ok += _add("daily_closes", "unlocked_by", "VARCHAR(255)")
            ok += _add("daily_closes", "unlocked_at", "TIMESTAMP")
            # Business profile — service-day rollover hour. Default 6 =
            # Danish restaurant convention (02:00 close still belongs to
            # yesterday's shift). Migration 012_dk_cutoff_default_6 owns
            # the canonical change + DKK backfill; this is the
            # safety-net for fresh schemas that bypass Alembic.
            ok += _add("business_profiles", "day_cutoff_hour", "INTEGER DEFAULT 6")
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
limiter = Limiter(key_func=client_ip, default_limits=["120/minute"])

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
                ip_address=(client_ip(request) if request else None),
                user_agent=(request.headers.get("user-agent") or "")[:500],
                error_type=type(exc).__name__[:100],
                message=str(exc)[:1000],
                # Cap at 16KB — Starlette wraps every request in ~7 BaseHTTPMiddleware
                # frames each adding 6+ lines of boilerplate via collapse_excgroups, so
                # the inner-most app frame (where the bug actually lives) sits >4KB deep.
                # 16KB gives us enough headroom to always see the offending code path.
                traceback=_tb.format_exc()[:16000],
            ))
            _db.commit()
        finally:
            _db.close()
    except Exception:  # noqa: BLE001 — observability MUST never raise
        pass
    # Audit spike detection: many exceptions from same IP looks like probing
    try:
        ip = client_ip(request) if request else ""
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


# --- Raised-HTTPException sanitizer (info-disclosure hardening) ----------
# Several routers do `except Exception as e: raise HTTPException(500,
# detail=f"...{str(e)}")`, which Starlette serializes verbatim — leaking raw
# SQLAlchemy/driver text (table/column/constraint names, SQL fragments) to
# the caller. The global Exception handler above does NOT catch a *raised*
# HTTPException, so we register a handler on the Starlette base. Sub-500
# statuses keep their detail untouched (the frontend relies on 400/401/402/
# 403/404 detail + codes); only >=500 in prod is replaced with a generic
# message while the real error is logged server-side.
from starlette.exceptions import HTTPException as _StarletteHTTPException  # noqa: E402


@app.exception_handler(_StarletteHTTPException)
async def _http_exception_sanitizer(request: Request, exc: _StarletteHTTPException):
    status_code = exc.status_code
    headers = getattr(exc, "headers", None)
    if status_code >= 500 and is_prod:
        _error_logger.error(
            "HTTPException %s on %s %s: %s",
            status_code, request.method, request.url.path, exc.detail,
        )
        return JSONResponse(
            status_code=status_code,
            content={
                "detail": "Something went wrong on our side. Please try again.",
                "_error": True,
                "_recoverable": True,
            },
            headers=headers,
        )
    return JSONResponse(
        status_code=status_code, content={"detail": exc.detail}, headers=headers
    )


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

    # ─── Schema-drift fail-loud guard (Layer 1 of the 4-layer safety
    # net added 2026-05-26 after the team-invite columns regression
    # took prod down).  Compares SQLAlchemy model columns against the
    # LIVE DB schema and either hard-fails (Postgres / prod) or
    # log-and-continues (SQLite / dev).  See the SchemaDriftError
    # docstring above for the contract.
    #
    # HARD-FAIL semantics on PG: if drift is detected we return EARLY
    # here WITHOUT calling `_db_ready.set()`.  The db_readiness_gate
    # middleware (defined below) will then return 503 for every API
    # request, Render's health probe stays red, and the previous
    # healthy deploy stays live until the operator fixes the ALTER
    # list and re-deploys.  No silent half-broken worker.
    is_pg = str(engine.url).startswith("postgresql")
    try:
        with engine.connect() as _drift_conn:
            _verify_schema_no_drift(_drift_conn, strict=is_pg)
    except SchemaDriftError as drift_exc:
        import logging as _lg
        _lg.getLogger("bonbox.security").critical(
            "REFUSING TO SERVE — schema drift detected on Postgres startup: %s. "
            "Worker will stay in 503 mode (db_readiness_gate). Fix the missing "
            "ALTER TABLE statements in backend/app/main.py:_run_migrations() "
            "ALTER list and re-deploy. See d3dc5ae for the canonical pattern, "
            "CLAUDE.md → 'Schema changes — DO NOT use Alembic' for the rule.",
            drift_exc,
        )
        # Intentionally do NOT call _db_ready.set() — leave the gate
        # closed so Render rolls back to the previous deploy.
        return
    except Exception as e:
        # Self-test itself blew up (e.g. transient DB error during
        # information_schema query).  Don't take prod down for a
        # diagnostic failure — log and continue.  The migration step
        # already ran; if it succeeded and the column-check failed
        # for unrelated reasons, the worker should still serve.
        print(f"Schema-drift self-test warning: {e}")

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
    # Terminal-provider catalog seed (added 2026-05-28, Commit 1 of
    # the POS terminal registry feature). Global metadata only — no
    # per-tenant impact. Idempotent UPSERT by `slug` reads from
    # `backend/app/data/terminal_providers.json`. Layer 8 graceful
    # degradation: failure is logged and does NOT crash startup, the
    # Daily Close / OCR paths keep working without the catalog.
    try:
        from app.services.terminal_providers_seeder import seed_terminal_providers
        from app.database import SessionLocal
        with SessionLocal() as seed_db:
            tp_result = seed_terminal_providers(seed_db)
        if tp_result.get("created") or tp_result.get("updated"):
            print(
                f"Terminal providers seeded: {tp_result['created']} new, "
                f"{tp_result['updated']} updated ({tp_result['total']} total)"
            )
    except Exception as e:
        # Non-fatal — catalog being stale doesn't break anything in
        # Commit 1 (no consumer reads it yet). Commit 2's detector
        # will handle empty/stale catalog with its own fallback.
        print(f"Terminal providers seed warning: {e}")
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
    if path in ("/", "/api/health", "/api/health/ready", "/api/health/db", "/api/keepalive", "/api/config/features", "/api/email/unsubscribe", "/docs", "/redoc", "/openapi.json") or request.method == "OPTIONS":
        return await call_next(request)
    # Return 503 instantly if DB isn't ready yet (non-blocking — won't freeze event loop)
    if not _db_ready.is_set():
        return JSONResponse(
            status_code=503,
            content={"detail": "Server is starting up, please retry in a moment"},
            headers={"Retry-After": "3"},
        )
    return await call_next(request)


# Infra paths that hit the origin DIRECTLY (Render's internal health probe) and
# therefore never carry the Cloudflare-set header — must bypass the origin guard.
_ORIGIN_GUARD_HEADER = "x-bonbox-origin"
_ORIGIN_GUARD_EXEMPT = frozenset(
    {"/", "/api/health", "/api/health/ready", "/api/health/db", "/api/keepalive"}
)


# --- Cloudflare origin lock: reject traffic that didn't come through Cloudflare ---
@app.middleware("http")
async def cloudflare_origin_guard(request: Request, call_next):
    """Close the residual where an attacker bypasses Cloudflare (hits the
    *.onrender.com origin directly) to defeat the CF-Connecting-IP rate limits
    (OCR/AI cost caps, admin scan-ban). Cloudflare is configured to add a secret
    header to every request it forwards; a direct origin hit won't have it.

    FAIL-SAFE: enforcement is OFF unless ORIGIN_SHARED_SECRET is set, so merely
    deploying this code changes nothing. Turn it on in THIS ORDER to avoid a
    self-inflicted outage:
      1. Add the Cloudflare Transform Rule that sets `X-Bonbox-Origin: <secret>`
         on all requests (harmless until step 2 — the app ignores it).
      2. THEN set ORIGIN_SHARED_SECRET (same value) in Render. Setting it FIRST
         would 403 all legit traffic, which lacks the header until step 1 lands.

    Exempt: Render's health probe hits the origin directly (/api/health*,
    /api/keepalive, /) and CORS preflight (OPTIONS). Every EXTERNAL caller
    (Stripe webhook, OAuth/bank callbacks, the public booking widget) must use
    the Cloudflare-fronted domain (api.bonbox.dk / bonbox.dk) so it carries the
    header — which they already do; point the Stripe webhook at api.bonbox.dk.
    """
    secret = (os.getenv("ORIGIN_SHARED_SECRET") or "").strip()
    if (
        secret
        and request.method != "OPTIONS"
        and request.url.path not in _ORIGIN_GUARD_EXEMPT
    ):
        import hmac
        presented = request.headers.get(_ORIGIN_GUARD_HEADER, "")
        if not (presented and hmac.compare_digest(presented, secret)):
            return JSONResponse(status_code=403, content={"detail": "Forbidden"})
    return await call_next(request)


# --- CORS (tightened, environment-aware) ---
# Production:    only canonical bonbox.dk + Capacitor iOS shell
# Non-production: also allow vercel.app preview alias + localhost for dev
# This stops attackers using a stale or malicious preview origin to send
# authenticated XHR with allow_credentials=True.
#
# IMPORTANT: the actual `app.add_middleware(CORSMiddleware, ...)` call lives
# at the BOTTOM of this middleware block (after every other middleware) so
# the CORS layer is the OUTERMOST wrap in the stack. In Starlette, the LAST
# middleware added becomes the OUTERMOST — meaning it sees every response
# leaving the app, including JSONResponses returned directly by inner
# middlewares (CSRF rejection, request-size limit, db-readiness 503, the
# accountant-write guard). Without that ordering, an inner middleware that
# `return JSONResponse(...)`s its own response skips the CORS layer
# entirely → the browser sees a 4xx/5xx response with NO Access-Control-
# Allow-Origin header and JS reads it as "Failed to fetch" instead of the
# real status/body. Don't move this call back up the file.
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
# NOTE: `app.add_middleware(CORSMiddleware, ...)` is intentionally NOT
# placed here. See the comment above + the actual call at the end of the
# middleware block (search for "CORS layer registration — keep last").


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
    ip = client_ip(request) if request else "unknown"
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
    if path in _CSRF_EXEMPT_PATHS or path.startswith("/api/portal"):
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
        # Legacy non-first-party path — log and let through. This branch is
        # UNREACHABLE by real prod traffic: the auth cookie is Domain=.bonbox.dk
        # (see _cookie_scope) so browsers never send it to a non-bonbox.dk host,
        # meaning only a cookie-authed request on a non-first-party host reaches
        # here — in practice just the test client (host "testserver"). The
        # latent "stale build points at onrender → CSRF skipped" gap is closed
        # at the source by pinning VITE_API_URL to api.bonbox.dk in
        # frontend/.env.production (Jun-2026 leak sweep), so first-party + the
        # SameSite=Lax cookie are the real enforcement. Keeping the pass-through
        # avoids 403-ing the test client for zero prod benefit.
        _logging.getLogger(__name__).info(
            "csrf_protect: header missing on non-first-party host %s %s %s — passing through",
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


# ── Team-member write guard (read-only first slice of the manager seat) ──
# Invited members (manager/cashier/viewer) now SEE the owner's business
# (get_current_user delegation), but writes stay default-DENIED until each
# money router is mapped to a role scope. This keeps the fix strictly
# read-only and safe. A tiny allowlist keeps session self-service working.
_MEMBER_WRITE_ROLES = frozenset({"manager", "cashier", "viewer"})
_MEMBER_WRITE_ALLOWED = frozenset({
    "/api/auth/logout",
})


def _is_path_allowlisted_for_member_write(path: str) -> bool:
    """True iff an invited team member may mutate this path in the
    read-only slice. Kept deliberately tiny — write-scopes per router
    are the documented follow-up."""
    return path in _MEMBER_WRITE_ALLOWED


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

    # Quick role lookup — DB-only, no relationship loading.
    #
    # Fail CLOSED on a RAISED query: a transient DB error here must NOT
    # let a mutating request slip past unguarded (an authenticated member
    # could otherwise wait for / induce DB pressure to bypass the
    # read-only guard). We distinguish two outcomes:
    #   • query returns no row  → legit absent user (anonymous-ish / owner
    #     row gone); pass through to the underlying auth dep, which makes
    #     its own decision. This is the SAME behaviour as before.
    #   • query RAISES           → we can't prove the caller isn't a
    #     restricted member, so refuse with 503 (retryable) instead of
    #     calling call_next.
    from app.database import SessionLocal as _Session
    from sqlalchemy import text as _text
    db = _Session()
    try:
        row = db.execute(
            _text("SELECT role FROM users WHERE id = :uid LIMIT 1"),
            {"uid": user_id},
        ).first()
    except Exception:  # noqa: BLE001
        _security_logger.warning(
            "accountant_write_guard role lookup failed — failing CLOSED (503)"
        )
        return JSONResponse(
            status_code=503,
            content={
                "detail": {
                    "code": "role_check_unavailable",
                    "message": "Could not verify your access right now. Please retry.",
                },
            },
        )
    finally:
        db.close()

    if not row:
        return await call_next(request)

    role = (row[0] or "").lower() if row[0] else ""
    path = request.url.path or ""

    if role == "accountant":
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

    # Invited team members — default-DENY writes (read-only first slice of
    # the manager seat). Per-router role scopes are the follow-up that
    # selectively re-opens writes; until then a member can SEE the
    # business but not change it.
    if role in _MEMBER_WRITE_ROLES:
        if _is_path_allowlisted_for_member_write(path):
            return await call_next(request)
        return JSONResponse(
            status_code=403,
            content={
                "detail": {
                    "code": "read_only",
                    "message": (
                        "Your role can view this business but can't make "
                        "changes yet. Ask the owner."
                    ),
                },
            },
        )

    return await call_next(request)


# --- Member read-scope guard (least-privilege / GDPR) -------------------
# The manager-seat slice resolves an invited member's session to the OWNER
# user so reads are tenant-scoped (auth.py::_resolve_member_view), and the
# write-guard above default-denies their writes. But READS were never
# role-scoped — so a low-privilege member (cashier intended {sales,cashbook};
# viewer intended {reports}) could GET owner-only financial surfaces:
# all-employee lønseddel PII, tax filings, bank feeds, cash position. This
# guard closes that. It is deliberately surgical:
#   • only GET/HEAD (writes already default-denied)
#   • only a small set of crown-jewel prefixes triggers a role lookup, so
#     the common path stays a single startswith() with no DB hit
#   • ROLE-SCOPED denial (GDPR least-privilege):
#       - cashier / viewer → the FULL owner-financials set below
#       - manager          → owner financials MINUS the wage/labor-cost estimate.
#         A manager runs shifts and legitimately manages labor cost; that surface
#         (/api/staff/payroll) is an hours×rate ESTIMATE, not payslips — BonBox
#         does not do payroll, so it carries no CPR/bank/payslip PII. But a shift
#         manager has no business in the OWNER's SKAT filings, bank feed, or
#         cashflow, so those stay denied. (Still NOT the full per-router scope
#         model — that's the documented follow-up, task #375.)
#   • the accountant grant keeps its own (read-only) access — separate guard
#   • fails CLOSED (503) if the role lookup raises, like the write-guard
_MEMBER_READ_DENY_PREFIXES = (
    "/api/staff/payroll",
    "/api/tax",
    "/api/bank-connect",
    "/api/bank-connections",
    "/api/bank-import",
    "/api/cashflow",
    # The whole Reports & MOMS router is owner financial/compliance reporting —
    # /reports/monthly, /vat-export(/pdf), /overview, /forecast all return the
    # owner's SKAT liability (moms_til_skat / vat_payable). Owner-only by
    # product decision (Manoj, 2026-07-06). A member's operational reads live
    # under other prefixes (/api/sales, /api/staff, /api/dashboard), so denying
    # the whole /api/reports prefix costs a member nothing they need.
    "/api/reports",
)
# Owner financials a MANAGER must not read — the full set MINUS the wage-cost
# estimate (/api/staff/payroll). Subset of _MEMBER_READ_DENY_PREFIXES, so the
# fast-path _is_sensitive_member_read_path() still catches every manager-denied
# path (it screens the union) before any DB lookup.
_MANAGER_READ_DENY_PREFIXES = (
    "/api/tax",
    "/api/bank-connect",
    "/api/bank-connections",
    "/api/bank-import",
    "/api/cashflow",
    "/api/reports",
)
_LOW_PRIV_MEMBER_ROLES = frozenset({"cashier", "viewer"})


def _is_sensitive_member_read_path(path: str) -> bool:
    """True iff this read path exposes owner-only financial/PII data that a
    low-privilege invited member (cashier/viewer) must not pull. Kept as a
    standalone helper so the gate is unit-testable (see test_member_seat)."""
    return any(path.startswith(p) for p in _MEMBER_READ_DENY_PREFIXES)


@app.middleware("http")
async def member_read_guard(request: Request, call_next):
    if request.method not in ("GET", "HEAD"):
        return await call_next(request)
    path = request.url.path or ""
    if not _is_sensitive_member_read_path(path):
        return await call_next(request)  # cheap common path — no DB lookup

    # Sensitive path — resolve the RAW role (same approach as the
    # accountant_write_guard; don't trigger owner-delegation here).
    bearer = request.headers.get("authorization", "")
    has_bearer = bearer.lower().startswith("bearer ")
    has_cookie = bool(request.cookies.get(_AUTH_COOKIE))
    if not has_bearer and not has_cookie:
        return await call_next(request)  # anon — let the auth dep decide
    token = bearer.split(" ", 1)[1].strip() if has_bearer else request.cookies.get(_AUTH_COOKIE)
    if not token:
        return await call_next(request)
    try:
        payload = _decode_jwt(token)
        user_id = payload.get("sub")
        if not user_id:
            return await call_next(request)
    except Exception:  # noqa: BLE001
        return await call_next(request)

    from app.database import SessionLocal as _Session
    from sqlalchemy import text as _text
    db = _Session()
    try:
        row = db.execute(
            _text("SELECT role FROM users WHERE id = :uid LIMIT 1"),
            {"uid": user_id},
        ).first()
    except Exception:  # noqa: BLE001
        _security_logger.warning(
            "member_read_guard role lookup failed — failing CLOSED (503)"
        )
        return JSONResponse(
            status_code=503,
            content={
                "detail": {
                    "code": "role_check_unavailable",
                    "message": "Could not verify your access right now. Please retry.",
                },
            },
        )
    finally:
        db.close()

    if not row:
        return await call_next(request)
    role = (row[0] or "").lower() if row[0] else ""

    # Role-scoped denial. cashier/viewer lose the full owner-financials set
    # (incl. the wage-cost estimate); a manager loses only the OWNER financials
    # (tax/bank/cashflow) and keeps the wage/labor-cost estimate they run shifts
    # against. Owner + accountant fall through (deny=False).
    if role in _LOW_PRIV_MEMBER_ROLES:
        deny = _is_sensitive_member_read_path(path)
    elif role == "manager":
        deny = any(path.startswith(p) for p in _MANAGER_READ_DENY_PREFIXES)
    else:
        deny = False

    if deny:
        _security_logger.info(
            "member_read_guard: role=%s blocked from %s", role, path
        )
        return JSONResponse(
            status_code=403,
            content={
                "detail": {
                    "code": "read_forbidden",
                    "message": (
                        "Your role can't view this. Ask the business owner "
                        "for access."
                    ),
                },
            },
        )
    return await call_next(request)


# --- Shared-device ("Delt enhed") reveal-PIN gate (task #379) ---
# Sibling to member_read_guard, but keyed on the SERVER-SIGNED `sd` token claim
# rather than role. When a device is in shared mode, hard-block the owner-
# financial read prefixes unless the request carries a live reveal proof
# (X-BonBox-Device-Pin) bound to this device's nonce. On a shared owner tablet
# the actor IS the owner (role=owner), so member_read_guard never fires — this
# is the ONLY server gate that protects it. Fails CLOSED (503) on lookup error.
# Reuses the owner-financial prefix set so it can't drift from the member gate.
_SHARED_DEVICE_DENY_PREFIXES = _MANAGER_READ_DENY_PREFIXES  # tax / bank* / cashflow / reports


@app.middleware("http")
async def shared_device_pin_gate(request: Request, call_next):
    if request.method not in ("GET", "HEAD"):
        return await call_next(request)
    path = request.url.path or ""
    if not any(path.startswith(p) for p in _SHARED_DEVICE_DENY_PREFIXES):
        return await call_next(request)  # cheap common path — no decode/DB
    bearer = request.headers.get("authorization", "")
    has_bearer = bearer.lower().startswith("bearer ")
    token = bearer.split(" ", 1)[1].strip() if has_bearer else request.cookies.get(_AUTH_COOKIE)
    if not token:
        return await call_next(request)  # anon — the auth dep will decide
    try:
        payload = _decode_jwt(token)
    except Exception:  # noqa: BLE001
        return await call_next(request)
    if not payload.get("sd"):
        return await call_next(request)  # normal (non-shared) session — untouched

    # Shared device — require a live reveal proof bound to this device nonce.
    from app.services.auth import device_pin_proof_valid, DEVICE_PIN_HEADER
    user_id = payload.get("sub")
    dn = payload.get("dn")
    proof = request.headers.get(DEVICE_PIN_HEADER)

    from app.database import SessionLocal as _Session
    from sqlalchemy import text as _text
    db = _Session()
    try:
        row = db.execute(
            _text("SELECT device_pin_hash FROM users WHERE id = :uid LIMIT 1"),
            {"uid": user_id},
        ).first()
    except Exception:  # noqa: BLE001
        _security_logger.warning(
            "shared_device_pin_gate lookup failed — failing CLOSED (503)"
        )
        return JSONResponse(
            status_code=503,
            content={"detail": {"code": "pin_check_unavailable",
                                "message": "Could not verify. Please retry."}},
        )
    finally:
        db.close()

    pin_hash = row[0] if row else None
    if device_pin_proof_valid(str(user_id), pin_hash, dn, proof):
        return await call_next(request)  # revealed for this window
    return JSONResponse(
        status_code=403,
        content={"detail": {"code": "device_pin_required",
                            "message": "Enter your PIN to view your finances on this shared device."}},
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


# --- Sliding-refresh middleware (30d session, midway re-mint) ---
#
# Stay-signed-in UX: after this middleware lands, an actively-used session
# never expires. Token is minted with a 30-day exp; once the request's
# token is past its midway point (older than 15 days), the middleware
# mints a fresh token and re-issues it via either:
#
#   • cookie path (web)        — Set-Cookie bonbox_session + bonbox_csrf
#                                 with fresh 30d max_age, same Domain/
#                                 SameSite/Secure as _set_auth_cookie.
#   • bearer path (native iOS) — Response header `X-New-Token`; the
#                                 Capacitor axios interceptor in
#                                 frontend/src/services/api.js writes
#                                 the new token to localStorage so the
#                                 next request uses it. Exposed via
#                                 CORS `expose_headers` below.
#
# Multi-barrier defense — mirrors the 10-layer doctrine for any
# auth-bearing surface:
#   L1 auth           — must have a Bearer header OR bonbox_session cookie
#   L2 bounds         — past midway = older than (exp - iat) / 2; never
#                        before
#   L3 rate-limit     — only one refresh per response (the request itself
#                        is the rate-limiter — a refresh per request is
#                        normal, but we cap audit_logs to 1 row/user/day
#                        below to avoid spamming the trail).
#   L4 fail-soft      — any unexpected error in the middleware is swallowed
#                        and the original response is returned untouched;
#                        a refresh hiccup must NEVER take a request down.
#   L5 tenant scope   — refresh only fires for the JWT's `sub`. Locked
#                        users never get a fresh token (we re-check
#                        users.is_locked before minting).
#   L6 fail-closed    — if decode fails or `sub` is missing, no refresh;
#                        the response already carries the route's 401.
#   L7 audit          — `auth.token_refreshed` row, deduped 1/user/24h.
#   L8 fallback       — exempt list (login, logout, magic-link, OAuth
#                        callback, health, /auth/refresh self) — these
#                        paths mint their own tokens; sliding refresh
#                        would race with them.
#   L9 graceful HTTP  — middleware never returns a non-200 of its own;
#                        only enriches the route's response with the
#                        refreshed cookie/header.
#   L10 honest claims — `X-New-Token` is the literal new JWT; nothing
#                        masked. The audit row records mode='cookie'|
#                        'bearer' so we know which path actually fired.
#
# Placement — declared BELOW every other @app.middleware("http") so it
# is the innermost custom middleware. CORS sits OUTSIDE this so the
# `X-New-Token` header is allowed through with the existing
# allow_credentials=True wrap. `expose_headers` is set on CORSMiddleware
# below so JS can actually read it.
from app.services.auth import _decode_token as _decode_jwt_refresh
from datetime import datetime as _dt_class, timezone as _tz_class
from typing import Optional as _Opt
import secrets as _secrets_refresh
import logging as _log_refresh

_REFRESH_UTC = _tz_class.utc

_refresh_log = _log_refresh.getLogger("bonbox.session_refresh")

# Paths that mint / clear their own session — sliding refresh would race
# with them or fire on anonymous flows. Mirrors _CSRF_EXEMPT_PATHS with
# the additions for /logout (no refresh on the way out the door) and the
# health surface.
_REFRESH_EXEMPT_PATHS = frozenset({
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/logout",
    "/api/auth/google",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    "/api/auth/magic-link/request",
    "/api/auth/magic-link/verify",
    "/api/auth/oauth/google",
    "/api/auth/oauth/apple",
    "/api/auth/apple",
    "/api/auth/refresh",
    "/api/billing/stripe/webhook",
    "/api/health",
    "/api/health/db",
    "/api/keepalive",
    "/api/config/features",
    "/api/email/unsubscribe",
})

# How many tokens we re-issue per response. A bearer-mode iOS request
# may carry a token in localStorage that we ALSO mirror into the
# bonbox_session cookie (no — only one path fires per request; see
# logic). We track per-user the last-audit timestamp so the
# auth.token_refreshed audit row doesn't fire on every single refresh
# (a hot owner could hammer 100 requests/min; that'd be 100 audit rows).
# Process-local cache — one row per user per 24h is more than enough
# forensic granularity, the actual refresh STILL fires every time.
_refresh_audit_dedup: dict[str, float] = {}
_REFRESH_AUDIT_TTL_SEC = 60 * 60 * 24  # 24h


def _refresh_audit_should_log(user_id: str) -> bool:
    """Return True if we haven't already audited a refresh for this user
    in the last 24h. Side-effect: stamps the dedup cache when True."""
    import time as _t
    now = _t.time()
    last = _refresh_audit_dedup.get(user_id, 0)
    if now - last < _REFRESH_AUDIT_TTL_SEC:
        return False
    _refresh_audit_dedup[user_id] = now
    # Best-effort cap on cache growth (5k users max retained)
    if len(_refresh_audit_dedup) > 5000:
        # Drop oldest half — cheapest possible eviction
        cutoff = now - _REFRESH_AUDIT_TTL_SEC
        for k in [k for k, t in _refresh_audit_dedup.items() if t < cutoff]:
            _refresh_audit_dedup.pop(k, None)
    return True


def _read_token_from_request(request: Request) -> tuple[_Opt[str], str]:
    """Return (raw_token, mode) where mode is 'bearer' | 'cookie' | ''.
    Bearer wins if both are present (matches get_current_user)."""
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        tok = auth_header.split(" ", 1)[1].strip()
        if tok:
            return tok, "bearer"
    cookie_tok = request.cookies.get(AUTH_COOKIE_NAME)
    if cookie_tok:
        return cookie_tok, "cookie"
    return None, ""


@app.middleware("http")
async def sliding_refresh_middleware(request: Request, call_next):
    """Stay-signed-in via sliding refresh. See header comment for the
    multi-barrier doctrine. Designed to be invisible on every request
    that doesn't need refreshing — early-exits on the cheap path."""
    # Default — pass through, then refresh on response if applicable.
    response: Response = await call_next(request)

    # Don't refresh failures — if the underlying request 401'd because
    # the token is genuinely bad/expired, leave the 401 intact so the
    # frontend redirects to /login. Same for 5xx — never paper over.
    if response.status_code >= 400:
        return response

    try:
        path = request.url.path or ""
        if path in _REFRESH_EXEMPT_PATHS:
            return response
        # Static asset / preflight — nothing to refresh.
        if request.method == "OPTIONS":
            return response

        raw_token, mode = _read_token_from_request(request)
        if not raw_token or not mode:
            return response  # anonymous request — no refresh

        # Decode. Support rotated-secret grace via _decode_token().
        try:
            payload = _decode_jwt_refresh(raw_token)
        except Exception:
            return response  # invalid token — auth dep would have 401'd

        user_id = payload.get("sub")
        iat = payload.get("iat")
        exp = payload.get("exp")
        if not user_id or not iat or not exp:
            return response  # legacy token without iat — let it expire naturally

        # Coerce iat/exp to ints (jose decodes them as ints already, defensive cast)
        try:
            iat_ts = int(iat)
            exp_ts = int(exp)
        except Exception:
            return response

        now_ts = int(_dt_class.now(_REFRESH_UTC).timestamp())
        midway = iat_ts + (exp_ts - iat_ts) // 2
        if now_ts < midway:
            return response  # still in first half — no refresh

        # Locked-account safety: never re-issue a token for a user who
        # has been locked out via /admin/users/{id}/lock. The original
        # get_current_user already 401s, but our middleware sees the
        # response AFTER the dep runs — and this branch only fires when
        # the route returned <400, so the user MUST have resolved.
        # Still, do a defensive re-check so a race between lock + refresh
        # doesn't extend a hostile session by 30d.
        from app.database import SessionLocal as _Session
        from sqlalchemy import text as _text
        is_locked = False
        with _Session() as _db:
            try:
                row = _db.execute(
                    _text("SELECT is_locked FROM users WHERE id = :uid LIMIT 1"),
                    {"uid": user_id},
                ).first()
                if row and row[0]:
                    is_locked = True
            except Exception:  # noqa: BLE001
                # DB hiccup — fail-soft. We won't refresh this round, but
                # the existing token is still valid for ~15d so the user
                # is fine.
                return response
        if is_locked:
            return response

        # Mint a fresh JWT under the CURRENT secret only. APP_SECRET_KEY
        # rotation: existing in-flight sessions migrate forward on first
        # refresh because the new token is signed with SECRET_KEY, while
        # _decode_token() still accepts SECRET_KEY_PREVIOUS for grace.
        from app.services.auth import create_access_token as _mint
        # Carry the session's revocation epoch forward on refresh — so a
        # refreshed session stays revocable (and a no-`tv` legacy token keeps
        # grace-passing). We preserve the OLD token's `tv` rather than re-read
        # the DB: a refresh continues the same session, it doesn't re-auth.
        # Preserve the shared-device claim + nonce across the re-mint so "Delt
        # enhed" mode survives the midway refresh (task #379) — else the curtain
        # silently drops after ~15 days.
        new_token = _mint(
            str(user_id), payload.get("tv"),
            shared_device=bool(payload.get("sd")),
            device_nonce=payload.get("dn"),
        )

        # ── Wire the new token into the response ──────────────────────
        if mode == "cookie":
            # Web session — re-issue cookies with fresh 30d max_age. CSRF
            # cookie too, so it doesn't expire at 24h while the session
            # lives 30d (would cause 403s on later state-changing requests).
            from app.routers.auth import _cookie_scope as _scope
            is_secure = settings.ENVIRONMENT == "production"
            cookie_domain, same_site = _scope(request)
            max_age = settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60
            response.set_cookie(
                key=AUTH_COOKIE_NAME,
                value=new_token,
                max_age=max_age,
                httponly=True,
                secure=is_secure,
                samesite=same_site,
                path="/",
                domain=cookie_domain,
            )
            # Re-issue the CSRF cookie if the request actually carried
            # one (i.e. this is a real web session that needs the pair).
            # Use a fresh random value — CSRF tokens are not the JWT;
            # rotating them on session refresh is harmless and aligns
            # the two cookies' lifetimes.
            if request.cookies.get(CSRF_COOKIE_NAME):
                response.set_cookie(
                    key=CSRF_COOKIE_NAME,
                    value=_secrets_refresh.token_urlsafe(32),
                    max_age=max_age,
                    httponly=False,
                    secure=is_secure,
                    samesite=same_site,
                    path="/",
                    domain=cookie_domain,
                )
        else:
            # Bearer (native iOS) — expose the new token via a header.
            # Capacitor axios interceptor reads X-New-Token and writes
            # to localStorage. MUST be added to CORS `expose_headers`
            # below for the browser to surface it to JS.
            response.headers["X-New-Token"] = new_token

        # ── Audit log (deduped 1/user/24h) ────────────────────────────
        if _refresh_audit_should_log(str(user_id)):
            try:
                from app.services import audit_service as _audit
                from app.database import SessionLocal as _AuditSession
                with _AuditSession() as _adb:
                    _audit.record(
                        _adb,
                        user=user_id,
                        action="auth.token_refreshed",
                        entity_type="user",
                        entity_id=None,
                        before=None,
                        after={
                            "old_token_iat": iat_ts,
                            "new_token_iat": now_ts,
                            "mode": mode,
                        },
                        ip_address=(client_ip(request) if request else None),
                        actor_id=None,
                        actor_type="system.session_refresh",
                    )
                    _adb.commit()
            except Exception as e:  # noqa: BLE001
                # Audit failure NEVER blocks the refresh — same discipline as
                # audit_service.record itself.
                _refresh_log.warning("token_refreshed audit failed: %s", e)
    except Exception as e:  # noqa: BLE001
        # Fail-soft — a bug in the refresh path must not break the response.
        _refresh_log.warning("sliding_refresh swallowed: %s", e)

    return response


# --- Rate-limit middleware registration ---
# slowapi's Limiter only enforces the `default_limits=["120/minute"]`
# app-wide cap if SlowAPIMiddleware is actually in the stack. Without
# this line the default limit is INERT — only routes carrying an explicit
# @limiter.limit(...) decorator throttle, leaving every undecorated
# endpoint (incl. bank-connect /init + public /callback) unthrottled.
# Registered BEFORE the CORS block below so CORS still wraps it and the
# 429 RateLimitExceeded response carries Access-Control-Allow-Origin (same
# reasoning as the inner-middleware ordering note in the CORS comment).
app.add_middleware(SlowAPIMiddleware)

# --- CORS layer registration — keep last (outermost) ---
# Starlette's `app.add_middleware(...)` inserts at the FRONT of the
# user-middleware list, then the stack is built by iterating that list in
# REVERSE — so the LAST `add_middleware` call becomes the OUTERMOST wrap.
# Registering CORSMiddleware here (after every `@app.middleware("http")`
# decorator above) guarantees it sees every response on the way out,
# including 4xx/5xx responses that inner middlewares return directly
# (CSRF reject, request-size cap, db-readiness 503, accountant-write
# block). Without that wrap, the browser sees those responses without
# Access-Control-Allow-Origin and JS reads them as "Failed to fetch"
# instead of the real status — the bank-connect "Network Error in 157ms"
# regression that motivated this ordering was exactly that pattern.
# Origin list + allow_credentials + allow_headers were already defined
# above next to the `_PROD_ORIGINS` block — we just defer the actual
# registration to the bottom of the file.
#
# expose_headers — by default only "simple" headers (Cache-Control,
# Content-*, Expires, Last-Modified, Pragma) are surfaced to JS in a
# cross-origin response. The sliding-refresh middleware emits
# `X-New-Token` for bearer-mode (native iOS Capacitor) sessions; without
# it being on this list, axios sees an empty `res.headers["x-new-token"]`
# and the token never updates in localStorage → users get logged out
# again at 30d like before.
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    # NB: BOTH "Idempotency-Key" (Stripe-style, sent by the gavekort redeem POST
    # which the backend reads via Header(alias="Idempotency-Key")) AND the older
    # "X-Idempotency-Key" (reservations public booking) must be whitelisted, or
    # the browser preflight 400s and the real POST is silently blocked.
    allow_headers=["Content-Type", "Authorization", "X-BonBox-Platform", "Stripe-Signature", "X-CSRF-Token", "X-Idempotency-Key", "Idempotency-Key", "X-BonBox-Pin", "X-BonBox-Device-Pin"],
    expose_headers=["X-New-Token"],
    max_age=600,  # cache preflights for 10min — fewer OPTIONS roundtrips
)


# --- Regression guard: rate-limit middleware MUST be in the stack ---
# The default_limits cap is only enforced while SlowAPIMiddleware is
# registered (see the add_middleware call above). A future refactor that
# drops that line would silently disable app-wide throttling. Assert it
# here at import time so the failure is loud + immediate instead of an
# invisible security regression discovered only under abuse.
assert any(
    m.cls is SlowAPIMiddleware for m in app.user_middleware
), "SlowAPIMiddleware missing from the stack — app-wide rate-limit would be inert"


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
# Shared-device ("Delt enhed") reveal PIN — router carries its own
# /auth/device-pin prefix, so mount at /api → /api/auth/device-pin (task #379).
from app.routers import device_pin as _device_pin_router
app.include_router(_device_pin_router.router, prefix="/api")
app.include_router(sales.router, prefix="/api/sales", tags=["Sales"])
app.include_router(expenses.router, prefix="/api/expenses", tags=["Expenses"])
app.include_router(inventory.router, prefix="/api/inventory", tags=["Inventory"])
app.include_router(reports.router, prefix="/api/reports", tags=["Reports"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["Dashboard"])
app.include_router(staffing.router, prefix="/api/staffing", tags=["Staffing"])
app.include_router(waste.router, prefix="/api/waste", tags=["Waste"])
app.include_router(feedback.router, prefix="/api/feedback", tags=["Feedback"])
app.include_router(cashbook.router, prefix="/api/cashbook", tags=["Cash Book"])
# ── /api/events vs /api/event-log split (migration 013) ────────────────
# The cultural-events sprint took over the `/api/events` namespace for
# the new Event entity CRUD (Sudip-style customers tagging Sales/Expenses
# with a real-world event). The old analytics-telemetry endpoints moved
# to `/api/event-log` (router file: app/routers/event_log.py — the
# telemetry router was just renamed; the DB model EventLog was always
# its proper name).
#
# Legacy clients that still POST to /api/events / /api/events/batch are
# routed via two tiny back-compat shims registered below. They emit a
# 308 redirect to /api/event-log so the native-app builds (which can't
# update their telemetry URL until the next App Store push) keep
# working without losing the page-view stream. New clients should call
# /api/event-log directly.
app.include_router(events.router, prefix="/api/events", tags=["Events"])
# Sub-router for booking-id-scoped endpoints — `/api/bookings/{id}/...`.
# Lives on routers.events so it shares the helpers (audit, _client_ip)
# but mounted under its own prefix because the URLs are not nested
# under /api/events/{event_id}/.
app.include_router(events.bookings_router, prefix="/api/bookings", tags=["Events"])
# 2026-05-25 — Event-booking v3 (visitor-facing surface).
# `public_events_router` carries the SSR /e/{slug} HTML route + the
# /api/public/events/{slug} JSON. The router file mounts both URLs
# at their full paths so we mount it with NO prefix.
app.include_router(public_events_router.router, tags=["Public Events"])
# Visitor checkout + booking-poll + cancel endpoints, mounted under
# /api/public so cap-aware caller routing matches the other public
# surfaces (founder_rate router etc.).
app.include_router(
    public_bookings_router.router,
    prefix="/api/public",
    tags=["Public Bookings"],
)
# Internal cron — X-Cron-Secret header gates the sweep. Lives next to
# the public booking router but mounted under /api/internal so the
# path matches the spec.
app.include_router(
    public_bookings_router.internal_router,
    prefix="/api/internal",
    tags=["Internal Cron"],
)
# Reservations — owner CRUD/book + the public /r/<slug> booking surface.
app.include_router(reservations_router.router, prefix="/api/reservations", tags=["Reservations"])
# Owner-facing analytics on the booking book — GET /api/reservations/insights.
# Mounted under the SAME prefix as the owner reservation router (separate file
# to keep that router from growing further). Authed + tenant-scoped + fail-soft.
app.include_router(reservation_insights_router.router, prefix="/api/reservations", tags=["Reservations"])
# Gavekort (gift cards) — owner issues / tracks / redeems / voids. Authed +
# tenant-scoped (404 cross-tenant) + feature-gated + per-tier cap. Redeem is
# DB-enforced single-spend (conditional atomic decrement + UNIQUE idempotency).
app.include_router(gavekort_router.router, prefix="/api/gavekort", tags=["Gavekort"])
app.include_router(
    public_reservations_router.router,
    prefix="/api/public/reservations",
    tags=["Public Reservations"],
)
# The recipient's live gavekort page (no auth — the signed token is the
# credential). PII-minimal balance mirror; never redeems.
app.include_router(
    public_gavekort_router.router,
    prefix="/api/public/gavekort",
    tags=["Public Gavekort"],
)
# Door-scan + visitor's web-ticket page (signed URL). Same no-prefix
# pattern as public_events_router because the routes (`/api/tickets/*`
# + `/t/{ticket_id}`) live at distinct path roots.
app.include_router(tickets_router.router, tags=["Tickets"])
app.include_router(event_log_router.router, prefix="/api/event-log", tags=["Event Log"])
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
# Owner ↔ staff 1:1 chat ("Beskeder") — two routers, two auth gates.
app.include_router(staff_chat_router.owner_router, prefix="/api/staff", tags=["Staff Chat (Owner)"])
app.include_router(staff_chat_router.staff_router, prefix="/api/portal", tags=["Staff Chat (Portal)"])
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
# Pillar visibility — GET/PUT /api/pillars. The RELEVANCE axis of the
# 3-axis IA model (free + uncapped; see services/pillars.py). Owner-UI
# nav preference only — never read by public surfaces or crons.
app.include_router(pillars_router.router, prefix="/api/pillars", tags=["Pillars"])
app.include_router(diagnostics_router.router, prefix="/api/diagnostics", tags=["Diagnostics"])
# Activation-gated disclosure — GET /api/activation. The ACTIVATION axis of
# the 4-axis IA model (DERIVED from real usage rows, new-accounts-only,
# fail-open, feature-flagged). Owner-UI nav preference only; never stored,
# never written to hidden_pillars. See routers/activation.py + services/pillars.
app.include_router(activation_router.router, prefix="/api/activation", tags=["Activation"])
# Onboarding — POST /api/onboarding/detect-archetype. Auth-required, rate-
# limited (10/min/IP, same shape as register); keyword fast-path then at most
# one AI call (PREMIUM→DEFAULT fallback) to map a free-text business
# description to a canonical business_type + archetype.
app.include_router(onboarding_router.router, prefix="/api/onboarding", tags=["Onboarding"])
# Smart inventory import — paste/CSV/Excel/photo → AI parse + categorize
# → review draft → commit. Six-layer defense (auth, bounds, rate limit,
# tenant scope, daily quota, idempotency, audit) — see router docstring.
app.include_router(
    inventory_smart_import.router,
    prefix="/api/inventory/smart-import",
    tags=["Smart Inventory Import"],
)
# Smart Scan — single "snap anything" entry point that routes to the
# right destination page (expenses / daily-close / inventory) using the
# doc-type classifier. The basic auto-route is universal across tiers;
# batch upload (Starter+) and PDF-direct (Pro+) are gated server-side.
app.include_router(
    smart_scan_router.router,
    prefix="/api/smart-scan",
    tags=["Smart Scan"],
)
# Receipt-forwarding email inbox (v0.1). Webhook accepts Postmark Basic
# Auth; /me + /test are session-authenticated. Dark-launched: GET /me
# answers honestly with infra_enabled=false until INBOX_ENABLED flips.
app.include_router(
    inbox_router.router,
    prefix="/api/inbox",
    tags=["Inbox"],
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
# 2026-05-24 — Accountant Hours Saved. Read-only metric router behind
# auth + 30/min rate limit + 1-year max range. Tier-gated inside the
# service (accountant_hours_widget); Free gets a zero payload so the
# widget renders an upsell instead of "0 hours saved".
app.include_router(
    accountant_savings_router.router,
    prefix="/api/accountant-savings",
    tags=["Accountant Savings"],
)
# 2026-05-25 — Growth signals (Pro killer #3, Tier 4 Dashboard Phase F).
# Mounted under /api/dashboard so the new endpoint lands at
# /api/dashboard/growth-signals — sits alongside /batch, /summary,
# /daily-brief, etc. on the existing Dashboard surface. Pro-only via
# the new `growth_intelligence` PLAN_FEATURE; full 10-layer doctrine
# in the router module.
app.include_router(
    growth_signals_router.router,
    prefix="/api/dashboard",
    tags=["Dashboard"],
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
    from app.jobs.expiry_scanner_job import run_expiry_scan
    from app.jobs.frontend_monitor_job import run_frontend_monitor_tick
    from app.jobs.subscription_reconcile_job import run_subscription_reconcile
    from app.jobs.public_surface_monitor_job import run_public_surface_monitor_tick
    from app.jobs.reservation_jobs import (
        send_reservation_reminders, purge_expired_reservations,
    )

    _scheduler = BackgroundScheduler()
    _scheduler.add_job(
        run_auto_sync,
        trigger=IntervalTrigger(hours=6),
        id="payment_autosync",
        name="Auto-sync payment providers",
        replace_existing=True,
    )
    # Stripe subscription reconciliation — the downgrade backstop. Every 6h,
    # reconciles the plan COLUMN for any paid-plan owner whose subscription is
    # no longer alive (webhook missed / never fired). Entitlement is already
    # correct via the read-time guard; this keeps the raw column + founding
    # counter honest and audits the downgrade. Never touches a live sub or a
    # super_admin; defers on a transient Stripe outage. See
    # jobs/subscription_reconcile_job.py.
    _scheduler.add_job(
        run_subscription_reconcile,
        trigger=IntervalTrigger(hours=6),
        id="subscription_reconcile",
        name="Stripe subscription reconciliation (downgrade backstop)",
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
    # Reservations — day-before reminder (the v1 reminders-only no-show
    # defense). 08:00 UTC ≈ 09:00-10:00 Copenhagen; sends for confirmed
    # reservations in the next ~36h that haven't been reminded.
    _scheduler.add_job(
        send_reservation_reminders,
        trigger=CronTrigger(hour=8, minute=0),
        id="reservation_reminders",
        name="Reservation day-before reminders",
        replace_existing=True,
    )
    # Reservations — GDPR Art. 9 purge (null guest PII + allergy past
    # purge_after). 02:45 UTC, right after daily_maintenance.
    _scheduler.add_job(
        purge_expired_reservations,
        trigger=CronTrigger(hour=2, minute=45),
        id="reservation_gdpr_purge",
        name="Reservation GDPR purge (PII + allergy)",
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
    # Expiry chain Phase 1 — daily 06:15 UTC scan. Sits BETWEEN the
    # brief push (06:00 UTC) and email (06:30 UTC) so a Pro owner with
    # an expiring item gets the brief push first, the dedicated
    # expiry push 15 min later, then the email confirmation. Each
    # channel is independent — no single failure cascades.
    _scheduler.add_job(
        run_expiry_scan,
        trigger=CronTrigger(hour=6, minute=15),
        id="expiry_scan",
        name="Daily expiry scan + Pro push",
        replace_existing=True,
    )
    # Prod frontend synthetic monitor — probes the live bonbox.dk bundle every
    # 5 min and alerts the operator ONCE on a broken/stale Vercel deploy (the
    # stale-chunk outage that dead-ends users at the ErrorBoundary). Fail-soft,
    # read-only, flap-tolerant. See jobs/frontend_monitor_job.py.
    _scheduler.add_job(
        run_frontend_monitor_tick,
        trigger=IntervalTrigger(minutes=5),
        id="frontend_prod_monitor",
        name="Prod frontend synthetic monitor (Vercel deploy integrity)",
        replace_existing=True,
    )
    # Public-surface quality monitor — flags SILENT booking-page defects (a page
    # dead for 14 days, an app-default title) the crash monitor can't see. Every
    # 15 min (higher per-slug cost than the frontend monitor). Fail-soft,
    # flap-tolerant, alarms only on a genuinely-dead page. See
    # jobs/public_surface_monitor_job.py.
    _scheduler.add_job(
        run_public_surface_monitor_tick,
        trigger=IntervalTrigger(minutes=15),
        id="public_surface_monitor",
        name="Public booking-page quality monitor",
        replace_existing=True,
    )
    _scheduler.start()
    print("Schedulers started: payment auto-sync (6h), nightly maintenance (02:30), "
          "kasserapport drift (03:00), demo refresh (03:15), kasserapport patterns (Sun 03:30), "
          "recurring expenses (04:00), daily brief push (06:00), daily brief email (06:30), "
          "aiia sync (03:30), mobilepay sync (03:45), frontend monitor (5m)")

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


@app.api_route("/api/health/ready", methods=["GET", "HEAD"])
def health_ready():
    """Readiness probe — this is what render.yaml's healthCheckPath points at.

    Unlike /api/health (a static liveness 200) and /api/health/db (a bare
    SELECT 1 that still passes during column drift), this reflects the
    DB-readiness gate: 503 until `_db_ready` is set, and 503 FOREVER if the
    schema-drift guard refused to signal readiness (`_init_db` returns early
    without `_db_ready.set()` on drift).

    Why it matters: /api/health answers 200 the instant uvicorn binds — so a
    drift-broken worker looked healthy, Render completed the cutover, killed
    the last-good instance, and every real request 503'd with no rollback.
    Pointing the health check here makes a bad migration FAIL its probe, so
    Render aborts the cutover and the previous healthy deploy stays live —
    the behaviour the drift guard's own comments already promise.
    """
    if not _db_ready.is_set():
        return JSONResponse(
            status_code=503,
            content={"status": "starting", "db_ready": False},
            headers={"Retry-After": "3"},
        )
    return {"status": "ok", "db_ready": True}
