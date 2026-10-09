/**
 * Round 18 — the review of round 18's own fixes, each reproduced on the page.
 *
 *  1. A sales sync over a total-only bon, then one box typed: the day keeps
 *     the synced lines (it saved the one typed box's till alone, "Rettet ned").
 *  2. Fortsæt kladden after a date move does not re-save the other day's
 *     draft with this day's Gavekort.
 *  3. An older day's save answering after the new day's: the form's own new
 *     draft is still its own, and later edits are saved.
 *  4. "Brug det ikke" on the only photo: back where the photo was taken, the
 *     owner's own figures in the boxes and on the record — never a blank page.
 *  5. Fortryd on the card: what the card holds is not filed until it is
 *     applied, and the card says so.
 *  6. Figures typed with øre on the card stay what was typed while typing.
 *  7. After "brug det ikke" on a summed card: one Undo, the drop's.
 *  8. Form ↔ card with nothing changed: no second POST of the same draft.
 *  9. "Ikke fordelt" below the category boxes follows a category typed on
 *     the card; it holds only for a box below it.
 * Strings are asserted by key (t echoes key + values).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { businessTodayIso } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";

const get = vi.fn();
const post = vi.fn();
let branchType = "restaurant";
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency: "DKK", business_type: "restaurant" }, refreshUser: vi.fn() }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fallbackOrVars, maybeVars) => {
      const vars = typeof fallbackOrVars === "object" ? fallbackOrVars : maybeVars;
      return vars ? `${k}:${Object.values(vars).join("|")}` : k;
    },
    lang: "da",
    setLang: () => {},
    LANGUAGES: [],
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true }),
}));
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType, hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const { createServer, installApi } = await import("../test/closeSequenceHarness");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const shiftIso = (iso, days) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
const yesterday = shiftIso(today, -1);
const bon = (o) => ({ raw_text: "BON", ocr_available: true, payments: {}, revenue: {}, ...o });
const BON_3000 = bon({ revenue: { food: 2000, drinks: 1000 }, revenue_total: 3000, moms_total: 600, payments: { card: 3000 } });
const BON_4000 = bon({ revenue_total: 4000, moms_total: 800, payments: { card: 4000 } });
const T2500 = bon({ revenue_total: 2500, moms_total: 500 });
const TILL1 = bon({
  revenue: { food: 9000, drinks: 6000, takeaway: 2030 }, revenue_total: 17030, moms_total: 3406,
  payments: { card: 12000, cash: 4030, mobilepay: 1000 },
});
const PAGE = bon({ revenue: { takeaway: 450 }, payments: { mobilepay: 450 } });

let S;
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.confirm = vi.fn(() => true);
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  branchType = "restaurant";
  S = createServer({ syncedDates: [yesterday] });
  installApi(S, get, post);
});

const renderPage = () => render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
const draftPosts = () => S.posts.filter((b) => b.status === "draft");
const question = () => screen.queryByTestId("dc-terminal-question");
const cardInput = (container) => [...container.querySelectorAll('input[type="file"]')].at(-1);
const shoot = async (container, scan, name) => {
  S.nextScan = scan;
  fireEvent.change(cardInput(container), { target: { files: [new File([name], name, { type: "image/jpeg", lastModified: 1 })] } });
  await waitFor(() => expect(screen.queryByText("readingZReport")).toBeNull());
};
/** Selecting the box's text and typing over it, the way the harness does it. */
const keyIn = (el, value) => {
  fireEvent.change(el, { target: { value: "" } });
  for (let i = 1; i <= value.length; i++) fireEvent.change(el, { target: { value: value.slice(0, i) } });
};
/** A browser: each key goes onto what the box shows NOW. */
const typeOn = (el, chars) => { for (const ch of chars) fireEvent.change(el, { target: { value: el.value + ch } }); };
const tap = (re) => {
  const b = [...document.querySelectorAll("button")].find((x) => re.test(x.textContent.trim()));
  if (!b) throw new Error(`no button ${re}`);
  fireEvent.click(b);
};
const buttonsMatching = (re) => [...document.querySelectorAll("button")].filter((x) => re.test(x.textContent.trim()));
const toStep = async (container, selector) => {
  for (let i = 0; i < 8 && !container.querySelector(selector); i++) tap(/^next\s*→$/);
  await waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
};
const backToStepOne = async (container) => {
  for (let i = 0; i < 8 && !container.querySelector("#dc-rev-food"); i++) tap(/^←\s*back$/);
  await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
};
/** Leaving the page sends a save that is waiting (pagehide), and only then. */
const leave = () => act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
const settle = (ms = 0) => act(() => new Promise((r) => setTimeout(r, ms)));
const typedClose = async (rev, pay) => {
  const view = renderPage();
  fireEvent.click(await screen.findByText("skipEnterManually"));
  await waitFor(() => expect(view.container.querySelector("#dc-rev-food")).not.toBeNull());
  Object.entries(rev).forEach(([k, v]) => keyIn(view.container.querySelector(`#dc-rev-${k}`), v));
  await toStep(view.container, "#dc-pay-card");
  Object.entries(pay).forEach(([k, v]) => keyIn(view.container.querySelector(`#dc-pay-${k}`), v));
  await backToStepOne(view.container);
  return view;
};
const toScanCard = async () => {
  fireEvent.click(screen.getByText("← scanZReportBack"));
  await waitFor(() => expect(screen.getByText(/scanZReportTitle|startOver/)).toBeInTheDocument());
};
const money = (el) => {
  const s = (el?.textContent || "").replace(/\s/g, "");
  if (!/\d/.test(s)) return null;
  const n = Number(s.replace(/[^\d,]/g, "").replace(",", "."));
  return /^[−-]/.test(s) ? -n : n;
};
const review = async (container) => {
  await toStep(container, "#dc-notes");
  return { total: money(screen.getByTestId("dc-review-total")), moms: money(screen.getByTestId("dc-review-moms")) };
};
const stored = (date = today) => S.rows.get(`${date}|`);

describe("1. a sales sync over a total-only bon, then one box typed", () => {
  it("Mad 3.000 → 3.500: the day is 5.500 (both synced lines), never the typed till's 3.500 \"rettet ned\"", async () => {
    const { container } = renderPage();
    await screen.findByText("skipEnterManually");
    await shoot(container, T2500, "t.jpg");
    tap(/^continueStepByStep$/);
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(container.querySelector("#close-date"), { target: { value: yesterday } });
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("3.000"));
    expect(container.querySelector("#dc-rev-drinks").value).toBe("2.000");
    keyIn(container.querySelector("#dc-rev-food"), "3.500");
    await leave();
    const row = stored(yesterday);
    const lines = Object.values(row.revenue_breakdown).reduce((a, v) => a + v, 0);
    expect(lines).toBe(5500);
    expect(row.revenue_total).toBeGreaterThanOrEqual(lines);
    const R = await review(container);
    expect(R.total).toBe(row.revenue_total);
    expect(R.moms).toBe(row.moms_total);
    expect(row.moms_total).toBe(1100);
    expect(container.textContent).not.toContain("dcCorrectedDown");
  });
});

describe("2. Fortsæt kladden after a date move", () => {
  it("a salon's Gavekort typed for today is not filed on yesterday's draft by opening it", async () => {
    branchType = "salon";
    S.rows.set(`${yesterday}|`, {
      id: "y1", date: yesterday, branch_id: null, status: "draft", revenue_total: 800,
      revenue_breakdown: { treatments: 800 }, payment_breakdown: { card: 800 }, moms_total: 160, moms_mode: "auto",
      notes: "Gammel", closed_by: "Test", source_meta: { kind: "typed" }, is_deleted: false,
    });
    const view = renderPage();
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(view.container.querySelector("#dc-rev-treatments")).not.toBeNull());
    keyIn(view.container.querySelector("#dc-rev-treatments"), "1.000");
    await toStep(view.container, "#dc-notes");
    const gk = [...view.container.querySelectorAll('input[inputmode="decimal"]')]
      .find((el) => el.closest("div")?.parentElement?.textContent.includes("closeGavekortSoldLabel"));
    keyIn(gk, "500");
    await leave();
    expect(stored(today).notes).toContain("Gavekort solgt");
    await backToStepOne(view.container).catch(() => {});
    // Round 23 (path changed): figures are never moved onto a day that holds
    // another draft — the question says so, and its "Fortsæt kladden" is the
    // one tap that continues it (round 23 review: restored — it was a detour
    // through History).
    const asked = [];
    const was = window.confirm;
    window.confirm = (m) => { asked.push(m); return true; };
    fireEvent.change(view.container.querySelector("#close-date"), { target: { value: yesterday } });
    await waitFor(() => expect(asked.length).toBe(1));
    window.confirm = was;
    expect(asked[0]).toMatch(/^dcMoveTargetDraftBody/);
    await waitFor(() => expect(view.container.querySelector("#dc-rev-treatments")?.value).toBe("800"));
    const before = S.posts.length;
    await settle(2300);
    await leave();
    expect(S.posts.slice(before).filter((b) => b.date === yesterday)).toEqual([]);
    expect(stored(yesterday).notes).toBe("Gammel");
  });
});

describe("3. an older day's save answering last", () => {
  it("yesterday's own new draft stays the form's own: Drikke typed after is saved", async () => {
    // Today's save answers slowly; yesterday's at once.
    const plain = post.getMockImplementation();
    post.mockImplementation((url, body) => {
      if (url === "/daily-close" && body?.date === today) return new Promise((r) => setTimeout(() => r(plain(url, body)), 500));
      return plain(url, body);
    });
    S.syncedDates = new Set();
    const { container } = renderPage();
    await screen.findByText("skipEnterManually");
    await shoot(container, TILL1, "z.jpg");
    tap(/^continueStepByStep$/);
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    keyIn(container.querySelector("#dc-rev-food"), "9.500");
    await leave(); // today's save goes, and answers in 500 ms
    fireEvent.change(container.querySelector("#close-date"), { target: { value: yesterday } });
    await settle(0);
    await leave(); // yesterday's save goes and answers first
    await settle(700);
    await waitFor(() => expect(stored(today)).toBeTruthy());
    expect(stored(yesterday)).toBeTruthy();
    expect(container.textContent).not.toContain("dcDayHasDraft");
    keyIn(container.querySelector("#dc-rev-drinks"), "1.200");
    await leave();
    expect(stored(yesterday).revenue_breakdown.drinks).toBe(1200);
  });
});

describe("4. \"brug det ikke\" on the only photo", () => {
  it("over a typed close: back where the photo was taken, the owner's figures kept, the drop undoable", async () => {
    const { container } = await typedClose({ food: "9.000" }, { card: "9.000" });
    await leave();
    await toScanCard();
    await shoot(container, BON_3000, "b.jpg");
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^dcScanSamePhotoDiscard$/);
    // Never a blank page: the idle card (photo / skip) is there, and the drop is said.
    expect(screen.getByText("skipEnterManually")).toBeInTheDocument();
    expect(screen.getByTestId("dc-scan-dropped")).toBeInTheDocument();
    expect(buttonsMatching(/^scanMergedUndo$/)).toHaveLength(1);
    tap(/^scanMergedUndo$/);
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^dcScanSamePhotoDiscard$/);
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("9.000"));
    await leave();
    expect(stored().revenue_total).toBe(9000);
  });

  it("after a sum was applied and saved (12.000), Fortryd then \"brug det ikke\": the boxes and the draft are the typed 9.000 again", async () => {
    const { container } = await typedClose({ food: "9.000" }, { card: "9.000" });
    await toScanCard();
    await shoot(container, BON_3000, "b.jpg");
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^scanSecondTotalSum/);
    tap(/^continueStepByStep$/);
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    await leave();
    expect(stored().revenue_total).toBe(12000);
    await toScanCard();
    tap(/^scanMergedUndo$/);
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^dcScanSamePhotoDiscard$/);
    expect(screen.getByText("skipEnterManually")).toBeInTheDocument();
    await settle(2300);
    await leave();
    expect(stored().revenue_total).toBe(9000);
    expect(stored().revenue_breakdown).toEqual({ food: 9000 });
    expect(stored().payment_breakdown).toEqual({ card: 9000 });
  });

  it("\"same terminal\" applied (3.000 saved), then Fortryd and \"brug det ikke\": the typed 9.000 is filed again", async () => {
    const { container } = await typedClose({ food: "9.000" }, { card: "9.000" });
    await toScanCard();
    await shoot(container, BON_3000, "b.jpg");
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^scanSecondTotalReplace/);
    tap(/^continueStepByStep$/);
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    await leave();
    expect(stored().revenue_total).toBe(3000);
    await toScanCard();
    tap(/^scanMergedUndo$/);
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^dcScanSamePhotoDiscard$/);
    await settle(2300);
    await leave();
    expect(stored().revenue_total).toBe(9000);
  });
});

describe("5. Fortryd on the card is not filed until applied — and the card says so", () => {
  it("typed 17.412,50 + a 4.000 bon summed and saved; Fortryd: the card says it is not saved yet", async () => {
    const { container } = await typedClose({ food: "17.412,50" }, { card: "14.000" });
    await toScanCard();
    expect(screen.queryByTestId("dc-scan-unsaved")).toBeNull();
    await shoot(container, BON_4000, "b.jpg");
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^scanSecondTotalSum/);
    tap(/^useTheseValuesJumpReview$/);
    await waitFor(() => expect(container.querySelector("#dc-notes")).not.toBeNull());
    await leave();
    expect(stored().revenue_total).toBe(21412.5);
    await backToStepOne(container);
    await toScanCard();
    // The card shows what is saved: nothing to say.
    expect(screen.queryByTestId("dc-scan-unsaved")).toBeNull();
    tap(/^scanMergedUndo$/);
    await waitFor(() => expect(question()).not.toBeNull());
    expect(screen.getByTestId("dc-scan-unsaved")).toBeInTheDocument();
  });

  it("a page taken back with Fortryd (no question open): said too, and applying files it", async () => {
    const { container } = renderPage();
    await screen.findByText("skipEnterManually");
    await shoot(container, TILL1, "z.jpg");
    await shoot(container, BON_3000, "b.jpg");
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^scanSecondTotalSum/);
    await shoot(container, PAGE, "p.jpg");
    expect(question()).toBeNull();
    tap(/^continueStepByStep$/);
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    await leave();
    expect(stored().payment_breakdown.mobilepay).toBe(1450);
    await toScanCard();
    expect(screen.queryByTestId("dc-scan-unsaved")).toBeNull();
    tap(/^scanMergedUndo$/);
    expect(question()).toBeNull();
    expect(screen.getByTestId("dc-scan-unsaved")).toBeInTheDocument();
    tap(/^continueStepByStep$/);
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    await leave();
    expect(stored().payment_breakdown.mobilepay).toBe(1000);
  });
});

describe("6. the card's boxes keep what is typed while it is typed", () => {
  it("the total typed \"17030,00\" on a one-till card is readable as typed", async () => {
    const { container } = renderPage();
    await screen.findByText("skipEnterManually");
    await shoot(container, TILL1, "z.jpg");
    const el = container.querySelector("#scan-total");
    fireEvent.change(el, { target: { value: "" } });
    typeOn(el, "17030,00");
    expect(el.value).toBe("17030,00");
    expect(el.getAttribute("aria-invalid")).toBeNull();
    fireEvent.change(el, { target: { value: "" } });
    typeOn(el, "17030,05");
    expect(el.value).toBe("17030,05");
    expect(el.getAttribute("aria-invalid")).toBeNull();
  });

  it("a category typed \"9000,00\" and the summed card's total \"20030,00\"", async () => {
    const { container } = renderPage();
    await screen.findByText("skipEnterManually");
    await shoot(container, TILL1, "z.jpg");
    const food = container.querySelector("#scan-rev-food");
    fireEvent.change(food, { target: { value: "" } });
    typeOn(food, "9000,00");
    expect(food.value).toBe("9000,00");
    expect(food.getAttribute("aria-invalid")).toBeNull();
    await shoot(container, BON_3000, "b.jpg");
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^scanSecondTotalSum/);
    const total = container.querySelector("#scan-total");
    fireEvent.change(total, { target: { value: "" } });
    typeOn(total, "20030,00");
    expect(total.value).toBe("20030,00");
    expect(total.getAttribute("aria-invalid")).toBeNull();
    // Leaving the box shows the figure the day saves, formatted.
    fireEvent.blur(total);
    expect(total.value).toBe("20.030");
  });
});

describe("7. after \"brug det ikke\" on a summed card", () => {
  it("exactly one Undo — the drop's — and it brings the question back", async () => {
    const { container } = renderPage();
    await screen.findByText("skipEnterManually");
    await shoot(container, TILL1, "z.jpg");
    await shoot(container, BON_3000, "b.jpg");
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^scanSecondTotalSum/);
    await shoot(container, BON_3000, "b2.jpg");
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^dcScanSamePhotoDiscard$/);
    expect(buttonsMatching(/^scanMergedUndo$/)).toHaveLength(1);
    tap(/^scanMergedUndo$/);
    await waitFor(() => expect(question()).not.toBeNull());
    expect(container.querySelector("#scan-total").value).toBe("20.030");
  });
});

describe("8. form ↔ card with nothing changed", () => {
  it("a typed close saved once: ← Scan Z-bon and Spring over back post nothing more", async () => {
    await typedClose({ food: "12.000" }, { card: "12.000" });
    await settle(2300);
    await leave();
    const n = draftPosts().length;
    expect(n).toBe(1);
    await toScanCard();
    await settle(2300);
    await leave();
    tap(/^skipEnterManually$/);
    await settle(2300);
    await leave();
    expect(draftPosts()).toHaveLength(n);
  }, 15000);
});

describe("9. the card's \"Ikke fordelt\" line while a box has focus", () => {
  const unsplitText = (container) => [...container.querySelectorAll("span")]
    .find((el) => el.textContent === "dcUnsplitRevenue")?.parentElement?.textContent || "";

  it("typing a category (above it) moves it with each key; typing the total (below it) holds it until the box is left", async () => {
    const { container } = renderPage();
    await screen.findByText("skipEnterManually");
    await shoot(container, T2500, "t.jpg");
    expect(unsplitText(container)).toContain("2.500");
    const food = container.querySelector("#scan-rev-food");
    fireEvent.focus(food);
    typeOn(food, "1000");
    expect(unsplitText(container)).toContain("1.500");
    fireEvent.blur(food);
    const total = container.querySelector("#scan-total");
    fireEvent.focus(total);
    fireEvent.change(total, { target: { value: "" } });
    typeOn(total, "3000");
    expect(unsplitText(container)).toContain("1.500");
    fireEvent.blur(total);
    expect(unsplitText(container)).toContain("2.000");
  });
});
