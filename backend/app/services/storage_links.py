"""What a browser is handed for a stored receipt photo — re-linked off the
retired storage project at READ time, never written back.

Since 20 Oct 2026 production runs in the Frankfurt project. Seven receipt
photos (expenses 4, sales 1, daily_closes 2) are still stored as 1-year signed
URLs on the old Ireland project's host. Every one of those files was copied to
Frankfurt under the same bucket and path (investigation 23 Oct: 7 of 7, 0
missing). The Ireland URLs keep working only until that project is deleted
(promised by 30 Nov).

`client_receipt_ref(stored, owner_id)` is the ONE place that decides what a
client gets for a stored value:

  None / empty / bare key / local path   unchanged (as before)
  URL on the current project's host      unchanged (as before)
  URL on a RETIRED host                  a fresh signed URL for the same
                                         object in the current bucket, with
                                         the TTL new uploads get — only when
                                         ALL of these hold, otherwise unchanged:
                                           • the key is the ROW OWNER's
                                             (parse_receipt_ref: strict key
                                             shape, percent-decoded, no dot
                                             segments, no backslash)
                                           • the bucket is the configured one
                                           • the kind is one a receipt upload
                                             writes (expense / sale /
                                             kasserapport)
                                           • storage is durable
  URL on any other host                  unchanged; the HOST is logged once

Why the owner check is not optional: re-signing a key read out of a URL
bypasses that URL's own token, and daily_closes.receipt_photo takes any string
the client sends (schemas/daily_close.py). Without it, an owner could store
another owner's key in an Ireland-shaped URL and be handed a working link to
their photo. The owner compared is the ROW's, never the caller's.

What it never does:
  • write — a read path never assigns the result to an ORM attribute (an
    autoflush would store it); only link-bilag stores one, deliberately.
    Stored values, _content_signature / doc_sig, audit rows and the revisor
    package all keep reading the raw column.
  • fetch from the retired host — it only signs in the current project.
  • log a path, key or token — hosts, sources and reason codes only.

Only rows written BEFORE the move are ever re-linked (RETIRED_CUTOVER, the
row's own created_at; a missing one is refused). Every legacy Ireland link
was stored before 20 Oct (production 23 Oct: 7 of 7). A row written since can
only carry an Ireland-shaped URL because a client typed one — expense and
sale receipt_photo and daily_closes.receipt_photo accept any string — and
signing those would let any tenant turn every list read into one outbound
Supabase call per row (fix round 23 Oct, finding B1).

Signing happens in the request path, so it is bounded: a short per-call
timeout, a failure returns the stored value (no worse than before), and an
in-process LRU keeps one URL per object for 30 days (the URL itself is valid
for a year), so a list endpoint asks Supabase once per object per process;
after a failure the object is not asked again for 5 minutes. Behind all of
that, a process-wide budget (SIGN_BUDGET_PER_MIN) caps signing attempts that
miss the cache, and inside it each row owner has a smaller one
(SIGN_BUDGET_PER_OWNER_PER_MIN), so one tenant cannot spend it for everyone;
when either is spent the stored value is handed out and the next read tries
again.

No write path accepts a NEW retired-host link (fix round 2, 23 Oct):
ExpenseCreate, link-bilag, /sales/from-receipt and the daily-close save
refuse one with 422 (`is_retired_link`); the daily-close save lets through
only the page's own echo of what the close already stores. Moving a draft's
bilag onto another expense (link-bilag) re-links it at write time — the
moved photo is stored as the Frankfurt link, never as an Ireland link on a
newer row (that write path is the one place a result of client_receipt_ref
is stored, on purpose).

`relink_stats()` counts what happened since boot. It is informational: the
precondition for deleting the retired project is
`safe_to_delete_retired_project` in /api/admin/storage-links, which signs
each legacy object itself rather than trusting a counter a deploy resets.
"""
from __future__ import annotations

import logging
import threading
import time
from collections import Counter, OrderedDict
from datetime import datetime, timezone
from urllib.parse import unquote, urlsplit

from app.config import settings
from app.services.receipt_ref import parse_receipt_ref

logger = logging.getLogger(__name__)

# The old primary (Ireland, eu-west-1). Retired as the live project on
# 20 Oct 2026; a read-only fallback copy until it is deleted. Only ever
# re-linked FROM, never signed or fetched against.
RETIRED_PROJECT_REFS = ("ahlqhztujpeccmaivkhr",)
RETIRED_STORAGE_HOSTS = frozenset(f"{ref}.supabase.co" for ref in RETIRED_PROJECT_REFS)

# The kinds save_receipt_photo_ex writes into a receipt_photo column. Anything
# else in that column (a staff document, a logo, an avatar key) is not a
# receipt and is never signed from here.
RELINK_KINDS = frozenset({"expense", "sale", "kasserapport"})

# The lifetime of a receipt URL — one value for new uploads
# (receipt_ocr._upload_to_supabase) and re-links alike.
RECEIPT_URL_TTL_SECONDS = 60 * 60 * 24 * 365

# Production moved to Frankfurt on 20 Oct 2026. A row written on or after this
# instant was never stored with an Ireland link by the app, so it is never
# re-linked (its created_at is server-set: no request schema accepts it).
RETIRED_CUTOVER = datetime(2026, 10, 20, tzinfo=timezone.utc)

SIGN_TIMEOUT_SECONDS = 3.0
# Process-wide ceiling on signing calls that miss the cache (a token bucket,
# refilled continuously). The 7 legacy objects need 7 calls per process start
# (then cached for 30 days); this is the backstop if anything else ever
# reaches the signer.
SIGN_BUDGET_PER_MIN = 30
# Inside that, per row owner (also a token bucket): one tenant's rows can use
# a third of the minute at most, so another owner's legacy photo still gets
# its link. The owner map is bounded (least recently used out).
SIGN_BUDGET_PER_OWNER_PER_MIN = 10
OWNER_BUDGETS_MAX = 1024
# The signing check /api/admin/storage-links makes per legacy object: proves
# the current project can mint a link for it. Minting writes nothing.
REPORT_SIGN_TTL_SECONDS = 60
CACHE_MAX_ENTRIES = 1024
CACHE_FRESH_SECONDS = 30 * 24 * 60 * 60
# After a failed signing, the same object is not asked again for this long:
# a slow or failing Supabase then costs one short timeout per object per
# 5 minutes, not one per object per read.
SIGN_FAIL_BACKOFF_SECONDS = 5 * 60
# Log-once marks that carry a HOST (foreign URLs: a tenant can type any
# host) are capped; marks of a reason alone are a closed set (reason x
# source, both from code) and always log once, so a tenant filling the host
# marks can never silence a later sign_failed.
_MAX_NOTED_HOSTS = 100

_OBJECT_PREFIX = "/storage/v1/object/"
_ACCESS_SEGMENTS = ("sign", "public", "authenticated")

_lock = threading.Lock()
_cache: "OrderedDict[str, tuple[str, float]]" = OrderedDict()
_stats: Counter = Counter()
_failed: "OrderedDict[str, float]" = OrderedDict()
_noted: set[tuple[str, str]] = set()
_noted_hosts: set[tuple[str, str, str]] = set()
_bucket: dict = {"tokens": float(SIGN_BUDGET_PER_MIN), "at": None}
_owner_buckets: "OrderedDict[str, tuple[float, float]]" = OrderedDict()


def _now() -> float:
    """The monotonic clock every timer here reads (one seam for tests)."""
    return time.monotonic()


def _as_utc(value) -> datetime | None:
    """A row's created_at as an aware UTC datetime. The columns are naive
    UTC (utc_now; Postgres `timestamp without time zone`, SQLite returns
    naive too), so a naive value is UTC. Anything else is None."""
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _host(url: str) -> str | None:
    try:
        h = urlsplit(url).hostname
    except ValueError:
        return None
    return h.lower() if h else None


def current_storage_host() -> str | None:
    """Host of the project the app stores in now (settings.SUPABASE_URL)."""
    return _host((settings.SUPABASE_URL or "").strip())


_retired_config_logged = False


def configured_project_is_retired() -> bool:
    """True when SUPABASE_URL itself names a retired project — new uploads
    would then be signed on a host that is going away. Reported, never
    blocking (storage-switch plan §5.2): CRITICAL once per process here, and
    in /api/admin/storage-links."""
    global _retired_config_logged
    retired = current_storage_host() in RETIRED_STORAGE_HOSTS
    if retired and not _retired_config_logged:
        _retired_config_logged = True
        logger.critical(
            "Storage: SUPABASE_URL names a retired project. Uploads are kept, but "
            "their links sit on a host that is going away: point SUPABASE_URL at "
            "the live project."
        )
    return retired


def _note(reason: str, source: str, host: str | None = None) -> None:
    """Count, and log ONCE per (reason, source[, host]) per process. Never a
    path, key or token: the host (for a foreign URL), the source and the
    reason. Host marks are capped at _MAX_NOTED_HOSTS; reason-only marks are
    not (a closed set), so they always log once."""
    with _lock:
        _stats[reason] += 1
        if host:
            mark = (reason, source or "", host[:100])
            if mark in _noted_hosts or len(_noted_hosts) >= _MAX_NOTED_HOSTS:
                return
            _noted_hosts.add(mark)
        else:
            mark2 = (reason, source or "")
            if mark2 in _noted:
                return
            _noted.add(mark2)
    if host:
        logger.warning("receipt link left as stored: reason=%s source=%s host=%s",
                       reason, source or "-", host[:100])
    else:
        logger.warning("receipt link left as stored: reason=%s source=%s",
                       reason, source or "-")


def is_retired_link(value) -> bool:
    """True when `value` is a link on a retired storage host. Every write
    path refuses a NEW one (fix round 2): since the move only a client can
    send one, and on a pre-cutover row it would be signed on every read.
    Any scheme, any case; a lookalike host is not a retired host.

    Never true for the host storage is configured on (storage-switch plan
    §5.1): on 23 Oct SUPABASE_URL still named Ireland, every upload handed
    out an Ireland link, and refusing it stopped receipt photos from saving.
    That case is reported by configured_project_is_retired(), not blocked."""
    if not value or not isinstance(value, str):
        return False
    host = _host(value.strip())
    if host not in RETIRED_STORAGE_HOSTS:
        return False
    if host == current_storage_host():
        configured_project_is_retired()  # logs the misconfiguration once
        return False
    return True


def _bucket_of(url: str) -> str | None:
    """The bucket segment of a Supabase storage object URL, or None when the
    path is not one (…/storage/v1/object/[sign|public|authenticated/]<bucket>/…).
    Percent-decoded first, like parse_receipt_ref."""
    try:
        path = unquote(urlsplit(url).path or "")
    except ValueError:
        return None
    if not path.startswith(_OBJECT_PREFIX):
        return None
    segs = path[len(_OBJECT_PREFIX):].split("/")
    if segs and segs[0] in _ACCESS_SEGMENTS:
        segs = segs[1:]
    if len(segs) < 2 or not segs[0]:
        return None
    return segs[0]


def retired_link_key(stored: str | None, owner_id, *, created_at=None) -> tuple[str | None, str]:
    """For a URL on a retired host: (key, "ok") when it may be re-linked to
    the same object in the current bucket, else (None, reason). Pure — no
    storage call; /api/admin/storage-links uses it to count the same way the
    read paths decide. `created_at` is the ROW's: a row without one, or
    written on/after RETIRED_CUTOVER, is refused before anything else is
    looked at."""
    s = (stored or "").strip()
    if not s or "://" not in s:
        return None, "not_a_url"
    if _host(s) not in RETIRED_STORAGE_HOSTS:
        return None, "not_retired_host"
    at = _as_utc(created_at)
    if at is None:
        return None, "refused_no_created_at"
    if at >= RETIRED_CUTOVER:
        return None, "refused_after_cutover"
    if not s.lower().startswith("https://"):
        return None, "refused_scheme"
    if owner_id is None:
        return None, "refused_no_owner"
    parsed = parse_receipt_ref(s, owner_id)
    if not parsed or parsed[0] != "storage":
        # another owner's key, a malformed or traversal path, an unknown shape
        return None, "refused_not_owner_key"
    key = parsed[1]
    bucket = (settings.SUPABASE_RECEIPTS_BUCKET or "receipts").strip()
    if _bucket_of(s) != bucket:
        return None, "refused_bucket"
    if key.split("/", 2)[1] not in RELINK_KINDS:
        return None, "refused_kind"
    return key, "ok"


def _cached(key: str) -> str | None:
    now = _now()
    with _lock:
        hit = _cache.get(key)
        if hit is None:
            return None
        url, minted = hit
        if now - minted > CACHE_FRESH_SECONDS:
            _cache.pop(key, None)
            return None
        _cache.move_to_end(key)
        _stats["cache_hit"] += 1
        return url


def _recently_failed(key: str) -> bool:
    now = _now()
    with _lock:
        at = _failed.get(key)
        if at is None:
            return False
        if now - at > SIGN_FAIL_BACKOFF_SECONDS:
            _failed.pop(key, None)
            return False
        return True


def _remember_failure(key: str) -> None:
    with _lock:
        _failed[key] = _now()
        _failed.move_to_end(key)
        while len(_failed) > CACHE_MAX_ENTRIES:
            _failed.popitem(last=False)


def _remember(key: str, url: str) -> None:
    with _lock:
        _cache[key] = (url, _now())
        _cache.move_to_end(key)
        while len(_cache) > CACHE_MAX_ENTRIES:
            _cache.popitem(last=False)
        _stats["relinked"] += 1
        _failed.pop(key, None)


def _refill(tokens: float, at, now: float, cap: float) -> float:
    if at is not None and now > at:
        return min(cap, tokens + (now - at) * cap / 60.0)
    return tokens


def _take_sign_token(owner_id=None) -> str | None:
    """One signing attempt from the process-wide budget AND the row owner's,
    or the reason it was refused ("sign_budget" / "sign_budget_owner").
    Token buckets of SIGN_BUDGET_PER_MIN and SIGN_BUDGET_PER_OWNER_PER_MIN,
    refilled continuously; both are taken together or neither is."""
    now = _now()
    cap = float(SIGN_BUDGET_PER_MIN)
    owner_cap = float(SIGN_BUDGET_PER_OWNER_PER_MIN)
    owner = str(owner_id) if owner_id is not None else ""
    with _lock:
        tokens = _refill(_bucket["tokens"], _bucket["at"], now, cap)
        _bucket["tokens"], _bucket["at"] = tokens, now
        o_tokens, o_at = _owner_buckets.get(owner, (owner_cap, None))
        o_tokens = _refill(o_tokens, o_at, now, owner_cap)
        _owner_buckets[owner] = (o_tokens, now)
        _owner_buckets.move_to_end(owner)
        while len(_owner_buckets) > OWNER_BUDGETS_MAX:
            _owner_buckets.popitem(last=False)
        if tokens < 1.0:
            return "sign_budget"
        if o_tokens < 1.0:
            return "sign_budget_owner"
        _bucket["tokens"] = tokens - 1.0
        _owner_buckets[owner] = (o_tokens - 1.0, now)
        return None


def client_receipt_ref(stored: str | None, owner_id, *, created_at=None,
                       source: str = "") -> str | None:
    """The receipt reference to hand a client for `stored` on a row owned by
    `owner_id` and written at `created_at` (the ROW's). NEVER writes, never
    fetches from a retired host; on any doubt returns `stored` unchanged.
    Only rows written before RETIRED_CUTOVER are ever signed. `source`
    ('expenses', 'sales', 'daily_closes') only labels the log line."""
    if not stored or not isinstance(stored, str):
        return stored
    s = stored.strip()
    if "://" not in s:
        return stored                                   # bare key / local path / inbox blob
    host = _host(s)
    if host is None:
        _note("malformed_url", source)
        return stored
    current = current_storage_host()
    if current and host == current:
        return stored                                   # already the live project
    if host not in RETIRED_STORAGE_HOSTS:
        _note("foreign_host", source, host)
        return stored
    key, reason = retired_link_key(s, owner_id, created_at=created_at)
    if key is None:
        _note(reason, source)
        return stored
    from app.services.storage import get_storage
    backend = get_storage()
    if not getattr(backend, "is_durable", False):
        _note("no_durable_storage", source)
        return stored
    hit = _cached(key)
    if hit:
        return hit
    if _recently_failed(key):
        _note("sign_backoff", source)
        return stored
    refused = _take_sign_token(owner_id)
    if refused:
        _note(refused, source)
        return stored
    try:
        signed = backend.signed_url(key, ttl_seconds=RECEIPT_URL_TTL_SECONDS,
                                    timeout=SIGN_TIMEOUT_SECONDS)
    except Exception:  # noqa: BLE001 — a read must never fail on signing
        signed = None
    if not signed or not isinstance(signed, str) or _host(signed) in RETIRED_STORAGE_HOSTS:
        _note("sign_failed", source)
        _remember_failure(key)
        return stored
    _remember(key, signed)
    return signed


def relink_response_model(model, data, source: str):
    """For a response model's wrap validator (ExpenseResponse, SaleResponse):
    swap receipt_photo on the built PYDANTIC model for its client link. The
    owner and created_at are read from what the model was built from (the
    ORM row's, or a dict's); without an owner nothing is re-linked, and
    without a created_at before the cutover nothing is signed. The source
    object — the ORM row — is only read, never assigned."""
    stored = getattr(model, "receipt_photo", None)
    if not stored or isinstance(data, type(model)):
        return model                    # nothing stored, or already built (re-validation)
    if isinstance(data, dict):
        owner, created = data.get("user_id"), data.get("created_at")
    else:
        owner, created = getattr(data, "user_id", None), getattr(data, "created_at", None)
    out = client_receipt_ref(stored, owner, created_at=created, source=source)
    if out != stored:
        model.receipt_photo = out
    return model


def same_receipt_object(a: str | None, b: str | None, owner_id) -> bool:
    """True when two stored references name the SAME storage object of this
    owner (an Ireland URL and its Frankfurt re-link, two signings of one key).
    The daily-close save uses it so the page echoing back the re-linked URL
    never replaces the stored one (that would change the close's content
    signature and its audit trail). Compared by key, never by string."""
    if not a or not b or owner_id is None:
        return False
    pa = parse_receipt_ref(a, owner_id)
    pb = parse_receipt_ref(b, owner_id)
    return bool(pa and pb and pa[0] == "storage" and pa == pb)


def relink_stats() -> dict:
    """Process-local counters since boot (aggregate only)."""
    with _lock:
        out = dict(_stats)
        out["cached_objects"] = len(_cache)
    return out


def reset_for_tests() -> None:
    with _lock:
        _cache.clear()
        _failed.clear()
        _stats.clear()
        _noted.clear()
        _noted_hosts.clear()
        _owner_buckets.clear()
        _bucket["tokens"] = float(SIGN_BUDGET_PER_MIN)
        _bucket["at"] = None


# ─── /api/admin/storage-links: is every retired-host photo resolvable? ──

# (table, model module, model class) — the three columns that store a receipt URL
# (investigation 23 Oct: a scan of every text/json column found no others).
_URL_COLUMNS = (
    ("expenses", "app.models.expense", "Expense"),
    ("sales", "app.models.sale", "Sale"),
    ("daily_closes", "app.models.daily_close", "DailyClose"),
)


def _report_sign_ok(backend, key: str) -> bool:
    """Can the current project mint a link for `key` right now? A real
    signing call with a 60 s TTL — writes nothing. Any error, an empty
    answer or a link on a retired host is False."""
    try:
        signed = backend.signed_url(key, ttl_seconds=REPORT_SIGN_TTL_SECONDS,
                                    timeout=SIGN_TIMEOUT_SECONDS)
    except Exception:  # noqa: BLE001 — "could not sign" is not "signs"
        return False
    return bool(signed and isinstance(signed, str)
                and _host(signed) not in RETIRED_STORAGE_HOSTS)


_REPORT_KEYS = (
    "rows_with_value", "current_host", "retired_host", "other_url", "not_url",
    "retired_after_cutover",
    "retired_resolvable", "retired_signable", "retired_sign_failed",
    "retired_missing", "retired_unchecked", "retired_refused",
)


def storage_link_report(db, *, check_limit: int = 500) -> dict:
    """Aggregate counts only — no ids, keys, paths, hosts or owners.

    Per column, every non-empty receipt_photo (soft-deleted rows included:
    they are retained source documents) is classed as on the current host,
    on a row written on/after RETIRED_CUTOVER is counted apart as
    `retired_after_cutover`: the read paths never re-link it and it uses no
    check budget, but it DOES hold `safe_to_delete_retired_project` false
    (fix round 3). Since fix round 2 no write path stores a new one, so such
    a row was written between the move and that release — most likely a
    REAL photo ("Knyt til eksisterende udgift" on the old code moved a
    pre-move draft's Ireland link onto a newer expense), which would break
    with the project. Each one has to be explained (or fixed) before the
    delete; the flag cannot tell typed junk from a real photo, so it never
    guesses. Every OTHER retired-host value — the legacy
    links — goes through the SAME guards the read paths use
    (retired_link_key) and, when it passes, its object is looked up in the
    current bucket and, when there, signed once (60 s TTL):
      retired_resolvable   the file is there
        retired_signable     … and the current project signs a link for it
        retired_sign_failed  … but signing it failed — the read path would
                               hand out the dead Ireland link
      retired_missing      the guards pass but there is no such file
      retired_unchecked    the lookup could not answer (or check_limit hit)
      retired_refused      the guards refuse it (another owner's key, wrong
                           bucket or kind, no created_at, malformed) —
                           never re-linked
    `unresolvable` = missing + unchecked + refused + sign_failed: what breaks
    when the retired project is deleted. `safe_to_delete_retired_project`
    also requires every legacy row to be signable, so it is proven by this
    call, not by process counters a deploy resets — and
    `retired_after_cutover` to be 0.

    The DB is read first, oldest rows first; the read transaction is then
    ended (nothing is written) so no connection is held during the storage
    calls. Then one existence check and at most one signing call per
    distinct legacy object, at most `check_limit` of each."""
    import importlib
    from app.services.storage import get_storage

    backend = get_storage()
    current = current_storage_host()
    budget = max(0, int(check_limit))
    tables = []
    for table, module, name in _URL_COLUMNS:
        model = getattr(importlib.import_module(module), name)
        col = model.receipt_photo
        c: Counter = Counter()
        refused: Counter = Counter()
        legacy_keys: list[str] = []
        rows = (db.query(model.user_id, col, model.created_at)
                .filter(col.isnot(None), col != "")
                .order_by(model.created_at, model.id)
                .yield_per(500))
        for owner_id, value, created_at in rows:      # DB only — no storage call in here
            c["rows_with_value"] += 1
            v = (value or "").strip()
            if "://" not in v:
                c["not_url"] += 1
                continue
            host = _host(v)
            if host and current and host == current:
                c["current_host"] += 1
                continue
            if host not in RETIRED_STORAGE_HOSTS:
                c["other_url"] += 1
                continue
            c["retired_host"] += 1
            key, reason = retired_link_key(v, owner_id, created_at=created_at)
            if reason == "refused_after_cutover":
                c["retired_after_cutover"] += 1
                continue
            if key is None:
                c["retired_refused"] += 1
                refused[reason] += 1
                continue
            legacy_keys.append(key)
        tables.append((table, c, refused, legacy_keys))
    try:
        db.rollback()          # end the read transaction: no connection held below
    except Exception:  # noqa: BLE001
        pass

    seen: dict[str, str] = {}      # key -> "signable" | "sign_failed" | "missing" | "unchecked"
    columns = []
    totals: Counter = Counter()
    for table, c, refused, legacy_keys in tables:
        for key in legacy_keys:
            if key not in seen:
                if budget <= 0:
                    seen[key] = "unchecked"
                else:
                    budget -= 1
                    try:
                        found = backend.exists(key)
                    except Exception:  # noqa: BLE001 — an error is "could not check"
                        found = None
                    if found is True:
                        seen[key] = "signable" if _report_sign_ok(backend, key) else "sign_failed"
                    elif found is False:
                        seen[key] = "missing"
                    else:
                        seen[key] = "unchecked"
            outcome = seen[key]
            if outcome in ("signable", "sign_failed"):
                c["retired_resolvable"] += 1
                c[f"retired_{outcome}"] += 1
            else:
                c[f"retired_{outcome}"] += 1
        row = {"table": table, "column": "receipt_photo"}
        for k in _REPORT_KEYS:
            row[k] = c[k]
        row["retired_refused_by_reason"] = dict(refused)
        columns.append(row)
        totals.update({k: v for k, v in row.items() if isinstance(v, int)})
    unresolvable = (totals["retired_missing"] + totals["retired_unchecked"]
                    + totals["retired_refused"] + totals["retired_sign_failed"])
    legacy = totals["retired_host"] - totals["retired_after_cutover"]
    durable = bool(getattr(backend, "is_durable", False))
    retired_configured = configured_project_is_retired()
    return {
        "durable_storage": durable,
        "configured_project_is_retired": retired_configured,
        "retired_cutover": RETIRED_CUTOVER.date().isoformat(),
        "columns": columns,
        "totals": {k: totals[k] for k in _REPORT_KEYS},
        "objects_checked": len([k for k, v in seen.items() if v != "unchecked"]),
        "unresolvable": unresolvable,
        # True only when every legacy retired-host row is re-linked to a file
        # that exists in the current project AND the current project signed
        # a link for it in this very call, AND no row written after the
        # cutover still links to the retired project (never re-linked, so it
        # would break with it; each one is explained first) — the
        # precondition for deleting the retired one.
        "safe_to_delete_retired_project": bool(durable and not retired_configured
                                               and unresolvable == 0
                                               and totals["retired_after_cutover"] == 0
                                               and totals["retired_signable"] == legacy),
        "relink_stats": relink_stats(),
    }
