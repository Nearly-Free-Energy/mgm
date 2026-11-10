"use client";

/**
 * Keeps a live view's model fresh, and ages its values against server time.
 * Polling is gentle: never faster than every 15 seconds, four times slower
 * on a data saver or a slow connection, and paused while the tab is hidden.
 */
import { useEffect, useState } from "react";
import type { ActionResult, FeedState, Href, LiveState, Value, ViewModel } from "../../contract";
import { useKitState } from "./kit-provider";
import { loadView } from "./kit-runtime";
import { usePathname } from "./navigation";

export const MIN_REFRESH_SECONDS = 15;
export const SLOW_FACTOR = 4;

type Connection = { saveData?: boolean; effectiveType?: string };

function slowConnection(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & { connection?: Connection }).connection;
  return connection?.saveData === true || ["slow-2g", "2g", "3g"].includes(connection?.effectiveType ?? "");
}

export function useLive(model: ViewModel): LiveState {
  const skew = useKitState()?.skew ?? 0;
  const pathname = usePathname();
  const [latest, setLatest] = useState<{ from: ViewModel; model: ViewModel } | null>(null);
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const [slow] = useState(slowConnection);
  const live = model.live;
  const refreshSeconds = live?.refreshSeconds;

  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  useEffect(() => {
    if (!refreshSeconds || hidden) return;
    let active = true;
    let inFlight = false;
    const seconds = Math.max(MIN_REFRESH_SECONDS, refreshSeconds) * (slow ? SLOW_FACTOR : 1);
    const id = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      const result = await loadView(`${pathname}${window.location.search}` as Href);
      inFlight = false;
      // Only a model of the same view: a GUI may pass a model that is not the page's.
      if (active && result.type === "view" && result.view === model.view) setLatest({ from: model, model: result });
    }, seconds * 1000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [refreshSeconds, hidden, slow, pathname, model]);

  const ageSeconds = (value: Value): number | null => {
    if (!value.at) return null;
    const at = Date.parse(value.at);
    return Number.isNaN(at) ? null : Math.max(0, Math.floor((Date.now() + skew - at) / 1000));
  };
  return {
    // A new model from the page wins over one polled for the previous model.
    model: latest?.from === model ? latest.model : model,
    ageSeconds,
    stale: (value) => {
      const age = ageSeconds(value);
      return !!live && age !== null && age > live.staleAfterSeconds;
    },
    polling: !live || hidden ? "paused" : slow ? "slow" : "on",
  };
}

const UNSUPPORTED: ActionResult = {
  type: "result",
  ok: false,
  status: 0,
  code: "unsupported",
  message: "Not available yet",
};

/** Feeds are not served yet: no model, and sending refuses. */
export function useFeed(href: Href): FeedState {
  void href;
  return { model: null, busy: false, send: async () => UNSUPPORTED, stop() {} };
}
