import axios from "axios";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:8000/api",
  timeout: 30000, // 30s timeout for slow connections (Nepal, etc.)
});

// Auto-retry on timeout or network error (max 1 retry, skip POST to avoid duplicates)
api.interceptors.response.use(null, async (err) => {
  const config = err.config;
  if (!config || config._retryCount >= 1) return Promise.reject(err);
  // Don't retry POST requests (register, login, create) — can cause duplicates
  if (config.method === "post") return Promise.reject(err);
  const isRetryable = !err.response || err.code === "ECONNABORTED" || err.response?.status >= 500;
  if (!isRetryable) return Promise.reject(err);
  config._retryCount = (config._retryCount || 0) + 1;
  await new Promise((r) => setTimeout(r, 2000));
  return api(config);
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("token");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export default api;
