// Community loading fallback: shown while moving between a community's
// overview and its payment or invoice pages. Sits inside the community
// layout, which renders no chrome of its own.

import { SectionLoading } from "@/components/ui/section-loading";

export default function CommunityLoading() {
  return <SectionLoading label="community" />;
}
