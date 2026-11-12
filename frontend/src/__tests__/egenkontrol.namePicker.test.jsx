/**
 * Egenkontrol R1a — "Hvem målte?" (plan "Name picker"): NOTHING is
 * pre-selected on the first reading; after a save the name is held for 2
 * minutes from that save and shown as "Måler: Ali K. · Skift"; it resets to
 * none after the 2 minutes (each save restarts them); "Skift" clears it at
 * once; "Andet navn" takes at most 40 characters.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.namePicker
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));

const RecordPanel = (await import("../components/egenkontrol/RecordPanel")).default;
const { MeasurerBar } = await import("../components/egenkontrol/NamePicker");
const useNameRound = (await import("../components/egenkontrol/useNameRound")).default;

const t = (k, vars) => {
  let s = da[k] ?? k;
  if (vars && typeof vars === "object") s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};

const FRIDGE = {
  id: "c1", name: "Køl 1", kind: "temp_max", template_key: "fridge", group_key: "temperatures",
  limit: { limit_c: 5, direction: "max", source: "law", ref: null }, product_limits: null,
  action_codes: ["thermostat_adjusted", "other"], fate_codes: ["moved", "discarded", "other"],
  status: "due", slot: { due_local: "08:00" }, last: null, open_deviation: null,
};
const STAFF = [
  { id: "s-ali", name: "Ali K.", on_shift: true },
  { id: "s-bo", name: "Bo L.", on_shift: false },
];

const saves = [];
function Harness() {
  const round = useNameRound();
  return (
    <>
      <MeasurerBar held={round.held} onClear={round.clear} t={t} />
      <RecordPanel
        check={FRIDGE}
        staff={STAFF}
        heldWho={round.held}
        onSave={async (body, meta) => {
          saves.push(body);
          round.hold(meta.state.who);
          return { ok: true, entry: { id: `e${saves.length}` } };
        }}
        t={t}
        lang="da"
      />
    </>
  );
}

const key = (k) => fireEvent.click(screen.getByRole("button", { name: k === "," ? da.ekKeyDecimal : k }));
const cta = () => screen.getByTestId("ek-save");
const ali = () => screen.getByRole("button", { name: /Ali K\./ });
const save = async () => {
  await act(async () => { fireEvent.click(cta()); });
};

beforeEach(() => {
  saves.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Hvem målte? — no default, a 2-minute round", () => {
  it("nothing is pre-selected on the first reading (never staff[0])", () => {
    render(<Harness />);
    expect(screen.queryByTestId("ek-measurer")).toBeNull();
    for (const b of [ali(), screen.getByRole("button", { name: /Bo L\./ })]) expect(b).toHaveAttribute("aria-pressed", "false");
    key("3");
    expect(cta()).toHaveTextContent(da.ekCtaChooseName);
    expect(screen.getByText(da.ekNameSavedNote)).toBeInTheDocument();
    // On-shift first, with the marker.
    expect(ali()).toHaveTextContent(da.ekOnShift);
  });

  it("is held after a save ('Måler: Ali K. · Skift') and resets to none after 2 minutes", async () => {
    render(<Harness />);
    key("3");
    fireEvent.click(ali());
    await save();
    expect(saves[0]).toMatchObject({ staff_id: "s-ali", typed_name: null });
    expect(screen.getByTestId("ek-measurer")).toHaveTextContent("Måler: Ali K.");
    expect(screen.getByTestId("ek-measurer")).toHaveTextContent(da.ekKitchenSwitch);
    // The next reading needs no new pick inside the round.
    key("4");
    expect(cta()).toHaveTextContent("Gem 4,0 °C");
    expect(ali()).toHaveAttribute("aria-pressed", "true");

    act(() => { vi.advanceTimersByTime(119000); });
    expect(screen.getByTestId("ek-measurer")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByTestId("ek-measurer")).toBeNull();
    expect(cta()).toHaveTextContent(da.ekCtaChooseName);
    expect(ali()).toHaveAttribute("aria-pressed", "false");
  });

  it("each save restarts the 2 minutes", async () => {
    render(<Harness />);
    key("3");
    fireEvent.click(ali());
    await save();
    act(() => { vi.advanceTimersByTime(100000); });
    key("2");
    await save();
    act(() => { vi.advanceTimersByTime(100000); });
    expect(screen.getByTestId("ek-measurer")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(21000); });
    expect(screen.queryByTestId("ek-measurer")).toBeNull();
  });

  it("'Skift' clears the held name at once", async () => {
    render(<Harness />);
    key("3");
    fireEvent.click(ali());
    await save();
    fireEvent.click(screen.getByRole("button", { name: da.ekKitchenSwitch }));
    expect(screen.queryByTestId("ek-measurer")).toBeNull();
    key("3");
    expect(cta()).toHaveTextContent(da.ekCtaChooseName);
  });

  it("'Andet navn' opens a typed name of at most 40 characters, sent as typed_name", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: da.ekOtherName }));
    const input = screen.getByPlaceholderText(da.ekOtherNamePlaceholder);
    expect(input).toHaveAttribute("maxLength", "40");
    fireEvent.change(input, { target: { value: "Sofie (afløser)" } });
    key("3");
    expect(cta()).toHaveTextContent("Gem 3,0 °C");
    await save();
    expect(saves[0]).toMatchObject({ staff_id: null, typed_name: "Sofie (afløser)" });
    expect(screen.getByTestId("ek-measurer")).toHaveTextContent("Måler: Sofie (afløser)");
  });

  it("the held name can be deselected inside the panel — it never falls back to it", async () => {
    render(<Harness />);
    key("3");
    fireEvent.click(ali());
    await save();
    key("4");
    expect(ali()).toHaveAttribute("aria-pressed", "true");     // held for the round
    fireEvent.click(ali());                                    // a temp worker: "not me"
    expect(ali()).toHaveAttribute("aria-pressed", "false");
    expect(cta()).toHaveTextContent(da.ekCtaChooseName);
    expect(cta()).toHaveAttribute("aria-disabled", "true"); // not ready: a tap goes to the name
    // Picking someone else, then deselecting them, does not bring Ali back either.
    fireEvent.click(screen.getByRole("button", { name: /Bo L\./ }));
    fireEvent.click(screen.getByRole("button", { name: /Bo L\./ }));
    expect(ali()).toHaveAttribute("aria-pressed", "false");
    expect(cta()).toHaveTextContent(da.ekCtaChooseName);
  });

  it("'Andet navn' with an empty field never saves under the held name", async () => {
    render(<Harness />);
    key("3");
    fireEvent.click(ali());
    await save();
    key("4");
    fireEvent.click(screen.getByRole("button", { name: da.ekOtherName }));
    expect(ali()).toHaveAttribute("aria-pressed", "false");
    expect(cta()).toHaveTextContent(da.ekCtaChooseName);
    expect(cta()).toHaveAttribute("aria-disabled", "true"); // not ready: a tap goes to the name
    await save();
    expect(saves).toHaveLength(1);
    fireEvent.change(screen.getByPlaceholderText(da.ekOtherNamePlaceholder), { target: { value: "Sofie" } });
    expect(cta()).toHaveTextContent("Gem 4,0 °C");
    await save();
    expect(saves[1]).toMatchObject({ staff_id: null, typed_name: "Sofie" });
  });
});
