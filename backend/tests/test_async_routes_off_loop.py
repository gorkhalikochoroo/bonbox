"""R-d round 3 fix-up — no async route waits on the DB pool on the event loop.

Round 3 moved the middlewares' and the exception handler's DB work off the
event loop. The review found ten async routes that still ran synchronous DB
work right on the loop; with the pool exhausted each such request froze
EVERY request (and /api/health) for up to the pool timeout (30 s in
production). The most frequent was the staff-portal SSE stream: one token
lookup per portal open / reconnect. Fixed here:

  * portal_stream: the token lookup runs in a worker thread;
  * sales import-csv / import-csv rollback, bank-import preview: plain
    `def` routes (FastAPI runs them in the threadpool);
  * business reverify, payment-import sync: plain `def`, the async register
    / provider call run on the loop with anyio.from_thread.run;
  * wine scan: the scan ceiling's count + audit row in run_in_threadpool;
  * WhatsApp webhook: everything after the signature check in a threadpool
    helper;
  * stripe and postmark webhooks already handed their session to
    run_in_threadpool (the reviewer's scan flagged them for Depends(get_db)).

Pinned: an AST scan of every async route in app/ — a DB session may only be
handed to a threadpool call, never used on the loop — and the routes still
work.

Run:
  cd backend && python -m pytest tests/test_async_routes_off_loop.py -q
"""

from __future__ import annotations

import ast
import asyncio
import pathlib
import random
import threading
import uuid
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()

APP_DIR = pathlib.Path(__file__).resolve().parents[1] / "app"

_ROUTE_DECORATORS = {"get", "post", "put", "patch", "delete", "api_route", "websocket", "head", "options"}
#: Calls that run their callable argument in a worker thread.
_OFF_LOOP_CALLS = {"run_in_threadpool", "run_blocking", "run_sync"}


def _call_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _is_route(fn: ast.AsyncFunctionDef) -> bool:
    for d in fn.decorator_list:
        if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr in _ROUTE_DECORATORS:
            return True
    return False


def _db_params(fn: ast.AsyncFunctionDef) -> set[str]:
    """Parameters whose default is Depends(get_db)."""
    names = set()
    args = fn.args.args + fn.args.kwonlyargs
    defaults = [None] * (len(fn.args.args) - len(fn.args.defaults)) + list(fn.args.defaults) + list(fn.args.kw_defaults)
    for a, dflt in zip(args, defaults):
        if (isinstance(dflt, ast.Call) and _call_name(dflt.func) == "Depends" and dflt.args
                and _call_name(dflt.args[0]) == "get_db"):
            names.add(a.arg)
    return names


def _on_loop_db_uses(fn: ast.AsyncFunctionDef) -> list[str]:
    """Where an async route touches the DB ON the event loop: a session
    (its Depends(get_db) parameter, or SessionLocal()) used anywhere except
    as an argument of a threadpool call; a nested sync helper called
    directly instead of being handed to one. Nested async defs run on the
    loop too, so they are checked by the same rules."""
    db_names = _db_params(fn)
    problems: list[str] = []
    sync_helpers: set[str] = set()
    allowed: set[int] = set()  # id() of Name nodes handed to a threadpool call

    def collect(node: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.FunctionDef):
                sync_helpers.add(child.name)
                continue  # runs wherever it is called — see the name check
            if isinstance(child, ast.Lambda):
                continue
            if isinstance(child, ast.Call) and _call_name(child.func) in _OFF_LOOP_CALLS:
                for a in list(child.args) + [k.value for k in child.keywords]:
                    if isinstance(a, ast.Name):
                        allowed.add(id(a))
            collect(child)

    def scan(node: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.Lambda)):
                continue
            if isinstance(child, ast.Call) and _call_name(child.func) == "SessionLocal":
                problems.append(f"line {child.lineno}: SessionLocal() on the loop")
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load) and id(child) not in allowed:
                if child.id in db_names:
                    problems.append(f"line {child.lineno}: session '{child.id}' used on the loop")
                elif child.id in sync_helpers:
                    problems.append(f"line {child.lineno}: sync helper '{child.id}' called on the loop")
            scan(child)

    collect(fn)
    scan(fn)
    return problems


def _async_routes():
    for path in sorted(APP_DIR.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.AsyncFunctionDef) and _is_route(node):
                yield path.relative_to(APP_DIR), node


def test_no_async_route_uses_a_db_session_on_the_event_loop():
    offenders = {}
    for rel, fn in _async_routes():
        problems = _on_loop_db_uses(fn)
        if problems:
            offenders[f"{rel}:{fn.name}"] = problems
    assert offenders == {}, (
        "async routes run on the event loop: a DB call there waits for a pool "
        f"connection with every request frozen. Make the route a plain def, or "
        f"hand the DB work to run_in_threadpool: {offenders}"
    )


def test_the_scan_really_finds_on_loop_db_work():
    """Guards the guard: the old shapes of the routes fixed here are caught."""
    src = '''
@router.get("/{token}/stream")
async def portal_stream(token: str, request: Request):
    db = SessionLocal()
    _link, member = _get_staff_from_token(token, db)

@router.post("/import-csv")
async def import_csv(request: Request, db: Session = Depends(get_db)):
    content = await file.read()
    db.add(Sale())

@router.post("/scan")
async def scan(request: Request, db: Session = Depends(get_db)):
    _enforce_wine_scan_ceiling(db, user)

@router.post("/hook")
async def hook(request: Request, db: Session = Depends(get_db)):
    def _work():
        db.commit()
    _work()

@router.post("/ok")
async def ok(request: Request, db: Session = Depends(get_db)):
    def _work():
        db.commit()
    await run_in_threadpool(_work)
    return await run_in_threadpool(handle, db, payload)
'''
    found = {fn.name: _on_loop_db_uses(fn) for fn in ast.walk(ast.parse(src))
             if isinstance(fn, ast.AsyncFunctionDef)}
    assert found["portal_stream"] and found["import_csv"] and found["scan"] and found["hook"]
    assert found["ok"] == []


# ─── The routes still work ──────────────────────────────────────────

def _ip() -> dict:
    return {"CF-Connecting-IP": f"10.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}"}


@pytest.fixture
def SessionLocal():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture
def owner(SessionLocal):
    db = SessionLocal()
    u = User(
        id=str(uuid.uuid4()), email=f"{uuid.uuid4().hex[:10]}@cafe-example.dk",
        password_hash=hash_password("pw123456"), business_name="Venue", business_type="cafe",
        currency="DKK", plan="pro", role="owner", email_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    db.expunge(u)
    db.close()
    return u


@pytest.fixture
def client(SessionLocal, owner):
    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    app.dependency_overrides[get_current_user] = lambda: owner
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)


def test_the_portal_stream_token_lookup_runs_on_a_worker_thread(monkeypatch):
    from app.routers import staff_portal

    seen = []

    def lookup(token, db, touch=True):
        seen.append(threading.current_thread().name)
        raise HTTPException(status_code=404, detail="Link not found")

    class _Session:
        def close(self):
            pass

    monkeypatch.setattr(staff_portal, "_get_staff_from_token", lookup)
    monkeypatch.setattr(staff_portal, "SessionLocal", _Session)

    async def run():
        loop_thread = threading.current_thread().name
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            r = await c.get("/api/portal/tok-nope/stream", headers=_ip())
        return loop_thread, r

    loop_thread, r = asyncio.run(run())
    assert r.status_code == 404
    assert seen and seen[0] != loop_thread, "the token lookup ran on the event loop"


def test_import_csv_and_its_rollback_still_work(client, SessionLocal):
    from app.routers.sales import limiter

    limiter.reset()
    csv = "date,amount,payment_method\n2026-10-01,120.50,card\n2026-10-02,80,cash\n"
    r = client.post("/api/sales/import-csv", files={"file": ("s.csv", csv.encode(), "text/csv")}, headers=_ip())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["imported"] == 2 and len(body["imported_ids"]) == 2, body
    r2 = client.post("/api/sales/import-csv/rollback", json={"sale_ids": body["imported_ids"]}, headers=_ip())
    assert r2.status_code == 200, r2.text
    assert r2.json()["deleted"] == 2
    limiter.reset()


def test_bank_import_preview_still_works(client):
    csv = "Dato;Tekst;Beløb;Saldo\n01.10.2026;Netto;-120,50;1.000,00\n02.10.2026;Indbetaling;500,00;1.500,00\n"
    r = client.post(
        "/api/bank-import/preview?bank=danske_bank",
        files={"file": ("bank.csv", csv.encode("utf-8"), "text/csv")},
        headers=_ip(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["bank"] == "danske_bank"
    assert len(r.json()["transactions"]) == 2


def test_payment_import_sync_still_awaits_the_provider(client, SessionLocal, owner):
    from app.models.payment_connection import PaymentConnection

    db = SessionLocal()
    conn = PaymentConnection(user_id=owner.id, provider="vipps_mobilepay", label="MP", credentials="{}")
    db.add(conn)
    db.commit()
    cid = conn.id
    db.close()
    txns = [{"date": "2026-10-01", "amount": 99.0, "description": "Kaffe", "type": "income",
             "ref_hash": "r1", "payment_method": "mobilepay", "provider": "vipps_mobilepay"}]
    with patch("app.routers.payment_import.fetch_transactions", new=AsyncMock(return_value=txns)) as fetch:
        r = client.post(f"/api/payment-import/sync/{cid}", headers=_ip())
    assert r.status_code == 200, r.text
    assert fetch.await_count == 1
    assert r.json()["total_count"] == 1
