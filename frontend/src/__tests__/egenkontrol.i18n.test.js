/**
 * Egenkontrol R1a — i18n (plan "i18n"): every key the egenkontrol screens use,
 * and every value of the static code → key maps in ekLogic.js, exists in BOTH
 * da.js and en.js with real text (no t()||"fallback", no raw key on screen).
 * And none of them says what we must never say: "klar til Fødevarestyrelsen",
 * "Sikker", "Alt er dokumenteret", "Alt er klaret", "100 %".
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.i18n
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";
import * as ek from "../components/egenkontrol/ekLogic";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

const KEYS = [
  "navEgenkontrol", "ekPageTitle", "ekPageSubtitle", "ekTabReadings", "ekTabFolder", "ekTabSetup",
  "ekResponsibility", "ekStartValuesNote", "ekLoadFailed", "ekEmptyTitle", "ekEmptyBody", "ekEmptyMember",
  "ekSetupTitle", "ekSetupFrequencyQ", "ekFreqDaily", "ekFreqWeekly", "ekFreqWeeklyOn", "ekFreqOnEvent",
  "ekFreqOnEventReceiving", "ekFreqOnEventReheating", "ekSetupMissedNote", "ekSetupAdd", "ekAddFridge",
  "ekDueBeforeDayStart", "ekCapReached", "ekTplFridge", "ekTplFridgeName", "ekTplFreezer",
  "ekTplFreezerName", "ekTplHotHolding", "ekTplReheating", "ekTplReceiving", "ekGroupTemperatures",
  "ekGroupReheating", "ekGroupReceiving", "ekLimitMax", "ekLimitMin", "ekSourceLaw", "ekSourceGuide",
  "ekSourceExample", "ekSourceOwner", "ekOwnLimitNote", "ekProductChilled", "ekProductFish",
  "ekProductFrozen", "ekChooseProduct", "ekProductNoteLabel", "ekLabelOk", "ekStatusLater", "ekStatusDue",
  "ekStatusOverdue", "ekStatusDone", "ekStatusDoneLate", "ekStatusDeviationOpen", "ekStatusDeviationClosed",
  "ekStatusOnEvent", "ekStatusMissed", "ekRecheckBy", "ekWeeklyDue", "ekLastReading", "ekClientTimeNote",
  "ekKitchenToday", "ekKitchenProgress", "ekKitchenMissing", "ekKitchenNoChecks", "ekKitchenNoScheduled",
  "ekKitchenMeasurer", "ekKitchenSwitch", "ekKitchenFolder", "ekKitchenUnpair",
  "ekKitchenUnpairConfirmTitle", "ekKitchenUnpairConfirmBody", "ekKitchenRevokedTitle",
  "ekKitchenRevokedTitleNoVenue", "ekKitchenRevokedBody", "ekKitchenUnsent", "ekKitchenPairAgain",
  "ekKitchenPairHint", "ekKitchenOfflineHelp", "ekKitchenWakeLockHint", "ekKitchenLanguage", "ekRecord",
  "ekWhoMeasured", "ekOtherName", "ekOtherNamePlaceholder", "ekNameSavedNote", "ekOnShift", "ekWhatDidYouDo",
  "ekWhatHappenedFood", "ekTooWarm", "ekTooCold", "ekInLimit", "ekOtherActionPlaceholder",
  "ekOtherFatePlaceholder", "ekNoteLabel", "ekCtaEnter", "ekCtaChooseAction", "ekCtaChooseFate",
  "ekCtaChooseName", "ekCtaSave", "ekCtaSaving", "ekPlausibleTitle", "ekPlausibleBody", "ekPlausibleConfirm",
  "ekPlausibleCancel", "ekOutOfRange", "ekSaved", "ekSavedLate", "ekSavedDeviation", "ekNotSavedYet",
  "ekRetry", "ekRetryAll", "ekNeedsAction", "ekUndo", "ekUndone", "ekUndoTooLate", "ekKeyMinus",
  "ekKeyDecimal", "ekKeyBackspace", "ekErrDeviationFields", "ekErrFollowupFate", "ekErrName",
  "ekErrCheckInactive", "ekErrSaveFailed", "ekActThermostatAdjusted", "ekActMovedGoods",
  "ekActSupplierContacted", "ekActHeatIncreased", "ekActReheatedFurther", "ekActOther", "ekFateDiscarded",
  "ekFateMoved", "ekFateAssessedOk", "ekFateReturned", "ekFateReheated75", "ekFateAwaitingRecheck",
  "ekFateOther", "ekFolderEyebrow", "ekFolderSummary", "ekFolderAllClosed", "ekFolderOpenCount",
  "ekFolderNoReadings", "ekFolderOnTime", "ekFolderLate", "ekFolderMissed", "ekFolderUndoneCount",
  "ekFolderDeviations", "ekFolderNoDeviations", "ekFolderLateH", "ekFolderMissedH", "ekFolderUndoneH",
  "ekFolderFollowup", "ekFolderCovers", "ekFolderNamesNote", "ekNamePicked", "ekNamePickedShared",
  "ekNamePickedOwner", "ekNameTyped", "ekDayOk", "ekDayLate", "ekDayMissed", "ekDayDeviation", "ekDayNone",
  "ekDownloadPdf", "ekPdfReady", "ekPdfFailed", "ekEditCheck", "ekAddCheck", "ekFieldName", "ekFieldNote",
  "ekFieldLimit", "ekFieldSchedule", "ekFieldRecheck", "ekSave", "ekSwitchOff", "ekSwitchOn", "ekArchive",
  "ekArchiveConfirmTitle", "ekArchiveConfirmBody", "ekDevicesTitle", "ekDevicesBody", "ekPairIpad",
  "ekPairCode", "ekPairSteps", "ekDeviceLastSeen", "ekDeviceNotPaired", "ekDeviceRevoke",
  "ekDeviceRevokeConfirmTitle", "ekDeviceRevokeConfirmBody", "ekDeviceDefaultLabel", "nyqEkMissingOne",
  "nyqEkMissingMany", "nyqEkDeviationOne", "nyqEkDeviationMany", "nyqEkAction", "ekBadgeMissing",
  "ekDeleteNotice", "ekDeleteDownload", "ekErrStaffGone", "ekErrOpenDeviation", "ekFolderFollowupFate",
  "ekFolderFollowupNote", "ekFirstReadingTomorrow", "ekFirstReadingOn",
];

const MAPS = [
  ek.EK_ACTION_KEYS, ek.EK_FATE_KEYS, ek.EK_STATUS_KEYS, ek.EK_SOURCE_KEYS, ek.EK_PRODUCT_KEYS,
  ek.EK_TEMPLATE_KEYS, ek.EK_GROUP_KEYS, ek.EK_ERROR_KEYS, ek.EK_DAY_KEYS,
];
const NEVER = ["klar til Fødevarestyrelsen", "Sikker", "Alt er dokumenteret", "Alt er klaret", "100 %"];
const NEVER_EN = ["ready for the Danish Food Authority", "All documented", "All done", "100%"];

describe("egenkontrol words — real Danish and English for every key", () => {
  const all = [...new Set([...KEYS, ...MAPS.flatMap((m) => Object.values(m)), ...ek.EK_NAME_NOTE_KEYS])];

  it.each(all)("%s exists in da and en, non-empty, and is not the key itself", (k) => {
    expect(typeof da[k], `da.${k}`).toBe("string");
    expect(typeof en[k], `en.${k}`).toBe("string");
    expect(da[k].trim().length).toBeGreaterThan(0);
    expect(en[k].trim().length).toBeGreaterThan(0);
    expect(da[k]).not.toBe(k);
  });

  it("every static map covers the codes the server sends", () => {
    expect(Object.keys(ek.EK_ACTION_KEYS).sort()).toEqual(
      ["thermostat_adjusted", "moved_goods", "supplier_contacted", "heat_increased", "reheated_further", "other"].sort(),
    );
    expect(Object.keys(ek.EK_FATE_KEYS).sort()).toEqual(
      ["discarded", "moved", "assessed_ok", "returned", "reheated_75", "awaiting_recheck", "other"].sort(),
    );
    expect(Object.keys(ek.EK_SOURCE_KEYS).sort()).toEqual(["fvst_example", "guide", "law", "owner"]);
    expect(Object.keys(ek.EK_PRODUCT_KEYS).sort()).toEqual(["chilled", "fish", "frozen"]);
    expect(Object.keys(ek.EK_STATUS_KEYS)).toEqual(expect.arrayContaining([
      "later", "due", "overdue", "done", "done_late", "deviation_open", "deviation_closed", "on_event",
    ]));
  });

  it("the placeholders match between da and en", () => {
    const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of all) expect(vars(da[k]), k).toEqual(vars(en[k]));
  });

  it("never claims readiness or safety, and never an 'all done' over nothing", () => {
    for (const k of all) {
      for (const bad of NEVER) expect(da[k], `da.${k}`).not.toContain(bad);
      for (const bad of [...NEVER, ...NEVER_EN]) expect(en[k], `en.${k}`).not.toContain(bad);
    }
  });

  it("the egenkontrol code itself never writes those words either, and has no inline fallbacks", () => {
    const files = [
      ...readdirSync(join(SRC, "components", "egenkontrol")).map((f) => join(SRC, "components", "egenkontrol", f)),
      join(SRC, "pages", "KitchenPage.jsx"),
      join(SRC, "pages", "EgenkontrolPage.jsx"),
    ];
    for (const f of files) {
      // Code only: the comments may NAME the banned words to forbid them.
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const bad of ["klar til Fødevarestyrelsen", "Alt er dokumenteret", "Alt er klaret", "100 %"]) {
        expect(src.includes(bad), `${f}: ${bad}`).toBe(false);
      }
      // t("key") || "…" is a raw-key leak waiting to happen (t returns the key).
      expect(/\bt\(\s*["'][^"']+["']\s*\)\s*\|\|/.test(src), f).toBe(false);
    }
  });

  it("locked terms stay: 'BonBox' in English stays 'BonBox' in Danish", () => {
    for (const k of all) if (en[k].includes("BonBox")) expect(da[k], k).toContain("BonBox");
  });
});
