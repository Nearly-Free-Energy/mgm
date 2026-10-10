/**
 * GET /api/communities/[id]/payment/override — read the community override
 * (if any) plus the effective account + origin. Redacted: never secrets.
 *
 * PUT — set/clear the override: { merchantAccountId: string | null }.
 * An explicit override (even a broken one) wins over the org default; a
 * broken override errors at checkout instead of silently falling back.
 *
 * DELETE — clear the override (restore org default).
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessOrg } from "@/lib/auth/access";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadCommunityOrg(
  supabase: Awaited<ReturnType<typeof createClient>>,
  communityId: string
): Promise<string | null> {
  const { data } = await supabase
    .from("communities")
    .select("id, org_id")
    .eq("id", communityId)
    .maybeSingle<{ id: string; org_id: string }>();
  return data?.org_id ?? null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: communityId } = await params;
  if (!UUID_RE.test(communityId)) {
    return NextResponse.json({ error: "Invalid community id." }, { status: 400 });
  }
  const supabase = await createClient();
  const orgId = await loadCommunityOrg(supabase, communityId);
  if (!orgId) {
    return NextResponse.json({ error: "Community not found." }, { status: 404 });
  }
  if (!(await currentUserCanAccessOrg(supabase, orgId))) {
    return NextResponse.json({ error: "Community not found." }, { status: 404 });
  }
  const { data: override } = await supabase
    .from("community_payment_overrides")
    .select("id, merchant_account_id, created_at, updated_at")
    .eq("community_id", communityId)
    .maybeSingle<{ id: string; merchant_account_id: string | null; created_at: string; updated_at: string }>();
  return NextResponse.json({ override: override ?? null, orgId });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: communityId } = await params;
  if (!UUID_RE.test(communityId)) {
    return NextResponse.json({ error: "Invalid community id." }, { status: 400 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const merchantAccountId =
    body?.merchantAccountId === null
      ? null
      : typeof body?.merchantAccountId === "string"
        ? (body.merchantAccountId as string)
        : undefined;
  if (merchantAccountId === undefined) {
    return NextResponse.json(
      { error: "merchantAccountId must be a UUID string or null." },
      { status: 400 }
    );
  }
  if (merchantAccountId !== null && !UUID_RE.test(merchantAccountId)) {
    return NextResponse.json(
      { error: "merchantAccountId must be a UUID string or null." },
      { status: 400 }
    );
  }
  const supabase = await createClient();
  const orgId = await loadCommunityOrg(supabase, communityId);
  if (!orgId) {
    return NextResponse.json({ error: "Community not found." }, { status: 404 });
  }
  if (!(await currentUserCanAccessOrg(supabase, orgId))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  if (merchantAccountId) {
    const { data: account } = await supabase
      .from("payment_merchant_accounts")
      .select("id, org_id")
      .eq("id", merchantAccountId)
      .maybeSingle<{ id: string; org_id: string }>();
    if (!account || account.org_id !== orgId) {
      return NextResponse.json(
        { error: "Merchant account not found for this organization." },
        { status: 404 }
      );
    }
  }
  const { error } = await supabase.from("community_payment_overrides").upsert(
    { org_id: orgId, community_id: communityId, merchant_account_id: merchantAccountId },
    { onConflict: "community_id" }
  );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ status: "success" });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: communityId } = await params;
  if (!UUID_RE.test(communityId)) {
    return NextResponse.json({ error: "Invalid community id." }, { status: 400 });
  }
  const supabase = await createClient();
  const orgId = await loadCommunityOrg(supabase, communityId);
  if (!orgId) {
    return NextResponse.json({ error: "Community not found." }, { status: 404 });
  }
  if (!(await currentUserCanAccessOrg(supabase, orgId))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  const { error } = await supabase
    .from("community_payment_overrides")
    .delete()
    .eq("community_id", communityId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ status: "success" });
}
