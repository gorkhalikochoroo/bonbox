/**
 * alertSound — the live-alert chime for the host stand.
 *
 *   playChime()  — soft rising two-note chime: a new booking or a change.
 *   playCancel() — the same chime falling: a booking was cancelled.
 *   playUrgent() — a distinct triple-pulse for a SEVERE allergy (Art. 9 health
 *                  data: the stronger cue is deliberate — a severe allergy is
 *                  a safety event, not just an FYI). Three pulses on a
 *                  different interval, a touch louder than the chime — no
 *                  longer a square-wave alarm (see SOUND SET below).
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
 * Each part is either a mallet note { freq, start, duration, volume, attack,
 * decay, partials } (every alert today) or a plain tone { freq, start,
 * duration, volume, square } (kept for callers that want one).
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
      let v;
      if (p.partials) {
        // A soft mallet note: sine partials, each ringing out on its own
        // (upper ones die first, so the note mellows as it rings), a rounded
        // 12 ms attack instead of a click, and a short fade at the end.
        let raw = 0;
        for (const [mult, amp, decayFactor] of p.partials) {
          raw += amp * Math.sin(2 * Math.PI * p.freq * mult * t) * Math.exp(-t / (p.decay * decayFactor));
        }
        const x = Math.min(1, t / p.attack);
        const attack = 0.5 - 0.5 * Math.cos(Math.PI * x);
        const fadeOut = Math.min(1, (len - i) / (SAMPLE_RATE * 0.04));
        v = raw * p.volume * attack * fadeOut;
      } else {
        const phase = 2 * Math.PI * p.freq * t;
        const raw = p.square ? (Math.sin(phase) >= 0 ? 1 : -1) : Math.sin(phase);
        // Exponential decay, mirroring gain.exponentialRampToValueAtTime.
        const decay = Math.exp((-5 * i) / len);
        // Short fade-in kills the click a square wave starts with.
        const attack = Math.min(1, i / (SAMPLE_RATE * 0.004));
        v = raw * p.volume * decay * attack;
      }
      const idx = from + i;
      if (idx < frames) pcm[idx] += v;
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

/*
 * SOUND SET.
 *
 * Sep 2026: the old 880/1175 Hz blip read as an irritating beep, so booking
 * and cancel became one family of soft mallet notes (E5/B5). On 27 Sep the
 * severe-allergy alarm was kept as a sharp square-wave triple-beep on purpose.
 *
 * 12 Oct 2026: Manoj still found the set "a bit high, irritating" and chose
 * the softest of three rendered options. Everything moved down an octave onto
 * WARM partials (no inharmonic "tok"), quieter and with a longer ring:
 *   chime  — rising E4 → B4: a new booking or a change.
 *   cancel — falling B4 → E4, a touch quieter: a booking was cancelled.
 *   urgent — B4 · D#5 · B4, three pulses, still the loudest of the three.
 * The allergy alarm stays DISTINCT — three pulses, a different interval (a
 * major third, not the chime's fifth), a little louder (≈ +1.6 dB peak,
 * +2.5 dB rms) — but it is no longer a square wave. Staff still tell the three apart without looking.
 * Pinned by __tests__/soundSet.test.js.
 */
const MALLET = [
  [1, 1.0, 1.0], // fundamental
  [2, 0.16, 0.55], // a little warmth, fades faster
  [3.98, 0.05, 0.3], // the soft "tok" of a mallet, gone almost at once
];
const WARM = [
  [1, 1.0, 1.0], // fundamental
  [2, 0.1, 0.5], // a little warmth, fades faster
  [3, 0.03, 0.3], // a harmonic (not 3.98) — rounder, no "tok"
];
// [mult, amp, decayFactor]: each partial rings out on `decay * decayFactor`.
const mallet = (freq, start, volume, decay = 0.26, partials = MALLET, duration = 1.0) => ({
  freq, start, volume, duration, attack: 0.012, decay, partials,
});
const CHIME_PARTS = [mallet(329.63, 0, 0.18, 0.38, WARM), mallet(493.88, 0.16, 0.16, 0.38, WARM)];
const CANCEL_PARTS = [mallet(493.88, 0, 0.14, 0.38, WARM), mallet(329.63, 0.18, 0.13, 0.38, WARM)];
const URGENT_PARTS = [
  mallet(493.88, 0, 0.26, 0.2, WARM, 0.55),
  mallet(622.25, 0.22, 0.26, 0.2, WARM, 0.55),
  mallet(493.88, 0.44, 0.26, 0.25, WARM, 0.8),
];

/** The alert recipes, read-only — for the tests and the offline renderer. */
export const ALERT_PARTS = Object.freeze({
  chime: Object.freeze(CHIME_PARTS),
  cancel: Object.freeze(CANCEL_PARTS),
  urgent: Object.freeze(URGENT_PARTS),
});

/* ── the media elements ───────────────────────────────────────────────────── */

const _els = {}; // kind -> HTMLAudioElement

function element(kind) {
  if (_els[kind]) return _els[kind];
  if (typeof Audio === "undefined") return null;
  try {
    const parts = kind === "urgent" ? URGENT_PARTS : kind === "cancel" ? CANCEL_PARTS : CHIME_PARTS;
    const el = new Audio(buildWavUrl(parts));
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
 * Build the three clips before anyone needs them — one per idle moment,
 * nothing played, no gesture needed. The synthesis (sample by sample at
 * 44,1 kHz: 33–37 ms on a desktop, 120+ ms on a slow phone) ran inside the
 * first tap after an app load, on whatever page that tap was, and held it.
 * The gesture still primes them (unlockSound); it no longer builds them.
 * Returns a cancel function.
 */
export function prepareSoundWhenIdle() {
  if (typeof window === "undefined" || typeof Audio === "undefined") return () => {};
  const ric = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback.bind(window) : null;
  const kinds = ["chime", "cancel", "urgent"].filter((k) => !_els[k]);
  let handle = null;
  let cancelled = false;
  const next = () => {
    if (cancelled || !kinds.length) return;
    const run = () => {
      handle = null;
      if (cancelled) return;
      element(kinds.shift());
      next();
    };
    handle = ric ? ric(run, { timeout: 5000 }) : setTimeout(run, 1000);
  };
  next();
  return () => {
    cancelled = true;
    if (handle == null) return;
    if (ric) window.cancelIdleCallback?.(handle);
    else clearTimeout(handle);
  };
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
  const kinds = ["chime", "cancel", "urgent"];
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

/**
 * One sine note shaped like the WAV mallet's fundamental: a 12 ms rise
 * instead of a click, a natural ring-out on time constant `ring` (counted from
 * the strike, not from the end of the rise), and a 40 ms ease to silence.
 */
function tone(freq, startOffset, duration, volume = 0.04, ring = 0.38, type = "sine") {
  const c = ctx();
  if (!c) return;
  try {
    const attack = 0.012;
    const t0 = c.currentTime + startOffset;
    const fadeAt = t0 + Math.max(attack, duration - 0.04);
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume * Math.exp(-attack / ring), t0 + attack);
    gain.gain.setTargetAtTime(0, t0 + attack, ring);
    gain.gain.setValueAtTime(volume * Math.exp(-(fadeAt - t0) / ring), fadeAt);
    gain.gain.linearRampToValueAtTime(0, t0 + duration);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.03);
  } catch {
    /* swallow — audio is best-effort */
  }
}

// The same notes as the WAV clips, sine only (the fallback path has always
// been quieter than the media element; it is the last resort).
function toneFallback(kind) {
  resumeCtx();
  if (kind === "urgent") {
    tone(493.88, 0, 0.55, 0.05, 0.2);
    tone(622.25, 0.22, 0.55, 0.05, 0.2);
    tone(493.88, 0.44, 0.8, 0.05, 0.25);
  } else if (kind === "cancel") {
    tone(493.88, 0, 1.0, 0.03, 0.38);
    tone(329.63, 0.18, 1.0, 0.028, 0.38);
  } else {
    tone(329.63, 0, 1.0, 0.04, 0.38);
    tone(493.88, 0.16, 1.0, 0.035, 0.38);
  }
}

/* ── public play API (unchanged signatures) ───────────────────────────────── */

/** Soft rising two-note chime (E4 → B4) for a new booking or a change. */
export function playChime() {
  play("chime");
}

/** The same chime falling, a touch quieter — a booking was cancelled. */
export function playCancel() {
  play("cancel");
}

/** Distinct triple-pulse (B4 · D#5 · B4) for a severe allergy — a little
 *  louder and on a different interval than the chime, but not a square wave. */
export function playUrgent() {
  play("urgent");
}
