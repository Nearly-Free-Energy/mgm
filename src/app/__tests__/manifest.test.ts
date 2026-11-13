/**
 * The web app manifest: the app's name, the light theme colour from
 * palette.ts, and icons that exist in public/ at the sizes it declares.
 * The middleware half (the manifest loads without a session) is in
 * src/lib/__tests__/middleware.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import manifest from "../manifest";
import { THEME_COLOR } from "@/lib/public-html/palette";
import { BILLING_SURFACE } from "@/lib/billing/surface";
import { METERING_SURFACE } from "@/lib/metering/surface";
import { isReleasedRoute } from "@/lib/mgm/released-routes";

vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "font-inter" }),
}));
vi.mock("../globals.css", () => ({}));

const PUBLIC = path.resolve(__dirname, "..", "..", "..", "public");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk, which always comes first. */
function pngSize(bytes: Buffer): [number, number] {
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  expect(bytes.toString("latin1", 12, 16)).toBe("IHDR");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("web app manifest", () => {
  it("names the app and opens it on the start page without browser controls", () => {
    const m = manifest();
    expect(m).toMatchObject({
      id: "/",
      name: "Microgrid Manager",
      short_name: "MGM",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
  });

  it("describes the app as the root layout does", async () => {
    const { metadata } = await import("../layout");
    expect(manifest().description).toBe(metadata.description);
  });

  it("uses the light page background from palette.ts for both colours", () => {
    const m = manifest();
    expect(m.theme_color).toBe(THEME_COLOR.light);
    expect(m.background_color).toBe(THEME_COLOR.light);
  });

  it("has no fields that need app support it does not have yet", () => {
    const m = manifest() as Record<string, unknown>;
    expect(m).not.toHaveProperty("display_override");
  });

  it("opens each shortcut through /go/<nav> with a nav id a plugin contributes", () => {
    const ids = new Set(
      [BILLING_SURFACE, METERING_SURFACE].flatMap((surface) => (surface.nav ?? []).map((entry) => entry.id)),
    );
    const shortcuts = manifest().shortcuts ?? [];
    expect(shortcuts.map((s) => s.name)).toEqual(["Billing", "Operations"]);
    for (const { url } of shortcuts) {
      const id = /^\/go\/([^/]+)$/.exec(url)?.[1];
      expect(id && ids.has(id as never), url).toBe(true);
      expect(isReleasedRoute(url), url).toBe(true);
    }
  });

  it("points at PNG icons in public/ of the sizes it declares, one of them maskable", () => {
    const icons = manifest().icons ?? [];
    expect(icons.map((icon) => icon.src)).toEqual([
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/icon-maskable-512.png",
    ]);
    for (const icon of icons) {
      const file = path.join(PUBLIC, icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      expect(icon.type, icon.src).toBe("image/png");
      const side = Number(/^(\d+)x\1$/.exec(icon.sizes ?? "")?.[1]);
      expect(pngSize(readFileSync(file)), icon.src).toEqual([side, side]);
    }
    expect(icons.filter((icon) => icon.purpose === "maskable")).toHaveLength(1);
    expect(icons.filter((icon) => icon.purpose === "any").map((icon) => icon.sizes)).toEqual([
      "192x192",
      "512x512",
    ]);
  });

  it("stays under 2 KB", () => {
    expect(Buffer.byteLength(JSON.stringify(manifest()), "utf8")).toBeLessThanOrEqual(2048);
  });
});
