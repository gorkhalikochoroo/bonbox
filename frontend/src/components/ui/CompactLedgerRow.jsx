/**
 * One ledger line on a phone: what + how much on the first line, when / how
 * on the second, the row's actions as quiet icon buttons.
 *
 * DataTable's default phone card prints one label/value pair per line, so a
 * single sale or expense took ~300px and a month of them was a scroll wall.
 * Passed as DataTable's `mobileRow`, a line is ~56px and reads as a list.
 */
export default function CompactLedgerRow({ title, meta = null, amount, actions = [] }) {
  return (
    <div className="flex items-center gap-2 min-h-11">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100">{title}</p>
          <span className="shrink-0 text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{amount}</span>
        </div>
        {meta && <p className="truncate text-xs text-gray-500 dark:text-gray-400">{meta}</p>}
      </div>
      {actions.length > 0 && (
        <div className="flex shrink-0 items-center -mr-2">
          {actions.map((a) => (
            <button
              key={a.id || a.label}
              type="button"
              onClick={(e) => { e.stopPropagation(); a.onClick?.(); }}
              disabled={a.disabled}
              aria-label={a.label}
              title={a.label}
              className={`inline-flex h-11 w-10 min-h-0! items-center justify-center rounded-lg transition disabled:opacity-40 ${
                a.variant === "danger"
                  ? "text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                  : "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
              }`}
            >
              {a.icon}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
