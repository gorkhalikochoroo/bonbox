/**
 * Månedsafslutning — Push 8 gate walk (15 Oct 2026).
 *
 *  MAJOR  "Send pakken" spun for ~27 s: the server answers 503 when mail or
 *         storage is down, and the api.js interceptor replayed the POST four
 *         more times (2/4/8/12 s). A second tap then met the 5/minute limiter
 *         and the page showed axios's raw "Request failed with status code
 *         429". Now: one tap, one POST, the refusal at once; a 429 is said
 *         in the owner's words.
 *  MINOR  Send, ZIP and PDF stayed live when the page already said the
 *         server would refuse them (sample revisor; sample rows under the
 *         owner's own name), and the refusal stacked a second warning.
 *  MINOR  The checklist head's status line was shrink-0 on one line and ran
 *         off the card at 360 px.
 *
 * The page runs on the REAL api module; only its HTTP adapter is replaced,
 * so the interceptor that replayed the send is the one under test.
 * Strings are asserted by key (t echoes the key).
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError } from "axios";

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
  LanguageProvider: ({ children }) => children,
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, isReady: true, minPlanForFeature: () => "starter" }),
}));
const confirmFn = vi.fn(async () => true);
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => confirmFn }));

const api = (await import("../services/api")).default;
const MonthEndPage = (await import("../pages/MonthEndPage")).default;
const RevisorPackageSchedule = (await import("../components/RevisorPackageSchedule")).default;

const CHECKLIST = (send = {}) => ({
  period: { start: "2026-09-01", end: "2026-09-30", kind: "month", label: "september 2026" },
  open_count: 0,
  checked_until: "2026-09-30",
  items: [{ key: "bilag_missing", count: 0, applicable: true, amount: 0, rows: [], link: "/expenses" }],
  send: { entitled: true, blocker: null, revisor_email: "pia@revisorhuset.dk", ...send },
  last_sends: [],
});

const sent = [];
let checklist = CHECKLIST();
let sendReply = null;
let settings = null;
const origAdapter = api.defaults.adapter;

const ok = (config, data = {}) => ({ data, status: 200, statusText: "OK", headers: {}, config, request: {} });
const fail = (config, status, data) => {
  const response = { data, status, statusText: String(status), headers: {}, config, request: {} };
  throw new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_RESPONSE", config, {}, response);
};

beforeEach(() => {
  sent.length = 0;
  checklist = CHECKLIST();
  sendReply = null;
  settings = null;
  confirmFn.mockClear();
  localStorage.clear();
  api.defaults.adapter = async (config) => {
    const method = (config.method || "get").toUpperCase();
    sent.push({ method, url: config.url });
    if (config.url === "/revisor-package/checklist") return ok(config, checklist);
    if (config.url === "/revisor-package/settings" && settings) return ok(config, settings);
    if (method === "POST" && config.url === "/revisor-package/send") return sendReply(config);
    return ok(config, {});
  };
});
afterEach(() => {
  api.defaults.adapter = origAdapter;
  localStorage.clear();
});

const posts = () => sent.filter((s) => s.method === "POST" && s.url === "/revisor-package/send");
const renderPage = () => render(<MemoryRouter><MonthEndPage /></MemoryRouter>);
const button = (key) => screen.getByText(key).closest("button");

describe("Send pakken — one tap, one try", () => {
  it("a 503 (mail or storage down) is answered at once, with one POST", async () => {
    sendReply = (config) => fail(config, 503, { detail: {
      code: "email_send_failed", reason: "email_not_configured",
      message: "Couldn't send the package right now. You can still download it.",
      message_da: "Pakken kunne ikke sendes lige nu. Du kan stadig hente den.",
    } });
    renderPage();
    await screen.findByTestId("me-checked-until");
    const t0 = Date.now();
    fireEvent.click(button("meSend"));
    // The first automatic retry would wait 2 s; the refusal must show before it.
    await screen.findByText("Pakken kunne ikke sendes lige nu. Du kan stadig hente den.", {}, { timeout: 1500 });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(posts()).toHaveLength(1);
  }, 10000);

  it("the limiter's 429 is said in the owner's words, never axios's English", async () => {
    sendReply = (config) => fail(config, 429, { error: "Rate limit exceeded: 5 per 1 minute" });
    renderPage();
    await screen.findByTestId("me-checked-until");
    fireEvent.click(button("meSend"));
    expect(await screen.findByText("meSendTooMany")).toBeInTheDocument();
    expect(screen.queryByText(/Request failed with status code/)).toBeNull();
    expect(posts()).toHaveLength(1);
  });
});

describe("what the page already knows the server will refuse is not offered", () => {
  it("a sample revisor: Send is off and named; the download stays", async () => {
    checklist = CHECKLIST({ blocker: "demo_recipient" });
    renderPage();
    expect(await screen.findByTestId("me-send-blocker")).toHaveTextContent("rpsBlocked_demo_recipient");
    expect(button("meSend")).toBeDisabled();
    expect(button("meDownloadZip")).not.toBeDisabled();
    expect(button("meDownloadPdf")).not.toBeDisabled();
    fireEvent.click(button("meSend"));
    expect(confirmFn).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(0);
  });

  it("sample rows under the owner's own name: Send, ZIP and PDF are off, and say why", async () => {
    checklist = CHECKLIST({ blocker: "demo_in_period" });
    renderPage();
    expect(await screen.findByTestId("me-send-blocker")).toHaveTextContent("rpsBlocked_demo_in_period");
    expect(button("meSend")).toBeDisabled();
    expect(button("meDownloadZip")).toBeDisabled();
    expect(button("meDownloadPdf")).toBeDisabled();
  });

  it("an unconfirmed e-mail stops the mail, never the download", async () => {
    checklist = CHECKLIST({ blocker: "email_unverified" });
    renderPage();
    await screen.findByTestId("me-send-blocker");
    expect(button("meSend")).toBeDisabled();
    expect(button("meDownloadZip")).not.toBeDisabled();
    expect(button("meDownloadPdf")).not.toBeDisabled();
  });

  it("nothing in the way: all three are live", async () => {
    renderPage();
    await screen.findByTestId("me-checked-until");
    expect(screen.queryByTestId("me-send-blocker")).toBeNull();
    for (const k of ["meSend", "meDownloadZip", "meDownloadPdf"]) expect(button(k)).not.toBeDisabled();
  });
});

describe("the checklist head fits a 360 px phone", () => {
  it("wraps instead of pinning the status line on one line", async () => {
    checklist = { ...CHECKLIST(), open_count: 3,
      period: { start: "2026-10-01", end: "2026-10-31", kind: "month", label: "oktober 2026" },
      checked_until: "2026-10-14" };
    renderPage();
    await waitFor(() => expect(screen.getByTestId("me-checked-until")).toBeInTheDocument());
    const head = screen.getByTestId("me-checklist-head");
    expect(head.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
    const status = screen.getByTestId("me-checked-until");
    expect(status.className).not.toMatch(/(^|\s)shrink-0(\s|$)/);
    expect(status.className).toMatch(/(^|\s)min-w-0(\s|$)/);
    // "3 åbne" stays on one line.
    expect(screen.getByTestId("me-open-count").className).toMatch(/(^|\s)whitespace-nowrap(\s|$)/);
  });
});

// ── Push 8 gate, round 2 ─────────────────────────────────────────────

describe("the download wall is said even when another blocker comes first", () => {
  // Sample rows under the owner's own name: the server refuses the ZIP and
  // the PDF (422 demo_in_period) whatever stops the mail. The send blocker
  // named only the first wall (sample revisor, opt-out), the downloads stayed
  // live, and the refusal stacked a second warning after the tap.
  it.each(["demo_recipient", "opted_out"])("%s + sample rows: ZIP and PDF are off, and the page says why", async (blocker) => {
    checklist = CHECKLIST({ blocker, download_blocker: "demo_in_period" });
    renderPage();
    expect(await screen.findByTestId("me-send-blocker")).toHaveTextContent(`rpsBlocked_${blocker}`);
    expect(screen.getByTestId("me-download-blocker")).toHaveTextContent("rpsBlocked_demo_in_period");
    expect(button("meDownloadZip")).toBeDisabled();
    expect(button("meDownloadPdf")).toBeDisabled();
    expect(button("meSend")).toBeDisabled();
  });

  it("on a plan without sending, the download wall still has its line", async () => {
    checklist = CHECKLIST({ entitled: false, blocker: "plan", download_blocker: "demo_in_period" });
    renderPage();
    expect(await screen.findByTestId("me-download-blocker")).toHaveTextContent("rpsBlocked_demo_in_period");
    expect(button("meDownloadZip")).toBeDisabled();
    expect(button("meDownloadPdf")).toBeDisabled();
  });

  it("demo_in_period as the send blocker is said once", async () => {
    checklist = CHECKLIST({ blocker: "demo_in_period", download_blocker: "demo_in_period" });
    renderPage();
    expect(await screen.findByTestId("me-send-blocker")).toHaveTextContent("rpsBlocked_demo_in_period");
    expect(screen.queryByTestId("me-download-blocker")).toBeNull();
    expect(button("meDownloadZip")).toBeDisabled();
  });

  it("no sample rows: the download stays live under any other blocker", async () => {
    checklist = CHECKLIST({ blocker: "opted_out", download_blocker: null });
    renderPage();
    await screen.findByTestId("me-send-blocker");
    expect(screen.queryByTestId("me-download-blocker")).toBeNull();
    expect(button("meDownloadZip")).not.toBeDisabled();
    expect(button("meDownloadPdf")).not.toBeDisabled();
  });
});

const withOpen = (n) => ({
  ...CHECKLIST(),
  open_count: n,
  items: [{ key: "bilag_missing", count: n, applicable: true, amount: 450 * n,
    rows: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, date: "2026-09-1" + i, amount: 450, description: "Hørkram" })),
    link: "/expenses" }],
});

describe("the 'Ret' button can be read in dark mode", () => {
  it("carries its own text colour for light and dark", async () => {
    checklist = withOpen(2);
    renderPage();
    const fix = (await screen.findByText("meFix")).closest("a");
    // No colour class: it inherited black and sat black on the gray-900 card.
    expect(fix.className).toMatch(/(^|\s)text-gray-[5-9]00(\s|$)/);
    expect(fix.className).toMatch(/(^|\s)dark:text-(gray-(100|200|300)|white)(\s|$)/);
  });
});

describe("one open item is singular in Danish", () => {
  it("1 open: 'åbent punkt' and 'punkt er åbent' — head, card and the send confirm", async () => {
    checklist = withOpen(1);
    renderPage();
    expect(await screen.findByTestId("me-open-count")).toHaveTextContent("meOpenCountOne:1");
    expect(screen.getByText("meSendOpenWarnOne:1")).toBeInTheDocument();
    expect(screen.queryByText(/^meSendOpenWarn:/)).toBeNull();
    confirmFn.mockImplementationOnce(async () => false);
    fireEvent.click(button("meSend"));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(confirmFn.mock.calls[0][0].message).toBe("meSendOpenWarnOne:1");
    expect(posts()).toHaveLength(0);
  });

  it("2 or more keep the plural", async () => {
    checklist = withOpen(2);
    renderPage();
    expect(await screen.findByTestId("me-open-count")).toHaveTextContent("meOpenCount:2");
    expect(screen.getByText("meSendOpenWarn:2")).toBeInTheDocument();
  });
});

// ── Push 8 gate, round 3 ─────────────────────────────────────────────
//  MAJOR  The schedule card in dark mode: the revisor's e-mail input had no
//         text colour (black on the gray-900 card, 1.18:1), and the radios
//         were accent-gray-900 only, so the chosen schedule was the dark,
//         hollow-looking dot and the others the white ones. The Custom
//         period's date inputs on Månedsafslutning had the same missing
//         colour.
//  MINOR  An open-item row was one truncated line "date · text · amount",
//         so a phone cut the amount — the fact the owner needs.

describe("the schedule card can be read in dark mode", () => {
  it("the revisor's e-mail has its own colour, and the chosen schedule is the light dot", async () => {
    settings = { schedule: "monthly", entitled: true, revisor_email: "qa4.revisor@gmail.com",
      next: null, blocker: null, last_sends: [] };
    render(<MemoryRouter><RevisorPackageSchedule /></MemoryRouter>);
    const email = await screen.findByLabelText("rpsRevisorEmail");
    expect(email).toHaveValue("qa4.revisor@gmail.com");
    expect(email.className).toMatch(/(^|\s)text-gray-[7-9]00(\s|$)/);
    expect(email.className).toMatch(/(^|\s)dark:text-(gray-(100|200)|white)(\s|$)/);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByDisplayValue("monthly")).toBeChecked();
    for (const r of radios) {
      expect(r.className).toMatch(/(^|\s)accent-gray-900(\s|$)/);          // light: unchanged
      expect(r.className).toMatch(/(^|\s)dark:accent-(gray-(100|200)|white)(\s|$)/);
      // Unchosen radios render dark on the dark card, not as white dots.
      expect(r.className).toMatch(/(^|\s)dark:\[color-scheme:dark\](\s|$)/);
    }
  });

  it("Månedsafslutning's own date inputs carry a colour for light and dark", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "mePeriodCustom" }));
    for (const id of ["me-from", "me-to"]) {
      const input = document.getElementById(id);
      expect(input.className).toMatch(/(^|\s)text-gray-[7-9]00(\s|$)/);
      expect(input.className).toMatch(/(^|\s)dark:text-(gray-(100|200)|white)(\s|$)/);
      expect(input.className).toMatch(/(^|\s)dark:\[color-scheme:dark\](\s|$)/);
    }
  });
});

describe("a phone never cuts the kroner off an open-item row", () => {
  const rowsChecklist = () => ({
    ...CHECKLIST(),
    open_count: 3,
    items: [
      { key: "bilag_missing", count: 1, applicable: true, amount: 1875,
        rows: [{ id: "e1", date: "2026-09-11", description: "Elregning Ørsted kvartalsafregning", amount: 1875 }],
        link: "/expenses" },
      { key: "bank_unmatched", count: 1, applicable: true,
        rows: [{ id: "b1", date: "2026-09-12", description: "Hørkram Foodservice faktura 88812", amount: 1234.5 }],
        link: "/imports?tab=bank" },
      { key: "sales_variance", count: 1, applicable: true,
        rows: [{ date: "2026-09-07", close_revenue: 5000, sale_sum: 300, delta: 4700, delta_pct: 94, direction: "close_high" }],
        link: "/daily-close?date=2026-09-07" },
    ],
  });

  it("the text is what gets shortened; the amount sits beside it, whole", async () => {
    checklist = rowsChecklist();
    renderPage();
    for (const [key, text, kr] of [["bilag_missing", /Elregning Ørsted/, /1\.875,00/],
                                    ["bank_unmatched", /Hørkram Foodservice/, /1\.234,50/]]) {
      const item = await screen.findByTestId(`me-item-${key}`);
      const amount = within(item).getByText(kr);
      // One truncated line cut the amount ('… Elregning Ørsted · 1.87…').
      expect(amount.closest(".truncate"), key).toBeNull();
      expect(amount.className, key).toMatch(/(^|\s)shrink-0(\s|$)/);
      const desc = within(item).getByText(text);
      expect(desc.className, key).toMatch(/(^|\s)truncate(\s|$)/);
      expect(desc.textContent, key).not.toMatch(kr);
      // The row still reads "date · text · amount".
      expect(desc.closest("li").textContent, key).toMatch(/· .+ · 1\.\d{3},\d{2}/);
    }
  });

  it("a row with amounts in its sentence wraps instead of being cut", async () => {
    checklist = rowsChecklist();
    renderPage();
    const item = await screen.findByTestId("me-item-sales_variance");
    expect(within(item).getByText(/meVarianceRow/).closest(".truncate")).toBeNull();
  });
});
