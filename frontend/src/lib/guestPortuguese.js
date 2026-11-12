// The guest booking page's Portuguese (reservations v2, 12 Nov 2026).
//
// European Portuguese (pt-PT) for every word the public booking page shows,
// registered as page words (lib/pageDict.js) the first time a guest picks PT
// — or the venue's own language is Portuguese. Its own chunk
// (virtual:bonbox-guest-words-pt, vite.config.js), so a Danish or English
// guest downloads none of it. Resolves true once the words are in, false
// when the chunk could not load (the page then stays in its language).
import { hasPageDict, registerPageDict } from "./pageDict";

let pending = null;

export function loadGuestPortuguese() {
  if (hasPageDict("pt")) return Promise.resolve(true);
  if (!pending) {
    pending = import("virtual:bonbox-guest-words-pt")
      .then((m) => {
        registerPageDict(m.default);
        return true;
      })
      .catch(() => {
        pending = null;
        return false;
      });
  }
  return pending;
}
