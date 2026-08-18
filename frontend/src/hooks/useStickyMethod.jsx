/**
 * useStickyMethod — remember the owner's last-used payment method so the
 * highest-frequency action in the app (logging a sale / an expense) stops
 * costing a re-pick every single time.
 *
 * WHY THIS EXISTS
 *   A Danish café is overwhelmingly card + MobilePay. Forcing the owner to
 *   re-select "how was I paid?" on every entry is pure friction on a value
 *   the app already knew from last time. This hook makes the picker a
 *   confirmation glance after the first use, not a decision.
 *
 * THE CASH-HONESTY INVARIANT (load-bearing — do not loosen)
 *   `payment_method == "cash"` is the ONLY method that auto-posts a cash-in
 *   row to the kassekladde (cashbook) — see sync_cash_in_for_sale in
 *   backend/app/routers/sales.py. If "cash" could become a *remembered*
 *   default, a single one-off cash sale would silently book every later sale
 *   as cash and inject phantom cash into the cashbook (overstating the drawer,
 *   breaking the close). So on the SALE scope cash is deliberately NOT
 *   persistable: tapping Kontant logs THAT one sale as cash, but the next
 *   entry re-selects the last non-cash method. The owner can always reach for
 *   Kontant again; the choice just isn't inferred.
 *
 *   The EXPENSE scope allows cash to stick — an expense form always shows the
 *   method picker (so a stuck value is visible and correctable) and paying a
 *   supplier in cash is a legitimate recurring pattern.
 *
 * API
 *   const { method, setMethod, commitMethod, reread } = useStickyMethod("sale");
 *     method        resolved value (stored-valid-or-default), a canonical id
 *     setMethod(m)  in-memory ONLY — for voice / transient selection that must
 *                   NOT be remembered (e.g. a voiced "cash")
 *     commitMethod(m) sets in-memory AND persists, but only for a method that
 *                   is persistable for the scope (cash no-ops on "sale")
 *     reread()      re-read from storage with the current user id (call when a
 *                   modal re-opens so a method picked elsewhere this session
 *                   is reflected)
 *
 *   getStickyMethod(scope, userId)  imperative read for seeding useState.
 */
import { useState, useEffect, useCallback } from "react";
import { useAuth } from "./useAuth";

const PREFIX = "bonbox_sticky_method";

// What may be SHOWN / used as a pre-selected default per scope (read guard).
// A stale value outside this set (e.g. a typo, or a method removed from the
// UI) falls back to the scope default rather than rendering a blank chip.
// NOTE: "cash" is intentionally absent from `sale` here too — this is the
// second barrier of the cash-honesty invariant (with PERSIST_ALLOW below), so
// a tampered/stale "cash" value on the sale key can never be pre-lit. Do not
// add "cash" to `sale` in either list.
// The `expense` sets are the ids the backend actually vets for this feature
// (recurring_expense.py's _ALLOWED_PAYMENT_METHODS = {cash, card, mobilepay,
// bank_transfer}) and the ids the expense form now offers. They previously
// listed "online"/"mixed"/"dankort" — values the schema rejects — and spelled
// bank transfer "bankTransfer" (the i18n KEY) rather than "bank_transfer" (the
// id). That mismatch meant tapping Bankoverførsel could never become sticky:
// commitMethod's PERSIST_ALLOW check below returned early every time.
// `sale` is untouched — its values are correct for that scope.
const READ_ALLOW = {
  sale: ["card", "mobilepay", "online", "mixed", "dankort"],
  expense: ["card", "cash", "mobilepay", "bank_transfer"],
};

// What may be PERSISTED per scope. Note "cash" is absent from `sale` on
// purpose (see the cash-honesty invariant above).
const PERSIST_ALLOW = {
  sale: ["card", "mobilepay", "online", "mixed", "dankort"],
  expense: ["card", "cash", "mobilepay", "bank_transfer"],
};

// Accounts that used the expense form before the offered methods were narrowed
// still hold one of the retired ids. Without this they fail the read guard and
// silently become the scope DEFAULT, so an owner whose habit was dankort would
// find no chip lit and — if they didn't notice — book against whatever the
// default happens to be. Both retired card-type values map to the card they
// always were. "mixed" has no honest single equivalent, so it is left to fall
// through and be re-chosen.
//
// NOTHING may map to "cash". Inventing a cash payment would post a phantom
// movement to the cashbook via sync_cash_out_for_expense — the cash-honesty
// invariant above, applied in the other direction.
const LEGACY_EXPENSE_ALIAS = { dankort: "card", online: "card" };

// Fresh-account defaults. DK is cashless-first, so "card" is the value an
// owner would pick anyway, and it posts nothing to the cashbook.
const DEFAULTS = { sale: "card", expense: "card" };

function keyFor(scope, uid) {
  return `${PREFIX}_${scope}_${uid || "anon"}`;
}

/**
 * Imperative read — validates against the scope's read allow-list and falls
 * back to the scope default. Safe in private mode / quota errors (try/catch).
 * Exported so a component can seed useState before the hook resolves.
 */
export function getStickyMethod(scope, uid) {
  const fallback = DEFAULTS[scope] || "card";
  try {
    let v = localStorage.getItem(keyFor(scope, uid));
    // Translate a retired expense id before the guard, not after — after the
    // guard it has already collapsed into the default and the owner's actual
    // habit is lost.
    if (v && scope === "expense" && LEGACY_EXPENSE_ALIAS[v]) {
      v = LEGACY_EXPENSE_ALIAS[v];
    }
    if (v && (READ_ALLOW[scope] || []).includes(v)) return v;
  } catch {
    /* localStorage unavailable — fall through to the default */
  }
  return fallback;
}

export const STICKY_DEFAULTS = DEFAULTS;

export function useStickyMethod(scope) {
  const { user } = useAuth();
  // null suffix while auth resolves → "anon" key, and we never persist under
  // it (see commitMethod) so a pre-auth write can't bleed into a real account.
  const uid = user?.id || null;

  const [method, setMethodState] = useState(() => getStickyMethod(scope, uid));

  // Re-read when the signed-in user changes (logout → login on a shared
  // back-office laptop must not inherit the previous owner's default).
  useEffect(() => {
    setMethodState(getStickyMethod(scope, uid));
  }, [scope, uid]);

  // In-memory only — never persists. Use for voice / prefill / transient.
  const setMethod = useCallback((m) => setMethodState(m), []);

  // In-memory + persist, gated by the scope's persist allow-list and a real
  // (non-anon) account. Cash on the "sale" scope silently no-ops the persist.
  const commitMethod = useCallback(
    (m) => {
      setMethodState(m);
      if (!uid) return;
      if (!(PERSIST_ALLOW[scope] || []).includes(m)) return;
      try {
        localStorage.setItem(keyFor(scope, uid), m);
      } catch {
        /* ignore — selection still applies in-memory for this entry */
      }
    },
    [scope, uid],
  );

  const reread = useCallback(() => {
    const v = getStickyMethod(scope, uid);
    setMethodState(v);
    return v;
  }, [scope, uid]);

  return { method, setMethod, commitMethod, reread };
}
