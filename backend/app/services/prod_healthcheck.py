"""
prod_healthcheck — server-side port of frontend/scripts/prod-healthcheck.mjs.

Fetches the LIVE frontend (default https://www.bonbox.dk), extracts the entry
chunk, and verifies every referenced chunk resolves to JavaScript — NOT the
SPA index.html Vercel serves at HTTP 200 for a missing /assets/*.js. That
fallback-served-HTML is the exact stale-deploy trap a plain 200-check misses,
and it is what dead-ends users at the ErrorBoundary (the /reservations outage).

Sync (httpx.Client) because it runs on APScheduler's BackgroundScheduler
threads. Bounded (≤ _MAX_FETCHES) + fully fail-soft so a 5-min tick is cheap
and can NEVER crash the web process. Read-only: GETs public URLs only, mutates
nothing — it observes, a human acts.
"""
import re
from dataclasses import dataclass, field

import httpx

_TIMEOUT = httpx.Timeout(12.0, connect=6.0)
_MAX_FETCHES = 90  # covers the full ~76-chunk graph; truncation is a NOTE, never an alarm

# route → the source module its lazy import pulls. We assert the entry's
# dynamic-import map references a chunk whose basename starts with this AND
# that chunk resolves to JS. Mirrors prod-healthcheck.mjs KEY_ROUTES.
KEY_ROUTES = [
    ("/reservations", "ReservationsPage-"),
    ("/dashboard", "DashboardPage-"),
    ("/gavekort", "GavekortPage-"),
    ("/r/:slug", "ReservationPublicPage-"),
]

_ENTRY_RE = re.compile(
    r'<script[^>]+type="module"[^>]+src="/assets/([A-Za-z0-9_$-]+-[A-Za-z0-9_$-]{8})\.js"'
)
_ENTRY_RE_FALLBACK = re.compile(r'src="/assets/(index-[A-Za-z0-9_$-]{8})\.js"')
_IMPORT_FROM = re.compile(
    r"""import\s*\{([^}]*)\}\s*from\s*["']\./([A-Za-z0-9_$-]+-[A-Za-z0-9_$-]{8}\.js)["']"""
)
_EXPORT_BLOCK = re.compile(r"export\s*\{([^}]*)\}")


@dataclass
class HealthResult:
    healthy: bool
    entry: str | None = None
    errors: list = field(default_factory=list)
    summary: str = ""
    chunks_checked: int = 0
    truncated: bool = False


def _looks_like_js(status: int, body: str) -> bool:
    """A chunk URL that returns the SPA index.html (Vercel 404→fallback, HTTP
    200) is a MISSING asset. Reject anything that opens like HTML."""
    if status != 200:
        return False
    head = (body or "").lstrip()[:48].lower()
    if head.startswith("<!") or head.startswith("<html") or "<head" in head:
        return False
    return bool(body)


def _parse_chunk(src: str):
    """(imports, exports) for one rolldown/rollup chunk. imports = list of
    (dep_file, [imported_export_names]); exports = set of names it provides."""
    imports = []
    for m in _IMPORT_FROM.finditer(src):
        names = []
        for part in m.group(1).split(","):
            p = part.strip()
            if not p:
                continue
            # `x as y` imports the EXPORTED name x (left side)
            names.append(p.split(" as ")[0].strip() if " as " in p else p)
        imports.append((m.group(2), names))
    exports = set()
    for m in _EXPORT_BLOCK.finditer(src):
        for part in m.group(1).split(","):
            p = part.strip()
            if not p:
                continue
            # `x as y` re-exports y; `x` exports x
            exports.add(p.split(" as ")[1].strip() if " as " in p else p)
    return imports, exports


def check_prod_frontend(base: str = "https://www.bonbox.dk") -> HealthResult:
    """Probe the live frontend. Returns healthy=False (with errors) on a
    broken/stale deploy OR a probe error. NEVER raises."""
    base = (base or "https://www.bonbox.dk").rstrip("/")
    errors: list[str] = []
    entry_name = None
    fetches = 0
    truncated = False

    try:
        with httpx.Client(
            timeout=_TIMEOUT,
            follow_redirects=True,
            headers={"cache-control": "no-cache", "user-agent": "bonbox-monitor/1.0"},
        ) as c:
            # 1) HTML shell → entry chunk
            idx = c.get(base + "/")
            if idx.status_code != 200:
                return HealthResult(False, None, [f"index HTTP {idx.status_code}"],
                                    f"index HTTP {idx.status_code} at {base}/")
            html = idx.text
            m = _ENTRY_RE.search(html) or _ENTRY_RE_FALLBACK.search(html)
            if not m:
                return HealthResult(False, None,
                                    ["no module entry <script src=/assets/index-*.js> in HTML"],
                                    "no entry script in HTML shell")
            entry_name = m.group(1) + ".js"

            cache: dict[str, object] = {}

            def load(fn):
                """Return (body, parsed) | None (broken: 404/HTML) | 'TRUNCATED'
                (out of budget — a note, not a failure)."""
                nonlocal fetches, truncated
                if fn in cache:
                    return cache[fn]
                if fetches >= _MAX_FETCHES:
                    truncated = True
                    return "TRUNCATED"
                r = c.get(f"{base}/assets/{fn}")
                fetches += 1
                if not _looks_like_js(r.status_code, r.text):
                    cache[fn] = None
                    return None
                rec = (r.text, _parse_chunk(r.text))
                cache[fn] = rec
                return rec

            # 2) entry chunk must resolve to JS (the primary discriminator)
            entry_rec = load(entry_name)
            if entry_rec in (None, "TRUNCATED"):
                errors.append(f"entry {entry_name} did not resolve to JavaScript "
                              f"(SPA fallback / 404) — STALE DEPLOY")
                return HealthResult(False, entry_name, errors, f"entry={entry_name} broken", fetches)
            entry_body = entry_rec[0]

            # 3) each key route's chunk must be referenced by the entry + load as JS
            route_chunks = []
            for route, prefix in KEY_ROUTES:
                rm = re.search(rf"(?:assets/)?({re.escape(prefix)}[A-Za-z0-9_$-]{{8}})\.js",
                               entry_body)
                if not rm:
                    errors.append(f"route {route}: no {prefix}* chunk referenced by entry")
                    continue
                fn = rm.group(1) + ".js"
                route_chunks.append(fn)
                rec = load(fn)
                if rec is None:
                    errors.append(f"route {route}: chunk {fn} did not resolve to JS "
                                  f"(404/HTML) — stale deploy")

            # 4) BOUNDED graph — direct import contracts from entry + route chunks
            #    (one level, not a full BFS). Catches the "chunk 200s but was
            #    built against a different graph" case: an import of a name the
            #    dep no longer exports = a module-link error that crashes the route.
            for fn in [entry_name] + route_chunks:
                rec = cache.get(fn)
                if not isinstance(rec, tuple):
                    continue
                # rec = (body, (imports, exports)); imports = [(dep_file, [names])]
                for dep_file, names in rec[1][0]:
                    dep = load(dep_file)
                    if dep == "TRUNCATED":
                        continue
                    if dep is None:
                        errors.append(f"{fn} imports {dep_file} which did not resolve to JS "
                                      f"— broken chunk link")
                        continue
                    # dep = (body, (imports, exports)); exports set is dep[1][1]
                    missing = [n for n in names if n not in dep[1][1]]
                    if missing:
                        errors.append(f"GRAPH: {fn} imports {{{','.join(missing)}}} from "
                                      f"{dep_file} but it isn't exported — module-link error")
    except Exception as e:  # DNS/TLS/timeout/parse — inconclusive tick, treated as a soft-fail
        return HealthResult(False, entry_name, [f"probe error: {e}"], f"probe error: {e}", fetches)

    healthy = len(errors) == 0
    if healthy:
        summary = f"entry={entry_name}; {fetches} chunks OK"
        if truncated:
            summary += " (graph walk truncated)"
    else:
        summary = f"entry={entry_name}; {errors[0]}"
    return HealthResult(healthy, entry_name, errors, summary, fetches, truncated)


if __name__ == "__main__":  # one-shot manual check: python -m app.services.prod_healthcheck [base]
    import sys
    r = check_prod_frontend(sys.argv[1] if len(sys.argv) > 1 else "https://www.bonbox.dk")
    print("healthy:", r.healthy)
    print("entry:", r.entry)
    print("summary:", r.summary)
    for e in r.errors:
        print("  ✗", e)
    sys.exit(0 if r.healthy else 1)
