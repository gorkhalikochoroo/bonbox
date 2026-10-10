"""Per-account failed-login lockout — spoof-proof brute-force backstop.

The per-IP rate limit on /auth/login keys on the client IP; even after we
switch that key to the unforgeable ``CF-Connecting-IP`` (see ``client_ip``),
IP-keyed throttling can be diluted by a botnet. This adds a defense keyed on
the ACCOUNT (email), which no IP trick can bypass: after N failed attempts in
a rolling window the account refuses login for a cooldown, regardless of source
IP. There is no other per-account lockout on owner login today.

Storage is in-process (a module-level dict), which is correct for this app's
deliberate SINGLE-worker deployment (same model as the in-memory SlowAPI
limiter and the in-process SSE bus). A restart resets the counters — acceptable:
it grants at most one more window per (infrequent) deploy, and the CF-IP rate
limit still caps the attacker's raw request rate. If the web tier is ever
scaled past one worker this must move to a shared store (Redis / a DB column) —
see the single-worker invariant in ops docs.

Enumeration-safe: callers raise the SAME generic 401 for a lockout as for a
bad password, so an attacker can't tell which emails exist or are locked.
"""
import threading
import time

from app.utils.bounded import bound_stamp_dict, bound_window_dict

# Tunables. 8 failures inside a 15-minute window locks the account for 15
# minutes. Real users almost never fail 8× in 15 min; attackers are bounded.
_WINDOW_SECONDS = 15 * 60
_MAX_FAILURES = 8
_LOCKOUT_SECONDS = 15 * 60
# E-mails tracked at once. Every failed login with a NEW e-mail (typos,
# credential-stuffing lists) used to add a key that stayed until the next
# deploy unless that same e-mail logged in or was checked after its lockout.
# Past these sizes the dicts first shed what decides nothing any more —
# failures all older than the window, locks that have run out — so what stays
# is the e-mails that failed in the last 15 minutes (~250 bytes each, ~5 MB at
# the limit). Only a flood of more live e-mails than that sheds the ones that
# failed longest ago; the per-IP 10/minute login limit still applies to it.
_MAX_TRACKED_EMAILS = 20_000
_MAX_LOCKED_EMAILS = 10_000

_lock = threading.Lock()
# email(lowercased) -> list[failure_timestamp]
_failures: dict[str, list[float]] = {}
# email(lowercased) -> locked_until_timestamp
_locked_until: dict[str, float] = {}


def _norm(email: str | None) -> str | None:
    return email.strip().lower() if email else None


def is_locked_out(email: str | None) -> bool:
    """True if this account is currently in cooldown after too many failures."""
    key = _norm(email)
    if not key:
        return False
    now = time.time()
    with _lock:
        until = _locked_until.get(key)
        if until and now < until:
            return True
        if until and now >= until:
            # Cooldown elapsed — clear so the account can try again.
            _locked_until.pop(key, None)
            _failures.pop(key, None)
        return False


def record_failure(email: str | None) -> None:
    """Record a failed login. Trips the lockout once the threshold is crossed."""
    key = _norm(email)
    if not key:
        return
    now = time.time()
    with _lock:
        recent = [t for t in _failures.get(key, []) if now - t < _WINDOW_SECONDS]
        recent.append(now)
        _failures[key] = recent
        if len(recent) >= _MAX_FAILURES:
            _locked_until[key] = now + _LOCKOUT_SECONDS
            bound_stamp_dict(_locked_until, stale_before=now, max_keys=_MAX_LOCKED_EMAILS)
        bound_window_dict(_failures, cutoff=now - _WINDOW_SECONDS, max_keys=_MAX_TRACKED_EMAILS)


def clear(email: str | None) -> None:
    """Reset all counters for an account — call on successful login."""
    key = _norm(email)
    if not key:
        return
    with _lock:
        _failures.pop(key, None)
        _locked_until.pop(key, None)
