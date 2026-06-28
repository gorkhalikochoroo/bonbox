import { useEffect, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";

/**
 * Magic-link landing page for a TEAM MEMBER accepting an invite.
 *
 * P0 security rewrite (Task #202, 2026-05-25):
 *   Replaces the old TeamPage flow that rendered the owner-set
 *   temp_password in plaintext. Now:
 *     1. URL contains the invite token: /accept-invite/team/:token
 *     2. We GET /api/team/accept-invite/:token to resolve the inviter
 *        business name + role + invitee email so we can render
 *        "X has invited you as a Y at Z" without exposing the token
 *        in the URL bar.
 *     3. The invitee chooses their OWN password (8+ chars).
 *     4. POST /api/team/accept-invite/:token sets the password,
 *        burns the token (single-use), and logs the invitee in.
 *
 * Security:
 *   • The token IS the credential — never copied to a display surface,
 *     never persisted client-side beyond the URL bar.
 *   • Single-use: a second submit with the same token returns 409.
 *   • Expired tokens (>7 days) get a friendly "ask for a new one" error
 *     with no PII leakage about which owner sent the original invite.
 *   • Token minimum length is enforced on both ends (server returns
 *     404 for tokens shorter than 32 chars).
 *   • This page is PUBLIC — no auth needed; if the user is logged in
 *     elsewhere we still let them accept (they may be onboarding a
 *     second device).
 */
export default function TeamAcceptInvitePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setUser } = useAuth() || {};
  const { t } = useLanguage();

  const [resolving, setResolving] = useState(true);
  const [resolveError, setResolveError] = useState("");
  const [invite, setInvite] = useState(null); // {email, role, owner_business_name}

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Hint from invite link, used only as a fallback if /resolve doesn't return role.
  const linkRole = (searchParams.get("role") || "").toLowerCase();

  // Strength gauge — visual hint only; the real rule is min length 8.
  const strength = (() => {
    if (!password) return { score: 0, label: "" };
    let score = 0;
    if (password.length >= 8) score += 1;
    if (password.length >= 12) score += 1;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
    if (/\d/.test(password) || /[^A-Za-z0-9]/.test(password)) score += 1;
    const labels = ["", t("taiPwWeak", "Weak"), t("taiPwOkay", "Okay"), t("taiPwStrong", "Strong"), t("taiPwExcellent", "Excellent")];
    return { score, label: labels[score] };
  })();

  useEffect(() => {
    if (!token || token.length < 32) {
      setResolveError(t("taiErrInvalidLink", "This invitation link looks invalid. Ask the business owner to send a new one."));
      setResolving(false);
      return;
    }
    let cancelled = false;
    api
      .get(`/team/accept-invite/${token}`)
      .then((res) => {
        if (cancelled) return;
        setInvite(res.data);
      })
      .catch((err) => {
        if (cancelled) return;
        const status = err?.response?.status;
        const code = err?.response?.data?.detail?.code;
        if (status === 410 || code === "invite_expired") {
          setResolveError(t("taiErrExpiredLink", "This invitation link has expired. Ask the business owner to send a new one."));
        } else {
          setResolveError(t("taiErrNotFound", "This invitation could not be found. It may have been revoked or already used."));
        }
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError(t("taiErrPwTooShort", "Password must be at least 8 characters."));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("taiErrPwMismatch", "Passwords don't match."));
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post(`/team/accept-invite/${token}`, {
        password,
        full_name: fullName || null,
      });
      const access = res.data?.access_token;
      if (access && window.Capacitor?.isNativePlatform?.()) {
        try {
          localStorage.setItem("token", access);
        } catch {}
      }
      if (typeof setUser === "function" && res.data?.user) {
        setUser(res.data.user);
      }
      // Hard navigation so the auth provider re-fetches /auth/me and the
      // cookie picks up.
      window.location.href = "/dashboard";
    } catch (err) {
      const detail = err?.response?.data?.detail;
      const code = detail?.code;
      const msg = detail?.message || (typeof detail === "string" ? detail : null);
      if (err?.response?.status === 410 || code === "invite_expired") {
        setError(t("taiErrExpired", "This invitation has expired. Ask the business owner to send a new one."));
      } else if (code === "already_accepted") {
        setError(t("taiErrAlreadyUsed", "This invitation has already been used. Sign in with the password you chose."));
      } else if (err?.response?.status === 404) {
        setError(t("taiErrRevoked", "This invitation could not be found. It may have been revoked."));
      } else {
        setError(msg || t("taiErrGeneric", "Something went wrong. Try again or contact the business owner."));
      }
      setSubmitting(false);
    }
  };

  const roleLabel = (invite?.role || linkRole || t("taiDefaultRole", "team member")).replace(/_/g, " ");
  const ownerName = invite?.owner_business_name || "BonBox";

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-gray-900 px-4 py-12">
      <div className="w-full max-w-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm p-7">
        {resolving ? (
          <div className="text-center py-8">
            <div className="inline-block w-6 h-6 border-2 border-gray-300 border-t-gray-700 rounded-full animate-spin" />
            <p className="text-sm text-gray-500 mt-3">{t("taiLookingUp", "Looking up your invitation...")}</p>
          </div>
        ) : resolveError ? (
          <>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">
              {t("taiUnavailableTitle", "Invitation unavailable")}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-6 leading-relaxed">
              {resolveError}
            </p>
            <button
              onClick={() => navigate("/login")}
              className="w-full bg-gray-900 text-white py-2.5 rounded-lg font-medium hover:bg-gray-700 transition"
            >
              {t("taiBackToSignIn", "Back to sign in")}
            </button>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
              {t("taiJoin", "Join")} {ownerName}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-6 leading-relaxed">
              {t("taiInvitedAs", "You've been invited as a")} <span className="font-semibold capitalize">{roleLabel}</span>.
              {" "}{t("taiChoosePassword", "Choose a password to finish setting up your account.")}
              {invite?.email && (
                <span className="block mt-1 text-xs text-gray-500">{t("taiAccountEmail", "Account email:")} {invite.email}</span>
              )}
            </p>

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg px-3 py-2.5 text-sm mb-4">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                  {t("taiYourName", "Your name (optional)")}
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
                  {t("password", "Password")}
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("taiPwPlaceholder", "At least 8 characters")}
                  minLength={8}
                  maxLength={200}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:border-gray-300"
                  autoComplete="new-password"
                  required
                />
                {password && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex-1 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          strength.score >= 3
                            ? "bg-green-500"
                            : strength.score === 2
                              ? "bg-yellow-500"
                              : "bg-red-400"
                        }`}
                        style={{ width: `${(strength.score / 4) * 100}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-gray-500 w-20 text-right">{strength.label}</span>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                  {t("taiConfirmPassword", "Confirm password")}
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder={t("taiConfirmPwPlaceholder", "Type the same password again")}
                  minLength={8}
                  maxLength={200}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:border-gray-300"
                  autoComplete="new-password"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={submitting || password.length < 8 || password !== confirmPassword}
                className="w-full bg-gray-900 text-white py-2.5 rounded-lg font-medium hover:bg-gray-700 disabled:opacity-60 transition"
              >
                {submitting ? t("taiSettingUp", "Setting up your account...") : t("taiAcceptInvitation", "Accept invitation")}
              </button>
            </form>

            <p className="text-xs text-gray-500 dark:text-gray-400 text-center mt-5 leading-relaxed">
              {t("taiTermsNotice", "By accepting, you agree to BonBox's Terms. The business owner can revoke your access at any time.")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
