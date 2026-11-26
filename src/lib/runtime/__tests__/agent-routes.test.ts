/**
 * The routes an agent client may call (RFC #259 § 2, ADR-008 decision 6),
 * pinned. Adding one widens what an assistant reaches on the person's
 * behalf, so it changes this test and is reviewed against ADR-007's data
 * boundary. Middleware refuses every other request (middleware.test.ts);
 * the GUI host's routes refuse it again unless they opt in, and the routes
 * that opt in must be exactly these.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_ROUTES, isAgentRoute } from "../agent-routes";

const REPO = path.resolve(__dirname, "../../../..");

function routeFiles(dir: string): string[] {
  return readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : routeFiles(rel);
    return entry.name === "route.ts" ? [rel] : [];
  });
}

describe("AGENT_ROUTES", () => {
  it("is the catalog and the view route, read with GET, and nothing else", () => {
    expect(AGENT_ROUTES).toEqual([
      { method: "GET", path: "/api/gui/catalog" },
      { method: "GET", path: "/api/gui/view" },
    ]);
    expect(Object.isFrozen(AGENT_ROUTES)).toBe(true);
  });

  it("matches only the exact method and path", () => {
    expect(isAgentRoute("GET", "/api/gui/view")).toBe(true);
    expect(isAgentRoute("GET", "/api/gui/catalog")).toBe(true);
    for (const [method, pathname] of [
      ["HEAD", "/api/gui/view"],
      ["POST", "/api/gui/view"],
      ["get", "/api/gui/view"],
      ["GET", "/api/gui/view/"],
      ["GET", "/api/gui/View"],
      ["GET", "/api/gui/prepare"],
      ["POST", "/api/gui/prepare"],
      ["GET", "/api/gui/manifest"],
      ["GET", "/api/gui/search"],
      ["GET", "/api/gui/signals"],
      ["GET", "/api/mgm/health"],
    ]) {
      expect(isAgentRoute(method, pathname), `${method} ${pathname}`).toBe(false);
    }
  });

  it("names exactly the routes that let an agent client into the GUI host", () => {
    const optedIn = routeFiles("src/app/api")
      .filter((file) => /openHostRequest\([^)]*agent:/.test(readFileSync(path.join(REPO, file), "utf8")))
      .map((file) => `/${path.dirname(file).replace(/^src\/app\//, "")}`);
    expect(optedIn.sort()).toEqual(AGENT_ROUTES.map((r) => r.path).sort());
    for (const route of AGENT_ROUTES) {
      const text = readFileSync(path.join(REPO, `src/app${route.path}/route.ts`), "utf8");
      expect(text, route.path).toMatch(new RegExp(`export async function ${route.method}\\(`));
    }
  });
});
