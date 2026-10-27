"""A SAVEPOINT inside the caller's transaction — the house pattern
(services/stripe_billing._savepoint_in_open_transaction has the long story).

pysqlite opens a transaction lazily, at the first INSERT/UPDATE/DELETE: a
SAVEPOINT issued before any write starts the transaction itself, and its
RELEASE then COMMITs what ran inside it — outside the caller's transaction,
so a later rollback of the caller would not take it back. On SQLite (dev,
tests) the outer transaction is opened first; Postgres drivers open it at
the first statement, so nothing changes there.

Use it as `with savepoint(db): …`: an error inside rolls back only what ran
inside (SQLAlchemy's begin_nested), and the caller's transaction goes on.
"""
from __future__ import annotations


def savepoint(db):
    conn = db.connection()
    if conn.dialect.name == "sqlite":
        raw = conn.connection.dbapi_connection
        if raw is not None and not raw.in_transaction:
            conn.exec_driver_sql("BEGIN")
    return db.begin_nested()
