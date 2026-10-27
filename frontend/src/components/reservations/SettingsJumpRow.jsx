// "Gå til" — the phone's way through Indstillinger (R9, 27 Oct 2026; rubric
// R12: each setting within two screens of scroll).
//
// On a 390 px phone the settings page is about eight screens long: the
// name, the switch, the link, the website kit, the hours, the closed dates,
// the rules, the e-mails, the blocked contacts, SMS and the door devices. A
// first-week owner asked to "close 24 Dec and set lunch + dinner" had to
// hunt. One quiet row of jumps at the top, phone only (desktop is unchanged).
// Each jump scrolls its card to the top of the screen.
export default function SettingsJumpRow({ t, items = [] }) {
  const go = (id) => {
    const el = typeof document !== "undefined" ? document.getElementById(id) : null;
    if (!el) return;
    el.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };
  const shown = items.filter((it) => it && it.id && it.label);
  if (shown.length === 0) return null;
  return (
    <nav
      aria-label={t("rsvpJumpAria", "On this page")}
      data-testid="rsvp-settings-jump"
      className="sm:hidden -mx-4 px-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex items-center gap-2 w-max">
        <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">{t("rsvpJumpLabel", "Go to")}</span>
        {shown.map((it) => (
          <button
            key={it.id}
            type="button"
            onClick={() => go(it.id)}
            className="h-9 min-h-0! px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[rgb(var(--surface-card))] text-[13px] font-medium text-gray-700 dark:text-gray-200 whitespace-nowrap"
          >
            {it.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
