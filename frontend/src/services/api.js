import axios from "axios";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:8000/api",
  timeout: 60000, // 60s timeout for slow connections (Nepal, etc.)
});

// Auto-retry on timeout or network error (max 2 retries)
api.interceptors.response.use(null, async (err) => {
  const config = err.config;
  if (!config || config._retryCount >= 2) return Promise.reject(err);
  const isRetryable = !err.response || err.code === "ECONNABORTED" || err.response?.status >= 500;
  if (!isRetryable) return Promise.reject(err);
  // Only retry login/register POSTs on network errors (not on 4xx)
  if (config.method === "post" && err.response) return Promise.reject(err);
  config._retryCount = (config._retryCount || 0) + 1;
  await new Promise((r) => setTimeout(r, 1500));
  return api(config);
});

// Multi-layer defense: detect _error flag in 200-OK responses.
//
// Backend wraps risky endpoints to ALWAYS return a stable shape — even on
// failure — with `_error: true|"message"` and `_recoverable: true`. This means
// the page renders cleanly and we surface a non-blocking toast/banner instead
// of crashing or showing a blank screen.
//
// Pages that need to react to graceful failures can read `res.data._error`
// directly. The interceptor below dispatches a custom event so a global
// banner component can show the message without every page re-implementing it.
api.interceptors.response.use((res) => {
  try {
    const data = res?.data;
    if (data && typeof data === "object" && data._error) {
      const msg = typeof data._error === "string"
        ? data._error
        : (data.detail || "Something went wrong loading this section.");
      window.dispatchEvent(
        new CustomEvent("bonbox:soft-error", {
          detail: {
            message: msg,
            recoverable: !!data._recoverable,
            url: res?.config?.url || "",
          },
        }),
      );
    }
  } catch (_) {
    // Never let the interceptor itself break a successful response
  }
  return res;
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Tell the backend whether we're inside a Capacitor native shell so it can
  // apply iOS-IAP-compliance rules to billing endpoints. Web requests get "web".
  try {
    if (window.Capacitor?.isNativePlatform?.()) {
      config.headers["X-BonBox-Platform"] = window.Capacitor.getPlatform?.() || "native";
    } else {
      config.headers["X-BonBox-Platform"] = "web";
    }
  } catch (_) {
    config.headers["X-BonBox-Platform"] = "web";
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      // Don't redirect if already on login/register/forgot-password page
      const path = window.location.pathname;
      const isAuthPage = path === "/login" || path === "/register" || path.startsWith("/forgot") || path.startsWith("/reset") || path.startsWith("/s/");
      if (!isAuthPage) {
        localStorage.removeItem("token");
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);

export default api;
