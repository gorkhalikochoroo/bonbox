import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import api from "../services/api";
import { getCookieConsent } from "../components/CookieConsent";

// The cookie banner's "Analytics" choice says it "helps us understand which
// features are useful and where the app breaks" — which is exactly this log.
// An owner who DECLINED it was still being logged on every page. A decline now
// stops it: nothing is queued, and anything queued before the choice is
// dropped rather than sent. (Before any choice, this first-party log — no
// cookie, nothing stored on the device — runs as before.)
// Exported so every client-side usage event (useSmartTelemetry too) obeys the
// same "no".
export function analyticsDeclined() {
  const c = getCookieConsent();
  return !!c && c.analytics === false;
}

// Queue events and flush periodically to avoid too many API calls
let eventQueue = [];
let flushTimer = null;

function flushEvents() {
  if (eventQueue.length === 0) return;
  if (analyticsDeclined()) {
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
  api.post("/event-log/batch", { events: batch }).catch(() => {
    // silently fail — don't interrupt user experience
  });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushEvents();
  }, 5000); // flush every 5 seconds
}

export function trackEvent(event, page = null, detail = null) {
  if (analyticsDeclined()) return;
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
