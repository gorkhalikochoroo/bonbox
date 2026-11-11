/**
 * Vagtplan in English (11 Nov 2026 simulator walk) plus the Byt fixes from
 * the pass before it, pinned on the REAL page against a mocked portalApi:
 *
 *   • Built-in roles show their label in both languages ("Barista",
 *     "Bartender", "Vært"), never the raw lowercase code; an owner-typed
 *     role shows exactly as typed.
 *   • Byt: the request that needs the viewer's answer is listed first, then
 *     what waits on someone else, then what is done; every card names the
 *     two shifts from the VIEWER's side ("Du giver / Du får", "You give /
 *     You get"), the right shift under each; the dock's Byt tab counts the
 *     requests that wait on the viewer.
 *   • English: the pay-cycle chips without the Danish ordinal dot, the
 *     weekly-rule sheet's full weekday, the hours left as the hours
 *     formatter writes them, the legend's words, the give-away words, the
 *     sick form's one name, a known server refusal in the staffer's language.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "../i18n/en";
import { da } from "../i18n/da";
import { roleName } from "../utils/roleNames";
import { orderSwapInbox, swapSides, countNeedsMyAnswer, needsMyAnswer } from "../utils/swapInbox";
import { portalErrText, PORTAL_SERVER_ERRORS, PORTAL_SERVER_ERROR_PATTERNS } from "../utils/portalErrText";
import { formatClockDistance } from "../utils/clockDistance";

const TOK = "tokeng";
const ok = (data) => Promise.resolve({ data });
const iso = (d) => d.toLocaleDateString("sv-SE");
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const nextWeek = (i) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7 + i);
  return iso(d);
};
const refuse = (status, detail) => {
  const e = new Error(`Request failed with status code ${status}`);
  e.response = { status, data: { detail } };
  return Promise.reject(e);
};

let data;
const get = vi.fn((url) => {
  const sub = url.slice(`/portal/${TOK}`.length);
  if (sub === "") return ok(data.info);
  if (sub.startsWith("/schedule")) return ok({ shifts: data.shifts });
  if (sub.startsWith("/team-schedule")) return ok(data.team);
  if (sub.startsWith("/open-shifts")) return ok(data.open);
  if (sub.startsWith("/availability")) return ok({ availability: data.availability });
  if (sub.startsWith("/absence")) return ok({ absence: [] });
  if (sub.startsWith("/notifications")) return ok({ notifications: [] });
  if (sub === "/chat/unread") return ok({ unread: 0 });
  if (sub.startsWith("/chat/colleagues")) return ok({ colleagues: [] });
  if (sub.startsWith("/chat/threads")) return ok({ threads: [] });
  if (sub.startsWith("/swap-requests")) return ok(data.swaps);
  if (sub.startsWith("/give-aways")) return ok(data.pool);
  if (sub.startsWith("/hours")) return ok(data.hours);
  return ok([]);
});
let postImpl;
const post = vi.fn((...a) => postImpl(...a));

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), put: vi.fn(), delete: vi.fn(() => ok({})), defaults: { baseURL: "" } },
  storePinProof: vi.fn(),
}));
vi.mock("../hooks/useNativePush", () => ({
  default: () => ({}),
  unregisterNativePush: vi.fn(() => Promise.resolve()),
  getStoredNativePushToken: () => null,
  NATIVE_PUSH_TOKEN_KEY: "bonbox_apns_token",
}));
vi.mock("../utils/haptics", () => ({ haptic: Object.assign(vi.fn(), { light: vi.fn(), warning: vi.fn(), success: vi.fn(), error: vi.fn() }) }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn() }));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })) } }));
vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })), setAccessoryBarVisible: vi.fn(() => Promise.resolve()), setScroll: vi.fn(() => Promise.resolve()), setResizeMode: vi.fn(() => Promise.resolve()) },
  KeyboardResize: { Body: "body", Native: "native", None: "none", Ionic: "ionic" },
}));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");

async function mount(lang = "da") {
  localStorage.setItem("lang", lang);
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
  await waitFor(() => expect(screen.getByTitle(lang === "da" ? "Rediger profil" : "Edit profile")).toBeInTheDocument());
}
const content = () => screen.getByTestId("portal-content");
const go = (tab) => fireEvent.click(screen.getByTestId(`portal-tab-${tab}`));

// Freja (the viewer) and two colleagues. Ida asks Freja: Ida gives her
// Wednesday 10–16 (from_*) for Freja's Thursday 16–22 (to_*). Freja asks
// Sofie: Freja gives her Friday 16–22 (from_*) for Sofie's Saturday 10–16.
const INCOMING = {
  id: "in", direction: "incoming", status: "proposed",
  from_staff_name: "Ida H.", to_staff_name: "Freja M.",
  from_shift_id: "ida-wed", from_shift_date: nextWeek(2), from_shift_time: "10:00–16:00",
  to_shift_id: "freja-thu", to_shift_date: nextWeek(3), to_shift_time: "16:00–22:00",
};
const OUTGOING = {
  id: "out", direction: "outgoing", status: "proposed",
  from_staff_name: "Freja M.", to_staff_name: "Sofie K.",
  from_shift_id: "freja-fri", from_shift_date: nextWeek(4), from_shift_time: "16:00–22:00",
  to_shift_id: "sofie-sat", to_shift_date: nextWeek(5), to_shift_time: "10:00–16:00",
};
const DONE = {
  id: "done", direction: "outgoing", status: "done",
  from_staff_name: "Freja M.", to_staff_name: "Sofie K.",
  from_shift_id: "freja-sun", from_shift_date: nextWeek(6), from_shift_time: "12:00–18:00",
  to_shift_id: null,
};

beforeEach(() => {
  localStorage.clear();
  get.mockClear();
  post.mockClear();
  postImpl = () => ok({});
  data = {
    info: { has_pin: false, staff_name: "Freja M.", role: "waiter", restaurant_name: "Café Solsikke" },
    shifts: [{ id: "sh-1", date: inDays(1), start_time: "16:00", end_time: "22:00", status: "published", net_hours: 5.5 }],
    team: [],
    open: [],
    availability: [
      { id: "av-fri", date: null, kind: "unavailable", weekday: 4, start_time: null, end_time: null, note: null },
    ],
    swaps: [],
    pool: [],
    hours: {
      period_start: inDays(-20), period_end: inDays(6), total_hours: 19.5, hours_source: "logged",
      entries: [{ date: inDays(-1), start_time: "16:00", end_time: "22:00", total_hours: 5.5, resolution: "confirmed" }],
    },
  };
});

describe("built-in roles read as their label, in both languages", () => {
  it("the shared map names barista, bartender, host and cleaner (the portal's own copy did not)", () => {
    const tEn = (k) => en[k];
    const tDa = (k) => da[k];
    expect(roleName("barista", tEn)).toBe("Barista");
    expect(roleName("bartender", tEn)).toBe("Bartender");
    expect(roleName("host", tEn)).toBe("Host");
    expect(roleName("host", tDa)).toBe("Vært");
    expect(roleName("cleaner", tEn)).toBe("Cleaner");
    expect(roleName("cleaner", tDa)).toBe("Rengøring");
    expect(roleName("waiter", tDa)).toBe("Tjener");
    // An owner-typed role is never translated.
    expect(roleName("Opvasker deluxe", tEn)).toBe("Opvasker deluxe");
  });

  for (const lang of ["da", "en"]) {
    it(`${lang}: the home's open-shift row says "Barista", not "barista"`, async () => {
      data.open = [{ id: "os-1", date: inDays(2), start_time: "10:00", end_time: "15:00", role: "barista" }];
      await mount(lang);
      const open = await screen.findByTestId("portal-open-shifts");
      await waitFor(() => expect(open.textContent).toContain("Barista"));
      expect(open.textContent).not.toMatch(/\bbarista\b/);
    });
  }
});

describe("Byt: order, the viewer's side, the dock count", () => {
  it("helpers: needs-your-answer first, then waiting, then done; the server's order kept inside a group", () => {
    const accepted = { ...INCOMING, id: "agreed", status: "accepted" };
    const ordered = orderSwapInbox([DONE, OUTGOING, accepted, INCOMING]);
    expect(ordered.map((s) => s.id)).toEqual(["in", "out", "agreed", "done"]);
    expect(countNeedsMyAnswer([DONE, OUTGOING, accepted, INCOMING])).toBe(1);
    expect(countNeedsMyAnswer(null)).toBe(0);
    expect(needsMyAnswer(OUTGOING)).toBe(false);
  });

  it("helpers: an incoming card gives the viewer's own shift (to_*) and gets the proposer's (from_*); outgoing the other way round", () => {
    expect(swapSides(INCOMING)).toEqual({
      give: { date: INCOMING.to_shift_date, time: "16:00–22:00" },
      get: { date: INCOMING.from_shift_date, time: "10:00–16:00" },
    });
    expect(swapSides(OUTGOING)).toEqual({
      give: { date: OUTGOING.from_shift_date, time: "16:00–22:00" },
      get: { date: OUTGOING.to_shift_date, time: "10:00–16:00" },
    });
    expect(swapSides(DONE).get).toBeNull();
  });

  it("da: the incoming request Freja must answer is listed ABOVE her own outgoing one, and both done ones come last", async () => {
    // The server's order: newest first, the incoming request last.
    data.swaps = [OUTGOING, DONE, INCOMING];
    await mount("da");
    go("swaps");
    const rows = await screen.findAllByTestId("swap-row");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByTestId("swap-accept")).toBeInTheDocument();
    expect(rows[0].textContent).toContain("Ida H.");
    expect(within(rows[1]).getByRole("button", { name: "Træk tilbage" })).toBeInTheDocument();
    expect(within(rows[2]).getByTestId("swap-done-line")).toBeInTheDocument();
  });

  it("da: the incoming card — 'Du giver' is Freja's Thursday, 'Du får' is Ida's Wednesday", async () => {
    data.swaps = [INCOMING];
    await mount("da");
    go("swaps");
    const [row] = await screen.findAllByTestId("swap-row");
    const give = within(row).getByTestId("swap-side-give");
    const get_ = within(row).getByTestId("swap-side-get");
    expect(give.textContent).toMatch(/^Du giver/);
    expect(give.textContent).toContain("16:00–22:00");
    expect(get_.textContent).toMatch(/^Du får/);
    expect(get_.textContent).toContain("10:00–16:00");
    // The proposer's words are gone: no bare "Giver" / "Får" label.
    expect(row.textContent).not.toMatch(/\bGiver\b/);
  });

  it("da: the outgoing card — 'Du giver' is Freja's Friday, 'Du får' is Sofie's Saturday", async () => {
    data.swaps = [OUTGOING];
    await mount("da");
    go("swaps");
    const [row] = await screen.findAllByTestId("swap-row");
    expect(within(row).getByTestId("swap-side-give").textContent).toMatch(/^Du giver.*16:00–22:00$/);
    expect(within(row).getByTestId("swap-side-get").textContent).toMatch(/^Du får.*10:00–16:00$/);
  });

  it("en: 'You give' / 'You get' on both cards, the right shift under each", async () => {
    data.swaps = [OUTGOING, INCOMING];
    await mount("en");
    go("swaps");
    const [inc, out] = await screen.findAllByTestId("swap-row");
    expect(within(inc).getByTestId("swap-side-give").textContent).toMatch(/^You give.*16:00–22:00$/);
    expect(within(inc).getByTestId("swap-side-get").textContent).toMatch(/^You get.*10:00–16:00$/);
    expect(within(out).getByTestId("swap-side-give").textContent).toMatch(/^You give.*16:00–22:00$/);
    expect(within(out).getByTestId("swap-side-get").textContent).toMatch(/^You get.*10:00–16:00$/);
    expect(content().textContent).not.toMatch(/\bGives\b|\bGets\b/);
  });

  it("the dock's Byt tab counts the requests that wait on the viewer — read from the inbox endpoint, no endpoint of its own", async () => {
    data.swaps = [INCOMING, { ...INCOMING, id: "in2" }, OUTGOING, DONE];
    await mount("da");
    const badge = await within(screen.getByTestId("portal-tab-swaps")).findByTestId("portal-swaps-badge");
    expect(badge.textContent).toBe("2");
    expect(badge.getAttribute("aria-label")).toBe("Bytteanmodninger, der venter på dit svar");
    const urls = get.mock.calls.map(([u]) => u);
    expect(urls.some((u) => u === `/portal/${TOK}/swap-requests`)).toBe(true);
    expect(urls.every((u) => u.startsWith(`/portal/${TOK}`))).toBe(true);
  });

  it("no request waiting on the viewer: no badge", async () => {
    data.swaps = [OUTGOING, DONE];
    await mount("da");
    await waitFor(() => expect(get.mock.calls.some(([u]) => u === `/portal/${TOK}/swap-requests`)).toBe(true));
    expect(within(screen.getByTestId("portal-tab-swaps")).queryByTestId("portal-swaps-badge")).toBeNull();
  });

  it("answering on Byt clears the badge from the tab's own re-read", async () => {
    data.swaps = [INCOMING];
    await mount("da");
    expect((await within(screen.getByTestId("portal-tab-swaps")).findByTestId("portal-swaps-badge")).textContent).toBe("1");
    go("swaps");
    const [row] = await screen.findAllByTestId("swap-row");
    postImpl = () => { data.swaps = [{ ...INCOMING, status: "done" }]; return ok({}); };
    await act(async () => { fireEvent.click(within(row).getByTestId("swap-accept")); });
    await waitFor(() => expect(within(screen.getByTestId("portal-tab-swaps")).queryByTestId("portal-swaps-badge")).toBeNull());
  });

  it("en: the give-away words are plain (no 'up for grabs'), and the agreed line speaks to the reader", async () => {
    data.pool = [{ id: "ga-1", from_staff_name: "Ida H.", from_shift_date: nextWeek(5), from_shift_time: "16:00–22:00" }];
    data.swaps = [{ ...INCOMING, id: "agreed", status: "accepted" }, { ...DONE, id: "open-ga", status: "proposed" }];
    await mount("en");
    go("swaps");
    expect(await screen.findByRole("heading", { level: 2, name: "Shifts being given away" })).toBeInTheDocument();
    expect(within(screen.getByTestId("swap-pool-row")).getByTestId("swap-pool-verdict").textContent).toBe("You're free then");
    expect(content().textContent).toContain("Being given away");
    expect(content().textContent).toContain("You both agreed.");
    expect(content().textContent).not.toMatch(/up for grabs/i);
    fireEvent.click(screen.getByTestId("swap-give-away"));
    expect(within(await screen.findByTestId("swap-sell")).getByRole("button", { name: "Give it away" })).toBeInTheDocument();
  });

  it("da: a give-away someone just took says so in Danish, not the server's English", async () => {
    data.pool = [{ id: "ga-1", from_staff_name: "Ida H.", from_shift_date: nextWeek(5), from_shift_time: "16:00–22:00" }];
    postImpl = () => refuse(422, "This shift has already been taken.");
    await mount("da");
    go("swaps");
    const row = await screen.findByTestId("swap-pool-row");
    await act(async () => { fireEvent.click(within(row).getByRole("button", { name: "Tag den" })); });
    expect(await screen.findByText("En kollega har lige taget vagten.")).toBeInTheDocument();
    expect(content().textContent).not.toContain("This shift has already been taken.");
  });
});

describe("English: the walk's fixes on the page", () => {
  it("Timer: the pay-cycle chips read 1–30 / 15–14 / 16–15 in English and keep the Danish dot in Danish; the dates hold their columns", async () => {
    await mount("en");
    go("hours");
    fireEvent.click(await screen.findByTestId("portal-hours-period"));
    const sheet = await screen.findByTestId("portal-period-sheet");
    const chips = within(sheet).getAllByRole("button").filter((b) => b.hasAttribute("aria-pressed"));
    const labels = chips.map((c) => c.querySelector(".vp-figures").textContent);
    expect(labels[0]).toMatch(/^1–(28|29|30|31)$/);
    expect(labels.slice(1)).toEqual(["15–14", "16–15"]);
    expect(sheet.textContent).not.toMatch(/\d\.–/);
    for (const id of ["portal-period-from", "portal-period-to"]) {
      const input = within(sheet).getByTestId(id);
      expect(input.type).toBe("date");
      expect(input.style.minWidth).toMatch(/^0(px)?$/);
      expect(input.style.appearance).toBe("none");
      expect(input.style.maxWidth).toBe("100%");
    }
  });

  it("Timer (da): the chips keep the ordinal dot", async () => {
    await mount("da");
    go("hours");
    fireEvent.click(await screen.findByTestId("portal-hours-period"));
    const sheet = await screen.findByTestId("portal-period-sheet");
    const labels = within(sheet).getAllByRole("button").filter((b) => b.hasAttribute("aria-pressed"))
      .map((c) => c.querySelector(".vp-figures").textContent);
    expect(labels.slice(1)).toEqual(["15.–14.", "16.–15."]);
  });

  it("Timer: the work-permit note prints the hours left the way the hours formatter does (no float noise, no '{n} hours')", async () => {
    data.info.max_hours_month = 26.91; // 26.91 − 19.5 = 7.410000000000002 in floating point
    await mount("en");
    go("hours");
    const note = await screen.findByTestId("portal-hours-permit-note");
    expect(note.textContent).toContain("You have 7.41 h left this period.");
    expect(note.textContent).not.toMatch(/7\.41000/);
  });

  it("Timer (da): the same note with a comma and 't'", async () => {
    data.info.max_hours_month = 26.91;
    await mount("da");
    go("hours");
    const note = await screen.findByTestId("portal-hours-permit-note");
    expect(note.textContent).toContain("Du har 7,41 t tilbage i denne periode.");
  });

  it("Fravær: removing a weekly rule names the whole weekday ('every Friday', 'hver fredag'), and the legend says 'Preferred'", async () => {
    await mount("en");
    go("availability");
    const week = await screen.findByTestId("kanikke-week");
    fireEvent.click(within(week).getByRole("button", { name: "Next week" }));
    // The Fravær strip spells the week as the home does ("9–15 November").
    const range = week.querySelector("span.min-w-0.truncate");
    expect(range.textContent).toMatch(/^\d{1,2}–\d{1,2} [A-Z][a-z]+$|^\d{1,2} [A-Z][a-z]{2} – \d{1,2} [A-Z][a-z]{2}$/);
    const weekly = within(week).getAllByRole("button").find((b) => b.dataset.look === "weekly");
    fireEvent.click(weekly);
    const sheet = await screen.findByTestId("kanikke-weekly-sheet");
    expect(sheet.textContent).toContain("This clears every Friday.");
    expect(sheet.textContent).not.toContain("every Fri.");
    const legend = screen.getByTestId("kanikke-legend");
    expect(legend.textContent).toContain("Preferred");
    expect(legend.textContent).not.toContain("Prefers");
  });

  it("Fravær (da): 'Det gælder hver fredag.'", async () => {
    await mount("da");
    go("availability");
    const week = await screen.findByTestId("kanikke-week");
    fireEvent.click(within(week).getByRole("button", { name: "Næste uge" }));
    fireEvent.click(within(week).getAllByRole("button").find((b) => b.dataset.look === "weekly"));
    expect((await screen.findByTestId("kanikke-weekly-sheet")).textContent).toContain("Det gælder hver fredag.");
  });

  it("the sick form has one name, 'Report sick', and its button says 'Send'", async () => {
    await mount("en");
    const section = await screen.findByTestId("portal-need-change");
    fireEvent.click(within(section).getByText("Report sick").closest("button"));
    const form = await screen.findByTestId("portal-sick-from-week");
    expect(within(form).getByText("Report sick")).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(form.textContent).not.toContain("Call in sick");
    // The date field holds the card's width (iOS drew it wider).
    const date = within(form).getByTestId("portal-sick-date");
    expect(date.className).toContain("min-w-0");
    expect(date.style.appearance).toBe("none");
  });
});

describe("English: the walk's fixes in the dictionaries and helpers", () => {
  it("the count strings have a singular in both languages", () => {
    expect(en.portalSecComingUpCountOne).toBe("Coming up · {n} more shift");
    expect(da.portalSecComingUpCountOne).toBe("Kommende · {n} vagt mere");
    expect(en.portalConfirmCountOne).toBe("{n} shift confirmed");
    expect(da.portalConfirmCountOne).toBe("{n} vagt bekræftet");
    expect(en.portalDeptShiftCountOne).toBe("{n} shift");
    expect(da.portalDeptShiftCountOne).toBe("{n} vagt");
  });

  it("a break ended within a minute has its own words, not the clock-out line", () => {
    expect(en.portalBreakTooShort).toBe("Break under a minute — not counted.");
    expect(da.portalBreakTooShort).toBe("Pausen var under et minut — den tæller ikke med.");
  });

  it("the ring's break line is short: '{d} on shift' / '{d} på vagt'", () => {
    expect(en.portalLiveBreakSub).toBe("{d} on shift");
    expect(da.portalLiveBreakSub).toBe("{d} på vagt");
  });

  it("lønseddel is a locked term in English too; the bank errors name the fields the form shows", () => {
    for (const k of ["portalHolidaySince", "portalHolidayBalanceOnPayslip"]) {
      expect(en[k]).toContain("lønseddel");
      expect(en[k]).not.toMatch(/payslip/i);
    }
    expect(en.portalDocsEmpty).toContain("lønsedler");
    for (const k of Object.keys(en).filter((key) => key.startsWith("portalBankErr"))) {
      expect(en[k]).not.toMatch(/kontonummer|registreringsnummer/i);
    }
  });

  it("one loading ellipsis, and the plain words the walk asked for", () => {
    expect(en.portalPinVerifying).toBe("Verifying…");
    expect(en.portalSending).toBe("Sending…");
    expect(da.portalPinVerifying).toBe("Bekræfter…");
    expect(da.portalSending).toBe("Sender…");
    expect(en.legendApproved).toBe("Approved time off");
    expect(en.portalHoursOpenLive).toBe("Clocked in at {t}");
    expect(en.staffRemindHr).toBe("{n} hours");
    expect(en.portalStaleStrip).toBe("Couldn't refresh – showing the last update");
    expect(en.portalSwapAcceptedLine).toBe("You both agreed.");
    expect(da.portalSwapAcceptedLine).toBe("I er begge enige.");
    for (const k of ["portalSwapPickTeammate", "portalSwapTakeInExchange", "portalSwapProposeHint"]) {
      expect(en[k]).toMatch(/colleague/);
      expect(en[k]).not.toMatch(/teammate/i);
    }
  });

  it("the distance is in the app language's decimal mark, with no second hedge", () => {
    expect(formatClockDistance(1234, "en")).toBe("1.2 km");
    expect(formatClockDistance(1234, "da")).toBe("1,2 km");
    expect(formatClockDistance(412.6, "en")).toBe("413 m");
    expect(formatClockDistance(null, "en")).toBe("");
    const line = en.portalClockTooFarDist.replace("{dist}", formatClockDistance(1234, "en")).replace("{venue}", "Café Solsikke");
    expect(line).toBe("About 1.2 km from Café Solsikke");
    expect(da.portalClockTooFarDist.replace("{dist}", formatClockDistance(1234, "da")).replace("{venue}", "Café Solsikke")).toBe("Cirka 1,2 km fra Café Solsikke");
  });

  it("every server sentence the portal maps has a real English AND Danish line", () => {
    const keys = [
      ...Object.values(PORTAL_SERVER_ERRORS).map(([k]) => k),
      ...PORTAL_SERVER_ERROR_PATTERNS.map((p) => p.key),
    ];
    for (const k of keys) {
      expect(typeof en[k], k).toBe("string");
      expect(typeof da[k], k).toBe("string");
      expect(da[k], k).not.toBe(en[k]);
    }
    // The inline fallback is the English line, so it cannot go stale.
    for (const [k, fb] of Object.values(PORTAL_SERVER_ERRORS)) expect(fb).toBe(en[k]);
    for (const p of PORTAL_SERVER_ERROR_PATTERNS) expect(p.fallback).toBe(en[p.key]);
  });

  it("portalErrText: a known sentence in the staffer's language, a number in their format, an unknown one as before", () => {
    const tr = (dict) => (key, fallback, vars) => {
      let out = dict[key] ?? fallback;
      for (const [k, v] of Object.entries(vars || {})) out = out.replaceAll(`{${k}}`, v);
      return out;
    };
    const err = (detail) => ({ response: { status: 422, data: { detail } } });
    expect(portalErrText(err("This shift has already been taken."), tr(da), "x", "da")).toBe("En kollega har lige taget vagten.");
    expect(portalErrText(err("This shift has already been taken."), tr(en), "x", "en")).toBe("Someone just took this shift.");
    expect(portalErrText(err("Invalid phone format. Use international format e.g. +4512345678"), tr(da), "x", "da"))
      .toBe("Det telefonnummer ser ikke rigtigt ud. Brug internationalt format, f.eks. +4512345678.");
    expect(portalErrText(err("Taking this shift would put you over your weekly limit (38.5 of 37 hours)."), tr(da), "x", "da"))
      .toBe("Vagten ville bringe dig over din ugegrænse (38,5 t af 37 t).");
    expect(portalErrText(err("Date is too far in the past (max 30 days back). Ask your manager to log this absence."), tr(en), "x", "en"))
      .toBe("That date is too far back (at most 30 days). Ask your manager to log this absence.");
    // Unknown: unchanged behaviour (errText passes it through).
    expect(portalErrText(err("Something new."), tr(da), "x", "da")).toBe("Something new.");
    expect(portalErrText({}, tr(da), "Kunne ikke gemme", "da")).toBe("Kunne ikke gemme");
  });
});
