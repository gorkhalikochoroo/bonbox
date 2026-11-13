/**
 * The door scanner's pace (phone R1, 120 Hz): how often the camera loop
 * (DoorScanPage, one requestAnimationFrame tick per screen frame) hands a
 * frame to jsQR — by the frame clock in ms, never by counting frames.
 *
 * It was every second frame: 30 reads a second at 60 Hz, but 60 on a 120 Hz
 * phone (Chrome's WebView runs requestAnimationFrame at the panel's rate) —
 * twice the CPU and heat on a phone that stands at the door all night, for no
 * faster read. SCAN_GAP_MS = 30: two 60 Hz frames (33.3 ms) are enough and
 * one (16.7) is not, so a 60 Hz phone reads exactly as before (the first
 * ready frame starts the clock, as the old count's frame 1 did); at 90, 120
 * and 144 Hz it is every 3rd, 4th and 5th frame, about 30 reads a second.
 */
export const SCAN_GAP_MS = 30;

/** due(now) → true when this frame should be read; reset() on a new start. */
export function scanPacer(gapMs = SCAN_GAP_MS) {
  let last = null;
  return {
    due(now) {
      if (last == null || now < last) {        // first ready frame, or a clock that went back: start again
        last = now;
        return false;
      }
      if (now - last < gapMs) return false;
      last = now;
      return true;
    },
    reset() {
      last = null;
    },
  };
}
