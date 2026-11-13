"use client";

/**
 * Publishes a contributed view's model to useView() while its page is shown.
 * useView() reads it only while the pathname it was published for is
 * current, so a shell never shows a model after navigating away.
 *
 * Without `initial`, the view's title, trail and scope come from
 * contributedView over the provider's manifest, as the (gui) layout derives
 * them for the first paint (../server/render-view.tsx).
 */
import { useLayoutEffect, useMemo, type ReactNode } from "react";
import type { InitialView, ViewModel } from "../../contract";
import { contributedView } from "../shared/legacy-view";
import { useKitState } from "./kit-provider";
import { usePathname } from "./navigation";

export function ViewBoundary(props: { initial?: InitialView; model: ViewModel; children?: ReactNode }) {
  const { model, children } = props;
  const state = useKitState();
  const setBoundary = state?.setBoundary;
  const manifest = state?.manifest ?? null;
  const pathname = usePathname();
  const initial = useMemo(
    () => props.initial ?? (manifest ? contributedView(pathname, model, manifest) : null),
    [props.initial, manifest, pathname, model],
  );
  useLayoutEffect(() => {
    if (!setBoundary || !initial) return;
    setBoundary({ pathname, initial, model });
    return () => setBoundary(null);
  }, [setBoundary, pathname, initial, model]);
  return children ?? null;
}
