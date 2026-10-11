"""Bucket clients for the off-project backup.

Two implementations of one small interface:
  • SupabaseBucket — Supabase Storage REST (httpx, like services/storage). Used
    for the SOURCE bucket (main project, "receipts") and the DESTINATION bucket
    (the separate backup project).
  • LocalDirBucket — a directory. Used by tests and for an offline restore
    drill from a downloaded copy.

Contract that the backup job relies on (services/backup_service):
  • list_all() returns the COMPLETE recursive listing or raises
    BackupStorageError. It never returns a partial list: a partial list would
    make every unlisted object look "deleted in source". A folder is paged
    until the API returns an EMPTY page (a short page is not taken as the
    end: the server may cap the page size below LIST_PAGE).
  • download() returns None only for "not found"; any other failure raises.
  • upload()/delete_many() raise on failure.
Errors carry status codes and short bodies, never the service key.
"""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Iterable

import httpx

# A Supabase "folder" is materialised by this zero-byte placeholder when it is
# created in the dashboard. It is not data.
_PLACEHOLDER = ".emptyFolderPlaceholder"

LIST_PAGE = 1000
MAX_LIST_CALLS = 20_000
MAX_LISTED_OBJECTS = 1_000_000
STREAM_BLOCK = 1 << 20


class BackupStorageError(RuntimeError):
    pass


class ObjectExistsError(BackupStorageError):
    """upload(upsert=False) onto a key that already holds an object."""


@dataclass(frozen=True)
class ObjectInfo:
    key: str
    size: int | None
    etag: str | None
    created_at: datetime | None
    updated_at: datetime | None


def _parse_ts(value) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


class SupabaseBucket:
    """One bucket of one Supabase project, via the Storage REST API."""

    def __init__(self, url: str, service_key: str, bucket: str, *,
                 timeout: float = 60.0, client: httpx.Client | None = None):
        if not url or not service_key or not bucket:
            raise BackupStorageError("bucket client needs url, key and bucket")
        self.base = url.rstrip("/") + "/storage/v1"
        self.bucket = bucket
        self._headers = {"Authorization": f"Bearer {service_key}", "apikey": service_key}
        self._client = client or httpx.Client(timeout=httpx.Timeout(timeout, connect=10.0))

    def _err(self, what: str, resp: httpx.Response) -> BackupStorageError:
        body = (resp.text or "")[:200].replace("\n", " ")
        low = body.lower()
        cls = BackupStorageError
        if resp.status_code == 409 or "already exists" in low or "duplicate" in low:
            cls = ObjectExistsError
        return cls(f"{what} -> HTTP {resp.status_code}: {body}")

    # ── listing ──────────────────────────────────────────────────────
    def _list_page(self, prefix: str, offset: int) -> list[dict]:
        resp = self._client.post(
            f"{self.base}/object/list/{self.bucket}",
            json={"prefix": prefix, "limit": LIST_PAGE, "offset": offset,
                  "sortBy": {"column": "name", "order": "asc"}},
            headers=self._headers,
        )
        if resp.status_code >= 400:
            raise self._err(f"list {self.bucket}/{prefix or '.'}", resp)
        items = resp.json()
        if not isinstance(items, list):
            raise BackupStorageError(f"list {self.bucket}: unexpected response shape")
        return items

    def _list_folder(self, prefix: str, budget: list[int]) -> tuple[list[str], list[ObjectInfo]]:
        folders: list[str] = []
        files: list[ObjectInfo] = []
        offset = 0
        while True:
            budget[0] -= 1
            if budget[0] < 0:
                raise BackupStorageError("listing exceeded MAX_LIST_CALLS")
            items = self._list_page(prefix, offset)
            if not items:
                break
            for it in items:
                name = it.get("name")
                if not name or name == _PLACEHOLDER:
                    continue
                full = f"{prefix}/{name}" if prefix else name
                if it.get("id") is None:
                    folders.append(full)
                else:
                    meta = it.get("metadata") or {}
                    size = meta.get("size")
                    files.append(ObjectInfo(
                        key=full,
                        size=int(size) if size is not None else None,
                        etag=(meta.get("eTag") or None),
                        created_at=_parse_ts(it.get("created_at")),
                        updated_at=_parse_ts(it.get("updated_at")),
                    ))
            # Advance by what came back, not by LIST_PAGE, and stop only on an
            # empty page: a server that caps a page below LIST_PAGE would
            # otherwise end the listing early, and every unlisted object
            # would look deleted in the source.
            offset += len(items)
        return folders, files

    def list_folders(self, prefix: str) -> list[str]:
        folders, _ = self._list_folder(prefix.strip("/"), [MAX_LIST_CALLS])
        return folders

    def list_files(self, prefix: str) -> list[ObjectInfo]:
        _, files = self._list_folder(prefix.strip("/"), [MAX_LIST_CALLS])
        return files

    def list_all(self, prefix: str = "") -> list[ObjectInfo]:
        budget = [MAX_LIST_CALLS]
        pending = [prefix.strip("/")]
        out: list[ObjectInfo] = []
        while pending:
            folder = pending.pop()
            sub, files = self._list_folder(folder, budget)
            out.extend(files)
            if len(out) > MAX_LISTED_OBJECTS:
                raise BackupStorageError("listing exceeded MAX_LISTED_OBJECTS")
            pending.extend(sub)
        return out

    # ── bucket ───────────────────────────────────────────────────────
    def bucket_public(self) -> bool:
        """True when the bucket is PUBLIC (anyone with a key path can read
        it). Raises BackupStorageError when it cannot be checked — the caller
        reports "unknown", never "private"."""
        resp = self._client.get(f"{self.base}/bucket/{self.bucket}", headers=self._headers)
        if resp.status_code >= 400:
            raise self._err(f"bucket info {self.bucket}", resp)
        try:
            body = resp.json()
        except ValueError:
            raise BackupStorageError(f"bucket info {self.bucket}: not JSON") from None
        if not isinstance(body, dict) or not isinstance(body.get("public"), bool):
            raise BackupStorageError(f"bucket info {self.bucket}: unexpected response shape")
        return body["public"]

    # ── objects ──────────────────────────────────────────────────────
    @staticmethod
    def _object_missing(resp: httpx.Response) -> bool:
        """Object-not-found (Supabase answers 404, or 400 with a 404 body).
        A missing BUCKET is a configuration error, never "no object"."""
        if resp.status_code not in (400, 404):
            return False
        body = (resp.text or "").lower()
        if "bucket" in body:
            return False
        return resp.status_code == 404 or "not found" in body or "not_found" in body

    def download(self, key: str) -> bytes | None:
        resp = self._client.get(f"{self.base}/object/{self.bucket}/{key}", headers=self._headers)
        if self._object_missing(resp):
            return None
        if resp.status_code >= 400:
            raise self._err(f"download {key}", resp)
        return resp.content

    def download_to(self, key: str, fileobj: BinaryIO) -> bool:
        with self._client.stream("GET", f"{self.base}/object/{self.bucket}/{key}",
                                 headers=self._headers) as resp:
            if resp.status_code >= 400:
                resp.read()
                if self._object_missing(resp):
                    return False
                raise self._err(f"download {key}", resp)
            for block in resp.iter_bytes(STREAM_BLOCK):
                fileobj.write(block)
        return True

    def upload(self, key: str, data: bytes, *, upsert: bool,
               content_type: str = "application/octet-stream") -> None:
        resp = self._client.post(
            f"{self.base}/object/{self.bucket}/{key}", content=data,
            headers={**self._headers, "Content-Type": content_type,
                     "x-upsert": "true" if upsert else "false"},
        )
        if resp.status_code >= 400:
            raise self._err(f"upload {key}", resp)

    def upload_file(self, key: str, fileobj: BinaryIO, size: int, *, upsert: bool) -> None:
        """Stream `size` bytes from fileobj's current position. Content-Length is
        set explicitly, so httpx sends a plain (not chunked) body and memory
        stays at one STREAM_BLOCK."""
        def _body():
            left = size
            while left > 0:
                block = fileobj.read(min(STREAM_BLOCK, left))
                if not block:
                    raise BackupStorageError(f"upload {key}: source ended early")
                left -= len(block)
                yield block

        resp = self._client.post(
            f"{self.base}/object/{self.bucket}/{key}", content=_body(),
            headers={**self._headers, "Content-Type": "application/octet-stream",
                     "Content-Length": str(size),
                     "x-upsert": "true" if upsert else "false"},
        )
        if resp.status_code >= 400:
            raise self._err(f"upload {key}", resp)

    def delete_many(self, keys: Iterable[str]) -> None:
        keys = list(keys)
        for i in range(0, len(keys), 500):
            batch = keys[i:i + 500]
            resp = self._client.request(
                "DELETE", f"{self.base}/object/{self.bucket}",
                json={"prefixes": batch}, headers=self._headers,
            )
            if resp.status_code >= 400:
                raise self._err(f"delete {len(batch)} objects", resp)


class LocalDirBucket:
    """The same interface over a directory (tests, offline restore drills)."""

    def __init__(self, root: str | os.PathLike):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.bucket = self.root.name

    def _path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        try:
            p.relative_to(self.root.resolve())
        except ValueError:
            raise BackupStorageError("key escapes the bucket root") from None
        return p

    def _info(self, p: Path) -> ObjectInfo:
        st = p.stat()
        key = p.relative_to(self.root).as_posix()
        etag = hashlib.md5(f"{st.st_size}:{st.st_mtime_ns}".encode()).hexdigest()  # noqa: S324 — change marker, not security
        ts = datetime.fromtimestamp(st.st_mtime, timezone.utc).replace(tzinfo=None)
        return ObjectInfo(key=key, size=st.st_size, etag=etag, created_at=ts, updated_at=ts)

    def list_all(self, prefix: str = "") -> list[ObjectInfo]:
        base = self._path(prefix.strip("/")) if prefix.strip("/") else self.root
        if not base.exists():
            return []
        return sorted((self._info(p) for p in base.rglob("*")
                       if p.is_file() and p.name != _PLACEHOLDER), key=lambda o: o.key)

    def list_folders(self, prefix: str) -> list[str]:
        base = self._path(prefix.strip("/"))
        if not base.exists():
            return []
        return sorted(p.relative_to(self.root).as_posix() for p in base.iterdir() if p.is_dir())

    def list_files(self, prefix: str) -> list[ObjectInfo]:
        base = self._path(prefix.strip("/"))
        if not base.exists():
            return []
        return sorted((self._info(p) for p in base.iterdir() if p.is_file()), key=lambda o: o.key)

    def bucket_public(self) -> bool:
        return False            # a local directory is never public

    def download(self, key: str) -> bytes | None:
        p = self._path(key)
        return p.read_bytes() if p.is_file() else None

    def download_to(self, key: str, fileobj: BinaryIO) -> bool:
        p = self._path(key)
        if not p.is_file():
            return False
        with p.open("rb") as f:
            while True:
                block = f.read(STREAM_BLOCK)
                if not block:
                    break
                fileobj.write(block)
        return True

    def upload(self, key: str, data: bytes, *, upsert: bool,
               content_type: str = "application/octet-stream") -> None:
        p = self._path(key)              # (content_type: a directory keeps none)
        if p.exists() and not upsert:
            raise ObjectExistsError(f"upload {key} -> HTTP 409: already exists")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def upload_file(self, key: str, fileobj: BinaryIO, size: int, *, upsert: bool) -> None:
        p = self._path(key)
        if p.exists() and not upsert:
            raise ObjectExistsError(f"upload {key} -> HTTP 409: already exists")
        p.parent.mkdir(parents=True, exist_ok=True)
        left = size
        with p.open("wb") as out:
            while left > 0:
                block = fileobj.read(min(STREAM_BLOCK, left))
                if not block:
                    raise BackupStorageError(f"upload {key}: source ended early")
                out.write(block)
                left -= len(block)

    def delete_many(self, keys: Iterable[str]) -> None:
        root = self.root.resolve()
        for k in keys:
            p = self._path(k)
            if p.is_file():
                p.unlink()
            # Like Supabase, a folder exists only while it holds objects.
            parent = p.parent
            while parent != root and parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()
                parent = parent.parent
