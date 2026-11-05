// Edges loading fallback: shown while moving between the edge list, an edge
// and the shared devices page. The microgrid header and the Setup sub-nav
// above it stay on screen.

import { SectionLoading } from "@/components/ui/section-loading";

export default function EdgesLoading() {
  return <SectionLoading label="edge" />;
}
