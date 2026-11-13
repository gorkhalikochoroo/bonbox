/**
 * Egenkontrol R1b — the venue's own findsmiley.dk link (Decision 7):
 *   • the Kontrolmappe (owner AND the kitchen iPad) shows a plain TEXT link
 *     "Se vores kontrolrapporter på findsmiley.dk" — target _blank, rel
 *     "noopener noreferrer" — never an <img>, never the smiley or a logo;
 *     a stored value that is not a findsmiley.dk link is not linked at all;
 *   • Opsætning: "Link til jeres side på findsmiley.dk" + the help text; a
 *     wrong prefix is caught on the device ("Linket skal begynde med
 *     https://www.findsmiley.dk/ eller https://findsmiley.dk/") and not sent;
 *     a good one is trimmed and PUT; https://findsmiley.dk/… (no www, 13 Nov
 *     2026) is sent in the one www form the server stores; the server's 422
 *     findsmiley_invalid says the same; empty clears;
 *   • the pre-check matrix (the server's allow-list is the rule).
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.smiley
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

const h = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: vi.fn(), put: (...a) => h.put(...a), patch: vi.fn(), delete: vi.fn(),
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
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1", role: "owner", business_type: "cafe" } }) }));
vi.mock("../hooks/useToast", () => ({ useToast: () => vi.fn() }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../hooks/useDeviceShare", () => ({ useDeviceShare: () => ({ enabled: false, locked: false, reveal: async () => {} }) }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../utils/download", () => ({ saveFile: vi.fn() }));

const EgenkontrolPage = (await import("../pages/EgenkontrolPage")).default;
const FolderView = (await import("../components/egenkontrol/FolderView")).default;
const { checkFindsmiley } = await import("../components/egenkontrol/ekLogic");
const { __resetEgenkontrolStatus } = await import("../components/egenkontrol/useEgenkontrolStatus");

const t = (k, vars) => {
  let s = da[k] ?? k;
  if (vars && typeof vars === "object") s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};
const URL_OK = "https://www.findsmiley.dk/769342";
const FOLDER = (url) => ({
  from: "2026-10-14", to: "2026-11-12", title_counts: { readings: 0 }, summary: {}, days: [], deviations: [], late: [], missed: [], undone: [],
  findsmiley_url: url,
});
let routes;
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

beforeEach(() => {
  h.get.mockReset();
  h.put.mockReset();
  routes = {
    "/egenkontrol/today": { business_date: "2026-11-12", cutoff_hour: 6, checks: [], summary: {} },
    "/egenkontrol/checks": { checks: [], archived: [] },
    "/egenkontrol/templates": { templates: [] },
    "/egenkontrol/staff": { staff: [] },
    "/egenkontrol/devices": { devices: [] },
    "/egenkontrol/settings": { findsmiley_url: null, opted_in: false, opt_in_offered: false },
  };
  h.get.mockImplementation((url) => (url in routes ? Promise.resolve({ data: routes[url] }) : Promise.reject({ response: { status: 404 } })));
  __resetEgenkontrolStatus();
});

describe("the Kontrolmappe link", () => {
  it("a plain text link, new tab, noopener noreferrer — no image", () => {
    render(<FolderView folder={FOLDER(URL_OK)} t={t} lang="da" />);
    const a = screen.getByTestId("ek-smiley-link");
    expect(a.tagName).toBe("A");
    expect(a).toHaveTextContent("Se vores kontrolrapporter på findsmiley.dk");
    expect(a).toHaveAttribute("href", URL_OK);
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", "noopener noreferrer");
    expect(a.querySelector("img")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });
  it("not set, or not a findsmiley.dk link → no link at all", () => {
    const { unmount } = render(<FolderView folder={FOLDER(null)} t={t} lang="da" />);
    expect(screen.queryByTestId("ek-smiley-link")).toBeNull();
    unmount();
    render(<FolderView folder={FOLDER("https://www.findsmiley.dk.evil.com/1")} t={t} lang="da" />);
    expect(screen.queryByTestId("ek-smiley-link")).toBeNull();
  });
});

describe("Opsætning → the link", () => {
  const openSetup = async () => {
    render(<MemoryRouter initialEntries={["/egenkontrol?tab=setup"]}><EgenkontrolPage /></MemoryRouter>);
    await settle();
    return screen.getByTestId("ek-smiley-card");
  };

  it("label + the authority's own words; a wrong prefix is refused on the device, not sent", async () => {
    const card = await openSetup();
    expect(card).toHaveTextContent(da.ekSmileyLabel);
    expect(within(card).getByTestId("ek-smiley-help")).toHaveTextContent("Fødevarestyrelsen beder virksomheder linke til findsmiley.dk, når de markedsfører sig online.");
    fireEvent.change(within(card).getByLabelText(da.ekSmileyLabel), { target: { value: "http://www.findsmiley.dk/1" } });
    expect(within(card).getByTestId("ek-smiley-error")).toHaveTextContent("Linket skal begynde med https://www.findsmiley.dk/ eller https://findsmiley.dk/");
    await act(async () => { fireEvent.click(within(card).getByTestId("ek-smiley-save")); });
    expect(h.put).not.toHaveBeenCalled();
  });

  it("a good link is trimmed and saved; the server's 422 is said in the same words", async () => {
    h.put.mockResolvedValueOnce({ data: { findsmiley_url: URL_OK } })
      .mockRejectedValueOnce({ response: { status: 422, data: { detail: { code: "findsmiley_invalid" } } } });
    const card = await openSetup();
    const input = within(card).getByLabelText(da.ekSmileyLabel);
    fireEvent.change(input, { target: { value: `  ${URL_OK}  ` } });
    await act(async () => { fireEvent.click(within(card).getByTestId("ek-smiley-save")); });
    await settle(2);
    expect(h.put).toHaveBeenCalledWith("/egenkontrol/settings", { findsmiley_url: URL_OK });
    const card2 = screen.getByTestId("ek-smiley-card");
    fireEvent.change(within(card2).getByLabelText(da.ekSmileyLabel), { target: { value: "https://www.findsmiley.dk/x?y=<z>" } });
    await act(async () => { fireEvent.click(within(card2).getByTestId("ek-smiley-save")); });
    await settle(2);
    expect(within(screen.getByTestId("ek-smiley-card")).getByTestId("ek-smiley-error")).toHaveTextContent(da.ekErrSmileyUrl);
  });

  it("without www: accepted, sent in the www form, no error shown", async () => {
    h.put.mockResolvedValueOnce({ data: { findsmiley_url: URL_OK } });
    const card = await openSetup();
    fireEvent.change(within(card).getByLabelText(da.ekSmileyLabel), { target: { value: " https://findsmiley.dk/769342 " } });
    expect(within(card).queryByTestId("ek-smiley-error")).toBeNull();
    await act(async () => { fireEvent.click(within(card).getByTestId("ek-smiley-save")); });
    await settle(2);
    expect(h.put).toHaveBeenCalledWith("/egenkontrol/settings", { findsmiley_url: URL_OK });
    const card2 = screen.getByTestId("ek-smiley-card");
    expect(within(card2).getByLabelText(da.ekSmileyLabel)).toHaveValue(URL_OK);
    expect(within(card2).queryByTestId("ek-smiley-error")).toBeNull();
  });

  it("an empty field clears the link (null)", async () => {
    routes["/egenkontrol/settings"] = { findsmiley_url: URL_OK, opted_in: false, opt_in_offered: false };
    h.put.mockResolvedValue({ data: { findsmiley_url: null } });
    const card = await openSetup();
    const input = within(card).getByLabelText(da.ekSmileyLabel);
    expect(input).toHaveValue(URL_OK);
    fireEvent.change(input, { target: { value: "" } });
    await act(async () => { fireEvent.click(within(card).getByTestId("ek-smiley-save")); });
    expect(h.put).toHaveBeenCalledWith("/egenkontrol/settings", { findsmiley_url: null });
  });
});

describe("the device pre-check", () => {
  it.each([
    [URL_OK, URL_OK],
    [`  ${URL_OK}\t`, URL_OK],
    ["", ""],
    ["   ", ""],
    ["http://www.findsmiley.dk/1", null],
    ["https://findsmiley.dk/1", "https://www.findsmiley.dk/1"],
    [" https://findsmiley.dk/769342\t", URL_OK],
    ["http://findsmiley.dk/1", null],
    ["https://findsmiley.dk/", null],
    ["https://findsmiley.dk.evil.com/1", null],
    ["https://findsmiley.dk@evil.com/", null],
    ["https://findsmiley.dk:443/1", null],
    ["HTTPS://FINDSMILEY.DK/1", null],
    ["//findsmiley.dk/1", null],
    ["https://evil.com/https://findsmiley.dk/1", null],
    ["data:text/html,https://findsmiley.dk/1", null],
    ["javascript:alert('https://findsmiley.dk/1')", null],
    [`https://findsmiley.dk/${"1".repeat(229)}`, `https://www.findsmiley.dk/${"1".repeat(229)}`],
    [`https://findsmiley.dk/${"1".repeat(230)}`, null],
    ["https://www.findsmiley.dk.evil.com/1", null],
    ["https://www.findsmiley.dk@evil.com/", null],
    ["https://www.findsmiley.dk:443/1", null],
    ["javascript:alert(1)", null],
    ["https://www.findsmiley.dk/", null],
    ["https://www.findsmiley.dk/a b", null],
    ["https://www.findsmiley.dk/a\nb", null],
    ["https://www.findsmiley.dk/a\\b", null],
    [`https://www.findsmiley.dk/${"1".repeat(230)}`, null],
  ])("%j → %j", (raw, want) => {
    expect(checkFindsmiley(raw)).toBe(want);
  });
});
