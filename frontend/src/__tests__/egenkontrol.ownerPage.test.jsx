/**
 * Egenkontrol R1a — the owner's surfaces:
 *   • empty state = the start list ("Tilføj jeres første køleskab"), every
 *     limit with its source, one POST /egenkontrol/setup — never "Alt er
 *     klaret" / "100 %";
 *   • a member with 0 checks: "Ejeren har ikke sat egenkontrol op endnu.";
 *     a cashier has no Kontrolmappe tab; a manager has Kontrolmappe, no
 *     Opsætning; a curtained shared device gets the PIN pad, not the folder;
 *   • the PDF: "PDF klar" ONLY on saveFile's { ok: true }; { ok: false }
 *     (incl. no_download_manager) → "PDF'en kunne ikke hentes. Prøv igen.";
 *   • NeedsYouQueue renders egenkontrol_due (missing / deviation variants);
 *   • the sidebar badge counts missing + open deviations, nothing at 0;
 *   • the delete-account notice only when there are readings;
 *   • /privacy carries both retention rows (pinned by the backend too).
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.ownerPage
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { da } from "../i18n/da";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  toast: vi.fn(),
  saveFile: vi.fn(),
  user: { role: "owner", business_type: "cafe" },
  share: { enabled: false, locked: false, reveal: async () => {} },
}));

vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a),
    post: (...a) => h.post(...a),
    patch: (...a) => h.patch(...a),
    delete: (...a) => h.del(...a),
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
vi.mock("../hooks/useDeviceShare", () => ({ useDeviceShare: () => h.share }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../utils/download", () => ({ saveFile: (...a) => h.saveFile(...a) }));

const EgenkontrolPage = (await import("../pages/EgenkontrolPage")).default;
const NeedsYouQueue = (await import("../components/NeedsYouQueue")).default;
const EgenkontrolDeleteNotice = (await import("../components/egenkontrol/EgenkontrolDeleteNotice")).default;
const EgenkontrolNavBadge = (await import("../components/egenkontrol/EgenkontrolNavBadge")).default;
const { __resetEgenkontrolStatus } = await import("../components/egenkontrol/useEgenkontrolStatus");

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

const TEMPLATES = {
  cutoff_hour: 6,
  timezone: "Europe/Copenhagen",
  templates: [
    { key: "fridge", kind: "temp_max", group_key: "temperatures", limit: { limit_c: 5, direction: "max", source: "law", ref: "BEK nr. 1331 af 20/11/2025, bilag 3 A" }, product_limits: null, schedule_default: { type: "daily", due: "08:00" }, schedule_options: ["daily", "weekly", "on_event"], action_codes: [], fate_codes: [], recheck_min: 30 },
    { key: "freezer", kind: "temp_max", group_key: "temperatures", limit: { limit_c: -18, direction: "max", source: "fvst_example", ref: null }, product_limits: null, schedule_default: { type: "daily", due: "08:00" }, schedule_options: ["daily", "weekly", "on_event"], action_codes: [], fate_codes: [], recheck_min: 30 },
    { key: "hot_holding", kind: "temp_min", group_key: "temperatures", limit: { limit_c: 56, direction: "min", source: "law", ref: "BEK nr. 1331 af 20/11/2025, § 29, stk. 3" }, product_limits: null, schedule_default: { type: "daily", due: "12:00" }, schedule_options: ["daily", "weekly", "on_event"], action_codes: [], fate_codes: [], recheck_min: 30 },
    { key: "reheating", kind: "temp_min", group_key: "reheating", limit: { limit_c: 75, direction: "min", source: "law", ref: "BEK nr. 1331 af 20/11/2025, § 26, stk. 3" }, product_limits: null, schedule_default: { type: "on_event" }, schedule_options: ["on_event"], action_codes: [], fate_codes: [], recheck_min: 30 },
    { key: "receiving", kind: "receiving", group_key: "receiving", limit: null, product_limits: [
      { product_type: "chilled", limit_c: 5, direction: "max", source: "law", ref: null },
      { product_type: "fish", limit_c: 2, direction: "max", source: "fvst_example", ref: null },
      { product_type: "frozen", limit_c: -18, direction: "max", source: "fvst_example", ref: null },
    ], schedule_default: { type: "on_event" }, schedule_options: ["on_event"], action_codes: [], fate_codes: [], recheck_min: 30 },
  ],
};
const EMPTY_TODAY = { business_date: "2026-11-12", cutoff_hour: 6, setup_done: false, checks: [], summary: { total: 0, done: 0, missing: 0, due: 0, open_deviations: 0 } };
const FOLDER = {
  from: "2026-10-14", to: "2026-11-12", venue_name: "Café Sol", branch_name: null,
  title_counts: { readings: 0, deviations: 0, deviations_open: 0 },
  summary: { readings: 0, slots_on_time: 0, slots_late: 0, slots_missed: 0, deviations: 0, deviations_open: 0, undone: 0, paper: 0, corrections: 0 },
  days: [], deviations: [], late: [], missed: [], undone: [], checks: [],
};

let routes = {};
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const renderPage = async (path = "/egenkontrol") => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <EgenkontrolPage />
    </MemoryRouter>,
  );
  await settle();
};
const noAllDone = () => {
  for (const bad of ["Alt er klaret", "100 %", "klar til Fødevarestyrelsen"]) expect(document.body.textContent).not.toContain(bad);
};

beforeEach(() => {
  for (const f of [h.get, h.post, h.patch, h.del, h.toast, h.saveFile]) f.mockReset();
  h.user = { role: "owner", business_type: "cafe" };
  h.share = { enabled: false, locked: false, reveal: async () => {} };
  routes = {
    "/egenkontrol/today": EMPTY_TODAY,
    "/egenkontrol/checks": { checks: [], archived: [] },
    "/egenkontrol/templates": TEMPLATES,
    "/egenkontrol/staff": { staff: [] },
    "/egenkontrol/folder": FOLDER,
    "/egenkontrol/devices": { devices: [] },
  };
  h.get.mockImplementation((url) => (url in routes ? Promise.resolve({ data: routes[url] }) : Promise.reject({ response: { status: 404 } })));
  __resetEgenkontrolStatus();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("empty state — the start list, never an 'all done'", () => {
  it("owner: 'Tilføj jeres første køleskab', five items with their sources, one setup POST", async () => {
    h.post.mockResolvedValue({ data: { checks: [] } });
    await renderPage();
    const setup = screen.getByTestId("ek-setup");
    expect(setup).toHaveTextContent(da.ekEmptyTitle);
    expect(setup).toHaveTextContent(da.ekEmptyBody);
    for (const name of ["Køl 1", "Frost 1", "Varmholdelse", "Genopvarmning", "Varemodtagelse"]) expect(setup).toHaveTextContent(name);
    expect(setup).toHaveTextContent(da.ekSourceLaw);
    expect(setup).toHaveTextContent(da.ekSourceExample);
    expect(setup).toHaveTextContent("5,0 °C eller koldere");
    expect(setup).toHaveTextContent("Mindst 56,0 °C");
    expect(setup).toHaveTextContent(da.ekSetupFrequencyQ);
    expect(setup).toHaveTextContent(da.ekSetupMissedNote);
    expect(screen.getByTestId("ek-responsibility")).toHaveTextContent(da.ekResponsibility);
    noAllDone();

    fireEvent.click(screen.getByRole("button", { name: /Køl mere/ }));
    fireEvent.click(screen.getByRole("button", { name: da.ekFreqWeekly }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Tilføj 6 kontrolpunkter" })); });
    expect(h.post).toHaveBeenCalledTimes(1);
    const [url, body] = h.post.mock.calls[0];
    expect(url).toBe("/egenkontrol/setup");
    expect(body.items.map((i) => i.name)).toEqual(["Køl 1", "Køl 2", "Frost 1", "Varmholdelse", "Genopvarmning", "Varemodtagelse"]);
    expect(body.items[0]).toMatchObject({ template_key: "fridge", schedule: { type: "weekly", weekday: 0, due: "08:00" } });
    expect(body.items[3]).toEqual({ template_key: "hot_holding", name: "Varmholdelse" });
    expect(body.items.find((i) => i.template_key === "receiving").schedule).toBeUndefined();
  });

  it("a member with no checks: the owner has not set it up — no start list, no folder/setup tabs", async () => {
    h.user = { role: "cashier" };
    await renderPage();
    expect(screen.getByTestId("ek-empty-member")).toHaveTextContent(da.ekEmptyMember);
    expect(screen.queryByTestId("ek-setup")).toBeNull();
    expect(screen.queryByRole("tab", { name: da.ekTabFolder })).toBeNull();
    expect(screen.queryByText(da.ekTabFolder)).toBeNull();
    expect(h.get.mock.calls.map((c) => c[0])).not.toContain("/egenkontrol/folder");
    noAllDone();
  });

  it("a manager sees Kontrolmappe but not Opsætning", async () => {
    h.user = { role: "manager" };
    await renderPage();
    expect(screen.getByRole("tab", { name: da.ekTabFolder })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: da.ekTabSetup })).toBeNull();
  });
});

describe("Kontrolmappe — the PDF toast follows the real outcome", () => {
  it("{ ok: false } (no download manager) → the failure toast, never 'PDF klar'", async () => {
    routes["/egenkontrol/folder.pdf"] = new Blob(["%PDF-1.4"], { type: "application/pdf" });
    h.saveFile.mockResolvedValue({ ok: false, reason: "no_download_manager" });
    await renderPage("/egenkontrol?tab=folder");
    expect(screen.getByTestId("ek-folder")).toHaveTextContent(da.ekFolderNoReadings);
    noAllDone();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.ekDownloadPdf })); });
    await settle();
    const pdfCall = h.get.mock.calls.find((c) => c[0] === "/egenkontrol/folder.pdf");
    expect(pdfCall[1]).toMatchObject({ params: { from: "2026-10-14", to: "2026-11-12" }, responseType: "blob" });
    expect(h.saveFile.mock.calls[0][1]).toBe("Kontrolmappe_2026-10-14_2026-11-12.pdf");
    expect(h.saveFile.mock.calls[0][2]).toMatchObject({ type: "application/pdf" });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ message: da.ekPdfFailed, severity: "critical" }));
    expect(h.toast).not.toHaveBeenCalledWith(expect.objectContaining({ message: da.ekPdfReady }));
  });

  it("{ ok: true } → 'PDF klar'", async () => {
    routes["/egenkontrol/folder.pdf"] = new Blob(["%PDF-1.4"], { type: "application/pdf" });
    h.saveFile.mockResolvedValue({ ok: true, channel: "download" });
    await renderPage("/egenkontrol?tab=folder");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.ekDownloadPdf })); });
    await settle();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ message: da.ekPdfReady, severity: "success" }));
  });

  it("a failed PDF request is a failure too (no saveFile, no success)", async () => {
    await renderPage("/egenkontrol?tab=folder");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.ekDownloadPdf })); });
    await settle();
    expect(h.saveFile).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ message: da.ekPdfFailed }));
  });

  it("a curtained shared device gets the PIN pad, and the folder is not fetched", async () => {
    h.share = { enabled: true, locked: true, reveal: async () => {} };
    await renderPage("/egenkontrol?tab=folder");
    expect(screen.queryByTestId("ek-folder")).toBeNull();
    expect(h.get.mock.calls.map((c) => c[0])).not.toContain("/egenkontrol/folder");
  });
});

describe("NeedsYouQueue — 'egenkontrol_due'", () => {
  const renderQueue = async (meta, severity = "warn") => {
    h.get.mockImplementation((url) =>
      url === "/diagnostics/needs-you"
        ? Promise.resolve({ data: { findings: [{ code: "egenkontrol_due", severity, deep_link: "/egenkontrol", meta: { date: "2026-11-12", ...meta } }] } })
        : Promise.reject(new Error("x")),
    );
    render(<MemoryRouter><NeedsYouQueue /></MemoryRouter>);
    await settle();
  };

  it("1 missing → '1 måling til egenkontrol mangler' + 'Åbn egenkontrol'", async () => {
    await renderQueue({ missing: 1, deviations: 0, count: 1 });
    expect(screen.getByText(da.nyqEkMissingOne)).toBeInTheDocument();
    expect(screen.getByText(da.nyqEkAction)).toBeInTheDocument();
  });
  it("3 missing → the plural", async () => {
    await renderQueue({ missing: 3, deviations: 0, count: 3 });
    expect(screen.getByText("3 målinger til egenkontrol mangler")).toBeInTheDocument();
  });
  it("an open deviation wins the title (urgent)", async () => {
    await renderQueue({ missing: 2, deviations: 2, count: 4 }, "urgent");
    expect(screen.getByText("2 afvigelser i egenkontrollen er ikke afsluttet")).toBeInTheDocument();
  });
});

describe("the sidebar badge", () => {
  it("counts missing readings + open deviations; nothing at 0", async () => {
    h.get.mockResolvedValue({ data: { missing_now: 2, open_deviations: 1, has_records: true, business_date: "2026-11-12" } });
    const { unmount } = render(<EgenkontrolNavBadge />);
    await settle();
    expect(screen.getByTestId("ek-nav-badge")).toHaveTextContent("3");
    expect(screen.getByTestId("ek-nav-badge")).toHaveAttribute("aria-label", "3 mangler");
    unmount();
    __resetEgenkontrolStatus();
    h.get.mockResolvedValue({ data: { missing_now: 0, open_deviations: 0 } });
    render(<EgenkontrolNavBadge />);
    await settle();
    expect(screen.queryByTestId("ek-nav-badge")).toBeNull();
  });
});

describe("the delete-account notice", () => {
  it("only when the account has readings", async () => {
    h.get.mockResolvedValue({ data: { has_records: false } });
    const { unmount } = render(<EgenkontrolDeleteNotice />);
    await settle();
    expect(screen.queryByTestId("ek-delete-notice")).toBeNull();
    unmount();
    h.get.mockResolvedValue({ data: { has_records: true, business_date: "2026-11-12" } });
    render(<EgenkontrolDeleteNotice />);
    await settle();
    const card = screen.getByTestId("ek-delete-notice");
    expect(card).toHaveTextContent(da.ekDeleteNotice);
    expect(within(card).getByRole("button", { name: da.ekDeleteDownload })).toBeInTheDocument();
  });
  it("renders nothing on an error", async () => {
    h.get.mockRejectedValue({ response: { status: 403 } });
    render(<EgenkontrolDeleteNotice />);
    await settle();
    expect(screen.queryByTestId("ek-delete-notice")).toBeNull();
  });
});

describe("/privacy says how long the readings are kept", () => {
  it("both retention rows are on the page (EN + DA)", () => {
    const src = readFileSync(join(SRC, "pages", "PrivacyPolicyPage.jsx"), "utf8");
    expect(src).toContain('["Food safety records (egenkontrol readings, with the name of whoever measured)", "2 years, then deleted automatically; deleted with your account"]');
    expect(src).toContain('["Egenkontrol-målinger (med navnet på den, der målte)", "2 år, derefter slettet automatisk; slettes med kontoen"]');
  });
});

// ── Review fixes (12 Nov): the record says what happened, and to whom ────

const FRIDGE_TODAY = {
  id: "c-k1", name: "Køl 1", note: null, kind: "temp_max", template_key: "fridge", group_key: "temperatures",
  branch_id: null, sort_order: 0, active: true, archived_at: null,
  limit: { limit_c: 5, direction: "max", source: "law", ref: null }, product_limits: null,
  schedule: { type: "daily", due: "08:00" }, schedule_options: ["daily", "weekly", "on_event"], recheck_min: 30,
  action_codes: ["thermostat_adjusted", "moved_goods", "other"], fate_codes: ["moved", "discarded", "assessed_ok", "awaiting_recheck", "other"],
  revision_id: "r1", valid_from: "2026-11-01T07:00:00Z",
  status: "due", slot: { due_at: "2026-11-12T07:00:00Z", due_local: "08:00" }, last: null, open_deviation: null,
};
const RECEIVING = {
  ...FRIDGE_TODAY, id: "c-rec", name: "Varemodtagelse", kind: "receiving", template_key: "receiving", group_key: "receiving",
  limit: null, schedule: { type: "on_event" }, status: "on_event", slot: null,
  product_limits: [
    { product_type: "chilled", limit_c: 5, direction: "max", source: "law", ref: null },
    { product_type: "fish", limit_c: 2, direction: "max", source: "fvst_example", ref: null },
    { product_type: "frozen", limit_c: -18, direction: "max", source: "fvst_example", ref: null },
  ],
};
const tDa = (k, vars) => {
  let s = da[k] ?? k;
  if (vars && typeof vars === "object") s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};
const ekLogic = await import("../components/egenkontrol/ekLogic");
const FolderView = (await import("../components/egenkontrol/FolderView")).default;
const CheckList = (await import("../components/egenkontrol/CheckList")).default;
const RECV_SOURCES = `${da.ekProductChilled}: ${da.ekSourceLaw} · ${da.ekProductFish}, ${da.ekProductFrozen}: ${da.ekSourceExample}`;

describe("every limit shows its source — receiving too", () => {
  it("receivingSourceLine groups the product types by source", () => {
    expect(ekLogic.receivingSourceLine(RECEIVING, tDa)).toBe(RECV_SOURCES);
    expect(ekLogic.receivingSourceLine({ product_limits: null }, tDa)).toBe("");
  });

  it("the 'I dag' list shows the receiving sources under the limits", () => {
    render(<CheckList checks={[FRIDGE_TODAY, RECEIVING]} t={tDa} lang="da" />);
    const row = screen.getByTestId("ek-row-c-rec");
    expect(row).toHaveTextContent("Kølevare ≤ 5,0 °C · Fisk ≤ 2,0 °C · Frost ≤ −18,0 °C");
    expect(within(row).getByTestId("ek-receiving-source")).toHaveTextContent(RECV_SOURCES);
    expect(screen.getByTestId("ek-row-c-k1")).toHaveTextContent(da.ekSourceLaw);
  });

  it("Opsætning shows them too", async () => {
    routes["/egenkontrol/checks"] = { checks: [FRIDGE_TODAY, RECEIVING], archived: [] };
    routes["/egenkontrol/today"] = { ...EMPTY_TODAY, checks: [FRIDGE_TODAY, RECEIVING] };
    await renderPage("/egenkontrol?tab=setup");
    expect(screen.getByTestId("ek-setup-receiving-source")).toHaveTextContent(RECV_SOURCES);
  });
});

describe("'For sent · registreret kl. …' names the reading that filled the slot", () => {
  it("uses slot_entry, not the newest reading of the day", () => {
    const check = {
      ...FRIDGE_TODAY, status: "done_late",
      last: { recorded_local: "14:00", slot_due_local: null },
      slot_entry: { recorded_local: "09:30", slot_due_local: "08:00" },
    };
    const [[k, vars]] = ekLogic.statusLines(check, "da");
    expect(tDa(k, vars)).toBe("For sent · registreret kl. 09:30 (frist kl. 08:00)");
  });
});

describe("the Kontrolmappe shows what finally happened to the food", () => {
  it("a follow-up's fate and note are on screen, typed text verbatim", () => {
    const folder = {
      ...FOLDER,
      title_counts: { readings: 2, deviations: 1, deviations_open: 0 },
      deviations: [{
        id: "d1", check_name: "Køl 1", recorded_local: "07:30", recorded_local_date: "2026-11-12", value_c: 7.1,
        limit_c: 5, limit_direction: "max", action_code: "thermostat_adjusted", fate_code: "awaiting_recheck",
        staff_name: "Mia", name_source: "typed", via: "owner_app", deviation_state: "closed",
        followups: [{
          id: "f1", value_c: 4, recorded_local: "08:00", fate_code: "other", fate_other: "<b>Givet</b> til {fate}",
          action_note: "FOLLOWUP-NOTE {note}", staff_name: "Bo", name_source: "typed", via: "owner_app",
        }],
      }],
    };
    render(<FolderView folder={folder} t={tDa} lang="da" />);
    const fu = screen.getByTestId("ek-folder-followup");
    expect(fu).toHaveTextContent("Opfølgning: 4,0 °C kl. 08:00 · Bo");
    expect(fu).toHaveTextContent(`${da.ekFolderFollowupFate} <b>Givet</b> til {fate}`);
    expect(fu).toHaveTextContent(`${da.ekFolderFollowupNote} FOLLOWUP-NOTE {note}`);
    expect(screen.getByTestId("ek-folder-deviations")).toHaveTextContent(da.ekFateAwaitingRecheck);
  });
});

describe("owner app — a 404 on a save is a name the server no longer has", () => {
  it("keeps the reading as 'Kræver handling', fetches the names again, no 'slået fra' toast", async () => {
    routes["/egenkontrol/today"] = { ...EMPTY_TODAY, setup_done: true, checks: [FRIDGE_TODAY], summary: { total: 1, done: 0, missing: 0, due: 1, open_deviations: 0 } };
    routes["/egenkontrol/checks"] = { checks: [FRIDGE_TODAY], archived: [] };
    routes["/egenkontrol/staff"] = { staff: [{ id: "s-ali", name: "Ali K.", on_shift: true }] };
    h.post.mockRejectedValueOnce({ response: { status: 404, data: { detail: { error: "not_found" } } } });
    await renderPage();
    fireEvent.click(within(screen.getByTestId("ek-row-c-k1")).getAllByRole("button")[0]);
    const panel = screen.getByTestId("ek-record-panel");
    for (const k of ["3", ",", "1"]) fireEvent.click(within(panel).getByRole("button", { name: k === "," ? da.ekKeyDecimal : k }));
    fireEvent.click(within(panel).getByRole("button", { name: /Ali K\./ }));
    await act(async () => { fireEvent.click(within(panel).getByTestId("ek-save")); });
    await settle();
    expect(within(screen.getByTestId("ek-row-c-k1")).getByTestId("ek-pending-needs-action")).toHaveTextContent(da.ekNeedsAction);
    expect(screen.getByTestId("ek-panel-error")).toHaveTextContent(da.ekErrStaffGone);
    expect(h.get.mock.calls.filter(([u]) => u === "/egenkontrol/staff")).toHaveLength(2);
    expect(h.toast).not.toHaveBeenCalledWith(expect.objectContaining({ message: da.ekErrCheckInactive }));
    expect(within(panel).getByTestId("ek-save")).toHaveTextContent(da.ekCtaChooseName);
  });
});

describe("Opsætning — an open deviation must be finished before switch-off", () => {
  it("archive answers 409 open_deviation → the editor says so", async () => {
    routes["/egenkontrol/checks"] = { checks: [FRIDGE_TODAY], archived: [] };
    routes["/egenkontrol/today"] = { ...EMPTY_TODAY, checks: [FRIDGE_TODAY] };
    h.post.mockRejectedValueOnce({ response: { status: 409, data: { detail: { code: "open_deviation" } } } });
    await renderPage("/egenkontrol?tab=setup");
    fireEvent.click(screen.getByRole("button", { name: da.ekEditCheck }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.ekArchive })); });
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(da.ekErrOpenDeviation);
  });
});

describe("the delete-account notice says what the PDF covers", () => {
  it("the last 30 days, and where the older readings are", async () => {
    const { en } = await import("../i18n/en");
    expect(da.ekDeleteNotice).toContain("seneste 30 dage");
    expect(da.ekDeleteDownload).toContain("30 dage");
    expect(da.ekDeleteNotice).toContain(da.exportAllData);
    expect(en.ekDeleteNotice).toContain("last 30 days");
    expect(en.ekDeleteDownload).toContain("30 days");
    expect(en.ekDeleteNotice).toContain(en.exportAllData);
  });
});
