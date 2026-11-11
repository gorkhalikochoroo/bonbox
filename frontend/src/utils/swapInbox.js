/**
 * The staff portal's swap inbox, read from the viewer's side.
 *
 * GET /portal/{token}/swap-requests returns each request as stored: from_* is
 * the PROPOSER's shift (the one they give), to_* the target's (the one the
 * proposer gets), and `direction` says which of the two the viewer is
 * ("outgoing" = I proposed, "incoming" = I am asked). The cards used to label
 * the two shifts "Gives / Gets" from the proposer's side, so on an incoming
 * card "Gives Thu 19" was the shift the viewer would GET. These helpers turn
 * a row into what the viewer gives and gets, and say which rows wait on them.
 */

/** A request only the viewer can move: a proposal addressed to them. */
export function needsMyAnswer(swap) {
  return !!swap && swap.status === "proposed" && swap.direction === "incoming";
}

/** How many requests wait on the viewer's answer (the Byt dock badge). */
export function countNeedsMyAnswer(list) {
  return Array.isArray(list) ? list.filter(needsMyAnswer).length : 0;
}

// 0 = needs your answer, 1 = waiting on someone else (your own open
// proposal or give-away, or an agreed swap waiting on the owner), 2 = done.
function rank(swap) {
  if (needsMyAnswer(swap)) return 0;
  if (swap?.status === "proposed" || swap?.status === "accepted") return 1;
  return 2;
}

/** Needs-your-answer first, then waiting-on-others, then done; the server's
    order (newest first) kept inside each group. Never mutates the input. */
export function orderSwapInbox(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((s, i) => [s, i])
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(([s]) => s);
}

/** The two sides of a swap as the viewer reads them: the shift they give and
    the shift they get. A give-away (no counter-shift) has only `give`. */
export function swapSides(swap) {
  const from = { date: swap?.from_shift_date ?? null, time: swap?.from_shift_time ?? null };
  const to = { date: swap?.to_shift_date ?? null, time: swap?.to_shift_time ?? null };
  if (!swap?.to_shift_id) return { give: from, get: null };
  return swap.direction === "incoming"
    ? { give: to, get: from }
    : { give: from, get: to };
}
