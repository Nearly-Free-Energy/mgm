import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

import { NO_STORE, hostOutcome } from "../http";

describe("hostOutcome", () => {
  it("answers a success as uncacheable JSON", async () => {
    const res = hostOutcome({ ok: true, value: { type: "view", view: "metering.site-day" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(await res.json()).toEqual({ type: "view", view: "metering.site-day" });
  });

  it("answers a refusal in ActionResult's shape, uncacheable", async () => {
    const res = hostOutcome({ ok: false, status: 404, code: "gui_not_found", message: "This page could not be found." });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(await res.json()).toEqual({
      type: "result",
      ok: false,
      status: 404,
      code: "gui_not_found",
      message: "This page could not be found.",
    });
  });
});
