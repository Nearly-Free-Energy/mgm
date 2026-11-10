import "server-only";

/**
 * Search for interfaces (GET /api/gui/search): the person's query goes to
 * every contributed search of its prefix ("@" places and people, "#"
 * records) in their organization.
 *
 * Each search runs only while its plugin is enabled for the organization
 * (./gate-state.ts), on its own request and client of the person's session
 * (./access.ts), and within SEARCH_BUDGET_MS (./budget.ts). Its hits are
 * strictly parsed and must be of the kind it declares; a hit whose href is
 * not a released page is dropped. A search that is late, throws or breaks
 * the parse is left out, and only its plugin and the kind of miss are logged.
 */
import { z } from "zod";
import type { EntityHit } from "../../contract";
import { requireIssued, surfaceRequest, type HostContext } from "./access";
import { withinBudget } from "./budget";
import { pluginGate } from "./gate-state";
import { isPageHref } from "./hrefs";
import { entityHitSchema } from "./model-schema";
import { selectOrganization } from "./organization";
import { parseOrFail } from "./parse";
import { surfaceSnapshot } from "./snapshot";
import type { RegisteredSearch } from "./surface-registry";
import type { HostFailure, HostOutcome } from "./view";

export const SEARCH_BUDGET_MS = 1_000;
export const QUERY_LENGTH = { min: 2, max: 64 } as const;
/** How many hits the answer carries, from all searches together. */
export const MAX_HITS = 20;
const MAX_HITS_PER_SEARCH = 50;
const MAX_LABEL = 200;
const MAX_ID = 128;

const BAD_REQUEST: HostFailure = {
  ok: false,
  status: 400,
  code: "gui_bad_request",
  message: `Search for ${QUERY_LENGTH.min} to ${QUERY_LENGTH.max} characters after @ or #.`,
};

const querySchema = z.strictObject({
  q: z
    .string()
    .transform((q) => q.trim())
    .refine((q) => {
      const length = [...q].length;
      return length >= QUERY_LENGTH.min && length <= QUERY_LENGTH.max && !/[\u0000-\u001f\u007f]/.test(q);
    }),
  prefix: z.enum(["@", "#"]),
  // Not bounded, as for signals: pickOrganization (./organization.ts) ignores anything but a visible organization's id. Bound it if that changes.
  org: z.string().nullable(),
});

/** One search's hits, or null when it is late, throws or breaks the parse. */
async function find(ctx: HostContext, organizationId: string, entry: RegisteredSearch, q: string): Promise<EntityHit[] | null> {
  const out = await withinBudget(
    async () => entry.find(await surfaceRequest(ctx, organizationId, {}, new URLSearchParams()), q),
    SEARCH_BUDGET_MS,
  );
  if (!out.ok) {
    console.warn(`[gui] search ${entry.plugin} ${entry.prefix}: left out (${out.miss})`);
    return null;
  }
  const hit = entityHitSchema.refine((h) => h.kind === entry.entity && h.label.length <= MAX_LABEL && h.id.length <= MAX_ID);
  const parsed = parseOrFail(z.array(hit).max(MAX_HITS_PER_SEARCH), out.value, `search ${entry.plugin} ${entry.prefix}`);
  return parsed.ok ? parsed.value.filter((h) => isPageHref(h.href)) : null;
}

/**
 * Hits for `q` from every search of `prefix`, in the organization `org`
 * names when the person can see it, otherwise their first (./organization.ts).
 * Searches answer in registration order; a record two searches return is
 * kept once.
 */
export async function runSearch(
  ctx: HostContext,
  input: { q: string | null; prefix: string | null; org: string | null },
): Promise<HostOutcome<EntityHit[]>> {
  requireIssued(ctx);
  const query = querySchema.safeParse(input);
  if (!query.success) return BAD_REQUEST;
  const { q, prefix, org } = query.data;

  const snapshot = await surfaceSnapshot();
  let organizationId: string | null;
  try {
    organizationId = (await selectOrganization(ctx, { requested: org })).organizationId;
  } catch {
    return { ok: false, status: 503, code: "gui_unavailable", message: "Search is not available right now." };
  }
  if (organizationId === null) return { ok: false, status: 403, code: "gui_no_access", message: "Your account has no organization yet." };
  const orgId = organizationId;

  const gate = pluginGate(ctx, orgId);
  const answers = await Promise.all(
    snapshot.search
      .filter((entry) => entry.prefix === prefix)
      .map(async (entry) => ((await gate(entry.plugin).catch(() => null))?.ok ? find(ctx, orgId, entry, q) : null)),
  );
  const seen = new Set<string>();
  const hits: EntityHit[] = [];
  for (const hit of answers.flatMap((a) => a ?? [])) {
    const key = `${hit.kind} ${hit.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(hit);
  }
  return { ok: true, value: hits.slice(0, MAX_HITS) };
}
