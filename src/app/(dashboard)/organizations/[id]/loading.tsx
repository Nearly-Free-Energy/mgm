// Organization loading fallback: shown while moving between an
// organization's page and its payment accounts.

import { SectionLoading } from "@/components/ui/section-loading";

export default function OrganizationLoading() {
  return <SectionLoading label="organization" />;
}
