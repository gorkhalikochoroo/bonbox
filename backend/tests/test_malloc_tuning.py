"""R-d round 3 — glibc malloc settings are applied in code, not by hand.

Measured under Linux, 1 CPU / 2 GB, NO swap (like Render, 10 Oct): with the
default allocator, three bursts of 12 concurrent 48 MP Z-report scans got
the API OOM-killed; with M_ARENA_MAX=2 + a 1 MiB mmap threshold set in code
the same bursts survived and RSS settled back to ~250 MB. The 3-slot sizing
silently depended on a Render env var nothing in the repo set. Pinned here:

  * app.main applies the settings at import, BEFORE the heavy imports;
  * on glibc it calls mallopt(M_ARENA_MAX=-8, 2) and
    mallopt(M_MMAP_THRESHOLD=-3, 1048576), and logs one line;
  * it is a no-op on macOS / musl, and BONBOX_MALLOPT=0 turns it off;
  * an operator's MALLOC_ARENA_MAX / MALLOC_MMAP_THRESHOLD_ is left alone;
  * on a real glibc Linux (the CI container) it really applies.

Run:
  cd backend && python -m pytest tests/test_malloc_tuning.py -q
"""

from __future__ import annotations

import pathlib
import platform
import sys

import pytest

from app.utils import malloc_tuning as mt

MAIN_SRC = (pathlib.Path(__file__).resolve().parents[1] / "app" / "main.py").read_text(encoding="utf-8")


class _FakeLibc:
    def __init__(self, ret: int = 1):
        self.calls: list[tuple[int, int]] = []
        self.ret = ret

    def mallopt(self, param, value):
        self.calls.append((param, value))
        return self.ret


@pytest.fixture
def fake_glibc(monkeypatch):
    libc = _FakeLibc()
    monkeypatch.setattr(mt.sys, "platform", "linux")
    monkeypatch.setattr(mt.platform, "libc_ver", lambda *a, **k: ("glibc", "2.41"))
    monkeypatch.setattr(mt, "_load_libc", lambda: libc)
    return libc


def test_main_applies_it_at_import_before_the_heavy_imports():
    call = MAIN_SRC.index("_MALLOC_TUNING = _apply_malloc_tuning()")
    for heavy in ("import sentry_sdk", "from fastapi import", "from app.routers import", "from app.database import"):
        assert call < MAIN_SRC.index(heavy), heavy


def test_on_glibc_both_settings_are_applied_and_one_line_is_logged(fake_glibc):
    lines: list[str] = []
    r = mt.apply_malloc_tuning({}, log=lines.append)
    assert fake_glibc.calls == [(-8, 2), (-3, 1048576)]
    assert r["applied"] == {"M_ARENA_MAX": 2, "M_MMAP_THRESHOLD": 1048576}
    assert lines == ["malloc tuning: glibc 2.41: M_ARENA_MAX=2, M_MMAP_THRESHOLD=1048576"]


def test_a_refused_setting_is_reported_not_raised(fake_glibc):
    fake_glibc.ret = 0
    lines: list[str] = []
    r = mt.apply_malloc_tuning({}, log=lines.append)
    assert r["applied"] == {"M_ARENA_MAX": "refused", "M_MMAP_THRESHOLD": "refused"}
    assert "refused" in lines[0]


def test_bonbox_mallopt_0_turns_it_off(fake_glibc):
    lines: list[str] = []
    r = mt.apply_malloc_tuning({"BONBOX_MALLOPT": "0"}, log=lines.append)
    assert fake_glibc.calls == []
    assert r["skipped"] == "disabled by BONBOX_MALLOPT=0"
    assert lines == ["malloc tuning: skipped (disabled by BONBOX_MALLOPT=0)"]


def test_an_operators_glibc_env_var_is_left_alone(fake_glibc):
    r = mt.apply_malloc_tuning({"MALLOC_ARENA_MAX": "4"}, log=lambda _l: None)
    assert fake_glibc.calls == [(-3, 1048576)]
    assert r["applied"]["M_ARENA_MAX"] == "left to MALLOC_ARENA_MAX=4"


@pytest.mark.parametrize("plat,libc", [("darwin", ("", "")), ("linux", ("", "")), ("win32", ("", ""))])
def test_it_is_a_no_op_off_glibc(monkeypatch, plat, libc):
    """macOS, musl (Alpine: libc_ver() is empty) and Windows: nothing is called."""
    monkeypatch.setattr(mt.sys, "platform", plat)
    monkeypatch.setattr(mt.platform, "libc_ver", lambda *a, **k: libc)
    monkeypatch.setattr(mt, "_load_libc", lambda: pytest.fail("libc must not be loaded off glibc"))
    lines: list[str] = []
    r = mt.apply_malloc_tuning({}, log=lines.append)
    assert r["applied"] == {} and r["skipped"].startswith("not glibc")
    assert len(lines) == 1 and lines[0].startswith("malloc tuning: skipped (not glibc")


def test_it_never_raises_when_libc_cannot_be_loaded(monkeypatch):
    monkeypatch.setattr(mt.sys, "platform", "linux")
    monkeypatch.setattr(mt.platform, "libc_ver", lambda *a, **k: ("glibc", "2.41"))

    def _boom():
        raise OSError("no libc")

    monkeypatch.setattr(mt, "_load_libc", _boom)
    r = mt.apply_malloc_tuning({}, log=lambda _l: None)
    assert r["skipped"].startswith("mallopt unavailable")


def test_the_import_time_call_ran_and_matches_this_platform():
    import app.main as main

    r = main._MALLOC_TUNING
    assert r["line"].startswith("malloc tuning: ")
    real_glibc = sys.platform.startswith("linux") and platform.libc_ver()[0] == "glibc"
    import os

    if os.environ.get("BONBOX_MALLOPT", "").strip() == "0":
        assert r["skipped"] == "disabled by BONBOX_MALLOPT=0"
    elif real_glibc:
        # The CI container (python:3.12-slim, glibc): really applied.
        for name, value in (("M_ARENA_MAX", 2), ("M_MMAP_THRESHOLD", 1048576)):
            env_var = "MALLOC_ARENA_MAX" if name == "M_ARENA_MAX" else "MALLOC_MMAP_THRESHOLD_"
            if os.environ.get(env_var):
                assert str(r["applied"][name]).startswith("left to")
            else:
                assert r["applied"][name] == value, r
    else:
        assert r["applied"] == {} and r["skipped"]
