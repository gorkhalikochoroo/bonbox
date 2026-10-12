/**
 * staffInvite — the one invitation an owner sends a staffer, and the three
 * ways it leaves the owner's phone (SMS, WhatsApp, copy).
 *
 * BonBox sends nothing here. Every channel is a hand-off to an app on the
 * owner's own device: `sms:` opens Messages with the text filled in, wa.me
 * opens WhatsApp, and copy puts the same text on the clipboard. That is the
 * same promise FirstStepsPage makes ("BonBox sender ingen sms").
 *
 * ONE message for every channel, so a staffer who gets it by SMS and one who
 * gets it pasted into a WhatsApp group read the same thing: who it is from,
 * their personal link (the way in that needs nothing installed), and — for
 * the ones who prefer it — the Vagtplan app and the code that signs them in.
 *
 * Pure, so it is tested without mounting the 9k-line schedule page.
 */

/** The staff app on the App Store (BonBox Vagtplan, id 6787010793). */
export const VAGTPLAN_APP_URL = "https://apps.apple.com/dk/app/bonbox-scheduler/id6787010793";

/** A staffer's first name, for a greeting ("Sofie Holm" → "Sofie"). */
export function firstName(name) {
  const clean = String(name || "").trim();
  return clean.split(/\s+/)[0] || clean;
}

/**
 * The invitation text.
 *
 * @param {object} p
 * @param {(key: string, vars?: object) => string} p.t
 * @param {string} p.name       staffer's name
 * @param {string} p.restaurant the venue's name
 * @param {string} p.url        their personal portal link (absolute)
 * @param {string} [p.code]     their 6-character join code, when known
 * @returns {string}
 */
export function inviteMessage({ t, name, restaurant, url, code }) {
  const lines = [
    t("staffInviteMsgHello", { name: firstName(name), restaurant: restaurant || "BonBox" }),
    url,
    "",
    `${t("shareCopyAppLine")}: ${VAGTPLAN_APP_URL}`,
  ];
  if (code) lines.push(t("staffInviteMsgCode", { code }));
  return lines.join("\n");
}

/**
 * The number WhatsApp's wa.me wants: digits only, country code first, no "+".
 * A bare 8-digit number is Danish (the product is DK-first and the add form
 * does not ask for a country), so it gets 45. Anything else is passed through
 * as typed, minus formatting. "" when there is no number — wa.me/?text= then
 * lets the owner pick the chat.
 */
export function whatsappNumber(phone) {
  const raw = String(phone || "").trim();
  if (!raw) return "";
  if (raw.startsWith("+")) return raw.slice(1).replace(/\D/g, "");
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) return digits.slice(2);
  if (digits.length === 8) return `45${digits}`;
  return digits;
}

/** sms: link with the text filled in. `?&body=` is the form both iOS and Android read. */
export function smsHref(phone, body) {
  const to = String(phone || "").replace(/[^\d+]/g, "");
  return `sms:${to}?&body=${encodeURIComponent(body)}`;
}

/** wa.me link with the text filled in (to the number when there is one). */
export function whatsappHref(phone, body) {
  return `https://wa.me/${whatsappNumber(phone)}?text=${encodeURIComponent(body)}`;
}

/**
 * Can this device hand a text to a messages app? Phones and tablets can, and so
 * can a Mac (Messages). A Windows or Linux desktop has nothing registered for
 * `sms:`, and a button that does nothing when tapped is a dead end — so there
 * the sheet offers WhatsApp and copy only.
 */
export function canSendSms(nav = typeof navigator !== "undefined" ? navigator : null) {
  if (!nav) return false;
  const ua = String(nav.userAgent || "");
  if (/iPhone|iPad|iPod|Android|Macintosh|Mac OS X/i.test(ua)) return true;
  return Number(nav.maxTouchPoints || 0) > 0 && !/Windows/i.test(ua);
}
