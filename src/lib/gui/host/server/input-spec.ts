import "server-only";

/**
 * The JSON Schema of an action's input, as the host serves it: in the
 * prepared action's spec (./prepare.ts), which a form is built from.
 *
 * Built on each call from the action's zod schema, with zod's default
 * `unrepresentable: "throw"`, so an input JSON Schema cannot describe throws
 * here rather than becoming an empty schema. The contribution check refuses
 * such an input when it is registered (./contribution-schema.ts), and one
 * with a part that accepts any value (unconstrainedNodes below), so a throw
 * here is a host bug. If that check stops refusing either, revisit. Nothing
 * is cached between calls.
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

/** Keywords that describe a schema without limiting what it accepts. */
const ANNOTATIONS: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/** A JSON Pointer reference token (RFC 6901). */
const token = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * The JSON Pointers of the places in a JSON Schema that accept any value:
 * `true`, or an object with no keyword but annotations, such as `{}` or the
 * `{ "writeOnly": true }` that z.unknown().meta({ writeOnly: true }) writes.
 * z.any(), z.unknown(), a loose object's or a catchall's
 * additionalProperties and a record of unknowns all describe so.
 *
 * Only schema positions are visited: each value of properties,
 * patternProperties and $defs; items and each prefixItems, anyOf, oneOf and
 * allOf member; additionalProperties; and the schema under not, whose own
 * `{}` is z.never() and is not refused, though what it holds is visited. A
 * keyword's map is not a schema, so z.strictObject({}), whose properties is
 * `{}`, passes. Keywords not listed (if, contains, propertyNames and the
 * rest) are not visited: zod 4.6 writes none of them with an unknown
 * inside. If a zod upgrade does, visit them too.
 */
export function unconstrainedNodes(schema: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown, at: string, refuse: boolean) => {
    if (node === true) {
      if (refuse) found.push(at);
      return;
    }
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    const o = node as Record<string, unknown>;
    if (refuse && Object.keys(o).every((k) => ANNOTATIONS.has(k))) found.push(at);
    for (const key of ["properties", "patternProperties", "$defs"]) {
      const map = o[key];
      if (map !== null && typeof map === "object" && !Array.isArray(map))
        for (const [name, child] of Object.entries(map)) visit(child, `${at}/${key}/${token(name)}`, true);
    }
    for (const key of ["items", "additionalProperties"]) if (Object.hasOwn(o, key)) visit(o[key], `${at}/${key}`, true);
    for (const key of ["prefixItems", "anyOf", "oneOf", "allOf"]) {
      const list = o[key];
      if (Array.isArray(list)) list.forEach((child, i) => visit(child, `${at}/${key}/${i}`, true));
    }
    if (Object.hasOwn(o, "not")) visit(o.not, `${at}/not`, false);
  };
  visit(schema, "", true);
  return found;
}
