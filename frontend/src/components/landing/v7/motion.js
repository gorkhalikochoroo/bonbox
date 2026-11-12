/* The v7 landing's motion, as the design's own script runs it, as one imperative module on the page root:
 *
 *   - the hero: once the stage is on screen the week goes from draft to published on the iPad (a tap ring on "Udgiv"),
 *     the staff phone shows it in the Vagtplan app, a toast says it is out; "Se det igen" plays it again;
 *   - depth: the stage rises in 3D once (the page renders it; over the HTML's first screen it carries on from where that
 *     screen's rise was), then follows a fine pointer gently; scrolling drives the product shots flat as they come in;
 *   - the top bar's hairline once the page has scrolled, and the phone's sticky call to action between the hero and the
 *     last call.
 * Reduced motion: the published week and the toast are shown at once, nothing moves.
 *
 * React renders every element this touches and never writes the same attribute: the classes toggled here (on, enter,
 * scrolled) are on elements whose className React does not change, and the inline transform / opacity / custom
 * properties are written only here. mountMotion returns { play, destroy }: destroy clears every timer, observer,
 * listener and inline style it wrote. */
const FX = [
  [".tilt-in", "tilt"], [".duo-l", "duoL"], [".duo-r", "duoR"], [".fan-l", "fanL"], [".fan-c", "fanC"], [".fan-r", "fanR"], [".thumb", "thumb"], [".rv", "rise"],
];
const T3 = {
  tilt: (q) => `rotateX(${(q * 30).toFixed(2)}deg) translateY(${(q * 48).toFixed(1)}px) scale(${(1 - q * 0.07).toFixed(4)})`,
  duoL: (q) => `translateY(${(q * 40).toFixed(1)}px) rotateY(${(7 + q * 19).toFixed(2)}deg) rotateZ(${(-1 - q * 2).toFixed(2)}deg)`,
  duoR: (q) => `translateY(${(q * 70).toFixed(1)}px) rotateY(${(-7 - q * 19).toFixed(2)}deg) rotateZ(${(1 + q * 2).toFixed(2)}deg)`,
  fanL: (q) => `translateX(${(q * 55).toFixed(1)}%) rotateY(${(14 + q * 26).toFixed(2)}deg) translateZ(${(-30 * (1 - q)).toFixed(1)}px) scale(${(1 - q * 0.1).toFixed(4)})`,
  fanC: (q) => `translateY(${(-8 + q * 22).toFixed(2)}%) scale(${(1 - q * 0.04).toFixed(4)})`,
  fanR: (q) => `translateX(${(-q * 55).toFixed(1)}%) rotateY(${(-14 - q * 26).toFixed(2)}deg) translateZ(${(-30 * (1 - q)).toFixed(1)}px) scale(${(1 - q * 0.1).toFixed(4)})`,
  thumb: (q) => `perspective(1200px) rotateX(${(q * 18).toFixed(2)}deg) translateY(${(q * 16).toFixed(1)}px)`,
  rise: (q) => `translateY(${(q * 22).toFixed(1)}px)`,
};
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (p) => 1 - Math.pow(1 - p, 3);
const media = (q) => { try { return !!window.matchMedia && window.matchMedia(q).matches; } catch { return false; } };
const raf = (fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(fn, 16));
const unraf = (id) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id));

export function mountMotion(root, parts) {
  const win = window;
  const reduce = media("(prefers-reduced-motion: reduce)");
  const timers = [];
  const offs = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); offs.push(() => target.removeEventListener(type, fn, opts)); };
  const el = (k) => parts.current[k] || null;
  const cls = (k, name, yes) => { const n = el(k); if (n) n.classList.toggle(name, yes); };

  /* the hero sequence */
  let seq = [];
  const reset = () => { seq.forEach(clearTimeout); seq = []; ["pub", "tap", "banner", "toast"].forEach((k) => cls(k, "on", false)); };
  const play = () => {
    reset();
    if (reduce) { cls("pub", "on", true); cls("toast", "on", true); return; }
    const at = (ms, fn) => { seq.push(setTimeout(fn, ms)); };
    at(300, () => cls("tap", "on", true));
    at(650, () => cls("pub", "on", true));
    at(1500, () => cls("banner", "on", true));
    at(2100, () => cls("toast", "on", true));
    at(4600, () => { cls("banner", "on", false); cls("tap", "on", false); });
    at(8200, () => cls("toast", "on", false));
  };
  const stage = el("stage");
  let played = false;
  let io = null;
  if (stage && "IntersectionObserver" in win) {
    io = new IntersectionObserver((en) => {
      en.forEach((e) => { if (e.isIntersecting && !played) { played = true; timers.push(setTimeout(play, 1100)); if (io) io.disconnect(); } });
    }, { threshold: 0.2 });
    io.observe(stage);
  }
  timers.push(setTimeout(() => { if (!played && stage && stage.getBoundingClientRect().top < win.innerHeight) { played = true; play(); } }, 2600));

  /* hero depth: the 3D rise (the stage's "enter" class, rendered by the page) is dropped once it has run, so the scroll
   * and the pointer drive the stage's transform from then on; then follow a fine pointer */
  if (!reduce && stage) {
    if (stage.classList.contains("enter")) on(stage, "animationend", (e) => { if (e.target === stage && e.animationName === "lp7-rise3d") stage.classList.remove("enter"); });
    const hero = root.querySelector(".hero");
    if (hero && media("(hover: hover) and (pointer: fine)")) {
      let pending = 0, px = 0, py = 0;
      on(hero, "pointermove", (e) => {
        const r = stage.getBoundingClientRect();
        px = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2)));
        py = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 2)));
        if (!pending) pending = raf(() => { pending = 0; stage.style.setProperty("--ry", `${(px * 5).toFixed(2)}deg`); stage.style.setProperty("--rx", `${(-py * 4).toFixed(2)}deg`); });
      });
      on(hero, "pointerleave", () => { stage.style.setProperty("--ry", "0deg"); stage.style.setProperty("--rx", "0deg"); });
      offs.push(() => unraf(pending));
    }
  }

  /* depth on every screen size: scroll drives the 3D */
  const fx = [];
  if (!reduce) FX.forEach(([sel, k]) => root.querySelectorAll(sel).forEach((n) => fx.push([n, k])));
  let ticking = false;
  let frameId = 0;
  const frame = () => {
    ticking = false;
    const vh = win.innerHeight;
    for (let i = 0; i < fx.length; i++) {
      const [n, k] = fx[i];
      const r = n.getBoundingClientRect();
      if (r.bottom < -200 || r.top > vh + 200) continue;
      const end = k === "rise" ? 0.82 : 0.45;
      const p = ease(clamp01((vh - r.top) / (vh * (1 - end))));
      n.style.transform = T3[k](1 - p);
      if (k === "rise") n.style.opacity = (0.7 + 0.3 * p).toFixed(3);
    }
    if (stage) {
      const y = Math.min(win.scrollY, 700);
      stage.style.setProperty("--srx", `${(y / 700 * 9).toFixed(2)}deg`);
      stage.style.setProperty("--py", `${(-y * 0.07).toFixed(1)}px`);
    }
  };
  const req = () => { if (!ticking) { ticking = true; frameId = raf(frame); } };
  if (!reduce) { on(win, "scroll", req, { passive: true }); on(win, "resize", req); frame(); }

  /* the top bar's hairline and the phone's sticky call to action */
  const bar = el("bar"), mbar = el("mbar"), end = el("end");
  const chrome = () => {
    if (bar) bar.classList.toggle("scrolled", win.scrollY > 8);
    if (mbar) mbar.classList.toggle("on", win.scrollY > 520 && (!end || end.getBoundingClientRect().top > win.innerHeight * 0.6));
  };
  on(win, "scroll", chrome, { passive: true });
  chrome();

  return {
    play,
    destroy() {
      reset();
      timers.forEach(clearTimeout);
      if (io) io.disconnect();
      unraf(frameId);
      offs.forEach((off) => off());
      if (stage) ["--rx", "--ry", "--srx", "--py"].forEach((p) => stage.style.removeProperty(p));
      fx.forEach(([n]) => { n.style.removeProperty("transform"); n.style.removeProperty("opacity"); });
      if (bar) bar.classList.remove("scrolled");
      if (mbar) mbar.classList.remove("on");
    },
  };
}
