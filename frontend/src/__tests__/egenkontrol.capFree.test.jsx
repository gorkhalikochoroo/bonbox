/**
 * Egenkontrol R1b — the Free plan's 6 active checks (Decision 1):
 *   • a 402 cap_exceeded on setup / a new check / switching one back on →
 *     on the WEB the upgrade sheet (components/Entitlement, forCap, with its
 *     /subscription link) + the plain words; in the APP (isNativeApp) only
 *     the plain words "Jeres plan har ikke plads …" — no purchase link
 *     (Apple 3.1.1);
 *   • Opsætning shows "Jeres plan: op til 6 aktive kontrolpunkter · 5 i
 *     brug"; after a downgrade (8 active on Free) "I har 8 aktive
 *     kontrolpunkter. De virker alle stadig. …" — never that records are
 *     incomplete; a paid plan (100) shows nothing;
 *   • the start list counts along as items are ticked.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.capFree
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), native: false }));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: vi.fn(), patch: (...a) => h.patch(...a), delete: vi.fn(),
    defaults: { baseURL: "http://test/api" },
  },
}));
vi.mock("../utils/platform", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, isNativeApp: () => h.native };
});
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
const { __resetEgenkontrolStatus } = await import("../components/egenkontrol/useEgenkontrolStatus");

const TPL = (key, extra = {}) => ({
  key, kind: "temp_max", group_key: "temperatures", limit: { limit_c: 5, direction: "max", source: "law" }, product_limits: null,
  schedule_default: { type: "daily", due: "08:00" }, schedule_options: ["daily", "weekly", "on_event"], action_codes: [], fate_codes: [], recheck_min: 30, ...extra,
});
const TEMPLATES = { cutoff_hour: 6, templates: [TPL("fridge"), TPL("freezer", { limit: { limit_c: -18, direction: "max", source: "fvst_example" } })] };
const CAP_402 = { response: { status: 402, data: { detail: { error: "cap_exceeded", cap: "egenkontrol_active_checks", current: 6, limit: 6, plan: "free", upgrade_to: "starter" } } } };
const check = (id) => ({
  id, name: `Køl ${id}`, kind: "temp_max", template_key: "fridge", group_key: "temperatures", active: true,
  limit: { limit_c: 5, direction: "max", source: "law" }, schedule: { type: "daily", due: "08:00" }, schedule_options: ["daily", "weekly", "on_event"], recheck_min: 30,
});
let routes;
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const renderPage = async (path) => {
  render(<MemoryRouter initialEntries={[path]}><EgenkontrolPage /></MemoryRouter>);
  await settle();
};
const capAlert = () => screen.getAllByRole("alert").find((a) => a.textContent.includes(da.ekCapReached));
// jsdom has no z-order: read the Tailwind z-[n] class on the stacking roots.
const zOf = (el) => Number((String(el?.className || "").match(/(?:^|\s)z-\[(\d+)\]/) || [])[1] ?? (String(el?.className || "").match(/(?:^|\s)z-(\d+)(?:\s|$)/) || [])[1] ?? NaN);
const subscriptionLinks = () => Array.from(document.querySelectorAll('a[href="/subscription"]'));

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.patch.mockReset();
  h.native = false;
  routes = {
    "/egenkontrol/today": { business_date: "2026-11-12", cutoff_hour: 6, setup_done: false, checks: [], summary: {} },
    "/egenkontrol/checks": { checks: [], archived: [], cap: { limit: 6, active: 0 } },
    "/egenkontrol/templates": TEMPLATES,
    "/egenkontrol/staff": { staff: [] },
  };
  h.get.mockImplementation((url) => (url in routes ? Promise.resolve({ data: routes[url] }) : Promise.reject({ response: { status: 404 } })));
  __resetEgenkontrolStatus();
});

describe("402 on setup", () => {
  it("web: the upgrade sheet (with its plans link) and the plain words; nothing created", async () => {
    h.post.mockRejectedValue(CAP_402);
    await renderPage("/egenkontrol");
    expect(screen.getByTestId("ek-setup-cap")).toHaveTextContent("Jeres plan: op til 6 aktive kontrolpunkter · 2 i brug");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Tilføj 2 kontrolpunkter" })); });
    await settle(2);
    expect(screen.getByRole("alert")).toHaveTextContent(da.ekCapReached);
    expect(subscriptionLinks().length).toBeGreaterThan(0);
    expect(screen.getByTestId("ek-cap-prompt")).toHaveTextContent("Opgrader til Starter");
  });

  it("the app (iOS / Android): the plain words only — no purchase link", async () => {
    h.native = true;
    h.post.mockRejectedValue(CAP_402);
    await renderPage("/egenkontrol");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Tilføj 2 kontrolpunkter" })); });
    await settle(2);
    expect(screen.getByRole("alert")).toHaveTextContent(da.ekCapReached);
    expect(subscriptionLinks()).toHaveLength(0);
  });
});

describe("Opsætning says the plan's line honestly", () => {
  it("Free, 5 of 6 → 'Jeres plan: op til 6 aktive kontrolpunkter · 5 i brug'", async () => {
    routes["/egenkontrol/checks"] = { checks: [1, 2, 3, 4, 5].map((i) => check(`c${i}`)), archived: [], cap: { limit: 6, active: 5 } };
    await renderPage("/egenkontrol?tab=setup");
    expect(screen.getByTestId("ek-cap-line")).toHaveTextContent("Jeres plan: op til 6 aktive kontrolpunkter · 5 i brug");
  });

  it("after a downgrade: 8 active on Free → they all still work", async () => {
    routes["/egenkontrol/checks"] = { checks: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => check(`c${i}`)), archived: [], cap: { limit: 6, active: 8 } };
    await renderPage("/egenkontrol?tab=setup");
    const line = screen.getByTestId("ek-cap-line");
    expect(line).toHaveTextContent("I har 8 aktive kontrolpunkter. De virker alle stadig. Nye kan tilføjes, når I har færre end 6.");
    expect(line.textContent).not.toMatch(/ufuldstændig|mangler|incomplete/i);
  });

  it("a paid plan (100) shows no line", async () => {
    routes["/egenkontrol/checks"] = { checks: [check("c1")], archived: [], cap: { limit: 100, active: 1 } };
    await renderPage("/egenkontrol?tab=setup");
    expect(screen.queryByTestId("ek-cap-line")).toBeNull();
  });

  it("a new check over the limit (402) → the sheet says so and the upgrade sheet opens (web)", async () => {
    routes["/egenkontrol/checks"] = { checks: [1, 2, 3, 4, 5, 6].map((i) => check(`c${i}`)), archived: [], cap: { limit: 6, active: 6 } };
    h.post.mockRejectedValue(CAP_402);
    await renderPage("/egenkontrol?tab=setup");
    fireEvent.click(screen.getByRole("button", { name: da.ekAddCheck }));
    fireEvent.click(screen.getByRole("button", { name: da.ekTplFridge }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.ekSave })); });
    await settle(2);
    expect(h.post.mock.calls[0][0]).toBe("/egenkontrol/checks");
    expect(capAlert()).toBeTruthy();
    expect(subscriptionLinks().length).toBeGreaterThan(0);
    // The editor is a Sheet (portaled to <body>, z-[60]). The prompt must sit
    // ABOVE it — its own portal on <body> with a higher z — never inside it.
    const editor = screen.getByRole("dialog", { name: da.ekAddCheck });
    const prompt = screen.getByTestId("ek-cap-prompt");
    expect(editor.parentElement).toBe(document.body);
    expect(prompt.parentElement).toBe(document.body);
    expect(editor.contains(prompt)).toBe(false);
    expect(zOf(prompt)).toBeGreaterThan(zOf(editor));
    expect(zOf(editor)).toBe(60);
    // It names the plan the 402 says lifts the limit (Starter), not Pro.
    expect(prompt).toHaveTextContent("Opgrader til Starter");
    expect(prompt).not.toHaveTextContent("Opgrader til Pro");
    // "Måske senere" closes the prompt; the editor (and what was typed) stays.
    fireEvent.click(within(prompt).getByRole("button", { name: da.upgradeMaybeLater }));
    expect(screen.queryByTestId("ek-cap-prompt")).toBeNull();
    expect(screen.getByRole("dialog", { name: da.ekAddCheck })).toBeInTheDocument();
  });

  it("a 402 without upgrade_to still names Starter (the plan that lifts this limit), never Pro", async () => {
    routes["/egenkontrol/checks"] = { checks: [1, 2, 3, 4, 5, 6].map((i) => check(`c${i}`)), archived: [], cap: { limit: 6, active: 6 } };
    const { upgrade_to: _drop, ...noTarget } = CAP_402.response.data.detail;
    h.post.mockRejectedValue({ response: { status: 402, data: { detail: noTarget } } });
    await renderPage("/egenkontrol?tab=setup");
    fireEvent.click(screen.getByRole("button", { name: da.ekAddCheck }));
    fireEvent.click(screen.getByRole("button", { name: da.ekTplFridge }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.ekSave })); });
    await settle(2);
    expect(screen.getByTestId("ek-cap-prompt")).toHaveTextContent("Opgrader til Starter");
  });

  it("switching a check back on over the limit (402) → the same", async () => {
    routes["/egenkontrol/checks"] = { checks: [{ ...check("c9"), active: false }], archived: [], cap: { limit: 6, active: 6 } };
    h.patch.mockRejectedValue(CAP_402);
    h.native = true;
    await renderPage("/egenkontrol?tab=setup");
    fireEvent.click(screen.getByRole("button", { name: da.ekEditCheck }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.ekSwitchOn })); });
    await settle(2);
    expect(h.patch).toHaveBeenCalledWith("/egenkontrol/checks/c9", { active: true });
    expect(capAlert()).toBeTruthy();
    expect(subscriptionLinks()).toHaveLength(0);
  });
});
