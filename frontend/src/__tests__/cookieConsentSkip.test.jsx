/**
 * The cookie banner's re-measure skips a page's own per-frame churn (landing v6, port step 7; PORT_PLAN 1.5).
 *
 * While the banner is open it watches the whole body for class / style / hidden changes, so it can sit on any bar
 * marked data-bb-consent-clear. The v6 landing's scroll engine writes classes and styles on every scroll frame; on a
 * first visit (banner open) each frame would have cost the banner a forced layout. The landing's root carries
 * data-bb-consent-skip: changes inside it are ignored, unless they land on a marked bar (the landing's bottom bar
 * showing, hiding or lifting). Changes outside it, and the page itself mounting or leaving, count as before.
 */
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import CookieConsent from "../components/CookieConsent";
import { consentChangeMatters } from "../lib/consentClear";
import { LanguageProvider } from "../hooks/useLanguage";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.removeItem("bonbox_cookie_consent");
  localStorage.removeItem("lang");
  document.body.querySelectorAll("[data-test-page]").forEach((n) => n.remove());
});

function page() {
  const root = document.createElement("div");
  root.setAttribute("data-test-page", "");
  root.innerHTML =
    '<div class="lp6" data-bb-consent-skip="">' +
    '<div id="clock"><b>1</b></div>' +
    '<div class="dock" id="bar" data-bb-consent-clear=""><button id="dprev" class="off">←</button></div>' +
    "</div>" +
    '<div id="outside"></div>';
  document.body.appendChild(root);
  return {
    skip: root.querySelector("[data-bb-consent-skip]"),
    clock: root.querySelector("#clock"),
    bar: root.querySelector("#bar"),
    inBar: root.querySelector("#dprev"),
    outside: root.querySelector("#outside"),
  };
}

const rec = (target, type = "attributes") => ({ type, target });

describe("consentChangeMatters (pure)", () => {
  it("ignores changes inside a skip subtree, the marked root itself included", () => {
    const p = page();
    expect(consentChangeMatters(rec(p.clock))).toBe(false);
    expect(consentChangeMatters(rec(p.clock, "childList"))).toBe(false);
    expect(consentChangeMatters(rec(p.skip))).toBe(false); // the engine's per-frame --e / --trk writes
    expect(consentChangeMatters(rec(p.inBar))).toBe(false); // inside the bar, not the bar
  });

  it("counts a change on a marked bar inside it, and every change outside it", () => {
    const p = page();
    expect(consentChangeMatters(rec(p.bar))).toBe(true);
    expect(consentChangeMatters(rec(p.outside))).toBe(true);
    expect(consentChangeMatters(rec(document.body, "childList"))).toBe(true); // the page mounting / leaving
    expect(consentChangeMatters(rec(p.skip.parentNode, "childList"))).toBe(true);
  });

  it("fails open: an odd record still counts", () => {
    expect(consentChangeMatters(null)).toBe(true);
    expect(consentChangeMatters({})).toBe(true);
    expect(consentChangeMatters(rec(document.createTextNode("x")))).toBe(true);
  });
});

describe("the open banner re-measures on the bar, not on the page's churn", () => {
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 60)); });

  it("style and class writes inside the landing cost no measure; the bar showing does", async () => {
    const p = page();
    const measured = vi.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }));
    p.bar.getBoundingClientRect = measured;
    localStorage.setItem("lang", "da");
    vi.useFakeTimers();
    render(
      <LanguageProvider>
        <MemoryRouter initialEntries={["/"]}>
          <CookieConsent />
        </MemoryRouter>
      </LanguageProvider>,
    );
    await act(async () => { vi.advanceTimersByTime(700); });
    vi.useRealTimers();
    expect(document.querySelector('[data-cookie-consent="banner"]')).not.toBeNull();
    await settle();
    const base = measured.mock.calls.length;
    expect(base).toBeGreaterThan(0); // it measured when it opened

    // the engine's frames: root variables, clock text and classes, a class inside the bar
    for (let i = 0; i < 20; i += 1) {
      p.skip.style.setProperty("--e", `${i}px`);
      p.skip.classList.toggle("xing");
      p.clock.className = `f${i}`;
      p.clock.firstChild.textContent = String(i);
      p.inBar.classList.toggle("off");
    }
    await settle();
    expect(measured.mock.calls.length).toBe(base);

    // the bar itself showing: measured again
    p.bar.classList.add("on");
    await settle();
    expect(measured.mock.calls.length).toBeGreaterThan(base);

    // a change outside the page: measured again, as before
    const before = measured.mock.calls.length;
    p.outside.className = "moved";
    await settle();
    expect(measured.mock.calls.length).toBeGreaterThan(before);
  });
});
