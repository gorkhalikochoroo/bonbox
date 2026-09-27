/**
 * apiActivity — how many API requests are in flight, and "tell me when it
 * goes quiet".
 *
 * services/api.js reports every request's start and final answer here. A page
 * that assembles itself from several self-loading cards can wait for them to
 * finish and show itself in one go, instead of each late card pushing the rest
 * down (DashboardPage). Its own module — not part of api.js — so tests that
 * stub the API client still get a working tracker (it simply reads zero).
 */
let inflight = 0;
const quietListeners = new Set();

export function requestStarted() {
  inflight += 1;
}

export function requestSettled() {
  inflight = Math.max(0, inflight - 1);
  if (inflight === 0) quietListeners.forEach((fn) => fn());
}

/**
 * Call `fn` once no request has been in flight for `quietMs`. Returns an
 * unsubscribe function.
 */
export function onApiIdle(fn, quietMs = 120) {
  let timer = null;
  let done = false;
  const arm = () => {
    if (done) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (inflight === 0 && !done) {
        done = true;
        quietListeners.delete(arm);
        fn();
      }
    }, quietMs);
  };
  quietListeners.add(arm);
  if (inflight === 0) arm();
  return () => {
    done = true;
    clearTimeout(timer);
    quietListeners.delete(arm);
  };
}
