// Gavekort QR helpers shared by the door scanner (live camera, DoorScanPage)
// and Smart Scan (a still photo, SmartScanModal). Keeping the family detector
// in ONE place means the two entry points can never drift on what counts as a
// gavekort QR — important because a mis-detect routes into the money path.

import jsQR from "jsqr";

// A gavekort QR encodes the public URL ".../g/BB1.G.<jwt>". Pull the bare
// envelope out of whatever was read (URL, url-encoded, or raw envelope) so a
// caller can route it to redeem. Tolerant — the server re-verifies on
// scan-resolve; this is only a client-side FAMILY hint. Returns the envelope
// string, or null if it isn't a gavekort QR.
export function extractGavekortToken(qrText) {
  if (typeof qrText !== "string") return null;
  const s = qrText.trim();
  if (s.includes("/g/")) {
    const tail = s.split("/g/").pop().split("?")[0].split("#")[0];
    try {
      const dec = decodeURIComponent(tail);
      if (dec.startsWith("BB1.G.")) return dec;
    } catch {
      /* fall through */
    }
    if (tail.startsWith("BB1.G.")) return tail;
  }
  if (s.startsWith("BB1.G.")) return s;
  return null;
}

// Decode an image FILE (a photo) and, if it contains a gavekort QR, return the
// raw scanned QR TEXT (exactly what the server's /gavekort/scan-resolve expects
// as `token`). Returns null for: no QR, a non-gavekort QR, or any decode
// failure — the caller then falls through to its normal (document-OCR) path.
// Never throws.
export async function detectGavekortInImageFile(file) {
  try {
    const imageData = await fileToImageData(file);
    if (!imageData) return null;
    // BonBox gavekort QRs are dark-on-light, so only the non-inverted pass is
    // needed. jsQR DEFAULTS to "attemptBoth" — a wasted 2× decode on the common
    // no-QR (receipt/faktura) path that runs before every Smart Scan OCR — so
    // pin "dontInvert". A missed inverted QR just falls through to OCR (no
    // dead-end, money path unaffected).
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "dontInvert",
    });
    if (code && extractGavekortToken(code.data)) return code.data;
    return null;
  } catch {
    return null;
  }
}

// File → ImageData via canvas, downscaled so jsQR stays fast on a multi-MP
// phone photo while keeping a fingertip-sized QR legible (cap longest side
// ~1600px). Uses createImageBitmap with an <img> fallback for older WebViews.
async function fileToImageData(file) {
  const MAX = 1600;
  let source;
  try {
    source = await createImageBitmap(file);
  } catch {
    source = await loadViaImageEl(file);
  }
  if (!source) return null;
  const w = source.width;
  const h = source.height;
  if (!w || !h) return null;
  const scale = Math.min(1, MAX / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, cw, ch);
  if (typeof source.close === "function") source.close(); // release ImageBitmap
  return ctx.getImageData(0, 0, cw, ch);
}

function loadViaImageEl(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    let done = false;
    const settle = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(val);
    };
    // Guarantee the promise settles (and the object URL is revoked) even if the
    // <img> fires neither load nor error — otherwise the Smart Scan classify
    // pipeline could hang on the 'scanning' stage and the fall-through to OCR
    // would never run.
    const timer = setTimeout(() => settle(null), 4000);
    img.onload = () => settle(img);
    img.onerror = () => settle(null);
    img.src = url;
  });
}
