"""Client-side encryption for the off-project backup (services/backup_service).

Everything that leaves BonBox for the backup project is encrypted HERE, before
upload, with a key the backup project never sees (BACKUP_ENCRYPTION_KEY). A
leaked backup-project service key therefore yields ciphertext only.

Primitive: Fernet (AES-128-CBC + HMAC-SHA256), the same recipe app/utils/crypto
uses for bank tokens — no new dependency, no hand-rolled cipher. Fernet is not
a streaming cipher, so a stream is cut into frames of at most CHUNK_BYTES of
plaintext, each its own Fernet token. Framing alone would let an attacker drop,
reorder, truncate or splice frames between files, so every frame's plaintext
starts with (file_id, sequence number, final flag) and the reader checks all
three:

    file   = MAGIC "BBK1" | version (1 byte) | file_id (16 random bytes)
             | frame*
    frame  = length (4 bytes, big-endian) | Fernet token
    token plaintext = file_id (16) | seq (8, big-endian) | final (1) | data

A stream that ends without a final frame, has bytes after it, skips or repeats
a sequence number, or carries another file's frame is rejected. Memory stays
bounded: the writer holds at most one frame of plaintext, the reader one token.

The key must be a real Fernet key (Fernet.generate_key()). Unlike
APP_SECRET_KEY there is no "derive a key from any string" fallback: a backup
key that was silently derived from a typo would be discovered at restore time,
which is the worst possible time. BACKUP_ENCRYPTION_KEY_PREVIOUS (optional)
keeps older backups readable after a rotation.
"""
from __future__ import annotations

import io
import os
import struct
from typing import BinaryIO, Iterator

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

MAGIC = b"BBK1"
FORMAT_VERSION = 1
_HEADER = struct.Struct(">4sB16s")
_FRAME_LEN = struct.Struct(">I")
_CHUNK_HDR = struct.Struct(">16sQB")

CHUNK_BYTES = 1 << 20            # 1 MiB of plaintext per frame
MAX_TOKEN_BYTES = 8 << 20        # reader refuses a frame longer than this


class BackupConfigError(RuntimeError):
    """The backup key is missing or not a Fernet key. Never carries the value."""


class BackupCryptoError(RuntimeError):
    """A backup stream failed authentication or framing checks."""


def load_backup_fernet(primary: str, previous: str = "") -> MultiFernet:
    """MultiFernet for BACKUP_ENCRYPTION_KEY (+ optional previous key).

    Encrypts with `primary`; decrypts with either. Strict: a value that is not
    a Fernet key raises BackupConfigError (the message names the variable,
    never the value)."""
    keys = []
    for name, value in (("BACKUP_ENCRYPTION_KEY", primary),
                        ("BACKUP_ENCRYPTION_KEY_PREVIOUS", previous)):
        value = (value or "").strip()
        if not value:
            if name == "BACKUP_ENCRYPTION_KEY":
                raise BackupConfigError("BACKUP_ENCRYPTION_KEY is not set")
            continue
        try:
            keys.append(Fernet(value.encode("ascii")))
        except (ValueError, TypeError, UnicodeEncodeError):
            raise BackupConfigError(
                f"{name} is not a Fernet key (generate one with "
                "Fernet.generate_key())"
            ) from None
    return MultiFernet(keys)


class EncryptingWriter(io.RawIOBase):
    """Write-only file object: plaintext in, framed ciphertext out to `sink`.

    close() writes the final frame; it does NOT close `sink` (the caller owns
    it). `bytes_in` / `bytes_out` count plaintext and ciphertext."""

    def __init__(self, sink: BinaryIO, fernet: MultiFernet, chunk_bytes: int = CHUNK_BYTES):
        super().__init__()
        if chunk_bytes <= 0:
            raise ValueError("chunk_bytes must be positive")
        self._sink = sink
        self._fernet = fernet
        self._chunk = chunk_bytes
        self._buf = bytearray()
        self._seq = 0
        self._file_id = os.urandom(16)
        self.bytes_in = 0
        self.bytes_out = 0
        header = _HEADER.pack(MAGIC, FORMAT_VERSION, self._file_id)
        sink.write(header)
        self.bytes_out += len(header)

    def writable(self) -> bool:
        return True

    def write(self, b) -> int:
        if self.closed:
            raise ValueError("write to closed EncryptingWriter")
        mv = memoryview(b).cast("B")
        n = len(mv)
        self._buf += mv
        self.bytes_in += n
        # Strictly greater: the frame that empties the buffer is emitted by
        # close() with the final flag, so the last frame is always final.
        while len(self._buf) > self._chunk:
            self._emit(bytes(self._buf[: self._chunk]), final=False)
            del self._buf[: self._chunk]
        return n

    def _emit(self, data: bytes, *, final: bool) -> None:
        token = self._fernet.encrypt(
            _CHUNK_HDR.pack(self._file_id, self._seq, 1 if final else 0) + data
        )
        frame = _FRAME_LEN.pack(len(token)) + token
        self._sink.write(frame)
        self.bytes_out += len(frame)
        self._seq += 1

    def close(self) -> None:
        if not self.closed:
            self._emit(bytes(self._buf), final=True)
            self._buf = bytearray()
            try:
                self._sink.flush()
            except Exception:  # noqa: BLE001 — sinks without flush
                pass
        super().close()


def _read_exact(src: BinaryIO, n: int) -> bytes:
    out = bytearray()
    while len(out) < n:
        chunk = src.read(n - len(out))
        if not chunk:
            break
        out += chunk
    return bytes(out)


def iter_decrypt(src: BinaryIO, fernet: MultiFernet) -> Iterator[bytes]:
    """Yield the plaintext of each frame of `src`, checking every invariant.

    Raises BackupCryptoError on a wrong key, tampering, truncation, reordering,
    a foreign frame or trailing bytes. The check for "final frame present"
    happens when the iterator is exhausted, so callers must drain it (see
    DecryptingReader.verify_complete)."""
    header = _read_exact(src, _HEADER.size)
    if len(header) != _HEADER.size:
        raise BackupCryptoError("not a backup stream (short header)")
    magic, version, file_id = _HEADER.unpack(header)
    if magic != MAGIC:
        raise BackupCryptoError("not a backup stream (bad magic)")
    if version != FORMAT_VERSION:
        raise BackupCryptoError(f"unsupported backup format version {version}")
    seq = 0
    saw_final = False
    while True:
        raw_len = _read_exact(src, _FRAME_LEN.size)
        if not raw_len:
            break
        if saw_final:
            raise BackupCryptoError("data after the final frame")
        if len(raw_len) != _FRAME_LEN.size:
            raise BackupCryptoError("truncated frame length")
        (n,) = _FRAME_LEN.unpack(raw_len)
        if n == 0 or n > MAX_TOKEN_BYTES:
            raise BackupCryptoError("implausible frame length")
        token = _read_exact(src, n)
        if len(token) != n:
            raise BackupCryptoError("truncated frame")
        try:
            plain = fernet.decrypt(token)
        except InvalidToken:
            raise BackupCryptoError(
                "frame failed authentication (wrong key or tampered data)"
            ) from None
        if len(plain) < _CHUNK_HDR.size:
            raise BackupCryptoError("frame too short")
        fid, fseq, final = _CHUNK_HDR.unpack_from(plain)
        if fid != file_id:
            raise BackupCryptoError("frame belongs to another backup file")
        if fseq != seq:
            raise BackupCryptoError("frames out of order or missing")
        seq += 1
        saw_final = bool(final)
        data = plain[_CHUNK_HDR.size:]
        if data:
            yield data
    if not saw_final:
        raise BackupCryptoError("truncated backup stream (final frame missing)")


class DecryptingReader(io.RawIOBase):
    """Read-only file object over a framed ciphertext stream."""

    def __init__(self, src: BinaryIO, fernet: MultiFernet):
        super().__init__()
        self._it = iter_decrypt(src, fernet)
        self._buf = b""
        self._pos = 0
        self._eof = False
        self.bytes_out = 0

    def readable(self) -> bool:
        return True

    def readinto(self, b) -> int:
        while self._pos >= len(self._buf):
            if self._eof:
                return 0
            try:
                self._buf = next(self._it)
                self._pos = 0
            except StopIteration:
                self._eof = True
                self._buf = b""
                self._pos = 0
                return 0
        n = min(len(b), len(self._buf) - self._pos)
        b[:n] = self._buf[self._pos:self._pos + n]
        self._pos += n
        self.bytes_out += n
        return n

    def verify_complete(self) -> int:
        """Drain whatever the consumer did not read and prove the stream ended
        with its final frame. Returns the number of unread plaintext bytes."""
        left = max(0, len(self._buf) - self._pos)
        self._buf, self._pos = b"", 0
        for chunk in self._it:
            left += len(chunk)
        self._eof = True
        return left


def encrypt_bytes(data: bytes, fernet: MultiFernet, chunk_bytes: int = CHUNK_BYTES) -> bytes:
    sink = io.BytesIO()
    w = EncryptingWriter(sink, fernet, chunk_bytes)
    w.write(data)
    w.close()
    return sink.getvalue()


def decrypt_bytes(blob: bytes, fernet: MultiFernet) -> bytes:
    return b"".join(iter_decrypt(io.BytesIO(blob), fernet))
