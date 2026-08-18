/**
 * Sticky payment method — the expense scope's ids must match what is offered.
 *
 * Two defects, one root cause: the expense allow-lists drifted away from the
 * ids the form actually uses.
 *
 *   1. The lists spelled bank transfer "bankTransfer" — the i18n KEY — while
 *      the chip's id is "bank_transfer", the value the backend vets. So
 *      commitMethod's PERSIST_ALLOW check returned early on every tap and
 *      bankoverførsel, how a Danish business pays most supplier invoices,
 *      could never become sticky. Silent: the chip lit, nothing was stored.
 *
 *   2. The lists still carried "online" / "mixed" / "dankort" after those were
 *      retired from the form. A stored one is now unofferable, so it lit no
 *      chip at all, and an owner who didn't notice would book against whatever
 *      the default was rather than what they actually paid with.
 *
 * The invariant that outranks both: NOTHING may resolve to "cash". "cash" is
 * the only method that posts to the cashbook (sync_cash_out_for_expense), so a
 * fabricated one invents a drawer movement that never happened. The file's own
 * cash-honesty note says the same thing for the sale scope; these pin it for
 * the migration path too.
 *
 * Run:
 *   cd frontend && npx vitest run src/__tests__/useStickyMethod.expenseIds.test.jsx
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getStickyMethod } from "../hooks/useStickyMethod";

const UID = "u-123";
const KEY = (scope) => `bonbox_sticky_method_${scope}_${UID}`;

const store = (scope, value) => localStorage.setItem(KEY(scope), value);

describe("expense scope — ids match what the form offers", () => {
  beforeEach(() => localStorage.clear());

  it("reads back bank_transfer, the id the backend vets", () => {
    store("expense", "bank_transfer");
    expect(getStickyMethod("expense", UID)).toBe("bank_transfer");
  });

  it("does NOT accept the i18n key spelling", () => {
    // If this ever passes, the lists have drifted back to the translation key.
    store("expense", "bankTransfer");
    expect(getStickyMethod("expense", UID)).not.toBe("bankTransfer");
  });

  it.each(["card", "cash", "mobilepay", "bank_transfer"])(
    "round-trips the offered id %s",
    (id) => {
      store("expense", id);
      expect(getStickyMethod("expense", UID)).toBe(id);
    },
  );
});

describe("retired expense ids", () => {
  beforeEach(() => localStorage.clear());

  it.each([
    ["dankort", "card"],
    ["online", "card"],
  ])("maps %s to the card it always was", (stored, expected) => {
    store("expense", stored);
    expect(getStickyMethod("expense", UID)).toBe(expected);
  });

  it("leaves 'mixed' to be re-chosen rather than inventing an equivalent", () => {
    store("expense", "mixed");
    expect(getStickyMethod("expense", UID)).not.toBe("mixed");
  });

  it("never resolves a retired id to cash", () => {
    // The one outcome that would post a phantom cashbook movement.
    for (const retired of ["dankort", "online", "mixed"]) {
      localStorage.clear();
      store("expense", retired);
      expect(getStickyMethod("expense", UID)).not.toBe("cash");
    }
  });
});

describe("the sale scope is untouched", () => {
  beforeEach(() => localStorage.clear());

  it.each(["card", "mobilepay", "online", "mixed", "dankort"])(
    "still accepts %s on a sale",
    (id) => {
      store("sale", id);
      expect(getStickyMethod("sale", UID)).toBe(id);
    },
  );

  it("still refuses to pre-light cash on a sale (cash-honesty invariant)", () => {
    store("sale", "cash");
    expect(getStickyMethod("sale", UID)).not.toBe("cash");
  });

  it("does not apply the expense migration to a sale", () => {
    store("sale", "dankort");
    expect(getStickyMethod("sale", UID)).toBe("dankort"); // NOT rewritten to card
  });
});

describe("garbage and absence", () => {
  beforeEach(() => localStorage.clear());

  it("falls back when nothing is stored", () => {
    expect(getStickyMethod("expense", UID)).toBe("card");
  });

  it("falls back on a tampered value rather than passing it through", () => {
    store("expense", "'; DROP TABLE expenses;--");
    expect(getStickyMethod("expense", UID)).toBe("card");
  });
});
