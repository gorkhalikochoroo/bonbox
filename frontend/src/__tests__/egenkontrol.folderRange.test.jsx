/**
 * Egenkontrol R1b — the Kontrolmappe's period, up to 92 days per file:
 *   • "Seneste 30 dage" by default; "Denne måned", "Sidste måned", "Seneste 3
 *     måneder" (today − 91 … today), "Vælg datoer";
 *   • ONE period drives the folder on screen and the PDF;
 *   • a chosen span over 92 days is refused on the device ("Højst 92 dage ad
 *     gangen.") and never fetched; the server's 422 range_too_long says the same;
 *   • the PDF toast follows saveFile's real outcome.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.folderRange
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const h = vi.hoisted(() => ({ get: vi.fn(), toast: vi.fn(), saveFile: vi.fn() }));
vi.mock("../services/api", () => ({
  default: { get: (...a) => h.get(...a), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { baseURL: "http://test/api" } },
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
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1", role: "owner" } }) }));
vi.mock("../hooks/useToast", () => ({ useToast: () => h.toast }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../hooks/useDeviceShare", () => ({ useDeviceShare: () => ({ enabled: false, locked: false, reveal: async () => {} }) }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../utils/download", () => ({ saveFile: (...a) => h.saveFile(...a) }));

const EgenkontrolPage = (await import("../pages/EgenkontrolPage")).default;
const { rangePreset, rangeProblem, spanDays } = await import("../components/egenkontrol/ekLogic");
const { __resetEgenkontrolStatus } = await import("../components/egenkontrol/useEgenkontrolStatus");

const FOLDER = {
  from: "2026-10-14", to: "2026-11-12", title_counts: { readings: 0 }, summary: {}, days: [], deviations: [], late: [], missed: [], undone: [],
};
let folderReply;
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const folderCalls = () => h.get.mock.calls.filter(([u]) => u === "/egenkontrol/folder").map(([, cfg]) => cfg?.params || {});

beforeEach(() => {
  h.get.mockReset();
  h.toast.mockReset();
  h.saveFile.mockReset();
  folderReply = (params) => Promise.resolve({ data: { ...FOLDER, from: params.from, to: params.to } });
  const routes = {
    "/egenkontrol/today": { business_date: "2026-11-12", cutoff_hour: 6, checks: [], summary: {} },
    "/egenkontrol/checks": { checks: [], archived: [] },
    "/egenkontrol/templates": { templates: [] },
    "/egenkontrol/staff": { staff: [] },
    "/egenkontrol/folder.pdf": new Blob(["%PDF-1.4"], { type: "application/pdf" }),
  };
  h.get.mockImplementation((url, cfg) => {
    if (url === "/egenkontrol/folder") return folderReply(cfg?.params || {});
    return url in routes ? Promise.resolve({ data: routes[url] }) : Promise.reject({ response: { status: 404 } });
  });
  __resetEgenkontrolStatus();
});

describe("presets from the venue's business date", () => {
  it("last 30, this month, last month (across a year), last 92", () => {
    expect(rangePreset("last30", "2026-11-12")).toEqual({ from: "2026-10-14", to: "2026-11-12" });
    expect(rangePreset("thisMonth", "2026-11-12")).toEqual({ from: "2026-11-01", to: "2026-11-12" });
    expect(rangePreset("lastMonth", "2026-11-12")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(rangePreset("lastMonth", "2027-01-05")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(rangePreset("last92", "2026-11-12")).toEqual({ from: "2026-08-13", to: "2026-11-12" });
    expect(spanDays("2026-08-13", "2026-11-12")).toBe(92);
    expect(rangeProblem("2026-08-12", "2026-11-12", "2026-11-12")).toBe("range_too_long");
    expect(rangeProblem("2026-08-13", "2026-11-12", "2026-11-12")).toBeNull();
    expect(rangeProblem("2026-11-01", "2026-11-13", "2026-11-12")).toBe("bad_range");
    expect(rangeProblem("2026-11-05", "2026-11-01", "2026-11-12")).toBe("bad_range");
  });
});

describe("one period for the screen and the PDF", () => {
  it("default 30 days, fetched ONCE; 'Seneste 3 måneder' → 92 days; the PDF asks for the same", async () => {
    h.saveFile.mockResolvedValue({ ok: true, channel: "download" });
    render(<MemoryRouter initialEntries={["/egenkontrol?tab=folder"]}><EgenkontrolPage /></MemoryRouter>);
    await settle();
    expect(folderCalls()).toEqual([{ from: "2026-10-14", to: "2026-11-12" }]);
    expect(screen.getByTestId("ek-range-last30")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByTestId("ek-range-last92"));
    await settle();
    expect(folderCalls().at(-1)).toEqual({ from: "2026-08-13", to: "2026-11-12" });

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.ekDownloadPdf })); });
    await settle();
    const pdf = h.get.mock.calls.find(([u]) => u === "/egenkontrol/folder.pdf");
    expect(pdf[1]).toMatchObject({ params: { from: "2026-08-13", to: "2026-11-12" }, responseType: "blob" });
    expect(h.saveFile.mock.calls[0][1]).toBe("Kontrolmappe_2026-08-13_2026-11-12.pdf");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ message: da.ekPdfReady }));
  });

  it("the PDF button names no fixed period: 'Seneste 3 måneder' never sits under 'Hent PDF (30 dage)'", async () => {
    // Review M1 (15 Nov): the label said "(30 dage)" while the file followed the
    // picker (up to 92 days). The period is shown above the button; the label
    // itself must not promise a length, in either language.
    expect(da.ekDownloadPdf).not.toMatch(/\d/);
    expect(en.ekDownloadPdf).not.toMatch(/\d/);
    render(<MemoryRouter initialEntries={["/egenkontrol?tab=folder"]}><EgenkontrolPage /></MemoryRouter>);
    await settle();
    fireEvent.click(screen.getByTestId("ek-range-last92"));
    await settle();
    const btn = screen.getByRole("button", { name: da.ekDownloadPdf });
    expect(btn.textContent).not.toMatch(/30\s*dage/i);
    expect(btn.textContent).toMatch(/Hent PDF/);
  });

  it("'Vælg datoer' over 92 days → 'Højst 92 dage ad gangen.' and no fetch", async () => {
    render(<MemoryRouter initialEntries={["/egenkontrol?tab=folder"]}><EgenkontrolPage /></MemoryRouter>);
    await settle();
    fireEvent.click(screen.getByTestId("ek-range-custom"));
    await settle();
    const before = folderCalls().length;
    fireEvent.change(screen.getByLabelText(da.ekRangeFrom), { target: { value: "2026-08-01" } });
    await settle();
    expect(screen.getByTestId("ek-range-error")).toHaveTextContent(da.ekErrRangeTooLong);
    expect(folderCalls().length).toBe(before);
    fireEvent.change(screen.getByLabelText(da.ekRangeFrom), { target: { value: "2026-09-01" } });
    await settle();
    expect(screen.queryByTestId("ek-range-error")).toBeNull();
    expect(folderCalls().at(-1)).toEqual({ from: "2026-09-01", to: "2026-11-12" });
  });

  it("the server's 422 range_too_long is said in words", async () => {
    folderReply = () => Promise.reject({ response: { status: 422, data: { detail: { code: "range_too_long", max_days: 92 } } } });
    render(<MemoryRouter initialEntries={["/egenkontrol?tab=folder"]}><EgenkontrolPage /></MemoryRouter>);
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(da.ekErrRangeTooLong);
  });
});
