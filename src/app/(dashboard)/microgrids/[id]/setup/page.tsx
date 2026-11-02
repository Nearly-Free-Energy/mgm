import { redirect } from "next/navigation";
import { microgridSetupHref } from "@/lib/microgrid-links";

// /microgrids/[id]/setup index — redirect to the first sub-tab (Edges).
// In-app links go to microgridSetupHref directly; this stays for old
// bookmarks.
export default async function SetupIndexPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(microgridSetupHref(id));
}
