import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

import { NO_STORE, hostFailure, hostOutcome } from "../http";
import { hostFailureBodySchema } from "../model-schema";

describe("hostOutcome", () => {
  it("answers a success as uncacheable JSON", async () => {
    const res = hostOutcome({ ok: true, value: { type: "view", view: "metering.site-day" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(await res.json()).toEqual({ type: "view", view: "metering.site-day" });
  });

  it("answers a refusal in ActionResult's shape, with the same text as `error`, uncacheable", async () => {
    const res = hostOutcome({ ok: false, status: 404, code: "gui_not_found", message: "This page could not be found." });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(await res.json()).toEqual({
      type: "result",
      ok: false,
      status: 404,
      code: "gui_not_found",
      message: "This page could not be found.",
      error: "This page could not be found.",
    });
  });

  it("answers hostFailure in the same shape, the { error, code } of the action routes included", async () => {
    const res = hostFailure(401, "gui_unauthenticated", "Sign in to continue.");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    const body = await res.json();
    expect(hostFailureBodySchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      type: "result",
      ok: false,
      status: 401,
      code: "gui_unauthenticated",
      message: "Sign in to continue.",
      error: "Sign in to continue.",
    });
  });
});
