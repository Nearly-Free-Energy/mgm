import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJsonBody } from "../parse-body";

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
});
