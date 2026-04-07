/**
 * usePushNotifications — manages browser + Capacitor push notifications.
 *
 * Browser: uses Notification API + Service Worker push events.
 * Mobile: uses @capacitor/push-notifications for native push.
 */
import { useState, useEffect, useCallback } from "react";

// Check if Capacitor native platform
const isNative = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.();

export default function usePushNotifications() {
  const [permission, setPermission] = useState("default");
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    // Browser Notification API
    if ("Notification" in window) {
      setSupported(true);
      setPermission(Notification.permission);
    }
  }, []);

  // Request permission
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
          PushNotifications.addListener("registration", (token) => {
            console.log("Push token:", token.value);
            // TODO: Send token to backend for server-side push
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

  // Show a local browser notification
  const showNotification = useCallback((title, options = {}) => {
    if (permission !== "granted") return;

    // Use service worker for persistent notifications
    if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification(title, {
          body: options.body || "",
          icon: options.icon || "/icon-192.png",
          badge: "/icon-192.png",
          data: options.url || "/dashboard",
          vibrate: [100, 50, 100],
          ...options,
        });
      });
    } else {
      // Fallback to basic Notification API
      new Notification(title, {
        body: options.body || "",
        icon: options.icon || "/icon-192.png",
        ...options,
      });
    }
  }, [permission]);

  return { permission, supported, requestPermission, showNotification };
}
