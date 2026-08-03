"""Group chat — the authorization surface.

A 1:1 thread could prove access with `thread.staff_id == me`. A group cannot:
staff_id is NULL there and there are N people. Every check moved to
`staff_chat_members`, and that move is the whole risk. What these tests pin:

  1. A non-member cannot read a group's messages, photos, or even learn it
     exists — and no amount of being a legitimate member of SOME thread helps.
  2. Membership never substitutes for the tenant filter. A member of business
     A's group is still a stranger to business B.
  3. You cannot add someone from another business to a group, and you cannot
     create a group you are not in.
  4. Read state is per-person. One member opening a group must not zero
     anybody else's badge — the old shared column would have.
  5. `mine` is decided by identity. In a group everyone is sender_type='staff',
     so role-based `mine` would render every colleague's message as your own.
  6. Removal is real: a removed member's next read fails, immediately.

Run:
  cd backend && python3 -m pytest tests/test_staff_chat_groups.py -x -q
"""

import io
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember, StaffLink, StaffChatMember
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    from app.routers import staff_chat as sc
    sc._limiter.reset()
    yield
    sc._limiter.reset()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _as_owner(user):
    if user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = lambda: user


def _owner(db, suffix=""):
    u = User(
        email=f"o{suffix}{uuid.uuid4().hex[:6]}@bonbox.dk",
        password_hash=hash_password("x"), business_name=f"Bon{suffix}",
        business_type="cafe", currency="DKK", role="owner",
        timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _staff(db, owner, name, token):
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role="server")
    db.add(m); db.commit(); db.refresh(m)
    db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=m.id,
                     token=token, active=True))
    db.commit()
    return m


def _png():
    # 1x1 PNG — smallest thing sanitize_chat_photo will accept.
    return (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00"
        b"\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
    )


def _make_group(client, token, title, staff_ids):
    r = client.post(f"/api/portal/{token}/chat/groups",
                    json={"title": title, "staff_ids": [str(s) for s in staff_ids]})
    assert r.status_code == 200, r.text
    return r.json()["thread_id"]


# ── 1. a non-member is simply not there ──────────────────────────────────

def test_non_member_cannot_read_a_group(client, db):
    o = _owner(db)
    a = _staff(db, o, "Agnes", "tok-a")
    b = _staff(db, o, "Bo", "tok-b")
    _staff(db, o, "Carl", "tok-c")                 # a colleague, left out

    tid = _make_group(client, "tok-a", "Køkken", [b.id])
    client.post(f"/api/portal/tok-a/chat/threads/{tid}", json={"body": "møde kl 9"})

    assert client.get(f"/api/portal/tok-b/chat/threads/{tid}").status_code == 200
    assert client.get(f"/api/portal/tok-c/chat/threads/{tid}").status_code == 403


def test_non_member_cannot_send_into_a_group(client, db):
    o = _owner(db)
    a = _staff(db, o, "Agnes", "tok-a")
    b = _staff(db, o, "Bo", "tok-b")
    _staff(db, o, "Carl", "tok-c")
    tid = _make_group(client, "tok-a", "Køkken", [b.id])

    r = client.post(f"/api/portal/tok-c/chat/threads/{tid}", json={"body": "hej"})
    assert r.status_code == 403


def test_a_group_does_not_appear_in_a_non_members_list(client, db):
    o = _owner(db)
    _staff(db, o, "Agnes", "tok-a")
    b = _staff(db, o, "Bo", "tok-b")
    _staff(db, o, "Carl", "tok-c")
    _make_group(client, "tok-a", "Køkken", [b.id])

    kinds = [t["kind"] for t in
             client.get("/api/portal/tok-c/chat/threads").json()["threads"]]
    assert kinds == ["direct"]           # their owner thread, nothing else


def test_non_member_cannot_fetch_a_group_photo(client, db):
    """The highest-stakes one: photos are proxy-served, and the old check
    (`thread.staff_id == me`) is NULL for a group — so the rewrite had to be
    membership-based without ever dropping the tenant filter."""
    o = _owner(db)
    _staff(db, o, "Agnes", "tok-a")
    b = _staff(db, o, "Bo", "tok-b")
    _staff(db, o, "Carl", "tok-c")
    tid = _make_group(client, "tok-a", "Køkken", [b.id])

    r = client.post(
        f"/api/portal/tok-a/chat/threads/{tid}/photos",
        files=[("photos", ("x.png", io.BytesIO(_png()), "image/png"))],
    )
    assert r.status_code == 200, r.text
    pid = r.json()["photos"][0]["id"]

    assert client.get(f"/api/portal/tok-b/chat/photo/{pid}").status_code == 200
    # 404, not 403 — never confirm the photo id to someone who may not see it.
    assert client.get(f"/api/portal/tok-c/chat/photo/{pid}").status_code == 404


# ── 2. membership never replaces the tenant filter ───────────────────────

def test_a_group_id_from_another_business_is_unreachable(client, db):
    """Both callers are legitimate members of a group — of DIFFERENT owners."""
    o1 = _owner(db, "1"); o2 = _owner(db, "2")
    _staff(db, o1, "Agnes", "tok-a")
    b1 = _staff(db, o1, "Bo", "tok-b")
    _staff(db, o2, "Rival", "tok-r")
    r2 = _staff(db, o2, "Rival2", "tok-r2")

    theirs = _make_group(client, "tok-a", "Køkken", [b1.id])
    _make_group(client, "tok-r", "Deres", [r2.id])       # caller IS a member here

    assert client.get(f"/api/portal/tok-r/chat/threads/{theirs}").status_code == 404
    assert client.post(f"/api/portal/tok-r/chat/threads/{theirs}",
                       json={"body": "hi"}).status_code == 404


def test_owner_cannot_open_another_businesss_group(client, db):
    o1 = _owner(db, "1"); o2 = _owner(db, "2")
    _staff(db, o1, "Agnes", "tok-a")
    b = _staff(db, o1, "Bo", "tok-b")
    theirs = _make_group(client, "tok-a", "Køkken", [b.id])

    _as_owner(o2)
    try:
        assert client.get(f"/api/staff/chat/groups/{theirs}").status_code == 404
        assert client.delete(f"/api/staff/chat/groups/{theirs}").status_code == 404
    finally:
        _as_owner(None)


def test_a_malformed_thread_id_is_a_404_not_a_500(client, db):
    o = _owner(db); _staff(db, o, "Agnes", "tok-a")
    assert client.get("/api/portal/tok-a/chat/threads/not-a-uuid").status_code == 404


# ── 3. you cannot build a group out of strangers ─────────────────────────

def test_a_foreign_staff_id_is_silently_dropped_from_a_new_group(client, db):
    o1 = _owner(db, "1"); o2 = _owner(db, "2")
    a = _staff(db, o1, "Agnes", "tok-a")
    outsider = _staff(db, o2, "Rival", "tok-r")

    r = client.post("/api/portal/tok-a/chat/groups",
                    json={"title": "Køkken", "staff_ids": [str(outsider.id)]})
    assert r.status_code == 200
    assert [str(a.id)] == r.json()["member_ids"]     # creator only

    tid = r.json()["thread_id"]
    assert client.get(f"/api/portal/tok-r/chat/threads/{tid}").status_code == 404


def test_the_creator_is_always_a_member(client, db):
    """Otherwise you could start a conversation you are not in — a way to make
    people talk somewhere you can be told about but never be seen in."""
    o = _owner(db)
    a = _staff(db, o, "Agnes", "tok-a")
    b = _staff(db, o, "Bo", "tok-b")
    r = client.post("/api/portal/tok-a/chat/groups",
                    json={"title": "Køkken", "staff_ids": [str(b.id)]})
    assert str(a.id) in r.json()["member_ids"]


def test_a_deactivated_colleague_cannot_be_added(client, db):
    o = _owner(db)
    _staff(db, o, "Agnes", "tok-a")
    gone = _staff(db, o, "Fired", "tok-f")
    gone.active = False
    db.commit()

    r = client.post("/api/portal/tok-a/chat/groups",
                    json={"title": "Køkken", "staff_ids": [str(gone.id)]})
    assert str(gone.id) not in r.json()["member_ids"]


def test_a_group_needs_a_name(client, db):
    o = _owner(db); _staff(db, o, "Agnes", "tok-a")
    assert client.post("/api/portal/tok-a/chat/groups",
                       json={"title": "   ", "staff_ids": []}).status_code == 400


def test_colleague_picker_exposes_names_only(client, db):
    """A picker needs a name. Anything more turns chat into a directory leak."""
    o = _owner(db)
    _staff(db, o, "Agnes", "tok-a")
    _staff(db, o, "Bo", "tok-b")
    body = client.get("/api/portal/tok-a/chat/colleagues").json()["colleagues"]
    assert [c["name"] for c in body] == ["Bo"]          # never themselves
    assert set(body[0]) == {"staff_id", "name", "role"}


def test_colleagues_never_cross_the_tenant(client, db):
    o1 = _owner(db, "1"); o2 = _owner(db, "2")
    _staff(db, o1, "Agnes", "tok-a")
    _staff(db, o2, "Rival", "tok-r")
    body = client.get("/api/portal/tok-a/chat/colleagues").json()["colleagues"]
    assert body == []


# ── 4. read state is per person ──────────────────────────────────────────

def test_one_member_reading_does_not_clear_anothers_badge(client, db):
    """The shared `staff_last_read_at` column would have. This is why
    membership rows carry their own last_read_at."""
    o = _owner(db)
    a = _staff(db, o, "Agnes", "tok-a")
    b = _staff(db, o, "Bo", "tok-b")
    c = _staff(db, o, "Carl", "tok-c")
    tid = _make_group(client, "tok-a", "Køkken", [b.id, c.id])
    client.post(f"/api/portal/tok-a/chat/threads/{tid}", json={"body": "møde kl 9"})

    client.get(f"/api/portal/tok-b/chat/threads/{tid}")        # Bo reads
    assert client.get("/api/portal/tok-b/chat/unread").json()["unread"] == 0
    assert client.get("/api/portal/tok-c/chat/unread").json()["unread"] == 1


def test_your_own_message_is_never_unread_to_you(client, db):
    o = _owner(db)
    _staff(db, o, "Agnes", "tok-a")
    b = _staff(db, o, "Bo", "tok-b")
    tid = _make_group(client, "tok-a", "Køkken", [b.id])
    client.post(f"/api/portal/tok-a/chat/threads/{tid}", json={"body": "hej"})
    assert client.get("/api/portal/tok-a/chat/unread").json()["unread"] == 0


def test_the_badge_spans_groups_and_the_owner_thread(client, db):
    o = _owner(db)
    a = _staff(db, o, "Agnes", "tok-a")
    b = _staff(db, o, "Bo", "tok-b")
    tid = _make_group(client, "tok-a", "Køkken", [b.id])
    client.post(f"/api/portal/tok-b/chat/threads/{tid}", json={"body": "fra Bo"})

    _as_owner(o)
    try:
        client.post(f"/api/staff/chat/threads/{a.id}", json={"body": "fra chefen"})
    finally:
        _as_owner(None)

    assert client.get("/api/portal/tok-a/chat/unread").json()["unread"] == 2


# ── 5. "mine" is identity, not role ──────────────────────────────────────

def test_a_colleagues_message_is_not_mine(client, db):
    o = _owner(db)
    _staff(db, o, "Agnes", "tok-a")
    b = _staff(db, o, "Bo", "tok-b")
    tid = _make_group(client, "tok-a", "Køkken", [b.id])
    client.post(f"/api/portal/tok-b/chat/threads/{tid}", json={"body": "fra Bo"})

    msgs = client.get(f"/api/portal/tok-a/chat/threads/{tid}").json()["messages"]
    sent = [m for m in msgs if m["body"] == "fra Bo"][0]
    assert sent["sender_type"] == "staff"       # everyone in a group is 'staff'
    assert sent["mine"] is False                # …but it is not Agnes's
    assert sent["sender_name"] == "Bo"


def test_my_own_message_is_mine(client, db):
    o = _owner(db)
    _staff(db, o, "Agnes", "tok-a")
    b = _staff(db, o, "Bo", "tok-b")
    tid = _make_group(client, "tok-a", "Køkken", [b.id])
    client.post(f"/api/portal/tok-a/chat/threads/{tid}", json={"body": "fra Agnes"})
    msgs = client.get(f"/api/portal/tok-a/chat/threads/{tid}").json()["messages"]
    assert msgs[0]["mine"] is True


def test_a_client_cannot_claim_to_be_someone_else(client, db):
    """sender_staff_id is server-set from the token, like sender_type."""
    o = _owner(db)
    _staff(db, o, "Agnes", "tok-a")
    b = _staff(db, o, "Bo", "tok-b")
    tid = _make_group(client, "tok-a", "Køkken", [b.id])
    client.post(f"/api/portal/tok-a/chat/threads/{tid}",
                json={"body": "spoof", "sender_staff_id": str(b.id),
                      "sender_type": "owner"})
    msgs = client.get(f"/api/portal/tok-b/chat/threads/{tid}").json()["messages"]
    assert msgs[0]["sender_type"] == "staff"
    assert msgs[0]["sender_name"] == "Agnes"
    assert msgs[0]["mine"] is False


# ── 6. removal takes effect at once ──────────────────────────────────────

def test_owner_removing_a_member_ends_their_access(client, db):
    o = _owner(db)
    _staff(db, o, "Agnes", "tok-a")
    b = _staff(db, o, "Bo", "tok-b")
    tid = _make_group(client, "tok-a", "Køkken", [b.id])
    assert client.get(f"/api/portal/tok-b/chat/threads/{tid}").status_code == 200

    _as_owner(o)
    try:
        r = client.patch(f"/api/staff/chat/groups/{tid}",
                         json={"staff_ids": []})       # full roster, not a delta
        assert r.status_code == 200, r.text
    finally:
        _as_owner(None)

    assert client.get(f"/api/portal/tok-b/chat/threads/{tid}").status_code == 403


def test_leaving_a_group_ends_your_access(client, db):
    o = _owner(db)
    _staff(db, o, "Agnes", "tok-a")
    b = _staff(db, o, "Bo", "tok-b")
    tid = _make_group(client, "tok-a", "Køkken", [b.id])

    assert client.post(f"/api/portal/tok-b/chat/groups/{tid}/leave").status_code == 200
    assert client.get(f"/api/portal/tok-b/chat/threads/{tid}").status_code == 403


def test_the_owner_thread_cannot_be_left(client, db):
    """It is the channel the schedule speaks through — leaving it would make a
    staffer unreachable while looking like a normal chat action."""
    o = _owner(db)
    _staff(db, o, "Agnes", "tok-a")
    direct = [t for t in client.get("/api/portal/tok-a/chat/threads").json()["threads"]
              if t["kind"] == "direct"][0]["thread_id"]
    assert client.post(
        f"/api/portal/tok-a/chat/groups/{direct}/leave"
    ).status_code == 400


def test_deleting_a_group_ends_everyones_access(client, db):
    o = _owner(db)
    _staff(db, o, "Agnes", "tok-a")
    b = _staff(db, o, "Bo", "tok-b")
    tid = _make_group(client, "tok-a", "Køkken", [b.id])

    _as_owner(o)
    try:
        assert client.delete(f"/api/staff/chat/groups/{tid}").status_code == 200
    finally:
        _as_owner(None)

    assert client.get(f"/api/portal/tok-a/chat/threads/{tid}").status_code == 403
    assert client.get(f"/api/portal/tok-b/chat/threads/{tid}").status_code == 403


# ── the 1:1 path must not have regressed ─────────────────────────────────

def test_the_direct_thread_still_works_end_to_end(client, db):
    o = _owner(db)
    a = _staff(db, o, "Agnes", "tok-a")
    _as_owner(o)
    try:
        client.post(f"/api/staff/chat/threads/{a.id}", json={"body": "kom kl 8"})
    finally:
        _as_owner(None)

    body = client.get("/api/portal/tok-a/chat").json()
    assert [m["body"] for m in body["messages"]] == ["kom kl 8"]
    assert body["messages"][0]["mine"] is False
    assert client.get("/api/portal/tok-a/chat/unread").json()["unread"] == 0  # read


def test_owner_thread_list_does_not_collapse_when_groups_exist(client, db):
    """Groups have staff_id NULL. The owner list keyed a dict on staff_id, so
    without a kind filter every group landed on the same None key."""
    o = _owner(db)
    a = _staff(db, o, "Agnes", "tok-a")
    b = _staff(db, o, "Bo", "tok-b")
    _make_group(client, "tok-a", "Køkken", [b.id])
    _make_group(client, "tok-a", "Bar", [b.id])

    _as_owner(o)
    try:
        rows = client.get("/api/staff/chat/threads").json()["threads"]
        groups = client.get("/api/staff/chat/groups").json()["groups"]
    finally:
        _as_owner(None)

    assert sorted(r["name"] for r in rows) == ["Agnes", "Bo"]
    assert sorted(g["title"] for g in groups) == ["Bar", "Køkken"]
