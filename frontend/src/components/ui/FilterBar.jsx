/**
 * FilterBar — date-range + select + search + reset, the row that sits
 * above every Recent-X table.
 *
 * Pattern observed 4+ times across the app (Sales, Expenses, CashBook,
 * Faktura, BankImport): a row of date pickers, an event/category select,
 * a search box, and a "Reset" that only shows when at least one filter
 * has a non-default value.
 *
 * Before this each page rolled its own row, with subtly different label
 * sizing, different gap, and different "Reset" behaviour. This component
 * collapses them all and uses <Input> internally so the chrome stays
 * identical to every other field in the app.
 *
 * Compound component pattern — sub-components are namespaced:
 *
 *   <FilterBar>
 *     <FilterBar.Date  label="From" value={from} onChange={setFrom} />
 *     <FilterBar.Date  label="To"   value={to}   onChange={setTo} />
 *     <FilterBar.Select label="Event" value={ev} onChange={setEv}
 *                       options={[{value:"all",label:"All events"}, ...]} />
 *     <FilterBar.Search value={q} onChange={setQ} placeholder="Search..." />
 *     <FilterBar.Reset onClick={() => { setFrom(""); setTo(""); ... }} />
 *   </FilterBar>
 *
 * Layout:
 *   • Mobile: each control stacks full-width.
 *   • sm+:    controls flow left-to-right, ending baselines aligned
 *             (sm:items-end) so labels sit above the inputs neatly.
 *
 * Reset behaviour: it's the parent's job to decide what "default" means
 * (the parent compares from/to/event/q to its defaults and only renders
 * <FilterBar.Reset /> when at least one differs). We don't centralize
 * that here because "default" varies per page (Sales = last 30 days,
 * BankImport = all-time, etc).
 */
import React from "react";
import Button from "./Button";
import Input from "./Input";
import { X, Search, ChevronDown } from "lucide-react";

/**
 * FilterBar — outer flex row. Wraps to a stack on mobile, row on sm+.
 * `items-end` so labelled controls visually align by the input baseline.
 */
function FilterBar({ children, className = "" }) {
  return (
    <div
      className={
        "flex flex-col sm:flex-row sm:items-end gap-2 sm:gap-3 " + className
      }
    >
      {children}
    </div>
  );
}

/**
 * Field — internal helper. Renders a label + control pair so every
 * sub-component shares the same micro-typography for the floating label.
 */
function Field({ label, htmlFor, children, className = "" }) {
  return (
    <div className={"flex flex-col gap-1 min-w-0 " + className}>
      {label && (
        <label
          htmlFor={htmlFor}
          className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400"
        >
          {label}
        </label>
      )}
      {children}
    </div>
  );
}

/**
 * FilterBar.Date — a date input. Uses native <input type="date"> which
 * gives us platform-correct date pickers without an extra dependency.
 * Wrapped in <Input> for chrome consistency.
 */
function FilterBarDate({
  label = "From",
  value = "",
  onChange,
  id,
  className = "",
  ...rest
}) {
  const inputId = id || `fb-date-${(label || "date").toLowerCase()}`;
  return (
    <Field label={label} htmlFor={inputId} className={className}>
      <Input
        id={inputId}
        type="date"
        size="md"
        value={value}
        onChange={(e) => onChange && onChange(e.target.value)}
        {...rest}
      />
    </Field>
  );
}

/**
 * FilterBar.Select — native <select> styled to match Input chrome.
 *
 * We deliberately don't render this through <Input>: <select> has its
 * own intrinsic behaviour (chevron, dropdown) that we don't want to
 * re-implement. Instead we mirror Input's classes so the row stays
 * visually consistent.
 */
function FilterBarSelect({
  label = "Filter",
  value = "",
  onChange,
  options = [],
  id,
  className = "",
  placeholder = null,
  ...rest
}) {
  const selectId = id || `fb-select-${(label || "select").toLowerCase()}`;
  return (
    <Field label={label} htmlFor={selectId} className={className}>
      <div
        className={
          "relative flex items-center rounded-lg border bg-white dark:bg-gray-900 " +
          "border-gray-200 dark:border-gray-700 h-10 transition " +
          "focus-within:border-gray-400 dark:focus-within:border-gray-500 " +
          "focus-within:ring-1 focus-within:ring-gray-400 dark:focus-within:ring-gray-500"
        }
      >
        <select
          id={selectId}
          value={value}
          onChange={(e) => onChange && onChange(e.target.value)}
          className={
            "flex-1 min-w-0 bg-transparent outline-none border-0 " +
            "pl-3 pr-8 text-sm text-gray-900 dark:text-gray-100 " +
            "appearance-none cursor-pointer"
          }
          {...rest}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className="pointer-events-none absolute right-2.5 text-gray-500 dark:text-gray-400"
          aria-hidden="true"
        />
      </div>
    </Field>
  );
}

/**
 * FilterBar.Search — a search input with a leading magnifier icon.
 * Defaults to `type="search"` so iOS/Android offer a Search key on the
 * on-screen keyboard.
 */
function FilterBarSearch({
  label = null,
  value = "",
  onChange,
  placeholder = "Search...",
  id,
  className = "",
  ...rest
}) {
  const inputId = id || "fb-search";
  return (
    <Field label={label} htmlFor={inputId} className={"flex-1 " + className}>
      <Input
        id={inputId}
        type="search"
        size="md"
        value={value}
        onChange={(e) => onChange && onChange(e.target.value)}
        placeholder={placeholder}
        prefix={<Search size={14} strokeWidth={1.75} aria-hidden="true" />}
        {...rest}
      />
    </Field>
  );
}

/**
 * FilterBar.Reset — the "clear all filters" button. Renders as a ghost
 * Button with an X icon. Parent should conditionally render this only
 * when at least one filter differs from the page's defaults — see the
 * top-of-file doc for why we leave that decision to the parent.
 */
function FilterBarReset({
  label = "Reset",
  onClick,
  className = "",
  ...rest
}) {
  return (
    <div className={"flex items-end " + className}>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        iconLeft={<X size={14} strokeWidth={1.75} aria-hidden="true" />}
        {...rest}
      >
        {label}
      </Button>
    </div>
  );
}

FilterBar.Date = FilterBarDate;
FilterBar.Select = FilterBarSelect;
FilterBar.Search = FilterBarSearch;
FilterBar.Reset = FilterBarReset;

export default FilterBar;
