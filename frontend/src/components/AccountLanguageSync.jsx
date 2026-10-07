import { useEffect, useRef } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useGuestSurface } from "../lib/guestSurface";

/**
 * Tells the server which language this owner reads the app in, so the pushes
 * it writes — a new booking, a sick call, a waste alert — arrive in that
 * language. The language is picked per device; the one used last wins.
 *
 * Saves only when the account's value differs, once per language — no request
 * on an ordinary page load. Renders nothing.
 */
function onStaffPage() {
  try {
    const p = window.location.pathname;
    return p === "/join" || p.startsWith("/join/") || p.startsWith("/s/");
  } catch {
    return false;
  }
}

export default function AccountLanguageSync() {
  const { user } = useAuth();
  const { lang } = useLanguage();
  const sent = useRef(null);
  // On a guest's booking page the language is the GUEST's choice — an owner
  // logged in on the same device (the door iPad) must not have their account
  // language (and so their notifications) switched by a guest tapping EN.
  const onGuestPage = useGuestSurface();

  useEffect(() => {
    // Same on the staff pages (/join, /s/<token>): their DA/EN switch is the
    // STAFFER's choice, made on whatever device is at hand — the owner's
    // phone, the café iPad. Not a guest surface (that would also drop the
    // cookie banner), so the path decides.
    if (onStaffPage()) return;
    if (onGuestPage || !user || !lang || user.ui_language === lang || sent.current === lang) return;
    sent.current = lang;
    api.patch("/auth/profile", { ui_language: lang }).catch(() => {
      sent.current = null; // not saved — try again on the next load or switch
    });
  }, [user, lang, onGuestPage]);

  return null;
}
