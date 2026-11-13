/**
 * Egenkontrol R1b — "Ret" (owner only, readings ≤ 14 days old). Acceptance:
 * a corrected deviation stays under "Afvigelser" with its reason.
 *   • a deviation whose typo was corrected to an in-limit value is still
 *     listed: "Rettet: Tastefejl · 71,0 °C → 7,1 °C · …" and "Rettet — ikke
 *     en afvigelse"; the Rettelser section lists before → after and why;
 *   • "Ret" shows only for the owner and only while correctable_until lies
 *     ahead; it corrects the chain's LIVE tail;
 *   • the sheet: the original stays on screen, Tastefejl → a new value on the
 *     keypad, POST /egenkontrol/corrections; one client_id across retries;
 *     "Andet" needs a typed reason; "Forkert kontrolpunkt" offers checks of
 *     the same kind only.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.correction
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

const h = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: (...a) => h.post(...a), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { baseURL: "x" } },
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  return { useLanguage: () => ({ lang: "da", setLang: () => {}, t: (k) => DA[k] ?? k }) };
});

const FolderView = (await import("../components/egenkontrol/FolderView")).default;
const CorrectionSheet = (await import("../components/egenkontrol/CorrectionSheet")).default;

const t = (k, vars) => {
  let s = da[k] ?? k;
  if (vars && typeof vars === "object") s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};
const FUTURE = "2099-01-01T00:00:00Z";
const PAST = "2020-01-01T00:00:00Z";
const HEAD = {
  id: "e-1", check_id: "c-k1", check_name: "Køl 1", value_c: 71, limit_c: 5, limit_direction: "max", in_limit: false,
  recorded_local_date: "2026-11-10", recorded_local: "08:05", action_code: "thermostat_adjusted", fate_code: "moved",
  staff_name: "Ali K.", name_source: "picked", via: "kitchen", voided_at: "2026-11-11T09:00:00Z", void_reason: "correction",
  correctable_until: null, deviation_state: "closed",
};
const TAIL = {
  ...HEAD, id: "e-2", value_c: 7.1, in_limit: false, supersedes_id: "e-1", correction_reason: "typo", correction_text: null,
  created_local_date: "2026-11-11", created_local: "10:00", voided_at: null, void_reason: null, correctable_until: FUTURE,
};
const TAIL_IN = { ...TAIL, value_c: 3.1, in_limit: true, deviation_state: null, action_code: null, fate_code: null };
const FOLDER = (devs, extra = {}) => ({
  from: "2026-10-14", to: "2026-11-12", title_counts: { readings: 1, deviations: 1, deviations_open: 0 },
  summary: { readings: 1, deviations: 1, corrections: 1 }, days: [{ date: "2026-11-10", state: "deviation" }],
  deviations: devs, late: [], missed: [], undone: [], ...extra,
});
const FRIDGE = {
  id: "c-k1", name: "Køl 1", kind: "temp_max", template_key: "fridge", active: true, limit: { limit_c: 5, direction: "max" },
  action_codes: ["thermostat_adjusted", "other"], fate_codes: ["moved", "discarded", "other"],
};
const FRIDGE2 = { ...FRIDGE, id: "c-k2", name: "Køl 2" };
const HOT = { ...FRIDGE, id: "c-hot", name: "Varmholdelse", kind: "temp_min", limit: { limit_c: 56, direction: "min" } };

beforeEach(() => {
  h.post.mockReset();
});

describe("a corrected deviation stays under Afvigelser", () => {
  it("typo 71 → 3,1 (in limit): still listed, with its reason and 'Rettet — ikke en afvigelse'", () => {
    const folder = FOLDER([{ ...HEAD, chain: [HEAD, TAIL_IN], state: "corrected", followups: [] }], {
      corrections: [{
        original: HEAD, corrected: TAIL_IN, reason_code: "typo", reason_text: null, corrected_local_date: "2026-11-11",
        corrected_local: "10:00", check_changed: false, original_check_name: "Køl 1", check_name: "Køl 1",
      }],
    });
    render(<FolderView folder={folder} t={t} lang="da" />);
    const devs = screen.getByTestId("ek-folder-deviations");
    const item = within(devs).getByTestId("ek-folder-deviation");
    expect(item).toHaveTextContent("71,0 °C");
    expect(within(item).getByTestId("ek-corrected-line")).toHaveTextContent(/^Rettet: Tastefejl · 71,0 °C → 3,1 °C · 11\.? [Nn]ov\.? 26 kl\. 10:00$/);
    expect(item).toHaveTextContent(da.ekCorrectedNotDeviation);
    // The day strip still says deviation (the server's state; a correction never cleans it).
    expect(screen.getByTestId("ek-folder-strip")).toHaveTextContent(da.ekDayDeviation);
    const corr = screen.getByTestId("ek-folder-corrections");
    expect(corr).toHaveTextContent("71,0 °C → 3,1 °C · Tastefejl");
    expect(corr).toHaveTextContent(/Rettet 11\.? [Nn]ov\.? 26 · 10:00/);
  });

  it("a three-row chain is listed ONCE with two 'Rettet:' lines", () => {
    const third = { ...TAIL_IN, id: "e-3", supersedes_id: "e-2", correction_reason: "other", correction_text: "Målt <b>igen</b>", value_c: 4 };
    render(<FolderView folder={FOLDER([{ ...HEAD, chain: [HEAD, { ...TAIL, voided_at: "x" }, third], state: "corrected" }])} t={t} lang="da" />);
    expect(screen.getAllByTestId("ek-folder-deviation")).toHaveLength(1);
    const lines = screen.getAllByTestId("ek-corrected-line").map((x) => x.textContent);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Andet: Målt <b>igen</b>"); // typed text, verbatim
  });
});

describe("'Ret' — owner only, while correctable", () => {
  it("owner + correctable_until ahead → 'Ret' corrects the LIVE tail", () => {
    const onCorrect = vi.fn();
    render(<FolderView folder={FOLDER([{ ...HEAD, chain: [HEAD, TAIL], state: "closed" }])} t={t} lang="da" permissions={{ canCorrect: true }} handlers={{ onCorrect }} />);
    fireEvent.click(screen.getByTestId("ek-ret"));
    expect(onCorrect.mock.calls[0][0]).toMatchObject({ id: "e-2" });
  });
  it("past the 14 days → no 'Ret'", () => {
    render(<FolderView folder={FOLDER([{ ...HEAD, chain: [HEAD, { ...TAIL, correctable_until: PAST }], state: "closed" }])} t={t} lang="da" permissions={{ canCorrect: true }} handlers={{ onCorrect: vi.fn() }} />);
    expect(screen.queryByTestId("ek-ret")).toBeNull();
  });
  it("a manager (no permission) → no 'Ret'", () => {
    render(<FolderView folder={FOLDER([{ ...HEAD, chain: [HEAD, TAIL], state: "closed" }])} t={t} lang="da" permissions={{ canCorrect: false }} handlers={{ onCorrect: vi.fn() }} />);
    expect(screen.queryByTestId("ek-ret")).toBeNull();
  });
});

describe("the correction sheet", () => {
  const LIVE = { ...HEAD, id: "e-9", voided_at: null, void_reason: null, correctable_until: FUTURE, value_c: 71 };

  it("Tastefejl → the new value → POST /egenkontrol/corrections; a retry keeps the client_id", async () => {
    h.post.mockRejectedValueOnce({ response: { status: 503 } }).mockResolvedValueOnce({ data: { entry: {}, corrected: {} } });
    const onSaved = vi.fn();
    render(<CorrectionSheet entry={LIVE} checks={[FRIDGE, FRIDGE2, HOT]} onSaved={onSaved} onClose={vi.fn()} t={t} lang="da" />);
    const sheet = screen.getByTestId("ek-correction");
    expect(within(sheet).getByTestId("ek-correction-original")).toHaveTextContent("71,0 °C");
    expect(within(sheet).getByTestId("ek-correct-intro")).toHaveTextContent(da.ekCorrectIntro);
    const save = screen.getByTestId("ek-correct-save");
    expect(save).toBeDisabled();
    fireEvent.click(within(sheet).getByRole("button", { name: da.ekCorrectReasonTypo }));
    for (const k of ["7", ",", "1"]) fireEvent.click(within(sheet).getByRole("button", { name: k === "," ? da.ekKeyDecimal : k }));
    // 7,1 on a 5 °C fridge: still out of limit — the original's answers are kept (same check).
    expect(screen.getByTestId("ek-correct-preview")).toHaveTextContent("71,0 °C → 7,1 °C");
    expect(save).not.toBeDisabled();
    await act(async () => { fireEvent.click(save); });
    expect(screen.getByRole("alert")).toHaveTextContent(da.ekErrSaveFailed);
    await act(async () => { fireEvent.click(save); });
    expect(h.post).toHaveBeenCalledTimes(2);
    const [url, body] = h.post.mock.calls[0];
    expect(url).toBe("/egenkontrol/corrections");
    expect(body).toMatchObject({ entry_id: "e-9", reason_code: "typo", value_c: 7.1, reason_text: null });
    expect(body.check_id).toBeUndefined();
    expect(h.post.mock.calls[1][1].client_id).toBe(body.client_id);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("'Andet' needs a typed reason; 'Forkert kontrolpunkt' offers the same kind only", () => {
    render(<CorrectionSheet entry={LIVE} checks={[FRIDGE, FRIDGE2, HOT]} onSaved={vi.fn()} onClose={vi.fn()} t={t} lang="da" />);
    const sheet = screen.getByTestId("ek-correction");
    fireEvent.click(within(sheet).getByRole("button", { name: da.ekCorrectReasonWrongCheck }));
    const options = within(within(sheet).getByTestId("ek-correct-check")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Køl 1", "Køl 2"]);
    fireEvent.click(within(sheet).getByRole("button", { name: da.ekCorrectReasonOther }));
    for (const k of ["3"]) fireEvent.click(within(sheet).getByRole("button", { name: k }));
    expect(screen.getByTestId("ek-correct-save")).toBeDisabled();
    fireEvent.change(within(sheet).getByTestId("ek-correct-reason-text"), { target: { value: "Læst forkert" } });
    expect(screen.getByTestId("ek-correct-save")).not.toBeDisabled();
  });

  it("a server code is shown in words (correction_too_old)", async () => {
    h.post.mockRejectedValue({ response: { status: 422, data: { detail: { code: "correction_too_old", max_days: 14 } } } });
    render(<CorrectionSheet entry={LIVE} checks={[FRIDGE]} onSaved={vi.fn()} onClose={vi.fn()} t={t} lang="da" />);
    fireEvent.click(screen.getByRole("button", { name: da.ekCorrectReasonTypo }));
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    await act(async () => { fireEvent.click(screen.getByTestId("ek-correct-save")); });
    expect(screen.getByRole("alert")).toHaveTextContent(da.ekErrCorrectionTooOld);
  });
});
