/**
 * Danish first 15 minutes, item 4 — "Du er klar": the one next step.
 *
 *   • "Lav din første kasserapport" is one tap into the Daily close wizard
 *     (which opens on today's business day), with the one-line hint.
 *   • "Inviter dit personale" makes the invite with the EXISTING staff-link
 *     endpoints, shows the join code and a QR of the link, and shares through
 *     the phone's share sheet (or copies). BonBox sends nothing itself: the
 *     only calls are the two staff-link ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({
  post: vi.fn(),
  navigate: vi.fn(),
  role: "owner",
}));

vi.mock("../services/api", () => ({ default: { post: h.post } }));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", business_name: "Café Solsikken", role: h.role } }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    lang: "en",
    t: (k, fb, vars) => {
      let s = typeof fb === "string" ? fb : k;
      const v = typeof fb === "object" && fb ? fb : vars;
      if (v) Object.entries(v).forEach(([a, b]) => { s = s.replace(`{${a}}`, String(b)); });
      return s;
    },
  }),
}));
vi.mock("react-router-dom", async (orig) => {
  const mod = await orig();
  return { ...mod, useNavigate: () => h.navigate };
});

import FirstStepsPage from "../pages/FirstStepsPage";

const page = () => render(<MemoryRouter><FirstStepsPage /></MemoryRouter>);

beforeEach(() => {
  h.role = "owner";
  h.navigate.mockClear();
  h.post.mockReset();
  h.post.mockImplementation((url) => {
    if (url === "/staff/members") return Promise.resolve({ data: { id: "m1", name: "Sofie" } });
    if (url === "/staff/members/m1/link") {
      return Promise.resolve({ data: { portal_url: "/s/cafe-solsikken/sofie/tok123", join_code: "K7Q2XM" } });
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
});

afterEach(() => {
  delete navigator.share;
});

async function makeInvite(name = "Sofie") {
  fireEvent.change(screen.getByPlaceholderText("e.g. Sofie"), { target: { value: name } });
  await act(async () => { fireEvent.click(screen.getByText("Make invite")); });
  return screen.findByTestId("first-steps-invite-ready");
}

describe("FirstStepsPage — the first kasserapport", () => {
  it("is the primary card, with the hint, one tap into the Daily close wizard", () => {
    page();
    expect(screen.getByText("Make your first kasserapport")).toBeInTheDocument();
    expect(screen.getByText("Snap the Z-report, or type in the day's totals yourself.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("first-steps-close"));
    expect(h.navigate).toHaveBeenCalledWith("/daily-close");
  });

  it("offers the overview as the way out", () => {
    page();
    const links = screen.getAllByText("Go to the overview");
    expect(links[0].closest("a").getAttribute("href")).toBe("/dashboard");
  });
});

describe("FirstStepsPage — invite your staff", () => {
  it("makes the invite with the existing staff-link endpoints and shows code + QR", async () => {
    page();
    await makeInvite("  Sofie  ");
    expect(h.post).toHaveBeenNthCalledWith(1, "/staff/members", { name: "Sofie" });
    expect(h.post).toHaveBeenNthCalledWith(2, "/staff/members/m1/link");
    expect(h.post).toHaveBeenCalledTimes(2); // nothing sent by BonBox: no SMS, no mail
    expect(screen.getByTestId("first-steps-code").textContent).toBe("K7Q2XM");
    expect(screen.getByText("Sofie can connect now:")).toBeInTheDocument();
    expect(document.querySelector("[data-testid='first-steps-invite-ready'] svg")).not.toBeNull();
    expect(screen.getByText(/BonBox sends no text message/)).toBeInTheDocument();
  });

  it("shares the link through the phone's share sheet", async () => {
    navigator.share = vi.fn(() => Promise.resolve());
    page();
    await makeInvite();
    await act(async () => { fireEvent.click(screen.getByText("Share link")); });
    expect(navigator.share).toHaveBeenCalledTimes(1);
    const arg = navigator.share.mock.calls[0][0];
    expect(arg.url).toMatch(/\/s\/cafe-solsikken\/sofie\/tok123$/);
    expect(arg.text).toContain("K7Q2XM");
  });

  it("copies the link where there is no share sheet", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    page();
    await makeInvite();
    await act(async () => { fireEvent.click(screen.getByText("Copy link")); });
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/s\/cafe-solsikken\/sofie\/tok123$/));
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });

  it("'Invite one more' starts a fresh invite", async () => {
    page();
    await makeInvite();
    fireEvent.click(screen.getByText("Invite one more"));
    expect(screen.getByPlaceholderText("e.g. Sofie").value).toBe("");
  });

  it("says so when the invite can't be made (e.g. the staff cap)", async () => {
    h.post.mockImplementation(() => Promise.reject({ response: { status: 402, data: { detail: "Staff limit reached" } } }));
    page();
    fireEvent.change(screen.getByPlaceholderText("e.g. Sofie"), { target: { value: "Sofie" } });
    await act(async () => { fireEvent.click(screen.getByText("Make invite")); });
    expect(screen.getByRole("alert").textContent).toMatch(/Staff limit reached|Couldn't make the invite/);
    expect(screen.queryByTestId("first-steps-invite-ready")).toBeNull();
  });

  it("a failed link call is retried without creating the staff member twice", async () => {
    let linkCalls = 0;
    h.post.mockImplementation((url) => {
      if (url === "/staff/members") return Promise.resolve({ data: { id: "m1", name: "Sofie" } });
      if (url === "/staff/members/m1/link") {
        linkCalls += 1;
        if (linkCalls === 1) return Promise.reject({ response: { status: 503, data: { detail: "Network blip" } } });
        return Promise.resolve({ data: { portal_url: "/s/cafe-solsikken/sofie/tok123", join_code: "K7Q2XM" } });
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    page();
    fireEvent.change(screen.getByPlaceholderText("e.g. Sofie"), { target: { value: "Sofie" } });
    await act(async () => { fireEvent.click(screen.getByText("Make invite")); });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("first-steps-invite-ready")).toBeNull();
    // Same name, second tap: only the link is asked for again.
    await act(async () => { fireEvent.click(screen.getByText("Make invite")); });
    await screen.findByTestId("first-steps-invite-ready");
    const creates = h.post.mock.calls.filter(([url]) => url === "/staff/members");
    expect(creates).toHaveLength(1);
    expect(linkCalls).toBe(2);
    expect(screen.getByTestId("first-steps-code").textContent).toBe("K7Q2XM");
  });

  it("after a failed link, a different name is a different person (created fresh)", async () => {
    let n = 0;
    h.post.mockImplementation((url) => {
      if (url === "/staff/members") { n += 1; return Promise.resolve({ data: { id: `m${n}` } }); }
      if (url === "/staff/members/m1/link") return Promise.reject({ response: { status: 503, data: { detail: "Network blip" } } });
      if (url === "/staff/members/m2/link") {
        return Promise.resolve({ data: { portal_url: "/s/cafe-solsikken/jonas/tok9", join_code: "ABCDEF" } });
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    page();
    fireEvent.change(screen.getByPlaceholderText("e.g. Sofie"), { target: { value: "Sofie" } });
    await act(async () => { fireEvent.click(screen.getByText("Make invite")); });
    await makeInvite("Jonas");
    expect(h.post).toHaveBeenCalledWith("/staff/members", { name: "Jonas" });
    expect(screen.getByTestId("first-steps-code").textContent).toBe("ABCDEF");
  });

  it("is the owner's card only", () => {
    h.role = "manager";
    page();
    expect(screen.queryByTestId("first-steps-invite")).toBeNull();
    expect(screen.getByTestId("first-steps-close")).toBeInTheDocument();
  });
});
