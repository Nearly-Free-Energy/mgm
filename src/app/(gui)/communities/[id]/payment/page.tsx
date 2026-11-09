import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessOrg } from "@/lib/auth/access";
import { MerchantSettings } from "@/components/payments/merchant-settings";
export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const supabase = await createClient();
  const { data: community } = await supabase.from("communities").select("org_id").eq("id", id).maybeSingle<{ org_id: string }>();
  if (!community || !await currentUserCanAccessOrg(supabase, community.org_id)) notFound();
  return <MerchantSettings orgId={community.org_id} communityId={id} />;
}
