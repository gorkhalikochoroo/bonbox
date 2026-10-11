"""Push 3 (Manoj, 11 Oct 2026, B1): the Copilot never sends a phone number or
an e-mail address to Anthropic.

Every Copilot tool result goes to Anthropic's API as a tool_result
(routers/agent.py). query_khata used to return each khata customer's phone
number, and query_staff each staff member's phone number and e-mail. /privacy
now says the Copilot sends names, figures and shifts — never phone numbers or
e-mail addresses — so this file pins:

  * query_khata / query_staff return no contact field, and the stored phone
    numbers and e-mails appear nowhere in their output; the names, figures
    and shifts are still there;
  * no tool in TOOL_MAP returns a stored phone number or e-mail (all nine run
    against an account that has them);
  * end to end: what the fake Anthropic client RECEIVES in the tool_result
    holds the names but not the phone numbers or e-mails;
  * the second barrier: a tool that returns contact fields anyway (a future
    tool) has them stripped before anything is streamed or sent.
"""
from __future__ import annotations

import asyncio
import json
import random
import sys
import types
import uuid
from datetime import date, timedelta

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models import KhataCustomer, KhataTransaction
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.routers import agent as agent_router
from app.services import agent_tools
from app.services.auth import get_current_user, hash_password

_db_ready.set()

CUSTOMER_NAME = "Ramesh Thapa"
CUSTOMER_PHONE = "+4512345678"
STAFF_NAME = "Sofie Jensen"
STAFF_PHONE = "+4587654321"
STAFF_EMAIL = "sofie.jensen@example-staff.dk"
SECRETS = (CUSTOMER_PHONE, STAFF_PHONE, STAFF_EMAIL, "12345678", "87654321", "sofie.jensen@")


@pytest.fixture
def SessionLocal():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture
def db(SessionLocal):
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def as_user(SessionLocal):
    holder: dict = {}

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    app.dependency_overrides[get_current_user] = lambda: holder["user"]

    def _set(user):
        holder["user"] = user

    yield _set
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)


def _seed(db) -> User:
    """An owner with one khata customer (with a phone and a balance) and one
    staff member (with a phone, an e-mail and a shift later this week)."""
    u = User(
        id=str(uuid.uuid4()),
        email=f"{uuid.uuid4().hex[:10]}@cafe-example.dk",
        password_hash=hash_password("pw123456"),
        business_name="Venue", business_type="cafe", currency="DKK",
        plan="pro", role="owner", email_verified=True,
    )
    db.add(u)
    db.flush()
    cust = KhataCustomer(user_id=u.id, name=CUSTOMER_NAME, phone=CUSTOMER_PHONE)
    db.add(cust)
    db.flush()
    db.add(KhataTransaction(
        customer_id=cust.id, user_id=u.id, date=date.today() - timedelta(days=40),
        purchase_amount=500, paid_amount=100,
    ))
    staff = StaffMember(user_id=u.id, name=STAFF_NAME, phone=STAFF_PHONE, email=STAFF_EMAIL,
                        role="server", contract_type="full", active=True)
    db.add(staff)
    db.flush()
    db.add(Schedule(user_id=u.id, staff_id=staff.id, date=date.today(),
                    start_time="10:00", end_time="16:00", status="published"))
    db.commit()
    return u


def _keys(value) -> set[str]:
    out: set[str] = set()
    if isinstance(value, dict):
        for k, v in value.items():
            out.add(str(k).lower())
            out |= _keys(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            out |= _keys(v)
    return out


def _assert_no_contact(result) -> str:
    dumped = json.dumps(result, default=str)
    for secret in SECRETS:
        assert secret not in dumped, f"{secret!r} would be sent to Anthropic"
    for k in _keys(result):
        assert not any(p in k for p in ("phone", "email", "e_mail", "mobile")), k
    return dumped


# ─── the tools themselves ───────────────────────────────────────────

def test_query_khata_keeps_the_name_and_the_figures_but_not_the_phone(db):
    u = _seed(db)
    result = agent_tools.query_khata(db, u.id)
    dumped = _assert_no_contact(result)
    assert CUSTOMER_NAME in dumped
    [c] = result["data"]["customers"]
    assert c["name"] == CUSTOMER_NAME
    assert c["outstanding"] == 400.0 and c["is_overdue"] is True


def test_query_staff_keeps_names_roles_and_shifts_but_not_phone_or_email(db):
    u = _seed(db)
    result = agent_tools.query_staff(db, u.id)
    dumped = _assert_no_contact(result)
    assert STAFF_NAME in dumped
    [m] = result["data"]["staff"]
    assert m["name"] == STAFF_NAME and m["role"] == "server"
    # Data minimisation: only what the answers need — no contract type
    # (the seed has one, "full"); /privacy lists names, roles and shifts.
    assert set(m) == {"id", "name", "role"}
    assert "contract_type" not in dumped
    [shift] = result["data"]["upcoming_shifts"]
    assert shift["staff_name"] == STAFF_NAME
    assert (shift["start_time"], shift["end_time"]) == ("10:00", "16:00")


def test_no_copilot_tool_returns_a_stored_phone_number_or_email(db):
    u = _seed(db)
    assert set(agent_router.TOOL_MAP) == {
        "query_revenue", "query_expenses", "query_inventory", "query_waste", "query_khata",
        "query_cashbook", "business_overview", "query_staff", "business_suggestions",
    }, "a new Copilot tool: check it returns no phone number or e-mail, then add it here"
    for name, fn in agent_router.TOOL_MAP.items():
        _assert_no_contact(fn(db, u.id))


# ─── the second barrier ─────────────────────────────────────────────

def test_strip_contact_fields_removes_contact_keys_at_any_depth_and_keeps_the_rest():
    raw = {
        "summary": "2 staff",
        "data": {
            "staff": [
                {"name": "A", "role": "chef", "phone": "1", "Email": "a@x.dk", "mobile_number": "2"},
                {"name": "B", "contact": {"guest_email": "b@x.dk", "e_mail": "c@x.dk", "city": "Odense"}},
            ],
            "phone_numbers": ["3", "4"],
            "total": 2,
        },
    }
    out = agent_router.strip_contact_fields(raw)
    assert out == {
        "summary": "2 staff",
        "data": {
            "staff": [{"name": "A", "role": "chef"}, {"name": "B", "contact": {"city": "Odense"}}],
            "total": 2,
        },
    }
    # The tool's own dict is not changed (a copy is returned).
    assert raw["data"]["staff"][0]["phone"] == "1"


# ─── end to end: what Anthropic receives ────────────────────────────

class _Block:
    def __init__(self, type_, **kw):
        self.type = type_
        for k, v in kw.items():
            setattr(self, k, v)


class _Resp:
    def __init__(self, blocks):
        self.content = blocks
        self.usage = types.SimpleNamespace(input_tokens=10, output_tokens=5)
        self.model = "fake-model"


def _sse_events(text: str) -> list[tuple[str, dict]]:
    out = []
    for chunk in text.split("\n\n"):
        lines = chunk.strip().split("\n")
        if len(lines) >= 2 and lines[0].startswith("event: ") and lines[1].startswith("data: "):
            out.append((lines[0][7:], json.loads(lines[1][6:])))
    return out


def _chat_with_tools(monkeypatch, tool_calls: list[tuple[str, dict]]):
    """Run one Copilot turn where the model first asks for `tool_calls`,
    then answers. Returns (every kwargs the fake Anthropic client got, SSE events)."""
    monkeypatch.setattr(agent_router.settings, "ANTHROPIC_API_KEY", "test-key", raising=False)
    monkeypatch.setattr(agent_router.settings, "USE_CLAUDE_API", True, raising=False)
    received: list[dict] = []

    def create(**kwargs):
        received.append(json.loads(json.dumps(kwargs, default=str)))
        if len(received) == 1:
            return _Resp([_Block("tool_use", name=n, input=i, id=f"t{k}") for k, (n, i) in enumerate(tool_calls)])
        return _Resp([_Block("text", text="Færdig.")])

    class _Client:
        def __init__(self, **kwargs):
            self.messages = types.SimpleNamespace(create=create)

    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=_Client))

    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            ip = f"10.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}"
            return await c.post("/api/agent/chat", json={"message": "hvem skylder mig penge, og hvem arbejder?",
                                                          "history": []}, headers={"CF-Connecting-IP": ip})

    resp = asyncio.run(run())
    assert resp.status_code == 200, resp.text
    return received, _sse_events(resp.text)


def _tool_results_sent(received: list[dict]) -> list[str]:
    """The tool_result contents of the second model call — what Anthropic got."""
    assert len(received) == 2, "the model was called twice: tools, then the answer"
    sent = []
    for m in received[1]["messages"]:
        if m["role"] == "user" and isinstance(m["content"], list):
            sent += [b["content"] for b in m["content"] if b.get("type") == "tool_result"]
    return sent


def test_anthropic_receives_names_and_shifts_but_no_phone_or_email(db, as_user, monkeypatch):
    u = _seed(db)
    as_user(u)
    received, events = _chat_with_tools(monkeypatch, [("query_khata", {}), ("query_staff", {})])
    sent = _tool_results_sent(received)
    assert len(sent) == 2
    everything_sent = json.dumps(received)
    for secret in SECRETS:
        assert secret not in everything_sent, f"{secret!r} reached Anthropic"
    assert CUSTOMER_NAME in sent[0] and "400" in sent[0]
    assert STAFF_NAME in sent[1] and "10:00" in sent[1]
    # The page's data cards get the same stripped result.
    streamed = json.dumps([d for e, d in events if e == "tool_result"])
    for secret in SECRETS:
        assert secret not in streamed


def test_a_tool_that_returns_contact_fields_anyway_is_stripped_before_anthropic(db, as_user, monkeypatch):
    u = _seed(db)
    as_user(u)
    monkeypatch.setitem(agent_router.TOOL_MAP, "query_staff", lambda db, uid: {
        "summary": "1 active staff members",
        "data": {"staff": [{"name": STAFF_NAME, "role": "server", "phone": STAFF_PHONE, "email": STAFF_EMAIL}]},
    })
    received, events = _chat_with_tools(monkeypatch, [("query_staff", {})])
    [sent] = _tool_results_sent(received)
    assert json.loads(sent) == {"summary": "1 active staff members",
                                "data": {"staff": [{"name": STAFF_NAME, "role": "server"}]}}
    everything = json.dumps(received) + json.dumps(events)
    for secret in (STAFF_PHONE, STAFF_EMAIL):
        assert secret not in everything


# ─── the daily brief (SF2): what /privacy's Anthropic row says it sends ───

def test_daily_brief_payload_has_khata_names_but_no_phone_or_email(db):
    """/privacy: the daily brief sends "the names of khata customers who
    haven't been back for a while" — and never phone numbers or e-mail
    addresses. The brief's LLM payload is Precompute.to_dict()
    (daily_brief._try_llm_polish), so hold the real producer to it."""
    from app.services.daily_brief import compute_precompute
    u = _seed(db)
    cust = db.query(KhataCustomer).filter(KhataCustomer.user_id == u.id).one()
    for days_ago in (20, 30, 50):  # a regular (≥ 3 visits in 90 days), last seen 20 days ago
        db.add(KhataTransaction(customer_id=cust.id, user_id=u.id, date=date.today() - timedelta(days=days_ago),
                                purchase_amount=50, paid_amount=50))
    db.commit()
    payload = compute_precompute(u, db).to_dict()
    assert [r["name"] for r in payload["top_regulars_at_risk"]] == [CUSTOMER_NAME]
    _assert_no_contact(payload)


def test_privacy_says_what_the_daily_brief_sends():
    from pathlib import Path
    privacy = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "pages" / "PrivacyPolicyPage.jsx").read_text()
    assert ("For the daily brief: figures, item names, the names of khata customers who haven't been back for a "
            "while, your business name and type, the pages you use most and recent insights — never phone numbers "
            "or e-mail addresses.") in privacy
    assert ("For morgenbriefen: tal, varenavne, navnene på khata-kunder, der ikke har været forbi i et stykke tid, "
            "din virksomheds navn og type, de sider, du bruger mest, og seneste indsigter — aldrig telefonnumre "
            "eller e-mailadresser.") in privacy


# ─── /privacy says what this code sends ─────────────────────────────

def test_privacy_says_the_copilot_never_sends_stored_phone_numbers_or_emails():
    from pathlib import Path
    privacy = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "pages" / "PrivacyPolicyPage.jsx").read_text()
    assert "We never send the phone numbers or e-mail addresses stored in your account." in privacy
    assert "Vi sender aldrig de telefonnumre eller e-mailadresser, der er gemt på din konto." in privacy
    # The old sentence that hid the names and contact details is gone.
    assert "never raw customer data" not in privacy and "aldrig rå kundedata" not in privacy


# ─── the second barrier keeps payment methods (push-3 review F1) ────
#
# strip_contact_fields() used to drop every key that CONTAINED "mobile",
# so query_revenue's payment_split lost its "mobilepay" entry: the
# "By payment" line, the RevenueCard pills and the tool_result sent to
# Claude no longer added up to total_revenue. Contact keys are now matched
# by whole word, and the keys of payment_split are payment methods (data),
# never field names.

from app.models import Sale  # noqa: E402

PAYMENT_SPLIT_KEYS = ("cash", "card", "mobilepay", "mobile_pay", "MobilePay", "mobilePay", "mixed")


def _seed_sales(db, user) -> dict[str, float]:
    amounts = {"cash": 200.0, "card": 300.0, "mobilepay": 500.0}
    for method, amount in amounts.items():
        db.add(Sale(user_id=user.id, date=date.today(), amount=amount, payment_method=method))
    db.commit()
    return amounts


def test_mobilepay_is_never_stripped_at_any_depth():
    for key in PAYMENT_SPLIT_KEYS:
        raw = {key: 1, "data": {key: {"total": 2.0}, "rows": [{key: 3}]}}
        assert agent_router.strip_contact_fields(raw) == raw, key


def test_a_query_revenue_shaped_result_comes_through_unchanged():
    raw = {
        "summary": "This Month revenue: 1.000 kr from 3 sales",
        "data": {
            "total_revenue": 1000.0,
            "payment_split": {k: {"total": 100.0, "count": 1} for k in PAYMENT_SPLIT_KEYS},
            "currency": "DKK",
        },
    }
    assert agent_router.strip_contact_fields(raw) == raw


def test_the_payment_split_keeps_every_method_even_one_named_like_a_contact_field():
    # Sale.payment_method is a free string (SaleCreate takes any str), so a
    # method called "phone" (a phone order) is a payment method, not a
    # phone number. Its figures are still checked for contact keys.
    raw = {"data": {"payment_split": {
        "phone": {"total": 50.0, "count": 1},
        "mobile": {"total": 60.0, "count": 2, "email": "x@y.dk"},
    }}}
    assert agent_router.strip_contact_fields(raw) == {"data": {"payment_split": {
        "phone": {"total": 50.0, "count": 1},
        "mobile": {"total": 60.0, "count": 2},
    }}}


def test_contact_keys_are_still_stripped_by_whole_word():
    contact = ("phone", "Phone", "phone_number", "phoneNumber", "phone_numbers", "mobile", "Mobile",
               "mobile_number", "mobileNumber", "mobile_phone", "contact_mobile", "telephone", "email",
               "Email", "EMAIL", "e_mail", "e-mail", "eMail", "email_address", "emailAddress", "emails",
               "guest_email", "guest_phone", "contact_email", "contact_phone", "customer_phone",
               "staff_email", "mobilenumber", "mobilnummer")
    raw = {k: "secret" for k in contact}
    raw.update({"name": "A", "mobilepay_total": 1, "mobile_pay_count": 2})
    out = agent_router.strip_contact_fields(raw)
    assert set(out) == {"name", "mobilepay_total", "mobile_pay_count"}


def test_real_query_revenue_keeps_mobilepay_through_the_barrier(db):
    u = _seed(db)
    amounts = _seed_sales(db, u)
    result = agent_router.strip_contact_fields(agent_tools.query_revenue(db, u.id, period="this_month"))
    split = result["data"]["payment_split"]
    assert {m: v["total"] for m, v in split.items()} == amounts
    assert sum(v["total"] for v in split.values()) == result["data"]["total_revenue"] == 1000.0


def test_claude_path_sends_and_streams_the_whole_payment_split(db, as_user, monkeypatch):
    u = _seed(db)
    amounts = _seed_sales(db, u)
    as_user(u)
    received, events = _chat_with_tools(monkeypatch, [("query_revenue", {"period": "this_month"})])
    [sent] = _tool_results_sent(received)
    split = json.loads(sent)["data"]["payment_split"]
    assert {m: v["total"] for m, v in split.items()} == amounts
    [streamed] = [d["result"] for e, d in events if e == "tool_result"]
    assert {m: v["total"] for m, v in streamed["data"]["payment_split"].items()} == amounts


def test_local_path_streams_the_whole_payment_split_and_names_mobilepay(db, as_user, monkeypatch):
    u = _seed(db)
    amounts = _seed_sales(db, u)
    as_user(u)
    monkeypatch.setattr(agent_router.settings, "USE_CLAUDE_API", False, raising=False)
    monkeypatch.setattr(agent_router, "_detect_intent", lambda msg: ("query_revenue", {"period": "this_month"}))

    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            ip = f"10.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}"
            return await c.post("/api/agent/chat", json={"message": "omsætning denne måned", "history": []},
                                headers={"CF-Connecting-IP": ip})

    resp = asyncio.run(run())
    assert resp.status_code == 200, resp.text
    events = _sse_events(resp.text)
    [streamed] = [d["result"] for e, d in events if e == "tool_result"]
    assert {m: v["total"] for m, v in streamed["data"]["payment_split"].items()} == amounts
    text = "".join(d["delta"] for e, d in events if e == "text")
    assert "mobilepay: 500" in text, text


# ─── round 3 (G2): substring matching again, two narrow exemptions ──
#
# The whole-word rule kept joined-up and numbered contact keys that the old
# substring rule stripped (contactphone, guestemail, phone2, smartphone, ...)
# and every MobilePay-number key — a MobilePay number IS a phone number.
# Contact keys are matched by substring again (phone, email, e-mail, e_mail,
# telefon, tlf, mobil not followed by "pay", and mobil...number). The only
# exemptions: the keys of the data-keyed maps payment_split and
# role_breakdown (their values are still checked), and a key that is exactly
# a payment-method name (mobilepay, mobile_pay, mobilepayment(s)).

STRIPPED_BY_SUBSTRING = (
    "contactphone", "contactemail", "customerphone", "guestemail", "ownerphone", "phone2", "email2",
    "phone1", "mobile2", "smartphone", "mobilepay_number", "mobilePayNumber", "mobile_pay_number",
    "MobilePayNumber", "mobilepay_nummer", "mobilepaynumber", "e.mail", "kunde_tlf", "telefonnr",
    "mobilnr", "Mobil",
)


def test_joined_up_and_numbered_contact_keys_are_stripped_again():
    raw = {k: "+4512345678" for k in STRIPPED_BY_SUBSTRING}
    raw["name"] = "A"
    out = agent_router.strip_contact_fields(raw)
    assert out == {"name": "A"}, sorted(set(out) - {"name"})


def test_contact_keys_are_stripped_at_any_depth_by_substring():
    for key in STRIPPED_BY_SUBSTRING:
        raw = {"data": {"rows": [{"name": "A", key: "x"}], "nested": {key: {"v": 1}, "total": 2}}}
        assert agent_router.strip_contact_fields(raw) == {
            "data": {"rows": [{"name": "A"}], "nested": {"total": 2}}}, key


def test_a_payment_method_name_is_kept_and_its_totals_too():
    keep = ("mobilepay", "mobile_pay", "MobilePay", "mobilePay", "Mobile-Pay", "mobilepayment",
            "mobile_payments", "mobilepay_total", "mobile_pay_count")
    raw = {k: 1 for k in keep}
    assert agent_router.strip_contact_fields(raw) == raw


def test_role_breakdown_keys_are_kept_and_their_values_still_checked():
    # query_staff's role_breakdown is keyed by role NAMES (user data): a
    # role called "Telefon" or "Phone orders" is a role, not a phone number.
    raw = {"data": {
        "role_breakdown": {"Telefon": 2, "Phone orders": 1, "waiter": 3,
                           "mobil": {"count": 1, "phone": "+4512345678"}},
        "payment_split": {"phone": {"total": 50.0, "count": 1, "guestemail": "x@y.dk"}},
    }}
    assert agent_router.strip_contact_fields(raw) == {"data": {
        "role_breakdown": {"Telefon": 2, "Phone orders": 1, "waiter": 3, "mobil": {"count": 1}},
        "payment_split": {"phone": {"total": 50.0, "count": 1}},
    }}


def test_a_data_keyed_map_never_carries_a_contact_string():
    # Keys of payment_split / role_breakdown are kept because their values are
    # figures. A contact-looking key whose value is a plain string is a
    # contact detail, not a figure, and is stripped.
    raw = {"payment_split": {"email": "a@b.dk", "card": {"total": 1.0}},
           "role_breakdown": {"phone": "+4512345678", "chef": 2}}
    assert agent_router.strip_contact_fields(raw) == {
        "payment_split": {"card": {"total": 1.0}}, "role_breakdown": {"chef": 2}}


def test_real_query_staff_keeps_a_role_named_like_a_contact_field(db):
    u = _seed(db)
    for i, role in enumerate(("Telefon", "Phone orders")):
        db.add(StaffMember(user_id=u.id, name=f"Extra {i}", role=role, contract_type="part", active=True))
    db.commit()
    result = agent_router.strip_contact_fields(agent_tools.query_staff(db, u.id))
    breakdown = result["data"]["role_breakdown"]
    assert breakdown == {"server": 1, "Telefon": 1, "Phone orders": 1}
    assert sum(breakdown.values()) == result["data"]["total_staff"] == 3
