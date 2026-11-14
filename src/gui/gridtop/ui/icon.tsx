/**
 * The contract's icon names drawn with lucide-react. A name Gridtop does not
 * know renders nothing, and the caller keeps the entry's label in view
 * (`hasIcon`).
 */
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Building2,
  CalendarDays,
  CircleHelp,
  Contact,
  Cpu,
  Database,
  Download,
  Gauge,
  House,
  Landmark,
  MapPin,
  MessageSquare,
  Palette,
  Puzzle,
  Receipt,
  Share2,
  Sparkles,
  Tag,
  TriangleAlert,
  UserRound,
  Users,
  Wallet,
  Zap,
} from "lucide-react";
import type { Icon as IconName } from "@/lib/gui/contract";

const ICONS: Readonly<Record<IconName, LucideIcon>> = {
  today: CalendarDays,
  live: Activity,
  sites: Zap,
  communities: MapPin,
  households: House,
  devices: Cpu,
  readings: Gauge,
  billing: Receipt,
  payments: Wallet,
  tariff: Tag,
  "data-source": Database,
  branding: Palette,
  accounts: Landmark,
  plugins: Puzzle,
  users: Users,
  profile: UserRound,
  organizations: Building2,
  assistant: Sparkles,
  message: MessageSquare,
  alert: TriangleAlert,
  download: Download,
  share: Share2,
  contact: Contact,
  help: CircleHelp,
};

export function hasIcon(name: string): name is IconName {
  return Object.hasOwn(ICONS, name);
}

export function Icon({ name, className }: { name: string; className?: string }) {
  if (!hasIcon(name)) return null;
  const Glyph = ICONS[name];
  return <Glyph aria-hidden="true" focusable="false" className={className} />;
}
