#!/usr/bin/env python3
"""
Promote a user to super_admin — the one-time bootstrap step.

The codebase intentionally has NO API endpoint to grant `super_admin` role,
because giving the API the power to elevate roles is a privilege-escalation
attack surface. So the only way in is this script, run by someone with shell
access to the database.

Usage (against production Render Postgres):
    cd backend
    DATABASE_URL=$RENDER_DATABASE_URL python scripts/promote_admin.py iside653@gmail.com

Usage (against local dev DB):
    python scripts/promote_admin.py owner@example.com

What it does:
    1. Looks up the user by email
    2. Checks their email is in SUPER_ADMIN_EMAILS env var (defense-in-depth — both
       the env-var allowlist AND the DB role must agree)
    3. Sets users.role = 'super_admin'

If SUPER_ADMIN_EMAILS is not set, the script still flips the DB role but PRINTS
A WARNING — the user won't have admin access until you set the env var too.

Re-running is idempotent and safe.
"""

from __future__ import annotations

import os
import sys


def main(email: str) -> int:
    email = email.strip().lower()
    if not email or "@" not in email:
        print(f"ERROR: '{email}' doesn't look like an email")
        return 1

    # Import here so missing deps fail with a clear message
    try:
        from app.config import settings
        from app.database import SessionLocal
        from app.models.user import User
    except ImportError as e:
        print(f"ERROR: cannot import backend modules ({e})")
        print("Run from the backend directory:  cd backend && python scripts/promote_admin.py <email>")
        return 1

    # Check env-var allowlist — warn if missing, don't block
    allowlist_raw = (settings.SUPER_ADMIN_EMAILS or "").strip()
    allowlist = [e.strip().lower() for e in allowlist_raw.split(",") if e.strip()]
    in_allowlist = email in allowlist

    if not allowlist:
        print(
            "⚠  WARNING: SUPER_ADMIN_EMAILS env var is empty. The DB role will\n"
            f"   be set, but the API will still reject {email} until you set:\n"
            f"     SUPER_ADMIN_EMAILS={email}\n"
            "   in Render env vars (or your local .env)."
        )
    elif not in_allowlist:
        print(
            f"⚠  WARNING: {email} is NOT in SUPER_ADMIN_EMAILS allowlist.\n"
            f"   Current allowlist: {', '.join(allowlist)}\n"
            "   The DB role will be set anyway, but you'll need to also add\n"
            "   this email to SUPER_ADMIN_EMAILS for the API to accept it."
        )

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == email).first()
        if not user:
            print(f"ERROR: no user found with email {email}")
            print("       Register the account first via /register, then re-run this.")
            return 1

        if user.role == "super_admin":
            print(f"✓ {email} is already super_admin (id={str(user.id)[:8]}…). No change.")
            return 0

        old_role = user.role
        user.role = "super_admin"
        db.commit()
        print(f"✓ {email} promoted: {old_role} → super_admin")
        print(f"  user_id: {user.id}")
        print()
        if in_allowlist:
            print("✓ Email is in SUPER_ADMIN_EMAILS allowlist — admin access ready.")
            print("  Visit /admin in the BonBox UI (or hit /api/admin/overview directly).")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
