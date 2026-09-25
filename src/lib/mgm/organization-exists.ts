import "server-only";

import { createServiceClient } from "@/lib/supabase/service";

/** A global existence check; a caller-scoped query returns zero under RLS. */
export async function organizationExists(): Promise<boolean> {
  const { data, error } = await createServiceClient()
    .from("organizations")
    .select("id")
    .limit(1);

  if (error) throw new Error(`Could not check organization setup: ${error.message}`);
  return (data?.length ?? 0) > 0;
}
