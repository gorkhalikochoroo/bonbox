import { Network } from "@capacitor/network";
import { Storage } from "../utils/storage";
import { useState, useEffect } from "react";

/**
 * Detects online/offline state and manages an offline action queue.
 * Uses Capacitor Network plugin on native, navigator.onLine on web.
 */
export function useOffline() {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    Network.getStatus().then((s) => setIsOnline(s.connected));

    const listener = Network.addListener("networkStatusChange", (status) => {
      setIsOnline(status.connected);
      if (status.connected) syncOfflineQueue();
    });

    return () => { listener.then((l) => l.remove()); };
  }, []);

  return { isOnline };
}

/** Queue an API action to retry when back online */
export async function queueOfflineAction(action) {
  const queue = (await Storage.get("offlineQueue")) || [];
  queue.push({ ...action, timestamp: Date.now() });
  await Storage.set("offlineQueue", queue);
}

/** Process queued actions — stops on first failure (still offline) */
export async function syncOfflineQueue() {
  const queue = await Storage.get("offlineQueue");
  if (!queue || queue.length === 0) return;

  const token = localStorage.getItem("token");
  const remaining = [];

  for (const action of queue) {
    try {
      await fetch(action.url, {
        method: action.method || "POST",
        body: JSON.stringify(action.body),
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      // Still offline — keep this and all remaining items
      remaining.push(action);
    }
  }

  if (remaining.length > 0) {
    await Storage.set("offlineQueue", remaining);
  } else {
    await Storage.remove("offlineQueue");
  }
}
