/**
 * useNativePush — APNs registration for the native BonBox Scheduler shell.
 *
 * Web push is dead inside WKWebView, so when the portal runs in the native
 * app we register a real APNs device token with the backend instead
 * (POST /portal/{token}/device). Outside the shell this hook is a no-op —
 * the browser/PWA keeps using the existing web-push path.
 *
 * Registration waits for `ready` (portal validated AND past any PIN gate,
 * so the request carries the proof header). The received device token is
 * mirrored to localStorage so the Frakobl (disconnect) action can
 * unregister it server-side before forgetting the link — a phone that
 * leaves the workplace must go quiet.
 */
import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { isNativeApp } from "../utils/platform";
import portalApi from "../services/portalApi";

export const NATIVE_PUSH_TOKEN_KEY = "bonbox_apns_token";

export function getStoredNativePushToken() {
  try {
    return localStorage.getItem(NATIVE_PUSH_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

/** Best-effort server-side unregister — used by the disconnect action.
 *  Never throws; the disconnect must proceed even offline. */
export async function unregisterNativePush(portalToken) {
  const deviceToken = getStoredNativePushToken();
  if (!deviceToken || !portalToken) return;
  try {
    await portalApi.delete(`/portal/${portalToken}/device`, {
      data: { token: deviceToken },
    });
  } catch {
    /* offline / older backend — the 410 cleanup prunes the row later */
  }
  try {
    localStorage.removeItem(NATIVE_PUSH_TOKEN_KEY);
  } catch {
    /* private mode */
  }
}

export default function useNativePush(portalToken, ready) {
  useEffect(() => {
    if (!ready || !portalToken) return undefined;
    if (!isNativeApp() || !Capacitor.isPluginAvailable("PushNotifications")) {
      return undefined;
    }

    let cancelled = false;
    const handles = [];

    (async () => {
      try {
        const { PushNotifications } = await import(
          "@capacitor/push-notifications"
        );

        const reg = await PushNotifications.addListener(
          "registration",
          async ({ value }) => {
            if (cancelled || !value) return;
            try {
              await portalApi.post(`/portal/${portalToken}/device`, {
                token: value,
                platform: "ios",
              });
              try {
                localStorage.setItem(NATIVE_PUSH_TOKEN_KEY, value);
              } catch {
                /* private mode — unregister-on-disconnect degrades to 410 cleanup */
              }
            } catch (err) {
              // 403 staff_push_not_enabled (owner tier) or offline — the
              // schedule still works, alerts just stay in-app. Honest: we
              // never claim push is on when the server said no.
              console.warn("native push register failed", err?.response?.status);
            }
          },
        );
        handles.push(reg);

        const errH = await PushNotifications.addListener(
          "registrationError",
          (e) => console.warn("APNs registration error", e),
        );
        handles.push(errH);

        // Tap on a notification → deep-link into the portal. The backend
        // puts the target path in the payload's `url`; falling back to a
        // reload keeps us on the schedule.
        const tapH = await PushNotifications.addListener(
          "pushNotificationActionPerformed",
          (action) => {
            const url = action?.notification?.data?.url;
            if (url && typeof url === "string" && url.startsWith("/")) {
              window.location.href = url;
            }
          },
        );
        handles.push(tapH);

        let perm = await PushNotifications.checkPermissions();
        if (perm.receive === "prompt") {
          perm = await PushNotifications.requestPermissions();
        }
        if (perm.receive === "granted" && !cancelled) {
          await PushNotifications.register();
        }
      } catch (err) {
        // Plugin missing on this build — never break the portal over push.
        console.warn("native push unavailable", err);
      }
    })();

    return () => {
      cancelled = true;
      handles.forEach((h) => {
        try {
          h.remove();
        } catch {
          /* already gone */
        }
      });
    };
  }, [portalToken, ready]);
}
