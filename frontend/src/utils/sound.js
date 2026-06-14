/**
 * alertSound — one shared Web Audio chime for the live-alert bell.
 *
 * Programmatic tones (no audio file to ship), same approach as DoorScanPage's
 * scan beep. Browsers start an AudioContext "suspended" until a real user
 * gesture, so `unlockSound()` must be called once from a click/tap (the
 * provider wires it to the first interaction) — otherwise a poll-triggered
 * beep would be silently dropped.
 *
 *   playChime()  — soft two-note ding for a normal booking change.
 *   playUrgent() — sharper triple-pulse for a SEVERE allergy (Art. 9 health
 *                  data: the louder cue is deliberate — a severe allergy is a
 *                  safety event, not just an FYI).
 */
let _ctx = null;
let _unlocked = false;
let _blocked = false; // audio is suspended/blocked right now (screen locked, no gesture)

function ctx() {
  if (_ctx) return _ctx;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    _ctx = new Ctor();
  } catch {
    return null;
  }
  return _ctx;
}

/**
 * Re-arm audio from a real user gesture. Call this on EVERY gesture (not once):
 * on a wall-mounted iPad the AudioContext suspends when the screen locks, so a
 * one-shot unlock would leave the chime silently dead for the rest of the shift.
 * Re-resuming on each tap keeps it alive; _blocked tracks whether sound is
 * currently unavailable so the UI can show a visible fallback for a severe alert.
 */
export function unlockSound() {
  const c = ctx();
  if (!c) {
    _blocked = true;
    return;
  }
  try {
    const p = c.resume?.();
    if (p && typeof p.then === "function") {
      p.then(() => {
        _unlocked = c.state === "running";
        _blocked = !_unlocked;
      }).catch(() => {
        _blocked = true;
      });
    }
    _unlocked = c.state === "running";
    _blocked = c.state !== "running" && c.state !== "suspended";
  } catch {
    _blocked = true;
  }
}

export const isSoundUnlocked = () => _unlocked;
/** True when audio can't play right now (locked/blocked) — drives the visible
 *  fallback banner for a severe allergy so "didn't hear it" ≠ "never saw it". */
export const isSoundBlocked = () => _blocked;

function tone(freq, startOffset, duration, volume = 0.06, type = "sine") {
  const c = ctx();
  if (!c) return;
  try {
    const t0 = c.currentTime + startOffset;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, t0);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    gain.gain.exponentialRampToValueAtTime(0.00001, t0 + duration);
    osc.stop(t0 + duration + 0.03);
  } catch {
    /* swallow — audio is best-effort */
  }
}

function resume() {
  const c = ctx();
  try {
    if (c && c.state === "suspended") c.resume();
  } catch {
    /* ignore */
  }
}

/** Soft, friendly two-note ding for a normal booking change. */
export function playChime() {
  resume();
  tone(880, 0, 0.14, 0.06, "sine");
  tone(1175, 0.13, 0.18, 0.05, "sine");
}

/** Sharper triple-pulse for a severe allergy — distinctly more alarming. */
export function playUrgent() {
  resume();
  tone(660, 0, 0.12, 0.07, "square");
  tone(880, 0.16, 0.12, 0.07, "square");
  tone(660, 0.32, 0.16, 0.07, "square");
}
