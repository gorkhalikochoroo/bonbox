/**
 * BonBox mails a third party only for an account whose own e-mail is
 * confirmed (Manoj, 8 Oct). The revisor invite from an unconfirmed owner is
 * SAVED (grant + copy link) but not e-mailed; the server answers
 * email_sent:false + email_not_sent_reason:"email_unverified".
 *
 *   • RevisorSection says so plainly, with the one tap that fixes it
 *     ("Confirm now" → /verify-email?now=1), and never "Didn't arrive?".
 *   • Once the owner is confirmed, each pending row carries "Send invitation",
 *     which re-posts that row's address (the server re-arms the same grant
 *     and mails it). Not shown while unconfirmed — it would only be held again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  user: { id: "u1", role: "owner", email_verified: false },
  grants: [],
}));

vi.mock("../services/api", () => ({ default: { get: h.get, post: h.post, delete: vi.fn() } }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn(() => Promise.resolve(false)) }));
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

import RevisorSection from "../components/RevisorSection";

const PENDING = {
  id: "g1", accountant_email: "anna@revisor.dk", accountant_name: "Anna Hansen",
  status: "pending", invited_at: "2026-10-08T10:00:00Z",
};

beforeEach(() => {
  h.get.mockReset();
  h.get.mockImplementation(() => Promise.resolve({ data: h.grants }));
  h.post.mockReset();
  h.user = { id: "u1", role: "owner", email_verified: false };
  h.grants = [];
});

async function renderSection() {
  render(<MemoryRouter><RevisorSection /></MemoryRouter>);
  await act(async () => {});
}

async function invite(email = "anna@revisor.dk") {
  fireEvent.change(screen.getByPlaceholderText("anna@revisor.dk"), { target: { value: email } });
  await act(async () => { fireEvent.click(screen.getByText("Send invite")); });
}

describe("an unconfirmed owner's invite", () => {
  it("is reported as saved, not e-mailed, with the Confirm-now link — no error", async () => {
    h.post.mockResolvedValue({ data: {
      id: "g1", status: "pending", accept_url: "https://bonbox.dk/accept-invite/tok",
      email_sent: false, email_not_sent_reason: "email_unverified",
    } });
    await renderSection();
    await invite();
    expect(h.post).toHaveBeenCalledWith("/accountants/invite", { email: "anna@revisor.dk", name: null });
    expect(screen.getByTestId("revisor-invite-held").textContent)
      .toMatch(/Invite saved, but not e-mailed yet: BonBox only sends mail to others once your own e-mail is confirmed/);
    const link = screen.getByText("Confirm now");
    expect(link.closest("a").getAttribute("href")).toBe("/verify-email?now=1");
    // The copy link is still there — and never claims a mail left.
    expect(screen.getByDisplayValue("https://bonbox.dk/accept-invite/tok")).toBeInTheDocument();
    expect(screen.getByText(/Or send your revisor this link yourself/)).toBeInTheDocument();
    expect(screen.queryByText(/Didn't arrive\?/)).toBeNull();
    expect(screen.queryByText(/Invite sent\./)).toBeNull();
    expect(screen.queryByText(/Could not send the invite/)).toBeNull();
  });

  it("a pending row offers no Send invitation until the owner is confirmed", async () => {
    h.grants = [PENDING];
    await renderSection();
    expect(screen.getByText(/anna@revisor\.dk/)).toBeInTheDocument();
    expect(screen.queryByText("Send invitation")).toBeNull();
    expect(screen.getByText("Revoke")).toBeInTheDocument();
  });

  it("another not-sent reason keeps the existing not-emailed notice", async () => {
    h.post.mockResolvedValue({ data: {
      id: "g1", status: "pending", accept_url: "https://bonbox.dk/accept-invite/tok",
      email_sent: false, email_not_sent_reason: null,
    } });
    await renderSection();
    await invite();
    expect(screen.getByText(/the e-mail could not be sent/)).toBeInTheDocument();
    expect(screen.queryByTestId("revisor-invite-held")).toBeNull();
    expect(screen.queryByText("Confirm now")).toBeNull();
  });
});

describe("a confirmed owner", () => {
  it("sends the saved invite from the pending row", async () => {
    h.user = { id: "u1", role: "owner", email_verified: true };
    h.grants = [PENDING];
    h.post.mockResolvedValue({ data: {
      id: "g1", status: "pending", accept_url: "https://bonbox.dk/accept-invite/new",
      email_sent: true, email_not_sent_reason: null,
    } });
    await renderSection();
    await act(async () => { fireEvent.click(screen.getByText("Send invitation")); });
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith("/accountants/invite", { email: "anna@revisor.dk", name: "Anna Hansen" });
    expect(screen.getByText("Invite sent. They have 7 days to accept.")).toBeInTheDocument();
    expect(screen.queryByText("Confirm now")).toBeNull();
    // The grants list is re-read so the row shows the re-armed invite.
    expect(h.get.mock.calls.filter(([u]) => u === "/accountants/grants").length).toBeGreaterThanOrEqual(2);
  });

  it("an active or revoked row has no Send invitation", async () => {
    h.user = { id: "u1", role: "owner", email_verified: true };
    h.grants = [
      { ...PENDING, id: "g2", status: "active", activated_at: "2026-10-08T11:00:00Z" },
      { ...PENDING, id: "g3", accountant_email: "old@revisor.dk", status: "revoked" },
    ];
    await renderSection();
    expect(screen.queryByText("Send invitation")).toBeNull();
  });

  it("a normal invite still says sent, with the Didn't-arrive hint", async () => {
    h.user = { id: "u1", role: "owner", email_verified: true };
    h.post.mockResolvedValue({ data: {
      id: "g1", status: "pending", accept_url: "https://bonbox.dk/accept-invite/tok",
      email_sent: true, email_not_sent_reason: null,
    } });
    await renderSection();
    await invite();
    expect(screen.getByText("Invite sent. They have 7 days to accept.")).toBeInTheDocument();
    expect(screen.getByText(/Didn't arrive\?/)).toBeInTheDocument();
  });
});
