"""Per-account failed-login lockout — spoof-proof brute-force backstop.

The per-IP rate limit on /auth/login keys on the client IP (now the unforgeable
``CF-Connecting-IP`` — see ``client_ip``), which is the PRIMARY defense. This
adds a second layer keyed on the ACCOUNT (email) that no IP trick can bypass:
after N failed attempts in a rolling window the account is refused for a short
cooldown, regardless of source IP.

DoS tradeoff (deliberate, bounded): a hard per-account lock is a known
account-lockout DoS vector — a third party who knows an owner's email can force
the lock. We accept it, bounded, because (1) the cooldown is SHORT (5 min) and
self-heals, and (2) the CF-IP rate limit is the primary brute-force gate, so
this layer stays gentle. A future hardening could exempt a known-device/valid-
session signal so a legitimate owner can never be fully locked out.

Storage is in-process (module-level dicts), correct for this app's deliberate
SINGLE-worker deployment (same model as the in-memory SlowAPI limiter + SSE
bus). It is SIZE-CAPPED and self-pruning so attacker-supplied emails can't grow
it without bound. A restart resets counters — acceptable. If the web tier is
ever scaled past one worker this must move to a shared store (Redis / DB).

Enumeration-safe: callers raise the SAME generic 401 for a lockout as for a bad
password, so an attacker can't tell which emails exist or are locked.
"""
import threading
import time

# Tunables. 8 failures inside a 15-min window locks the account for 5 min.
_WINDOW_SECONDS = 15 * 60
_MAX_FAILURES = 8
_LOCKOUT_SECONDS = 5 * 60
# Hard cap on distinct emails tracked — memory-leak guard against an attacker
# spraying millions of fake emails on the single worker.
_MAX_TRACKED = 4096

_lock = threading.Lock()
# email(lowercased) -> list[failure_timestamp]
_failures: dict[str, list[float]] = {}
# email(lowercased) -> locked_until_timestamp
_locked_until: dict[str, float] = {}


def _norm(email: str | None) -> str | None:
    return email.strip().lower() if email else None


def _prune(now: float) -> None:
    """Evict stale/oversized state. Caller must hold _lock.

    Drops non-locked emails whose newest failure is older than the window, then
    — if still over the cap — evicts the non-locked emails with the oldest last
    failure. Locked emails are always kept until their cooldown expires.
    """
    stale = [
        k for k, ts in _failures.items()
        if k not in _locked_until and (not ts or now - ts[-1] >= _WINDOW_SECONDS)
    ]
    for k in stale:
        _failures.pop(k, None)
    if len(_failures) >= _MAX_TRACKED:
        evictable = sorted(
            (kv for kv in _failures.items() if kv[0] not in _locked_until),
            key=lambda kv: kv[1][-1] if kv[1] else 0.0,
        )
        # Evict enough that after the caller's pending insert we stay <= cap.
        for k, _ in evictable[: len(_failures) - _MAX_TRACKED + 1]:
            _failures.pop(k, None)


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
        _prune(now)
        recent = [t for t in _failures.get(key, []) if now - t < _WINDOW_SECONDS]
        recent.append(now)
        _failures[key] = recent
        if len(recent) >= _MAX_FAILURES:
            _locked_until[key] = now + _LOCKOUT_SECONDS


def clear(email: str | None) -> None:
    """Reset all counters for an account — call on successful login."""
    key = _norm(email)
    if not key:
        return
    with _lock:
        _failures.pop(key, None)
        _locked_until.pop(key, None)
