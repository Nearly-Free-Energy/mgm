/**
 * POST /api/gui/prepare: the session is checked before the body is read or
 * the GUI surface is looked at, every answer is uncacheable JSON, and with
 * no capability contributing an action yet every action is a 404.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

let user: { id: string; email: string } | null;
let roles: { role: string; scope_type: string; scope_id: string | null }[];
const client = () => {
  const chain: Record<string, unknown> = {
    then: (resolve: (r: unknown) => unknown) => Promise.resolve({ data: roles, error: null }).then(resolve),
  };
  for (const op of ["select", "eq", "returns", "order"]) chain[op] = () => chain;
  return { auth: { getUser: async () => ({ data: { user } }) }, from: () => chain };
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client() }));
const surfaceSnapshot = vi.fn();
vi.mock("@/lib/gui/host/server/snapshot", () => ({ surfaceSnapshot: () => surfaceSnapshot() }));

import { POST } from "../route";

const ORG = "e7100000-0000-4000-8003-000000000001";
const MG = "e7100000-0000-4000-8003-0000000000b1";
let bodyRead: boolean;
function post(body: string) {
  const request = new NextRequest("http://localhost/api/gui/prepare", { method: "POST", body });
  const read = request.body!.getReader.bind(request.body);
  bodyRead = false;
  request.body!.getReader = ((...args: Parameters<typeof read>) => ((bodyRead = true), read(...args))) as typeof read;
  return POST(request);
}
const valid = JSON.stringify({ action: "metering.backend", params: { id: MG } });

beforeEach(() => {
  user = { id: "e7100000-0000-4000-8003-0000000000aa", email: "m@test.local" };
  roles = [{ role: "org_manager", scope_type: "org", scope_id: ORG }];
  surfaceSnapshot.mockReset().mockResolvedValue({
    views: [],
    actions: new Map(),
    nav: [],
    signals: [],
    status: [],
    search: [],
    entities: new Map(),
    guis: [],
  });
});

async function expectFailure(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store, private");
  expect(await res.json()).toMatchObject({ type: "result", ok: false, status, code });
}

describe("POST /api/gui/prepare", () => {
  it("answers 401 without a session, before reading the body or the GUI surface", async () => {
    user = null;
    await expectFailure(await post(valid), 401, "gui_unauthenticated");
    expect(bodyRead).toBe(false);
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers 403 to a person with no role", async () => {
    roles = [];
    await expectFailure(await post(valid), 403, "gui_no_access");
    expect(bodyRead).toBe(false);
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON or not a prepare request", async () => {
    await expectFailure(await post("{"), 400, "gui_bad_request");
    await expectFailure(await post(JSON.stringify({ action: "metering.backend", params: {}, extra: true })), 400, "gui_bad_request");
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers 413 for a body over 16 KB", async () => {
    await expectFailure(await post(JSON.stringify({ pad: "x".repeat(16 * 1024) })), 413, "gui_body_too_large");
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers 404 for an action no plugin contributes", async () => {
    await expectFailure(await post(valid), 404, "gui_not_found");
    expect(bodyRead).toBe(true);
    expect(surfaceSnapshot).toHaveBeenCalledOnce();
  });
});
