/**
 * Share-to-accountant helper for the multi-day daily close range PDF.
 *
 * The whole point of the range export: the bookkeeper gets one clean
 * file per week or per month. This utility takes the workflow from
 * "download → open Mail → attach → type recipient → type subject →
 * type body → send" down to one tap.
 *
 * Three output paths in priority order:
 *
 *   1. Web Share API with files (navigator.share with files)
 *      iOS 16+, Chrome on Android, Capacitor — opens the native share
 *      sheet with the PDF pre-attached. The user picks Mail / WhatsApp
 *      / AirDrop / Messages and it goes. Best UX, single tap.
 *
 *   2. mailto: + manual attach
 *      Desktop browsers without file-share support. We download the
 *      file, then open mailto: with the To/Subject/Body pre-filled.
 *      The user drags the just-downloaded file into the email window.
 *      Imperfect but standard — every email client works.
 *
 *   3. Plain download
 *      Privacy mode / browsers without mailto handler. Just download
 *      the file and let the user handle the rest.
 *
 * Body template is Danish by default — kasserapport recipients
 * (accountant, revisor) speak Danish even when the BonBox UI isn't.
 */


/**
 * Build the email subject for an accountant handoff.
 *
 *   "Kasserapport · Mirabelle · 1.5.2026 → 7.5.2026"
 *
 * Pure function — easy to unit test.
 */
export function buildAccountantSubject({ businessName, fromIso, toIso, language = "da" } = {}) {
  const parts = [];
  if (language === "en") {
    parts.push("Daily Close Report");
  } else {
    parts.push("Kasserapport");
  }
  if (businessName) parts.push(businessName);
  if (fromIso && toIso) {
    if (fromIso === toIso) {
      parts.push(formatShortDate(fromIso, language));
    } else {
      parts.push(`${formatShortDate(fromIso, language)} → ${formatShortDate(toIso, language)}`);
    }
  }
  return parts.join(" · ");
}


/**
 * Build the email body for an accountant handoff.
 *
 * Default Danish; English fallback when language === "en".
 * Always polite, business-formal — the recipient is a professional.
 */
export function buildAccountantBody({
  businessName,
  fromIso,
  toIso,
  closeCount,
  accountantName,
  language = "da",
} = {}) {
  const greet = accountantName ? `Hej ${accountantName},` : "Hej,";
  const greetEn = accountantName ? `Hi ${accountantName},` : "Hi,";

  if (language === "en") {
    const lines = [
      greetEn,
      "",
      `Attached is the daily close report for ${formatShortDate(fromIso, "en")} to ${formatShortDate(toIso, "en")}` +
      (closeCount ? ` (${closeCount} close${closeCount === 1 ? "" : "s"}).` : "."),
      "",
      "Let me know if you need anything else.",
      "",
      `Best regards,`,
      businessName || "",
      "",
      "— sent from BonBox",
    ];
    return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
  }

  // Danish (default)
  const lines = [
    greet,
    "",
    `Vedlagt finder du kasserapport for perioden ${formatShortDate(fromIso, "da")} → ${formatShortDate(toIso, "da")}` +
    (closeCount ? ` (${closeCount} lukning${closeCount === 1 ? "" : "er"}).` : "."),
    "",
    "Sig endelig til hvis du mangler noget.",
    "",
    "Med venlig hilsen,",
    businessName || "",
    "",
    "— sendt fra BonBox",
  ];
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}


/**
 * Format a YYYY-MM-DD ISO date as "1.5.2026" (Danish) or "1 May 2026"
 * (English). Pure helper, no DOM access.
 */
export function formatShortDate(iso, language = "da") {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  if (language === "en") {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
  }
  return `${parseInt(d, 10)}.${parseInt(m, 10)}.${y}`;
}


/**
 * Detect whether the browser can share files via Web Share API.
 *
 * Web Share Level 2 with files is supported on:
 *   • iOS 16+ Safari
 *   • Chrome on Android (recent)
 *   • Edge on Android
 *   • Capacitor (native iOS / Android)
 *
 * NOT supported on:
 *   • Desktop Safari, Firefox, most desktop browsers
 *   • Older mobile browsers
 *
 * Best-effort feature detection — we test the canShare() probe with
 * a single-byte sentinel file. Returns false on any error so we fall
 * through to mailto/download safely.
 */
function canShareFiles() {
  try {
    if (typeof navigator === "undefined") return false;
    if (typeof navigator.share !== "function") return false;
    if (typeof navigator.canShare !== "function") return false;
    const probe = new File([new Uint8Array([0])], "probe.pdf", { type: "application/pdf" });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}


/**
 * Attempt to share the PDF via the native share sheet.
 *
 * @param {Blob} blob       — PDF blob from the export endpoint
 * @param {string} filename — suggested filename for the shared file
 * @param {object} opts
 * @param {string} opts.title  — share-sheet title (e.g. "Kasserapport · Mirabelle")
 * @param {string} opts.text   — body text included alongside the file
 * @returns {Promise<{ok: boolean, channel?: string, reason?: string}>}
 */
async function shareViaSheet(blob, filename, { title, text } = {}) {
  if (!canShareFiles()) return { ok: false, reason: "no_file_share_api" };

  try {
    const file = new File([blob], filename, { type: blob.type || "application/pdf" });
    if (!navigator.canShare({ files: [file] })) {
      return { ok: false, reason: "cannot_share_this_file_type" };
    }
    await navigator.share({ files: [file], title, text });
    return { ok: true, channel: "share" };
  } catch (e) {
    // AbortError = user dismissed → still considered "ok" (we showed the sheet)
    if (e?.name === "AbortError") return { ok: true, channel: "share" };
    return { ok: false, reason: e?.message || "share_failed" };
  }
}


/**
 * Download the blob to disk as a file.
 *
 * Pure DOM operation — used both as the desktop-fallback for share
 * and as the prelude to opening mailto: (so the user has a file to
 * attach by the time the email window opens).
 */
function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // Defer revoke so Safari has time to start the download.
  setTimeout(() => {
    a.remove();
    window.URL.revokeObjectURL(url);
  }, 1000);
}


/**
 * Open the user's default email client with To/Subject/Body
 * pre-filled. The user attaches the just-downloaded file manually.
 *
 * mailto: cannot attach files — that's a long-standing browser
 * security/privacy restriction. The pattern is: download first,
 * then mailto. The user drags the file into the email window.
 */
function openMailto({ to, subject, body }) {
  const params = new URLSearchParams();
  if (subject) params.set("subject", subject);
  if (body) params.set("body", body);
  // mailto: uses ; or , to separate addresses; URLSearchParams encodes
  // safely. RFC 2368 says To: comes before the ?.
  const qs = params.toString().replace(/\+/g, "%20"); // mailto wants %20 not +
  const href = `mailto:${to ? encodeURIComponent(to) : ""}${qs ? "?" + qs : ""}`;
  // Use location.href rather than window.open so popup blockers don't
  // eat the email client launch.
  window.location.href = href;
}


/**
 * Send a daily close range PDF to the accountant.
 *
 * Top-level orchestrator — picks the best channel available:
 *   1. Web Share API with files → native share sheet, single tap
 *   2. mailto: + auto-download → email pre-filled, user attaches
 *   3. plain download → fallback for any other failure
 *
 * @param {object} params
 * @param {Blob} params.blob               PDF blob
 * @param {string} params.filename         suggested filename
 * @param {string} params.accountantEmail  recipient (optional — user
 *                                          can save it on their profile)
 * @param {string} params.accountantName
 * @param {string} params.businessName
 * @param {string} params.fromIso          range start (YYYY-MM-DD)
 * @param {string} params.toIso            range end (YYYY-MM-DD)
 * @param {number} params.closeCount       number of closes in range
 * @param {string} params.language         "da" (default) | "en"
 * @returns {Promise<{ok: boolean, channel: string, reason?: string}>}
 */
export async function sendDailyCloseRangeToAccountant({
  blob,
  filename,
  accountantEmail,
  accountantName,
  businessName,
  fromIso,
  toIso,
  closeCount,
  language = "da",
}) {
  const subject = buildAccountantSubject({ businessName, fromIso, toIso, language });
  const body = buildAccountantBody({
    businessName, fromIso, toIso, closeCount, accountantName, language,
  });

  // Path 1 — native file share sheet (mobile / Capacitor)
  const shareResult = await shareViaSheet(blob, filename, {
    title: subject,
    text: body,
  });
  if (shareResult.ok) {
    return shareResult;
  }

  // Path 2 — download + mailto (desktop / browsers without file-share)
  // The order matters: download FIRST so the file exists in Downloads
  // by the time the email client opens. Otherwise the user hits
  // "Attach" and fumbles for a file that hasn't landed yet.
  try {
    downloadBlob(blob, filename);
    // Small delay so the download is queued before the mailto launch
    // takes window focus away from the page.
    await new Promise(r => setTimeout(r, 200));
    openMailto({ to: accountantEmail, subject, body });
    return { ok: true, channel: "mailto" };
  } catch (e) {
    // Path 3 — last resort: just download. Better than nothing.
    return { ok: false, channel: "download", reason: e?.message || "mailto_failed" };
  }
}
