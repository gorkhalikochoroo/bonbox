/**
 * BonBox mails a third party only for an account whose own e-mail is
 * confirmed (Manoj, 8 Oct). The revisor invite from an unconfirmed owner is
 * SAVED (grant + copy link) but not e-mailed; the server answers
 * email_sent:false + email_not_sent_reason:"email_unverified".
 *
 *   • RevisorSection says so plainly, with the one tap that fixes it
 *     ("Confirm now" → /verify-email?now=1), and never "Didn't arrive?".
 *   • Once the owner is confirmed, a pending row whose link was never e-mailed
 *     (server: mail_held) carries "Send invitation", which re-posts that row's
 *     address (the server re-arms the same grant, same link, and mails it).
 *     Not shown while unconfirmed — it would only be held again — and not on
 *     an invite that already went out by mail.
 *   • The held copy speaks of THE INVITE: BonBox does not hold every mail to
 *     a third party for an unconfirmed account, so it never says it does
 *     (review, 8 Oct — RELEASE_GATE item 5).
 *   • After a reload the held row reads "saved · not e-mailed yet", never
 *     "invited · awaiting accept".
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
// The same row as the server lists it when its link was never e-mailed.
const HELD = { ...PENDING, mail_held: "email_unverified" };
// The general claim the code does not keep (other mail to a third party is
// not held for an unconfirmed account) — in either language.
const GENERAL_CLAIM = /only sends mail to others|mail to others|kun mail til andre|mail til andre/i;

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
      .toMatch(/Invite saved, but not e-mailed yet: BonBox e-mails your revisor the invitation only once your own e-mail is confirmed/);
    expect(screen.getByTestId("revisor-invite-held").textContent).not.toMatch(GENERAL_CLAIM);
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
    h.grants = [HELD];
    await renderSection();
    expect(screen.getByText(/anna@revisor\.dk/)).toBeInTheDocument();
    expect(screen.queryByText("Send invitation")).toBeNull();
    expect(screen.getByText("Revoke")).toBeInTheDocument();
  });

  it("after a reload, the held row says saved · not e-mailed yet, with Confirm now", async () => {
    h.grants = [HELD];
    await renderSection();
    expect(screen.getByText("Revisor — saved · not e-mailed yet")).toBeInTheDocument();
    expect(screen.queryByText("Revisor — invited · awaiting accept")).toBeNull();
    const link = screen.getByText("Confirm now");
    expect(link.closest("a").getAttribute("href")).toBe("/verify-email?now=1");
  });

  it("a row from before BonBox recorded the mail still reads as before", async () => {
    h.grants = [PENDING];
    await renderSection();
    expect(screen.getByText("Revisor — invited · awaiting accept")).toBeInTheDocument();
    expect(screen.queryByText("Confirm now")).toBeNull();
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
    h.grants = [HELD];
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

  it("an invite that already went out by mail has no Send invitation (no second mail in one tap)", async () => {
    h.user = { id: "u1", role: "owner", email_verified: true };
    h.grants = [{ ...PENDING, mail_held: null }];
    await renderSection();
    expect(screen.getByText("Revisor — invited · awaiting accept")).toBeInTheDocument();
    expect(screen.queryByText("Send invitation")).toBeNull();
  });

  it("a failed send can be sent again from its row", async () => {
    h.user = { id: "u1", role: "owner", email_verified: true };
    h.grants = [{ ...PENDING, mail_held: "send_failed" }];
    await renderSection();
    expect(screen.getByText("Revisor — saved · not e-mailed yet")).toBeInTheDocument();
    expect(screen.getByText("Send invitation")).toBeInTheDocument();
  });

  it("a re-send of a link mailed under 24 hours ago says it was not sent again", async () => {
    h.user = { id: "u1", role: "owner", email_verified: true };
    h.post.mockResolvedValue({ data: {
      id: "g1", status: "pending", accept_url: "https://bonbox.dk/accept-invite/tok",
      email_sent: false, email_not_sent_reason: "recently_sent",
    } });
    await renderSection();
    await invite();
    expect(screen.getByText("This invite was e-mailed less than 24 hours ago, so BonBox didn't send it again.")).toBeInTheDocument();
    // A mail did leave (earlier), so "Didn't arrive?" is the true hint.
    expect(screen.getByText(/Didn't arrive\?/)).toBeInTheDocument();
    expect(screen.queryByText(/Invite sent\./)).toBeNull();
    expect(screen.queryByText(/could not be sent/)).toBeNull();
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

describe("the held copy in both dictionaries", () => {
  it("speaks of the invite, never of every mail to others", async () => {
    const { en } = await import("../i18n/en");
    const { da } = await import("../i18n/da");
    for (const k of ["revisorInviteHeldUnverified", "onbRevisorInviteHeld"]) {
      expect(en[k]).toMatch(/invitation/);
      expect(da[k]).toMatch(/invitationen/);
      expect(en[k]).not.toMatch(GENERAL_CLAIM);
      expect(da[k]).not.toMatch(GENERAL_CLAIM);
    }
  });
});
