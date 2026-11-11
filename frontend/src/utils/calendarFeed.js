/**
 * The staffer's shift feed — "Tilføj til kalender" in the staff app.
 *
 * The feed is the staffer's OWN: its URL carries their portal token (and, on
 * a PIN-protected link, the calendar key the server hands over once the PIN
 * is proven, because a calendar app cannot send the PIN header). Personal —
 * built only for that staffer's own tap, never logged or sent anywhere else.
 *
 *   iPhone / iPad / desktop — webcal: opens the OS "Subscribe" dialog.
 *   Android — nothing handles webcal: (not the app's WebView, not Chrome), so
 *   the tap opened nothing at all. Google Calendar's add-by-URL page is the
 *   nearest thing; Google itself says a phone cannot finish a subscription
 *   (support.google.com/calendar/answer/37100), so the staff app never claims
 *   it worked, and offers the https feed to copy as well.
 */

/** The https feed for `token` (with `?k=` on a PIN link). */
export function scheduleFeedUrl(baseURL, token, calendarKey) {
  const base = (baseURL || "https://api.bonbox.dk/api").replace(/\/+$/, "");
  return `${base}/portal/${token}/schedule.ics${calendarKey ? `?k=${encodeURIComponent(calendarKey)}` : ""}`;
}

/** The same feed as a webcal: subscription. */
export const webcalUrl = (url) => String(url).replace(/^https?:/, "webcal:");

/** Google Calendar's add-by-URL page for the feed. `cid` is the webcal: form,
    fully encoded so a `?k=` inside it survives as part of the feed. The link
    is long-standing but undocumented — best effort, never a promise. */
export const googleSubscribeUrl = (feedUrl) =>
  `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcalUrl(feedUrl))}`;
