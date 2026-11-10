import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Value } from "../../../contract";
import { KitProvider } from "../kit-provider";
import { KitRuntimeProvider } from "../kit-runtime";
import { useFeed, useLive } from "../live";
import { initial, manifest, model, recordingRuntime } from "./kit-test-utils";

vi.mock("next/navigation", () => ({ usePathname: () => null, useSearchParams: () => null }));

const live = model({ live: { refreshSeconds: 5, staleAfterSeconds: 60 } });
const polled = model({ title: "Polled", live: { refreshSeconds: 5, staleAfterSeconds: 60 } });

function setup(
  connection?: { saveData?: boolean; effectiveType?: string },
  fetch: () => Promise<Response> = async () => Response.json(polled),
) {
  Object.defineProperty(navigator, "connection", { configurable: true, value: connection });
  const runtime = recordingRuntime({ pathname: "/microgrids/a/operations", fetch: vi.fn(fetch) });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <KitRuntimeProvider runtime={runtime}>
      <KitProvider manifest={manifest()} initial={initial}>{children}</KitProvider>
    </KitRuntimeProvider>
  );
  return { runtime, wrapper };
}

const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

describe("useLive", () => {
  it("is paused for a model that is not live, and never fetches", async () => {
    const { runtime, wrapper } = setup();
    const { result } = renderHook(() => useLive(model()), { wrapper });
    expect(result.current.polling).toBe("paused");
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it("polls no faster than every 15 seconds and adopts the new model", async () => {
    const { runtime, wrapper } = setup();
    const { result } = renderHook(() => useLive(live), { wrapper });
    expect(result.current.polling).toBe("on");
    await act(() => vi.advanceTimersByTimeAsync(14_000));
    expect(runtime.fetch).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(runtime.fetch).toHaveBeenCalledWith(
      `/api/gui/view?href=${encodeURIComponent("/microgrids/a/operations")}`,
      expect.anything(),
    );
    expect(result.current.model.title).toBe("Polled");
  });

  it("slows four times on a data saver", async () => {
    const { runtime, wrapper } = setup({ saveData: true });
    const { result } = renderHook(() => useLive(live), { wrapper });
    expect(result.current.polling).toBe("slow");
    await act(() => vi.advanceTimersByTimeAsync(59_000));
    expect(runtime.fetch).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(runtime.fetch).toHaveBeenCalledOnce();
  });

  it.each(["slow-2g", "2g", "3g"])("slows four times on a %s connection", async (effectiveType) => {
    const { runtime, wrapper } = setup({ effectiveType });
    const { result } = renderHook(() => useLive(live), { wrapper });
    expect(result.current.polling).toBe("slow");
    await act(() => vi.advanceTimersByTimeAsync(59_000));
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it("keeps full speed on a 4g connection", () => {
    const { wrapper } = setup({ effectiveType: "4g" });
    const { result } = renderHook(() => useLive(live), { wrapper });
    expect(result.current.polling).toBe("on");
  });

  it("polls the page with its query string", async () => {
    window.history.replaceState(null, "", "/microgrids/a/operations?day=1");
    const { runtime, wrapper } = setup();
    renderHook(() => useLive(live), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(runtime.fetch).toHaveBeenCalledWith(
      `/api/gui/view?href=${encodeURIComponent("/microgrids/a/operations?day=1")}`,
      expect.anything(),
    );
  });

  it("lets a new model from the page win over one polled for the previous model", async () => {
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ m }) => useLive(m), { wrapper, initialProps: { m: live } });
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(result.current.model.title).toBe("Polled");
    const next = model({ title: "Next", live: { refreshSeconds: 5, staleAfterSeconds: 60 } });
    rerender({ m: next });
    expect(result.current.model).toBe(next);
  });

  it("keeps a model of another view rather than adopting the page's", async () => {
    const { runtime, wrapper } = setup();
    const other = model({ view: "billing.period", live: { refreshSeconds: 5, staleAfterSeconds: 60 } });
    const { result } = renderHook(() => useLive(other), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(runtime.fetch).toHaveBeenCalledOnce();
    expect(result.current.model).toBe(other);
  });

  it("never overlaps polls", async () => {
    const { runtime, wrapper } = setup(undefined, () => new Promise<Response>(() => {}));
    renderHook(() => useLive(live), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(45_000));
    expect(runtime.fetch).toHaveBeenCalledOnce();
  });

  it("drops a poll that returns after the tab was hidden", async () => {
    let answer: (response: Response) => void = () => {};
    const { wrapper } = setup(undefined, () => new Promise<Response>((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useLive(live), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    act(() => setHidden(true));
    await act(async () => answer(Response.json(polled)));
    expect(result.current.model).toBe(live);
  });

  it("pauses while the tab is hidden", async () => {
    const { runtime, wrapper } = setup();
    const { result } = renderHook(() => useLive(live), { wrapper });
    act(() => setHidden(true));
    expect(result.current.polling).toBe("paused");
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(runtime.fetch).not.toHaveBeenCalled();
    act(() => setHidden(false));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(runtime.fetch).toHaveBeenCalledOnce();
  });

  it("ages values against server time", () => {
    const { wrapper } = setup();
    // The device clock runs an hour behind the server's.
    vi.setSystemTime(new Date("2026-11-10T11:00:00.000Z"));
    const { result } = renderHook(() => useLive(live), { wrapper });
    const value = (at: string): Value => ({ t: "text", text: "x", at });
    expect(result.current.ageSeconds(value("2026-11-10T11:59:30.000Z"))).toBe(30);
    expect(result.current.stale(value("2026-11-10T11:58:00.000Z"))).toBe(true);
    expect(result.current.ageSeconds({ t: "text", text: "x" })).toBeNull();
  });

  it("is stale only past staleAfterSeconds, and only for a live model", () => {
    const { wrapper } = setup();
    const value = (at: string): Value => ({ t: "text", text: "x", at });
    const { result } = renderHook(() => useLive(live), { wrapper });
    expect(result.current.stale(value("2026-11-10T11:59:00.000Z"))).toBe(false);
    expect(result.current.stale(value("2026-11-10T11:58:59.000Z"))).toBe(true);
    const still = renderHook(() => useLive(model()), { wrapper });
    expect(still.result.current.stale(value("2026-11-09T12:00:00.000Z"))).toBe(false);
  });

  it("ages a value from the server's future as 0", () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useLive(live), { wrapper });
    expect(result.current.ageSeconds({ t: "text", text: "x", at: "2026-11-10T12:00:30.000Z" })).toBe(0);
  });
});

describe("useFeed", () => {
  it("is inert", async () => {
    const { result } = renderHook(() => useFeed("/feeds/x"));
    expect(result.current.model).toBeNull();
    await expect(result.current.send("hi")).resolves.toMatchObject({ ok: false, code: "unsupported" });
  });
});
