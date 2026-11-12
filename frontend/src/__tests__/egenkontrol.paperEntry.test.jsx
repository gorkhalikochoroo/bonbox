/**
 * Egenkontrol R1b — "Fra papir" (owner only, at most 14 days back, both
 * dates shown):
 *   • the owner's Kontrolmappe has "Fra papir"; a manager's has not;
 *   • the sheet: the intro, the check, the date (min today − 14, max today),
 *     the time and the reason ABOVE the keypad; the button asks for them
 *     first; out of limit the food question offers CLOSING fates only;
 *   • the POST carries measured_date / measured_time / paper_reason
 *     (verbatim) next to the reading; a refusal keeps the sheet open with the
 *     server's reason and the SAME client_id;
 *   • wherever a paper reading shows: "Indtastet … fra papir · målt …".
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.paperEntry
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), user: { id: "u1", role: "owner", business_type: "cafe" } }));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    defaults: { baseURL: "http://test/api" },
  },
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const t = (k, fb, vars) => {
    const v = typeof fb === "object" && fb ? fb : vars;
    let s = DA[k] ?? (typeof fb === "string" ? fb : k);
    if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
    return s;
  };
  return { useLanguage: () => ({ lang: "da", setLang: () => {}, t }), LanguageProvider: ({ children }) => children };
});
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../hooks/useToast", () => ({ useToast: () => h.toast }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../hooks/useDeviceShare", () => ({ useDeviceShare: () => ({ enabled: false, locked: false, reveal: async () => {} }) }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../utils/download", () => ({ saveFile: vi.fn() }));

const EgenkontrolPage = (await import("../pages/EgenkontrolPage")).default;
const PaperEntrySheet = (await import("../components/egenkontrol/PaperEntrySheet")).default;
const FolderView = (await import("../components/egenkontrol/FolderView")).default;
const { paperLine } = await import("../components/egenkontrol/ekLogic");
const { __resetEgenkontrolStatus } = await import("../components/egenkontrol/useEgenkontrolStatus");

const t = (k, vars) => {
  let s = da[k] ?? k;
  if (vars && typeof vars === "object") s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};
const FRIDGE = {
  id: "c-k1", name: "Køl 1", note: null, kind: "temp_max", template_key: "fridge", group_key: "temperatures", active: true,
  limit: { limit_c: 5, direction: "max", source: "law", ref: null }, product_limits: null, schedule: { type: "daily", due: "08:00" },
  action_codes: ["thermostat_adjusted", "other"], fate_codes: ["moved", "discarded", "assessed_ok", "reheated_75", "awaiting_recheck", "other"],
  status: "due", slot: { due_at: "2026-11-12T07:00:00Z", due_local: "08:00" }, last: null, open_deviation: null,
};
const TODAY = {
  business_date: "2026-11-12", cutoff_hour: 6, setup_done: true, checks: [FRIDGE],
  summary: { total: 1, done: 0, missing: 0, due: 1, open_deviations: 0 },
};
const FOLDER = {
  from: "2026-10-14", to: "2026-11-12", title_counts: { readings: 0, deviations: 0, deviations_open: 0 },
  summary: { readings: 0 }, days: [], deviations: [], late: [], missed: [], undone: [], documents: [], reviews: [],
};
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const routes = {
  "/egenkontrol/today": TODAY,
  "/egenkontrol/checks": { checks: [FRIDGE], archived: [] },
  "/egenkontrol/templates": { cutoff_hour: 6, templates: [] },
  "/egenkontrol/staff": { staff: [{ id: "s-ali", name: "Ali K.", on_shift: true }] },
  "/egenkontrol/folder": FOLDER,
};
const openFolder = async () => {
  render(<MemoryRouter initialEntries={["/egenkontrol?tab=folder"]}><EgenkontrolPage /></MemoryRouter>);
  await settle();
};

beforeEach(() => {
  // Pin the clock (only Date): the sheet's newest date is the venue's
  // calendar date, which the clock picks between business_date and +1.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
  h.get.mockReset();
  h.post.mockReset();
  h.toast.mockReset();
  h.user = { id: "u1", role: "owner", business_type: "cafe" };
  h.get.mockImplementation((url) => (url in routes ? Promise.resolve({ data: routes[url] }) : Promise.reject({ response: { status: 404 } })));
  __resetEgenkontrolStatus();
});

describe("who gets 'Fra papir'", () => {
  it("the owner: a button on the Kontrolmappe; a manager: none", async () => {
    await openFolder();
    expect(screen.getByTestId("ek-paper-open")).toHaveTextContent(da.ekPaperTitle);
  });
  it("a manager never sees it", async () => {
    h.user = { id: "m1", role: "manager" };
    await openFolder();
    expect(screen.getByTestId("ek-folder")).toBeInTheDocument();
    expect(screen.queryByTestId("ek-paper-open")).toBeNull();
  });
});

describe("the paper sheet", () => {
  it("dates: min today − 14, max today; asks for when → reason first; closing fates only; POSTs both dates", async () => {
    h.post.mockResolvedValue({ data: { id: "e-p", value_c: 7 } });
    await openFolder();
    await act(async () => { fireEvent.click(screen.getByTestId("ek-paper-open")); });
    const dialog = screen.getByRole("dialog", { name: da.ekPaperTitle });
    expect(within(dialog).getByTestId("ek-paper-intro")).toHaveTextContent(da.ekPaperIntro);
    const date = within(dialog).getByTestId("ek-paper-date");
    expect(date).toHaveAttribute("min", "2026-10-29");
    expect(date).toHaveAttribute("max", "2026-11-12");
    expect(date).toHaveValue("2026-11-12");
    // The block sits ABOVE the keypad.
    const keys = within(dialog).getByTestId("ek-keypad-keys");
    expect(Boolean(within(dialog).getByTestId("ek-paper-block").compareDocumentPosition(keys) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    const cta = () => within(dialog).getByTestId("ek-save");
    expect(cta()).toHaveTextContent(da.ekCtaPaperWhen);
    fireEvent.change(within(dialog).getByTestId("ek-paper-date"), { target: { value: "2026-11-10" } });
    fireEvent.change(within(dialog).getByTestId("ek-paper-time"), { target: { value: "08:05" } });
    expect(cta()).toHaveTextContent(da.ekCtaPaperReason);
    fireEvent.change(within(dialog).getByTestId("ek-paper-reason"), { target: { value: "Nettet var nede <b>&</b>" } });
    expect(cta()).toHaveTextContent(da.ekCtaEnter);
    fireEvent.click(within(dialog).getByRole("button", { name: "7" }));
    const fates = within(within(dialog).getByTestId("ek-fate-row")).getAllByRole("button").map((b) => b.textContent);
    expect(fates).toEqual(expect.arrayContaining([da.ekFateMoved, da.ekFateDiscarded, da.ekFateAssessedOk]));
    expect(fates).not.toContain(da.ekFateAwaitingRecheck);
    expect(fates).not.toContain(da.ekFateReheated75);
    // No photo on a paper reading.
    expect(within(dialog).queryByTestId("ek-photo-step")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: da.ekActThermostatAdjusted }));
    fireEvent.click(within(dialog).getByRole("button", { name: da.ekFateDiscarded }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Ali K\./ }));
    await act(async () => { fireEvent.click(cta()); });
    await settle();
    const [url, body] = h.post.mock.calls[0];
    expect(url).toBe("/egenkontrol/paper-entries");
    expect(body).toMatchObject({
      check_id: "c-k1", value_c: 7, measured_date: "2026-11-10", measured_time: "08:05",
      paper_reason: "Nettet var nede <b>&</b>", action_code: "thermostat_adjusted", fate_code: "discarded", staff_id: "s-ali",
    });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ message: da.ekPaperSaved }));
    expect(screen.queryByRole("dialog", { name: da.ekPaperTitle })).toBeNull();
  });

  it("422 paper_too_old → the reason in the sheet; the retry keeps the client_id", async () => {
    h.post
      .mockRejectedValueOnce({ response: { status: 422, data: { detail: { code: "paper_too_old", max_days: 14 } } } })
      .mockResolvedValueOnce({ data: { id: "e-p" } });
    await openFolder();
    await act(async () => { fireEvent.click(screen.getByTestId("ek-paper-open")); });
    const dialog = screen.getByRole("dialog", { name: da.ekPaperTitle });
    fireEvent.change(within(dialog).getByTestId("ek-paper-time"), { target: { value: "06:30" } });
    fireEvent.change(within(dialog).getByTestId("ek-paper-reason"), { target: { value: "Strøm" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "3" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Ali K\./ }));
    await act(async () => { fireEvent.click(within(dialog).getByTestId("ek-save")); });
    await settle();
    expect(within(dialog).getByTestId("ek-panel-error")).toHaveTextContent(da.ekErrPaperTooOld);
    await act(async () => { fireEvent.click(within(dialog).getByTestId("ek-save")); });
    await settle();
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.post.mock.calls[1][1].client_id).toBe(h.post.mock.calls[0][1].client_id);
  });
});

describe("409 check_inactive at the measured time", () => {
  it("says the check did not exist then — not that it is switched off now", async () => {
    h.post.mockRejectedValue({ response: { status: 409, data: { detail: { code: "check_inactive", at: "measured" } } } });
    await openFolder();
    await act(async () => { fireEvent.click(screen.getByTestId("ek-paper-open")); });
    const dialog = screen.getByRole("dialog", { name: da.ekPaperTitle });
    fireEvent.change(within(dialog).getByTestId("ek-paper-time"), { target: { value: "06:30" } });
    fireEvent.change(within(dialog).getByTestId("ek-paper-reason"), { target: { value: "Strøm" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "3" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Ali K\./ }));
    await act(async () => { fireEvent.click(within(dialog).getByTestId("ek-save")); });
    await settle();
    expect(within(dialog).getByTestId("ek-panel-error")).toHaveTextContent(da.ekErrPaperCheckNotYet);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the paper date is a CALENDAR date (the server reads date + time in the venue's zone)", () => {
  // Business day 12 Nov; the clock is 13 Nov 01:30 — before the 06:00 cutoff.
  const sheet = (prefill, timeZone = "UTC") =>
    render(
      <PaperEntrySheet checks={[FRIDGE]} staff={[]} businessDate="2026-11-12" timeZone={timeZone}
        prefill={prefill} onClose={() => {}} t={t} lang="da" />,
    );

  it("a reading typed at 01:30 on 13 Nov (business day 12 Nov) is filled in as 13 Nov 01:30, not 12 Nov", () => {
    vi.setSystemTime(new Date("2026-11-13T07:00:00Z"));
    sheet({ checkId: "c-k1", typedAt: "2026-11-13T01:30:00.000Z", businessDate: "2026-11-12" });
    const dialog = screen.getByRole("dialog", { name: da.ekPaperTitle });
    expect(within(dialog).getByTestId("ek-paper-date")).toHaveValue("2026-11-13");
    expect(within(dialog).getByTestId("ek-paper-time")).toHaveValue("01:30");
  });

  it("before the cutoff the newest date is today's CALENDAR date (business date + 1)", () => {
    vi.setSystemTime(new Date("2026-11-13T01:30:00Z"));
    sheet(null);
    const date = within(screen.getByRole("dialog", { name: da.ekPaperTitle })).getByTestId("ek-paper-date");
    expect(date).toHaveAttribute("max", "2026-11-13");
    expect(date).toHaveAttribute("min", "2026-10-30");
    expect(date).toHaveValue("2026-11-13");
  });

  it("after the cutoff it is the business date itself, and a wrong clock never goes beyond business date + 1", () => {
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    sheet(null);
    expect(within(screen.getByRole("dialog", { name: da.ekPaperTitle })).getByTestId("ek-paper-date")).toHaveAttribute("max", "2026-11-12");
  });

  it("the venue's zone decides, not the device's: 00:30 in Copenhagen on 13 Nov (23:30 UTC on the 12th)", () => {
    vi.setSystemTime(new Date("2026-11-12T23:30:00Z"));
    sheet(null, "Europe/Copenhagen");
    expect(within(screen.getByRole("dialog", { name: da.ekPaperTitle })).getByTestId("ek-paper-date")).toHaveAttribute("max", "2026-11-13");
  });
});

describe("a paper reading shows both dates", () => {
  const PAPER = {
    id: "e-p", check_name: "Køl 1", source: "paper", value_c: 3.4, staff_name: "Ali K.", name_source: "picked", via: "owner_app",
    paper_measured_local_date: "2026-11-10", paper_measured_local: "08:05", created_local_date: "2026-11-12", created_local: "14:10",
    recorded_local_date: "2026-11-12", recorded_local: "14:10", reason_text: "Nettet var nede",
  };
  it("'Indtastet 12. nov. kl. 14:10 fra papir · målt 10. nov. kl. 08:05' in the folder's Fra papir section", () => {
    expect(paperLine(PAPER, t, "da")).toMatch(/^Indtastet 12\. nov\.? kl\. 14:10 fra papir · målt 10\. nov\.? kl\. 08:05$/);
    render(<FolderView folder={{ ...FOLDER, paper: [PAPER], summary: { paper: 1 } }} t={t} lang="da" />);
    const sec = screen.getByTestId("ek-folder-paper");
    expect(within(sec).getByTestId("ek-paper-line")).toHaveTextContent(/målt 10\. nov\.? kl\. 08:05/);
    expect(sec).toHaveTextContent("Nettet var nede");
    expect(sec).toHaveTextContent("Ali K. (fra papir)");
    expect(screen.getByTestId("ek-folder-counts")).toHaveTextContent("1 fra papir");
  });
});
