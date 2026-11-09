// Microgrid section loading fallback.
//
// Generic minimal frame for the whole `microgrids/[id]` subtree (operations,
// the billing list, setup/*). Deliberately NOT page-specific: App Router
// `loading.tsx` wraps its segment's page AND all children, so a page-shaped
// skeleton here would flash the wrong frame on e.g. the rates or households
// pages (pr-375 review).
//
// Sits inside microgrids/[id]/layout.tsx, so the microgrid header and tabs
// stay on screen while a tab switch (Billing ↔ Setup) loads.

import { SectionLoading } from "@/components/ui/section-loading";

export default function MicrogridSectionLoading() {
  return <SectionLoading label="microgrid" />;
}
