/**
 * usePushNotifications — manages browser + Capacitor push notifications.
 *
 * Two flavours wired through one hook:
 *
 *   1. Browser / PWA (Web Push, Task #72) — uses the standard
 *      Notification API + ServiceWorker + PushManager pipeline. The
 *      service worker at /sw.js registers a `push` listener that calls
 *      `self.registration.showNotification(title, ...)`. Our backend
 *      fans the morning brief via VAPID to every saved subscription
 *      at 06:00 UTC.
 *
 *   2. Capacitor native iOS / Android — uses @capacitor/push-
 *      notifications. The push token is provider-specific (APNs / FCM)
 *      and is sent to the backend separately. Same surface — the hook
 *      hides the difference behind one `subscribe()` call.
 *
 * Public API:
 *   {
 *     permission,         // 'default' | 'granted' | 'denied'
 *     supported,           // boolean — browser has Notification + SW + PushManager
 *     subscribed,          // boolean — there's a live PushSubscription tied to
 *                          //   /api/push/subscribe
 *     busy,                // boolean — a subscribe / unsubscribe is in flight
 *     requestPermission,   // legacy (Task #66) — kept for back-compat
 *     showNotification,    // legacy local-only notification
 *     subscribe,           // NEW — full /api/push/subscribe handshake
 *     unsubscribe,         // NEW — POST /api/push/unsubscribe + local cleanup
 *     sendTest,            // NEW — POST /api/push/test
 *   }
 *
 * Privacy note: the actual subscription endpoint URL never appears in
 * the UI — only the backend stores it, and only ever returns the last
 * 8 chars to confirm "this device is subscribed". GDPR-safe.
 */
import { useState, useEffect, useCallback } from "react";
import api from "../services/api";

// Check if Capacitor native platform
const isNative = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.();

// Local-storage key that mirrors the "currently subscribed" state so
// the UI can render correctly on cold-load before we've fetched the
// real PushSubscription back from the SW. The backend remains the
// source of truth — this flag is only a render hint.
const _LS_SUBSCRIBED = "bonbox_push_subscribed_v1";

/**
 * Decode the VAPID public key (base64url, no padding) into the
 * Uint8Array PushManager.subscribe() requires. Standard browser API
 * choice — no library needed.
 */
function _vapidKeyToBytes(b64url) {
  const padding = "=".repeat((4 - (b64url.length % 4)) % 4);
  const base64 = (b64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Turn a PushSubscription (from PushManager) into the JSON shape our
 * backend expects. The browser's .toJSON() does most of this; we just
 * normalize + add the user-agent so the user can later tell devices
 * apart.
 */
function _serializeSubscription(sub) {
  const json = sub.toJSON();
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
    user_agent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 500) : null,
  };
}

export default function usePushNotifications() {
  const [permission, setPermission] = useState("default");
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  // Capability detection — Web Push needs Notification API +
  // ServiceWorker + PushManager. Some Capacitor in-app browsers ship
  // Notification but not PushManager; we treat that as "not supported"
  // and fall through to the native @capacitor/push path.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hasNotification = "Notification" in window;
    const hasServiceWorker = "serviceWorker" in navigator;
    const hasPushManager = "PushManager" in window;
    setSupported(hasNotification && hasServiceWorker && hasPushManager);
    if (hasNotification) setPermission(Notification.permission);

    // Hydrate subscribed-flag from localStorage so the UI doesn't
    // flicker on cold-load. Confirmed against the live SW below.
    try {
      setSubscribed(localStorage.getItem(_LS_SUBSCRIBED) === "1");
    } catch {
      // localStorage unavailable in some embedded webviews — silent.
    }

    // Best-effort: ask the SW if there's already a PushSubscription
    // (e.g. user re-opens the app on a device that subscribed last week).
    if (hasServiceWorker && hasPushManager) {
      navigator.serviceWorker.ready
        .then((reg) => reg.pushManager.getSubscription())
        .then((sub) => {
          const has = !!sub;
          setSubscribed(has);
          try {
            localStorage.setItem(_LS_SUBSCRIBED, has ? "1" : "0");
          } catch { /* noop */ }
        })
        .catch(() => { /* SW not ready — ignore */ });
    }
  }, []);

  // ─── Legacy API (kept for back-compat with ProfilePage Task #66) ──

  const requestPermission = useCallback(async () => {
    if (!supported) return "unsupported";

    if (isNative) {
      // Capacitor native push
      try {
        const { PushNotifications } = await import("@capacitor/push-notifications");
        const result = await PushNotifications.requestPermissions();
        if (result.receive === "granted") {
          await PushNotifications.register();
          setPermission("granted");

          // Listen for registration token
          PushNotifications.addListener("registration", () => {
            // Never log token.value — it's a device credential. (sibling
            // src/utils/push.js follows the same rule.)
            // TODO: Send token to backend for server-side push (v2)
          });

          // Listen for push received
          PushNotifications.addListener("pushNotificationReceived", (notification) => {
            console.log("Push received:", notification);
          });

          // Listen for push action
          PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
            console.log("Push action:", action);
            const url = action.notification?.data?.url;
            if (url) window.location.href = url;
          });

          return "granted";
        }
        setPermission("denied");
        return "denied";
      } catch {
        // Fallback to browser API
      }
    }

    // Browser Notification API
    const result = await Notification.requestPermission();
    setPermission(result);
    return result;
  }, [supported]);

  const showNotification = useCallback((title, options = {}) => {
    if (permission !== "granted") return;

    if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification(title, {
          body: options.body || "",
          icon: options.icon || "/icon-192.png",
          badge: "/icon-192.png",
          data: options.url ? { url: options.url } : { url: "/" },
          vibrate: [100, 50, 100],
          ...options,
        });
      });
    } else {
      new Notification(title, {
        body: options.body || "",
        icon: options.icon || "/icon-192.png",
        ...options,
      });
    }
  }, [permission]);

  // ─── New API (Task #72) ─────────────────────────────────────────────

  /**
   * Full subscribe flow:
   *   1. Make sure permission is 'granted'
   *   2. Register / get the service worker
   *   3. Fetch the VAPID public key from /api/push/vapid-public-key
   *   4. PushManager.subscribe() with that key
   *   5. POST the subscription JSON to /api/push/subscribe
   * Returns the backend's confirmation object on success, or
   *   { error: <reason> } on failure.
   */
  const subscribe = useCallback(async () => {
    if (!supported) return { error: "unsupported" };
    setBusy(true);
    try {
      // Permission first — Notification.requestPermission() in the
      // same gesture chain is safest on Safari iOS (it'll only grant
      // if called from a user activation).
      let perm = Notification.permission;
      if (perm === "default") {
        perm = await Notification.requestPermission();
        setPermission(perm);
      }
      if (perm !== "granted") {
        return { error: perm === "denied" ? "denied" : "permission_required" };
      }

      // Register the SW (idempotent — Workbox / browser dedupe).
      let reg;
      try {
        reg = await navigator.serviceWorker.register("/sw.js");
      } catch (e) {
        return { error: "sw_register_failed", detail: String(e) };
      }
      // Wait until it's active (Chrome can return 'installing').
      reg = await navigator.serviceWorker.ready;

      // Fetch VAPID public key. The endpoint is text/plain.
      let vapid;
      try {
        const res = await api.get("/push/vapid-public-key", {
          responseType: "text",
          transformResponse: [(d) => d],
        });
        vapid = String(res.data || "").trim();
      } catch (e) {
        const status = e?.response?.status;
        if (status === 503) return { error: "push_disabled" };
        return { error: "vapid_fetch_failed" };
      }
      if (!vapid) return { error: "vapid_empty" };

      // Subscribe at the browser layer. userVisibleOnly is required
      // by Chrome — if false, browsers refuse to subscribe.
      let pushSub;
      try {
        pushSub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: _vapidKeyToBytes(vapid),
        });
      } catch (e) {
        return { error: "push_subscribe_failed", detail: String(e) };
      }

      // POST to backend.
      try {
        await api.post("/push/subscribe", _serializeSubscription(pushSub));
      } catch (e) {
        // Best effort: try to clean up the browser-side sub so we
        // don't leak a stranded subscription with no backend row.
        try { await pushSub.unsubscribe(); } catch { /* noop */ }
        return { error: "backend_subscribe_failed" };
      }

      setSubscribed(true);
      try { localStorage.setItem(_LS_SUBSCRIBED, "1"); } catch { /* noop */ }
      return { ok: true };
    } finally {
      setBusy(false);
    }
  }, [supported]);

  /**
   * Tear down both sides — browser-level PushManager + backend row.
   * Either side failing is non-fatal; we always clear the local flag
   * so the UI lets the user re-try.
   */
  const unsubscribe = useCallback(async () => {
    setBusy(true);
    try {
      let endpoint = null;
      try {
        const reg = await navigator.serviceWorker.ready;
        const pushSub = await reg.pushManager.getSubscription();
        if (pushSub) {
          endpoint = pushSub.endpoint;
          try { await pushSub.unsubscribe(); } catch { /* noop */ }
        }
      } catch { /* SW gone — proceed anyway */ }

      if (endpoint) {
        try {
          await api.post("/push/unsubscribe", { endpoint });
        } catch { /* network blip — backend cron will prune via fail_count */ }
      }

      setSubscribed(false);
      try { localStorage.setItem(_LS_SUBSCRIBED, "0"); } catch { /* noop */ }
      return { ok: true };
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Fire the test endpoint. Backend fans a "BonBox: push works!"
   * notification to every subscription the caller owns. 5/hour limit.
   */
  const sendTest = useCallback(async () => {
    setBusy(true);
    try {
      const res = await api.post("/push/test");
      return { ok: true, ...res.data };
    } catch (e) {
      const status = e?.response?.status;
      if (status === 429) return { error: "rate_limited" };
      if (status === 503) return { error: "push_disabled" };
      return { error: "send_failed" };
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    permission,
    supported,
    subscribed,
    busy,
    requestPermission,
    showNotification,
    subscribe,
    unsubscribe,
    sendTest,
  };
}
