/**
 * Which stock rows Home is allowed to call "reorder needed".
 *
 * THE DEFECT. Home rendered "Reorder needed (23)" while /inventory — the page
 * that card navigates to — rendered its empty state, for the same 23 rows at
 * the same moment. They were pour-tracked bar-template bottles at quantity 0
 * that nothing had ever sold or logged: invisible on /inventory (it drops
 * pour-tracked rows) and not urgent by any honest reading (an untouched
 * placeholder is not a stock-out).
 *
 * THE RULE NOW LIVES SERVER-SIDE, in app/services/inventory_reorder.py, and
 * for a reason this file cannot work around: the second half of it asks
 * whether the venue actually sells the item, which needs sales and stock-log
 * history the browser never receives. So /dashboard/batch stamps each row with
 * `needs_reorder` and the card reads that field — it does not recompute
 * anything from quantity and min_threshold.
 *
 * WHICH ROWS. Feed this `inventory_reorder` — the payload's complete flagged
 * set — and never `inventory`, which is a 50-row DISPLAY sample. Counting the
 * flagged rows of a sample makes the number a count of the sample: on a
 * 316-row account whose low rows were older than its newest 50, the card
 * rendered nothing while /inventory read "Low stock (6)". Same two screens
 * disagreeing, opposite direction, and harder to notice because the honest-
 * looking answer is silence.
 *
 * WHY STRICT `=== true` AND NOT A FALLBACK. If the field is absent — an older
 * backend deploy, a cached payload — we have not learned that nothing is low;
 * we have failed to check. Falling back to the old `qty <= min` arithmetic
 * would resurrect the exact lie this replaces, and it would do it silently.
 * The card therefore shows nothing until the backend answers. A missing alert
 * costs the owner a glance at /inventory; a false one costs their trust in
 * every number on the page.
 */

/**
 * @param {Array<object>} items — rows from /dashboard/batch `inventory_reorder`.
 * @returns {Array<object>} the rows the backend flagged for reorder.
 */
export function reorderNeededItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((i) => i?.needs_reorder === true);
}
