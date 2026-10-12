import { formatDateClearFull } from "./dateFormat";

/** The local date a cancelled subscription ends ("12. nov. 2026"), or null.
 *  /billing/me sends subscription_cancel_at (naive UTC ISO) when the owner
 *  cancelled and Stripe will not charge again; only shown while the
 *  subscription is still running (active / trialing). */
export function cancelDateLabel(billing) {
  const iso = billing?.subscription_cancel_at;
  if (!iso || !["active", "trialing"].includes(billing?.subscription_status)) return null;
  const d = new Date(/([zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return null;
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return formatDateClearFull(local);
}
