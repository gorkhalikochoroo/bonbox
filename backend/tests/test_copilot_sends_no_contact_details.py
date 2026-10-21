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
    tool) has them stripped before anything is streamed or sent;
  * (21 Oct 2026, PR #234 port) home addresses and CPR numbers are stripped
    too, "cpr" only as a whole word (basic_profit stays), and the system
    prompt tells the model contact details are left out on purpose.
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


# ─── round 4 (H2): "mail" / "e-post", more phone spellings, a strict MobilePay ──
#
# Round 3's substrings (phone, email, telefon, tlf, mobil...) missed e-mail
# keys spelled with a bare "mail" — the everyday Danish word ("mailadresse",
# "kontakt_mail") — and "epost" / "e-post", and common phone spellings (tel,
# tel_nr, gsm, msisdn, whatsapp, cell_number, mob_no, fax). The ambiguous
# short ones (tel, gsm, cell, mob, fax, sms) are matched only as a whole word
# of the key (hotel, telemetry, excel, logs_merged are not contact fields).
# And the MobilePay exemption is now strict: only the payment method itself
# (mobilepay, mobilepayment(s)) and mobilepay + an aggregate (total, count,
# amount, revenue, sum, share, pct, percent, fee, fees) are kept; a MobilePay
# NUMBER or a person's MobilePay (mobilepay_no, customer_mobilepay) is not.

import ast  # noqa: E402
import re  # noqa: E402
from pathlib import Path  # noqa: E402

STRIPPED_ROUND_4 = (
    # e-mail spelled with a bare "mail", or "e-post"
    "mail", "Mail", "mailadresse", "mail_adresse", "kontakt_mail", "kontaktmail", "mail_address",
    "mailAddress", "epost", "e-post", "e_post", "kunde_epost",
    # phone spellings
    "tel", "Tel", "tel_no", "telno", "tel_nr", "telnr", "guest_tel", "telNo", "tel2", "Kunde-Tel",
    "gsm", "gsm_nr", "gsmNr", "msisdn", "whatsapp", "whatsapp_number", "WhatsApp", "cell_number",
    "cellNumber", "cellnumber", "mob_no", "mobNo", "fax", "fax_number", "sms_number",
    # a MobilePay number, or a person's MobilePay, is a phone number
    "mobilepay_no", "mobilePayNo", "mobilepay_num", "mobile_pay_no", "customer_mobilepay",
    "guest_mobilepay", "payer_mobilepay", "contact_mobile_pay",
)

# Payment-method keys and MobilePay aggregates: figures, not contact details.
KEPT_MOBILEPAY = (
    "mobilepay", "mobile_pay", "MobilePay", "mobilePay", "Mobile-Pay", "mobilepayment",
    "mobile_payments", "mobilepay_total", "mobile_pay_count", "mobilepay_amount", "mobilepay_revenue",
    "mobilepay_sum", "mobilepay_share", "mobilepay_pct", "mobilepay_percent", "mobilepay_fee",
    "mobilePayFees",
)

# Words that merely CONTAIN tel / cell / gsm / fax / mob / sms are not contact keys.
KEPT_LOOKALIKES = (
    "hotel", "hotel_revenue", "telemetry_count", "cancel_count", "excel_rows", "excel_number",
    "logs_merged", "bags_mall", "faxe_total", "mobs", "smsa", "intel", "hostel_nights",
)


@pytest.mark.parametrize("key", STRIPPED_ROUND_4)
def test_round_4_contact_spellings_are_stripped_at_any_depth(key):
    assert agent_router.strip_contact_fields({key: "+4512345678", "name": "A"}) == {"name": "A"}
    raw = {"data": {"rows": [{"name": "A", key: "ida@x.dk"}], "nested": {key: {"v": 1}, "total": 2}}}
    assert agent_router.strip_contact_fields(raw) == {
        "data": {"rows": [{"name": "A"}], "nested": {"total": 2}}}


def test_the_mobilepay_method_and_its_aggregates_are_kept():
    raw = {k: 1 for k in KEPT_MOBILEPAY}
    assert agent_router.strip_contact_fields(raw) == raw


def test_keys_that_merely_contain_a_short_phone_word_are_kept():
    raw = {k: 1 for k in KEPT_LOOKALIKES}
    assert agent_router.strip_contact_fields(raw) == raw


def test_data_keyed_maps_keep_their_keys_and_drop_contact_strings_under_round_4_spellings():
    raw = {"data": {
        "payment_split": {"mobilepay": {"total": 500.0, "count": 3}, "Mail": {"total": 1.0},
                          "mobilepay_no": "12345678"},
        "role_breakdown": {"Tel": 2, "kontakt_mail": "ida@x.dk", "chef": 1},
    }}
    assert agent_router.strip_contact_fields(raw) == {"data": {
        "payment_split": {"mobilepay": {"total": 500.0, "count": 3}, "Mail": {"total": 1.0}},
        "role_breakdown": {"Tel": 2, "chef": 1},
    }}


def _literal_tool_keys() -> tuple[set[str], set[str]]:
    """(dict keys the tools build, every identifier-like string literal and
    keyword name in services/agent_tools.py — a superset)."""
    path = Path(agent_tools.__file__)
    tree = ast.parse(path.read_text())
    docstrings = {
        id(n.body[0].value) for n in ast.walk(tree)
        if isinstance(n, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        and n.body and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant)
    }
    dict_keys, literals = set(), set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Dict):
            dict_keys |= {k.value for k in n.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)}
        elif isinstance(n, ast.Subscript) and isinstance(n.ctx, ast.Store) \
                and isinstance(n.slice, ast.Constant) and isinstance(n.slice.value, str):
            dict_keys.add(n.slice.value)
        elif isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docstrings \
                and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_\-]*", n.value):
            literals.add(n.value)
        elif isinstance(n, ast.keyword) and n.arg:
            literals.add(n.arg)
    return dict_keys, literals | dict_keys


def test_no_real_tool_key_is_stripped_by_the_rule():
    """Every literal key the Copilot tools build (and every identifier-like
    literal in agent_tools.py) goes through the rule: none is a contact key,
    so no figure the Copilot shows can vanish (the F1 class of bug)."""
    dict_keys, everything = _literal_tool_keys()
    assert len(dict_keys) >= 90, sorted(dict_keys)  # the extraction found the tools' keys
    stripped = sorted(k for k in everything if agent_router._is_contact_key(k))
    assert stripped == [], stripped
    raw = {k: 1 for k in everything}
    assert agent_router.strip_contact_fields(raw) == raw


# ─── home addresses and CPR numbers (PR #234 port, 21 Oct 2026) ─────
#
# Customer and staff addresses are stored, and a venue may hold a CPR number.
# No Copilot tool returns one today; the second barrier must catch one that a
# future tool adds, so it never reaches Anthropic (/privacy). Keys with
# "address", "adresse" or "personnummer" in them are stripped by substring.
# "cpr" is stripped only as a WHOLE WORD of the key: as a substring it would
# also hide keys such as basic_profit, specific_product or graphic_print,
# which a future tool could return (the F1 class of bug, like the MobilePay
# one above). No tool returns any key with c-p-r in it today.
#
# The model is also told these fields are left out on purpose. Without that,
# "what's Hari's number?" gets "I don't have a number for Hari", which reads
# as "none on file".

HOME_ADDRESS = "Testvej 99, 5000 Odense C"
CPR_NUMBER = "010190-1234"

STRIPPED_ADDRESS_AND_CPR = (
    "Address", "address", "home_address", "homeAddress", "street_address", "adresse", "Adresse",
    "hjemmeadresse", "kunde_adresse", "personnummer", "Personnummer", "cpr", "CPR", "cpr_number",
    "cprNr", "CPR-nummer", "cpr_nr", "cpr_no", "cprnummer", "staff_cpr", "staffCpr",
)

# Keys that merely contain the letters c-p-r, and plain location fields.
KEPT_NOT_ADDRESS_OR_CPR = (
    "basic_profit", "basicProfit", "specific_product", "graphic_print", "city", "postal_code",
)

PRIVACY_PROMPT_LINE = (
    "- Tool results leave out phone numbers, email addresses and home addresses on purpose "
    "(privacy). If the owner asks for one, say the assistant isn't given contact details and "
    "point them to the Team, Reservations or Customers page. Never say it isn't on file.\n"
)


# Review round (21 Oct 2026): one-word CPR keys, short forms of personnummer
# and "addr" got through. A key that ENDS in cpr (+ a number word) is
# stripped; "addr" only as a whole word, because as a substring it would hit
# add_rate / add_revenue ("addrate").
STRIPPED_JOINED_CPR_AND_SHORT_FORMS = (
    "staffcpr", "kundecpr", "employeecpr", "medarbejdercpr", "staffcprnr", "staffCPRnr", "staffcpr2",
    "cprnum", "CPRNUM", "cprid", "cprnumre", "cprnummeret",
    "personnr", "person_nr", "personNr", "Personnr", "kunde_personnr",
    "addr", "Addr", "home_addr", "homeAddr", "addr1",
)

# Must stay: they only contain the letters c-p-r or a-d-d-r. A naive
# "starts with cpr" rule would hit c_price; "addr" as a substring add_rate.
KEPT_LOOKALIKES_OF_THE_JOINED_RULES = (
    "basicprofit", "specificproduct", "graphicprint", "basic_price", "c_price", "cPrice",
    "cost_per_unit", "corp", "cpu", "add_rate", "add_revenue", "had_drinks",
)


def test_contact_fields_are_removed_at_any_depth():
    # PR #234 test 1, against main's strip_contact_fields.
    staff = {"staff": [{"name": "Ana", "phone": "+45 12 34 56 78", "email": "ana@example.dk", "role": "chef",
                        "hours": 30}], "count": 1}
    assert agent_router.strip_contact_fields(staff) == {
        "staff": [{"name": "Ana", "role": "chef", "hours": 30}], "count": 1}

    khata = [{"name": "Hari", "customer_phone": "555", "outstanding": 1200.0,
              "entries": [{"note": "rice", "Address": "Vej 1"}]}]
    assert agent_router.strip_contact_fields(khata) == [
        {"name": "Hari", "outstanding": 1200.0, "entries": [{"note": "rice"}]}]

    assert agent_router.strip_contact_fields({"cpr_number": "010101-1234", "E_Mail": "x", "total": 3}) == {"total": 3}


def test_everything_else_passes_through_unchanged():
    # PR #234 test 2, against main's strip_contact_fields.
    result = {"revenue": 9000.0, "top_items": [{"name": "Momo", "qty": 41}], "ok": True, "note": None}
    assert agent_router.strip_contact_fields(result) == result
    assert agent_router.strip_contact_fields(5) == 5
    assert agent_router.strip_contact_fields("text") == "text"
    assert agent_router.strip_contact_fields(("a", {"b": 1})) == ["a", {"b": 1}]


@pytest.mark.parametrize("key", STRIPPED_ADDRESS_AND_CPR)
def test_every_address_and_cpr_spelling_is_stripped_at_any_depth(key):
    assert agent_router.strip_contact_fields({key: HOME_ADDRESS, "name": "A"}) == {"name": "A"}
    raw = {"data": {"rows": [{"name": "A", key: CPR_NUMBER}],
                    "nested": {key: {"street": "Testvej 99"}, "total": 2},
                    "deeper": [{"person": {key: HOME_ADDRESS, "role": "chef"}}]}}
    assert agent_router.strip_contact_fields(raw) == {
        "data": {"rows": [{"name": "A"}], "nested": {"total": 2}, "deeper": [{"person": {"role": "chef"}}]}}


@pytest.mark.parametrize("key", KEPT_NOT_ADDRESS_OR_CPR)
def test_names_that_only_look_like_cpr_or_address_are_kept(key):
    raw = {key: 1250.0, "data": {"rows": [{key: "Odense"}], "nested": {key: {"total": 2}}}}
    assert agent_router.strip_contact_fields(raw) == raw


@pytest.mark.parametrize("key", STRIPPED_JOINED_CPR_AND_SHORT_FORMS)
def test_one_word_cpr_keys_and_short_forms_are_stripped_at_any_depth(key):
    assert agent_router.strip_contact_fields({key: CPR_NUMBER, "name": "A"}) == {"name": "A"}
    raw = {"data": {"rows": [{"name": "A", key: CPR_NUMBER}],
                    "deeper": [{"person": {key: HOME_ADDRESS, "role": "chef"}}]}}
    assert agent_router.strip_contact_fields(raw) == {
        "data": {"rows": [{"name": "A"}], "deeper": [{"person": {"role": "chef"}}]}}


@pytest.mark.parametrize("key", KEPT_LOOKALIKES_OF_THE_JOINED_RULES)
def test_lookalikes_of_the_one_word_rules_are_kept(key):
    raw = {key: 1250.0, "data": {"rows": [{key: "Odense"}], "nested": {key: {"total": 2}}}}
    assert agent_router.strip_contact_fields(raw) == raw


def test_the_model_is_told_contact_details_are_left_out_on_purpose(db, as_user, monkeypatch):
    u = _seed(db)
    as_user(u)
    received, _events = _chat_with_tools(monkeypatch, [("query_staff", {})])
    assert len(received) == 2
    for call in received:  # both rounds: the tool request and the answer
        system = call["system"]
        assert isinstance(system, str), type(system)
        assert "- NEVER guess or make up numbers.\n" + PRIVACY_PROMPT_LINE + "\n## Response style" in system


def test_a_tool_that_returns_nested_address_and_cpr_is_stripped_before_anthropic(db, as_user, monkeypatch):
    u = _seed(db)
    as_user(u)
    monkeypatch.setitem(agent_router.TOOL_MAP, "query_staff", lambda db, uid: {
        "summary": "1 active staff members",
        "data": {"staff": [{
            "name": STAFF_NAME, "role": "server", "home_address": HOME_ADDRESS, "cpr_number": CPR_NUMBER,
            "details": {"Adresse": HOME_ADDRESS, "CPR": CPR_NUMBER, "personnummer": CPR_NUMBER,
                        "city": "Odense", "postal_code": "5000"},
        }]},
    })
    received, events = _chat_with_tools(monkeypatch, [("query_staff", {})])
    [sent] = _tool_results_sent(received)
    assert json.loads(sent) == {"summary": "1 active staff members", "data": {"staff": [{
        "name": STAFF_NAME, "role": "server", "details": {"city": "Odense", "postal_code": "5000"}}]}}
    # Nothing Anthropic got, and nothing streamed to the page, holds them.
    everything = json.dumps(received) + json.dumps(events)
    for secret in (HOME_ADDRESS, "Testvej", CPR_NUMBER, "010190"):
        assert secret not in everything, f"{secret!r} reached Anthropic or the stream"
