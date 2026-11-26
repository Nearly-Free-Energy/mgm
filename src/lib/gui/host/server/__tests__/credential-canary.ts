/**
 * The reusable part of the credential canary (credential-canary.db.test.ts):
 * stored credentials seeded with canary plaintexts through the database's own
 * encryption function, a scan of host output for any form of them, and a
 * loop that dispatches every view, prepares every action, or runs every
 * watcher and search in a surface snapshot.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { vi } from "vitest";
import { SYNTHETIC_EDGE_ID_PREFIX } from "@/lib/metering/fixture-provider";
import { TENANT_APP_PLUGIN_NAME, TENANT_APP_PLUGIN_VERSION } from "@/lib/plugins/bundled";
import type { EntityKind } from "../../../contract";
import { fillPath } from "../../shared/merge-actions";
import type { HostContext } from "../access";
import { hostOutcome } from "../http";
import { prepareAction } from "../prepare";
import { runSearch } from "../search";
import { collectSignals } from "../signals";
import type { SurfaceSnapshot } from "../surface-registry";
import { dispatchView } from "../view";

// Port 9 answers nothing. The backend URL check (src/lib/openems/backend-url.ts)
// accepts localhost over http://, so the OpenEMS client is built and contacted
// with each decrypted credential; if that check changes, revisit.
export const NOWHERE = "http://localhost:9";

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
  organization_email_senders: ["password_encrypted"],
} as const;

/** The key column of a credential table whose key is not `id`. */
export const ROW_KEY: Readonly<Record<string, string>> = { organization_email_senders: "org_id" };

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
export type CanaryIds = {
  orgId: string;
  communityId: string;
  merchantId: string;
  microgridIds: Record<OpenEmsPath, string>;
  /** Served by the synthetic metering source while MGM_METERING_FIXTURES is on. */
  syntheticMicrogridId: string;
  /** One synthetic edge and one real one, which the synthetic source refuses. */
  mixedMicrogridId: string;
  /**
   * A draft billing period on the Basic path's microgrid, pinned to
   * `rateScheduleId`: a draft with one unpaid bill and no recorded payment,
   * so delete's available() and prepare run, and every bill action reaches
   * its own steps.
   */
  billingPeriodId: string;
  /** The period's pinned tariff. */
  rateScheduleId: string;
  /** A tenant of the Basic path's microgrid, with no meter. */
  tenantId: string;
  /** The period's one bill: the tenant's, unpaid, entered by hand, with a starting reading. */
  lineItemId: string;
  /**
   * An online payment attempt on the bill, through the canary merchant
   * account, held for reconciliation with a tracking id and a verified
   * receipt of the whole bill, so the bill attempts view, dispatched with
   * `?bill=` the bill (QUERY_KINDS), lists it, and both reconciliations
   * reach their own steps. It has no checkout URL or failure message;
   * bill-attempts.db.test.ts seeds its own attempt with those and checks
   * that they reach no output.
   */
  paymentAttemptId: string;
  /**
   * The Basic path's microgrid's edge and that edge's house meter, so each
   * action on an edge or a device (metering's) has a row to be prepared for.
   */
  edgeId: string;
  deviceId: string;
  /**
   * A person's access to `tenantId`'s pages: the id of their tenant role
   * row, which is the `community.tenant-access` entity the access removal's
   * path names, so its prepare runs. The test creates the person and the
   * row, since seedCanaries creates no account.
   */
  tenantAccessId: string;
  /**
   * One tenant unit per seeded microgrid, in canaryMicrogrids order: tenant
   * views are dispatched as a tenant holding every one of them. Each unit
   * has that microgrid's house meter (TENANT_METER_COMPONENT, on its first
   * edge) as its primary meter from 1 January 2026, so the tenant usage
   * views (RFC mgm#197 § 5) read it through the microgrid's metering source
   * with its stored credential, and the Operations day counts it as a house.
   */
  unitIds: readonly string[];
};

/**
 * The component id of each unit's house meter. Only that meter has it (the
 * site's battery and grid meter are ess0 and meter0), so a request for its
 * channel is the tenant usage views' read.
 */
export const TENANT_METER_COMPONENT = "meter1";

/** Every seeded microgrid: one per OpenEMS credential path, then the synthetic and mixed ones. */
export const canaryMicrogrids = (ids: CanaryIds): string[] => [
  ...Object.values(ids.microgridIds),
  ids.syntheticMicrogridId,
  ids.mixedMicrogridId,
];

/**
 * The ids `ids` gives more than once. Each seeded row needs its own: the
 * rows of one kind or table would otherwise collide, and seededParams keys
 * each row's parent by the row's id, so a repeated id leaves a parent out
 * without failing.
 */
export function repeatedCanaryIds(ids: CanaryIds): string[] {
  const all: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") all.push(value);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(ids);
  return [...new Set(all.filter((id, i) => all.indexOf(id) !== i))];
}

/**
 * Seeds an organization, a community, one microgrid per OpenEMS credential
 * path, a synthetic microgrid with the Basic path's configuration, a mixed
 * one with the bearer path's, and a merchant account. Each credential column holds a new canary,
 * `CANARY-<field>-<32 random hex>`, encrypted by fn_ems_encrypt_secret as the
 * routes that store them do. Every backend is an address nothing answers on.
 * Each microgrid has an edge with a battery and a grid meter, so a view that
 * reads the site reaches its metering source: the edges of the synthetic
 * microgrid carry the reserved `SYNTHETIC-EDGE-` id, the others a real-looking
 * one, and the mixed microgrid has one edge of each. The Basic path's edge
 * and its house meter take `edgeId` and `deviceId`. The Basic path's
 * microgrid also gets a tariff, a tenant with no meter and a draft billing
 * period pinned to that tariff: a draft with one unpaid bill and no recorded
 * payment, so delete's available() and prepare run, and every bill action
 * reaches its own steps; and an online payment attempt on that bill, held
 * for reconciliation, so the payment attempt actions reach theirs. The
 * organization's delete removes them with it (cleanupTestData purges an
 * organization whose payment records the database keeps).
 * The organization also gets an email sender (RFC #186) whose password is a
 * canary, a tenant unit on each microgrid (`unitIds`) linked to a house
 * meter on its first edge, and the tenant app turned on.
 */
export async function seedCanaries(svc: SupabaseClient, ids: CanaryIds): Promise<Canary[]> {
  const repeated = repeatedCanaryIds(ids);
  if (repeated.length > 0) throw new Error(`[canary] ids given to more than one row: ${repeated.join(", ")}`);
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
  const REAL = "CANARY-EDGE-";
  const microgrids: { id: string; name: string; edgePrefixes: string[]; path: OpenEmsPath }[] = [
    ...(Object.keys(OPENEMS_PATHS) as OpenEmsPath[]).map((path) => ({ id: ids.microgridIds[path], name: path, edgePrefixes: [REAL], path })),
    { id: ids.syntheticMicrogridId, name: "synthetic", edgePrefixes: [SYNTHETIC_EDGE_ID_PREFIX], path: "basic" },
    { id: ids.mixedMicrogridId, name: "mixed", edgePrefixes: [SYNTHETIC_EDGE_ID_PREFIX, REAL], path: "bearer" },
  ];
  const site: [string, Record<string, unknown>][] = [];
  /** Each microgrid's house meter, by microgrid id. */
  const houseMeters = new Map<string, string>();
  for (const { id, name, edgePrefixes, path } of microgrids) {
    const [field, config] = OPENEMS_PATHS[path];
    const row = { id, community_id: ids.communityId, name: `GUI Canary Microgrid ${name}`, currency: "UGX", timezone: "Africa/Kampala", ems_backend_url: NOWHERE, ...config };
    rows.push(["microgrids", { ...row, ...(await secret("microgrids", field, id)) }]);
    for (const edgePrefix of edgePrefixes) {
      const edge = id === ids.microgridIds.basic ? ids.edgeId : randomUUID();
      site.push(["edges", { id: edge, microgrid_id: id, name: `Canary edge ${edgePrefix}`, openems_edge_id: `${edgePrefix}${id}` }]);
      for (const [type, component] of [["battery", "ess0"], ["grid_meter", "meter0"]]) {
        site.push(["devices", { edge_id: edge, name: `Canary ${type}`, device_type: type, openems_component_id: component }]);
      }
      if (!houseMeters.has(id)) {
        const meter = id === ids.microgridIds.basic ? ids.deviceId : randomUUID();
        houseMeters.set(id, meter);
        site.push(["devices", { id: meter, edge_id: edge, name: "Canary house meter", device_type: "consumption_meter", openems_component_id: TENANT_METER_COMPONENT }]);
      }
    }
  }
  // The tariff before the period, which pins one on insert; set explicitly anyway.
  site.push([
    "rate_schedules",
    {
      id: ids.rateScheduleId,
      microgrid_id: ids.microgridIds.basic,
      tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 500 }],
      service_charge: 0,
      tax_rate: 0,
    },
  ]);
  site.push([
    "billing_periods",
    {
      id: ids.billingPeriodId,
      microgrid_id: ids.microgridIds.basic,
      start_date: "2026-10-01",
      end_date: "2026-10-31",
      status: "draft",
      timezone: "Africa/Kampala",
      rate_schedule_id: ids.rateScheduleId,
    },
  ]);
  site.push(["tenants", { id: ids.tenantId, microgrid_id: ids.microgridIds.basic, display_name: "GUI Canary Tenant", primary_phone: "+256700000999" }]);
  site.push([
    "billing_line_items",
    {
      id: ids.lineItemId,
      billing_period_id: ids.billingPeriodId,
      tenant_id: ids.tenantId,
      start_kwh: 0,
      end_kwh: 10,
      usage_kwh: 10,
      total_amount: 5000,
      reading_source: "manual",
    },
  ]);
  // After the bill and the merchant account it refers to (rows go in before site).
  site.push([
    "payment_attempts",
    {
      id: ids.paymentAttemptId,
      org_id: ids.orgId,
      line_item_id: ids.lineItemId,
      community_id: ids.communityId,
      merchant_account_id: ids.merchantId,
      merchant_account_version: 1,
      amount: 5000,
      currency: "UGX",
      bill_revision_total: 5000,
      merchant_reference: `MGM-${ids.paymentAttemptId}`,
      provider_tracking_id: "canary-tracking-id",
      status: "needs_reconciliation",
      failure_code: "balance_mismatch",
    },
  ]);
  // A verified receipt of the whole bill, so accepting exact receipts is available too.
  site.push([
    "payment_receipts",
    {
      org_id: ids.orgId,
      attempt_id: ids.paymentAttemptId,
      amount: 5000,
      currency: "UGX",
      provider: "pesapal",
      provider_status: "completed",
      provider_tracking_id: "canary-tracking-id",
      raw_payload: {},
    },
  ]);
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
  rows.push([
    "organization_email_senders",
    {
      org_id: ids.orgId,
      host: "smtp.canary.invalid",
      port: 587,
      username: "canary",
      from_address: "canary@canary.invalid",
      ...(await secret("organization_email_senders", "password_encrypted", ids.orgId)),
    },
  ]);
  const places = canaryMicrogrids(ids);
  if (ids.unitIds.length !== places.length) throw new Error("[canary] unitIds needs one unit per seeded microgrid");
  places.forEach((microgridId, i) => {
    site.push(["tenants", { id: ids.unitIds[i], microgrid_id: microgridId, display_name: `Canary unit ${i}`, primary_phone: "+256700000000" }]);
  });
  places.forEach((microgridId, i) => {
    site.push([
      "tenant_devices",
      { tenant_id: ids.unitIds[i], device_id: houseMeters.get(microgridId), role: "primary_consumption_meter", effective_from: "2026-01-01" },
    ]);
  });
  // The tenant app is off without a row (defaultEnabled in src/lib/plugins/bundled.ts),
  // so its views would stop at the gate's 409 before reading anything.
  site.push(["mgm_plugins", { org_id: ids.orgId, plugin_name: TENANT_APP_PLUGIN_NAME, version: TENANT_APP_PLUGIN_VERSION, enabled: true }]);
  for (const [table, row] of [...rows, ...site]) {
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

/**
 * Every assignment of seeded rows to `kinds` (name → entity kind), or a
 * throw naming a kind with no seeded row. Only nested assignments are kept:
 * where both a row's kind and its parent's kind are params (a period and its
 * microgrid), the two must be the seeded row and its own parent, since a
 * view answers 404 for a period under another microgrid before its loader
 * runs.
 */
function seededParams(ids: CanaryIds, kinds: Record<string, EntityKind>, what: string): Record<string, string>[] {
  const byKind: Partial<Record<EntityKind, string[]>> = {
    organization: [ids.orgId],
    community: [ids.communityId],
    microgrid: canaryMicrogrids(ids),
    billingPeriod: [ids.billingPeriodId],
    lineItem: [ids.lineItemId],
    tenant: [ids.tenantId],
    paymentAttempt: [ids.paymentAttemptId],
    edge: [ids.edgeId],
    device: [ids.deviceId],
    "community.tenant-access": [ids.tenantAccessId],
  };
  /** Each seeded row's parent, by the parent's kind. */
  const parentOf: Record<string, { kind: EntityKind; id: string }> = {
    [ids.billingPeriodId]: { kind: "microgrid", id: ids.microgridIds.basic },
    [ids.lineItemId]: { kind: "billingPeriod", id: ids.billingPeriodId },
    [ids.paymentAttemptId]: { kind: "lineItem", id: ids.lineItemId },
    [ids.tenantId]: { kind: "microgrid", id: ids.microgridIds.basic },
    [ids.edgeId]: { kind: "microgrid", id: ids.microgridIds.basic },
    [ids.deviceId]: { kind: "edge", id: ids.edgeId },
    [ids.tenantAccessId]: { kind: "tenant", id: ids.tenantId },
  };
  let combos: Record<string, string>[] = [{}];
  for (const [name, kind] of Object.entries(kinds)) {
    const rows = byKind[kind];
    if (rows === undefined) throw new Error(`[canary] ${what}: no canary row for entity kind "${kind}"; seed one`);
    combos = combos.flatMap((c) => rows.map((id) => ({ ...c, [name]: id })));
  }
  const names = Object.entries(kinds);
  return combos.filter((c) =>
    names.every(([name]) => {
      const parent = parentOf[c[name]];
      if (!parent) return true;
      return names.every(([other, kind]) => kind !== parent.kind || c[other] === parent.id);
    }),
  );
}

/**
 * The query parameters views declare (ViewDef.query), by the entity kind
 * their value names, or null for one that names no row (a day, a cursor).
 * A staff view is also dispatched once per seeded row of each kind here,
 * with that one parameter, so a loader's branch behind it is scanned too.
 * A view declaring a parameter missing here throws: a new one that names a
 * row gets its kind, so its branch does not go unscanned.
 */
const QUERY_KINDS: Readonly<Record<string, EntityKind | null>> = {
  bill: "lineItem",
  tenant_id: "tenant",
  date: null,
  before: null,
};

/**
 * Dispatches every view in `snapshot` once for each seeded row of the entity
 * kinds its path names (a view with no segments gets `?org=`), and again
 * with each query parameter that names a row (QUERY_KINDS) set to each
 * seeded row of its kind under the path's rows, and returns
 * each response body as the route sends it, with whatever was logged to the
 * console meanwhile. `serve` must make the host's surfaceSnapshot() return
 * the snapshot it is given (null: stop), so the loop can count loader runs:
 * a view whose loader did not run, or whose path names a kind with no seeded
 * row, throws rather than passing unscanned. A tenant view (scope "tenant")
 * is dispatched as `tenant`, a person holding every seeded unit, once per
 * unit with `?unit=`; without `tenant` it throws.
 */
export async function dispatchEveryView(
  ctx: HostContext,
  snapshot: SurfaceSnapshot,
  ids: CanaryIds,
  serve: (snapshot: SurfaceSnapshot | null) => void,
  tenant?: HostContext,
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
      const asTenant = def.scope === "tenant";
      if (asTenant && !tenant) throw new Error(`[canary] view ${def.id} is a tenant view: pass a tenant's context`);
      const filled = (params: Record<string, string>) => {
        const path = fillPath(def.path, params);
        if (path === null) throw new Error(`[canary] view ${def.id}: path ${def.path} could not be filled`);
        return path;
      };
      const queried = asTenant
        ? []
        : (def.query ?? []).flatMap((name) => {
            if (!(name in QUERY_KINDS)) throw new Error(`[canary] view ${def.id}: query parameter "${name}" is not in QUERY_KINDS; add it`);
            const kind = QUERY_KINDS[name];
            if (kind === null) return [];
            if (name in def.params) throw new Error(`[canary] view ${def.id}: query parameter "${name}" is also a path segment`);
            return seededParams(ids, { ...def.params, [name]: kind }, `view ${def.id}`).map((params) => {
              const { [name]: value, ...path } = params;
              return `${filled(path)}?${name}=${value}`;
            });
          });
      const hrefs = asTenant
        ? ids.unitIds.map((unit) => `${def.path}?unit=${unit}`)
        : [
            ...seededParams(ids, def.params, `view ${def.id}`).map((params) =>
              Object.keys(def.params).length === 0 ? `${filled(params)}?org=${ids.orgId}` : filled(params),
            ),
            ...queried,
          ];
      for (const href of hrefs) {
        for (const spy of spies) spy.mockClear();
        const before = runs.get(def.id) ?? 0;
        const response = hostOutcome(await dispatchView(asTenant ? tenant! : ctx, href));
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
