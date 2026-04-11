import { PushNotifications } from "@capacitor/push-notifications";
import { platform } from "./platform";

const API_BASE = import.meta.env.VITE_API_URL || "";

/**
 * Initialize push notifications on native platforms.
 * Registers device token with backend, handles foreground + tap events.
 * No-op on web.
 * @param {function} navigate — React Router navigate function
 * @param {function} showToast — in-app toast function (optional)
 */
export const initPushNotifications = async (navigate, showToast) => {
  if (!platform.isNative) return;

  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== "granted") return;

  await PushNotifications.register();

  // Send device token to backend — never log the full token
  PushNotifications.addListener("registration", async (token) => {
    try {
      const authToken = localStorage.getItem("token");
      if (!authToken) return;
      await fetch(`${API_BASE}/api/devices/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          token: token.value,
          platform: platform.isIOS ? "ios" : "android",
        }),
      });
    } catch {
      // Silent — push registration failure shouldn't block the app
    }
  });

  // Foreground notification — show in-app toast
  PushNotifications.addListener("pushNotificationReceived", (notification) => {
    if (showToast) showToast(notification.title, notification.body);
  });

  // User tapped notification — navigate to relevant page
  PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
    const data = action.notification.data || {};
    const routes = {
      "daily-close-reminder": "/daily-close",
      "low-stock": "/inventory",
      "staff-hours-warning": "/staff/hours",
      "cash-variance": "/daily-close",
      "weekly-summary": "/reports",
    };
    navigate(routes[data.type] || "/dashboard");
  });
};
