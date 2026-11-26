/**
 * describeInput, the input schema prepare and the catalog serve, and
 * unconstrainedNodes and hasRootProperties, which the contribution check
 * refuses inputs by (contribution-schema.test.ts holds the refusals).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeInput, hasRootProperties, unconstrainedNodes } from "../input-spec";

const nodes = (schema: z.ZodType) => unconstrainedNodes(z.toJSONSchema(schema, { io: "input" }));

describe("describeInput", () => {
  it("leaves out bound fields and the host's confirmation, and keeps writeOnly marks", () => {
    const input = z.strictObject({
      microgrid_id: z.uuid(),
      url: z.string().max(200),
      password: z.string().meta({ writeOnly: true }).optional(),
      confirmation: z.strictObject({ typed: z.string() }).optional(),
    });
    const described = describeInput({ input, bind: { path: { id: "microgrid" }, body: { microgrid_id: "microgrid" } } });
    expect(described).toMatchObject({ type: "object", required: ["url"], additionalProperties: false });
    expect(Object.keys((described as { properties: object }).properties)).toEqual(["url", "password"]);
    expect(JSON.stringify(described)).toContain('"writeOnly":true');
  });

  it("is plain JSON", () => {
    const described = describeInput({ input: z.strictObject({ n: z.number() }), bind: {} });
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
    expect(Object.getOwnPropertyNames(described)).not.toContain("~standard");
  });

  it("throws for an input JSON Schema cannot describe, rather than describe nothing", () => {
    expect(() => describeInput({ input: z.strictObject({ at: z.date() }), bind: {} })).toThrow();
    expect(() => describeInput({ input: z.strictObject({ c: z.custom(() => true) }), bind: {} })).toThrow();
  });
});

describe("hasRootProperties", () => {
  const root = (schema: z.ZodType) => hasRootProperties(z.toJSONSchema(schema, { io: "input" }));

  it("holds for a strict object, with fields or without", () => {
    expect(root(z.strictObject({ microgrid_id: z.uuid() }))).toBe(true);
    expect(root(z.strictObject({}))).toBe(true);
  });

  it("fails for a union, whose bound fields describeInput would leave in, and for a record or a scalar", () => {
    const union = z.union([
      z.strictObject({ microgrid_id: z.uuid(), name: z.string() }),
      z.strictObject({ microgrid_id: z.uuid(), copy_of: z.uuid() }),
    ]);
    expect(root(union)).toBe(false);
    expect(JSON.stringify(describeInput({ input: union, bind: { body: { microgrid_id: "microgrid" } } }))).toContain("microgrid_id");
    expect(root(z.record(z.string(), z.string()))).toBe(false);
    expect(root(z.string())).toBe(false);
  });
});

describe("unconstrainedNodes", () => {
  it("finds what accepts any value, at its JSON Pointer", () => {
    expect(nodes(z.unknown())).toEqual([""]);
    expect(nodes(z.any())).toEqual([""]);
    expect(nodes(z.strictObject({ x: z.unknown() }))).toEqual(["/properties/x"]);
    expect(nodes(z.strictObject({ x: z.unknown().meta({ writeOnly: true, description: "d" }) }))).toEqual(["/properties/x"]);
    expect(nodes(z.strictObject({ x: z.unknown().nullable() }))).toEqual(["/properties/x/anyOf/0"]);
    expect(nodes(z.looseObject({ a: z.string() }))).toEqual(["/additionalProperties"]);
    expect(nodes(z.strictObject({ a: z.string() }).catchall(z.unknown()))).toEqual(["/additionalProperties"]);
    expect(nodes(z.record(z.string(), z.unknown()))).toEqual(["/additionalProperties"]);
    expect(nodes(z.array(z.unknown()))).toEqual(["/items"]);
    expect(nodes(z.tuple([z.unknown()]))).toEqual(["/prefixItems/0"]);
    expect(nodes(z.strictObject({ "a/b~": z.unknown() }))).toEqual(["/properties/a~1b~0"]);
    expect(nodes(z.strictObject({ a: z.unknown().meta({ id: "Loose" }) }))).toEqual(["/$defs/Loose"]);
  });

  it("finds an object that takes keys it does not name, which z.object() writes, at its missing additionalProperties", () => {
    expect(nodes(z.object({}))).toEqual(["/additionalProperties"]);
    expect(nodes(z.object({ a: z.string() }))).toEqual(["/additionalProperties"]);
    expect(nodes(z.strictObject({ a: z.object({ b: z.string() }).optional() }))).toEqual(["/properties/a/additionalProperties"]);
    expect(nodes(z.union([z.string(), z.object({})]))).toEqual(["/anyOf/1/additionalProperties"]);
    expect(unconstrainedNodes({ type: "object", properties: { a: { type: "string" } } })).toEqual(["/additionalProperties"]);
  });

  // Matched in the form zod writes it: if a zod upgrade writes another, this fails (unconstrainedNodes says so).
  it("finds the union z.json() writes, which takes any JSON value, at the union", () => {
    expect(nodes(z.json())).toEqual([""]);
    expect(nodes(z.strictObject({ data: z.json() }))).toEqual(["/$defs/__schema0"]);
    expect(nodes(z.strictObject({ data: z.json().nullable() }))).toEqual(["/$defs/__schema0"]);
  });

  it("finds `true` in a schema position", () => {
    expect(unconstrainedNodes(true)).toEqual([""]);
    expect(unconstrainedNodes({ type: "object", additionalProperties: true })).toEqual(["/additionalProperties"]);
    expect(unconstrainedNodes({ type: "array", items: true })).toEqual(["/items"]);
    expect(unconstrainedNodes({ oneOf: [{ type: "string" }, true] })).toEqual(["/oneOf/1"]);
    expect(unconstrainedNodes({ allOf: [{}] })).toEqual(["/allOf/0"]);
    expect(unconstrainedNodes({ type: "object", patternProperties: { "^x": {} }, additionalProperties: false })).toEqual(["/patternProperties/^x"]);
  });

  it("passes empty keyword maps, never, closed objects and lists, and refinements", () => {
    expect(nodes(z.strictObject({}))).toEqual([]);
    expect(nodes(z.never())).toEqual([]);
    expect(nodes(z.strictObject({ gone: z.never().optional() }))).toEqual([]);
    expect(nodes(z.strictObject({ a: z.string(), b: z.array(z.number()).max(3) }))).toEqual([]);
    expect(nodes(z.record(z.string(), z.string()))).toEqual([]);
    expect(nodes(z.tuple([z.string()]))).toEqual([]);
    expect(nodes(z.strictObject({ n: z.string() }).refine(() => true))).toEqual([]);
    expect(nodes(z.record(z.enum(["a", "b"]), z.string()))).toEqual([]);
    expect(nodes(z.strictObject({ a: z.string() }).nullable())).toEqual([]);
    expect(unconstrainedNodes({ type: "object", additionalProperties: false })).toEqual([]);
  });

  it("passes a union of every JSON type that does not take every value", () => {
    const scalars = [z.string(), z.number(), z.boolean(), z.null()] as const;
    expect(nodes(z.union([...scalars, z.array(z.string()), z.record(z.string(), z.string())]))).toEqual([]);
    expect(nodes(z.union([z.string().max(9), z.number(), z.boolean(), z.null()]))).toEqual([]);
    const json = z.toJSONSchema(z.json(), { io: "input" }) as { anyOf: Record<string, unknown>[] };
    const keyed = { ...json, anyOf: json.anyOf.map((m) => (m.type === "object" ? { ...m, propertyNames: { type: "string", enum: ["a"] } } : m)) };
    expect(unconstrainedNodes(keyed)).toEqual([]);
  });

  it("visits what the schema under not holds, though not its own empty schema", () => {
    expect(unconstrainedNodes({ not: {} })).toEqual([]);
    expect(unconstrainedNodes({ not: true })).toEqual([]);
    expect(unconstrainedNodes({ not: { properties: { a: {} } } })).toEqual(["/not/properties/a"]);
  });
});
