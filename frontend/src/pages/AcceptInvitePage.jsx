import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";

/**
 * Magic-link landing page for an accountant accepting an invite.
 *
 * Flow:
 *   1. URL contains the invite token: /accept-invite/:token
 *   2. Render: "X invited you to be their revisor on BonBox"
 *   3. Form: password (8+ chars), optional full name
 *   4. Submit → POST /accountants/signup → auto-login → redirect to /dashboard
 *
 * Security notes:
 *   • The token is the credential — we never display it back to the user
 *     (no UI surface to copy it from the URL bar)
 *   • The server handles email validation; this page just collects password
 *     + name and ships them to /signup
 *   • Single-use: a second submit with the same token returns 409 / 410
 *   • This page is PUBLIC — no auth needed to render it; if the user is
 *     already logged in we still let them accept, because they might be
 *     completing a fresh invite on a different account
 */
export default function AcceptInvitePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { setUser } = useAuth() || {};

  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token || token.length < 10) {
      setError("This invite link looks invalid. Ask the business owner to send a fresh one.");
    }
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post("/accountants/signup", {
        invite_token: token,
        password,
        full_name: fullName || null,
      });
      // Backend has set the bonbox_session cookie + accountant_client cookie.
      // Update the in-app auth state and route the revisor to the dashboard.
      const access = res.data.access_token;
      if (access && window.Capacitor?.isNativePlatform?.()) {
        // Native: persist the bearer token for cross-site WKWebView
        try { localStorage.setItem("token", access); } catch {}
      }
      if (typeof setUser === "function" && res.data.user) {
        setUser(res.data.user);
      }
      // Force a full reload so the auth provider re-fetches /auth/me with
      // the new cookie + the accountant_client cookie picks up.
      window.location.href = "/dashboard";
    } catch (err) {
      const detail = err?.response?.data?.detail;
      const code = detail?.code;
      const msg = detail?.message || (typeof detail === "string" ? detail : null);
      if (err?.response?.status === 410 || code === "invite_expired") {
        setError("This invite has expired. Ask the business owner to send a fresh one.");
      } else if (code === "grant_revoked") {
        setError("This invite has been revoked. Ask the business owner if this was a mistake.");
      } else if (code === "already_active") {
        setError("This invite has already been used. Sign in with the email and password you set up before.");
      } else if (code === "email_in_use") {
        setError(
          msg ||
            "An account with this email already exists. Sign in first and then ask the owner to re-invite you so we can link the accounts."
        );
      } else {
        setError(msg || "Something went wrong. Try again or contact support.");
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-gray-900 px-4 py-12">
      <div className="w-full max-w-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm p-7">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
          You're invited as a revisor
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-6 leading-relaxed">
          A business owner has invited you to BonBox with read-only access to their books.
          Choose a password to finish setting up your accountant account.
        </p>

        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg px-3 py-2.5 text-sm mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
              Your name (optional)
            </label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Anna Hansen"
              maxLength={255}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:border-gray-300"
              autoComplete="name"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              minLength={8}
              maxLength={200}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:border-gray-300"
              autoComplete="new-password"
              required
            />
          </div>

          <button
            type="submit"
            disabled={submitting || !!error || password.length < 8}
            className="w-full bg-gray-900 text-white py-2.5 rounded-lg font-medium hover:bg-gray-700 disabled:opacity-60 transition"
          >
            {submitting ? "Setting up your account…" : "Accept invitation"}
          </button>
        </form>

        <p className="text-xs text-gray-500 dark:text-gray-400 text-center mt-5 leading-relaxed">
          You'll have read-only access. You can view reports and books but never modify data.
          The business owner can revoke your access at any time.
        </p>
      </div>
    </div>
  );
}
