import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

/**
 * Secure token storage.
 * Native: Capacitor Preferences (encrypted app container on iOS).
 * Web: localStorage (acceptable for browser — no better option).
 *
 * SECURITY: Never log token values. Never include in URLs.
 */
export const SecureStore = {
  async setToken(token) {
    if (Capacitor.isNativePlatform()) {
      await Preferences.set({ key: "auth_token", value: token });
    } else {
      localStorage.setItem("token", token);
    }
  },

  async getToken() {
    if (Capacitor.isNativePlatform()) {
      const { value } = await Preferences.get({ key: "auth_token" });
      return value;
    }
    return localStorage.getItem("token");
  },

  async clearToken() {
    if (Capacitor.isNativePlatform()) {
      await Preferences.remove({ key: "auth_token" });
    } else {
      localStorage.removeItem("token");
    }
  },
};
