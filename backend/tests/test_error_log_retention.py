"""Technical logs are kept 30 days — the privacy policy says so, and
error_logs were never purged (899 rows older than 90 days, with IPs)."""
from datetime import timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app import models as _all_models  # noqa: F401
from app.jobs import retention_and_patterns as rp
from app.models.error_log import ErrorLog
from app.utils.time import utc_now


def test_error_logs_older_than_30_days_are_purged(monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    monkeypatch.setattr(rp, "SessionLocal", Session)

    s = Session()
    s.add(ErrorLog(method="GET", path="/old", status_code=500, created_at=utc_now() - timedelta(days=31)))
    s.add(ErrorLog(method="GET", path="/recent", status_code=500, created_at=utc_now() - timedelta(days=2)))
    s.commit()

    assert rp.purge_old_error_logs() == 1
    left = [r.path for r in Session().query(ErrorLog).all()]
    assert left == ["/recent"]


def test_remaining_rows_have_link_tokens_redacted(monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    monkeypatch.setattr(rp, "SessionLocal", Session)

    s = Session()
    s.add(ErrorLog(method="CLIENT", path="/s/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEyMzQ", status_code=0,
                   created_at=utc_now() - timedelta(days=1)))
    s.commit()

    rp.purge_old_error_logs()
    assert [r.path for r in Session().query(ErrorLog).all()] == ["/s/:redacted"]

