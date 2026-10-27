import uuid

from sqlalchemy import String, create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.types import TypeDecorator, CHAR

from app.config import settings


class GUID(TypeDecorator):
    """Platform-independent UUID type. Uses String(36) for SQLite, native UUID for PostgreSQL."""
    impl = CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect):
        return dialect.type_descriptor(String(36))

    def process_bind_param(self, value, dialect):
        if value is not None:
            return str(value)
        return value

    def process_result_value(self, value, dialect):
        if value is not None:
            return uuid.UUID(str(value))
        return value

def postgres_engine_kwargs() -> dict:
    """Engine settings for Postgres (production: Supabase's Supavisor pooler,
    transaction mode, port 6543).

    POOL (F, speed push 15 Oct): the SAME ceiling of 15 connections per worker
    as before (SQLAlchemy's default was pool_size 5 + max_overflow 10), but all
    15 are kept open instead of 5. A Home open fires ~25 requests at once; with
    5 kept, ~10 of them opened a brand-new connection every time (TCP + TLS +
    SCRAM to the pooler in eu-west-1, ~5 round trips ≈ 110 ms each) and closed
    it again on return. The peak number of client connections Supavisor sees
    is unchanged (15 per worker; one worker on Render), so this asks nothing
    more of the project's connection limits (checked read-only on 16 Oct:
    max_connections 120; transaction-mode pooler; 7 server connections in use).

    connect_timeout bounds how long a NEW connection attempt can hang when the
    DB is down/unreachable (default is OS-level, effectively minutes). Without
    it the readiness probe — and any real request needing a fresh connection
    during an outage — blocks instead of failing fast. pool_pre_ping stays: a
    kept connection the pooler closed while idle is replaced, not used.

    hide_parameters (fix round 27 Oct, review P3-8): a failed statement's
    bound values never reach a log line or an exception message — a guest's
    full phone number or mailbox (a LIKE pattern, a WHERE value) was printed
    by every logger.warning(..., exc_info=True) around a failed read. The
    statement itself and the database's own error text still are (nothing
    reads parameter values from an error: /admin/recent-errors shows the
    message and the traceback as text).
    """
    return {
        "pool_pre_ping": True,
        "pool_size": 15,
        "max_overflow": 0,
        "connect_args": {"connect_timeout": 5},
        "hide_parameters": True,
    }


if "sqlite" in settings.DATABASE_URL:
    connect_args = {"check_same_thread": False}
    # The same rule as Postgres: bound values never reach a log or an error.
    engine = create_engine(settings.DATABASE_URL, connect_args=connect_args,
                           hide_parameters=True)
else:
    engine = create_engine(settings.DATABASE_URL, **postgres_engine_kwargs())
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
