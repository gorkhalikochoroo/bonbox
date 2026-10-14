/**
 * Månedsafslutning — the period checklist and the revisor package.
 *
 *  • every open item from the server is listed with a link to its fix;
 *  • "Send pakken" with open items asks first (the mail lists them) and
 *    posts the period with a one-tap key;
 *  • without the plan that sends, the download stays and the send is an
 *    upgrade nudge; with no revisor saved, it says where to save one;
 *  • the schedule card (Settings) saves Aldrig / Hver uge / Hver måned and
 *    says plainly what would stop the next package.
 * Strings are asserted by key (t echoes the key).
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => get(...a), post: (...a) => post(...a), put: (...a) => put(...a),
    patch: vi.fn(), delete: vi.fn(),
  },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", currency: "DKK", business_type: "cafe" } }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fallbackOrVars, maybeVars) => {
      const vars = typeof fallbackOrVars === "object" ? fallbackOrVars : maybeVars;
      return vars ? `${k}:${Object.values(vars).join("|")}` : k;
    },
    lang: "da",
  }),
}));
let entitled = true;
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => entitled, isReady: true, minPlanForFeature: () => "starter" }),
}));
const confirmFn = vi.fn(async () => true);
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => confirmFn }));

const MonthEndPage = (await import("../pages/MonthEndPage")).default;
const RevisorPackageSchedule = (await import("../components/RevisorPackageSchedule")).default;

const CHECKLIST = (overrides = {}) => ({
  period: { start: "2026-09-01", end: "2026-09-30", kind: "month", label: "september 2026" },
  open_count: 3,
  checked_until: "2026-09-30",
  items: [
    { key: "closes_missing", count: 2, applicable: true, open_days_configured: false,
      rows: [{ date: "2026-09-03" }, { date: "2026-09-17" }], link: "/daily-close?date=2026-09-03" },
    { key: "closes_unlocked", count: 0, applicable: true, rows: [], link: "/daily-close" },
    { key: "bilag_missing", count: 1, applicable: true, amount: 300,
      rows: [{ id: "e1", date: "2026-09-08", description: "Hørkram", amount: 300 }],
      link: "/expenses?bilag=missing&from=2026-09-01&to=2026-09-30" },
    { key: "drafts_pending", count: 0, applicable: true, rows: [], link: "/expenses" },
    { key: "cash_differences", count: 1, applicable: true, threshold: 100,
      rows: [{ date: "2026-09-04", difference: -150 }], link: "/daily-close?date=2026-09-04" },
    { key: "bank_unmatched", count: 0, applicable: false, rows: [], link: "/imports?tab=bank" },
    { key: "gavekort_checks", count: 0, applicable: true, rows: [], link: "/tax" },
  ],
  send: { entitled: true, blocker: null, revisor_email: "pia@revisorhuset.dk" },
  last_sends: [],
  ...overrides,
});

const renderPage = () => render(<MemoryRouter><MonthEndPage /></MemoryRouter>);

beforeEach(() => {
  entitled = true;
  get.mockReset(); post.mockReset(); put.mockReset(); confirmFn.mockClear();
  get.mockImplementation((url) => {
    if (url === "/revisor-package/checklist") return Promise.resolve({ data: CHECKLIST() });
    return Promise.resolve({ data: {} });
  });
  post.mockResolvedValue({ data: { ok: true, sent_to: "pia@revisorhuset.dk", link_expires_at: "2026-10-26T08:00:00" } });
});

describe("Månedsafslutning", () => {
  it("lists every open item with a link to the screen that fixes it", async () => {
    renderPage();
    expect(await screen.findByTestId("me-open-count")).toHaveTextContent("meOpenCount:3");
    const missing = screen.getByTestId("me-item-closes_missing");
    expect(within(missing).getByText("meFix").closest("a")).toHaveAttribute("href", "/daily-close?date=2026-09-03");
    const bilag = screen.getByTestId("me-item-bilag_missing");
    expect(within(bilag).getByText("meFix").closest("a"))
      .toHaveAttribute("href", "/expenses?bilag=missing&from=2026-09-01&to=2026-09-30");
    expect(within(bilag).getByText(/Hørkram/)).toBeInTheDocument();
    // Not in use → not listed as a problem.
    expect(screen.queryByTestId("me-item-bank_unmatched")).toBeNull();
    // Closed weekdays hint: no opening days saved.
    expect(within(missing).getByText(/meHintOpenDays/)).toBeInTheDocument();
  });

  it("an all-clear never says more than was checked", async () => {
    const clear = (over) => CHECKLIST({
      open_count: 0,
      items: CHECKLIST().items.map((i) => ({ ...i, count: 0, rows: [] })),
      ...over,
    });
    // Finished period, closes in use → "every day is closed and locked".
    get.mockImplementation(() => Promise.resolve({ data: clear() }));
    const a = renderPage();
    expect(await screen.findByText("meAllClear")).toBeInTheDocument();
    expect(screen.getByTestId("me-checked-until")).toHaveTextContent(/^meCheckedUntil:/);
    a.unmount();
    // Running period → "so far", and it says the period isn't over.
    get.mockImplementation(() => Promise.resolve({ data: clear({
      period: { start: "2026-10-01", end: "2026-10-31", kind: "month", label: "oktober 2026" },
      checked_until: "2026-10-11",
    }) }));
    const b = renderPage();
    expect(await screen.findByText("meAllClearSoFar")).toBeInTheDocument();
    expect(screen.getByTestId("me-checked-until")).toHaveTextContent(/^mePeriodNotOver:/);
    b.unmount();
    // No daily closes in BonBox → no claim about locked days at all.
    get.mockImplementation(() => Promise.resolve({ data: clear({
      items: CHECKLIST().items.map((i) => ({ ...i, count: 0, rows: [],
        applicable: i.key.startsWith("closes") || i.key === "cash_differences" ? false : i.applicable })),
    }) }));
    renderPage();
    expect(await screen.findByText("meAllClearNoCloses")).toBeInTheDocument();
    expect(screen.queryByText("meAllClear")).toBeNull();
  });

  it("sends after a confirmation that names the open items, with a one-tap key", async () => {
    renderPage();
    await screen.findByTestId("me-open-count");
    fireEvent.click(screen.getByText("meSend"));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(confirmFn).toHaveBeenCalledWith(expect.objectContaining({ message: "meSendOpenWarn:3" }));
    const [url, body] = post.mock.calls[0];
    expect(url).toBe("/revisor-package/send");
    expect(body).toMatchObject({ start: expect.any(String), end: expect.any(String) });
    expect(body.key).toMatch(/^me-/);
    expect(await screen.findByText(/meSent:pia@revisorhuset.dk/)).toBeInTheDocument();
  });

  it("a refused send says why in the owner's language", async () => {
    post.mockRejectedValue({ response: { status: 403, data: { detail: {
      code: "email_unverified", message: "Not sent", message_da: "Ikke sendt til revisoren — bekræft din e-mail først",
    } } } });
    renderPage();
    await screen.findByTestId("me-open-count");
    fireEvent.click(screen.getByText("meSend"));
    expect(await screen.findByText(/bekræft din e-mail først/)).toBeInTheDocument();
  });

  it("without the plan that sends: download stays, send becomes an upgrade nudge", async () => {
    entitled = false;
    get.mockImplementation(() => Promise.resolve({ data: CHECKLIST({ send: { entitled: false, blocker: "plan", revisor_email: "pia@revisorhuset.dk" } }) }));
    renderPage();
    await screen.findByTestId("me-open-count");
    expect(screen.getByText("meDownloadZip")).toBeInTheDocument();
    expect(screen.queryByText("meSend")).toBeNull();
    expect(screen.getByText(/meSendLocked/)).toBeInTheDocument();
  });

  it("says before the tap that an unconfirmed e-mail stops the mail", async () => {
    get.mockImplementation(() => Promise.resolve({ data: CHECKLIST({ send: { entitled: true, blocker: "email_unverified", revisor_email: "pia@revisorhuset.dk" } }) }));
    renderPage();
    expect(await screen.findByTestId("me-send-blocker")).toHaveTextContent("rpsBlocked_email_unverified");
    // The download is never held back.
    expect(screen.getByText("meDownloadZip")).toBeInTheDocument();
  });

  it("with no revisor saved it points to where it is saved", async () => {
    get.mockImplementation(() => Promise.resolve({ data: CHECKLIST({ send: { entitled: true, blocker: "no_revisor", revisor_email: null } }) }));
    renderPage();
    await screen.findByTestId("me-open-count");
    expect(screen.queryByText("meSend")).toBeNull();
    expect(screen.getByText(/meNoRevisor/)).toBeInTheDocument();
  });

  it("downloads the ZIP for the period", async () => {
    const blob = new Blob(["PK"], { type: "application/zip" });
    get.mockImplementation((url) => {
      if (url === "/revisor-package/download") {
        return Promise.resolve({ data: blob, headers: { "content-disposition": "attachment; filename*=UTF-8''Revisorpakke_X_2026-09.zip" } });
      }
      return Promise.resolve({ data: CHECKLIST() });
    });
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    renderPage();
    await screen.findByTestId("me-open-count");
    fireEvent.click(screen.getByText("meDownloadZip"));
    await waitFor(() => expect(get.mock.calls.some(([u]) => u === "/revisor-package/download")).toBe(true));
    const [, opts] = get.mock.calls.find(([u]) => u === "/revisor-package/download");
    expect(opts.responseType).toBe("blob");
    expect(opts.params.start <= opts.params.end).toBe(true);
    // Never retried behind the owner's back (each retry is a full build).
    expect(opts._noRetry).toBe(true);
  });

  it("the daily cap on this page promises nothing queued", async () => {
    get.mockImplementation(() => Promise.resolve({ data: CHECKLIST({ send: { entitled: true, blocker: "daily_cap", revisor_email: "pia@revisorhuset.dk" } }) }));
    renderPage();
    expect(await screen.findByTestId("me-send-blocker")).toHaveTextContent("meBlocked_daily_cap");
    expect(screen.queryByText("rpsBlocked_daily_cap")).toBeNull();
  });

  it("after an unclear send outcome the next tap is a new send, not a replay", async () => {
    post.mockRejectedValueOnce({ response: { status: 502, data: { detail: {
      code: "email_unclear", message: "Couldn't confirm", message_da: "Spørg revisoren, før du sender igen",
    } } } });
    renderPage();
    await screen.findByTestId("me-open-count");
    fireEvent.click(screen.getByText("meSend"));
    expect(await screen.findByText(/Spørg revisoren/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("meSend"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[0][1].key).not.toBe(post.mock.calls[1][1].key);
  });

  it("names the local date the link works through", async () => {
    post.mockResolvedValueOnce({ data: { ok: true, sent_to: "pia@revisorhuset.dk",
      link_expires_at: "2026-10-27T03:59:59", link_expires_on: "2026-10-26" } });
    renderPage();
    await screen.findByTestId("me-open-count");
    fireEvent.click(screen.getByText("meSend"));
    expect(await screen.findByText(/meSent:pia@revisorhuset.dk\|.*26/)).toBeInTheDocument();
  });
});

describe("Månedsafslutning — after the package went (12 Oct review M7, minor 8)", () => {
  const SENT = (o = {}) => CHECKLIST({
    sent_package: { sent_on: "2026-10-03", recipient: "pia@revisorhuset.dk", trigger: "manual",
      status: "sent", changed: false, changes: [] },
    ...o,
  });

  it("a period that changed after it was sent says so and offers the corrected package", async () => {
    get.mockImplementation(() => Promise.resolve({ data: SENT({
      sent_package: { sent_on: "2026-10-03", recipient: "pia@revisorhuset.dk", trigger: "manual", status: "sent",
        changed: true, changes: [{ key: "moms_af_kob", before: 40.2, after: 290.2 }] },
    }) }));
    renderPage();
    expect(await screen.findByTestId("me-changed-after-send")).toHaveTextContent("meChangedAfterSend");
    expect(screen.getByTestId("me-sent-package")).toHaveTextContent(/meFigInputVat/);
    fireEvent.click(screen.getByText("meSendCorrected"));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(confirmFn).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/^meResendCorrectedMsg/) }));
    expect(post.mock.calls[0][1]).toMatchObject({ resend: true, key: expect.stringMatching(/^me-/) });
  });

  it("a changed category row or day is named, never shown as its raw key (14 Oct review)", async () => {
    get.mockImplementation(() => Promise.resolve({ data: SENT({
      sent_package: { sent_on: "2026-11-03", recipient: "pia@revisorhuset.dk", trigger: "manual", status: "sent",
        changed: true, changes: [
          { key: "category_vat:Kontorartikler", kind: "category_vat", name: "Kontorartikler", before: 266.67, after: 933.34 },
          { key: "category_gross:Varekøb", kind: "category_gross", name: "Varekøb", before: 9000, after: 5666.67 },
          { key: "day_revenue:2026-10-09", kind: "day_revenue", name: "2026-10-09", before: 5000, after: 0 },
        ] },
    }) }));
    renderPage();
    const box = await screen.findByTestId("me-sent-package");
    expect(box).toHaveTextContent(/meFigInputVat — Kontorartikler/);
    expect(box).toHaveTextContent(/meFigExpenses — Varekøb/);
    expect(box).toHaveTextContent(/meFigRevenue/);
    expect(box.textContent).not.toMatch(/category_vat:|category_gross:|day_revenue:/);
  });

  it("re-sending an unchanged period asks first, and a 'no' sends nothing", async () => {
    get.mockImplementation(() => Promise.resolve({ data: SENT() }));
    confirmFn.mockImplementationOnce(async () => false);
    renderPage();
    fireEvent.click(await screen.findByText("meSendAgain"));
    await waitFor(() => expect(confirmFn).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/^meResendMsg/) })));
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryByTestId("me-changed-after-send")).toBeNull();
  });

  it("a package sent while the period ran is named so, and a new send still asks first", async () => {
    get.mockImplementation(() => Promise.resolve({ data: SENT({
      sent_package: { sent_on: "2026-10-20", recipient: "pia@revisorhuset.dk", trigger: "manual",
        status: "sent", partial: true, changed: false, changes: [] },
    }) }));
    renderPage();
    expect(await screen.findByTestId("me-sent-package")).toHaveTextContent(/^meSentPartial/);
    fireEvent.click(screen.getByText("meSendAgain"));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(confirmFn).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/^meResendPartialMsg/) }));
    expect(post.mock.calls[0][1]).toMatchObject({ resend: true });
  });

  it("lists receipts BonBox can't fetch and close/till variances as open items", async () => {
    const items = [...CHECKLIST().items,
      { key: "bilag_unreadable", count: 1, applicable: true,
        rows: [{ id: "e9", date: "2026-09-10", description: "Videresendt", amount: 250 }], link: "/expenses" },
      { key: "sales_variance", count: 1, applicable: true,
        rows: [{ date: "2026-09-07", close_revenue: 5000, sale_sum: 300, delta: 4700, delta_pct: 94, direction: "close_high" }],
        link: "/daily-close?date=2026-09-07" }];
    get.mockImplementation(() => Promise.resolve({ data: CHECKLIST({ items, open_count: 5 }) }));
    renderPage();
    expect(await screen.findByTestId("me-item-bilag_unreadable")).toHaveTextContent("meItemBilagUnreadable");
    expect(screen.getByTestId("me-item-sales_variance")).toHaveTextContent(/meVarianceRow/);
  });
});

describe("Settings → Send revisorpakke", () => {
  const SETTINGS = (o = {}) => ({
    schedule: "never", entitled: true, revisor_email: "pia@revisorhuset.dk",
    next: null, blocker: null, last_sends: [], ...o,
  });

  it("saves the schedule and shows the next package", async () => {
    get.mockResolvedValue({ data: SETTINGS() });
    put.mockResolvedValue({ data: SETTINGS({
      schedule: "monthly",
      next: { kind: "month", start: "2026-10-01", end: "2026-10-31", label: "oktober 2026", due_at: "2026-11-03T06:00:00Z" },
    }) });
    render(<MemoryRouter><RevisorPackageSchedule /></MemoryRouter>);
    fireEvent.click(await screen.findByDisplayValue("monthly"));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/revisor-package/settings", { schedule: "monthly" }));
    expect(await screen.findByTestId("rps-next")).toHaveTextContent("oktober 2026");
  });

  it("warns when the owner's e-mail is unconfirmed — nothing would be sent", async () => {
    get.mockResolvedValue({ data: SETTINGS({ schedule: "weekly", blocker: "email_unverified",
      next: { kind: "week", start: "2026-10-12", end: "2026-10-18", label: "uge 42", due_at: "2026-10-19T05:00:00Z" } }) });
    render(<MemoryRouter><RevisorPackageSchedule /></MemoryRouter>);
    expect(await screen.findByTestId("rps-blocker")).toHaveTextContent("rpsBlocked_email_unverified");
    expect(screen.queryByTestId("rps-next")).toBeNull();
  });

  it("saves a missing revisor e-mail on the business profile", async () => {
    get.mockResolvedValue({ data: SETTINGS({ revisor_email: null }) });
    put.mockResolvedValue({ data: {} });
    render(<MemoryRouter><RevisorPackageSchedule /></MemoryRouter>);
    const input = await screen.findByLabelText("rpsRevisorEmail");
    fireEvent.change(input, { target: { value: "pia@revisorhuset.dk" } });
    fireEvent.click(screen.getByText("rpsSaveEmail"));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/business", { accountant_email: "pia@revisorhuset.dk" }));
  });

  it("a send that may have arrived is 'not confirmed', never plain 'failed'", async () => {
    get.mockResolvedValue({ data: SETTINGS({ schedule: "monthly", last_sends: [
      { id: "a", label: "oktober 2026", trigger: "scheduled", status: "failed", error: "mail_unclear:send_error: ReadTimeout" },
      { id: "b", label: "september 2026", trigger: "manual", status: "failed", error: "mail:send_error: RateLimitError" },
    ] }) });
    render(<MemoryRouter><RevisorPackageSchedule /></MemoryRouter>);
    expect(await screen.findByText(/rpsStatus_unclear/)).toBeInTheDocument();
    expect(screen.getByText(/rpsStatus_failed/)).toBeInTheDocument();
  });

  it("shows when the job really sends it, in the business's own time zone", async () => {
    get.mockResolvedValue({ data: SETTINGS({ schedule: "monthly",
      next: { kind: "month", start: "2026-10-01", end: "2026-10-31", label: "oktober 2026",
        due_at: "2026-11-03T06:00:00Z", run_at: "2026-11-03T06:20:00Z", tz: "Europe/Copenhagen" } }) });
    render(<MemoryRouter><RevisorPackageSchedule /></MemoryRouter>);
    // 06:20 UTC = 07:20 in Copenhagen, whatever the browser's own zone.
    expect(await screen.findByTestId("rps-next")).toHaveTextContent(/07[.:]20/);
  });

  it("on a plan that doesn't send it is an upgrade nudge, not a dead switch", async () => {
    get.mockResolvedValue({ data: SETTINGS({ entitled: false }) });
    render(<MemoryRouter><RevisorPackageSchedule /></MemoryRouter>);
    expect(await screen.findByText(/rpsLockedBenefit/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("monthly")).toBeNull();
  });
});
