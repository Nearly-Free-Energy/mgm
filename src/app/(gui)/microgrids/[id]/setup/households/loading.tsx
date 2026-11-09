// Households loading fallback: shown while moving between the household list
// and a household, or from one household to another. The microgrid header
// and the Setup sub-nav above it stay on screen.

import { SectionLoading } from "@/components/ui/section-loading";

export default function HouseholdsLoading() {
  return <SectionLoading label="household" />;
}
