import "server-only";

/**
 * The JSON Schema of an action's input, as the host serves it: in the
 * prepared action's spec (./prepare.ts), which a form is built from, and in
 * the OpenAPI document (./openapi.ts), as the body the action's route parses.
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
 * The JSON Schema of the whole body the action's route parses: every field
 * of its input, bound fields and `confirmation` included. describeInput is
 * this with those fields removed.
 */
export function describeBody(def: Pick<ActionDef, "input">): Json {
  // Through JSON, so only JSON is kept: zod adds a non-enumerable "~standard" property.
  return JSON.parse(JSON.stringify(z.toJSONSchema(def.input, { io: "input" }))) as Json;
}

/**
 * The JSON Schema of the fields a person enters: the input's, with bound
 * fields and `confirmation` (sent by the host's confirmation step) removed.
 * writeOnly marks stay, so a form never prefills or shows a secret.
 */
export function describeInput(def: Pick<ActionDef, "input" | "bind">): Json {
  const schema = describeBody(def) as Record<string, unknown>;
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

/** A JSON Schema object, as opposed to `true`, `false` or a keyword's value. */
const isNode = (n: unknown): n is Record<string, unknown> => n !== null && typeof n === "object" && !Array.isArray(n);
/** Whether `n` has no keyword but annotations and those in `allowed`. */
const only = (n: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(n).every((k) => ANNOTATIONS.has(k) || allowed.includes(k));
/** Whether `n` is nothing but a `$ref` to `target`. */
const refTo = (n: unknown, target: string) => isNode(n) && n.$ref === target && only(n, ["$ref"]);
const SCALARS = ["string", "number", "boolean", "null"];

/**
 * Whether `o`, at JSON Pointer `at`, is the union z.json() writes: each JSON
 * scalar type with nothing else, an array of itself and an object of itself
 * (a `$ref` back to `at`), which between them accept any JSON value.
 */
function isJsonUnion(o: Record<string, unknown>, at: string): boolean {
  const members = o.anyOf;
  if (!Array.isArray(members) || !only(o, ["anyOf", "$defs"])) return false;
  const self = `#${at}`;
  const typed = (t: string) => members.filter((m): m is Record<string, unknown> => isNode(m) && m.type === t);
  const anyKey = (m: Record<string, unknown>) =>
    !Object.hasOwn(m, "propertyNames") || (isNode(m.propertyNames) && m.propertyNames.type === "string" && only(m.propertyNames, ["type"]));
  return (
    SCALARS.every((t) => typed(t).some((m) => only(m, ["type"]))) &&
    typed("array").some((m) => only(m, ["type", "items"]) && refTo(m.items, self)) &&
    typed("object").some(
      (m) => only(m, ["type", "propertyNames", "additionalProperties"]) && anyKey(m) && refTo(m.additionalProperties, self),
    )
  );
}

/**
 * The JSON Pointers of the places in a JSON Schema that accept any value:
 * - `true`, or an object with no keyword but annotations, such as `{}` or
 *   the `{ "writeOnly": true }` that z.unknown().meta({ writeOnly: true })
 *   writes. z.any(), z.unknown(), a loose object's or a catchall's
 *   additionalProperties and a record of unknowns all describe so.
 * - an object schema (`"type": "object"`) with no additionalProperties,
 *   which JSON Schema reads as `{}`: what z.object() writes, since zod
 *   strips a key it does not know rather than refusing it. The pointer
 *   names the missing additionalProperties. So every object in an input is
 *   a z.strictObject (or a record), as every contributed input is today.
 * - the union z.json() writes (isJsonUnion above), at the pointer of the
 *   union: at the root, or in $defs when it is a field. It is matched in
 *   the form zod 4.6 writes, which input-spec.test.ts pins; if a zod
 *   upgrade writes another, that test fails, and this needs the new form.
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
    if (!isNode(node)) return;
    const o = node;
    if (refuse && Object.keys(o).every((k) => ANNOTATIONS.has(k))) found.push(at);
    if (refuse && o.type === "object" && !Object.hasOwn(o, "additionalProperties")) found.push(`${at}/additionalProperties`);
    if (refuse && isJsonUnion(o, at)) found.push(at);
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
