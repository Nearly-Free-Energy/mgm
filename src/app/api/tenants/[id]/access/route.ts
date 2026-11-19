import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  composeCommunityManagement,
  type CommunityManagementError,
} from "@/lib/community-management";
import { TenantAccessGrantBody } from "@/lib/community-management/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";
import { isPluginEnabledForOrg } from "@/lib/plugins/state";
import { TENANT_APP_PLUGIN_NAME } from "@/lib/plugins/bundled";
import { checkTenantAccessGrant } from "@/lib/community-management/tenant-access-limit";
import { findAuthAccountByEmail, isEmailExistsError } from "@/lib/auth/find-account";
import { tenantAccessNotice } from "@/lib/auth/tenant-access-notice";
import { sendNotice } from "@/lib/email/notices";
import { getMgmRuntime } from "@/lib/runtime/root";

/**
 * POST /api/tenants/[id]/access — give a person access to a unit's tenant
 * pages (RFC mgm#197 § 6), from the tenant record.
 *
 * Steps, in order:
 *   1. The unit and its organization through the caller's own client. A
 *      unit the caller cannot read answers 404; one whose microgrid they
 *      cannot read (a tenant-only caller reading their own unit) answers 403.
 *   2. composeCommunityManagement: getUser(), organization access (super
 *      admin, or org manager of the unit's organization) and the
 *      community-management gate. Nothing privileged runs before it.
 *   3. This route's per-manager limit, then the tenant app's state for the
 *      organization: while it is off, no access is given (409).
 *   4. fn_tenant_access_list with the caller's client: an address already on
 *      the unit's list answers 409 and gets no second notice. The check runs
 *      before the grant and is not atomic with it: two requests for the same
 *      address at once both reach fn_tenant_access_grant, whose ON CONFLICT
 *      returns the one existing row to both, so both answer 201 with the same
 *      access_id and the person may get the notice twice. No second access
 *      row is made. If the grant starts reporting whether it inserted, answer
 *      409 from that instead.
 *   5. The service client: the account for the address, or a new one with
 *      no password (Supabase Auth sends nothing), then
 *      fn_tenant_access_grant with the getUser() id as _actor. The account
 *      comes only from the address in the body; no caller names one by id.
 *      Tenant access does not depend on staff rows: an address that holds
 *      or held a staff role is given the unit like any other.
 *   6. The notice, through the organization's sender (sendNotice), once the
 *      access is saved. It carries no sign-in link or code. A notice that
 *      cannot be sent leaves the access in place and answers
 *      email_sent: false.
 *
 * Response: 201 { access_id, email, email_sent }.
 * Errors: { error, code, field?, reason? } with fixed copy.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FORBIDDEN_COPY = "You do not have permission to manage access to this unit.";
const TENANT_APP_OFF_COPY =
  "The tenant app is not on for this organization yet. You can give access once it is on.";
const UNAVAILABLE_COPY = "Could not give access. Retry the request.";
const FAILED_COPY = "Could not give access. Retry the request.";
const RATE_LIMITED_COPY = "Too many access changes. Wait a few minutes and try again.";

function mapError(error: CommunityManagementError): NextResponse {
  const { status, code, message, field, reason } = error;
  return NextResponse.json(
    {
      error: message,
      code,
      ...(field !== undefined ? { field } : {}),
      ...(reason !== undefined ? { reason } : {}),
    },
    { status }
  );
}

function answer(status: number, error: string, code: string, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ error, code, ...extra }, { status });
}

const forbidden = () => answer(403, FORBIDDEN_COPY, "forbidden", { reason: "forbidden" });
const tenantNotFound = () => answer(404, "Tenant not found", "tenant_not_found");
const unavailable = () => answer(503, UNAVAILABLE_COPY, "tenant_access_unavailable");
const failed = () => answer(500, FAILED_COPY, "tenant_access_failed");

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid tenant ID — expected UUID" }, { status: 400 });
  }

  const parsed = await parseJsonBody(request, TenantAccessGrantBody);
  if (!parsed.ok) return parsed.response;
  const { email } = parsed.data;

  const supabase = await createClient();
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, microgrid_id")
    .eq("id", id)
    .maybeSingle<{ id: string; microgrid_id: string }>();
  if (!tenant) return tenantNotFound();

  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", tenant.microgrid_id)
    .maybeSingle<{ id: string; communities: { org_id: string } }>();
  if (!microgrid) return forbidden();
  const orgId = microgrid.communities.org_id;

  const composed = await composeCommunityManagement({ supabase, organizationId: orgId });
  if (!composed.ok) return mapError(composed);

  try {
    const actorId = composed.data.scope.userId;

    // Its own limiter, keyed by the getUser() id (tenant-access-limit.ts).
    if (!checkTenantAccessGrant(actorId).ok) {
      return answer(429, RATE_LIMITED_COPY, "rate_limited");
    }

    let tenantAppOn: boolean;
    try {
      tenantAppOn = await isPluginEnabledForOrg(supabase, orgId, TENANT_APP_PLUGIN_NAME);
    } catch {
      return unavailable();
    }
    if (!tenantAppOn) return answer(409, TENANT_APP_OFF_COPY, "tenant_app_disabled");

    const listed = await supabase.rpc("fn_tenant_access_list", { _tenant_id: id });
    if (listed.error) {
      return (listed.error as { code?: string }).code === "42501" ? forbidden() : unavailable();
    }
    const holders = (listed.data ?? []) as { email: string | null }[];
    if (holders.some((row) => row.email?.toLowerCase() === email)) {
      return answer(409, `${email} can already sign in to this unit.`, "already_has_access", {
        field: "email",
      });
    }

    const svc = createServiceClient();
    const account = await accountFor(svc, email);
    if (!account.ok) return account.response;
    const { userId, created } = account;

    const granted = await svc.rpc("fn_tenant_access_grant", {
      _tenant_id: id,
      _user_id: userId,
      _actor: actorId,
    });
    if (granted.error || typeof granted.data !== "string") {
      // An account this request created stays: with no role row it gets no
      // sign-in link (fn_auth_sign_in_target needs one) and is on no list,
      // and a retry finds it. Deleting it could take another request's grant
      // with it, made meanwhile for the same address, since user_roles.user_id
      // cascades from auth.users.
      const { code, message } = (granted.error ?? {}) as { code?: string; message?: string };
      if (code === "42501") return forbidden();
      if (code === "P0002" && message === "Tenant not found.") return tenantNotFound();
      // P0002 "User not found.": the account went while the grant waited.
      if (code === "P0002") return unavailable();
      return failed();
    }
    const accessId = granted.data;

    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", orgId)
      .maybeSingle<{ name: string }>();
    const emailSent = await sendTenantAccessNotice({
      svc,
      orgId,
      to: email,
      organizationName: org?.name ?? null,
    });

    // Server log only, with ids and never the address.
    console.info(
      JSON.stringify({
        event: "tenant_access.granted",
        tenant_id: id,
        access_id: accessId,
        actor_id: actorId,
        new_account: created,
        email_sent: emailSent,
        at: new Date().toISOString(),
      })
    );

    return NextResponse.json(
      { access_id: accessId, email, email_sent: emailSent },
      { status: 201 }
    );
  } finally {
    await composed.data.dispose();
  }
}

/**
 * The account for the address: the existing one, whatever rows it holds, or
 * a new one with no password and an unconfirmed address, which Supabase
 * Auth sends nothing for. `created` is true only for an account this
 * request made, the only kind a failed grant may remove.
 */
async function accountFor(
  svc: SupabaseClient,
  email: string
): Promise<{ ok: true; userId: string; created: boolean } | { ok: false; response: NextResponse }> {
  const found = await findAuthAccountByEmail(svc, email);
  if (!found.ok) return { ok: false, response: unavailable() };
  if (found.user) return { ok: true, userId: found.user.id, created: false };

  const res = await svc.auth.admin.createUser({ email, email_confirm: false });
  if (res.error) {
    if (!isEmailExistsError(res.error)) return { ok: false, response: failed() };
    // Created by another request since the lookup: use it.
    const again = await findAuthAccountByEmail(svc, email);
    if (again.ok && again.user) return { ok: true, userId: again.user.id, created: false };
    return { ok: false, response: unavailable() };
  }
  const newId = res.data.user?.id;
  if (!newId) return { ok: false, response: failed() };
  return { ok: true, userId: newId, created: true };
}

/**
 * The access notice, through the tenant's organization's sender, or the
 * deployment's when it has none or it fails (sendNotice). True iff it was
 * sent; a notice that cannot be sent leaves the access in place.
 */
async function sendTenantAccessNotice(input: {
  svc: SupabaseClient;
  orgId: string;
  to: string;
  organizationName: string | null;
}): Promise<boolean> {
  try {
    const runtime = await getMgmRuntime();
    const result = await sendNotice({
      service: input.svc,
      transports: runtime.mailTransports,
      orgId: input.orgId,
      message: tenantAccessNotice({ to: input.to, organizationName: input.organizationName }),
    });
    return result.ok;
  } catch (error) {
    console.error("[tenant-access] The access notice failed:", (error as Error).name);
    return false;
  }
}
