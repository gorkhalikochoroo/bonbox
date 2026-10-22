/* The three markers a landingV6 value may carry (port step 5), rendered as the prototype's markup:
 *   <nw>…</nw>  → <span className="nw">  (words that must stay on one line: "Instagram-bio", "2 som drop-in.")
 *   <b>…</b>    → <b>                     ("Opsig når som helst." in the price note)
 *   <a>…</a>    → link(children)          (the component supplies the link: "privatlivspolitikken" → /privacy)
 * One key holds one whole sentence with its markers, so a translation keeps its own line breaks and links and
 * nothing is built by joining fragments. No HTML is parsed: only these three exact tags, nothing else. */

import { Fragment } from "react";

const TAG = /<(nw|b|a)>([\s\S]*?)<\/\1>/g;

export function rich(text, link) {
  if (typeof text !== "string" || text.indexOf("<") === -1) return text;
  const out = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(TAG)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [, tag, inner] = m;
    if (tag === "nw") out.push(<span className="nw" key={n++}>{rich(inner, link)}</span>);
    else if (tag === "b") out.push(<b key={n++}>{inner}</b>);
    else out.push(link ? <Fragment key={n++}>{link(inner)}</Fragment> : inner);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
