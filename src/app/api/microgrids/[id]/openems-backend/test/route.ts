import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getMicrogridEmsConfig } from "@/lib/openems/config";
import {
  composeMetering,
  type MeteringResult,
} from "@/lib/metering/compose";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapError(error: Extract<MeteringResult<never>, { ok: false }>) {
  const { ok, status, ...body } = error;
  void ok;
  return NextResponse.json(body, { status });
}

/**
 * POST /api/microgrids/[id]/openems-backend/test — safe connection test.
 *
 * Tests a candidate backend configuration WITHOUT persisting anything,
 * so an operator can verify credentials and reachability before saving.
 * The candidate (including any plaintext secret) lives only in this
 * request: it is built into an in-memory client, never logged, never
 * stored, never returned.
 *
 * Released metering mutations route through the metering Cordis capability.
 * Always responds 200 with a ConnectionTestResult body — even an
 * auth_failed/unreachable outcome is a successful *test*.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: microgridId } = await params;

  if (!UUID_RE.test(microgridId)) {
    return NextResponse.json(
      { error: "Invalid microgrid id — expected UUID." },
      { status: 400 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, community_id, communities!inner(org_id)")
    .eq("id", microgridId)
    .maybeSingle<{
      id: string;
      community_id: string;
      communities: { org_id: string };
    }>();
  if (!microgrid) {
    return NextResponse.json(
      { error: "Microgrid not found." },
      { status: 404 }
    );
  }

  const composed = await composeMetering({
    supabase,
    organizationId: microgrid.communities.org_id,
  });
  if (!composed.ok) return mapError(composed);

  // The form omits stored secrets ("blank means keep"). Fill omitted
  // secrets from the stored configuration of the same type so testing an
  // edited-but-not-retyped config works. Explicitly typed values always
  // win; without a stored config of the same type the capability rejects
  // the incomplete candidate. Secrets stay server-side: the merged object
  // is built into an in-memory client, never logged, never returned.
  const type = body.type as "cloud_aws" | "direct_url";
  let stored: Awaited<ReturnType<typeof getMicrogridEmsConfig>> = null;
  try {
    stored = await getMicrogridEmsConfig(supabase, microgridId);
  } catch {
    stored = null;
  }
  const asText = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;
  // Secrets merge only within the same type: a direct_url candidate never
  // inherits AWS fields (and vice versa), so cross-type stored values cannot
  // leak into an unrelated configuration.
  const storedAws =
    stored?.type === "cloud_aws" && type === "cloud_aws" ? stored : null;
  const storedDirect =
    stored?.type === "direct_url" && type === "direct_url" ? stored : null;
  const candidate = {
    type,
    backendUrl: typeof body.backendUrl === "string" ? body.backendUrl : "",
    region: asText(body.region) ?? storedAws?.region ?? null,
    accessKeyId: asText(body.accessKeyId) ?? storedAws?.accessKeyId ?? null,
    secretAccessKey:
      asText(body.secretAccessKey) ?? storedAws?.secretAccessKey ?? null,
    basicAuthUsername:
      asText(body.basicAuthUsername) ?? storedDirect?.username ?? null,
    basicAuthPassword:
      asText(body.basicAuthPassword) ?? storedDirect?.password ?? null,
    bearerToken: asText(body.bearerToken) ?? storedDirect?.token ?? null,
  };

  try {
    const result = await composed.data.metering.testConnection(
      microgridId,
      candidate
    );
    if (!result.ok) return mapError(result);
    return NextResponse.json(result.data, { status: 200 });
  } finally {
    await composed.data.dispose();
  }
}
