import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Href } from "../../../contract";
import { KitProvider } from "../kit-provider";
import { KitRuntimeProvider, loadView, search } from "../kit-runtime";
import { initial, manifest, model, ORG, recordingRuntime } from "./kit-test-utils";

vi.mock("next/navigation", () => ({ usePathname: () => null, useSearchParams: () => null }));

const realLocation = window.location;
afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

function mount(fetch: (url: string) => Promise<Response>, withManifest = false) {
  const runtime = recordingRuntime({ fetch: vi.fn(fetch) });
  const view = render(
    <KitRuntimeProvider runtime={runtime}>
      {withManifest ? <KitProvider manifest={manifest()} initial={initial}>{null}</KitProvider> : null}
    </KitRuntimeProvider>,
  );
  return { runtime, unmount: view.unmount };
}

const hit = (href: string) => ({ kind: "microgrid", id: "a", label: "A", href });

describe("search", () => {
  it("keeps only hits that are pages on this site", async () => {
    const { runtime } = mount(async () =>
      Response.json([hit("/microgrids/a"), hit("//evil.example"), hit("https://evil.example"), hit("javascript:x")]),
    );
    await expect(search("ka", "@")).resolves.toEqual([hit("/microgrids/a")]);
    expect(runtime.fetch).toHaveBeenCalledWith("/api/gui/search?q=ka&prefix=%40", expect.anything());
  });

  it("sends nothing for fewer than 2 or more than 64 characters", async () => {
    const { runtime } = mount(async () => Response.json([]));
    await expect(search("a", "@")).resolves.toEqual([]);
    await expect(search("x".repeat(65), "#")).resolves.toEqual([]);
    expect(runtime.fetch).not.toHaveBeenCalled();
    await search("x".repeat(64), "#");
    expect(runtime.fetch).toHaveBeenCalledOnce();
  });

  it("returns none when the host fails or cannot be reached", async () => {
    mount(async () => Response.json([hit("/microgrids/a")], { status: 500 }));
    await expect(search("ka", "@")).resolves.toEqual([]);
  });

  it("returns none when fetch rejects", async () => {
    mount(async () => {
      throw new TypeError("offline");
    });
    await expect(search("ka", "@")).resolves.toEqual([]);
  });

  it("asks for the organization the manifest shows", async () => {
    const { runtime, unmount } = mount(async () => Response.json([]), true);
    await search("ka", "#");
    expect(runtime.fetch).toHaveBeenCalledWith(`/api/gui/search?q=ka&prefix=%23&org=${ORG}`, expect.anything());
    unmount();
  });
});

describe("loadView", () => {
  it("goes to /login when signed out", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, assign } });
    mount(async () => new Response("{}", { status: 401 }));
    await expect(loadView("/microgrids/a")).resolves.toMatchObject({ ok: false, status: 401 });
    expect(assign).toHaveBeenCalledWith("/login");
  });

  it("refuses an href that is not a page on this site before fetching", async () => {
    const { runtime } = mount(async () => Response.json(model()));
    await expect(loadView("//evil.example" as Href)).resolves.toMatchObject({ ok: false, status: 400 });
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it("returns a view from an ok response", async () => {
    mount(async () => Response.json(model()));
    await expect(loadView("/microgrids/a")).resolves.toMatchObject({ type: "view", title: "Operations" });
  });

  it.each([
    ["a failed response", () => Response.json(model(), { status: 500 })],
    ["a body that is not a view or result", () => Response.json({ type: "manifest" })],
  ])("returns a refusal, not the body, for %s", async (_, respond) => {
    mount(async () => respond());
    await expect(loadView("/microgrids/a")).resolves.toMatchObject({ type: "result", ok: false });
  });
});
