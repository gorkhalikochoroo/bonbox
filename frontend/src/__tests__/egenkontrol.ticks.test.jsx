/**
 * Egenkontrol R1b — the two ticks, "Rengøring" and "Termometertjek"
 * (kind "tick", on-event, so they are never "missing"):
 *   • the panel: no keypad, no deviation rows, no photo — an optional note,
 *     "Hvem?", and "Gem · udført"; the body says done: true, value null;
 *   • the row: "Sidst udført {dato} kl. {tid}" or "Ikke udført i dag", in a
 *     NEUTRAL tone (never red);
 *   • the groups "Rengøring" and "Andet" after the temperatures;
 *   • the start list offers both, UNTICKED;
 *   • the check editor hides the limit, the schedule and the re-check.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.ticks
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

const h = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn() }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: (...a) => h.post(...a), patch: (...a) => h.patch(...a), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: "x" } },
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  return { useLanguage: () => ({ lang: "da", setLang: () => {}, t: (k) => DA[k] ?? k }) };
});

const RecordPanel = (await import("../components/egenkontrol/RecordPanel")).default;
const CheckList = (await import("../components/egenkontrol/CheckList")).default;
const SetupFromStartList = (await import("../components/egenkontrol/SetupFromStartList")).default;
const CheckEditorSheet = (await import("../components/egenkontrol/CheckEditorSheet")).default;
const { ctaFor, buildEntryBody, groupChecks, statusLines } = await import("../components/egenkontrol/ekLogic");

const t = (k, vars) => {
  let s = da[k] ?? k;
  if (vars && typeof vars === "object") s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};

const CLEANING = {
  id: "c-clean", name: "Rengøring", note: null, kind: "tick", template_key: "cleaning", group_key: "cleaning",
  limit: null, product_limits: null, schedule: { type: "on_event" }, schedule_options: ["on_event"],
  action_codes: [], fate_codes: [], recheck_min: 30, active: true, status: "on_event", slot: null, last: null, open_deviation: null,
};
const THERMO = { ...CLEANING, id: "c-thermo", name: "Termometertjek", template_key: "thermometer", group_key: "other" };
const FRIDGE = {
  id: "c-k1", name: "Køl 1", note: null, kind: "temp_max", template_key: "fridge", group_key: "temperatures",
  limit: { limit_c: 5, direction: "max", source: "law" }, product_limits: null, schedule: { type: "daily", due: "08:00" },
  action_codes: ["other"], fate_codes: ["discarded"], status: "due", slot: { due_local: "08:00" }, last: null, open_deviation: null,
};
const ALI = { kind: "staff", id: "s-ali", label: "Ali K." };

beforeEach(() => {
  h.post.mockReset();
  h.patch.mockReset();
});

describe("the tick panel", () => {
  it("no keypad, no deviation rows, no photo; name → 'Gem · udført'; the body is done: true with the note", async () => {
    const onSave = vi.fn(async () => ({ ok: true, entry: { id: "e1" } }));
    render(<RecordPanel check={CLEANING} staff={[{ id: "s-ali", name: "Ali K.", on_shift: true }]} heldWho={null} onSave={onSave} t={t} lang="da" businessDate="2026-11-12" />);
    const panel = screen.getByTestId("ek-record-panel");
    expect(within(panel).queryByTestId("ek-keypad")).toBeNull();
    expect(within(panel).queryByTestId("ek-action-row")).toBeNull();
    expect(within(panel).queryByTestId("ek-photo-step")).toBeNull();
    expect(within(panel).getByTestId("ek-save")).toHaveTextContent(da.ekCtaChooseName);
    fireEvent.change(within(panel).getByTestId("ek-tick-note"), { target: { value: "Gulv <b>& vægge</b>" } });
    fireEvent.click(within(panel).getByRole("button", { name: /Ali K\./ }));
    const cta = within(panel).getByTestId("ek-save");
    expect(cta).toHaveTextContent(da.ekCtaSaveDone);
    await act(async () => { fireEvent.click(cta); });
    const [body, meta] = onSave.mock.calls[0];
    expect(body).toMatchObject({
      check_id: "c-clean", value_c: null, done: true, action_note: "Gulv <b>& vægge</b>", staff_id: "s-ali",
      client_business_date: "2026-11-12",
    });
    expect(body.action_code).toBeUndefined();
    expect(body.fate_code).toBeUndefined();
    expect(meta.photo).toBeNull();
  });

  it("ctaFor / buildEntryBody for a tick", () => {
    expect(ctaFor({ kind: "tick", who: null })).toMatchObject({ key: "ekCtaChooseName", disabled: true, step: "name" });
    expect(ctaFor({ kind: "tick", who: ALI })).toMatchObject({ key: "ekCtaSaveDone", disabled: false });
    const b = buildEntryBody({ clientId: "x", check: THERMO, note: "  ", who: { kind: "typed", name: " Mia " }, typedAt: "T", businessDate: "2026-11-12" });
    expect(b).toEqual({
      client_id: "x", check_id: "c-thermo", value_c: null, done: true, action_note: null, staff_id: null, typed_name: "Mia",
      client_typed_at: "T", client_business_date: "2026-11-12",
    });
  });
});

describe("the tick row", () => {
  it("'Ikke udført i dag', then 'Sidst udført … kl. …' — neutral, never red", () => {
    expect(statusLines(CLEANING, "da")).toEqual([["ekTickNotToday", null]]);
    const done = { ...CLEANING, last: { recorded_local: "07:45", recorded_local_date: "2026-11-12", done: true } };
    const [[k, vars]] = statusLines(done, "da");
    expect(t(k, vars)).toMatch(/^Sidst udført 12\. nov\.? kl\. 07:45$/);
    render(<CheckList checks={[FRIDGE, CLEANING, THERMO]} t={t} lang="da" />);
    const row = screen.getByTestId("ek-row-c-clean");
    expect(row).toHaveTextContent(da.ekTickNotToday);
    const pill = within(row).getByText(da.ekTickNotToday);
    expect(pill.className).not.toMatch(/red/);
  });

  it("groups: Temperaturer, then Rengøring, then Andet", () => {
    expect(groupChecks([THERMO, CLEANING, FRIDGE]).map((g) => g.key)).toEqual(["temperatures", "cleaning", "other"]);
    render(<CheckList checks={[THERMO, CLEANING, FRIDGE]} t={t} lang="da" />);
    const headers = screen.getAllByRole("heading", { level: 2 }).map((x) => x.textContent);
    expect(headers).toEqual([da.ekGroupTemperatures, da.ekGroupCleaning, da.ekGroupOther]);
  });
});

describe("the start list offers the ticks unticked", () => {
  const TEMPLATES = [
    { key: "fridge", kind: "temp_max", limit: { limit_c: 5, direction: "max", source: "law" }, schedule_default: { type: "daily", due: "08:00" } },
    { key: "cleaning", kind: "tick", limit: null, product_limits: null, schedule_default: { type: "on_event" }, schedule_options: ["on_event"] },
    { key: "thermometer", kind: "tick", limit: null, product_limits: null, schedule_default: { type: "on_event" }, schedule_options: ["on_event"] },
  ];
  it("shown, not chosen; ticking one adds it to the setup POST", async () => {
    h.post.mockResolvedValue({ data: { checks: [] } });
    render(<SetupFromStartList templates={TEMPLATES} onCreated={vi.fn()} t={t} lang="da" />);
    const clean = screen.getByRole("checkbox", { name: new RegExp(da.ekTemplateCleaning) });
    const thermo = screen.getByRole("checkbox", { name: new RegExp(da.ekTemplateThermometer) });
    expect(clean).not.toBeChecked();
    expect(thermo).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Tilføj 1 kontrolpunkter" })).toBeInTheDocument();
    fireEvent.click(clean);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Tilføj 2 kontrolpunkter" })); });
    const body = h.post.mock.calls[0][1];
    expect(body.items).toEqual([
      expect.objectContaining({ template_key: "fridge" }),
      { template_key: "cleaning", name: da.ekTemplateCleaning },
    ]);
  });
});

describe("the check editor for a tick", () => {
  it("no limit, no schedule, no re-check — name and note only", () => {
    render(
      <CheckEditorSheet check={{ ...CLEANING, schedule: { type: "on_event" } }} templates={[]} onSaved={vi.fn()} onClose={vi.fn()} t={t} lang="da" />,
    );
    const ed = screen.getByTestId("ek-editor");
    expect(within(ed).queryByLabelText(da.ekFieldLimit)).toBeNull();
    expect(within(ed).queryByText(da.ekFieldSchedule)).toBeNull();
    expect(within(ed).getByText(da.ekTickEditorNote)).toBeInTheDocument();
    expect(within(ed).getByLabelText(da.ekFieldName)).toHaveValue("Rengøring");
  });
});
