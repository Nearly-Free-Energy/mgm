// Microgrid section loading fallback.
//
// Generic minimal frame for the whole `microgrids/[id]` subtree (setup/*;
// the billing pages are views the (gui) catch-all serves outside this
// segment). Deliberately NOT page-specific: App Router
// `loading.tsx` wraps its segment's page AND all children, so a page-shaped
// skeleton here would flash the wrong frame on e.g. the rates or tenants
// pages (pr-375 review).
//
// Sits inside microgrids/[id]/layout.tsx, so the microgrid header and tabs
// stay on screen while another page under this layout loads.

import { SectionLoading } from "@/components/ui/section-loading";

export default function MicrogridSectionLoading() {
  return <SectionLoading label="microgrid" />;
}
