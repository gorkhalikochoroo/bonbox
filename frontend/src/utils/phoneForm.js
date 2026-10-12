/**
 * Phone-keyboard helpers for the sign-up forms (/register, /login,
 * /forgot-password) — mobile walk, 12 Oct 2026.
 *
 * enterToNext(next)
 *   The keyboard's "next" key. Each field but the last carries
 *   enterKeyHint="next"; Enter there moves to the next field instead of
 *   submitting the form. Before, Return in the e-mail field on /register sent
 *   the form at once: the focus jumped to the password and "Skriv navnet på
 *   dit sted" turned red under a field the owner had not reached yet. The last
 *   field keeps the form's own submit and says "go".
 *   `next` is a ref ({ current }) or a function returning the element. Enter
 *   that confirms an IME composition (keyCode 229, isComposing) and Enter with
 *   a modifier are left alone.
 *
 * dismissKeyboard()
 *   Called once a submit is valid and on its way: the focused field lets go,
 *   so a phone closes its keyboard and the button's spinner (and the "slow
 *   connection" line under it) can be seen. Pressing "go" on the last field
 *   left the keyboard up over the busy button, and nothing seemed to happen.
 */

export function enterToNext(next) {
  return (e) => {
    if (!e || e.key !== "Enter") return;
    const native = e.nativeEvent || e;
    if (native.isComposing || e.keyCode === 229) return;
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    const el = typeof next === "function" ? next() : next && next.current;
    if (!el || typeof el.focus !== "function") return;
    e.preventDefault();
    el.focus();
  };
}

export function dismissKeyboard(doc = typeof document !== "undefined" ? document : null) {
  const el = doc && doc.activeElement;
  if (!el || typeof el.blur !== "function") return false;
  if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return false;
  el.blur();
  return true;
}
