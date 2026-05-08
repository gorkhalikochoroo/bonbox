/**
 * useSmartTelemetry — log Smart-card outcomes for tuning the inference
 * services.
 *
 * Without this we'll never know whether owners actually trust our
 * proposals. Specifically we want to learn:
 *   • Are "low confidence" proposals accepted blindly? (over-trust risk)
 *   • Are "high confidence" proposals rejected? (our inference is bad)
 *   • Which surface gets edited the most? (where to invest tuning)
 *
 * One event per terminal action:
 *   {
 *     event: "smart_proposal_accepted" | "smart_proposal_edited" | "smart_proposal_cancelled",
 *     page:  "smart_staffing" | "smart_inventory" | "smart_terminals",
 *     detail: JSON.stringify({ confidence, ...extras })
 *   }
 *
 * Privacy:
 *   • Falls back to silent no-op on network failure (telemetry MUST
 *     never block UX).
 *   • Server respects `analytics_opt_out` on the user model — we send
 *     blindly, the server drops if opted out.
 *   • Detail field is sanitised — only known keys get through, no
 *     free-text or item names that would carry tenant data.
 */
import api from "../services/api";

const ALLOWED_PAGES = new Set([
  "smart_staffing",
  "smart_inventory",
  "smart_terminals",
]);

const ALLOWED_EVENTS = new Set([
  "smart_proposal_viewed",
  "smart_proposal_accepted",
  "smart_proposal_edited",
  "smart_proposal_cancelled",
]);

// Whitelist of detail keys we'll send. Anything else is dropped to
// avoid accidentally leaking item names or other tenant data.
const ALLOWED_DETAIL_KEYS = new Set([
  "confidence",
  "proposal_count",
  "edited_count",
  "auto_saved",          // true if high-confidence skipped confirm
  "had_existing",
  "scan_count",
  "vertical",            // business_type — coarse aggregate only
  "drift_kind",          // for drift-banner interactions
]);


function _sanitiseDetail(detail) {
  if (!detail || typeof detail !== "object") return null;
  const out = {};
  for (const k of Object.keys(detail)) {
    if (ALLOWED_DETAIL_KEYS.has(k)) {
      out[k] = detail[k];
    }
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}


export function useSmartTelemetry() {
  function track(event, page, detail = null) {
    if (!ALLOWED_EVENTS.has(event)) return;
    if (!ALLOWED_PAGES.has(page)) return;
    const body = { event, page, detail: _sanitiseDetail(detail) };
    // Fire-and-forget — telemetry must not throw or block.
    api.post("/events", body).catch(() => { /* silently swallow */ });
  }
  return { track };
}
