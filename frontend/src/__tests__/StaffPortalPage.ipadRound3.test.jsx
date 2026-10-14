/**
 * BonBox Vagtplan — the third review round of the iPad pass, pinned on the
 * REAL page against a mocked portalApi that keeps state like the server does
 * (reading a thread marks it read; /chat/unread is the sum the list shows).
 *
 *   • The Beskeder count has one source of truth. It used to have two writers
 *     with opposite answers (the unread poll, and every list read writing 0),
 *     so the badge blinked — on an iPad beside rows still showing "1", on a
 *     phone on the active tab.
 *   • "På arbejde med dig" counts a colleague on exactly the staffer's hours.
 *   • Smaller ones: a picked free day answers in the week list, the Kan ikke
 *     caption counts a weekly rule, the period sheet shows the period on
 *     screen, the chart says "timer" (not a lone "t"), a refused give-away is
 *     said in Danish, a group thread never says "Din leder", a draft is kept
 *     per conversation, the composer grows, chat times are readable.
 *   • Behaviours the last round's tests let go: the Conversation key, the
 *     New group sheet keeping the list mounted, the hidden list not reading,
 *     the picked day being revealed, the narrow-phone swap buttons.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "tokr3";
const ok = (data) => Promise.resolve({ data });
const reject = (status, data = {}) => {
  const e = new Error(`Request failed with status code ${status}`);
  e.response = { status, data };
  return Promise.reject(e);
};
const iso = (d) => d.toLocaleDateString("sv-SE");
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return iso(d);
};
const TODAY = inDays(0);

// ─── A mock server with state ────────────────────────────────────────────
let api;
function freshApi() {
  return {
    threads: [
      { thread_id: "own-1", kind: "direct", title: "Café Nordlys", member_count: 2, last_body: "Kan du tage fredag?", unread: 1, last_message_at: new Date().toISOString() },
      { thread_id: "grp-1", kind: "group", title: "Køkken + sal", member_count: 3, last_body: "Dagens suppe", unread: 1, last_message_at: new Date().toISOString() },
    ],
    messages: {
      "own-1": [{ id: "o1", sender_type: "owner", mine: false, body: "Hej Mads", created_at: new Date().toISOString() }],
      "grp-1": [{ id: "g1", sender_type: "staff", sender_name: "Oliver Berg", mine: false, body: "Dagens suppe er græskar", created_at: new Date().toISOString() }],
    },
    memberIds: { "grp-1": ["a", "b", "c"] },
    schedule: [
      { id: "s1", date: TODAY, start_time: "14:00", end_time: "20:00", status: "published", net_hours: 5.5 },
    ],
    team: [],
    hours: { period_start: inDays(-10), period_end: inDays(10), total_hours: 11, entries: [] },
    availability: [],
    giveaways: [],
    unreadHold: null, // a promise the NEXT /chat/unread answer waits for
    threadHold: null, // likewise for GET /chat/threads/{id}
    listHold: null, // likewise for GET /chat/threads (the list)
  };
}

const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) {
    return ok({ has_pin: false, staff_name: "Mads Holm", restaurant_name: "Café Nordlys", role: "server" });
  }
  if (url.startsWith(`/portal/${TOK}/schedule`)) return ok({ shifts: api.schedule });
  if (url.startsWith(`/portal/${TOK}/team-schedule`)) return ok(api.team);
  if (url.startsWith(`/portal/${TOK}/hours`)) return ok(api.hours);
  if (url.includes("/notifications")) return ok({ notifications: [] });
  if (url.endsWith("/chat/unread")) {
    // The count is computed when the request ARRIVES (as the server does);
    // a hold only delays the answer.
    const n = api.threads.reduce((a, th) => a + (th.unread || 0), 0);
    const hold = api.unreadHold;
    api.unreadHold = null;
    return hold ? hold.then(() => ({ data: { unread: n } })) : ok({ unread: n });
  }
  if (url.endsWith("/chat/colleagues")) return ok({ colleagues: [] });
  if (url.endsWith("/availability")) return ok({ availability: api.availability });
  if (url.endsWith("/give-aways")) return ok(api.giveaways);
  if (url.endsWith("/swap-requests")) return ok([]);
  if (url.endsWith("/bank")) return ok({ has_bank: false });
  if (url === `/portal/${TOK}/chat/threads`) {
    const snapshot = { data: { threads: api.threads.map((th) => ({ ...th })) } };
    const hold = api.listHold;
    api.listHold = null;
    return hold ? hold.then(() => snapshot) : Promise.resolve(snapshot);
  }
  if (url.startsWith(`/portal/${TOK}/chat/threads/`)) {
    const id = url.split("/").pop();
    const answer = () => {
      const th = api.threads.find((x) => x.thread_id === id);
      if (th) th.unread = 0; // reading a thread marks it read
      return { data: { thread_id: id, kind: th?.kind, title: th?.title, member_ids: api.memberIds[id] || [], messages: api.messages[id] || [] } };
    };
    const hold = api.threadHold;
    api.threadHold = null;
    return hold ? hold.then(answer) : Promise.resolve(answer());
  }
  return ok([]);
});
let postImpl = () => ok({});
const post = vi.fn((...a) => postImpl(...a));

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), put: vi.fn(() => ok({})), delete: vi.fn(() => ok({})), defaults: { baseURL: "" } },
  storePinProof: vi.fn(),
}));
vi.mock("../hooks/useNativePush", () => ({
  default: () => ({}),
  unregisterNativePush: vi.fn(() => Promise.resolve()),
  getStoredNativePushToken: () => null,
  NATIVE_PUSH_TOKEN_KEY: "bonbox_apns_token",
}));
vi.mock("../utils/haptics", () => ({ haptic: Object.assign(vi.fn(), { warning: vi.fn(), success: vi.fn(), error: vi.fn(), light: vi.fn() }) }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn() }));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");
const { PAD_QUERY, PAD_WIDE_QUERY } = await import("../lib/padLayout");

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "pages", "StaffPortalPage.jsx"), "utf8");
const CSS = readFileSync(join(HERE, "..", "styles", "staffPortal.css"), "utf8");
const SWAP_SERVICE = readFileSync(join(HERE, "..", "..", "..", "backend", "app", "services", "shift_swap_service.py"), "utf8");

/** Pretend to be an iPad: `which` = which pad queries match. */
function mockMatchMedia(which = []) {
  window.matchMedia = vi.fn((q) => ({
    matches: which.includes(q),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}
/** A pretend window whose size can change (rotation, Split View). */
function mockWindow(w, h) {
  const size = { w, h };
  const listeners = new Set();
  const evalQuery = (q) => q.split(/\s+and\s+/).every((part) => {
    const m = /^\((width|height) >= (\d+)px\)$/.exec(part.trim());
    if (!m) throw new Error(`cannot read ${part}`);
    return (m[1] === "width" ? size.w : size.h) >= Number(m[2]);
  });
  window.matchMedia = vi.fn((q) => ({
    get matches() { return evalQuery(q); },
    media: q,
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
  }));
  return {
    async resize(nw, nh) {
      await act(async () => {
        size.w = nw;
        size.h = nh;
        [...listeners].forEach((fn) => fn());
      });
    },
  };
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
  await waitFor(() => expect(screen.getByTitle("Rediger profil")).toBeInTheDocument());
}
const nav = () => document.querySelector("nav");
const navTo = (label) => fireEvent.click(within(nav()).getByText(label).closest("button"));
const settle = (ms = 60) => act(() => new Promise((r) => setTimeout(r, ms)));
const tokens = (el) => (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);

/** The iPad sidebar's Beskeder count (RailCount) — null when not drawn. */
const railCount = () => {
  const row = within(nav()).getByText("Beskeder").closest("button");
  const el = [...row.querySelectorAll('[aria-label="Ulæste beskeder"]')].find((n) => tokens(n).includes("pad:inline-flex"));
  return el ? el.textContent : null;
};
/** The phone tab bar's Beskeder badge — null when not drawn. */
const phoneBadge = () => {
  const row = within(nav()).getByText("Beskeder").closest("button");
  const el = [...row.querySelectorAll('[aria-label="Ulæste beskeder"]')].find((n) => tokens(n).includes("absolute"));
  return el ? el.textContent : null;
};
/** The unread pill at the end of a thread row ("" when none). */
const rowCount = (name) => {
  const row = screen.getAllByText(name).map((el) => el.closest("button")).find((b) => b && b.closest("nav") === null && b.querySelector("span"));
  return row.lastElementChild.textContent;
};
const calls = (pred) => get.mock.calls.map(([u]) => u).filter(pred);

beforeEach(() => {
  localStorage.clear();
  get.mockClear();
  post.mockClear();
  postImpl = () => ok({});
  api = freshApi();
  delete window.matchMedia;
});
afterEach(() => {
  delete window.matchMedia;
});

// ─── The Beskeder count ───────────────────────────────────────────────────
describe("the Beskeder count has one source of truth — no blinking, no contradiction", () => {
  it("iPad: the sidebar count is the list's own sum — reading the list does not zero it", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    await waitFor(() => expect(railCount()).toBe("2"));
    // The list answers after any count read that went out with it — the
    // order a slow list read has on a real network.
    let release;
    api.listHold = new Promise((r) => { release = r; });
    navTo("Beskeder");
    await settle(30);
    await act(async () => { release(); await Promise.resolve(); });
    await screen.findByText("Køkken + sal");
    await settle(120);
    // Both rows still show 1 — and so does the sidebar beside them (it read
    // "" here: the list's read wrote 0 although it marks nothing read).
    expect(rowCount("Køkken + sal")).toBe("1");
    expect(railCount()).toBe("2");
  });

  it("iPad master-detail: opening one thread leaves the other's count; the open row shows none", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    navTo("Beskeder");
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    await screen.findByTestId("portal-chat-pane");
    await waitFor(() => expect(railCount()).toBe("1"));
    expect(rowCount("Café Nordlys")).toBe("1");
    expect(rowCount("Køkken + sal")).toBe("");
    await settle(150);
    expect(railCount()).toBe("1");
  });

  it("a slow, older count can never overwrite a newer one (the newest READ wins)", async () => {
    mockMatchMedia([PAD_QUERY]); // iPad portrait: one thread full-screen
    await mount();
    navTo("Beskeder");
    await screen.findByText("Køkken + sal");
    // The count read after this conversation read is slow. It is counted on
    // arrival: Café Nordlys still unread → 1.
    let release;
    api.unreadHold = new Promise((r) => { release = r; });
    fireEvent.click(screen.getByText("Køkken + sal").closest("button"));
    await screen.findByText("Dagens suppe er græskar");
    // Meanwhile Café Nordlys is read on another device, and the staffer goes
    // back to the list, whose read (newer) says 0.
    api.threads[0].unread = 0;
    fireEvent.click(screen.getByText("Alle samtaler"));
    await waitFor(() => expect(rowCount("Café Nordlys")).toBe(""));
    expect(railCount()).toBeNull();
    // The old answer lands last. It must not bring back a "1".
    await act(async () => { release(); await Promise.resolve(); });
    await settle(30);
    expect(railCount()).toBeNull();
  });

  it("iPad portrait (one thread full-screen): the count is read right AFTER each conversation read", async () => {
    mockMatchMedia([PAD_QUERY]);
    await mount();
    navTo("Beskeder");
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    await screen.findByText("Dagens suppe er græskar");
    await waitFor(() => expect(railCount()).toBe("1"));
    const seq = calls((u) => u.includes("/chat/"));
    const read = seq.lastIndexOf(`/portal/${TOK}/chat/threads/grp-1`);
    expect(read).toBeGreaterThan(-1);
    expect(seq.slice(read + 1)).toContain(`/portal/${TOK}/chat/unread`);
  });

  it("phone: the badge shows away from Beskeder, never on the open Beskeder tab (as on origin/main), and is back on leaving", async () => {
    await mount();
    await waitFor(() => expect(phoneBadge()).toBe("2"));
    navTo("Beskeder");
    await screen.findByText("Køkken + sal");
    await settle(120);
    expect(phoneBadge()).toBeNull();
    fireEvent.click(screen.getByText("Køkken + sal").closest("button"));
    await screen.findByText("Dagens suppe er græskar");
    await settle(120);
    expect(phoneBadge()).toBeNull();
    navTo("Vagtplan");
    await waitFor(() => expect(phoneBadge()).toBe("1")); // Café Nordlys is still unread
  });

  it("nothing writes a zero it did not count", () => {
    expect(SRC).not.toMatch(/setChatUnread\(0\)/);
    expect(SRC).not.toContain("onChatRead");
  });
});

// ─── Who am I on with ─────────────────────────────────────────────────────
describe("'På arbejde med dig' counts colleagues on exactly my hours", () => {
  const row = (name, date, start, end, id) => ({ shift_id: `t-${name}-${start}`, staff_id: id, staff_name: name, date, start_time: start, end_time: end, role: null });

  it("a whole team on my shift is named in the hero and on the week row — not 'alone'", async () => {
    api.team = [
      row("Mads Holm", TODAY, "14:00", "20:00", "m"),
      row("Oliver Berg", TODAY, "14:00", "20:00", "o"),
      row("Emma Lund", TODAY, "14:00", "20:00", "e"),
      row("Sofie Dahl", TODAY, "17:00", "23:00", "s"),
    ];
    await mount();
    expect(await screen.findByText("Oliver, Emma, Sofie")).toBeInTheDocument();
    const mates = screen.getByTestId("portal-week-mates");
    for (const n of ["Oliver", "Emma", "Sofie"]) expect(within(mates).getByText(n)).toBeTruthy();
    expect(within(mates).queryByText("Mads")).toBeNull();
    expect(screen.queryByText("Alene")).toBeNull();
  });

  it("my own second shift that day is not listed as a colleague", async () => {
    api.schedule = [
      { id: "a", date: TODAY, start_time: "10:00", end_time: "14:00", status: "published", net_hours: 4 },
      { id: "b", date: TODAY, start_time: "17:00", end_time: "22:00", status: "published", net_hours: 5 },
    ];
    api.team = [
      row("Mads Holm", TODAY, "10:00", "14:00", "m"),
      row("Mads Holm", TODAY, "17:00", "22:00", "m"),
      row("Oliver Berg", TODAY, "17:00", "22:00", "o"),
    ];
    await mount();
    const lines = await screen.findAllByTestId("portal-week-mates");
    for (const l of lines) expect(within(l).queryByText("Mads")).toBeNull();
    expect(within(lines[0]).getByText("Oliver")).toBeTruthy();
  });
});

// ─── The week strip and the list beside it ───────────────────────────────
describe("a free day picked in the strip answers in the week list", () => {
  it("tapping today with no shift adds a 'Fri — ingen vagt' line and brings it into view", async () => {
    api.schedule = [{ id: "n", date: inDays(8), start_time: "16:00", end_time: "22:00", status: "published", net_hours: 5.5 }];
    const spy = vi.fn();
    const real = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    try {
      await mount();
      const card = screen.getByTestId("portal-week-card");
      expect(within(card).queryByTestId("portal-week-free-day")).toBeNull();
      fireEvent.click(card.querySelector('button[aria-current="date"]'));
      const line = await within(card).findByTestId("portal-week-free-day");
      expect(line.textContent).toBe("Fri — ingen vagt");
      await settle(80);
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.contexts.some((el) => el.getAttribute?.("data-week-day") === TODAY)).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = real;
    }
  });

  it("a picked day WITH a shift is revealed too (the day-tap reveal, not just a source pin)", async () => {
    const spy = vi.fn();
    const real = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    try {
      await mount();
      fireEvent.click(screen.getByTestId("portal-week-card").querySelector('button[aria-current="date"]'));
      await settle(80);
      expect(spy.mock.contexts.some((el) => el.getAttribute?.("data-week-day") === TODAY)).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = real;
    }
  });
});

describe("Kan ikke: a weekly rule counts as marked in its week", () => {
  it("'1 markeret i denne uge' under a weekly Kan ikke day — not 'Intet markeret'", async () => {
    const wd = (new Date().getDay() + 6) % 7; // Monday-first, as the API stores it
    api.availability = [{ id: "w1", date: null, weekday: wd, kind: "unavailable" }];
    await mount();
    navTo("Kan ikke");
    expect(await screen.findByText("1 markeret i denne uge")).toBeInTheDocument();
    expect(screen.queryByText("Intet markeret i denne uge")).toBeNull();
  });
});

// ─── Timer ────────────────────────────────────────────────────────────────
describe("Timer", () => {
  const monthOf = () => {
    const d = new Date();
    return { start: iso(new Date(d.getFullYear(), d.getMonth(), 1)), end: iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)), last: new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() };
  };

  it("the period sheet opens on the period on screen: its cycle is lit and the dates are filled", async () => {
    const m = monthOf();
    api.hours = { period_start: m.start, period_end: m.end, total_hours: 11, entries: [] };
    await mount();
    navTo("Timer");
    const periodBtn = await screen.findByText((_, el) => el?.tagName === "BUTTON" && / – /.test(el.textContent || ""));
    fireEvent.click(periodBtn);
    const sheet = await screen.findByRole("dialog", { name: "Vælg en periode" });
    const cycle = within(sheet).getByText(`1.–${m.last}.`).closest("button");
    expect(cycle.getAttribute("style")).toContain("linear-gradient(180deg,#1e293b,#0f172a)");
    expect(within(sheet).getByText("15.–14.").closest("button").getAttribute("style")).not.toContain("#1e293b");
    const [from, to] = sheet.querySelectorAll('input[type="date"]');
    expect(from.value).toBe(m.start);
    expect(to.value).toBe(m.end);
    // Showing the pay period it opened on stays ON the pay period — no custom
    // range (which would hide the permit tile and offer "Tilbage til …").
    const before = calls((u) => u.includes("/hours?start=")).length;
    fireEvent.click(within(sheet).getByText("Vis disse timer"));
    await settle();
    expect(screen.queryByRole("dialog", { name: "Vælg en periode" })).toBeNull();
    expect(calls((u) => u.includes("/hours?start=")).length).toBe(before);
    expect(screen.queryByText("Tilbage til min lønperiode")).toBeNull();
  });

  it("the by-week chart says 'timer', not a lone 't' in its corner", async () => {
    api.hours = {
      period_start: inDays(-20), period_end: inDays(-1), total_hours: 12,
      entries: [
        { date: inDays(-15), start_time: "10:00", end_time: "16:00", total_hours: 6 },
        { date: inDays(-3), start_time: "10:00", end_time: "16:00", total_hours: 6 },
      ],
    };
    await mount();
    navTo("Timer");
    const title = await screen.findByText("Efter uge");
    expect(title.nextElementSibling.textContent).toBe("timer");
  });
});

// ─── Bytte ────────────────────────────────────────────────────────────────
describe("a refused give-away is said in Danish", () => {
  const take = async (detail) => {
    api.giveaways = [{ id: "g1", from_shift_date: inDays(2), from_shift_time: "16:00–22:00", from_staff_name: "Emma Lund", reason: null }];
    postImpl = (url) => (url.endsWith("/claim") ? reject(422, { detail }) : ok({}));
    await mount();
    navTo("Bytte");
    fireEvent.click(await screen.findByRole("button", { name: "Tag vagten" }));
  };

  it("over the weekly limit: Danish, with Danish numbers", async () => {
    await take("Taking this shift would put you over your weekly limit (37.5 of 37 hours).");
    expect(await screen.findByText("Tager du vagten, kommer du over din ugentlige grænse (37,5 af 37 timer).")).toBeInTheDocument();
    expect(screen.queryByText(/weekly limit/)).toBeNull();
  });

  it("already taken: Danish", async () => {
    await take("This shift has already been taken.");
    expect(await screen.findByText("En kollega har lige taget vagten.")).toBeInTheDocument();
  });

  it("an English sentence we do not know is not shown on a Danish screen", async () => {
    await take("Staff not found.");
    expect(await screen.findByText("Kunne ikke tage vagten. Prøv igen.")).toBeInTheDocument();
    expect(screen.queryByText("Staff not found.")).toBeNull();
  });

  it("contract: every sentence the page translates is still what claim_giveaway raises", () => {
    for (const s of [
      'ShiftSwapError("Give-away not found.")',
      'ShiftSwapError("This shift has already been taken.")',
      "You can't take your own shift — withdraw it instead.",
      "The shift has changed since it was offered; ask them to re-offer.",
      'ShiftSwapError("This shift is already in the past.")',
      "You already work an overlapping shift that day.",
      'f"Taking this shift would put you over your weekly limit "',
      'f"({week_hours:.1f} of {cap:.0f} hours)."',
    ]) expect(SWAP_SERVICE).toContain(s);
  });

  it("narrow phones (< 360 px): the two action buttons drop their icons and stay one line", async () => {
    await mount();
    navTo("Bytte");
    for (const label of ["Byt", "Giv en vagt væk"]) {
      const btn = (await screen.findByText(label)).closest("button");
      expect(tokens(btn)).toEqual(expect.arrayContaining(["max-[359px]:px-2", "max-[359px]:whitespace-nowrap"]));
      expect(btn.querySelector("svg").getAttribute("class")).toContain("max-[359px]:hidden");
    }
  });
});

// ─── Beskeder ─────────────────────────────────────────────────────────────
describe("Beskeder", () => {
  const composer = () => screen.getByTestId("portal-chat-input");

  it("a group thread says how many are in it from the first frame — never 'Din leder' while it loads", async () => {
    let release;
    api.threadHold = new Promise((r) => { release = r; });
    await mount();
    navTo("Beskeder");
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    await screen.findByText("Alle samtaler");
    expect(screen.getByText("3 personer")).toBeInTheDocument();
    expect(screen.queryByText("Din leder")).toBeNull();
    await act(async () => { release(); await Promise.resolve(); });
    expect(await screen.findByText("Dagens suppe er græskar")).toBeInTheDocument();
    expect(screen.getByText("3 personer")).toBeInTheDocument();
  });

  it("a group of unknown size (just created, not read yet) says nothing rather than 'Din leder'", async () => {
    api.threads[1].member_count = undefined;
    api.memberIds["grp-1"] = [];
    await mount();
    navTo("Beskeder");
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    await screen.findByText("Dagens suppe er græskar");
    expect(screen.queryByText("Din leder")).toBeNull();
  });

  it("iPad master-detail: switching threads keeps each one's draft — and never shows one thread's text in another", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    navTo("Beskeder");
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    await screen.findByText("Dagens suppe er græskar");
    fireEvent.change(composer(), { target: { value: "Kun til gruppen" } });

    fireEvent.click(screen.getAllByText("Café Nordlys").map((el) => el.closest("button")).find((b) => b && !b.closest("nav")));
    expect(await screen.findByText("Hej Mads")).toBeInTheDocument();
    expect(screen.queryByText("Dagens suppe er græskar")).toBeNull();
    expect(composer().value).toBe(""); // B's own (empty) draft, not A's

    fireEvent.click(screen.getAllByText("Køkken + sal").map((el) => el.closest("button")).find((b) => b && !b.closest("nav")));
    await screen.findByText("Dagens suppe er græskar");
    expect(composer().value).toBe("Kun til gruppen");
  });

  it("phone: a draft survives going back to the list and opening the thread again; sending clears it", async () => {
    await mount();
    navTo("Beskeder");
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    await screen.findByText("Dagens suppe er græskar");
    fireEvent.change(composer(), { target: { value: "Jeg kommer 10 min senere" } });
    fireEvent.click(screen.getByText("Alle samtaler"));
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    await screen.findByText("Dagens suppe er græskar");
    expect(composer().value).toBe("Jeg kommer 10 min senere");
    postImpl = (url, body) => ok({ id: "new", sender_type: "staff", mine: true, body: body?.body, created_at: new Date().toISOString() });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(composer().value).toBe(""));
    fireEvent.click(screen.getByText("Alle samtaler"));
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    await screen.findByText("Dagens suppe er græskar");
    expect(composer().value).toBe("");
  });

  it("the composer grows with the text (a card, not a clipped pill) and is one 44 px line again when cleared", async () => {
    const proto = HTMLTextAreaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
    // jsdom does not lay out: answer like Safari — 21.6 px a line + 20 px padding.
    Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return (this.value || "").split("\n").length * 21.6 + 20; } });
    try {
      await mount();
      navTo("Beskeder");
      fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
      await screen.findByText("Dagens suppe er græskar");
      expect(composer().style.height).toBe("43.6px");
      expect(composer().style.borderRadius).toBe("999px");
      fireEvent.change(composer(), { target: { value: "1\n2\n3\n4\n5" } });
      expect(composer().style.height).toBe("130px");
      expect(composer().style.borderRadius).toBe("20px");
      fireEvent.change(composer(), { target: { value: "" } });
      expect(composer().style.height).toBe("43.6px");
      expect(composer().style.borderRadius).toBe("999px");
    } finally {
      delete proto.scrollHeight;
      if (desc) Object.defineProperty(Element.prototype, "scrollHeight", desc);
    }
  });

  it("phone layout (also Split View / Slide Over): message times are 10.5 px #94a3b8, not 9.5 px #cbd5e1", async () => {
    await mount();
    navTo("Beskeder");
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    const bubble = await screen.findByText("Dagens suppe er græskar");
    const time = bubble.parentElement.lastElementChild;
    expect(time.textContent).toBe("lige nu");
    expect(time.style.font).toContain("10.5px");
    expect(time.style.color).toBe("rgb(148, 163, 184)");
  });
});

// ─── Behaviours the last round's tests let go ─────────────────────────────
describe("load-bearing behaviours, now pinned by behaviour", () => {
  const listCalls = () => calls((u) => u === `/portal/${TOK}/chat/threads`).length;

  it("an iPad keeps the list mounted but NOT reading behind a full-screen thread", async () => {
    mockWindow(820, 1180);
    await mount();
    navTo("Beskeder");
    await screen.findByText("Køkken + sal");
    await waitFor(() => expect(listCalls()).toBe(1));
    fireEvent.click(screen.getByText("Køkken + sal").closest("button"));
    await screen.findByText("Dagens suppe er græskar");
    await settle(120);
    expect(listCalls()).toBe(1); // hiding it did not read it either
    expect(screen.getByPlaceholderText("Søg personer og beskeder")).toBeInTheDocument();
  });

  it("New group open beside a thread survives a resize to the phone layout (the sheet keeps the list mounted)", async () => {
    const win = mockWindow(1180, 820);
    await mount();
    navTo("Beskeder");
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    await screen.findByTestId("portal-chat-pane");
    fireEvent.click(screen.getByRole("button", { name: "Ny gruppe" }));
    const name = within(await screen.findByRole("dialog", { name: "Ny gruppe" })).getByPlaceholderText(/Køkken/);
    fireEvent.change(name, { target: { value: "Bar" } });
    await win.resize(390, 844);
    expect(within(screen.getByRole("dialog", { name: "Ny gruppe" })).getByPlaceholderText(/Køkken/).value).toBe("Bar");
  });
});

describe("install card", () => {
  it("the bold title is a block of its own, so the hint starts on the next line", () => {
    expect(SRC).toContain('className="font-semibold text-gray-700 mb-1 flex items-center gap-1.5" data-testid="staff-push-install-title"');
  });
});

// ─── iPad only ────────────────────────────────────────────────────────────
describe("iPad: every control a finger can hit is 44 px", () => {
  it("Giv en vagt væk: the shift picker and the reason field (were 40–41 px)", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    navTo("Bytte");
    fireEvent.click(await screen.findByText("Giv en vagt væk"));
    const select = await screen.findByRole("combobox");
    expect(tokens(select)).toContain("pad:min-h-11");
    expect(tokens(screen.getByPlaceholderText(/Årsag/))).toContain("pad:min-h-11");
  });

  it("Timer's period sheet: the Fra / Til date fields (were 42 px)", async () => {
    mockMatchMedia([PAD_QUERY]);
    await mount();
    navTo("Timer");
    fireEvent.click(await screen.findByText((_, el) => el?.tagName === "BUTTON" && / – /.test(el.textContent || "")));
    const sheet = await screen.findByRole("dialog", { name: "Vælg en periode" });
    const dates = sheet.querySelectorAll('input[type="date"]');
    expect(dates).toHaveLength(2);
    for (const d of dates) expect(tokens(d)).toContain("pad:min-h-11");
  });

  it("'Mind mig om vagt': a 44 × 44 target around the same 42 × 25 track; on a phone the button is the track, as before", async () => {
    await mount();
    fireEvent.click(screen.getByTitle("Rediger profil"));
    const sw = await screen.findByRole("switch", { name: "Mind mig om vagt" });
    expect(tokens(sw).filter((c) => !c.startsWith("pad:"))).toEqual(["flex-shrink-0", "flex", "disabled:opacity-50"]);
    expect(tokens(sw)).toEqual(expect.arrayContaining(["pad:w-11", "pad:h-11", "pad:-my-[9.5px]", "pad:-mx-px"]));
    const track = sw.firstElementChild;
    expect(track.style.width).toBe("42px");
    expect(track.style.height).toBe("25px");
    expect(track.style.padding).toBe("3px");
  });
});

describe("iPad: two-column empty states are cards on the column's top line", () => {
  it("Bytte with no requests, and Timer with no shifts", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    navTo("Bytte");
    const swap = await screen.findByTestId("portal-swap-empty");
    expect(tokens(swap)).toEqual(expect.arrayContaining(["pad-wide:bg-white", "pad-wide:border", "pad-wide:rounded-[20px]"]));
    expect(swap.parentElement.getAttribute("data-testid")).toBe("portal-swap-inbox");
    navTo("Timer");
    const hours = await screen.findByTestId("portal-hours-empty");
    expect(tokens(hours)).toEqual(expect.arrayContaining(["pad-wide:bg-white", "pad-wide:border", "pad-wide:rounded-[20px]"]));
    // A phone keeps its own tokens.
    expect(tokens(hours).filter((c) => !c.startsWith("pad-wide:"))).toEqual(["text-sm", "text-gray-400", "py-4", "text-center"]);
  });
});

describe("iPad: the bank form opens in view inside the profile sheet", () => {
  const openBank = async () => {
    await mount();
    fireEvent.click(screen.getByTitle("Rediger profil"));
    fireEvent.click(await screen.findByRole("button", { name: "Tilføj" }));
    return screen.findByTestId("portal-bank-form");
  };
  it("iPad: Tilføj brings the fields AND Gem konto / Annuller into view", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    const spy = vi.fn();
    const real = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    try {
      const form = await openBank();
      await settle(80);
      expect(spy.mock.contexts).toContain(form);
      expect(within(form).getByText("Gem konto")).toBeTruthy();
    } finally {
      Element.prototype.scrollIntoView = real;
    }
  });
  it("a phone does not scroll (as before)", async () => {
    const spy = vi.fn();
    const real = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    try {
      const form = await openBank();
      await settle(80);
      expect(spy.mock.contexts).not.toContain(form);
    } finally {
      Element.prototype.scrollIntoView = real;
    }
  });
});

describe("iPad: copy names the device it is on", () => {
  const withUA = async (ua, touch, fn) => {
    const uaDesc = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
    const tpDesc = Object.getOwnPropertyDescriptor(window.navigator, "maxTouchPoints");
    Object.defineProperty(window.navigator, "userAgent", { configurable: true, get: () => ua });
    Object.defineProperty(window.navigator, "maxTouchPoints", { configurable: true, get: () => touch });
    try { await fn(); } finally {
      if (uaDesc) Object.defineProperty(window.navigator, "userAgent", uaDesc); else delete window.navigator.userAgent;
      if (tpDesc) Object.defineProperty(window.navigator, "maxTouchPoints", tpDesc); else delete window.navigator.maxTouchPoints;
    }
  };
  const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

  it("an iPad (desktop-class UA + touch) is told 'Frakobl denne iPad', and the confirm says iPad too", async () => {
    await withUA(IPAD, 5, async () => {
      mockMatchMedia([PAD_QUERY]);
      await mount();
      fireEvent.click(screen.getByTitle("Rediger profil"));
      fireEvent.click(await screen.findByText("Frakobl denne iPad fra vagtplanen"));
      expect(await screen.findByText("Frakoble denne iPad?")).toBeInTheDocument();
      expect(screen.queryByText(/denne telefon/)).toBeNull();
    });
  });

  it("an iPhone keeps 'Frakobl denne telefon' (unchanged)", async () => {
    await withUA(IPHONE, 5, async () => {
      await mount();
      fireEvent.click(screen.getByTitle("Rediger profil"));
      expect(await screen.findByText("Frakobl denne telefon fra vagtplanen")).toBeInTheDocument();
    });
  });

  it("the install hint and the server-down line have iPad versions (Share is at the TOP of iPad Safari)", () => {
    expect(SRC).toContain('t("staffPushIpadInstallHint"');
    expect(SRC).toContain('t("portalServerDownBodyIpad"');
  });
});

describe("iPad: the sidebar's count is the list's colour", () => {
  // Round 4 (design QA): the same Beskeder count was green in the iPad
  // sidebar and red in the phone / Split View tab bar — it changed colour
  // when the window was resized. Every unread count is red now: the tab
  // badge, the header bell, the sidebar, and the thread rows beside it (so
  // the sidebar is still the list's colour, which is what this pinned).
  it("red — the phone badge's colour, and the thread rows' — at every window size", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    await waitFor(() => expect(railCount()).toBe("2"));
    const row = within(nav()).getByText("Beskeder").closest("button");
    const pill = [...row.querySelectorAll('[aria-label="Ulæste beskeder"]')].find((n) => tokens(n).includes("pad:inline-flex"));
    expect(tokens(pill)).toContain("bg-red-600");
    expect(tokens(pill)).not.toContain("bg-[#16a34a]");
    // The phone's icon badge is red too.
    expect(SRC).toContain('className="absolute z-10 -top-1 -right-1.5 min-w-[14px] h-[14px] px-1 rounded-full bg-red-600');
    // And the thread rows' own counts (red-600 = #dc2626).
    navTo("Beskeder");
    const listPill = (await screen.findByText("Køkken + sal")).closest("button").lastElementChild;
    expect(listPill.style.background).toMatch(/rgb\(220, 38, 38\)|#dc2626/);
  });
});

describe("iPad + hardware keyboard", () => {
  const order = (a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? "before" : "after");
  it("the sidebar comes BEFORE the header and the page in Tab order; a phone keeps the tab bar after the content", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    const header = screen.getByRole("heading", { level: 1 });
    expect(order(nav(), header)).toBe("before");
    expect(order(nav(), screen.getByTestId("portal-schedule-grid"))).toBe("before");
    cleanup();
    delete window.matchMedia;
    await mount();
    expect(order(nav(), screen.getByRole("heading", { level: 1 }))).toBe("after");
    expect(order(nav(), screen.getByTestId("portal-schedule-grid"))).toBe("after");
  });

  it("every portal control draws a focus ring for the keyboard (beats focus:outline-none; never on a tap)", () => {
    expect(CSS).toMatch(/body:has\(\[data-portal-scroller\]\) :is\(button, a\[href\], summary, \[role="button"\], \[role="switch"\], \[role="tab"\]\):focus-visible \{\s*outline: 2px solid #16a34a;\s*outline-offset: 2px;/);
    // Unlayered: at the top level of the staff stylesheet, inside no block
    // (staffPortalCss.test.js checks the BUILT output the same way).
    const before = CSS.slice(0, CSS.indexOf("body:has([data-portal-scroller])")).replace(/\/\*[\s\S]*?\*\//g, "");
    expect((before.match(/\{/g) || []).length).toBe((before.match(/\}/g) || []).length);
  });
});

afterEach(() => cleanup());
