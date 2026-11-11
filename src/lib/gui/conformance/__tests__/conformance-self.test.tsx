import { cleanup, render } from "@testing-library/react";
import { useLayoutEffect, useState, type ReactNode } from "react";
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

  it("stays within its limits when every click remounts the controls", async () => {
    let clicks = 0;
    function Remounts() {
      const [round, setRound] = useState(0);
      const click = () => {
        clicks++;
        setRound(round + 1);
      };
      return (
        <div key={round}>
          {["A", "B", "C"].map((label) => <button key={label} type="button" onClick={click}>{label}</button>)}
        </div>
      );
    }
    const { log } = recordingRuntime({ pathname: "/" });
    render(<Remounts />);
    await crawl(log, { max: 10, depth: 3 });
    expect(clicks).toBeGreaterThan(0);
    expect(clicks).toBeLessThanOrEqual(10 * (3 + 1));
  });

  it("stays within its limits when reopening a menu never brings its items back", async () => {
    let clicks = 0;
    // Each opening relabels the items, so every queued item costs a reopening click and is never found.
    function Relabels() {
      const [round, setRound] = useState(0);
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => { clicks++; setOpen(true); setRound(round + 1); }}>Open</button>
          {open && Array.from({ length: 100 }, (_, i) => (
            <button key={i} type="button" onClick={() => { clicks++; setOpen(false); }}>{`Item ${i} of ${round}`}</button>
          ))}
        </div>
      );
    }
    const { log } = recordingRuntime({ pathname: "/" });
    render(<Relabels />);
    await crawl(log, { max: 10, depth: 3 });
    expect(clicks).toBeGreaterThan(0);
    expect(clicks).toBeLessThanOrEqual(10 * (3 + 1));
  });
});

/** The reference Shell with `extra` after it, and the parts `extra` replaces left out. */
function withExtra(broken: Parameters<typeof referenceGui>[0], extra: (props: ShellProps) => ReactNode): GuiPlugin {
  const base = referenceGui(broken);
  const Base = base.Shell as (props: ShellProps) => ReactNode;
  function Shell(props: ShellProps) {
    return (
      <>
        <Base {...props} />
        {extra(props)}
      </>
    );
  }
  return { ...base, Shell };
}

/** An organization switcher drawn as a native select that navigates on change. */
function OrgSelect({ manifest }: ShellProps) {
  return (
    <select
      aria-label="Organization"
      value={manifest.org.id}
      onChange={(event) => {
        const to = manifest.orgs.find((o) => o.id === event.target.value);
        if (to) kit.navigate(to.href);
      }}
    >
      {manifest.orgs.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

/** A menu opened by a button named "More", like every other one. */
function MoreMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>More</button>
      {open && <div>{children}</div>}
    </div>
  );
}

describe("a GUI the crawl must explore fully", () => {
  it("passes with an organization switcher drawn as a native select", async () => {
    const gui = withExtra({ noOrgSwitch: true }, (props) => <OrgSelect {...props} />);
    for (const check of Object.values(CHECKS)) expect(await check(gui, { installed })).toEqual([]);
  });

  it("passes with two menus both opened by \"More\", when only the second reaches sign-out and the other organization", async () => {
    const gui = withExtra({ noStatus: true, noOrgSwitch: true, noSignOut: true }, ({ manifest }) => (
      <>
        <MoreMenu>
          {manifest.org.status.map((item) => <kit.Link key={item.id} href={item.open}>{item.label}</kit.Link>)}
        </MoreMenu>
        <MoreMenu>
          {manifest.orgs.map((o) => <kit.Link key={o.id} href={o.href}>{o.name}</kit.Link>)}
          <kit.SignOut />
        </MoreMenu>
      </>
    ));
    for (const check of Object.values(CHECKS)) expect(await check(gui, { installed })).toEqual([]);
  });
});
