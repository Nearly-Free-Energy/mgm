import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessOrg } from "@/lib/auth/access";
import { SenderSettings } from "@/components/email/sender-settings";
import { keepTenantOnlyToTenantPages } from "@/lib/gui/host/server/tenant-pages";
export default async function EmailSettings({ params }: { params: Promise<{ id: string }> }) {
 await keepTenantOnlyToTenantPages();
 const { id } = await params; const client = await createClient();
 if (!await currentUserCanAccessOrg(client, id)) notFound();
 return <SenderSettings orgId={id} />;
}
