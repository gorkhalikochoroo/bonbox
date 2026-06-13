"""Route body-contract guard — catches the `from __future__ import annotations`
+ slowapi-limiter footgun before it ever ships again.

THE BUG (shipped + fixed 2026-06-13):
  A router that combines `from __future__ import annotations` (PEP 563 string
  annotations) with slowapi's @limiter.limit(...) on an endpoint that takes a
  Pydantic body makes FastAPI resolve the body annotation through the limiter
  WRAPPER's module globals — where the request model doesn't exist. FastAPI
  can't classify it as a model, silently demotes the parameter to a *required
  query parameter*, and every call 422s with loc=["query","body"] / "Field
  required". It hit PUT /api/pillars, PUT /api/modules/select, and
  POST /api/business/{verify-address,logo} simultaneously.

This test introspects the REAL app and fails if ANY route has a query/path
parameter whose annotation is actually a Pydantic model or an unresolved
ForwardRef — the exact fingerprint of the bug. It is annotation-style
agnostic: the fix (drop the future import) keeps it green; a regression
(re-add it on a limited body route) turns it red.
"""
from __future__ import annotations

from fastapi.routing import APIRoute
from pydantic import BaseModel

from app.main import app


def _misclassified_params():
    """Yield (methods, path, param_name, annotation) for every query/path
    param that is really a body (Pydantic model or unresolved ForwardRef)."""
    out = []
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        dependant = getattr(route, "dependant", None)
        if not dependant:
            continue
        suspects = list(getattr(dependant, "query_params", [])) + list(
            getattr(dependant, "path_params", [])
        )
        for p in suspects:
            ann = getattr(getattr(p, "field_info", None), "annotation", None) or getattr(
                p, "type_", None
            )
            is_model = isinstance(ann, type) and issubclass(ann, BaseModel)
            looks_forwardref = "ForwardRef" in str(ann)
            if is_model or looks_forwardref:
                out.append(
                    (sorted(route.methods), route.path, p.name, str(ann)[:90])
                )
    return out


def test_no_route_misclassifies_a_body_as_query_or_path():
    bad = _misclassified_params()
    assert not bad, (
        "Route(s) demote a request body to a query/path param — the "
        "`from __future__ import annotations` + slowapi-limiter footgun. "
        "Drop the future import from the offending router(s):\n"
        + "\n".join(f"  {m} {path}  param='{n}'  ann={a}" for m, path, n, a in bad)
    )


def test_pillars_put_exposes_a_request_body():
    """Direct guard on the endpoint the bug was found on: PUT /api/pillars
    must accept a JSON body, not a required `body` query param."""
    put = next(
        r
        for r in app.routes
        if isinstance(r, APIRoute) and r.path == "/api/pillars" and "PUT" in r.methods
    )
    assert put.dependant.body_params, "PUT /api/pillars lost its request body"
    query_names = {p.name for p in put.dependant.query_params}
    assert "body" not in query_names, "PUT /api/pillars `body` leaked into query params"
