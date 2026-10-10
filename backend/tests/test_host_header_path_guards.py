"""INFRA-01 — a crafted Host header must not steer a path-based security check.

Pinned Starlette (0.41.3, CVE-2026-48710) builds request.url from the raw Host
header, so ``Host: testserver/api/accountants/grants/x?`` makes
request.url.path read ``/api/accountants/grants/x`` while the router still
dispatches the real path. Every guard now reads the ROUTED path
(app/utils/request_path.routed_path → scope["path"]).

Each test below sends the crafted header at a guarded route and asserts the
guard still fires. On origin/main 6a2ba5c5 (before the fix) the accountant
write, the member write, the member wage read, the shared-device curtain and
the staff-portal PIN all let the request through.
"""
import uuid
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.requests import Request

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.accountant_grant import AccountantGrant
from app.models.sale import Sale
from app.models.staff import StaffLink, StaffMember
from app.models.user import User
from app.services.auth import create_access_token, hash_password
from app.utils.request_path import routed_path
from app.utils.time import utc_now

_db_ready.set()


def _host(fake_path: str) -> dict:
    """A Host header that smuggles `fake_path` into request.url.path."""
    return {"Host": f"testserver{fake_path}?"}


@pytest.fixture
def SessionLocal(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SL = sessionmaker(bind=engine)
    # The guards open their own SessionLocal() at call time.
    import app.database as _app_db
    monkeypatch.setattr(_app_db, "SessionLocal", SL, raising=False)
    return SL


@pytest.fixture
def db(SessionLocal):
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(SessionLocal, monkeypatch):
    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    monkeypatch.setenv("PORTAL_PIN_ENFORCE", "1")
    from app.routers import staff_portal as sp
    sp.limiter.reset()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        sp.limiter.reset()


def _user(db, *, email, role, owner_id=None, plan="starter"):
    u = User(
        email=email, password_hash=hash_password("pw-12345678"),
        business_name="Bon Café" if role == "owner" else "",
        business_type="cafe", currency="DKK", plan=plan, role=role,
        owner_id=owner_id, email_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _bearer(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id), 0)}"}


# ── the helper itself ────────────────────────────────────────────────────


def test_routed_path_ignores_the_host_header():
    scope = {
        "type": "http", "method": "POST", "path": "/api/expenses/1",
        "query_string": b"",
        "headers": [(b"host", b"api.bonbox.dk/api/accountants/grants/x?")],
    }
    req = Request(scope)
    # The vulnerable read, documented: Starlette re-parses Host + path.
    assert req.url.path != "/api/expenses/1"
    assert routed_path(req) == "/api/expenses/1"
    assert routed_path(None) == ""


# request.url parts that do not carry the routed path. bank_connect builds
# its callback origin from scheme + netloc (a separate concern: INFRA-01 is
# about the PATH a guard decides on).
_URL_PARTS_WITHOUT_THE_PATH = {"scheme", "netloc", "hostname", "port"}


def _url_path_reads(tree) -> list[int]:
    """Line numbers where code reads a request's Host-built URL in a way that
    can reach its path: <x>.url.path, <x>.url.components, or request.url /
    req.url used whole (`u = request.url; u.path`, `str(request.url)`,
    `urlparse(str(request.url)).path`). Code only — docstrings/comments don't
    count."""
    import ast
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    lines = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Attribute) and node.attr == "url"):
            continue
        parent = parents.get(node)
        if isinstance(parent, ast.Attribute) and parent.value is node:
            if parent.attr in ("path", "components"):
                lines.append(node.lineno)
            continue
        if isinstance(node.value, ast.Name) and node.value.id in ("request", "req"):
            lines.append(node.lineno)
    return lines


def test_no_guard_reads_request_url_path_again():
    """Static tripwire: the next guard someone writes must use routed_path."""
    import ast

    app_dir = Path(__file__).resolve().parents[1] / "app"
    offenders = []
    for py in app_dir.rglob("*.py"):
        tree = ast.parse(py.read_text(encoding="utf-8"))
        for lineno in _url_path_reads(tree):
            offenders.append(f"{py.relative_to(app_dir)}:{lineno}")
    assert offenders == [], offenders


@pytest.mark.parametrize("src,caught", [
    ("p = request.url.path", True),
    ("u = request.url\nif u.path.startswith('/api'): pass", True),
    ("from urllib.parse import urlparse\np = urlparse(str(request.url)).path", True),
    ("p = request.url.components.path", True),
    ("p = req.url.path", True),
    ("p = scope_request.url.path", True),
    ("s = request.url.scheme\nh = request.url.netloc", False),
    ("from app.utils.request_path import routed_path\np = routed_path(request)", False),
])
def test_the_tripwire_sees_the_indirect_reads_too(src, caught):
    """Review, 10 Oct: the tripwire used to see only the literal <x>.url.path."""
    import ast
    assert bool(_url_path_reads(ast.parse(src))) is caught, src


# ── accountant / member read-only write guard ────────────────────────────


def test_accountant_cannot_write_by_smuggling_an_allowlisted_path(client, db):
    owner = _user(db, email="owner@bonbox.dk", role="owner")
    acct = _user(db, email="revisor@bonbox.dk", role="accountant", plan="free")
    db.add(AccountantGrant(
        accountant_user_id=acct.id, accountant_email=acct.email,
        owner_user_id=owner.id, granted_by=owner.id, status="active",
        invite_token=None, invited_at=utc_now(), activated_at=utc_now(),
    ))
    db.commit()

    r = client.post(
        "/api/sales",
        json={"amount": 100, "payment_method": "card", "date": str(date.today())},
        headers={**_bearer(acct), "X-Client-ID": str(owner.id),
                 **_host("/api/accountants/grants/x")},
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "read_only"
    assert db.query(Sale).count() == 0


def test_member_cannot_write_by_smuggling_the_logout_path(client, db):
    owner = _user(db, email="owner@bonbox.dk", role="owner")
    mgr = _user(db, email="manager@bonbox.dk", role="manager", owner_id=owner.id)

    r = client.post(
        "/api/sales",
        json={"amount": 100, "payment_method": "card", "date": str(date.today())},
        headers={**_bearer(mgr), **_host("/api/auth/logout")},
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "read_only"
    assert db.query(Sale).count() == 0


# ── wage-data read guard ─────────────────────────────────────────────────


@pytest.mark.parametrize("role", ["manager", "cashier", "viewer"])
def test_member_cannot_read_wages_by_smuggling_an_open_path(client, db, role):
    owner = _user(db, email="owner@bonbox.dk", role="owner")
    member = _user(db, email=f"{role}@bonbox.dk", role=role, owner_id=owner.id)

    r = client.get(
        "/api/staff/payroll/estimate?period_start=2026-10-01&period_end=2026-10-07",
        headers={**_bearer(member), **_host("/api/sales")},
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "read_forbidden"


# ── shared-device ("Delt enhed") curtain ─────────────────────────────────


def test_shared_device_curtain_holds_against_a_smuggled_path(client, db):
    owner = _user(db, email="owner@bonbox.dk", role="owner", plan="pro")
    owner.device_pin_hash = hash_password("4271")
    db.commit()
    sd = create_access_token(str(owner.id), 0, shared_device=True, device_nonce="n1")

    r = client.get(
        "/api/staff/payroll/estimate?period_start=2026-10-01&period_end=2026-10-07",
        headers={"Authorization": f"Bearer {sd}", **_host("/api/sales")},
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "device_pin_required"


# ── staff-portal PIN chokepoint ──────────────────────────────────────────


def test_portal_pin_exemption_cannot_be_smuggled(client, db):
    owner = _user(db, email="owner@bonbox.dk", role="owner")
    a = StaffMember(id=uuid.uuid4(), user_id=owner.id, name="Agnes", role="server")
    db.add(a)
    db.commit()
    from app.routers.staff_portal import pwd_context
    db.add(StaffLink(
        id=uuid.uuid4(), user_id=owner.id, staff_id=a.id, token="tokH",
        active=True, pin_hash=pwd_context.hash("1234"),
    ))
    db.commit()

    for exempt_tail in ("/stream", "/manifest.webmanifest", ""):
        r = client.get(
            "/api/portal/tokH/schedule",
            headers=_host(f"/api/portal/tokH{exempt_tail}"),
        )
        assert r.status_code == 401, (exempt_tail, r.status_code, r.text)
