"""The path a request is ROUTED on — the only path a security check may read.

WHY THIS EXISTS (INFRA-01, CVE-2026-48710 / GHSA-86qp-5c8j-p5mr)
-----------------------------------------------------------------
Starlette < 1.0.1 builds ``request.url`` by gluing the raw ``Host`` header in
front of the path and re-parsing the result. A crafted header such as
``Host: api.bonbox.dk/api/accountants/grants/x?`` therefore makes
``request.url.path`` read ``/api/accountants/grants/x`` while the router still
dispatches the real path (``scope["path"]``, e.g. ``/api/expenses/1``). Every
guard that decided on ``request.url.path`` — the accountant/member read-only
write guard, the wage-data read guard, the shared-device PIN gate, the staff
portal PIN exemptions, CSRF exemptions, the IP ceiling — could be steered by
the Host header.

``scope["path"]`` is set by the ASGI server from the request line, is what the
router matches on, and is never influenced by ``Host``. Read it through this
helper so the next guard someone writes can't regress.
"""


def routed_path(request) -> str:
    """Return the ASGI ``scope["path"]`` the router dispatches on ("" if absent).

    Never derived from the ``Host`` header. Accepts a Starlette ``Request`` (or
    anything with a ``scope`` mapping); ``None`` returns "".
    """
    if request is None:
        return ""
    try:
        return request.scope.get("path") or ""
    except Exception:  # noqa: BLE001 — a guard must never crash on a weird request
        return ""
