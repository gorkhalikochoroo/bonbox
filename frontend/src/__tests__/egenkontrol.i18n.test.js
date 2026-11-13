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

// R1b — every key the new screens use (contract §12 + the ones the screens needed).
const KEYS_R1B = [
  "ekPhotoOptional", "ekPhotoTake", "ekPhotoRetake", "ekPhotoRemoveLocal", "ekPhotoHint", "ekPhotoAttached",
  "ekPhotoSending", "ekPhotoNotSent", "ekPhotoSaved", "ekPhotoLost", "ekPhotoRemoved", "ekPhotoRemovedShort", "ekPhotoRemove",
  "ekPhotoRemoveConfirmTitle", "ekPhotoRemoveConfirmBody", "ekPhotoWindowPassed", "ekPhotoTooLarge", "ekPhotoUnreadable",
  "ekPaperTitle", "ekPaperIntro", "ekPaperCheck", "ekPaperWhenLegend", "ekPaperMeasuredDate", "ekPaperMeasuredTime", "ekPaperReason",
  "ekPaperReasonPlaceholder", "ekPaperShown", "ekPaperSaved", "ekCtaPaperWhen", "ekCtaPaperReason", "ekErrPaperTooOld",
  "ekErrPaperFuture", "ekErrPaperFateMustClose", "ekErrPaperReason", "ekErrPaperWhen", "ekErrPaperCheckNotYet", "ekNamePaper",
  "ekCorrectTitle", "ekCorrectIntro", "ekCorrectReasonQ", "ekCorrectReasonTypo", "ekCorrectReasonWrongCheck", "ekCorrectReasonOther",
  "ekCorrectReasonPlaceholder", "ekCorrectCheck", "ekCorrectSave", "ekCorrectSaved", "ekCorrectedLine", "ekCorrectedNotDeviation",
  "ekCorrectedShort", "ekCorrectedAt", "ekErrCorrectionTooOld", "ekErrCorrectionNoChange", "ekErrCorrectionReason",
  "ekErrCorrectionCheck", "ekErrAlreadyCorrected", "ekRet",
  "ekWeekTitle", "ekWeekCountReadings", "ekWeekCountLate", "ekWeekCountMissed", "ekWeekCountDeviations", "ekWeekCountOpen",
  "ekWeekCountPaper", "ekWeekCountCorrections", "ekWeekOpenNow", "ekRepeatHint", "ekWeekDocsDue", "ekDocReviewBy", "ekWeekScope",
  "ekWeekName", "ekWeekNote", "ekWeekMarkReviewed", "ekWeekReviewedLine", "ekErrWeekNotOver", "ekReviewRow", "ekReviewsNone",
  "ekSectionReviews",
  "ekDocsTitle", "ekDocsHonest", "ekDocsEmpty", "ekDocAdd", "ekDocUploadedReview", "ekDocReviewAgain", "ekDocMarkReviewed",
  "ekDocDelete", "ekDocDeleteConfirmTitle", "ekDocDeleteConfirmBody", "ekDocTypeProgramme", "ekDocTypeRisk", "ekDocTypeCleaning",
  "ekDocTypeHygiene", "ekDocTypeOther", "ekDocTypeLabel", "ekDocTitleLabel", "ekDocFileLabel", "ekDocFileHelp", "ekDocSave",
  "ekDocSavedToast", "ekDocReviewedToast", "ekDocDeletedToast", "ekDocDownloaded", "ekDocShared", "ekDocOpenFailed",
  "ekErrDocTooLarge", "ekErrDocType", "ekErrDocTitle", "ekErrDocsFull", "ekErrStorage",
  "ekSmileyLabel", "ekSmileyHelp", "ekSmileyLink", "ekSmileySaved", "ekErrSmileyUrl",
  "ekOptInTitle", "ekOptInBody", "ekOptInButton", "ekOptInDone", "ekErrOptOutHasChecks",
  "ekCapLine", "ekCapOver", "ekCapSetupOver",
  "ekTemplateCleaning", "ekTemplateThermometer", "ekGroupCleaning", "ekGroupOther", "ekTickDone", "ekTickNoteLabel",
  "ekCtaSaveDone", "ekTickLast", "ekTickNotToday", "ekTickEditorNote",
  "ekQueueStaleKitchen", "ekQueueStaleOwner", "ekQueueDiscard", "ekQueueDiscardConfirmTitle", "ekQueueDiscardConfirmBody",
  "ekKitchenUnsentList", "ekErrBusinessDayChanged",
  "ekRangeLabel", "ekRangeLast30", "ekRangeThisMonth", "ekRangeLastMonth", "ekRangeLast92", "ekRangeCustom", "ekRangeFrom",
  "ekRangeTo", "ekRangeMax", "ekErrRangeTooLong", "ekErrRangeBad",
  "ekAllReadings", "ekSectionCorrections", "ekSectionPaper", "ekFolderPaperCount", "ekFolderCorrectionsCount", "ekDateAtTime",
  "ekQueueWaitingOffline", "ekQueueWaitingList", "ekKitchenPairAgainConfirmTitle", "ekKitchenPairAgainConfirmBody",
  "ekPhotoAttachedLater",
  // 13 Nov 2026 founder answers: a hygiejnebevis row without a review date;
  // the tick ceiling (409 too_many_ticks, never a 402).
  "ekDocUploaded", "ekErrTooManyTicks",
];
KEYS.push(...KEYS_R1B);

const MAPS = [
  ek.EK_ACTION_KEYS, ek.EK_FATE_KEYS, ek.EK_STATUS_KEYS, ek.EK_SOURCE_KEYS, ek.EK_PRODUCT_KEYS,
  ek.EK_TEMPLATE_KEYS, ek.EK_GROUP_KEYS, ek.EK_ERROR_KEYS, ek.EK_DAY_KEYS,
  ek.EK_DOC_TYPE_KEYS, ek.EK_CORRECTION_REASON_KEYS,
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

  it("R1b: every server code the new routes send has words (no raw code on screen)", () => {
    const codes = [
      "business_day_changed", "done_required", "value_not_allowed", "limit_not_allowed", "paper_too_old", "paper_in_future",
      "paper_fate_must_close", "paper_reason_required", "paper_reason_too_long", "correction_too_old", "correction_no_change",
      "reason_unknown", "other_text_required", "reason_too_long", "check_change_needs_reason", "kind_mismatch",
      "photo_not_allowed", "photo_window_passed", "photo_exists", "photo_too_large", "photo_unreadable", "findsmiley_invalid",
      "opt_in_not_offered", "has_checks", "title_required", "title_too_long", "doc_type_unknown", "too_many_documents",
      "unsupported_type", "too_large", "storage_unavailable", "week_not_over", "bad_week", "range_too_long",
      "too_many_ticks",
    ];
    for (const c of codes) expect(ek.EK_ERROR_KEYS[c], c).toBeTruthy();
    expect(Object.keys(ek.EK_DOC_TYPE_KEYS).sort()).toEqual(["cleaning_plan", "hygiene_cert", "other", "programme", "risk_analysis"]);
    expect(Object.keys(ek.EK_CORRECTION_REASON_KEYS).sort()).toEqual(["other", "typo", "wrong_check"]);
  });

  it("R1b: the exact words the spec fixes", () => {
    expect(da.ekPhotoHint).toBe("Fotografér termometeret eller maden — ikke personer.");
    expect(en.ekPhotoHint).toBe("Photograph the thermometer or the food — not people.");
    expect(da.ekSmileyHelp).toBe("Fødevarestyrelsen beder virksomheder linke til findsmiley.dk, når de markedsfører sig online.");
    // 13 Nov 2026: with or without www (stored in the www form).
    expect(da.ekErrSmileyUrl).toBe("Linket skal begynde med https://www.findsmiley.dk/ eller https://findsmiley.dk/");
    expect(en.ekErrSmileyUrl).toBe("The link must start with https://www.findsmiley.dk/ or https://findsmiley.dk/");
    // 13 Nov 2026: the plan's limit counts temperature checks; ticks never.
    for (const k of ["ekCapLine", "ekCapOver", "ekCapSetupOver"]) {
      expect(da[k], k).toContain("temperaturkontroller");
      expect(da[k], k).toContain("Rengøring og termometertjek tæller ikke med.");
      expect(en[k], k).toContain("temperature checks");
      expect(en[k], k).toContain("Cleaning and thermometer checks don't count.");
    }
    expect(da.ekDocsHonest).toBe("BonBox gemmer jeres dokumenter. Vi læser dem ikke og godkender dem ikke.");
    expect(da.ekCorrectIntro).toBe("Rettelsen gemmes ved siden af den oprindelige måling. Tidspunktet ændres ikke, og en afvigelse forsvinder ikke.");
    expect(da.ekPhotoAttached).toBe("Foto vedlagt");
    expect(da.ekErrRangeTooLong).toBe("Højst 92 dage ad gangen.");
    // A document is never called current or valid.
    for (const k of KEYS_R1B) {
      expect(da[k], k).not.toMatch(/\bAktuel/);
      expect(en[k], k).not.toMatch(/\bCurrent\b/);
    }
  });

  it("locked terms stay: 'BonBox' in English stays 'BonBox' in Danish", () => {
    for (const k of all) if (en[k].includes("BonBox")) expect(da[k], k).toContain("BonBox");
  });
});
