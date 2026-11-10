/** Shared fixtures for the kit's jsdom tests: a manifest, an initial view and a recording runtime. */
import { vi } from "vitest";
import type { InitialView, Manifest, ViewModel } from "../../../contract";
import type { KitRuntime } from "../kit-runtime";

export const ORG = "00000000-0000-4000-8000-000000000001";
export const MG = "00000000-0000-4000-8000-0000000000a1";

export function manifest(): Manifest {
  return {
    type: "manifest",
    contract: "0.1.0",
    release: null,
    locale: "en",
    now: "2026-11-10T12:00:00.000Z",
    gui: "gridtop",
    user: { name: "Ann", email: "ann@example.test" },
    org: {
      id: ORG,
      name: "Org",
      href: `/organizations/${ORG}`,
      timezone: null,
      nav: [],
      status: [],
      places: [{ kind: "microgrid", id: MG, label: "Site", href: `/microgrids/${MG}/operations` }],
    },
    orgs: [{ id: ORG, name: "Org", href: `/organizations/${ORG}` }],
  };
}

export const initial: InitialView = { view: null, title: "Dashboard", trail: [], tabs: [], scope: {} };

export function model(over: Partial<ViewModel> = {}): ViewModel {
  return {
    type: "view",
    view: "metering.operations",
    kind: "record",
    body: { sections: [] },
    title: "Operations",
    org: ORG,
    trail: [],
    actions: [],
    links: [],
    attached: [],
    ...over,
  } as ViewModel;
}

export function recordingRuntime(over: Partial<KitRuntime> = {}) {
  return {
    navigate: vi.fn(),
    refresh: vi.fn(),
    fetch: vi.fn(async () => new Response("null", { status: 404 })),
    act: vi.fn(),
    open: vi.fn(async () => {}),
    pathname: "/",
    ...over,
  } satisfies KitRuntime;
}
