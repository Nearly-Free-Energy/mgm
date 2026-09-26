import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import { createOpenEmsClient, OpenEmsError } from "@/lib/openems";
import type { OpenEmsClientConfig } from "@/lib/openems";
import {
  getEmsSecretForMicrogrid,
  getEmsBasicAuthPasswordForMicrogrid,
  getEmsBearerTokenForMicrogrid,
  getEmsKeycloakClientSecretForMicrogrid,
} from "@/lib/openems/config";
import { validateBackendUrl } from "@/lib/openems/backend-url";
import { scrubSecretValues } from "@/lib/logging/scrub-secrets";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PUT /api/microgrids/[id]/openems-backend — Save & test connection (#101).
 *
 * Body shape:
 *   { type: 'cloud_aws' | 'direct_url',
 *     backendUrl: string,
 *     known_edge_ids: string[],                // edge IDs to validate (#112)
 *     region?, accessKeyId?, secretAccessKey?  // cloud_aws only
 *     basicAuthUsername?, basicAuthPassword?   // direct_url only (#327)
 *     bearerToken?                             // direct_url only (issue #4)
 *     keycloakTokenUrl?, keycloakClientId?,
 *     keycloakClientSecret?                    // direct_url only (issue #4)
 *     confirmed_name?: string                  // closed-period bypass
 *   }
 *
 * `basicAuthUsername` / `basicAuthPassword` are optional and must be supplied
 * together — a username with no password would send `Basic <user>:` and the
 * backend would report bad credentials rather than missing ones. Blank
 * password with a username and an existing ciphertext on record means
 * "keep the stored password", mirroring the cloud_aws secret-preserve flow.
 *
 * `bearerToken` (Keycloak token for the dedicated MGM account) is likewise
 * optional and mutually exclusive with the Basic pair: blank with an
 * existing ciphertext on record means "keep the stored token". The stored
 * token wins over Basic at read time, so a saved mixed state always
 * authenticates as the dedicated account — but this route rejects mixed
 * input outright so no such state is ever written.
 *
 * Mandatory execution order (AC-ROUTE-1, amendments 2026-04-23 + #112):
 *
 *   1. Validate body shape → 400 on malformed.
 *      Accepts known_edge_ids as string[] (non-array → 400).
 *      backendUrl must additionally pass `validateBackendUrl` (mbe-docs#8):
 *      absolute https:// URL (http:// for localhost only), no embedded
 *      credentials, no private/loopback/link-local literal host.
 *   2. Permission check via currentUserCanAccessMicrogrid. 404 if the
 *      microgrid is hidden/missing (don't leak existence with a 403).
 *   3. Secret-preserve gate (cloud_aws): if secretAccessKey blank and an
 *      existing ciphertext is on record, preserve it. Otherwise 400.
 *      Same gate for the direct_url Basic password (#327), plus a 400 when
 *      exactly one of username/password is supplied.
 *   4. Mid-period lock — 3-branch decision tree:
 *        (a) draft exists            → hard 409
 *        (b) closed exists (no draft) → 409 with requires_typed_confirmation
 *                                       unless body.confirmed_name matches
 *        (c) no periods              → free pass
 *   5. Edge-ID validation (#112): if known_edge_ids is non-empty, build the
 *      candidate OpenEmsClientConfig (using effectiveSecret already resolved
 *      in step 3) and call getEdgesStatus(known_edge_ids). Any ID absent
 *      from the response → 400 with invalid_edges. No DB write on failure.
 *   6. Persist the config (first transaction). fn_ems_encrypt_secret encrypts
 *      the AWS secret key if supplied. Saves ems_known_edge_ids.
 *   7. Run Discover against the saved config (second transaction; status
 *      fields updated regardless of success). Passes known_edge_ids to
 *      getEdgesStatus instead of []; reuses statuses stashed in step 5.
 *   8. Return { status, message, edgeCount?, edges? }.
 *
 * Error mapping (OpenEmsError):
 *   auth failure  → status='auth_failed'   message with rotated-key hint
 *   fetch failure → status='unreachable'   message with URL
 *   zero edges    → status='zero_edges'    message
 *   unknown       → status='unknown_error' message + full error kept server-side
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const startedAt = Date.now();
  const { id: microgridId } = await params;

  if (!UUID_RE.test(microgridId)) {
    return NextResponse.json(
      { error: "Invalid microgrid id — expected UUID" },
      { status: 400 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Request body must be an object" },
      { status: 400 }
    );
  }

  const type = body.type;
  const backendUrl = body.backendUrl;

  if (type !== "cloud_aws" && type !== "direct_url") {
    return NextResponse.json(
      { error: "type must be 'cloud_aws' or 'direct_url'" },
      { status: 400 }
    );
  }
  if (typeof backendUrl !== "string" || !backendUrl.trim()) {
    return NextResponse.json(
      { error: "backendUrl is required" },
      { status: 400 }
    );
  }

  // Scheme / host validation before anything is persisted or contacted
  // (mbe-docs#8). Runs ahead of the permission and mid-period gates because
  // it is a pure body-shape check — same tier as the `type` check above.
  const urlCheck = validateBackendUrl(backendUrl);
  if (!urlCheck.ok) {
    return NextResponse.json({ error: urlCheck.error }, { status: 400 });
  }

  // Validate known_edge_ids — must be an array of strings.
  // Server-side sanitize: trim, filter empties, dedupe (preserve first occurrence).
  if (!Array.isArray(body.known_edge_ids)) {
    return NextResponse.json(
      { error: "known_edge_ids must be an array of strings" },
      { status: 400 }
    );
  }
  for (const el of body.known_edge_ids as unknown[]) {
    if (typeof el !== "string") {
      return NextResponse.json(
        { error: "known_edge_ids must be an array of strings" },
        { status: 400 }
      );
    }
  }
  const rawEdgeIds = body.known_edge_ids as string[];
  const seenEdgeIds = new Set<string>();
  const known_edge_ids: string[] = [];
  for (const id of rawEdgeIds) {
    const trimmed = id.trim();
    if (trimmed && !seenEdgeIds.has(trimmed)) {
      seenEdgeIds.add(trimmed);
      known_edge_ids.push(trimmed);
    }
  }

  let region: string | undefined;
  let accessKeyId: string | undefined;
  let secretAccessKey: string | undefined;

  if (type === "cloud_aws") {
    region = typeof body.region === "string" ? body.region.trim() : undefined;
    accessKeyId =
      typeof body.accessKeyId === "string" ? body.accessKeyId.trim() : undefined;
    secretAccessKey =
      typeof body.secretAccessKey === "string"
        ? body.secretAccessKey
        : undefined;

    // Region + accessKeyId are always required for cloud_aws.
    // secretAccessKey required-ness is deferred until after we know whether
    // an existing ciphertext is preserved (#102 AC-SECRET-PRESERVE). We
    // resolve that below after reading the microgrid row.
    if (!region || !accessKeyId) {
      return NextResponse.json(
        {
          error:
            "type='cloud_aws' requires region, accessKeyId, and secretAccessKey",
        },
        { status: 400 }
      );
    }
  }

  // direct_url HTTP Basic credentials (#327). Both optional, but not
  // independently: a username with no password produces `Basic dXNlcjo=`,
  // which the backend rejects as *wrong* credentials rather than *missing*
  // ones, sending the operator to check a password they never set. Rejecting
  // the half-filled form here is the only place that distinction is still
  // visible.
  //
  // Password required-ness is resolved after the row read, like the AWS
  // secret: blank + existing ciphertext means "keep the stored one".
  let basicAuthUsername: string | undefined;
  let basicAuthPassword: string | undefined;
  let bearerToken: string | undefined;
  let keycloakTokenUrl: string | undefined;
  let keycloakClientId: string | undefined;
  let keycloakClientSecret: string | undefined;

  if (type === "direct_url") {
    basicAuthUsername =
      typeof body.basicAuthUsername === "string"
        ? body.basicAuthUsername.trim()
        : undefined;
    basicAuthPassword =
      typeof body.basicAuthPassword === "string"
        ? body.basicAuthPassword
        : undefined;
    // Bearer token (issue #4): blank means "keep the stored token", exactly
    // like the Basic password preserve flow below. Whitespace-only is
    // treated as blank — a token of spaces authenticates nowhere.
    bearerToken =
      typeof body.bearerToken === "string" && body.bearerToken.trim()
        ? body.bearerToken
        : undefined;
    // Keycloak client-credentials (issue #4 follow-up): the token URL and
    // client id are identifiers (retyping them with a blank secret preserves
    // the stored secret, mirroring Basic). All-or-nothing — validated below.
    keycloakTokenUrl =
      typeof body.keycloakTokenUrl === "string" && body.keycloakTokenUrl.trim()
        ? body.keycloakTokenUrl.trim()
        : undefined;
    keycloakClientId =
      typeof body.keycloakClientId === "string" && body.keycloakClientId.trim()
        ? body.keycloakClientId.trim()
        : undefined;
    keycloakClientSecret =
      typeof body.keycloakClientSecret === "string" &&
      body.keycloakClientSecret.length > 0
        ? body.keycloakClientSecret
        : undefined;
  }

  const supabase = await createClient();

  // Permission check — 404 on hidden/missing (don't leak existence).
  // Also read the existing encrypted secret so we can support the
  // "leave blank to keep the current secret" flow (#102 AC-SECRET-PRESERVE).
  // SECURITY: ciphertext read server-side only — never returned to client (issue #106).
  const { data: mgRow, error: mgErr } = await supabase
    .from("microgrids")
    .select(
      "id, name, ems_type, ems_aws_secret_access_key_encrypted, ems_basic_auth_password_encrypted, ems_bearer_token_encrypted, ems_keycloak_token_url, ems_keycloak_client_id, ems_keycloak_client_secret_encrypted"
    )
    .eq("id", microgridId)
    .maybeSingle<{
      id: string;
      name: string;
      ems_type: "cloud_aws" | "direct_url" | null;
      ems_aws_secret_access_key_encrypted: string | null;
      ems_basic_auth_password_encrypted: string | null;
      ems_bearer_token_encrypted: string | null;
      ems_keycloak_token_url: string | null;
      ems_keycloak_client_id: string | null;
      ems_keycloak_client_secret_encrypted: string | null;
    }>();

  if (mgErr) {
    return NextResponse.json(
      { error: `Failed to read microgrid: ${mgErr.message}` },
      { status: 500 }
    );
  }
  if (!mgRow) {
    return NextResponse.json({ error: "Microgrid not found." }, { status: 404 });
  }

  // Secret-preserve gate (cloud_aws only):
  //   If user submitted blank secretAccessKey AND an existing ciphertext is on
  //   record, we preserve the existing ciphertext. Otherwise (no ciphertext
  //   AND blank) we require a secret.
  const preserveExistingSecret =
    type === "cloud_aws" &&
    (!secretAccessKey || secretAccessKey.length === 0) &&
    mgRow.ems_aws_secret_access_key_encrypted !== null &&
    mgRow.ems_aws_secret_access_key_encrypted !== undefined;

  if (type === "cloud_aws" && !secretAccessKey && !preserveExistingSecret) {
    return NextResponse.json(
      {
        error:
          "type='cloud_aws' requires region, accessKeyId, and secretAccessKey",
      },
      { status: 400 }
    );
  }

  // Basic-auth preserve gate (#327), mirroring the cloud_aws one above: a
  // blank password with an existing ciphertext on record means "keep it".
  const preserveExistingBasicAuthPassword =
    type === "direct_url" &&
    !!basicAuthUsername &&
    (!basicAuthPassword || basicAuthPassword.length === 0) &&
    mgRow.ems_basic_auth_password_encrypted !== null &&
    mgRow.ems_basic_auth_password_encrypted !== undefined;

  // Bearer-token preserve gate (issue #4), mirroring the two above: a
  // blank token with an existing ciphertext on record means "keep it" —
  // but only when no Basic identity is being named. Typing a username is
  // an explicit switch and clears the stored token below.
  const preserveExistingBearerToken =
    type === "direct_url" &&
    !bearerToken &&
    !basicAuthUsername &&
    !keycloakTokenUrl &&
    !keycloakClientId &&
    mgRow.ems_bearer_token_encrypted !== null &&
    mgRow.ems_bearer_token_encrypted !== undefined;

  // Keycloak preserve gate: identifiers retyped + secret blank + a stored
  // triple on record means "keep the stored secret". A blank-everything
  // save clears Keycloak (mirroring Basic) — preserving an identity the
  // operator did not name would make switches silent.
  const storedKeycloakComplete =
    mgRow.ems_keycloak_token_url != null &&
    mgRow.ems_keycloak_client_id != null &&
    mgRow.ems_keycloak_client_secret_encrypted != null;
  const preserveExistingKeycloakSecret =
    type === "direct_url" &&
    !!keycloakTokenUrl &&
    !!keycloakClientId &&
    !keycloakClientSecret &&
    storedKeycloakComplete;

  // Reject the half-filled form. Checked after the row read so that "username
  // present, password blank, ciphertext on record" is a preserve rather than
  // an error.
  if (type === "direct_url") {
    if (
      basicAuthUsername &&
      !basicAuthPassword &&
      !preserveExistingBasicAuthPassword
    ) {
      return NextResponse.json(
        {
          error:
            "A username was provided with no password. Enter the password, or clear the username to connect without authentication.",
        },
        { status: 400 }
      );
    }
    if (!basicAuthUsername && basicAuthPassword) {
      return NextResponse.json(
        {
          error:
            "A password was provided with no username. Enter the username, or clear the password to connect without authentication.",
        },
        { status: 400 }
      );
    }
    // The three direct_url identities — bearer token, Basic pair, Keycloak
    // client — are mutually exclusive: a request naming more than one
    // cannot say which account the backend will see, so it says none.
    // (Read-time precedence prefers Keycloak-auto, then the token, but
    // that path exists only for states predating this validation.)
    //
    // Switching identities is explicit, never silent: naming a new
    // identity clears the stored ones, because the operator named the new
    // identity. Blank-everything keeps a stored bearer or Keycloak triple
    // but clears Basic — matching the pre-existing Basic behavior where
    // blank fields with no stored ciphertext mean "unauthenticated".
    const namedIdentities = [
      bearerToken ? "bearer" : null,
      basicAuthUsername ? "basic" : null,
      keycloakTokenUrl && keycloakClientId ? "keycloak" : null,
    ].filter((identity): identity is string => identity !== null);
    if (namedIdentities.length > 1) {
      return NextResponse.json(
        {
          error:
            "Use a bearer token, a username/password pair, or Keycloak — not more than one. Clear the others to proceed.",
        },
        { status: 400 }
      );
    }
    // Keycloak triple is all-or-nothing for identifiers: a URL without a
    // client id (or vice versa) names half an identity the server could
    // resolve against the wrong stored half. The secret alone is never an
    // identity — without identifiers it is rejected, not preserved.
    if (
      type === "direct_url" &&
      (keycloakTokenUrl || keycloakClientId || keycloakClientSecret) &&
      !(keycloakTokenUrl && keycloakClientId)
    ) {
      return NextResponse.json(
        {
          error:
            "Keycloak needs both the token URL and the client id. Enter both, or clear both to connect another way.",
        },
        { status: 400 }
      );
    }
    // A lone secret with no identifiers and no stored triple to preserve
    // into is likely a paste into the wrong field — reject rather than
    // silently drop a credential the operator thinks was saved.
    if (
      type === "direct_url" &&
      keycloakClientSecret &&
      !keycloakTokenUrl &&
      !keycloakClientId &&
      !storedKeycloakComplete
    ) {
      return NextResponse.json(
        {
          error:
            "A client secret was provided with no token URL or client id. Enter the Keycloak details, or clear the secret.",
        },
        { status: 400 }
      );
    }
  }
  const wantsKeycloak =
    type === "direct_url" &&
    !!keycloakTokenUrl &&
    !!keycloakClientId &&
    !basicAuthUsername &&
    !bearerToken;
  const wantsBearer =
    type === "direct_url" &&
    !basicAuthUsername &&
    !wantsKeycloak &&
    (!!bearerToken || preserveExistingBearerToken);

  // Keycloak secret required-ness mirrors cloud_aws: a named triple with a
  // blank secret and no stored triple to preserve is incomplete, not
  // "unauthenticated" — silently saving it would store an identity that
  // authenticates as nobody.
  if (wantsKeycloak && !keycloakClientSecret && !preserveExistingKeycloakSecret) {
    return NextResponse.json(
      {
        error:
          "Keycloak requires the token URL, client id, and client secret.",
      },
      { status: 400 }
    );
  }
  // Configuration gate. Since #321 this is the same permission as reaching
  // the microgrid at all: an org manager configures any microgrid in their own
  // org and nothing else. It is a preview of what the BEFORE UPDATE trigger on
  // `microgrids` will decide at step 6 (migration 00053, which chains through
  // `user_can_access_microgrid`) — it exists to produce an actionable 403 here
  // rather than a bare Postgres 42501 after the outbound connection test has
  // already run. The trigger is the enforcement; if this check were removed the
  // write would still be rejected. If that trigger is ever repointed at a
  // narrower predicate, this stops being an accurate preview.
  if (!(await currentUserCanAccessMicrogrid(supabase, microgridId))) {
    return NextResponse.json(
      { error: "You do not have permission to configure this microgrid." },
      { status: 403 }
    );
  }

  // Mid-period lock — 3-branch decision tree (amendments 2026-04-23).
  const { data: periods, error: periodsErr } = await supabase
    .from("billing_periods")
    .select("id, status")
    .eq("microgrid_id", microgridId)
    .in("status", ["draft", "closed"]);

  if (periodsErr) {
    return NextResponse.json(
      { error: `Failed to read billing periods: ${periodsErr.message}` },
      { status: 500 }
    );
  }

  const draftCount = (periods ?? []).filter((p) => p.status === "draft").length;
  const closedCount = (periods ?? []).filter((p) => p.status === "closed").length;

  if (draftCount > 0) {
    // Branch (a) — hard 409.
    return NextResponse.json(
      {
        error:
          "Close or delete the draft period first. Changing the OpenEMS backend requires rediscovering devices and would invalidate readings from the current period.",
        draft_count: draftCount,
        closed_count: closedCount,
      },
      { status: 409 }
    );
  }

  if (closedCount > 0) {
    // Branch (b) — type-to-confirm gate (two sub-cases).
    //   • confirmed_name absent (or not a string) → 409 prompting the user to type.
    //   • confirmed_name present but wrong → 400 explicit mismatch error.
    //   • confirmed_name matches → fall through to save + discover.
    if (typeof body.confirmed_name !== "string") {
      return NextResponse.json(
        {
          error: `This microgrid has ${closedCount} closed billing period${closedCount === 1 ? "" : "s"}. Changing the OpenEMS backend may affect historical invoice verification if edge IDs differ after rediscovery. Type the microgrid name to confirm.`,
          requires_typed_confirmation: { entity_name: mgRow.name },
          draft_count: draftCount,
          closed_count: closedCount,
        },
        { status: 409 }
      );
    }

    if (body.confirmed_name.trim() !== mgRow.name.trim()) {
      return NextResponse.json(
        { error: "Confirmed name does not match the microgrid name." },
        { status: 400 }
      );
    }
  }

  // Branch (c): no periods — fall through.

  // ── Steps 3b + 5 prep: resolve effectiveSecret early so step 5 can reuse ─
  //
  // We build the candidate OpenEmsClientConfig here (before the DB write) so
  // step 5 (edge-ID validation) can use it without a second decrypt round-trip.
  // effectiveSecret is also reused by step 7 (Discover after save).
  //
  // The decrypt runs on the service-role client inside
  // `getEmsSecretForMicrogrid`, which re-reads the microgrid row on the
  // RLS-evaluated `supabase` client first and returns null before any decrypt
  // is reachable when that row is not visible. That read is the authorization
  // — it must stay ahead of the decrypt (see the helper's ordering note). The
  // route's own mgRow read + currentUserCanAccessMicrogrid + super_admin gates
  // above have already run at this point.
  let effectiveSecret: string | undefined = secretAccessKey;
  if (type === "cloud_aws" && preserveExistingSecret) {
    let decrypted: string | null = null;
    let decryptErr: unknown = null;
    try {
      decrypted = await getEmsSecretForMicrogrid(supabase, microgridId);
    } catch (err) {
      decryptErr = err;
    }
    if (decryptErr || !decrypted) {
      return NextResponse.json(
        {
          error:
            "Could not retrieve the existing secret to test the connection. Re-enter the secret access key to proceed.",
        },
        { status: 500 }
      );
    }
    effectiveSecret = decrypted;
  }

  // Same treatment for the Basic password (#327): when the operator left it
  // blank and a ciphertext is on record, decrypt the stored one so step 5
  // tests the credentials that will actually be in force after the save. A
  // pre-save test that authenticates differently from the saved config is
  // worse than no test — it reports green on something that will not run.
  let effectiveBasicAuthPassword: string | undefined = basicAuthPassword;
  if (preserveExistingBasicAuthPassword) {
    let decrypted: string | null = null;
    let decryptErr: unknown = null;
    try {
      decrypted = await getEmsBasicAuthPasswordForMicrogrid(
        supabase,
        microgridId
      );
    } catch (err) {
      decryptErr = err;
    }
    if (decryptErr || !decrypted) {
      return NextResponse.json(
        {
          error:
            "Could not retrieve the existing password to test the connection. Re-enter the password to proceed.",
        },
        { status: 500 }
      );
    }
    effectiveBasicAuthPassword = decrypted;
  }

  // Same treatment for the bearer token (issue #4): when the operator left
  // it blank and a ciphertext is on record, decrypt the stored one so the
  // pre-save test authenticates exactly as the saved config will. A
  // pre-save test that authenticates differently from the saved config is
  // worse than no test — it reports green on something that will not run.
  let effectiveBearerToken: string | undefined = bearerToken;
  if (wantsBearer && preserveExistingBearerToken) {
    let decrypted: string | null = null;
    let decryptErr: unknown = null;
    try {
      decrypted = await getEmsBearerTokenForMicrogrid(supabase, microgridId);
    } catch (err) {
      decryptErr = err;
    }
    if (decryptErr || !decrypted) {
      return NextResponse.json(
        {
          error:
            "Could not retrieve the existing token to test the connection. Re-enter the bearer token to proceed.",
        },
        { status: 500 }
      );
    }
    effectiveBearerToken = decrypted;
  }

  // Same treatment for the Keycloak client secret: when the operator retyped
  // the identifiers but left the secret blank and a complete triple is on
  // record, decrypt the stored secret so the pre-save test uses the
  // credentials that will actually be in force after the save. Then obtain
  // an access token immediately — a Keycloak config whose IdP rejects the
  // client must fail here, before anything is persisted.
  let effectiveKeycloakToken: string | undefined;
  let effectiveKeycloakClientSecret: string | undefined = keycloakClientSecret;
  if (wantsKeycloak) {
    if (!effectiveKeycloakClientSecret && preserveExistingKeycloakSecret) {
      let decrypted: string | null = null;
      let decryptErr: unknown = null;
      try {
        decrypted = await getEmsKeycloakClientSecretForMicrogrid(
          supabase,
          microgridId
        );
      } catch (err) {
        decryptErr = err;
      }
      if (decryptErr || !decrypted) {
        return NextResponse.json(
          {
            error:
              "Could not retrieve the existing client secret to test the connection. Re-enter the client secret to proceed.",
          },
          { status: 500 }
        );
      }
      effectiveKeycloakClientSecret = decrypted;
    }
    if (effectiveKeycloakClientSecret && keycloakTokenUrl && keycloakClientId) {
      const { obtainKeycloakToken } = await import("@/lib/openems/keycloak");
      try {
        effectiveKeycloakToken = await obtainKeycloakToken({
          tokenUrl: keycloakTokenUrl,
          clientId: keycloakClientId,
          clientSecret: effectiveKeycloakClientSecret,
        });
      } catch (err) {
        if (err instanceof OpenEmsError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: err.statusCode }
          );
        }
        throw err;
      }
    }
  }

  const candidateConfig: OpenEmsClientConfig =
    type === "cloud_aws"
      ? {
          type: "cloud_aws",
          url: backendUrl.trim(),
          region: region as string,
          accessKeyId: accessKeyId as string,
          secretAccessKey: effectiveSecret as string,
        }
      : {
          type: "direct_url",
          url: backendUrl.trim(),
          username: basicAuthUsername ?? null,
          password: effectiveBasicAuthPassword ?? null,
          token: effectiveKeycloakToken ?? effectiveBearerToken ?? null,
        };

  // ── Step 5: Edge-ID validation (#112) ─────────────────────────────────────
  //
  // MUST run BEFORE the UPDATE (step 6) so invalid configs are never persisted.
  // If known_edge_ids is empty, skip the round-trip (empty list is allowed).
  // Stash statuses for step 7 reuse to avoid a second round-trip.
  let step5Statuses: Array<{ edgeId: string; online: boolean }> | null = null;

  if (known_edge_ids.length > 0) {
    try {
      const client = createOpenEmsClient(candidateConfig);
      step5Statuses = await client.getEdgesStatus(known_edge_ids);
      const foundIds = new Set(step5Statuses.map((s) => s.edgeId));
      const invalidEdges = known_edge_ids.filter((id) => !foundIds.has(id));
      if (invalidEdges.length > 0) {
        const {
          data: { user: actorUser },
        } = await supabase.auth.getUser();
        console.info(
          JSON.stringify({
            event: "openems.save.invalid_edges",
            microgrid_id: microgridId,
            actor_user_id: actorUser?.id ?? null,
            invalid_edges: invalidEdges,
            at: new Date().toISOString(),
          })
        );
        return NextResponse.json(
          {
            error:
              "Some edge IDs were not found on the backend. Remove or fix them before saving.",
            invalid_edges: invalidEdges,
          },
          { status: 400 }
        );
      }
    } catch (err) {
      // Step 5 is a pre-save gate — nothing is persisted on OpenEmsError.
      // Return 503 (not 200) so the client can distinguish pre-save failure
      // from step 7's post-save health reporting (which stays 200).
      if (err instanceof OpenEmsError) {
        let reason: "auth_failed" | "unreachable" | "unknown_error";
        let errorMsg: string;
        if (err.code === "OPENEMS_AUTH_FAILED") {
          reason = "auth_failed";
          errorMsg =
            "Authentication failed. Verify your AWS credentials and region (common cause: rotated access key).";
        } else if (err.code === "OPENEMS_REDIRECT") {
          // Reported as 'unreachable' — the discover-status CHECK constraint
          // (migration 00018) allows only the five existing values, and this
          // ticket adds no migration. The message carries the detail.
          reason = "unreachable";
          errorMsg = err.message;
        } else if (err.code === "OPENEMS_UNREACHABLE") {
          reason = "unreachable";
          errorMsg = `Could not reach OpenEMS Backend at ${backendUrl.trim()}. Check the URL and that the host is reachable from Vercel.`;
        } else {
          // Every remaining OpenEmsError already carries an operator-actionable
          // message; this branch used to replace all of them with a generic
          // string and leave the only copy of the cause in a server log (#325).
          //
          // `reason` stays `unknown_error` deliberately. It is persisted to
          // `ems_last_discover_status`, whose CHECK constraint (migration
          // 00018) permits five values; widening it needs a migration that is
          // out of this ticket's scope — the same boundary #318 documents.
          // The message carries the detail; the status stays lossy and tracked.
          //
          // What reaches here and what it tells the operator:
          //   OPENEMS_HTTP_ERROR          status + body — including an OpenEMS
          //                               auth failure, which arrives as 500
          //                               rather than 401
          //   OPENEMS_NOT_JSON            the URL is not a JSON-RPC API
          //                               (typically the OpenEMS UI)
          //   OPENEMS_INVALID_BACKEND_URL a stored URL failed sink-side checks
          //   OPENEMS_RPC_ERROR           the backend's own JSON-RPC error text
          reason = "unknown_error";
          errorMsg = err.message;
        }
        return NextResponse.json(
          { error: errorMsg, reason },
          { status: 503 }
        );
      }
      return NextResponse.json(
        {
          error: "Edge validation failed with an unexpected error. Check server logs.",
          reason: "unknown_error",
        },
        { status: 503 }
      );
    }
  }

  // ── Step 6: Transaction 1 — persist config ─────────────────────────────────
  //
  // We encrypt the AWS secret via a single RPC + a separate UPDATE. This is
  // two DB round-trips but only one committed transaction for the write
  // (the RPC is stateless). Discover runs in its own transaction below.

  let encryptedSecret: string | null = null;
  if (type === "cloud_aws" && secretAccessKey && !preserveExistingSecret) {
    const { data, error } = await supabase.rpc("fn_ems_encrypt_secret", {
      p_plaintext: secretAccessKey,
    });
    if (error || !data) {
      return NextResponse.json(
        {
          error: `Failed to encrypt secret: ${error?.message ?? "no data"}`,
        },
        { status: 500 }
      );
    }
    encryptedSecret = data as string;
  }

  // Same for the Basic password (#327). Encrypted through the same DEK path —
  // fn_ems_encrypt_secret is not AWS-specific, it encrypts a string.
  let encryptedBasicAuthPassword: string | null = null;
  if (
    type === "direct_url" &&
    basicAuthPassword &&
    !preserveExistingBasicAuthPassword
  ) {
    const { data, error } = await supabase.rpc("fn_ems_encrypt_secret", {
      p_plaintext: basicAuthPassword,
    });
    if (error || !data) {
      return NextResponse.json(
        {
          error: `Failed to encrypt password: ${error?.message ?? "no data"}`,
        },
        { status: 500 }
      );
    }
    encryptedBasicAuthPassword = data as string;
  }

  // Same for the bearer token (issue #4). Encrypted through the same DEK
  // path — fn_ems_encrypt_secret encrypts a string, whatever it is.
  let encryptedBearerToken: string | null = null;
  if (wantsBearer && bearerToken && !preserveExistingBearerToken) {
    const { data, error } = await supabase.rpc("fn_ems_encrypt_secret", {
      p_plaintext: bearerToken,
    });
    if (error || !data) {
      return NextResponse.json(
        {
          error: `Failed to encrypt token: ${error?.message ?? "no data"}`,
        },
        { status: 500 }
      );
    }
    encryptedBearerToken = data as string;
  }

  // Same for the Keycloak client secret. Encrypted through the same DEK
  // path. Only when the operator typed one and we are not preserving.
  let encryptedKeycloakClientSecret: string | null = null;
  if (wantsKeycloak && keycloakClientSecret && !preserveExistingKeycloakSecret) {
    const { data, error } = await supabase.rpc("fn_ems_encrypt_secret", {
      p_plaintext: keycloakClientSecret,
    });
    if (error || !data) {
      return NextResponse.json(
        {
          error: `Failed to encrypt client secret: ${error?.message ?? "no data"}`,
        },
        { status: 500 }
      );
    }
    encryptedKeycloakClientSecret = data as string;
  }

  // Build the UPDATE payload. When preserving the secret we OMIT the
  // ems_aws_secret_access_key_encrypted column entirely so the existing
  // ciphertext is left untouched. Omitting the column also prevents a
  // bytea round-trip encode/decode.
  const updatePayload: Record<string, unknown> = {
    ems_type: type,
    ems_backend_url: backendUrl.trim(),
    ems_aws_region: type === "cloud_aws" ? region : null,
    ems_aws_access_key_id: type === "cloud_aws" ? accessKeyId : null,
    ems_basic_auth_username:
      type === "direct_url" ? basicAuthUsername || null : null,
    ems_known_edge_ids: known_edge_ids,
  };
  if (!preserveExistingSecret) {
    updatePayload.ems_aws_secret_access_key_encrypted =
      type === "cloud_aws" ? encryptedSecret : null;
  }
  if (!preserveExistingBasicAuthPassword) {
    // Switching to cloud_aws, or clearing the username, nulls the password.
    // Leaving a stored credential behind a form that no longer shows it is
    // how an operator ends up unable to explain what their microgrid sends.
    updatePayload.ems_basic_auth_password_encrypted =
      type === "direct_url" && basicAuthUsername
        ? encryptedBasicAuthPassword
        : null;
  }
  if (!preserveExistingBearerToken) {
    // Same rule for the bearer token (issue #4): naming a new identity
    // (Basic fields, cloud_aws, or blank-everything without a stored token
    // to keep) clears it. Only an explicit new token — or a blank token
    // with no competing identity, handled by the preserve branch — keeps
    // bearer authentication in force.
    updatePayload.ems_bearer_token_encrypted =
      wantsBearer && bearerToken ? encryptedBearerToken : null;
  }
  // Keycloak triple: identifiers are set when named, cleared otherwise;
  // the secret follows the preserve/encrypt/clear rules like every other
  // stored secret. Naming any identity other than Keycloak clears the
  // whole triple — a credential left behind a form that no longer shows
  // it is how an operator ends up unable to explain what their microgrid
  // sends.
  updatePayload.ems_keycloak_token_url =
    wantsKeycloak ? (keycloakTokenUrl as string) : null;
  updatePayload.ems_keycloak_client_id =
    wantsKeycloak ? (keycloakClientId as string) : null;
  if (!preserveExistingKeycloakSecret) {
    updatePayload.ems_keycloak_client_secret_encrypted =
      wantsKeycloak && keycloakClientSecret ? encryptedKeycloakClientSecret : null;
  }

  const { error: updErr } = await supabase
    .from("microgrids")
    .update(updatePayload)
    .eq("id", microgridId);

  if (updErr) {
    if (
      updErr.code === "42501" ||
      updErr.message.includes("row-level security")
    ) {
      return NextResponse.json(
        { error: "You do not have permission to configure this microgrid." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      {
        error: scrubSecretValues(
          `Failed to persist config: ${updErr.message}`,
          {
            secretAccessKey,
            password: effectiveBasicAuthPassword,
            extra: [effectiveBearerToken, effectiveKeycloakClientSecret, effectiveKeycloakToken].filter(
              (value): value is string => typeof value === "string"
            ),
          }
        ),
      },
      { status: 500 }
    );
  }

  // ── Step 7: Transaction 2 — Discover ───────────────────────────────────────
  //
  // Pass known_edge_ids to getEdgesStatus instead of []. getEdgesStatus([])
  // returns {} on real OpenEMS backends (verified 2026-04-23 against Kisakye);
  // the known_edge_ids approach is the correct fix (#112).
  //
  // When known_edge_ids is empty, skip the RPC and return zero_edges immediately
  // (no edges declared yet — user must configure them via Reconfigure).
  //
  // If step 5 already fetched statuses (non-empty list path), reuse them to
  // avoid a second round-trip to the backend.
  let discoverStatus:
    | "success"
    | "auth_failed"
    | "unreachable"
    | "zero_edges"
    | "unknown_error" = "success";
  let discoverMessage = "";
  let discoveredEdges: Array<{
    openems_edge_id: string;
    name: string;
    metadata: Record<string, unknown>;
    alreadyLinked: boolean;
  }> = [];

  if (known_edge_ids.length === 0) {
    // Empty list — skip the RPC; surface as zero_edges.
    discoverStatus = "zero_edges";
    discoverMessage =
      "Saved. No edges declared yet — add some in Reconfigure → Known edge IDs to enable the Add Edge flow.";
  } else {
    try {
      const client = createOpenEmsClient(candidateConfig);
      // Reuse statuses from step 5 when available; otherwise re-fetch.
      const statuses = step5Statuses ?? await client.getEdgesStatus(known_edge_ids);
      if (statuses.length === 0) {
        discoverStatus = "zero_edges";
        discoverMessage =
          "Connected, but the OpenEMS Backend returned zero edges. Check that edges are registered under this backend.";
      } else {
        const prefetched = new Set<string>();
        const { data: existing } = await supabase
          .from("edges")
          .select("openems_edge_id")
          .eq("microgrid_id", microgridId);
        for (const e of existing ?? []) {
          if (e.openems_edge_id) prefetched.add(e.openems_edge_id);
        }

        discoveredEdges = statuses.map((s) => ({
          openems_edge_id: s.edgeId,
          name: s.edgeId, // Backend doesn't return a display name here; UI may enrich later.
          metadata: { online: s.online },
          alreadyLinked: prefetched.has(s.edgeId),
        }));

        const onlineCount = statuses.filter((s) => s.online).length;
        const offlineCount = statuses.length - onlineCount;
        const validatedCount = statuses.length;
        const totalCount = known_edge_ids.length;
        if (offlineCount > 0) {
          discoverMessage = `Connected. ${validatedCount} of ${totalCount} edge${totalCount === 1 ? "" : "s"} validated — ${offlineCount} offline.`;
        } else {
          discoverMessage = `Connected. ${validatedCount} of ${totalCount} edge${totalCount === 1 ? "" : "s"} validated.`;
        }
      }
    } catch (err) {
      if (err instanceof OpenEmsError) {
        if (err.code === "OPENEMS_AUTH_FAILED") {
          discoverStatus = "auth_failed";
          discoverMessage =
            "Authentication failed. Verify your AWS credentials and region (common cause: rotated access key).";
        } else if (err.code === "OPENEMS_REDIRECT") {
          // See the note in step 5 — no new status value without a migration.
          discoverStatus = "unreachable";
          discoverMessage = err.message;
        } else if (err.code === "OPENEMS_UNREACHABLE") {
          discoverStatus = "unreachable";
          discoverMessage = `Could not reach OpenEMS Backend at ${backendUrl.trim()}. Check the URL and that the host is reachable from Vercel.`;
        } else {
          // DO NOT change this to `err.message` without also scrubbing it.
          //
          // Unlike step 5 above — which returns its message to the caller and
          // exits — `discoverMessage` is PERSISTED to
          // `ems_last_discover_error`, and that column is in
          // MICROGRID_PUBLIC_COLUMNS, so anyone with org access reads it.
          //
          // Since #325 an OPENEMS_HTTP_ERROR message carries up to 500 bytes of
          // the backend's own response body, and since #327 `direct_url` sends
          // `Authorization: Basic …`. A backend whose error page echoes the
          // request would therefore put a credential into an org-readable
          // column. Today it cannot: this branch discards the message, and
          // `err.message` is used only for OPENEMS_REDIRECT below.
          //
          // Surfacing the real message here is a reasonable thing to want —
          // #318 covers the adjacent status problem. If you do it, route it
          // through `scrubSecretValues(msg, { secretAccessKey, password })`
          // first, with the literal values rather than a `Basic …` pattern: the
          // values catch the credential however the backend echoed it, the
          // pattern only catches the header form.
          discoverStatus = "unknown_error";
          discoverMessage =
            "Discover failed with an unexpected error. Check server logs.";
        }
      } else {
        discoverStatus = "unknown_error";
        discoverMessage =
          "Discover failed with an unexpected error. Check server logs.";
      }
    }
  }

  // Update health fields.
  //
  const { error: healthErr } = await supabase
    .from("microgrids")
    .update({
      ems_last_discover_at: new Date().toISOString(),
      ems_last_discover_status: discoverStatus,
      ems_last_discover_error:
        discoverStatus === "success" ? null : discoverMessage,
      ems_last_discover_count:
        discoverStatus === "success" ? discoveredEdges.length : null,
    })
    .eq("id", microgridId);

  if (healthErr) {
    // Non-fatal: save already succeeded; we log and continue.
    console.warn(
      `openems.save: failed to update health fields: ${healthErr.message}`
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  console.info(
    JSON.stringify(
      scrubSecretValues(
        {
          event: "openems.save_and_test",
          microgrid_id: microgridId,
          actor_user_id: user?.id ?? null,
          ems_type: type,
          known_edge_ids_count: known_edge_ids.length,
          result_status: discoverStatus,
          edge_count: discoveredEdges.length,
          duration_ms: Date.now() - startedAt,
          at: new Date().toISOString(),
        },
        {
          secretAccessKey,
          password: effectiveBasicAuthPassword,
          extra: [effectiveBearerToken, effectiveKeycloakClientSecret, effectiveKeycloakToken].filter(
            (value): value is string => typeof value === "string"
          ),
        }
      )
    )
  );

  return NextResponse.json(
    {
      status: discoverStatus,
      message: discoverMessage,
      edgeCount: discoveredEdges.length,
      edges: discoveredEdges,
    },
    { status: 200 }
  );
}
