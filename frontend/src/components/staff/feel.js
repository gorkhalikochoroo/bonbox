import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { platform } from "../../utils/platform";

// Vagtplan's haptic words (Nov 2026, premium feel P2). One per action, on the
// outcome; navigation is silent. iOS app: the Taptic Engine. Android app:
// done, warn and fail only, and warn plays the two-tap ERROR pattern
// (Capacitor 8.0.2's Android WARNING is one 210 ms full buzz; its light and
// selection are 50-100 ms motor pulses). Web link: nothing.
//
// The clock's own lines (`haptic.*` inside act / breakAct) do not come
// through here: they stay on utils/haptics.js, byte for byte.
export const OUTCOME_GAP_MS = 1500;   // two answers landing together never buzz twice
export const WARM_MS = 2000;
let lastOutcome = -Infinity;
let warmUntil = 0;
let warmTimer = 0;
const iosApp = () => platform.isNative && platform.isIOS;
// Fire and forget: a missing plugin, a sync throw or a rejected promise never escapes.
const quiet = (fn) => { try { Promise.resolve(fn()).catch(() => {}); } catch { /* never throws */ } };
function outcome(fn) {
  if (!platform.isNative) return;
  const now = Date.now();
  if (now - lastOutcome < OUTCOME_GAP_MS) return;
  lastOutcome = now;
  quiet(fn);
}
const note = (type) => () => Haptics.notification({ type });
// iOS plays selectionChanged ONLY between selectionStart and selectionEnd (the
// plugin keeps no generator otherwise), so a tick warms itself when nothing
// warmed it.
function warmIos() {
  const now = Date.now();
  if (now >= warmUntil) quiet(() => Haptics.selectionStart());
  warmUntil = now + WARM_MS;
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => { warmUntil = 0; quiet(() => Haptics.selectionEnd()); }, WARM_MS);
}
export const feel = {
  /** The server said yes to something that matters. */
  done: () => outcome(note(NotificationType.Success)),
  /** Refused, or needs attention. Android: the two-tap error pattern (call E). */
  warn: () => outcome(note(platform.isAndroid ? NotificationType.Error : NotificationType.Warning)),
  /** Could not do it (network, server). */
  fail: () => outcome(note(NotificationType.Error)),
  /** A routine thing went through. iOS app only (call E). */
  soft: () => { if (iosApp()) outcome(() => Haptics.impact({ style: ImpactStyle.Light })); },
  /** pointerdown on a tab, switch, radio or segment: the tick on change then has no lag. */
  warm: () => { if (iosApp()) warmIos(); },
  /** A value changed in a picker, switch or segment. iOS app only; not throttled. */
  tick: () => { if (!iosApp()) return; warmIos(); quiet(() => Haptics.selectionChanged()); },
};
export function resetFeelForTests() { lastOutcome = -Infinity; warmUntil = 0; clearTimeout(warmTimer); }
