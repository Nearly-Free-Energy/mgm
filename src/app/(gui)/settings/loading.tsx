// Settings loading fallback: shown while switching Settings tabs. Sits
// inside settings/layout.tsx, so the heading and tabs stay on screen. The
// settings pages have no breadcrumb; if one gains one, drop
// `breadcrumb={false}` so the frame matches it.

import { SectionLoading } from "@/components/ui/section-loading";

export default function SettingsLoading() {
  return <SectionLoading label="settings" breadcrumb={false} />;
}
