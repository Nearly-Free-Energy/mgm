import { act as flush, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRef, ModelOf, Value, ViewModel } from "../../contract";
import { KitProvider } from "../../host/client/kit-provider";
import { KitRuntimeProvider, type KitRuntime } from "../../host/client/kit-runtime";
import { initial, manifest, model, recordingRuntime } from "../../host/client/__tests__/kit-test-utils";
import { KitView } from "../kit-view";

vi.mock("next/navigation", () => ({ usePathname: () => null, useSearchParams: () => null, useRouter: () => ({}) }));

const ok = { type: "result" as const, ok: true as const };
let runtime: ReturnType<typeof recordingRuntime>;
let act: ReturnType<typeof vi.fn<KitRuntime["act"]>>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
  act = vi.fn<KitRuntime["act"]>(async () => ok);
  runtime = recordingRuntime({ act });
});
afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

const show = (over: Partial<ViewModel>) => {
  const { container } = render(
    <KitRuntimeProvider runtime={runtime}>
      <KitView model={model(over)} />
    </KitRuntimeProvider>,
  );
  return container;
};
const text = (t: string, extra: Partial<Value> = {}) => ({ t: "text", text: t, ...extra }) as Value;
const ref = (action: `${string}.${string}`, label: string, extra: Partial<ActionRef> = {}): ActionRef => ({
  action,
  params: {},
  label,
  enabled: true,
  ...extra,
});
const actedWith = () => act.mock.calls.map((call) => call[0]);

type CollectionBody = ModelOf<"collection">["body"];
const collection = (body: Partial<CollectionBody>, over: Partial<ViewModel> = {}) =>
  ({
    kind: "collection",
    body: {
      columns: [
        { key: "name", label: "Name", type: "text", priority: 1 },
        { key: "meter", label: "Meter", type: "text", priority: 3 },
        { key: "owed", label: "Owed", type: "money", priority: 1, copy: "bare" },
      ],
      rows: [
        { id: "h1", href: "/households/h1", cells: { name: text("Aisha"), meter: text("M-7"), owed: text("4,216,800") }, actions: [ref("billing.remind", "Remind")] },
      ],
      empty: { title: "Add the first household", action: ref("org.add-household", "Add household") },
      ...body,
    },
    ...over,
  }) as Partial<ViewModel>;

describe("KitView: collection", () => {
  it("draws a scrolling table, keeps priority-3 cells in the DOM, and links the first cell", () => {
    const view = show(collection({}));
    expect(view.querySelector("table")?.parentElement?.className).toContain("overflow-x-auto");
    const meter = screen.getByText("M-7").closest("td")!;
    expect(meter.className).toContain("hidden");
    expect(meter.className).toContain("min-[600px]:table-cell");
    expect(screen.getByRole("link", { name: "Aisha" }).getAttribute("href")).toBe("/households/h1");
    expect(screen.getByText("4,216,800").closest("td")!.className).toContain("text-right");
  });

  it("puts the totals below the table, never in it", () => {
    const view = show(collection({ totals: { owed: text("9,000,000") } }));
    const totals = view.querySelector("[data-gui-totals]")!;
    const table = view.querySelector("table")!;
    expect(table.contains(totals)).toBe(false);
    expect(table.compareDocumentPosition(totals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(totals as HTMLElement).getByText("9,000,000")).toBeTruthy();
  });

  it("renders filters as links marking the current one", () => {
    show(collection({ filters: [{ label: "All", href: "/h", current: true }, { label: "Owing", href: "/h?owing", count: 2, current: false }] }));
    expect(screen.getByRole("link", { name: "All" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Owing (2)" }).getAttribute("aria-current")).toBeNull();
  });

  it("shows filters on a collection with rows even when no filter has a count", () => {
    show(collection({ filters: [{ label: "All", href: "/h", current: true }, { label: "Owing", href: "/h?owing", current: false }] }));
    expect(screen.getByRole("navigation", { name: "Filters" })).toBeTruthy();
  });

  it("keeps the create action in the header while there are rows", () => {
    show(collection({}, { actions: [ref("org.add-household", "Add household")] }));
    expect(screen.getAllByRole("button", { name: "Add household" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add household" }).closest("header")).toBeTruthy();
  });

  it("hides priority-3 headers with their cells, and links to the next page only when there are rows", () => {
    show(collection({ next: "/h?after=h1" }));
    const meter = screen.getByRole("columnheader", { name: "Meter" }).className;
    expect(meter).toContain("hidden");
    expect(meter).toContain("min-[600px]:table-cell");
    expect(screen.getByRole("link", { name: "More" }).getAttribute("href")).toBe("/h?after=h1");
  });

  it("does not nest the row link around a value that links itself, and keeps the link for a ref without a page", () => {
    const site = { t: "ref", ref: { kind: "microgrid", id: "m", label: "Site", href: "/microgrids/m" }, text: "Site" } as Value;
    const bare = { t: "ref", ref: { kind: "household", id: "h2", label: "Bob" }, text: "Bob" } as Value;
    const view = show(
      collection({
        rows: [
          { id: "h1", href: "/households/h1", cells: { name: site }, actions: [] },
          { id: "h2", href: "/households/h2", cells: { name: bare }, actions: [] },
        ],
      }),
    );
    expect(view.querySelector("a a")).toBeNull();
    expect(within(screen.getByText("Site").closest("td")!).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/microgrids/m"]);
    expect(screen.getByRole("link", { name: "Bob" }).getAttribute("href")).toBe("/households/h2");
  });

  it("puts the row link in the first column that stays visible on a phone", () => {
    show(
      collection({
        columns: [
          { key: "meter", label: "Meter", type: "text", priority: 3 },
          { key: "name", label: "Name", type: "text", priority: 1 },
        ],
      }),
    );
    expect(screen.getByRole("link", { name: "Aisha" }).getAttribute("href")).toBe("/households/h1");
    expect(within(screen.getByText("M-7").closest("td")!).queryByRole("link")).toBeNull();
  });

  it("opens row links through kit.open", () => {
    const link = { id: "billing.statement" as const, label: "Statement", href: "/households/h1/statement" as const };
    show(collection({ rows: [{ id: "h1", cells: { name: text("Aisha") }, actions: [], links: [link] }] }));
    fireEvent.click(screen.getByRole("link", { name: "Statement" }));
    expect(runtime.open).toHaveBeenCalledWith(link);
  });

  it("at zero rows, lets the empty state own the create action, with no table and no filters", async () => {
    const add = ref("org.add-household", "Add household");
    const view = show(
      collection(
        { rows: [], totals: { owed: text("0") }, next: "/h?after=h1", filters: [{ label: "All", href: "/h", current: true }] },
        { actions: [add] },
      ),
    );
    expect(view.querySelector("table")).toBeNull();
    expect(screen.queryByRole("link", { name: "More" })).toBeNull();
    expect(view.querySelector("[data-gui-totals]")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Filters" })).toBeNull();
    const region = screen.getByRole("region", { name: "Add the first household" });
    expect(screen.getAllByRole("button", { name: "Add household" })).toHaveLength(1);
    fireEvent.click(within(region).getByRole("button", { name: "Add household" }));
    await waitFor(() => expect(actedWith()).toEqual([add]));
  });

  it("at zero rows, keeps filters when another filter has rows", () => {
    show(collection({ rows: [], filters: [{ label: "Owing", href: "/h?owing", current: true }, { label: "All", href: "/h", count: 4, current: false }] }));
    expect(screen.getByRole("navigation", { name: "Filters" })).toBeTruthy();
  });

  it("row actions call kit.act; a disabled one says why; a proposed one says so", async () => {
    const remind = ref("billing.remind", "Remind");
    show(
      collection(
        {},
        { actions: [ref("billing.close", "Close", { enabled: false, reason: "Billing is off" }), ref("billing.send", "Send", { provenance: { by: "assistant", at: "2026-11-10T11:00:00Z" } })] },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remind" }));
    await waitFor(() => expect(actedWith()).toEqual([remind]));
    const close = screen.getByRole("button", { name: "Close" }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    expect(document.getElementById(close.getAttribute("aria-describedby")!)?.textContent).toBe("Billing is off");
    const send = screen.getByRole("button", { name: /Send/ });
    expect(send.textContent).toContain("Proposed");
    expect(send.className).toContain("border-dashed");
  });

  it("styles a danger action with the destructive tokens", () => {
    show(collection({}, { actions: [ref("org.remove", "Remove", { tone: "danger" })] }));
    expect(screen.getByRole("button", { name: "Remove" }).className).toContain("bg-destructive-muted");
    expect(screen.getByRole("button", { name: "Remind" }).className).not.toContain("bg-destructive-muted");
  });

  it("disables an action while its act call is pending, so a double click runs it once", async () => {
    let resolve!: (r: typeof ok) => void;
    act.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    show(collection({}));
    const remind = screen.getByRole("button", { name: "Remind" }) as HTMLButtonElement;
    fireEvent.click(remind);
    await waitFor(() => expect(remind.disabled).toBe(true));
    expect(remind.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(remind);
    expect(act).toHaveBeenCalledTimes(1);
    resolve(ok);
    await waitFor(() => expect(remind.disabled).toBe(false));
  });

  it("shows the failure an action resolves with, but not a cancellation", async () => {
    act.mockResolvedValueOnce({ type: "result", ok: false, status: 0, code: "unsupported", message: "Not yet" });
    show(collection({}));
    fireEvent.click(screen.getByRole("button", { name: "Remind" }));
    expect(await screen.findByText("Not yet")).toBeTruthy();
  });

  it("says nothing when the person cancels an action", async () => {
    act.mockResolvedValueOnce({ type: "result", ok: false, status: 0, code: "cancelled", message: "Cancelled" });
    show(collection({}));
    fireEvent.click(screen.getByRole("button", { name: "Remind" }));
    await waitFor(() => expect(act).toHaveBeenCalledOnce());
    await waitFor(() => expect((screen.getByRole("button", { name: "Remind" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("Cancelled")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("KitView: the other kinds", () => {
  it("metrics: tiles with marks and statuses, and a sparkline whose points stay readable", () => {
    const view = show({
      kind: "metrics",
      body: {
        tiles: [{ key: "soc", label: "Battery", value: text("82%", { derived: true, synthetic: true }), status: { t: "status", v: "ok", tone: "success", text: "Charging" }, hint: "Since dawn" }],
        series: [{ key: "load", label: "Load", unit: "kW", points: [["06:00", 1], ["06:05", null], ["06:10", 3], ["06:15", 2]] }],
      },
    } as Partial<ViewModel>);
    expect(screen.getByText("82%")).toBeTruthy();
    expect(screen.getByTitle("Calculated")).toBeTruthy();
    expect(screen.getByText("Synthetic")).toBeTruthy();
    expect(screen.getByText("Charging").className).toContain("bg-success-muted");
    expect(screen.getByText("Since dawn")).toBeTruthy();
    expect(view.querySelector("path")?.getAttribute("d")?.match(/M/g)).toHaveLength(2);
    expect(within(view.querySelector("details")!).getByText("—")).toBeTruthy();
  });

  it("metrics: prints a timestamp point in the organization's time zone, not as the raw string", () => {
    const m = manifest();
    const view = render(
      <KitRuntimeProvider runtime={runtime}>
        <KitProvider manifest={{ ...m, org: { ...m.org, timezone: "Africa/Kampala" } }} initial={initial}>
          <KitView
            model={model({
              kind: "metrics",
              body: { tiles: [], series: [{ key: "soc", label: "Battery", unit: "%", points: [["2026-11-10T05:00:00.000Z", 80], ["late", 81]] }] },
            } as Partial<ViewModel>)}
          />
        </KitProvider>
      </KitRuntimeProvider>,
    ).container;
    const cells = [...view.querySelectorAll("details tbody tr td:first-child")].map((td) => td.textContent);
    expect(cells[0]).toMatch(/08:00/);
    expect(cells[0]).not.toContain("T05:00");
    expect(cells[1]).toBe("late");
  });

  it("record: sections of terms and values", () => {
    show({ kind: "record", body: { sections: [{ title: "Site", fields: [{ key: "tz", label: "Time zone", value: text("Africa/Kampala") }] }] } });
    expect(screen.getByRole("heading", { level: 2, name: "Site" })).toBeTruthy();
    expect(screen.getByText("Time zone").tagName).toBe("DT");
    expect(screen.getByText("Africa/Kampala").closest("dd")).toBeTruthy();
  });

  it("feed: rich text as nodes, unverified figures marked, and a view embedded once", () => {
    const inner = model({ title: "Inner", kind: "feed", body: { entries: [{ id: "x", at: "2026-11-10T11:00:00Z", author: { kind: "system", name: "MGM" }, text: [], embed: { type: "view", href: "/deep", model: model({ title: "Deep" }) } }] } } as Partial<ViewModel>);
    const view = show({
      kind: "feed",
      body: {
        entries: [
          { id: "e1", at: "2026-11-10T11:55:00Z", author: { kind: "assistant", name: "Helper" }, text: [{ p: ["Used ", { value: text("12 kWh") }, " <b>today</b>"] }, { li: [{ unverified: "about 40%" }] }, { li: [{ link: "/x", text: "Details" }] }], embed: { type: "view", href: "/inner", model: inner } },
        ],
      },
    } as Partial<ViewModel>);
    expect(screen.getByText(/5 min ago/)).toBeTruthy();
    expect(view.querySelector("b")).toBeNull();
    expect(view.querySelectorAll("ul > li")).toHaveLength(2);
    expect(view.querySelector("[data-gui-unverified]")?.textContent).toContain("(unverified)");
    expect(screen.getByRole("heading", { level: 2, name: "Inner" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Deep" }).getAttribute("href")).toBe("/deep");
  });

  it("feed: compose sends the text and the current page's href, then clears", async () => {
    runtime = recordingRuntime({ act, pathname: "/microgrids/m/operations" });
    window.history.replaceState(null, "", "/microgrids/m/operations?date=2026-11-09");
    const send = ref("org.ask", "Ask");
    show({ kind: "feed", body: { entries: [], compose: { action: send, textField: "text", contextField: "view", placeholder: "Ask something" } } } as Partial<ViewModel>);
    const box = screen.getByLabelText("Ask something") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Why?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(send, { initial: { text: "Why?", view: "/microgrids/m/operations?date=2026-11-09" } }));
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("feed: a disabled compose, stop, busy, and action, values and steps embeds", async () => {
    const stop = ref("org.stop", "Stop");
    const go = ref("org.go", "Go");
    const at = "2026-11-10T11:59:00Z";
    const author = { kind: "system", name: "MGM" };
    const view = show({
      kind: "feed",
      body: {
        busy: true,
        stop,
        entries: [
          { id: "a", at, author, text: [], embed: { type: "action", ref: go } },
          { id: "v", at, author, text: [], embed: { type: "values", values: [text("3 kWh"), text("UGX 900")] } },
          { id: "s", at, author, text: [], embed: { type: "steps", steps: [{ label: "Read", ms: 12, ok: true }, { label: "Write", ms: 40, ok: false }] } },
        ],
        compose: { action: ref("org.ask", "Ask", { enabled: false }), textField: "text", placeholder: "Ask something" },
      },
    } as Partial<ViewModel>);
    expect((screen.getByLabelText("Ask something") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.querySelector("ol")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("3 kWh")).toBeTruthy();
    expect(screen.getByText("UGX 900")).toBeTruthy();
    expect(screen.getByText("Failed").className).toContain("bg-destructive-muted");
    expect(screen.getByText("Done").className).toContain("bg-success-muted");
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(actedWith()).toEqual([go, stop]));
  });

  it("flow: steps with their state, the current one marked, a blocked one in the alert tone, and step actions", async () => {
    const fix = ref("org.fix", "Fix");
    show({
      kind: "flow",
      body: {
        steps: [
          { id: "a", title: "Connect", state: "done" },
          { id: "b", title: "Import", state: "current", detail: "Pick a file" },
          { id: "c", title: "Check", state: "blocked", action: fix },
        ],
      },
    });
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Import").closest("li")?.getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("Blocked").className).toContain("bg-destructive-muted");
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    await waitFor(() => expect(actedWith()).toEqual([fix]));
  });
});

describe("KitView: what every view shares", () => {
  it("shows the notice as a banner, opens links through kit.open, and lists attached views as links", () => {
    const link = { id: "billing.csv" as const, label: "Export", href: "/api/billing/export.csv" as const, download: { mime: "text/csv", filename: "b.csv" } };
    show({
      notice: { tone: "danger", text: "Billing is off" },
      links: [link],
      attached: [{ view: "billing.savings", title: "Savings", href: "/microgrids/m/savings", hint: "section" }],
    });
    expect(screen.getByRole("alert").textContent).toContain("Billing is off");
    fireEvent.click(screen.getByRole("link", { name: "Export" }));
    expect(runtime.open).toHaveBeenCalledWith(link);
    expect(screen.getByRole("link", { name: "Savings" }).getAttribute("href")).toBe("/microgrids/m/savings");
  });

  it("leaves the title, subtitle, actions and links to a shell that draws them, keeping the heading and the notice", () => {
    const link = { id: "billing.csv" as const, label: "Export", href: "/api/billing/export.csv" as const };
    render(
      <KitRuntimeProvider runtime={runtime}>
        <KitView
          headerInShell
          model={model({
            subtitle: "Today",
            actions: [ref("billing.close", "Close period")],
            links: [link],
            notice: { tone: "warning", text: "Readings are late" },
          })}
        />
      </KitRuntimeProvider>,
    );
    const heading = screen.getByRole("heading", { level: 1, name: "Operations" });
    expect(heading.className).toContain("sr-only");
    expect(screen.queryByText("Today")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close period" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Export" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Readings are late");
  });

  it("hides only the page view's header in the shell: an embedded view keeps its title and actions", () => {
    const inner = model({ title: "Inner", actions: [ref("billing.remind", "Remind all")] });
    render(
      <KitRuntimeProvider runtime={runtime}>
        <KitView
          headerInShell
          model={model({
            kind: "feed",
            actions: [ref("billing.close", "Close period")],
            body: { entries: [{ id: "e", at: "2026-11-10T11:00:00Z", author: { kind: "system", name: "MGM" }, text: [], embed: { type: "view", href: "/inner", model: inner } }] },
          } as Partial<ViewModel>)}
        />
      </KitRuntimeProvider>,
    );
    expect(screen.queryByRole("button", { name: "Close period" })).toBeNull();
    const heading = screen.getByRole("heading", { level: 2, name: "Inner" });
    expect(heading.className).not.toContain("sr-only");
    expect(screen.getByRole("button", { name: "Remind all" })).toBeTruthy();
  });

  it("leaves views attached as tabs to a shell that draws them, and lists the others", () => {
    const attached: ViewModel["attached"] = [
      { view: "billing.savings", title: "Savings", href: "/microgrids/m/savings", hint: "tab" },
      { view: "metering.devices", title: "Devices", href: "/microgrids/m/devices", hint: "section" },
    ];
    const { rerender } = render(
      <KitRuntimeProvider runtime={runtime}>
        <KitView headerInShell model={model({ attached })} />
      </KitRuntimeProvider>,
    );
    const related = screen.getByRole("navigation", { name: "Related views" });
    expect(within(related).queryByRole("link", { name: "Savings" })).toBeNull();
    expect(within(related).getByRole("link", { name: "Devices" })).toBeTruthy();

    rerender(
      <KitRuntimeProvider runtime={runtime}>
        <KitView model={model({ attached })} />
      </KitRuntimeProvider>,
    );
    expect(within(screen.getByRole("navigation", { name: "Related views" })).getByRole("link", { name: "Savings" })).toBeTruthy();
  });

  it("shows a warning notice in the warning tone", () => {
    show({ notice: { tone: "warning", text: "Readings are late" } });
    expect(screen.getByRole("status").className).toContain("bg-warning-muted");
  });

  it("draws only links the browser may follow: same-origin pages and the allowed outside targets", () => {
    show({
      links: [
        { id: "x.out", label: "Evil", href: "https://evil.example/x" },
        { id: "x.js", label: "Script", href: "javascript:alert(1)" },
        { id: "x.tel", label: "Call", href: "tel:+256700000000" },
      ] as never,
    });
    expect(screen.queryByRole("link", { name: "Evil" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Script" })).toBeNull();
    expect(screen.getByText("Evil").tagName).toBe("SPAN");
    expect(document.querySelector('a[href^="https://evil"], a[href^="javascript"]')).toBeNull();
    expect(screen.getByRole("link", { name: "Call" }).getAttribute("href")).toBe("tel:+256700000000");
  });

  it("marks a value stale once a live view says so", () => {
    show({
      kind: "record",
      live: { refreshSeconds: 60, staleAfterSeconds: 120 },
      body: { sections: [{ fields: [{ key: "p", label: "Power", value: text("1 kW", { at: "2026-11-10T11:55:00Z" }) }] }] },
    } as Partial<ViewModel>);
    const age = screen.getByText(/5 min ago/);
    expect(age.textContent).toBe("5 min ago, stale");
    expect(age.className).toContain("text-warning-fg");
  });

  it("draws the model a live view polls, and an embedded view never polls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
    const power = (v: string) => ({ kind: "record", body: { sections: [{ fields: [{ key: "p", label: "Power", value: text(v) }] }] } }) as Partial<ViewModel>;
    const fetch = vi.fn(async () => Response.json(model({ ...power("2 kW"), live: { refreshSeconds: 15, staleAfterSeconds: 60 } })));
    runtime = recordingRuntime({ act, fetch, pathname: "/microgrids/m/operations" });
    show({ ...power("1 kW"), live: { refreshSeconds: 15, staleAfterSeconds: 60 } });
    await flush(() => vi.advanceTimersByTimeAsync(15_000));
    expect(screen.getByText("2 kW")).toBeTruthy();
  });

  it("does not poll for a live view embedded in a feed", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response("null", { status: 404 }));
    runtime = recordingRuntime({ act, fetch });
    const inner = model({ title: "Inner", live: { refreshSeconds: 15, staleAfterSeconds: 60 } });
    show({
      kind: "feed",
      body: { entries: [{ id: "e", at: "2026-11-10T11:00:00Z", author: { kind: "system", name: "MGM" }, text: [], embed: { type: "view", href: "/inner", model: inner } }] },
    } as Partial<ViewModel>);
    await flush(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("draws an unknown kind embedded in a feed below the page heading", () => {
    const odd = model({ kind: "chart", title: "Odd" } as never);
    const view = show({
      kind: "feed",
      body: { entries: [{ id: "e", at: "2026-11-10T11:00:00Z", author: { kind: "system", name: "MGM" }, text: [], embed: { type: "view", href: "/odd", model: odd } }] },
    } as Partial<ViewModel>);
    expect(view.querySelector("[data-gui-raw='chart']")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Odd" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("falls back to RawView for a kind it does not know", () => {
    const view = show({ kind: "chart", title: "Chart" } as never);
    expect(view.querySelector("[data-gui-raw='chart']")).toBeTruthy();
  });
});
