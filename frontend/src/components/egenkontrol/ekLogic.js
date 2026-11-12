/**
 * Egenkontrol — the pure helpers both screens share (the kitchen iPad at
 * /kitchen/<token> and the owner's /egenkontrol). No React, no network, no
 * clock: every function here is a value in, a value out, so the rules that
 * decide what a cook can press are unit-tested on their own.
 *
 * THE SERVER DECIDES. Whether a reading is in limit, late, a deviation or
 * closes one is the server's call (backend services/egenkontrol_rules.py).
 * What lives here is only what the screen needs BEFORE it asks: the keypad,
 * the hint colour while typing, which rows to show and what the one button
 * says. A client value never reaches a row — the server ignores in_limit,
 * late and recorded_at in the body.
 *
 * Codes from the server never reach t() as built strings: they go through
 * the static maps at the bottom (EK_*_KEYS), so every word is a real key in
 * src/i18n/da.js and en.js (egenkontrol.i18n.test.js asserts it).
 */

export const VALUE_MIN_C = -40;
export const VALUE_MAX_C = 120;
export const TYPED_NAME_MAX = 40;
export const CHECK_NAME_MAX = 60;
export const CHECK_NOTE_MAX = 80;
export const OTHER_TEXT_MAX = 80;
export const ACTION_NOTE_MAX = 280;
export const PRODUCT_NOTE_MAX = 80;
export const RECHECK_MIN_RANGE = [5, 240];
export const NAME_ROUND_MS = 120000;
export const PRODUCT_TYPES = ["chilled", "fish", "frozen"];

const MINUS = "−";

// ─── Keypad ──────────────────────────────────────────────────────────────

/**
 * The keypad's next entry. The entry is held canonically as a string with a
 * comma decimal ("-3,5"), whatever the UI language shows on the key.
 *   "-"    toggles a leading minus (every check — freezers read below zero)
 *   ","    adds the decimal once ("" → "0,", "-" → "-0,")
 *   "back" removes the last character; a lone "-" becomes ""
 *   digit  at most 3 integer digits and ONE decimal (a 4-digit cap); a lone
 *          leading 0 is replaced by the next digit ("0" + "5" → "5")
 */
export function nextEntry(entry, key) {
  const e = typeof entry === "string" ? entry : "";
  if (key === "-") return e.startsWith("-") ? e.slice(1) : `-${e}`;
  if (key === ",") {
    if (e.includes(",")) return e;
    if (e === "" || e === "-") return `${e}0,`;
    return `${e},`;
  }
  if (key === "back") {
    const n = e.slice(0, -1);
    return n === "-" ? "" : n;
  }
  if (!/^[0-9]$/.test(String(key))) return e;
  const sign = e.startsWith("-") ? "-" : "";
  const body = sign ? e.slice(1) : e;
  const [int = "", dec] = body.split(",");
  if (dec !== undefined) return dec.length >= 1 ? e : e + key;
  if (int.length >= 3) return e;
  if (int === "0") return `${sign}${key}`;
  return e + key;
}

/** The keypad entry as a Number rounded to 0.1, or null while incomplete. */
export function parseEntry(entry) {
  if (typeof entry !== "string") return null;
  if (entry === "" || entry === "-" || entry === "-0,") return null;
  const v = Number(entry.replace(",", "."));
  if (!Number.isFinite(v)) return null;
  const r = Math.round(v * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

export function inRange(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= VALUE_MIN_C && value <= VALUE_MAX_C;
}

/** How the keypad display shows an entry: real minus, the language's decimal. */
export function displayEntry(entry, lang) {
  if (!entry) return "";
  let s = entry.replace("-", MINUS);
  if (lang !== "da") s = s.replace(",", ".");
  return s;
}

/**
 * Is this value usual for this check? False asks "Er 51,0 °C rigtigt?" once
 * before the save — the "51" typed for "5,1" on a fridge.
 */
export function isPlausible(value, templateKey, productType = null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return true;
  const cold =
    templateKey === "fridge" ||
    (templateKey === "receiving" && (productType === "chilled" || productType === "fish"));
  const frozen = templateKey === "freezer" || (templateKey === "receiving" && productType === "frozen");
  const hot = templateKey === "hot_holding" || templateKey === "reheating";
  if (cold && value > 15) return false;
  if (frozen && value > 0) return false;
  if (hot && value < 20) return false;
  return true;
}

// ─── Formatting ──────────────────────────────────────────────────────────

/** "3,1 °C" (da) / "3.1 °C" (en) with a real minus (U+2212): "−18,0 °C". */
export function formatTemp(value, lang = "da") {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  const abs = Math.abs(n).toFixed(1);
  const num = lang === "da" ? abs.replace(".", ",") : abs;
  return `${n < 0 && Number(abs) !== 0 ? MINUS : ""}${num} °C`;
}

/** A limit field the owner typed ("5", "5,0", "-18.0") → Number, or null. */
export function parseLimitInput(raw) {
  const s = String(raw ?? "").trim().replace(MINUS, "-");
  if (!/^-?\d{1,3}([.,]\d)?$/.test(s)) return null;
  const v = Number(s.replace(",", "."));
  return inRange(v) ? v : null;
}

/** "08:00" style due time, as the server validates it. */
export function isHhmm(s) {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** A due time before the venue's day starts (the 06:00 cutoff) is refused. */
export function dueBeforeDayStart(hhmm, cutoffHour) {
  if (!isHhmm(hhmm)) return false;
  const h = Number(hhmm.slice(0, 2));
  return h < Number(cutoffHour || 0);
}

export function cutoffLabel(cutoffHour) {
  return `${String(Number(cutoffHour) || 0).padStart(2, "0")}:00`;
}

// ─── Limits ──────────────────────────────────────────────────────────────

/** The limit that applies: the check's own, or the product type's (receiving). */
export function limitFor(check, productType = null) {
  if (!check) return null;
  if (check.kind === "receiving" || check.template_key === "receiving") {
    const list = Array.isArray(check.product_limits) ? check.product_limits : [];
    return list.find((p) => p.product_type === productType) || null;
  }
  return check.limit || null;
}

/** Inside the limit (boundaries in). A HINT only — the server decides. */
export function withinLimit(value, limit) {
  if (!limit || typeof value !== "number") return true;
  const lim = Number(limit.limit_c);
  if (!Number.isFinite(lim)) return true;
  return limit.direction === "min" ? value >= lim : value <= lim;
}

// Fates that close a deviation at once (mirrors the server's FATE_CLOSES).
export const FATE_CLOSES = {
  discarded: true,
  moved: true,
  assessed_ok: true,
  returned: true,
  other: true,
  reheated_75: false,
  awaiting_recheck: false,
};

export function closingFates(fates) {
  return (Array.isArray(fates) ? fates : []).filter((f) => FATE_CLOSES[f] === true);
}

/**
 * A follow-up reading on a check with an open deviation whose fate keeps it
 * open (awaiting_recheck, reheated_75 below 75 °C): in limit, it must say
 * what happened to the food — closing fates only. Out of limit it is a new
 * deviation and the normal rows apply.
 */
export function followupNeedsFate(check, value, limit) {
  const od = check?.open_deviation;
  if (!od || typeof value !== "number") return false;
  if (!withinLimit(value, limit)) return false;
  const closesAt =
    od.closes_at_or_above != null ? Number(od.closes_at_or_above) : od.fate_code === "reheated_75" ? 75 : null;
  if (closesAt != null && value >= closesAt) return false;
  if (typeof od.needs_fate === "boolean") return od.needs_fate;
  return FATE_CLOSES[od.fate_code] !== true;
}

// ─── The one button ──────────────────────────────────────────────────────

const filled = (code, other) => !!code && (code !== "other" || String(other || "").trim().length > 0);

/**
 * What the save button says and whether it can be pressed. Returns an i18n
 * key + vars (the caller translates), in this order:
 *   receiving without a type   → "Vælg varetype"
 *   no value / out of range    → "Indtast temperatur"
 *   out of limit, no action    → "Vælg hvad du gjorde"
 *   no fate (or follow-up)     → "Hvad skete der med maden?"
 *   no name                    → "Vælg hvem der målte"
 *   ready                      → "Gem 3,1 °C"
 *   sending                    → "Gemmer…"
 */
export function ctaFor(s) {
  const lang = s?.lang || "da";
  if (s?.saving) return { key: "ekCtaSaving", vars: null, disabled: true, step: "saving" };
  if (s?.kind === "receiving" && !s?.productType) {
    return { key: "ekChooseProduct", vars: null, disabled: true, step: "product" };
  }
  if (typeof s?.value !== "number" || !inRange(s.value)) {
    return { key: "ekCtaEnter", vars: null, disabled: true, step: "value" };
  }
  const out = !withinLimit(s.value, s.limit);
  if (out) {
    if (!filled(s.action, s.actionOther)) return { key: "ekCtaChooseAction", vars: null, disabled: true, step: "action" };
    if (!filled(s.fate, s.fateOther)) return { key: "ekCtaChooseFate", vars: null, disabled: true, step: "fate" };
  } else if (s.followup && !filled(s.fate, s.fateOther)) {
    return { key: "ekCtaChooseFate", vars: null, disabled: true, step: "fate" };
  }
  if (!s.who) return { key: "ekCtaChooseName", vars: null, disabled: true, step: "name" };
  return { key: "ekCtaSave", vars: { value: formatTemp(s.value, lang) }, disabled: false, step: "save" };
}

/**
 * The body for POST …/entries. Only what the person chose: the server sets
 * the time, the limit, in_limit, late, the slot and the deviation state.
 * Typed text goes as typed (the server stores it verbatim and escapes it on
 * print); an empty field is null.
 */
export function buildEntryBody({ clientId, check, value, productType, productNote, labelOk, action, actionOther, fate, fateOther, note, who, out, followup, typedAt }) {
  const receiving = check?.kind === "receiving" || check?.template_key === "receiving";
  const text = (v) => (typeof v === "string" && v.trim() ? v : null);
  const withFate = out || followup;
  const body = {
    client_id: clientId,
    check_id: check?.id,
    value_c: value,
    product_type: receiving ? productType || null : null,
    product_note: receiving ? text(productNote) : null,
    label_ok: receiving ? (typeof labelOk === "boolean" ? labelOk : null) : null,
    action_code: out ? action || null : null,
    action_other: out && action === "other" ? text(actionOther) : null,
    fate_code: withFate ? fate || null : null,
    fate_other: withFate && fate === "other" ? text(fateOther) : null,
    action_note: out ? text(note) : null,
    staff_id: null,
    typed_name: null,
    client_typed_at: typedAt || null,
  };
  if (who?.kind === "staff") body.staff_id = who.id;
  else if (who?.kind === "typed") body.typed_name = String(who.name || "").trim();
  return body;
}

/** A device-made id for one reading (retries resend the same one). */
export function newClientId() {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * How a failed send is kept: "failed" (network, timeout, 5xx, 429 — retry
 * with the same client_id), "needs_action" (the server refused the content:
 * 422 / 409 — reopen the panel), "revoked" (404 on the kitchen device).
 */
export function classifySaveError(err) {
  const status = err?.response?.status;
  if (!err?.response || status >= 500 || status === 429 || err?.code === "ECONNABORTED") {
    return { kind: "failed", code: null, missing: [] };
  }
  const d = err.response.data || {};
  const detail = d.detail && typeof d.detail === "object" ? d.detail : d;
  const code = typeof detail.code === "string" ? detail.code : null;
  const missing = Array.isArray(detail.missing) ? detail.missing : [];
  if (status === 404) return { kind: "revoked", code, missing };
  return { kind: "needs_action", code, missing };
}

/** The server's error code for any failed call, or null. */
export function errorCode(err) {
  const d = err?.response?.data || {};
  const detail = d.detail && typeof d.detail === "object" ? d.detail : d;
  return typeof detail.code === "string" ? detail.code : typeof detail.error === "string" ? detail.error : null;
}

// ─── Status ──────────────────────────────────────────────────────────────

/** Status → colour tone for ui/CheckStatusPill (the pill owns the colours). */
export const STATUS_TONE = {
  done: "ok",
  done_late: "warn",
  due: "warn",
  overdue: "bad",
  deviation_open: "bad",
  deviation_closed: "warn",
  later: "muted",
  on_event: "muted",
  missed: "bad",
};

export const DAY_TONE = { ok: "ok", late: "warn", missed: "bad", deviation: "bad", none: "muted" };

/**
 * The row's status words for a CheckToday: [key, vars] lines (the first is
 * the status, an optional second the re-check time or the last reading).
 */
export function statusLines(check, lang = "da", weekdayName = null) {
  const s = check?.status;
  const slot = check?.slot || null;
  const last = check?.last || null;
  const lines = [];
  switch (s) {
    case "later":
      if (slot?.weekday != null && check?.schedule?.type === "weekly" && weekdayName) {
        lines.push(["ekWeeklyDue", { weekday: weekdayName(slot.weekday), time: slot.due_local }]);
      } else {
        lines.push(["ekStatusLater", { time: slot?.due_local || "" }]);
      }
      break;
    case "due":
      lines.push(["ekStatusDue", { time: slot?.due_local || "" }]);
      break;
    case "overdue":
      lines.push(["ekStatusOverdue", { time: slot?.due_local || "" }]);
      break;
    case "done":
      lines.push(["ekStatusDone", { time: last?.recorded_local || "" }]);
      break;
    case "done_late": {
      // The reading that FILLED the late slot — not a later one the same day.
      const se = check?.slot_entry || last;
      lines.push(["ekStatusDoneLate", { time: se?.recorded_local || "", due: se?.slot_due_local || slot?.due_local || "" }]);
      break;
    }
    case "deviation_open":
      lines.push(["ekStatusDeviationOpen", null]);
      if (check?.open_deviation?.recheck_due_local) {
        lines.push(["ekRecheckBy", { time: check.open_deviation.recheck_due_local }]);
      }
      break;
    case "deviation_closed":
      lines.push(["ekStatusDeviationClosed", null]);
      break;
    default:
      lines.push(["ekStatusOnEvent", null]);
      if (last && last.value_c != null) {
        lines.push(["ekLastReading", { value: formatTemp(last.value_c, lang), time: last.recorded_local || "" }]);
      }
  }
  return lines;
}

/** Groups in the order the list shows them, each with its checks. */
export function groupChecks(checks) {
  const order = ["temperatures", "reheating", "receiving"];
  const by = new Map(order.map((g) => [g, []]));
  for (const c of Array.isArray(checks) ? checks : []) {
    const g = by.has(c.group_key) ? c.group_key : "temperatures";
    by.get(g).push(c);
  }
  return order.map((g) => ({ key: g, checks: by.get(g) })).filter((g) => g.checks.length > 0);
}

/** {from, to} for the last 30 business days ending on `businessDate`. */
export function last30(businessDate) {
  if (typeof businessDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return { from: null, to: null };
  const [y, m, d] = businessDate.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d - 29));
  const iso = (dt) => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  return { from: iso(start), to: businessDate };
}

/** Weekday name for 0 = Monday … 6 = Sunday in the UI language (Intl). */
export function weekdayName(index, lang = "da", style = "long") {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i > 6) return "";
  // 9 Nov 2026 is a Monday; UTC on both sides so no zone can shift the day.
  const d = new Date(Date.UTC(2026, 10, 9 + i));
  try {
    return new Intl.DateTimeFormat(lang === "da" ? "da-DK" : "en-GB", { weekday: style, timeZone: "UTC" }).format(d);
  } catch {
    return "";
  }
}

/** "torsdag 12. november" for a YYYY-MM-DD business date (the venue's day). */
export function longDate(isoDate, lang = "da") {
  if (typeof isoDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return "";
  const [y, m, d] = isoDate.split("-").map(Number);
  try {
    return new Intl.DateTimeFormat(lang === "da" ? "da-DK" : "en-GB", {
      weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
    }).format(new Date(Date.UTC(y, m - 1, d)));
  } catch {
    return isoDate;
  }
}

/** The row's limit words: "5,0 °C eller koldere" / "Kølevare ≤ 5,0 °C · Fisk ≤ 2,0 °C · …". */
export function limitLine(check, t, lang) {
  if (!check) return "";
  if (check.kind === "receiving" || check.template_key === "receiving") {
    return (check.product_limits || [])
      .map((p) => `${t(EK_PRODUCT_KEYS[p.product_type] || "ekProductChilled")} ≤ ${formatTemp(p.limit_c, lang)}`)
      .join(" · ");
  }
  const l = check.limit;
  if (!l) return "";
  return t(l.direction === "min" ? "ekLimitMin" : "ekLimitMax", { value: formatTemp(l.limit_c, lang) });
}

export function sourceLine(limit, t) {
  if (!limit?.source || !EK_SOURCE_KEYS[limit.source]) return "";
  return t(EK_SOURCE_KEYS[limit.source]);
}

/**
 * Receiving: where each product type's limit comes from, grouped by source —
 * "Kølevare: Fra loven (BEK nr. 1331/2025) · Fisk, Frost: Startværdi fra
 * Fødevarestyrelsens eksempel". Every limit shows its source.
 */
export function receivingSourceLine(check, t) {
  const list = Array.isArray(check?.product_limits) ? check.product_limits : [];
  const groups = new Map();
  for (const p of list) {
    const key = EK_SOURCE_KEYS[p?.source];
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t(EK_PRODUCT_KEYS[p.product_type] || "ekProductChilled"));
  }
  return [...groups.entries()].map(([k, names]) => `${names.join(", ")}: ${t(k)}`).join(" · ");
}

/** A start-list item's name in the UI language ("Køl 2", "Varmholdelse"); stored verbatim as sent. */
export function startItemName(item, t) {
  switch (item.template_key) {
    case "fridge":
      return t("ekTplFridgeName", { n: item.n });
    case "freezer":
      return t("ekTplFreezerName", { n: item.n });
    case "hot_holding":
      return t("ekTplHotHolding");
    case "reheating":
      return t("ekTplReheating");
    default:
      return t("ekTplReceiving");
  }
}

// ─── Static code → i18n key maps (the only way a code reaches t()) ───────

export const EK_ACTION_KEYS = {
  thermostat_adjusted: "ekActThermostatAdjusted",
  moved_goods: "ekActMovedGoods",
  supplier_contacted: "ekActSupplierContacted",
  heat_increased: "ekActHeatIncreased",
  reheated_further: "ekActReheatedFurther",
  other: "ekActOther",
};

export const EK_FATE_KEYS = {
  discarded: "ekFateDiscarded",
  moved: "ekFateMoved",
  assessed_ok: "ekFateAssessedOk",
  returned: "ekFateReturned",
  reheated_75: "ekFateReheated75",
  awaiting_recheck: "ekFateAwaitingRecheck",
  other: "ekFateOther",
};

export const EK_STATUS_KEYS = {
  later: "ekStatusLater",
  due: "ekStatusDue",
  overdue: "ekStatusOverdue",
  done: "ekStatusDone",
  done_late: "ekStatusDoneLate",
  deviation_open: "ekStatusDeviationOpen",
  deviation_closed: "ekStatusDeviationClosed",
  on_event: "ekStatusOnEvent",
  missed: "ekStatusMissed",
};

export const EK_SOURCE_KEYS = {
  law: "ekSourceLaw",
  guide: "ekSourceGuide",
  fvst_example: "ekSourceExample",
  owner: "ekSourceOwner",
};

export const EK_PRODUCT_KEYS = {
  chilled: "ekProductChilled",
  fish: "ekProductFish",
  frozen: "ekProductFrozen",
};

export const EK_TEMPLATE_KEYS = {
  fridge: "ekTplFridge",
  freezer: "ekTplFreezer",
  hot_holding: "ekTplHotHolding",
  reheating: "ekTplReheating",
  receiving: "ekTplReceiving",
};

export const EK_GROUP_KEYS = {
  temperatures: "ekGroupTemperatures",
  reheating: "ekGroupReheating",
  receiving: "ekGroupReceiving",
};

export const EK_ERROR_KEYS = {
  deviation_fields_required: "ekErrDeviationFields",
  followup_fate_required: "ekErrFollowupFate",
  name_required: "ekErrName",
  name_invalid: "ekErrName",
  check_inactive: "ekErrCheckInactive",
  staff_gone: "ekErrStaffGone",
  open_deviation: "ekErrOpenDeviation",
  value_out_of_range: "ekOutOfRange",
  too_many_decimals: "ekOutOfRange",
  due_before_day_start: "ekDueBeforeDayStart",
};

export const EK_DAY_KEYS = {
  ok: "ekDayOk",
  late: "ekDayLate",
  missed: "ekDayMissed",
  deviation: "ekDayDeviation",
  none: "ekDayNone",
};

/** How a name was given: (valgt på køkken-iPad) / (valgt på delt enhed) / … */
export function nameNoteKey(nameSource, via) {
  if (nameSource === "typed") return "ekNameTyped";
  if (via === "shared") return "ekNamePickedShared";
  if (via === "owner_app") return "ekNamePickedOwner";
  return "ekNamePicked";
}

export const EK_NAME_NOTE_KEYS = ["ekNamePicked", "ekNamePickedShared", "ekNamePickedOwner", "ekNameTyped"];
