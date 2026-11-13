/**
 * Egenkontrol R1a — the "Registrér" panel's one button (plan "Save button
 * text"): it says what is still missing, in order —
 *   "Indtast temperatur" → (7,1 on a 5 °C fridge) "Vælg hvad du gjorde" →
 *   (an action) "Hvad skete der med maden?" → (a fate, name held) "Gem 7,1 °C".
 * In limit "Gem 3,1 °C"; no name "Vælg hvem der målte"; receiving starts at
 * "Vælg varetype"; a follow-up on an awaiting_recheck deviation offers only
 * CLOSING fates; "51" on a fridge asks once through useConfirm, never
 * window.confirm.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.recordPanel
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { ctaFor } from "../components/egenkontrol/ekLogic";

const h = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));

const RecordPanel = (await import("../components/egenkontrol/RecordPanel")).default;

const t = (k, vars) => {
  let s = da[k] ?? k;
  if (vars && typeof vars === "object") s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};

const FRIDGE = {
  id: "c-fridge",
  name: "Køl 2",
  note: null,
  kind: "temp_max",
  template_key: "fridge",
  group_key: "temperatures",
  limit: { limit_c: 5, direction: "max", source: "law", ref: "BEK nr. 1331 af 20/11/2025, bilag 3 A" },
  product_limits: null,
  schedule: { type: "daily", due: "08:00" },
  action_codes: ["thermostat_adjusted", "moved_goods", "other"],
  fate_codes: ["moved", "discarded", "assessed_ok", "awaiting_recheck", "other"],
  recheck_min: 30,
  status: "due",
  slot: { due_local: "08:00" },
  last: null,
  open_deviation: null,
};
const RECEIVING = {
  ...FRIDGE,
  id: "c-recv",
  name: "Varemodtagelse",
  kind: "receiving",
  template_key: "receiving",
  group_key: "receiving",
  limit: null,
  product_limits: [
    { product_type: "chilled", limit_c: 5, direction: "max", source: "law", ref: null },
    { product_type: "fish", limit_c: 2, direction: "max", source: "fvst_example", ref: null },
    { product_type: "frozen", limit_c: -18, direction: "max", source: "fvst_example", ref: null },
  ],
  action_codes: ["supplier_contacted", "other"],
  fate_codes: ["returned", "discarded", "assessed_ok", "other"],
};
const STAFF = [{ id: "s-ali", name: "Ali K.", on_shift: true }];
const ALI = { kind: "staff", id: "s-ali", label: "Ali K." };

const keys = (...ks) => {
  for (const k of ks) fireEvent.click(screen.getByRole("button", { name: k === "," ? da.ekKeyDecimal : k === "-" ? da.ekKeyMinus : k }));
};
const saveButton = () => screen.getByTestId("ek-save");

function renderPanel(props = {}) {
  const onSave = props.onSave || vi.fn(async () => ({ ok: true, entry: { id: "e1" } }));
  render(<RecordPanel check={FRIDGE} staff={STAFF} heldWho={ALI} onSave={onSave} t={t} lang="da" {...props} />);
  return onSave;
}

beforeEach(() => {
  h.confirm.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the save button says what is still missing", () => {
  it("plan sequence on a 5 °C fridge: Indtast → Vælg hvad du gjorde → Hvad skete der med maden? → Gem 7,1 °C", () => {
    renderPanel();
    expect(saveButton()).toHaveTextContent("Indtast temperatur");
    expect(saveButton()).toHaveAttribute("aria-disabled", "true"); // not ready: a tap goes to the missing step

    keys("7", ",", "1");
    expect(saveButton()).toHaveTextContent("Vælg hvad du gjorde");
    expect(saveButton()).toHaveAttribute("aria-disabled", "true"); // not ready: a tap goes to the missing step
    expect(screen.getByText(da.ekTooWarm)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: da.ekActThermostatAdjusted }));
    expect(saveButton()).toHaveTextContent("Hvad skete der med maden?");
    expect(saveButton()).toHaveAttribute("aria-disabled", "true"); // not ready: a tap goes to the missing step

    fireEvent.click(screen.getByRole("button", { name: da.ekFateMoved }));
    expect(saveButton()).toHaveTextContent("Gem 7,1 °C");
    expect(saveButton()).toBeEnabled();
    expect(saveButton()).not.toHaveAttribute("aria-disabled");
  });

  it("in limit: straight to 'Gem 3,1 °C' with no action rows", () => {
    renderPanel();
    keys("3", ",", "1");
    expect(saveButton()).toHaveTextContent("Gem 3,1 °C");
    expect(screen.queryByTestId("ek-action-row")).toBeNull();
    expect(screen.queryByTestId("ek-fate-row")).toBeNull();
  });

  it("no name picked: 'Vælg hvem der målte' — nothing is pre-selected", () => {
    renderPanel({ heldWho: null });
    keys("3", ",", "1");
    expect(saveButton()).toHaveTextContent("Vælg hvem der målte");
    expect(saveButton()).toHaveAttribute("aria-disabled", "true"); // not ready: a tap goes to the missing step
    expect(screen.getByRole("button", { name: /Ali K\./ })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: /Ali K\./ }));
    expect(saveButton()).toHaveTextContent("Gem 3,1 °C");
  });

  it("receiving starts at 'Vælg varetype', then the product's limit applies", () => {
    renderPanel({ check: RECEIVING });
    expect(saveButton()).toHaveTextContent("Vælg varetype");
    fireEvent.click(screen.getByRole("button", { name: /Fisk/ }));
    expect(saveButton()).toHaveTextContent("Indtast temperatur");
    keys("3");
    // 3 °C is above fish's 2 °C: a deviation for fish (but fine for chilled).
    expect(saveButton()).toHaveTextContent("Vælg hvad du gjorde");
    fireEvent.click(screen.getByRole("button", { name: /Fisk/ }));
    fireEvent.click(screen.getByRole("button", { name: /Kølevare/ }));
    expect(saveButton()).toHaveTextContent("Gem 3,0 °C");
  });

  it("a follow-up on an 'awaiting_recheck' deviation in limit offers only CLOSING fates", () => {
    const check = {
      ...FRIDGE,
      status: "deviation_open",
      open_deviation: { entry_id: "e0", fate_code: "awaiting_recheck", needs_fate: true, closes_at_or_above: null, recheck_due_local: "09:30" },
    };
    renderPanel({ check });
    keys("3", ",", "1");
    expect(saveButton()).toHaveTextContent("Hvad skete der med maden?");
    const row = screen.getByTestId("ek-fate-row");
    expect(row).toHaveTextContent(da.ekFateMoved);
    expect(row).toHaveTextContent(da.ekFateDiscarded);
    expect(row).not.toHaveTextContent(da.ekFateAwaitingRecheck);
    expect(screen.queryByTestId("ek-action-row")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: da.ekFateAssessedOk }));
    expect(saveButton()).toHaveTextContent("Gem 3,1 °C");
  });

  it("ctaFor is pure: 'Gemmer…' while sending", () => {
    expect(ctaFor({ saving: true }).key).toBe("ekCtaSaving");
    expect(ctaFor({ kind: "temp_max", value: null }).key).toBe("ekCtaEnter");
    expect(ctaFor({ kind: "temp_max", value: 3.1, who: ALI, lang: "da" })).toMatchObject({ key: "ekCtaSave", disabled: false, vars: { value: "3,1 °C" } });
  });
});

describe("plausibility — '51' on a fridge asks once (useConfirm)", () => {
  it("'Ret tallet' saves nothing; 'Ja, gem' saves 51", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm").mockImplementation(() => true);
    const onSave = renderPanel();
    keys("5", "1");
    // 51 °C on a 5 °C fridge is a deviation too: choose both rows first.
    fireEvent.click(screen.getByRole("button", { name: da.ekActThermostatAdjusted }));
    fireEvent.click(screen.getByRole("button", { name: da.ekFateDiscarded }));
    expect(saveButton()).toHaveTextContent("Gem 51,0 °C");

    h.confirm.mockResolvedValueOnce(false);
    await act(async () => { fireEvent.click(saveButton()); });
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0][0]).toMatchObject({
      title: "Er 51,0 °C rigtigt?",
      confirmLabel: "Ja, gem 51,0 °C",
      cancelLabel: "Ret tallet",
    });
    expect(h.confirm.mock.calls[0][0].message).toContain("Køl 2");
    expect(onSave).not.toHaveBeenCalled();

    h.confirm.mockResolvedValueOnce(true);
    await act(async () => { fireEvent.click(saveButton()); });
    expect(onSave).toHaveBeenCalledTimes(1);
    const body = onSave.mock.calls[0][0];
    expect(body).toMatchObject({ check_id: "c-fridge", value_c: 51, action_code: "thermostat_adjusted", fate_code: "discarded", staff_id: "s-ali" });
    expect(body.client_id).toMatch(/^[0-9a-f-]{36}$/);
    // The server decides these; the client never sends them.
    for (const k of ["in_limit", "late", "recorded_at", "deviation_state"]) expect(body).not.toHaveProperty(k);
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("5,1 on a fridge does not ask", async () => {
    const onSave = renderPanel();
    keys("5", ",", "1");
    fireEvent.click(screen.getByRole("button", { name: da.ekActThermostatAdjusted }));
    fireEvent.click(screen.getByRole("button", { name: da.ekFateMoved }));
    await act(async () => { fireEvent.click(saveButton()); });
    expect(h.confirm).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
