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

#: Production reaches Supabase through Supavisor in SESSION mode
#: (DATABASE_URL -> aws-1-eu-west-1.pooler.supabase.com:5432), not transaction
#: mode (:6543). In session mode every open client connection holds a slot,
#: and the pooler admits at most its "Pool Size" clients for the whole
#: project; one more is refused with "(EMAXCONNSESSION) max clients reached
#: in session mode". 15 is the Pool Size this code must fit: the design floor
#: (the live value was raised to 30 during the 20 Oct incident; 15 stays the
#: floor so the guard holds whichever value is live). If Pool Size is ever
#: lowered below 15, or raised for good and the pool with it, change this
#: constant and its pinned test (tests/test_db_pool_settings.py) together.
#: Headroom is thin: old + new = 14 of 15 during a deploy. Ad-hoc clients
#: (scripts, psql) use the transaction pooler (:6543) or the direct
#: connection, never this :5432 session pooler.
SUPAVISOR_SESSION_CLIENT_CAP = 15

#: Processes holding connections at the same time. Render runs ONE uvicorn
#: worker, but a zero-downtime deploy boots the NEW instance while the OLD one
#: keeps serving with its pool as full as it got, and the new one must pass
#: /api/health/ready — a SELECT 1 through its own pool — before the cutover.
DEPLOY_OVERLAP_INSTANCES = 2

#: Most connections one process may ever open: 15 // 2 = 7, so old + new = 14
#: fits under the cap with one slot to spare.
DEPLOY_SAFE_PEAK = SUPAVISOR_SESSION_CLIENT_CAP // DEPLOY_OVERLAP_INSTANCES


def postgres_engine_kwargs() -> dict:
    """Engine settings for Postgres (production: Supabase's Supavisor pooler in
    SESSION mode, port 5432 — see SUPAVISOR_SESSION_CLIENT_CAP above).

    POOL: 7 kept open, no overflow, so this process never holds more than
    DEPLOY_SAFE_PEAK (7) connections and two instances overlapping in a deploy
    hold at most 14 of the pooler's 15 client slots
    (tests/test_db_pool_settings.py pins peak x 2 <= 15).

    Incident 20 Oct: speed push F (d9d3265a) kept 15 open per process, on the
    wrong premise that production used transaction mode. A day in, the old
    instance held all 15, the new one got EMAXCONNSESSION on every connect,
    /api/health/ready stayed 503 and the deploy timed out after ~16 min.

    ROLLBACK: builds d9d3265a..00c17ce9 (F up to the 20 Oct profile hotfix)
    keep 15 open. Once one of them is live again, the next deploy needs Pool
    Size >= 15 + 7 = 22, so never roll back to them while Pool Size is 15.
    Builds before F (5 kept + 10 overflow, the overflow closed again on
    return, so 5 held between bursts) and builds with this setting do not
    fill up like that.

    What stays of F: connections are kept warm, never opened per request.
    Before F the default (5 kept + 10 overflow) opened up to 10 extra on a
    Home burst (~25 requests) and closed them again, each a new TCP + TLS +
    SCRAM handshake to eu-west-1 (~110 ms). Now nothing is opened after
    warm-up; the 8th concurrent DB request waits for one of the 7 to come
    back instead of opening one. Measured lab cost vs 15 (replay of the Home
    request graph, 20 Oct): about +0.2 s to the money card, about +0.5 s
    with two owners opening Home at once. 5 kept + 2 overflow would bring
    back the per-burst connects F removed; fewer than 7 adds roughly
    0.1-0.17 s per connection taken away (modelled, not measured).

    pool_timeout (30 s, SQLAlchemy's default, written down): how long such a
    wait may last before TimeoutError. A request holds its connection from
    its first query until it ends, so slow work inside a request should hand
    it back first: the photo reads (vision_slot(db=...)) and the staff-chat
    photo decodes call ai_limits.release_db_connection before the slot wait
    and the 30-60 s model call; text-only AI calls do not yet.

    connect_timeout bounds how long a NEW connection attempt can hang when the
    DB is down/unreachable (default is OS-level, effectively minutes). Without
    it the readiness probe — and any real request needing a fresh connection
    during an outage — blocks instead of failing fast. pool_pre_ping stays: a
    kept connection the pooler closed while idle is replaced, not used.
    """
    return {
        "pool_pre_ping": True,
        "pool_size": DEPLOY_SAFE_PEAK,
        "max_overflow": 0,
        "pool_timeout": 30,
        "connect_args": {"connect_timeout": 5},
    }


if "sqlite" in settings.DATABASE_URL:
    connect_args = {"check_same_thread": False}
    engine = create_engine(settings.DATABASE_URL, connect_args=connect_args)
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
