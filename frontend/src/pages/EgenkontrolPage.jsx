/**
 * Egenkontrol — the owner's page (/egenkontrol, lazyRetry, inside Layout).
 *
 * Tabs (?tab= deep link):
 *   Målinger      — every seat reads today; only the OWNER records (the
 *                   server refuses member writes). Same rows and status words
 *                   as the kitchen iPad, same "Registrér" panel.
 *   Kontrolmappe  — owner + manager: the last 30 days, and the PDF.
 *   Opsætning     — owner: the checks and their limits, and the kitchen iPad.
 * On a curtained shared device ("Delt enhed") Kontrolmappe and Opsætning show
 * the existing PIN pad instead of calling the API (the server 403s them
 * anyway); Målinger keeps working there — readings are marked "delt enhed".
 *
 * Honest words only: BonBox stores the readings; the risk analysis and the
 * programme are the venue's. Never "klar til Fødevarestyrelsen", never
 * "Alt er klaret", never "100 %" — a venue with no checks gets the start list.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, Pencil, Plus } from "lucide-react";

import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { useDeviceShare } from "../hooks/useDeviceShare";
import { useMediaQuery } from "../hooks/useMediaQuery";
import usePageTitle from "../hooks/usePageTitle";
import { useBranch } from "../components/BranchSelector";
import DevicePinLockScreen from "../components/DevicePinLockScreen";
import PageHeader from "../components/ui/PageHeader";
import TabPills from "../components/ui/TabPills";
import LoadFailed from "../components/ui/LoadFailed";
import Button from "../components/ui/Button";
import Chip from "../components/ui/Chip";
import Sheet from "../components/ui/Sheet";
import CheckStatusPill from "../components/ui/CheckStatusPill";
import CheckList from "../components/egenkontrol/CheckList";
import RecordPanel from "../components/egenkontrol/RecordPanel";
import FolderView from "../components/egenkontrol/FolderView";
import SetupFromStartList from "../components/egenkontrol/SetupFromStartList";
import CheckEditorSheet from "../components/egenkontrol/CheckEditorSheet";
import KitchenDevicesCard from "../components/egenkontrol/KitchenDevicesCard";
import downloadFolderPdf from "../components/egenkontrol/downloadFolderPdf";
import { MeasurerBar } from "../components/egenkontrol/NamePicker";
import useNameRound from "../components/egenkontrol/useNameRound";
import usePendingEntries, { useRecentSaves } from "../components/egenkontrol/usePendingEntries";
import {
  EK_TEMPLATE_KEYS,
  errorCode,
  firstReadingLine,
  formatTemp,
  limitLine,
  receivingSourceLine,
  sourceLine,
  startItemName,
  weekdayName,
} from "../components/egenkontrol/ekLogic";

const freshness = () => {
  try {
    window.dispatchEvent(new Event("bonbox-data-changed"));
  } catch {
    /* never fails a save */
  }
};

function scheduleText(c, t, lang) {
  const s = c?.schedule || {};
  if (s.type === "weekly") return t("ekFreqWeeklyOn", { weekday: weekdayName(s.weekday ?? 0, lang), time: s.due || "" });
  if (s.type === "daily") return t("ekFreqDaily", { time: s.due || "" });
  if (c?.template_key === "receiving") return t("ekFreqOnEventReceiving");
  if (c?.template_key === "reheating") return t("ekFreqOnEventReheating");
  return t("ekFreqOnEvent");
}

export default function EgenkontrolPage() {
  const { t, lang } = useLanguage();
  usePageTitle("ekPageTitle");
  const { user } = useAuth();
  const toast = useToast();
  const share = useDeviceShare();
  const branchCtx = useBranch() || {};
  const wide = useMediaQuery("(min-width: 1024px)");
  const [params, setParams] = useSearchParams();

  const role = String(user?.role || "owner").toLowerCase();
  const isOwner = role === "owner";
  const canFolder = isOwner || role === "manager";
  const curtained = !!(share?.enabled && share?.locked);
  const branchId = branchCtx.hasBranches && branchCtx.branchId ? branchCtx.branchId : null;

  const tabs = [
    { id: "readings", label: t("ekTabReadings") },
    canFolder ? { id: "folder", label: t("ekTabFolder") } : null,
    isOwner ? { id: "setup", label: t("ekTabSetup") } : null,
  ].filter(Boolean);
  const tab = tabs.find((x) => x.id === params.get("tab"))?.id || "readings";
  const setTab = (id) => {
    const next = new URLSearchParams(params);
    if (id === "readings") next.delete("tab");
    else next.set("tab", id);
    setParams(next, { replace: true });
  };

  // ── Today ─────────────────────────────────────────────────────────────
  const [today, setToday] = useState(null);
  const [todayFailed, setTodayFailed] = useState(false);
  const [todayKey, setTodayKey] = useState(0);
  useEffect(() => {
    let alive = true;
    api
      .get("/egenkontrol/today", { params: branchId ? { branch_id: branchId } : {} })
      .then((r) => {
        if (!alive) return;
        setToday(r.data || null);
        setTodayFailed(false);
      })
      .catch(() => {
        if (alive) setTodayFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [branchId, todayKey]);
  const reloadToday = useCallback(() => setTodayKey((k) => k + 1), []);

  // ── Owner: the checks (incl. switched off), the start list, staff ────
  const [checksData, setChecksData] = useState(null);
  const [checksKey, setChecksKey] = useState(0);
  const [templates, setTemplates] = useState(null);
  const [staff, setStaff] = useState([]);
  const [staffKey, setStaffKey] = useState(0);
  useEffect(() => {
    if (!isOwner) return undefined;
    let alive = true;
    api
      .get("/egenkontrol/checks")
      .then((r) => alive && setChecksData(r.data || { checks: [], archived: [] }))
      .catch(() => alive && setChecksData({ checks: [], archived: [], failed: true }));
    return () => {
      alive = false;
    };
  }, [isOwner, checksKey]);
  useEffect(() => {
    if (!isOwner) return undefined;
    let alive = true;
    api
      .get("/egenkontrol/templates")
      .then((r) => alive && setTemplates(r.data || null))
      .catch(() => alive && setTemplates({ templates: [], failed: true }));
    return () => {
      alive = false;
    };
  }, [isOwner]);
  useEffect(() => {
    if (!isOwner) return undefined;
    let alive = true;
    api
      .get("/egenkontrol/staff")
      .then((r) => alive && setStaff(Array.isArray(r.data?.staff) ? r.data.staff : []))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isOwner, staffKey]);
  const reloadChecks = useCallback(() => setChecksKey((k) => k + 1), []);

  const cutoffHour = today?.cutoff_hour ?? templates?.cutoff_hour ?? 6;
  const checks = useMemo(() => (Array.isArray(today?.checks) ? today.checks : []), [today]);
  const byId = useMemo(() => Object.fromEntries(checks.map((c) => [c.id, c])), [checks]);
  const ownerHasAnyCheck = (checksData?.checks || []).length > 0;

  // ── Recording (owner) ─────────────────────────────────────────────────
  const nameRound = useNameRound();
  const { recent, now, add: addRecent, drop: dropRecent } = useRecentSaves();
  const pending = usePendingEntries(useCallback((body) => api.post("/egenkontrol/entries", body).then((r) => r.data), []));
  const [panel, setPanel] = useState(null); // { checkId, draft }
  const [panelNonce, setPanelNonce] = useState(0);
  const [undoBusy, setUndoBusy] = useState(null);
  const [live, setLive] = useState("");

  const afterSaved = (entry, check, who) => {
    addRecent(entry);
    if (who) nameRound.hold(who);
    const name = check?.name || "";
    const value = formatTemp(entry?.value_c, lang);
    let msg = t("ekSaved", { check: name, value });
    let severity = "success";
    if (entry?.deviation_state) {
      msg = t("ekSavedDeviation", { check: name, value });
      severity = "notice";
    } else if (entry?.late) {
      msg = t("ekSavedLate", { check: name, value, due: entry.slot_due_local || "" });
      severity = "notice";
    }
    toast({ message: msg, severity });
    setLive(msg);
    freshness();
    reloadToday();
  };

  // A 404 on a save here is a name the server no longer has (a staff member
  // deleted since the list was fetched) — the check itself answers 409. Keep
  // the reading as "Kræver handling", fetch the names again, choose anew.
  const staffGone = (clientId, who) => {
    const missing = ["name"];
    pending.markNeedsAction(clientId, { code: "staff_gone", missing });
    const held = nameRound.held;
    if (who?.kind === "staff" && held?.kind === "staff" && held.id === who.id) nameRound.clear();
    setStaffKey((k) => k + 1);
    setLive(t("ekErrStaffGone"));
    return { ok: false, kind: "needs_action", code: "staff_gone", missing };
  };

  const onSave = async (body, meta) => {
    const check = byId[meta.checkId];
    const res = await pending.submit({ clientId: meta.clientId, checkId: meta.checkId, body, draft: meta.state });
    if (res.ok) {
      afterSaved(res.entry, check, meta.state?.who);
      if (!wide) setPanel(null);
      return res;
    }
    if (res.kind === "revoked") return staffGone(meta.clientId, meta.state?.who);
    if (res.code === "check_inactive") {
      pending.remove(meta.clientId);
      toast({ message: t("ekErrCheckInactive"), severity: "warn" });
      setPanel(null);
      reloadToday();
      return { ok: false, kind: "closed" };
    }
    if (res.kind === "failed") {
      setLive(t("ekNotSavedYet"));
      if (!wide) setPanel(null);
    }
    return res;
  };

  // A retry never starts or extends a name round (see the kitchen screen).
  const retry = async (clientId) => {
    const item = pending.items.find((x) => x.clientId === clientId);
    const res = await pending.retry(clientId);
    if (res.ok) afterSaved(res.entry, byId[item?.checkId], null);
    else if (res.kind === "revoked") staffGone(clientId, item?.draft?.who);
  };

  const onUndo = async (entry) => {
    setUndoBusy(entry.id);
    try {
      await api.post(`/egenkontrol/entries/${encodeURIComponent(entry.id)}/undo`, {});
      dropRecent(entry.check_id);
      toast({ message: t("ekUndone"), severity: "info" });
      setLive(t("ekUndone"));
      freshness();
      reloadToday();
    } catch (err) {
      const code = errorCode(err);
      if (code === "undo_window_passed") {
        dropRecent(entry.check_id);
        toast({ message: t("ekUndoTooLate"), severity: "warn" });
      } else if (code === "already_voided") {
        dropRecent(entry.check_id);
        reloadToday();
      } else {
        toast({ message: t("ekErrSaveFailed"), severity: "critical" });
      }
    } finally {
      setUndoBusy(null);
    }
  };

  const openPending = (item) => {
    setPanelNonce((n) => n + 1);
    setPanel({ checkId: item.checkId, draft: { clientId: item.clientId, state: item.draft, code: item.code, missing: item.missing } });
  };

  // ── Kontrolmappe ──────────────────────────────────────────────────────
  const [folder, setFolder] = useState(null);
  const [folderFailed, setFolderFailed] = useState(false);
  const [folderKey, setFolderKey] = useState(0);
  const [pdfBusy, setPdfBusy] = useState(false);
  const folderOn = tab === "folder" && canFolder && !curtained;
  useEffect(() => {
    if (!folderOn) return undefined;
    let alive = true;
    api
      .get("/egenkontrol/folder", { params: branchId ? { branch_id: branchId } : {} })
      .then((r) => {
        if (!alive) return;
        setFolder(r.data || null);
        setFolderFailed(false);
      })
      .catch(() => alive && setFolderFailed(true));
    return () => {
      alive = false;
    };
  }, [folderOn, branchId, folderKey]);

  const downloadPdf = async () => {
    if (pdfBusy) return;
    setPdfBusy(true);
    const out = await downloadFolderPdf({
      from: folder?.from,
      to: folder?.to,
      businessDate: today?.business_date,
      branchId,
    });
    setPdfBusy(false);
    if (out?.ok === true) toast({ message: t("ekPdfReady"), severity: "success" });
    else toast({ message: t("ekPdfFailed"), severity: "critical" });
  };

  // ── Opsætning ─────────────────────────────────────────────────────────
  const [editor, setEditor] = useState(null); // { check } | { templateKey, defaultName }
  const [picking, setPicking] = useState(false);
  const tplList = Array.isArray(templates?.templates) ? templates.templates : [];

  const onEditorSaved = () => {
    setEditor(null);
    reloadChecks();
    reloadToday();
    freshness();
  };

  const addFromTemplate = (key) => {
    setPicking(false);
    const n = (checksData?.checks || []).filter((c) => c.template_key === key).length + 1;
    setEditor({ templateKey: key, defaultName: startItemName({ template_key: key, n }, t) });
  };

  // ── Render ────────────────────────────────────────────────────────────
  const header = (
    <PageHeader
      title={t("ekPageTitle")}
      subtitle={
        <>
          {t("ekPageSubtitle")}
          <span className="block mt-1 text-[13px] leading-snug" data-testid="ek-responsibility">{t("ekResponsibility")}</span>
        </>
      }
      className="mb-4! sm:mb-5!"
    />
  );

  const summary = today?.summary || {};
  const progress = !summary.total
    ? firstReadingLine(checks, today?.business_date, t, lang) || t("ekKitchenNoScheduled")
    : [
        t("ekKitchenProgress", { done: summary.done || 0, total: summary.total }),
        summary.missing ? t("ekKitchenMissing", { count: summary.missing }) : null,
      ]
        .filter(Boolean)
        .join(" · ");

  const panelCheck = panel ? byId[panel.checkId] : null;
  const recordPanel = panelCheck ? (
    <RecordPanel
      key={`${panel.checkId}:${panel.draft?.clientId || ""}:${panelNonce}`}
      check={panelCheck}
      staff={staff}
      heldWho={nameRound.held}
      onSave={onSave}
      onClose={() => setPanel(null)}
      draft={panel.draft}
      t={t}
      lang={lang}
      idPrefix="ek-owner"
    />
  ) : null;

  let readings;
  if (todayFailed && !today) {
    readings = <LoadFailed title={t("ekLoadFailed")} onRetry={reloadToday} />;
  } else if (!today) {
    readings = <p className="text-sm text-gray-500 dark:text-gray-400" role="status">{t("loading")}</p>;
  } else if (checks.length === 0) {
    if (!isOwner) {
      readings = (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5 text-[15px] text-gray-700 dark:text-gray-300" data-testid="ek-empty-member">
          {t("ekEmptyMember")}
        </div>
      );
    } else if (!checksData || !templates) {
      readings = <p className="text-sm text-gray-500 dark:text-gray-400" role="status">{t("loading")}</p>;
    } else if (ownerHasAnyCheck) {
      readings = (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5 text-[15px] text-gray-700 dark:text-gray-300">
          {t("ekKitchenNoScheduled")}
        </div>
      );
    } else if (templates.failed) {
      readings = <LoadFailed title={t("ekLoadFailed")} onRetry={() => window.location.reload()} />;
    } else {
      readings = (
        <SetupFromStartList
          templates={tplList}
          cutoffHour={cutoffHour}
          branchId={branchId}
          onCreated={() => {
            reloadToday();
            reloadChecks();
            freshness();
          }}
          t={t}
          lang={lang}
        />
      );
    }
  } else {
    readings = (
      <div className={wide && isOwner && panelCheck ? "grid grid-cols-[minmax(0,1fr)_minmax(360px,420px)] gap-5 items-start" : ""}>
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[15px] text-gray-700 dark:text-gray-300 font-display tabular-nums" data-testid="ek-owner-progress">{progress}</p>
            {isOwner ? <MeasurerBar held={nameRound.held} onClear={nameRound.clear} t={t} /> : null}
          </div>
          {pending.failedCount > 0 ? (
            <p className="mb-3 text-[14px] text-red-700 dark:text-red-400" role="alert">{t("ekKitchenOfflineHelp")}</p>
          ) : null}
          <CheckList
            checks={checks}
            selectedId={panel?.checkId || null}
            onSelect={isOwner ? (c) => setPanel({ checkId: c.id, draft: null }) : null}
            pending={pending.items}
            onRetry={retry}
            onOpenPending={openPending}
            recent={recent}
            now={now}
            onUndo={isOwner ? onUndo : null}
            undoBusy={undoBusy}
            t={t}
            lang={lang}
          />
        </div>
        {wide && isOwner && panelCheck ? (
          <aside className="sticky top-4 max-h-[calc(100dvh-2rem)] flex flex-col rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
            {recordPanel}
          </aside>
        ) : null}
      </div>
    );
  }

  let folderView = null;
  if (tab === "folder") {
    if (curtained) folderView = <DevicePinLockScreen />;
    else if (folderFailed && !folder) folderView = <LoadFailed title={t("ekLoadFailed")} onRetry={() => setFolderKey((k) => k + 1)} />;
    else if (!folder) folderView = <p className="text-sm text-gray-500 dark:text-gray-400" role="status">{t("loading")}</p>;
    else {
      folderView = (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 sm:p-6">
          <FolderView
            folder={folder}
            t={t}
            lang={lang}
            actions={
              <Button variant="primary" className="h-10" busy={pdfBusy} disabled={pdfBusy} onClick={downloadPdf} iconLeft={<Download className="w-4 h-4" aria-hidden="true" />}>
                {t("ekDownloadPdf")}
              </Button>
            }
          />
        </div>
      );
    }
  }

  let setupView = null;
  if (tab === "setup") {
    if (curtained) setupView = <DevicePinLockScreen />;
    else {
      const list = checksData?.checks || [];
      setupView = (
        <div className="space-y-5">
          <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900" data-testid="ek-setup-list">
            {checksData?.failed ? (
              <div className="p-4"><LoadFailed title={t("ekLoadFailed")} onRetry={reloadChecks} /></div>
            ) : list.length === 0 && checksData ? (
              <p className="p-4 text-[15px] text-gray-600 dark:text-gray-400">{t("ekEmptyBody")}</p>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {list.map((c) => {
                  const lim = c.limit || null;
                  return (
                    <li key={c.id} className="px-4 py-3 flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[15px] font-semibold text-gray-900 dark:text-gray-100">
                          {c.name}
                          {c.note ? <span className="ml-2 text-[13.5px] font-normal text-gray-500 dark:text-gray-400">{c.note}</span> : null}
                        </p>
                        <p className="text-[13.5px] text-gray-600 dark:text-gray-400">
                          <span className="font-display tabular-nums">{limitLine(c, t, lang)}</span>
                          {lim && sourceLine(lim, t) ? ` · ${sourceLine(lim, t)}` : ""}
                        </p>
                        {c.template_key === "receiving" && receivingSourceLine(c, t) ? (
                          <p className="text-[13px] text-gray-500 dark:text-gray-400" data-testid="ek-setup-receiving-source">
                            {receivingSourceLine(c, t)}
                          </p>
                        ) : null}
                        <p className="text-[13.5px] text-gray-500 dark:text-gray-400">{scheduleText(c, t, lang)}</p>
                        {!c.active ? (
                          <span className="mt-1 inline-block"><CheckStatusPill tone="muted">{t("ekSwitchOff")}</CheckStatusPill></span>
                        ) : null}
                      </div>
                      <Button variant="secondary" className="h-10 shrink-0" onClick={() => setEditor({ check: c })} iconLeft={<Pencil className="w-4 h-4" aria-hidden="true" />}>
                        {t("ekEditCheck")}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="p-4 border-t border-gray-100 dark:border-gray-800">
              {picking ? (
                <div className="flex flex-wrap gap-2" role="group" aria-label={t("ekAddCheck")}>
                  {tplList.map((tp) => (
                    <Chip key={tp.key} className="h-10" onClick={() => addFromTemplate(tp.key)}>
                      {t(EK_TEMPLATE_KEYS[tp.key])}
                    </Chip>
                  ))}
                </div>
              ) : (
                <Button variant="secondary" className="h-10" onClick={() => setPicking(true)} disabled={!tplList.length} iconLeft={<Plus className="w-4 h-4" aria-hidden="true" />}>
                  {t("ekAddCheck")}
                </Button>
              )}
            </div>
          </section>
          <p className="text-[13.5px] text-gray-600 dark:text-gray-400">{t("ekStartValuesNote")}</p>
          <KitchenDevicesCard branchId={branchId} t={t} lang={lang} />
        </div>
      );
    }
  }

  return (
    <div className="max-w-5xl mx-auto overflow-x-hidden" data-testid="ek-owner-page">
      <div className="sr-only" aria-live="polite" role="status">{live}</div>
      {header}
      {tabs.length > 1 ? (
        <TabPills tabs={tabs} activeId={tab} onChange={setTab} ariaLabel={t("ekPageTitle")} className="mb-5" />
      ) : null}
      {tab === "readings" ? readings : tab === "folder" ? folderView : setupView}

      {!wide && isOwner && panelCheck ? (
        <Sheet
          onClose={() => setPanel(null)}
          desktop="top"
          ariaLabel={t("ekRecord")}
          panelClassName="bg-white dark:bg-gray-900 border-t sm:border border-gray-200 dark:border-gray-700"
        >
          {recordPanel}
        </Sheet>
      ) : null}

      {editor ? (
        <CheckEditorSheet
          check={editor.check || null}
          templateKey={editor.templateKey || null}
          defaultName={editor.defaultName || ""}
          templates={tplList}
          cutoffHour={cutoffHour}
          branchId={branchId}
          onSaved={onEditorSaved}
          onClose={() => setEditor(null)}
          t={t}
          lang={lang}
        />
      ) : null}
    </div>
  );
}
