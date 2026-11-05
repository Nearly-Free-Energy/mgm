// Microgrid section loading fallback.
//
// Generic minimal frame for the whole `microgrids/[id]` subtree (setup/*,
// tenants, billing list). Deliberately NOT overview-specific: App Router
// `loading.tsx` wraps its segment's page AND all children, so an
// overview-shaped skeleton here would flash the wrong frame on e.g. the
// rates or households pages (pr-375 review). The overview page itself gets
// its precise skeleton from the `(overview)` route group, which is
// URL-transparent and takes precedence for that route.
//
// Sits inside microgrids/[id]/layout.tsx, so the microgrid header and tabs
// stay on screen while a tab switch (Billing ↔ Setup) loads.

import { SectionLoading } from "@/components/ui/section-loading";

export default function MicrogridSectionLoading() {
  return <SectionLoading label="microgrid" />;
}
