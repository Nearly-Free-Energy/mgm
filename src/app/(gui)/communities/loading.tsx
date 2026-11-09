// Communities loading fallback: shown while moving between the community
// list and a community, or from one community to another through the
// breadcrumb switcher. The dashboard chrome stays.

import { SectionLoading } from "@/components/ui/section-loading";

export default function CommunitiesLoading() {
  return <SectionLoading label="community" />;
}
