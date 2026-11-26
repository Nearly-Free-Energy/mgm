import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJsonBody, type BodyRefusals } from "../parse-body";

const Body = z.strictObject({
  name: z.string({ error: "name must be text" }),
  tags: z.array(z.string({ error: "each tag must be text" })).optional(),
});

function request(body: string): Request {
  return new Request("http://localhost/api/thing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("parseJsonBody", () => {
  it("returns the parsed data on success", async () => {
    const result = await parseJsonBody(request(JSON.stringify({ name: "a", tags: ["b"] })), Body);
    expect(result).toEqual({ ok: true, data: { name: "a", tags: ["b"] } });
  });

  it("returns the schema's output, not the raw JSON", async () => {
    const Shaped = z.object({ name: z.string().transform((v) => v.toUpperCase()), n: z.number().default(1) });
    const result = await parseJsonBody(request(JSON.stringify({ name: "a", dropped: true })), Shaped);
    expect(result).toEqual({ ok: true, data: { name: "A", n: 1 } });
  });

  it("names the first failing key in the schema's order when several fail", async () => {
    const result = await parseJsonBody(request(JSON.stringify({ name: 1, tags: [2] })), Body);
    if (result.ok) throw new Error("expected a failure");
    expect(await result.response.json()).toEqual({
      error: "name must be text",
      field: "name",
      code: "invalid_body",
    });
  });

  it("answers 400 invalid_body when the body is not JSON", async () => {
    const result = await parseJsonBody(request("{not json"), Body);
    if (result.ok) throw new Error("expected a failure");
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ error: "Invalid JSON body", code: "invalid_body" });
  });

  it("names the top-level key a failure is under, however deep it is", async () => {
    const result = await parseJsonBody(request(JSON.stringify({ name: "a", tags: ["b", 3] })), Body);
    if (result.ok) throw new Error("expected a failure");
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({
      error: "each tag must be text",
      field: "tags",
      code: "invalid_body",
    });
  });

  it("gives no field for a failure of the body itself", async () => {
    for (const body of [JSON.stringify([]), JSON.stringify({ name: "a", extra: 1 }), "null"]) {
      const result = await parseJsonBody(request(body), Body);
      if (result.ok) throw new Error(`expected a failure for ${body}`);
      expect(result.response.status).toBe(400);
      const json = await result.response.json();
      expect(json.code).toBe("invalid_body");
      expect(json).not.toHaveProperty("field");
    }
  });

  describe("with a route's own refusals", () => {
    const Own = z.strictObject({
      id: z.string({ error: "id is required" }),
      name: z.string({ error: "name must be text" }).trim().min(1, { error: "name is required" }),
      note: z.string({ error: "note must be text" }).optional(),
    });
    const REFUSALS: BodyRefusals = {
      json: { status: 400, body: { error: "Invalid JSON body" } },
      issue: (issue) => {
        if (issue.code === "unrecognized_keys") return { status: 400, body: { error: `Unsupported field: ${issue.keys[0]}`, code: "own_unknown" } };
        if (issue.path[0] === "id") return { status: 400, body: { error: issue.message, code: "own_id", field: "id" } };
        if (issue.path[0] === "name") return { status: 422, body: { error: issue.message, code: "own_name", field: "name" } };
        return null;
      },
    };
    const refuse = async (body: string, refusals: BodyRefusals = REFUSALS) => {
      const result = await parseJsonBody(request(body), Own, refusals);
      if (result.ok) throw new Error(`expected a failure for ${body}`);
      return { status: result.response.status, json: await result.response.json() };
    };

    it("answers a body that is not JSON with the route's own answer", async () => {
      expect(await refuse("{not json")).toEqual({ status: 400, json: { error: "Invalid JSON body" } });
    });

    it("answers the first issue the route answers, in the schema's key order", async () => {
      expect(await refuse(JSON.stringify({ name: " " }))).toEqual({
        status: 400,
        json: { error: "id is required", code: "own_id", field: "id" },
      });
      expect(await refuse(JSON.stringify({ id: "a", name: " " }))).toEqual({
        status: 422,
        json: { error: "name is required", code: "own_name", field: "name" },
      });
    });

    it("skips an issue the route has no answer for when a later one has", async () => {
      expect(await refuse(JSON.stringify({ id: "a", note: 1, name: "" }))).toMatchObject({ status: 422, json: { code: "own_name" } });
    });

    it("gives the generic answer when the route answers none of the issues", async () => {
      expect(await refuse(JSON.stringify({ id: "a", name: "b", note: 1 }))).toEqual({
        status: 400,
        json: { error: "note must be text", field: "note", code: "invalid_body" },
      });
    });

    it("answers unknown keys where the schema reports them, or first when the route did", async () => {
      expect(await refuse(JSON.stringify({ id: "a", name: "", extra: 1 }))).toMatchObject({ status: 422, json: { code: "own_name" } });
      expect(await refuse(JSON.stringify({ id: "a", name: "", extra: 1 }), { ...REFUSALS, unknownKeysFirst: true })).toEqual({
        status: 400,
        json: { error: "Unsupported field: extra", code: "own_unknown" },
      });
    });

    it("returns the parsed data on success, as without them", async () => {
      expect(await parseJsonBody(request(JSON.stringify({ id: "a", name: " b " })), Own, REFUSALS)).toEqual({
        ok: true,
        data: { id: "a", name: "b" },
      });
    });
  });
});
