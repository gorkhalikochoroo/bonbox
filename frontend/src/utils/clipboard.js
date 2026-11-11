/**
 * copyText — put `text` on the clipboard; resolves true only when it got there.
 *
 * The async Clipboard API first. An Android WebView or an older browser may
 * not have it, or refuse it, so a hidden read-only textarea + execCommand
 * ("copy") is the fallback (read-only: no soft keyboard pops up on Android).
 * Never throws: a failed copy is a message on the row, not a crash.
 */
export async function copyText(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* refused (no permission / not focused): try the fallback */ }
  try {
    if (typeof document === "undefined") return false;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try { ok = document.execCommand("copy") === true; } finally { ta.remove(); }
    return ok;
  } catch {
    return false;
  }
}
