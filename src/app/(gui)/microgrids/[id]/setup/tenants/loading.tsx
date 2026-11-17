// Tenants loading fallback: shown while moving between the tenant list
// and a tenant, or from one tenant to another. The microgrid header
// and the Setup sub-nav above it stay on screen.

import { SectionLoading } from "@/components/ui/section-loading";

export default function TenantsLoading() {
  return <SectionLoading label="tenant" />;
}
