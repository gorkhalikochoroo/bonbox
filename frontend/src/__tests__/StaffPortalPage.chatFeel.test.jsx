/**
 * Premium feel 1.8, chat (PREMIUM-FEEL-SPEC.md), on the REAL page against a
 * mocked portalApi and a spied components/staff/feel. Fake timers drive the
 * thread's 6 s poll.
 *
 *   a) Never yanked: the stream follows new messages only on the first
 *      paint, after your own send, or while you are at the bottom (72 px).
 *      Someone reading older messages stays where they are.
 *   b) The poll merges; it never throws away what only this phone knows. An
 *      unchanged answer writes nothing at all. A pending bubble survives a
 *      poll; a failed one stays until it is tapped (a deliberate change: it
 *      used to vanish within 6 s).
 *   c) Sending has weight: one key from the tap to the server's copy, so the
 *      bubble is the SAME node after the answer and after the next poll. It
 *      rises in (vp-bubble-in); someone else's new message fades in
 *      (vp-msg-new). Memory holds server lists only, so a return replays
 *      nothing.
 *
 * jsdom has no layout: the stream gets fake sizes (400 px tall, 100 px per
 * row) and jsdom does not clamp scrollTop, so "pinned" reads
 * scrollTop === scrollHeight, as the spec words it.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recall } from "../components/staff/tabMemory";

const TOK = "tokchat";
const ok = (data) => Promise.resolve({ data });
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const spy = vi.hoisted(() => ({
  feel: { done: vi.fn(), warn: vi.fn(), fail: vi.fn(), soft: vi.fn(), tick: vi.fn(), warm: vi.fn() },
}));
vi.mock("../components/staff/feel", () => ({ feel: spy.feel, resetFeelForTests: () => {} }));

// Two hours before "now": the time-ago label cannot change during a test.
const AT = new Date(2026, 10, 12, 7, 0, 0).toISOString();
const msg = (id, body, mine = false) => ({ id, sender_type: mine ? "staff" : "owner", mine, body, photo_count: 0, created_at: AT });
const THREAD = { thread_id: "t1", kind: "owner", title: "Café Solsikke", last_body: "Hej", last_at: AT, unread: 0 };

let data;       // { thread }: what the server holds now
let threadImpl; // the thread GET (default: the server's current copy, fresh objects every time)
const get = vi.fn((url) => {
  const sub = url.slice(`/portal/${TOK}`.length);
  if (sub === "") return ok({ has_pin: false, staff_name: "Freja M.", role: "waiter", restaurant_name: "Café Solsikke" });
  if (sub.startsWith("/schedule")) return ok({ shifts: [] });
  if (sub.startsWith("/team-schedule")) return ok([]);
  if (sub === "/clock") return ok({ clocked_in: false, geofence_on: false, locked: false });
  if (sub.startsWith("/hours")) return ok({ period_start: "2026-11-01", period_end: "2026-11-30", total_hours: 0, entries: [] });
  if (sub.startsWith("/notifications")) return ok({ notifications: [] });
  if (sub === "/chat/unread") return ok({ unread: 0 });
  if (sub.startsWith("/chat/threads/")) return threadImpl();
  if (sub.startsWith("/chat/threads")) return ok({ threads: [THREAD] });
  return ok([]);
});
let postImpl;
const post = vi.fn((...a) => postImpl(...a));

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), put: vi.fn(), delete: vi.fn(() => ok({})), defaults: { baseURL: "" } },
  storePinProof: vi.fn(),
}));
vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useNativePush", () => ({
  default: () => ({}),
  unregisterNativePush: vi.fn(() => Promise.resolve()),
  getStoredNativePushToken: () => null,
  NATIVE_PUSH_TOKEN_KEY: "bonbox_apns_token",
}));
vi.mock("../utils/haptics", () => ({ haptic: Object.assign(vi.fn(), { light: vi.fn(), warning: vi.fn(), success: vi.fn(), error: vi.fn() }) }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn(), takePhotoFile: vi.fn(), choosePhotoFiles: vi.fn(), isCameraDenied: vi.fn() }));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");

// Fake layout for the stream only: 400 px tall, 100 px per row. Reads of its
// scrollHeight (a forced layout in a browser) and writes of its scrollTop are
// counted, for "an unchanged poll writes nothing".
const isStream = (el) => el.getAttribute?.("data-testid") === "portal-chat-stream";
const io = { layoutReads: 0, scrollWrites: 0 };
const scrollTopOf = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (!isStream(this)) return 0;
      io.layoutReads += 1;
      return 400 + 100 * this.childElementCount;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return isStream(this) ? 400 : 0; },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return scrollTopOf.get.call(this); },
    set(v) {
      if (isStream(this)) io.scrollWrites += 1;
      scrollTopOf.set.call(this, v);
    },
  });
});
afterAll(() => {
  delete HTMLElement.prototype.scrollHeight;
  delete HTMLElement.prototype.clientHeight;
  delete HTMLElement.prototype.scrollTop;
});

async function flush(n = 4) {
  for (let i = 0; i < n; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }
}
async function advance(ms) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await flush(2);
}
const poll = () => advance(6000);
async function click(el) {
  await act(async () => { fireEvent.click(el); });
  await flush(2);
}
async function mount() {
  localStorage.setItem("lang", "da");
  render(
    <LanguageProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[`/portal/${TOK}`]}>
          <Routes>
            <Route path="/portal/:token" element={<StaffPortalPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </LanguageProvider>,
  );
  await flush(8);
  expect(screen.getByTestId("portal-hero")).toBeInTheDocument();
}
async function openThread() {
  await click(screen.getByTestId("portal-tab-messages"));
  await flush(4);
  await click(screen.getAllByTestId("portal-thread-row")[0]);
  await flush(4);
  return stream();
}
const stream = () => screen.getByTestId("portal-chat-stream");
const bubbles = () => screen.queryAllByTestId("portal-chat-bubble");
const bubbleWith = (text) => bubbles().filter((b) => b.textContent === text);
const rowOf = (bubble) => bubble.parentElement.parentElement;   // bubble → column → row
const pinned = (el) => el.scrollTop === el.scrollHeight;
function scrollTo(el, top) {
  el.scrollTop = top;
  fireEvent.scroll(el);
}
async function type(text) {
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText("Skriv en besked…"), { target: { value: text } });
  });
}
const sendBtn = () => screen.getByTestId("portal-chat-send");
const threadReads = () => get.mock.calls.filter(([u]) => u === `/portal/${TOK}/chat/threads/t1`).length;
function holdPost() {
  const d = deferred();
  postImpl = () => d.promise;
  return d;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date(2026, 10, 12, 9, 0, 0));
  localStorage.clear();
  get.mockClear();
  post.mockClear();
  Object.values(spy.feel).forEach((f) => f.mockClear());
  data = {
    thread: {
      thread_id: "t1", kind: "owner", title: "Café Solsikke", member_ids: [],
      messages: [msg(1, "Hej Freja"), msg(2, "Hej!", true), msg(3, "Kan du tage lørdag?")],
    },
  };
  threadImpl = () => ok(JSON.parse(JSON.stringify(data.thread)));
  postImpl = () => ok({});
});
afterEach(() => {
  vi.useRealTimers();
  document.body.classList.remove("portal-shell");
});

describe("a) Never yanked", () => {
  it("the first load lands at the bottom", async () => {
    await mount();
    const el = await openThread();
    expect(bubbles()).toHaveLength(3);
    expect(el.scrollHeight).toBe(700);
    expect(pinned(el)).toBe(true);
  });

  it("the first-paint pin waits for the list: a scroll during the skeleton does not cancel it", async () => {
    await mount();
    const held = deferred();
    threadImpl = () => held.promise;
    const el = await openThread();
    expect(screen.getByTestId("portal-skeleton")).toBeInTheDocument();
    scrollTo(el, 0);                                   // 500 − 0 − 400 = 100 px from the bottom
    await act(async () => { held.resolve({ data: JSON.parse(JSON.stringify(data.thread)) }); });
    await flush(4);
    expect(bubbles()).toHaveLength(3);
    expect(pinned(el)).toBe(true);
  });

  it("reading older messages: a poll with a new message leaves the scroll alone and fades the message in; at the bottom the same kind of poll follows it", async () => {
    await mount();
    const el = await openThread();
    scrollTo(el, 0);                                   // reading the top of the thread
    data.thread.messages.push(msg(4, "Svar gerne i dag"));
    await poll();
    expect(bubbleWith("Svar gerne i dag")).toHaveLength(1);
    expect(el.scrollTop).toBe(0);                      // not pulled down
    expect(rowOf(bubbleWith("Svar gerne i dag")[0]).className).toContain("vp-msg-new");
    // Messages that were already there do not fade again.
    expect(rowOf(bubbleWith("Hej Freja")[0]).className).not.toMatch(/vp-msg-new|vp-bubble-in/);

    // Back at the bottom (within 72 px): the next new message is followed.
    scrollTo(el, el.scrollHeight - el.clientHeight - 40);
    data.thread.messages.push(msg(5, "Tak!"));
    await poll();
    expect(bubbleWith("Tak!")).toHaveLength(1);
    expect(pinned(el)).toBe(true);
  });

  it("your own send always comes into view, even while reading older messages", async () => {
    await mount();
    const el = await openThread();
    scrollTo(el, 0);
    holdPost();
    await type("Jeg kommer");
    await click(sendBtn());
    expect(bubbleWith("Jeg kommer")).toHaveLength(1);
    expect(pinned(el)).toBe(true);
  });
});

describe("b) The poll merges, and an unchanged answer writes nothing", () => {
  it("a poll answering the same thread: the stream's DOM is untouched (MutationObserver records nothing), no scroll write, no layout read", async () => {
    await mount();
    const el = await openThread();
    const seen = [];
    const mo = new MutationObserver((records) => seen.push(...records));
    mo.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
    const before = threadReads();
    io.layoutReads = 0;
    io.scrollWrites = 0;
    await poll();
    await poll();
    expect(threadReads()).toBe(before + 2);            // both polls did answer
    seen.push(...mo.takeRecords());
    mo.disconnect();
    expect(seen).toEqual([]);
    expect(io.scrollWrites).toBe(0);
    expect(io.layoutReads).toBe(0);
    expect(pinned(el)).toBe(true);                     // and it is still where it was
  });

  it("a poll while the POST is held keeps the pending bubble; a poll that already has the sent message, then the answer → exactly one bubble", async () => {
    await mount();
    await openThread();
    const d = holdPost();
    await type("Kommer 5 min senere");
    await click(sendBtn());
    const pending = bubbleWith("Kommer 5 min senere");
    expect(pending).toHaveLength(1);
    expect(pending[0].className).toContain("opacity-60");

    // A poll with something new from the manager: the merge keeps the pending bubble.
    data.thread.messages.push(msg(4, "Ok"));
    await poll();
    expect(bubbleWith("Ok")).toHaveLength(1);
    expect(bubbleWith("Kommer 5 min senere")).toHaveLength(1);
    expect(bubbleWith("Kommer 5 min senere")[0].className).toContain("opacity-60");

    // The server saved it and a poll brought it before the POST answered.
    data.thread.messages.push(msg(99, "Kommer 5 min senere", true));
    await poll();
    await act(async () => { d.resolve({ data: msg(99, "Kommer 5 min senere", true) }); });
    await flush(4);
    expect(bubbleWith("Kommer 5 min senere")).toHaveLength(1);
    expect(bubbleWith("Kommer 5 min senere")[0].className).not.toContain("opacity-60");
    // And the next poll does not bring a second one.
    await poll();
    expect(bubbleWith("Kommer 5 min senere")).toHaveLength(1);
  });

  it("a failed send: fail once, the red ring and 'Ikke sendt'; it stays through two polls; a tap refills the composer and removes it", async () => {
    await mount();
    await openThread();
    const d = holdPost();
    await type("Er der personalemad?");
    await click(sendBtn());
    await act(async () => { d.reject(new Error("offline")); });
    await flush(4);
    expect(spy.feel.fail).toHaveBeenCalledTimes(1);
    const failed = () => bubbleWith("Er der personalemad?");
    expect(failed()).toHaveLength(1);
    expect(failed()[0].style.boxShadow).toContain("0 0 0 1.5px");
    const note = within(rowOf(failed()[0])).getByText("Ikke sendt — tryk for at prøve igen");
    expect(note).toBeInTheDocument();

    // Two polls, one of them with news (so the list is merged, not skipped).
    data.thread.messages.push(msg(4, "Ja, kl. 15"));
    await poll();
    await poll();
    expect(bubbleWith("Ja, kl. 15")).toHaveLength(1);
    expect(failed()).toHaveLength(1);
    expect(screen.getByText("Ikke sendt — tryk for at prøve igen")).toBeInTheDocument();
    expect(spy.feel.fail).toHaveBeenCalledTimes(1);

    // Today's tap: refill the composer, drop the failed bubble (no silent retry).
    await click(failed()[0]);
    expect(failed()).toHaveLength(0);
    expect(screen.getByPlaceholderText("Skriv en besked…").value).toBe("Er der personalemad?");
    expect(screen.queryByText("Ikke sendt — tryk for at prøve igen")).toBeNull();
  });
});

describe("c) Sending has weight", () => {
  it("the optimistic bubble rises in; after the POST and after the next poll it is the SAME node; send is silent", async () => {
    await mount();
    await openThread();
    const d = holdPost();
    await type("Hej hej");
    await click(sendBtn());
    const node = bubbleWith("Hej hej")[0];
    const row = rowOf(node);
    expect(row.className).toContain("vp-bubble-in");
    expect(node.className).toContain("vp-pending-fade");
    expect(node.className).toContain("opacity-60");    // "not sent yet" stays

    await act(async () => { d.resolve({ data: msg(42, "Hej hej", true) }); });
    await flush(4);
    expect(bubbleWith("Hej hej")[0]).toBe(node);       // not re-mounted
    expect(rowOf(node)).toBe(row);
    expect(row.className).toContain("vp-bubble-in");   // the class never changes on that node
    expect(node.className).toContain("vp-pending-fade");
    expect(node.className).not.toContain("opacity-60");

    data.thread.messages.push(msg(42, "Hej hej", true));
    await poll();
    expect(bubbleWith("Hej hej")).toHaveLength(1);
    expect(bubbleWith("Hej hej")[0]).toBe(node);
    expect(row.className).toContain("vp-bubble-in");
    // Send is silent: the bubble is the feedback.
    expect(Object.values(spy.feel).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it("leave the thread and come back: the bubbles from memory carry no entrance class; memory holds the server's list only", async () => {
    await mount();
    await openThread();
    await type("Ses i aften");
    postImpl = () => ok(msg(50, "Ses i aften", true));
    await click(sendBtn());
    await flush(4);
    data.thread.messages.push(msg(50, "Ses i aften", true), msg(51, "Godt!"));
    await poll();
    expect(rowOf(bubbleWith("Ses i aften")[0]).className).toContain("vp-bubble-in");
    expect(rowOf(bubbleWith("Godt!")[0]).className).toContain("vp-msg-new");
    // What memory holds is exactly the server's list: no local flags.
    const kept = recall(TOK, "thread:t1");
    expect(kept.map((m) => m.id)).toEqual([1, 2, 3, 50, 51]);
    expect(kept.some((m) => "_ck" in m || "_new" in m || "_pending" in m || "_failed" in m)).toBe(false);

    await click(screen.getByTestId("portal-chat-back"));
    await flush(4);
    // Hold the return's GET: what shows is memory.
    const held = deferred();
    threadImpl = () => held.promise;
    await click(screen.getAllByTestId("portal-thread-row")[0]);
    expect(screen.queryAllByTestId("portal-skeleton")).toEqual([]);
    expect(bubbles().map((b) => b.textContent)).toEqual(["Hej Freja", "Hej!", "Kan du tage lørdag?", "Ses i aften", "Godt!"]);
    const replay = () => stream().querySelectorAll(".vp-bubble-in, .vp-msg-new");
    expect(replay()).toHaveLength(0);
    // The refresh behind it (same list) replays nothing either.
    await act(async () => { held.resolve({ data: JSON.parse(JSON.stringify(data.thread)) }); });
    await flush(4);
    expect(replay()).toHaveLength(0);
    expect(pinned(stream())).toBe(true);
  });
});
