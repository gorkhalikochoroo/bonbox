# Architecture

## System Overview
BonBox is a full-stack SaaS analytics platform for small businesses.

## Stack
| Layer | Technology | Host |
|-------|-----------|------|
| Frontend | React 18 + Tailwind CSS + Vite | Vercel |
| Backend | FastAPI + SQLAlchemy | Render |
| Database | PostgreSQL 15 | Supabase (EU) |
| Email | Resend API | — |
| OCR | OCR.space API | — |
| WhatsApp | Twilio API | — |

## Features
- Sales tracking with payment methods
- Expense management (business + personal mode)
- Inventory with templates and stock tracking
- Khata (credit ledger) for customer balances
- Cash Book for cash flow tracking
- Loan Tracker for borrowing/lending
- Smart Staffing predictions
- Waste logging
- Revenue forecasting and PDF reports
- Receipt OCR scanning
- WhatsApp bot integration
- Trilingual UI (English, Danish, Nepali)
- Dark mode, mobile-responsive

## Data Flow
1. User logs sale/expense via UI or WhatsApp bot
2. Frontend calls FastAPI endpoint with JWT auth
3. Backend validates with Pydantic, writes to Supabase PostgreSQL
4. Dashboard queries aggregate data in real-time
5. Reports generate PDF summaries on demand
