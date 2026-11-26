import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Signals } from "../../../contract";
import {
  badgeCount,
  fetchSignals,
  SIGNALS_MAX_BACKOFF_MS,
  SIGNALS_MIN_GAP_MS,
  SIGNALS_REFRESH_MS,
  useSignalsFeed,
  type SignalsFeed,
} from "../signals-feed";
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
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const probe: { seen: SignalsFeed | null } = { seen: null };
function Probe({ org, fetch, hook = useSignalsFeed }: { org: string | null; fetch: Fetch; hook?: typeof useSignalsFeed }) {
  const feed = hook(org, fetch);
  useEffect(() => {
    probe.seen = feed;
  });
  return null;
}
const feed = () => probe.seen!;

/** Runs the timers due in `ms` and lets each fetch and its JSON settle. */
const advance = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
/** Lets a fetch already sent settle. */
const settle = () => advance(0);

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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

  it("answers signed-out for 401, none for 403 and another organization's signals, keep otherwise; never rejects", async () => {
    await expect(fetchSignals(fetchOf({ status: 401 }), ORG)).resolves.toEqual({ kind: "signed-out" });
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
  it("fetches a turn after mounting, holds the signals and sets the badge to their count", async () => {
    const fetch = fetchOf({ body: signals(3) });
    render(<Probe org={ORG} fetch={fetch} />);
    expect(fetch).not.toHaveBeenCalled();
    expect(feed().signals).toBeNull();
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
    expect(feed().signals).toEqual(signals(3));
    expect(badge.set).toHaveBeenCalledWith(3);
  });

  it("waits for the page's load event before its first fetch", async () => {
    Object.defineProperty(document, "readyState", { configurable: true, value: "interactive" });
    try {
      const fetch = fetchOf({ body: signals(2) });
      render(<Probe org={ORG} fetch={fetch} />);
      await advance(1_000);
      expect(fetch).not.toHaveBeenCalled();
      Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
      act(() => {
        window.dispatchEvent(new Event("load"));
      });
      await settle();
      expect(fetch).toHaveBeenCalledOnce();
      expect(feed().signals?.count).toBe(2);
    } finally {
      delete (document as { readyState?: unknown }).readyState;
    }
  });

  it("sets the badge to the warn and critical signals (attention) when the answer gives them, while the tray keeps every signal's count", async () => {
    const mixed: Signals = { ...signals(30), attention: 23 };
    render(<Probe org={ORG} fetch={fetchOf({ body: mixed })} />);
    await settle();
    expect(feed().signals?.count).toBe(30);
    expect(badge.set).toHaveBeenCalledWith(23);
  });

  it("clears the badge when every signal is info, and still holds them for the tray", async () => {
    render(<Probe org={ORG} fetch={fetchOf({ body: { ...signals(4), attention: 0 } })} />);
    await settle();
    expect(feed().signals?.count).toBe(4);
    expect(badge.clear).toHaveBeenCalledOnce();
    expect(badge.set).not.toHaveBeenCalled();
  });

  it("uses attention from seeded signals too", async () => {
    render(<Probe org={ORG} fetch={fetchOf({ body: signals(9) })} />);
    act(() => feed().seed({ ...signals(5), attention: 2 }));
    expect(badge.set).toHaveBeenCalledWith(2);
  });

  it("falls back to count when attention is missing or not a count", async () => {
    expect(badgeCount(signals(7))).toBe(7);
    expect(badgeCount({ ...signals(7), attention: 3 })).toBe(3);
    expect(badgeCount({ ...signals(7), attention: 0 })).toBe(0);
    expect(badgeCount({ ...signals(7), attention: -1 })).toBe(7);
    expect(badgeCount({ ...signals(7), attention: Number.NaN })).toBe(7);
    expect(badgeCount({ ...signals(7), attention: "3" as unknown as number })).toBe(7);
  });

  it("clears the badge at zero", async () => {
    render(<Probe org={ORG} fetch={fetchOf({ body: signals(0) })} />);
    await settle();
    expect(feed().signals?.count).toBe(0);
    expect(badge.clear).toHaveBeenCalledOnce();
    expect(badge.set).not.toHaveBeenCalled();
  });

  it("takes seeded signals instead of its first fetch, and fetches next on its cadence", async () => {
    const fetch = fetchOf({ body: signals(6) });
    render(<Probe org={ORG} fetch={fetch} />);
    act(() => feed().seed(signals(2)));
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(feed().signals).toEqual(signals(2));
    expect(badge.set).toHaveBeenCalledWith(2);
    // Focus soon after counts the seed as the last fetch.
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(fetch).not.toHaveBeenCalled();
    await advance(SIGNALS_REFRESH_MS);
    expect(fetch).toHaveBeenCalledOnce();
    expect(feed().signals?.count).toBe(6);
  });

  it("ignores seeded signals of another organization", async () => {
    const fetch = fetchOf({ body: signals(1) });
    render(<Probe org={ORG} fetch={fetch} />);
    act(() => feed().seed(signals(9, OTHER)));
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
    expect(feed().signals?.count).toBe(1);
  });

  it("drops the answer of a fetch the seed overtook", async () => {
    let release!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    act(() => feed().seed(signals(2)));
    release(Response.json(signals(8)));
    await settle();
    expect(feed().signals?.count).toBe(2);
    expect(badge.set.mock.calls).toEqual([[2]]);
  });

  it("fetches again on its cadence while visible, and not while hidden", async () => {
    const fetch = fetchOf({ body: signals(1) }, { body: signals(2) }, { body: signals(5) });
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    await advance(SIGNALS_REFRESH_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(badge.set).toHaveBeenLastCalledWith(2);

    act(() => setVisibility("hidden"));
    await advance(SIGNALS_REFRESH_MS * 3);
    expect(fetch).toHaveBeenCalledTimes(2);

    act(() => setVisibility("visible"));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(feed().signals?.count).toBe(5);
  });

  it("fetches on focus or coming into view only when the last fetch is old enough", async () => {
    expect(SIGNALS_MIN_GAP_MS).toBe(2 * 60_000);
    const fetch = fetchOf({ body: signals(1) });
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    act(() => void window.dispatchEvent(new Event("focus")));
    act(() => setVisibility("visible"));
    expect(fetch).toHaveBeenCalledOnce();
    await advance(SIGNALS_MIN_GAP_MS - 1);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(fetch).toHaveBeenCalledOnce();
    await advance(1);
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fetches at once on refresh, as after an action whose result says signals: true", async () => {
    const fetch = fetchOf({ body: signals(2) }, { body: signals(1) });
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    act(() => feed().refresh());
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(feed().signals?.count).toBe(1);
    expect(badge.set).toHaveBeenLastCalledWith(1);
  });

  it("keeps the signals and the badge as they were after a 503 or a network error", async () => {
    const fetch = fetchOf({ body: signals(4) }, { status: 503 }, { fail: true });
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    act(() => feed().refresh());
    await settle();
    act(() => feed().refresh());
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(feed().signals?.count).toBe(4);
    expect(badge.set).toHaveBeenCalledOnce();
    expect(badge.clear).not.toHaveBeenCalled();
  });

  it("fetches at once when the browser comes back online after a failed fetch, and not otherwise", async () => {
    const fetch = fetchOf({ body: signals(4) }, { fail: true }, { body: signals(2) });
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    // Online after an answer: nothing to catch up on.
    act(() => void window.dispatchEvent(new Event("online")));
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
    act(() => feed().refresh());
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(badge.set.mock.calls).toEqual([[4]]);
    act(() => void window.dispatchEvent(new Event("online")));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(badge.set).toHaveBeenLastCalledWith(2);
    // Answered again: online no longer fetches.
    act(() => void window.dispatchEvent(new Event("online")));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("remembers coming back online while hidden, and fetches as soon as the page is shown", async () => {
    const fetch = fetchOf({ body: signals(4) }, { fail: true }, { body: signals(2) });
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    act(() => feed().refresh());
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    act(() => setVisibility("hidden"));
    act(() => void window.dispatchEvent(new Event("online")));
    await advance(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    // Shown as a browser shows it: visibilitychange, then focus, and no second online.
    act(() => setVisibility("visible"));
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(badge.set).toHaveBeenLastCalledWith(2);
  });

  it("does not count a failure of the fetch coming back online starts, and keeps the fetch already due", async () => {
    const MINUTE = 60_000;
    const fetch = fetchOf({ body: signals(4) }, { fail: true }, { fail: true }, { body: signals(2) });
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    // One failure: the next fetch is due in ten minutes.
    act(() => feed().refresh());
    await settle();
    await advance(MINUTE);
    act(() => void window.dispatchEvent(new Event("online")));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    // Still due ten minutes after the first failure, not twenty after this one.
    await advance(9 * MINUTE - 1);
    expect(fetch).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(badge.set).toHaveBeenLastCalledWith(2);
  });

  it("keeps the badge as it was, and backs off, when no source answered", async () => {
    const late: Signals = { type: "signals", org: ORG, count: 0, top: [], checked: [], unchecked: ["billing.due", "metering.readings"] };
    const fetch = fetchOf({ body: signals(4) }, { body: late }, { body: late });
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    expect(badge.set).toHaveBeenLastCalledWith(4);
    act(() => feed().refresh());
    await settle();
    // The tray holds the answer, with its unchecked sources; the badge keeps 4.
    expect(feed().signals).toEqual(late);
    expect(badge.set).toHaveBeenCalledOnce();
    expect(badge.clear).not.toHaveBeenCalled();
    // Counted as a failure: the next fetch waits twice the cadence.
    await advance(SIGNALS_REFRESH_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    await advance(SIGNALS_REFRESH_MS);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("doubles the wait after each failure in a row, up to the cap, and resets it on an answer", async () => {
    const fetch = fetchOf(
      ...Array.from({ length: 6 }, () => ({ status: 503 })),
      { body: signals(1) },
      { body: signals(1) },
    );
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    // 1 failure: 10 minutes; 2: 20; then the 30-minute cap.
    const MINUTE = 60_000;
    for (const [minutes, calls] of [[10, 2], [20, 3], [30, 4], [30, 5], [30, 6], [30, 7]] as const) {
      await advance(minutes * MINUTE - 1);
      expect(fetch).toHaveBeenCalledTimes(calls - 1);
      await advance(1);
      expect(fetch).toHaveBeenCalledTimes(calls);
    }
    expect(SIGNALS_MAX_BACKOFF_MS).toBe(30 * MINUTE);
    // The seventh answered: back to the plain cadence.
    await advance(SIGNALS_REFRESH_MS);
    expect(fetch).toHaveBeenCalledTimes(8);
  });

  it("clears the signals and the badge after a 403, and keeps fetching", async () => {
    const fetch = fetchOf({ body: signals(4) }, { status: 403 }, { body: signals(1) });
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    act(() => feed().refresh());
    await settle();
    expect(feed().signals).toBeNull();
    expect(badge.clear).toHaveBeenCalledOnce();
    await advance(SIGNALS_REFRESH_MS);
    expect(feed().signals?.count).toBe(1);
  });

  it("clears the signals and the badge after a 401 and stops fetching", async () => {
    const fetch = fetchOf({ body: signals(4) }, { status: 401 });
    render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    act(() => feed().refresh());
    await settle();
    expect(feed().signals).toBeNull();
    expect(badge.clear).toHaveBeenCalledOnce();
    await advance(SIGNALS_MAX_BACKOFF_MS * 2);
    act(() => void window.dispatchEvent(new Event("focus")));
    act(() => feed().refresh());
    act(() => feed().seed(signals(3)));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(badge.set).toHaveBeenCalledOnce();
  });

  it("drops the old organization's signals and badge when the organization changes, and ignores its late answer", async () => {
    let release!: (r: Response) => void;
    const fetch = vi.fn(async (url: string) =>
      url.includes(OTHER) ? Response.json(signals(7, OTHER)) : new Promise<Response>((resolve) => (release = resolve)),
    );
    const { rerender } = render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    rerender(<Probe org={OTHER} fetch={fetch} />);
    expect(badge.clear).toHaveBeenCalledOnce();
    await settle();
    expect(feed().signals).toEqual(signals(7, OTHER));
    release(Response.json(signals(9)));
    await settle();
    expect(feed().signals).toEqual(signals(7, OTHER));
    expect(badge.set.mock.calls).toEqual([[7]]);

    rerender(<Probe org={ORG} fetch={fetch} />);
    expect(feed().signals).toBeNull();
  });

  it("fetches nothing and clears the badge for a tenant (no organization)", async () => {
    const fetch = fetchOf({ body: signals(1) });
    render(<Probe org={null} fetch={fetch} />);
    await settle();
    act(() => feed().refresh());
    expect(fetch).not.toHaveBeenCalled();
    expect(feed().signals).toBeNull();
    expect(badge.clear).toHaveBeenCalledOnce();
  });

  it("stops fetching once unmounted", async () => {
    const fetch = fetchOf({ body: signals(1) });
    const { unmount } = render(<Probe org={ORG} fetch={fetch} />);
    await settle();
    unmount();
    await advance(SIGNALS_REFRESH_MS * 2);
    window.dispatchEvent(new Event("focus"));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("sets no badge from an answer that lands after sign-out, and fetches nothing more", async () => {
    // A fresh copy, so this file's other tests keep a page that is signed in.
    vi.resetModules();
    const { useSignalsFeed: fresh } = await import("../signals-feed");
    const { markSignedOut } = await import("../app-badge");
    let release!: (r: Response) => void;
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(signals(2)))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)));
    render(<Probe org={ORG} fetch={fetch} hook={fresh} />);
    await settle();
    expect(badge.set.mock.calls).toEqual([[2]]);
    // A focus refetch is in flight when the person signs out.
    await advance(SIGNALS_MIN_GAP_MS);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(fetch).toHaveBeenCalledTimes(2);
    markSignedOut();
    expect(badge.clear).toHaveBeenCalledOnce();
    release(Response.json(signals(5)));
    await settle();
    expect(badge.set.mock.calls).toEqual([[2]]);
    expect(feed().signals?.count).toBe(2);
    await advance(SIGNALS_REFRESH_MS);
    act(() => feed().refresh());
    act(() => feed().seed(signals(4)));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(badge.set.mock.calls).toEqual([[2]]);
  });
});
