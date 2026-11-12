// The door screen's haptic words (phone R1) — what components/staff/feel.js
// is, in the door screen's own build only. feel.js imports the Capacitor
// haptics plugin; the door screen is always the web (stand.html is never
// loaded by the app), so its words are silent here and the Capacitor runtime
// stays out of its budget. Same exports as feel.js (r11.standBuild checks).
const none = () => {};

export const OUTCOME_GAP_MS = 1500;
export const WARM_MS = 2000;
export const feel = {
  done: none,
  warn: none,
  fail: none,
  soft: none,
  warm: none,
  tick: none,
};
export function resetFeelForTests() {}
