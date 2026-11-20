"use client";

/**
 * The organization's signals on the client: GET /api/gui/signals for the
 * organization the shell shows, fetched after the first paint (never part of
 * the manifest), again every few minutes while the page is visible, when the
 * page comes back into view or focus, and when an action's result says
 * `signals: true`. What it holds is what the kit's useSignals() returns, and
 * its count is the installed app's badge (./app-badge.ts).
 *
 * A view that takes signals (Today) carries the ones the host collected for
 * it in its model, and KitProvider hands them to `seed`: they count as a
 * fetch, so the feed does not run every watcher again right after the page
 * did. The first fetch waits a turn after mounting for that reason; if the
 * view's model stops carrying `signals`, the feed simply fetches.
 *
 * The badge counts every signal, as Today lists every signal and the tray
 * shows `count`: one number for "what needs you" wherever it appears. If
 * Today starts leaving out a severity, decide whether the badge follows.
 * The badge belongs to the installed app, not to a tab, so two windows on
 * different organizations show whichever fetched last.
 *
 * Failing quietly, by rule:
 * - 401 (signed out) clears the signals and the badge and stops fetching
 *   until the page loads again.
 * - 403 (no organization's signals for this person), and an answer for
 *   another organization than the one asked about, clear the signals and the
 *   badge: there is nothing of theirs to count.
 * - Anything else (503, 500, a network error, a body that is not signals)
 *   keeps what was shown, signals and badge, and doubles the wait before
 *   the next fetch, up to SIGNALS_MAX_BACKOFF_MS, until one answers.
 * - Once this page has signed the person out (markSignedOut), nothing is
 *   fetched and no answer is applied.
 * Nothing here throws or blocks rendering.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Signals } from "../../contract";
import { clearAppBadge, isSignedOut, setAppBadge } from "./app-badge";

/** How often the signals are fetched again while the page is visible. Every fetch runs every watcher. */
export const SIGNALS_REFRESH_MS = 5 * 60_000;
/** Coming back into view or focus fetches again only when the last fetch is at least this old. */
export const SIGNALS_MIN_GAP_MS = 30_000;
/** The longest wait between fetches after repeated failures. */
export const SIGNALS_MAX_BACKOFF_MS = 30 * 60_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type SignalsAnswer = { kind: "signals"; signals: Signals } | { kind: "none" } | { kind: "signed-out" } | { kind: "keep" };

const isIdList = (v: unknown) => Array.isArray(v) && v.every((id) => typeof id === "string");

/** Whether `signals` are `organization`'s. */
const sameOrg = (signals: Signals, organization: string) => signals.org.toLowerCase() === organization.toLowerCase();

/** Enough of the shape for the tray and the badge; the host has already parsed it strictly. */
function asSignals(body: unknown): Signals | null {
  if (body === null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const ok =
    b.type === "signals" &&
    typeof b.org === "string" &&
    typeof b.count === "number" &&
    Number.isFinite(b.count) &&
    b.count >= 0 &&
    Array.isArray(b.top) &&
    isIdList(b.checked) &&
    isIdList(b.unchecked);
  return ok ? (body as Signals) : null;
}

/** One fetch of `organization`'s signals, as an answer the rules above act on; never rejects. */
export async function fetchSignals(fetch: Fetch, organization: string, signal?: AbortSignal): Promise<SignalsAnswer> {
  try {
    const response = await fetch(`/api/gui/signals?${new URLSearchParams({ org: organization })}`, {
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    if (response.status === 401) return { kind: "signed-out" };
    if (response.status === 403) return { kind: "none" };
    if (!response.ok) return { kind: "keep" };
    const signals = asSignals(await response.json());
    if (!signals) return { kind: "keep" };
    return sameOrg(signals, organization) ? { kind: "signals", signals } : { kind: "none" };
  } catch {
    return { kind: "keep" };
  }
}

const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

export interface SignalsFeed {
  signals: Signals | null;
  /** Fetches the signals again at once. */
  refresh(): void;
  /** Signals the host already collected for this organization (a view's model); they count as a fetch. */
  seed(signals: Signals): void;
}

/**
 * The signals of `organization`, or null before they arrive, when there are
 * none for this person, or when `organization` is null (a tenant's
 * manifest, which gets no signals). The badge is cleared when
 * `organization` becomes null or changes, and otherwise follows the rules
 * above.
 */
export function useSignalsFeed(organization: string | null, fetch: Fetch): SignalsFeed {
  const [held, setHeld] = useState<{ org: string; signals: Signals | null } | null>(null);
  const fetchRef = useRef(fetch);
  useEffect(() => {
    fetchRef.current = fetch;
  }, [fetch]);
  const feedRef = useRef<{ load(): void; seed(signals: Signals): void } | null>(null);
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (organization === null || (previous.current !== null && previous.current !== organization)) clearAppBadge();
    previous.current = organization;
    if (organization === null) return;

    let alive = true;
    let stopped = false;
    let controller: AbortController | null = null;
    let last = 0;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** The wait before the next fetch: doubled for each failure in a row, capped. */
    const wait = (base: number) => Math.min(base * 2 ** failures, SIGNALS_MAX_BACKOFF_MS);
    const schedule = () => {
      clearTimeout(timer);
      if (stopped) return;
      timer = setTimeout(() => (visible() ? load() : schedule()), wait(SIGNALS_REFRESH_MS));
    };
    const show = (signals: Signals | null) => {
      setHeld({ org: organization, signals });
      if (signals) setAppBadge(signals.count);
      else clearAppBadge();
    };
    const load = () => {
      if (stopped || isSignedOut()) return;
      controller?.abort();
      const own = (controller = typeof AbortController === "undefined" ? null : new AbortController());
      last = Date.now();
      schedule();
      void fetchSignals(fetchRef.current, organization, own?.signal).then((answer) => {
        if (!alive || controller !== own || isSignedOut()) return;
        if (answer.kind === "keep") {
          failures += 1;
          return schedule();
        }
        failures = 0;
        if (answer.kind === "signed-out") stopped = true;
        schedule();
        show(answer.kind === "signals" ? answer.signals : null);
      });
    };
    const seed = (signals: Signals) => {
      if (stopped || isSignedOut() || !sameOrg(signals, organization)) return;
      // A fetch already sent is older than these; drop its answer.
      controller?.abort();
      controller = null;
      last = Date.now();
      failures = 0;
      schedule();
      show(signals);
    };
    const ifStale = () => {
      if (visible() && Date.now() - last >= wait(SIGNALS_MIN_GAP_MS)) load();
    };
    feedRef.current = { load, seed };
    // A turn later, so a view's model that carries the signals can seed them first.
    timer = setTimeout(() => {
      if (last === 0) load();
    }, 0);
    document.addEventListener("visibilitychange", ifStale);
    window.addEventListener("focus", ifStale);
    return () => {
      alive = false;
      controller?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", ifStale);
      window.removeEventListener("focus", ifStale);
      if (feedRef.current?.load === load) feedRef.current = null;
    };
  }, [organization]);

  const refresh = useCallback(() => feedRef.current?.load(), []);
  const seed = useCallback((signals: Signals) => feedRef.current?.seed(signals), []);
  return { signals: held !== null && held.org === organization ? held.signals : null, refresh, seed };
}
