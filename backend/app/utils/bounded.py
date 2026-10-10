"""Keep the process-wide per-key dicts from growing for the life of the process.

Production is ONE long-lived uvicorn process (Render, 1 CPU / 2 GB). A
module-level dict keyed per client IP, e-mail, account or request input
that only ever gains keys grows with every new key the internet sends it
(rotating scanner IPs, random e-mails in a credential-stuffing run) until
the next deploy. Each owner calls one of these right after it writes:

* ``bound_window_dict`` — ``key -> list[timestamps]`` sliding windows
  (rate counters, strike lists);
* ``bound_stamp_dict``  — ``key -> one comparable value`` (a last-seen time,
  an expiry; floats or datetimes).

Both are no-ops until the dict holds more than ``max_keys`` keys. Then they
first drop the keys that can no longer affect any decision (a window with
no event after ``cutoff``, a stamp older than ``stale_before``) — exactly
what the owner would have ignored anyway — and only if the dict is STILL
over the limit (a flood of live keys) drop the keys touched longest ago.
They shrink to 90% of ``max_keys`` so a full sweep runs once per ~10% new
keys, not on every request.

Not thread-safe by themselves: owners touched from worker threads hold
their own lock around the write and the call.
"""

from __future__ import annotations

from typing import Any, Callable, Hashable, MutableMapping, Sequence

#: A sweep shrinks the dict to this share of its limit.
_SHRINK_TO = 0.9


def _last(seq: Sequence[float]) -> float:
    return seq[-1] if seq else float("-inf")


def bound_window_dict(
    d: MutableMapping[Hashable, Sequence[float]], *, cutoff: float, max_keys: int,
) -> int:
    """Bound a ``key -> ascending timestamps`` dict. Returns keys dropped.

    Stale = no timestamp after ``cutoff`` (the caller's window start): such a
    key counts as zero events, which is what a missing key counts as too.
    """
    if len(d) <= max_keys:
        return 0
    before = len(d)
    for k in [k for k, v in list(d.items()) if _last(v) <= cutoff]:
        d.pop(k, None)
    if len(d) > max_keys:
        keep = int(max_keys * _SHRINK_TO)
        oldest = sorted(list(d.items()), key=lambda kv: _last(kv[1]))
        for k, _ in oldest[: len(d) - keep]:
            d.pop(k, None)
    return before - len(d)


def bound_stamp_dict(
    d: MutableMapping[Hashable, Any], *, stale_before: Any, max_keys: int,
    stamp: Callable[[Any], Any] | None = None,
) -> int:
    """Bound a ``key -> stamp`` dict (stamps comparable with ``stale_before``).

    Stale = stamp ``<= stale_before`` (a cooldown that has run out, a ban or
    lock that has expired). ``stamp`` extracts the stamp when the value is
    more than one (e.g. ``(expires_at, payload)``). Returns keys dropped.
    """
    if len(d) <= max_keys:
        return 0
    get = stamp or (lambda v: v)
    before = len(d)
    for k in [k for k, v in list(d.items()) if get(v) <= stale_before]:
        d.pop(k, None)
    if len(d) > max_keys:
        keep = int(max_keys * _SHRINK_TO)
        oldest = sorted(list(d.items()), key=lambda kv: get(kv[1]))
        for k, _ in oldest[: len(d) - keep]:
            d.pop(k, None)
    return before - len(d)
