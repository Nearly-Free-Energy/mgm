"use client";

/**
 * Gridtop's renderer of `billing.savings`, reading ext version 1. Every
 * component Gridtop's entry names reaches the interface layout's first load
 * (the (gui) layout imports src/gui/installed.ts), so this one loads the
 * table (./savings-view.tsx) the first time it is drawn, handing it the kit.
 * If the layout stops importing the entry, the table can be imported
 * directly.
 */
import { lazy, Suspense } from "react";
import type { ViewProps } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";

const SavingsTable = lazy(() => import("./savings-view"));

export function SavingsRenderer({ model }: ViewProps) {
  return (
    <Suspense fallback={null}>
      <SavingsTable model={model} kit={kit} />
    </Suspense>
  );
}
