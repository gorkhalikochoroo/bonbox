"""Contact details never reach the model, and the model knows they are withheld.

In Claude mode every agent tool result is sent to Anthropic as a tool_result.
query_staff returned each employee's phone and email and query_khata each
credit customer's phone, while the privacy policy promises "never raw customer
data". _for_model() strips phone, email, address and CPR fields at any depth
before the result is appended for the model. The owner's browser still gets
the full result on the SSE stream.

Dropping the keys silently has a cost: the system prompt also says "NEVER
guess or make up numbers", so "what's Hari's number?" would get "I don't have
a number for Hari", which reads as "none on file". The prompt therefore says
the fields are withheld on purpose and where the owner finds them.
"""
import inspect

from app.routers import agent
from app.routers.agent import _for_model


def test_contact_fields_are_removed_at_any_depth():
    staff = {"staff": [{"name": "Ana", "phone": "+45 12 34 56 78", "email": "ana@example.dk", "role": "chef", "hours": 30}], "count": 1}
    assert _for_model(staff) == {"staff": [{"name": "Ana", "role": "chef", "hours": 30}], "count": 1}

    khata = [{"name": "Hari", "customer_phone": "555", "outstanding": 1200.0,
              "entries": [{"note": "rice", "Address": "Vej 1"}]}]
    assert _for_model(khata) == [{"name": "Hari", "outstanding": 1200.0, "entries": [{"note": "rice"}]}]

    assert _for_model({"cpr_number": "010101-1234", "E_Mail": "x", "total": 3}) == {"total": 3}


def test_everything_else_passes_through_unchanged():
    result = {"revenue": 9000.0, "top_items": [{"name": "Momo", "qty": 41}], "ok": True, "note": None}
    assert _for_model(result) == result
    assert _for_model(5) == 5 and _for_model("text") == "text"
    assert _for_model(("a", {"b": 1})) == ["a", {"b": 1}]


def test_tool_results_for_the_model_go_through_the_filter():
    src = inspect.getsource(agent._claude_chat)
    assert '"content": json.dumps(_for_model(result))' in src
    assert '"content": json.dumps(result)' not in src


def test_the_model_is_told_contact_details_are_withheld():
    src = inspect.getsource(agent._claude_chat)
    assert "leave out phone numbers, email addresses and home addresses on purpose" in src
    assert "Never say it isn't on file" in src
