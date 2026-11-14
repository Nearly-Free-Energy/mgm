import { notFound, redirect } from "next/navigation";
import { getRequestUserAccess } from "@/lib/auth/request-access";
import { resolveGoTarget } from "@/lib/gui/host/server/go";
import { GoPicker } from "@/lib/gui/host/server/go-picker";

/**
 * /go/<nav>: opens a navigation entry by its id, for links and home-screen
 * shortcuts that should not change when a page moves. The work is in
 * src/lib/gui/host/server/go.ts.
 */
export default async function GoPage({ params }: { params: Promise<{ nav: string }> }) {
  const { user } = await getRequestUserAccess();
  if (!user) redirect("/login");
  const { nav } = await params;
  const target = await resolveGoTarget(nav);
  if (target.kind === "not-found") notFound();
  if (target.kind === "redirect") redirect(target.href);
  return <GoPicker target={target} />;
}
