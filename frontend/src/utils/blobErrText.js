/**
 * The error message hiding inside a failed file download.
 *
 * THE DEFECT THIS EXISTS FOR. A download is requested with
 * `responseType: "blob"`, so when the server refuses, axios still hands back a
 * Blob — `err.response.data` is a Blob, not an object. `errText()` reaches for
 * `err.response.data.detail`, finds undefined, and returns its generic
 * fallback. So VatReportPage caught a 402 whose body said, in Danish, exactly
 * which cap had been reached and what to do about it:
 *
 *   "Du har brugt dine 2 MOMS PDF-eksporter denne måned. Opgrader til
 *    Starter for 20/md."
 *
 * …and rendered "Could not download the report." The backend had gone to the
 * trouble of READING the cap from PLAN_CAPS rather than typing it, precisely
 * so this sentence could never go stale — and the frontend threw the whole
 * thing away.
 *
 * WHY IT IS ASYNC. Blob.text() is a promise. There is no synchronous way to
 * read it, which is most of why this was skipped.
 *
 * The Danish message is the default because these surfaces are
 * jurisdiction-locked (MOMS, kr, SKAT stay Danish); `message_en` is used when
 * the owner is working in English and the server offered one.
 */
import { errText } from "./errText";

export async function blobErrText(err, fallback, lang = "da") {
  const data = err?.response?.data;

  // Not a blob response — the ordinary path still applies.
  if (!data || typeof data.text !== "function") return errText(err, fallback);

  let parsed = null;
  try {
    const raw = await data.text();
    parsed = JSON.parse(raw);
  } catch {
    // An unreadable or non-JSON body (a truncated download, an HTML error
    // page from a proxy) is not a message. Fall through rather than render
    // whatever bytes arrived.
    return fallback;
  }

  const detail = parsed?.detail;
  if (!detail) return fallback;
  if (typeof detail === "string") return detail;

  const preferred = lang === "en" ? detail.message_en : detail.message;
  return preferred || detail.message || detail.message_en || fallback;
}

export default blobErrText;
