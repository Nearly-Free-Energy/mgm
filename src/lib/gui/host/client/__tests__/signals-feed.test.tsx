import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Signals } from "../../../contract";
import { fetchSignals, SIGNALS_MIN_GAP_MS, SIGNALS_REFRESH_MS, useSignalsFeed } from "../signals-feed";
import { ORG } from "./kit-test-utils";

const OTHER = "00000000-0000-4000-8000-000000000002";
const signals = (count: number, org = ORG): Signals => ({ type: "signals", org, count, top: [], checked: ["billing.due"], unchecked: [] });

type Reply = { status?: number; body?: unknown; fail?: boolean };
const badge = { set: vi.fn<(count?: number) => Promise<void>>(async () => {}), clear: vi.fn(async () => {}) };

function fetchOf(...replies: Reply[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    void url;
    void init;
    const reply = replies.length > 1 ? replies.shift()! : replies[0];
    if (reply.fail) throw new TypeError("Failed to fetch");
    return Response.json(reply.body ?? null, { status: reply.status ?? 200 });
  });
}

type Feed = { signals: Signals | null; refresh(): void };
const probe: { seen: Feed | null } = { seen: null };
function Probe({ org, fetch }: { org: string | null; fetch: ReturnType<typeof fetchOf> }) {
  const feed = useSignalsFeed(org, fetch);
  useEffect(() => {
    probe.seen = feed;
  });
  return null;
}

/** Lets the fetch and its JSON settle. */
const settle = () => act(async () => {});

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: badge.set });
  Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: badge.clear });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  probe.seen = null;
  delete (navigator as { setAppBadge?: unknown }).setAppBadge;
  delete (navigator as { clearAppBadge?: unknown }).clearAppBadge;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("fetchSignals", () => {
  it("asks for the organization's signals, uncached", async () => {
    const fetch = fetchOf({ body: signals(1) });
    await expect(fetchSignals(fetch, ORG)).resolves.toEqual({ kind: "signals", signals: signals(1) });
    expect(fetch).toHaveBeenCalledWith(`/api/gui/signals?org=${ORG}`, expect.objectContaining({ cache: "no-store" }));
  });

  it("answers none for 401, 403 and another organization's signals; keep for anything else; never rejects", async () => {
    await expect(fetchSignals(fetchOf({ status: 401 }), ORG)).resolves.toEqual({ kind: "none" });
    await expect(fetchSignals(fetchOf({ status: 403, body: { code: "gui_no_access" } }), ORG)).resolves.toEqual({ kind: "none" });
    await expect(fetchSignals(fetchOf({ body: signals(2, OTHER) }), ORG)).resolves.toEqual({ kind: "none" });
    for (const reply of [{ status: 503 }, { status: 500 }, { fail: true }, { body: { type: "view" } }, { body: { ...signals(1), count: -1 } }]) {
      await expect(fetchSignals(fetchOf(reply), ORG)).resolves.toEqual({ kind: "keep" });
    }
    const broken = vi.fn(async () => new Response("not json", { status: 200 }));
    await expect(fetchSignals(broken, ORG)).resolves.toEqual({ kind: "keep" });
  });
});

describe("useSignalsFeed", () => {
  it("fetches after mounting, holds the signals and sets the badge to their count", async () => {
    const fetch = fetchOf({ body: signals(3) });
    render(<Probe org={ORG} fetch={fetch} />);
    expect(probe.seen!.signals).toBeNull();
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
    expect(probe.seen!.signals).toEqual(signals(3));
    expect(badge.set).toHaveBeenCalledWith(3);
  });

  it("clears the badge at zero", async () => {
    render(<Probe org={ORG} fetch={fetchOf({ body: signals(0) })} />);
    await settle();
    expect(probe.seen!.signals?.count).toBe(0);
    expect(badge.clear).toHaveBeenCalledOnce();
    expect(badge.set).not.toHaveBeenCalled();
  });

  it("fetches again on its cadence while visible, and not while hidden", async () => {
    const fetch = fetchOf({ body: signals(1) }, { body: signals(2) }, { body: signals(5) });
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    act(() => void vi.advanceTimersByTime(SIGNALS_REFRESH_MS));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(badge.set).toHaveBeenLastCalledWith(2);

    act(() => setVisibility("hidden"));
    act(() => void vi.advanceTimersByTime(SIGNALS_REFRESH_MS * 3));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);

    act(() => setVisibility("visible"));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(probe.seen!.signals?.count).toBe(5);
  });

  it("fetches on focus or coming into view only when the last fetch is old enough", async () => {
    const fetch = fetchOf({ body: signals(1) });
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    act(() => void window.dispatchEvent(new Event("focus")));
    act(() => setVisibility("visible"));
    expect(fetch).toHaveBeenCalledOnce();
    act(() => void vi.advanceTimersByTime(SIGNALS_MIN_GAP_MS));
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fetches at once on refresh, as after an action whose result says signals: true", async () => {
    const fetch = fetchOf({ body: signals(2) }, { body: signals(1) });
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    act(() => probe.seen!.refresh());
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(probe.seen!.signals?.count).toBe(1);
    expect(badge.set).toHaveBeenLastCalledWith(1);
  });

  it("keeps the signals and the badge as they were after a 503 or a network error", async () => {
    const fetch = fetchOf({ body: signals(4) }, { status: 503 }, { fail: true });
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    act(() => probe.seen!.refresh());
    await settle();
    act(() => probe.seen!.refresh());
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(probe.seen!.signals?.count).toBe(4);
    expect(badge.set).toHaveBeenCalledOnce();
    expect(badge.clear).not.toHaveBeenCalled();
  });

  it("clears the signals and the badge after a 403 or 401", async () => {
    const fetch = fetchOf({ body: signals(4) }, { status: 403 }, { body: signals(1) }, { status: 401 });
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    act(() => probe.seen!.refresh());
    await settle();
    expect(probe.seen!.signals).toBeNull();
    expect(badge.clear).toHaveBeenCalledOnce();
    act(() => probe.seen!.refresh());
    await settle();
    act(() => probe.seen!.refresh());
    await settle();
    expect(probe.seen!.signals).toBeNull();
    expect(badge.clear).toHaveBeenCalledTimes(2);
  });

  it("drops the old organization's signals and badge when the organization changes, and ignores its late answer", async () => {
    let release!: (r: Response) => void;
    const fetch = vi.fn(async (url: string) =>
      url.includes(OTHER) ? Response.json(signals(7, OTHER)) : new Promise<Response>((resolve) => (release = resolve)),
    );
    const { rerender } = render(<Probe org={ORG} fetch={fetch} />);
    rerender(<Probe org={OTHER} fetch={fetch} />);
    expect(badge.clear).toHaveBeenCalledOnce();
    await settle();
    expect(probe.seen!.signals).toEqual(signals(7, OTHER));
    release(Response.json(signals(9)));
    await settle();
    expect(probe.seen!.signals).toEqual(signals(7, OTHER));
    expect(badge.set.mock.calls).toEqual([[7]]);

    rerender(<Probe org={ORG} fetch={fetch} />);
    expect(probe.seen!.signals).toBeNull();
  });

  it("fetches nothing and clears the badge for a tenant (no organization)", async () => {
    const fetch = fetchOf({ body: signals(1) });
    render(<Probe org={null} fetch={fetch} />);
    await settle();
    act(() => probe.seen!.refresh());
    expect(fetch).not.toHaveBeenCalled();
    expect(probe.seen!.signals).toBeNull();
    expect(badge.clear).toHaveBeenCalledOnce();
  });

  it("stops fetching once unmounted", async () => {
    const fetch = fetchOf({ body: signals(1) });
    const { unmount } = render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    unmount();
    act(() => void vi.advanceTimersByTime(SIGNALS_REFRESH_MS * 2));
    window.dispatchEvent(new Event("focus"));
    expect(fetch).toHaveBeenCalledOnce();
  });
});
