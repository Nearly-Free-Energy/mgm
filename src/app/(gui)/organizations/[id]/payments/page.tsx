import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessOrg } from "@/lib/auth/access";
import { MerchantSettings } from "@/components/payments/merchant-settings";
export default async function PaymentSettings({ params }: { params: Promise<{ id: string }> }) {
 const { id } = await params; const client = await createClient();
 if (!await currentUserCanAccessOrg(client, id)) notFound();
 return <MerchantSettings orgId={id} />;
}
