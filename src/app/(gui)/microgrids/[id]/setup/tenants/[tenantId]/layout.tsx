import { keepTenantOnlyToTenantPages } from "@/lib/gui/host/server/tenant-pages";
// Passthrough layout — HierarchyNav is owned by the leaf page (tenant detail page).
// This file must exist to satisfy Next.js layout conventions but renders children directly.
export default async function TenantDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // As every (gui) page and layout does first: a nested layout renders
  // alongside the page on a client-side navigation (mgm#209), so it must
  // not depend on the page's own call, even before a read is added here.
  await keepTenantOnlyToTenantPages();
  return <>{children}</>;
}
