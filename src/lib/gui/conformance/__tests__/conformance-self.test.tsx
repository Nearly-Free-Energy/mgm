import { cleanup, render } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuiPlugin, ShellProps } from "../../contract";
import { KitRuntimeProvider } from "../../host/client/kit-runtime";
import { kit } from "../../kit";
import { crawl, MANIFEST_FIXTURES, PAGE_MODEL, recordingRuntime, renderShell } from "..";
import { CHECKS } from "../checks";
import { registerConformance } from "../describe";
import { REFERENCE_META, referenceGui } from "./reference-gui";

const installed = { reference: REFERENCE_META };

// The kit's own known-good GUI passes every check.
registerConformance(referenceGui(), { installed }, { describe, it });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the harness", () => {
  it("renders an async Shell, as a server component would be", async () => {
    const { Shell } = referenceGui();
    const gui: GuiPlugin = { ...referenceGui(), Shell: async (props: ShellProps) => <Shell {...props} /> };
    for (const check of Object.values(CHECKS)) expect(await check(gui, { installed })).toEqual([]);
  });

  it("records a loadView made before the GUI's first paint and sends no request", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    function Loads({ children }: ShellProps) {
      useLayoutEffect(() => void kit.loadView("/communities"), []);
      return <main>{children}</main>;
    }
    const { log, unmount } = await renderShell({ ...referenceGui(), Shell: Loads }, MANIFEST_FIXTURES[0]);
    unmount();
    expect(log.loadView).toEqual(["/communities"]);
    expect(network).not.toHaveBeenCalled();
  });
});

describe("the recording runtime", () => {
  it("answers loadView and search itself, records them and sends no request", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const { runtime, log } = recordingRuntime({ pathname: "/", model: PAGE_MODEL });
    render(<KitRuntimeProvider runtime={runtime}>{null}</KitRuntimeProvider>);
    await expect(kit.loadView("/communities")).resolves.toMatchObject({ type: "view", view: PAGE_MODEL.view });
    await expect(kit.search("ka", "@")).resolves.toEqual([]);
    expect(log).toMatchObject({ loadView: ["/communities"], search: ["ka"], fetch: [] });
    expect(network).not.toHaveBeenCalled();
  });
});

/** A menu that closes on "Close", with a submenu holding a further opener. */
function Menus() {
  const [level, setLevel] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setLevel(level > 0 ? 0 : 1)}>Menu</button>
      {level > 0 && (
        <div role="menu">
          <button type="button" role="menuitem" onClick={() => setLevel(2)}>More</button>
          <button type="button" role="menuitem" onClick={() => setLevel(0)}>Close</button>
          {level >= 2 && <button type="button" role="menuitem" onClick={() => setLevel(3)}>Deeper</button>}
          {level >= 3 && <a href="/deep">Deep</a>}
        </div>
      )}
      <button type="button" onClick={() => kit.navigate("/x")}>Go</button>
      <button type="button" aria-labelledby="label" />
      <span id="label">Labelled elsewhere</span>
    </div>
  );
}

describe("the crawl", () => {
  it("opens closed menus again to reach nested controls, and counts navigate calls and computed names", async () => {
    const { runtime, log } = recordingRuntime({ pathname: "/" });
    render(
      <KitRuntimeProvider runtime={runtime}>
        <Menus />
      </KitRuntimeProvider>,
    );
    const reach = await crawl(log);
    expect(reach.hrefs).toContain("/deep");
    expect(reach.hrefs).toContain("/x");
    expect(reach.names).toContain("Labelled elsewhere");
  });
});
