/**
 * The rebuilt marketing landing page (design_handoff_bonbox_landing).
 *
 * This is the front door, served at "/". It shipped behind /v2 first so it
 * could be compared against the old page; /v2 stays as an alias so any
 * link already shared keeps working.
 *
 * DO NOT WRAP THE SELF-CONTAINED SECTIONS.
 * Six of these components return their own <section id="…"> carrying the
 * band background, the 1440px container and the clamp() padding: HeroV2
 * (#top), ModulesV2 (#modules), AccessV2 (#access), AiPanelV2 (#ai),
 * GavekortV2 (#gavekort), PricingV2 (#pricing). The first version of this
 * page put a <Band> around them as well, which nested a section inside a
 * section carrying the same id. That gave doubled gutters (the hero was
 * inset 90px instead of 45), a second background painted inside the first
 * — visible as an edge running down both sides of the page — and
 * duplicate DOM ids, so getElementById returned the outer shell and the
 * nav anchors scrolled to the wrong element.
 *
 * The rest are fragments with no section of their own (BookingCardV2,
 * StaffCopyV2, ScheduleGridV2, PhoneFanV2), so those DO get the Band
 * below. NavV2 returns <header> and FooterV2 returns <footer>; both are
 * full-width and own their layout.
 *
 * Rule when adding a section: if the component renders its own
 * <section id>, render it bare here.
 */
import NavV2 from "../components/landing/v2/NavV2";
import HeroV2 from "../components/landing/v2/HeroV2";
import ModulesV2 from "../components/landing/v2/ModulesV2";
import BookingCardV2 from "../components/landing/v2/BookingCardV2";
import FloorPlan from "../components/landing/FloorPlan";
import StaffCopyV2 from "../components/landing/v2/StaffCopyV2";
import ScheduleGridV2 from "../components/landing/v2/ScheduleGridV2";
import PhoneFanV2 from "../components/landing/v2/PhoneFanV2";
import AccessV2 from "../components/landing/v2/AccessV2";
import AiPanelV2 from "../components/landing/v2/AiPanelV2";
import GavekortV2 from "../components/landing/v2/GavekortV2";
import PricingV2 from "../components/landing/v2/PricingV2";
import FooterV2 from "../components/landing/v2/FooterV2";

/**
 * Wrapper for the fragment sections only. Matches the geometry the
 * self-contained ones already carry, so every band sits on the same
 * 1440px column with the same fluid gutters.
 */
function Band({ id, tone = "white", children }) {
  const bg = tone === "slate" ? "bg-slate-50" : "bg-white";
  return (
    <section id={id} className={`${bg} border-t border-slate-200`}>
      <div
        className="mx-auto w-full max-w-[1800px]"
        style={{
          maxWidth: 1800,
          paddingLeft: "clamp(24px,4vw,80px)",
          paddingRight: "clamp(24px,4vw,80px)",
          paddingTop: "clamp(52px,6vw,88px)",
          paddingBottom: "clamp(52px,6vw,88px)",
        }}
      >
        {children}
      </div>
    </section>
  );
}

export default function LandingV2Page() {
  return (
    <div
      data-page="landing"
      className="min-h-screen bg-white font-text text-slate-900"
    >
      <NavV2 />

      {/* Self-contained: brings #top and its own slate-50 band */}
      <HeroV2 />

      {/* Self-contained: #modules */}
      <ModulesV2 />

      {/* Fragments — booking card + the architectural floor plan.
          0.82fr / 1.18fr per the handoff, one column under 1041px. */}
      <Band id="reservations" tone="slate">
        <div className="grid items-center gap-[clamp(36px,5vw,56px)] min-[1041px]:grid-cols-[0.82fr_1.18fr]">
          <div><BookingCardV2 /></div>
          <div className="flex justify-center"><FloorPlan /></div>
        </div>
      </Band>

      {/* Fragments — copy, then the week builder, then the phone fan */}
      <Band id="staff" tone="white">
        <StaffCopyV2 />
        <div className="mt-12"><ScheduleGridV2 /></div>
        <div className="mt-14"><PhoneFanV2 /></div>
      </Band>

      {/* Self-contained: #access */}
      <AccessV2 />

      {/* Self-contained: #ai */}
      <AiPanelV2 />

      {/* Self-contained: #gavekort — the charcoal band */}
      <GavekortV2 />

      {/* Self-contained: #pricing */}
      <PricingV2 />

      <FooterV2 />
    </div>
  );
}
