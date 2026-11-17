// Setup loading fallback: shown while switching Setup tabs (Edges,
// Tenants, OpenEMS Backend, Rate Schedule). Sits inside setup/layout.tsx,
// so the microgrid header, the tabs and the Setup sub-nav stay on screen.

import { SectionLoading } from "@/components/ui/section-loading";

export default function SetupLoading() {
  return <SectionLoading label="setup" />;
}
