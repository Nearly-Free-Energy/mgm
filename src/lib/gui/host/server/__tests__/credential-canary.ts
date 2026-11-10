/**
 * The reusable part of the credential canary (credential-canary.db.test.ts):
 * stored credentials seeded with canary plaintexts through the database's own
 * encryption function, a scan of host output for any form of them, and a
 * loop that dispatches every view, prepares every action, or runs every
 * watcher and search in a surface snapshot.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { vi } from "vitest";
import type { EntityKind } from "../../../contract";
import { fillPath } from "../../shared/merge-actions";
import type { HostContext } from "../access";
import { hostOutcome } from "../http";
import { prepareAction } from "../prepare";
import { runSearch } from "../search";
import { collectSignals } from "../signals";
import type { SurfaceSnapshot } from "../surface-registry";
import { dispatchView } from "../view";

const NOWHERE = "http://127.0.0.1:9";

/**
 * One microgrid per way src/lib/openems/config.ts picks a credential, since a
 * microgrid reaches only one of them: Keycloak needs a token URL and client
 * id, a bearer token wins over Basic, and the AWS secret is read only for
 * cloud_aws. If config.ts changes that order, revisit these rows.
 */
export const OPENEMS_PATHS = {
  keycloak: ["ems_keycloak_client_secret_encrypted", { ems_type: "direct_url", ems_keycloak_token_url: `${NOWHERE}/token`, ems_keycloak_client_id: "canary" }],
  bearer: ["ems_bearer_token_encrypted", { ems_type: "direct_url" }],
  basic: ["ems_basic_auth_password_encrypted", { ems_type: "direct_url", ems_basic_auth_username: "canary" }],
  aws: ["ems_aws_secret_access_key_encrypted", { ems_type: "cloud_aws", ems_aws_region: "us-east-1", ems_aws_access_key_id: "AKIACANARY" }],
} as const;
export type OpenEmsPath = keyof typeof OPENEMS_PATHS;

/**
 * Every column that stores an encrypted credential, by table. The test
 * compares this with the `*_encrypted` columns in the generated types, so a
 * new credential column fails it until it is seeded here, as long as its
 * name ends in `_encrypted`; a credential stored under any other name must
 * be added here by hand.
 */
export const CREDENTIAL_COLUMNS = {
  microgrids: Object.values(OPENEMS_PATHS).map(([column]) => column),
  communities: ["payment_provider_secret_encrypted"],
  payment_merchant_accounts: ["secret_encrypted"],
} as const;

/** `table.column` for every `*_encrypted` column of a public table in database.gen.ts. */
export function encryptedColumnsInSchema(): string[] {
  const text = readFileSync(join(process.cwd(), "src", "lib", "types", "database.gen.ts"), "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((line, i) => line === "    Tables: {" && lines[i - 1] === "  public: {");
  const out: string[] = [];
  let table: string | undefined;
  let inRow = false;
  for (const line of lines.slice(start + 1)) {
    if (line === "    Views: {") break;
    const named = /^ {6}(\w+): \{$/.exec(line);
    if (named) table = named[1];
    else if (line === "        Row: {") inRow = true;
    else if (line === "        }") inRow = false;
    const column = inRow ? /^ {10}(\w+_encrypted)\??:/.exec(line)?.[1] : undefined;
    if (column && table) out.push(`${table}.${column}`);
  }
  return out.sort();
}

/** A seeded credential: `column` is `table.field`, stored in row `rowId`. */
export type Canary = { column: string; table: string; field: string; rowId: string; plaintext: string; ciphertext: string };
export type CanaryIds = { orgId: string; communityId: string; merchantId: string; microgridIds: Record<OpenEmsPath, string> };

/**
 * Seeds an organization, a community, one microgrid per OpenEMS credential
 * path and a merchant account. Each credential column holds a new canary,
 * `CANARY-<field>-<32 random hex>`, encrypted by fn_ems_encrypt_secret as the
 * routes that store them do. Every backend is an address nothing answers on.
 */
export async function seedCanaries(svc: SupabaseClient, ids: CanaryIds): Promise<Canary[]> {
  const canaries: Canary[] = [];
  const secret = async (table: string, field: string, rowId: string) => {
    const plaintext = `CANARY-${field}-${randomBytes(16).toString("hex")}`;
    const { data, error } = await svc.rpc("fn_ems_encrypt_secret", { p_plaintext: plaintext });
    if (error || typeof data !== "string") throw new Error(`[canary] encrypt ${table}.${field}: ${error?.message}`);
    canaries.push({ column: `${table}.${field}`, table, field, rowId, plaintext, ciphertext: data });
    return { [field]: data };
  };
  const rows: [string, Record<string, unknown>][] = [
    ["organizations", { id: ids.orgId, name: "GUI Canary Org" }],
    [
      "communities",
      {
        id: ids.communityId,
        org_id: ids.orgId,
        name: "GUI Canary Community",
        payment_provider: "pesapal",
        payment_provider_config: { consumer_key: "canary-consumer", sandbox: true },
        payment_last_configured_at: new Date().toISOString(),
        ...(await secret("communities", "payment_provider_secret_encrypted", ids.communityId)),
      },
    ],
  ];
  for (const [path, [field, config]] of Object.entries(OPENEMS_PATHS)) {
    const id = ids.microgridIds[path as OpenEmsPath];
    const row = { id, community_id: ids.communityId, name: `GUI Canary Microgrid ${path}`, currency: "UGX", ems_backend_url: NOWHERE, ...config };
    rows.push(["microgrids", { ...row, ...(await secret("microgrids", field, id)) }]);
  }
  rows.push([
    "payment_merchant_accounts",
    {
      id: ids.merchantId,
      org_id: ids.orgId,
      display_name: "GUI Canary Merchant",
      consumer_key: "canary-consumer",
      ...(await secret("payment_merchant_accounts", "secret_encrypted", ids.merchantId)),
    },
  ]);
  for (const [table, row] of rows) {
    const { error } = await svc.from(table).insert(row);
    if (error) throw new Error(`[canary] ${table}: ${error.message}`);
  }
  return canaries;
}

/**
 * The base64 of `bytes` at each of the three byte offsets it could start at
 * inside a longer value (such as `Basic base64(user:password)`), keeping only
 * the characters that depend on `bytes` alone.
 */
function base64Cores(bytes: Buffer, encoding: "base64" | "base64url"): string[] {
  return [0, 1, 2].map((k) => {
    const text = Buffer.concat([Buffer.alloc(k), bytes]).toString(encoding);
    return text.slice(Math.ceil((4 * k) / 3), 4 * Math.floor((k + bytes.length) / 3));
  });
}

/**
 * The forms of a canary the scan looks for: the plaintext, the first half of
 * its random part (a cut-off copy), its hex and base64, and the stored
 * ciphertext as hex and base64.
 */
export function formsOf(c: Pick<Canary, "plaintext" | "ciphertext">): string[] {
  const plain = Buffer.from(c.plaintext, "utf8");
  const random = c.plaintext.slice(c.plaintext.lastIndexOf("-") + 1);
  const cipherHex = c.ciphertext.startsWith("\\x") ? c.ciphertext.slice(2) : c.ciphertext;
  const cipher = Buffer.from(cipherHex, "hex");
  return [
    c.plaintext,
    random.slice(0, 16),
    plain.toString("hex"),
    cipherHex,
    ...[plain, cipher].flatMap((b) => [...base64Cores(b, "base64"), ...base64Cores(b, "base64url")]),
  ];
}

/** Throws, naming the column and form, when `text` contains any form of any canary. Case is ignored. */
export function assertNoCanary(text: string, canaries: readonly Canary[], where: string): void {
  const lower = text.toLowerCase();
  for (const c of canaries) {
    const found = formsOf(c).find((form) => lower.includes(form.toLowerCase()));
    if (found !== undefined) throw new Error(`${where}: output carries the ${c.column} canary (${found.slice(0, 24)}…)`);
  }
}

export type Dispatched = { id: string; href: string; status: number; output: string };
const LOGS = ["error", "warn", "log", "info"] as const;
const show = (arg: unknown) =>
  typeof arg === "string" ? arg : inspect(arg, { depth: Infinity, maxArrayLength: Infinity, maxStringLength: Infinity, breakLength: Infinity });

/** Every assignment of seeded rows to `kinds` (name → entity kind), or a throw naming a kind with no seeded row. */
function seededParams(ids: CanaryIds, kinds: Record<string, EntityKind>, what: string): Record<string, string>[] {
  const byKind: Partial<Record<EntityKind, string[]>> = {
    organization: [ids.orgId],
    community: [ids.communityId],
    microgrid: Object.values(ids.microgridIds),
  };
  let combos: Record<string, string>[] = [{}];
  for (const [name, kind] of Object.entries(kinds)) {
    const rows = byKind[kind];
    if (rows === undefined) throw new Error(`[canary] ${what}: no canary row for entity kind "${kind}"; seed one`);
    combos = combos.flatMap((c) => rows.map((id) => ({ ...c, [name]: id })));
  }
  return combos;
}

/**
 * Dispatches every view in `snapshot` once for each seeded row of the entity
 * kinds its path names (a view with no segments gets `?org=`), and returns
 * each response body as the route sends it, with whatever was logged to the
 * console meanwhile. `serve` must make the host's surfaceSnapshot() return
 * the snapshot it is given (null: stop), so the loop can count loader runs:
 * a view whose loader did not run, or whose path names a kind with no seeded
 * row, throws rather than passing unscanned.
 */
export async function dispatchEveryView(
  ctx: HostContext,
  snapshot: SurfaceSnapshot,
  ids: CanaryIds,
  serve: (snapshot: SurfaceSnapshot | null) => void,
): Promise<Dispatched[]> {
  const runs = new Map<string, number>();
  const views = snapshot.views.map(({ plugin, def }) => {
    const load = (async (req: unknown) => {
      runs.set(def.id, (runs.get(def.id) ?? 0) + 1);
      return (def.load as (r: unknown) => unknown)(req);
    }) as typeof def.load;
    return { plugin, def: { ...def, load } as typeof def };
  });
  const out: Dispatched[] = [];
  const spies = LOGS.map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
  serve({ ...snapshot, views });
  try {
    for (const { def } of snapshot.views) {
      for (const params of seededParams(ids, def.params, `view ${def.id}`)) {
        const path = fillPath(def.path, params);
        if (path === null) throw new Error(`[canary] view ${def.id}: path ${def.path} could not be filled`);
        const href = Object.keys(def.params).length === 0 ? `${path}?org=${ids.orgId}` : path;
        for (const spy of spies) spy.mockClear();
        const before = runs.get(def.id) ?? 0;
        const response = hostOutcome(await dispatchView(ctx, href));
        const body = await response.text();
        if ((runs.get(def.id) ?? 0) === before) throw new Error(`[canary] view ${def.id} (${href}): loader did not run: ${response.status} ${body}`);
        const logged = spies.flatMap((spy) => spy.mock.calls.flat().map(show));
        out.push({ id: def.id, href, status: response.status, output: [body, ...logged].join("\n") });
      }
    }
  } finally {
    serve(null);
    for (const spy of spies) spy.mockRestore();
  }
  return out;
}

/**
 * Prepares every action in `snapshot` once for each seeded row of the entity
 * kinds it binds, with no starting values, and returns each response body as
 * the route sends it, with whatever was logged meanwhile. `serve` works as
 * for dispatchEveryView. An action must get past its request check for at
 * least one row, and reach its own available() and prepare, where it has
 * them, for at least one row; otherwise the loop throws rather than passing
 * it unscanned.
 */
export async function prepareEveryAction(
  ctx: HostContext,
  snapshot: SurfaceSnapshot,
  ids: CanaryIds,
  serve: (snapshot: SurfaceSnapshot | null) => void,
): Promise<Dispatched[]> {
  const runs = new Map<string, number>();
  const count = <F extends (...args: never[]) => unknown>(key: string, fn: F | undefined): F | undefined =>
    fn && (((...args: Parameters<F>) => (runs.set(key, (runs.get(key) ?? 0) + 1), fn(...args))) as F);
  const actions = new Map(
    [...snapshot.actions].map(([id, { plugin, def }]) => {
      const counted = { ...def, prepare: count(`${id} prepare`, def.prepare), available: count(`${id} available()`, def.available) };
      return [id, { plugin, def: counted as typeof def }];
    }),
  );
  const out: Dispatched[] = [];
  const spies = LOGS.map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
  serve({ ...snapshot, actions });
  try {
    for (const [id, { def }] of snapshot.actions) {
      const kinds = { ...def.bind.path, ...def.bind.body };
      const first = out.length;
      for (const params of seededParams(ids, kinds, `action ${id}`)) {
        for (const spy of spies) spy.mockClear();
        const response = hostOutcome(await prepareAction(ctx, { action: id, params }));
        const logged = spies.flatMap((spy) => spy.mock.calls.flat().map(show));
        out.push({ id, href: `${def.method} ${fillPath(def.path, params)}`, status: response.status, output: [await response.text(), ...logged].join("\n") });
      }
      const last = `${out.at(-1)?.status} ${out.at(-1)?.output}`;
      if (out.slice(first).every((r) => r.status === 400)) throw new Error(`[canary] action ${id}: every request was refused: ${last}`);
      for (const [fn, has] of [["available()", def.available], ["prepare", def.prepare]] as const) {
        if (has && !runs.get(`${id} ${fn}`)) throw new Error(`[canary] action ${id}: ${fn} did not run: ${last}`);
      }
    }
  } finally {
    serve(null);
    for (const spy of spies) spy.mockRestore();
  }
  return out;
}

/**
 * Collects the signals of every watcher in `snapshot` for the seeded
 * organization, and runs every search of each prefix with `q`. Returns each
 * response body as the route sends it, with whatever was logged meanwhile.
 * `serve` works as for dispatchEveryView. A watcher or search that did not
 * run throws rather than passing unscanned.
 */
export async function collectEverySignalAndSearch(
  ctx: HostContext,
  snapshot: SurfaceSnapshot,
  ids: CanaryIds,
  serve: (snapshot: SurfaceSnapshot | null) => void,
  q = "ka",
): Promise<Dispatched[]> {
  const ran = new Set<string>();
  const signals = snapshot.signals.map((s) => ({ ...s, load: ((req) => (ran.add(`signals ${s.id}`), s.load(req))) as typeof s.load }));
  const search = snapshot.search.map((s, i) => ({ ...s, find: ((req, text) => (ran.add(`search ${i}`), s.find(req, text))) as typeof s.find }));
  const out: Dispatched[] = [];
  const spies = LOGS.map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
  const record = async (id: string, href: string, response: Response) => {
    const logged = spies.flatMap((spy) => spy.mock.calls.flat().map(show));
    out.push({ id, href, status: response.status, output: [await response.text(), ...logged].join("\n") });
    for (const spy of spies) spy.mockClear();
  };
  serve({ ...snapshot, signals, search });
  try {
    await record("signals", `/api/gui/signals?org=${ids.orgId}`, hostOutcome(await collectSignals(ctx, { requested: ids.orgId })));
    for (const prefix of ["@", "#"] as const) {
      if (!search.some((s) => s.prefix === prefix)) continue;
      const response = hostOutcome(await runSearch(ctx, { q, prefix, org: ids.orgId }));
      await record(`search ${prefix}`, `/api/gui/search?q=${q}&prefix=${encodeURIComponent(prefix)}`, response);
    }
  } finally {
    serve(null);
    for (const spy of spies) spy.mockRestore();
  }
  const last = `${out.at(-1)?.status} ${out.at(-1)?.output}`;
  for (const s of snapshot.signals) if (!ran.has(`signals ${s.id}`)) throw new Error(`[canary] watcher ${s.id} did not run: ${last}`);
  snapshot.search.forEach((s, i) => {
    if (!ran.has(`search ${i}`)) throw new Error(`[canary] search ${s.plugin} ${s.prefix} did not run: ${last}`);
  });
  return out;
}
