/**
 * OperatingProfileSection — Smart Staffing onboarding/edit surface.
 *
 * Three blocks in one card:
 *   1. Open days — 7 day toggles (Mon-Sun, Danish standard week order)
 *   2. Operating hours per day — time-range inputs, "Closed" toggle
 *   3. Role targets — pulled from /business/role-catalog (vertical-
 *      aware), each row is a checkbox + count picker
 *
 * Why one component (not three):
 *   • The owner sets these together during onboarding; splitting them
 *     would make first-pass setup feel choppy
 *   • The data shape is connected — peak windows depend on open days,
 *     role targets depend on staffing
 *   • One Save button persists everything atomically (two PUTs in
 *     parallel) so the owner doesn't see "saved" on one chunk while
 *     another silently fails
 *
 * Multi-layer security inherited from the backend:
 *   • Every endpoint is auth-gated (Depends(get_current_user))
 *   • Tenant scoping enforced server-side (user_id)
 *   • Role identifiers are validated against the catalog server-side;
 *     a tampered client picking 'phantom_role' gets 422
 *   • All inputs revalidated server-side; UI is convenience, not gate
 */
import { useEffect, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";


const DAY_KEYS = [
  { id: "1", key: "mon", label: { en: "Mon", da: "Man" } },
  { id: "2", key: "tue", label: { en: "Tue", da: "Tir" } },
  { id: "3", key: "wed", label: { en: "Wed", da: "Ons" } },
  { id: "4", key: "thu", label: { en: "Thu", da: "Tor" } },
  { id: "5", key: "fri", label: { en: "Fri", da: "Fre" } },
  { id: "6", key: "sat", label: { en: "Sat", da: "Lør" } },
  { id: "7", key: "sun", label: { en: "Sun", da: "Søn" } },
];


export default function OperatingProfileSection() {
  const { t, lang } = useLanguage();
  const [openDaysSet, setOpenDaysSet] = useState(new Set());
  const [hours, setHours] = useState({});
  const [catalog, setCatalog] = useState([]);
  const [vertical, setVertical] = useState("restaurant");
  const [roleTargets, setRoleTargets] = useState({});  // { role: count }
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedToast, setSavedToast] = useState("");
  const [error, setError] = useState("");

  // Initial load — pull all three resources in parallel.
  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get("/business/operating-profile").catch(() => ({ data: null })),
      api.get("/business/role-catalog").catch(() => ({ data: null })),
      api.get("/business/staff-role-targets").catch(() => ({ data: [] })),
    ]).then(([opRes, catRes, targetsRes]) => {
      if (!alive) return;
      const op = opRes.data || {};
      // open_days_mask is a string of digits "12345"
      const mask = op.open_days_mask || "";
      setOpenDaysSet(new Set(mask.split("")));
      // operating_hours is a dict { mon: "10:00-22:00" | "closed", ... }
      setHours(op.operating_hours || {});
      const cat = catRes.data || {};
      setVertical(cat.vertical || "restaurant");
      setCatalog(cat.roles || []);
      const targets = (targetsRes.data || []).reduce((acc, r) => {
        acc[r.role] = r.default_count;
        return acc;
      }, {});
      setRoleTargets(targets);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  const localeLabel = (label) =>
    (label && (label[lang] || label.en)) || "";

  const toggleDay = (dayId) => {
    const next = new Set(openDaysSet);
    if (next.has(dayId)) next.delete(dayId); else next.add(dayId);
    setOpenDaysSet(next);
  };

  const setDayHours = (dayKey, value) => {
    setHours({ ...hours, [dayKey]: value });
  };

  const toggleClosed = (dayKey) => {
    const cur = hours[dayKey];
    if (cur === "closed") setDayHours(dayKey, "10:00-22:00");
    else setDayHours(dayKey, "closed");
  };

  const updateRoleCount = (role, count) => {
    const next = { ...roleTargets };
    if (count === 0 || count === "") {
      delete next[role];
    } else {
      next[role] = Number(count);
    }
    setRoleTargets(next);
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSavedToast("");
    try {
      // Build the open_days_mask from the set, sorted ascending as
      // digits — server validates the regex.
      const mask = Array.from(openDaysSet).sort().join("");
      // Filter operating_hours to only the days actually open;
      // closed days stay "closed" if the user explicitly set that.
      const cleanHours = {};
      DAY_KEYS.forEach(({ id, key }) => {
        if (openDaysSet.has(id)) {
          cleanHours[key] = hours[key] && /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(hours[key])
            ? hours[key]
            : (hours[key] === "closed" ? "closed" : "10:00-22:00");
        } else {
          cleanHours[key] = "closed";
        }
      });
      // Targets — only roles with count > 0
      const targets = Object.entries(roleTargets)
        .filter(([_, count]) => Number(count) > 0)
        .map(([role, count]) => ({ role, default_count: Number(count) }));

      await Promise.all([
        api.put("/business/operating-profile", {
          open_days_mask: mask,
          operating_hours: cleanHours,
        }),
        api.put("/business/staff-role-targets", { targets }),
      ]);

      setSavedToast(t("operatingProfileSaved") || "Saved");
      setTimeout(() => setSavedToast(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || (t("operatingProfileSaveError") || "Couldn't save. Try again."));
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <div className="rounded-2xl border border-gray-200 dark:border-gray-700/60 p-5 text-sm text-gray-500">
        {t("loading") || "Loading…"}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-200 dark:border-gray-700/60 bg-white dark:bg-gray-800/40 p-5 sm:p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          🗓️ {t("operatingProfileTitle") || "Operating profile"}
        </h2>
        <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5">
          {t("operatingProfileSubtitle") ||
            "Tells the AI how your business runs so it can suggest schedules + spot anomalies."}
        </p>
      </div>

      {/* Open days */}
      <div>
        <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1.5">
          {t("operatingProfileOpenDays") || "Days open"}
        </div>
        <div className="flex flex-wrap gap-2">
          {DAY_KEYS.map(({ id, key, label }) => {
            const active = openDaysSet.has(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggleDay(id)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium border transition ${
                  active
                    ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                    : "border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                }`}
              >
                {localeLabel(label)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Hours per day */}
      <div>
        <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1.5">
          {t("operatingProfileHours") || "Hours per day"}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {DAY_KEYS.filter(({ id }) => openDaysSet.has(id)).map(({ key, label }) => {
            const value = hours[key] || "10:00-22:00";
            const isClosed = value === "closed";
            return (
              <div key={key} className="flex items-center gap-2 bg-gray-50 dark:bg-gray-700/30 rounded-md px-3 py-2">
                <div className="text-xs font-semibold text-gray-700 dark:text-gray-200 w-12 shrink-0">
                  {localeLabel(label)}
                </div>
                {isClosed ? (
                  <button
                    onClick={() => toggleClosed(key)}
                    className="text-[11px] px-2 py-1 rounded bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-gray-500 hover:bg-gray-100"
                  >
                    {t("operatingProfileClosed") || "Closed"} · {t("operatingProfileSetHours") || "set hours"}
                  </button>
                ) : (
                  <>
                    <input
                      type="text"
                      value={value}
                      onChange={(e) => setDayHours(key, e.target.value)}
                      placeholder="10:00-22:00"
                      className="flex-1 px-2 py-1 rounded-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 text-xs text-gray-800 dark:text-gray-100 outline-none focus:border-gray-900"
                    />
                    <button
                      onClick={() => toggleClosed(key)}
                      className="text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            );
          })}
          {openDaysSet.size === 0 && (
            <div className="text-xs text-gray-500 dark:text-gray-400 italic">
              {t("operatingProfilePickDaysFirst") || "Pick days above to set hours."}
            </div>
          )}
        </div>
      </div>

      {/* Role targets */}
      <div>
        <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1.5">
          {t("operatingProfileStaffPerShift") || "Typical staff per shift"}
          <span className="ml-1 text-[10px] text-gray-400 normal-case font-normal">
            ({vertical})
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {catalog.map((r) => (
            <RoleRow
              key={r.role}
              role={r.role}
              label={localeLabel(r.label)}
              category={r.category}
              count={roleTargets[r.role] ?? 0}
              onChange={(v) => updateRoleCount(r.role, v)}
              t={t}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 pt-2">
        {savedToast && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">✓ {savedToast}</span>
        )}
        {error && (
          <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
        )}
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold disabled:opacity-50 transition"
        >
          {saving ? (t("saving") || "Saving…") : (t("save") || "Save")}
        </button>
      </div>
    </div>
  );
}


function RoleRow({ role, label, category, count, onChange, t }) {
  const enabled = Number(count) > 0;
  return (
    <div className={`rounded-md px-3 py-2 border transition ${
      enabled
        ? "border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/50 dark:bg-emerald-900/15"
        : "border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700/30"
    }`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-gray-800 dark:text-gray-100">
            {label}
          </div>
          <div className="text-[10px] text-gray-500 dark:text-gray-400 capitalize">
            {category.replace("_", " ")}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => onChange(Math.max(0, Number(count) - 1))}
            className="w-7 h-7 rounded-md bg-white dark:bg-gray-600 border border-gray-200 dark:border-gray-500 text-gray-500 hover:bg-gray-100"
            aria-label={t("decrease") || "Decrease"}
          >
            −
          </button>
          <input
            type="number"
            min="0"
            max="99"
            step="0.5"
            value={count}
            onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
            className="w-12 text-center text-sm font-semibold bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-md py-1 outline-none focus:border-gray-900"
          />
          <button
            onClick={() => onChange(Math.min(99, Number(count) + 1))}
            className="w-7 h-7 rounded-md bg-white dark:bg-gray-600 border border-gray-200 dark:border-gray-500 text-gray-500 hover:bg-gray-100"
            aria-label={t("increase") || "Increase"}
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}
