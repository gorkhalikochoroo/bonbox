/**
 * Release gate R-b (9 Oct): "Spring over for nu" is per account, and a log
 * out forgets it.
 *
 * The session flag ("skip_email_verify") was a plain "1" read for EVERY
 * account and kept after "Log ud": account A skipped, logged out, and
 * account B signing in in the same tab skipped the verify wall too, until
 * the tab closed. The flag now names the account it is for, and logout
 * removes it. A bare "1" (written by an older build, or with no account id)
 * is still honoured — the 7-day per-account memory is unchanged.
 */
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  get: vi.fn(() => Promise.reject(Object.assign(new Error("401"), { response: { status: 401 } }))),
  post: vi.fn(() => Promise.resolve({ data: {} })),
}));
vi.mock("../services/api", () => ({ default: { get: h.get, post: h.post, patch: vi.fn(() => Promise.resolve({})) } }));
vi.mock("../hooks/useEventLog", () => ({ trackEvent: () => {} }));

import { clearVerifySkip, rememberVerifySkip, verifySkipActive } from "../utils/verifySkip";
import { AuthProvider, useAuth } from "../hooks/useAuth";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("the session skip flag is per account", () => {
  it("A's skip in this tab does not skip B (a new session, same tab)", () => {
    rememberVerifySkip("acct-a");
    localStorage.clear(); // only the session flag is left
    expect(verifySkipActive("acct-a")).toBe(true);
    expect(verifySkipActive("acct-b")).toBe(false);
  });

  it("a bare '1' (older build / native signup with no id) is still honoured", () => {
    sessionStorage.setItem("skip_email_verify", "1");
    expect(verifySkipActive("anyone")).toBe(true);
  });

  it("clearing one account's skip leaves no session flag behind", () => {
    rememberVerifySkip("acct-a");
    clearVerifySkip("acct-a");
    expect(sessionStorage.getItem("skip_email_verify")).toBeNull();
    expect(verifySkipActive("acct-a")).toBe(false);
  });
});

describe("logout forgets the session skip", () => {
  it("'Log ud' removes the session flag — the next account on this device does not inherit it", async () => {
    let auth;
    function Probe() { auth = useAuth(); return null; }
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    rememberVerifySkip("acct-a");
    sessionStorage.setItem("skip_email_verify", "1"); // even an older build's bare flag
    await act(async () => { await auth.logout(); });
    expect(sessionStorage.getItem("skip_email_verify")).toBeNull();
    expect(verifySkipActive("acct-b")).toBe(false);
    // A's own 7-day skip is A's — kept for A's next sign-in.
    expect(verifySkipActive("acct-a")).toBe(true);
  });
});
