// The full night's own helpers (booking R12) — imported ONLY by
// FullNightOffer.jsx, so they ride in its lazy chunk and never in the booking
// page's (the page's own helpers are handed over in `host.kit` instead; see
// FullNightOffer.jsx). Plain functions, so the component file exports only
// components.

// The booking form's own bound on how long the page was open (form_ms).
const FORM_MS_MAX = 86_400_000;

// This visit's receipts, by "slug|day|party" — they outlive a change of day
// and back (the chunk stays loaded for the visit). No device storage: the link
// in the address bar is what survives a reload.
const RECEIPTS = new Map();

export const receiptFor = (key) => RECEIPTS.get(key) || null;
export const keepReceipt = (key, receipt) => {
  RECEIPTS.set(key, receipt);
};
export const joinedHere = (id) => [...RECEIPTS.values()].some((r) => r?.id === id);
// For tests: this visit's receipts start empty.
export function resetReceipts() {
  RECEIPTS.clear();
}

// The same shape check as the server's (and the booking form's).
export function phoneOk(value) {
  const v = String(value || "").split(/\s+/).filter(Boolean).join(" ");
  const digits = (v.match(/\d/g) || []).length;
  return digits >= 6 && digits <= 15 && /^\+?[0-9 ()\-./]{6,40}$/.test(v);
}

// How long the page has been open — the booking form's signal. A guest's
// booking page is its own document (a link, or the embed's frame), so the time
// since it loaded is never shorter than the time the guest spent on it.
export function formMs() {
  const now = typeof performance !== "undefined" && performance.now ? performance.now() : 0;
  return Math.min(FORM_MS_MAX, Math.max(0, Math.round(now)));
}

// What a failed join says (the server's codes; 422 bodies are pydantic's).
export function joinErrorOf(err) {
  const status = err?.response?.status;
  const detail = err?.response?.data?.detail;
  const code = typeof detail?.error === "string" ? detail.error : null;
  const text = JSON.stringify(detail || "");
  if (status === 409 && code === "not_full") return "not_full";
  if (status === 409 || status === 410) return "unavailable";
  if (status === 429) return "too_many";
  if (status === 422 && text.includes("invalid_phone")) return "phone";
  if (status === 422 && text.includes("name_required")) return "name";
  return "generic";
}
