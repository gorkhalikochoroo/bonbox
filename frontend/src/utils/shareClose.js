/**
 * Share-to-team helper for the multi-terminal close.
 *
 * The "killer differentiator" per Manoj: the closer hits Send → native
 * share sheet opens → they pick WhatsApp / Messenger / email and off
 * the close summary goes to the owner. Same workflow they already use
 * (Excel + photo dump in a Messenger group) but the typing is gone
 * and the numbers are guaranteed correct.
 *
 * Two output paths, one fallback:
 *   1. Web Share API   navigator.share() — iOS 14+, Chrome on Android,
 *                       in-app on Capacitor. The native share sheet
 *                       handles the channel selection.
 *   2. Clipboard       For desktop browsers without share API. Copies
 *                       the formatted text; closer pastes manually.
 *
 * The text is structured Danish by default — restaurant owners speak
 * Danish even when the BonBox UI is in another language, because their
 * recipients (revisor, investor, owner-WhatsApp-group) are in DK.
 */

/**
 * Build the share message body. Pure function — easy to unit test
 * and easy to inject into navigator.share() / clipboard.
 *
 * @param {object} aggregated  the `aggregated` object from /api/kasserapport/aggregate
 * @param {object} opts
 * @param {string} opts.businessName
 * @param {string} opts.dateLabel        e.g. "6.3.2026 (Onsdag)" — caller formats
 * @param {string} opts.currency         "DKK", "EUR" etc
 * @returns {string} multi-line text ready for share / clipboard
 */
export function buildShareMessage(aggregated, { businessName, dateLabel, currency = "DKK" } = {}) {
  if (!aggregated) return "";

  const fmt = (n) =>
    n == null || isNaN(n)
      ? "—"
      : Math.round(Number(n)).toLocaleString("da-DK") + " " + currency;

  const lines = [];
  lines.push(`Lukning ${businessName || ""}${dateLabel ? " – " + dateLabel : ""}`.trim());
  if (aggregated.closed_by) {
    lines.push(`Lukket af: ${aggregated.closed_by}`);
  }
  lines.push(""); // blank separator

  // Card breakdown (per terminal if multi-terminal, single line if not)
  if (Array.isArray(aggregated.terminals) && aggregated.terminals.length > 1) {
    lines.push("Kortbetalinger pr. terminal:");
    for (const t of aggregated.terminals) {
      lines.push(`  ${t.terminal_name}: ${fmt(t.total)}`);
    }
    lines.push(`Kort i alt: ${fmt(aggregated.cards_total)}`);
  } else {
    lines.push(`Kortbetalinger: ${fmt(aggregated.cards_total)}`);
  }

  // Other payment lines — only render if non-zero (cleaner output)
  if (aggregated.cash_closing) {
    lines.push(`Kontant: ${fmt(aggregated.cash_closing)}`);
  }
  if (aggregated.mobilepay_total) {
    lines.push(`MobilePay: ${fmt(aggregated.mobilepay_total)}`);
  }
  if (aggregated.gift_cards_total) {
    lines.push(`Gavekort: ${fmt(aggregated.gift_cards_total)}`);
  }

  lines.push(""); // blank separator
  lines.push(`Total: ${fmt(aggregated.payments_total)}`);
  lines.push(`POS-salg: ${fmt(aggregated.sales_pos)}`);

  // The headline: cash difference + flag indicator
  const diffPrefix = (aggregated.cash_difference || 0) >= 0 ? "+" : "";
  const diffStr = `${diffPrefix}${fmt(aggregated.cash_difference)}`;
  lines.push(`Forskel: ${diffStr}${aggregated.cash_diff_flagged ? " ⚠️" : ""}`);

  if (aggregated.cash_diff_flagged && aggregated.flagged_reason) {
    lines.push("");
    lines.push(`(${aggregated.flagged_reason})`);
  }

  lines.push("");
  lines.push("— sendt fra BonBox");

  return lines.join("\n");
}


/**
 * Build the share title (used by some channels — WhatsApp surfaces
 * `title` as a fallback caption; iMessage uses it as the header).
 * Kept separate from the body so the channel can decide.
 */
export function buildShareTitle({ businessName, dateLabel } = {}) {
  return `Lukning${businessName ? " " + businessName : ""}${dateLabel ? " – " + dateLabel : ""}`.trim();
}


/**
 * Trigger the native share sheet OR fall back to clipboard.
 *
 * Returns:
 *   { ok: true, channel: "share"  }  user shared (or cancelled — both look success)
 *   { ok: true, channel: "clipboard" } copied to clipboard
 *   { ok: false, error: string }       neither worked
 *
 * navigator.share() resolves on success AND on user-cancel — there's
 * no clean way to distinguish. That's fine: even cancel means the
 * sheet opened, which is all we promise.
 */
export async function shareCloseSummary({ title, text }) {
  // Path 1: Web Share API
  if (typeof navigator !== "undefined" && navigator.share && typeof window !== "undefined") {
    try {
      await navigator.share({ title, text });
      return { ok: true, channel: "share" };
    } catch (e) {
      // AbortError = user dismissed the sheet → still considered success
      if (e?.name === "AbortError") {
        return { ok: true, channel: "share" };
      }
      // Anything else falls through to clipboard
    }
  }

  // Path 2: Clipboard fallback
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(`${title}\n\n${text}`);
      return { ok: true, channel: "clipboard" };
    }
  } catch (e) {
    return { ok: false, error: e?.message || "clipboard_failed" };
  }

  return { ok: false, error: "no_share_method_available" };
}


/**
 * Format today's date in Danish "5.3.2026 (Onsdag)" form for the
 * share message header. Pure helper — no DOM access.
 */
export function formatDanishDateLabel(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) return "";
  const day = d.getDate();
  const month = d.getMonth() + 1;
  const year = d.getFullYear();
  const dayNames = [
    "Søndag", "Mandag", "Tirsdag", "Onsdag",
    "Torsdag", "Fredag", "Lørdag",
  ];
  return `${day}.${month}.${year} (${dayNames[d.getDay()]})`;
}
