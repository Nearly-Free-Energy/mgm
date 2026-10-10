import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessOrg } from "@/lib/auth/access";
export async function PUT(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: "Invalid community id" }, { status: 400 });
  const client = await createClient();
  const { data: community } = await client.from("communities").select("org_id").eq("id", id).maybeSingle<{ org_id: string }>();
  if (!community || !await currentUserCanAccessOrg(client, community.org_id)) return NextResponse.json({ error: "Community not found" }, { status: 404 });
  return NextResponse.json({ error: "Configure merchant accounts in organization payment settings, then select a community override.", reason: "use_organization_payment_settings" }, { status: 409 });
}
