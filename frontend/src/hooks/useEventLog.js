import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import api from "../services/api";
import { getCookieConsent } from "../components/CookieConsent";

// The cookie banner's "Analytics" choice says it "helps us understand which
// features are useful" — which is exactly this log. (Crash reports are not
// part of it: they go to the error log, which /privacy lists separately.)
// R-h (LEG-10): usage events leave this browser only after an explicit "yes"
// to Analytics in the cookie banner (or "Accept all"). No answer yet, or a
// "no", means nothing is queued, and anything queued before the answer is
// dropped rather than sent. The server side (Profile → pause, plan-limit
// rows the server writes itself) is unchanged.
// Exported so every client-side usage event (useSmartTelemetry too) obeys
// the same rule.

// Usage events leave this browser only after an explicit "yes" to Analytics
// in the cookie banner (or "Accept all"). No answer = nothing is queued or sent.
export function analyticsAllowed() {
  const c = getCookieConsent();
  return !!c && c.analytics === true;
}

// An explicit "no" to Analytics (unchanged meaning; kept for its callers).
export function analyticsDeclined() {
  const c = getCookieConsent();
  return !!c && c.analytics === false;
}

// Queue events and flush periodically to avoid too many API calls
let eventQueue = [];
let flushTimer = null;

function flushEvents() {
  if (eventQueue.length === 0) return;
  if (!analyticsAllowed()) {
    eventQueue = [];
    return;
  }
  const batch = [...eventQueue];
  eventQueue = [];
  // Migration 013 (kulturarrangør sprint): the `/api/events` namespace
  // now belongs to the cultural-event entity CRUD (Sudip-style customers
  // tagging Sales by which event a row belongs to). Analytics telemetry
  // moved to `/api/event-log`. The wire shape ({events: [...]}) and the
  // GDPR opt-out handling are unchanged.
  // Silently fail — don't interrupt user experience. Guarded against a
  // poster that throws or answers with no promise (a stubbed api in a test
  // whose mock was reset while this 5 s timer was pending surfaced as an
  // uncaught TypeError and failed the whole run).
  try {
    const sent = api.post("/event-log/batch", { events: batch });
    if (sent && typeof sent.catch === "function") sent.catch(() => {});
  } catch { /* silently fail */ }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushEvents();
  }, 5000); // flush every 5 seconds
}

export function trackEvent(event, page = null, detail = null) {
  if (!analyticsAllowed()) return;
  eventQueue.push({ event, page, detail });
  scheduleFlush();
}

// Flush on page unload
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushEvents);
}

// Hook to auto-track page views
export function usePageTracking() {
  const location = useLocation();
  const lastPath = useRef("");

  useEffect(() => {
    const path = location.pathname;
    if (path === lastPath.current) return;
    lastPath.current = path;

    const pageName = path === "/" ? "dashboard" : path.replace("/", "");
    trackEvent("page_view", pageName);
  }, [location.pathname]);
}
