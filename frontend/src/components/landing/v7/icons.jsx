/* The v7 landing's line icons, as the design draws them (stroke icons, 24 px grid). Decorative: aria-hidden. */
const line = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false" };

export const Globe = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" strokeWidth="1.6" {...line}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.4 2.5 3.7 5.5 3.7 9s-1.3 6.5-3.7 9c-2.4-2.5-3.7-5.5-3.7-9S9.6 5.5 12 3z" /></svg>
);
export const Chevron = () => (
  <svg className="chev" width="12" height="12" viewBox="0 0 24 24" strokeWidth="2.2" {...line}><path d="m6 9 6 6 6-6" /></svg>
);
export const Check = ({ className, size = 16, width = "2.4" }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={width} {...line}><path d="M20 6 9 17l-5-5" /></svg>
);
export const Arrow = () => (
  <svg className="arrow" width="16" height="16" viewBox="0 0 24 24" strokeWidth="2" {...line}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const Calendar = () => (
  <svg viewBox="0 0 24 24" strokeWidth="2" {...line}><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
);
export const FlowArrow = () => (
  <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="M0 5H96" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" fill="none" /><path d="M91 1l5 4-5 4" fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" /></svg>
);
