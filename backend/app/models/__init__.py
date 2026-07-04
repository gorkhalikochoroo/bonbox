from app.models.user import User
from app.models.sale import Sale
from app.models.expense import ExpenseCategory, Expense
from app.models.inventory import InventoryItem, InventoryLog
from app.models.staffing import StaffingRule, DailyStaffing
from app.models.waste import WasteLog
from app.models.feedback import Feedback
from app.models.cashbook import CashTransaction
from app.models.event_log import EventLog
from app.models.khata import KhataCustomer, KhataTransaction
from app.models.budget import Budget
from app.models.loan import LoanPerson, LoanTransaction
from app.models.category_mapping import CategoryMapping
from app.models.whatsapp import WhatsAppUser, WhatsAppMessage
from app.models.weather import SickCall, DailyWeather
from app.models.business_profile import BusinessProfile
from app.models.payment_connection import PaymentConnection
from app.models.branch import Branch
from app.models.competitor import Competitor, CompetitorPrice
from app.models.daily_close import DailyClose
from app.models.workshop import Vehicle, JobCard, JobCardPart, JobCardLabor
from app.models.wine import Wine, WineSale
from app.models.staff import StaffMember, PayPeriodConfig, Schedule, HoursLogged, Tip, TipDistribution, StaffLink, NotificationLog
from app.models.security_event import SecurityEvent
from app.models.owner_pattern import OwnerPattern
from app.models.waitlist import WaitlistEntry
from app.models.daily_brief import DailyBrief
from app.models.anomaly_alert import AnomalyAlert
from app.models.triage_note import TriageNote
from app.models.kasserapport import KasserapportExtraction, KasserapportExample
from app.models.inventory_import import InventoryImport
from app.models.inventory_import_example import InventoryImportExample
from app.models.terminal import Terminal
from app.models.terminal_provider import TerminalProvider
from app.models.output_channel import OutputChannel
from app.models.order_channel_config import OrderChannelConfig
from app.models.absence import StaffAbsence
from app.models.shift_swap import ShiftSwapRequest
from app.models.staff_role_target import StaffRoleTarget
from app.models.smart_drift_finding import SmartDriftFinding
from app.models.support_ticket import SupportTicket
# Invoicing / debitor / mileage — Starter-tier features for occasional
# businesses (events, photographers, side-gigs) that want to replace the
# monthly revisor bill with their own data capture.
from app.models.customer import Customer
from app.models.invoice import Invoice, InvoiceLine
from app.models.mileage import MileageEntry
# Migration 034 — confidence-based payment matching + append-only audit log.
from app.models.payment_match_suggestion import PaymentMatchSuggestion
from app.models.audit_log import AuditLog
# Stripe webhook idempotency / replay-protection ledger (Migration 026).
# event_id PK → a replayed Stripe event is deduped before the handler runs.
from app.models.webhook_event import WebhookEvent
# Task #47 — Starter+ recurring expenses (auto-materialized monthly).
from app.models.recurring_expense import RecurringExpense
# Task #49 — Starter+ accountant read-only login (many-to-many grants).
from app.models.accountant_grant import AccountantGrant
# Task #61 — magic-link passwordless login (single-use, 15-min TTL tokens).
from app.models.magic_link_token import MagicLinkToken
# Task #67 — Aiia (Mastercard Open Banking) consent + refresh-token storage.
from app.models.bank_connection import BankConnection
# Task #71 — MobilePay Erhverv (Vipps MobilePay Business) merchant
# OAuth + payments-direct sync. Sibling of BankConnection — Aiia gives
# us the full bank feed, MobilePay gives per-settlement granularity.
from app.models.mobilepay_connection import MobilePayConnection
# Task #72 — Web Push (VAPID) endpoint registry. One row per
# (user, device endpoint); the morning push cron iterates this to
# fan out the 8am brief as a native push notification.
from app.models.push_subscription import PushSubscription
from app.models.staff_device_token import StaffDeviceToken
# Cultural events sprint (migration 013) — Sudip-style customers tag
# Sales/Expenses with a real-world event (movie night, pop-up stall).
# Distinct from EventLog above which is analytics telemetry; named
# Event (singular) so the FK on Sale.event_id reads naturally.
from app.models.event import Event
# Migration 016 — receipt-forwarding email inbox (v0.1). EmailMessage
# logs every Postmark hit; ReceiptIntake carries one row per accepted
# attachment with the Fernet-encrypted blob pointer + OCR lifecycle.
from app.models.email_message import EmailMessage
from app.models.receipt_intake import ReceiptIntake
# Event-booking product (v3 ledger-only, 2026-05-25). Booking is the
# durable record across pending → paid → attended; Ticket is one row
# per individual ticket; EventCustomer dedupes visitors per organizer
# for the post-event outreach / GDPR retention boundary.
from app.models.booking import Booking
from app.models.ticket import Ticket
from app.models.event_customer import EventCustomer
# Reservations (table booking + appointments) — generic bookable-resource
# engine. BookableResource = a table / provider / room; Reservation = a
# guest holding one for a time-range. See availability_engine.py.
from app.models.bookable_resource import BookableResource
from app.models.reservation import Reservation
# P0 integrity backbone (Migration 023) — overlap-protected physical-table
# rows. The gist EXCLUDE constraint (Postgres-only) makes double-booking a
# resource physically impossible. See reservation_occupancy.py + §2 of
# docs/reservations-architecture.md.
from app.models.reservation_occupancy import ReservationOccupancy
# Venteliste — parties the venue couldn't seat; a dedicated table so it can
# never hold a resource or leak into the availability engine. user_id FK puts
# it in the metadata-driven GDPR delete_account sweep automatically.
from app.models.reservation_waitlist import ReservationWaitlistEntry
# S2 — salon service (Behandlinger) catalog. A per-salon list of services
# with a duration + optional DISPLAY-ONLY price. Owner CRUD via the
# reservations router; gated behind the "reservations" feature flag. See
# app/models/behandling.py.
from app.models.behandling import Behandling
# Gavekort (gift cards) — owner issues a gift card, it's tracked, staff
# redeem it. GiftCard holds the balance cache; GiftCardTransaction is the
# append-only ledger (source of truth). Money in integer øre. See
# app/models/gift_card.py.
from app.models.gift_card import GiftCard, GiftCardTransaction

__all__ = ["User", "Sale", "ExpenseCategory", "Expense", "InventoryItem", "InventoryLog", "StaffingRule", "DailyStaffing", "WasteLog", "Feedback", "CashTransaction", "EventLog", "KhataCustomer", "KhataTransaction", "Budget", "LoanPerson", "LoanTransaction", "CategoryMapping", "WhatsAppUser", "WhatsAppMessage", "SickCall", "DailyWeather", "BusinessProfile", "PaymentConnection", "Branch", "Competitor", "CompetitorPrice", "DailyClose", "Vehicle", "JobCard", "JobCardPart", "JobCardLabor", "Wine", "WineSale", "StaffMember", "PayPeriodConfig", "Schedule", "HoursLogged", "Tip", "TipDistribution", "StaffLink", "NotificationLog", "SecurityEvent", "OwnerPattern", "WaitlistEntry", "DailyBrief", "AnomalyAlert", "TriageNote", "KasserapportExtraction", "KasserapportExample", "InventoryImport", "InventoryImportExample", "Terminal", "TerminalProvider", "OutputChannel", "OrderChannelConfig", "StaffAbsence", "ShiftSwapRequest", "StaffRoleTarget", "SmartDriftFinding", "SupportTicket", "Customer", "Invoice", "InvoiceLine", "MileageEntry", "PaymentMatchSuggestion", "AuditLog", "RecurringExpense", "AccountantGrant", "MagicLinkToken", "BankConnection", "MobilePayConnection", "PushSubscription", "Event", "EmailMessage", "ReceiptIntake", "Booking", "Ticket", "EventCustomer", "BookableResource", "Reservation", "ReservationOccupancy", "Behandling", "GiftCard", "GiftCardTransaction"]
