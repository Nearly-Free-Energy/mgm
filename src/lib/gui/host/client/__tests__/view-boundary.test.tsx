import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InitialView, Manifest, ViewState } from "../../../contract";
import { HostKitProvider } from "../host-kit-provider";
import { useView } from "../kit-provider";
import { KitRuntimeProvider } from "../kit-runtime";
import { ViewBoundary } from "../view-boundary";
import { initial, manifest, MG, model, ORG, recordingRuntime } from "./kit-test-utils";

vi.mock("next/navigation", () => ({
  usePathname: () => null,
  useSearchParams: () => null,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  vi.clearAllMocks();
  document.cookie = "mgm-org=; Max-Age=0; Path=/";
});

const OPERATIONS = `/microgrids/${MG}/operations`;

function withNav(): Manifest {
  const m = manifest();
  m.org.places = [{ kind: "microgrid", id: MG, label: "Site", href: `/microgrids/${MG}` }];
  m.org.nav = [
    { id: "org.today", title: "Dashboard", group: "operate", icon: "today", order: 10, href: "/", needs: [] },
    {
      id: "metering.operations",
      title: "Operations",
      group: "operate",
      icon: "live",
      order: 40,
      href: "/microgrids/[microgrid]/operations",
      needs: ["microgrid"],
    },
  ] as Manifest["org"]["nav"];
  return m;
}

const day = model({ view: "metering.site-day", title: "Tuesday 10 November" });

describe("ViewBoundary on a contributed view's page", () => {
  const seen: ViewState[] = [];
  function Probe() {
    seen.push(useView());
    return null;
  }
  const tree = (runtime: ReturnType<typeof recordingRuntime>, pathname: string, start: InitialView = initial, withBoundary = true) => (
    <KitRuntimeProvider runtime={{ ...runtime, pathname }}>
      <HostKitProvider manifest={withNav()} initial={start}>
        {withBoundary && <ViewBoundary model={day} />}
        <Probe />
      </HostKitProvider>
    </KitRuntimeProvider>
  );

  it("publishes the view's title with the scope and trail its path names in the manifest", () => {
    const runtime = recordingRuntime();
    render(tree(runtime, OPERATIONS));
    const view = seen.at(-1)!;
    expect(view).toMatchObject({ view: "metering.site-day", title: "Tuesday 10 November", model: day });
    expect(view.scope.microgrid?.id).toBe(MG);
    expect(view.scope.organization?.id).toBe(ORG);
    expect(view.trail.map((crumb) => crumb.label)).toEqual(["Org", "Site", "Operations"]);
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it("shows the layout's initial view on its own pathname before any boundary, and follows the pathname after", () => {
    const runtime = recordingRuntime();
    const first: InitialView = { ...initial, view: "metering.site-day", title: "From the layout" };
    const { rerender } = render(tree(runtime, OPERATIONS, first, false));
    expect(seen.at(-1)).toMatchObject({ view: "metering.site-day", title: "From the layout", model: null });

    rerender(tree(runtime, "/", first, false));
    expect(seen.at(-1)).toMatchObject({ view: null, title: "Dashboard" });
  });

  it("takes a new initial view from the layout on the pathname current when it arrives", () => {
    const runtime = recordingRuntime();
    const a: InitialView = { ...initial, view: "metering.site-day", title: "A" };
    const b: InitialView = { ...initial, view: "metering.site-day", title: "B" };
    const { rerender } = render(tree(runtime, OPERATIONS, a, false));
    rerender(tree(runtime, OPERATIONS, b, false));
    expect(seen.at(-1)).toMatchObject({ view: "metering.site-day", title: "B" });

    // The layout's render belongs to OPERATIONS; a soft navigation away resolves the new pathname.
    rerender(tree(runtime, "/", b, false));
    expect(seen.at(-1)).toMatchObject({ view: null, title: "Dashboard" });
  });

  it("rebuilds the manifest once when the boundary's view is unplaced, even where the legacy view is placed", () => {
    const runtime = recordingRuntime();
    const unplaced = { ...initial, view: "metering.site-day", title: "Tuesday 10 November", unplaced: true } as InitialView;
    const placed = (
      <KitRuntimeProvider runtime={{ ...runtime, pathname: OPERATIONS }}>
        <HostKitProvider manifest={withNav()} initial={initial}>
          <ViewBoundary model={day} initial={unplaced} />
          <Probe />
        </HostKitProvider>
      </KitRuntimeProvider>
    );
    const { rerender } = render(placed);
    rerender(placed);
    expect(runtime.refresh).toHaveBeenCalledTimes(1);
  });

  it("rebuilds the manifest once for a view whose place the manifest does not list", () => {
    const runtime = recordingRuntime();
    const elsewhere = "/microgrids/00000000-0000-4000-8000-0000000000b2/operations";
    const { rerender } = render(tree(runtime, elsewhere));
    rerender(tree(runtime, elsewhere));
    expect(seen.at(-1)?.title).toBe("Tuesday 10 November");
    expect(runtime.refresh).toHaveBeenCalledTimes(1);
  });
});
