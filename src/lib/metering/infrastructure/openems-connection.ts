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

function candidateToConfig(
  candidate: StoredConnectionCandidate
): OpenEmsClientConfig {
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
  return {
    type: "direct_url",
    url: candidate.backendUrl.trim(),
    ...(candidate.basicAuthUsername && candidate.basicAuthPassword
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
      // client, never logged, never persisted, never returned.
      const config = candidateToConfig(candidate);
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
