"use client";

/**
 * Gridtop's renderer of `billing.send-queue`, reading ext version 1. Every
 * component Gridtop's entry names reaches the interface layout's first load
 * (the (gui) layout imports src/gui/installed.ts), so this wrapper loads
 * the queue (./view.tsx) as a chunk of its own the first time it is drawn,
 * handing it the kit. If the layout stops importing the entry, the view can
 * be imported directly.
 */
import { lazy, Suspense } from "react";
import type { ViewProps } from "@/lib/gui/contract";
import type { SyncNode } from "@/lib/gui/contract-react";
import { kit } from "@/lib/gui/kit";

const SendQueueView = lazy(() => import("./view"));

export function SendQueueRenderer({ model }: ViewProps): SyncNode {
  return (
    <Suspense fallback={null}>
      <SendQueueView model={model} kit={kit} />
    </Suspense>
  );
}
