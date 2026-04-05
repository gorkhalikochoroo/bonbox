/**
 * BonBox Animation Kit
 * Smooth, seamless animations using Framer Motion
 * Drop-in wrappers — just wrap any component to animate it
 */
import { motion, AnimatePresence, useInView, useSpring, useTransform, useMotionValue } from "framer-motion";
import { useRef, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

// ═══════════════════════════════════════════════════
// PAGE TRANSITION — wraps each page for route changes
// ═══════════════════════════════════════════════════
export function PageTransition({ children }) {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

// ═══════════════════════════════════════════════════
// FADE IN — simple opacity + optional slide
// ═══════════════════════════════════════════════════
export function FadeIn({ children, delay = 0, duration = 0.4, y = 10, className = "" }) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration, delay, ease: [0.25, 0.1, 0.25, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════
// FADE IN ON SCROLL — animates when element enters viewport
// ═══════════════════════════════════════════════════
export function FadeInView({ children, delay = 0, y = 20, className = "", once = true }) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once, margin: "-50px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y }}
      transition={{ duration: 0.5, delay, ease: [0.25, 0.1, 0.25, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════
// STAGGER CONTAINER + ITEM — cards/rows appear one by one
// ═══════════════════════════════════════════════════
const staggerContainer = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.06,
      delayChildren: 0.05,
    },
  },
};

const staggerItem = {
  hidden: { opacity: 0, y: 16 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, ease: [0.25, 0.1, 0.25, 1] },
  },
};

export function StaggerContainer({ children, className = "" }) {
  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className = "" }) {
  return (
    <motion.div variants={staggerItem} className={className}>
      {children}
    </motion.div>
  );
}

// Grid version for dashboard cards
export function StaggerGrid({ children, className = "" }) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0 },
        show: {
          opacity: 1,
          transition: { staggerChildren: 0.07, delayChildren: 0.1 },
        },
      }}
      initial="hidden"
      animate="show"
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function StaggerGridItem({ children, className = "" }) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 20, scale: 0.97 },
        show: {
          opacity: 1,
          y: 0,
          scale: 1,
          transition: { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] },
        },
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════
// ANIMATED CARD — hover lift + entrance animation
// ═══════════════════════════════════════════════════
export function AnimatedCard({ children, className = "", delay = 0, hover = true }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: [0.25, 0.1, 0.25, 1] }}
      whileHover={hover ? { y: -2, boxShadow: "0 8px 25px rgba(0,0,0,0.08)" } : undefined}
      whileTap={hover ? { scale: 0.995 } : undefined}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════
// LIST ANIMATIONS — table rows / list items
// ═══════════════════════════════════════════════════
export function AnimatedList({ children, className = "" }) {
  return (
    <motion.div
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: 0.04 } },
      }}
      initial="hidden"
      animate="show"
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function AnimatedListItem({ children, className = "", layout = true }) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, x: -10 },
        show: {
          opacity: 1,
          x: 0,
          transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] },
        },
      }}
      layout={layout}
      exit={{ opacity: 0, x: 10, transition: { duration: 0.2 } }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// Table row variant
export function AnimatedRow({ children, className = "", onClick }) {
  return (
    <motion.tr
      variants={{
        hidden: { opacity: 0 },
        show: {
          opacity: 1,
          transition: { duration: 0.25, ease: "easeOut" },
        },
      }}
      layout
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      className={className}
      onClick={onClick}
    >
      {children}
    </motion.tr>
  );
}

// ═══════════════════════════════════════════════════
// TAB CONTENT — crossfade between tab panels
// ═══════════════════════════════════════════════════
export function TabContent({ tabKey, children, className = "" }) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={tabKey}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
        className={className}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

// ═══════════════════════════════════════════════════
// ANIMATED NUMBER — smooth counting/morphing
// ═══════════════════════════════════════════════════
export function AnimatedNumber({ value, duration = 0.8, decimals = 0, prefix = "", suffix = "" }) {
  const motionValue = useMotionValue(0);
  const spring = useSpring(motionValue, { duration: duration * 1000, bounce: 0 });
  const display = useTransform(spring, (v) => {
    const num = Number(v) || 0;
    if (decimals > 0) return prefix + num.toFixed(decimals) + suffix;
    return prefix + Math.round(num).toLocaleString() + suffix;
  });

  useEffect(() => {
    motionValue.set(value || 0);
  }, [value, motionValue]);

  return <motion.span>{display}</motion.span>;
}

// ═══════════════════════════════════════════════════
// SLIDE PANEL — for sidebars, drawers, modals
// ═══════════════════════════════════════════════════
export function SlidePanel({ isOpen, onClose, children, from = "right", className = "" }) {
  const transforms = {
    right: { initial: { x: "100%" }, animate: { x: 0 }, exit: { x: "100%" } },
    left: { initial: { x: "-100%" }, animate: { x: 0 }, exit: { x: "-100%" } },
    bottom: { initial: { y: "100%" }, animate: { y: 0 }, exit: { y: "100%" } },
  };
  const t = transforms[from] || transforms.right;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/30 z-40"
            onClick={onClose}
          />
          <motion.div
            initial={t.initial}
            animate={t.animate}
            exit={t.exit}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className={`fixed z-50 ${className}`}
          >
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ═══════════════════════════════════════════════════
// SCALE ON TAP — micro-interaction for buttons
// ═══════════════════════════════════════════════════
export function ScaleTap({ children, className = "", scale = 0.97 }) {
  return (
    <motion.div
      whileTap={{ scale }}
      transition={{ type: "spring", stiffness: 400, damping: 15 }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════
// PROGRESS BAR — animated width
// ═══════════════════════════════════════════════════
export function AnimatedBar({ value, max = 100, color = "bg-green-500", className = "", height = "h-2" }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className={`w-full bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden ${height} ${className}`}>
      <motion.div
        className={`${height} ${color} rounded-full`}
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.7, ease: [0.25, 0.1, 0.25, 1], delay: 0.15 }}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════
// NOTIFICATION DOT — pulses then settles
// ═══════════════════════════════════════════════════
export function PulseDot({ color = "bg-red-500", className = "" }) {
  return (
    <span className={`relative flex h-2.5 w-2.5 ${className}`}>
      <motion.span
        className={`absolute inline-flex h-full w-full rounded-full ${color}`}
        animate={{ scale: [1, 1.8, 1], opacity: [0.75, 0, 0.75] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
      />
      <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${color}`} />
    </span>
  );
}

// Re-export motion and AnimatePresence for direct use
export { motion, AnimatePresence };
