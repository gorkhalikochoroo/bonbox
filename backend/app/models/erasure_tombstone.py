"""
ErasureTombstone — completes the GDPR erasure promise for accounting blobs.

delete_account tells the departing owner that accounting source documents
(kasserapport / expense / sale / inventory_import scans) are "kept for
5 years, then deleted" (Bogføringsloven §10). The DB pointer rows are wiped
at erasure, so without this row nothing can ever FIND those blobs again to
honour the "then deleted" half — they would sit in storage forever.

One row per erased account, written in the SAME commit as the user delete.
Deliberately NO users-FK: the user row is gone by design. The nightly
retention sweep purges the retained storage prefixes for tombstones older
than the legal floor + buffer, then removes the tombstone itself.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class ErasureTombstone(Base):
    __tablename__ = "erasure_tombstones"

    # The erased user's id. PK: one tombstone per erased account; a re-used
    # uuid is impossible (uuid4) and merge() makes a double-delete idempotent.
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True)

    erased_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utc_now,
    )
