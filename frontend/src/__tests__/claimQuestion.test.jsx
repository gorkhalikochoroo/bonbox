/**
 * A login link that lands in an account whose address was never confirmed
 * does not replace the password silently any more (Manoj, 8 Oct). The page
 * ASKS: "Har du selv oprettet denne BonBox-konto den <dato> og valgt
 * adgangskoden?" — Ja keeps everything, Nej / Ved ikke secures the account
 * and offers a new password. There is no skip: leaving the page leaves the
 * question open. The mail's two links land on /login/claim, which asks once
 * more before anything happens (a mail scanner opening a link changes
 * nothing).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("../services/api", () => ({ default: { post: (...a) => post(...a), get: vi.fn(() => Promise.resolve({ data: {} })) } }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({}) }));

import LoginMagicPage from "../pages/LoginMagicPage";
import ClaimDecisionPage from "../pages/ClaimDecisionPage";
import ForgotPasswordPage from "../pages/ForgotPasswordPage";
import { LanguageProvider } from "../hooks/useLanguage";

const TOKEN = "b".repeat(43);
const TICKET = "p".repeat(43);
const MAIL_TICKET = "m".repeat(43);

const openMagic = () =>
  render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[`/login/magic?token=${TOKEN}`]}>
        <Routes>
          <Route path="/login/magic" element={<LoginMagicPage />} />
        </Routes>
      </MemoryRouter>
    </LanguageProvider>,
  );

const openMailLink = (answer) =>
  render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[`/login/claim?token=${MAIL_TICKET}&answer=${answer}`]}>
        <Routes>
          <Route path="/login/claim" element={<ClaimDecisionPage />} />
        </Routes>
      </MemoryRouter>
    </LanguageProvider>,
  );

const verifyWithQuestion = () =>
  Promise.resolve({ data: {
    access_token: "jwt", password_reset: false, access_closed: false,
    claim_question: { created_at: "2026-10-08", has_password: true },
    claim_ticket: TICKET,
  } });

const claimCalls = () => post.mock.calls.filter(([url]) => url === "/auth/claim-decision");

beforeEach(() => {
  post.mockReset();
  localStorage.clear();
  localStorage.setItem("lang", "en");
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("login link on a never-confirmed account: the page asks", () => {
  it("asks the question with the date, both answers, and no way to skip it", async () => {
    post.mockImplementation((url) => (url === "/auth/magic-link/verify" ? verifyWithQuestion() : Promise.reject(new Error(url))));
    openMagic();
    await screen.findByTestId("claim-question");
    expect(screen.getByText("Did you create this BonBox account yourself on 8 October 2026 and choose the password?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yes, it was me" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "No / Not sure" })).toBeTruthy();
    // Exactly two buttons: no "continue" / "skip" that would keep silently.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByText("Continue to BonBox")).toBeNull();
    // Nothing is answered by waiting, and the page does not move on.
    vi.advanceTimersByTime(5000);
    expect(claimCalls()).toHaveLength(0);
    expect(screen.getByTestId("claim-question")).toBeTruthy();
    // The ticket stays in memory — not in storage.
    const stored = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i))).join("|");
    expect(stored).toContain("en");          // the store is really read
    expect(stored).not.toContain(TICKET);
    expect(sessionStorage.length === 0 || !Array.from({ length: sessionStorage.length },
      (_, i) => sessionStorage.getItem(sessionStorage.key(i))).join("|").includes(TICKET)).toBe(true);
  });

  it("asks in Danish with the exact wording", async () => {
    localStorage.setItem("lang", "da");
    post.mockImplementation((url) => (url === "/auth/magic-link/verify" ? verifyWithQuestion() : Promise.reject(new Error(url))));
    openMagic();
    await waitFor(() =>
      expect(screen.getByText("Har du selv oprettet denne BonBox-konto den 8. oktober 2026 og valgt adgangskoden?")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Ja, det var mig" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nej / Ved ikke" })).toBeTruthy();
  });

  it("Ja: keeps everything and goes on into BonBox", async () => {
    post.mockImplementation((url, body) => {
      if (url === "/auth/magic-link/verify") return verifyWithQuestion();
      if (url === "/auth/claim-decision") return Promise.resolve({ data: { decision: body.answer, already_decided: false } });
      return Promise.reject(new Error(url));
    });
    openMagic();
    fireEvent.click(await screen.findByRole("button", { name: "Yes, it was me" }));
    await waitFor(() => expect(screen.getByText("You're in. Redirecting…")).toBeTruthy());
    expect(claimCalls()).toHaveLength(1);
    expect(claimCalls()[0][1]).toEqual({ ticket: TICKET, answer: "keep" });
    expect(screen.queryByText("Choose a new password")).toBeNull();
  });

  it("Nej / Ved ikke: secures the account and offers a new password", async () => {
    post.mockImplementation((url, body) => {
      if (url === "/auth/magic-link/verify") return verifyWithQuestion();
      if (url === "/auth/claim-decision") return Promise.resolve({ data: { decision: body.answer, access_closed: true, access_token: "jwt2" } });
      return Promise.reject(new Error(url));
    });
    openMagic();
    fireEvent.click(await screen.findByRole("button", { name: "No / Not sure" }));
    const box = await screen.findByTestId("claim-secured");
    expect(claimCalls()[0][1]).toEqual({ ticket: TICKET, answer: "secure" });
    expect(screen.getByText("Your account is secured")).toBeTruthy();
    expect(document.body.textContent).toMatch(/The old password no longer works, and other devices are signed out\./);
    expect(document.body.textContent).toMatch(/Revisor access and host-stand devices given before were closed too/);
    const link = screen.getByText("Choose a new password");
    expect(link.closest("a").getAttribute("href")).toBe("/forgot-password");
    expect(box.textContent).toMatch(/Continue to BonBox/);
    vi.advanceTimersByTime(1000);
    expect(screen.getByTestId("claim-secured")).toBeTruthy();   // no silent redirect
  });

  it("an expired question says so and leaves the account as it is", async () => {
    post.mockImplementation((url) => {
      if (url === "/auth/magic-link/verify") return verifyWithQuestion();
      return Promise.reject({ response: { status: 410, data: { detail: { code: "claim_ticket_expired" } } } });
    });
    openMagic();
    fireEvent.click(await screen.findByRole("button", { name: "No / Not sure" }));
    await screen.findByTestId("claim-closed");
    expect(document.body.textContent).toMatch(/This question has expired\. Sign in with a new login link and we'll ask again\./);
  });

  it("a failed save keeps the question on screen to try again", async () => {
    post.mockImplementation((url) => {
      if (url === "/auth/magic-link/verify") return verifyWithQuestion();
      return Promise.reject(new Error("network"));
    });
    openMagic();
    fireEvent.click(await screen.findByRole("button", { name: "Yes, it was me" }));
    await waitFor(() => expect(screen.getByText("Your answer couldn't be saved. Try again.")).toBeTruthy());
    expect(screen.getByTestId("claim-question")).toBeTruthy();
  });

  it("an ordinary sign-in is not asked anything", async () => {
    post.mockResolvedValue({ data: { access_token: "jwt", password_reset: false, claim_question: null, claim_ticket: null } });
    openMagic();
    await waitFor(() => expect(screen.getByText("You're in. Redirecting…")).toBeTruthy());
    expect(screen.queryByTestId("claim-question")).toBeNull();
  });
});

describe("the notice mail's links (/login/claim)", () => {
  const statusOpen = () => Promise.resolve({ data: { state: "open", decision: null, question: { created_at: "2026-10-08", has_password: true } } });

  it("opening a link answers nothing — the page asks once more", async () => {
    post.mockImplementation((url) => (url === "/auth/claim-decision/status" ? statusOpen() : Promise.reject(new Error(url))));
    openMailLink("secure");
    await screen.findByTestId("claim-question");
    expect(screen.getByText("A question about your BonBox account")).toBeTruthy();
    expect(screen.getByText("Did you create this BonBox account yourself on 8 October 2026 and choose the password?")).toBeTruthy();
    expect(post.mock.calls[0]).toEqual(["/auth/claim-decision/status", { ticket: MAIL_TICKET }]);
    vi.advanceTimersByTime(5000);
    expect(claimCalls()).toHaveLength(0);
    // The link's answer is the primary button; the other is still offered.
    expect(screen.getByRole("button", { name: "No / Not sure" }).className).toMatch(/bg-slate-900/);
    expect(screen.getByRole("button", { name: "Yes, it was me" }).className).not.toMatch(/bg-slate-900/);
  });

  it("Secure from the mail: says every device is signed out and offers a new password", async () => {
    post.mockImplementation((url, body) => {
      if (url === "/auth/claim-decision/status") return statusOpen();
      if (url === "/auth/claim-decision") return Promise.resolve({ data: { decision: body.answer, access_closed: false } });
      return Promise.reject(new Error(url));
    });
    openMailLink("secure");
    fireEvent.click(await screen.findByRole("button", { name: "No / Not sure" }));
    await screen.findByTestId("claim-secured");
    expect(claimCalls()[0][1]).toEqual({ ticket: MAIL_TICKET, answer: "secure" });
    expect(document.body.textContent).toMatch(/The old password no longer works, and every device is signed out\./);
    expect(screen.getByText("Choose a new password").closest("a").getAttribute("href")).toBe("/forgot-password");
    expect(screen.getByText("Sign in with a login link").closest("a").getAttribute("href")).toBe("/login");
  });

  it("Keep from the mail: thanks, nothing changed", async () => {
    post.mockImplementation((url, body) => {
      if (url === "/auth/claim-decision/status") return statusOpen();
      if (url === "/auth/claim-decision") return Promise.resolve({ data: { decision: body.answer } });
      return Promise.reject(new Error(url));
    });
    openMailLink("keep");
    fireEvent.click(await screen.findByRole("button", { name: "Yes, it was me" }));
    await screen.findByTestId("claim-kept");
    expect(claimCalls()[0][1]).toEqual({ ticket: MAIL_TICKET, answer: "keep" });
    expect(screen.getByText("Thanks — everything stays as it was")).toBeTruthy();
  });

  it("an answered or expired question is said plainly, with no buttons to answer", async () => {
    post.mockResolvedValueOnce({ data: { state: "decided", decision: "keep", question: { created_at: "2026-10-08" } } });
    const { unmount } = openMailLink("secure");
    await waitFor(() => expect(screen.getByText("This question has already been answered.")).toBeTruthy());
    expect(screen.queryByTestId("claim-question")).toBeNull();
    unmount();
    post.mockResolvedValueOnce({ data: { state: "expired", decision: null, question: { created_at: "2026-10-08" } } });
    openMailLink("keep");
    await waitFor(() => expect(screen.getByText("This question has expired. Sign in with a new login link and we'll ask again.")).toBeTruthy());
    expect(screen.queryByTestId("claim-question")).toBeNull();
  });

  it("an unknown link says invalid; a rate limit or network hiccup does not blame the link", async () => {
    post.mockRejectedValueOnce({ response: { status: 404, data: { detail: { code: "claim_ticket_invalid" } } } });
    const { unmount } = openMailLink("keep");
    await waitFor(() => expect(screen.getByText("This link is invalid.")).toBeTruthy());
    unmount();
    post.mockRejectedValueOnce({ response: { status: 429 } });
    openMailLink("keep");
    await waitFor(() => expect(screen.getByText("The question couldn't be opened right now. Try the link again in a moment.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("after \"Nej / Ved ikke\": a new password in one step (review, 9 Oct)", () => {
  const openMagicWithReset = () =>
    render(
      <LanguageProvider>
        <MemoryRouter initialEntries={[`/login/magic?token=${TOKEN}`]}>
          <Routes>
            <Route path="/login/magic" element={<LoginMagicPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          </Routes>
        </MemoryRouter>
      </LanguageProvider>,
    );

  it("Choose a new password arrives with the address filled in and the code already sent", async () => {
    post.mockImplementation((url, body) => {
      if (url === "/auth/magic-link/verify") {
        return verifyWithQuestion().then((r) => ({ data: { ...r.data, user: { email: "owner@cafe.dk" } } }));
      }
      if (url === "/auth/claim-decision") {
        return Promise.resolve({ data: { decision: body.answer, access_token: "jwt2", user: { email: "owner@cafe.dk" } } });
      }
      if (url === "/auth/forgot-password") return Promise.resolve({ data: { message: "ok" } });
      return Promise.reject(new Error(url));
    });
    openMagicWithReset();
    fireEvent.click(await screen.findByRole("button", { name: "No / Not sure" }));
    await screen.findByTestId("claim-secured");
    const link = screen.getByText("Choose a new password").closest("a");
    // The address never goes in the URL.
    expect(link.getAttribute("href")).toBe("/forgot-password");
    fireEvent.click(link);
    // The code is on its way: only the code and the new password are left.
    await waitFor(() => expect(screen.getByText("6-digit code")).toBeTruthy());
    const sends = post.mock.calls.filter(([url]) => url === "/auth/forgot-password");
    expect(sends).toEqual([["/auth/forgot-password", { email: "owner@cafe.dk" }]]);
    expect(document.body.textContent).toContain("owner@cafe.dk");
  });

  it("the plain Forgot password page still starts empty and sends nothing by itself", async () => {
    post.mockResolvedValue({ data: {} });
    render(
      <LanguageProvider>
        <MemoryRouter initialEntries={["/forgot-password"]}>
          <Routes><Route path="/forgot-password" element={<ForgotPasswordPage />} /></Routes>
        </MemoryRouter>
      </LanguageProvider>,
    );
    const box = await screen.findByPlaceholderText(/./, { selector: "input[type=email]" });
    expect(box.value).toBe("");
    vi.advanceTimersByTime(1000);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("a question opened by a password reset (/login/claim)", () => {
  it("asks about the FIRST password — the owner just chose the current one", async () => {
    post.mockImplementation((url) => (url === "/auth/claim-decision/status"
      ? Promise.resolve({ data: { state: "open", decision: null,
        question: { created_at: "2026-10-08", has_password: true, after_reset: true } } })
      : Promise.reject(new Error(url))));
    openMailLink("secure");
    await screen.findByTestId("claim-question");
    expect(screen.getByText("Did you create this BonBox account yourself on 8 October 2026 and choose its first password?")).toBeTruthy();
  });

  it("in Danish too", async () => {
    localStorage.setItem("lang", "da");
    post.mockImplementation((url) => (url === "/auth/claim-decision/status"
      ? Promise.resolve({ data: { state: "open", decision: null,
        question: { created_at: "2026-10-08", has_password: true, after_reset: true } } })
      : Promise.reject(new Error(url))));
    openMailLink("keep");
    await waitFor(() => expect(screen.getByText(
      "Har du selv oprettet denne BonBox-konto den 8. oktober 2026 og valgt den første adgangskode?")).toBeTruthy());
  });
});
