// Is this page inside someone else's frame (an owner's website iframe)? The
// embed snippet always adds ?embed=1, but /r/<slug> is frameable without it
// (utils/bookingEmbed.js), so the booking page asks this too before it
// spreads into two columns. A cross-origin parent throws on `top` access:
// that is a frame as well.
export function isFramed(win = typeof window !== "undefined" ? window : undefined) {
  if (!win) return false;
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}
