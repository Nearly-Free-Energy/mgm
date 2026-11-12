/**
 * Check 9: the frames a GUI may bring, checked only when it brings them.
 *
 * The Overlay is mounted by the host's own ActionHost, which hands it HostSlot
 * and portals the step into it, so the check sees what production renders.
 * The Overlay is wrapped only to count its onDismiss calls. The step is a
 * sentinel bespoke form (role "form") or the host's ConfirmStep with a plain
 * ceremony (role "confirm", tone "danger").
 */
import { act, fireEvent, queryAllByRole, render, waitFor } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { setViewportWidth } from "@/test/gui-setup";
import type { ActionRef, GuiPlugin, OverlayProps, PublicPage, SyncComponent } from "../contract";
import { KitProvider } from "../host/client/kit-provider";
import { hostAct, KitRuntimeProvider } from "../host/client/kit-runtime";
import type { PreparedAction } from "../host/server/prepare";
import { controlName, CONTROLS } from "./crawl";
import { WIDTHS, type Finding } from "./findings";
import { MANIFEST_FIXTURES } from "./fixtures/manifests";
import { recordingRuntime, renderInKit, serverNode, settle } from "./harness";
import { holding, pageText } from "./inspect";

const ACTION = "acme.frame";
const TITLE = "Frame the step";
const FIELD = "Sentinel field";
const SUBMIT = "Sentinel submit";
const STATEMENT = "Sentinel statement for the frame check.";
const PAGE_TEXT = "Sentinel page content";
const PAGES = Object.keys({
  login: 1,
  "forgot-password": 1,
  "reset-password": 1,
  "accept-invite": 1,
  "no-access": 1,
  setup: 1,
} satisfies Record<PublicPage, 1>) as PublicPage[];
const CASES = [
  { role: "form", tone: "neutral" },
  { role: "confirm", tone: "danger" },
] as const;

function prepared(role: OverlayProps["role"]): PreparedAction {
  return {
    type: "prepared",
    spec: {
      type: "spec",
      id: ACTION,
      title: TITLE,
      confirm: "confirm",
      inputVersion: 1,
      input: { type: "object", properties: role === "form" ? { note: { type: "string" } } : {} },
    },
    confirm: "confirm",
    method: "POST",
    path: "/api/acme/frame",
    bound: {},
    ceremony: role === "confirm" ? { type: "ceremony", statement: STATEMENT, facts: [], warnings: [], acknowledgements: [] } : null,
  };
}

/** The host content of the form case; it has no Cancel, so any the frame shows is the frame's own. */
function SentinelForm() {
  return (
    <form data-conformance-sentinel="">
      <label>
        {FIELD} <input name="note" />
      </label>
      <button type="submit">{SUBMIT}</button>
    </form>
  );
}

/** The host content that must sit inside the frame, by role. */
const CONTROLS_OF = { form: [["textbox", FIELD], ["button", SUBMIT]], confirm: [["button", "Cancel"], ["button", TITLE]] } as const;

async function overlay(Overlay: SyncComponent<OverlayProps>, role: OverlayProps["role"], tone: OverlayProps["tone"]): Promise<string[]> {
  const found: string[] = [];
  let dismissed = 0;
  function Counted(props: OverlayProps) {
    return <Overlay {...props} onDismiss={() => ((dismissed += 1), props.onDismiss())} />;
  }
  const fixture = MANIFEST_FIXTURES[0];
  const runtime = {
    ...recordingRuntime({ pathname: fixture.pathname }).runtime,
    act: hostAct,
    fetch: async (url: string) =>
      url === "/api/gui/prepare" ? Response.json(prepared(role)) : Response.json(null, { status: 404 }),
  };
  const ref: ActionRef = { action: ACTION, params: {}, label: TITLE, enabled: true, ...(tone === "danger" ? { tone } : {}) };
  const { unmount } = render(
    <KitRuntimeProvider runtime={runtime}>
      <KitProvider
        manifest={fixture.manifest}
        initial={fixture.initial}
        actions={{ Overlay: Counted, forms: { [ACTION]: { reads: [1], Component: SentinelForm } } }}
      >
        {null}
      </KitProvider>
    </KitRuntimeProvider>,
  );
  try {
    await act(async () => void hostAct(ref));
    await settle();
    const marker = role === "form" ? FIELD : STATEMENT;
    // The host loads its steps lazily; frameFindings imports them first (see there), so this wait is short.
    await waitFor(
      () => {
        if (!pageText().includes(marker)) throw new Error("The step is not on the page.");
      },
      { timeout: 500 },
    ).catch(() => undefined);
    const frames = (["dialog", "alertdialog", "region"] as const).flatMap((r) => queryAllByRole(document.body, r, { name: TITLE }));
    const frame = frames[0];
    if (!frame) return [`frames the ${role} step with no dialog named "${TITLE}"`];
    if (!holding(marker).some((el) => frame.contains(el))) found.push(`does not show the host's ${role} step inside the dialog`);
    for (const [controlRole, name] of CONTROLS_OF[role]) {
      if (queryAllByRole(frame, controlRole, { name }).length === 0) found.push(`does not hold the host's ${controlRole} "${name}"`);
    }
    if (role === "form") {
      await act(async () => void fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
      const closers = [...frame.querySelectorAll(CONTROLS)].filter(
        (el) => /close|cancel/i.test(controlName(el)) && !el.closest("[data-conformance-sentinel]"),
      );
      for (const el of closers) if (dismissed === 0) await act(async () => void fireEvent.click(el));
      if (dismissed === 0) found.push("calls onDismiss neither on Escape nor from a control named Close or Cancel");
    }
  } finally {
    unmount();
  }
  return found;
}

/** Catches what a frame throws while rendering. */
class Catch extends Component<{ onError(error: unknown): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export async function frameFindings(gui: GuiPlugin): Promise<Finding[]> {
  const found: Finding[] = [];
  // The lazy() imports in ../host/client/action-host.tsx, so its first step is not held up by a cold
  // import. If that list changes, change this one: a missed module can outlast the 500 ms wait below.
  await Promise.all([import("../host/client/confirm-step"), import("../kit/overlay"), import("../kit/action-form")]);
  for (const width of WIDTHS) {
    setViewportWidth(width);
    const report = (fixture: string, message: string) => found.push({ check: "frames", fixture: `${fixture} at ${width} px`, message });
    if (gui.Overlay) {
      for (const { role, tone } of CASES) {
        for (const message of await overlay(gui.Overlay, role, tone)) report(`Overlay, ${role}`, message);
      }
    }
    if (gui.PublicFrame) {
      for (const page of PAGES) {
        const node = await serverNode(gui.PublicFrame, { page, children: <p>{PAGE_TEXT}</p> });
        const { unmount } = await renderInKit(node);
        if (!pageText().includes(PAGE_TEXT)) report(`PublicFrame, ${page}`, "does not render its children");
        if (queryAllByRole(document.body, "main").length === 0) report(`PublicFrame, ${page}`, "has no main landmark");
        unmount();
      }
    }
    if (gui.Loading) {
      const Loading = gui.Loading;
      let error: unknown = null;
      const { unmount } = await renderInKit(
        <Catch onError={(e) => (error = e)}>
          <Loading />
        </Catch>,
      );
      unmount();
      if (error) report("Loading", `throws while rendering: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return found;
}
