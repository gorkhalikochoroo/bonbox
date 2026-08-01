/**
 * The owner's view of a staff member's bank account.
 *
 * This is the one place the plaintext account reaches a screen, so the tests
 * that matter are about WHEN it is fetched and what the owner is told:
 *
 *   • nothing is requested on render — the audit row must record a real intent
 *     to look, not every time someone opened a staff member's drawer
 *   • the owner is told the view is logged
 *   • removal always asks first
 *   • there is no way to EDIT the number here; an account is only trustworthy
 *     if the person being paid typed it
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const del = vi.fn();
const confirmMock = vi.fn();

vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), delete: (...a) => del(...a) },
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => confirmMock }));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    // Mirrors the real t(): fallback, with {var} substitution so the tests
    // assert the shipped copy.
    t: (_k, fb, vars) => {
      let out = fb ?? "";
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
      return out;
    },
  }),
}));

const { default: StaffBankRow } = await import("../components/StaffBankRow");

const setup = () => render(<StaffBankRow memberId="m1" memberName="Sofia" labelCls="lbl" />);

describe("StaffBankRow", () => {
  beforeEach(() => { get.mockReset(); del.mockReset(); confirmMock.mockReset(); });

  it("mounts and fetches NOTHING until asked", () => {
    setup();
    expect(screen.getByText("Show account")).toBeTruthy();
    // The whole point of the on-demand fetch: no audit row from just looking
    // at a staff member.
    expect(get).not.toHaveBeenCalled();
  });

  it("fetches only on an explicit tap, and shows the account", async () => {
    get.mockResolvedValue({ data: { has_bank: true, reg_nr: "1234", account_number: "0005678901" } });
    setup();
    fireEvent.click(screen.getByText("Show account"));
    await screen.findByText(/0005678901/);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/staff/members/m1/bank");
  });

  it("tells the owner the view is logged", async () => {
    get.mockResolvedValue({ data: { has_bank: true, reg_nr: "1234", account_number: "0005678901" } });
    setup();
    fireEvent.click(screen.getByText("Show account"));
    expect(await screen.findByText(/recorded in the audit log/)).toBeTruthy();
  });

  it("says who to chase when no account is on file", async () => {
    get.mockResolvedValue({ data: { has_bank: false } });
    setup();
    fireEvent.click(screen.getByText("Show account"));
    expect(await screen.findByText(/they add it in their portal/)).toBeTruthy();
  });

  it("offers no way to edit the number", async () => {
    get.mockResolvedValue({ data: { has_bank: true, reg_nr: "1234", account_number: "0005678901" } });
    const { container } = setup();
    fireEvent.click(screen.getByText("Show account"));
    await screen.findByText(/0005678901/);
    // An account is only worth trusting if the person being paid typed it.
    expect(container.querySelectorAll("input, textarea").length).toBe(0);
  });

  it("asks before removing, and does nothing if declined", async () => {
    get.mockResolvedValue({ data: { has_bank: true, reg_nr: "1234", account_number: "0005678901" } });
    confirmMock.mockResolvedValue(false);
    setup();
    fireEvent.click(screen.getByText("Show account"));
    fireEvent.click(await screen.findByText("Remove"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(del).not.toHaveBeenCalled();
  });

  it("names the person in the removal confirmation", async () => {
    get.mockResolvedValue({ data: { has_bank: true, reg_nr: "1234", account_number: "0005678901" } });
    confirmMock.mockResolvedValue(false);
    setup();
    fireEvent.click(screen.getByText("Show account"));
    fireEvent.click(await screen.findByText("Remove"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock.mock.calls[0][0].message).toContain("Sofia");
  });

  it("removes once confirmed", async () => {
    get.mockResolvedValue({ data: { has_bank: true, reg_nr: "1234", account_number: "0005678901" } });
    del.mockResolvedValue({ data: { has_bank: false } });
    confirmMock.mockResolvedValue(true);
    setup();
    fireEvent.click(screen.getByText("Show account"));
    fireEvent.click(await screen.findByText("Remove"));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/staff/members/m1/bank"));
  });

  it("explains a 403 rather than showing a generic failure", async () => {
    get.mockRejectedValue({ response: { status: 403 } });
    setup();
    fireEvent.click(screen.getByText("Show account"));
    expect(await screen.findByText(/Only the account owner/)).toBeTruthy();
  });

  it("hides the number again on demand", async () => {
    get.mockResolvedValue({ data: { has_bank: true, reg_nr: "1234", account_number: "0005678901" } });
    setup();
    fireEvent.click(screen.getByText("Show account"));
    fireEvent.click(await screen.findByText("Hide"));
    await waitFor(() => expect(screen.queryByText(/0005678901/)).toBeNull());
  });
});
