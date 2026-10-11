"""The AI that reads photos/text runs on Claude Sonnet 5.5 — with a net.

Pins (services/ai_model_guard.py, config.py, every reader that uses them):
  • the defaults: DEFAULT/PREMIUM = claude-sonnet-5-5, LEGACY_SAFE =
    claude-sonnet-5, ACCURACY unchanged; the BONBOX_* env vars still win,
    and so do the per-feature overrides;
  • a model-not-found answer for claude-sonnet-5-5 -> ONE retry on
    claude-sonnet-5, the read's result comes back, and ONE error_logs row
    "AI:ModelNotFound" per model per UTC day (memo + DB check), which the
    ops triage reads; a second 404 the same day writes nothing;
  • any other error (429, 500, a 400 about tool_choice, a plain exception)
    is NOT retried on the legacy model and writes no row;
  • Sonnet 5.5 refuses forced tool_choice: the guard sends "auto" + a
    system line naming the tool (+ thinking between_tools), while the legacy
    retry keeps the forced call Sonnet 5 accepts;
  • the kasserapport / receipt / doctype readers send the model from
    Settings (a mocked client records the model name);
  • the wine label scan (raw HTTP) gets the same net and no `temperature`.
No request leaves a test: every client is a fake.
"""
from __future__ import annotations

import importlib.util
import io
import json
import pathlib
import sys
import types
from datetime import timedelta

import anthropic as _real_anthropic
import httpx
import pytest
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.database
from app.config import settings
from app.database import Base
from app import models as _all_models  # noqa: F401 — register all models
from app.models.error_log import ErrorLog
from app.services import ai_model_guard as guard
from app.services.ai_limits import anthropic_client
from app.utils.time import utc_now

NEW, LEGACY, OPUS = "claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-4-8"
SECRET_PROMPT = "PROMPT-TEXT-THAT-MUST-NEVER-BE-LOGGED"


# ─── fixtures / fakes ───────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _tiers(monkeypatch):
    """Pin the tiers to the shipped defaults whatever the shell env says."""
    monkeypatch.setattr(settings, "DEFAULT_MODEL", NEW)
    monkeypatch.setattr(settings, "PREMIUM_MODEL", NEW)
    monkeypatch.setattr(settings, "LEGACY_SAFE_MODEL", LEGACY)
    monkeypatch.setattr(settings, "ACCURACY_MODEL", OPUS)
    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "test-key", raising=False)
    guard._alerted.clear()
    yield
    guard._alerted.clear()


@pytest.fixture
def mem(monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(app.database, "SessionLocal", Session)
    return Session


def _rows(Session) -> list[ErrorLog]:
    db = Session()
    try:
        return db.query(ErrorLog).filter(ErrorLog.error_type == guard.ALERT_ERROR_TYPE).all()
    finally:
        db.close()


def _status_error(cls, status: int, err_type: str, message: str):
    body = {"type": "error", "error": {"type": err_type, "message": message}}
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls(f"Error code: {status} - {body}", response=httpx.Response(status, request=req, json=body),
               body=body)


def _not_found(model: str):
    return _status_error(_real_anthropic.NotFoundError, 404, "not_found_error", f"model: {model}")


def _ok(model: str, *, tool: str | None = None, payload: dict | None = None, text: str | None = None):
    content = []
    if tool:
        content.append(types.SimpleNamespace(type="tool_use", name=tool, input=payload or {}))
    if text is not None:
        content.append(types.SimpleNamespace(type="text", text=text))
    return types.SimpleNamespace(
        model=model, content=content, stop_reason="tool_use" if tool else "end_turn",
        usage=types.SimpleNamespace(input_tokens=10, output_tokens=5),
    )


def _install(monkeypatch, behave):
    """sys.modules['anthropic'] -> a fake whose create(**kw) records kw and
    returns / raises behave(kw)."""
    calls: list[dict] = []

    class _Msgs:
        def create(self, **kw):
            calls.append(kw)
            out = behave(kw)
            if isinstance(out, BaseException):
                raise out
            return out

    class _Client:
        def __init__(self, *a, **k):
            self.messages = _Msgs()

    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=_Client))
    return calls


def _missing_new_model(tool=None, payload=None, text=None):
    def behave(kw):
        if kw["model"] == NEW:
            return _not_found(NEW)
        return _ok(kw["model"], tool=tool, payload=payload, text=text)
    return behave


def _load_fresh_config():
    """Execute config.py as a NEW module (the live `settings` object other
    modules hold is untouched), so the env-var defaults are evaluated now."""
    path = pathlib.Path(__file__).resolve().parents[1] / "app" / "config.py"
    spec = importlib.util.spec_from_file_location("_bonbox_config_probe", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.Settings()


_MODEL_ENV = ("BONBOX_DEFAULT_MODEL", "BONBOX_PREMIUM_MODEL", "BONBOX_SAFE_MODEL",
              "BONBOX_ACCURACY_MODEL", "DEFAULT_MODEL", "PREMIUM_MODEL",
              "LEGACY_SAFE_MODEL", "ACCURACY_MODEL")


# ─── 1. settings ────────────────────────────────────────────────────────

def test_shipped_defaults_are_sonnet_5_5_with_sonnet_5_as_the_legacy_safe_model(monkeypatch):
    for k in _MODEL_ENV:
        monkeypatch.delenv(k, raising=False)
    s = _load_fresh_config()
    assert s.DEFAULT_MODEL == "claude-sonnet-5-5"
    assert s.PREMIUM_MODEL == "claude-sonnet-5-5"
    assert s.LEGACY_SAFE_MODEL == "claude-sonnet-5"
    assert s.ACCURACY_MODEL == "claude-opus-4-8"  # accuracy tier unchanged


def test_env_overrides_still_win(monkeypatch):
    for k in _MODEL_ENV:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("BONBOX_DEFAULT_MODEL", "claude-default-from-env")
    monkeypatch.setenv("BONBOX_PREMIUM_MODEL", "claude-premium-from-env")
    monkeypatch.setenv("BONBOX_SAFE_MODEL", "claude-safe-from-env")
    monkeypatch.setenv("BONBOX_ACCURACY_MODEL", "claude-accuracy-from-env")
    s = _load_fresh_config()
    assert (s.DEFAULT_MODEL, s.PREMIUM_MODEL, s.LEGACY_SAFE_MODEL, s.ACCURACY_MODEL) == (
        "claude-default-from-env", "claude-premium-from-env",
        "claude-safe-from-env", "claude-accuracy-from-env",
    )


def test_per_feature_overrides_still_win(monkeypatch, tmp_path):
    """The overrides that reach a reader today: the per-call `model=` argument
    and the AI_MODEL_DOCTYPE_CLASSIFIER / AI_MODEL_INVENTORY_OCR env vars.
    (The getattr(settings, "AI_MODEL_<X>") hooks are not Settings fields, so
    pydantic drops those env vars — unchanged by this bump, see the report.)"""
    from app.services import claude_vision_ocr
    from app.services import kasserapport_extractor as kx
    from app.services.menu_extractor import extract_menu_from_image

    calls = _install(monkeypatch, lambda kw: _ok(kw["model"], text="receipt"))
    kx.classify_document("Zm9v", model="claude-per-call-override")
    extract_menu_from_image(b"\xff\xd8\xff" + b"0" * 2000, model="claude-menu-override")
    monkeypatch.setenv("AI_MODEL_DOCTYPE_CLASSIFIER", "claude-doctype-override")
    claude_vision_ocr._CLASSIFIER_CACHE.clear()
    claude_vision_ocr.classify_document_type(str(_jpeg(tmp_path)))
    assert [c["model"] for c in calls] == [
        "claude-per-call-override", "claude-menu-override", "claude-doctype-override",
    ]


def test_default_readers_send_the_setting(monkeypatch):
    from app.services import anomaly_detector, sale_parser, triage_service  # noqa: F401
    from app.services.menu_extractor import extract_menu_from_image
    from app.services.inventory_extractor import extract_image
    from app.services.inventory_categorizer import categorize_with_ai

    monkeypatch.setattr(settings, "DEFAULT_MODEL", "claude-default-under-test")
    calls = _install(monkeypatch, lambda kw: _ok(kw["model"], tool="x"))
    extract_menu_from_image(b"\xff\xd8\xff" + b"0" * 2000)
    extract_image(_jpeg_bytes())
    categorize_with_ai([{"name": "Mælk"}], "cafe")
    monkeypatch.setattr(settings, "USE_CLAUDE_API", True)
    triage_service._try_llm_triage({"error_type": "X"})
    assert [c["model"] for c in calls] == ["claude-default-under-test"] * 4


# ─── 2. model-not-found -> one legacy retry + one ops row per day ───────

def test_a_404_on_sonnet_5_5_retries_once_on_sonnet_5_and_returns_the_read(monkeypatch, mem):
    calls = _install(monkeypatch, _missing_new_model(text="hello"))
    client = anthropic_client("k")
    resp = client.messages.create(model=NEW, max_tokens=50,
                                  messages=[{"role": "user", "content": SECRET_PROMPT}])
    assert [c["model"] for c in calls] == [NEW, LEGACY]
    assert resp.model == LEGACY and resp.content[0].text == "hello"
    rows = _rows(mem)
    assert len(rows) == 1
    r = rows[0]
    assert (r.method, r.path, r.status_code) == ("AI", f"ai:model:{NEW}", None)
    assert NEW in r.message and LEGACY in r.message
    assert SECRET_PROMPT not in (r.message or "") and not r.traceback


def test_a_second_404_the_same_day_writes_no_second_row(monkeypatch, mem):
    _install(monkeypatch, _missing_new_model(text="ok"))
    client = anthropic_client("k")
    for _ in range(3):
        client.messages.create(model=NEW, max_tokens=5, messages=[])
    assert len(_rows(mem)) == 1
    # Survives a restart (memo gone): the DB check still dedupes today.
    guard._alerted.clear()
    client.messages.create(model=NEW, max_tokens=5, messages=[])
    assert len(_rows(mem)) == 1


def test_the_next_utc_day_records_again(monkeypatch, mem):
    _install(monkeypatch, _missing_new_model(text="ok"))
    client = anthropic_client("k")
    client.messages.create(model=NEW, max_tokens=5, messages=[])
    tomorrow = utc_now() + timedelta(days=1)
    monkeypatch.setattr(guard, "utc_now", lambda: tomorrow)
    client.messages.create(model=NEW, max_tokens=5, messages=[])
    assert len(_rows(mem)) == 2


def test_premium_model_gets_the_same_net(monkeypatch, mem):
    monkeypatch.setattr(settings, "PREMIUM_MODEL", "claude-premium-x")
    def behave(kw):
        return _not_found(kw["model"]) if kw["model"] == "claude-premium-x" else _ok(kw["model"], text="ok")
    calls = _install(monkeypatch, behave)
    anthropic_client("k").messages.create(model="claude-premium-x", max_tokens=5, messages=[])
    assert [c["model"] for c in calls] == ["claude-premium-x", LEGACY]
    assert [r.path for r in _rows(mem)] == ["ai:model:claude-premium-x"]


@pytest.mark.parametrize("make_error", [
    lambda: _status_error(_real_anthropic.RateLimitError, 429, "rate_limit_error", "slow down"),
    lambda: _status_error(_real_anthropic.InternalServerError, 500, "api_error", "boom"),
    lambda: _status_error(_real_anthropic.BadRequestError, 400, "invalid_request_error",
                          'tool_choice: type "tool" and "any" are not supported for this model.'),
    lambda: _status_error(_real_anthropic.BadRequestError, 400, "invalid_request_error",
                          '"thinking.type.disabled" is not supported for this model.'),
    lambda: RuntimeError("network down"),
], ids=["429", "500", "400-tool_choice", "400-thinking", "plain"])
def test_other_errors_are_not_retried_on_the_legacy_model(monkeypatch, mem, make_error):
    err = make_error()
    calls = _install(monkeypatch, lambda kw: err)
    with pytest.raises(type(err)):
        anthropic_client("k").messages.create(model=NEW, max_tokens=5, messages=[])
    assert [c["model"] for c in calls] == [NEW]
    assert _rows(mem) == []


def test_a_400_naming_the_model_invalid_counts_as_not_found(monkeypatch, mem):
    bad = _status_error(_real_anthropic.BadRequestError, 400, "invalid_request_error", f"model: {NEW}")
    calls = _install(monkeypatch, lambda kw: bad if kw["model"] == NEW else _ok(kw["model"], text="ok"))
    anthropic_client("k").messages.create(model=NEW, max_tokens=5, messages=[])
    assert [c["model"] for c in calls] == [NEW, LEGACY]
    assert len(_rows(mem)) == 1


def test_only_default_and_premium_are_netted(monkeypatch, mem):
    # An accuracy-tier 404 is NOT retried on the legacy Sonnet here — the
    # accuracy tier's own fallback (call_with_fallback) handles it.
    calls = _install(monkeypatch, lambda kw: _not_found(kw["model"]))
    with pytest.raises(_real_anthropic.NotFoundError):
        anthropic_client("k").messages.create(model=OPUS, max_tokens=5, messages=[])
    assert [c["model"] for c in calls] == [OPUS]
    # Rolled back to the legacy id itself: nothing to retry on.
    monkeypatch.setattr(settings, "DEFAULT_MODEL", LEGACY)
    with pytest.raises(_real_anthropic.NotFoundError):
        anthropic_client("k").messages.create(model=LEGACY, max_tokens=5, messages=[])
    assert [c["model"] for c in calls] == [OPUS, LEGACY]
    assert _rows(mem) == []


def test_a_failing_legacy_retry_propagates_and_still_alerted(monkeypatch, mem):
    calls = _install(monkeypatch, lambda kw: _not_found(kw["model"]))
    with pytest.raises(_real_anthropic.NotFoundError):
        anthropic_client("k").messages.create(model=NEW, max_tokens=5, messages=[])
    assert [c["model"] for c in calls] == [NEW, LEGACY]  # once, never a loop
    assert len(_rows(mem)) == 1


def test_call_with_fallback_nets_a_client_it_did_not_build(monkeypatch, mem):
    """onboarding.py builds its own anthropic.Anthropic and hands it to
    call_with_fallback(PREMIUM -> DEFAULT)."""
    from app.services.model_fallback import call_with_fallback

    calls = _install(monkeypatch, _missing_new_model(text="cafe"))
    raw_client = sys.modules["anthropic"].Anthropic(api_key="k")
    resp = call_with_fallback(raw_client, _label="t", _primary=settings.PREMIUM_MODEL,
                              _fallback=settings.DEFAULT_MODEL, max_tokens=20, messages=[])
    assert resp.content[0].text == "cafe"
    assert [c["model"] for c in calls] == [NEW, LEGACY]
    assert len(_rows(mem)) == 1


def test_the_ops_triage_reads_the_row(monkeypatch, mem):
    from app.services.triage_service import run_triage

    _install(monkeypatch, _missing_new_model(text="ok"))
    anthropic_client("k").messages.create(model=NEW, max_tokens=5, messages=[])
    db = mem()
    try:
        res = run_triage(db, since=utc_now() - timedelta(minutes=5),
                         until=utc_now() + timedelta(minutes=1),
                         send_emails=False, use_llm=False, keep_sample_message=False)
        assert res.error_count == 1
        assert [n.error_type for n in res.new_notes] == [guard.ALERT_ERROR_TYPE]
    finally:
        db.close()


# ─── 3. forced tool use on Sonnet 5.5 ───────────────────────────────────

_TOOL = {"name": "extract_x", "input_schema": {"type": "object", "properties": {}}}
_SYS = [{"type": "text", "text": "SYSTEM", "cache_control": {"type": "ephemeral"}}]


def test_sonnet_5_5_gets_auto_tool_choice_a_naming_line_and_lowest_thinking(monkeypatch):
    calls = _install(monkeypatch, lambda kw: _ok(kw["model"], tool="extract_x"))
    anthropic_client("k").messages.create(
        model=NEW, max_tokens=200, system=_SYS, tools=[_TOOL],
        tool_choice={"type": "tool", "name": "extract_x"}, messages=[],
    )
    sent = calls[0]
    assert sent["tool_choice"] == {"type": "auto"}
    assert sent["thinking"] == {"type": "between_tools"}
    assert sent["system"][0] == _SYS[0]  # cached prefix untouched
    assert "extract_x" in sent["system"][-1]["text"]
    assert sent["tools"] == [_TOOL]


def test_the_legacy_retry_keeps_the_forced_call_sonnet_5_accepts(monkeypatch, mem):
    calls = _install(monkeypatch, _missing_new_model(tool="extract_x"))
    anthropic_client("k").messages.create(
        model=NEW, max_tokens=200, system=_SYS, tools=[_TOOL],
        tool_choice={"type": "tool", "name": "extract_x"}, messages=[],
    )
    legacy_call = calls[1]
    assert legacy_call["model"] == LEGACY
    assert legacy_call["tool_choice"] == {"type": "tool", "name": "extract_x"}
    assert "thinking" not in legacy_call
    assert legacy_call["system"] == _SYS


def test_models_that_accept_forced_tool_use_are_sent_unchanged(monkeypatch):
    calls = _install(monkeypatch, lambda kw: _ok(kw["model"], tool="extract_x"))
    kw = dict(max_tokens=200, system="S", tools=[_TOOL],
              tool_choice={"type": "tool", "name": "extract_x"}, messages=[])
    for m in (OPUS, LEGACY):
        anthropic_client("k").messages.create(model=m, **kw)
    for c in calls:
        assert c["tool_choice"] == {"type": "tool", "name": "extract_x"}
        assert c["system"] == "S" and "thinking" not in c


def test_a_caller_thinking_or_high_effort_is_respected(monkeypatch):
    calls = _install(monkeypatch, lambda kw: _ok(kw["model"], tool="extract_x"))
    c = anthropic_client("k")
    c.messages.create(model=NEW, max_tokens=9, tools=[_TOOL], messages=[],
                      tool_choice={"type": "any"}, thinking={"type": "adaptive"})
    c.messages.create(model=NEW, max_tokens=9, tools=[_TOOL], messages=[],
                      tool_choice={"type": "any"}, output_config={"effort": "xhigh"})
    assert calls[0]["thinking"] == {"type": "adaptive"}
    assert "thinking" not in calls[1]
    assert all(x["tool_choice"] == {"type": "auto"} for x in calls)
    assert calls[0]["system"].startswith("Answer by calling one of the provided tools")


# ─── 4. the money readers use the setting ───────────────────────────────

def _jpeg_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), color=(200, 10, 10)).save(buf, format="JPEG")
    return buf.getvalue()


def _jpeg(tmp_path) -> pathlib.Path:
    p = tmp_path / "scan.jpg"
    p.write_bytes(_jpeg_bytes())
    return p


def test_kasserapport_reads_use_the_settings_models(monkeypatch):
    from app.services import kasserapport_extractor as kx

    monkeypatch.setattr(settings, "DEFAULT_MODEL", "claude-default-under-test")
    monkeypatch.setattr(settings, "ACCURACY_MODEL", "claude-accuracy-under-test")

    def behave(kw):
        if kw["model"] == "claude-accuracy-under-test":
            return RuntimeError("accuracy tier down")
        return _ok(kw["model"], tool=kw["tools"][0]["name"], payload={"type": "kasserapport"})
    calls = _install(monkeypatch, behave)

    kx.classify_document("Zm9v")
    kx.detect_pos_format("Zm9v")
    kx.extract_kasserapport("Zm9v")
    assert [c["model"] for c in calls] == [
        "claude-default-under-test",   # classifier
        "claude-default-under-test",   # format detector
        "claude-accuracy-under-test",  # extractor: accuracy tier first
        "claude-default-under-test",   # ... then its DEFAULT_MODEL fallback
    ]


def test_receipt_and_doctype_reads_use_the_settings_models(monkeypatch, tmp_path):
    from app.services import claude_vision_ocr

    monkeypatch.delenv("AI_MODEL_DOCTYPE_CLASSIFIER", raising=False)
    calls = _install(monkeypatch, lambda kw: (
        RuntimeError("opus down") if kw["model"] == OPUS else _ok(kw["model"], text="receipt")))
    img = str(_jpeg(tmp_path))
    claude_vision_ocr.extract_receipt_data(img)
    claude_vision_ocr._CLASSIFIER_CACHE.clear()
    assert claude_vision_ocr.classify_document_type(img) == "receipt"
    assert [c["model"] for c in calls] == [OPUS, NEW, NEW]


def test_a_reader_reports_the_model_that_answered(monkeypatch, mem):
    from app.services.inventory_extractor import extract_image

    _install(monkeypatch, _missing_new_model(tool="extract_inventory_items",
                                             payload={"items": []}))
    _items, meta = extract_image(_jpeg_bytes())
    assert meta["model_used"] == LEGACY  # served by the legacy retry


# ─── 5. the wine label scan (raw HTTP) ──────────────────────────────────

class _HttpResp:
    def __init__(self, status: int, body: dict):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body)

    def json(self):
        return self._body


def test_wine_scan_gets_the_net_and_sends_no_temperature(monkeypatch, mem):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.models.user import User
    from app.routers import wine
    from app.services.auth import get_current_user, hash_password
    from tests.test_wine_scan_limits import JPEG

    sent: list[dict] = []
    label = json.dumps({"name": "Barolo", "producer": "Vietti", "vintage": 2019, "type": "red"})

    async def _post(self, url, *a, json=None, **k):  # noqa: A002 — httpx's own name
        sent.append(json)
        if json["model"] == NEW:
            return _HttpResp(404, {"type": "error",
                                   "error": {"type": "not_found_error", "message": f"model: {NEW}"}})
        # A thinking block first: the scan must read the first TEXT block.
        return _HttpResp(200, {"model": LEGACY, "content": [
            {"type": "thinking", "thinking": "", "signature": "x"},
            {"type": "text", "text": label},
        ]})

    monkeypatch.setattr(httpx.AsyncClient, "post", _post)

    db = mem()
    owner = User(email="guard@vin.dk", password_hash=hash_password("x"), business_name="Vin",
                 business_type="bar", currency="DKK", role="owner", plan="free")
    db.add(owner); db.commit(); db.refresh(owner)

    def _override():
        yield db

    from app.database import get_db
    app.dependency_overrides[get_db] = _override
    app.dependency_overrides[get_current_user] = lambda: owner
    try:
        wine._limiter.reset()
        r = TestClient(app).post("/api/wines/scan", files={"file": ("l.jpg", JPEG, "image/jpeg")})
    finally:
        app.dependency_overrides.clear()
        db.close()
    assert r.status_code == 200, r.text
    assert r.json()["success"] is True and r.json()["data"]["name"] == "Barolo"
    assert [b["model"] for b in sent] == [NEW, LEGACY]
    assert all("temperature" not in b for b in sent)
    assert len(_rows(mem)) == 1


def test_first_text_skips_a_leading_thinking_block():
    content = [types.SimpleNamespace(type="thinking", thinking=""),
               types.SimpleNamespace(type="text", text="[1]")]
    assert guard.first_text(content) == "[1]"
    assert guard.first_text([{"type": "thinking", "thinking": ""}]) is None
