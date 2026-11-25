import "server-only";

/**
 * The views and watchers an assistant may read: ADR-007 decision 8
 * (docs/adr/ADR-007-agentic-operation-and-model-data-boundary.md, PR #261).
 *
 * A view or watcher may carry `agent: "read"` only while it is on this list
 * with its kind; the contribution check (host/server/contribution-schema.ts)
 * refuses the mark on anything else when the contribution registers. Being
 * listed does not lift that check's other refusals: a view or watcher of a
 * plugin whose reading is refused there (billing, payments, Pesapal, the
 * tenant app), a view whose path names a tenant, device or billing or
 * payment record, a view that takes signals, a view that declares a key
 * prefix, a tenant view and a view
 * reached from configure or system navigation are refused the mark whether
 * listed or not.
 *
 * The list is the review that no mechanical check can make: whether a view's
 * cells and fields carry only what ADR-007 decision 6 lets reach a model.
 * So each entry is added in its own pull request, reviewed by a code owner
 * of src/lib/gui/ against ADR-007 decisions 6 and 7, and that commit also
 * sets the mark on the view or watcher. Removing an entry removes the mark
 * in the same commit, or the contribution stops registering.
 *
 * It starts empty. ADR-007's first list (the view `metering.site-day`, the
 * watcher `metering.connection`, the investigation view, and on decision
 * 10's condition the tenant views `tenant.home`, `tenant.usage-month` and
 * `tenant.usage-day`) is added by A1's pull requests, one entry each, not
 * here. If ADR-007 decision 8 changes what an entry holds (it proposes
 * pinning each view's declaration), this type and the check change with it.
 */
export interface AssistantRead {
  kind: "view" | "watcher";
  id: string;
}

export const ASSISTANT_READS: readonly AssistantRead[] = [];
