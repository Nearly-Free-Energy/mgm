import "server-only";

/**
 * The error codes of the described API (RFC #259 § 3), in one place, with
 * what each means and the HTTP statuses it comes with. Every MGM route
 * refuses in the `{ error, code }` shape; a client reads `code`, which is
 * stable, and shows `error`. The OpenAPI document (./openapi.ts) lists these
 * under `x-mgm-error-codes`, and names on each operation the ones its route
 * answers.
 *
 * - HOST_CODES: what the GUI host's routes (src/app/api/gui/) refuse with,
 *   in a HostFailureBody (../../contract.ts), and the reasons the action
 *   catalog gives for an action it cannot offer. error-codes.test.ts fails
 *   while a `gui_` code written in the host's server modules or routes is
 *   missing here, one here is written nowhere but here and in ./openapi.ts,
 *   or one is written beside a status not listed for it.
 * - GATE_CODES: the plugin gate's two refusals (src/lib/runtime/gate.ts),
 *   one code of each per non-core plugin, which a gated action route and the
 *   host answer with, and the catalog gives as reasons.
 * - BODY_CODES: the refusal of parseJsonBody (src/lib/validation/parse-body.ts),
 *   which every action's route parses its body with (gui-surface.test.ts,
 *   check 2).
 *
 * An action route's other refusals are its own, such as
 * `billing_period_not_found`, in the same shape. They are not listed here:
 * no field of an action says which codes its route answers. If ActionDef
 * (../../surface.ts) comes to declare them, list them from there.
 *
 * Codes the kit makes on the client for an interface (`cancelled`,
 * `gui_bad_action`, `gui_bad_href`) are never an HTTP answer, so they are not
 * here. Middleware's own refusals, a 401 with no code for a request with no
 * session and a plain-text 404 for a path not released, come before any
 * route and carry no code (src/middleware.ts); the document describes them
 * as responses.
 */
import type { MgmPluginName } from "@/lib/plugins/bundled";
import { codePrefix } from "@/lib/runtime/gate";
import type { AvailabilityCheck } from "../../contract";
import { TENANT_UNIT_PARAM } from "../shared/tenant-units";

export type CodeEntry = {
  /** The HTTP statuses a refusal with this code comes with; empty when it is only ever a catalog reason. */
  status: readonly number[];
  /** The checks the action catalog gives it as a reason for (CatalogAvailability in ../../contract.ts). */
  reasons?: readonly AvailabilityCheck[];
  meaning: string;
};

/** The GUI host's own codes. A new one goes here in the change that first answers it. */
export const HOST_CODES = {
  gui_action_refused: {
    status: [403, 409, 500, 503],
    meaning:
      "The action's own prepare refused it, for a reason other than not finding its record. The status and the message are the action's.",
  },
  gui_action_unavailable: {
    status: [409],
    reasons: ["state"],
    meaning: "The action's own available() said no for this record; the message says why.",
  },
  gui_availability_unchecked: {
    status: [],
    reasons: ["healthy"],
    meaning:
      "The action's available() was late, threw or gave no usable answer, so whether it can be sent for this record was not decided.",
  },
  gui_bad_request: {
    status: [400],
    meaning:
      "The query or the body breaks the route's rules: a parameter it does not take, one given twice or of the wrong form, or a body that is not JSON or not the request's shape.",
  },
  gui_body_too_large: {
    status: [413],
    meaning: "The request body is larger than the route reads.",
  },
  gui_human_only: {
    status: [403],
    meaning: "The action is human-only, and it was asked for as a proposal (with `provenance`).",
  },
  gui_manifest_failed: {
    status: [500],
    meaning: "The manifest could not be built, also when MGM_GUI names no interface this build serves.",
  },
  gui_no_access: {
    status: [403],
    meaning: "The person holds no role, or reaches no organization the answer needs.",
  },
  gui_not_found: {
    status: [404],
    meaning:
      "Nothing the person can see answers the request: an unknown view or action, or a record they cannot see. It does not say whether such a record exists.",
  },
  gui_not_released: {
    status: [404],
    reasons: ["installed"],
    meaning:
      "The page, or the action's route, is not part of the MGM release installed here. A tenant view is answered so while the tenant app is off for the unit's organization.",
  },
  gui_output_invalid: {
    status: [500],
    meaning: "What the host built, or what a contribution returned, broke the contract's schema, so none of it is sent.",
  },
  gui_prepare_failed: {
    status: [500],
    meaning: "The action's own prepare threw.",
  },
  gui_unauthenticated: {
    status: [401],
    meaning: "No signed-in person: Supabase Auth does not accept the session.",
  },
  gui_unavailable: {
    status: [503],
    meaning: "Something the answer needs could not be read right now. Nothing was written; try again.",
  },
  gui_unit_required: {
    status: [400],
    meaning: `A tenant view was asked for by a person with several units, naming none. Ask again with \`${TENANT_UNIT_PARAM}=<tenant id>\` in the page's query.`,
  },
  gui_view_failed: {
    status: [500],
    meaning: "The view's loader threw, or the view could not be completed.",
  },
  gui_view_refused: {
    status: [403, 409, 500, 503],
    meaning:
      "The view's loader refused, for a reason other than not finding its record. The status and the message are the loader's.",
  },
} as const satisfies Record<`gui_${string}`, CodeEntry>;

export type HostCode = keyof typeof HOST_CODES;

/**
 * The plugin gate's refusals of a write (and of a view that calls an outside
 * system), as `<plugin><suffix>`, the plugin's name with hyphens as
 * underscores (codePrefix in src/lib/runtime/gate.ts). error-codes.test.ts
 * asks the gate for both, so a change to the gate's codes fails there.
 */
export const GATE_CODES = {
  disabled: {
    suffix: "_disabled",
    status: [409],
    reasons: ["enabled"],
    meaning:
      "The plugin is off for the organization the request targets. Its records are kept, and it is turned on in Settings → Plugins.",
  },
  unavailable: {
    suffix: "_gate_unavailable",
    status: [503],
    reasons: ["healthy"],
    meaning: "Whether the plugin is on could not be read, so nothing was done. Try again.",
  },
} as const satisfies Record<string, CodeEntry & { suffix: string }>;

export type GateRefusal = keyof typeof GATE_CODES;

/** The code the gate refuses `plugin` with. */
export function gateCode(plugin: MgmPluginName, refusal: GateRefusal): string {
  return `${codePrefix(plugin)}${GATE_CODES[refusal].suffix}`;
}

/** parseJsonBody's refusal, which every action's route answers a body its input refuses with. */
export const BODY_CODES = {
  invalid_body: {
    status: [400],
    meaning:
      "The body is not JSON, or the action's input refuses it. `error` describes the first problem, and `field` names the top-level field it is in, when there is one.",
  },
} as const satisfies Record<string, CodeEntry>;

/** One code as the document lists it. */
export type ListedCode = CodeEntry & { code: string };

/**
 * Every host and body code above, and the gate's code for each plugin and
 * refusal in `gates`, each once, sorted by code: the list the OpenAPI
 * document publishes, given the gate refusals its routes answer.
 */
export function listedCodes(gates: Iterable<readonly [MgmPluginName, GateRefusal]>): ListedCode[] {
  const entry = (code: string, e: CodeEntry): ListedCode => ({
    code,
    status: [...e.status],
    ...(e.reasons ? { reasons: [...e.reasons] } : {}),
    meaning: e.meaning,
  });
  const gate = new Map([...gates].map(([plugin, refusal]) => [gateCode(plugin, refusal), entry(gateCode(plugin, refusal), GATE_CODES[refusal])]));
  const all = [
    ...Object.entries(HOST_CODES).map(([code, e]) => entry(code, e)),
    ...gate.values(),
    ...Object.entries(BODY_CODES).map(([code, e]) => entry(code, e)),
  ];
  return all.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}
