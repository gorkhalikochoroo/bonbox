/**
 * The rebuilt marketing landing page (design_handoff_bonbox_landing).
 *
 * Mounted at /v2 so it can be looked at beside the live page rather than
 * replacing it in one commit — the current landing carries two weeks of
 * corrections (hosting claims, statute references, MOMS arithmetic,
 * fabricated quotes) and a straight swap would risk losing them silently.
 *
 * Section order and backgrounds follow the handoff: alternating white /
 * slate-50, with one charcoal band near the end. The floor plan is the
 * component already shipped in components/landing/FloorPlan.jsx rather
 * than a second copy.
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
import { useLanguage } from "../hooks/useLanguage";

/** Shared shell: 1180px container with the handoff's fluid gutters. */
function Container({ children, className = "" }) {
  return (
    <div
      className={`mx-auto w-full ${className}`}
      style={{ maxWidth: 1180, paddingLeft: "clamp(24px,4vw,64px)", paddingRight: "clamp(24px,4vw,64px)" }}
    >
      {children}
    </div>
  );
}

function Band({ id, tone = "white", children }) {
  const bg = tone === "slate" ? "bg-slate-50" : tone === "charcoal" ? "bg-charcoal" : "bg-white";
  return (
    <section id={id} className={`${bg} border-t border-slate-200`}>
      <Container>
        <div style={{ paddingTop: "clamp(52px,6vw,88px)", paddingBottom: "clamp(52px,6vw,88px)" }}>
          {children}
        </div>
      </Container>
    </section>
  );
}

export default function LandingV2Page() {
  const { t } = useLanguage();

  return (
    <div className="min-h-screen bg-white font-text text-slate-900">
      <NavV2 />

      {/* 2 · Hero — slate-50, no top border (it sits under the nav) */}
      <section id="top" className="bg-slate-50">
        <Container>
          <div style={{ paddingTop: "clamp(48px,6vw,88px)", paddingBottom: "clamp(40px,5vw,64px)" }}>
            <HeroV2 />
          </div>
        </Container>
      </section>

      {/* 3 · Six modules */}
      <Band id="modules" tone="white">
        <ModulesV2 />
      </Band>

      {/* 4 · Reservations — booking card + the architectural floor plan.
          0.82fr / 1.18fr per the handoff, one column under 1040px. */}
      <Band id="reservations" tone="slate">
        <div className="grid items-center gap-[clamp(36px,5vw,56px)] lg:grid-cols-[0.82fr_1.18fr]">
          <div><BookingCardV2 /></div>
          <div className="flex justify-center"><FloorPlan /></div>
        </div>
      </Band>

      {/* 5 · Staff app — copy, then the week builder, then the phone fan */}
      <Band id="staff" tone="white">
        <StaffCopyV2 />
        <div className="mt-12"><ScheduleGridV2 /></div>
        <div className="mt-14"><PhoneFanV2 /></div>
      </Band>

      {/* 6 · Who sees what */}
      <Band id="access" tone="slate">
        <AccessV2 />
      </Band>

      {/* 7 · BonBox AI */}
      <Band id="ai" tone="white">
        <AiPanelV2 />
      </Band>

      {/* 8 · Gavekort — the one band that breaks the white/slate rhythm */}
      <Band id="gavekort" tone="charcoal">
        <GavekortV2 />
      </Band>

      {/* 9 · Pricing */}
      <Band id="pricing" tone="white">
        <PricingV2 />
      </Band>

      <FooterV2 />

      {/* Preview marker — this route is not the live page. Removed when the
          design replaces it. */}
      <div className="bg-slate-900 px-4 py-2 text-center text-[12px] text-slate-400">
        {t("landingV2PreviewNote", "Preview of the rebuilt landing page. The live page is at /.")}
      </div>
    </div>
  );
}
