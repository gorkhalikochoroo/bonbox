"""Triage grades a Billing:* group critical regardless of count.

A double-billing alarm (Billing:SecondLiveSubscription) fires once per
customer, so the count-based fallback grade (low below 5 rows) graded the
worst money incident LOW in the operator digest. Billing:* is now critical
on the deterministic path (the 15-minute ops tick) and on the manual LLM
path alike; other error types keep the count-based grade.

Run: cd backend && python3 -m pytest tests/test_triage_billing_severity.py -q
"""
from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.database import Base
from app.models.error_log import ErrorLog
from app.services import triage_service as ts
from app.utils.time import utc_now


def _summary(error_type, count):
    return {"error_type": error_type, "path_template": "/api/billing/stripe/webhook",
            "occurrence_count": count, "affected_users": 1}


@pytest.mark.parametrize("count", [1, 4, 5, 49, 50])
def test_billing_is_critical_at_any_count(count):
    out = ts._fallback_triage(_summary("Billing:SecondLiveSubscription", count))
    assert out.severity == "critical"


@pytest.mark.parametrize("count,sev", [(1, "low"), (5, "medium"), (50, "high")])
def test_other_types_keep_the_count_grade(count, sev):
    assert ts._fallback_triage(_summary("ValueError", count)).severity == sev


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield s
    finally:
        s.close()


def _alarm_row(db):
    db.add(ErrorLog(method="WEBHOOK", path="/api/billing/stripe/webhook", status_code=None,
                    error_type="Billing:SecondLiveSubscription",
                    message="second live subscription: sub_A -> sub_B | old_status=active"))
    db.commit()


def test_the_ops_tick_note_is_critical(db):
    _alarm_row(db)
    res = ts.run_triage(db, since=utc_now() - timedelta(minutes=5),
                        until=utc_now() + timedelta(minutes=1), send_emails=False,
                        use_llm=False, keep_sample_message=False)
    assert [(n.error_type, n.severity) for n in res.new_notes] == [
        ("Billing:SecondLiveSubscription", "critical")]


def test_an_llm_low_grade_cannot_downgrade_a_billing_alarm(db):
    _alarm_row(db)
    llm = ts._TriageOutput(probable_cause="Probably a webhook retry.", blast_radius="one user",
                           severity="low", suggested_actions="Check the Stripe dashboard.")
    with patch.object(ts, "_try_llm_triage", return_value=llm):
        res = ts.run_triage(db, since=utc_now() - timedelta(minutes=5),
                            until=utc_now() + timedelta(minutes=1), send_emails=False,
                            use_llm=True, keep_sample_message=False)
    assert [n.severity for n in res.new_notes] == ["critical"]
