import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

/**
 * Unified storage adapter.
 * Web: localStorage (existing BonBox pattern).
 * Native: Capacitor Preferences (encrypted app container on iOS).
 */
export const Storage = {
  async get(key) {
    if (Capacitor.isNativePlatform()) {
      const { value } = await Preferences.get({ key });
      return value ? JSON.parse(value) : null;
    }
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  },

  async set(key, value) {
    const json = JSON.stringify(value);
    if (Capacitor.isNativePlatform()) {
      await Preferences.set({ key, value: json });
    } else {
      localStorage.setItem(key, json);
    }
  },

  async remove(key) {
    if (Capacitor.isNativePlatform()) {
      await Preferences.remove({ key });
    } else {
      localStorage.removeItem(key);
    }
  },
};
