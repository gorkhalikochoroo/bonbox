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

if "sqlite" in settings.DATABASE_URL:
    connect_args = {"check_same_thread": False}
    engine = create_engine(settings.DATABASE_URL, connect_args=connect_args)
else:
    # connect_timeout bounds how long a NEW connection attempt can hang when
    # the DB is down/unreachable (default is OS-level, effectively minutes).
    # Without it the readiness probe — and any real request needing a fresh
    # connection during an outage — blocks instead of failing fast.
    engine = create_engine(
        settings.DATABASE_URL,
        pool_pre_ping=True,
        connect_args={"connect_timeout": 5},
    )
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
