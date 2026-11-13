/**
 * The kitchen iPad — /kitchen/<token>. "I dag": the day's temperature checks,
 * the keypad, "Hvem målte?", and the Kontrolmappe read-only.
 *
 * A PAIRED DEVICE, NOT A LOGIN. The token in the path is the only credential
 * (services/kitchenApi: no session, no cookie, no 401 → /login). The backend
 * scopes it to the kitchen wrappers (today, staff, entries, undo, folder,
 * unpair) and 404s everything else, so this route sits OUTSIDE ProtectedRoute
 * and Layout, beside /stand. Nothing under src/stand imports this file, and
 * this file imports nothing from src/stand: the door screen's bundle is not
 * touched (egenkontrol.isolation.test.js).
 *
 * /kitchen (no token) — the "entry" mode: a remembered pairing reopens at
 * once; otherwise a card sends the iPad to bonbox.dk/stand to type the code.
 *
 * THE SERVER'S CLOCK IS THE ONLY CLOCK. The time on a reading is when the
 * server got it; the iPad's own time goes along as client_typed_at for
 * display only. Late, missed, in-limit, deviation: all decided server-side.
 *
 * Layout: landscape iPad (≥ 1024 px, landscape) = a FIXED-HEIGHT two-pane
 * screen (data-layout="landscape-panes"): the header on top, the list left
 * and "Registrér" right, each pane scrolling on its own. The panel is never
 * taller than the screen, so its save button and the next missing step are
 * always reachable inside it (R1a review: the old sticky column ran below the
 * iPad's bottom edge and a tap on the not-ready button could not reveal the
 * step). Portrait / narrow = the list, and a tap opens the panel in ui/Sheet,
 * TOP-anchored (desktop="top"): the panel grows downward as the deviation
 * questions appear, so the keypad never moves mid-entry. Tap targets ≥ 56 px,
 * keypad keys ≥ 64 px, 16 px gutter, no sideways scroll. Colours only through
 * ui/CheckStatusPill.
 *
 * "Hvem målte?" fits (release 2026-11-15): in landscape the whole name row
 * shows above the button WITHOUT scrolling the pane — the panel runs in
 * fit="panes" (keys 48 … 64 px from the pane's height, the "For varmt" line
 * inside the display, tighter head and button bar) and the header's progress
 * and "Måler" share one line of fixed height. Measured (headless Chromium,
 * three cooks): keys 61.6 px at 1180 × 820, 64 px at 1194 × 834 and
 * 1366 × 1024, 48.6 px at 1024 × 768 — never under 48 px; a shorter screen
 * than that scrolls the pane as before. egenkontrol.kitchenFit.test.jsx.
 *
 * R1b: unsent readings are kept on the iPad (a reload keeps them, and an
 * offline reload still lists them; a reading typed on an earlier business day
 * is sent once to ASK — a replay means it was stored — and only the server's
 * "another day" makes it "skriv den på papir"; "Par igen" asks first); a
 * photo can follow a deviation or a delivery; the Kontrolmappe shows the
 * owner's documents (read-only) and the photos.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { BookOpen, Loader2, MoreHorizontal, RotateCcw, X } from "lucide-react";

import { useLanguage } from "../hooks/useLanguage";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";
import { useMediaQuery } from "../hooks/useMediaQuery";
import usePageTitle from "../hooks/usePageTitle";
import Sheet from "../components/ui/Sheet";
import Button from "../components/ui/Button";
import CheckList from "../components/egenkontrol/CheckList";
import RecordPanel from "../components/egenkontrol/RecordPanel";
import FolderView from "../components/egenkontrol/FolderView";
import { MeasurerBar } from "../components/egenkontrol/NamePicker";
import useNameRound from "../components/egenkontrol/useNameRound";
import usePendingEntries, { kitchenQueueKey, useRecentSaves } from "../components/egenkontrol/usePendingEntries";
import { usePhotoUploads } from "../components/egenkontrol/usePhotoUploads";
import useScreenWakeLock from "../components/egenkontrol/useScreenWakeLock";
import UnsentList from "../components/egenkontrol/UnsentList";
import { errorCode, firstReadingLine, longDate, valueText } from "../components/egenkontrol/ekLogic";
import kitchenApi, {
  KITCHEN_TOKEN_RE,
  forgetKitchenToken,
  rememberKitchenToken,
  rememberedKitchenToken,
  rememberedKitchenVenue,
} from "../services/kitchenApi";

const TODAY_POLL_MS = 30000;
const STAFF_POLL_MS = 10 * 60 * 1000;
const BTN =
  "min-h-14! px-4 inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 " +
  "bg-white dark:bg-gray-900 text-[15px] font-semibold text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400";

export default function KitchenPage() {
  const { kitchenToken } = useParams();
  // The tab / home-screen title names the screen ("Egenkontrol"), not the landing.
  usePageTitle("navEgenkontrol");
  if (!kitchenToken) return <KitchenEntry />;
  return <KitchenScreen key={kitchenToken} token={kitchenToken} />;
}

/** /kitchen — reopen the remembered pairing, or say how to pair. */
function KitchenEntry() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [remembered] = useState(() => rememberedKitchenToken());
  useEffect(() => {
    if (remembered) navigate(`/kitchen/${remembered}`, { replace: true });
  }, [remembered, navigate]);
  if (remembered) return <Centered><Spinner label={t("loading")} /></Centered>;
  return (
    <Centered>
      <div className="w-full max-w-md rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-6">
        <h1 className="text-[22px] font-semibold text-gray-900 dark:text-gray-50">{t("ekDevicesTitle")}</h1>
        <p className="mt-2 text-[16px] leading-relaxed text-gray-700 dark:text-gray-300">{t("ekKitchenPairHint")}</p>
        <Button variant="main" className="mt-5 w-full min-h-14! text-[17px]" onClick={() => window.location.assign("/stand")}>
          {t("ekPairIpad")}
        </Button>
      </div>
    </Centered>
  );
}

function Centered({ children }) {
  return (
    <div className="min-h-dvh flex items-center justify-center px-4 py-10 bg-gray-50 dark:bg-gray-950">{children}</div>
  );
}

function Spinner({ label }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-[16px] text-gray-600 dark:text-gray-400">
      <Loader2 className="w-5 h-5 motion-safe:animate-spin" aria-hidden="true" />
      {label}
    </span>
  );
}

function KitchenScreen({ token }) {
  const { t, lang, setLang } = useLanguage();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const landscape = useMediaQuery("(min-width: 1024px) and (orientation: landscape)");
  const { supported: wakeLockSupported } = useScreenWakeLock(true);
  const nameRound = useNameRound();
  const { recent, now, add: addRecent, drop: dropRecent } = useRecentSaves();

  const validToken = KITCHEN_TOKEN_RE.test(token || "");
  const [phase, setPhase] = useState(validToken ? "loading" : "revoked");
  const [today, setToday] = useState(null);
  const [venue, setVenue] = useState(() => rememberedKitchenVenue());
  const [staff, setStaff] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [sheet, setSheet] = useState(null); // { checkId, draft }
  const [panelDraft, setPanelDraft] = useState(null); // landscape: draft for the selected check
  const [panelNonce, setPanelNonce] = useState(0);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folder, setFolder] = useState(null);
  const [folderPhase, setFolderPhase] = useState("idle");
  const [menuOpen, setMenuOpen] = useState(false);
  const [undoBusy, setUndoBusy] = useState(null);
  const [live, setLive] = useState("");
  const revokedRef = useRef(!validToken);

  const goRevoked = useCallback(() => {
    revokedRef.current = true;
    forgetKitchenToken();
    setPhase("revoked");
  }, []);

  // ── Today: on open, every 30 s while visible, and on coming back ─────
  const load = useCallback(() => {
    if (revokedRef.current) return Promise.resolve();
    return kitchenApi
      .today(token)
      .then((data) => {
        if (revokedRef.current) return;
        setToday(data);
        setPhase("ready");
        if (data?.venue_name) setVenue(data.venue_name);
        rememberKitchenToken(token, data?.venue_name || null);
      })
      .catch((err) => {
        if (err?.response?.status === 404) goRevoked();
        else setPhase((p) => (p === "ready" ? p : "error"));
      });
  }, [token, goRevoked]);

  useEffect(() => {
    if (!validToken) {
      forgetKitchenToken();
      return undefined;
    }
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, TODAY_POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVis);
    // The network came back: fetch /today now (not at the next 30 s poll), so
    // the readings waiting on this iPad go at once.
    window.addEventListener("online", load);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", load);
    };
  }, [load, validToken]);

  // ── Staff names: on open, every 10 minutes, and after a name was refused ─
  const fetchStaff = useCallback(() => {
    if (revokedRef.current) return;
    kitchenApi
      .staff(token)
      .then((d) => setStaff(Array.isArray(d?.staff) ? d.staff : []))
      .catch((err) => {
        if (err?.response?.status === 404) goRevoked();
      });
  }, [token, goRevoked]);
  useEffect(() => {
    if (!validToken) return undefined;
    fetchStaff();
    const id = setInterval(fetchStaff, STAFF_POLL_MS);
    return () => clearInterval(id);
  }, [validToken, fetchStaff]);

  // A 404 on a SAVE is not proof the iPad was unpaired: the server answers the
  // same 404 for a name it no longer has (a staff member deleted since the
  // list was fetched). Only a 404 on /today as well wipes the pairing.
  const deviceRevoked = useCallback(async () => {
    try {
      await kitchenApi.today(token);
      return false;
    } catch (err) {
      return err?.response?.status === 404;
    }
  }, [token]);

  // The photo follows its reading (never before it is saved).
  const photos = usePhotoUploads(
    useCallback((entryId, file) => kitchenApi.uploadPhoto(token, entryId, file), [token]),
    {
      onSaved: useCallback(() => {
        toast({ message: t("ekPhotoSaved"), severity: "success" });
        setLive(t("ekPhotoSaved"));
      }, [toast, t]),
    },
  );
  const afterPhoto = (item, entry) => {
    if (!entry?.id || !item) return;
    if (item.photo) photos.send(entry.id, item.checkId, item.photo);
    else if (item.hadPhoto) photos.markLost(entry.id, item.checkId);
  };

  // Readings sent without a tap (after a reload once /today is in, or when
  // the network comes back) report here like a "Prøv alle igen".
  const autoResultsRef = useRef(null);
  const onAutoResults = useCallback((results) => autoResultsRef.current?.(results), []);
  const pending = usePendingEntries(
    useCallback((body) => kitchenApi.saveEntry(token, body), [token]),
    { storageKey: kitchenQueueKey(token), businessDate: today?.business_date || null, onAutoResults },
  );

  const checks = useMemo(() => (Array.isArray(today?.checks) ? today.checks : []), [today]);
  const byId = useMemo(() => Object.fromEntries(checks.map((c) => [c.id, c])), [checks]);

  // Landscape: the panel shows the chosen check, else the first that wants a
  // reading now (overdue, due, open deviation), else the first.
  const autoId = useMemo(() => {
    const want = checks.find((c) => ["overdue", "deviation_open", "due"].includes(c.status));
    return (want || checks[0] || {}).id || null;
  }, [checks]);
  const panelCheckId = selectedId && byId[selectedId] ? selectedId : autoId;

  const announce = (msg) => setLive(msg);

  const afterSaved = (entry, check, who, item = null) => {
    addRecent(entry);
    if (who) nameRound.hold(who);
    const name = check?.name || item?.checkName || "";
    const value = valueText(entry, t, lang);
    let msg;
    let severity = "success";
    if (entry?.deviation_state) {
      msg = t("ekSavedDeviation", { check: name, value });
      severity = "notice";
    } else if (entry?.late) {
      msg = t("ekSavedLate", { check: name, value, due: entry.slot_due_local || "" });
      severity = "notice";
    } else {
      msg = t("ekSaved", { check: name, value });
    }
    toast({ message: msg, severity });
    announce(msg);
    load();
  };

  // The name was refused: keep the reading as "Kræver handling", fetch the
  // list again, and drop the held name if it was that person.
  const staffGone = (clientId, who) => {
    const missing = ["name"];
    pending.markNeedsAction(clientId, { code: "staff_gone", missing });
    const held = nameRound.held;
    if (who?.kind === "staff" && held?.kind === "staff" && held.id === who.id) nameRound.clear();
    fetchStaff();
    announce(t("ekErrStaffGone"));
    return { ok: false, kind: "needs_action", code: "staff_gone", missing };
  };

  const onSave = async (body, meta) => {
    const check = byId[meta.checkId];
    const res = await pending.submit({
      clientId: meta.clientId,
      checkId: meta.checkId,
      checkName: meta.checkName || check?.name || null,
      body,
      draft: meta.state,
      photo: meta.photo || null,
      businessDate: meta.businessDate || today?.business_date || null,
    });
    if (res.ok) {
      afterSaved(res.entry, check, meta.state?.who);
      afterPhoto(res.item, res.entry);
      if (!landscape) setSheet(null);
      setPanelDraft(null);
      return res;
    }
    if (res.kind === "revoked") {
      if (!(await deviceRevoked())) return staffGone(meta.clientId, meta.state?.who);
      setSheet(null);
      goRevoked();
      return res;
    }
    if (res.code === "check_inactive") {
      pending.remove(meta.clientId);
      toast({ message: t("ekErrCheckInactive"), severity: "warn" });
      setSheet(null);
      setPanelDraft(null);
      load();
      return { ok: false, kind: "closed" };
    }
    if (res.kind === "failed" || res.kind === "stale") {
      announce(t("ekNotSavedYet"));
      if (!landscape) setSheet(null);
      setPanelDraft(null);
    }
    return res;
  };

  // A retry never starts or extends a name round: whoever presses "Prøv igen"
  // may not be the person who measured (no name picked in advance, D7).
  const retry = async (clientId) => {
    const item = pending.items.find((x) => x.clientId === clientId);
    const res = await pending.retry(clientId);
    if (res.ok) {
      afterSaved(res.entry, byId[item?.checkId], null, item);
      afterPhoto(res.item, res.entry);
    } else if (res.kind === "revoked") {
      if (await deviceRevoked()) goRevoked();
      else staffGone(clientId, item?.draft?.who);
    }
  };

  const handleResults = async (results) => {
    for (const r of results) {
      const item = r.item;
      if (r.ok) {
        afterSaved(r.entry, byId[item?.checkId], null, item);
        afterPhoto(item, r.entry);
      } else if (r.kind === "revoked") {
        if (await deviceRevoked()) {
          goRevoked();
          break;
        }
        staffGone(r.item?.clientId, item?.draft?.who);
      }
    }
  };
  useEffect(() => {
    autoResultsRef.current = handleResults;
  });
  const retryAll = async () => handleResults(await pending.retryAll());

  // "Fjern" on a reading that will never be sent from here: asked first.
  const discard = async (item) => {
    const ok = await confirm({
      title: t("ekQueueDiscardConfirmTitle"),
      message: t("ekQueueDiscardConfirmBody"),
      confirmLabel: t("ekQueueDiscard"),
      cancelLabel: t("cancel"),
      destructive: true,
    });
    if (ok === true) pending.remove(item.clientId);
  };

  const openPending = (item) => {
    const draft = {
      clientId: item.clientId,
      state: item.draft,
      code: item.code,
      missing: item.missing,
      photo: item.photo || null,
      businessDate: item.businessDate || null,
    };
    setPanelNonce((n) => n + 1);
    if (landscape) {
      setSelectedId(item.checkId);
      setPanelDraft({ checkId: item.checkId, ...draft });
    } else {
      setSheet({ checkId: item.checkId, draft });
    }
  };

  const onUndo = async (entry) => {
    setUndoBusy(entry.id);
    try {
      await kitchenApi.undo(token, entry.id);
      dropRecent(entry.check_id);
      toast({ message: t("ekUndone"), severity: "info" });
      announce(t("ekUndone"));
      load();
    } catch (err) {
      const code = errorCode(err);
      if (err?.response?.status === 404) goRevoked();
      else if (code === "undo_window_passed") {
        dropRecent(entry.check_id);
        toast({ message: t("ekUndoTooLate"), severity: "warn" });
        announce(t("ekUndoTooLate"));
      } else if (code === "already_voided") {
        dropRecent(entry.check_id);
        load();
      } else {
        toast({ message: t("ekErrSaveFailed"), severity: "critical" });
      }
    } finally {
      setUndoBusy(null);
    }
  };

  const openFolder = () => {
    setMenuOpen(false);
    setFolderOpen(true);
    setFolderPhase("loading");
    kitchenApi
      .folder(token, 30)
      .then((d) => {
        setFolder(d);
        setFolderPhase("ready");
      })
      .catch((err) => {
        if (err?.response?.status === 404) goRevoked();
        else setFolderPhase("error");
      });
  };

  const unpair = async () => {
    setMenuOpen(false);
    const ok = await confirm({
      title: t("ekKitchenUnpairConfirmTitle"),
      message: t("ekKitchenUnpairConfirmBody"),
      confirmLabel: t("ekKitchenUnpair"),
      cancelLabel: t("cancel"),
      destructive: true,
    });
    if (ok !== true) return;
    try {
      await kitchenApi.unpair(token);
    } catch (err) {
      if (err?.response?.status !== 404) {
        toast({ message: t("ekErrSaveFailed"), severity: "critical" });
        return;
      }
    }
    revokedRef.current = true;
    forgetKitchenToken();
    navigate("/kitchen", { replace: true });
  };

  // ── Revoked: never a blank screen, never /login ───────────────────────
  if (phase === "revoked") {
    return (
      <Centered>
        <div className="w-full max-w-md rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-6" role="alert" data-testid="ek-kitchen-revoked">
          <h1 className="text-[22px] font-semibold text-gray-900 dark:text-gray-50">
            {venue ? t("ekKitchenRevokedTitle", { venue }) : t("ekKitchenRevokedTitleNoVenue")}
          </h1>
          <p className="mt-2 text-[16px] text-gray-700 dark:text-gray-300">{t("ekKitchenRevokedBody")}</p>
          {pending.unsentCount > 0 ? (
            <>
              <p className="mt-3 text-[16px] font-semibold text-red-700 dark:text-red-400">
                {t("ekKitchenUnsent", { count: pending.unsentCount })}
              </p>
              <UnsentList items={pending.items} t={t} lang={lang} />
            </>
          ) : null}
          <Button
            variant="main"
            className="mt-5 w-full min-h-14! text-[17px]"
            onClick={async () => {
              // The list above was the last place these readings lived on this
              // iPad: ask before wiping them (a wet-handed tap is easy).
              if (pending.unsentCount > 0) {
                const ok = await confirm({
                  title: t("ekKitchenPairAgainConfirmTitle"),
                  message: t("ekKitchenPairAgainConfirmBody", { count: pending.unsentCount }),
                  confirmLabel: t("ekKitchenPairAgain"),
                  cancelLabel: t("cancel"),
                  destructive: true,
                });
                if (ok !== true) return;
              }
              pending.clearAll();
              window.location.assign("/stand");
            }}
          >
            {t("ekKitchenPairAgain")}
          </Button>
        </div>
      </Centered>
    );
  }

  if (phase === "loading" || (phase === "error" && !today)) {
    return (
      <Centered>
        {phase === "loading" ? (
          <Spinner label={t("loading")} />
        ) : (
          <div className="text-center w-full max-w-md">
            <p className="text-[17px] text-gray-800 dark:text-gray-200" role="alert">{t("ekLoadFailed")}</p>
            {pending.unsentCount > 0 ? (
              // Offline reload: the readings are still on this iPad — say so,
              // so nobody writes them on paper twice.
              <div className="mt-3 text-left" data-testid="ek-kitchen-waiting">
                <p className="text-[16px] font-semibold text-gray-900 dark:text-gray-100">
                  {t("ekQueueWaitingOffline", { count: pending.unsentCount })}
                </p>
                <UnsentList items={pending.items} t={t} lang={lang} heading={t("ekQueueWaitingList")} />
              </div>
            ) : null}
            <button type="button" className={BTN + " mt-4"} onClick={() => load()}>
              <RotateCcw className="w-4 h-4" aria-hidden="true" />
              {t("ekRetry")}
            </button>
          </div>
        )}
      </Centered>
    );
  }

  const summary = today?.summary || {};
  const progress =
    checks.length === 0
      ? t("ekKitchenNoChecks")
      : !summary.total
        ? firstReadingLine(checks, today?.business_date, t, lang) || t("ekKitchenNoScheduled")
        : [
            t("ekKitchenProgress", { done: summary.done || 0, total: summary.total }),
            summary.missing ? t("ekKitchenMissing", { count: summary.missing }) : null,
          ]
            .filter(Boolean)
            .join(" · ");

  const panelFor = (checkId, draft, onClose) => {
    const check = byId[checkId];
    if (!check) return null;
    return (
      <RecordPanel
        businessDate={draft?.businessDate || today?.business_date || null}
        key={`${checkId}:${draft?.clientId || ""}:${panelNonce}`}
        check={check}
        staff={staff}
        heldWho={nameRound.held}
        onSave={onSave}
        onClose={onClose}
        draft={draft}
        t={t}
        lang={lang}
        idPrefix="ek-kitchen"
        fit={landscape ? "panes" : "sheet"}
      />
    );
  };

  const list = (
    <CheckList
      checks={checks}
      selectedId={landscape ? panelCheckId : null}
      onSelect={(c) => {
        setPanelDraft(null);
        if (landscape) setSelectedId(c.id);
        else setSheet({ checkId: c.id, draft: null });
      }}
      pending={pending.items}
      onRetry={retry}
      onOpenPending={openPending}
      recent={recent}
      now={now}
      onUndo={onUndo}
      undoBusy={undoBusy}
      t={t}
      lang={lang}
      onDiscard={discard}
      staleMode="kitchen"
      photos={photos.photos}
      onRetryPhoto={photos.retry}
      onDismissPhoto={photos.dismiss}
      onRetakePhoto={(entryId, checkId, file) => photos.send(entryId, checkId, file)}
    />
  );

  // The Kontrolmappe on the iPad: read-only — photos and the owner's
  // documents through the token's own proxy routes, no actions.
  const folderLoaders = {
    loadPhoto: (id) => kitchenApi.photo(token, id),
    loadDocument: (doc) => kitchenApi.documentFile(token, doc.id),
  };

  return (
    <div
      className={
        "bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 overflow-x-hidden " +
        (landscape ? "h-dvh flex flex-col overflow-hidden" : "min-h-dvh")
      }
      data-testid="ek-kitchen"
      data-layout={landscape ? "landscape-panes" : "stack"}
    >
      <div className="sr-only" aria-live="polite" role="status">{live}</div>
      <header className="px-4 pt-4 pb-3 shrink-0" style={{ paddingTop: "max(1rem, env(safe-area-inset-top, 0px))" }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[15px] text-gray-600 dark:text-gray-400 truncate">
              {[today?.venue_name, today?.branch_name, today?.device_label].filter(Boolean).join(" · ")}
            </p>
            <h1 className="text-[28px] font-semibold leading-tight text-gray-900 dark:text-gray-50">
              {t("ekKitchenToday")}
              <span className="ml-3 text-[18px] font-normal text-gray-600 dark:text-gray-400">
                {longDate(today?.business_date, lang)}
              </span>
            </h1>
            {/* Landscape: the progress and "Måler: … · Skift" share ONE line of
                fixed height (the pane below gets that line back, and holding a
                name no longer moves the panes). Portrait: two lines as before. */}
            <div className={landscape ? "mt-1 h-8 flex items-center gap-x-4 min-w-0" : undefined} data-testid="ek-kitchen-status">
              <p className={(landscape ? "shrink-0 " : "mt-1 ") + "text-[16px] text-gray-700 dark:text-gray-300 font-display tabular-nums"} data-testid="ek-kitchen-progress">
                {progress}
              </p>
              <div className={landscape ? "min-w-0 flex items-center" : "mt-1 min-h-6"}>
                <MeasurerBar held={nameRound.held} onClear={nameRound.clear} t={t} />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label={t("ekKitchenLanguage")} className="inline-flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden">
              {["da", "en"].map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => setLang(code)}
                  aria-pressed={lang === code}
                  className={`min-h-14! min-w-14 px-3 text-[15px] font-semibold uppercase ${lang === code ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900" : "bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300"}`}
                >
                  {code}
                </button>
              ))}
            </div>
            <button type="button" className={BTN} onClick={openFolder} data-testid="ek-kitchen-folder">
              <BookOpen className="w-5 h-5" aria-hidden="true" />
              {t("ekKitchenFolder")}
            </button>
            <div className="relative">
              <button
                type="button"
                className={BTN + " min-w-14 px-3"}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={t("ekKitchenUnpair")}
                onClick={() => setMenuOpen((o) => !o)}
              >
                <MoreHorizontal className="w-5 h-5" aria-hidden="true" />
              </button>
              {menuOpen ? (
                <div role="menu" className="absolute right-0 mt-2 z-30 w-64 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-1 shadow-sm">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={unpair}
                    className="w-full min-h-14! px-4 text-left rounded-lg text-[16px] font-semibold text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
                  >
                    {t("ekKitchenUnpair")}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {pending.failedCount > 0 ? (
          <div className="mt-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-4 py-3 flex flex-wrap items-center gap-3" role="alert">
            <p className="flex-1 min-w-0 text-[15px] text-red-800 dark:text-red-300">{t("ekKitchenOfflineHelp")}</p>
            {pending.failedCount > 1 ? (
              <button type="button" className={BTN} onClick={retryAll}>
                <RotateCcw className="w-4 h-4" aria-hidden="true" />
                {t("ekRetryAll")}
              </button>
            ) : null}
          </div>
        ) : null}
        {!wakeLockSupported ? (
          <p className="mt-2 text-[13px] text-gray-500 dark:text-gray-400">{t("ekKitchenWakeLockHint")}</p>
        ) : null}
      </header>

      {folderOpen ? (
        <main className={"px-4 pb-8 " + (landscape ? "flex-1 min-h-0 overflow-y-auto overscroll-contain" : "")} data-testid="ek-kitchen-folder-main">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-[20px] font-semibold">{t("ekKitchenFolder")}</h2>
            <button type="button" className={BTN} onClick={() => setFolderOpen(false)} aria-label={t("close")}>
              <X className="w-5 h-5" aria-hidden="true" />
              {t("close")}
            </button>
          </div>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
            {folderPhase === "loading" ? (
              <Spinner label={t("loading")} />
            ) : folderPhase === "error" ? (
              <div>
                <p role="alert" className="text-[16px]">{t("ekLoadFailed")}</p>
                <button type="button" className={BTN + " mt-3"} onClick={openFolder}>
                  <RotateCcw className="w-4 h-4" aria-hidden="true" />
                  {t("ekRetry")}
                </button>
              </div>
            ) : (
              <FolderView folder={folder} t={t} lang={lang} loaders={folderLoaders} />
            )}
          </div>
        </main>
      ) : landscape ? (
        <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_minmax(380px,440px)] gap-4 px-4 pb-4" data-testid="ek-kitchen-panes">
          <main className="min-w-0 min-h-0 overflow-y-auto overscroll-contain" data-testid="ek-kitchen-list-pane">{list}</main>
          <aside
            className="min-w-0 min-h-0 h-full flex flex-col rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden"
            aria-label={t("ekRecord")}
            data-testid="ek-kitchen-record-pane"
          >
            {panelCheckId
              ? panelFor(panelCheckId, panelDraft && panelDraft.checkId === panelCheckId ? panelDraft : null, null)
              : null}
          </aside>
        </div>
      ) : (
        <main className="px-4 pb-8 min-w-0">{list}</main>
      )}

      {!landscape && sheet && byId[sheet.checkId] ? (
        <Sheet
          onClose={() => setSheet(null)}
          desktop="top"
          ariaLabel={t("ekRecord")}
          panelClassName="bg-white dark:bg-gray-900 border-t sm:border border-gray-200 dark:border-gray-700"
        >
          {panelFor(sheet.checkId, sheet.draft, () => setSheet(null))}
        </Sheet>
      ) : null}
    </div>
  );
}
