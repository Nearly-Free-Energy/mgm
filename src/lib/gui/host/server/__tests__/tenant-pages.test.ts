/**
 * isTenantPage: a page is a tenant page only when the catalog has a view
 * serve it and the view whose path fits it has scope "tenant". The (gui)
 * layout's test walks every page with the real surface; this one pins the
 * two conditions with a surface of its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewDef } from "../../../surface";
import type { RegisteredView, SurfaceSnapshot } from "../surface-registry";

let snapshot: SurfaceSnapshot;
vi.mock("../snapshot", () => ({ surfaceSnapshot: async () => snapshot }));

import { isTenantPage } from "../tenant-pages";

const view = (path: string, scope: "tenant" | "organization"): RegisteredView => ({
  plugin: "tenant-app",
  def: { id: `test.${path}`, kind: "record", scope, path, params: {}, cost: "db", load: vi.fn() } as unknown as ViewDef,
});

const withViews = (...views: RegisteredView[]) => ({ views }) as unknown as SurfaceSnapshot;

beforeEach(() => {
  snapshot = withViews(view("/my", "tenant"));
});

describe("isTenantPage", () => {
  it("is true for the page of a tenant view the catalog has a view serve, with or without a query", async () => {
    expect(await isTenantPage("/my")).toBe(true);
    expect(await isTenantPage("/my?unit=e7400000-0000-4000-8000-00000000000a")).toBe(true);
  });

  it("is false for that page while no tenant view serves it", async () => {
    snapshot = withViews();
    expect(await isTenantPage("/my")).toBe(false);
    snapshot = withViews(view("/my", "organization"));
    expect(await isTenantPage("/my")).toBe(false);
  });

  it("is false for a tenant view's path that the catalog does not have a view serve", async () => {
    // A page.tsx serves /settings/users, so a view there would never be shown.
    snapshot = withViews(view("/settings/users", "tenant"), view("/no-such-page", "tenant"));
    expect(await isTenantPage("/settings/users")).toBe(false);
    expect(await isTenantPage("/no-such-page")).toBe(false);
  });

  it("is false for what is not a same-origin path", async () => {
    for (const path of ["", "my", "//my", "https://example.test/my", "/%2Fmy"]) {
      expect(await isTenantPage(path), path).toBe(false);
    }
  });
});
