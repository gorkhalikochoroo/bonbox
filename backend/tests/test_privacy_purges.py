"""R-h: the nightly privacy jobs.

Pins:
  • H-1 the two nightly privacy jobs survive a busy thread pool
    (misfire grace + coalesce + one instance), so a night is not skipped.

Run:
  cd backend && python3 -m pytest tests/test_privacy_purges.py -q
"""
from __future__ import annotations

import ast
from pathlib import Path

_MAIN = Path(__file__).resolve().parents[1] / "app" / "main.py"


def _add_job_kwargs(job_id: str) -> dict:
    """The keyword arguments of the add_job(...) call whose id= is job_id."""
    tree = ast.parse(_MAIN.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "add_job"):
            continue
        kw = {k.arg: k.value for k in node.keywords if k.arg}
        idv = kw.get("id")
        if isinstance(idv, ast.Constant) and idv.value == job_id:
            return {k: (v.value if isinstance(v, ast.Constant) else v) for k, v in kw.items()}
    raise AssertionError(f"no add_job(..., id={job_id!r}) in app/main.py")


def test_nightly_privacy_jobs_have_misfire_grace():
    for job_id in ("daily_maintenance", "reservation_gdpr_purge"):
        kw = _add_job_kwargs(job_id)
        assert kw.get("misfire_grace_time") == 3600, job_id
        assert kw.get("coalesce") is True, job_id
        assert kw.get("max_instances") == 1, job_id
