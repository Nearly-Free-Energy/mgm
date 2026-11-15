"use client";

/**
 * Publishes a contributed view's model to useView() while its page is shown.
 * useView() reads it only while the pathname it was published for is
 * current, so a shell never shows a model after navigating away.
 *
 * Without `initial`, the view's title, trail and scope come from
 * contributedView over the provider's manifest. The (gui) layout's first
 * paint derives the same trail and scope without the model, so its title is
 * the nav entry's until this boundary publishes the model's
 * (resolveInitialView in ../server/render-view.tsx).
 *
 * ViewUnavailable is drawn instead where a view's page could not load its
 * model (renderView's refusal banner). It publishes the view the shell
 * already shows with no view and no model, so the shell stops waiting for a
 * model that will not come, as it does after a soft navigation to that page.
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

export function ViewUnavailable(props: { children?: ReactNode }) {
  const state = useKitState();
  const setBoundary = state?.setBoundary;
  const view = state?.view ?? null;
  const pathname = usePathname();
  useLayoutEffect(() => {
    if (!setBoundary || !view) return;
    setBoundary({ pathname, initial: { ...view, view: null }, model: null });
    return () => setBoundary(null);
  }, [setBoundary, pathname, view]);
  return props.children ?? null;
}
