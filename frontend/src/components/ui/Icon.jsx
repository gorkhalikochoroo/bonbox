/**
 * Icon — single entry point for all sidebar + Cmd-K + QuickAdd icons.
 *
 * Replaces the previous emoji-as-string approach (`icon: "📊"`) which
 * suffered from:
 *   • Duplicates: 💰 used for Sales / Tax / Tips simultaneously
 *   • Cross-platform drift: Apple emoji vs Windows Segoe vs Noto = three
 *     completely different sidebars depending on user device
 *   • Color chaos: rainbow emoji clashed with the warm-stone palette
 *   • No accessibility — screen readers announced "rolled-up newspaper"
 *     for 🗞 etc., useless for nav
 *
 * Lucide outline icons (1.5px stroke, monochrome) give a consistent,
 * accessible, palette-friendly visual rhythm. We import only the ~50 we
 * actually use so the tree-shake stays tight.
 *
 * Usage:
 *   <Icon name="Home" size={18} />
 *   <Icon name="UnknownName" />  -> renders a generic Circle fallback so
 *                                   missing maps don't crash the sidebar.
 *
 * Adding a new icon:
 *   1. Pick from https://lucide.dev/icons/ — outline style is the default
 *   2. Import it below + add to `ICONS` map under a canonical name
 *   3. Reference it as `<Icon name="YourName" />` anywhere
 */
import {
  // Core
  Home, ShoppingBag, Receipt, CalendarDays, CalendarCheck,
  // Money
  Wallet, BookOpen, LineChart, Target, Landmark, CreditCard,
  BookText, FileText, Users, Car,
  // Stock
  Boxes, Package, PackageSearch, Martini, Wine, AlarmClock, Trash2,
  // Reports
  BarChart3, Utensils, ClipboardList, Moon, Store, Calculator, Send,
  // Staff
  UsersRound, Calendar, Timer, Coins, FileSpreadsheet, Briefcase,
  // Intelligence
  Brain, CloudSun, CalendarClock, BadgePercent, Heart, Telescope,
  // Weather conditions (WeatherPage) — replaced the emoji map.
  CloudRain, CloudDrizzle, Snowflake, CloudLightning, CloudFog, Thermometer,
  // Workshop
  Wrench,
  // Manage
  Settings, Building2, Monitor, Bike, LayoutGrid, Mail, Network,
  Building, UserCog, Trash, MessageCircle, MessageSquare, Link2,
  KeyRound, Menu,
  // Account
  Sparkles,
  // Personal mode
  User, Banknote, TrendingDown,
  // Accountant Hours Saved widget (2026-05-24) — Clock pairs with
  // TrendingDown in the time-saved-money tile on the dashboard.
  Clock,
  // Profile / settings
  Lock, Bell, Shield, Palette, Download, Image, CheckCircle2, AlertTriangle,
  // Recurring expenses (Task #47)
  Pause, Play, RotateCw, Plus,
  // Demo data (Task #68)
  Eraser, Loader2,
  // Stock polish (Task #118) — dead-stock / hot-sellers / search / tag / check
  Flame, TrendingUp, Search, Tag, Check, Hourglass, X,
  // Stock table icon-only action buttons (Task #121)
  Beaker, Globe, Pencil, Minus, PlusCircle,
  // Sidebar toggle — Claude-style hide/show (Task #129)
  PanelLeft, PanelLeftClose,
  // Sidebar footer (Layout.jsx) — replace legacy emoji with Lucide
  Sun, LogOut,
  // Insights feedback (Dashboard polish) — Useful / Not useful buttons
  ThumbsUp, ThumbsDown,
  // Receipt-forwarding inbox (v0.1) — Copy + AlertCircle pair with
  // the existing Mail icon on the InboxBanner / Connections card.
  Copy, AlertCircle,
  // Pop-out affordance — the schedule's "own window" button. Same mark the
  // reservations host-stand pop-out uses (it imports lucide directly), routed
  // through here so the toolbar keeps ONE icon entry point.
  ExternalLink,
  // DK i18n leak fix — Onboarding branch-type tiles + Team role badges.
  // Coffee/UtensilsCrossed/Beer replace the emoji-on-tile chooser; Crown +
  // Eye round out the role catalog (Crown=owner, ClipboardList=manager
  // already imported, Wallet=cashier already imported, Eye=viewer).
  Coffee, UtensilsCrossed, Beer, Crown, Eye,
  // POS terminal auto-detect (Commit 2, 2026-05-28) — Cpu conveys
  // "device identified" on the Daily Close detected-terminal chip.
  Cpu,
  // Tidsregistrering (DK working-time, 2026-06) — month-nav chevrons +
  // Scale for the Arbejdstidsloven legal note. ChevronUp pairs with the
  // already-mapped ChevronDown on the expandable employee register rows.
  ChevronLeft, ChevronRight, ChevronUp, Scale,
  // Daily Close de-emoji (feel PR, 2026-06-21) — JustLockedCard email-status
  // lines (ℹ️/💡/🔕) + offline lock button (📤 → UploadCloud).
  Info, Lightbulb, BellOff, UploadCloud,
  // Daily Close de-emoji sweep (feel PR cont., 2026-06-21) — revenue/payment
  // category icons + inline render glyphs. Hammer=labor, Truck=towing/shipping,
  // RotateCcw=returns, ShoppingCart=grocery products, Ticket=tobacco/lottery,
  // Leaf=fresh, Smartphone=MobilePay, Gift=gift card, FolderOpen=upload image,
  // LockOpen=unlock, RefreshCw=auto-detect refresh.
  Hammer, Truck, RotateCcw, ShoppingCart, Ticket, Leaf, Smartphone, Gift,
  FolderOpen, LockOpen, RefreshCw,
  // Audit-Tryg (2026-07) — ShieldCheck = compliance/procedurebeskrivelse.
  ShieldCheck,
  // Per-vertical adaptation (Phase A, 2026-06) — Onboarding branch tiles +
  // venueProfiles glance icons. Scissors=salon, Croissant=bakery.
  Scissors, Croissant,
  // Misc / fallback
  Circle, ChevronDown,
  HelpCircle,
} from "lucide-react";

// Map canonical icon names → Lucide components. Sidebar entries reference
// these by the string key (e.g. `icon: "Home"`). Renaming an icon here is
// safe — only the icon name string needs updating in Layout.jsx.
const ICONS = {
  HelpCircle,
  // Core
  Home, ShoppingBag, Receipt, CalendarDays, CalendarCheck,
  // Money group
  Wallet, BookOpen, LineChart, Target, Landmark, CreditCard,
  BookText, FileText, Users, Car,
  // Stock group
  Boxes, Package, PackageSearch, Martini, Wine, AlarmClock, Trash2,
  // Reports group
  BarChart3, Utensils, ClipboardList, Moon, Store, Calculator, Send,
  // Staff group
  UsersRound, Calendar, Timer, Coins, FileSpreadsheet, Briefcase,
  // Intelligence group
  Brain, CloudSun, CalendarClock, BadgePercent, Heart, Telescope,
  // Weather conditions (WeatherPage) — replaced the emoji map.
  CloudRain, CloudDrizzle, Snowflake, CloudLightning, CloudFog, Thermometer,
  // Workshop group
  Wrench,
  // Manage group
  Settings, Building2, Monitor, Bike, LayoutGrid, Mail, Network,
  Building, UserCog, Trash, MessageCircle, MessageSquare,
  // Link2 was imported but never registered, so every <Icon name="Link2"/>
  // rendered a blank Circle: the /connections nav row, ConnectionsProgressCard,
  // the schedule share button and the bank-import screen. KeyRound was not
  // imported at all (revisor login, bookkeeping export, profile). Menu was
  // special-cased in MobileBottomNav to work around this very gap.
  Link2, KeyRound, Menu,
  // Account group
  Sparkles,
  // Personal mode
  User, Banknote, TrendingDown,
  // Accountant Hours Saved widget (2026-05-24)
  Clock,
  // Profile / settings
  Lock, Bell, Shield, Palette, Download, Image, CheckCircle2, AlertTriangle,
  // Recurring expenses (Task #47)
  Pause, Play, RotateCw, Plus,
  // Demo data (Task #68)
  Eraser,
  Loader: Loader2,
  // Stock polish (Task #118) — used in InventoryPage, WastePage, ExpiryPage
  Flame, TrendingUp, Search, Tag, Check, Hourglass, X,
  // Stock table icon-only action buttons (Task #121)
  Beaker, Globe, Pencil, Minus, PlusCircle,
  // Sidebar toggle — Claude-style hide/show (Task #129)
  PanelLeft, PanelLeftClose,
  // Sidebar footer
  Sun, LogOut,
  // Insights feedback (Dashboard polish)
  ThumbsUp, ThumbsDown,
  // Receipt-forwarding inbox (v0.1)
  Copy, AlertCircle,
  ExternalLink,
  // DK i18n leak fix — Onboarding branch-type tiles + Team role badges
  Coffee, UtensilsCrossed, Beer, Crown, Eye,
  // POS terminal auto-detect chip (Commit 2)
  Cpu,
  // Tidsregistrering — working-time nav + legal note (2026-06)
  ChevronLeft, ChevronRight, ChevronUp, Scale,
  // Daily Close de-emoji (feel PR, 2026-06-21)
  Info, Lightbulb, BellOff, UploadCloud,
  // Daily Close de-emoji sweep (feel PR cont., 2026-06-21)
  Hammer, Truck, RotateCcw, ShoppingCart, Ticket, Leaf, Smartphone, Gift,
  FolderOpen, LockOpen, RefreshCw,
  ShieldCheck,
  // Per-vertical adaptation (Phase A) — salon + bakery onboarding tiles
  Scissors, Croissant,
  // Utility
  ChevronDown,
};

export default function Icon({ name, size = 18, className = "", strokeWidth = 1.75, ...rest }) {
  const C = ICONS[name] || Circle;
  return (
    <C
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      aria-hidden="true"
      {...rest}
    />
  );
}
