/**
 * No assistant reaches a person (`org.user`) through the host. A person's
 * steps name their address and role, which ADR-007 and #133's data boundary
 * keep from any model; buildActionCatalog's comment
 * (src/lib/gui/host/server/catalog.ts) says the same for the agent clients
 * that will reach the catalog. Until those clients reach the host (RFC #259
 * § 2, Track A), what reaches it on an assistant's behalf is a proposal (a
 * prepare with `provenance`) and a view marked `agent: "read"`. This holds
 * both against the registered surface of every plugin, so the line is held
 * by code and not only by that comment:
 *
 * - every action that names a person, by its target or a bound field, is
 *   human-only, and the host refuses to prepare it from any proposal,
 *   before it reads anyone;
 * - no view an assistant may read has a person in its path, and the host
 *   refuses to register one that does, even listed in ASSISTANT_READS.
 *
 * An agent client (RFC #259 § 2) is told apart from a browser session by
 * the `mgm_client_kind` claim #323's token hook writes, which only the
 * resolver reads (src/lib/runtime/caller.ts; #272). The catalog refuses it
 * `entity=org.user`, and prepare refuses it everything, before either reads
 * anyone. The last test fails when any other source under src/ reads that
 * claim, so a second reader is reviewed against this boundary, and on the
 * migration if the claim is renamed.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { User } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { hostContext } from "@/lib/gui/host/server/access";
import { buildActionCatalog } from "@/lib/gui/host/server/catalog";
import { parseContribution, SurfaceContributionError } from "@/lib/gui/host/server/contribution-schema";
import { prepareAction } from "@/lib/gui/host/server/prepare";
import type { ActionDef } from "@/lib/gui/surface";
import { MGM_BUNDLED_PLUGINS } from "@/lib/plugins/bundled";
import { BROWSER, type Caller } from "@/lib/runtime/caller";
import { getMgmRuntime, resetMgmRuntimeForTests } from "@/lib/runtime/root";
import type { UserRoleRecord } from "@/lib/types/domain";
import { ORGANIZATION_DIRECTORY_SURFACE, USER_KIND } from "../surface";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

afterAll(() => resetMgmRuntimeForTests());

const PERSON = "e7100000-0000-4000-8fff-000000000002";
const ORG = "e7100000-0000-4000-8000-000000000001";
const CALLER = { id: "e7100000-0000-4000-8fff-000000000001", email: "host@test.local" } as User;
const SUPER_ADMIN_ROW = { id: "r", user_id: CALLER.id, role: "super_admin", scope_type: "org", scope_id: null } as unknown as UserRoleRecord;

/** The kinds an action names: its target and every bound field's kind. */
const kindsOf = (def: ActionDef) => new Set([def.target, ...Object.values(def.bind.path ?? {}), ...Object.values(def.bind.body ?? {})]);

async function snapshot() {
  return (await getMgmRuntime()).mgmSurface.snapshot();
}

/** A context whose client throws on any use, so a refusal is shown to come before any read. */
function context(caller?: Caller) {
  const made = hostContext({ user: CALLER, roles: [SUPER_ADMIN_ROW] }, new Headers({ "accept-language": "en-GB" }), {
    newClient: async () => {
      throw new Error("the host read something before refusing the proposal");
    },
    makeFmt: (locale) => createFmt({ locale }),
    caller: caller ?? BROWSER,
  });
  if (!made.ok) throw new Error("fixture context refused");
  return made.ctx;
}

const PROPOSALS = [
  ["an assistant's proposal", { by: "assistant", proposal: "e7100000-0000-4000-8009-0000000000c1", at: "2026-11-09T08:00:00Z" }],
  ["a watcher's proposal", { by: "watcher", at: "2026-11-09T08:00:00Z" }],
] as const;

describe("a person (org.user) and assistants", () => {
  it("is named by the organization directory's person actions, and every action that names one is human-only", async () => {
    const naming = [...(await snapshot()).actions.values()].filter(({ def }) => kindsOf(def).has(USER_KIND));
    // The list is not empty, so the checks below are not vacuous.
    expect(naming.map(({ def }) => def.id).sort()).toEqual([
      "org.change-role",
      "org.remove-user",
      "org.resend-invite",
      "org.update-profile",
    ]);
    for (const { def } of naming) expect([def.id, def.humanOnly], def.id).toEqual([def.id, true]);
  });

  it.each(PROPOSALS)("cannot be acted on from %s: the host refuses to prepare it, reading nothing", async (_label, provenance) => {
    const naming = [...(await snapshot()).actions.values()].filter(({ def }) => kindsOf(def).has(USER_KIND));
    for (const { def } of naming) {
      const params = Object.fromEntries(
        [...Object.entries(def.bind.path ?? {}), ...Object.entries(def.bind.body ?? {})].map(([field, kind]) => [field, kind === USER_KIND ? PERSON : ORG]),
      );
      expect(await prepareAction(context(), { action: def.id, params, provenance }), def.id).toMatchObject({
        ok: false,
        status: 403,
        code: "gui_human_only",
      });
    }
  });

  it("is in the path of no view an assistant may read", async () => {
    const { views } = await snapshot();
    const readable = views.filter(({ def }) => def.agent === "read");
    for (const { def } of readable) expect(Object.values(def.params), def.id).not.toContain(USER_KIND);
  });

  // ASSISTANT_READS is empty today, so the check above has no view to look
  // at. This one does not depend on the list: a view of the organization
  // directory whose path names a person, marked and listed, is refused when
  // it registers, so no entry added to the list can let one through.
  it("is in the path of no view the host lets an assistant read, even one on the list", () => {
    const [today] = ORGANIZATION_DIRECTORY_SURFACE.views!;
    const view = (params: Record<string, string>) => ({ ...today, id: "org.person", path: "/settings/users/[id]", params, agent: "read" as const });
    const issues = (params: Record<string, string>) => {
      try {
        parseContribution({ ...ORGANIZATION_DIRECTORY_SURFACE, views: [view(params)] }, { plugins: MGM_BUNDLED_PLUGINS }, [{ kind: "view", id: "org.person", declares: { keys: [], ext: null }, links: [] }]);
      } catch (error) {
        if (error instanceof SurfaceContributionError) return error.issues.map((i) => i.message);
        throw error;
      }
      return [];
    };
    const refusal = `a view whose path names a ${USER_KIND} cannot be read by an assistant`;
    expect(issues({ id: USER_KIND })).toContain(refusal);
    // The same view about an organization is not refused for that reason, so
    // the refusal comes from the person in its path.
    expect(issues({ id: "organization" })).not.toContain(refusal);
  });

  it("is refused to an agent client by the catalog, for entity=org.user, and by prepare, reading nothing", async () => {
    const agent = context({ kind: "agent", clientId: "e7100000-0000-4000-8fff-0000000000c1" });
    expect(await buildActionCatalog(agent, { org: null, preferred: null, entities: [{ kind: USER_KIND, id: PERSON }] })).toMatchObject({
      ok: false,
      status: 403,
      code: "gui_agent_refused",
    });
    const naming = [...(await snapshot()).actions.values()].filter(({ def }) => kindsOf(def).has(USER_KIND));
    for (const { def } of naming) {
      const params = Object.fromEntries(
        [...Object.entries(def.bind.path ?? {}), ...Object.entries(def.bind.body ?? {})].map(([field, kind]) => [field, kind === USER_KIND ? PERSON : ORG]),
      );
      // With and without provenance: an agent client prepares nothing, not only proposals.
      for (const provenance of [undefined, PROPOSALS[0][1]]) {
        expect(await prepareAction(agent, { action: def.id, params, ...(provenance ? { provenance } : {}) }), def.id).toMatchObject({
          ok: false,
          status: 403,
          code: "gui_agent_refused",
        });
      }
    }
  });

  it("is told apart from a browser session only by the resolver, the one reader of the client-kind claim", () => {
    // #323's hook writes the claim; if it is renamed, revisit this test and the header.
    const migrations = path.join(REPO_ROOT, "supabase/migrations");
    const hook = readdirSync(migrations).filter((f) => f.endsWith(".sql") && readFileSync(path.join(migrations, f), "utf8").includes("{claims,mgm_client_kind}"));
    expect(hook.length, "no migration writes the mgm_client_kind claim any more").toBeGreaterThan(0);

    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && readFileSync(full, "utf8").includes("mgm_client_kind")) {
          readers.push(path.relative(REPO_ROOT, full));
        }
      }
    };
    walk(path.join(REPO_ROOT, "src"));
    // A new reader decides something by a client's kind: check it against
    // the test above and the header before listing it here.
    expect(readers).toEqual(["src/lib/runtime/caller.ts"]);
  });
});
