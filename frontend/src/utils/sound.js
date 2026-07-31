/**
 * alertSound — the live-alert chime for the host stand.
 *
 *   playChime()  — soft two-note ding for a normal booking change.
 *   playUrgent() — sharper triple-pulse for a SEVERE allergy (Art. 9 health
 *                  data: the louder cue is deliberate — a severe allergy is a
 *                  safety event, not just an FYI).
 *
 * WHY THIS IS NOT PURE WEB AUDIO ANY MORE.
 * This module used to be Web Audio only (AudioContext + createOscillator).
 * On iOS the hardware/Control-Centre mute silences the Web Audio path
 * outright, and a door iPad has no physical switch to check — one accidental
 * tap in Control Centre and the severe-allergy beep is gone for the rest of
 * the shift, with nothing on screen saying so. That is a safety defect on the
 * one alert the feature exists for.
 *
 * So the PRIMARY path is now an HTML5 <audio> element playing a WAV we
 * synthesise at runtime (no binary to ship, no network fetch, CSP-safe).
 * Media elements are the only route on iOS that can survive the mute switch.
 *
 * HONESTY, BECAUSE THIS MATTERS. That survival is an observed WebKit
 * behaviour, NOT a documented contract, and it has shifted between iOS
 * versions before. This module therefore does not claim the sound worked — it
 * reports whether playback actually STARTED (`getSoundStatus`), so the UI can
 * show a live "Lyd aktiv / Lyd slået fra" chip. A dead chime must fail
 * visibly. Verify on a real muted iPad before trusting it; an evidenced
 * failure there is the signal to move this to a native AVAudioSession, not a
 * reason to patch around it.
 *
 * Web Audio is kept as a fallback for browsers where the media element is
 * blocked or unavailable.
 */

const SAMPLE_RATE = 44100;

/* ── status, so a silent failure becomes a visible one ────────────────────── */

const STATUS = {
  UNKNOWN: "unknown", // never attempted — no gesture yet
  READY: "ready", // primed by a gesture, playback has started cleanly
  BLOCKED: "blocked", // the browser refused to play (autoplay policy / no gesture)
  UNSUPPORTED: "unsupported", // no usable audio path at all
};

let _status = STATUS.UNKNOWN;
let _lastError = "";
const _listeners = new Set();

function setStatus(next, err = "") {
  if (_status === next && _lastError === err) return;
  _status = next;
  _lastError = err;
  _listeners.forEach((fn) => {
    try {
      fn(getSoundStatus());
    } catch {
      /* a listener must never break playback */
    }
  });
}

/** Current audibility. `ok` false means the host will NOT hear the next alert. */
export function getSoundStatus() {
  return { status: _status, ok: _status === STATUS.READY, error: _lastError };
}

/** Subscribe to audibility changes. Returns an unsubscribe fn. */
export function subscribeSound(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/* ── WAV synthesis ────────────────────────────────────────────────────────── */

/**
 * Render `parts` into a mono 16-bit PCM WAV blob URL.
 * Each part: { freq, start, duration, volume, square } — matching the tones
 * the Web Audio version produced, so the stand sounds the same as before.
 */
function buildWavUrl(parts) {
  const end = Math.max(...parts.map((p) => p.start + p.duration)) + 0.05;
  const frames = Math.ceil(end * SAMPLE_RATE);
  const pcm = new Float32Array(frames);

  for (const p of parts) {
    const from = Math.floor(p.start * SAMPLE_RATE);
    const len = Math.floor(p.duration * SAMPLE_RATE);
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      const phase = 2 * Math.PI * p.freq * t;
      const raw = p.square ? (Math.sin(phase) >= 0 ? 1 : -1) : Math.sin(phase);
      // Exponential decay, mirroring gain.exponentialRampToValueAtTime.
      const decay = Math.exp((-5 * i) / len);
      // Short fade-in kills the click a square wave starts with.
      const attack = Math.min(1, i / (SAMPLE_RATE * 0.004));
      const idx = from + i;
      if (idx < frames) pcm[idx] += raw * p.volume * decay * attack;
    }
  }

  const bytes = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(bytes);
  const ascii = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, clamped * 32767, true);
  }

  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

const CHIME_PARTS = [
  { freq: 880, start: 0, duration: 0.14, volume: 0.5 },
  { freq: 1175, start: 0.13, duration: 0.18, volume: 0.42 },
];
const URGENT_PARTS = [
  { freq: 660, start: 0, duration: 0.12, volume: 0.6, square: true },
  { freq: 880, start: 0.16, duration: 0.12, volume: 0.6, square: true },
  { freq: 660, start: 0.32, duration: 0.16, volume: 0.6, square: true },
];

/* ── the media elements ───────────────────────────────────────────────────── */

const _els = {}; // kind -> HTMLAudioElement

function element(kind) {
  if (_els[kind]) return _els[kind];
  if (typeof Audio === "undefined") return null;
  try {
    const el = new Audio(buildWavUrl(kind === "urgent" ? URGENT_PARTS : CHIME_PARTS));
    el.preload = "auto";
    // Not muted, not looped: this is a foreground alert on a device whose
    // whole job is to be heard.
    // Attached to the document because a detached media element is the less
    // reliable path on iOS; hidden, and it never renders controls.
    try {
      el.setAttribute("aria-hidden", "true");
      el.style.display = "none";
      document.body?.appendChild(el);
    } catch {
      /* detached still plays in every browser we support — not fatal */
    }
    _els[kind] = el;
    return el;
  } catch {
    return null;
  }
}

/**
 * Turn a play() rejection into an audibility verdict.
 *
 * Only an autoplay refusal means the host will not hear the next alert.
 * AbortError specifically does NOT: it is what the browser throws when a
 * pending play() is interrupted by our own pause(), which is exactly what
 * priming does on purpose. Treating it as "blocked" made the stand chip read
 * "Lyd slået fra" on a device whose sound was working perfectly — a false
 * alarm on a safety indicator, which teaches a host to ignore it.
 */
function classify(e) {
  const name = String(e?.name || e || "");
  if (name === "AbortError") return null; // self-inflicted, not a signal
  return name;
}

/**
 * Re-arm audio from a real user gesture. Call on EVERY gesture, not once: on a
 * wall-mounted iPad both audio paths go dormant when the screen locks, so a
 * one-shot unlock would leave the chime silently dead for the rest of a shift.
 *
 * Priming plays each clip muted and rewinds it, which is what buys the right to
 * play later without a gesture.
 */
export function unlockSound() {
  const kinds = ["chime", "urgent"];
  let any = false;

  for (const kind of kinds) {
    const el = element(kind);
    if (!el) continue;
    any = true;
    try {
      const wasMuted = el.muted;
      el.muted = true;
      const p = el.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          el.pause();
          el.currentTime = 0;
          el.muted = wasMuted;
          setStatus(STATUS.READY);
        }).catch((e) => {
          el.muted = wasMuted;
          const reason = classify(e);
          // The element accepted play() and we interrupted it ourselves —
          // that is a successful prime, not a blocked one.
          if (reason === null) setStatus(STATUS.READY);
          else setStatus(STATUS.BLOCKED, reason);
        });
      } else {
        el.pause();
        el.currentTime = 0;
        el.muted = wasMuted;
        setStatus(STATUS.READY);
      }
    } catch (e) {
      setStatus(STATUS.BLOCKED, String(e?.message || e || ""));
    }
  }

  // Keep the Web Audio fallback warm too.
  resumeCtx();
  if (!any && !ctx()) setStatus(STATUS.UNSUPPORTED);
}

export const isSoundUnlocked = () => _status === STATUS.READY;
/** True when audio can't play right now — drives the visible fallback so
 *  "didn't hear it" can never be confused with "was never told". */
export const isSoundBlocked = () => _status === STATUS.BLOCKED || _status === STATUS.UNSUPPORTED;

function play(kind) {
  const el = element(kind);
  if (el) {
    try {
      el.currentTime = 0;
      const p = el.play();
      if (p && typeof p.then === "function") {
        p.then(() => setStatus(STATUS.READY)).catch((e) => {
          const reason = classify(e);
          if (reason === null) return; // interrupted by the next alert, not blocked
          setStatus(STATUS.BLOCKED, reason);
          toneFallback(kind); // last resort
        });
      } else {
        setStatus(STATUS.READY);
      }
      return;
    } catch (e) {
      setStatus(STATUS.BLOCKED, String(e?.message || e || ""));
    }
  }
  toneFallback(kind);
}

/**
 * Play the alert and resolve with whether playback actually STARTED.
 * Used by the stand's "Test lyden" button — the host taps it and finds out
 * now, not during service.
 */
export function testSound(kind = "urgent") {
  const el = element(kind);
  if (!el) {
    toneFallback(kind);
    setStatus(ctx() ? STATUS.READY : STATUS.UNSUPPORTED);
    return Promise.resolve(!!ctx());
  }
  try {
    el.currentTime = 0;
    const p = el.play();
    if (p && typeof p.then === "function") {
      return p
        .then(() => {
          setStatus(STATUS.READY);
          return true;
        })
        .catch((e) => {
          const reason = classify(e);
          if (reason === null) return true; // interrupted, but the element accepted it
          setStatus(STATUS.BLOCKED, reason);
          toneFallback(kind);
          return false;
        });
    }
    setStatus(STATUS.READY);
    return Promise.resolve(true);
  } catch (e) {
    setStatus(STATUS.BLOCKED, String(e?.message || e || ""));
    return Promise.resolve(false);
  }
}

/* ── Web Audio fallback ───────────────────────────────────────────────────── */

let _ctx = null;

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

function resumeCtx() {
  const c = ctx();
  try {
    if (c && c.state === "suspended") c.resume();
  } catch {
    /* ignore */
  }
}

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

function toneFallback(kind) {
  resumeCtx();
  if (kind === "urgent") {
    tone(660, 0, 0.12, 0.07, "square");
    tone(880, 0.16, 0.12, 0.07, "square");
    tone(660, 0.32, 0.16, 0.07, "square");
  } else {
    tone(880, 0, 0.14, 0.06, "sine");
    tone(1175, 0.13, 0.18, 0.05, "sine");
  }
}

/* ── public play API (unchanged signatures) ───────────────────────────────── */

/** Soft, friendly two-note ding for a normal booking change. */
export function playChime() {
  play("chime");
}

/** Sharper triple-pulse for a severe allergy — distinctly more alarming. */
export function playUrgent() {
  play("urgent");
}
