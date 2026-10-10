// Burst scan ("Scan a pile"): send the photos, and send again the ones a busy
// server left unread.
//
// The server stops a pile part-way when every photo-decode slot stays busy:
// the drafts made so far are kept and `busy_from` is the index (in the photos
// it was sent) of the first one it did not read. Those are sent again on
// their own, after a short pause, `resends` times at most. Whatever is still
// unread after that is returned as `left` so the page can name it — a photo
// is never dropped silently.
//
// `post(photos)` sends one request and resolves with the response body.
// A failure on the FIRST request is rethrown (nothing was added, the page
// shows its plain error); a failure on a resend keeps what was already added
// and counts the rest as `left`.

export const BURST_BUSY_RESENDS = 2;
// The server's Retry-After is 10 s; its decode queue clears in a few seconds.
export const BURST_BUSY_PAUSE_MS = 5000;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function scanPileWithResends(
  photos,
  post,
  { resends = BURST_BUSY_RESENDS, pauseMs = BURST_BUSY_PAUSE_MS, sleep = defaultSleep } = {},
) {
  let pending = photos;
  let added = 0;
  let capHit = false;
  let left = 0;
  for (let round = 0; pending.length; round += 1) {
    if (round > 0) await sleep(pauseMs);
    let data;
    try {
      data = await post(pending);
    } catch (err) {
      if (round === 0) throw err;
      left = pending.length;
      break;
    }
    added += data?.created ?? 0;
    capHit = capHit || !!data?.cap_reached;
    const from = data?.busy_from;
    if (typeof from !== "number") break;
    pending = pending.slice(from);
    if (capHit || round >= resends) {
      left = pending.length;
      break;
    }
  }
  return { added, capHit, left };
}
