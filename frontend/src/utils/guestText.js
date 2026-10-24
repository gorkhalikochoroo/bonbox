// What a GUEST typed into a booking (name, notes, allergy note, occasion),
// as the owner's screens show it — the book, the drawer, the host stand, the
// live alerts (R1a fix round, 24 Oct 2026).
//
// The text is STORED EXACTLY AS TYPED: the kitchen and the AI allergy reading
// read the guest's own words (R1 replaced anything link-like with "[link]"
// when the booking was saved, and "Glutenfri.Laktosefri.Nøddeallergi" lost
// the allergy). A link in it is made harmless only where it is SHOWN: every
// link-like token keeps its words with the dots defanged ("example[.]com",
// "hxxps://…"), so nobody taps it or copies it into a browser by habit.
//
// DISPLAY ONLY. The edit form, the search and every save use the raw value —
// never pass a defanged string back to the server.
//
// The same rules as the e-mails (backend app/utils/text.py defang_links);
// backend/tests/test_r1a_fix_guest_text.py keeps the two ending lists equal.
// No look-behind anywhere: iOS Safari before 16.4 cannot parse it, and one
// such regex would break the whole page there.

// Domain endings a mail client or a phone turns into a link. A dotted run of
// words needs one of these at its end (or a path after it), so
// "Glutenfri.Laktosefri.Nøddeallergi" and "Anne.Marie.Jensen" show as typed.
export const DISPLAY_TLDS =
  "com|net|org|dk|io|ru|xyz|info|biz|top|click|link|shop|online|site|live|app|ly" +
  "|eu|de|co|me|se|no|uk|cc|to|us|nl|fr|it|es|pl|ch|at|be|fi|is|ie|pt|cz|lt|lv|ee" +
  "|gl|fo|tk|ml|ga|cf|gq|pw|ws|su|cn|in|br|ua|tv|gg|ai|sh|im|la|vip|win|bid|loan" +
  "|work|club|store|tech|space|website|fun|icu|cyou|buzz|rest|bar|today|news|email" +
  "|support|help|page|pro|cloud|digital|network|services|life|world|zone|mobi|name" +
  "|dev|ca|gov|edu|np" +
  "|zip|mov|nu|casa|lol|sbs|fyi|st|ac|gle|ink|lat|mom|quest|cam|bond|cfd" +
  "|hair|beauty|skin|makeup|boats|autos|homes|motorcycles|yachts|rocks|monster" +
  "|wtf|host|press|global|party|review|trade|stream|download|racing|faith" +
  "|science|accountant|cricket|webcam|xin|ren|wang|nz|au|jp|kr|tr|gr|hu|ro" +
  "|bg|rs|mk|md|kz|il|ae|ir|pk|bd|ph|th|vn|sg|hk|mx|cl|ve|za|ng|ke|eg|tn";

const ENDINGS = new Set(DISPLAY_TLDS.split("|"));

// Look-alike dots folded to "." before matching ("evil[.]com", "evil。com").
const DOT_LOOKALIKES = /\s*(?:\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\))\s*|[。．․｡]/giu;
// A scheme or "www." link, whatever it carries. Group 1 is the character
// before it (in place of a look-behind).
const SCHEME_RE = /(^|[^\p{L}\p{N}_-])((?:https?:\/\/|www\.)\S+)/giu;
// A STRICT e-mail address — kept as it is (anna@cafe.dk).
const EMAIL_RE =
  /(^|[^\p{L}\p{N}_/:@.+-])([\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+)(?![\p{L}\p{N}_/@])/gu;
// A dotted token and what follows it (a port or a path). Linear: the dots
// separate the parts, so nothing backtracks over a long note.
const HOST_RE = /(^|[^\p{L}\p{N}_.-])([\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+)((?:[:/]\S*)?)/gu;
const LETTERS = /^\p{L}+$/u;
const DIGITS = /^\d{1,3}$/;

function isEnding(label) {
  const low = label.toLowerCase();
  return ENDINGS.has(low) || (low.startsWith("xn--") && low.length > 4);
}

// How many leading labels of a dotted token make a link (0: none) — the
// backend's _link_labels, rule for rule.
function linkLabels(labels, suffix) {
  if (suffix && labels.length === 4 && labels.every((x) => DIGITS.test(x))) return 4;
  const last = labels[labels.length - 1];
  if (suffix.startsWith("/") && LETTERS.test(last) && last.length >= 2 && last.length <= 24) {
    return labels.length;
  }
  for (let i = labels.length - 1; i > 0; i -= 1) {
    if (isEnding(labels[i])) return i + 1;
  }
  return 0;
}

function defangToken(token) {
  return token
    .replace(/^h(tt)(ps?)(?=:)/i, (m, _tt, ps) => m[0] + "xx" + ps)
    .replace(/\./g, "[.]");
}

/** A guest's text as the owner's screens show it: link-like tokens kept as
 *  plain text with the dots defanged. Text with no link (and anything that
 *  is not a string) comes back exactly as given. */
export function defangLinks(text) {
  if (typeof text !== "string" || !text) return text;
  let n = 0;
  const norm = text.normalize("NFKC").replace(DOT_LOOKALIKES, ".");
  let out = norm.replace(SCHEME_RE, (_m, pre, tok) => {
    n += 1;
    return pre + defangToken(tok);
  });
  const kept = [];
  out = out.replace(EMAIL_RE, (_m, pre, addr) => {
    kept.push(addr);
    return `${pre}\u0000${kept.length - 1}\u0000`;
  });
  out = out.replace(HOST_RE, (m, pre, host, suffix = "") => {
    const labels = host.split(".");
    const k = linkLabels(labels, suffix || "");
    if (!k) return m;
    n += 1;
    const rest = labels.slice(k).map((x) => "." + x).join("");
    return pre + labels.slice(0, k).join("[.]") + rest + (suffix || "");
  });
  if (!n) return text;
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => kept[Number(i)]);
}

/** The short name the screens use: guestText(r.guest_name). */
export const guestText = defangLinks;
