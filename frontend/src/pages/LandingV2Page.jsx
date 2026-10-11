/**
 * The rebuilt marketing landing page (design_handoff_bonbox_landing).
 *
 * This is the front door, served at "/". It shipped behind /v2 first so it
 * could be compared against the old page; /v2 stays as an alias so any
 * link already shared keeps working.
 *
 * DO NOT WRAP THE SELF-CONTAINED SECTIONS.
 * Six of these components return their own <section id="…"> carrying the
 * band background, the content container and its padding: HeroV2
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
import {
  ART_BOOKING,
  ART_FAN,
  ART_FLOOR,
  CELL,
  ROOT,
  TEXT,
  WIDE,
  WIDE_PY,
} from "../components/landing/v2/fluid";

/**
 * Wrapper for the fragment sections only. Matches the geometry the
 * self-contained ones already carry, so every band sits on the same
 * column with the same fluid gutters (see ./fluid.js for the wide-screen
 * rules). The geometry is in classes, not an inline style: an inline
 * maxWidth beat every responsive class, so the band could not widen.
 */
function Band({ id, tone = "white", children }) {
  const bg = tone === "slate" ? "bg-slate-50" : "bg-white";
  return (
    <section id={id} className={`${bg} border-t border-slate-200`}>
      <div
        className={`mx-auto w-full max-w-[1180px] px-[clamp(24px,4vw,64px)] py-[clamp(52px,6vw,88px)] ${WIDE} ${WIDE_PY}`}
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
      className={`min-h-screen bg-white font-text text-slate-900 ${ROOT}`}
    >
      <NavV2 />

      {/* Self-contained: brings #top and its own slate-50 band */}
      <HeroV2 />

      {/* Self-contained: #modules */}
      <ModulesV2 />

      {/* Fragments — booking card + the architectural floor plan.
          0.82fr / 1.18fr per the handoff, one column under 1041px. From
          1041px both are drawn at the width of their column (the booking
          card as a 440px drawing, the floor plan as a 600px one) instead of
          sitting at their own size with empty space beside them, up to
          1.1x (card) and 1.3x (plan) the type scale; past that they lay out
          wider and still fill the column (the plan drops its 600px cap,
          it is drawn in percentages). See components/landing/v2/fluid.js. */}
      <Band id="reservations" tone="slate">
        <div className="grid items-center gap-[clamp(36px,5vw,56px)] min-[1041px]:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] min-[1441px]:gap-[calc(56px*var(--lx))]">
          <div className={`${CELL} ${ART_BOOKING}`}>
            <BookingCardV2 />
          </div>
          <div className={`flex justify-center ${CELL} ${ART_FLOOR} min-[1041px]:[&>*]:max-w-none`}>
            <FloorPlan />
          </div>
        </div>
      </Band>

      {/* Fragments — the staff pitch beside its phones, then the week builder.
          The copy is capped at 58ch, so stacking the phone fan underneath it
          left the entire right half of this band empty at desktop widths while
          the phones sat centred on a row of their own. Pairing them matches
          the reservations band above and closes that gap. Single column below
          1041px, where PhoneFanV2 also drops its two side phones (981px). */}
      <Band id="staff" tone="white">
        <div className="grid items-center gap-6 min-[1041px]:gap-[clamp(36px,5vw,64px)] min-[1041px]:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] min-[1441px]:gap-[calc(64px*var(--lx))]">
          <StaffCopyV2 />
          {/* PhoneFanV2 is fixed-width artwork — three 280px shells that
              paint ~800px across. Measured at 1200px before any scaling, the
              phones ran 453->1250 inside a 552->1152 cell, overlapping the
              copy on the left and cut off by html's overflow-x:clip on the
              right (which is why scrollWidth looked clean). It used to be
              shrunk by fixed steps (scale 0.58 / 0.66), which left it 526px
              wide in a column that kept growing. Now it is zoomed to its
              column: ~0.6 at 1041px, ~0.9 at 1440px, ~1.5 at 2560 (fluid.js).
              Zoom rather than scale so the band's height follows the fan. */}
          <div className={`flex justify-center ${CELL} ${ART_FAN}`}>
            <PhoneFanV2 />
          </div>
        </div>
        <div className={`mt-14 ${TEXT}`}><ScheduleGridV2 /></div>
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
