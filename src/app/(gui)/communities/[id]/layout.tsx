import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessCommunity } from "@/lib/auth/access";

// Management and metering are released before payments. Keep this shared
// layout independent of payment schema and unreleased payment navigation.
export default async function CommunityLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const canAccess = await currentUserCanAccessCommunity(supabase, id);
  // Same not-found page as a missing community. On a full page load it
  // comes with HTTP 200, not 404, because (gui)/loading.tsx and
  // communities/loading.tsx wrap this layout; if both go, it is a 404 again.
  if (!canAccess) notFound();
  return <>{children}</>;
}
