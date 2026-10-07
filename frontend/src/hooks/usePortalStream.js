import { useEffect, useRef, useState } from "react";
import { App as CapApp } from "@capacitor/app";
import { platform } from "../utils/platform";

/**
 * The portal's live channel (Server-Sent Events) — and the reason the header
 * can honestly say "Live".
 *
 * Round-2 report: after the Scheduler app sat idle for hours the header never
 * came back to "Live"; only a relaunch did. Two holes, both real:
 *
 *   1. EventSource only retries by itself after a NETWORK drop. When the
 *      server answers with an error — a 5xx or 502 while it restarts or
 *      Render wakes, the 429 from the per-tenant stream cap — the browser
 *      moves it to CLOSED and never tries again. Nothing re-created it, so
 *      the stream stayed dead for the life of the page.
 *   2. After the phone sleeps, iOS suspends the web view; the socket can come
 *      back half-open, still "OPEN" but deaf. Nothing ever recycled it.
 *
 * So: a CLOSED stream is reopened with backoff (5 s → 10 s → … → 5 min, reset
 * on a good open), and coming back to the app — visibilitychange, the
 * browser's 'online', the native shell's 'resume' — reopens it at once. The
 * 20 s / 60 s poll stays the correctness fallback; this is only speed.
 */
export const STREAM_BACKOFF_MS = [5000, 10000, 20000, 40000, 80000, 160000, 300000];
const CLOSED = 2;

export function usePortalStream({ enabled, url, onPublished }) {
  const [live, setLive] = useState(false);
  const handler = useRef(onPublished);
  useEffect(() => { handler.current = onPublished; }, [onPublished]);

  useEffect(() => {
    if (!enabled || !url) return undefined;
    if (typeof window === "undefined" || typeof window.EventSource === "undefined") return undefined;

    let es = null;
    let openedAt = 0;
    let timer = null;
    let attempt = 0;
    let stopped = false;
    const onEvent = (e) => handler.current?.(e);

    const close = () => {
      if (!es) return;
      try { es.removeEventListener("schedule_published", onEvent); } catch { /* noop */ }
      try { es.close(); } catch { /* noop */ }
      es = null;
    };

    const schedule = () => {
      if (stopped || timer) return;
      const delay = STREAM_BACKOFF_MS[Math.min(attempt, STREAM_BACKOFF_MS.length - 1)];
      attempt += 1;
      timer = setTimeout(() => { timer = null; open(); }, delay);
    };

    function open() {
      if (stopped) return;
      close();
      let mine;
      try {
        mine = new window.EventSource(url);
      } catch {
        schedule();
        return;
      }
      es = mine;
      openedAt = Date.now();
      mine.onopen = () => {
        if (es !== mine) return;
        attempt = 0;
        setLive(true);
      };
      mine.onerror = () => {
        if (es !== mine) return;
        setLive(false);
        // CONNECTING = the browser is already retrying a dropped socket.
        // CLOSED = it gave up for good (an HTTP error status) — our job.
        if (mine.readyState === CLOSED) {
          close();
          schedule();
        }
      };
      mine.addEventListener("schedule_published", onEvent);
    }

    // Back in front of the staffer: whatever the stream claims, start a fresh
    // one now. A burst of these (resume + visibilitychange + online all fire
    // on one unlock) opens a single stream.
    const revive = () => {
      if (stopped) return;
      if (es && es.readyState !== CLOSED && Date.now() - openedAt < 3000) return;
      if (timer) { clearTimeout(timer); timer = null; }
      attempt = 0;
      setLive(false);
      open();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") revive();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", revive);
    let resumeSub = null;
    if (platform.isNative) {
      try { resumeSub = CapApp.addListener("resume", revive); } catch { /* plugin missing — visibilitychange still covers it */ }
    }

    open();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      close();
      setLive(false);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", revive);
      Promise.resolve(resumeSub).then((l) => l?.remove?.()).catch(() => {});
    };
  }, [enabled, url]);

  return live;
}
