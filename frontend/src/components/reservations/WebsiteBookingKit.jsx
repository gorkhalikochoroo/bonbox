// WebsiteBookingKit — "Book bord på din hjemmeside": the ONE place an owner
// gets booking onto their own website. Three ways, fastest first:
//
//   1. Link og knap — the booking link (one-tap copy), a ready "Book bord"
//      button as plain HTML, and the QR code as a print-ready PNG.
//   2. Indlejr      — the whole booking form inside their page (iframe that
//      sizes itself from the page's bonbox:height messages), centred in
//      their column at the width they choose, with the compact header and
//      the card as switches, and a live preview of the real booking page on
//      a phone or on their page on a computer (booking R4).
//   3. Vejledning   — four short steps per site builder, plus the notes that
//      builder needs (WordPress block editor and Elementor, Wix, Squarespace
//      in detail; R4).
//
// Plus a mailto: hand-off to whoever makes their website. It only OPENS the
// owner's own mail app, pre-filled — BonBox sends nothing.
//
// Every snippet comes from utils/bookingEmbed.js, so what is copied, what is
// e-mailed and what the preview shows are built by the same code.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, Download, ExternalLink, Globe, Mail, Monitor, Smartphone } from "lucide-react";
import TabPills from "../ui/TabPills";
import { saveFile } from "../../utils/download";
import { platform } from "../../utils/platform";
import { BOOKING_LOOK_EVENT } from "../../utils/accentColor";
import {
  BUTTON_STYLE,
  EMBED_WIDTHS,
  EMBED_WIDTH_DEFAULT,
  LOOK_FRAME_RADIUS,
  LOOK_SAMPLES,
  LOOK_SAMPLE_IDS,
  SITE_BUILDERS,
  buttonSnippet,
  embedOriginFor,
  guideNoteKeys,
  guideStepKeys,
  iframeSnippet,
  mailtoHref,
  previewSrcFor,
  qrFileName,
  sampleLookQuery,
} from "../../utils/bookingEmbed";

// Booking R4: a new snippet carries the compact header (&compact=1) unless the
// owner switches it off — their own page already shows their logo, name and
// address, and without them "Vælg tid" sits above the fold on a 390×844
// phone. Snippets pasted before R4 keep the full header. One line to flip.
export const COMPACT_DEFAULT = true;

// Booking R13 (Manoj, 27–28 Oct): a new snippet matches the restaurant's
// website — its background, text colour, button colour, corners and font,
// read on their page by the snippet and checked in the frame — unless the
// owner switches it off. Off = the R4 snippet, byte for byte. Snippets
// already pasted carry no opt-in and stay exactly as they are.
export const MATCH_DEFAULT = true;

// The owner's override, in the snippet as data- attributes.
const LOOK_MODE_LABEL = { auto: "rsvpWebColoursAuto", light: "rsvpWebColoursLight", dark: "rsvpWebColoursDark" };
const LOOK_ACCENT_LABEL = { site: "rsvpWebButtonColourSite", own: "rsvpWebButtonColourOwn" };
const SAMPLE_LABEL = { light: "rsvpWebSampleLight", dark: "rsvpWebSampleDark", photo: "rsvpWebSamplePhoto" };
// The stand-in "photo" site: flat shapes of a dim room (no photo of anyone's
// venue ships with the app, no gradient).
const SAMPLE_PHOTO =
  'url("data:image/svg+xml,' +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 300' preserveAspectRatio='xMidYMid slice'>" +
      "<rect width='400' height='300' fill='#2a211b'/><rect y='190' width='400' height='110' fill='#1c1612'/>" +
      "<rect x='40' y='60' width='90' height='120' fill='#3a2e25'/><rect x='270' y='40' width='100' height='150' fill='#34291f'/>" +
      "<rect x='196' y='0' width='8' height='46' fill='#151110'/><circle cx='200' cy='70' r='26' fill='#c8a46e'/>" +
      "<rect x='110' y='200' width='180' height='14' fill='#4a3a2c'/></svg>",
  ).replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()) +
  '")';
// What each sample site looks like around the frame (its own page).
function sampleGround(id) {
  const s = LOOK_SAMPLES[id];
  if (!s) return undefined;
  return s.surface === "photo"
    ? { backgroundColor: "#2a211b", backgroundImage: SAMPLE_PHOTO, backgroundSize: "cover", backgroundPosition: "center" }
    : { backgroundColor: "#" + s.surface };
}

// The width choices' words (EMBED_WIDTHS).
const WIDTH_LABEL = { 460: "rsvpWebEmbedWidthStd", 560: "rsvpWebEmbedWidthWide" };

// Phone controls are 40px with 13px text (index.css's 44px coarse-pointer
// floor is released for exactly these); from sm: up they are 36px.
const CTRL =
  "inline-flex items-center justify-center gap-1.5 shrink-0 h-10 sm:h-9 min-h-0! px-3 rounded-lg " +
  "text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-[rgb(var(--brand-green-accent))] focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-[rgb(var(--surface-card))]";
const PRIMARY =
  CTRL + " bg-gray-900 text-white hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100";
const SECONDARY =
  CTRL +
  " border border-gray-200 dark:border-gray-700 bg-white dark:bg-transparent text-gray-800 " +
  "dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800";
const HEAD = "text-[13px] font-semibold text-gray-800 dark:text-gray-200";
const HINT = "text-xs text-gray-500 dark:text-gray-400 leading-relaxed";
const CODE =
  "max-h-28 overflow-auto rounded-lg bg-gray-50 dark:bg-gray-950 border border-gray-100 " +
  "dark:border-gray-800 p-2.5 text-[11px] leading-relaxed text-gray-700 dark:text-gray-300 " +
  "font-mono whitespace-pre";
// One pill for every one-of choice in the kit (site builder, width, device):
// 40px / 13px on a phone, 32px from sm. Picked = gray-900; in dark a raised
// grey, never the inverted white slab (27 Sep phone rule).
const PILL =
  "inline-flex items-center justify-center gap-1.5 h-10 sm:h-8 min-h-0! px-3 rounded-full text-[13px] font-medium " +
  "transition-colors focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-[rgb(var(--brand-green-accent))] ";
const pillClass = (on) =>
  PILL +
  (on
    ? "bg-gray-900 text-white dark:bg-gray-600 dark:text-white"
    : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700");

// One switch row (the compact header, the card): a checkbox, its name and
// one quiet line on what it does.
function OptionCheck({ checked, onChange, label, hint, testId }) {
  return (
    <label className="flex items-start gap-2.5 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
        className="mt-0.5 h-4 w-4 min-h-0! shrink-0 rounded border-gray-300 dark:border-gray-600 accent-gray-900 dark:accent-gray-100"
      />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-gray-800 dark:text-gray-200">{label}</span>
        <span className={HINT + " block"}>{hint}</span>
      </span>
    </label>
  );
}

// One labelled row of pills for a one-of choice (R13: colours, button
// colour, sample site) — the width row's look and roles.
function ChoiceRow({ id, label, options, value, onPick, word }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <span id={id + "-label"} className="text-[13px] font-medium text-gray-800 dark:text-gray-200">
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={id + "-label"} data-testid={id} className="flex flex-wrap gap-1.5">
        {options.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={value === k}
            data-value={k}
            onClick={() => onPick(k)}
            className={pillClass(value === k)}
          >
            {word(k)}
          </button>
        ))}
      </div>
    </div>
  );
}

// The stand-in website's own top line in the computer preview (R13): its
// name in its own ink and its own button — what the booking just matched.
// With "Din BonBox-farve" the button is still the site's; the booking keeps
// the owner's colour.
function SampleHeader({ id, t }) {
  const s = LOOK_SAMPLES[id];
  if (!s) return null;
  const font = { georgia: "Georgia, serif", helvetica: '"Helvetica Neue", Helvetica, Arial, sans-serif', system: "system-ui, sans-serif" }[s.font];
  return (
    <div
      data-testid="website-preview-sample-header"
      className="mx-auto mb-4 flex max-w-[560px] items-center justify-between gap-3 px-1"
      style={{ color: "#" + s.ink, fontFamily: font }}
    >
      <span className="text-[15px] font-semibold truncate">{t("rsvpWebSampleSite")}</span>
      <span
        aria-hidden="true"
        className="shrink-0 px-3 py-1.5 text-[12px] font-semibold"
        style={{ background: "#" + s.accent, color: "#" + s.accent_ink, borderRadius: { sharp: 2, soft: 8, round: 9999 }[s.radius] }}
      >
        {t("rsvpWebSampleButton")}
      </span>
    </div>
  );
}

// "On your page, on a computer": the booking at the width the owner chose,
// centred on a light ground that stands in for their website — the card,
// its shadow and the centring as their guests will see them. Scaled down
// (never up) when the owner's own screen is narrower than that width, so a
// phone shows the whole thing. The frame itself is the chosen width, so the
// page inside lays out exactly as it will there.
function HostPreview({ src, width, height, frameRef, title, ground, header = null, frameRadius }) {
  const boxRef = useRef(null);
  const [avail, setAvail] = useState(0);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => setAvail(el.clientWidth || 0);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Unmeasured (0) = full size; never above 1.
  const scale = avail > 0 ? Math.min(1, avail / width) : 1;
  return (
    <div
      data-testid="website-preview-host"
      className="rounded-xl bg-gray-100 dark:bg-gray-100 px-3 py-5 sm:px-5 sm:py-8"
      style={ground}
    >
      {header}
      <div ref={boxRef} className="w-full">
        <div
          className="mx-auto overflow-hidden"
          style={{ width: Math.round(width * scale), height: Math.round(height * scale) }}
        >
          <iframe
            ref={frameRef}
            src={src}
            title={title}
            loading="lazy"
            data-testid="website-preview"
            data-scale={scale.toFixed(3)}
            style={{
              width,
              height,
              transform: scale < 1 ? `scale(${scale})` : undefined,
              transformOrigin: "0 0",
              borderRadius: frameRadius,
            }}
            className="block border-0"
          />
        </div>
      </div>
    </div>
  );
}

// The inline style of the snippet, as a React style object — the on-screen
// button IS the snippet's button.
const BUTTON_STYLE_OBJ = Object.fromEntries(
  BUTTON_STYLE.split(";").filter(Boolean).map((decl) => {
    const i = decl.indexOf(":");
    const prop = decl.slice(0, i).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return [prop, decl.slice(i + 1)];
  }),
);

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the textarea path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// The on-screen QR (SVG) drawn onto a 1024px canvas with a white ground — a
// print shop needs pixels, and a transparent PNG prints black-on-nothing.
function svgToPngBlob(svg, size = 1024) {
  return new Promise((resolve) => {
    try {
      const xml = new XMLSerializer().serializeToString(svg);
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = size;
          c.height = size;
          const g = c.getContext("2d");
          g.fillStyle = "#ffffff";
          g.fillRect(0, 0, size, size);
          g.imageSmoothingEnabled = false;
          g.drawImage(img, 0, 0, size, size);
          c.toBlob((b) => resolve(b || null), "image/png");
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
    } catch {
      resolve(null);
    }
  });
}

// promptLabel: when both clipboard paths are refused (an embedded webview, a
// locked-down browser), show the text in a prompt so it can be copied by hand
// — the last resort the old share card had, kept for the link.
function CopyButton({ text, label, copiedLabel, primary = false, testId, promptLabel = "" }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return undefined;
    const id = setTimeout(() => setDone(false), 2500);
    return () => clearTimeout(id);
  }, [done]);
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={async () => {
        const ok = await copyText(text);
        setDone(ok);
        if (!ok && promptLabel) {
          try {
            window.prompt(promptLabel, text);
          } catch { /* no prompt (headless): nothing more to offer */ }
        }
      }}
      className={primary ? PRIMARY : SECONDARY}
    >
      {done ? <Check className="w-4 h-4" aria-hidden /> : <Copy className="w-4 h-4" aria-hidden />}
      <span aria-live="polite">{done ? copiedLabel : label}</span>
    </button>
  );
}

export default function WebsiteBookingKit({
  publicUrl,
  venueName,
  isProvider = false,
  enabled = true,
  // Push 7 — the venue has nothing online booking can book yet (a shop or a
  // workshop with no table and no behandler): there is no switch to point
  // at, so the kit says why there is nothing here.
  notReady = false,
  t,
  // Injected for tests; the real values come from the running app.
  appOrigin = typeof window !== "undefined" ? window.location.origin : "",
  canFramePreview = !(platform.isNative && platform.isIOS),
}) {
  const [option, setOption] = useState("link");
  // The booking draws itself as one white card on the owner's page from
  // 450 px (booking R3). A site that already frames it can switch the card
  // off: the snippet then loads the page with &flat=1.
  const [flat, setFlat] = useState(false);
  // Booking R4: the compact header (default on for a new snippet), the width
  // in the owner's column, and which preview — a phone, or their page on a
  // computer (the only place the width and the card show).
  const [compact, setCompact] = useState(COMPACT_DEFAULT);
  // Booking R13: match the website (default on), the owner's override, and
  // the sample site the preview shows it on.
  const [match, setMatch] = useState(MATCH_DEFAULT);
  const [lookMode, setLookMode] = useState("auto");
  const [lookAccent, setLookAccent] = useState("site");
  const [sample, setSample] = useState("light");
  const [width, setWidth] = useState(EMBED_WIDTH_DEFAULT);
  const [device, setDevice] = useState("phone");
  const [builder, setBuilder] = useState(SITE_BUILDERS[0].id);
  const [qrError, setQrError] = useState(false);
  const [previewH, setPreviewH] = useState(640);
  const qrRef = useRef(null);
  const frameRef = useRef(null);
  // Booking R5: the owner changed the page's colour (BookingAccentRow) — the
  // open preview reloads, so it shows what guests now get.
  const [look, setLook] = useState(0);
  useEffect(() => {
    const bump = () => setLook((n) => n + 1);
    window.addEventListener(BOOKING_LOOK_EVENT, bump);
    return () => window.removeEventListener(BOOKING_LOOK_EVENT, bump);
  }, []);
  const pickDevice = (d) => {
    if (d === device) return;
    // The other frame is another width: its height comes from its own
    // messages, not the last frame's.
    setPreviewH(640);
    setDevice(d);
  };
  // A choice the phone can't show (the width, the card) turns the preview to
  // the computer, so the owner sees what they just changed.
  const pickWidth = (w) => {
    setWidth(w);
    pickDevice("computer");
  };
  const pickFlat = (v) => {
    setFlat(v);
    pickDevice("computer");
  };

  // `isProvider`: the page's appointment words (a salon, a shop, a workshop —
  // venueProfiles.speaksAppointments): "Book tid", customers, the counter;
  // never "Book bord" or table cards (vertical-fit review, Oct 2026).
  const title = isProvider ? t("rsvpWebTitleProvider") : t("rsvpWebTitle");
  const label = isProvider ? t("rsvpWebButtonLabelProvider") : t("rsvpEmbedButtonLabel");
  const live = enabled && !!publicUrl;

  const kit = useMemo(() => {
    if (!live) return null;
    const lk = match ? { mode: lookMode, accent: lookAccent } : null;
    const button = buttonSnippet({ publicUrl, label });
    const iframe = iframeSnippet({
      publicUrl,
      label,
      venueName,
      fallbackLabel: t("rsvpEmbedOpenInNewTab"),
      flat,
      compact,
      width,
      look: lk,
      hosted: true,
    });
    // The whole snippet rides in the mail, which stays a mailto: link every
    // mail program keeps whole (≤ 2,000 characters, R13 fix round): the code
    // and where it goes; the full guides live in the kit.
    const mail = mailtoHref({
      subject: t("rsvpEmbedMailSubject"),
      body: t("rsvpWebMailBody", { link: publicUrl, iframe, origin: embedOriginFor(publicUrl) }),
    });
    const lookQuery = sampleLookQuery(sample, lk);
    return { button, iframe, mail, preview: previewSrcFor(publicUrl, appOrigin, { flat, compact, lookQuery }) };
  }, [live, publicUrl, label, venueName, appOrigin, t, flat, compact, width, match, lookMode, lookAccent, sample]);

  // The preview sizes itself exactly like the owner's page will: from the
  // booking page's own height messages, trusted only from that frame.
  useEffect(() => {
    if (!kit || option !== "embed") return undefined;
    let origin = "";
    try {
      origin = new URL(kit.preview).origin;
    } catch { /* no origin, no messages accepted */ }
    const onMsg = (e) => {
      const f = frameRef.current;
      if (!f || e.source !== f.contentWindow || e.origin !== origin) return;
      if (!e.data || e.data.type !== "bonbox:height") return;
      const h = Number(e.data.height);
      if (Number.isFinite(h) && h > 0) setPreviewH(Math.min(Math.max(Math.ceil(h), 320), 2400));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [kit, option]);

  const downloadQr = async () => {
    setQrError(false);
    const svg = qrRef.current?.querySelector("svg");
    const blob = svg ? await svgToPngBlob(svg) : null;
    const res = blob
      ? await saveFile(blob, qrFileName(publicUrl), { type: "image/png", title })
      : { ok: false };
    if (!res?.ok) setQrError(true);
  };

  const active = SITE_BUILDERS.find((b) => b.id === builder) || SITE_BUILDERS[0];

  return (
    <section
      id="website"
      aria-labelledby="website-title"
      data-testid="website-booking-kit"
      className="scroll-mt-24 rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 space-y-4"
    >
      <div>
        <h2
          id="website-title"
          tabIndex={-1}
          className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2 focus:outline-none"
        >
          <Globe className="w-4 h-4 text-gray-400" aria-hidden />
          {title}
        </h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          {live
            ? t("rsvpWebSub")
            : notReady
              ? (isProvider ? t("rsvpWebNotReadyProvider") : t("rsvpWebNotReady"))
              : isProvider ? t("rsvpWebOffProvider") : t("rsvpWebOff")}
        </p>
      </div>

      {kit && (
        <>
          <TabPills
            tabs={[
              { id: "link", label: t("rsvpWebTabLink") },
              { id: "embed", label: t("rsvpWebTabEmbed") },
              { id: "guides", label: t("rsvpWebTabGuides") },
            ]}
            activeId={option}
            onChange={setOption}
            ariaLabel={t("rsvpWebOptionsAria")}
            phone="segmented"
          />

          {option === "link" && (
            <div className="space-y-5" data-testid="website-option-link">
              <div className="space-y-2">
                <p className={HEAD}>{t("rsvpWebLinkHeading")}</p>
                <div className="flex items-center gap-2">
                  <div
                    className="flex-1 min-w-0 h-10 sm:h-9 px-3 flex items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-[13px] text-gray-700 dark:text-gray-300 truncate"
                    data-testid="website-link"
                  >
                    <span className="truncate">{publicUrl}</span>
                  </div>
                  <CopyButton
                    text={publicUrl}
                    label={t("rsvpWebCopyLink")}
                    copiedLabel={t("rsvpCopied")}
                    primary
                    testId="website-copy-link"
                    promptLabel={t("rsvpCopyLinkPrompt")}
                  />
                  {/* Below sm: the icon alone, so the link box keeps room
                      for the address; named by aria-label, titled on hover. */}
                  <a
                    href={publicUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("rsvpOpenPage")}
                    title={t("rsvpOpenPage")}
                    className={SECONDARY + " max-sm:w-10 max-sm:px-0"}
                    data-testid="website-open-page"
                  >
                    <ExternalLink className="w-4 h-4" aria-hidden />
                    <span className="max-sm:hidden">{t("rsvpOpenPage")}</span>
                  </a>
                </div>
                <p className={HINT}>{isProvider ? t("rsvpWebLinkHintProvider") : t("rsvpWebLinkHint")}</p>
              </div>

              <div className="space-y-2 border-t border-gray-100 dark:border-gray-800 pt-4">
                <p className={HEAD}>{t("rsvpWebButtonHeading", { label })}</p>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  {/* The real button, styled from the same string the snippet
                      carries — a live link to the booking page. */}
                  <a
                    href={publicUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={BUTTON_STYLE_OBJ}
                    className="min-h-0!"
                    data-testid="website-button-preview"
                  >
                    {label}
                  </a>
                  <CopyButton
                    text={kit.button}
                    label={t("rsvpEmbedCopyCode")}
                    copiedLabel={t("rsvpCopied")}
                    testId="website-copy-button"
                  />
                </div>
                <pre className={CODE} data-testid="website-button-code">{kit.button}</pre>
                <p className={HINT}>{t("rsvpWebButtonHint")}</p>
              </div>

              <div className="border-t border-gray-100 dark:border-gray-800 pt-4 flex items-start gap-4">
                <div ref={qrRef} className="shrink-0 bg-white rounded-lg border border-gray-200 dark:border-gray-700 p-1.5">
                  {/* Generated client-side (qrcode.react): no image service,
                      works offline, and the PNG is drawn from this SVG. */}
                  <QRCodeSVG
                    value={publicUrl}
                    size={88}
                    level="M"
                    marginSize={2}
                    title={t("rsvpQrAlt")}
                    className="w-[88px] h-[88px]"
                  />
                </div>
                <div className="min-w-0 space-y-2">
                  <p className={HEAD}>{isProvider ? t("rsvpWebQrHeadingProvider") : t("rsvpWebQrHeading")}</p>
                  <p className={HINT}>{isProvider ? t("rsvpWebQrHintProvider") : t("rsvpWebQrHint")}</p>
                  <button type="button" onClick={downloadQr} className={SECONDARY} data-testid="website-qr-download">
                    <Download className="w-4 h-4" aria-hidden />
                    {t("rsvpWebQrDownload")}
                  </button>
                  {qrError && (
                    <p role="alert" className="text-xs text-red-600 dark:text-red-400">{t("rsvpWebQrFailed")}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {option === "embed" && (
            <div className="space-y-4" data-testid="website-option-embed">
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className={HEAD}>{t("rsvpWebEmbedHeading")}</p>
                    <p className={HINT}>{t("rsvpWebEmbedHint")}</p>
                  </div>
                  <CopyButton
                    text={kit.iframe}
                    label={t("rsvpEmbedCopyCode")}
                    copiedLabel={t("rsvpCopied")}
                    primary
                    testId="website-copy-embed"
                  />
                </div>
                <pre className={CODE} data-testid="website-embed-code">{kit.iframe}</pre>
                {/* Fit it to the owner's page (booking R4): how wide it may
                    get in their column (it is always centred), the compact
                    header, and the card (R3). The code above and the preview
                    below follow every choice at once. */}
                <div className="space-y-3 pt-1" data-testid="website-embed-options">
                  {/* Label above its pills, like the option rows below (R14). */}
                  <div className="flex flex-col items-start gap-1.5">
                    <span id="website-embed-width-label" className="text-[13px] font-medium text-gray-800 dark:text-gray-200">
                      {t("rsvpWebEmbedWidth")}
                    </span>
                    <div
                      role="radiogroup"
                      aria-labelledby="website-embed-width-label"
                      data-testid="website-embed-width"
                      className="flex flex-wrap gap-1.5"
                    >
                      {EMBED_WIDTHS.map((w) => (
                        <button
                          key={w}
                          type="button"
                          role="radio"
                          aria-checked={width === w}
                          onClick={() => pickWidth(w)}
                          className={pillClass(width === w)}
                        >
                          {t(WIDTH_LABEL[w])}
                        </button>
                      ))}
                    </div>
                  </div>
                  <OptionCheck
                    checked={compact}
                    onChange={setCompact}
                    testId="website-embed-compact"
                    label={t("rsvpWebEmbedCompact")}
                    hint={t("rsvpWebEmbedCompactHint")}
                  />
                  <OptionCheck
                    checked={flat}
                    onChange={pickFlat}
                    testId="website-embed-flat"
                    label={t("rsvpWebEmbedFlat")}
                    hint={t("rsvpWebEmbedFlatHint")}
                  />
                  {/* Booking R13: match the website (on by default), with
                      the owner's two overrides under it. */}
                  <OptionCheck
                    checked={match}
                    onChange={setMatch}
                    testId="website-embed-match"
                    label={t("rsvpWebMatch")}
                    hint={t("rsvpWebMatchHint")}
                  />
                  {match && (
                    <div className="space-y-2 pl-6" data-testid="website-embed-look">
                      <ChoiceRow
                        id="website-look-mode"
                        label={t("rsvpWebColours")}
                        options={Object.keys(LOOK_MODE_LABEL)}
                        value={lookMode}
                        onPick={setLookMode}
                        word={(k) => t(LOOK_MODE_LABEL[k])}
                      />
                      <ChoiceRow
                        id="website-look-accent"
                        label={t("rsvpWebButtonColour")}
                        options={Object.keys(LOOK_ACCENT_LABEL)}
                        value={lookAccent}
                        onPick={setLookAccent}
                        word={(k) => t(LOOK_ACCENT_LABEL[k])}
                      />
                    </div>
                  )}
                </div>
                <p className={HINT}>
                  {/* The failure an owner can't see: on a plain-http site the
                      frame is blocked and shows a blank box, no error. */}
                  {t("rsvpWebNeedsHttps")}{" "}
                  <button
                    type="button"
                    onClick={() => setOption("guides")}
                    className="inline min-h-0! font-medium text-gray-800 dark:text-gray-200 underline underline-offset-2"
                  >
                    {t("rsvpWebEmbedGuideLink")}
                  </button>
                </p>
              </div>

              <div className="space-y-2 border-t border-gray-100 dark:border-gray-800 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <p className={HEAD}>
                    {device === "computer" && canFramePreview
                      ? t("rsvpWebPreviewHeadingDesktop")
                      : t("rsvpWebPreviewHeading")}
                  </p>
                  <div className="flex items-center gap-3">
                    {canFramePreview && (
                      <div
                        role="radiogroup"
                        aria-label={t("rsvpWebPreviewDevice")}
                        data-testid="website-preview-device"
                        className="flex items-center gap-1"
                      >
                        <button
                          type="button"
                          role="radio"
                          aria-checked={device === "phone"}
                          onClick={() => pickDevice("phone")}
                          className={pillClass(device === "phone")}
                        >
                          <Smartphone className="w-4 h-4" aria-hidden />
                          <span>{t("rsvpWebPreviewPhone")}</span>
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={device === "computer"}
                          onClick={() => pickDevice("computer")}
                          className={pillClass(device === "computer")}
                        >
                          <Monitor className="w-4 h-4" aria-hidden />
                          <span>{t("rsvpWebPreviewComputer")}</span>
                        </button>
                      </div>
                    )}
                    <a
                      href={publicUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 min-h-0! text-xs text-gray-500 hover:text-gray-900 dark:hover:text-gray-200"
                    >
                      <ExternalLink className="w-3.5 h-3.5" aria-hidden />
                      {t("rsvpOpenPage")}
                    </a>
                  </div>
                </div>
                {canFramePreview && match && (
                  // R13: the same booking on three stand-in websites — what
                  // the snippet reads from a light page, a dark page and a
                  // photo, sent to the real page exactly as it would be.
                  <div className="space-y-1">
                    <ChoiceRow
                      id="website-look-sample"
                      label={t("rsvpWebSample")}
                      options={LOOK_SAMPLE_IDS}
                      value={sample}
                      onPick={setSample}
                      word={(k) => t(SAMPLE_LABEL[k])}
                    />
                    <p className={HINT}>{t("rsvpWebSampleHint")}</p>
                  </div>
                )}
                {canFramePreview && device === "phone" && (
                  // A phone-width frame around the REAL booking page — the
                  // same /r/ route and ?embed=1 the snippet loads.
                  <div
                    data-testid="website-preview-phone"
                    className="mx-auto w-full max-w-[375px] rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden"
                    style={match ? sampleGround(sample) : undefined}
                  >
                    <iframe
                      key={look}
                      ref={frameRef}
                      src={kit.preview}
                      title={t("rsvpWebPreviewTitle")}
                      loading="lazy"
                      data-testid="website-preview"
                      style={{ height: previewH }}
                      className="block w-full border-0"
                    />
                  </div>
                )}
                {canFramePreview && device === "computer" && (
                  <HostPreview
                    key={look}
                    src={kit.preview}
                    width={width}
                    height={previewH}
                    frameRef={frameRef}
                    title={t("rsvpWebPreviewTitle")}
                    ground={match ? sampleGround(sample) : undefined}
                    frameRadius={match ? LOOK_FRAME_RADIUS[LOOK_SAMPLES[sample].radius] : undefined}
                    header={match ? <SampleHeader id={sample} t={t} /> : null}
                  />
                )}
              </div>
            </div>
          )}

          {option === "guides" && (
            <div className="space-y-3" data-testid="website-option-guides">
              <p className={HEAD}>{t("rsvpWebGuidePick")}</p>
              <div role="radiogroup" aria-label={t("rsvpWebGuidePick")} className="flex flex-wrap gap-1.5">
                {SITE_BUILDERS.map((b) => {
                  const on = b.id === active.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setBuilder(b.id)}
                      className={pillClass(on)}
                    >
                      {b.name}
                    </button>
                  );
                })}
              </div>
              <ol className="space-y-2" data-testid="website-guide-steps">
                {/* Four steps: open, add, paste (it carries the copy button),
                    publish — each builder names its own where the generic
                    step would mislead (utils/bookingEmbed guideStepKeys). */}
                {guideStepKeys(active).map((k) => t(k)).map((s, i) => (
                  <li key={i} className="flex gap-3 text-[13px] text-gray-700 dark:text-gray-300 leading-snug">
                    <span
                      className="shrink-0 w-5 h-5 rounded-full bg-gray-100 dark:bg-gray-800 text-[11px] font-semibold text-gray-600 dark:text-gray-300 grid place-items-center"
                      aria-hidden
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0 pt-px space-y-2">
                      <span className="block">{s}</span>
                      {/* Step 3 pastes the code: copy it right here — the
                          same snippet as "Indlejr", no tab switch. */}
                      {i === 2 && (
                        <CopyButton
                          text={kit.iframe}
                          label={t("rsvpEmbedCopyCode")}
                          copiedLabel={t("rsvpCopied")}
                          primary
                          testId="website-guide-copy-embed"
                        />
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              {/* What this builder needs said (WordPress → Elementor, Wix's box
                  that doesn't grow, Squarespace's "Script disabled", a plan
                  without code); WordPress-based hosts point to that guide. */}
              {guideNoteKeys(active).map((k) => (
                <p key={k} className={HINT} data-testid="website-guide-note">{t(k)}</p>
              ))}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 dark:border-gray-800 pt-3">
                <p className={HINT + " min-w-0 flex-1"}>{t("rsvpWebGuideButtonOnly", { builder: active.name })}</p>
                <CopyButton
                  text={publicUrl}
                  label={t("rsvpWebCopyLink")}
                  copiedLabel={t("rsvpCopied")}
                  testId="website-guide-copy-link"
                />
              </div>
            </div>
          )}

          {/* A site whose Content-Security-Policy blocks other sites' frames
              and scripts shows only the link under the frame (lamfuz.dk, 28
              Oct): say what to allow. */}
          <div className="border-t border-gray-100 dark:border-gray-800 pt-4 space-y-1" data-testid="website-csp-help">
            <p className={HEAD}>{t("rsvpWebCspTitle")}</p>
            <p className={HINT}>{t("rsvpWebCspHint", { origin: embedOriginFor(publicUrl) })}</p>
          </div>

          {/* Most owners don't edit their own site — hand the whole thing to
              whoever does, in one tap. */}
          <div className="border-t border-gray-100 dark:border-gray-800 pt-4 space-y-1.5">
            <a href={kit.mail} className={SECONDARY + " w-full sm:w-auto"} data-testid="website-mailto">
              <Mail className="w-4 h-4" aria-hidden />
              {t("rsvpWebSendDev")}
            </a>
            <p className={HINT}>{t("rsvpWebSendDevHint")}</p>
          </div>
        </>
      )}
    </section>
  );
}
