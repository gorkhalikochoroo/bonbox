/**
 * Portal API client — separate from the main api.js.
 * Does NOT attach Bearer tokens or redirect to /login on 401.
 * Used exclusively by the staff self-service portal (/s/:token).
 */
import axios from "axios";

const portalApi = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:8000/api",
  timeout: 30000,
});

// Auto-retry on network error (max 2 retries)
portalApi.interceptors.response.use(null, async (err) => {
  const config = err.config;
  if (!config || config._retryCount >= 2) return Promise.reject(err);
  const isRetryable = !err.response || err.code === "ECONNABORTED" || err.response?.status >= 500;
  if (!isRetryable) return Promise.reject(err);
  config._retryCount = (config._retryCount || 0) + 1;
  await new Promise((r) => setTimeout(r, 1500));
  return portalApi(config);
});

export default portalApi;
