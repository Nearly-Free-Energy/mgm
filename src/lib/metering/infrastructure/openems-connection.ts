/**
 * OpenEMS implementation of `MeteringConnection`.
 *
 * Composition-root module: the ONLY place (besides the pre-existing
 * openems-backend save/discover routes) allowed to construct OpenEMS
 * clients from stored or candidate configs. OpenEMS identifiers, channel
 * mapping, and error codes never leave this module untranslated — callers
 * see `ConnectionTestResult` / `DiscoveredMeter` shapes only.
 *
 * Candidate configs may carry plaintext secrets in memory for a single
 * test call. They are never logged, persisted, or returned. Structured
 * logging here carries edge counts and durations only.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createOpenEmsClient,
  OpenEmsError,
  type OpenEmsClientConfig,
} from "@/lib/openems";
import { getMicrogridEmsConfig } from "@/lib/openems/config";
import { validateBackendUrl } from "@/lib/openems/backend-url";
import { MeteringError } from "../errors";
import type {
  MeteringConnection,
  StoredConnectionCandidate,
} from "../repository";
import type { ConnectionTestResult } from "../types";
import type { MeteringRepository } from "../repository";

function toConnectionTestResult(
  edgeCount: number,
  edges: { id: string; name: string }[]
): ConnectionTestResult {
  return { ok: true, edgeCount, edges };
}

function translateTestError(error: OpenEmsError): ConnectionTestResult {
  if (
    error.code === "OPENEMS_AUTH_FAILED" ||
    error.code === "OPENEMS_FORBIDDEN"
  ) {
    return {
      ok: false,
      code: "auth_failed",
      message:
        "Authentication failed or the identity is not authorized for reads. Verify the credentials and that the identity has read access.",
    };
  }
  if (
    error.code === "OPENEMS_INVALID_BACKEND_URL" ||
    error.code === "OPENEMS_INVALID_CONFIG"
  ) {
    return { ok: false, code: "invalid_config", message: error.message };
  }
  return {
    ok: false,
    code: "unreachable",
    message: `Could not reach the OpenEMS backend: ${error.message}`,
  };
}

async function candidateToConfig(
  candidate: StoredConnectionCandidate
): Promise<OpenEmsClientConfig> {
  const urlCheck = validateBackendUrl(candidate.backendUrl);
  if (!urlCheck.ok) {
    throw new MeteringError(urlCheck.error, "METERING_CONFIGURATION", 422);
  }
  if (candidate.type === "cloud_aws") {
    if (!candidate.region || !candidate.accessKeyId || !candidate.secretAccessKey) {
      throw new MeteringError(
        "type='cloud_aws' requires region, accessKeyId, and secretAccessKey.",
        "METERING_CONFIGURATION",
        422
      );
    }
    return {
      type: "cloud_aws",
      url: candidate.backendUrl.trim(),
      region: candidate.region,
      accessKeyId: candidate.accessKeyId,
      secretAccessKey: candidate.secretAccessKey,
    };
  }
  if (candidate.type !== "direct_url") {
    throw new MeteringError(
      "type must be 'cloud_aws' or 'direct_url'.",
      "METERING_CONFIGURATION",
      422
    );
  }
  if (
    Boolean(candidate.basicAuthUsername) !== Boolean(candidate.basicAuthPassword)
  ) {
    throw new MeteringError(
      "basicAuthUsername and basicAuthPassword must be set together.",
      "METERING_CONFIGURATION",
      422
    );
  }
  const bearerToken =
    typeof candidate.bearerToken === "string" && candidate.bearerToken.trim()
      ? candidate.bearerToken
      : null;
  if (
    bearerToken &&
    (candidate.basicAuthUsername || candidate.basicAuthPassword)
  ) {
    throw new MeteringError(
      "Use either a bearer token or a username/password pair, not both.",
      "METERING_CONFIGURATION",
      422
    );
  }
  // Keycloak client-credentials (issue #4 follow-up): all-or-nothing, and
  // mutually exclusive with the static identities — same rule as the save
  // route, so a passing test never precedes a rejected save.
  const asText = (value: string | null | undefined): string | null =>
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  const keycloakTokenUrl = asText(candidate.keycloakTokenUrl);
  const keycloakClientId = asText(candidate.keycloakClientId);
  const keycloakClientSecret = asText(candidate.keycloakClientSecret);
  const keycloakParts = [
    keycloakTokenUrl,
    keycloakClientId,
    keycloakClientSecret,
  ].filter(Boolean).length;
  if (keycloakParts > 0 && keycloakParts < 3) {
    throw new MeteringError(
      "keycloakTokenUrl, keycloakClientId, and keycloakClientSecret must be set together.",
      "METERING_CONFIGURATION",
      422
    );
  }
  if (
    keycloakParts === 3 &&
    (bearerToken || candidate.basicAuthUsername || candidate.basicAuthPassword)
  ) {
    throw new MeteringError(
      "Use one identity only: Keycloak, a bearer token, or a username/password pair — not a mix.",
      "METERING_CONFIGURATION",
      422
    );
  }
  if (keycloakParts === 3) {
    // A candidate that names Keycloak proves itself against the real IdP:
    // the obtained token is built into the in-memory client below, never
    // logged, never persisted. IdP failures surface as test results via
    // translateTestError, not exceptions.
    const { obtainKeycloakToken } = await import("@/lib/openems/keycloak");
    return {
      type: "direct_url",
      url: candidate.backendUrl.trim(),
      token: await obtainKeycloakToken({
        tokenUrl: keycloakTokenUrl as string,
        clientId: keycloakClientId as string,
        clientSecret: keycloakClientSecret as string,
      }),
    };
  }
  return {
    type: "direct_url",
    url: candidate.backendUrl.trim(),
    ...(bearerToken
      ? { token: bearerToken }
      : candidate.basicAuthUsername && candidate.basicAuthPassword
        ? {
            username: candidate.basicAuthUsername,
            password: candidate.basicAuthPassword,
          }
        : {}),
  };
}

export function createOpenEmsConnection(
  supabase: SupabaseClient,
  repo: MeteringRepository
): MeteringConnection {
  async function probe(
    config: OpenEmsClientConfig,
    edgeIds: string[]
  ): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    try {
      const client = createOpenEmsClient(config);
      // An empty edge list proves reachability + authorization (auth
      // failures throw) without asserting anything about inventory.
      const statuses = await client.getEdgesStatus(edgeIds);
      const edges = statuses.map((s) => ({ id: s.edgeId, name: s.edgeId }));
      console.info(
        JSON.stringify({
          event: "metering.connection_test",
          edge_count: edges.length,
          duration_ms: Date.now() - startedAt,
          at: new Date().toISOString(),
        })
      );
      return toConnectionTestResult(edges.length, edges);
    } catch (error) {
      if (error instanceof OpenEmsError) return translateTestError(error);
      if (error instanceof MeteringError) {
        return { ok: false, code: "invalid_config", message: error.message };
      }
      return {
        ok: false,
        code: "unreachable",
        message: "Could not reach the OpenEMS backend.",
      };
    }
  }

  return {
    async testStored(microgridId: string) {
      let config;
      try {
        config = await getMicrogridEmsConfig(supabase, microgridId);
      } catch (error) {
        if (error instanceof OpenEmsError) return translateTestError(error);
        throw error;
      }
      if (!config) {
        return {
          ok: false,
          code: "not_configured",
          message:
            "OpenEMS Backend not configured. Configure it first on the OpenEMS Backend tab.",
        };
      }
      const knownEdgeIds = await repo.getKnownEdgeIds(microgridId);
      return probe(config, knownEdgeIds);
    },

    async testCandidate(microgridId: string, candidate: StoredConnectionCandidate) {
      // Candidate secrets stay in memory for this call only: built into the
      // client, never logged, never persisted, never returned. Validation
      // failures return results rather than throwing, so callers treat all
      // outcomes uniformly.
      let config: OpenEmsClientConfig;
      try {
        config = await candidateToConfig(candidate);
      } catch (error) {
        if (error instanceof MeteringError) {
          return { ok: false, code: "invalid_config", message: error.message };
        }
        // A Keycloak candidate proves itself against the IdP while building
        // the config: a rejection or an unreachable token endpoint is a test
        // outcome, not a crash — translate it like any probe failure.
        if (error instanceof OpenEmsError) return translateTestError(error);
        throw error;
      }
      const knownEdgeIds = await repo.getKnownEdgeIds(microgridId);
      return probe(config, knownEdgeIds);
    },

    async discover(microgridId: string) {
      let config;
      try {
        config = await getMicrogridEmsConfig(supabase, microgridId);
      } catch (error) {
        if (error instanceof OpenEmsError) {
          throw new MeteringError(
            error.message,
            error.code === "OPENEMS_AUTH_FAILED" || error.code === "OPENEMS_FORBIDDEN"
              ? "METERING_UNAUTHORIZED"
              : "METERING_CONFIGURATION",
            error.statusCode
          );
        }
        throw error;
      }
      if (!config) {
        throw new MeteringError(
          "OpenEMS Backend not configured. Configure it first on the OpenEMS Backend tab.",
          "METERING_CONFIGURATION",
          409
        );
      }
      const client = createOpenEmsClient(config);
      const edges = await repo.getMicrogridEdges(microgridId);
      const out: {
        edgeId: string;
        online: boolean;
        components: { id: string; name: string }[];
      }[] = [];
      for (const edge of edges) {
        let edgeConfig = null;
        try {
          const statuses = await client.getEdgesStatus([edge.openemsEdgeId]);
          const online =
            statuses.find((s) => s.edgeId === edge.openemsEdgeId)?.online ?? false;
          edgeConfig = online
            ? await client.getEdgeConfig(edge.openemsEdgeId).catch(() => null)
            : null;
          out.push({
            edgeId: edge.openemsEdgeId,
            online,
            components: edgeConfig
              ? Object.entries(edgeConfig.components).map(([id, component]) => ({
                  id,
                  name: component.alias || id,
                }))
              : [],
          });
        } catch (error) {
          if (error instanceof OpenEmsError) {
            throw new MeteringError(
              error.message,
              "METERING_UNAVAILABLE",
              error.statusCode
            );
          }
          throw error;
        }
      }
      return out;
    },
  };
}
