/**
 * Egenkontrol R1b — "Ugens egenkontrol", the weekly look over last week:
 *   • the server's numbers (readings, late, not registered, deviations, still
 *     open, from paper, corrections), the deviations open now, the repeat
 *     hint ("… har haft 3 afvigelser på 30 dage. Gennemgå proceduren."),
 *     documents due, and the honest scope line;
 *   • the owner marks it reviewed (optional name + note, verbatim) → POST
 *     /egenkontrol/week/{iso_week}/reviewed → one line "Gennemgået …";
 *   • a manager reads it without the button; a week with no activity is not
 *     shown; a curtained shared tablet does not even fetch it.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.weekReview
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

const h = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), user: { id: "u1", role: "owner" }, share: { enabled: false, locked: false },
}));
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
vi.mock("../hooks/useToast", () => ({ useToast: () => vi.fn() }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../hooks/useDeviceShare", () => ({ useDeviceShare: () => ({ ...h.share, reveal: async () => {} }) }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../utils/download", () => ({ saveFile: vi.fn() }));

const EgenkontrolPage = (await import("../pages/EgenkontrolPage")).default;
const { __resetEgenkontrolStatus } = await import("../components/egenkontrol/useEgenkontrolStatus");

const FRIDGE = {
  id: "c-k1", name: "Køl 1", kind: "temp_max", template_key: "fridge", group_key: "temperatures", active: true,
  limit: { limit_c: 5, direction: "max", source: "law" }, product_limits: null, schedule: { type: "daily", due: "08:00" },
  action_codes: [], fate_codes: [], status: "due", slot: { due_local: "08:00" }, last: null, open_deviation: null,
};
const WEEK = {
  iso_week: "2026-W45", week_number: 45, start: "2026-11-02", end: "2026-11-08", over: true, has_activity: true,
  summary: { readings: 12, slots_late: 1, slots_missed: 2, deviations: 3, deviations_open: 1, paper: 1, corrections: 1 },
  open_deviations: [{ entry_id: "e-1", check_name: "Køl 2", value_c: 8.2, recorded_local_date: "2026-11-07", recorded_local: "08:10" }],
  repeat_hints: [{ check_id: "c-k2", check_name: "Køl 2", count: 3, days: 30 }],
  documents_review_due: [{ id: "d1", title: "Egenkontrolprogram 2025", review_due: "2026-11-20", review_state: "soon" }],
  review: null, can_review: true,
};
let routes;
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const renderPage = async () => {
  render(<MemoryRouter initialEntries={["/egenkontrol"]}><EgenkontrolPage /></MemoryRouter>);
  await settle();
};

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.user = { id: "u1", role: "owner" };
  h.share = { enabled: false, locked: false };
  routes = {
    "/egenkontrol/today": { business_date: "2026-11-12", cutoff_hour: 6, checks: [FRIDGE], summary: { total: 1, done: 0, missing: 0 } },
    "/egenkontrol/checks": { checks: [FRIDGE], archived: [] },
    "/egenkontrol/templates": { templates: [] },
    "/egenkontrol/staff": { staff: [] },
    "/egenkontrol/week": WEEK,
  };
  h.get.mockImplementation((url) => (url in routes ? Promise.resolve({ data: routes[url] }) : Promise.reject({ response: { status: 404 } })));
  __resetEgenkontrolStatus();
});

describe("Ugens egenkontrol", () => {
  it("the owner: numbers, open deviations, the repeat hint, documents due, the scope line; then 'Markér som gennemgået'", async () => {
    h.post.mockResolvedValue({
      data: { iso_week: "2026-W45", week_start: "2026-11-02", week_end: "2026-11-08", reviewed_local_date: "2026-11-12", reviewed_local: "09:12", actor_name: "Manoj <b>", note: "Ok" },
    });
    await renderPage();
    const card = screen.getByTestId("ek-week-card");
    expect(card).toHaveTextContent("Ugens egenkontrol · uge 45");
    const counts = within(card).getByTestId("ek-week-counts");
    for (const s of ["12 målinger", "1 for sent", "2 ikke registreret", "3 afvigelser", "1 ikke afsluttet", "1 fra papir", "1 rettelser"]) {
      expect(counts).toHaveTextContent(s);
    }
    expect(card).toHaveTextContent("Køl 2 · 8,2 °C");
    expect(within(card).getByTestId("ek-week-hints")).toHaveTextContent("Køl 2 har haft 3 afvigelser på 30 dage. Gennemgå proceduren.");
    expect(within(card).getByTestId("ek-week-docs")).toHaveTextContent("Egenkontrolprogram 2025");
    expect(within(card).getByTestId("ek-week-scope")).toHaveTextContent(da.ekWeekScope);

    fireEvent.change(within(card).getByLabelText(da.ekWeekName), { target: { value: "Manoj <b>" } });
    fireEvent.change(within(card).getByLabelText(da.ekWeekNote), { target: { value: "Ok" } });
    await act(async () => { fireEvent.click(within(card).getByTestId("ek-week-mark")); });
    await settle(2);
    expect(h.post).toHaveBeenCalledWith("/egenkontrol/week/2026-W45/reviewed", { name: "Manoj <b>", note: "Ok" });
    expect(within(card).getByTestId("ek-week-reviewed")).toHaveTextContent(/Gennemgået 12\.? [Nn]ov\.? 26 kl\. 09:12 · Manoj <b>/);
    expect(within(card).queryByTestId("ek-week-mark")).toBeNull();
  });

  it("blank name and note go as null", async () => {
    h.post.mockResolvedValue({ data: { reviewed_local_date: "2026-11-12", reviewed_local: "09:12", actor_name: null } });
    await renderPage();
    await act(async () => { fireEvent.click(screen.getByTestId("ek-week-mark")); });
    expect(h.post.mock.calls[0][1]).toEqual({ name: null, note: null });
  });

  it("a manager reads it, without the button", async () => {
    h.user = { id: "m1", role: "manager" };
    await renderPage();
    expect(screen.getByTestId("ek-week-card")).toBeInTheDocument();
    expect(screen.queryByTestId("ek-week-mark")).toBeNull();
  });

  it("a week with nothing in it is not shown", async () => {
    routes["/egenkontrol/week"] = { ...WEEK, has_activity: false };
    await renderPage();
    expect(screen.queryByTestId("ek-week-card")).toBeNull();
  });

  it("a curtained shared tablet does not fetch it", async () => {
    h.share = { enabled: true, locked: true };
    await renderPage();
    expect(h.get.mock.calls.map((c) => c[0])).not.toContain("/egenkontrol/week");
    expect(screen.queryByTestId("ek-week-card")).toBeNull();
  });
});
