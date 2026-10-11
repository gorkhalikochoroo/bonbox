"""An error report sent to Sentry keeps /privacy's clock-in promise.

/privacy: BonBox uses the clock-in coordinates only for the distance check
and does not save them. The staff app's prompt: the location is never stored.
error_logs never stores a link token. With the SDK defaults a 500 in
POST /api/portal/<token>/clock-in sent lat, lng and accuracy (request body and
frame locals) and the token (URL, Referer, log line) to Sentry, a third party
that stores them. app/utils/sentry_scrub.py closes that; these tests pin it.

The end-to-end test runs the real app and the real clock-in route in a
subprocess (Sentry's integrations patch FastAPI process-wide) with a capture
transport, so nothing leaves the machine. Its control arm runs the same
request with the SDK defaults and must find the coordinates — the check can
see a leak, so its "no leak" is not vacuous.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app.utils.sentry_scrub import SENTRY_PRIVACY_OPTIONS, scrub_event

BACKEND = Path(__file__).resolve().parents[1]
_TOKEN = "Qx7" + "LinkTokenAbCdEfGhIjKlMn" + "OpQrStUv12"
_UUID = "4fd3ef6d-26a6-4138-bd6b-6a27ecdbf997"


def test_scrub_drops_the_body_and_frame_variables():
    event = {
        "request": {
            "url": f"https://api.bonbox.dk/api/portal/{_TOKEN}/clock-in",
            "data": {"lat": 55.1, "lng": 12.2, "accuracy": 9.0},
            "headers": {"referer": f"https://bonbox.dk/s/{_TOKEN}"},
            "query_string": f"t={_TOKEN}&x=1",
        },
        "exception": {"values": [{"stacktrace": {"frames": [
            {"function": "portal_clock_in", "vars": {"lat": "55.1", "token": _TOKEN}},
        ]}}]},
        "threads": {"values": [{"stacktrace": {"frames": [{"vars": {"lng": "12.2"}}]}}]},
    }
    out = scrub_event(event, {})
    assert "data" not in out["request"]
    frame = out["exception"]["values"][0]["stacktrace"]["frames"][0]
    assert "vars" not in frame and frame["function"] == "portal_clock_in"
    assert "vars" not in out["threads"]["values"][0]["stacktrace"]["frames"][0]
    assert out["request"]["url"] == "https://api.bonbox.dk/api/portal/:redacted/clock-in"
    assert out["request"]["headers"]["referer"] == "https://bonbox.dk/s/:redacted"
    assert _TOKEN not in json.dumps(out)


def test_scrub_redacts_tokens_in_log_lines_and_breadcrumbs_and_keeps_ids():
    event = {
        "logentry": {
            "message": "Unhandled exception in %s %s: %s",
            "params": ["POST", f"/api/portal/{_TOKEN}/clock-in", "boom"],
        },
        "breadcrumbs": {"values": [
            {"message": f"GET /s/{_TOKEN}", "data": {"url": f"/api/stand/{_TOKEN}/book"}},
            {"message": f"GET /api/public/reservations/booking/{_UUID}"},
        ]},
        "spans": [{"description": f"POST /api/portal/{_TOKEN}/clock-in"}],
        "transaction": "/api/portal/{token}/clock-in",
    }
    out = scrub_event(event, {})
    assert _TOKEN not in json.dumps(out)
    assert out["logentry"]["params"][1] == "/api/portal/:redacted/clock-in"
    assert out["breadcrumbs"]["values"][1]["message"].endswith(_UUID)
    assert out["transaction"] == "/api/portal/{token}/clock-in"


def test_scrub_drops_an_event_it_cannot_scrub():
    assert scrub_event(None, {}) is None


def test_privacy_options_and_main_uses_them():
    assert SENTRY_PRIVACY_OPTIONS["send_default_pii"] is False
    assert SENTRY_PRIVACY_OPTIONS["max_request_body_size"] == "never"
    assert SENTRY_PRIVACY_OPTIONS["include_local_variables"] is False
    assert SENTRY_PRIVACY_OPTIONS["before_send"] is scrub_event
    assert SENTRY_PRIVACY_OPTIONS["before_send_transaction"] is scrub_event
    main_src = (BACKEND / "app" / "main.py").read_text()
    assert "**SENTRY_PRIVACY_OPTIONS," in main_src


# Runs in a fresh interpreter: argv[1] = "fixed" (main.py's init as written)
# or "control" (the SDK defaults: no privacy options). The token and the
# coordinates come in through the environment, built at run time: Sentry
# reports sys.argv and quotes source lines, and neither may carry them.
_SCRIPT = r'''
import json, os, sys, uuid
os.environ["SENTRY_DSN"] = "https://public@o0.ingest.example.invalid/1"
import sentry_sdk
from sentry_sdk.transport import Transport

SENT = []

class Capture(Transport):
    def capture_envelope(self, envelope):
        SENT.append(envelope.serialize().decode("utf-8", "replace"))

_real_init = sentry_sdk.init

def _init(*a, **kw):
    kw["transport"] = Capture
    kw["traces_sample_rate"] = 1.0
    if sys.argv[1] == "control":
        for k in ("max_request_body_size", "include_local_variables",
                  "before_send", "before_send_transaction"):
            kw.pop(k, None)
    return _real_init(*a, **kw)

sentry_sdk.init = _init

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.staff import StaffLink, StaffMember
from app.models.user import User
from app.routers import staff_portal as sp
from app.services.auth import hash_password

token = os.environ["BB_TEST_TOKEN"]
lat, lng, acc = (float(os.environ["BB_TEST_" + k]) for k in ("LAT", "LNG", "ACC"))
_db_ready.set()
engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
Base.metadata.create_all(engine)
Session = sessionmaker(bind=engine)
db = Session()
owner = User(email="o@bonbox.dk", password_hash=hash_password("x"), business_name="B",
             business_type="cafe", currency="DKK", role="owner", timezone="Europe/Copenhagen")
db.add(owner); db.commit(); db.refresh(owner)
db.add(BusinessProfile(user_id=owner.id, clock_settings_json=json.dumps(
    {"enabled": True, "lat": 55.6761, "lng": 12.5683, "radius_m": 150})))
staff = StaffMember(id=uuid.uuid4(), user_id=owner.id, name="Agnes", role="server")
db.add(staff); db.commit(); db.refresh(staff)
db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=staff.id, token=token, active=True))
db.commit()

def _get_db():
    s = Session()
    try:
        yield s
    finally:
        s.close()

app.dependency_overrides[get_db] = _get_db

def _fails(*a, **k):
    raise RuntimeError("distance check failed")

sp._haversine_m = _fails  # a 500 after lat/lng are read, inside portal_clock_in
client = TestClient(app, raise_server_exceptions=False)
r = client.post("/api/portal/" + token + "/clock-in",
                json={"lat": lat, "lng": lng, "accuracy": acc},
                headers={"Referer": "https://bonbox.dk/s/" + token})
sentry_sdk.flush()
blob = "\n".join(SENT)
print("RESULT " + json.dumps({
    "status": r.status_code,
    "error_event": '"exception"' in blob and "distance check failed" in blob,
    "lat": repr(lat) in blob, "lng": repr(lng) in blob, "accuracy": repr(acc) in blob,
    "token": token in blob,
}))
'''


def _run(mode: str) -> dict:
    pytest.importorskip("sentry_sdk")
    lat, lng, acc = "55.6" + "77123", "12.5" + "68987", "17." + "25"
    env = {k: v for k, v in os.environ.items() if not k.startswith("SENTRY")}
    env["PYTHONPATH"] = str(BACKEND) + os.pathsep + env.get("PYTHONPATH", "")
    env.update(BB_TEST_TOKEN=_TOKEN, BB_TEST_LAT=lat, BB_TEST_LNG=lng, BB_TEST_ACC=acc)
    proc = subprocess.run(
        [sys.executable, "-c", _SCRIPT, mode],
        cwd=BACKEND, env=env, capture_output=True, text=True, timeout=240,
    )
    lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("RESULT ")]
    assert lines, proc.stdout[-2000:] + proc.stderr[-4000:]
    return json.loads(lines[-1][len("RESULT "):])


def test_a_clock_in_500_reaches_sentry_without_coordinates_or_token():
    got = _run("fixed")
    assert got["status"] == 500 and got["error_event"], got
    assert not got["lat"] and not got["lng"] and not got["accuracy"], got
    assert not got["token"], got


def test_control_the_sdk_defaults_do_send_them():
    got = _run("control")
    assert got["status"] == 500 and got["error_event"], got
    assert got["lat"] and got["lng"] and got["token"], got
