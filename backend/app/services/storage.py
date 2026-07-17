"""Storage abstraction — durable receipt/image persistence.

Two backends, selected by env at boot:
  • SupabaseStorageBackend — when SUPABASE_SERVICE_KEY is set. Uploads
    to a private Supabase Storage bucket. Survives Render redeploys
    (Render's local disk is ephemeral on free/starter tiers).
  • LocalStorageBackend — fallback for local dev. Same interface,
    files written to ./uploads/<bucket>/<key>.

Why this matters:
  • Bogføringsloven §10 requires retaining accounting source documents
    for 5 years. Kasserapport photos ARE source documents (the only
    copy of the closing report). Local-disk storage on ephemeral
    infra would silently lose them on every redeploy.
  • Owners need to re-view receipts when an extracted number looks
    wrong — without the original image, they're stuck.

Path convention (enforced by `compose_key`):
  <user_id>/<kind>/<sha256_hex>.<ext>

The user_id prefix is the LAST line of defense — even if a backend
read leaks across users at the API layer, the storage path itself
ties every blob to one owner. The kasserapport / smart-import
routers MUST query by row.user_id == request_user.id BEFORE serving;
the path prefix is a belt-and-braces check on top.

Public surface:
  get_storage() -> StorageBackend                  # singleton
  compose_key(user_id, kind, sha, ext) -> str      # path builder
  StorageBackend.put(key, data, content_type) -> str
  StorageBackend.get(key) -> bytes | None
  StorageBackend.delete(key) -> bool
  StorageBackend.is_durable -> bool                # Supabase=True, Local=False
"""
from __future__ import annotations

import logging
import os
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


# ─── Path helper ───────────────────────────────────────────────────────

# Allowed kinds — keeps the path namespace tidy and constrains an
# attacker who somehow forges a kind to a closed enum.
ALLOWED_KINDS = {
    "kasserapport", "inventory_import", "expense", "sale", "business_logo",
    "staff_chat", "staff_avatar", "floor_background",
}


def compose_key(user_id, kind: str, sha: str, ext: str = "jpg") -> str:
    """Build a storage key. Validates inputs to prevent path traversal
    or sneaky writes outside the per-user prefix."""
    if kind not in ALLOWED_KINDS:
        raise ValueError(f"Unknown storage kind: {kind!r}")
    # SHA must be hex-only — no slashes, no dots, no traversal vectors.
    if not sha or not all(c in "0123456789abcdef" for c in sha.lower()):
        raise ValueError("sha must be lowercase hex")
    # Extension is enum-like.
    if ext not in {"jpg", "jpeg", "png", "webp", "heic"}:
        raise ValueError(f"Unsupported ext: {ext!r}")
    uid = str(user_id)
    # uuid4 string with hyphens, or all-hex; reject anything weirder.
    if not all(c in "0123456789abcdef-" for c in uid.lower()):
        raise ValueError("user_id must be UUID-shaped")
    return f"{uid}/{kind}/{sha[:64]}.{ext}"


# ─── Backend interface ─────────────────────────────────────────────────

class StorageBackend(ABC):
    is_durable: bool = False

    @abstractmethod
    def put(self, key: str, data: bytes, content_type: str = "image/jpeg") -> str:
        """Persist bytes at `key`. Returns the storage path/URL handle
        we'll save to the DB row."""

    @abstractmethod
    def get(self, key: str) -> bytes | None:
        """Read bytes at `key`. Returns None if not found."""

    @abstractmethod
    def delete(self, key: str) -> bool:
        """Delete blob at `key`. Returns True iff something was removed."""

    def delete_prefix(self, prefix: str) -> int:
        """Delete every object directly under `prefix` (e.g. '<uid>/<kind>').

        Used by GDPR account erasure to remove a user's blobs by path
        (independent of whether the DB rows that pointed at them still
        exist). Best-effort: returns the count removed, never raises.
        Default no-op; overridden per backend.
        """
        return 0

    def signed_url(self, key: str, ttl_seconds: int = 3600) -> str | None:
        """Return a time-limited URL the browser can fetch directly.

        Used by the legacy expense/sale receipt-photo flow which stores
        a URL (not a key) in the DB. Backends that don't natively
        support signed URLs return None — caller falls back to backend-
        proxied serving via the regular GET endpoint.

        Default implementation returns None; override per backend.
        """
        return None


# ─── Supabase backend (production) ─────────────────────────────────────

class SupabaseStorageBackend(StorageBackend):
    """Uses Supabase Storage REST API directly via httpx — no extra
    SDK dep. Service-role key goes only on the backend; never sent to
    a browser. Bucket is configured PRIVATE so the only way to read is
    via this server.

    Defense relevance:
      • Service-role key is server-only (env var, never in client JS).
      • All reads go through our backend's auth + tenant gate.
      • Storage path keyed on user_id so a successful direct-bucket
        read (e.g. via leaked service key) still scopes by owner.
    """
    is_durable = True

    def __init__(self, url: str, service_key: str, bucket: str):
        self.base = url.rstrip("/") + "/storage/v1"
        self.bucket = bucket
        self._headers = {
            "Authorization": f"Bearer {service_key}",
            "apikey": service_key,
        }
        # Connection pool with sane timeouts. 30s upload covers a 10MB
        # JPEG over a slow connection; reads are usually sub-second.
        self._client = httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0))

    def put(self, key: str, data: bytes, content_type: str = "image/jpeg") -> str:
        """Upload bytes. Returns the storage key (not a public URL —
        downstream code calls .get() through the backend)."""
        url = f"{self.base}/object/{self.bucket}/{key}"
        headers = {**self._headers, "Content-Type": content_type, "x-upsert": "true"}
        resp = self._client.post(url, content=data, headers=headers)
        if resp.status_code >= 400:
            raise StorageError(
                f"Supabase upload failed: {resp.status_code} {resp.text[:200]}"
            )
        return key

    def get(self, key: str) -> bytes | None:
        url = f"{self.base}/object/{self.bucket}/{key}"
        try:
            resp = self._client.get(url, headers=self._headers)
        except httpx.HTTPError as e:
            logger.warning("Supabase storage GET failed for %s: %s", key, e)
            return None
        if resp.status_code == 404:
            return None
        if resp.status_code >= 400:
            logger.warning("Supabase storage GET %s -> %s", key, resp.status_code)
            return None
        return resp.content

    def delete(self, key: str) -> bool:
        url = f"{self.base}/object/{self.bucket}/{key}"
        resp = self._client.delete(url, headers=self._headers)
        return resp.status_code < 400

    def delete_prefix(self, prefix: str) -> int:
        """List and bulk-remove every object under `<prefix>/`. Keys are
        `<uid>/<kind>/<sha>.<ext>`, so `prefix='<uid>/<kind>'` lists the leaf
        files directly. Paginates; best-effort (logs, never raises)."""
        folder = prefix.rstrip("/")
        removed = 0
        try:
            offset = 0
            while True:
                lr = self._client.post(
                    f"{self.base}/object/list/{self.bucket}",
                    json={"prefix": folder, "limit": 1000, "offset": offset,
                          "sortBy": {"column": "name", "order": "asc"}},
                    headers=self._headers,
                )
                if lr.status_code >= 400:
                    logger.warning("Supabase list %s -> %s", folder, lr.status_code)
                    break
                items = lr.json() or []
                names = [it.get("name") for it in items if it.get("name")]
                if not names:
                    break
                keys = [f"{folder}/{n}" for n in names]
                dr = self._client.request(
                    "DELETE", f"{self.base}/object/{self.bucket}",
                    json={"prefixes": keys}, headers=self._headers,
                )
                if dr.status_code < 400:
                    removed += len(keys)
                else:
                    logger.warning("Supabase bulk-delete %s -> %s", folder, dr.status_code)
                if len(names) < 1000:
                    break
                offset += 1000
        except Exception as e:  # noqa: BLE001 — erasure must never break on storage
            logger.warning("delete_prefix(%s) failed: %s", folder, e)
        return removed

    def signed_url(self, key: str, ttl_seconds: int = 3600) -> str | None:
        """Generate a signed URL valid for `ttl_seconds`. Used by the
        legacy receipt_photo flow that stores a URL string in DB.

        Supabase returns a path like `/object/sign/<bucket>/<key>?token=...`
        — we prefix with the project URL so the result is browser-fetchable
        as-is. Returns None on failure (caller falls back to local path /
        backend proxy)."""
        url = f"{self.base}/object/sign/{self.bucket}/{key}"
        try:
            resp = self._client.post(
                url,
                json={"expiresIn": int(ttl_seconds)},
                headers=self._headers,
            )
        except httpx.HTTPError as e:
            logger.warning("Supabase signed_url failed for %s: %s", key, e)
            return None
        if resp.status_code >= 400:
            logger.warning(
                "Supabase signed_url %s -> %s: %s",
                key, resp.status_code, resp.text[:200],
            )
            return None
        data = resp.json()
        signed = data.get("signedURL") or data.get("signed_url") or ""
        if not signed:
            return None
        # Supabase returns the path portion; prefix with project URL.
        if signed.startswith("/"):
            base_root = self.base.rsplit("/storage/v1", 1)[0]
            return f"{base_root}/storage/v1{signed}"
        return signed


# ─── Local backend (dev fallback) ──────────────────────────────────────

class LocalStorageBackend(StorageBackend):
    """Writes to ./uploads/<bucket>/<key>. Files do NOT survive a
    Render redeploy on free/starter tiers; this backend is for local
    dev only. Production sets SUPABASE_SERVICE_KEY and uses the
    Supabase backend instead."""
    is_durable = False

    def __init__(self, root: Path, bucket: str):
        self.root = root / bucket
        self.root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, key: str) -> Path:
        """Defense: resolve the key path then assert it stays inside
        self.root (path traversal guard)."""
        p = (self.root / key).resolve()
        try:
            p.relative_to(self.root.resolve())
        except ValueError:
            raise StorageError("Path traversal attempt") from None
        return p

    def put(self, key: str, data: bytes, content_type: str = "image/jpeg") -> str:
        p = self._resolve(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return key

    def get(self, key: str) -> bytes | None:
        try:
            p = self._resolve(key)
        except StorageError:
            return None
        if not p.exists() or not p.is_file():
            return None
        return p.read_bytes()

    def delete(self, key: str) -> bool:
        try:
            p = self._resolve(key)
        except StorageError:
            return False
        if p.exists():
            p.unlink()
            return True
        return False

    def delete_prefix(self, prefix: str) -> int:
        """Delete every file under the `<prefix>/` directory. Best-effort."""
        removed = 0
        try:
            folder = self._resolve(prefix.rstrip("/"))
        except StorageError:
            return 0
        if folder.exists() and folder.is_dir():
            for f in folder.rglob("*"):
                if f.is_file():
                    try:
                        f.unlink()
                        removed += 1
                    except OSError:
                        pass
        return removed


class StorageError(Exception):
    """Raised by storage backends on operational failure."""


# ─── Singleton selector ────────────────────────────────────────────────

_backend: StorageBackend | None = None


def get_storage() -> StorageBackend:
    """Return the active storage backend. Lazy-initialized + cached."""
    global _backend
    if _backend is not None:
        return _backend

    url = (settings.SUPABASE_URL or "").strip()
    service_key = (settings.SUPABASE_SERVICE_KEY or "").strip()
    bucket = (settings.SUPABASE_RECEIPTS_BUCKET or "receipts").strip()

    if url and service_key:
        logger.info("Storage: SupabaseStorageBackend bucket=%s", bucket)
        _backend = SupabaseStorageBackend(url, service_key, bucket)
    else:
        root = Path(os.getenv("LOCAL_UPLOADS_ROOT", "uploads"))
        logger.info(
            "Storage: LocalStorageBackend root=%s (set SUPABASE_SERVICE_KEY for durable storage)",
            root,
        )
        _backend = LocalStorageBackend(root, bucket)
    return _backend


def reset_storage_for_tests() -> None:
    """Test helper — wipe the cached singleton so a test can swap
    backends. NEVER call from production code."""
    global _backend
    _backend = None


# ─── GDPR erasure helper ───────────────────────────────────────────────

# Storage kinds with NO legal retention basis — purged on account erasure
# (GDPR Art.17). The accounting source-document kinds (kasserapport /
# expense / sale / inventory_import) are deliberately EXCLUDED: they are
# retained for 5 years under Bogføringsloven §10, then deleted. Keep this
# in sync with the retention disclosure in the delete-account response +
# PrivacyPolicyPage.
ERASURE_PURGE_KINDS = frozenset({
    "staff_chat", "staff_avatar", "business_logo",
    # A photo of the owner's real premises (possibly staff/guests in frame) with no
    # accounting-retention basis — purged on GDPR Art.17 erasure like the logo.
    "floor_background",
})


def purge_user_blobs(user_id, kinds=ERASURE_PURGE_KINDS) -> int:
    """Delete a user's storage blobs for the given kinds (default: the
    no-retention-basis kinds). Best-effort — returns the count removed and
    never raises, so a storage hiccup can't abort GDPR account erasure."""
    backend = get_storage()
    uid = str(user_id)
    total = 0
    for kind in kinds:
        if kind not in ALLOWED_KINDS:
            continue
        try:
            total += backend.delete_prefix(f"{uid}/{kind}")
        except Exception:  # noqa: BLE001 — never break erasure on one kind
            logger.warning("purge_user_blobs: failed on kind=%s", kind, exc_info=True)
    return total
