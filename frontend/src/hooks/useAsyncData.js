/**
 * Three outcomes, never two.
 *
 * THE DEFECT THIS EXISTS TO REMOVE. Nine list fetchers across the product were
 * written `api.get(...).then(setRows).catch(() => {})`. The rows stay `[]`, the
 * page falls through to its empty state, and the owner is told the reassuring
 * thing instead of the true one:
 *
 *   • the kasserapport history said "Submit your first end-of-day close" to an
 *     owner with a year of closes — and because today's lock status was derived
 *     from that same empty array, the page re-offered a close it had already
 *     locked ten minutes earlier;
 *   • a failed week in Vagtplan looked like an empty week, and the page then
 *     labelled it "Published";
 *   • the Cash Book said the drawer had no transactions;
 *   • the bell said "All clear" when it had not managed to ask.
 *
 * "Nothing here" and "I couldn't check" are different facts and the second one
 * is the one worth saying, because it is the one the owner can act on — retry,
 * or trust the number they already had. Collapsing them always picks the
 * comforting answer, which is the one that costs trust when it turns out to be
 * wrong. Same rule as the money surfaces: a missing number renders "—", never
 * a confident 0.
 *
 * NOT A NEW PATTERN. BranchSummaryView in DailyClosePage already did this
 * correctly — loading → words, `failed` → SectionBanner + Try again, then data
 * or empty — and so do prefillStatus, exemptStatus and the 403 split in
 * StaffHoursPage. This is that shape lifted into one place so the remaining
 * callers cannot each re-decide it. Behaviour is deliberately identical.
 *
 *   const shifts = useAsyncData(() => api.get("/staff/shifts"), [weekStart]);
 *   if (shifts.loading) return <Skeleton />;
 *   if (shifts.failed)  return <LoadFailed onRetry={shifts.reload} />;
 *   if (!shifts.data?.length) return <Empty />;   // now a REAL empty
 *
 * `data` stays at its previous value through a reload, so a refresh that fails
 * leaves the owner looking at the last numbers that were actually true rather
 * than blanking the screen — paired with `failed`, which says they are stale.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * @param {() => Promise<any>} fetcher  Returns the axios promise. Its `.data`
 *   is unwrapped for you; return anything else and you get it verbatim.
 * @param {any[]} deps  Re-runs when these change, like useEffect.
 * @param {{ initial?: any, enabled?: boolean }} [options]
 *   `enabled: false` holds the request (a tab that has not been opened, a
 *   permission still resolving) WITHOUT reporting failure — an un-asked
 *   question has no answer, which is the third state's whole point.
 */
export function useAsyncData(fetcher, deps = [], options = {}) {
  const { initial = null, enabled = true } = options;
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(enabled);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState(null);

  // The fetcher is almost always an inline arrow, so depending on it directly
  // would re-run every render. The caller's `deps` are the contract.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Guards a late response from a superseded request overwriting a newer one —
  // the owner clicks through three weeks fast and the slowest reply wins.
  const runIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!enabled) return;
    const runId = ++runIdRef.current;
    setLoading(true);
    setFailed(false);
    setError(null);
    try {
      const res = await fetcherRef.current();
      if (runId !== runIdRef.current) return;
      setData(res && typeof res === "object" && "data" in res ? res.data : res);
    } catch (e) {
      if (runId !== runIdRef.current) return;
      // `data` is deliberately NOT cleared. Stale-but-true beats blank, and
      // `failed` is what tells the page to say so.
      setFailed(true);
      setError(e);
    } finally {
      if (runId === runIdRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    load();
    // Superseding rather than aborting: the runId check above makes a late
    // reply harmless, and there is no request to cancel that axios would not
    // already have sent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  return {
    data,
    loading,
    failed,
    error,
    /** Re-run. Pass straight to a Try again button. */
    reload: load,
    /** True only when the request genuinely came back with nothing. */
    isEmpty: !loading && !failed && (data == null || (Array.isArray(data) && data.length === 0)),
    /** Let a page write its own copy while keeping the same three states. */
    setData,
  };
}

export default useAsyncData;
