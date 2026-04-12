import { useState, useEffect, useMemo, useCallback } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useBranch } from "../components/BranchSelector";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";

/* ═══════════════════════════════════════════════════════════
   CONSTANTS & HELPERS
   ═══════════════════════════════════════════════════════════ */
const ROLES = ["Chef", "Bartender", "Server", "Runner", "Dishwasher", "Manager"];
const CONTRACT_TYPES = [
  { value: "full", label: "Full-time" },
  { value: "part", label: "Part-time" },
  { value: "student", label: "Student" },
  { value: "freelance", label: "Freelance" },
];

const ROLE_CATEGORY = {
  Chef: "kitchen",
  Dishwasher: "kitchen",
  Bartender: "bar",
  Server: "floor",
  Runner: "floor",
  Manager: "floor",
};

const ROLE_COLORS = {
  kitchen: {
    bg: "bg-red-100 dark:bg-red-900/20",
    text: "text-red-800 dark:text-red-300",
    border: "border-red-200 dark:border-red-800",
    dot: "bg-red-500",
    label: "Kitchen",
  },
  bar: {
    bg: "bg-blue-100 dark:bg-blue-900/20",
    text: "text-blue-800 dark:text-blue-300",
    border: "border-blue-200 dark:border-blue-800",
    dot: "bg-blue-500",
    label: "Bar",
  },
  floor: {
    bg: "bg-green-100 dark:bg-green-900/20",
    text: "text-green-800 dark:text-green-300",
    border: "border-green-200 dark:border-green-800",
    dot: "bg-green-500",
    label: "Floor",
  },
};

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTE_OPTIONS = ["00", "15", "30", "45"];

/** Returns Monday of the week containing the given date */
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/** Returns ISO week number */
function getISOWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/** Formats "Week 15: 7 Apr – 13 Apr 2026" */
function formatWeekRange(weekStart) {
  const ws = new Date(weekStart);
  const we = new Date(ws);
  we.setDate(we.getDate() + 6);
  const weekNum = getISOWeekNumber(ws);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const startStr = `${ws.getDate()} ${monthNames[ws.getMonth()]}`;
  const endStr = `${we.getDate()} ${monthNames[we.getMonth()]} ${we.getFullYear()}`;
  return `Week ${weekNum}: ${startStr} – ${endStr}`;
}

/** Returns array of 7 Date objects starting from weekStart (Monday) */
function getWeekDates(weekStart) {
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    dates.push(d);
  }
  return dates;
}

/** Format date as YYYY-MM-DD */
function toISO(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Format shift time for display: "16:00-23:00" -> "16-23" */
function formatShiftTime(start, end) {
  if (!start || !end) return "";
  const s = start.slice(0, 5);
  const e = end.slice(0, 5);
  const sShort = s.endsWith(":00") ? s.split(":")[0] : s;
  const eShort = e.endsWith(":00") ? e.split(":")[0] : e;
  return `${sShort}-${eShort}`;
}

/** Calculate hours between two HH:MM times minus break */
function calcHours(startTime, endTime, breakMinutes = 0) {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  let totalMinutes = (eh * 60 + em) - (sh * 60 + sm);
  if (totalMinutes < 0) totalMinutes += 24 * 60; // overnight shift
  totalMinutes -= breakMinutes;
  return Math.max(0, totalMinutes / 60);
}

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════ */
export default function StaffSchedulePage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { branchId } = useBranch();
  const currency = displayCurrency(user?.currency);

  // Week navigation
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
  const weekDates = useMemo(() => getWeekDates(weekStart), [weekStart]);

  // Data
  const [staff, setStaff] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Staff management panel
  const [showManageStaff, setShowManageStaff] = useState(false);

  // Shift modal
  const [shiftModal, setShiftModal] = useState(null); // { staffId, date, shift? }

  // Action states
  const [copying, setCopying] = useState(false);
  const [publishing, setPublishing] = useState(false);

  /* ─── Data fetching ─── */
  const fetchStaff = useCallback(async () => {
    try {
      const params = {};
      if (branchId) params.branch_id = branchId;
      const res = await api.get("/staff/members", { params });
      setStaff(res.data || []);
    } catch {
      // Staff list may not exist yet
      setStaff([]);
    }
  }, [branchId]);

  const fetchShifts = useCallback(async () => {
    try {
      const params = { week_start: toISO(weekStart) };
      if (branchId) params.branch_id = branchId;
      const res = await api.get("/staff/schedules", { params });
      setShifts(res.data || []);
    } catch {
      setShifts([]);
    }
  }, [weekStart, branchId]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError("");
    await Promise.all([fetchStaff(), fetchShifts()]);
    setLoading(false);
  }, [fetchStaff, fetchShifts]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  /* ─── Week navigation ─── */
  const goToPrevWeek = () => {
    const prev = new Date(weekStart);
    prev.setDate(prev.getDate() - 7);
    setWeekStart(prev);
  };

  const goToNextWeek = () => {
    const next = new Date(weekStart);
    next.setDate(next.getDate() + 7);
    setWeekStart(next);
  };

  const goToCurrentWeek = () => {
    setWeekStart(getWeekStart(new Date()));
  };

  /* ─── Actions ─── */
  const handleCopyLastWeek = async () => {
    setCopying(true);
    setError("");
    try {
      const prevWeek = new Date(weekStart);
      prevWeek.setDate(prevWeek.getDate() - 7);
      await api.post("/staff/schedules/copy-week", {
        source_week: toISO(prevWeek),
        target_week: toISO(weekStart),
        branch_id: branchId || undefined,
      });
      await fetchShifts();
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to copy last week's schedule.");
    }
    setCopying(false);
  };

  const handlePublish = async () => {
    setPublishing(true);
    setError("");
    try {
      const params = { week_start: toISO(weekStart) };
      if (branchId) params.branch_id = branchId;
      await api.post("/staff/schedules/publish", null, { params });
      await fetchShifts();
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to publish schedule.");
    }
    setPublishing(false);
  };

  /* ─── Shift helpers ─── */
  const getShiftForCell = (staffId, date) => {
    const dateStr = toISO(date);
    return shifts.find(
      (s) => (s.staff_member_id === staffId || s.staff_id === staffId) && s.date === dateStr
    );
  };

  const activeStaff = useMemo(() => staff.filter((s) => s.is_active !== false), [staff]);

  /* ─── Stats ─── */
  const stats = useMemo(() => {
    let totalHours = 0;
    let totalCost = 0;
    shifts.forEach((s) => {
      const hrs = calcHours(s.start_time, s.end_time, s.break_minutes || 0);
      totalHours += hrs;
      const member = staff.find((m) => m.id === (s.staff_member_id || s.staff_id));
      const rate = member?.base_rate || 0;
      totalCost += hrs * rate;
    });
    return {
      totalHours: Math.round(totalHours * 10) / 10,
      totalCost: Math.round(totalCost),
      activeCount: activeStaff.length,
    };
  }, [shifts, staff, activeStaff]);

  /* ─── Render ─── */
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <FadeIn>
        <h1 className="text-2xl font-bold dark:text-white flex items-center gap-2">
          {"\uD83D\uDCC5"} {t("staffSchedule") || "Staff Schedule"}
        </h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
          {t("staffScheduleDesc") || "Plan weekly shifts, manage staff, and track labor costs."}
        </p>
      </FadeIn>

      {/* Week navigation + actions */}
      <FadeIn delay={0.05}>
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-4">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            {/* Week nav */}
            <div className="flex items-center gap-2">
              <button
                onClick={goToPrevWeek}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition"
              >
                {"\u2190"} Previous
              </button>
              <button
                onClick={goToCurrentWeek}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-gray-50 dark:bg-gray-750 text-gray-900 dark:text-white border border-gray-200 dark:border-gray-600 min-w-[220px] text-center"
              >
                {formatWeekRange(weekStart)}
              </button>
              <button
                onClick={goToNextWeek}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition"
              >
                Next {"\u2192"}
              </button>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2 flex-wrap justify-center">
              <button
                onClick={() => setShiftModal({ staffId: null, date: null, shift: null })}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition"
              >
                + Add Shift
              </button>
              <button
                onClick={handleCopyLastWeek}
                disabled={copying}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition disabled:opacity-50"
              >
                {copying ? "Copying..." : "Copy Last Week"}
              </button>
              <button
                onClick={handlePublish}
                disabled={publishing}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition disabled:opacity-50"
              >
                {publishing ? "Publishing..." : "Publish Week"}
              </button>
              <button
                disabled
                title="PDF export coming soon"
                className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed"
              >
                PDF
              </button>
            </div>
          </div>
        </div>
      </FadeIn>

      {/* Error banner */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-3 text-red-700 dark:text-red-300 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError("")} className="ml-2 text-red-500 hover:text-red-700 font-bold">{"\u00D7"}</button>
        </div>
      )}

      {/* Manage Staff collapsible */}
      <FadeIn delay={0.1}>
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700">
          <button
            onClick={() => setShowManageStaff(!showManageStaff)}
            className="w-full flex items-center justify-between px-5 py-4 text-left"
          >
            <span className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              {"\uD83D\uDC65"} Manage Staff
              <span className="text-xs font-normal text-gray-400 dark:text-gray-500">
                ({activeStaff.length} active)
              </span>
            </span>
            <span className="text-gray-400 dark:text-gray-500 text-lg transition-transform" style={{ transform: showManageStaff ? "rotate(180deg)" : "rotate(0)" }}>
              {"\u25BC"}
            </span>
          </button>
          {showManageStaff && (
            <StaffPanel
              staff={staff}
              currency={currency}
              onRefresh={fetchStaff}
              branchId={branchId}
            />
          )}
        </div>
      </FadeIn>

      {/* Color legend */}
      <FadeIn delay={0.12}>
        <div className="flex items-center gap-4 flex-wrap text-xs text-gray-500 dark:text-gray-400">
          <span className="font-medium">Shift colors:</span>
          {Object.entries(ROLE_COLORS).map(([key, c]) => (
            <span key={key} className="flex items-center gap-1.5">
              <span className={`w-3 h-3 rounded-full ${c.dot}`} />
              {c.label}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full bg-gray-300 dark:bg-gray-600" />
            OFF / No shift
          </span>
        </div>
      </FadeIn>

      {/* Schedule Grid */}
      <FadeIn delay={0.15}>
        {loading ? (
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-12 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600 mx-auto mb-3" />
            <p className="text-gray-500 dark:text-gray-400 text-sm">Loading schedule...</p>
          </div>
        ) : activeStaff.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-12 text-center">
            <p className="text-4xl mb-3">{"\uD83D\uDC65"}</p>
            <p className="text-gray-500 dark:text-gray-400 text-sm">
              No staff members yet. Open "Manage Staff" above to add your team.
            </p>
          </div>
        ) : (
          <ScheduleGrid
            staff={activeStaff}
            weekDates={weekDates}
            shifts={shifts}
            getShiftForCell={getShiftForCell}
            onCellClick={(staffId, date, existingShift) =>
              setShiftModal({ staffId, date: toISO(date), shift: existingShift || null })
            }
          />
        )}
      </FadeIn>

      {/* Bottom stats */}
      <FadeIn delay={0.2}>
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-4">
          <div className="flex flex-wrap items-center justify-center gap-6 text-sm">
            <span className="text-gray-600 dark:text-gray-300">
              Total scheduled: <strong className="text-gray-900 dark:text-white">{stats.totalHours} hrs</strong>
            </span>
            <span className="text-gray-300 dark:text-gray-600">|</span>
            <span className="text-gray-600 dark:text-gray-300">
              Estimated cost: <strong className="text-gray-900 dark:text-white">{stats.totalCost.toLocaleString()} {currency}</strong>
            </span>
            <span className="text-gray-300 dark:text-gray-600">|</span>
            <span className="text-gray-600 dark:text-gray-300">
              Staff: <strong className="text-gray-900 dark:text-white">{stats.activeCount} active</strong>
            </span>
          </div>
        </div>
      </FadeIn>

      {/* Shift Modal */}
      {shiftModal && (
        <ShiftModal
          modal={shiftModal}
          staff={activeStaff}
          weekDates={weekDates}
          onClose={() => setShiftModal(null)}
          onSaved={() => {
            setShiftModal(null);
            fetchShifts();
          }}
          branchId={branchId}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   STAFF MANAGEMENT PANEL
   ═══════════════════════════════════════════════════════════ */
function StaffPanel({ staff, currency, onRefresh, branchId }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState(ROLES[0]);
  const [contractType, setContractType] = useState("full");
  const [baseRate, setBaseRate] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [panelError, setPanelError] = useState("");
  const [linkModal, setLinkModal] = useState(null); // { staffName, portalUrl, loading }
  const [linkCopied, setLinkCopied] = useState(false);

  const generateLink = async (member) => {
    setLinkModal({ staffName: member.name, portalUrl: null, loading: true });
    try {
      const res = await api.post(`/staff/members/${member.id}/link`);
      const origin = window.location.origin;
      const fullUrl = `${origin}${res.data.portal_url}`;
      setLinkModal({ staffName: member.name, portalUrl: fullUrl, loading: false });
    } catch (err) {
      setPanelError(err.response?.data?.detail || "Failed to generate link");
      setLinkModal(null);
    }
  };

  const copyLink = async () => {
    if (!linkModal?.portalUrl) return;
    try {
      await navigator.clipboard.writeText(linkModal.portalUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const input = document.createElement("input");
      input.value = linkModal.portalUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }
  };

  const shareLink = async () => {
    if (!linkModal?.portalUrl) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: `${linkModal.staffName}'s BonBox Schedule`,
          text: `Hi ${linkModal.staffName}! Here's your BonBox portal link to see your schedule, hours, and tips 👉`,
          url: linkModal.portalUrl,
        });
      } catch { /* user cancelled */ }
    } else {
      copyLink();
    }
  };

  const handleAdd = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setPanelError("");
    try {
      await api.post("/staff/members", {
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        role,
        contract_type: contractType,
        base_rate: parseFloat(baseRate) || 0,
        branch_id: branchId || undefined,
      });
      setName("");
      setEmail("");
      setPhone("");
      setRole(ROLES[0]);
      setContractType("full");
      setBaseRate("");
      onRefresh();
    } catch (err) {
      setPanelError(err.response?.data?.detail || "Failed to add staff member.");
    }
    setSaving(false);
  };

  const handleUpdate = async (id) => {
    setSaving(true);
    setPanelError("");
    try {
      await api.put(`/staff/members/${id}`, {
        name: editForm.name?.trim() || undefined,
        email: editForm.email !== undefined ? (editForm.email.trim() || null) : undefined,
        phone: editForm.phone !== undefined ? (editForm.phone.trim() || null) : undefined,
        role: editForm.role || undefined,
        contract_type: editForm.contract_type || undefined,
        base_rate: editForm.base_rate !== undefined ? parseFloat(editForm.base_rate) : undefined,
      });
      setEditingId(null);
      setEditForm({});
      onRefresh();
    } catch (err) {
      setPanelError(err.response?.data?.detail || "Failed to update staff member.");
    }
    setSaving(false);
  };

  const handleDeactivate = async (id) => {
    if (!window.confirm("Deactivate this staff member? They won't appear in future schedules.")) return;
    setPanelError("");
    try {
      await api.delete(`/staff/members/${id}`);
      onRefresh();
    } catch (err) {
      setPanelError(err.response?.data?.detail || "Failed to deactivate staff member.");
    }
  };

  const startEdit = (member) => {
    setEditingId(member.id);
    setEditForm({
      name: member.name,
      email: member.email || "",
      phone: member.phone || "",
      role: member.role,
      contract_type: member.contract_type,
      base_rate: member.base_rate || "",
    });
  };

  const getRateCard = (member) => {
    const base = member.base_rate || 0;
    return {
      base,
      evening: Math.round(base * 1.25),
      weekend: Math.round(base * 1.45),
      holiday: Math.round(base * 2),
    };
  };

  return (
    <div className="px-5 pb-5 space-y-4 border-t border-gray-100 dark:border-gray-700">
      {/* Add form */}
      <div className="pt-4">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Add New Staff Member</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          <input
            type="text"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          />
          <input
            type="email"
            placeholder="Email (optional)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          />
          <input
            type="tel"
            placeholder="Phone (optional)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <select
            value={contractType}
            onChange={(e) => setContractType(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          >
            {CONTRACT_TYPES.map((ct) => (
              <option key={ct.value} value={ct.value}>{ct.label}</option>
            ))}
          </select>
          <input
            type="number"
            placeholder={`Base rate (${currency}/hr)`}
            value={baseRate}
            onChange={(e) => setBaseRate(e.target.value)}
            min="0"
            step="0.5"
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          />
          <button
            onClick={handleAdd}
            disabled={saving || !name.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition disabled:opacity-50"
          >
            {saving ? "Adding..." : "Add"}
          </button>
        </div>
      </div>

      {panelError && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-2.5 text-red-700 dark:text-red-300 text-xs">
          {panelError}
        </div>
      )}

      {/* Staff list */}
      {staff.length === 0 ? (
        <p className="text-gray-400 dark:text-gray-500 text-sm text-center py-4">
          No staff members yet. Add your first team member above.
        </p>
      ) : (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Current Staff</h3>
          <div className="divide-y divide-gray-100 dark:divide-gray-700 border border-gray-100 dark:border-gray-700 rounded-xl overflow-hidden">
            {staff.map((member) => {
              const isEditing = editingId === member.id;
              const cat = ROLE_CATEGORY[member.role] || "floor";
              const colors = ROLE_COLORS[cat];
              const rates = getRateCard(member);
              const isInactive = member.is_active === false;

              return (
                <div
                  key={member.id}
                  className={`px-4 py-3 bg-white dark:bg-gray-800 ${isInactive ? "opacity-50" : ""}`}
                >
                  {isEditing ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                        <input
                          type="text"
                          value={editForm.name || ""}
                          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                          className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
                          placeholder="Name"
                        />
                        <input
                          type="email"
                          value={editForm.email || ""}
                          onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                          className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
                          placeholder="Email (optional)"
                        />
                        <input
                          type="tel"
                          value={editForm.phone || ""}
                          onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                          className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
                          placeholder="Phone (optional)"
                        />
                        <select
                          value={editForm.role || ""}
                          onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                          className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                        <select
                          value={editForm.contract_type || ""}
                          onChange={(e) => setEditForm({ ...editForm, contract_type: e.target.value })}
                          className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
                        >
                          {CONTRACT_TYPES.map((ct) => (
                            <option key={ct.value} value={ct.value}>{ct.label}</option>
                          ))}
                        </select>
                        <input
                          type="number"
                          value={editForm.base_rate}
                          onChange={(e) => setEditForm({ ...editForm, base_rate: e.target.value })}
                          placeholder={`Rate (${currency}/hr)`}
                          min="0"
                          step="0.5"
                          className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
                        />
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleUpdate(member.id)}
                          disabled={saving}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-green-600 text-white hover:bg-green-700 transition disabled:opacity-50"
                        >
                          {saving ? "Saving..." : "Save"}
                        </button>
                        <button
                          onClick={() => { setEditingId(null); setEditForm({}); }}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`px-2 py-0.5 rounded-md text-xs font-medium ${colors.bg} ${colors.text}`}>
                          {member.role}
                        </div>
                        <span className="text-sm font-medium text-gray-900 dark:text-white">
                          {member.name}
                        </span>
                        {member.email && (
                          <span className="text-xs text-green-500 dark:text-green-400" title={member.email}>
                            @
                          </span>
                        )}
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          {CONTRACT_TYPES.find((c) => c.value === member.contract_type)?.label || member.contract_type}
                        </span>
                        {isInactive && (
                          <span className="text-xs text-red-500 font-medium">Inactive</span>
                        )}
                      </div>
                      <div className="flex items-center gap-4">
                        {/* Rate card */}
                        <div className="hidden sm:flex items-center gap-3 text-xs text-gray-400 dark:text-gray-500">
                          <span title="Base rate">Base: {rates.base}{currency}/hr</span>
                          <span title="Evening rate (x1.25)">Eve: {rates.evening}</span>
                          <span title="Weekend rate (x1.45)">Wknd: {rates.weekend}</span>
                          <span title="Holiday rate (x2)">Hol: {rates.holiday}</span>
                        </div>
                        {!isInactive && (
                          <div className="flex gap-1">
                            <button
                              onClick={() => generateLink(member)}
                              title="Share portal link"
                              className="px-2 py-1 rounded text-xs text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 transition"
                            >
                              🔗 Share
                            </button>
                            <button
                              onClick={() => startEdit(member)}
                              className="px-2 py-1 rounded text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleDeactivate(member.id)}
                              className="px-2 py-1 rounded text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition"
                            >
                              Deactivate
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* WhatsApp Setup Guide */}
      <details className="group">
        <summary className="flex items-center justify-between cursor-pointer py-3 px-4 bg-green-50 dark:bg-green-900/10 rounded-xl border border-green-200 dark:border-green-800/30 text-sm font-medium text-green-800 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/20 transition">
          <span>📱 WhatsApp Notifications — Quick Setup</span>
          <svg className="w-4 h-4 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
        </summary>
        <div className="mt-3 p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 space-y-5 text-sm text-gray-600 dark:text-gray-400">

          {/* How it works */}
          <div className="p-3 bg-green-50 dark:bg-green-900/10 rounded-lg border border-green-100 dark:border-green-800/20">
            <p className="text-gray-800 dark:text-gray-200 font-medium text-xs uppercase tracking-wide mb-1">How it works</p>
            <p>When you publish or change a schedule, staff with a phone number get a WhatsApp message like:</p>
            <div className="mt-2 p-3 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 font-mono text-xs leading-relaxed">
              <p className="text-green-600 dark:text-green-400">BonBox - Schedule Update</p>
              <p className="mt-1">Hi Jonas! Your shifts changed:</p>
              <p className="mt-1">Mon 14 Apr: 10:00 - 18:00</p>
              <p>Wed 16 Apr: start moved to 15:00</p>
              <p>Fri 18 Apr: shift removed</p>
            </div>
          </div>

          {/* 3 simple steps */}
          <div className="space-y-4">
            <p className="text-gray-800 dark:text-gray-200 font-semibold">3 steps to set it up:</p>

            {/* Step 1 */}
            <div className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-green-500 text-white flex items-center justify-center text-xs font-bold">1</span>
              <div className="flex-1">
                <p className="font-medium text-gray-800 dark:text-gray-200">Sign up at twilio.com <span className="text-xs font-normal text-gray-500">(free, 2 min)</span></p>
                <div className="mt-2 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg text-xs space-y-1">
                  <p>Go to <span className="text-green-600 dark:text-green-400 font-medium">twilio.com/try-twilio</span></p>
                  <p>Enter your email and create a password</p>
                  <p>Verify your phone number — done!</p>
                </div>
              </div>
            </div>

            {/* Step 2 */}
            <div className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-green-500 text-white flex items-center justify-center text-xs font-bold">2</span>
              <div className="flex-1">
                <p className="font-medium text-gray-800 dark:text-gray-200">Turn on WhatsApp <span className="text-xs font-normal text-gray-500">(1 min)</span></p>
                <div className="mt-2 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg text-xs space-y-2">
                  <p>In Twilio, click <span className="font-medium text-gray-800 dark:text-gray-200">Messaging</span> in the left menu</p>
                  <p>Click <span className="font-medium text-gray-800 dark:text-gray-200">Try it out</span> &rarr; <span className="font-medium text-gray-800 dark:text-gray-200">Send a WhatsApp message</span></p>
                  <p>You'll see a sandbox number like <span className="font-mono text-green-600 dark:text-green-400">+1 415 523 8886</span></p>
                  <p>And a join code like <span className="font-mono text-green-600 dark:text-green-400">join bright-owl</span></p>
                  <div className="mt-2 p-2 bg-green-50 dark:bg-green-900/20 rounded border border-green-200 dark:border-green-800/30">
                    <p className="text-green-700 dark:text-green-400">Copy these 3 things from your Twilio dashboard:</p>
                    <div className="mt-1 font-mono space-y-0.5 text-gray-700 dark:text-gray-300">
                      <p>Account SID: <span className="text-green-600 dark:text-green-400">AC1234...abcd</span></p>
                      <p>Auth Token: <span className="text-green-600 dark:text-green-400">ef5678...wxyz</span></p>
                      <p>WhatsApp #: <span className="text-green-600 dark:text-green-400">+14155238886</span></p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Step 3 */}
            <div className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-green-500 text-white flex items-center justify-center text-xs font-bold">3</span>
              <div className="flex-1">
                <p className="font-medium text-gray-800 dark:text-gray-200">Paste them in Render <span className="text-xs font-normal text-gray-500">(1 min)</span></p>
                <div className="mt-2 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg text-xs space-y-2">
                  <p>Go to your BonBox backend on <span className="font-medium text-gray-800 dark:text-gray-200">render.com</span></p>
                  <p>Click <span className="font-medium text-gray-800 dark:text-gray-200">Environment</span> in the sidebar</p>
                  <p>Add these 3 values:</p>
                  <div className="mt-1 font-mono bg-white dark:bg-gray-950 p-2 rounded border border-gray-200 dark:border-gray-700 space-y-0.5 text-gray-700 dark:text-gray-300">
                    <p>TWILIO_ACCOUNT_SID = <span className="text-green-600 dark:text-green-400">paste yours</span></p>
                    <p>TWILIO_AUTH_TOKEN = <span className="text-green-600 dark:text-green-400">paste yours</span></p>
                    <p>TWILIO_WHATSAPP_NUMBER = <span className="text-green-600 dark:text-green-400">+14155238886</span></p>
                  </div>
                  <p>Click <span className="font-medium text-gray-800 dark:text-gray-200">Save Changes</span> — Render restarts automatically</p>
                </div>
              </div>
            </div>
          </div>

          {/* Staff side */}
          <div className="p-3 bg-blue-50 dark:bg-blue-900/10 rounded-lg border border-blue-100 dark:border-blue-800/20">
            <p className="text-gray-800 dark:text-gray-200 font-medium text-xs uppercase tracking-wide mb-2">What your staff does</p>
            <div className="text-xs space-y-2">
              <p><span className="font-medium text-gray-800 dark:text-gray-200">You:</span> Add their phone number here (e.g. <span className="font-mono text-blue-600 dark:text-blue-400">+4512345678</span>) using the edit button above</p>
              <p><span className="font-medium text-gray-800 dark:text-gray-200">Staff:</span> Opens WhatsApp, sends <span className="font-mono bg-white dark:bg-gray-900 px-1.5 py-0.5 rounded text-green-600 dark:text-green-400">join bright-owl</span> to <span className="font-mono">+1 415 523 8886</span></p>
              <p><span className="font-medium text-gray-800 dark:text-gray-200">Done!</span> They'll now get WhatsApp messages when shifts change</p>
            </div>
          </div>

          <div className="p-3 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30 rounded-lg text-xs text-amber-700 dark:text-amber-400">
            <strong>Tip:</strong> This uses Twilio's free sandbox (great for testing). When you're ready for production, upgrade to a Twilio WhatsApp Business number — staff won't need to send the join message anymore.
          </div>
        </div>
      </details>

      {/* Portal Link Modal */}
      {linkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setLinkModal(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-sm w-full p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-center">
              <div className="text-3xl mb-2">🔗</div>
              <h3 className="text-base font-bold text-gray-900 dark:text-white">Share Portal Link</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Send this to <strong>{linkModal.staffName}</strong> — they can see their schedule, hours, and tips.
              </p>
            </div>

            {linkModal.loading ? (
              <div className="flex justify-center py-4">
                <div className="animate-spin w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full" />
              </div>
            ) : (
              <>
                <div className="bg-gray-50 dark:bg-gray-900 rounded-xl p-3 text-xs font-mono text-gray-600 dark:text-gray-400 break-all select-all">
                  {linkModal.portalUrl}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={copyLink}
                    className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition ${
                      linkCopied
                        ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                        : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                    }`}
                  >
                    {linkCopied ? "✓ Copied!" : "📋 Copy"}
                  </button>
                  <button
                    onClick={shareLink}
                    className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition"
                  >
                    📱 Share
                  </button>
                </div>
                <p className="text-[11px] text-gray-400 dark:text-gray-600 text-center">
                  No account needed. Staff just opens the link. You can deactivate it anytime.
                </p>
              </>
            )}

            <button
              onClick={() => setLinkModal(null)}
              className="w-full py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   SCHEDULE GRID
   ═══════════════════════════════════════════════════════════ */
function ScheduleGrid({ staff, weekDates, shifts, getShiftForCell, onCellClick }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-700">
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-40">
                Staff
              </th>
              {weekDates.map((date, i) => {
                const isToday = toISO(date) === toISO(new Date());
                return (
                  <th
                    key={i}
                    className={`px-2 py-3 text-center text-xs font-semibold uppercase tracking-wider w-[calc((100%-10rem)/7)] ${
                      isToday
                        ? "text-green-600 dark:text-green-400 bg-green-50/50 dark:bg-green-900/10"
                        : "text-gray-500 dark:text-gray-400"
                    }`}
                  >
                    <div>{DAY_LABELS[i]}</div>
                    <div className="font-normal text-[10px] mt-0.5 opacity-70">
                      {date.getDate()}/{date.getMonth() + 1}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
            {staff.map((member) => {
              const cat = ROLE_CATEGORY[member.role] || "floor";
              const colors = ROLE_COLORS[cat];

              return (
                <tr key={member.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-750/50">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${colors.dot} flex-shrink-0`} />
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-white truncate max-w-[120px]">
                          {member.name}
                        </div>
                        <div className="text-[10px] text-gray-400 dark:text-gray-500">{member.role}</div>
                      </div>
                    </div>
                  </td>
                  {weekDates.map((date, dayIdx) => {
                    const shift = getShiftForCell(member.id, date);
                    const isToday = toISO(date) === toISO(new Date());

                    if (!shift) {
                      return (
                        <td
                          key={dayIdx}
                          className={`px-1 py-2 text-center cursor-pointer transition-colors ${
                            isToday ? "bg-green-50/30 dark:bg-green-900/5" : ""
                          } hover:bg-gray-100 dark:hover:bg-gray-700/50`}
                          onClick={() => onCellClick(member.id, date, null)}
                        >
                          <div className="h-10 flex items-center justify-center">
                            <span className="text-gray-300 dark:text-gray-600 text-xs">OFF</span>
                          </div>
                        </td>
                      );
                    }

                    const shiftCat = ROLE_CATEGORY[shift.role_on_shift || member.role] || cat;
                    const shiftColors = ROLE_COLORS[shiftCat];
                    const hrs = calcHours(shift.start_time, shift.end_time, shift.break_minutes || 0);
                    const isDraft = shift.status === "draft";

                    return (
                      <td
                        key={dayIdx}
                        className={`px-1 py-2 text-center cursor-pointer transition-colors ${
                          isToday ? "bg-green-50/30 dark:bg-green-900/5" : ""
                        } hover:bg-gray-100 dark:hover:bg-gray-700/50`}
                        onClick={() => onCellClick(member.id, date, shift)}
                      >
                        <div
                          className={`rounded-lg px-2 py-1.5 border ${shiftColors.bg} ${shiftColors.border} ${
                            isDraft ? "border-dashed" : ""
                          }`}
                        >
                          <div className={`text-xs font-semibold ${shiftColors.text}`}>
                            {formatShiftTime(shift.start_time, shift.end_time)}
                          </div>
                          <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                            {hrs}h
                            {shift.role_on_shift && shift.role_on_shift !== member.role && (
                              <span className="ml-1 opacity-70">({shift.role_on_shift.slice(0, 3)})</span>
                            )}
                          </div>
                          {isDraft && (
                            <div className="text-[9px] text-amber-500 dark:text-amber-400 mt-0.5 font-medium">
                              Draft
                            </div>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   SHIFT MODAL
   ═══════════════════════════════════════════════════════════ */
function ShiftModal({ modal, staff, weekDates, onClose, onSaved, branchId }) {
  const existingShift = modal.shift;
  const isEdit = !!existingShift;

  const [staffId, setStaffId] = useState(modal.staffId || existingShift?.staff_member_id || existingShift?.staff_id || "");
  const [date, setDate] = useState(modal.date || (existingShift?.date) || toISO(weekDates[0]));
  const [startHour, setStartHour] = useState(() => {
    if (existingShift?.start_time) return existingShift.start_time.slice(0, 2);
    return "16";
  });
  const [startMin, setStartMin] = useState(() => {
    if (existingShift?.start_time) return existingShift.start_time.slice(3, 5);
    return "00";
  });
  const [endHour, setEndHour] = useState(() => {
    if (existingShift?.end_time) return existingShift.end_time.slice(0, 2);
    return "23";
  });
  const [endMin, setEndMin] = useState(() => {
    if (existingShift?.end_time) return existingShift.end_time.slice(3, 5);
    return "00";
  });
  const [breakMinutes, setBreakMinutes] = useState(existingShift?.break_minutes || 0);
  const [roleOnShift, setRoleOnShift] = useState(() => {
    if (existingShift?.role_on_shift) return existingShift.role_on_shift;
    const member = staff.find((s) => s.id === (modal.staffId || existingShift?.staff_member_id || existingShift?.staff_id));
    return member?.role || ROLES[0];
  });
  const [notes, setNotes] = useState(existingShift?.notes || "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [modalError, setModalError] = useState("");

  // When staff selection changes, update default role
  useEffect(() => {
    if (!isEdit && staffId) {
      const member = staff.find((s) => s.id === staffId);
      if (member) setRoleOnShift(member.role);
    }
  }, [staffId, staff, isEdit]);

  const startTime = `${startHour}:${startMin}`;
  const endTime = `${endHour}:${endMin}`;
  const previewHours = calcHours(startTime, endTime, breakMinutes);

  const handleSave = async () => {
    if (!staffId) {
      setModalError("Please select a staff member.");
      return;
    }
    if (!date) {
      setModalError("Please select a date.");
      return;
    }

    setSaving(true);
    setModalError("");

    const payload = {
      staff_id: staffId,
      date,
      start_time: startTime,
      end_time: endTime,
      break_minutes: breakMinutes || 0,
      role_on_shift: roleOnShift,
      notes: notes.trim() || undefined,
      branch_id: branchId || undefined,
    };

    try {
      if (isEdit) {
        await api.put(`/staff/schedules/${existingShift.id}`, payload);
      } else {
        await api.post("/staff/schedules", payload);
      }
      onSaved();
    } catch (err) {
      const d = err.response?.data?.detail;
      setModalError(typeof d === "string" ? d : Array.isArray(d) ? d.map(e => e.msg || e).join(", ") : `Failed to ${isEdit ? "update" : "create"} shift.`);
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!existingShift?.id) return;
    if (!window.confirm("Delete this shift?")) return;
    setDeleting(true);
    setModalError("");
    try {
      await api.delete(`/staff/schedules/${existingShift.id}`);
      onSaved();
    } catch (err) {
      setModalError(err.response?.data?.detail || "Failed to delete shift.");
    }
    setDeleting(false);
  };

  // Date options for the dropdown: all 7 days of the current week
  const dateOptions = weekDates.map((d) => ({
    value: toISO(d),
    label: `${DAY_LABELS[d.getDay() === 0 ? 6 : d.getDay() - 1]} ${d.getDate()}/${d.getMonth() + 1}`,
  }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-200 dark:border-gray-700 w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {isEdit ? "Edit Shift" : "Add Shift"}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none"
          >
            {"\u00D7"}
          </button>
        </div>

        {modalError && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-2.5 text-red-700 dark:text-red-300 text-xs">
            {modalError}
          </div>
        )}

        {/* Staff member */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Staff Member</label>
          <select
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          >
            <option value="">Select staff...</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.role})
              </option>
            ))}
          </select>
        </div>

        {/* Date */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Date</label>
          <select
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          >
            {dateOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Time selectors */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Start Time</label>
            <div className="flex gap-1">
              <select
                value={startHour}
                onChange={(e) => setStartHour(e.target.value)}
                className="flex-1 px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
              >
                {HOUR_OPTIONS.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
              <span className="text-gray-400 self-center">:</span>
              <select
                value={startMin}
                onChange={(e) => setStartMin(e.target.value)}
                className="flex-1 px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
              >
                {MINUTE_OPTIONS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">End Time</label>
            <div className="flex gap-1">
              <select
                value={endHour}
                onChange={(e) => setEndHour(e.target.value)}
                className="flex-1 px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
              >
                {HOUR_OPTIONS.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
              <span className="text-gray-400 self-center">:</span>
              <select
                value={endMin}
                onChange={(e) => setEndMin(e.target.value)}
                className="flex-1 px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
              >
                {MINUTE_OPTIONS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Break + Role */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Break (minutes)</label>
            <input
              type="number"
              value={breakMinutes}
              onChange={(e) => setBreakMinutes(e.target.value === "" ? "" : Math.max(0, parseInt(e.target.value) || 0))}
              min="0"
              max="120"
              step="5"
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Role on Shift</label>
            <select
              value={roleOnShift}
              onChange={(e) => setRoleOnShift(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Preview */}
        <div className="bg-gray-50 dark:bg-gray-750 rounded-lg px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
          Shift: {startTime} {"\u2013"} {endTime} ({previewHours}h net)
          {breakMinutes > 0 && ` with ${breakMinutes}min break`}
        </div>

        {/* Notes */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Notes (optional)</label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Training, covering for Anna..."
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between pt-2">
          <div>
            {isEdit && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition disabled:opacity-50"
              >
                {deleting ? "Deleting..." : "Delete Shift"}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition disabled:opacity-50"
            >
              {saving ? "Saving..." : isEdit ? "Update Shift" : "Add Shift"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
