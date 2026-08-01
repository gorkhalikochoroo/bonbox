/**
 * The staff-portal bank section.
 *
 * This renders the most sensitive thing on a staff member's phone, so the tests
 * that matter are the ones proving what it will NOT do:
 *
 *   • never display more than the last 4 — the server only ever sends a mask,
 *     and nothing in the component can widen that
 *   • never report success when the server refused (a 503 means the account was
 *     NOT stored, and the staffer has to know)
 *   • map the server's validation codes to real copy rather than leaking the
 *     English developer message
 *
 * It also exists because a component can pass build, lint and the i18n guard and
 * still explode on first render — that has shipped a prod-down page here before.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const put = vi.fn();
const del = vi.fn();

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), put: (...a) => put(...a), delete: (...a) => del(...a) },
}));

// t() returns the fallback, so assertions read the real shipped copy.
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => () => Promise.resolve(true) }));

vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (_k, fb) => fb, lang: "da", setLang: () => {}, LANGUAGES: [] }),
}));

const { BankSection } = await import("../pages/StaffPortalPage");

describe("BankSection", () => {
  beforeEach(() => {
    get.mockReset(); put.mockReset(); del.mockReset();
  });

  it("mounts without crashing and shows the empty state", async () => {
    get.mockResolvedValue({ data: { has_bank: false, reg_nr: null, masked: null } });
    render(<BankSection token="tok" />);
    expect(await screen.findByText("Not added yet")).toBeTruthy();
    expect(screen.getByText("Add")).toBeTruthy();
  });

  it("shows only the masked account the server sent", async () => {
    get.mockResolvedValue({ data: { has_bank: true, reg_nr: "1234", masked: "•••• 8901" } });
    render(<BankSection token="tok" />);
    await screen.findByText(/8901/);
    // The full number must appear nowhere in the rendered output.
    expect(document.body.textContent).not.toMatch(/0005678901|5678901/);
    expect(document.body.textContent).toContain("•••• 8901");
  });

  it("never renders more than four consecutive account digits", async () => {
    get.mockResolvedValue({ data: { has_bank: true, reg_nr: "1234", masked: "•••• 8901" } });
    render(<BankSection token="tok" />);
    await screen.findByText(/8901/);
    // reg-nr (4) and the mask (4) are the only digit runs allowed.
    for (const run of document.body.textContent.match(/\d+/g) || []) {
      expect(run.length).toBeLessThanOrEqual(4);
    }
  });

  it("says the account was NOT saved when storage is unavailable", async () => {
    get.mockResolvedValue({ data: { has_bank: false } });
    put.mockRejectedValue({ response: { status: 503 } });
    render(<BankSection token="tok" />);
    fireEvent.click(await screen.findByText("Add"));
    fireEvent.click(screen.getByText("Save account"));
    // The copy must state nothing was stored — a generic "error" would leave
    // the staffer believing their account is on file.
    expect(await screen.findByText(/Nothing was stored/)).toBeTruthy();
  });

  it("translates a server validation code instead of leaking the raw message", async () => {
    get.mockResolvedValue({ data: { has_bank: false } });
    put.mockRejectedValue({
      response: { status: 400, data: { detail: { code: "account_too_short", message: "Kontonummer must be at least 6 digits." } } },
    });
    render(<BankSection token="tok" />);
    fireEvent.click(await screen.findByText("Add"));
    fireEvent.click(screen.getByText("Save account"));
    expect(await screen.findByText(/looks too short/)).toBeTruthy();
    // The developer sentence must not reach the staff member.
    expect(document.body.textContent).not.toContain("must be at least 6 digits");
  });

  it("falls back to generic copy for an unmapped code", async () => {
    get.mockResolvedValue({ data: { has_bank: false } });
    put.mockRejectedValue({ response: { status: 400, data: { detail: { code: "something_new" } } } });
    render(<BankSection token="tok" />);
    fireEvent.click(await screen.findByText("Add"));
    fireEvent.click(screen.getByText("Save account"));
    expect(await screen.findByText(/Check the numbers and try again/)).toBeTruthy();
  });

  it("offers removal only once an account exists", async () => {
    get.mockResolvedValue({ data: { has_bank: false } });
    const { unmount } = render(<BankSection token="tok" />);
    fireEvent.click(await screen.findByText("Add"));
    expect(screen.queryByText("Remove my account")).toBeNull();
    unmount();

    get.mockResolvedValue({ data: { has_bank: true, reg_nr: "1234", masked: "•••• 8901" } });
    render(<BankSection token="tok" />);
    fireEvent.click(await screen.findByText("Change"));
    expect(screen.getByText("Remove my account")).toBeTruthy();
  });

  it("does NOT claim 'no account' when the read failed", async () => {
    // The backend deliberately fails loud on a decrypt error rather than
    // rendering an empty account. Showing "Not added yet" next to an Add
    // button would recreate exactly the silent lie it refused to tell — and
    // invite the staffer to overwrite an account that is still there.
    get.mockRejectedValue(new Error("offline"));
    render(<BankSection token="tok" />);
    expect(await screen.findByText(/isn't gone/)).toBeTruthy();
    expect(screen.queryByText("Not added yet")).toBeNull();
    expect(screen.queryByText("Add")).toBeNull();
  });

  it("offers a retry that re-requests the account", async () => {
    get.mockRejectedValueOnce(new Error("offline"))
       .mockResolvedValueOnce({ data: { has_bank: true, reg_nr: "1234", masked: "•••• 8901" } });
    render(<BankSection token="tok" />);
    fireEvent.click(await screen.findByText("Try again"));
    expect(await screen.findByText(/8901/)).toBeTruthy();
  });

  it("blames the connection, not the staffer's digits, on a transport failure", async () => {
    get.mockResolvedValue({ data: { has_bank: false } });
    put.mockRejectedValue({});                       // no .response at all
    render(<BankSection token="tok" />);
    fireEvent.click(await screen.findByText("Add"));
    fireEvent.click(screen.getByText("Save account"));
    expect(await screen.findByText(/No connection/)).toBeTruthy();
  });

  it("says nothing was saved on a rate limit", async () => {
    get.mockResolvedValue({ data: { has_bank: false } });
    put.mockRejectedValue({ response: { status: 429 } });
    render(<BankSection token="tok" />);
    fireEvent.click(await screen.findByText("Add"));
    fireEvent.click(screen.getByText("Save account"));
    // slowapi returns {error: ...} with no `detail`, so without an explicit
    // branch this fell through to "check the numbers" — telling someone whose
    // digits are correct that they are wrong.
    expect(await screen.findByText(/Too many attempts/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Check the numbers/);
  });
});
