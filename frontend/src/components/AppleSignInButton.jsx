import { useEffect, useRef, useState } from "react";

/*
 * AppleSignInButton — Task #65.
 *
 * Renders the Apple-branded "Sign in with Apple" button for the web,
 * powered by Apple's official JS SDK (loaded dynamically). The button
 * mirrors Apple's HIG: black background, white Apple-logo + label,
 * 8px radius. Width adapts to the parent container.
 *
 * Flow:
 *   1. Mount → inject `appleid.auth.js` once per page.
 *   2. Load → call AppleID.auth.init({ clientId, scope, redirectURI,
 *      usePopup: true }) with the Service ID + the current origin as
 *      the redirect.
 *   3. Click → AppleID.auth.signIn() returns a Promise that resolves
 *      to { authorization: { id_token, ... }, user?: { name } }.
 *      We post id_token (+ optional name) to /auth/oauth/apple.
 *
 * Props:
 *   • clientId  — Apple Service ID (e.g. dk.bonbox.web). When empty
 *                 the component renders nothing (parity with the
 *                 GoogleLogin pattern: missing env var = no button).
 *   • onSuccess({ idToken, name }) — called on successful Apple flow
 *   • onError(message)             — called on any failure (incl.
 *                                    user cancellation, which Apple
 *                                    surfaces as a polite 'popup_closed_by_user')
 *   • label, mode                  — display tweaks (defaults shown)
 *
 * Renders `null` until the SDK loads to avoid a button that does
 * nothing on click. Loading state stays under 1 second on cached page
 * loads.
 */

// Module-level guard so multiple buttons on the page don't double-
// inject the SDK script. Resolves once `window.AppleID` is available.
let _applePromise = null;

function loadAppleSdk() {
  if (typeof window === "undefined") return Promise.reject(new Error("no-window"));
  if (window.AppleID && window.AppleID.auth) return Promise.resolve(window.AppleID);
  if (_applePromise) return _applePromise;
  _applePromise = new Promise((resolve, reject) => {
    const existing = document.getElementById("apple-signin-sdk");
    if (existing) {
      existing.addEventListener("load", () => resolve(window.AppleID), { once: true });
      existing.addEventListener("error", () => reject(new Error("load_failed")), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.id = "apple-signin-sdk";
    s.async = true;
    s.defer = true;
    s.src = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";
    s.onload = () => {
      if (window.AppleID && window.AppleID.auth) resolve(window.AppleID);
      else reject(new Error("sdk_missing_global"));
    };
    s.onerror = () => reject(new Error("load_failed"));
    document.head.appendChild(s);
  });
  return _applePromise;
}

export default function AppleSignInButton({
  clientId,
  onSuccess,
  onError,
  label = "Sign in with Apple",
  // "signin" or "signup" — only affects the default label
  mode = "signin",
}) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const initialized = useRef(false);

  useEffect(() => {
    if (!clientId) return;
    if (initialized.current) return;
    initialized.current = true;

    let mounted = true;
    loadAppleSdk()
      .then((AppleID) => {
        if (!mounted) return;
        try {
          AppleID.auth.init({
            clientId,
            // "name email" — request the user's name + email scope. Apple
            // only returns name on the FIRST sign-in for a given user,
            // which is why the button collects it and forwards it to
            // /auth/oauth/apple as the `name` body field.
            scope: "name email",
            // redirectURI must EXACTLY match a configured Return URL on
            // the Apple Service ID. Using the current origin keeps dev
            // (localhost), staging, and prod all in sync without env
            // var sprawl (you register one origin per environment in
            // the Apple Developer console).
            redirectURI: typeof window !== "undefined" ? window.location.origin : "",
            // usePopup keeps the user on the same page — no redirect
            // dance, no need to handle ?code= query params on the
            // landing route.
            usePopup: true,
          });
          setReady(true);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("AppleSignInButton: init failed", e);
          if (onError) onError("Apple Sign-In init failed");
        }
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn("AppleSignInButton: SDK load failed", e);
        if (onError) onError("Apple Sign-In is unavailable right now");
      });

    return () => {
      mounted = false;
    };
  }, [clientId, onError]);

  if (!clientId) return null;

  const handleClick = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const result = await window.AppleID.auth.signIn();
      const idToken = result?.authorization?.id_token;
      // Apple returns the user.name as an object { firstName, lastName }
      // ONLY on the first sign-in. We turn it into a flat string the
      // backend uses for business_name on first-touch.
      const u = result?.user || {};
      const fn = u?.name?.firstName || "";
      const ln = u?.name?.lastName || "";
      const name = [fn, ln].filter(Boolean).join(" ").trim() || null;

      if (!idToken) {
        if (onError) onError("Apple did not return a token");
        return;
      }
      if (onSuccess) await onSuccess({ idToken, name });
    } catch (e) {
      // Apple SDK rejects with various shapes — surface a human message.
      const code = e?.error || e?.code || "unknown";
      if (code === "popup_closed_by_user" || code === "user_cancelled_authorize") {
        // Quiet — the user explicitly bailed
        return;
      }
      // eslint-disable-next-line no-console
      console.warn("Apple Sign-In failed:", e);
      if (onError) onError("Apple Sign-In failed");
    } finally {
      setBusy(false);
    }
  };

  // The button mimics Apple's HIG: black background, white text + logo.
  // Stays 44px tall to match Apple's minimum tap-target spec on iOS.
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!ready || busy}
      aria-label={label || (mode === "signup" ? "Sign up with Apple" : "Sign in with Apple")}
      className="w-full flex items-center justify-center gap-2 bg-black text-white rounded-lg
        h-[44px] px-4 text-[15px] font-medium hover:bg-gray-900 transition
        disabled:opacity-60 disabled:cursor-not-allowed
        focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-black"
    >
      <svg width="16" height="18" viewBox="0 0 16 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path
          d="M13.2 13.7c-.3.7-.7 1.4-1.2 2-.7.9-1.5 1.5-2.4 1.5-.4 0-.9-.1-1.5-.4-.6-.3-1.1-.4-1.6-.4-.5 0-1 .1-1.7.4-.6.2-1.1.4-1.5.4-.9 0-1.7-.7-2.5-1.6C.4 14.1 0 12.4 0 10.5c0-1.7.4-3.1 1.3-4.2.7-.9 1.6-1.4 2.7-1.4.4 0 1 .1 1.7.4.7.3 1.2.4 1.4.4.2 0 .7-.1 1.6-.4.8-.3 1.5-.4 2.1-.3 1.5.1 2.7.7 3.4 1.8-1.3.8-2 1.9-2 3.3 0 1.1.4 2 1.2 2.7.4.3.7.6 1.2.7-.1.3-.2.6-.3 1zM11.5 0c.1.7-.2 1.5-.7 2.2-.6.8-1.4 1.3-2.3 1.2-.1-.7.2-1.5.7-2.1.3-.4.7-.7 1.1-.9.4-.2.9-.3 1.2-.4z"
          fill="currentColor"
        />
      </svg>
      <span>{busy ? "…" : label || (mode === "signup" ? "Sign up with Apple" : "Sign in with Apple")}</span>
    </button>
  );
}
