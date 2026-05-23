"""Frontend URL helpers — shared by Stripe billing + Bank connect redirects.

The Vercel preview alias (bonbox.vercel.app) is access-walled and lands the
user on a 401 page, breaking any redirect that lands there from an external
service (Stripe checkout return, Aiia / GoCardless / Salt Edge SCA callback,
etc.). This module normalizes FRONTEND_URL so all post-external redirects
go to the public domain regardless of how FRONTEND_URL is set.

Background: AMBER finding from audit #127 — `bank_connect.py` was doing
`settings.FRONTEND_URL.rstrip('/')` directly while `stripe_billing.py` had
a local `_safe_frontend_url()` helper. If FRONTEND_URL ever drifts to a
Vercel preview alias, only the Stripe path was protected. This util makes
the protection uniform.
"""
from __future__ import annotations

import logging

from app.config import settings

logger = logging.getLogger(__name__)

# Canonical production frontend URL. External services MUST redirect to a
# public domain; the bonbox.vercel.app alias is access-walled by Vercel
# and lands the user on a 401 page.
CANONICAL_PROD_FRONTEND = "https://bonbox.dk"


def safe_frontend_url() -> str:
    """Return the frontend base URL external redirects should target.

    Always rewrites vercel.app preview aliases to bonbox.dk. localhost is
    preserved for dev. Empty FRONTEND_URL falls back to bonbox.dk too.
    """
    url = (settings.FRONTEND_URL or "").rstrip("/")
    if not url:
        return CANONICAL_PROD_FRONTEND
    if "vercel.app" in url:
        logger.warning(
            "FRONTEND_URL=%s is a vercel.app alias; rewriting to %s for "
            "external redirects (preview aliases are access-walled and "
            "break checkout + bank SCA callbacks)",
            url, CANONICAL_PROD_FRONTEND,
        )
        return CANONICAL_PROD_FRONTEND
    return url
