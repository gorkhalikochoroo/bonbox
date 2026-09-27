import { useEffect, useRef } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";

/**
 * Tells the server which language this owner reads the app in, so the pushes
 * it writes — a new booking, a sick call, a waste alert — arrive in that
 * language. The language is picked per device; the one used last wins.
 *
 * Saves only when the account's value differs, once per language — no request
 * on an ordinary page load. Renders nothing.
 */
export default function AccountLanguageSync() {
  const { user } = useAuth();
  const { lang } = useLanguage();
  const sent = useRef(null);

  useEffect(() => {
    if (!user || !lang || user.ui_language === lang || sent.current === lang) return;
    sent.current = lang;
    api.patch("/auth/profile", { ui_language: lang }).catch(() => {
      sent.current = null; // not saved — try again on the next load or switch
    });
  }, [user, lang]);

  return null;
}
