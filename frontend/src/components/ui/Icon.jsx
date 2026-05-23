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
  Home, ShoppingBag, Receipt,
  // Money
  Wallet, BookOpen, LineChart, Target, Landmark, CreditCard,
  BookText, FileText, Users, Car,
  // Stock
  Boxes, Package, Martini, Wine, AlarmClock, Trash2,
  // Reports
  BarChart3, Utensils, ClipboardList, Moon, Store, Calculator, Send,
  // Staff
  UsersRound, Calendar, Timer, Coins, FileSpreadsheet,
  // Intelligence
  Brain, CloudSun, CalendarClock, BadgePercent, Heart, Telescope,
  // Workshop
  Wrench,
  // Manage
  Settings, Building2, Monitor, Bike, LayoutGrid, Mail, Network,
  Building, UserCog, Trash, MessageCircle, Link2,
  // Account
  Sparkles,
  // Personal mode
  User, Banknote, TrendingDown,
  // Profile / settings
  Lock, Bell, Shield, Palette, Download, Image, CheckCircle2, AlertTriangle,
  // Recurring expenses (Task #47)
  Pause, Play, RotateCw, Plus,
  // Demo data (Task #68)
  Eraser, Loader2,
  // Stock polish (Task #118) — dead-stock / hot-sellers / search / tag / check
  Flame, TrendingUp, Search, Tag, Check, Hourglass, X,
  // Misc / fallback
  Circle, ChevronDown,
} from "lucide-react";

// Map canonical icon names → Lucide components. Sidebar entries reference
// these by the string key (e.g. `icon: "Home"`). Renaming an icon here is
// safe — only the icon name string needs updating in Layout.jsx.
const ICONS = {
  // Core
  Home, ShoppingBag, Receipt,
  // Money group
  Wallet, BookOpen, LineChart, Target, Landmark, CreditCard,
  BookText, FileText, Users, Car,
  // Stock group
  Boxes, Package, Martini, Wine, AlarmClock, Trash2,
  // Reports group
  BarChart3, Utensils, ClipboardList, Moon, Store, Calculator, Send,
  // Staff group
  UsersRound, Calendar, Timer, Coins, FileSpreadsheet,
  // Intelligence group
  Brain, CloudSun, CalendarClock, BadgePercent, Heart, Telescope,
  // Workshop group
  Wrench,
  // Manage group
  Settings, Building2, Monitor, Bike, LayoutGrid, Mail, Network,
  Building, UserCog, Trash, MessageCircle,
  // Account group
  Sparkles,
  // Personal mode
  User, Banknote, TrendingDown,
  // Profile / settings
  Lock, Bell, Shield, Palette, Download, Image, CheckCircle2, AlertTriangle,
  // Recurring expenses (Task #47)
  Pause, Play, RotateCw, Plus,
  // Demo data (Task #68)
  Eraser,
  Loader: Loader2,
  // Stock polish (Task #118) — used in InventoryPage, WastePage, ExpiryPage
  Flame, TrendingUp, Search, Tag, Check, Hourglass, X,
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
