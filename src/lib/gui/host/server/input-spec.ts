import "server-only";

/**
 * The JSON Schema of an action's input, as the host serves it: in the
 * prepared action's spec (./prepare.ts), which a form is built from.
 *
 * Built on each call from the action's zod schema, with zod's default
 * `unrepresentable: "throw"`, so an input JSON Schema cannot describe throws
 * here rather than becoming an empty schema. The contribution check refuses
 * such an input when it is registered (./contribution-schema.ts), so a throw
 * here is a host bug. Nothing is cached between calls.
 */
import { z } from "zod";
import type { Json } from "../../contract";
import type { ActionDef } from "../../surface";

/**
 * The JSON Schema of the fields a person enters: the input's, with bound
 * fields and `confirmation` (sent by the host's confirmation step) removed.
 * writeOnly marks stay, so a form never prefills or shows a secret.
 */
export function describeInput(def: Pick<ActionDef, "input" | "bind">): Json {
  // Through JSON, so only JSON is kept: zod adds a non-enumerable "~standard" property.
  const schema = JSON.parse(JSON.stringify(z.toJSONSchema(def.input, { io: "input" }))) as Record<string, unknown>;
  const hidden = new Set([...Object.keys(def.bind.path ?? {}), ...Object.keys(def.bind.body ?? {}), "confirmation"]);
  if (schema.properties !== null && typeof schema.properties === "object") {
    schema.properties = Object.fromEntries(Object.entries(schema.properties).filter(([k]) => !hidden.has(k)));
  }
  if (Array.isArray(schema.required)) schema.required = schema.required.filter((k) => !hidden.has(k as string));
  return schema as Json;
}
