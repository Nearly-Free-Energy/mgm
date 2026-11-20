import { act, render, waitFor } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MGM_NAVIGATION_HOLD_EVENT, MGM_NAVIGATION_SETTLED_EVENT } from "@/components/ui/navigation-progress";
import type { Manifest, OverlayProps, Signals, ViewState } from "../../../contract";
import { HostKitProvider } from "../host-kit-provider";
import { useSignals, useView, type KitProvider } from "../kit-provider";
import { KitRuntimeProvider } from "../kit-runtime";
import { ViewBoundary } from "../view-boundary";
import { initial, manifest, MG, model, ORG, recordingRuntime } from "./kit-test-utils";

// The real KitProvider, recording the props HostKitProvider hands it.
const seenProps = vi.hoisted(() => [] as ComponentProps<typeof KitProvider>[]);
vi.mock("../kit-provider", async (importOriginal) => {
  const real = await importOriginal<typeof import("../kit-provider")>();
  return {
    ...real,
    KitProvider: (props: ComponentProps<typeof real.KitProvider>) => {
      seenProps.push(props);
      return createElement(real.KitProvider, props);
    },
  };
});

const next = vi.hoisted(() => ({ searchParams: null as URLSearchParams | null }));
vi.mock("next/navigation", () => ({
  usePathname: () => null,
  useSearchParams: () => next.searchParams,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  vi.clearAllMocks();
  seenProps.length = 0;
  next.searchParams = null;
  document.cookie = "mgm-org=; Max-Age=0; Path=/";
});

function withNav(): Manifest {
  const m = manifest();
  m.org.nav = [
    { id: "org.today", title: "Dashboard", group: "operate", icon: "today", order: 10, href: "/", needs: [] },
    {
      id: "billing.periods",
      title: "Billing",
      group: "money",
      icon: "billing",
      order: 10,
      href: "/microgrids/[microgrid]/billing",
      needs: ["microgrid"],
    },
  ] as Manifest["org"]["nav"];
  return m;
}

describe("HostKitProvider", () => {
  const seen: ViewState[] = [];
  function Probe() {
    seen.push(useView());
    return null;
  }

  function tree(runtime: ReturnType<typeof recordingRuntime>, pathname: string, m: Manifest) {
    return (
      <KitRuntimeProvider runtime={{ ...runtime, pathname }}>
        <HostKitProvider manifest={m} initial={initial}>
          <Probe />
        </HostKitProvider>
      </KitRuntimeProvider>
    );
  }

  it("follows the pathname after a soft navigation, from the manifest it holds", () => {
    const runtime = recordingRuntime();
    const m = withNav();
    const { rerender } = render(tree(runtime, "/", m));
    expect(seen.at(-1)?.title).toBe("Dashboard");

    rerender(tree(runtime, `/microgrids/${MG}/billing`, m));
    const view = seen.at(-1)!;
    expect(view.title).toBe("Billing");
    expect(view.scope.microgrid?.id).toBe(MG);
    expect(view.trail.map((crumb) => crumb.label)).toEqual(["Org", "Site", "Billing"]);
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it("shows the organization alone on a path that is no catalog page", () => {
    const runtime = recordingRuntime();
    render(tree(runtime, "/no-such-page", withNav()));
    expect(seen.at(-1)).toMatchObject({ view: null, title: "Org", trail: [{ label: "Org", href: `/organizations/${ORG}` }] });
  });

  it("hands KitProvider the GUI's action slots and the signals it fetched for the manifest's organization", async () => {
    const Overlay: (props: OverlayProps) => null = () => null;
    const forms = {};
    const signals: Signals = { type: "signals", org: ORG, count: 2, top: [], checked: ["billing.due"], unchecked: [] };
    const fetch = vi.fn(async () => Response.json(signals));
    render(
      <KitRuntimeProvider runtime={{ ...recordingRuntime({ fetch }), pathname: "/" }}>
        <HostKitProvider manifest={withNav()} initial={initial} actions={{ Overlay, forms }}>
          <Probe />
        </HostKitProvider>
      </KitRuntimeProvider>
    );
    const props = seenProps.at(-1)!;
    expect(props.actions?.Overlay).toBe(Overlay);
    expect(props.actions?.forms).toBe(forms);
    expect(typeof props.resolve).toBe("function");
    expect(typeof props.refreshSignals).toBe("function");
    expect(typeof props.seedSignals).toBe("function");
    await waitFor(() => expect(seenProps.at(-1)!.signals).toEqual(signals));
    expect(fetch).toHaveBeenCalledWith(`/api/gui/signals?org=${ORG}`, expect.objectContaining({ cache: "no-store" }));
  });

  it("re-renders what reads the signals when they arrive, and not what reads the rest of the kit", async () => {
    // A page's views read the kit and sit inside the page's Suspense
    // boundary, which may still be hydrating when the signals land: they
    // must not re-render then (SignalsContext in ../kit-provider.tsx).
    const signals: Signals = { type: "signals", org: ORG, count: 3, top: [], checked: ["billing.due"], unchecked: [] };
    const fetch = vi.fn(async () => Response.json(signals));
    const renders = { view: 0 };
    const seen: (Signals | null)[] = [];
    function ViewReader() {
      useView();
      renders.view += 1;
      return null;
    }
    function SignalsReader() {
      seen.push(useSignals());
      return null;
    }
    render(
      <KitRuntimeProvider runtime={{ ...recordingRuntime({ fetch }), pathname: "/" }}>
        <HostKitProvider manifest={withNav()} initial={initial}>
          <ViewReader />
          <SignalsReader />
        </HostKitProvider>
      </KitRuntimeProvider>
    );
    const before = renders.view;
    await waitFor(() => expect(seen.at(-1)).toEqual(signals));
    expect(renders.view).toBe(before);
  });

  it("takes the signals a published view's model carries instead of fetching them", async () => {
    const signals: Signals = { type: "signals", org: ORG, count: 1, top: [], checked: ["billing.due"], unchecked: [] };
    const fetch = vi.fn(async () => Response.json({ ...signals, count: 5 }));
    const today = model({ view: "org.today", signals });
    render(
      <KitRuntimeProvider runtime={{ ...recordingRuntime({ fetch }), pathname: "/" }}>
        <HostKitProvider manifest={withNav()} initial={initial}>
          <ViewBoundary initial={initial} model={today} />
        </HostKitProvider>
      </KitRuntimeProvider>
    );
    await waitFor(() => expect(seenProps.at(-1)!.signals).toEqual(signals));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
    expect(seenProps.at(-1)!.signals).toEqual(signals);
  });

  it("fetches no signals for a tenant manifest, whose org is a unit and not among its orgs", async () => {
    const fetch = vi.fn(async () => new Response("null", { status: 404 }));
    const tenant = withNav();
    tenant.orgs = [];
    render(
      <KitRuntimeProvider runtime={{ ...recordingRuntime({ fetch }), pathname: "/my" }}>
        <HostKitProvider manifest={tenant} initial={initial}>
          <Probe />
        </HostKitProvider>
      </KitRuntimeProvider>
    );
    // The feed's first fetch waits a turn (signals-feed.ts), so wait past it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(seenProps.at(-1)!.signals).toBeNull();
  });

  it("remembers the manifest's organization in the mgm-org cookie", () => {
    const runtime = recordingRuntime();
    const m = withNav();
    const { rerender } = render(tree(runtime, "/", m));
    expect(document.cookie).toBe(`mgm-org=${ORG}`);

    const other = withNav();
    other.org = { ...other.org, id: "00000000-0000-4000-8000-000000000002" };
    rerender(tree(runtime, "/", other));
    expect(document.cookie).toBe("mgm-org=00000000-0000-4000-8000-000000000002");
  });

  it("writes no cookie without a manifest", () => {
    render(
      <KitRuntimeProvider runtime={{ ...recordingRuntime(), pathname: "/" }}>
        <HostKitProvider manifest={null} initial={initial}>
          {null}
        </HostKitProvider>
      </KitRuntimeProvider>
    );
    expect(document.cookie).toBe("");
  });

  it("rebuilds the manifest once for a place it does not list", () => {
    const runtime = recordingRuntime();
    const elsewhere = "/microgrids/00000000-0000-4000-8000-0000000000b2/billing";
    const { rerender } = render(tree(runtime, elsewhere, withNav()));
    rerender(tree(runtime, elsewhere, withNav()));
    expect(runtime.refresh).toHaveBeenCalledTimes(1);
  });

  describe("with two organizations", () => {
    const OTHER = "00000000-0000-4000-8000-000000000002";
    /** A manifest showing `id`, built afresh as each server render builds one. */
    function showing(id: string): Manifest {
      const m = withNav();
      const orgs = [
        { id: ORG, name: "Org", href: `/organizations/${ORG}` },
        { id: OTHER, name: "Other", href: `/organizations/${OTHER}` },
      ] as Manifest["orgs"];
      const name = orgs.find((o) => o.id === id)!.name;
      m.orgs = orgs;
      m.org = { ...m.org, id, name, href: `/organizations/${id}`, places: id === ORG ? m.org.places : [] };
      return m;
    }
    const query = (org: string) => new URLSearchParams({ org });
    const at = (id: string) => `/organizations/${id}`;

    it("rebuilds the manifest when ?org= switches to another organization on the same path", () => {
      const runtime = recordingRuntime();
      next.searchParams = query(ORG);
      const { rerender } = render(tree(runtime, "/communities", showing(ORG)));
      expect(runtime.refresh).not.toHaveBeenCalled();

      // HierarchyNav's switch: a soft navigation that changes only the query.
      next.searchParams = query(OTHER);
      rerender(tree(runtime, "/communities", showing(ORG)));
      expect(runtime.refresh).toHaveBeenCalledTimes(1);

      // The rebuilt manifest shows the requested organization: nothing more to do.
      rerender(tree(runtime, "/communities", showing(OTHER)));
      expect(runtime.refresh).toHaveBeenCalledTimes(1);

      // And back again, compared as the server compares it.
      next.searchParams = query(` ${ORG.toUpperCase()} `);
      rerender(tree(runtime, "/communities", showing(OTHER)));
      expect(runtime.refresh).toHaveBeenCalledTimes(2);
      rerender(tree(runtime, "/communities", showing(ORG)));
      expect(runtime.refresh).toHaveBeenCalledTimes(2);
    });

    it("holds the navigation bar from the rebuild until the manifest shows the requested organization", () => {
      const events: string[] = [];
      const record = (e: Event) => events.push(e.type);
      window.addEventListener(MGM_NAVIGATION_HOLD_EVENT, record);
      window.addEventListener(MGM_NAVIGATION_SETTLED_EVENT, record);
      try {
        const runtime = recordingRuntime();
        next.searchParams = query(ORG);
        const { rerender } = render(tree(runtime, "/communities", showing(ORG)));
        expect(events).toEqual([]);

        next.searchParams = query(OTHER);
        rerender(tree(runtime, "/communities", showing(ORG)));
        expect(runtime.refresh).toHaveBeenCalledTimes(1);
        expect(events).toEqual([MGM_NAVIGATION_HOLD_EVENT]);
        // The same manifest rendered again starts no second rebuild and no second hold.
        rerender(tree(runtime, "/communities", showing(ORG)));
        expect(events).toEqual([MGM_NAVIGATION_HOLD_EVENT]);

        rerender(tree(runtime, "/communities", showing(OTHER)));
        expect(events).toEqual([MGM_NAVIGATION_HOLD_EVENT, MGM_NAVIGATION_SETTLED_EVENT]);
        rerender(tree(runtime, "/communities", showing(OTHER)));
        expect(events).toHaveLength(2);
      } finally {
        window.removeEventListener(MGM_NAVIGATION_HOLD_EVENT, record);
        window.removeEventListener(MGM_NAVIGATION_SETTLED_EVENT, record);
      }
    });

    it("settles a hold it still has when it unmounts, and announces nothing otherwise", () => {
      const events: string[] = [];
      const record = (e: Event) => events.push(e.type);
      window.addEventListener(MGM_NAVIGATION_HOLD_EVENT, record);
      window.addEventListener(MGM_NAVIGATION_SETTLED_EVENT, record);
      try {
        next.searchParams = query(ORG);
        render(tree(recordingRuntime(), "/communities", showing(ORG))).unmount();
        expect(events).toEqual([]);

        const runtime = recordingRuntime();
        const { rerender, unmount } = render(tree(runtime, "/communities", showing(ORG)));
        next.searchParams = query(OTHER);
        rerender(tree(runtime, "/communities", showing(ORG)));
        expect(events).toEqual([MGM_NAVIGATION_HOLD_EVENT]);
        unmount();
        expect(events).toEqual([MGM_NAVIGATION_HOLD_EVENT, MGM_NAVIGATION_SETTLED_EVENT]);
      } finally {
        window.removeEventListener(MGM_NAVIGATION_HOLD_EVENT, record);
        window.removeEventListener(MGM_NAVIGATION_SETTLED_EVENT, record);
      }
    });

    it("rebuilds at most once for an ?org= the server does not follow", () => {
      const runtime = recordingRuntime();
      next.searchParams = query(OTHER);
      // The path names a place in ORG, which the server prefers over ?org=.
      const place = `/microgrids/${MG}/billing`;
      const { rerender } = render(tree(runtime, place, showing(ORG)));
      rerender(tree(runtime, place, showing(ORG)));
      rerender(tree(runtime, place, showing(ORG)));
      expect(runtime.refresh).toHaveBeenCalledTimes(1);
    });

    it("does not rebuild for an ?org= the person cannot see or that is no id", () => {
      const runtime = recordingRuntime();
      next.searchParams = query("00000000-0000-4000-8000-0000000000ff");
      const { rerender } = render(tree(runtime, "/communities", showing(ORG)));
      next.searchParams = query("not-an-id");
      rerender(tree(runtime, "/communities", showing(ORG)));
      expect(runtime.refresh).not.toHaveBeenCalled();
    });

    it("rebuilds on every switch A, B, A, B, but once per pathname per manifest", () => {
      const runtime = recordingRuntime();
      const { rerender } = render(tree(runtime, at(ORG), showing(ORG)));
      expect(runtime.refresh).not.toHaveBeenCalled();

      rerender(tree(runtime, at(OTHER), showing(ORG)));
      expect(runtime.refresh).toHaveBeenCalledTimes(1);
      rerender(tree(runtime, at(OTHER), showing(OTHER)));

      rerender(tree(runtime, at(ORG), showing(OTHER)));
      expect(runtime.refresh).toHaveBeenCalledTimes(2);
      rerender(tree(runtime, at(ORG), showing(ORG)));

      rerender(tree(runtime, at(OTHER), showing(ORG)));
      expect(runtime.refresh).toHaveBeenCalledTimes(3);
      rerender(tree(runtime, at(OTHER), showing(OTHER)));
      expect(seen.at(-1)?.org.id).toBe(OTHER);

      // A rebuilt manifest that still cannot show the path (the places cap):
      // a new manifest object for the same organization asks no more.
      const elsewhere = "/microgrids/00000000-0000-4000-8000-0000000000b2/billing";
      rerender(tree(runtime, elsewhere, showing(OTHER)));
      expect(runtime.refresh).toHaveBeenCalledTimes(4);
      rerender(tree(runtime, elsewhere, showing(OTHER)));
      rerender(tree(runtime, elsewhere, showing(OTHER)));
      expect(runtime.refresh).toHaveBeenCalledTimes(4);
    });

    it("rebuilds after a switch made by path, then by ?org=, then by path again", () => {
      const runtime = recordingRuntime();
      const { rerender } = render(tree(runtime, at(ORG), showing(ORG)));
      rerender(tree(runtime, at(OTHER), showing(ORG)));
      expect(runtime.refresh).toHaveBeenCalledTimes(1);
      rerender(tree(runtime, at(OTHER), showing(OTHER)));
      next.searchParams = query(ORG);
      rerender(tree(runtime, "/communities", showing(OTHER)));
      expect(runtime.refresh).toHaveBeenCalledTimes(2);
      rerender(tree(runtime, "/communities", showing(ORG)));
      next.searchParams = null;
      rerender(tree(runtime, at(OTHER), showing(ORG)));
      expect(runtime.refresh).toHaveBeenCalledTimes(3);
    });

    it("rebuilds after a switch made by ?org=, then by path, then by ?org= again", () => {
      const runtime = recordingRuntime();
      next.searchParams = query(ORG);
      const { rerender } = render(tree(runtime, "/communities", showing(ORG)));
      next.searchParams = query(OTHER);
      rerender(tree(runtime, "/communities", showing(ORG)));
      expect(runtime.refresh).toHaveBeenCalledTimes(1);
      rerender(tree(runtime, "/communities", showing(OTHER)));
      next.searchParams = null;
      rerender(tree(runtime, at(ORG), showing(OTHER)));
      expect(runtime.refresh).toHaveBeenCalledTimes(2);
      rerender(tree(runtime, at(ORG), showing(ORG)));
      next.searchParams = query(OTHER);
      rerender(tree(runtime, "/communities", showing(ORG)));
      expect(runtime.refresh).toHaveBeenCalledTimes(3);
    });
  });

  describe("with a tenant manifest of two units", () => {
    const UNIT_A = "00000000-0000-4000-8000-0000000000a1";
    const UNIT_B = "00000000-0000-4000-8000-0000000000a2";
    /** The tenant manifest the server builds with `id` as the current unit. */
    function showing(id: string): Manifest {
      const m = manifest();
      const units = [
        { id: UNIT_A, label: "Shop 9", timezone: "Africa/Kampala" },
        { id: UNIT_B, label: "Flat 2", timezone: "Africa/Nairobi" },
      ];
      const unit = units.find((u) => u.id === id)!;
      m.orgs = [];
      m.org = {
        ...m.org,
        id,
        name: unit.label,
        href: `/my?unit=${id}`,
        timezone: unit.timezone,
        nav: [],
        status: [],
        places: units.map((u) => ({ kind: "tenant", id: u.id, label: u.label, href: `/my?unit=${u.id}` })),
      };
      return m;
    }
    const query = (unit: string) => new URLSearchParams({ unit });

    it("rebuilds the manifest when the picker's soft navigation changes ?unit= to another unit", () => {
      const runtime = recordingRuntime();
      next.searchParams = query(UNIT_A);
      const { rerender } = render(tree(runtime, "/my", showing(UNIT_A)));
      expect(runtime.refresh).not.toHaveBeenCalled();
      expect(document.cookie).toBe(`mgm-org=${UNIT_A}`);

      next.searchParams = query(UNIT_B);
      rerender(tree(runtime, "/my", showing(UNIT_A)));
      expect(runtime.refresh).toHaveBeenCalledTimes(1);

      // The rebuilt manifest names unit B: its context, clock and cookie follow.
      rerender(tree(runtime, "/my", showing(UNIT_B)));
      expect(runtime.refresh).toHaveBeenCalledTimes(1);
      expect(seen.at(-1)?.org).toMatchObject({ id: UNIT_B, name: "Flat 2", timezone: "Africa/Nairobi" });
      expect(document.cookie).toBe(`mgm-org=${UNIT_B}`);

      // And back, compared in lower case as chooseTenantUnit compares it.
      next.searchParams = query(UNIT_A.toUpperCase());
      rerender(tree(runtime, "/my", showing(UNIT_B)));
      expect(runtime.refresh).toHaveBeenCalledTimes(2);
    });

    it("does not rebuild for the current unit, a unit not among its places, or two units at once", () => {
      const runtime = recordingRuntime();
      next.searchParams = query(UNIT_A);
      const { rerender } = render(tree(runtime, "/my", showing(UNIT_A)));
      next.searchParams = query("00000000-0000-4000-8000-0000000000ff");
      rerender(tree(runtime, "/my", showing(UNIT_A)));
      next.searchParams = new URLSearchParams([
        ["unit", UNIT_B],
        ["unit", UNIT_A],
      ]);
      rerender(tree(runtime, "/my", showing(UNIT_A)));
      expect(runtime.refresh).not.toHaveBeenCalled();
    });

    it("ignores ?unit= in a staff manifest, whose places are no units", () => {
      const runtime = recordingRuntime();
      next.searchParams = query(MG);
      render(tree(runtime, "/", withNav()));
      expect(runtime.refresh).not.toHaveBeenCalled();
    });
  });
});
