/**
 * Egenkontrol R1a — a save that fails is never lost in silence (plan "Failed
 * save"), on the real kitchen screen (/kitchen/<token>):
 *   • network error → the row keeps "Ikke gemt endnu · prøv igen" and the
 *     reading stays until the server has it;
 *   • "Prøv igen" resends the SAME body with the SAME client_id (the server
 *     answers a repeated client_id with the stored row — never a second);
 *   • 422 → "Kræver handling", the panel stays open with the server's reason;
 *   • 404 on the save AND on /today → the revoked screen, never blank, never
 *     /login, with "{count} målinger blev ikke gemt. Skriv dem på papir.";
 *   • 404 on the save while /today still answers → a name the server no
 *     longer has: "Kræver handling", the names are fetched again, the pairing
 *     is kept;
 *   • a retry never holds the measurer's name for whoever pressed it;
 *   • a bad token on a cold load is the revoked screen too.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.failedSave
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

const h = vi.hoisted(() => ({
  today: vi.fn(),
  staff: vi.fn(),
  saveEntry: vi.fn(),
  undo: vi.fn(),
  folder: vi.fn(),
  unpair: vi.fn(),
  toast: vi.fn(),
  forget: vi.fn(),
  remember: vi.fn(),
}));

vi.mock("../services/kitchenApi", () => ({
  default: { today: h.today, staff: h.staff, saveEntry: h.saveEntry, undo: h.undo, folder: h.folder, unpair: h.unpair },
  KITCHEN_TOKEN_RE: /^[A-Za-z0-9_-]{8,128}$/,
  forgetKitchenToken: h.forget,
  rememberKitchenToken: h.remember,
  rememberedKitchenToken: () => null,
  rememberedKitchenVenue: () => null,
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
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../hooks/useToast", () => ({ useToast: () => h.toast }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false })); // portrait iPad → Sheet

const KitchenPage = (await import("../pages/KitchenPage")).default;

const TOKEN = "kt_ABCdef123456";
const CHECK = {
  id: "c-k1", name: "Køl 1", note: null, kind: "temp_max", template_key: "fridge", group_key: "temperatures",
  branch_id: null, sort_order: 0, active: true, archived_at: null,
  limit: { limit_c: 5, direction: "max", source: "law", ref: null }, product_limits: null,
  schedule: { type: "daily", due: "08:00" }, schedule_options: ["daily", "weekly", "on_event"], recheck_min: 30,
  action_codes: ["thermostat_adjusted", "moved_goods", "other"], fate_codes: ["moved", "discarded", "assessed_ok", "awaiting_recheck", "other"],
  revision_id: "r1", valid_from: "2026-11-01T07:00:00Z",
  status: "due", slot: { due_at: "2026-11-12T07:00:00Z", due_local: "08:00", late_after: "2026-11-12T08:00:00Z" }, last: null, open_deviation: null,
};
const TODAY = {
  business_date: "2026-11-12", server_now: "2026-11-12T07:05:00Z", timezone: "Europe/Copenhagen", cutoff_hour: 6, setup_done: true,
  checks: [CHECK], summary: { total: 1, done: 0, missing: 0, due: 1, open_deviations: 0 },
  venue_name: "Café Sol", device_label: "Køkken-iPad", branch_name: null,
};
const ENTRY = {
  id: "e-1", check_id: "c-k1", client_id: "x", recorded_at: "2026-11-12T07:05:00Z", recorded_local: "08:05", recorded_local_date: "2026-11-12",
  value_c: 3.1, late: false, deviation_state: null, staff_name: "Ali K.", name_source: "picked", via: "kitchen",
  voided_at: null, undo_until: "2026-11-12T07:07:00Z", slot_due_local: "08:00",
};
const network = () => Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const key = (k) => fireEvent.click(screen.getByRole("button", { name: k === "," ? da.ekKeyDecimal : k }));

async function openAndRecord() {
  render(
    <MemoryRouter initialEntries={[`/kitchen/${TOKEN}`]}>
      <Routes>
        <Route path="/kitchen" element={<KitchenPage />} />
        <Route path="/kitchen/:kitchenToken" element={<KitchenPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await settle();
  fireEvent.click(within(screen.getByTestId("ek-row-c-k1")).getAllByRole("button")[0]);
  const panel = screen.getByTestId("ek-record-panel");
  key("3"); key(","); key("1");
  fireEvent.click(within(panel).getByRole("button", { name: /Ali K\./ }));
  await act(async () => { fireEvent.click(within(panel).getByTestId("ek-save")); });
  await settle();
}

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.today.mockResolvedValue(TODAY);
  h.staff.mockResolvedValue({ staff: [{ id: "s-ali", name: "Ali K.", on_shift: true }] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a failed save stays on screen and a retry sends the same client_id", () => {
  it("network error → 'Ikke gemt endnu · prøv igen' on the row; 'Prøv igen' resends the identical body", async () => {
    h.saveEntry.mockRejectedValueOnce(network()).mockResolvedValueOnce({ ...ENTRY, replayed: true });
    await openAndRecord();

    expect(h.saveEntry).toHaveBeenCalledTimes(1);
    const row = screen.getByTestId("ek-row-c-k1");
    expect(within(row).getByTestId("ek-pending-failed")).toHaveTextContent("Ikke gemt endnu · prøv igen");
    expect(within(row).getByTestId("ek-pending-failed")).toHaveTextContent("3,1 °C");
    expect(screen.getByText(da.ekKitchenOfflineHelp)).toBeInTheDocument();

    await act(async () => { fireEvent.click(within(row).getByRole("button", { name: da.ekRetry })); });
    await settle();
    expect(h.saveEntry).toHaveBeenCalledTimes(2);
    const [[tok1, first], [tok2, second]] = h.saveEntry.mock.calls;
    expect(tok1).toBe(TOKEN);
    expect(tok2).toBe(TOKEN);
    expect(second).toEqual(first);
    expect(second.client_id).toBe(first.client_id);
    expect(first.client_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).toMatchObject({ check_id: "c-k1", value_c: 3.1, staff_id: "s-ali" });
    expect(within(screen.getByTestId("ek-row-c-k1")).queryByTestId("ek-pending-failed")).toBeNull();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ message: "Køl 1 · 3,1 °C · gemt" }));
  });

  it("the browser coming back online resends failed readings with the same client_id", async () => {
    h.saveEntry.mockRejectedValueOnce(network()).mockResolvedValueOnce(ENTRY);
    await openAndRecord();
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await settle();
    expect(h.saveEntry).toHaveBeenCalledTimes(2);
    expect(h.saveEntry.mock.calls[1][1].client_id).toBe(h.saveEntry.mock.calls[0][1].client_id);
  });

  it("422 → 'Kræver handling' and the panel says what the server wants", async () => {
    h.saveEntry.mockRejectedValueOnce({ response: { status: 422, data: { detail: { code: "deviation_fields_required", missing: ["action", "fate"] } } } });
    await openAndRecord();
    expect(within(screen.getByTestId("ek-row-c-k1")).getByTestId("ek-pending-needs-action")).toHaveTextContent(da.ekNeedsAction);
    expect(screen.getByTestId("ek-panel-error")).toHaveTextContent(da.ekErrDeviationFields);
  });

  it("404 → the revoked screen, with the unsent count; the remembered token is forgotten", async () => {
    h.saveEntry.mockRejectedValueOnce({ response: { status: 404, data: { error: "not_found" } } });
    // A real unpairing: /today 404s too once the save has been refused.
    h.today.mockResolvedValueOnce(TODAY).mockRejectedValue({ response: { status: 404, data: { error: "not_found" } } });
    await openAndRecord();
    const card = screen.getByTestId("ek-kitchen-revoked");
    expect(card).toHaveTextContent("Denne iPad er ikke længere parret med Café Sol.");
    expect(card).toHaveTextContent("1 målinger blev ikke gemt. Skriv dem på papir.");
    expect(card).toHaveTextContent(da.ekKitchenPairAgain);
    expect(h.forget).toHaveBeenCalled();
  });

  it("404 on the save while /today answers → 'Kræver handling' for the name, never the revoked screen", async () => {
    h.saveEntry.mockRejectedValueOnce({ response: { status: 404, data: { error: "not_found" } } });
    h.staff
      .mockResolvedValueOnce({ staff: [{ id: "s-ali", name: "Ali K.", on_shift: true }] })
      .mockResolvedValue({ staff: [{ id: "s-bo", name: "Bo L.", on_shift: true }] });
    await openAndRecord();
    expect(screen.queryByTestId("ek-kitchen-revoked")).toBeNull();
    expect(h.forget).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("ek-row-c-k1")).getByTestId("ek-pending-needs-action")).toHaveTextContent(da.ekNeedsAction);
    expect(screen.getByTestId("ek-panel-error")).toHaveTextContent(da.ekErrStaffGone);
    expect(h.staff).toHaveBeenCalledTimes(2);            // the names were fetched again
    const panel = screen.getByTestId("ek-record-panel");
    expect(within(panel).queryByRole("button", { name: /Ali K\./ })).toBeNull();
    expect(within(panel).getByTestId("ek-save")).toHaveTextContent(da.ekCtaChooseName);
    // Choose again → the SAME client_id, the new name.
    h.saveEntry.mockResolvedValueOnce({ ...ENTRY, staff_name: "Bo L." });
    fireEvent.click(within(panel).getByRole("button", { name: /Bo L\./ }));
    await act(async () => { fireEvent.click(within(panel).getByTestId("ek-save")); });
    await settle();
    const [[, first], [, second]] = h.saveEntry.mock.calls;
    expect(second.client_id).toBe(first.client_id);
    expect(second.staff_id).toBe("s-bo");
    expect(within(screen.getByTestId("ek-row-c-k1")).queryByTestId("ek-pending-needs-action")).toBeNull();
  });

  it("a successful retry does not hold the measurer's name for whoever pressed it", async () => {
    h.saveEntry.mockRejectedValueOnce(network()).mockResolvedValueOnce({ ...ENTRY, replayed: true });
    await openAndRecord();
    expect(screen.queryByTestId("ek-measurer")).toBeNull();
    const row = screen.getByTestId("ek-row-c-k1");
    await act(async () => { fireEvent.click(within(row).getByRole("button", { name: da.ekRetry })); });
    await settle();
    expect(h.saveEntry).toHaveBeenCalledTimes(2);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ message: "Køl 1 · 3,1 °C · gemt" }));
    expect(screen.queryByTestId("ek-measurer")).toBeNull();   // no "Måler: Ali K." for the next cook
  });

  it("a cold load with a dead token is the revoked screen, never blank", async () => {
    h.today.mockRejectedValue({ response: { status: 404, data: { error: "not_found" } } });
    render(
      <MemoryRouter initialEntries={[`/kitchen/${TOKEN}`]}>
        <Routes>
          <Route path="/kitchen/:kitchenToken" element={<KitchenPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await settle();
    expect(screen.getByTestId("ek-kitchen-revoked")).toHaveTextContent(da.ekKitchenRevokedTitleNoVenue);
    expect(h.forget).toHaveBeenCalled();
  });

  it("the header says the day honestly: '0 af 1 klaret', the measurer is not set", async () => {
    render(
      <MemoryRouter initialEntries={[`/kitchen/${TOKEN}`]}>
        <Routes>
          <Route path="/kitchen/:kitchenToken" element={<KitchenPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await settle();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("I dag");
    expect(screen.getByTestId("ek-kitchen-progress")).toHaveTextContent("0 af 1 klaret");
    expect(screen.queryByTestId("ek-measurer")).toBeNull();
    expect(h.remember).toHaveBeenCalledWith(TOKEN, "Café Sol");
    for (const bad of ["Alt er klaret", "100 %"]) expect(document.body.textContent).not.toContain(bad);
  });
});
