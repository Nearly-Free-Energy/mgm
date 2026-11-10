import { act as flush, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { MouseEvent, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { kit } from "@/lib/gui/kit";
import type { EntityRef, GuiKit, InitialView, Manifest, NavEntry } from "../../../contract";
import { KitProvider, useManifest, useView } from "../kit-provider";
import { defaultRuntime, KitRuntimeProvider } from "../kit-runtime";
import { Link, useUiParam } from "../navigation";
import { ViewBoundary } from "../view-boundary";
import { initial, manifest, MG, model, ORG, recordingRuntime } from "./kit-test-utils";

type LinkStubProps = {
  href: string;
  prefetch?: boolean;
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

const router = { push: vi.fn(), refresh: vi.fn() };
const next = vi.hoisted(() => ({ searchParams: null as URLSearchParams | null }));
vi.mock("next/navigation", () => ({
  usePathname: () => null,
  useSearchParams: () => next.searchParams,
  useRouter: () => router,
}));
vi.mock("next/link", () => ({
  default: ({ href, prefetch, children, onClick, ...rest }: LinkStubProps) => (
    <a
      href={href}
      data-prefetch={String(prefetch)}
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault(); // as next/link does; jsdom cannot navigate
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  next.searchParams = null;
  window.history.replaceState(null, "", "/");
});

describe("Link", () => {
  it("never prefetches and marks the current page", () => {
    render(<Link href="/microgrids" current>Sites</Link>);
    const link = screen.getByRole("link", { name: "Sites" });
    expect(link.getAttribute("data-prefetch")).toBe("false");
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  it("renders an href that is not a page on this site as text", () => {
    render(<Link href={"//evil.example/x" as "/x"}>Away</Link>);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Away").tagName).toBe("SPAN");
  });

  it("is busy and pending from a click until the pathname changes", () => {
    const runtime = recordingRuntime({ pathname: "/" });
    const { rerender } = render(
      <KitRuntimeProvider runtime={runtime}>
        <Link href="/microgrids">Sites</Link>
      </KitRuntimeProvider>,
    );
    const link = screen.getByRole("link", { name: "Sites" });
    expect(link.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(link);
    expect(link.getAttribute("aria-busy")).toBe("true");
    expect(link.getAttribute("data-pending")).toBe("true");
    rerender(
      <KitRuntimeProvider runtime={{ ...runtime, pathname: "/microgrids" }}>
        <Link href="/microgrids">Sites</Link>
      </KitRuntimeProvider>,
    );
    expect(link.getAttribute("data-pending")).toBeNull();
    // Back on the page the click came from: no longer pending.
    rerender(
      <KitRuntimeProvider runtime={{ ...runtime, pathname: "/" }}>
        <Link href="/microgrids">Sites</Link>
      </KitRuntimeProvider>,
    );
    expect(link.getAttribute("data-pending")).toBeNull();
  });

  function clickAt(pathname: string, href: "/microgrids" | "/", props: { current?: boolean } = {}, init = {}) {
    render(
      <KitRuntimeProvider runtime={recordingRuntime({ pathname })}>
        <Link href={href} {...props}>Sites</Link>
      </KitRuntimeProvider>,
    );
    const link = screen.getByRole("link", { name: "Sites" });
    fireEvent.click(link, init);
    return link;
  }

  it("is not pending for a click that opens a new tab", () => {
    expect(clickAt("/", "/microgrids", {}, { metaKey: true }).getAttribute("aria-busy")).toBeNull();
  });

  it("is not pending for a link to the page already shown", () => {
    expect(clickAt("/", "/").getAttribute("aria-busy")).toBeNull();
  });

  it("is never pending while it marks the current section", () => {
    expect(clickAt("/", "/microgrids", { current: true }).getAttribute("data-pending")).toBeNull();
  });
});

describe("navigate and refresh", () => {
  it("go through the mounted runtime", () => {
    const runtime = recordingRuntime();
    render(<KitRuntimeProvider runtime={runtime}>{null}</KitRuntimeProvider>);
    kit.navigate("/microgrids");
    kit.refresh();
    expect(runtime.navigate).toHaveBeenCalledWith("/microgrids");
    expect(runtime.refresh).toHaveBeenCalledOnce();
  });

  it("refuse an href that leaves the site", () => {
    const started = vi.fn();
    window.addEventListener("mgm:navigation-start", started);
    render(<KitProvider manifest={manifest()} initial={initial}>{null}</KitProvider>);
    defaultRuntime.navigate("//evil.example" as "/x");
    defaultRuntime.navigate("/\\evil.example" as "/x");
    defaultRuntime.navigate("/a/%2e%2e/b" as "/x");
    window.removeEventListener("mgm:navigation-start", started);
    expect(started).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("use the router once the provider has mounted it", () => {
    render(<KitProvider manifest={manifest()} initial={initial}>{null}</KitProvider>);
    kit.navigate("/microgrids");
    expect(router.push).toHaveBeenCalledWith("/microgrids");
  });
});

describe("act", () => {
  it("refuses without an action host and sends nothing", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const result = await kit.act({ action: "billing.close", params: {}, label: "Close", enabled: true });
    expect(result).toMatchObject({ ok: false, code: "unsupported" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("useUiParam", () => {
  it("refuses a name outside ui.*", () => {
    expect(() => renderHook(() => useUiParam("date" as "ui.date"))).toThrow(/ui\./);
    expect(() => renderHook(() => useUiParam("ui.a b"))).toThrow(/ui\./);
  });

  it("writes without Next.js's history marker, so the router keeps the parameter", () => {
    window.history.replaceState({ __NA: true, tree: 1 }, "", "/");
    const replace = vi.spyOn(window.history, "replaceState");
    const { result } = renderHook(() => useUiParam("ui.row"));
    flush(() => result.current[1]("r1"));
    expect(replace).toHaveBeenCalledOnce();
    expect(replace.mock.calls[0][0]).toBeNull();
  });

  it("follows the URL once it moves on from what the hook wrote", () => {
    next.searchParams = new URLSearchParams();
    const { result, rerender } = renderHook(() => useUiParam("ui.row"));
    flush(() => result.current[1]("r1"));
    expect(result.current[0]).toBe("r1");
    next.searchParams = new URLSearchParams("ui.row=r2");
    rerender();
    expect(result.current[0]).toBe("r2");
  });

  it("writes with history.replaceState, not the router", () => {
    const replace = vi.spyOn(window.history, "replaceState");
    const { result } = renderHook(() => useUiParam("ui.row"));
    expect(result.current[0]).toBeNull();
    flush(() => result.current[1]("r1"));
    expect(result.current[0]).toBe("r1");
    expect(window.location.search).toBe("?ui.row=r1");
    flush(() => result.current[1](null));
    expect(window.location.search).toBe("");
    expect(replace).toHaveBeenCalledTimes(2);
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("KitProvider", () => {
  const nav: NavEntry = {
    id: "metering.operations",
    title: "Operations",
    icon: "live",
    group: "operate",
    order: 1,
    href: "/microgrids/[microgrid]/operations",
    needs: ["microgrid"],
  };

  it("useManifest throws without a manifest", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <KitProvider manifest={null} initial={initial}>{children}</KitProvider>
    );
    expect(() => renderHook(() => useManifest(), { wrapper })).toThrow(/manifest/);
  });

  it("fills nav patterns by kind, from the only place when the scope has none", () => {
    const m = manifest();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <KitProvider manifest={m} initial={initial}>{children}</KitProvider>
    );
    const { result } = renderHook(() => useView(), { wrapper });
    expect(result.current.href(nav)).toBe(`/microgrids/${MG}/operations`);
    expect(result.current.href({ ...nav, href: "/communities/[community]", needs: ["community"] })).toBeNull();
    expect(result.current.choices("organization").map((o) => o.id)).toEqual([ORG]);
  });

  it("fills a kind from pick, then the scope, and never guesses among several", () => {
    const A = "00000000-0000-4000-8000-0000000000a1";
    const B = "00000000-0000-4000-8000-0000000000b2";
    const site = (id: string): EntityRef => ({ kind: "microgrid", id, label: id, href: `/microgrids/${id}/operations` });
    const m: Manifest = { ...manifest(), org: { ...manifest().org, places: [site(A), site(B)] } };
    const hook = (scope: InitialView["scope"]) =>
      renderHook(() => useView(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <KitProvider manifest={m} initial={{ ...initial, scope }}>{children}</KitProvider>
        ),
      }).result.current;
    const unscoped = hook({});
    expect(unscoped.href(nav)).toBeNull();
    expect(unscoped.href(nav, { microgrid: site(B) })).toBe(`/microgrids/${B}/operations`);
    const scoped = hook({ microgrid: site(A) });
    expect(scoped.href(nav)).toBe(`/microgrids/${A}/operations`);
    expect(scoped.href(nav, { microgrid: site(B) })).toBe(`/microgrids/${B}/operations`);
    expect(scoped.href(nav, { microgrid: site("a?b") })).toBe("/microgrids/a%3Fb/operations");
    // Filled, the pattern would leave the site.
    expect(scoped.href({ ...nav, href: "/[microgrid]/x" }, { microgrid: site("") })).toBeNull();
  });

  it("drops a boundary's model when the boundary unmounts", () => {
    const runtime = recordingRuntime({ pathname: "/x" });
    const titles: (string | null)[] = [];
    function Probe() {
      titles.push(useView().model?.title ?? null);
      return null;
    }
    const tree = (withBoundary: boolean) => (
      <KitRuntimeProvider runtime={runtime}>
        <KitProvider manifest={manifest()} initial={initial}>
          {withBoundary && <ViewBoundary initial={{ ...initial, title: "Site" }} model={model()} />}
          <Probe />
        </KitProvider>
      </KitRuntimeProvider>
    );
    const { rerender } = render(tree(true));
    expect(titles.at(-1)).toBe("Operations");
    rerender(tree(false));
    expect(titles.at(-1)).toBeNull();
  });

  it("takes the title from the boundary, and ignores a boundary published for another pathname", () => {
    const runtime = recordingRuntime({ pathname: "/y" });
    const seen: { title: string; model: string | null }[] = [];
    function Probe() {
      const view = useView();
      seen.push({ title: view.title, model: view.model?.title ?? null });
      return null;
    }
    const tree = (boundaryPath: string) => (
      <KitRuntimeProvider runtime={runtime}>
        <KitProvider manifest={manifest()} initial={initial}>
          <KitRuntimeProvider runtime={{ ...runtime, pathname: boundaryPath }}>
            <ViewBoundary initial={{ ...initial, title: "Site" }} model={model()} />
          </KitRuntimeProvider>
          <Probe />
        </KitProvider>
      </KitRuntimeProvider>
    );
    const { rerender } = render(tree("/y"));
    expect(seen.at(-1)).toEqual({ title: "Site", model: "Operations" });
    rerender(tree("/x"));
    expect(seen.at(-1)).toEqual({ title: "Dashboard", model: null });
  });

  it("shows a boundary's model only on the pathname it was published for", () => {
    const runtime = recordingRuntime({ pathname: "/x" });
    const seen: (string | null)[] = [];
    function Probe() {
      seen.push(useView().model?.title ?? null);
      return null;
    }
    const tree = (pathname: string) => (
      <KitRuntimeProvider runtime={{ ...runtime, pathname }}>
        <KitProvider manifest={manifest()} initial={initial}>
          <ViewBoundary initial={initial} model={model()} />
          <Probe />
        </KitProvider>
      </KitRuntimeProvider>
    );
    const { rerender } = render(tree("/x"));
    expect(seen.at(-1)).toBe("Operations");
    // Another page, without a boundary of its own.
    rerender(
      <KitRuntimeProvider runtime={{ ...runtime, pathname: "/y" }}>
        <KitProvider manifest={manifest()} initial={initial}>
          <Probe />
        </KitProvider>
      </KitRuntimeProvider>,
    );
    expect(seen.at(-1)).toBeNull();
  });

  it("refreshes once per pathname for a place the manifest cannot show", () => {
    const runtime = recordingRuntime();
    const resolve = () => ({ ...initial, unplaced: true });
    const tree = (pathname: string) => (
      <KitRuntimeProvider runtime={{ ...runtime, pathname }}>
        <KitProvider manifest={manifest()} initial={initial} resolve={resolve}>{null}</KitProvider>
      </KitRuntimeProvider>
    );
    const { rerender } = render(tree("/microgrids/a/operations"));
    rerender(tree("/microgrids/a/operations"));
    expect(runtime.refresh).toHaveBeenCalledTimes(1);
    rerender(tree("/microgrids/b/operations"));
    expect(runtime.refresh).toHaveBeenCalledTimes(2);
  });

  it("does not refresh for a place the manifest shows", () => {
    const runtime = recordingRuntime();
    const resolve = () => initial;
    const tree = (pathname: string) => (
      <KitRuntimeProvider runtime={{ ...runtime, pathname }}>
        <KitProvider manifest={manifest()} initial={initial} resolve={resolve}>{null}</KitProvider>
      </KitRuntimeProvider>
    );
    const { rerender } = render(tree("/microgrids/a/operations"));
    rerender(tree("/microgrids/b/operations"));
    expect(runtime.refresh).not.toHaveBeenCalled();
  });
});

describe("kit", () => {
  it("exports every GuiKit name except the views still to come", () => {
    const names: (keyof GuiKit)[] = [
      "useManifest", "useView", "useSignals", "useLive", "useFeed", "loadView", "search", "Link",
      "navigate", "refresh", "usePathname", "useUiParam", "act", "open", "SignOut",
    ];
    expect(Object.keys(kit).sort()).toEqual([...names].sort());
  });
});
