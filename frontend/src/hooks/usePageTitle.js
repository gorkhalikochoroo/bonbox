import { useEffect, useRef } from "react";
import { useLanguage } from "./useLanguage";
import { shellTitle } from "../lib/shellTitles";

/**
 * usePageTitle — the browser tab names the page it is on (PQ-16).
 *
 * Every auth page shared index.html's one title, so a phone's tab switcher
 * and a screen reader announced "BonBox — Bagkontoret …" for sign-up, log-in,
 * the code screen and the wizard alike.
 *
 * Sets document.title to t(key) on mount and again whenever the language
 * changes. On unmount it puts back the shell title in the language that is on
 * screen THEN (not the one the page opened in — JoinPage's `prev` pattern
 * would restore a Danish title after a switch to English). The language
 * provider only swaps a title that is still a shell title, so it never
 * overwrites the page's own.
 */
export default function usePageTitle(key) {
  const { t, lang } = useLanguage();
  const langRef = useRef(lang);

  useEffect(() => {
    langRef.current = lang;
    if (typeof document === "undefined") return;
    document.title = t(key);
  }, [key, t, lang]);

  useEffect(
    () => () => {
      if (typeof document === "undefined") return;
      document.title = shellTitle(langRef.current);
    },
    [],
  );
}
