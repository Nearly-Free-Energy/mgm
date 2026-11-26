/**
 * The only routes an agent client may call (RFC #259 § 2, ADR-008 decision
 * 6, ADR-007 decisions 1 and 4): the action catalog and the view route, each
 * read with GET. Middleware refuses an agent client every other request,
 * whatever its method, before any route runs (403 `agent_route_refused`),
 * and the GUI host's routes refuse it again unless they opt in
 * (openHostRequest in src/lib/gui/host/server/http.ts).
 *
 * What an agent may read through these two is narrower still: the catalog
 * gives it an organization's catalog only, never one for `entity=`, and the
 * view route only a view marked `agent: "read"`; both ask the assistant
 * plugin's gate once the organization is known, before any action's gate,
 * available() or view loader (assistantGate in
 * src/lib/gui/host/server/agent.ts).
 *
 * agent-routes.test.ts pins this list. Adding a route widens what an
 * assistant can reach on the person's behalf: it needs the same review as a
 * change to the data boundary (ADR-007 decision 6).
 */
export const AGENT_ROUTES: readonly Readonly<{ method: "GET"; path: string }>[] = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/gui/catalog" }),
  Object.freeze({ method: "GET", path: "/api/gui/view" }),
]);

/** True only for a request an agent client may make: an exact method and path on the list. */
export function isAgentRoute(method: string, pathname: string): boolean {
  return AGENT_ROUTES.some((route) => route.method === method && route.path === pathname);
}
