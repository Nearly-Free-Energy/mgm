import { render } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Manifest, OverlayProps, Signals, ViewState } from "../../../contract";
import { HostKitProvider } from "../host-kit-provider";
import { useView, type KitProvider } from "../kit-provider";
import { KitRuntimeProvider } from "../kit-runtime";
import { initial, manifest, MG, ORG, recordingRuntime } from "./kit-test-utils";

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

vi.mock("next/navigation", () => ({
  usePathname: () => null,
  useSearchParams: () => null,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  vi.clearAllMocks();
  seenProps.length = 0;
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

  it("hands KitProvider the GUI's action slots and the signals it was given", () => {
    const Overlay: (props: OverlayProps) => null = () => null;
    const forms = {};
    const signals = {} as Signals;
    render(
      <KitRuntimeProvider runtime={{ ...recordingRuntime(), pathname: "/" }}>
        <HostKitProvider manifest={withNav()} initial={initial} actions={{ Overlay, forms }} signals={signals}>
          <Probe />
        </HostKitProvider>
      </KitRuntimeProvider>
    );
    const props = seenProps.at(-1)!;
    expect(props.actions?.Overlay).toBe(Overlay);
    expect(props.actions?.forms).toBe(forms);
    expect(props.signals).toBe(signals);
    expect(typeof props.resolve).toBe("function");
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
});
