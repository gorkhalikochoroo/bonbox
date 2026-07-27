/**
 * NavV2 — sticky top bar for the v2 landing page.
 *
 * Ported 1:1 from frontend/dist/newlanding.html: 66px tall, sticky, a 1px
 * slate-200 hairline underneath and a blurred slate-50/88% pane behind it.
 *
 * ONE DELIBERATE ADDITION: the source design simply hides the link row below
 * 860px and offers nothing in its place, which strands every in-page section
 * on a phone. So there is a real <button> here that toggles a panel holding
 * the same anchors — same copy, same order, no new destinations.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Menu, Receipt, X } from "lucide-react";
import { useLanguage } from "../../../hooks/useLanguage";

/** Landing copy exists in these two only — see the switcher comment below. */
const LANDING_LANGS = ["da", "en"];

export default function NavV2() {
  const { t, lang, setLang } = useLanguage();
  const [open, setOpen] = useState(false);
  const toggleRef = useRef(null);

  const links = [
    { href: "#modules", label: t("landingV2.nav.product", "Product") },
    { href: "#reservations", label: t("landingV2.nav.reservations", "Reservations") },
    { href: "#staff", label: t("landingV2.nav.staffApp", "Staff app") },
    { href: "#ai", label: t("landingV2.nav.ai", "BonBox AI") },
    { href: "#pricing", label: t("landingV2.nav.pricing", "Pricing") },
  ];

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-slate-50/[0.88] backdrop-blur-[14px]">
      <div className="mx-auto flex h-[66px] w-full max-w-[1800px] items-center gap-9 px-[clamp(24px,4vw,80px)]">
        <a href="#top" className="flex items-center gap-2.5" onClick={close}>
          <span
            aria-hidden="true"
            className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[9px] bg-bb-green"
          >
            <Receipt size={15} strokeWidth={1.75} className="text-white" />
          </span>
          <span className="font-display text-[19px] font-bold tracking-[-0.025em] text-slate-900">
            BonBox
          </span>
        </a>

        <nav
          aria-label={t("landingV2.nav.sections", "Sections")}
          className="hidden gap-[26px] text-[14.5px] text-slate-600 min-[860px]:flex"
        >
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="transition-colors duration-150 hover:text-slate-900"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-[18px]">
          {/* Language. The old landing page carried a <select> of all seven
              app languages; swapping the front door to this page dropped it
              entirely, so a visitor had no way to reach the Danish copy.
              Restored as DA/EN only, deliberately: the landing keys exist in
              exactly two languages (271/271 en, 271/271 da, 0/271 np, no
              section at all for de/vi/th/tr), so listing the other five would
              hand someone an English page under a Turkish label. Same
              segmented shape as the booking demo's own DA/EN switch. */}
          <div
            className="flex items-center gap-1.5 text-[13px] font-semibold"
            role="group"
            aria-label={t("landingV2.nav.language", "Language")}
          >
            {LANDING_LANGS.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => {
                  setLang(code);
                  close();
                }}
                aria-pressed={lang === code}
                className={
                  lang === code
                    ? "text-slate-900"
                    : "text-slate-400 transition-colors duration-150 hover:text-slate-600"
                }
              >
                {code.toUpperCase()}
              </button>
            ))}
          </div>

          <button
            ref={toggleRef}
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="bb-nav-panel"
            aria-label={
              open
                ? t("landingV2.nav.closeMenu", "Close menu")
                : t("landingV2.nav.openMenu", "Open menu")
            }
            className="-ml-1 flex h-9 w-9 items-center justify-center rounded-full text-slate-600 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-900 min-[860px]:hidden"
          >
            {open ? (
              <X size={19} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Menu size={19} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>

          <Link
            to="/login"
            className="text-[14.5px] text-slate-600 transition-colors duration-150 hover:text-slate-900"
            onClick={close}
          >
            {t("landingV2.nav.login", "Log in")}
          </Link>
          <a
            href="#pricing"
            className="rounded-full bg-slate-900 px-[18px] py-[9px] text-[14.5px] font-medium text-white transition-colors duration-[160ms] ease-[cubic-bezier(0.22,0.61,0.36,1)] hover:bg-bb-green"
            onClick={close}
          >
            {t("landingV2.nav.cta", "Start free")}
          </a>
        </div>
      </div>

      <div
        id="bb-nav-panel"
        hidden={!open}
        className="border-t border-slate-200 bg-slate-50 min-[860px]:hidden"
      >
        <nav
          aria-label={t("landingV2.nav.sections", "Sections")}
          className="mx-auto flex w-full max-w-[1800px] flex-col px-[clamp(24px,4vw,80px)] py-2"
        >
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={close}
              className="border-b border-slate-200 py-3 text-[15px] text-slate-600 last:border-b-0 hover:text-slate-900"
            >
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}
