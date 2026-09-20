/**
 * The money refusal that described the wrong failure.
 *
 * One key, `invalidAmount`, said "Beløbet skal være > 0" — and it fired on two
 * completely different events:
 *
 *   • the owner typed 1.234,50 and the STRICT parser could not read that shape
 *     for this account's money notation. A positive number, refused, and told
 *     that it must be positive;
 *   • the owner typed a real 0, which is the only case the sentence described.
 *
 * And "> 0" is not a thing anybody writes on a receipt.
 *
 * The two are now told apart at the only place that knows which happened, and
 * the shape refusal carries a worked example built from the SAME money locale
 * the parser reads with — so a DKK café is shown 1.234,50 and a USD one
 * 1,234.50, even when the interface chrome is in the other language.
 *
 * These render through the REAL catalogue, not a stubbed t(): the defect was a
 * wording defect, so a test that resolves keys to their own names would have
 * passed on the broken copy.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { LanguageProvider } from "../hooks/useLanguage";
import MoneyField from "../components/ui/MoneyField";
import EntryCard from "../components/ui/EntryCard";

/** Junk that parseMoneyInput refuses on shape — not a statement about zero. */
const UNREADABLE = "1.234.56";

const mount = (lang, ui) => {
  localStorage.setItem("lang", lang);
  return render(<LanguageProvider>{ui}</LanguageProvider>);
};

const alertText = () =>
  screen.getAllByRole("alert").map((n) => n.textContent).join(" | ");

beforeEach(() => localStorage.clear());

describe("MoneyField — a shape it cannot read says so, in the owner's notation", () => {
  it.each([
    ["da", "da-DK", "1.234,50"],
    ["da", "en-US", "1,234.50"],
    ["en", "da-DK", "1.234,50"],
  ])(
    "%s chrome, %s money → the example is the MONEY locale's, not the chrome's",
    (lang, moneyLoc, example) => {
      mount(lang, <MoneyField value={UNREADABLE} onChange={() => {}} locale={moneyLoc} />);
      const msg = alertText();
      expect(msg).toContain(example);
      // The old sentence, in both languages. Neither may come back.
      expect(msg).not.toContain("> 0");
      expect(msg).not.toMatch(/skal være|must be/i);
    },
  );

  it.each(["da", "en"])("%s: an empty field is the resting state, not an error", (lang) => {
    mount(lang, <MoneyField value="" onChange={() => {}} locale="da-DK" />);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });
});

describe("EntryCard — unreadable and non-positive are different sentences", () => {
  const card = (lang, amount) =>
    mount(
      lang,
      <EntryCard
        title="Tilføj udgift"
        amount={amount}
        onAmountChange={() => {}}
        onSubmit={vi.fn()}
        amountLocale="da-DK"
      />,
    );

  it.each([
    ["da", "1.234,50"],
    ["en", "1.234,50"],
  ])("%s: an unreadable shape gets the worked example", (lang, example) => {
    card(lang, UNREADABLE);
    expect(alertText()).toContain(example);
  });

  it.each(["da", "en"])("%s: a real zero gets the zero sentence, with no example", (lang) => {
    card(lang, "0");
    const msg = alertText();
    expect(msg).not.toContain("1.234,50");
    expect(msg).not.toContain("> 0");
    expect(msg.length).toBeGreaterThan(0);
  });

  it.each(["da", "en"])("%s: the two refusals are not the same string", (lang) => {
    const { unmount } = card(lang, UNREADABLE);
    const unreadable = alertText();
    unmount();
    card(lang, "0");
    expect(alertText()).not.toBe(unreadable);
  });

  it("neither refusal unlocks submit, and a readable positive amount does", async () => {
    const onSubmit = vi.fn();
    const { rerender } = mount(
      "da",
      <EntryCard title="Tilføj udgift" amount="0" onAmountChange={() => {}} onSubmit={onSubmit} amountLocale="da-DK" />,
    );
    const submit = () => screen.getAllByRole("button").find((b) => b.type === "submit");
    expect(submit().disabled).toBe(true);
    rerender(
      <LanguageProvider>
        <EntryCard title="Tilføj udgift" amount={UNREADABLE} onAmountChange={() => {}} onSubmit={onSubmit} amountLocale="da-DK" />
      </LanguageProvider>,
    );
    expect(submit().disabled).toBe(true);
    rerender(
      <LanguageProvider>
        <EntryCard title="Tilføj udgift" amount="1.234,50" onAmountChange={() => {}} onSubmit={onSubmit} amountLocale="da-DK" />
      </LanguageProvider>,
    );
    expect(submit().disabled).toBe(false);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    fireEvent.click(submit());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
