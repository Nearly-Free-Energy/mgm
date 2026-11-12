/**
 * The conformance fixtures are what the host could send: each parses with
 * the strict schemas, and withPoke() is the host's own merge.
 */
import { describe, expect, it } from "vitest";
import { CORE_ENTITY_KINDS } from "@/lib/plugins/bundled";
import { signalsSchema, viewModelSchema } from "../../host/server/model-schema";
import { POKE_ACTION, POKE_LABEL, withPoke } from "../fixtures/acme";
import { LATE_KIND_MODEL, MODEL_FIXTURES, SIGNALS, UNKNOWN_VALUE_MODEL } from "../fixtures/models";
import { refsOf, valuesOf } from "../inspect";

describe("the model fixtures", () => {
  it.each(MODEL_FIXTURES.map((f) => [f.name, f.model] as const))("%s parses strictly, before and after withPoke()", (_, model) => {
    expect(viewModelSchema.parse(model)).toEqual(model);
    expect(viewModelSchema.parse(withPoke(model))).toEqual(withPoke(model));
  });

  it("include every view kind, and a value of every type", () => {
    const models = MODEL_FIXTURES.map((f) => f.model);
    expect(new Set(models.map((m) => m.kind))).toEqual(new Set(["collection", "record", "metrics", "feed", "flow"]));
    expect(new Set(valuesOf(models).map((v) => v.t))).toEqual(
      new Set(["text", "empty", "number", "percent", "money", "energy", "power", "date", "datetime", "status", "ref"]),
    );
    const flags = valuesOf(models);
    expect(flags.some((v) => v.derived) && flags.some((v) => v.synthetic) && flags.some((v) => v.at)).toBe(true);
  });

  it("give every value a text found in no other value of the same model", () => {
    for (const { name, model } of MODEL_FIXTURES) {
      const texts = valuesOf(model).map((v) => v.text);
      for (const text of texts) expect(texts.filter((t) => t.includes(text)), `${name}: ${text}`).toEqual([text]);
    }
  });

  it("parse the signals and the late-kind model; the unknown value type does not parse", () => {
    expect(signalsSchema.parse(SIGNALS)).toEqual(SIGNALS);
    expect(viewModelSchema.safeParse(LATE_KIND_MODEL).success).toBe(true);
    expect(viewModelSchema.safeParse(UNKNOWN_VALUE_MODEL).success).toBe(false);
  });
});

describe("withPoke", () => {
  it("offers acme.poke once on the view's entity and once on each row's, bound to that entity", () => {
    const [collection] = MODEL_FIXTURES;
    const poked = withPoke(collection.model);
    if (poked.kind !== "collection" || collection.model.kind !== "collection") throw new Error("expected a collection");
    const byId = (x: { params: Record<string, string> }, y: { params: Record<string, string> }) => x.params.id.localeCompare(y.params.id);
    const pokes = refsOf(poked).filter((r) => r.action === POKE_ACTION).sort(byId);
    const entities = [collection.model.entity, ...collection.model.body.rows.map((r) => r.entity)];
    expect(pokes).toStrictEqual(
      entities.map((e) => ({ action: POKE_ACTION, params: { id: e!.id }, label: POKE_LABEL, enabled: true, from: "Acme" })).sort(byId),
    );
  });

  it("is offered on every core entity kind, and leaves a model without an entity as it was", () => {
    for (const kind of CORE_ENTITY_KINDS) {
      const model = { ...MODEL_FIXTURES[2].model, entity: { kind, id: "00000000-0000-4000-8000-000000000001", label: kind } };
      expect(refsOf(withPoke(model)).filter((r) => r.action === POKE_ACTION)).toHaveLength(1);
    }
    const bare = { ...MODEL_FIXTURES[2].model, entity: undefined };
    expect(withPoke(bare)).toEqual(bare);
  });
});
