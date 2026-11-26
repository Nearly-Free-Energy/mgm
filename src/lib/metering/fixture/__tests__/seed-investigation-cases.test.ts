/**
 * The investigation seed (supabase/scripts/seed-investigation-cases.sql)
 * against the pins it restates, with no database: the regeneration test's
 * stubs and the seeded installation must come from one list
 * (`case-ids.ts` and `CASE_VARIANTS`), and the seed's plugin rows from the
 * plugin catalog. The SQL is read as text, as default-off-plugins.test.ts
 * reads the migrations; the Test job's rehearsal
 * (supabase/scripts/rehearse-investigation-seed.sql) runs it.
 *
 * A plugin added to the catalog fails here until the seed has a row for it
 * in both organizations and the rehearsal lists it: on in A unless it is the
 * tenant app, and in B on unless it is metering or depends on it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CASE_COMMUNITY_A,
  CASE_COMMUNITY_B,
  CASE_DEVICES,
  CASE_ORG_A,
  CASE_ORG_B,
  caseDeviceId,
  caseEdgeId,
  caseMicrogridId,
} from "../case-ids";
import { CASE_VARIANTS } from "../../__tests__/investigation-cases.pins";
import {
  METERING_PLUGIN_NAME,
  MGM_BUNDLED_PLUGINS,
  TENANT_APP_PLUGIN_NAME,
  type MgmPluginName,
} from "@/lib/plugins/bundled";

const ROOT = process.cwd();
const SEED_PATH = "supabase/scripts/seed-investigation-cases.sql";
const REHEARSAL_PATH = "supabase/scripts/rehearse-investigation-seed.sql";
const TEMPLATE_PATH = "supabase/migrations/00003_seed.sql.template";
const TRIGGER = "trg_device_openems_component_valid";

const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** The SQL without its full-line `--` comments, which name forbidden statements to forbid them. */
function withoutComments(sql: string): string {
  return sql.replace(/^\s*--.*$/gm, "");
}

const seedText = read(SEED_PATH);
const seed = withoutComments(seedText);
const rehearsal = withoutComments(read(REHEARSAL_PATH));

type Value = string | boolean | null;
type Row = Record<string, Value>;

/**
 * The rows of a `VALUES (…), (…);` list starting at `start`. Only plain
 * literals: single-quoted strings, NULL, true and false.
 */
function parseValues(sql: string, start: number): Value[][] {
  const rows: Value[][] = [];
  let i = start;
  const skipSpace = () => {
    while (i < sql.length && /\s/.test(sql[i])) i++;
  };
  for (;;) {
    skipSpace();
    if (sql[i] !== "(") throw new Error(`Expected "(" at ${i}: ${sql.slice(i, i + 40)}`);
    i++;
    const row: Value[] = [];
    for (;;) {
      skipSpace();
      if (sql[i] === "'") {
        let text = "";
        i++;
        for (;;) {
          if (sql[i] === "'" && sql[i + 1] === "'") {
            text += "'";
            i += 2;
          } else if (sql[i] === "'") {
            i++;
            break;
          } else {
            text += sql[i++];
          }
        }
        row.push(text);
      } else {
        const token = /^[A-Za-z]+/.exec(sql.slice(i))?.[0] ?? "";
        i += token.length;
        const word = token.toLowerCase();
        if (word === "null") row.push(null);
        else if (word === "true" || word === "false") row.push(word === "true");
        else throw new Error(`Not a plain literal at ${i}: ${sql.slice(i - token.length, i + 40)}`);
      }
      skipSpace();
      if (sql[i] === ",") {
        i++;
        continue;
      }
      if (sql[i] === ")") {
        i++;
        break;
      }
      throw new Error(`Expected "," or ")" at ${i}: ${sql.slice(i, i + 40)}`);
    }
    rows.push(row);
    skipSpace();
    if (sql[i] === ",") {
      i++;
      continue;
    }
    if (sql[i] === ";") return rows;
    throw new Error(`Expected "," or ";" at ${i}: ${sql.slice(i, i + 40)}`);
  }
}

type Insert = { index: number; rows: Row[] };

/** Every `INSERT INTO public.<table> (cols) VALUES …;` in the seed, in order. */
function inserts(table: string): Insert[] {
  const pattern = new RegExp(`INSERT INTO public\\.${table}\\s*\\(([^)]*)\\)\\s*VALUES`, "g");
  return [...seed.matchAll(pattern)].map((match) => {
    const columns = match[1].split(",").map((c) => c.trim());
    const rows = parseValues(seed, match.index + match[0].length).map((values) => {
      if (values.length !== columns.length) {
        throw new Error(`${table}: a row has ${values.length} values for ${columns.length} columns`);
      }
      return Object.fromEntries(columns.map((c, k) => [c, values[k]]));
    });
    return { index: match.index, rows };
  });
}

const rowsOf = (table: string) => inserts(table).flatMap((s) => s.rows);
const sortBy = <T>(items: T[], key: (item: T) => string) =>
  [...items].sort((a, b) => key(a).localeCompare(key(b)));

const NUMBERS = Object.keys(CASE_VARIANTS);
const communityOf = (nn: string) =>
  CASE_VARIANTS[nn].org === "B" ? CASE_COMMUNITY_B : CASE_COMMUNITY_A;

describe("the investigation seed's guards", () => {
  it("sets ON_ERROR_STOP before anything else", () => {
    const firstLine = seed.split("\n").find((line) => line.trim() !== "");
    expect(firstLine?.trim()).toBe("\\set ON_ERROR_STOP on");
  });

  it("checks the disposable flag, then the Vault opt-in, then the organizations, before any insert", () => {
    const positions = [
      seed.indexOf("\\set ON_ERROR_STOP on"),
      seed.indexOf("\\if :{?disposable}"),
      seed.indexOf("\\if :disposable"),
      seed.indexOf("vault.decrypted_secrets"),
      seed.indexOf("FROM public.organizations"),
      seed.indexOf("INSERT INTO"),
    ];
    expect(positions.every((p) => p >= 0), positions.join(", ")).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("refuses a missing or false disposable flag with \\quit, not an error", () => {
    const guard = seed.slice(seed.indexOf("\\if :{?disposable}"), seed.indexOf("vault.decrypted_secrets"));
    expect(guard.match(/\\else\s+\\echo Refusing[^\n]*\n\s*\\quit/g)).toHaveLength(2);
  });

  it("asks Vault for migration 00018's development marker", () => {
    expect(seed).toMatch(
      /FROM vault\.decrypted_secrets\s+WHERE name = 'mgm_allow_dev_credential_key' AND decrypted_secret = '1'/
    );
  });

  it("allows only 00003_seed.sql.template's sample organization besides its own", () => {
    const template = /INSERT INTO organizations\s*\([^)]*\)\s*VALUES\s*\(\s*'([^']+)'/.exec(read(TEMPLATE_PATH));
    expect(template, `${TEMPLATE_PATH} no longer inserts an organization`).not.toBeNull();
    const allowed = /WHERE id NOT IN \(([^)]*)\)/.exec(seed);
    expect(allowed).not.toBeNull();
    const ids = [...allowed![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(ids).toEqual([template![1], CASE_ORG_A, CASE_ORG_B].sort());
  });

  it("leaves the transaction to its caller", () => {
    expect(seed).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;/im);
  });
});

describe("the investigation seed's legacy rows", () => {
  const triggerStatements = [...seed.matchAll(/(ENABLE|DISABLE)\s+TRIGGER\s+(\w+)/gi)];

  it("touches only the component-id trigger: disabled once, then enabled", () => {
    expect(triggerStatements.map((m) => [m[1].toUpperCase(), m[2]])).toEqual([
      ["DISABLE", TRIGGER],
      ["ENABLE", TRIGGER],
    ]);
    expect(seed).not.toMatch(/DISABLE\s+TRIGGER\s+ALL/i);
    expect(seed).not.toMatch(/session_replication_role/i);
  });

  it("writes exactly CASE_VARIANTS' legacy rows, in one statement inside the same DO block as the trigger switch", () => {
    const [disable, enable] = triggerStatements.map((m) => m.index);
    const blockStart = seed.lastIndexOf("DO $$", disable);
    const blockEnd = seed.indexOf("END $$", disable);
    expect(blockStart).toBeGreaterThanOrEqual(0);
    expect(enable).toBeLessThan(blockEnd);

    const devices = inserts("devices");
    const inside = devices.filter((s) => s.index > disable && s.index < enable);
    expect(inside).toHaveLength(1);
    const expected = NUMBERS.flatMap((nn) => CASE_VARIANTS[nn].legacy.map((dd) => caseDeviceId(nn, dd))).sort();
    expect(inside[0].rows.map((r) => r.id).sort()).toEqual(expected);
    expect(inside[0].rows.every((r) => r.openems_component_id === null)).toBe(true);

    const outside = devices.filter((s) => s !== inside[0]).flatMap((s) => s.rows);
    expect(outside.filter((r) => r.openems_component_id === null)).toEqual([]);
  });

  it("is what the rehearsal checks", () => {
    const listed = /IF missing IS DISTINCT FROM\s*'([^']+)'/.exec(rehearsal);
    expect(listed).not.toBeNull();
    const expected = NUMBERS.flatMap((nn) => CASE_VARIANTS[nn].legacy.map((dd) => caseDeviceId(nn, dd))).sort();
    expect(listed![1].split(", ")).toEqual(expected);
  });
});

describe("the investigation seed's rows", () => {
  it("writes organizations A and B, one community each", () => {
    expect(rowsOf("organizations").map((r) => r.id).sort()).toEqual([CASE_ORG_A, CASE_ORG_B].sort());
    expect(sortBy(rowsOf("communities").map((r) => ({ id: r.id, org: r.org_id })), (r) => String(r.id))).toEqual(
      sortBy(
        [
          { id: CASE_COMMUNITY_A, org: CASE_ORG_A },
          { id: CASE_COMMUNITY_B, org: CASE_ORG_B },
        ],
        (r) => r.id
      )
    );
  });

  it("writes every case microgrid in its organization's community, with its variant's zone", () => {
    const actual = rowsOf("microgrids").map((r) => ({
      id: r.id,
      community: r.community_id,
      timezone: r.timezone,
    }));
    const expected = NUMBERS.map((nn) => ({
      id: caseMicrogridId(nn),
      community: communityOf(nn),
      timezone: CASE_VARIANTS[nn].zone,
    }));
    expect(sortBy(actual, (r) => String(r.id))).toEqual(sortBy(expected, (r) => r.id));
  });

  const edges = rowsOf("edges");
  const edgeById = new Map(edges.map((e) => [e.id as string, e]));

  it("writes each microgrid's synthetic edge and its variant's extra edges", () => {
    const actual = edges.map((e) => `${e.microgrid_id} ${e.openems_edge_id}`).sort();
    const expected = NUMBERS.flatMap((nn) =>
      [caseEdgeId(nn), ...CASE_VARIANTS[nn].extraEdges].map((edge) => `${caseMicrogridId(nn)} ${edge}`)
    ).sort();
    expect(actual).toEqual(expected);
  });

  it("writes the full device set on each synthetic edge, less what the variant omits", () => {
    const actual = rowsOf("devices").map((d) => {
      const edge = edgeById.get(d.edge_id as string);
      return {
        id: d.id,
        microgrid: edge?.microgrid_id,
        edge: edge?.openems_edge_id,
        type: d.device_type,
        componentId: d.openems_component_id,
      };
    });
    const expected = NUMBERS.flatMap((nn) =>
      CASE_DEVICES.filter((d) => !CASE_VARIANTS[nn].omit.includes(d.dd)).map((d) => ({
        id: caseDeviceId(nn, d.dd),
        microgrid: caseMicrogridId(nn),
        edge: caseEdgeId(nn),
        type: d.type,
        componentId: CASE_VARIANTS[nn].legacy.includes(d.dd) ? null : d.componentId,
      }))
    );
    expect(sortBy(actual, (d) => String(d.id))).toEqual(sortBy(expected, (d) => d.id));
  });

  it("links each tenant-linked meter to its unit on the same microgrid, from 2026-01-01, open-ended", () => {
    const tenants = new Map(rowsOf("tenants").map((t) => [t.id as string, t]));
    const actual = rowsOf("tenant_devices").map((l) => {
      const tenant = tenants.get(l.tenant_id as string);
      return {
        device: l.device_id,
        microgrid: tenant?.microgrid_id,
        unit: tenant?.display_name,
        role: l.role,
        from: l.effective_from,
        to: l.effective_to ?? null,
      };
    });
    const expected = NUMBERS.flatMap((nn) =>
      CASE_DEVICES.filter((d) => d.tenantLinked && !CASE_VARIANTS[nn].omit.includes(d.dd)).map((d) => ({
        device: caseDeviceId(nn, d.dd),
        microgrid: caseMicrogridId(nn),
        // §1 "Devices": meter 1n is Unit n's.
        unit: `Unit ${d.dd.slice(1)}`,
        role: "primary_consumption_meter",
        from: "2026-01-01",
        to: null,
      }))
    );
    expect(sortBy(actual, (l) => String(l.device))).toEqual(sortBy(expected, (l) => l.device));
    // Every unit has exactly one link.
    const linked = rowsOf("tenant_devices").map((l) => l.tenant_id).sort();
    expect(linked).toEqual([...tenants.keys()].sort());
  });

  it("makes one manager an org manager of both organizations", () => {
    const roles = rowsOf("user_roles");
    expect(new Set(roles.map((r) => r.user_id)).size).toBe(1);
    expect(roles.map((r) => `${r.role} ${r.scope_type} ${r.scope_id}`).sort()).toEqual(
      [`org_manager org ${CASE_ORG_A}`, `org_manager org ${CASE_ORG_B}`].sort()
    );
    expect(seed).toMatch(/'investigations-manager@example\.org'/);
  });
});

describe("the investigation seed's plugin states", () => {
  const rows = rowsOf("mgm_plugins");
  const byName = new Map(MGM_BUNDLED_PLUGINS.map((p) => [p.name, p]));

  /** Metering and every plugin that depends on it, directly or through another. */
  function meteringAndDependents(): Set<MgmPluginName> {
    const off = new Set<MgmPluginName>([METERING_PLUGIN_NAME]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const plugin of MGM_BUNDLED_PLUGINS) {
        if (!off.has(plugin.name) && plugin.dependencies.some((d) => off.has(d))) {
          off.add(plugin.name);
          grew = true;
        }
      }
    }
    return off;
  }

  const expectedOn: Record<string, (name: MgmPluginName) => boolean> = {
    [CASE_ORG_A]: (name) => name !== TENANT_APP_PLUGIN_NAME,
    [CASE_ORG_B]: (name) => !meteringAndDependents().has(name),
  };

  it.each([
    ["A", CASE_ORG_A],
    ["B", CASE_ORG_B],
  ])("organization %s has a row for every bundled plugin, at its catalog version", (_label, org) => {
    const own = rows.filter((r) => r.org_id === org);
    expect(own.map((r) => r.plugin_name).sort()).toEqual(MGM_BUNDLED_PLUGINS.map((p) => p.name).sort());
    for (const row of own) {
      expect(row.version, String(row.plugin_name)).toBe(byName.get(row.plugin_name as MgmPluginName)?.version);
    }
  });

  it.each([
    ["A", CASE_ORG_A],
    ["B", CASE_ORG_B],
  ])("organization %s has the plugins on that §1 lists, and their dependencies", (_label, org) => {
    const own = rows.filter((r) => r.org_id === org);
    for (const row of own) {
      expect(row.enabled, String(row.plugin_name)).toBe(expectedOn[org](row.plugin_name as MgmPluginName));
    }
    const on = new Set(own.filter((r) => r.enabled).map((r) => r.plugin_name));
    for (const name of on) {
      for (const dependency of byName.get(name as MgmPluginName)?.dependencies ?? []) {
        expect(on.has(dependency), `${name} is on without ${dependency}`).toBe(true);
      }
    }
  });

  it("is what the rehearsal checks", () => {
    const listed = [...rehearsal.matchAll(/\((org_[ab]),\s*'([^']+)',\s*(true|false)\)/g)].map(
      (m) => `${m[1] === "org_a" ? CASE_ORG_A : CASE_ORG_B} ${m[2]} ${m[3]}`
    );
    expect(listed.sort()).toEqual(rows.map((r) => `${r.org_id} ${r.plugin_name} ${r.enabled}`).sort());
  });
});

it("the seed's own header names the wrapper that runs it", () => {
  expect(seedText).toContain("scripts/seed-investigation-cases.sh");
});
