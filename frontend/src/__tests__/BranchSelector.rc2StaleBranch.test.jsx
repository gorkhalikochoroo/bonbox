/**
 * R-c round 2 fix-up (review: attacker + removal lenses) — a branch picked by
 * the account signed in before never locks the next account out of Daily
 * close.
 *
 * The pick is kept on the phone (localStorage "bonbox_branch"); it survived
 * sign-out and was never checked against the next account's branches. Every
 * close of the next account was filed under it — refused by the server since
 * R-c (403 branch_not_owned), nothing saved — and an account with no branches
 * has no picker to get out of it. Now: sign-out forgets the pick (and the
 * Daily close queue's account), another account signing in lets go of it,
 * and a pick that is not among the signed-in account's branches is let go of
 * once that list has loaded (never on a failed read).
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({ default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() } }));
vi.mock("../hooks/useLanguage", () => ({ useLanguage: () => ({ t: (k, f) => (typeof f === "string" ? f : k), lang: "da" }) }));
let authUser = null;
vi.mock("../hooks/useAuth", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useAuth: () => ({ user: authUser }) };
});

const { BranchProvider, useBranch } = await import("../components/BranchSelector");
const { AuthProvider, useAuth } = await vi.importActual("../hooks/useAuth");
const { queueAccount, setQueueAccount } = await import("../utils/dailyCloseQueue");

let seen = null;
const Probe = () => { seen = useBranch(); return null; };
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const listOf = (ids) => ({ data: { branches: ids.map((id) => ({ id, name: id, business_type: "restaurant" })) } });

beforeEach(() => { localStorage.clear(); get.mockReset(); post.mockReset(); seen = null; });
afterEach(() => { setQueueAccount(undefined); });

describe("the branch picked is the signed-in account's, or none", () => {
  it("a pick left by another account, not among this account's branches, is let go of once the list loads", async () => {
    localStorage.setItem("bonbox_branch", "a-branch-x");
    authUser = { id: "user-b" };
    get.mockResolvedValue(listOf([]));
    render(<BranchProvider><Probe /></BranchProvider>);
    await settle();
    expect(seen.branchId).toBeNull();
    expect(localStorage.getItem("bonbox_branch")).toBeNull();
  });

  it("the account's own pick stays", async () => {
    localStorage.setItem("bonbox_branch", "b1");
    authUser = { id: "user-b" };
    get.mockResolvedValue(listOf(["b1", "b2"]));
    render(<BranchProvider><Probe /></BranchProvider>);
    await settle();
    expect(seen.branchId).toBe("b1");
  });

  it("the list could not be read: the pick stays (a failed read never re-files closes with no branch)", async () => {
    localStorage.setItem("bonbox_branch", "b1");
    authUser = { id: "user-b" };
    get.mockRejectedValue(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }));
    render(<BranchProvider><Probe /></BranchProvider>);
    await settle();
    expect(seen.branchId).toBe("b1");
  });

  it("another account signing in lets go of the pick at once", async () => {
    localStorage.setItem("bonbox_branch", "a1");
    authUser = { id: "user-a" };
    get.mockResolvedValue(listOf(["a1"]));
    const view = render(<BranchProvider><Probe /></BranchProvider>);
    await settle();
    expect(seen.branchId).toBe("a1");
    authUser = { id: "user-b" };
    get.mockImplementation(() => new Promise(() => {}));   // B's list still on its way
    view.rerender(<BranchProvider><Probe /></BranchProvider>);
    await settle();
    expect(seen.branchId).toBeNull();
  });
});

describe("sign-out forgets the pick and the Daily close queue's account", () => {
  it("logout clears bonbox_branch and leaves the queue with no account", async () => {
    authUser = undefined;
    localStorage.setItem("bonbox_branch", "a1");
    setQueueAccount("user-a");
    get.mockResolvedValue({ data: { id: "user-a", email: "a@cafe.dk" } });
    post.mockResolvedValue({ data: {} });
    let auth = null;
    const Grab = () => { auth = useAuth(); return null; };
    render(<AuthProvider><Grab /></AuthProvider>);
    await settle();
    await act(async () => { await auth.logout(); });
    expect(post).toHaveBeenCalledWith("/auth/logout");
    expect(localStorage.getItem("bonbox_branch")).toBeNull();
    expect(queueAccount()).toBeNull();
  });
});
