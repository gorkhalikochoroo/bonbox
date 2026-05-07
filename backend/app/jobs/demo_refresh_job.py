"""Demo account refresh job — keeps demo@bonbox.dk perpetually in
"trial state" so a sales walkthrough or investor demo never lands on a
broken-feeling Free-tier UI.

Why this exists (May 2026):
  The startup hook in main.py already calls seed_demo_account(), which
  has built-in trial-refresh logic: if trial_ends_at is < 7 days away,
  it bumps to now + 14 days. That works for active deploys (Render
  auto-deploys multiple times a week → restart triggers refresh).

  But a stable production deploy with no restarts could let the demo
  trial silently expire after 14 days. Without a periodic trigger, the
  next visitor sees the demo on Free → AI features capped → bad first
  impression.

  This job runs daily via APScheduler (in-process — no HTTP endpoint,
  zero attack surface). Calling it is idempotent: if the trial is far
  from expiring, nothing happens. If it's near expiry, it gets bumped.

Multi-layer defense:
  L1 (this file)        — wrapper opens its own DB session, isolates
                          failures, runs the seeder. Hardcoded email
                          allowlist defense (see _SAFE_DEMO_EMAILS).
  L2 (services/demo_seed) — seed_demo_account() filters every query
                          by User.email == _DEMO_EMAIL. Cannot touch
                          any other user even if mis-invoked.
  L3 (scheduler)        — wired with replace_existing=True so a hot
                          reload doesn't queue duplicate jobs.
  L4 (NO HTTP endpoint) — this function is intentionally NOT exposed
                          via any router. The only callers are the
                          APScheduler tick and the test suite. A future
                          author who wants an admin "Reset demo" button
                          must add their own auth + rate-limit; this
                          file stays internal.
"""
from __future__ import annotations

import logging
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.services.demo_seed import _DEMO_EMAIL, seed_demo_account

log = logging.getLogger(__name__)


# Belt-and-braces email allowlist: if a future refactor accidentally
# imports this module's public function with a different email, the
# guard below catches it BEFORE we hit the DB. Keeps the blast radius
# of a misconfigured cron job at zero.
_SAFE_DEMO_EMAILS = frozenset({"demo@bonbox.dk"})


def refresh_demo_account() -> dict:
    """Daily idempotent demo refresh.

    Calls seed_demo_account() against a fresh DB session. The seeder:
      • Refreshes trial_ends_at to now + 14 days IFF current trial
        expires within 7 days (otherwise leaves it alone — chip
        decreases naturally day by day).
      • Resets plan to "free" if a prior version bumped it to paid
        (so effective_plan() resolves to "trial" for full Pro feats).
      • Skips data seeding if the demo already has DailyClose rows
        (idempotent — won't duplicate).
      • No-ops silently if demo@bonbox.dk doesn't exist yet.

    Returns the seeder's result dict for logging. Never raises — any
    exception is caught + logged so a transient DB issue can't crash
    the scheduler thread.
    """
    # Belt-and-braces: assert the email constant hasn't been reassigned.
    # If a future refactor changes _DEMO_EMAIL to something else, this
    # halts before we operate. Cheap insurance — runs once per tick.
    if _DEMO_EMAIL not in _SAFE_DEMO_EMAILS:
        log.error(
            "[demo_refresh] _DEMO_EMAIL=%r is not in safe allowlist — refusing to run.",
            _DEMO_EMAIL,
        )
        return {"skipped": True, "reason": "email_allowlist_mismatch"}

    db: Session = SessionLocal()
    try:
        result = seed_demo_account(db)
        if result.get("skipped"):
            log.info("[demo_refresh] no-op: %s", result.get("reason"))
        else:
            log.info("[demo_refresh] re-seeded demo: %s", result)
        return result
    except Exception as e:  # noqa: BLE001
        # Critical: this scheduler thread MUST NOT propagate. A demo-
        # refresh failure is operational noise, not a service-down
        # event. Roll back any partial txn and let next tick retry.
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        log.exception("[demo_refresh] failed: %s", e)
        return {"skipped": True, "reason": f"error: {e}"}
    finally:
        db.close()
