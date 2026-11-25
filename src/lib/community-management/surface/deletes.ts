import "server-only";

/**
 * The confirmation steps of community management's three deletes
 * (community.delete-community, community.delete-microgrid and
 * community.delete-tenant): each names the record and what goes with it,
 * and asks for its name typed, which the delete route checks again
 * (DeleteCommunityBody and its siblings in ../schemas.ts). Every read is
 * through the person's own client, so a record they cannot read is not
 * found.
 *
 * A community or microgrid holding billing the database keeps (a closed
 * period, or a draft with recorded payments) is refused here with the copy
 * the delete preview gives (keptBillingMessage), and a tenant with billing
 * history with the capability's copy (deleteTenantOperation), so the step
 * is not offered for a delete the route would refuse. Neither replaces the
 * route's own refusal: billing hidden from the person's client, or added
 * after this ran, still stops the delete there.
 */
import type { Ceremony } from "@/lib/gui/contract";
import type { Fmt, Loaded, SurfaceRequest } from "@/lib/gui/surface";
import { countEntityDescendants } from "@/lib/entity-descendants";
import type { DescendantCounts } from "@/lib/entity-descendants-types";
import { keptBillingCounts, keptBillingMessage } from "@/lib/entity-deletion/shared";

type Refusal = Extract<Loaded<never>, { ok: false }>;
type Input = { params: Record<string, string>; body?: unknown };

const unavailable = (what: string): Refusal => ({
  ok: false,
  status: 503,
  message: `Could not check the ${what} right now. Try again shortly.`,
});
/** The delete routes' own copy for a record with no name to type; if theirs changes, change this. */
const UNNAMED: Refusal = { ok: false, status: 409, message: "Unnamed entity cannot be typed-to-confirm." };

/** The counts a person reads before typing the name, each a fact when it is not zero. */
const COUNTED: readonly [key: string, label: string][] = [
  ["microgrids", "Microgrids"],
  ["edges", "Edges"],
  ["devices", "Devices"],
  ["tenants", "Tenants"],
  ["tenant_devices", "Tenant meter links"],
  ["tenant_access", "Tenant app access grants"],
  ["billing_periods_draft", "Draft billing periods"],
  ["billing_line_items", "Bills"],
  ["rate_schedules", "Rate schedules"],
  ["grid_tariffs", "Grid tariffs"],
  ["microgrid_savings_settings", "Savings settings"],
];

function countFacts(counts: DescendantCounts, fmt: Fmt): Ceremony["facts"] {
  const values = counts as unknown as Record<string, unknown>;
  return COUNTED.flatMap(([key, label]) => {
    const n = values[key];
    return typeof n === "number" && n > 0 ? [{ label, value: fmt.number(n) }] : [];
  });
}

async function prepareHierarchyDelete(
  req: SurfaceRequest,
  kind: "community" | "microgrid",
  id: string,
): Promise<Loaded<Ceremony>> {
  const table = kind === "community" ? "communities" : "microgrids";
  const { data: row, error } = await req.supabase
    .from(table)
    .select("id, name")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string | null }>();
  if (error) return unavailable(kind);
  if (!row) return { ok: false, status: 404, message: `This ${kind} could not be found.` };
  const name = row.name?.trim() ? row.name : null;
  if (name === null) return UNNAMED;

  let counts: DescendantCounts;
  try {
    counts = await countEntityDescendants(req.supabase, kind, id);
  } catch {
    return unavailable(kind);
  }
  const kept = keptBillingCounts(counts);
  if (kept) return { ok: false, status: 409, message: keptBillingMessage(kind, kept) };

  const drafts = counts.kind === "edge" ? 0 : counts.billing_periods_draft;
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: `Delete the ${kind} ${name} and everything in it. This cannot be undone.`,
      facts: [{ label: kind === "community" ? "Community" : "Microgrid", value: req.fmt.text(name) }, ...countFacts(counts, req.fmt)],
      warnings:
        drafts === 0
          ? []
          : drafts === 1
            ? ["Its draft billing period is deleted too, with its readings and bills."]
            : [`Its ${drafts} draft billing periods are deleted too, with their readings and bills.`],
      acknowledgements: [],
      typed: name,
    },
  };
}

/** community.delete-community's step: the community, what goes with it, and its name to type. */
export function prepareDeleteCommunity(req: SurfaceRequest, input: Input): Promise<Loaded<Ceremony>> {
  return prepareHierarchyDelete(req, "community", input.params.id);
}

/** community.delete-microgrid's step: the microgrid, what goes with it, and its name to type. */
export function prepareDeleteMicrogrid(req: SurfaceRequest, input: Input): Promise<Loaded<Ceremony>> {
  return prepareHierarchyDelete(req, "microgrid", input.params.id);
}

/**
 * The capability's copy for a tenant it will not delete
 * (deleteTenantOperation in ../operations/tenants.ts); if that changes,
 * change this.
 */
const BILLED: Refusal = {
  ok: false,
  status: 409,
  message: "Cannot delete a tenant with billing history. Unlink its meter instead.",
};

/**
 * community.delete-tenant's step: the tenant, its meter links and the
 * people who can open its pages, all of which go with it, and its name to
 * type. The tenant's name is shown to the staff member deleting it; the
 * action is human-only, so no assistant is shown it.
 */
export async function prepareDeleteTenant(req: SurfaceRequest, input: Input): Promise<Loaded<Ceremony>> {
  const id = input.params.id;
  const { data: tenant, error } = await req.supabase
    .from("tenants")
    .select("id, display_name")
    .eq("id", id)
    .maybeSingle<{ id: string; display_name: string | null }>();
  if (error) return unavailable("tenant");
  if (!tenant) return { ok: false, status: 404, message: "This tenant could not be found." };
  const name = tenant.display_name?.trim() ? tenant.display_name : null;
  if (name === null) return UNNAMED;

  const [bills, links, access] = await Promise.all([
    req.supabase.from("billing_line_items").select("id", { count: "exact", head: true }).eq("tenant_id", id),
    req.supabase.from("tenant_devices").select("id", { count: "exact", head: true }).eq("tenant_id", id),
    req.supabase.rpc("fn_tenant_access_count", { _tenant_ids: [id] }),
  ]);
  if (bills.error || links.error || access.error) return unavailable("tenant");
  if ((bills.count ?? 0) > 0) return BILLED;

  const people = typeof access.data === "number" ? access.data : 0;
  const facts: Ceremony["facts"] = [{ label: "Tenant", value: req.fmt.text(name) }];
  if ((links.count ?? 0) > 0) facts.push({ label: "Meter links", value: req.fmt.number(links.count ?? 0) });
  if (people > 0) facts.push({ label: "People with app access", value: req.fmt.number(people) });
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: `Delete the tenant ${name}, with its meter links. This cannot be undone.`,
      facts,
      warnings: people > 0 ? [`${people === 1 ? "One person loses" : `${people} people lose`} access to this unit's pages.`] : [],
      acknowledgements: [],
      typed: name,
    },
  };
}
