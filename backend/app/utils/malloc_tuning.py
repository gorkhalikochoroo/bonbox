"""glibc malloc settings for the single API process, applied in code.

Why (measured under Linux, 1 CPU / 2 GB, NO swap — like Render, 10 Oct):
with glibc's default malloc, memory a worker thread frees after a photo
decode stays in that thread's malloc arena, so RSS ratchets up with every
batch of decodes. Three bursts of 12 concurrent 48 MP Z-report scans got
the API OOM-killed (exit 137) in burst 2 at ~2.07 GB. With both settings
below, set in code exactly like this, the same bursts peaked at 1.37 GB
and settled back to ~250 MB; a 15-minute mixed load averaged 288 MB
(default: 811 MB, peak 1.76 GB). With this module and the decode gate
(round 3): the bursts peaked at 692 MB and 15 minutes of mixed load
averaged 272 MB (peak 623 MB), no OOM, no swap.

* ``M_ARENA_MAX = 2`` — at most two malloc arenas instead of up to 8 per
  CPU, so freed memory is shared by the threads instead of stranded in
  one arena per thread.
* ``M_MMAP_THRESHOLD = 1 MiB`` — any allocation of 1 MiB or more (every
  decoded image buffer) gets its own mmap and is returned to the kernel
  the moment it is freed. Setting it also stops glibc from raising the
  threshold dynamically (which is how a 150 MB buffer ends up on the heap).

These used to be a recommendation for the Render service's environment
(``MALLOC_ARENA_MAX`` / ``MALLOC_MMAP_THRESHOLD_``); nothing in the repo set
them, so the photo-slot sizing in ai_limits silently depended on a manual
dashboard step. Now the process sets them itself at import of app.main,
before any worker thread exists.

Only glibc Linux is touched (production is Render, x86_64, glibc). macOS,
musl (Alpine) and anything else are a no-op. Overrides:

* ``BONBOX_MALLOPT=0`` — skip both settings. FOR MEASURING ONLY, NOT A
  PRODUCTION SWITCH: the decode gate alone does not hold memory down. With
  the round-3 code and this set (same bursts, 1 CPU / 2 GB, no swap, 10 Oct
  review): peak RSS 1,753 MB, container 1,840 of 2,048 MB, and RSS after
  each burst still climbing (1,006 -> 1,179 -> 1,256 MB) — against a
  775 MB peak settling at ~235 MB with the settings on. If a runtime ever
  misbehaves with them, set the two env vars below to other values instead.
* ``MALLOC_ARENA_MAX`` / ``MALLOC_MMAP_THRESHOLD_`` in the environment — glibc
  has already applied the operator's value at process start; this module
  leaves that one parameter alone.

Recommended on the Render service as well: ``MALLOC_ARENA_MAX=2`` and
``MALLOC_MMAP_THRESHOLD_=1048576`` (the same values). They do not conflict
with this module (it leaves an operator's value alone) and they keep the
allocator settings through any code rollback — a rollback to before this
module (d614f211, the round-2 tip) is the state that was OOM-killed.
"""

from __future__ import annotations

import os
import platform
import sys

#: mallopt() parameter numbers from glibc's <malloc.h>.
M_MMAP_THRESHOLD = -3
M_ARENA_MAX = -8

ARENA_MAX = 2
MMAP_THRESHOLD = 1024 * 1024  # 1 MiB

#: (name, mallopt param, value, the glibc env var that overrides it)
_SETTINGS = (
    ("M_ARENA_MAX", M_ARENA_MAX, ARENA_MAX, "MALLOC_ARENA_MAX"),
    ("M_MMAP_THRESHOLD", M_MMAP_THRESHOLD, MMAP_THRESHOLD, "MALLOC_MMAP_THRESHOLD_"),
)


def _glibc_version() -> str | None:
    """The glibc version on Linux/glibc, else None (macOS, musl, Windows)."""
    if not sys.platform.startswith("linux"):
        return None
    try:
        lib, version = platform.libc_ver()
    except Exception:  # noqa: BLE001
        return None
    return (version or None) if lib == "glibc" else None


#: glibc's soname — the same on every glibc Linux (x86_64 and arm64).
GLIBC_SONAME = "libc.so.6"


def _load_libc():
    # Loaded by soname: this only runs after _glibc_version() confirmed
    # glibc. ctypes.util.find_library("c") would fork `/sbin/ldconfig -p` on
    # every API boot to find the same name.
    import ctypes

    return ctypes.CDLL(GLIBC_SONAME)


def _print_line(line: str) -> None:
    # stdout like the other startup lines in main.py; flushed, so it shows
    # in the Render log at boot rather than whenever the buffer fills.
    print(line, flush=True)


def apply_malloc_tuning(environ=None, *, log=_print_line) -> dict:
    """Apply the glibc malloc settings once; return what was done.

    Never raises: a failure is reported in the result and the log line,
    and the process runs with glibc's defaults.
    """
    env = os.environ if environ is None else environ
    result: dict = {"applied": {}, "skipped": None}
    if (env.get("BONBOX_MALLOPT") or "").strip() == "0":
        result["skipped"] = "disabled by BONBOX_MALLOPT=0"
    else:
        version = _glibc_version()
        if version is None:
            result["skipped"] = f"not glibc ({sys.platform})"
        else:
            result["glibc"] = version
            try:
                libc = _load_libc()
                mallopt = libc.mallopt
            except Exception as e:  # noqa: BLE001
                result["skipped"] = f"mallopt unavailable: {e}"
            else:
                for name, param, value, env_var in _SETTINGS:
                    if env.get(env_var):
                        result["applied"][name] = f"left to {env_var}={env.get(env_var)}"
                        continue
                    try:
                        ok = mallopt(param, value) == 1
                    except Exception as e:  # noqa: BLE001
                        ok = False
                        result["applied"][name] = f"error: {e}"
                        continue
                    result["applied"][name] = value if ok else "refused"
    if result["skipped"]:
        line = f"malloc tuning: skipped ({result['skipped']})"
    else:
        parts = ", ".join(f"{k}={v}" for k, v in result["applied"].items())
        line = f"malloc tuning: glibc {result.get('glibc')}: {parts}"
    try:
        log(line)
    except Exception:  # noqa: BLE001
        pass
    result["line"] = line
    return result
