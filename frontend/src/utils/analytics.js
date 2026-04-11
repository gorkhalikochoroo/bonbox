const API_BASE = import.meta.env.VITE_API_URL || "";

/**
 * Lightweight event tracking.
 * Sends events to backend — never logs sensitive data (amounts, staff PII).
 * Silently fails so analytics never crashes the app.
 */
export const track = async (event, properties = {}) => {
  if (import.meta.env.DEV) return; // skip in development

  try {
    const token = localStorage.getItem("token");
    await fetch(`${API_BASE}/api/analytics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        event,
        properties,
        timestamp: new Date().toISOString(),
        platform: navigator.userAgent.includes("Capacitor") ? "native" : "web",
      }),
    });
  } catch {
    // Analytics must never crash the app
  }
};
