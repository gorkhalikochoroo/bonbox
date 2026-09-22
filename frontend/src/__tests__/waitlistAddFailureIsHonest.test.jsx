/**
 * The Venteliste must not blame the host for the server's failure.
 *
 * THE DEFECT. Adding a party to the waitlist answered EVERY non-402 failure
 * with "Couldn't add — check the phone number." A 500, a dropped connection, a
 * route the device cannot reach: all of them told the host, mid-service, that
 * the number they had just been given was wrong. So they re-typed a correct
 * number, watched it fail again, and learned not to trust the feature. The app
 * asserted a cause it had not established — and the cause it picked was the one
 * that puts the blame on the user.
 *
 * It matters most on a PAIRED HOST STAND (/stand/<token>). The api client
 * rewrites /reservations/* onto /stand/<token>/*, and the backend accepts that
 * credential only on the calls it wraps. The waitlist mutations are wrapped now,
 * but frontend and backend deploy separately — a newer bundle can still meet an
 * older API and get a 404 for a button it drew. On that call a 404 is
 * unambiguous (the owner-side handler cannot produce one), so it is the one
 * failure we are entitled to explain.
 *
 * Run: cd frontend && npx vitest run src/__tests__/waitlistAddFailureIsHonest.test.jsx
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));
const standState = vi.hoisted(() => ({ token: null }));
vi.mock("../services/standAuth", () => ({
  getStandToken: () => standState.token,
  setStandToken: vi.fn(),
  clearStandToken: vi.fn(),
  standRewrite: () => null,
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (_k, fallback) => fallback ?? _k, lang: "en" }),
}));
vi.mock("../hooks/useConfirm", () => ({
  useConfirm: () => () => Promise.resolve(true),
}));

import api from "../services/api";
import WaitlistSection from "../components/reservations/WaitlistSection";

const DAY = "2026-09-22";
const WRONG_ANSWER = /check the phone number/i;

function rejectWith(status) {
  const e = new Error("boom");
  e.response = { status, data: {} };
  return Promise.reject(e);
}

async function addAParty() {
  render(<WaitlistSection day={DAY} />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  fireEvent.click(screen.getByText("Add"));
  fireEvent.change(screen.getByPlaceholderText("Phone (required)"), {
    target: { value: "+45 20 30 40 50" },
  });
  await act(async () => {
    fireEvent.click(screen.getByText("Add to waitlist"));
  });
}

beforeEach(() => {
  standState.token = null;
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockResolvedValue({ data: { waitlist: [], day: DAY, active_count: 0 } });
});

describe("waitlist add — failures say something true", () => {
  it("does not blame the phone number for a server error", async () => {
    api.post.mockImplementation(() => rejectWith(500));
    await addAParty();
    const msg = await screen.findByText(/couldn't add/i);
    expect(msg.textContent).not.toMatch(WRONG_ANSWER);
    expect(msg.textContent).toMatch(/try again/i);
  });

  it("does not blame the phone number when the network is simply gone", async () => {
    // No `response` at all — axios's shape for "the request never arrived".
    api.post.mockImplementation(() => Promise.reject(new Error("Network Error")));
    await addAParty();
    const msg = await screen.findByText(/couldn't add/i);
    expect(msg.textContent).not.toMatch(WRONG_ANSWER);
  });

  it("still says check the phone number when the server actually rejected it", async () => {
    api.post.mockImplementation(() => rejectWith(422));
    await addAParty();
    expect((await screen.findByText(/couldn't add/i)).textContent).toMatch(WRONG_ANSWER);
  });

  it("tells a paired door device that IT cannot do this, rather than guessing", async () => {
    standState.token = "Zt4kQn9x_Sample-Token";
    api.post.mockImplementation(() => rejectWith(404));
    await addAParty();
    const msg = await screen.findByText(/door device/i);
    expect(msg.textContent).not.toMatch(WRONG_ANSWER);
  });

  it("keeps the upgrade answer for a real cap", async () => {
    api.post.mockImplementation(() => rejectWith(402));
    await addAParty();
    expect(await screen.findByText(/upgrade required/i)).toBeInTheDocument();
  });
});
