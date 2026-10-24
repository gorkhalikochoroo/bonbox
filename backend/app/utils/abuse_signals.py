"""In-process counters of abuse-cap events, drained by the abuse monitor.

Single uvicorn worker: one process, so one dict under a lock is the whole
store. A restart loses the counts, which is acceptable — the monitor's own
state lives in monitor_state rows. Counts only: never an address, e-mail,
IP or user id.

Kinds: edge, no_edge, magic_link_fleet, magic_link_domain,
guest_mail_fleet, guest_mail_venue (one venue's share of the fleet guest-mail
ceiling used up), staff_join_cooloff, stand_join_cooloff, booking_honeypot,
booking_screen_error.
"""
from __future__ import annotations

import threading

_lock = threading.Lock()
_counts: dict[str, int] = {}


def bump(kind: str, n: int = 1) -> None:
    with _lock:
        _counts[kind] = _counts.get(kind, 0) + n


def drain() -> dict:
    """The counts since the last drain, and start again from zero."""
    with _lock:
        out = dict(_counts)
        _counts.clear()
    return out


def reset() -> None:
    with _lock:
        _counts.clear()
