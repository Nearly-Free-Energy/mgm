"use client";

/**
 * Publishes a contributed view's model to useView() while its page is shown.
 * useView() reads it only while the pathname it was published for is
 * current, so a shell never shows a model after navigating away.
 */
import { useLayoutEffect, type ReactNode } from "react";
import type { InitialView, ViewModel } from "../../contract";
import { useKitState } from "./kit-provider";
import { usePathname } from "./navigation";

export function ViewBoundary({ initial, model, children }: { initial: InitialView; model: ViewModel; children?: ReactNode }) {
  const setBoundary = useKitState()?.setBoundary;
  const pathname = usePathname();
  useLayoutEffect(() => {
    if (!setBoundary) return;
    setBoundary({ pathname, initial, model });
    return () => setBoundary(null);
  }, [setBoundary, pathname, initial, model]);
  return children ?? null;
}
