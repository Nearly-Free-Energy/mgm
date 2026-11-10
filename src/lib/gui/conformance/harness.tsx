/**
 * Renders a GUI inside the real kit, with a runtime that records every kit
 * call instead of making it. Nothing here sends a request: fetch answers from
 * the fixture, and the runtime is installed before the GUI first renders.
 * Imported only by test files (gui-boundary.test.ts).
 */
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ActionRef, GuiPlugin, Href, LinkRef, ShellProps, ViewModel } from "../contract";
import { KitProvider } from "../host/client/kit-provider";
import { KitRuntimeProvider, type KitRuntime } from "../host/client/kit-runtime";
import { pickRenderer } from "../host/shared/pick-renderer";
import { RawView } from "../kit/raw-view";
import { PAGE_MODEL, type ManifestFixture } from "./fixtures/manifests";

export interface Recorded {
  act: ActionRef[];
  open: LinkRef[];
  navigate: Href[];
  /** The hrefs loadView() asked the host for. */
  loadView: string[];
  /** The queries search() sent. */
  search: string[];
  /** Any other URL the kit fetched. */
  fetch: string[];
  refresh: number;
  signOut: number;
}

const CANCELLED = { type: "result", ok: false, status: 0, code: "cancelled", message: "Cancelled." } as const;

export function recordingRuntime(input: { pathname: string; model?: ViewModel | null }): {
  runtime: KitRuntime;
  log: Recorded;
} {
  const log: Recorded = { act: [], open: [], navigate: [], loadView: [], search: [], fetch: [], refresh: 0, signOut: 0 };
  const runtime: KitRuntime = {
    pathname: input.pathname,
    navigate: (href) => void log.navigate.push(href),
    refresh: () => void log.refresh++,
    act: async (ref) => {
      log.act.push(ref);
      return CANCELLED;
    },
    open: async (link) => void log.open.push(link),
    signOut: async () => void log.signOut++,
    fetch: async (url) => {
      const parsed = new URL(url, "http://kit.test");
      if (parsed.pathname === "/api/gui/view") {
        log.loadView.push(parsed.searchParams.get("href") ?? "");
        return input.model ? Response.json(input.model) : Response.json({ code: "not_found" }, { status: 404 });
      }
      if (parsed.pathname === "/api/gui/search") {
        log.search.push(parsed.searchParams.get("q") ?? "");
        return Response.json([]);
      }
      log.fetch.push(url);
      return Response.json(null, { status: 404 });
    },
  };
  return { runtime, log };
}

/** A model drawn the way production draws it: bespoke renderer, the GUI's View, or RawView. */
export function ModelView({ gui, model }: { gui: GuiPlugin; model: ViewModel }) {
  const choice = pickRenderer(gui, model);
  const Component = choice.source === "raw" ? RawView : choice.Component;
  return <Component model={model} />;
}

export interface Rendered {
  log: Recorded;
  pathname: string;
  /** Renders the same Shell as if the page had moved to `pathname`. */
  goTo(pathname: string): Promise<void>;
  unmount(): void;
}

const isAsync = (fn: unknown) => Object.prototype.toString.call(fn) === "[object AsyncFunction]";

/**
 * How many rounds of zero-delay timers settle() lets run. Work a GUI chains
 * through more rounds than this, or schedules with a real delay, is not seen.
 */
const SETTLE_ROUNDS = 5;

/** Lets effects, microtasks and chained zero-delay timers run. */
export async function settle(): Promise<void> {
  await act(async () => {
    for (let round = 0; round < SETTLE_ROUNDS; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/**
 * Renders the Shell for a fixture, with `child` (by default the fixture's
 * page drawn by the GUI) as its children. An async Shell (a server
 * component) is awaited once and its result rendered; a Shell must not nest
 * further async components.
 *
 * The providers mount first with no children, so the recording runtime is
 * already current when the GUI renders: KitRuntimeProvider installs it in a
 * layout effect, which runs after its children's own render and layout
 * effects. If that provider starts installing the runtime during render,
 * the first pass can go.
 */
export async function renderShell(gui: GuiPlugin, fixture: ManifestFixture, child?: ReactNode): Promise<Rendered> {
  const { runtime, log } = recordingRuntime({ pathname: fixture.pathname });
  const tree = (content: ReactNode, at: KitRuntime = runtime) => (
    <KitRuntimeProvider runtime={at}>
      <KitProvider manifest={fixture.manifest} initial={fixture.initial}>
        {content}
      </KitProvider>
    </KitRuntimeProvider>
  );
  let rerender: (ui: ReactNode) => void = () => {};
  await act(async () => {
    rerender = render(tree(null)).rerender;
  });
  const props: ShellProps = { manifest: fixture.manifest, initial: fixture.initial, children: child ?? <ModelView gui={gui} model={PAGE_MODEL} /> };
  const Shell = gui.Shell as (p: ShellProps) => ReactNode;
  const shell = isAsync(gui.Shell) ? await gui.Shell(props) : <Shell {...props} />;
  await act(async () => {
    rerender(tree(shell));
  });
  await settle();
  const goTo = async (pathname: string) => {
    await act(async () => {
      rerender(tree(shell, { ...runtime, pathname }));
    });
  };
  return { log, pathname: fixture.pathname, goTo, unmount: cleanup };
}
