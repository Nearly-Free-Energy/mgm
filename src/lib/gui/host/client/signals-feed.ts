"use client";

/**
 * The organization's signals on the client: GET /api/gui/signals for the
 * organization the shell shows, fetched after the first paint (never part of
 * the manifest), again every few minutes while the page is visible, when the
 * page comes back into view or focus, and when an action's result says
 * `signals: true`. What it holds is what the kit's useSignals() returns, and
 * its count is the installed app's badge (./app-badge.ts).
 *
 * The badge counts every signal, as Today lists every signal and the tray
 * shows `count`: one number for "what needs you" wherever it appears. If
 * Today starts leaving out a severity, decide whether the badge follows.
 *
 * Failing quietly, by rule:
 * - 401 (signed out) and 403 (no organization's signals for this person)
 *   clear the signals and the badge: there is nothing of theirs to count.
 * - An answer for another organization than the one asked about is treated
 *   the same way, since its count is not this organization's.
 * - Anything else (503, 500, a network error, a body that is not signals)
 *   keeps what was shown, signals and badge, until the next fetch answers.
 * Nothing here throws or blocks rendering.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Signals } from "../../contract";
import { clearAppBadge, setAppBadge } from "./app-badge";

/** How often the signals are fetched again while the page is visible. Every fetch runs every watcher. */
export const SIGNALS_REFRESH_MS = 5 * 60_000;
/** Coming back into view or focus fetches again only when the last fetch is at least this old. */
export const SIGNALS_MIN_GAP_MS = 30_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type SignalsAnswer = { kind: "signals"; signals: Signals } | { kind: "none" } | { kind: "keep" };

const isIdList = (v: unknown) => Array.isArray(v) && v.every((id) => typeof id === "string");

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
    if (response.status === 401 || response.status === 403) return { kind: "none" };
    if (!response.ok) return { kind: "keep" };
    const signals = asSignals(await response.json());
    if (!signals) return { kind: "keep" };
    return signals.org.toLowerCase() === organization.toLowerCase() ? { kind: "signals", signals } : { kind: "none" };
  } catch {
    return { kind: "keep" };
  }
}

const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * The signals of `organization`, or null before they arrive, when there are
 * none for this person, or when `organization` is null (a tenant's
 * manifest, which gets no signals). `refresh` fetches them again at once.
 * The badge is cleared when `organization` becomes null or changes, and
 * otherwise follows the rules above.
 */
export function useSignalsFeed(organization: string | null, fetch: Fetch): { signals: Signals | null; refresh(): void } {
  const [held, setHeld] = useState<{ org: string; signals: Signals | null } | null>(null);
  const fetchRef = useRef(fetch);
  useEffect(() => {
    fetchRef.current = fetch;
  }, [fetch]);
  const loadRef = useRef<(() => void) | null>(null);
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (organization === null || (previous.current !== null && previous.current !== organization)) clearAppBadge();
    previous.current = organization;
    if (organization === null) return;

    let alive = true;
    let controller: AbortController | null = null;
    let last = 0;
    const load = () => {
      controller?.abort();
      const own = (controller = typeof AbortController === "undefined" ? null : new AbortController());
      last = Date.now();
      void fetchSignals(fetchRef.current, organization, own?.signal).then((answer) => {
        if (!alive || controller !== own || answer.kind === "keep") return;
        const signals = answer.kind === "signals" ? answer.signals : null;
        setHeld({ org: organization, signals });
        if (signals) setAppBadge(signals.count);
        else clearAppBadge();
      });
    };
    const ifStale = () => {
      if (visible() && Date.now() - last >= SIGNALS_MIN_GAP_MS) load();
    };
    loadRef.current = load;
    load();
    const timer = setInterval(() => {
      if (visible()) load();
    }, SIGNALS_REFRESH_MS);
    document.addEventListener("visibilitychange", ifStale);
    window.addEventListener("focus", ifStale);
    return () => {
      alive = false;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", ifStale);
      window.removeEventListener("focus", ifStale);
      if (loadRef.current === load) loadRef.current = null;
    };
  }, [organization]);

  const refresh = useCallback(() => loadRef.current?.(), []);
  return { signals: held !== null && held.org === organization ? held.signals : null, refresh };
}
