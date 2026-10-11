import { useEffect, useRef } from "react";
import { useGoogleOAuth } from "@react-oauth/google";
import { useLanguage } from "../hooks/useLanguage";

/**
 * GoogleButton — Google's own "Sign up / Sign in with Google" button, drawn in
 * the PAGE's language and redrawn when the owner switches it.
 *
 * Why not <GoogleLogin> from @react-oauth/google (0.13.4): its provider keeps
 * `locale` out of the context's useMemo deps, so a language switch never
 * reaches the button — a Danish page kept "Sign up with Google" from the
 * browser, or the other way round. Remounting the provider (key={lang}) would
 * fix that but remounts the whole page and wipes what the owner has typed.
 *
 * Same callback contract as <GoogleLogin>: onSuccess({ credential, … }) and
 * onError(). The provider's ?hl= on the GSI script covers the first load;
 * renderButton's `locale` covers every switch after it.
 *
 * Outside a GoogleOAuthProvider (no client id configured) it renders the empty
 * 40 px slot and does nothing.
 */
function useGoogleContext() {
  try {
    return useGoogleOAuth();
  } catch {
    return null;
  }
}

export default function GoogleButton({ onSuccess, onError, text = "signin_with", theme = "outline", width = 320 }) {
  const ctx = useGoogleContext();
  const { lang } = useLanguage();
  const slot = useRef(null);
  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
    onErrorRef.current = onError;
  });

  const clientId = ctx ? ctx.clientId : null;
  const scriptLoadedSuccessfully = !!(ctx && ctx.scriptLoadedSuccessfully);

  useEffect(() => {
    if (!scriptLoadedSuccessfully || !clientId) return;
    const gsi = typeof window !== "undefined" ? window.google?.accounts?.id : null;
    if (!gsi || !slot.current) return;
    gsi.initialize({
      client_id: clientId,
      callback: (res) => {
        if (!res || !res.credential) {
          if (onErrorRef.current) onErrorRef.current();
          return;
        }
        onSuccessRef.current({
          credential: res.credential,
          clientId: res.clientId ?? res.client_id,
          select_by: res.select_by,
        });
      },
    });
    gsi.renderButton(slot.current, {
      type: "standard",
      theme,
      size: "large",
      text,
      shape: "rectangular",
      width,
      locale: lang,
    });
  }, [scriptLoadedSuccessfully, clientId, lang, width, theme, text]);

  return <div ref={slot} data-testid="google-button" style={{ height: 40 }} />;
}
