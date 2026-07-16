"""/api/health exposes the deployed commit — makes 'is the latest deployed?'
a one-line public check (curl api.bonbox.dk/api/health) instead of guesswork."""
from fastapi.testclient import TestClient

from app.main import app, _db_ready

_db_ready.set()


def test_health_exposes_build_commit():
    r = TestClient(app).get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    # A commit marker is always present (the deployed short SHA on Render, or
    # "dev" locally where RENDER_GIT_COMMIT is unset). Never empty.
    assert isinstance(body.get("commit"), str) and body["commit"]
