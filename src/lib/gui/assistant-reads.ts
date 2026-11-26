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
 * A view's entry pins what was reviewed (ADR-007 decision 8): its declared
 * keys, its ext's schema id and the key paths of its ext schema
 * (extKeyPaths in host/server/contribution-schema.ts). The contribution
 * check refuses a marked view whose declaration differs from its entry, so
 * widening a listed view needs an edit here, reviewed like a new entry.
 * Write an entry's values literally, never imported from the view's plugin,
 * or the check would compare the view with itself. The entry also names the
 * link ids the view may hand an assistant and the ext paths an assistant
 * never receives, which the read interface (host/server/assistant-read.ts)
 * applies on every read. A watcher's entry pins only its id: a signal's
 * fields are fixed by the contract (SignalOut in ./surface.ts).
 *
 * ADR-007's first list is the view `metering.site-day`, the watcher
 * `metering.connection`, the investigation view, and on decision 10's
 * condition the tenant views `tenant.home`, `tenant.usage-month` and
 * `tenant.usage-day`; A1's pull requests add them, one entry each.
 */

/**
 * What a view's entry pins: its `declares.keys`, in any order, and its ext's
 * schema id with every key path of its zod schema, or null for a view with
 * no ext.
 */
export type ViewDeclaration = {
  keys: readonly string[];
  ext: { schema: string; paths: readonly string[] } | null;
};

export type AssistantRead =
  | { kind: "watcher"; id: string }
  | {
      kind: "view";
      id: string;
      declares: ViewDeclaration;
      /**
       * The only link ids the view may hand an assistant, each starting with
       * its plugin's alias. Any other link is dropped from the answer and
       * logged by id, not recorded in it, since whether a link is there can
       * depend on the data. Allowed by enumeration, so a link the view gains
       * later stays out until it is listed here.
       */
      links: readonly string[];
      /**
       * Ext paths an assistant never receives, each pinned in
       * `declares.ext.paths` and nullable, or else optional, wherever the
       * schema has it. Each is set to null, or removed, on every read, and
       * named in the answer's `withheld` whether or not it held anything.
       */
      withhold?: { ext: readonly string[] };
    };

export const ASSISTANT_READS: readonly AssistantRead[] = [];
