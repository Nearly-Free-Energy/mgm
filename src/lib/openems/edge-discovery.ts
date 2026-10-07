import "server-only";

import type { OpenEmsClientConfig } from "./index";
import { OpenEmsError } from "./errors";
import { validateBackendUrl } from "./backend-url";

export type ListedEdge = { id: string; name: string; online: boolean };

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const TIMEOUT_MS = 10_000;

/** List edges through the same authenticated UI WebSocket used by OpenEMS UI.
 * Backend-to-backend `getEdgesStatus` cannot enumerate edges: it only probes
 * caller-supplied IDs. The WebSocket URL is derived from the validated REST
 * origin, so the stored credential never travels to a different host.
 */
export async function listOpenEmsEdges(
  config: OpenEmsClientConfig
): Promise<ListedEdge[]> {
  if (config.type !== "direct_url" || !config.username || !config.password) {
    throw new OpenEmsError(
      "Automatic edge discovery requires OpenEMS UI username and password authentication on this connection.",
      "OPENEMS_INVALID_CONFIG",
      400
    );
  }

  const checked = validateBackendUrl(config.url);
  if (!checked.ok) {
    throw new OpenEmsError(checked.error, "OPENEMS_INVALID_BACKEND_URL", 400);
  }
  const backend = new URL(checked.url);
  const websocketUrl = new URL("/openems-backend", backend);
  websocketUrl.protocol = backend.protocol === "https:" ? "wss:" : "ws:";

  return new Promise<ListedEdge[]>((resolve, reject) => {
    const socket = new WebSocket(websocketUrl);
    const edges: ListedEdge[] = [];
    let page = 0;
    let settled = false;
    let pendingId = crypto.randomUUID();
    const authId = pendingId;
    const timer = setTimeout(() => fail(new OpenEmsError(
      "OpenEMS edge discovery timed out", "OPENEMS_UNREACHABLE", 504
    )), TIMEOUT_MS);

    function finish(value: ListedEdge[]) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(value);
    }
    function fail(error: OpenEmsError) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      reject(error);
    }
    function send(method: string, params: Record<string, unknown>, id: string) {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    }

    socket.addEventListener("open", () => {
      send("authenticateWithPassword", {
        username: config.username,
        password: config.password,
      }, authId);
    });
    socket.addEventListener("message", (event) => {
      let response: unknown;
      try {
        response = JSON.parse(String(event.data));
      } catch {
        fail(new OpenEmsError("Invalid OpenEMS discovery response", "OPENEMS_INVALID_RESPONSE", 502));
        return;
      }
      if (!response || typeof response !== "object") return;
      const rpc = response as Record<string, unknown>;
      if (rpc.id !== pendingId) return; // ignore unsolicited updates
      if (rpc.error) {
        fail(new OpenEmsError(
          rpc.id === authId ? "OpenEMS UI authentication failed" : "OpenEMS denied edge listing",
          rpc.id === authId ? "OPENEMS_AUTH_FAILED" : "OPENEMS_INVALID_RESPONSE",
          rpc.id === authId ? 401 : 502
        ));
        return;
      }
      if (rpc.id === authId) {
        pendingId = crypto.randomUUID();
        send("getEdges", { page, limit: PAGE_SIZE }, pendingId);
        return;
      }
      const result = rpc.result as { edges?: unknown } | undefined;
      if (!Array.isArray(result?.edges)) {
        fail(new OpenEmsError("Invalid OpenEMS edge list", "OPENEMS_INVALID_RESPONSE", 502));
        return;
      }
      const rows = result.edges as unknown[];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const item = row as Record<string, unknown>;
        if (typeof item.id !== "string" || !item.id) continue;
        edges.push({
          id: item.id,
          name: typeof item.comment === "string" && item.comment.trim() ? item.comment : item.id,
          online: item.isOnline === true,
        });
      }
      if (rows.length < PAGE_SIZE) {
        finish(edges);
      } else if (++page >= MAX_PAGES) {
        fail(new OpenEmsError("OpenEMS edge list exceeded the discovery limit", "OPENEMS_INVALID_RESPONSE", 502));
      } else {
        pendingId = crypto.randomUUID();
        send("getEdges", { page, limit: PAGE_SIZE }, pendingId);
      }
    });
    socket.addEventListener("error", () => fail(new OpenEmsError(
      "Could not connect to OpenEMS UI WebSocket", "OPENEMS_UNREACHABLE", 502
    )));
    socket.addEventListener("close", () => {
      if (!settled) fail(new OpenEmsError(
        "OpenEMS UI WebSocket closed during discovery", "OPENEMS_UNREACHABLE", 502
      ));
    });
  });
}
