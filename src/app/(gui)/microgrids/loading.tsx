// Microgrids loading fallback: shown while moving from the microgrid list
// into a microgrid, or from one microgrid to another through the breadcrumb
// switcher. Inside a microgrid, [id]/loading.tsx and the boundaries below it
// take over so the microgrid header and tabs stay on screen.

import { SectionLoading } from "@/components/ui/section-loading";

export default function MicrogridsLoading() {
  return <SectionLoading label="microgrid" />;
}
