/**
 * credential-canary.db.test.ts — no stored credential reaches contributed output.
 *
 * Every encrypted credential column holds a canary, stored through
 * fn_ems_encrypt_secret. An org manager of that organization then gets every
 * view and prepares every action in the real root's snapshot, and no response
 * body or console line may carry any canary as plaintext, base64, hex or
 * stored ciphertext. Every view must be dispatched and its loader run, and
 * every action prepared and its own available() and prepare run, so a new
 * view or action is covered without editing this file. Self-tests prove the
 * scan and the loops catch a loader, prepare or available() that leaks any
 * decrypted canary.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import type { User } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";
import type { UserRoleRecord } from "@/lib/types/domain";
import type { SurfaceSnapshot } from "../surface-registry";

// Passes through to the real snapshot, except while dispatchEveryView serves one.
let served: SurfaceSnapshot | null = null;
const serve = (s: SurfaceSnapshot | null) => {
  served = s;
};
vi.mock("../snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../snapshot")>();
  return { surfaceSnapshot: async () => served ?? actual.surfaceSnapshot() };
});

import { getMgmRuntime } from "@/lib/runtime/root";
import type { ActionDef, ViewDef } from "../../../surface";
import { createFmt } from "../../../fmt";
import { hostContext } from "../access";
import {
  CREDENTIAL_COLUMNS,
  assertNoCanary,
  dispatchEveryView,
  encryptedColumnsInSchema,
  prepareEveryAction,
  seedCanaries,
  type Canary,
  type CanaryIds,
} from "./credential-canary";

const IDS: CanaryIds = {
  orgId: "e7400000-0000-4000-8000-000000000001",
  communityId: "e7400000-0000-4000-8001-000000000001",
  merchantId: "e7400000-0000-4000-8009-000000000001",
  microgridIds: {
    keycloak: "e7400000-0000-4000-8002-000000000001",
    bearer: "e7400000-0000-4000-8002-000000000002",
    basic: "e7400000-0000-4000-8002-000000000003",
    aws: "e7400000-0000-4000-8002-000000000004",
  },
};
const EMAIL = "gui-canary-manager@test.local";
const COLUMNS = Object.entries(CREDENTIAL_COLUMNS).flatMap(([t, cs]) => cs.map((c) => `${t}.${c}`));

let manager: TestUser;
let roles: UserRoleRecord[];
let canaries: Canary[];

const ctx = () => {
  const made = hostContext({ user: { id: manager.userId, email: EMAIL } as User, roles }, new Headers({ "accept-language": "en" }), {
    newClient: async () => manager.client,
    makeFmt: (locale) => createFmt({ locale }),
  });
  if (!made.ok) throw new Error("canary context refused");
  return made.ctx;
};

// payment_merchant_versions references organizations without ON DELETE
// CASCADE, so its rows go first, as in gate.db.test.ts; if that foreign key
// gains a cascade, this delete becomes a no-op.
async function cleanup() {
  const svc = await serviceClient();
  const { error } = await svc.from("payment_merchant_versions").delete().eq("org_id", IDS.orgId);
  if (error) throw new Error(`[cleanup] payment_merchant_versions: ${error.message}`);
  await cleanupTestData({ orgIds: [IDS.orgId], userEmails: [EMAIL] });
}

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  await cleanup();
  const svc = await serviceClient();
  canaries = await seedCanaries(svc, IDS);
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: IDS.orgId });
  const { data, error } = await svc.from("user_roles").select("*").eq("user_id", manager.userId);
  if (error || !data?.length) throw new Error(`[fixture] user_roles: ${error?.message ?? "none"}`);
  roles = data as UserRoleRecord[];
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  served = null;
  await cleanup();
  // cleanupTestData ignores a failed organization delete; live ciphertexts must not stay behind.
  const svc = await serviceClient();
  const org = await svc.from("organizations").select("id").eq("id", IDS.orgId);
  const merchant = await svc.from("payment_merchant_accounts").select("id").eq("id", IDS.merchantId);
  expect([org.error, org.data, merchant.error, merchant.data]).toEqual([null, [], null, []]);
}, 60_000);

/** A view at `path` whose loader returns `load()`; the leaking ones are the self-tests' loaders. */
const view = (id: string, path: string, params: Record<string, string>, load: () => unknown) => ({
  plugin: "metering" as const,
  def: {
    id,
    kind: "metrics",
    path,
    params,
    ...(params.id ? { entity: "id" } : {}),
    cost: "db",
    declares: { keys: ["soc"] },
    examples: [{ title: "Canary" }],
    load: async () => load(),
  } as unknown as ViewDef,
});
const surface = (views: ReturnType<typeof view>[]): SurfaceSnapshot => ({
  views,
  actions: new Map(),
  nav: [],
  signals: [],
  status: [],
  search: [],
  entities: new Map(),
  guis: [],
});
const ok = (label: string) => ({ ok: true, model: { title: "Canary", actions: [], body: { tiles: [{ key: "soc", label, value: { t: "text", text: "x" } }] } } });
const refuse = (message: string) => ({ ok: false, status: 503, message });
const atMicrogrid = (load: () => unknown) => surface([view("acme.canary", "/microgrids/[id]", { id: "microgrid" }, load)]);
const canary = (column: string) => canaries.find((c) => c.column === column)!;
const scanAll = (results: { output: string }[]) => () => results.forEach((r) => assertNoCanary(r.output, canaries, "self-test"));

/** A canary read back as a loader with the service role could: the stored row, decrypted. */
async function decrypted(c: Canary): Promise<string> {
  const svc = await serviceClient();
  const { data: row, error: readError } = await svc.from(c.table).select(c.field).eq("id", c.rowId).single();
  if (readError) throw new Error(`[self-test] read ${c.column}: ${readError.message}`);
  const stored = (row as unknown as Record<string, unknown>)[c.field];
  const { data, error } = await svc.rpc("fn_ems_decrypt_secret", { p_ciphertext: stored });
  if (error) throw new Error(`[self-test] decrypt ${c.column}: ${error.message}`);
  return data as string;
}

describe.skipIf(shouldSkip())("credential canary", () => {
  it("seeds every encrypted credential column the schema has", () => {
    expect(encryptedColumnsInSchema()).toEqual([...COLUMNS].sort());
    expect(canaries.map((c) => c.column).sort()).toEqual([...COLUMNS].sort());
  });

  it("no view in the real snapshot returns or logs a stored credential", async () => {
    const snapshot = (await getMgmRuntime()).mgmSurface.snapshot();
    const results = await dispatchEveryView(ctx(), snapshot, IDS, serve);
    expect(new Set(results.map((r) => r.id)).size).toBe(snapshot.views.length);
    for (const r of results) assertNoCanary(r.output, canaries, `${r.id} (${r.href}, ${r.status})`);
  });

  it("no action in the real snapshot returns or logs a stored credential when prepared", async () => {
    const snapshot = (await getMgmRuntime()).mgmSurface.snapshot();
    const results = await prepareEveryAction(ctx(), snapshot, IDS, serve);
    expect(new Set(results.map((r) => r.id)).size).toBe(snapshot.actions.size);
    for (const r of results) assertNoCanary(r.output, canaries, `${r.id} (${r.href}, ${r.status})`);
  });

  describe("self-test: the scan catches a prepare or available() that leaks a decrypted credential", () => {
    // A core plugin, so the gate passes and the action's own functions run.
    const action = (over: Record<string, unknown>) => ({
      plugin: "organization-directory" as const,
      def: {
        id: "acme.canary",
        title: "Canary",
        target: "microgrid",
        input: z.object({ note: z.string().optional() }),
        inputVersion: 1,
        path: "/api/microgrids/[id]",
        method: "PATCH",
        bind: { path: { id: "microgrid" } },
        risk: "write",
        confirm: "confirm",
        humanOnly: false,
        ...over,
      } as unknown as ActionDef,
    });
    const actions = (a: ReturnType<typeof action>): SurfaceSnapshot => ({ ...surface([]), actions: new Map([[a.def.id, a]]) });
    const ceremony = (statement: string) => ({ ok: true, model: { type: "ceremony", statement, facts: [], warnings: [], acknowledgements: [] } });
    const basic = "microgrids.ems_basic_auth_password_encrypted";
    const scanPrepared = (results: { output: string }[]) => () => results.forEach((r) => assertNoCanary(r.output, canaries, "self-test"));

    it("passes a clean prepare at every seeded microgrid", async () => {
      const results = await prepareEveryAction(ctx(), actions(action({ prepare: async () => ceremony("Change it") })), IDS, serve);
      expect(results.map((r) => r.status)).toEqual(Object.values(IDS.microgridIds).map(() => 200));
      scanPrepared(results)();
    });

    const leaks: [string, (secret: string) => Record<string, unknown>][] = [
      ["a ceremony statement", (s) => ({ prepare: async () => ceremony(s) })],
      ["a refusal message from prepare", (s) => ({ prepare: async () => ({ ok: false, status: 409, message: `sent ${Buffer.from(s).toString("base64")}` }) })],
      ["available()'s reason", (s) => ({ available: async (_r: unknown, ids: string[]) => Object.fromEntries(ids.map((i) => [i, `hex ${Buffer.from(s).toString("hex")}`])) })],
      ["console.error in prepare", (s) => ({ prepare: async () => (console.error(`openems said ${s}`), ceremony("Change it")) })],
      [
        "available()'s reason, for an action that binds a body field and has no prepare",
        (s) => ({
          bind: { path: { id: "microgrid" }, body: { microgrid_id: "microgrid" } },
          input: z.object({ microgrid_id: z.uuid(), note: z.string().optional() }),
          available: async (_r: unknown, ids: string[]) => Object.fromEntries(ids.map((i) => [i, `sent ${s}`])),
        }),
      ],
    ];
    it.each(leaks)("%s", async (_name, leak) => {
      const secret = await decrypted(canary(basic));
      const results = await prepareEveryAction(ctx(), actions(action(leak(secret))), IDS, serve);
      expect(scanPrepared(results)).toThrow(basic);
    });

    it("refuses an action whose available() did not run", async () => {
      const fixture = actions(action({ path: "/api/microgrids/[id]/unreleased", available: async () => ({}) }));
      await expect(prepareEveryAction(ctx(), fixture, IDS, serve)).rejects.toThrow("available() did not run");
    });

    it("refuses an action whose prepare did not run", async () => {
      const fixture = actions(action({ prepare: async () => ceremony("x"), available: async (_r: unknown, ids: string[]) => Object.fromEntries(ids.map((i) => [i, "No"])) }));
      await expect(prepareEveryAction(ctx(), fixture, IDS, serve)).rejects.toThrow("prepare did not run");
    });
  });

  describe("self-test: the scan catches a loader that leaks a decrypted credential", () => {
    it("passes a clean view at every seeded microgrid", async () => {
      const results = await dispatchEveryView(ctx(), atMicrogrid(() => ok("Battery")), IDS, serve);
      expect(results.map((r) => [r.href, r.status])).toEqual(Object.values(IDS.microgridIds).map((id) => [`/microgrids/${id}`, 200]));
      scanAll(results)();
    });

    it.each(COLUMNS)("%s, stored and decrypted, is caught in a label", async (column) => {
      const secret = await decrypted(canary(column));
      expect(secret).toBe(canary(column).plaintext);
      const results = await dispatchEveryView(ctx(), atMicrogrid(() => ok(secret)), IDS, serve);
      expect(scanAll(results)).toThrow(column);
    });

    const basic = "microgrids.ems_basic_auth_password_encrypted";
    const header = (s: string) => `Basic ${Buffer.from(`canary:${s}`).toString("base64")}`;
    const leaks: [string, (secret: string) => unknown][] = [
      ["hex in a refusal message", (s) => refuse(`backend said ${Buffer.from(s).toString("hex")}`)],
      ["a Basic header in a label", (s) => ok(header(s))],
      ["a Basic header in a refusal message", (s) => refuse(`sent ${header(s)}`)],
      // view.ts keeps 300 characters of a refusal message: here, 20 of the 32 random ones.
      ["a refusal message cut off inside the secret", (s) => refuse(`${"x".repeat(280 - s.lastIndexOf("-") - 1)}${s}`)],
      ["the stored ciphertext in a label", () => ok(canary(basic).ciphertext)],
      ["console.error", (s) => (console.error(`openems said ${s}`), ok("Battery"))],
      ["console.warn", (s) => (console.warn(`openems said ${s}`), ok("Battery"))],
    ];
    it.each(leaks)("%s", async (_name, leak) => {
      const secret = await decrypted(canary(basic));
      const results = await dispatchEveryView(ctx(), atMicrogrid(() => leak(secret)), IDS, serve);
      expect(scanAll(results)).toThrow(basic);
    });

    it("dispatches every view, with ?org= on a view with no segments", async () => {
      const secret = await decrypted(canary(basic));
      const fixture = surface([
        view("acme.clean", "/microgrids/[id]", { id: "microgrid" }, () => ok("Battery")),
        view("acme.leak", "/microgrids", {}, () => ok(secret)),
      ]);
      const results = await dispatchEveryView(ctx(), fixture, IDS, serve);
      expect(new Set(results.map((r) => r.id)).size).toBe(fixture.views.length);
      expect(results.at(-1)).toMatchObject({ id: "acme.leak", href: `/microgrids?org=${IDS.orgId}`, status: 200 });
      expect(scanAll(results)).toThrow(basic);
    });

    it("refuses a view whose path names a kind with no seeded row", async () => {
      const fixture = surface([view("acme.house", "/households/[id]", { id: "household" }, () => ok("Battery"))]);
      await expect(dispatchEveryView(ctx(), fixture, IDS, serve)).rejects.toThrow('no canary row for entity kind "household"');
    });

    it("refuses a view whose loader did not run", async () => {
      const fixture = surface([view("acme.unreleased", "/canary-unreleased", {}, () => ok("Battery"))]);
      await expect(dispatchEveryView(ctx(), fixture, IDS, serve)).rejects.toThrow("loader did not run");
    });
  });
});
