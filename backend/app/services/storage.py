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
ALLOWED_KINDS = {"kasserapport", "inventory_import", "expense", "sale"}


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
