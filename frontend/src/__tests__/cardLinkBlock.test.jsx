import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import Card from "../components/ui/Card";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

// A Card rendered as a Link is an <a>; inline, its border broke into one
// box per line on /profile (12 Oct 2026). It must be a block unless the
// caller picks a display.
describe("Card as a link", () => {
  const renderCard = (props) =>
    render(<MemoryRouter><Card to="/tax" {...props}>x</Card></MemoryRouter>).container.querySelector("a");

  it("is a block by default", () => {
    expect(renderCard({}).className.split(/\s+/)).toContain("block");
  });

  it("keeps the caller's own display class", () => {
    const cls = renderCard({ className: "flex items-center" }).className.split(/\s+/);
    expect(cls).toContain("flex");
    expect(cls).not.toContain("block");
  });
});

describe("landing names the staff app Vagtplan in nav and footer", () => {
  it("da + en", () => {
    for (const dict of [da, en]) {
      const flat = JSON.stringify(dict);
      expect(flat).toContain('"landingV2.nav.staffApp":"Vagtplan"');
      expect(flat).toContain('"landingV2.footer.staffApp":"Vagtplan"');
    }
  });
});
