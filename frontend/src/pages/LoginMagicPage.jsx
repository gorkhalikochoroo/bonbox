import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { withSignupRef, clearSignupRef } from "../utils/signupRef";
import ClaimQuestion from "../components/ClaimQuestion";

/**
 * Magic-link landing page (Task #61).
 *
 * URL: /login/magic?token=<raw_token>
 *
 * Flow:
 *   1. Read the token from the query string
 *   2. POST /auth/magic-link/verify on mount
 *   3. On success → store JWT (native) / rely on HttpOnly cookie (web)
 *      → setUser in AuthContext → redirect to /dashboard
 *   3b. The account's address had never been confirmed (or an earlier
 *      question is unanswered) → the answer carries claim_question +
 *      claim_ticket: ask "Har du selv oprettet denne BonBox-konto den
 *      <dato> og valgt adgangskoden?" (components/ClaimQuestion.jsx).
 *      Ja → POST /auth/claim-decision keep → dashboard. Nej / Ved ikke →
 *      secure → "Din konto er sikret" + "Vælg en ny adgangskode". No skip:
 *      leaving the page leaves the question open (the mail asks too).
 *   4. On error → render an inline "expired or used" message with a
 *      button back to /login (where the user can request a new link)
 *
 * Security notes:
 *   • The token IS the credential — we never display it back to the user
 *   • Single-use; backend will 409 on the second submit
 *   • 15-min TTL; backend will 410 if expired
 *   • Even on a 401 / 410 / 409 we never reveal whether the email was
 *     registered — the error copy stays generic
 *   • No auth gate on this route; the token itself authenticates
 */
export default function LoginMagicPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";
  const navigate = useNavigate();
  const { t } = useLanguage();
  // useAuth may not have setUser exported (it doesn't in the current
  // tree — auth state is fetched fresh on the next /auth/me). We
  // tolerate either case so a future refactor doesn't break us.
  const auth = useAuth() || {};

  // verifying | success | claimed | question | secured | questionClosed | error
  const [state, setState] = useState("verifying");
  const [errorCode, setErrorCode] = useState("");
  // An older backend answered password_reset: it had already replaced the
  // password and signed other devices out (the "claimed" notice). Kept for
  // that answer; the current backend asks instead (below).
  const [accessClosed, setAccessClosed] = useState(false);
  // The link landed in an account whose address was never confirmed: the
  // address is now confirmed and this browser signed in, but nothing else
  // changed — the inbox owner is ASKED whether they made the account
  // (backend services/claim_decision.py, Manoj 8 Oct). The ticket that
  // answers lives only here, in memory: never in the URL or storage.
  const [question, setQuestion] = useState(null); // { createdAt, ticket }
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState("");
  const [closedNote, setClosedNote] = useState(""); // expired / already answered

  useEffect(() => {
    // Defensive: short / empty tokens never reach the network. The
    // backend's Pydantic schema enforces min_length=43, but a 422
    // response would also leak which lengths the server accepts.
    if (!token || token.length < 43) {
      setErrorCode("invalid");
      setState("error");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        // A new account made by this link gets the door-visit code, if one
        // is kept — the mailed link carries it as &ref= (utils/signupRef.js).
        // An existing account is never stamped (backend).
        const res = await api.post("/auth/magic-link/verify", withSignupRef({ token }));
        clearSignupRef();
        if (cancelled) return;
        const access = res?.data?.access_token;
        // Native (Capacitor iOS) — persist the bearer so the WKWebView
        // can re-attach it. Web sessions rely on the HttpOnly cookie
        // the backend just set.
        if (access && typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.()) {
          try { localStorage.setItem("token", access); } catch { /* ignore */ }
        }
        if (res?.data?.password_reset) {
          setAccessClosed(!!res?.data?.access_closed);
          setState("claimed");
          return;
        }
        if (res?.data?.claim_question && res?.data?.claim_ticket) {
          // No redirect, no skip: the owner answers (or closes the page and
          // the question stays open — the notice mail carries it too).
          setQuestion({
            createdAt: res.data.claim_question.created_at,
            ticket: res.data.claim_ticket,
          });
          setState("question");
          return;
        }
        setState("success");
        // Force a fresh /auth/me round-trip on the next page so the
        // AuthProvider picks up the new session + any user fields
        // that may have changed (e.g. trial start, onboarding flag).
        // window.location.href instead of navigate() — guarantees a
        // full reload so the cookie + token both take effect.
        setTimeout(() => {
          window.location.href = "/dashboard";
        }, 250);
      } catch (err) {
        if (cancelled) return;
        const detail = err?.response?.data?.detail;
        const code = (detail && typeof detail === "object" && detail.code) || "";
        // Map server-side codes to UI states. We collapse "expired",
        // "used", and "invalid" into one error path because all three
        // recoveries are identical: ask for a new link.
        if (code === "magic_link_expired" || err?.response?.status === 410) {
          setErrorCode("expired");
        } else if (code === "magic_link_used" || err?.response?.status === 409) {
          setErrorCode("used");
        } else if (code === "account_locked") {
          setErrorCode("locked");
        } else {
          setErrorCode("invalid");
        }
        setState("error");
      }
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally only run once on mount — verifying twice would 409
    // even on the first legit click in React StrictMode dev. The empty
    // dep array is safe here because the token is read from the URL
    // and we want exactly one verify attempt per page-load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const answer = async (choice) => {
    if (!question || answering) return;
    setAnswering(true);
    setAnswerError("");
    try {
      const res = await api.post("/auth/claim-decision", { ticket: question.ticket, answer: choice });
      if (choice === "keep") {
        setState("success");
        setTimeout(() => { window.location.href = "/dashboard"; }, 250);
        return;
      }
      // "secure": every session was signed out, this browser got a new one.
      const access = res?.data?.access_token;
      if (access && typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.()) {
        try { localStorage.setItem("token", access); } catch { /* ignore */ }
      }
      setAccessClosed(!!res?.data?.access_closed);
      setState("secured");
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.response?.data?.detail?.code || "";
      if (status === 410 || code === "claim_ticket_expired") {
        setClosedNote(t("claimExpired"));
        setState("questionClosed");
      } else if (status === 409 || code === "claim_already_decided") {
        setClosedNote(t("claimDecided"));
        setState("questionClosed");
      } else {
        setAnswerError(t("claimFailed"));
      }
    } finally {
      setAnswering(false);
    }
  };

  const headline = state === "verifying"
    ? (t("magicLinkVerifying") || "Signing you in…")
    : state === "success"
    ? (t("magicLinkSuccess") || "You're in. Redirecting…")
    : state === "claimed" || state === "question" || state === "questionClosed"
    ? t("magicLinkClaimedTitle")
    : state === "secured"
    ? t("claimSecuredTitle")
    : errorCode === "expired"
    ? (t("magicLinkExpired") || "This link has expired.")
    : errorCode === "used"
    ? (t("magicLinkUsed") || "This link was already used.")
    : errorCode === "locked"
    ? (t("magicLinkLocked") || "This account is locked. Contact support.")
    : (t("magicLinkInvalid") || "This link is invalid.");

  const sub = state === "verifying"
    ? (t("magicLinkVerifyingSub") || "Hang tight, this takes a second.")
    : state === "success"
    ? ""
    : state === "claimed"
    ? t("magicLinkClaimedBody")
    : state === "question"
    ? ""
    : state === "questionClosed"
    ? closedNote
    : state === "secured"
    ? t("claimSecuredBody")
    : (t("magicLinkErrorSub") || "Request a new link and we'll get you in.");

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md bg-white border border-gray-200 rounded-xl shadow-sm p-7 text-center">
        {/* Brand */}
        <div className="flex justify-center mb-5">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-[#22c55e]">
            <svg width="22" height="22" viewBox="0 0 28 28" fill="none">
              <rect x="4" y="2" width="20" height="24" rx="3" stroke="white" strokeWidth="2.2"/>
              <path d="M9 8h10M9 12h10M9 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
        </div>

        {/* Status icon */}
        {state === "verifying" && (
          <div className="flex justify-center mb-4">
            <svg className="animate-spin h-7 w-7 text-emerald-600" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          </div>
        )}
        {(state === "success" || state === "claimed" || state === "question" || state === "secured") && (
          <div className="flex justify-center mb-4">
            <div className="w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/>
              </svg>
            </div>
          </div>
        )}
        {state === "error" && (
          <div className="flex justify-center mb-4">
            <div className="w-10 h-10 rounded-full bg-amber-100 border border-amber-200 flex items-center justify-center">
              <svg className="w-5 h-5 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"/>
              </svg>
            </div>
          </div>
        )}

        <h1 className="text-[20px] font-semibold text-gray-900 tracking-tight">
          {headline}
        </h1>
        {sub && (
          <p className="text-[14px] text-gray-500 mt-2 leading-relaxed">
            {sub}
          </p>
        )}

        {state === "claimed" && (
          <div className="mt-5" data-testid="magic-link-claimed">
            {accessClosed && (
              <p className="text-[14px] text-gray-500 leading-relaxed mb-4">
                {t("magicLinkClaimedAccessClosed")}
              </p>
            )}
            <button
              type="button"
              onClick={() => { window.location.href = "/dashboard"; }}
              className="inline-block bg-[#22c55e] hover:bg-[#16a34a] text-white px-5 py-2.5 rounded-lg text-[14px] font-medium transition"
            >
              {t("magicLinkClaimedContinue")}
            </button>
            <p className="text-[13px] text-gray-500 mt-4">
              <Link to="/forgot-password" className="underline underline-offset-2 hover:text-gray-800">
                {t("magicLinkClaimedSetPassword")}
              </Link>
            </p>
          </div>
        )}

        {state === "question" && question && (
          <ClaimQuestion
            createdAt={question.createdAt}
            onAnswer={answer}
            busy={answering}
            error={answerError}
          />
        )}

        {state === "secured" && (
          <div className="mt-5" data-testid="claim-secured">
            {accessClosed && (
              <p className="text-[14px] text-gray-500 leading-relaxed mb-4">
                {t("magicLinkClaimedAccessClosed")}
              </p>
            )}
            <Link
              to="/forgot-password"
              className="inline-block bg-[#22c55e] hover:bg-[#16a34a] text-white px-5 py-2.5 rounded-lg text-[14px] font-medium transition"
            >
              {t("magicLinkClaimedSetPassword")}
            </Link>
            <p className="text-[13px] text-gray-500 mt-4">
              <button
                type="button"
                onClick={() => { window.location.href = "/dashboard"; }}
                className="underline underline-offset-2 hover:text-gray-800"
              >
                {t("magicLinkClaimedContinue")}
              </button>
            </p>
          </div>
        )}

        {state === "questionClosed" && (
          <div className="mt-6" data-testid="claim-closed">
            <button
              type="button"
              onClick={() => { window.location.href = "/dashboard"; }}
              className="inline-block bg-[#22c55e] hover:bg-[#16a34a] text-white px-5 py-2.5 rounded-lg text-[14px] font-medium transition"
            >
              {t("magicLinkClaimedContinue")}
            </button>
          </div>
        )}

        {state === "error" && (
          <div className="mt-6">
            <Link
              to="/login"
              className="inline-block bg-[#22c55e] hover:bg-[#16a34a] text-white px-5 py-2.5 rounded-lg text-[14px] font-medium transition"
            >
              {t("magicLinkRetry") || "Get a new link"}
            </Link>
            <p className="text-[12px] text-gray-400 mt-4">
              <Link to="/login" className="hover:text-gray-700 underline-offset-2 hover:underline">
                {t("usePasswordInstead") || "Use password instead"}
              </Link>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
