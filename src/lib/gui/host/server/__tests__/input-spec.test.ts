/**
 * describeInput, the input schema prepare and the catalog serve, and
 * unconstrainedNodes, which the contribution check refuses inputs with
 * (contribution-schema.test.ts holds the refusals).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeInput, unconstrainedNodes } from "../input-spec";

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

  it("finds `true` in a schema position", () => {
    expect(unconstrainedNodes(true)).toEqual([""]);
    expect(unconstrainedNodes({ type: "object", additionalProperties: true })).toEqual(["/additionalProperties"]);
    expect(unconstrainedNodes({ type: "array", items: true })).toEqual(["/items"]);
    expect(unconstrainedNodes({ oneOf: [{ type: "string" }, true] })).toEqual(["/oneOf/1"]);
    expect(unconstrainedNodes({ allOf: [{}] })).toEqual(["/allOf/0"]);
    expect(unconstrainedNodes({ type: "object", patternProperties: { "^x": {} } })).toEqual(["/patternProperties/^x"]);
  });

  it("passes empty keyword maps, never, closed objects and lists, and refinements", () => {
    expect(nodes(z.strictObject({}))).toEqual([]);
    expect(nodes(z.never())).toEqual([]);
    expect(nodes(z.strictObject({ gone: z.never().optional() }))).toEqual([]);
    expect(nodes(z.strictObject({ a: z.string(), b: z.array(z.number()).max(3) }))).toEqual([]);
    expect(nodes(z.record(z.string(), z.string()))).toEqual([]);
    expect(nodes(z.tuple([z.string()]))).toEqual([]);
    expect(nodes(z.strictObject({ n: z.string() }).refine(() => true))).toEqual([]);
    expect(nodes(z.json())).toEqual([]);
    expect(unconstrainedNodes({ type: "object", additionalProperties: false })).toEqual([]);
  });

  it("visits what the schema under not holds, though not its own empty schema", () => {
    expect(unconstrainedNodes({ not: {} })).toEqual([]);
    expect(unconstrainedNodes({ not: true })).toEqual([]);
    expect(unconstrainedNodes({ not: { properties: { a: {} } } })).toEqual(["/not/properties/a"]);
  });
});
