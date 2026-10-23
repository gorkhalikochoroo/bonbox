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
  • write — the result is never assigned to an ORM attribute (an autoflush
    would store it). Stored values, _content_signature / doc_sig, audit rows
    and the revisor package all keep reading the raw column.
  • fetch from the retired host — it only signs in the current project.
  • log a path, key or token — hosts, sources and reason codes only.

Signing happens in the request path, so it is bounded: a short per-call
timeout, a failure returns the stored value (no worse than before), and an
in-process LRU keeps one URL per object for 30 days (the URL itself is valid
for a year), so a list endpoint asks Supabase once per object per process;
after a failure the object is not asked again for 5 minutes.
`relink_stats()` counts what happened, for /api/admin/storage-links: before
the retired project is deleted, `sign_failed` and every `refused_*` must be 0.
"""
from __future__ import annotations

import logging
import threading
import time
from collections import Counter, OrderedDict
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

SIGN_TIMEOUT_SECONDS = 3.0
CACHE_MAX_ENTRIES = 1024
CACHE_FRESH_SECONDS = 30 * 24 * 60 * 60
# After a failed signing, the same object is not asked again for this long:
# a slow or failing Supabase then costs one short timeout per object per
# 5 minutes, not one per object per read.
SIGN_FAIL_BACKOFF_SECONDS = 5 * 60
_MAX_NOTED_HOSTS = 100

_OBJECT_PREFIX = "/storage/v1/object/"
_ACCESS_SEGMENTS = ("sign", "public", "authenticated")

_lock = threading.Lock()
_cache: "OrderedDict[str, tuple[str, float]]" = OrderedDict()
_stats: Counter = Counter()
_failed: "OrderedDict[str, float]" = OrderedDict()
_noted: set[tuple[str, str]] = set()


def _host(url: str) -> str | None:
    try:
        h = urlsplit(url).hostname
    except ValueError:
        return None
    return h.lower() if h else None


def current_storage_host() -> str | None:
    """Host of the project the app stores in now (settings.SUPABASE_URL)."""
    return _host((settings.SUPABASE_URL or "").strip())


def configured_project_is_retired() -> bool:
    """True when SUPABASE_URL itself names a retired project — new uploads
    would then be signed on a host that is going away."""
    return current_storage_host() in RETIRED_STORAGE_HOSTS


def _note(reason: str, source: str, host: str | None = None) -> None:
    """Count, and log ONCE per (reason, source) per process. Never a path,
    key or token: the host (for a foreign URL), the source and the reason."""
    with _lock:
        _stats[reason] += 1
        mark = (reason, f"{source}|{host or ''}")
        if mark in _noted or len(_noted) >= _MAX_NOTED_HOSTS:
            return
        _noted.add(mark)
    if host:
        logger.warning("receipt link left as stored: reason=%s source=%s host=%s",
                       reason, source or "-", host[:100])
    else:
        logger.warning("receipt link left as stored: reason=%s source=%s",
                       reason, source or "-")


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


def retired_link_key(stored: str | None, owner_id) -> tuple[str | None, str]:
    """For a URL on a retired host: (key, "ok") when it may be re-linked to
    the same object in the current bucket, else (None, reason). Pure — no
    storage call; /api/admin/storage-links uses it to count the same way the
    read paths decide."""
    s = (stored or "").strip()
    if not s or "://" not in s:
        return None, "not_a_url"
    if _host(s) not in RETIRED_STORAGE_HOSTS:
        return None, "not_retired_host"
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
    now = time.monotonic()
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
    now = time.monotonic()
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
        _failed[key] = time.monotonic()
        _failed.move_to_end(key)
        while len(_failed) > CACHE_MAX_ENTRIES:
            _failed.popitem(last=False)


def _remember(key: str, url: str) -> None:
    with _lock:
        _cache[key] = (url, time.monotonic())
        _cache.move_to_end(key)
        while len(_cache) > CACHE_MAX_ENTRIES:
            _cache.popitem(last=False)
        _stats["relinked"] += 1
        _failed.pop(key, None)


def client_receipt_ref(stored: str | None, owner_id, *, source: str = "") -> str | None:
    """The receipt reference to hand a client for `stored` on a row owned by
    `owner_id`. NEVER writes, never fetches from a retired host; on any doubt
    returns `stored` unchanged. `source` ('expenses', 'sales', 'daily_closes')
    only labels the log line."""
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
    key, reason = retired_link_key(s, owner_id)
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
    owner is read from what the model was built from (the ORM row's user_id,
    or a dict's); without one nothing is re-linked. The source object — the
    ORM row — is only read, never assigned."""
    stored = getattr(model, "receipt_photo", None)
    if not stored or isinstance(data, type(model)):
        return model                    # nothing stored, or already built (re-validation)
    owner = data.get("user_id") if isinstance(data, dict) else getattr(data, "user_id", None)
    out = client_receipt_ref(stored, owner, source=source)
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


# ─── /api/admin/storage-links: is every retired-host photo resolvable? ──

# (table, model module, model class) — the three columns that store a receipt URL
# (investigation 23 Oct: a scan of every text/json column found no others).
_URL_COLUMNS = (
    ("expenses", "app.models.expense", "Expense"),
    ("sales", "app.models.sale", "Sale"),
    ("daily_closes", "app.models.daily_close", "DailyClose"),
)


def storage_link_report(db, *, check_limit: int = 500) -> dict:
    """Aggregate counts only — no ids, keys, paths, hosts or owners.

    Per column, every non-empty receipt_photo (soft-deleted rows included:
    they are retained source documents) is classed as on the current host,
    on a retired host, on another host, or not a URL. Each retired-host value
    is put through the SAME guards the read paths use (retired_link_key) and,
    when it passes, its object is looked up in the current bucket:
      retired_resolvable   the file is there — the read paths re-link it
      retired_missing      the guards pass but there is no such file
      retired_unchecked    the lookup could not answer (or check_limit hit)
      retired_refused      the guards refuse it (another owner's key, wrong
                           bucket or kind, malformed) — never re-linked
    `unresolvable` = missing + unchecked + refused: what breaks when the
    retired project is deleted. Read-only: one storage listing per distinct
    object, no writes."""
    import importlib
    from app.services.storage import get_storage

    backend = get_storage()
    current = current_storage_host()
    seen: dict[str, bool | None] = {}
    budget = max(0, int(check_limit))
    columns = []
    totals: Counter = Counter()
    for table, module, name in _URL_COLUMNS:
        model = getattr(importlib.import_module(module), name)
        col = model.receipt_photo
        c: Counter = Counter()
        refused: Counter = Counter()
        rows = (db.query(model.user_id, col)
                .filter(col.isnot(None), col != "")
                .yield_per(500))
        for owner_id, value in rows:
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
            key, reason = retired_link_key(v, owner_id)
            if key is None:
                c["retired_refused"] += 1
                refused[reason] += 1
                continue
            if key not in seen:
                if budget <= 0:
                    found = None
                else:
                    budget -= 1
                    try:
                        found = backend.exists(key)
                    except Exception:  # noqa: BLE001 — an error is "could not check"
                        found = None
                seen[key] = found
            found = seen[key]
            if found is True:
                c["retired_resolvable"] += 1
            elif found is False:
                c["retired_missing"] += 1
            else:
                c["retired_unchecked"] += 1
        row = {"table": table, "column": "receipt_photo"}
        for k in ("rows_with_value", "current_host", "retired_host", "other_url", "not_url",
                  "retired_resolvable", "retired_missing", "retired_unchecked", "retired_refused"):
            row[k] = c[k]
        row["retired_refused_by_reason"] = dict(refused)
        columns.append(row)
        totals.update({k: v for k, v in row.items() if isinstance(v, int)})
    unresolvable = (totals["retired_missing"] + totals["retired_unchecked"]
                    + totals["retired_refused"])
    durable = bool(getattr(backend, "is_durable", False))
    retired_configured = configured_project_is_retired()
    return {
        "durable_storage": durable,
        "configured_project_is_retired": retired_configured,
        "columns": columns,
        "totals": {k: totals[k] for k in (
            "rows_with_value", "current_host", "retired_host", "other_url", "not_url",
            "retired_resolvable", "retired_missing", "retired_unchecked", "retired_refused")},
        "objects_checked": len([k for k, v in seen.items() if v is not None]),
        "unresolvable": unresolvable,
        # True only when every retired-host row is re-linked to a file that
        # exists in the current project — the precondition for deleting the
        # retired one. Also check relink_stats: sign_failed must be 0.
        "safe_to_delete_retired_project": bool(durable and not retired_configured
                                               and unresolvable == 0),
        "relink_stats": relink_stats(),
    }
