// Organizations loading fallback: shown while moving between the
// organization list and an organization's page. The dashboard chrome stays.

import { SectionLoading } from "@/components/ui/section-loading";

export default function OrganizationsLoading() {
  return <SectionLoading label="organization" />;
}
