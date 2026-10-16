/**
 * M (money honesty, 15 Oct): the MOMS hero must never print "Forventet MOMS
 * ~0 kr." for a period BonBox holds NO figures for. It says BonBox has no
 * figures for the period yet and points at where they go in.
 *
 * The owner's case: a quarterly owner on 16 Oct (Q3 over, frist 1 Dec) — or a
 * brand-new signup — with nothing entered for July–September. The backend now
 * flags it (foresight moms.has_data === false); an older backend sends no
 * flag and the card reads exactly as before.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: {} })), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const { LanguageProvider } = await import("../hooks/useLanguage");
const Card = (await import("../components/dashboard/ComplianceCountdownCard")).default;

const withLang = (ui, lang = "da") => {
  localStorage.setItem("lang", lang);
  return render(<LanguageProvider><MemoryRouter>{ui}</MemoryRouter></LanguageProvider>);
};

const FS = (moms = {}, deadline = {}) => ({
  available: true,
  verdict: "INSUFFICIENT_DATA",
  balance_source: "none",
  balance: {},
  deadline: { date: "2026-12-01", period_label: "Q3 2026", frequency: "quarterly", days_until: 46, ...deadline },
  moms: {
    low: 0, expected: 0, high: 0, confidence: "low", realized: 0, projected: 0,
    period_start: "2026-07-01", period_end: "2026-09-30", data_from: null, has_data: false,
    ...moms,
  },
});

beforeEach(() => localStorage.clear());

describe("no figures for the period", () => {
  it("Danish: names the quarter and the months, never ~0 kr.", async () => {
    const { container } = withLang(<Card foresight={FS()} ctx={{ summary: { uses_daily_close: true } }} />);
    const head = await screen.findByTestId("fs-no-figures");
    expect(head.textContent).toBe("BonBox har ingen tal for 3. kvartal endnu");
    expect(container.textContent).toMatch(/Tast eller scan juli–september ind — MOMS forfalder 1\. dec\./);
    expect(container.textContent).not.toMatch(/~0/);
    expect(container.textContent).not.toMatch(/Forventet MOMS/);
    // One tap to where the figures go in — the close, for a venue that closes.
    expect(container.querySelector('a[href="/daily-close"]')).not.toBeNull();
  });

  it("English, and a venue without closes is sent to Sales", async () => {
    const { container } = withLang(<Card foresight={FS()} ctx={{ summary: { uses_daily_close: false } }} />, "en");
    expect((await screen.findByTestId("fs-no-figures")).textContent).toBe("BonBox has no figures for Q3 yet");
    expect(container.textContent).toMatch(/Enter or scan July–September — MOMS is due/);
    expect(container.querySelector('a[href="/sales"]')).not.toBeNull();
  });

  it("half-yearly says the half-year", async () => {
    withLang(<Card foresight={FS({ period_start: "2026-01-01", period_end: "2026-06-30" },
      { date: "2026-09-01", frequency: "half_yearly", period_label: "H1 2026" })} />);
    expect((await screen.findByTestId("fs-no-figures")).textContent).toBe("BonBox har ingen tal for 1. halvår endnu");
  });

  it("a balance does not turn 'no figures' into 'covered'", async () => {
    const fs = { ...FS(), verdict: "ON_TRACK", balance_source: "manual", balance: { starting: 50000 } };
    const { container } = withLang(<Card foresight={fs} />);
    await screen.findByTestId("fs-no-figures");
    expect(container.textContent).not.toMatch(/dækket/);
  });
});

describe("unchanged when there ARE figures (or an older server)", () => {
  it("has_data true with a genuine 0 keeps the old line", async () => {
    const { container } = withLang(<Card foresight={FS({ has_data: true })} />);
    await screen.findAllByText(/MOMS/);
    expect(screen.queryByTestId("fs-no-figures")).toBeNull();
    expect(container.textContent).toMatch(/Forventet MOMS ~0/);
  });

  it("no has_data field (older backend) keeps the old line", async () => {
    const fs = FS();
    delete fs.moms.has_data;
    const { container } = withLang(<Card foresight={fs} />);
    await screen.findAllByText(/MOMS/);
    expect(screen.queryByTestId("fs-no-figures")).toBeNull();
    expect(container.textContent).toMatch(/Forventet MOMS ~0/);
  });
});
