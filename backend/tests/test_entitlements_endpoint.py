"""Integration tests for GET /api/billing/entitlements via TestClient.

These complement test_entitlements.py (which tests the service layer
directly). Here we mount the real FastAPI app and exercise the full
HTTP path so a regression in routing, auth wiring, or response
serialization can't slip through.

Coverage:
  • Anonymous request → 401 (auth gate works at the HTTP layer, not just
    in our heads)
  • Authenticated request → 200 with the full payload shape
  • Three tiers only — `business` MUST NOT appear in the `plans` list
  • `api_access` flag MUST NOT appear in the `features` map (removed)
  • Free user sees correct upsell hints
  • Trial user sees in_trial=true + trial_days_remaining
  • Paid user sees is_paid=true + their plan's full feature set

The auth dependency is overridden via app.dependency_overrides — the
canonical FastAPI test pattern. We never bake real JWTs in tests.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import app, _db_ready
from app.models.user import User
from app.services.auth import get_current_user
from app.utils.time import utc_now

# Flip the DB-readiness gate ON for tests. In production this gets set
# by the startup hook after migrations run; in TestClient context the
# startup hooks fire (which sets it), but we set it here defensively in
# case startup is skipped in some pytest run mode.
_db_ready.set()


def _build_user(plan: str = "free", *, in_trial: bool = False) -> User:
    """Lightweight in-memory User. The entitlements endpoint reads only
    plan + trial_ends_at, so no DB persistence is needed."""
    u = User(
        email=f"x+{plan}@bonbox.test",
        password_hash="x",
        business_name="Test",
        currency="DKK",
        plan=plan,
    )
    if in_trial:
        u.trial_ends_at = utc_now() + timedelta(days=7)
    return u


@pytest.fixture
def client():
    """TestClient with no auth override — used for the unauthenticated
    test. Cleans up overrides after each test so suites don't leak."""
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User):
    """Inject a known user as the auth result. Returns nothing —
    callers do `app.dependency_overrides[get_current_user] = ...` via
    this helper."""
    def _resolve():
        return user
    app.dependency_overrides[get_current_user] = _resolve


# ─── Auth gate ────────────────────────────────────────────────────────


def test_entitlements_requires_auth(client):
    """Anonymous request → 401. Mirrors what curl saw on the deployed
    endpoint; pin it so a future router refactor can't accidentally
    expose this endpoint anonymously."""
    res = client.get("/api/billing/entitlements")
    assert res.status_code == 401


# ─── Payload shape ────────────────────────────────────────────────────


def test_entitlements_payload_keys_for_free_user(client):
    _override_user(_build_user("free"))
    res = client.get("/api/billing/entitlements")
    assert res.status_code == 200
    body = res.json()
    expected_keys = {
        "plan", "raw_plan", "is_paid", "in_trial",
        "trial_ends_at", "trial_days_remaining",
        "caps", "features",
        "min_plan_by_feature", "plans",
    }
    assert expected_keys.issubset(body.keys()), (
        f"Missing keys: {expected_keys - set(body.keys())}"
    )


def test_entitlements_payload_three_tiers_only(client):
    """The `plans` field MUST contain Free / Starter / Pro and nothing
    else. Catches a regression where someone adds Business back without
    the deliberate decision."""
    _override_user(_build_user("free"))
    body = client.get("/api/billing/entitlements").json()
    assert set(body["plans"].keys()) == {"free", "starter", "pro"}
    assert "business" not in body["plans"]
    assert "trial" not in body["plans"]  # trial is not purchasable


def test_entitlements_payload_no_api_access_feature(client):
    """`api_access` was Business-only. With Business gone and no API
    shipped, the feature flag is removed entirely. Catches a regression
    where someone resurrects the flag."""
    _override_user(_build_user("pro"))
    body = client.get("/api/billing/entitlements").json()
    assert "api_access" not in body["features"]
    # And it's not in any plan's features list either
    for plan, snap in body["plans"].items():
        assert "api_access" not in snap["features"], (
            f"Plan {plan!r} surfaces api_access — regression"
        )


# ─── Free user state ──────────────────────────────────────────────────


def test_entitlements_free_user_state(client):
    _override_user(_build_user("free"))
    body = client.get("/api/billing/entitlements").json()
    assert body["plan"] == "free"
    assert body["is_paid"] is False
    assert body["in_trial"] is False
    assert body["trial_days_remaining"] is None
    # Free user gets Free's caps
    assert body["caps"]["branches"] == 1
    assert body["caps"]["daily_close_export_days"] == 7
    # Premium features locked
    assert body["features"]["ai_anomaly_detection"] is False
    assert body["features"]["multi_branch_dashboard"] is False
    # Upsell hints surface the correct minimum plan
    assert body["min_plan_by_feature"]["ai_anomaly_detection"] == "starter"
    assert body["min_plan_by_feature"]["multi_branch_dashboard"] == "pro"


# ─── Trial user state ─────────────────────────────────────────────────


def test_entitlements_trial_user_state(client):
    _override_user(_build_user("free", in_trial=True))
    body = client.get("/api/billing/entitlements").json()
    assert body["plan"] == "trial"
    assert body["is_paid"] is False  # trial is not paid
    assert body["in_trial"] is True
    assert 6 <= body["trial_days_remaining"] <= 7
    # Trial = full Pro
    assert body["caps"]["branches"] == 3
    assert body["features"]["ai_anomaly_detection"] is True
    assert body["features"]["multi_branch_dashboard"] is True


# ─── Paid user state ──────────────────────────────────────────────────


def test_entitlements_starter_user_state(client):
    _override_user(_build_user("starter"))
    body = client.get("/api/billing/entitlements").json()
    assert body["plan"] == "starter"
    assert body["is_paid"] is True
    assert body["in_trial"] is False
    # Starter caps (this is the regression the audit caught)
    assert body["caps"]["sale_parse_per_day"] == 50  # was leaking to 15
    assert body["caps"]["kasse_extracts_per_day"] == 40  # was leaking to 5
    assert body["caps"]["ai_brief_refreshes_per_day"] == 3  # was leaking to 0
    # Starter features
    assert body["features"]["ai_anomaly_detection"] is True
    # Pro-only feature locked
    assert body["features"]["multi_branch_dashboard"] is False


def test_entitlements_pro_user_state(client):
    _override_user(_build_user("pro"))
    body = client.get("/api/billing/entitlements").json()
    assert body["plan"] == "pro"
    assert body["is_paid"] is True
    # All premium features unlocked
    assert body["features"]["ai_anomaly_detection"] is True
    assert body["features"]["multi_branch_dashboard"] is True
    assert body["features"]["white_label_pdf"] is True
    assert body["features"]["priority_support"] is True


# ─── Legacy "business" plan defensive mapping ─────────────────────────


def test_entitlements_legacy_business_plan_resolves_to_pro(client):
    """A user with raw plan="business" (no production users have this,
    but defensive coverage matters): the resolved `plan` field is "pro",
    is_paid is True, and they get Pro's full feature set. Critically:
    `raw_plan` still exposes "business" so admin tooling can spot &
    correct stale rows; the user-facing tier (`plan`) hides it."""
    _override_user(_build_user("business"))
    body = client.get("/api/billing/entitlements").json()
    assert body["plan"] == "pro"
    assert body["raw_plan"] == "business"
    assert body["is_paid"] is True
    assert body["features"]["ai_anomaly_detection"] is True
    assert body["features"]["multi_branch_dashboard"] is True
