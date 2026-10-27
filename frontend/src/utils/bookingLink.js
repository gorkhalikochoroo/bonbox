// The booking link, as the owner sees it and as the guest page follows it
// (R9, 27 Oct 2026).
//
//  • The link box showed "/r/" in front of the name, but the link handed out
//    (the kit, the QR, the e-mails) is www.bonbox.dk/<name>. The box now
//    shows the real address, and a live "new link" line while typing.
//  • A changed link keeps the old one working (the server keeps it as an
//    old link). Opened on an old link, the guest page is told the current
//    one and moves its address bar there, keeping the query and the hash.

// The server's slugify (backend app/utils/text.py) for the "new link" line:
// lowercase, æ/ø/å → ae/oe/aa, accents dropped, anything else outside a–z
// and 0–9 → one dash, no dash at the ends, at most 60 characters (set_slug).
export const SLUG_MAX = 60;

export function slugPreview(text) {
  if (typeof text !== "string" || !text) return "";
  let s = text.toLowerCase();
  s = s.replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa");
  // NFKD splits é into e + a combining accent; the server then drops every
  // non-ASCII character (encode("ascii", "ignore")), so do the same.
  s = s.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, SLUG_MAX).replace(/^-+|-+$/g, "");
}

// "https://www.bonbox.dk/bistro" → "www.bonbox.dk/bistro" — what an owner
// reads and types. Anything that is not a URL is returned as it came.
export function linkDisplay(url) {
  if (typeof url !== "string") return "";
  return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

// The part of the address before the slug: "www.bonbox.dk/" (or
// "www.bonbox.dk/r/" for a legacy slug that keeps the /r/ form). Falls back
// to the public host when the page has no link yet.
export function linkPrefix(publicUrl, slug) {
  const shown = linkDisplay(publicUrl);
  if (shown && slug && shown.endsWith("/" + slug)) return shown.slice(0, shown.length - slug.length);
  return "www.bonbox.dk/";
}

// The address a new slug gets: always the root form — the server refuses
// a reserved word as a new link, so a new link never needs /r/.
export function newLinkDisplay(publicUrl, slug, draftSlug) {
  const full = linkPrefix(publicUrl, slug);
  const prefix = full.endsWith("/r/") ? full.slice(0, -2) : full;
  return draftSlug ? `${prefix}${draftSlug}` : "";
}

// The path the guest page moves to when it was opened on an old link: the
// last segment becomes the current slug; /r/ stays /r/ (the embed needs it).
export function canonicalPath(pathname, canonicalSlug) {
  if (typeof pathname !== "string" || !canonicalSlug) return null;
  const m = /^(\/r)?\/([^/]+)\/?$/.exec(pathname);
  if (!m || m[2] === canonicalSlug) return null;
  return `${m[1] || ""}/${canonicalSlug}`;
}

// Short day for "since" on an old link ("27. okt." / "27 Oct").
export function sinceLabel(iso, lang) {
  if (!iso) return "";
  try {
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleDateString(lang === "en" ? "en-GB" : "da-DK", { day: "numeric", month: "short" });
  } catch {
    return iso;
  }
}
